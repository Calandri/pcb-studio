import { MANUAL_EDITS_PATH, parseManualEdits, type ManualEdits } from "./manual-edits";
import { filesHash, type FsMap, type SavedBoardBase } from "./project-store";

/**
 * Is the saved board still the board of these files, give or take the hand
 * positions?
 *
 * The page blocked "Sposta" and asked for "Aggiorna" (a full compile, minutes
 * on a big board) after an ordinary move (sbb-dl-principale, 2026-11-10). The
 * old answer lived in manual-edits.json as a chain: every write noted the hash
 * of the board saved at that moment, and the fast update accepted the board
 * only if it was still that one. Two parts dropped a second apart broke the
 * chain: the second write noted the board of before the first update, the
 * first update then saved a newer one, and from there every move was refused
 * until a compile, after which the next quick pair broke it again.
 *
 * The answer is now on the board itself, and does not depend on the order of
 * anything: a board carries what it was made from apart from the hand
 * positions (`key`), and the parts held by hand on it (`placed`). It is still
 * good for the fast update when the files give the same key and every part
 * held on it is still held: the hand positions are absolute, by name, so
 * applying them to that board gives the board of the files, whichever of them
 * it already shows.
 *
 *  - a source changed (a .tsx, the rules, a library part): another key, the
 *    board is of other files and only a compile brings the new one;
 *  - a part let go (released, or undone back to where the code puts it), or
 *    only its turn or its face: what the code says is not on the board, so
 *    only a compile can put it back;
 *  - a schematic position or a trace hint changed: the schematic on the board
 *    is the old one, another key.
 */
export function boardBaseOf(fsMap: FsMap): SavedBoardBase {
  const edits = parseManualEdits(fsMap[MANUAL_EDITS_PATH]);
  return { key: baseKey(fsMap, edits), placed: placedNames(edits) };
}

/**
 * What is held by hand, part by part: the position (the name), and apart from
 * it the turn (`name#rot`) and the face (`name#face`) when the hand position
 * carries them. Each can be let go on its own: Cmd+Z on a turn writes the part
 * back without its rotation, which means "the turn of the code", and the board
 * cannot give that back any more than a released position.
 */
export function placedNames(edits: ManualEdits): string[] {
  const held = new Set<string>();
  for (const p of edits.pcb_placements) {
    held.add(p.selector);
    if (p.rotation !== undefined) held.add(`${p.selector}#rot`);
    if (p.layer) held.add(`${p.selector}#face`);
  }
  return [...held].sort();
}

/**
 * Everything that is not a hand position or a hand-drawn trace: the sources
 * (library included, as the compile sees them) and what in manual-edits.json
 * shapes the SCHEMATIC, which the fast update does not redraw.
 */
function baseKey(fsMap: FsMap, edits: ManualEdits): string {
  const rest = Object.fromEntries(Object.entries(fsMap).filter(([path]) => path !== MANUAL_EDITS_PATH));
  return filesHash({
    ...rest,
    [MANUAL_EDITS_PATH]: JSON.stringify({
      schematic_placements: edits.schematic_placements,
      manual_trace_hints: edits.manual_trace_hints,
    }),
  });
}

export type BaseVerdict =
  | { ok: true }
  /** `released` lists the parts let go since the board was saved */
  | { ok: false; why: "nessuna base" | "sorgenti" | "liberati"; released: string[] };

/** whether a board saved with `saved` can take the hand positions of files that give `now` */
export function baseHolds(saved: SavedBoardBase | null | undefined, now: SavedBoardBase): BaseVerdict {
  if (!saved) return { ok: false, why: "nessuna base", released: [] };
  if (saved.key !== now.key) return { ok: false, why: "sorgenti", released: [] };
  const held = new Set(now.placed);
  // by part: "U1" whether its position, its turn or its face was let go
  const released = [...new Set(saved.placed.filter((n) => !held.has(n)).map((n) => n.replace(/#(rot|face)$/, "")))];
  return released.length > 0 ? { ok: false, why: "liberati", released } : { ok: true };
}
