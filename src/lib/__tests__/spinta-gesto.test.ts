import { beforeAll, describe, expect, it } from "vitest";

/*
 * "SPINGI E SPOSTA": THE GESTURE, END TO END, ON COPPER THE FILES DRAW.
 *
 * The four functions the viewer calls (gesto.ts) on a board compiled for real,
 * the one of spinta-salvataggio.test.ts: three resistors, a trace between two
 * pins through two vias, a trace toward ground with a via in its path, a trace
 * that ends on a lone via of ground.
 *
 * A gesture is followed to its end: grabbed, moved, closed, and what it asks
 * to be saved goes the way a save goes. It is read within the limits of one
 * save (leggiRame), checked on the saved board (verificaRame), written in the
 * file (applyCopperPatch) and laid (applyManualRoutes, in the fast update and
 * in a compile). The copper on the board must be the copper the gesture drew
 * while it lasted: one trace for each connection, no id doubled.
 *
 * As in spinta-salvataggio.test.ts, the points of a `pcbPath` are relative to
 * the PART of the first pin: R1 is at (-10; 0), R3 at (-10; -6).
 */
import { compileProject } from "@/lib/compile";
import { DESIGN_RULES_PATH, resolveDesignRules } from "@/lib/design-rules";
import { idDoppi } from "@/lib/duplicate-ids";
import { applyCopperPatch, emptyManualEdits, MANUAL_EDITS_PATH, serializeManualEdits, type ManualEdits } from "@/lib/manual-edits";
import { applyManualRoutes, percorsoDellaPista } from "@/lib/manual-routes";
import { rerouteLocal } from "@/lib/reroute-local";
import { chiudiGesto, iniziaGesto, muoviGesto, preseDelRame } from "@/lib/spinta/gesto";
import type { BersaglioDelRame, PresaDelRame, SalvataggioDelGesto, StatoDelGesto } from "@/lib/spinta/gesto-tipi";
import { leggiRame, verificaRame } from "@/lib/spinta/verifica";
import type { El } from "./scheda-di-prova";

const REGOLE_DEL_PROGETTO = JSON.stringify({
  preset: "custom",
  rules: { minTraceWidthMm: 0.15, minClearanceMm: 0.15, pourClearanceMm: 0.2, autoPlaneVias: false, autoroute: false },
});
const MAIN = `export default () => (
  <board width="40mm" height="24mm">
    <net name="GND" />
    <resistor name="R1" resistance="1k" footprint="0402" pcbX={-10} pcbY={0} />
    <resistor name="R2" resistance="1k" footprint="0402" pcbX={10} pcbY={0} />
    <resistor name="R3" resistance="1k" footprint="0402" pcbX={-10} pcbY={-6} />
    <trace from=".R1 > .pin2" to=".R2 > .pin1" pcbPath={[
      { x: 5, y: 0 },
      { x: 5, y: 0, via: true, fromLayer: "top", toLayer: "bottom" },
      { x: 5, y: 0 },
      { x: 15, y: 0 },
      { x: 15, y: 0, via: true, fromLayer: "bottom", toLayer: "top" },
      { x: 15, y: 0 },
    ]} thickness="0.2mm" />
    <trace from=".R1 > .pin1" to="net.GND" pcbPath={[
      { x: -2, y: 0 },
      { x: -2, y: -3 },
      { x: -2, y: -3, via: true, fromLayer: "top", toLayer: "bottom" },
      { x: -2, y: -3 },
      { x: -2, y: -5 },
    ]} thickness="0.2mm" />
    <trace from=".R3 > .pin1" to="net.GND" pcbPath={[
      { x: -2, y: 0 },
      { x: -2, y: -2 },
      { x: 10, y: -2 },
      { x: 10, y: 0 },
    ]} thickness="0.2mm" />
    <via name="V1" pcbX={0} pcbY={-6} connectsTo="net.GND" fromLayer="top" toLayer="bottom" />
  </board>
)
`;
const FILES: Record<string, string> = { "main.tsx": MAIN, [DESIGN_RULES_PATH]: REGOLE_DEL_PROGETTO };
const REGOLE = resolveDesignRules(FILES).rules;
const FRA_PIEDINI = ".R1 > .pin2 to .R2 > .pin1";
const VERSO_MASSA = ".R1 > .pin1 to net.GND";
const ALLA_VIA = ".R3 > .pin1 to net.GND";
const LIMITI = { maxRoutes: 200, maxPoints: 2000, maxVias: 500 };
const QUANDO = "2026-11-12T10:00:00.000Z";

