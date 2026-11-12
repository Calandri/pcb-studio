import { beforeAll, describe, expect, it } from "vitest";

/*
 * "SPINGI E SPOSTA": COPPER OFF ITS DIRECTION BY A HAIR, AND TRACES OF THE
 * FILES CHAINED END TO END. Both on a board compiled for real, through the
 * path a save takes: leggiRame, verificaRame, applyCopperPatch,
 * applyManualRoutes.
 *
 * BY A HAIR. The sources of a real board write stretches at 45 degrees with
 * their ends rounded: on the owner's main board 104 of 994 stretches miss the
 * exact direction, 101 of them by two tenths of a micron at most, and a
 * quarter of its traces has one. Here the trace of R3 toward ground has two:
 * its corners at y = -10.0001 make the stretch before and the stretch after
 * one unit longer one way than the other.
 *   - such a stretch HAS the direction it was drawn at (within a micron);
 *   - a move that does not touch it leaves it as it is, and the save takes it
 *     as a given: it was in the path the gesture started from;
 *   - a move that touches it writes EXACT copper: the line it works on goes
 *     through the end of the stretch that does not move.
 *
 * CHAINED. Two <trace> of the files that end in the same place, on no pad and
 * no via, are one run of copper: a stretch that ends there slides along the
 * last stretch of the other, and each trace is saved as its own correction.
 */
import { compileProject } from "@/lib/compile";
import { DESIGN_RULES_PATH, resolveDesignRules } from "@/lib/design-rules";
import { idDoppi } from "@/lib/duplicate-ids";
import { applyCopperPatch, emptyManualEdits, type ManualEdits } from "@/lib/manual-edits";
import { applyManualRoutes, percorsoDellaPista, type ManualRoutePoint } from "@/lib/manual-routes";
import { direzioneEsatta, inUnita } from "@/lib/spinta/geometria";
import { chiudiGesto, iniziaGesto, muoviGesto, preseDelRame } from "@/lib/spinta/gesto";
import type { PresaDelRame, SalvataggioDelGesto } from "@/lib/spinta/gesto-tipi";
import { leggiRame, trattiStorti, verificaRame } from "@/lib/spinta/verifica";
import type { El } from "./scheda-di-prova";

const MAIN = `export default () => (
  <board width="40mm" height="24mm">
    <net name="GND" />
    <resistor name="R2" resistance="1k" footprint="0402" pcbX={10} pcbY={0} />
    <resistor name="R3" resistance="1k" footprint="0402" pcbX={-10} pcbY={-6} />
    <resistor name="R4" resistance="1k" footprint="0402" pcbX={10} pcbY={-6} />
    <trace from=".R3 > .pin1" to="net.GND" pcbPath={[
      { x: -2, y: 0 },
      { x: -2, y: -2 },
      { x: 0, y: -4.0001 },
      { x: 6, y: -4.0001 },
      { x: 10, y: 0 },
    ]} thickness="0.2mm" />
    <via name="V1" pcbX={0} pcbY={-6} connectsTo="net.GND" fromLayer="top" toLayer="bottom" />
    <trace from=".R2 > .pin2" to="net.GND" pcbPath={[
      { x: 2, y: 0 },
      { x: 2, y: -3 },
    ]} thickness="0.2mm" />
    <trace from=".R4 > .pin2" to="net.GND" pcbPath={[
      { x: 4, y: 0 },
      { x: 4, y: 3 },
      { x: 2, y: 3 },
    ]} thickness="0.2mm" />
  </board>
)
`;
const FILES: Record<string, string> = {
  "main.tsx": MAIN,
  [DESIGN_RULES_PATH]: JSON.stringify({
    preset: "custom",
    rules: { minTraceWidthMm: 0.15, minClearanceMm: 0.15, pourClearanceMm: 0.2, autoPlaneVias: false, autoroute: false },
  }),
};
const REGOLE = resolveDesignRules(FILES).rules;
const QUASI = ".R3 > .pin1 to net.GND";
const DA_R2 = ".R2 > .pin2 to net.GND";
const DA_R4 = ".R4 > .pin2 to net.GND";

