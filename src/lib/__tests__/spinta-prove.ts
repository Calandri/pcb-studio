/**
 * WHAT THE TESTS OF "SPINGI E SPOSTA" ASK OF EVERY MOVE, in one place: the
 * copper a gesture gives is exact where the gesture wrote it, it is saved the
 * way a save goes (read, verified on the saved board, written in the file,
 * laid), the board it leaves is the copper the gesture said, and the checks of
 * the house are no worse than before.
 *
 * Used by the tests of the moves at random, with and without the push.
 */
import { expect } from "vitest";
import { runDrcChecks } from "@/lib/drc";
import { idDoppi } from "@/lib/duplicate-ids";
import { applyCopperPatch, type ManualEdits } from "@/lib/manual-edits";
import { applyManualRoutes, manualRouteKey, percorsoDellaPista, type ManualRoutePoint } from "@/lib/manual-routes";
import { direzioneEsatta, inUnita } from "@/lib/spinta/geometria";
import type { SalvataggioDelGesto } from "@/lib/spinta/gesto-tipi";
import { leggiRame, trattiStorti, verificaRame } from "@/lib/spinta/verifica";
import type { El } from "./scheda-di-prova";
import { REGOLE } from "./spinta-scheda";

export const LIMITI = { maxRoutes: 200, maxPoints: 2000, maxVias: 500 };
export const QUANDO = "2026-11-12T10:00:00.000Z";

/** the checks a move must not make worse: the distances, the angles, the exits from the pads */
export const GUARDATE = ["pad_clearance", "trace_pad_clearance", "trace_trace_clearance", "board_edge_clearance", "hole_to_hole", "trace_angle", "pin_escape"];
export const violazioni = (cj: unknown[]): Record<string, number> => {
  const out: Record<string, number> = Object.fromEntries(GUARDATE.map((r) => [r, 0]));
  for (const v of runDrcChecks(cj as never, REGOLE)) if (v.rule in out) out[v.rule] += v.count ?? 1;
  return out;
};

export const piste = (cj: unknown[]) => (cj as El[]).filter((e) => e.type === "pcb_trace");
export const vie = (cj: unknown[]) => (cj as El[]).filter((e) => e.type === "pcb_via");
export const larghezzaDi = (e: El): number => Number((e.route as Array<Record<string, unknown>>).find((p) => p.route_type === "wire")?.width);
/** the stretches of some paths, as text, in no order */
export const comeTratti = (percorsi: Array<{ punti: ManualRoutePoint[]; larga: number }>): string[] =>
  percorsi.flatMap(({ punti, larga }) =>
    punti.slice(1).flatMap((b, i) => (punti[i].layer === b.layer ? [JSON.stringify({ x1: punti[i].x, y1: punti[i].y, x2: b.x, y2: b.y, layer: b.layer, width: larga })] : [])),
  );
export const trattiDellaScheda = (cj: unknown[], senza: ReadonlySet<string>): string[] =>
  comeTratti(piste(cj).filter((e) => !senza.has(String(e.pcb_trace_id))).map((e) => ({ punti: percorsoDellaPista(e), larga: larghezzaDi(e) })));
export const posto = (v: object): string => `${Number((v as { x?: unknown }).x)};${Number((v as { y?: unknown }).y)}`;

/** the stretches of a path, each as text the same whichever way it is read */
export const stretti = (punti: readonly ManualRoutePoint[]): Set<string> => {
  const out = new Set<string>();
  for (let k = 1; k < punti.length; k++) {
    const [a, b] = [punti[k - 1], punti[k]];
    if (a.layer !== b.layer) continue;
    out.add(`${a.x},${a.y}>${b.x},${b.y}@${a.layer}`);
    out.add(`${b.x},${b.y}>${a.x},${a.y}@${a.layer}`);
  }
  return out;
};

/**
 * A path a move gives: every stretch THE MOVE WROTE at 0, 45 or 90 degrees on
 * whole units, a change of layer in one place; on whole microns for hand
 * copper. The stretches the path had before (`prima`) are a given: a stretch
 * the sources wrote off its direction by a hair stays as it is until a move
 * touches it.
 */