type Punto = { x: number; y: number; layer: string };
const top = (x: number, y: number): Punto => ({ x, y, layer: "top" });
const bottom = (x: number, y: number): Punto => ({ x, y, layer: "bottom" });

const mm = (v: unknown) => Math.round(Number(v) * 1e4) / 1e4;
const posto = (e: Record<string, unknown>) => `${mm(e.x)};${mm(e.y)}`;
const piste = (cj: unknown[]) => (cj as El[]).filter((e) => e.type === "pcb_trace");
const vie = (cj: unknown[]) => (cj as El[]).filter((e) => e.type === "pcb_via");
/** the traces of one connection, by the name the files give it: never by id */
const pisteDi = (cj: unknown[], connessione: string) => {
  const sorgenti = new Set((cj as El[]).filter((e) => e.type === "source_trace" && e.display_name === connessione).map((e) => e.source_trace_id));
  return piste(cj).filter((e) => sorgenti.has(e.source_trace_id));
};
const pistaDi = (cj: unknown[], connessione: string): El => pisteDi(cj, connessione)[0];
const viaIn = (cj: unknown[], dove: string): El => vie(cj).find((v) => posto(v) === dove)!;
/** the stretches of some traces as the gesture draws them: every pair of points of a path on one layer */
const trattiDi = (percorsi: Punto[][]) =>
  percorsi.flatMap((punti) =>
    punti.slice(1).flatMap((b, i) => (punti[i].layer === b.layer ? [{ x1: punti[i].x, y1: punti[i].y, x2: b.x, y2: b.y, layer: b.layer, width: 0.2 }] : [])),
  );
/** the copper of a board for what it is: every path and every hole with its size */
const rame = (cj: unknown[]) => ({
  piste: piste(cj).map((e) => JSON.stringify(percorsoDellaPista(e))).sort(),
  vie: vie(cj).map((v) => `${posto(v)} ${mm(v.outer_diameter)}/${mm(v.hole_diameter)}`).sort(),
});

type Compilata = Awaited<ReturnType<typeof compileProject>>;
let base: Compilata;
let scheda: unknown[];
beforeAll(async () => {
  base = await compileProject(FILES);
  scheda = base.circuitJson;
}, 120_000);

const inizia = (presa: PresaDelRame) => {
  const esito = iniziaGesto({ circuitJson: scheda, regole: REGOLE, presa });
  if ("rifiuto" in esito) throw new Error(`rifiutato: ${esito.rifiuto}`);
  return esito;
};
const tratto = (connessione: string, indice: number): PresaDelRame => ({ tipo: "tratto", pcbTraceId: String(pistaDi(scheda, connessione).pcb_trace_id), indice });
const via = (dove: string): PresaDelRame => ({ tipo: "via", pcbViaId: String(viaIn(scheda, dove).pcb_via_id) });

/**
 * What a gesture asks to be saved, taken the way a save takes it: read, checked
 * on the saved board, written in the file, laid by the fast update. The board
 * it leaves, and the file.
 */
function salva(salvataggio: SalvataggioDelGesto, gestoId: string, correnti: ManualEdits = emptyManualEdits(), su: unknown[] = scheda) {
  expect(salvataggio.riscritte).toEqual([]);
  const letto = leggiRame({ routes: salvataggio.routes, vias: salvataggio.vias, gesto: gestoId }, LIMITI, QUANDO);
  if ("errore" in letto) throw new Error(`non letto: ${letto.errore}`);
  // what the gesture wrote is what the server reads: nothing dropped, nothing changed but the instant it stamps
  expect(letto.rame.routes).toEqual(salvataggio.routes.map((r) => ({ ...r, at: QUANDO })));
  expect(letto.rame.vias).toEqual(salvataggio.vias.map((v) => ({ ...v, at: QUANDO })));
  expect(verificaRame({ circuitJson: su, regole: REGOLE, correnti, rame: letto.rame })).toEqual({ ok: true });
  const edits = applyCopperPatch(correnti, letto.rame).edits;
  const posata = applyManualRoutes({
    circuitJson: su,
    routes: edits.pcb_routes,
    vias: edits.pcb_vias,
    viaDiameter: REGOLE.minViaDiameterMm,
    viaHoleDiameter: REGOLE.minViaHoleMm,
  });
  expect(posata.rame).toEqual({ orfane: { routes: [], vias: [] }, assorbite: { routes: [], vias: [] } });
  return { edits, posata: posata.circuitJson };
}

