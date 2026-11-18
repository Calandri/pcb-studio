/**
 * THE BOARD AS THE FILE WILL LAY IT, WORKED OUT ON THE PAGE.
 *
 * A copper gesture let go in Sposta (a via or a stretch dragged, a via pasted
 * or taken out) is saved in seconds and the saved board follows it in more
 * seconds still (3 to 7 s for the save and about 12 s for the fast update on
 * sbb-dl-principale, 2026-11-18). The page used to wait for that board before
 * it let another gesture start, and showed the gesture meanwhile as a drawing
 * over the board: one via every twenty seconds, and a via just pasted that
 * could not be taken, copied or moved.
 *
 * Here the page lays the copper itself, with the same hand the server lays it
 * with: the file as the server holds it (`saved`), the gestures not written
 * in it yet put in as the save will put them (applyCopperPatch, after
 * senzaAssorbite, the two steps of the action `copper`), and the result laid
 * on the saved board by applyManualRoutes, which is what the fast update does
 * with the copper. The board that comes out is the one the server will save,
 * so the next gesture starts from it at once: its targets, its solver and what
 * it asks to be saved are the same as if the person had waited.
 *
 * Nothing here is trusted by the server: every gesture is still checked when
 * it is saved (verificaRame), in the order it was made. One that is refused
 * leaves the list, and the board is laid again without it.
 *
 * Pure, no React, nothing of the server.
 */
import type { DesignRules } from "../design-rules";
import { applyCopperPatch, senzaAssorbite, type ManualEdits } from "../manual-edits";
import { RETE_SCRIVIBILE } from "../ground-stitching-file";
import { applyManualRoutes, ROUTE_LIMITS, round4, viaMoveKey, type ManualRoute, type ManualViaMove } from "../manual-routes";
import type { SalvataggioDelGesto } from "./gesto-tipi";

/** a pasted via the person takes out: its net and where it stands */
export interface ViaTolta {
  net: string;
  x: number;
  y: number;
}

/** one gesture not in the file yet: what it asks to be saved, or the pasted via it takes out */
export interface GestoDaPosare {
  salvataggio: SalvataggioDelGesto;
  togli?: ViaTolta;
}

/**
 * A pasted via to take out, as a save sends it: the name of its net and where
 * it stands, to 0.0001 mm like the entries of `pcb_vias`. Or why it is not one.
 * Nothing is clamped: what does not read is refused.
 */
export function leggiViaTolta(v: unknown): ViaTolta | string {
  if (typeof v !== "object" || v === null) return "manca la via da togliere";
  const q = v as Record<string, unknown>;
  if (typeof q.net !== "string" || !RETE_SCRIVIBILE.test(q.net)) return "la rete della via non e' un nome di rete";
  for (const c of [q.x, q.y]) {
    if (typeof c !== "number" || !Number.isFinite(c) || Math.abs(c) > ROUTE_LIMITS.maxCoordMm) return "il posto della via non e' un posto della scheda";
  }
  return { net: q.net, x: round4(q.x as number), y: round4(q.y as number) };
}

/** the key the entry of a pasted via has in the file (viaMoveKey: where it stands now) */
export const chiaveDellaViaTolta = (via: ViaTolta): string =>
  viaMoveKey({ net: via.net, from: { x: via.x, y: via.y }, to: { x: via.x, y: via.y }, aggiunta: true });

/** the file without the entry of that pasted via; the same object when it holds none */
export function senzaLaViaIncollata(edits: ManualEdits, via: ViaTolta): ManualEdits {
  const chiave = chiaveDellaViaTolta(via);
  if (!edits.pcb_vias.some((v) => v.aggiunta && viaMoveKey(v) === chiave)) return edits;
  return { ...edits, pcb_vias: edits.pcb_vias.filter((v) => !(v.aggiunta && viaMoveKey(v) === chiave)) };
}

/**
 * The copper of the file with the gestures not written yet in it, in the
 * order they were made: what the file will hold once they are all saved.
 * `circuitJson` is the saved board: the corrections the files have absorbed
 * leave the file first, as they do in the save.
 */
export function rameDelFile(
  saved: ManualEdits,
  circuitJson: unknown[],
  gesti: readonly GestoDaPosare[],
): { routes: ManualRoute[]; vias: ManualViaMove[] } {
  let edits = senzaAssorbite(saved, circuitJson);
  for (const g of gesti) {
    if (g.togli) {
      edits = senzaLaViaIncollata(edits, g.togli);
      continue;
    }
    const { routes, vias, riscritte } = g.salvataggio;
    edits = applyCopperPatch(edits, { routes, vias, ...(riscritte.length > 0 ? { riscritte } : {}) }).edits;
  }
  return { routes: edits.pcb_routes, vias: edits.pcb_vias };
}

/**
 * The saved board with the copper of the file laid on it as it will be once
 * the gestures waiting are saved. The same array when nothing changes it.
 */
export function schedaConIlRame(args: {
  /** the saved board, as the server gave it */
  circuitJson: unknown[];
  regole: DesignRules;
  /** manual-edits.json as the page knows the server holds it */
  saved: ManualEdits;
  /** the gestures not written in `saved` yet, oldest first */
  gesti: readonly GestoDaPosare[];
}): unknown[] {
  const { circuitJson, regole, saved, gesti } = args;
  const rame = rameDelFile(saved, circuitJson, gesti);
  return applyManualRoutes({
    circuitJson,
    routes: rame.routes,
    vias: rame.vias,
    // the sizes the compile and the fast update lay a via of a route with (reroute-local.ts)
    viaDiameter: regole.minViaDiameterMm,
    viaHoleDiameter: regole.minViaHoleMm,
  }).circuitJson;
}
