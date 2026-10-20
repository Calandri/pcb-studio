/**
 * A WRITE THAT LOST ITS SOCKET IS TRIED AGAIN.
 *
 * Measured on 2026-10-20 on the production compile of three imported boards:
 * the board was routed and checked, and the save failed with "fetch failed",
 * whose cause was `[UND_ERR_SOCKET] other side closed` on one and
 * `[ECONNRESET] read ECONNRESET` on the other. The Neon driver speaks HTTP over
 * keep-alive sockets; a compile keeps the event loop busy for a minute or more,
 * the proxy closes the idle socket in the meantime, and the first query after
 * the compile goes out on a socket that is already dead. The same compile run
 * from a laptop, a few times faster, saved every time.
 *
 * The board is not lost, only the save: a second attempt goes out on a new
 * socket. Only network errors are retried, a few times, a little apart, and
 * only around statements that can run twice with the same result (an upsert, a
 * CREATE IF NOT EXISTS). An error from the database itself (a constraint, a
 * syntax error) is not a network error and is thrown at once.
 */
import { motivoErrore } from "./error-cause";

const DI_RETE = /fetch failed|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT|ECONNRESET|ETIMEDOUT|EPIPE|other side closed|socket hang up/i;

export function erroreDiRete(err: unknown): boolean {
  return DI_RETE.test(motivoErrore(err, 2000));
}

export async function conRiprova<T>(
  fn: () => Promise<T>,
  { tentativi = 3, attesaMs = 300 }: { tentativi?: number; attesaMs?: number } = {},
): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= tentativi || !erroreDiRete(err)) throw err;
      await new Promise((r) => setTimeout(r, attesaMs * i));
    }
  }
}