/** one trace for each connection the files draw, and no id doubled */
function unaPerConnessione(cj: unknown[]) {
  for (const connessione of [FRA_PIEDINI, VERSO_MASSA, ALLA_VIA]) expect(pisteDi(cj, connessione), connessione).toHaveLength(1);
  expect(piste(cj)).toHaveLength(3);
  expect(idDoppi(cj)).toBeNull();
}

describe("spinta, gesto: what can be grabbed", () => {
  it("the board of the files, as the cases below read it", () => {
    expect(percorsoDellaPista(pistaDi(scheda, ALLA_VIA))).toEqual([top(-10.51, -6), top(-12, -6), top(-12, -8), top(0, -8), top(0, -6)]);
    expect(percorsoDellaPista(pistaDi(scheda, VERSO_MASSA))).toEqual([top(-10.51, 0), top(-12, 0), top(-12, -3), bottom(-12, -3), bottom(-12, -5)]);
    expect(percorsoDellaPista(pistaDi(scheda, FRA_PIEDINI))).toEqual([top(-9.49, 0), top(-5, 0), bottom(-5, 0), bottom(5, 0), top(5, 0), top(9.49, 0)]);
    expect(vie(scheda).map(posto).sort()).toEqual(["-12;-3", "-5;0", "0;-6", "5;0"]);
  });

  it("every via and every straight stretch, each named as the board names it: the via by its id, the stretch by its trace and the point of the route it starts from", () => {
    const prese = preseDelRame(scheda);
    const dellaVia = prese.filter((p): p is Extract<BersaglioDelRame, { tipo: "via" }> => p.tipo === "via");
    expect(dellaVia.map((p) => `${p.x};${p.y}`).sort()).toEqual(["-12;-3", "-5;0", "0;-6", "5;0"]);
    for (const p of dellaVia) {
      const sua = viaIn(scheda, `${p.x};${p.y}`);
      expect(p).toEqual({ tipo: "via", pcbViaId: sua.pcb_via_id, x: p.x, y: p.y, outerDiameter: sua.outer_diameter });
    }
    const tratti = prese.filter((p): p is Extract<BersaglioDelRame, { tipo: "tratto" }> => p.tipo === "tratto");
    // four stretches of the trace to the via, three of the one toward ground, three of the one between the pins
    expect(tratti).toHaveLength(10);
    for (const t of tratti) {
      const route = piste(scheda).find((e) => e.pcb_trace_id === t.pcbTraceId)!.route as Array<Record<string, unknown>>;
      const [a, b] = [route[t.indice], route[t.indice + 1]];
      // the two points of the route it lies between, both wires of its layer
      expect([a.route_type, b.route_type, a.layer, b.layer]).toEqual(["wire", "wire", t.layer, t.layer]);
      expect([mm(a.x), mm(a.y), mm(b.x), mm(b.y)]).toEqual([t.x1, t.y1, t.x2, t.y2]);
      expect(t.width).toBe(0.2);
    }
    // the trace between the pins: its bottom stretch starts at the wire after the via point of the route
    const fraPiedini = tratti.filter((t) => t.pcbTraceId === pistaDi(scheda, FRA_PIEDINI).pcb_trace_id);
    expect(fraPiedini.map((t) => [t.indice, t.layer])).toEqual([[0, "top"], [3, "bottom"], [6, "top"]]);
  });

  it("a thing that cannot move at all refuses to be grabbed, and says why; a thing that is not on the board too", () => {
    // the stretch that leaves the pad of R3
    expect(iniziaGesto({ circuitJson: scheda, regole: REGOLE, presa: tratto(ALLA_VIA, 0) })).toEqual({
      rifiuto: "bloccato: il tratto esce da R3.1 e scivolerebbe di lato",
    });
    // the stretch that ends on the lone via: the via is what moves
    expect(iniziaGesto({ circuitJson: scheda, regole: REGOLE, presa: tratto(ALLA_VIA, 3) })).toEqual({
      rifiuto: "bloccato: il tratto finisce sulla via di GND, servirebbe un gomito nuovo (si sposta la via)",
    });
    expect(iniziaGesto({ circuitJson: scheda, regole: REGOLE, presa: { tipo: "via", pcbViaId: "pcb_via_99" } })).toHaveProperty("rifiuto");
    expect(iniziaGesto({ circuitJson: scheda, regole: REGOLE, presa: tratto(ALLA_VIA, 17) })).toHaveProperty("rifiuto");
    expect(iniziaGesto({ circuitJson: scheda, regole: REGOLE, presa: { tipo: "tratto", pcbTraceId: "pcb_trace_99", indice: 0 } })).toHaveProperty("rifiuto");
  });
});

