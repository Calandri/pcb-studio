/**
 * The MCP compile of a big board answers when the board is saved, not when the
 * schematic is done.
 *
 * WHY. On Vercel the answer of a compile that lasts minutes never reaches the
 * client: tscircuit's schematic solver holds the process for its whole run
 * (102 s in one block out of 108 locally on a 243-part board, about five
 * minutes on Vercel), nothing can be written meanwhile, not even a keepalive,
 * and a response silent that long is dropped on the way (test project
 * zz-agente-prova-mcp-lungo, 09/11/2026: board saved at 361 s, client empty
 * after 937 s). The board without schematic is ready and saved in about 40 s,
 * before that block: the answer leaves then, "scheda salvata, schematico in
 * corso", and the schematic goes on in the background, inside the function's
 * 800 s. The final result is read with inspect_board.
 *
 * A small board answers at the end as before: its whole compile takes seconds.
 */

/** from here on the schematic takes minutes on Vercel, and the answer would be lost */
export const EARLY_REPLY_MIN_COMPONENTS = 40;

/** whether a compile of this board answers at the early save */
export function repliesEarly(circuitJson: unknown[]): boolean {
  let parts = 0;
  for (const el of circuitJson) {
    if ((el as { type?: unknown } | null)?.type === "source_component") parts++;
  }
  return parts >= EARLY_REPLY_MIN_COMPONENTS;
}

/** time given to the early answer to leave before the schematic takes the process */
export const EARLY_REPLY_FLUSH_MS = 1500;

export type CompileAnswer<F, E> = { kind: "final"; value: F } | { kind: "early"; value: E };

/**
 * Runs a compile and answers with whichever comes first: the final result, or
 * the early one the compile hands over through `answerEarly`. When the early
 * one wins, the rest of the compile is given to `keepAlive` (Next's `after`),
 * so the function lives until the schematic is saved.
 */
export async function answerAtEarlyBoard<F, E>(
  run: (answerEarly: (value: E) => Promise<void>) => Promise<F>,
  keepAlive: (rest: Promise<unknown>) => void,
  flushMs = EARLY_REPLY_FLUSH_MS,
): Promise<CompileAnswer<F, E>> {
  let early: ((a: CompileAnswer<F, E>) => void) | null = null;
  const earlyAnswer = new Promise<CompileAnswer<F, E>>((resolve) => {
    early = resolve;
  });
  const work = run(async (value) => {
    early?.({ kind: "early", value });
    early = null;
    // the answer must be on the wire before the schematic holds the process for minutes
    await new Promise((r) => setTimeout(r, flushMs));
  });
  const finalAnswer = work.then((value): CompileAnswer<F, E> => ({ kind: "final", value }));
  // when the early answer wins, a later failure belongs to keepAlive, not to nobody
  finalAnswer.catch(() => undefined);
  const first = await Promise.race([earlyAnswer, finalAnswer]);
  if (first.kind === "early") {
    // handled here so a failure is never unhandled; keepAlive still sees it
    work.catch(() => undefined);
    keepAlive(work);
  }
  return first;
}