const top = (x: number, y: number): ManualRoutePoint => ({ x, y, layer: "top" });
const mm = (v: unknown) => Math.round(Number(v) * 1e4) / 1e4;
const posto = (e: Record<string, unknown>) => `${mm(e.x)};${mm(e.y)}`;
const piste = (cj: unknown[]) => (cj as El[]).filter((e) => e.type === "pcb_trace");
const vie = (cj: unknown[]) => (cj as El[]).filter((e) => e.type === "pcb_via");
const pisteDi = (cj: unknown[], connessione: string) => {
  const sorgenti = new Set((cj as El[]).filter((e) => e.type === "source_trace" && e.display_name === connessione).map((e) => e.source_trace_id));
  return piste(cj).filter((e) => sorgenti.has(e.source_trace_id));
};
const percorso = (cj: unknown[], connessione: string) => percorsoDellaPista(pisteDi(cj, connessione)[0]);
/** the stretches of a path that are not at 0, 45 or 90 degrees on whole units: by how many units each misses */
const scarti = (punti: ManualRoutePoint[]): number[] =>
  punti.slice(1).flatMap((b, i) => {
    const dx = Math.abs(inUnita(b.x) - inUnita(punti[i].x));
    const dy = Math.abs(inUnita(b.y) - inUnita(punti[i].y));
    return direzioneEsatta(dx, dy) ? [] : [Math.min(dx, dy, Math.abs(dx - dy))];
  });

let scheda: unknown[];
beforeAll(async () => {
  scheda = (await compileProject(FILES)).circuitJson;
}, 120_000);

const inizia = (presa: PresaDelRame, su: unknown[] = scheda) => {
  const esito = iniziaGesto({ circuitJson: su, regole: REGOLE, presa });
  if ("rifiuto" in esito) throw new Error(`rifiutato: ${esito.rifiuto}`);
  return esito;
};
const tratto = (connessione: string, indice: number, su: unknown[] = scheda): PresaDelRame => ({ tipo: "tratto", pcbTraceId: String(pisteDi(su, connessione)[0].pcb_trace_id), indice });

/** what a gesture asks to be saved, the way a save goes: read, verified on the saved board, written in the file, laid */
function salva(s: SalvataggioDelGesto, correnti: ManualEdits = emptyManualEdits(), su: unknown[] = scheda) {
  expect(s.riscritte).toEqual([]);
  const letto = leggiRame({ routes: s.routes, vias: s.vias, gesto: "g1" }, { maxRoutes: 200, maxPoints: 2000, maxVias: 500 }, "2026-11-12T10:00:00.000Z");
  if ("errore" in letto) throw new Error(`non letto: ${letto.errore}`);
  expect(verificaRame({ circuitJson: su, regole: REGOLE, correnti, rame: letto.rame })).toEqual({ ok: true });
  const edits = applyCopperPatch(correnti, letto.rame).edits;
  const posata = applyManualRoutes({ circuitJson: su, routes: edits.pcb_routes, vias: edits.pcb_vias, viaDiameter: REGOLE.minViaDiameterMm, viaHoleDiameter: REGOLE.minViaHoleMm });
  expect(posata.rame).toEqual({ orfane: { routes: [], vias: [] }, assorbite: { routes: [], vias: [] } });
  // one trace for every connection the files draw, and no id doubled
  for (const c of [QUASI, DA_R2, DA_R4]) expect(pisteDi(posata.circuitJson, c), c).toHaveLength(1);
  expect(piste(posata.circuitJson)).toHaveLength(3);
  expect(idDoppi(posata.circuitJson)).toBeNull();
  return { edits, posata: posata.circuitJson };
}