describe("spinta, gesto: a lone via dragged with the trace that ends on it", () => {
  const ARRIVO = [top(-10.51, -6), top(-12, -6), top(-12, -8), top(0, -8), top(0, -6), top(0.5, -5.5)];

  it("grabbed: the via and its trace are hidden from the still copper and drawn where they are, nothing has moved", () => {
    const { stato } = inizia(via("0;-6"));
    expect(stato).toEqual({
      nascosti: { pcbTraceIds: [pistaDi(scheda, ALLA_VIA).pcb_trace_id], pcbViaIds: [viaIn(scheda, "0;-6").pcb_via_id] },
      tratti: trattiDi([[top(-10.51, -6), top(-12, -6), top(-12, -8), top(0, -8), top(0, -6)]]),
      vie: [{ x: 0, y: -6, outerDiameter: 0.3, holeDiameter: 0.2 }],
      posizione: { x: 0, y: -6 },
      blocco: null,
      mosso: false,
    });
  });

  it("moved: the last stretch keeps its direction and gains a leg at 45 degrees; the same lists of hidden copper", () => {
    const { gesto, stato: fermo } = inizia(via("0;-6"));
    const stato = muoviGesto(gesto, { x: 0.5, y: -5.5 });
    expect(stato.nascosti).toBe(fermo.nascosti);
    expect(stato).toMatchObject({ posizione: { x: 0.5, y: -5.5 }, blocco: null, mosso: true });
    expect(stato.vie).toEqual([{ x: 0.5, y: -5.5, outerDiameter: 0.3, holeDiameter: 0.2 }]);
    expect(stato.tratti).toEqual(trattiDi([ARRIVO]));
  });

  it("closed: a route with `replaces` and an entry of pcb_vias, which the save reads, checks and lays as the gesture drew them", async () => {
    const { gesto } = inizia(via("0;-6"));
    const stato = muoviGesto(gesto, { x: 0.5, y: -5.5 });
    const salvataggio = chiudiGesto(gesto, stato, "g1")!;
    expect(salvataggio).toEqual({
      routes: [
        {
          connection: ALLA_VIA,
          points: ARRIVO,
          width: 0.2,
          replaces: { original: [top(-10.51, -6), top(-12, -6), top(-12, -8), top(0, -8), top(0, -6)], width: 0.2 },
          gesto: "g1",
        },
      ],
      vias: [{ net: "GND", from: { x: 0, y: -6 }, to: { x: 0.5, y: -5.5 }, holeDiameter: 0.2, outerDiameter: 0.3, layers: ["top", "bottom"], gesto: "g1" }],
      riscritte: [],
    });
    // nothing numbered at a compile
    expect(JSON.stringify(salvataggio)).not.toMatch(/pcb_(trace|via|port|component)_|source_(trace|net|port|component)_/);

    const { edits, posata } = salva(salvataggio, "g1");
    unaPerConnessione(posata);
    // the copper on the board is the copper of the last state of the gesture
    expect(percorsoDellaPista(pistaDi(posata, ALLA_VIA))).toEqual(ARRIVO);
    expect(trattiDi([percorsoDellaPista(pistaDi(posata, ALLA_VIA))])).toEqual(stato.tratti);
    expect(vie(posata).map(posto).sort()).toEqual(["-12;-3", "-5;0", "0.5;-5.5", "5;0"]);
    // the via is the element of the files, moved: its id, its size
    expect(viaIn(posata, "0.5;-5.5")).toMatchObject({ pcb_via_id: viaIn(scheda, "0;-6").pcb_via_id, outer_diameter: 0.3, hole_diameter: 0.2 });
    // the rest of the copper is as the files draw it
    for (const connessione of [FRA_PIEDINI, VERSO_MASSA]) {
      expect(percorsoDellaPista(pistaDi(posata, connessione))).toEqual(percorsoDellaPista(pistaDi(scheda, connessione)));
    }

    // the two roads a board takes lay the same copper: the fast update of the saved board, and a compile of the files with the file of the edits
    const scritto = serializeManualEdits(edits);
    const conLeModifiche = { ...FILES, [MANUAL_EDITS_PATH]: scritto };
    const veloce = rerouteLocal(scheda, conLeModifiche, scritto);
    expect(veloce.result).toMatchObject({ ok: true });
    expect(rame(veloce.circuitJson!)).toEqual(rame(posata));
    const compilata = await compileProject(conLeModifiche);
    expect(rame(compilata.circuitJson)).toEqual(rame(posata));
    unaPerConnessione(compilata.circuitJson);
    expect(compilata.summary.manualEditsOrphans).toBeUndefined();
  }, 120_000);

  it("grabbed again on the board that shows it: the second gesture starts from what is on screen, and the file keeps where the files put both", () => {
    const primo = inizia(via("0;-6"));
    const uno = salva(chiudiGesto(primo.gesto, muoviGesto(primo.gesto, { x: 0.5, y: -5.5 }), "g1")!, "g1");
    const ancora = iniziaGesto({ circuitJson: uno.posata, regole: REGOLE, presa: { tipo: "via", pcbViaId: String(viaIn(uno.posata, "0.5;-5.5").pcb_via_id) } });
    if ("rifiuto" in ancora) throw new Error(ancora.rifiuto);
    const stato = muoviGesto(ancora.gesto, { x: 1.5, y: -5.5 });
    expect(stato).toMatchObject({ posizione: { x: 1.5, y: -5.5 }, blocco: null, mosso: true });
    const salvataggio = chiudiGesto(ancora.gesto, stato, "g2")!;
    // from the place and the path of the first gesture
    expect(salvataggio.vias[0]).toMatchObject({ from: { x: 0.5, y: -5.5 }, to: { x: 1.5, y: -5.5 } });
    expect(salvataggio.routes[0].replaces!.original).toEqual([top(-10.51, -6), top(-12, -6), top(-12, -8), top(0, -8), top(0, -6), top(0.5, -5.5)]);
    const due = salva(salvataggio, "g2", uno.edits, uno.posata);
    unaPerConnessione(due.posata);
    expect(trattiDi([percorsoDellaPista(pistaDi(due.posata, ALLA_VIA))])).toEqual(stato.tratti);
    expect(vie(due.posata).map(posto).sort()).toEqual(["-12;-3", "-5;0", "1.5;-5.5", "5;0"]);
    // one correction for the trace and one for the via, each from where the files put it
    expect(due.edits.pcb_routes).toHaveLength(1);
    expect(due.edits.pcb_routes[0].replaces!.original).toEqual([top(-10.51, -6), top(-12, -6), top(-12, -8), top(0, -8), top(0, -6)]);
    expect(due.edits.pcb_vias.map((v) => [v.from, v.to])).toEqual([[{ x: 0, y: -6 }, { x: 1.5, y: -5.5 }]]);
  });
});

