import { neon } from "@neondatabase/serverless";

/**
 * What is happening to the project, in time order.
 *
 * WHY IT EXISTS. When you hand a command to Claude and Claude works via MCP,
 * the work happens elsewhere: the page open on the project sees the board
 * change (the previews are saved during compilation) but cannot SAY anything:
 * not that it is compiling, not which file was rewritten, not why it takes
 * six minutes. The user stares at a frozen drawing and concludes it is not
 * working.
 *
 * WHY THIS WAY AND NOT A FIELD PER FUNCTION. The log does NOT know the
 * functions: it records tool calls, `{name, args} -> {result}`, and nothing
 * more. No special entry for "relayout" or "route": those commands are text
 * given to the model, and what scrolls by is simply what the model decided to
 * call. Adding a new tool tomorrow makes it appear here without touching a
 * line (LLM-first rule).
 *
 * The log is deliberately POOR: tool name, one readable line, outcome. No
 * Circuit JSON and no file contents go in it: the drawing already travels on
 * its own with the previews, and a log weighing megabytes cannot be read in
 * real time.
 */

const db = () => {
  const url = process.env.DATABASE_URL;
  return url ? neon(url) : null;
};

export type ActivityPhase = "avvio" | "fine" | "errore";

export interface ActivityEvent {
  id: number;
  at: string;
  /** who called: "claude" (MCP), "agente" (internal copilot), "app" */
  actor: string;
  tool: string;
  phase: ActivityPhase;
  /** one readable line: what was done, not the args dump */
  detail: string;
  /** call duration, present only on fine/errore */
  ms?: number;
}

let ddl: Promise<void> | null = null;
async function ensureTable(sql: NonNullable<ReturnType<typeof db>>): Promise<void> {
  ddl ??= sql`
    CREATE TABLE IF NOT EXISTS project_activity (
      id bigserial PRIMARY KEY,
      project_id text NOT NULL,
      at timestamptz NOT NULL DEFAULT now(),
      actor text NOT NULL,
      tool text NOT NULL,
      phase text NOT NULL,
      detail text NOT NULL DEFAULT '',
      ms int
    )
  `
    .then(
      () =>
        sql`CREATE INDEX IF NOT EXISTS project_activity_feed ON project_activity (project_id, id DESC)`,
    )
    .then(() => undefined)
    .catch((err) => {
      // a transient error must not shut down the log for the whole lifetime
      // of this instance
      ddl = null;
      throw err;
    });
  await ddl;
}

/**
 * Records a call. NEVER throws: a log that makes the work it is observing
 * fail is worse than no log at all.
 */
export async function logActivity(
  projectId: string,
  event: {
    actor: string;
    tool: string;
    phase: ActivityPhase;
    detail?: string;
    ms?: number;
  },
): Promise<void> {
  const sql = db();
  if (!sql || !projectId || projectId === "-") return;
  try {
    await ensureTable(sql);
    await sql`
      INSERT INTO project_activity (project_id, actor, tool, phase, detail, ms)
      VALUES (${projectId}, ${event.actor}, ${event.tool}, ${event.phase},
              ${(event.detail ?? "").slice(0, 500)}, ${event.ms ?? null})
    `;
  } catch {
    // silence: seeing the activity is a bonus, doing it is the job
  }
}

/**
 * The events after `sinceId`. With sinceId 0 the recent tail is returned, not
 * the whole history: whoever opens the page wants the context of the latest
 * moves, not the log of six months.
 */
export async function readActivity(
  projectId: string,
  sinceId = 0,
  limit = 60,
): Promise<ActivityEvent[]> {
  const sql = db();
  if (!sql) return [];
  try {
    await ensureTable(sql);
    const rows = (await sql`
      SELECT id, at, actor, tool, phase, detail, ms
      FROM project_activity
      WHERE project_id = ${projectId} AND id > ${sinceId}
      ORDER BY id DESC
      LIMIT ${Math.min(Math.max(limit, 1), 200)}
    `) as Array<Record<string, unknown>>;
    return rows
      .map((r) => ({
        id: Number(r.id),
        at: new Date(String(r.at)).toISOString(),
        actor: String(r.actor),
        tool: String(r.tool),
        phase: String(r.phase) as ActivityPhase,
        detail: String(r.detail ?? ""),
        ...(r.ms === null || r.ms === undefined ? {} : { ms: Number(r.ms) }),
      }))
      .reverse(); // in time order: that is how a log is read
  } catch {
    return [];
  }
}

/**
 * Wraps the execution of a tool with the log annotation.
 *
 * It lives here and not in the individual tools because it is ONE thing for
 * all of them: if each tool wrote it by itself, the first one added tomorrow
 * would forget it. It returns exactly what `run` returns, and if `run` throws,
 * the error passes through: the observer does not change the behavior of what
 * it observes.
 */
export async function recordTool<T>(
  projectId: string,
  actor: string,
  tool: string,
  describe: string,
  run: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  /*
   * Writes are AWAITED, not left running. On lambda a promise that is fired
   * and not awaited gets killed when the response goes out: the closing line,
   * the one with the outcome and the duration, is exactly the one that would
   * be lost most often. It is twenty milliseconds on calls that last seconds
   * or minutes.
   */
  await logActivity(projectId, { actor, tool, phase: "avvio", detail: describe });
  try {
    const out = await run();
    await logActivity(projectId, {
      actor,
      tool,
      phase: "fine",
      detail: summarize(out) || describe,
      ms: Date.now() - started,
    });
    return out;
  } catch (err) {
    await logActivity(projectId, {
      actor,
      tool,
      phase: "errore",
      detail: err instanceof Error ? err.message : String(err),
      ms: Date.now() - started,
    });
    throw err;
  }
}

/**
 * A one-line outcome from any result. Only the fields that recur in tool
 * results are looked at: what is not recognized is not invented, it is left
 * empty and the starting description remains.
 */
function summarize(result: unknown): string {
  const r = unwrap(result);
  if (!r || typeof r !== "object") return "";
  if (typeof r.error === "string") return r.error;
  const parts: string[] = [];
  const n = (v: unknown) => (typeof v === "number" ? v : null);
  if (typeof r.ok === "boolean") parts.push(r.ok ? "tutto a posto" : "con problemi");
  const traces = n(r.pcbTraces);
  if (traces !== null) parts.push(`${traces} piste`);
  const unrouted = Array.isArray(r.unroutedConnections) ? r.unroutedConnections.length : null;
  if (unrouted !== null) parts.push(`${unrouted} da collegare`);
  const drc = Array.isArray(r.drcViolations) ? r.drcViolations.length : null;
  if (drc !== null) parts.push(`${drc} segnalazioni DRC`);
  const errors = Array.isArray(r.errors) ? r.errors.length : null;
  if (errors) parts.push(`${errors} errori`);
  return parts.join(", ");
}

/**
 * The real result inside the MCP protocol envelope, which is
 * `{content: [{type:"text", text: "<json>"}]}`. Without opening it, every
 * compile would be logged as "answered" instead of "104 traces, 0 to connect,
 * 3 findings".
 */
function unwrap(result: unknown): Record<string, unknown> | null {
  const r = result as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return null;
  const content = r.content;
  if (!Array.isArray(content)) return r;
  const first = content[0] as { text?: unknown } | undefined;
  if (typeof first?.text !== "string") return r;
  try {
    const parsed = JSON.parse(first.text) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null; // free text: no summary to extract
  }
}
