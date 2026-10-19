import type { MeshData } from "./mesh3d";
import type { JscadWorkerRequest, JscadWorkerResponse } from "@/workers/jscad.worker";

/**
 * JSCAD worker client: a single shared instance, parallel requests with
 * responses matched by id. The worker loads @jscad/modeling only once, so
 * after the first compilation the following ones are fast.
 *
 * A source that never returns (a `while (true)` written by the model) blocks
 * the worker for good: it handles one message at a time, and every later
 * compile queued behind the loop never ran. So a timeout TERMINATES the worker;
 * the requests that were waiting behind it are sent again to a fresh one.
 */

const TIMEOUT_MS = 30_000;

interface Entry {
  code: string;
  resolve: (meshes: MeshData[]) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

let worker: Worker | null = null;
let sequence = 0;
const pending = new Map<string, Entry>();

function dropWorker() {
  worker?.terminate();
  worker = null;
}

function getWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL("../workers/jscad.worker.ts", import.meta.url));
  w.onmessage = (event: MessageEvent<JscadWorkerResponse>) => {
    const { id, meshes, error } = event.data;
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    if (error) entry.reject(new Error(error));
    else entry.resolve(meshes as MeshData[]);
  };
  w.onerror = (event) => {
    const err = new Error(event.message || "worker JSCAD in errore");
    for (const entry of pending.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(err);
    }
    pending.clear();
    if (worker === w) dropWorker();
  };
  worker = w;
  return w;
}

function send(id: string) {
  const entry = pending.get(id);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => expire(id), TIMEOUT_MS);
  getWorker().postMessage({ id, code: entry.code } satisfies JscadWorkerRequest);
}

function expire(id: string) {
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  entry.reject(new Error("compilazione della scocca scaduta (30s): il sorgente non termina"));
  // the loop is still spinning in there: only terminating stops it
  dropWorker();
  for (const other of [...pending.keys()]) send(other);
}

/** compiles a JSCAD source; rejects if it does not answer within 30 seconds */
export function compileJscad(code: string): Promise<MeshData[]> {
  const id = `jscad_${++sequence}_${Date.now()}`;
  return new Promise<MeshData[]>((resolve, reject) => {
    pending.set(id, { code, resolve, reject, timer: null });
    send(id);
  });
}

/** a request overtaken by a newer one in the same lane, before it even started */
export class SupersededError extends Error {
  constructor() {
    super("sostituita da una richiesta piu' recente");
    this.name = "SupersededError";
  }
}

/**
 * Latest wins: at most one job running and one waiting. A slider dragged
 * across twenty values used to queue twenty compiles in the worker, none of
 * them cancellable, and the scene lagged seconds behind the hand. Here a new
 * request replaces the one still waiting (which rejects with SupersededError),
 * and the result of a job that finished after a newer request arrived is
 * dropped the same way: only the last value asked for reaches the screen.
 */
export function latestWins<A, R>(run: (arg: A) => Promise<R>): (arg: A) => Promise<R> {
  let running = false;
  let waiting: { arg: A; resolve: (r: R) => void; reject: (e: unknown) => void } | null = null;

  const start = (job: NonNullable<typeof waiting>) => {
    running = true;
    // through a microtask: a run that throws synchronously must not leave
    // `running` stuck at true
    Promise.resolve()
      .then(() => run(job.arg))
      .then(
      (result) => finish(job, () => job.resolve(result)),
      (err) => finish(job, () => job.reject(err)),
    );
  };
  const finish = (job: NonNullable<typeof waiting>, settle: () => void) => {
    running = false;
    const next = waiting;
    waiting = null;
    if (next) {
      job.reject(new SupersededError());
      start(next);
    } else {
      settle();
    }
  };

  return (arg: A) =>
    new Promise<R>((resolve, reject) => {
      const job = { arg, resolve, reject };
      if (!running) {
        start(job);
        return;
      }
      waiting?.reject(new SupersededError());
      waiting = job;
    });
}