describe("spinta, gesto: a via inside the path of a trace", () => {
  it("travels with the path of its trace on both layers: one route, no entry of pcb_vias, and the hole of the same size in the new place", () => {
    const { gesto, stato: fermo } = inizia(via("-12;-3"));
    expect(fermo.nascosti).toEqual({ pcbTraceIds: [pistaDi(scheda, VERSO_MASSA).pcb_trace_id], pcbViaIds: [viaIn(scheda, "-12;-3").pcb_via_id] });
    const stato = muoviGesto(gesto, { x: -12.5, y: -3.5 });
    const ARRIVO = [top(-10.51, 0), top(-12, 0), top(-12, -3), top(-12.5, -3.5), bottom(-12.5, -3.5), bottom(-12, -4), bottom(-12, -5)];
    expect(stato).toMatchObject({ posizione: { x: -12.5, y: -3.5 }, blocco: null, mosso: true, vie: [{ x: -12.5, y: -3.5, outerDiameter: 0.3, holeDiameter: 0.2 }] });
    expect(stato.tratti).toEqual(trattiDi([ARRIVO]));

    const salvataggio = chiudiGesto(gesto, stato, "g3")!;
    expect(salvataggio.vias).toEqual([]);
    expect(salvataggio.routes).toEqual([
      {
        connection: VERSO_MASSA,
        points: ARRIVO,
        width: 0.2,
        viaDiameter: 0.3,
        viaHoleDiameter: 0.2,
        replaces: { original: [top(-10.51, 0), top(-12, 0), top(-12, -3), bottom(-12, -3), bottom(-12, -5)], width: 0.2 },
        gesto: "g3",
      },
    ]);
    const { posata } = salva(salvataggio, "g3");
    unaPerConnessione(posata);
    expect(percorsoDellaPista(pistaDi(posata, VERSO_MASSA))).toEqual(ARRIVO);
    // as many holes as before: the one of the trace went with it, of its size
    expect(vie(posata).map((v) => `${posto(v)} ${v.outer_diameter}/${v.hole_diameter}`).sort()).toEqual(["-12.5;-3.5 0.3/0.2", "-5;0 0.3/0.2", "0;-6 0.3/0.2", "5;0 0.3/0.2"]);
  });
});

