/*
 * The bookkeeping of the activity stream, kept pure so it can be tested: how
 * long to wait before reconnecting, when not to reconnect at all, and how to
 * merge a batch without showing the same event twice.
 */

/** the first retry is quick (the stream closing by design is the usual case), then it backs off */
export const RETRY_BASE_MS = 1200;
export const RETRY_MAX_MS = 30_000;

/** wait before the attempt number `attempt` (0 = first retry after a failure) */
export function nextBackoff(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempt));
}

/**
 * Whether a refused connection is worth retrying. Not signed in, no access to
 * the project, project gone: asking again every second only fills the server
 * log with the same refusal, forever.
 */
export function isRetryableStatus(status: number): boolean {
  return status !== 400 && status !== 401 && status !== 403 && status !== 404;
}

/**
 * Appends a batch, skipping ids already shown. A reconnect resumes from the
 * last cursor, but a batch can arrive twice when the connection drops between
 * the server sending it and the cursor moving: with duplicate ids React also
 * mixed up the rows. Kept short and in id order.
 */
export function mergeActivity<T extends { id: number }>(
  prev: readonly T[],
  incoming: readonly T[],
  cap = 120,
): T[] {
  const seen = new Set(prev.map((e) => e.id));
  const fresh: T[] = [];
  for (const e of incoming) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    fresh.push(e);
  }
  if (fresh.length === 0) return prev as T[];
  return [...prev, ...fresh].sort((a, b) => a.id - b.id).slice(-cap);
}
