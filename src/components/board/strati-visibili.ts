import type { LayerId } from "./render";

/**
 * ONE RULE for what a chosen layer shows, shared by Guarda, Sposta and
 * Instrada. It used to live in three places and each one said something
 * different: the board view hid the copper of the other layers but not their
 * solder paste, their courtyards and their hover boxes; the routing view kept
 * its own layer, never heard the left rail and drew every other layer at 16%
 * whatever the x-ray said. "Seleziono il TOP ma vedo TUTTO in ogni layer"
 * (Niccolo', 2026-11-11).
 *
 * The rule: the chosen layer at full strength; with "Tutti" every layer at
 * full strength; any other layer only as much as the x-ray asks, and with the
 * x-ray at zero it is NOT drawn. What belongs to a face (pads, paste,
 * courtyard, silkscreen, the box that answers the mouse) follows its face.
 * Holes and vias go through the board: they are on every layer.
 */

/** what "Sezione della scheda" holds: one copper layer, or all of them */
export type StratoScelto = LayerId | "all";

const NOTI: readonly string[] = ["top", "bottom", "inner1", "inner2", "all"];

/** the rail hands over a string: anything unknown means top, as it always did */
export function stratoScelto(layer: string | undefined | null): StratoScelto {
  return layer && NOTI.includes(layer) ? (layer as StratoScelto) : "top";
}

/**
 * A layer named by somebody else (the checker writes a string next to each
 * finding): the copper layer it is, or undefined when it is none of them.
 * Undefined means "on every face": a hole, a via, a finding saved before the
 * checker named its layer.
 */
export function stratoDiRame(layer: string | undefined | null): LayerId | undefined {
  return layer === "top" || layer === "bottom" || layer === "inner1" || layer === "inner2" ? layer : undefined;
}

/** how strongly a layer is drawn: 1 = full, 0 = not drawn at all */
export function opacitaStrato(l: LayerId, scelto: StratoScelto, xray: number): number {
  if (scelto === "all" || l === scelto) return 1;
  const x = Number.isFinite(xray) ? Math.min(100, Math.max(0, xray)) : 0;
  // multiply first: 40 x 0,75 / 100 is 0,3, while 40 / 100 x 0,75 is 0,30000000000000004
  return (x * 0.75) / 100;
}

/** something of that layer is on screen, even dimmed */
export function stratoVisibile(l: LayerId, scelto: StratoScelto, xray: number): boolean {
  return opacitaStrato(l, scelto, xray) > 0;
}