describe("spinta, quasi esatti: a trace of the files with two stretches off 45 degrees by one unit", () => {
  const DEI_FILE = [top(-10.51, -6), top(-12, -6), top(-12, -8), top(-10, -10.0001), top(-4, -10.0001), top(0, -6)];

  it("the board: the two stretches miss the exact direction by one unit, and they can be grabbed like the others", () => {
    expect(percorso(scheda, QUASI)).toEqual(DEI_FILE);
    expect(scarti(DEI_FILE)).toEqual([1, 1]);
    const suoi = preseDelRame(scheda).filter((p) => p.tipo === "tratto" && p.pcbTraceId === pisteDi(scheda, QUASI)[0].pcb_trace_id);
    expect(suoi).toHaveLength(5);
    // the one off by a hair between two exact ones: taken, and with no movement nothing is written
    const { gesto, stato } = inizia(tratto(QUASI, 2));
    expect(stato.mosso).toBe(false);
    expect(chiudiGesto(gesto, stato, "g1")).toBeNull();
  });

  it("a stretch between the two, dragged sideways: its neighbours are written EXACT, each on the line through its end that does not move", () => {
    const { gesto } = inizia(tratto(QUASI, 3));
    const stato = muoviGesto(gesto, { x: -7, y: -10.5001 });
    expect(stato).toMatchObject({ mosso: true, blocco: null, posizione: { x: -7, y: -10.5001 } });
    const NUOVO = [top(-10.51, -6), top(-12, -6), top(-12, -8), top(-9.4999, -10.5001), top(-4.5001, -10.5001), top(0, -6)];
    expect(scarti(NUOVO)).toEqual([]);
    const salvataggio = chiudiGesto(gesto, stato, "g1")!;
    expect(salvataggio.vias).toEqual([]);
    expect(salvataggio.routes).toEqual([{ connection: QUASI, points: NUOVO, width: 0.2, replaces: { original: DEI_FILE, width: 0.2 }, gesto: "g1" }]);
    const { posata } = salva(salvataggio);
    expect(percorso(posata, QUASI)).toEqual(NUOVO);
    // the via it ends on has not moved
    expect(vie(posata).map(posto)).toEqual(["0;-6"]);
  });

  it("the via it ends on, dragged: the last stretch is drawn again exact from its fixed end; the other stretch off by a hair is not touched, and the save takes it as it is", () => {
    const { gesto } = inizia({ tipo: "via", pcbViaId: String(vie(scheda)[0].pcb_via_id) });
    const stato = muoviGesto(gesto, { x: 0.5, y: -5.5 });
    expect(stato).toMatchObject({ mosso: true, blocco: null, posizione: { x: 0.5, y: -5.5 } });
    // from (-4; -10.0001) at exactly 45 degrees the line passes one unit under the via: the second leg is that unit
    const NUOVO = [top(-10.51, -6), top(-12, -6), top(-12, -8), top(-10, -10.0001), top(-4, -10.0001), top(0.5, -5.5001), top(0.5, -5.5)];
    // what is left off its direction is the stretch nobody touched
    expect(scarti(NUOVO)).toEqual([1]);
    const salvataggio = chiudiGesto(gesto, stato, "g1")!;
    expect(salvataggio.routes).toEqual([{ connection: QUASI, points: NUOVO, width: 0.2, replaces: { original: DEI_FILE, width: 0.2 }, gesto: "g1" }]);
    expect(salvataggio.vias).toEqual([{ net: "GND", from: { x: 0, y: -6 }, to: { x: 0.5, y: -5.5 }, holeDiameter: 0.2, outerDiameter: 0.3, layers: ["top", "bottom"], gesto: "g1" }]);
    // the check of the server: a stretch of the starting path is a given, one the gesture wrote is not
    expect(trattiStorti(salvataggio.routes[0])).toBeNull();
    expect(trattiStorti({ ...salvataggio.routes[0], points: [...NUOVO.slice(0, 5), top(0.5, -5.5)] })).toBe("il tratto da (-4; -10.0001) a (0.5; -5.5) non e' a 0, 45 o 90 gradi");
    const { posata } = salva(salvataggio);
    expect(percorso(posata, QUASI)).toEqual(NUOVO);
    expect(vie(posata).map(posto)).toEqual(["0.5;-5.5"]);
  });

  it("a stretch that is at no direction at all blocks only the move that would read it: the rest of its trace moves", () => {
    // the same board with the first corner of the diagonal a tenth of a millimetre off: about three degrees
    const storta = (scheda as El[]).map((e) => {
      if (e !== pisteDi(scheda, QUASI)[0]) return e;
      return { ...e, route: (e.route as Array<Record<string, unknown>>).map((p) => (mm(p.x) === -12 && mm(p.y) === -8 ? { ...p, x: -12.1 } : p)) };
    });
    expect(scarti(percorso(storta, QUASI))).toEqual([1000, 999, 1]);
    // the crooked stretch itself is no target
    expect(preseDelRame(storta).filter((p) => p.tipo === "tratto" && p.pcbTraceId === pisteDi(storta, QUASI)[0].pcb_trace_id)).toHaveLength(3);
    // the stretch next to it would lengthen it: blocked, with the sentence
    expect(iniziaGesto({ circuitJson: storta, regole: REGOLE, presa: tratto(QUASI, 3, storta) })).toEqual({
      rifiuto: `bloccato: la pista ${QUASI} ha un tratto che non e' a 0, 45 o 90 gradi`,
    });
    // the via at the other end reads only the last stretch: it moves, and the crooked one stays a given
    const { gesto } = inizia({ tipo: "via", pcbViaId: String(vie(storta)[0].pcb_via_id) }, storta);
    const stato = muoviGesto(gesto, { x: 0.5, y: -5.5 });
    expect(stato).toMatchObject({ mosso: true, blocco: null });
    const { posata } = salva(chiudiGesto(gesto, stato, "g1")!, emptyManualEdits(), storta);
    expect(scarti(percorso(posata, QUASI))).toEqual([1000, 999]);
  });
});

