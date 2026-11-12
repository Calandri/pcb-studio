/**
 * THE CORRECTIONS OF THE FILES' COPPER ENTER manual-edits.json CHECKED, OR NOT
 * AT ALL. What the doors they could enter by have in common.
 *
 * A route with `replaces` and a moved via win over the files, so each is
 * checked against the saved board before it is written (verificaRame, in
 * verifica.ts). Three saves do that:
 *   - `copper` of /api/manual-edits, for the gesture that makes them;
 *   - `set` of /api/manual-edits, for a state of the undo history that holds
 *     some the file does not;
 *   - `restore` of /api/trace, for a trace a correction had laid, detached and
 *     put back with Cmd+Z.
 * The saves of drawn traces (`routes` of /api/manual-edits, and its old one
 * that sends `routes` with no action) do not read the board and cannot check
 * them: they refuse them.
 *
 * Server side only: it reads the row of the saved board and builds answers.
 */
import type { DesignRules } from "../design-rules";
import { correzioniNuove, type ManualEdits } from "../manual-edits";
import { getCompileMeta, type CompileCache } from "../project-store";
import { verificaRame, type EsitoDelRame } from "./verifica";

/** whether a list of routes, as it arrives, holds an entry that says what it replaces */
export const portaCorrezioni = (lista: unknown): boolean =>
  Array.isArray(lista) && lista.some((r) => typeof r === "object" && r !== null && "replaces" in r);
export const SOLO_CON_COPPER =
  "le correzioni del rame dei file (una pista con replaces) si salvano con l'azione copper, che le verifica sulla scheda salvata: qui si salvano solo piste disegnate";

/** a save of corrections that is not written: the same answer from every door */
export const rameRifiutato = (reason: string, cambiata = false): Response =>
  Response.json({ error: `rame non salvato: ${reason}`, reason, ...(cambiata ? { cambiata: true } : {}) }, { status: 409 });
export const SENZA_SCHEDA = "non c'e' una scheda compilata su cui verificarlo: premi Aggiorna";
export const SCHEDA_RISALVATA = "la scheda e' stata salvata di nuovo mentre la leggevo: riprova sulla scheda di adesso";

/**
 * The row of the saved board, if it is still the board that was read: the
 * copper is checked on one board, and that must be the saved one when the
 * file is written. Null when a compile or a fast update saved another.
 */
export async function seAncoraQuella(projectId: string, scheda: Pick<CompileCache, "filesHash" | "createdAt">) {
  const meta = await getCompileMeta(projectId);
  return meta && meta.filesHash === scheda.filesHash && String(meta.createdAt) === String(scheda.createdAt) ? meta : null;
}

/**
 * The check of a save that replaces the file with `voluto`, to run INSIDE the
 * write, on the file actually being replaced (`correnti`): the corrections
 * `voluto` brings in (correzioniNuove) are judged on `scheda`, on the board of
 * the file as it will be (verificaRame with `finale`). Good when there is none
 * to bring in, and then nothing is measured; refused when there is one and no
 * board to judge it on.
 */
export function rameCheEntra(args: {
  /** the board the file will be laid on: the saved one, as this save leaves it */
  scheda: unknown[] | null | undefined;
  regole: DesignRules;
  correnti: ManualEdits;
  voluto: ManualEdits;
}): EsitoDelRame {
  const nuove = correzioniNuove(args.correnti, args.voluto);
  if (nuove.routes.length === 0 && nuove.vias.length === 0) return { ok: true };
  if (!args.scheda) return { ok: false, motivo: SENZA_SCHEDA };
  return verificaRame({ circuitJson: args.scheda, regole: args.regole, correnti: args.correnti, rame: nuove, finale: args.voluto });
}
