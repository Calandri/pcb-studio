import type { MeshData } from "./mesh3d";
import type { JscadWorkerRequest, JscadWorkerResponse } from "@/workers/jscad.worker";

/**
 * Client del worker JSCAD: una sola istanza condivisa, richieste in parallelo
 * con risposte abbinate per id. Il worker carica @jscad/modeling una volta
 * sola, quindi dopo la prima compilazione le successive sono rapide.
 */

let worker: Worker | null = null;
let sequence = 0;
const pending = new Map<
  string,
  { resolve: (meshes: MeshData[]) => void; reject: (err: Error) => void }
>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("../workers/jscad.worker.ts", import.meta.url));
  worker.onmessage = (event: MessageEvent<JscadWorkerResponse>) => {
    const { id, meshes, error } = event.data;
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (error) entry.reject(new Error(error));
    else entry.resolve(meshes as MeshData[]);
  };
  worker.onerror = (event) => {
    const err = new Error(event.message || "worker JSCAD in errore");
    for (const entry of pending.values()) entry.reject(err);
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

/** compila un sorgente JSCAD; rifiuta se non risponde entro 30 secondi */
export function compileJscad(code: string): Promise<MeshData[]> {
  const id = `jscad_${++sequence}_${Date.now()}`;
  return new Promise<MeshData[]>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error("compilazione della scocca scaduta (30s)"));
    }, 30_000);
    pending.set(id, {
      resolve: (meshes) => {
        clearTimeout(timeout);
        resolve(meshes);
      },
      reject: (err) => {
        clearTimeout(timeout);
        reject(err);
      },
    });
    getWorker().postMessage({ id, code } satisfies JscadWorkerRequest);
  });
}
