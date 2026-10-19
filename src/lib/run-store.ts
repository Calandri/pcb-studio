import { neon } from "@neondatabase/serverless";

/**
 * One row in `agent_runs` per model-backed request (the agent loop, a
 * component description).
 *
 * The row is written at the START (finished_at NULL = in flight) and closed in
 * the caller's `finally`. Before, the agent wrote it only at the end: a run in
 * flight did not count against the rate limit, so ten tabs could start ten
 * runs at once, and a run killed by the platform at maxDuration never counted
 * at all.
 *
 * A row whose function was killed before its `finally` stays open forever;
 * after STALE_AFTER_MINUTES it is considered dead, so a crash cannot lock a
 * project out of the agent.
 */

export type RunKind = "agent" | "describe";

/** above the agent's maxDuration (800 s) plus margin */
export const STALE_AFTER_MINUTES = 15;

export interface StartRunInput {
  projectId: string | null;
  userId: string | null;
  ip: string | null;
  kind: RunKind;
  /**
   * Refuse the run when the same project already has one of the same kind in
   * flight. Checked and inserted in one transaction under an advisory lock, so
   * two simultaneous requests cannot both pass.
   */
  exclusive?: boolean;
}

export interface FinishRunStats {
  steps: number;
  tokensIn: number;
  tokensOut: number;
  stopReason: string;
  durationMs: number;
}

/** thrown by startRun({exclusive: true}) when the project is busy */
export class ActiveRunConflict extends Error {
  constructor(projectId: string) {
    super(`run already in flight on project ${projectId}`);
    this.name = "ActiveRunConflict";
  }
}

function db() {
  const url = process.env.DATABASE_URL;
  return url ? neon(url) : null;
}

// ------------------------------------------------------------ dev fallback
// Without DATABASE_URL (local dev) the same rules hold in memory, so the
// conflict and the limit behave the same way they do in production.

interface MemRun {
  id: number;
  projectId: string | null;
  userId: string | null;
  ip: string | null;
  kind: RunKind;
  createdAt: number;
  finishedAt: number | null;
}

const MEM_KEY = Symbol.for("pcb-studio.run-store");
function memRuns(): { seq: number; runs: MemRun[] } {
  const g = globalThis as unknown as Record<symbol, { seq: number; runs: MemRun[] }>;
  g[MEM_KEY] ??= { seq: 0, runs: [] };
  return g[MEM_KEY];
}

function memActive(projectId: string, kind: RunKind, now = Date.now()): boolean {
  const staleMs = STALE_AFTER_MINUTES * 60_000;
  return memRuns().runs.some(
    (r) =>
      r.projectId === projectId &&
      r.kind === kind &&
      r.finishedAt === null &&
      now - r.createdAt < staleMs,
  );
}

// ------------------------------------------------------------------ API

/**
 * Inserts the run row and returns its id. With `exclusive`, throws
 * ActiveRunConflict if the project already has a live run of that kind.
 */