describe("spinta, gesto: a stretch dragged sideways", () => {
  const ARRIVO = [top(-10.51, -6), top(-12, -6), top(-12, -9.3), top(0, -9.3), top(0, -6)];

  it("only what the pointer moves across the stretch counts: the stretch slides, its two neighbours get longer, no direction changes", () => {
    const { gesto, stato: fermo } = inizia(tratto(ALLA_VIA, 2));
    expect(fermo).toMatchObject({ nascosti: { pcbTraceIds: [pistaDi(scheda, ALLA_VIA).pcb_trace_id], pcbViaIds: [] }, vie: [], mosso: false, posizione: { x: -6, y: -8 } });
    // the pointer goes down and to the right: the stretch goes down
    const stato = muoviGesto(gesto, { x: -3, y: -9.3 });
    expect(stato.tratti).toEqual(trattiDi([ARRIVO]));
    expect(stato).toMatchObject({ blocco: null, mosso: true, vie: [], posizione: { x: -3, y: -9.3 } });
    // along the stretch alone, nothing moves
    expect(muoviGesto(gesto, { x: 4, y: -8 })).toMatchObject({ mosso: false, blocco: null, tratti: fermo.tratti });
  });

  it("closed, saved and laid: the trace is the one the gesture drew, the via it ends on has not moved", () => {
    const { gesto } = inizia(tratto(ALLA_VIA, 2));
    const stato = muoviGesto(gesto, { x: -3, y: -9.3 });
    const salvataggio = chiudiGesto(gesto, stato, "g4")!;
    expect(salvataggio).toEqual({
      routes: [
        {
          connection: ALLA_VIA,
          points: ARRIVO,
          width: 0.2,
          replaces: { original: [top(-10.51, -6), top(-12, -6), top(-12, -8), top(0, -8), top(0, -6)], width: 0.2 },
          gesto: "g4",
        },
      ],
      vias: [],
      riscritte: [],
    });
    const { edits, posata } = salva(salvataggio, "g4");
    unaPerConnessione(posata);
    expect(percorsoDellaPista(pistaDi(posata, ALLA_VIA))).toEqual(ARRIVO);
    expect(trattiDi([percorsoDellaPista(pistaDi(posata, ALLA_VIA))])).toEqual(stato.tratti);
    expect(vie(posata).map(posto).sort()).toEqual(vie(scheda).map(posto).sort());
    const scritto = serializeManualEdits(edits);
    const veloce = rerouteLocal(scheda, { ...FILES, [MANUAL_EDITS_PATH]: scritto }, scritto);
    expect(rame(veloce.circuitJson!)).toEqual(rame(posata));
  });
});