describe("spinta, quasi esatti: two traces of the files chained end to end", () => {
  const R2 = [top(10.51, 0), top(12, 0), top(12, -3)];
  const R4 = [top(10.51, -6), top(14, -6), top(14, -3), top(12, -3)];
  const R2_GIU = [top(10.51, 0), top(12, 0), top(12, -4)];
  const R4_GIU = [top(10.51, -6), top(14, -6), top(14, -4), top(12, -4)];

  it("the last stretch of one, dragged sideways, slides along the last stretch of the other: two corrections, one for each trace", () => {
    expect(percorso(scheda, DA_R2)).toEqual(R2);
    expect(percorso(scheda, DA_R4)).toEqual(R4);
    const { gesto, stato: fermo } = inizia(tratto(DA_R4, 2));
    expect(fermo.nascosti).toEqual({ pcbTraceIds: [pisteDi(scheda, DA_R4)[0].pcb_trace_id, pisteDi(scheda, DA_R2)[0].pcb_trace_id], pcbViaIds: [] });
    const stato = muoviGesto(gesto, { x: 13, y: -4 });
    expect(stato).toMatchObject({ mosso: true, blocco: null, posizione: { x: 13, y: -4 } });
    const salvataggio = chiudiGesto(gesto, stato, "g1")!;
    expect(salvataggio).toEqual({
      routes: [
        { connection: DA_R4, points: R4_GIU, width: 0.2, replaces: { original: R4, width: 0.2 }, gesto: "g1" },
        { connection: DA_R2, points: R2_GIU, width: 0.2, replaces: { original: R2, width: 0.2 }, gesto: "g1" },
      ],
      vias: [],
      riscritte: [],
    });

    const { edits, posata } = salva(salvataggio);
    expect(percorso(posata, DA_R4)).toEqual(R4_GIU);
    expect(percorso(posata, DA_R2)).toEqual(R2_GIU);
    expect(percorso(posata, QUASI)).toEqual(percorso(scheda, QUASI));

    // grabbed again on the board that shows them, and dragged back: the copper of the files again, one correction for each trace
    const ancora = inizia(tratto(DA_R4, 2, posata), posata);
    const tornato = muoviGesto(ancora.gesto, { x: 13, y: -3 });
    expect(tornato).toMatchObject({ mosso: true, blocco: null });
    const dopo = salva(chiudiGesto(ancora.gesto, tornato, "g1")!, edits, posata);
    expect(percorso(dopo.posata, DA_R4)).toEqual(R4);
    expect(percorso(dopo.posata, DA_R2)).toEqual(R2);
    expect(dopo.edits.pcb_routes.map((r) => [r.connection, r.replaces?.original])).toEqual([[DA_R4, R4], [DA_R2, R2]]);
  });

  it("the stretch of the other trace that ends there is taken the same way, from its side", () => {
    // the last stretch of the trace of R2, vertical: its neighbours are its own first stretch and the last of the trace of R4
    const { gesto, stato: fermo } = inizia(tratto(DA_R2, 1));
    expect(fermo.nascosti.pcbTraceIds).toEqual([pisteDi(scheda, DA_R2)[0].pcb_trace_id, pisteDi(scheda, DA_R4)[0].pcb_trace_id]);
    const stato = muoviGesto(gesto, { x: 12.5, y: -1 });
    expect(stato).toMatchObject({ mosso: true, blocco: null });
    const { posata } = salva(chiudiGesto(gesto, stato, "g1")!);
    expect(percorso(posata, DA_R2)).toEqual([top(10.51, 0), top(12.5, 0), top(12.5, -3)]);
    expect(percorso(posata, DA_R4)).toEqual([top(10.51, -6), top(14, -6), top(14, -3), top(12.5, -3)]);
  });
});
