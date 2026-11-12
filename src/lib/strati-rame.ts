/**
 * THE COPPER LAYERS OF A BOARD, FROM ONE PLACE.
 *
 * A board declares how many copper layers it has (`<board layers={6}>`, which
 * the compile writes as `pcb_board.num_layers`) and tscircuit names them top,
 * inner1 ... inner(n-2), bottom, in stack order. Compiled and read on
 * 2026-11-12: a 6-layer board writes inner1..inner4 and an 8-layer one
 * inner1..inner6, on traces, vias and pours.
 *
 * The list used to be written by hand wherever it was needed, and each copy
 * stopped where its author did. The viewer and the "Sezione della scheda"
 * panel stopped at four: st-camera declares `layers={6}` and showed Top,
 * Inner 1, Inner 2, Bottom, and copper on inner3 or inner4 was drawn on the
 * top. The hand routes stopped at four: a route through inner3 was thrown away
 * when read. Pour against pour stopped at six. Every list is now this one.
 *
 * WHAT A NUMBER THAT IS NOT 2, 4, 6 OR 8 GIVES, kept as the checks always had it:
 *   - missing, not a number or below 2 (tscircuit accepts `layers={1}`): two
 *     layers, top and bottom;
 *   - not whole: rounded down;
 *   - odd (3, 5, 7: tscircuit refuses them, only a board made by hand or
 *     imported can carry one): that many names, so 3 is top, inner1, bottom.
 *     The viewer and the panel showed 3 as two layers and 5 or more as four:
 *     they now show the layers the checks measure;
 *   - above 8 (tscircuit accepts 10): the checks name them all (inner7,
 *     inner8). The viewer and the panel know the eight names below and no
 *     more: copper on a name they do not know is drawn on the top, as copper
 *     on an unknown layer always was, and a hand route on such a name is
 *     refused whole when read.
 */

/** the most copper layers a board can have here: top, inner1..inner6, bottom */
export const STRATI_MASSIMI = 8;

export type StratoDiRame = "top" | "inner1" | "inner2" | "inner3" | "inner4" | "inner5" | "inner6" | "bottom";

/** the copper layers of a board that declares `numeroStrati`, top first */
export function stratiDiRame(numeroStrati: number): string[] {
  const n = Number.isFinite(numeroStrati) && numeroStrati >= 2 ? Math.floor(numeroStrati) : 2;
  return ["top", ...Array.from({ length: n - 2 }, (_, i) => `inner${i + 1}`), "bottom"];
}

/** every name a copper layer can have, in the order of the widest stack */
export const STRATI_NOTI = stratiDiRame(STRATI_MASSIMI) as readonly StratoDiRame[];

export function eStratoDiRame(v: unknown): v is StratoDiRame {
  return typeof v === "string" && (STRATI_NOTI as readonly string[]).includes(v);
}

/** the same stack with its names typed, for what draws a layer or lists it: the viewer, the panel, the keys */
export function pilaDiRame(numeroStrati: number): StratoDiRame[] {
  return stratiDiRame(numeroStrati).filter(eStratoDiRame);
}

/** the name a person reads: Top, Inner 1 ... Inner 6, Bottom */
export function nomeDelloStrato(strato: string): string {
  if (strato === "top") return "Top";
  if (strato === "bottom") return "Bottom";
  const interno = /^inner(\d+)$/.exec(strato);
  return interno ? `Inner ${interno[1]}` : strato;
}

/** what the chosen layer is, in words: the side of the parts, the side of the solder, an inner plane, or all of them */
export function didascaliaDelloStrato(strato: string): string {
  if (strato === "top") return "lato componenti";
  if (strato === "bottom") return "lato saldature";
  if (strato === "all") return "tutti gli strati";
  const interno = /^inner(\d+)$/.exec(strato);
  return interno ? `piano interno ${interno[1]}` : strato;
}

/**
 * The colour of the copper of each layer, on the dark board. Top is the
 * warmest, bottom its darker tone, and the inner ones are told apart at a
 * glance: mint, blue, pink, lime, aqua, lilac. inner3..inner6 were chosen on
 * 2026-11-12 so that each stands from every other layer further than top
 * stands from bottom (CIEDE2000 16.6 at the nearest pair, pink and lilac,
 * against 11.1), and none is the red of an error or the amber of a warning.
 */
export const COLORE_DEL_RAME: Record<StratoDiRame, string> = {
  top: "#E8A33C",
  inner1: "#3BE8B0",
  inner2: "#7FB4FF",
  inner3: "#FF8FC7",
  inner4: "#B5E853",
  inner5: "#4DD0E1",
  inner6: "#D9B3FF",
  bottom: "#B9853A",
};
