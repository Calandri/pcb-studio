/*
 * The state of a compile read from the project's log (activity-store.ts).
 * Apart from the store because the page needs it too, and the store pulls in
 * the database driver.
 */

/** how long a compile can run on Vercel (maxDuration 800 s), with some margin */
export const COMPILE_MAX_MS = 15 * 60 * 1000;

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