describe("spinta, gesto: every position from the start of the gesture", () => {
  const stessi = (a: StatoDelGesto, b: StatoDelGesto) => expect(JSON.stringify(a)).toBe(JSON.stringify(b));

  it("the same place gives the same copper, whatever the pointer did before; and twice the same", () => {
    const { gesto } = inizia(via("0;-6"));
    const diretto = muoviGesto(gesto, { x: 0.5, y: -5.5 });
    muoviGesto(gesto, { x: 3, y: -7 });
    muoviGesto(gesto, { x: -1, y: -4 });
    stessi(muoviGesto(gesto, { x: 0.5, y: -5.5 }), diretto);
    stessi(muoviGesto(inizia(via("0;-6")).gesto, { x: 0.5, y: -5.5 }), diretto);
    // back where it started: nothing moved, and nothing to save
    const tornato = muoviGesto(gesto, { x: 0, y: -6 });
    expect(tornato).toMatchObject({ mosso: false, blocco: null, posizione: { x: 0, y: -6 } });
    expect(chiudiGesto(gesto, tornato, "g5")).toBeNull();
    expect(chiudiGesto(gesto, inizia(via("0;-6")).stato, "g5")).toBeNull();
  });

  it("a state that was copied closes like the one it is a copy of", () => {
    const { gesto } = inizia(tratto(ALLA_VIA, 2));
    const stato = muoviGesto(gesto, { x: -3, y: -9.3 });
    expect(chiudiGesto(gesto, structuredClone(stato), "g6")).toEqual(chiudiGesto(gesto, stato, "g6"));
    const dellaVia = inizia(via("0;-6"));
    const mossa = muoviGesto(dellaVia.gesto, { x: 0.5, y: -5.5 });
    expect(chiudiGesto(dellaVia.gesto, structuredClone(mossa), "g6")).toEqual(chiudiGesto(dellaVia.gesto, mossa, "g6"));
  });
});

describe("spinta, gesto: blocked", () => {
  it("a via does not jump past a thin trace on another layer: asked to go beyond it in one movement, it stops before it and says what stops it", () => {
    /*
     * The trace between the pins runs on the BOTTOM along y = 0, from x = -5 to
     * x = 5: 0.2 mm of copper. The lone via of ground is at (0; -6), and the
     * place asked, (0; 6), is free: solved in one leap the via would be there.
     */
    const { gesto } = inizia(via("0;-6"));
    const stato = muoviGesto(gesto, { x: 0, y: 6 });
    expect(stato.mosso).toBe(true);
    expect(stato.blocco).toEqual({
      motivo: `bloccato dalla pista ${FRA_PIEDINI}`,
      alone: { x: 0, y: 0, raggioMm: 0.3, layer: "bottom" },
    });
    // as near as the distance to keep lets it: the ring (0.15) and half the trace (0.1) and the 0.2 mm the project draws at
    expect(stato.posizione.x).toBe(0);
    expect(stato.posizione.y).toBeLessThanOrEqual(-0.45);
    expect(stato.posizione.y).toBeGreaterThan(-0.47);
    expect(stato.vie).toEqual([{ x: 0, y: stato.posizione.y, outerDiameter: 0.3, holeDiameter: 0.2 }]);
    // and what it would save there is good copper
    const { posata } = salva(chiudiGesto(gesto, stato, "g7")!, "g7");
    unaPerConnessione(posata);
    expect(trattiDi([percorsoDellaPista(pistaDi(posata, ALLA_VIA))])).toEqual(stato.tratti);
  });

  it("a stretch stops at the edge of the board, at the last place that keeps the distance", () => {
    const { gesto } = inizia(tratto(ALLA_VIA, 2));
    const stato = muoviGesto(gesto, { x: -6, y: -20 });
    // the board ends at y = -12: half the trace (0.1) and the 0.3 mm of the rule
    expect(stato.blocco?.motivo).toBe("bloccato dal bordo della scheda");
    expect(stato.posizione).toEqual({ x: -6, y: stato.posizione.y });
    expect(stato.posizione.y).toBeGreaterThanOrEqual(-11.6);
    expect(stato.posizione.y).toBeLessThan(-11.58);
    expect(stato.mosso).toBe(true);
    salva(chiudiGesto(gesto, stato, "g8")!, "g8");
  });

  it("with nowhere to go at all, the copper stays where it was and the block is said", () => {
    // the via in the path of the trace toward ground, asked to go back along its stretch past the corner before it
    const { gesto, stato: fermo } = inizia(via("-12;-3"));
    const stato = muoviGesto(gesto, { x: -12, y: 2 });
    expect(stato.blocco?.motivo).toBe(`bloccato: un tratto della pista ${VERSO_MASSA} sparirebbe`);
    // it went as far as its stretch stays as long as the trace is wide
    expect(stato.posizione.x).toBe(-12);
    expect(stato.posizione.y).toBeLessThanOrEqual(-0.2);
    expect(stato.posizione.y).toBeGreaterThan(-0.25);
    expect(stato.nascosti).toBe(fermo.nascosti);
  });
});
