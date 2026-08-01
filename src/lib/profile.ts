/**
 * Measures where a compilation's time goes.
 *
 * Needed because a BAT compilation takes 5-8 minutes and until now there was
 * no way to know which part was eating it: the router? the DRC? the schematic
 * analysis? Answers ended up being guesses, and optimizing on a guess means
 * optimizing the wrong thing.
 *
 * The tscircuit router already measures its 41 stages internally
 * (timeSpentOnPhase) but tells no one: here that data is pulled out and put
 * next to ours, so the accounting is a single one.
 *
 * Cost: one performance.now() read per interval. On a minutes-long
 * compilation that is noise, so the measurement stays always on instead of
 * being an option you have to remember to enable.
 */

export interface Span {
  name: string;
  ms: number;
  /** depth in the tree: 0 = top-level phase */
  depth: number;
  /** free-form details, e.g. number of traces produced */
  note?: string;
}

export interface Profile {
  spans: Span[];
  totalMs: number;
}

export class Profiler {
  private spans: Span[] = [];
  private stack: Array<{ name: string; start: number; depth: number }> = [];
  private readonly t0 = performance.now();

  /** measures an async function and returns its result */
  async run<T>(name: string, fn: () => Promise<T> | T, note?: () => string): Promise<T> {
    const depth = this.stack.length;
    const start = performance.now();
    this.stack.push({ name, start, depth });
    try {
      return await fn();
    } finally {
      this.stack.pop();
      this.spans.push({
        name,
        ms: Math.round(performance.now() - start),
        depth,
        ...(note ? { note: safeNote(note) } : {}),
      });
    }
  }

  /** adds an interval already measured by someone else (e.g. by the router) */
  add(name: string, ms: number, depth = 1, note?: string): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.spans.push({ name, ms: Math.round(ms), depth, ...(note ? { note } : {}) });
  }

  result(): Profile {
    return { spans: this.spans, totalMs: Math.round(performance.now() - this.t0) };
  }
}

/** a note that throws must not fail the compilation it is measuring */
function safeNote(note: () => string): string | undefined {
  try {
    return note();
  } catch {
    return undefined;
  }
}

/**
 * The router's internal phases, read from the solver at the end of the run.
 * The package exposes timeSpentOnPhase as an object {stageName: ms}: only the
 * stages that took meaningful time are kept, otherwise the list is forty
 * lines of zeros.
 */
export function routerPhases(solver: unknown, minMs = 50): Array<{ name: string; ms: number }> {
  const phases = (solver as { timeSpentOnPhase?: Record<string, number> } | null)
    ?.timeSpentOnPhase;
  if (!phases || typeof phases !== "object") return [];
  return Object.entries(phases)
    .filter(([, ms]) => typeof ms === "number" && ms >= minMs)
    .map(([name, ms]) => ({ name, ms: Math.round(ms) }))
    .sort((a, b) => b.ms - a.ms);
}

/** readable summary, for the terminal and the logs */
export function formatProfile(profile: Profile): string {
  const lines = [`totale ${(profile.totalMs / 1000).toFixed(1)}s`];
  for (const s of profile.spans.slice().sort((a, b) => b.ms - a.ms).slice(0, 24)) {
    const share = profile.totalMs > 0 ? (s.ms / profile.totalMs) * 100 : 0;
    lines.push(
      `${"  ".repeat(s.depth)}${(s.ms / 1000).toFixed(1).padStart(6)}s ` +
        `${share.toFixed(0).padStart(3)}%  ${s.name}${s.note ? `  (${s.note})` : ""}`,
    );
  }
  return lines.join("\n");
}