export function direzioniEsatte(punti: readonly ManualRoutePoint[], griglia: number, dove: string, prima: readonly ManualRoutePoint[]): void {
  const dati = stretti(prima);
  for (const q of punti) {
    expect([Math.abs(inUnita(q.x)) % griglia, Math.abs(inUnita(q.y)) % griglia], `${dove}: ${JSON.stringify(q)} fuori griglia`).toEqual([0, 0]);
    // the number written is the number of the grid: nothing left for a rounding to move
    expect([q.x, q.y], dove).toEqual([inUnita(q.x) / 1e4, inUnita(q.y) / 1e4]);
  }
  for (let k = 1; k < punti.length; k++) {
    const dx = inUnita(punti[k].x) - inUnita(punti[k - 1].x);
    const dy = inUnita(punti[k].y) - inUnita(punti[k - 1].y);
    if (punti[k].layer !== punti[k - 1].layer) expect([dx, dy], `${dove}: cambio di strato fra due posti`).toEqual([0, 0]);
    else if (!dati.has(`${punti[k - 1].x},${punti[k - 1].y}>${punti[k].x},${punti[k].y}@${punti[k].layer}`)) {
      expect(direzioneEsatta(dx, dy), `${dove}: tratto ${k} di ${JSON.stringify(punti)}`).toBe(true);
    }
  }
}

/** a board and the file of hand edits that lays its copper */
export interface Stato {
  scheda: El[];
  edits: ManualEdits;
}

/**
 * What a move asks to be saved, taken the way a save takes it, on the board
 * the move started from: the board and the file it leaves.
 */
export function salva(stato: Stato, s: SalvataggioDelGesto, dove: string): Stato {
  let edits = stato.edits;
  if (s.riscritte.length > 0) {
    // the server: the route of that key, with its new path and nothing else changed
    const nuove = new Map(s.riscritte.map((r) => [r.chiave, r.points]));
    expect(nuove.size, dove).toBe(s.riscritte.length);
    for (const k of nuove.keys()) expect(edits.pcb_routes.filter((r) => manualRouteKey(r) === k), `${dove}: ${k}`).toHaveLength(1);
    for (const r of s.riscritte) direzioniEsatte(r.points, 10, `${dove}, riscritta ${r.chiave}`, edits.pcb_routes.find((x) => manualRouteKey(x) === r.chiave)!.points);
    edits = { ...edits, pcb_routes: edits.pcb_routes.map((r) => (nuove.has(manualRouteKey(r)) ? { ...r, points: nuove.get(manualRouteKey(r))! } : r)) };
  }
  if (s.routes.length > 0 || s.vias.length > 0) {
    for (const r of s.routes) {
      direzioniEsatte(r.points, 1, `${dove}, ${r.connection}`, r.replaces!.original);
      // the check the server makes of the same thing
      expect(trattiStorti(r), dove).toBeNull();
    }
    const letto = leggiRame({ routes: s.routes, vias: s.vias, gesto: "g" }, LIMITI, QUANDO);
    if ("errore" in letto) throw new Error(`${dove}: non letto: ${letto.errore}`);
    expect(verificaRame({ circuitJson: stato.scheda, regole: REGOLE, correnti: edits, rame: letto.rame }), dove).toEqual({ ok: true });
    edits = applyCopperPatch(edits, letto.rame).edits;
  }
  const posata = applyManualRoutes({
    circuitJson: stato.scheda,
    routes: edits.pcb_routes,
    vias: edits.pcb_vias,
    viaDiameter: REGOLE.minViaDiameterMm,
    viaHoleDiameter: REGOLE.minViaHoleMm,
  });
  expect(posata.rame, dove).toEqual({ orfane: { routes: [], vias: [] }, assorbite: { routes: [], vias: [] } });
  expect(posata.unknown, dove).toEqual([]);
  return { scheda: posata.circuitJson as El[], edits };
}

/**
 * The board after a move against what the move said: the stretches of the
 * traces it touched and the places of the vias it touched are the ones it
 * gave, and every other piece of copper is where it was.
 */
export function comeDetto(
  prima: El[],
  dopo: El[],
  toccato: { piste: ReadonlySet<string>; vie: ReadonlySet<string> },
  detto: { tratti: string[]; vie: string[] },
  dove: string,
): void {
  expect(trattiDellaScheda(dopo, new Set()).sort(), `${dove}: le piste`).toEqual([...trattiDellaScheda(prima, toccato.piste), ...detto.tratti].sort());
  expect(vie(dopo).map(posto).sort(), `${dove}: le vie`).toEqual(
    [
      ...vie(prima)
        .filter((v) => !toccato.vie.has(String(v.pcb_via_id)))
        .map(posto),
      ...detto.vie,
    ].sort(),
  );
  expect(idDoppi(dopo), dove).toBeNull();
}
