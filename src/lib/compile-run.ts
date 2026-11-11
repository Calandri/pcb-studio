/*
 * The state of a compile read from the project's log (activity-store.ts).
 * Apart from the store because the page needs it too, and the store pulls in
 * the database driver.
 */

/** how long a compile can run on Vercel (maxDuration 800 s), with some margin */
export const COMPILE_MAX_MS = 15 * 60 * 1000;

/**
 * How the schematicPending of a compile that did not start the schematic
 * begins (it would not have ended in the time left, see stimaDelloSchematico):
 * the page says that reason, not "the compile stopped".
 */
export const SCHEMATICO_NON_PARTITO = "lo schematico non e' partito";
/**
 * How it begins when the schematic was drawn but the board could not take it
 * in the time left (the two readings of the board differed, and computing the
 * board again would not have ended: see compileProject).
 */
export const SCHEMATICO_NON_INNESTATO = "lo schematico non e' stato messo sulla scheda";

/**
 * Why a saved board has no schematic, when its compile chose to close without
 * it and said so (SCHEMATICO_NON_PARTITO, SCHEMATICO_NON_INNESTATO): pressing
 * Ricompila does not change that by itself. Null for a board whose schematic
 * is on its way or whose compile was cut off.
 */
export function motivoSenzaSchematico(schematicPending: unknown): string | null {
  if (typeof schematicPending !== "string") return null;
  return schematicPending.startsWith(SCHEMATICO_NON_PARTITO) || schematicPending.startsWith(SCHEMATICO_NON_INNESTATO) ? schematicPending : null;
}

/** the maxDuration of the routes that compile (/api/compile, the MCP compile) */
export const FUNCTION_MAX_MS = 800_000;
/** kept for the final save and the closing line of the log, after the compile */
const MARGINE_DOPO_IL_COMPILE_MS = 30_000;
/** what a compile started with the function has: the most any compile can have (see stimaDelloSchematico) */
export const COMPILE_BUDGET_PIENO_MS = FUNCTION_MAX_MS - MARGINE_DOPO_IL_COMPILE_MS;

/**
 * What a compile started now can spend: the function's life minus what the
 * request has already used and a margin for the final save. compileProject
 * reads it to decide whether the schematic still fits (see
 * stimaDelloSchematico): without it the compile believed it had 9 minutes
 * whatever time was left.
 */
export function compileBudgetMs(requestStartedAt: number, now = Date.now()): number {
  return COMPILE_BUDGET_PIENO_MS - (now - requestStartedAt);
}

/**
 * The line a compile closes the log with. A board saved without its schematic
 * says so first, with the reason, whole: the summary's message is long and the
 * log keeps its first 300 characters, so what gets cut is the message, never
 * the reason (the reasons are written short for this, see stimaDelloSchematico).
 * `completa`: what a board with its schematic says before its message.
 */
export function rigaDiFine(
  summary: { message?: unknown; schematicPending?: unknown },
  max = 300,
  completa = "",
): string {
  const message = String(summary.message ?? "");
  if (typeof summary.schematicPending !== "string" || !summary.schematicPending) return `${completa}${message}`.slice(0, max);
  const perche = `senza schematico: ${summary.schematicPending}.`;
  return perche.length >= max ? perche.slice(0, max) : `${perche} ${message}`.slice(0, max);
}

/**
 * The line every compile opens with in the log, whoever starts it (the MCP
 * tool, the page). Its steps are "avvio" lines too: this one is how a run is
 * told apart from the steps of the run before it, cut off without an outcome.
 */
export const COMPILE_START = "compila la scheda";

export interface CompileRun {
  /** running: a compile has started and not finished; interrupted: it never finished */
  state: "running" | "interrupted";
  startedAt: string;
  actor: string;
  /** the last step it announced */
  step: string;
}

/**
 * Whether a compile of the project is running somewhere, read from the log.
 *
 * The page knows about the compile it started itself (the stream), not about
 * one started by Claude via MCP, by the copilot or by another tab: on a board
 * never compiled there was not even a preview to show, and the board stayed
 * empty with nothing saying why. The log already has every step of every
 * compile, in order: the newest compile events, newest first, say it. A run
 * whose last word is a step and not an outcome is still running, until it has
 * lasted longer than a function can live: then it was cut off (the duration
 * limit), and that is said too, because nothing else would.
 */
export function compileRunFrom(
  newestFirst: Array<{ at: string; actor: string; phase: string; detail: string }>,
  now = Date.now(),
): CompileRun | null {
  if (newestFirst.length === 0 || newestFirst[0].phase !== "avvio") return null;
  let start = newestFirst[0];
  for (const e of newestFirst) {
    if (e.phase !== "avvio") break;
    start = e;
    if (e.detail === COMPILE_START) break;
  }
  const startedMs = Date.parse(start.at);
  if (!Number.isFinite(startedMs)) return null;
  return {
    state: now - startedMs > COMPILE_MAX_MS ? "interrupted" : "running",
    startedAt: new Date(startedMs).toISOString(),
    actor: start.actor,
    step: newestFirst[0].detail,
  };
}