export async function startRun(input: StartRunInput): Promise<number> {
  const sql = db();
  if (!sql) {
    const store = memRuns();
    if (input.exclusive && input.projectId && memActive(input.projectId, input.kind)) {
      throw new ActiveRunConflict(input.projectId);
    }
    const id = ++store.seq;
    store.runs.push({
      id,
      projectId: input.projectId,
      userId: input.userId,
      ip: input.ip,
      kind: input.kind,
      createdAt: Date.now(),
      finishedAt: null,
    });
    // keep the dev store bounded
    if (store.runs.length > 5_000) store.runs.splice(0, store.runs.length - 5_000);
    return id;
  }

  if (input.exclusive && input.projectId) {
    const projectId = input.projectId;
    /*
     * Lock + conditional insert in ONE transaction: the second request waits
     * on the advisory lock until the first commits, then its INSERT ... WHERE
     * NOT EXISTS sees the committed row and inserts nothing.
     */
    const [, inserted] = (await sql.transaction((tx) => [
      tx`SELECT pg_advisory_xact_lock(hashtext(${`agent_runs:${projectId}`}))`,
      tx`
        INSERT INTO agent_runs (project_id, user_id, kind, ip)
        SELECT ${projectId}, ${input.userId}, ${input.kind}, ${input.ip}
        WHERE NOT EXISTS (
          SELECT 1 FROM agent_runs
          WHERE project_id = ${projectId}
            AND kind = ${input.kind}
            AND finished_at IS NULL
            AND created_at > now() - (${STALE_AFTER_MINUTES}::int * interval '1 minute')
        )
        RETURNING id
      `,
    ])) as [unknown, Array<{ id: number | string }>];
    if (!inserted?.[0]) throw new ActiveRunConflict(projectId);
    return Number(inserted[0].id);
  }

  const [row] = (await sql`
    INSERT INTO agent_runs (project_id, user_id, kind, ip)
    VALUES (${input.projectId}, ${input.userId}, ${input.kind}, ${input.ip})
    RETURNING id
  `) as Array<{ id: number | string }>;
  return Number(row.id);
}

/** closes the run row; safe to call once per startRun */
export async function finishRun(id: number, stats: FinishRunStats): Promise<void> {
  const sql = db();
  if (!sql) {
    const run = memRuns().runs.find((r) => r.id === id);
    if (run) run.finishedAt = Date.now();
    return;
  }
  await sql`
    UPDATE agent_runs
    SET steps = ${Math.max(0, Math.round(stats.steps))},
        tokens_in = ${clampInt(stats.tokensIn)},
        tokens_out = ${clampInt(stats.tokensOut)},
        stop_reason = ${stats.stopReason.slice(0, 120)},
        duration_ms = ${clampInt(stats.durationMs)},
        finished_at = now()
    WHERE id = ${id} AND finished_at IS NULL
  `;
}

/**
 * Runs of a kind started in the window, in flight included. Keyed on the
 * user (the real identity); the IP count is a secondary brake for many
 * accounts behind one address.
 */
export async function countRecentRuns(opts: {
  userId: string | null;
  ip: string | null;
  kind: RunKind;
  windowMinutes: number;
}): Promise<{ byUser: number; byIp: number }> {
  const sql = db();
  if (!sql) {
    const since = Date.now() - opts.windowMinutes * 60_000;
    const recent = memRuns().runs.filter((r) => r.kind === opts.kind && r.createdAt > since);
    return {
      byUser: opts.userId ? recent.filter((r) => r.userId === opts.userId).length : 0,
      byIp: opts.ip ? recent.filter((r) => r.ip === opts.ip).length : 0,
    };
  }
  const [row] = (await sql`
    SELECT
      count(*) FILTER (WHERE user_id = ${opts.userId})::int AS by_user,
      count(*) FILTER (WHERE ip = ${opts.ip})::int AS by_ip
    FROM agent_runs
    WHERE kind = ${opts.kind}
      AND created_at > now() - (${opts.windowMinutes}::int * interval '1 minute')
      AND (user_id = ${opts.userId} OR ip = ${opts.ip})
  `) as Array<{ by_user: number; by_ip: number }>;
  return { byUser: row?.by_user ?? 0, byIp: row?.by_ip ?? 0 };
}

/** whether the project has a live (not stale) run of the given kind */
export async function hasActiveRun(projectId: string, kind: RunKind = "agent"): Promise<boolean> {
  const sql = db();
  if (!sql) return memActive(projectId, kind);
  const rows = (await sql`
    SELECT 1 FROM agent_runs
    WHERE project_id = ${projectId}
      AND kind = ${kind}
      AND finished_at IS NULL
      AND created_at > now() - (${STALE_AFTER_MINUTES}::int * interval '1 minute')
    LIMIT 1
  `) as unknown[];
  return rows.length > 0;
}

function clampInt(v: number): number {
  if (!Number.isFinite(v) || v < 0) return 0;
  return Math.min(Math.round(v), 2_147_483_647);
}
