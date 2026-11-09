/**
 * Projects with a known defect that their own files cannot say, listed here
 * instead of writing into them (they are other people's work, and some are
 * being edited right now).
 *
 * MIRRORED IN Y: imported from Altium before the fix of 2026-11-09 (see
 * altium-raddrizza.ts). Positions, rotations and footprints are mirrored top to
 * bottom: Gerbers and pick and place of these boards describe a board that
 * cannot be assembled. Verified one by one against the original Altium files.
 * Re-importing them is a decision for whoever owns them; until then the board
 * and every export say it.
 */
export const IMPORTATI_SPECCHIATI: ReadonlySet<string> = new Set<string>([
  "bat-bs",
  "birdy-bs",
  "altium-ht-tm-4g-hqt3x",
  "altium-queen-ht-jtkr5",
  // tm-4l-r3: re-imported from the original Altium files with the fix (2026-11-09)
]);

export const AVVISO_SPECCHIATO =
  "importato con il difetto di specchiatura in y del 09/11: non usare per produzione, reimportare";

/** what must be said about this project before anyone uses it, if anything */
export function avvisoDelProgetto(projectId: string): string | null {
  return IMPORTATI_SPECCHIATI.has(projectId) ? AVVISO_SPECCHIATO : null;
}
