import { beforeAll, describe, expect, it } from "vitest";

/*
 * "SPINGI E SPOSTA": THE GESTURE ON COPPER THAT IS ALREADY A HAND ROUTE.
 *
 * Copper drawn in Instrada, or imported from another CAD, is a route of
 * manual-edits.json with no `replaces`: laid, it is a `manual` trace that
 * carries the key of its route. Moved, it is not corrected: its route is
 * REWRITTEN in its place. The gesture gives, for each such trace, the key of
 * the route as the file holds it and its new path (`riscritte`), and nothing
 * else: whoever writes the file keeps every other field of the route.
 *
 * The board is compiled for real, with its hand routes in the file:
 *   - GND, imported as other CADs write a net: pieces of two or three points
 *     chained end to end, and a via that is a route of its own (two points in
 *     one place on two layers, with its size), on which two pieces end;
 *   - a route drawn in Instrada between two pins, through two vias of its own;
 *   - a lone via of the files (<via>), on which the last piece of GND ends.
 *
 * Every gesture is followed to the board: its rewritten routes take the place
 * of the old ones in the file BY KEY, as the server will do, the fast update
 * lays the file on the saved board, and the copper there must be the copper
 * the gesture drew, with the old copper gone and no id doubled.
 */
import { compileProject } from "@/lib/compile";
import { DESIGN_RULES_PATH, resolveDesignRules } from "@/lib/design-rules";
import { runDrcChecks } from "@/lib/drc";
import { idDoppi } from "@/lib/duplicate-ids";
import { applyCopperPatch, emptyManualEdits, MANUAL_EDITS_PATH, parseManualEdits, serializeManualEdits, type ManualEdits } from "@/lib/manual-edits";
import { applyManualRoutes, manualRouteKey, parseManualRoutes, percorsoDellaPista, type ManualRoute, type ManualRoutePoint } from "@/lib/manual-routes";
import { rerouteLocal } from "@/lib/reroute-local";
import { direzioneEsatta, inUnita } from "@/lib/spinta/geometria";
import { chiudiGesto, iniziaGesto, muoviGesto, preseDelRame } from "@/lib/spinta/gesto";
import type { PresaDelRame, SalvataggioDelGesto, StatoDelGesto } from "@/lib/spinta/gesto-tipi";
import { leggiRame, verificaRame } from "@/lib/spinta/verifica";
import { pezzo, rete, scheda as schedaVuota, type El } from "./scheda-di-prova";
import { viaDi } from "./spinta-scheda";

const MAIN = `export default () => (
  <board width="40mm" height="24mm">
    <net name="GND" />
    <resistor name="R1" resistance="1k" footprint="0402" pcbX={-10} pcbY={0} />
    <resistor name="R2" resistance="1k" footprint="0402" pcbX={10} pcbY={0} />
    <resistor name="R3" resistance="1k" footprint="0402" pcbX={-10} pcbY={-6} />
    <trace from=".R1 > .pin2" to=".R2 > .pin1" />
    <trace from=".R1 > .pin1" to="net.GND" />
    <trace from=".R3 > .pin1" to="net.GND" />
    <via name="V1" pcbX={4} pcbY={-10} connectsTo="net.GND" fromLayer="top" toLayer="bottom" />
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

const top = (x: number, y: number): ManualRoutePoint => ({ x, y, layer: "top" });
const bottom = (x: number, y: number): ManualRoutePoint => ({ x, y, layer: "bottom" });
/** a piece of the copper of GND, as an import writes it */
const gnd = (points: ManualRoutePoint[], altro: Partial<ManualRoute> = {}) => ({ connection: "net.GND", net: "GND", width: 0.2, importato: true, points, ...altro });

/** the hand routes of the file, by a name the cases use */
const SCRITTE = {
  // from the pad of R1 out to the left, down the side, back into the pad of R3: three pieces chained end to end
  gndUscita: gnd([top(-10.51, 0), top(-12, 0)]),
  gndDiscesa: gnd([top(-12, 0), top(-12, -6)]),
  gndRientro: gnd([top(-12, -6), top(-10.51, -6)]),
  // from the pad of R3 to a via, the via, and from the via on the bottom to the lone via of the files
  gndAllaVia: gnd([top(-10.51, -6), top(-10.51, -8), top(0, -8)]),
  gndVia: gnd([top(0, -8), bottom(0, -8)], { viaDiameter: 0.5, viaHoleDiameter: 0.25 }),
  gndSotto: gnd([bottom(0, -8), bottom(4, -8), bottom(4, -10)]),
  // drawn in Instrada between the two pins, with two stretches at 45 degrees and two changes of layer
  disegnata: {
    connection: ".R1 > .pin2 to .R2 > .pin1",
    from: ".R1 > .pin2",
    to: ".R2 > .pin1",
    width: 0.25,
    points: [top(-9.49, 0), top(-8, 0), top(-6, 2), top(-2, 2), bottom(-2, 2), bottom(6, 2), top(6, 2), top(8, 0), top(9.49, 0)],
  },
};
type Nome = keyof typeof SCRITTE;
const NOMI = Object.keys(SCRITTE) as Nome[];
/** as the file reads them, in the order they are written in */
const ROUTES = parseManualRoutes(Object.values(SCRITTE));
const route = (nome: Nome): ManualRoute => ROUTES[NOMI.indexOf(nome)];
const chiave = (nome: Nome): string => manualRouteKey(route(nome));
const EDITS: ManualEdits = { ...emptyManualEdits(), pcb_routes: ROUTES };

const mm = (v: unknown) => Math.round(Number(v) * 1e4) / 1e4;
const posto = (e: Record<string, unknown>) => `${mm(e.x)};${mm(e.y)}`;
const piste = (cj: unknown[]) => (cj as El[]).filter((e) => e.type === "pcb_trace");
const vie = (cj: unknown[]) => (cj as El[]).filter((e) => e.type === "pcb_via");
/** the trace laid for the route of that key */
const pistaDi = (cj: unknown[], k: string): El => {
  const sue = piste(cj).filter((e) => e.manual_route_id === k);
  expect(sue, k).toHaveLength(1);
  return sue[0];
};
const viaIn = (cj: unknown[], dove: string): El => vie(cj).find((v) => posto(v) === dove)!;
/** the stretches of some paths as the gesture draws them, in no order */
const tratti = (percorsi: Array<{ punti: ManualRoutePoint[]; larga: number }>) =>
  percorsi
    .flatMap(({ punti, larga }) =>
      punti.slice(1).flatMap((b, i) => (punti[i].layer === b.layer ? [JSON.stringify({ x1: punti[i].x, y1: punti[i].y, x2: b.x, y2: b.y, layer: b.layer, width: larga })] : [])),
    )
    .sort();
const disegnati = (stato: StatoDelGesto) => stato.tratti.map((t) => JSON.stringify(t)).sort();
/** the copper of a board for what it is: every path with its width, every hole with its size */
const rame = (cj: unknown[]) => ({
  piste: piste(cj).map((e) => JSON.stringify(percorsoDellaPista(e))).sort(),
  vie: vie(cj).map((v) => `${posto(v)} ${mm(v.outer_diameter)}/${mm(v.hole_diameter)}`).sort(),
});
/** the paths a file of hand routes asks for */
const percorsiDelFile = (edits: ManualEdits) => edits.pcb_routes.map((r) => JSON.stringify(r.points)).sort();

type Compilata = Awaited<ReturnType<typeof compileProject>>;
let base: Compilata;
/** the saved board: the files compiled with their hand routes */
let salvata: unknown[];
beforeAll(async () => {
  base = await compileProject({ ...FILES, [MANUAL_EDITS_PATH]: serializeManualEdits(EDITS) });
  salvata = base.circuitJson;
}, 120_000);

const inizia = (presa: PresaDelRame, su: unknown[] = salvata) => {
  const esito = iniziaGesto({ circuitJson: su, regole: REGOLE, presa });
  if ("rifiuto" in esito) throw new Error(`rifiutato: ${esito.rifiuto}`);
  return esito;
};
const trattoDi = (k: string, indice: number, su: unknown[] = salvata): PresaDelRame => ({ tipo: "tratto", pcbTraceId: String(pistaDi(su, k).pcb_trace_id), indice });
const viaDella = (dove: string, su: unknown[] = salvata): PresaDelRame => ({ tipo: "via", pcbViaId: String(viaIn(su, dove).pcb_via_id) });

/**
 * WHAT THE SERVER WILL DO with `riscritte`: the route of that key, in the
 * file, with its new path and every other field as it was. Each key must be
 * of exactly one route of the file.
 */
function riscrivi(edits: ManualEdits, riscritte: SalvataggioDelGesto["riscritte"]): ManualEdits {
  const nuove = new Map(riscritte.map((r) => [r.chiave, r.points]));
  expect(nuove.size).toBe(riscritte.length);
  for (const k of nuove.keys()) expect(edits.pcb_routes.filter((r) => manualRouteKey(r) === k), k).toHaveLength(1);
  const pcb_routes = edits.pcb_routes.map((r) => {
    const points = nuove.get(manualRouteKey(r));
    return points ? { ...r, points } : r;
  });
  const scritti = { ...edits, pcb_routes };
  // the paths go to the file and come back as they are: on whole microns, which is how a hand route is read
  expect(parseManualEdits(serializeManualEdits(scritti)).pcb_routes).toEqual(pcb_routes);
  return scritti;
}

/** the fast update of a saved board with a file: the board it gives */
function aggiorna(edits: ManualEdits, su: unknown[] = salvata): unknown[] {
  const scritto = serializeManualEdits(edits);
  const esito = rerouteLocal(su, { ...FILES, [MANUAL_EDITS_PATH]: scritto }, scritto);
  if (!esito.circuitJson) throw new Error(`aggiornamento veloce: ${esito.result.reason}`);
  expect(esito.result.orphans.total).toBe(0);
  return esito.circuitJson;
}

/** the hand copper of a board is the copper its file asks for: one trace for every route, on its path, and no other */
function comeIlFile(cj: unknown[], edits: ManualEdits) {
  expect(piste(cj).every((e) => e.manual === true)).toBe(true);
  expect(piste(cj).map((e) => JSON.stringify(percorsoDellaPista(e))).sort()).toEqual(percorsiDelFile(edits));
  expect(piste(cj).map((e) => String(e.manual_route_id)).sort()).toEqual(edits.pcb_routes.map(manualRouteKey).sort());
  expect(idDoppi(cj)).toBeNull();
}
const distanze = (cj: unknown[]) => runDrcChecks(cj as never, REGOLE).filter((v) => /clearance|hole_to_hole/.test(v.rule));

describe("spinta, gesto a mano: the board of the test", () => {
  it("every hand route is laid as a `manual` trace that carries its key, and the via of the import as a `manual` via of its size", () => {
    comeIlFile(salvata, EDITS);
    expect(vie(salvata).map((v) => `${posto(v)} ${v.outer_diameter}/${v.hole_diameter} ${v.manual === true ? "a mano" : "dei file"}`).sort()).toEqual([
      "-2;2 0.6/0.3 a mano",
      "0;-8 0.5/0.25 a mano",
      "4;-10 0.3/0.2 dei file",
      "6;2 0.6/0.3 a mano",
    ]);
    expect(distanze(salvata)).toEqual([]);
    expect(base.summary.unroutedConnections).toEqual([]);
  });

  it("it is grabbed like the copper of the files: every via, and every straight stretch", () => {
    const prese = preseDelRame(salvata);
    expect(prese.filter((p) => p.tipo === "via").map((p) => (p.tipo === "via" ? `${p.x};${p.y}` : "")).sort()).toEqual(["-2;2", "0;-8", "4;-10", "6;2"]);
    // 1 + 1 + 1 + 2 + 0 (the via) + 2 of GND, 6 of the drawn route
    expect(prese.filter((p) => p.tipo === "tratto")).toHaveLength(13);
  });
});

describe("spinta, gesto a mano: a piece of an imported net, dragged sideways", () => {
  const USCITA = [top(-10.51, 0), top(-13, 0)];
  const DISCESA = [top(-13, 0), top(-13, -6)];
  const RIENTRO = [top(-13, -6), top(-10.51, -6)];

  it("the pieces chained to its two ends follow like the next stretches of one trace: three routes rewritten, each by the key the file holds", () => {
    const { gesto, stato: fermo } = inizia(trattoDi(chiave("gndDiscesa"), 0));
    // the piece and the two it is chained to are hidden from the still copper
    expect(fermo.nascosti).toEqual({
      pcbTraceIds: ["gndDiscesa", "gndUscita", "gndRientro"].map((n) => pistaDi(salvata, chiave(n as Nome)).pcb_trace_id),
      pcbViaIds: [],
    });
    expect(fermo).toMatchObject({ mosso: false, blocco: null, posizione: { x: -12, y: -3 } });

    const stato = muoviGesto(gesto, { x: -13, y: -4 });
    expect(stato).toMatchObject({ mosso: true, blocco: null, posizione: { x: -13, y: -4 }, vie: [] });
    expect(disegnati(stato)).toEqual(tratti([USCITA, DISCESA, RIENTRO].map((punti) => ({ punti, larga: 0.2 }))));

    const salvataggio = chiudiGesto(gesto, stato, "g1")!;
    expect(salvataggio).toEqual({
      routes: [],
      vias: [],
      riscritte: [
        { chiave: chiave("gndDiscesa"), points: DISCESA },
        { chiave: chiave("gndUscita"), points: USCITA },
        { chiave: chiave("gndRientro"), points: RIENTRO },
      ],
    });
    // the keys are the `manual_route_id` of the copper, as they are on the board
    for (const r of salvataggio.riscritte) expect(piste(salvata).map((e) => e.manual_route_id)).toContain(r.chiave);
    expect(JSON.stringify(salvataggio)).not.toMatch(/pcb_(trace|via|port|component)_|source_(trace|net|port|component)_/);
  });

  it("rewritten in the file and laid by the fast update: the copper is the one the gesture drew, the old one is gone, no id is doubled", async () => {
    const { gesto } = inizia(trattoDi(chiave("gndDiscesa"), 0));
    const stato = muoviGesto(gesto, { x: -13, y: -4 });
    const edits = riscrivi(EDITS, chiudiGesto(gesto, stato, "g1")!.riscritte);
    // every other field of the three routes is as the file had it
    expect(edits.pcb_routes.map((r) => ({ ...r, points: [] }))).toEqual(EDITS.pcb_routes.map((r) => ({ ...r, points: [] })));

    const dopo = aggiorna(edits);
    comeIlFile(dopo, edits);
    // the three pieces where the gesture left them, under the keys their new paths give
    const nuove = (["gndUscita", "gndDiscesa", "gndRientro"] as Nome[]).map((n) => edits.pcb_routes[NOMI.indexOf(n)]);
    expect(tratti(nuove.map((r) => ({ punti: percorsoDellaPista(pistaDi(dopo, manualRouteKey(r))), larga: 0.2 })))).toEqual(disegnati(stato));
    // nothing is left of the copper that was at x = -12, nor of its keys
    for (const n of ["gndUscita", "gndDiscesa", "gndRientro"] as Nome[]) expect(piste(dopo).some((e) => e.manual_route_id === chiave(n))).toBe(false);
    expect(piste(dopo).flatMap((e) => percorsoDellaPista(e)).some((q) => q.x === -12)).toBe(false);
    // the rest of the board has not moved
    expect(rame(dopo).vie).toEqual(rame(salvata).vie);
    expect(distanze(dopo)).toEqual([]);
    // and a compile of the files with that file lays the same copper
    const compilata = await compileProject({ ...FILES, [MANUAL_EDITS_PATH]: serializeManualEdits(edits) });
    expect(rame(compilata.circuitJson)).toEqual(rame(dopo));
    comeIlFile(compilata.circuitJson, edits);
  }, 120_000);

  it("grabbed again on the board that shows it, under its new key, and dragged back: the file and the copper are the ones of the start", () => {
    const primo = inizia(trattoDi(chiave("gndDiscesa"), 0));
    const edits = riscrivi(EDITS, chiudiGesto(primo.gesto, muoviGesto(primo.gesto, { x: -13, y: -4 }), "g1")!.riscritte);
    const dopo = aggiorna(edits);
    const nuovaChiave = manualRouteKey(edits.pcb_routes[NOMI.indexOf("gndDiscesa")]);
    expect(nuovaChiave).not.toBe(chiave("gndDiscesa"));

    const ancora = inizia(trattoDi(nuovaChiave, 0, dopo), dopo);
    const stato = muoviGesto(ancora.gesto, { x: -12, y: -1 });
    const salvataggio = chiudiGesto(ancora.gesto, stato, "g2")!;
    expect(salvataggio.riscritte.map((r) => r.chiave)).toContain(nuovaChiave);
    const tornati = riscrivi(edits, salvataggio.riscritte);
    expect(serializeManualEdits(tornati)).toBe(serializeManualEdits(EDITS));
    const tornata = aggiorna(tornati, dopo);
    expect(rame(tornata)).toEqual(rame(salvata));
    comeIlFile(tornata, EDITS);
  });
});

describe("spinta, gesto a mano: the via of an import, which is a route of its own, with the pieces that end on it", () => {
  const ALLA_VIA = [top(-10.51, -6), top(-10.51, -8), top(0.5, -8), top(1, -7.5)];
  const VIA = [top(1, -7.5), bottom(1, -7.5)];
  const SOTTO = [bottom(1, -7.5), bottom(1.5, -8), bottom(4, -8), bottom(4, -10)];

  it("the via moves, and with it its own route and the end of every piece that ends on it, on both layers", () => {
    const { gesto, stato: fermo } = inizia(viaDella("0;-8"));
    expect(fermo.nascosti).toEqual({
      pcbTraceIds: ["gndAllaVia", "gndVia", "gndSotto"].map((n) => pistaDi(salvata, chiave(n as Nome)).pcb_trace_id),
      pcbViaIds: [viaIn(salvata, "0;-8").pcb_via_id],
    });
    expect(fermo.vie).toEqual([{ x: 0, y: -8, outerDiameter: 0.5, holeDiameter: 0.25 }]);

    const stato = muoviGesto(gesto, { x: 1, y: -7.5 });
    expect(stato).toMatchObject({ mosso: true, blocco: null, posizione: { x: 1, y: -7.5 }, vie: [{ x: 1, y: -7.5, outerDiameter: 0.5, holeDiameter: 0.25 }] });
    // the last stretch of each piece keeps its direction and gains a leg at 45 degrees; the route of the via has no stretch
    expect(disegnati(stato)).toEqual(tratti([ALLA_VIA, SOTTO].map((punti) => ({ punti, larga: 0.2 }))));
    expect(chiudiGesto(gesto, stato, "g3")).toEqual({
      routes: [],
      vias: [],
      riscritte: [
        { chiave: chiave("gndAllaVia"), points: ALLA_VIA },
        { chiave: chiave("gndVia"), points: VIA },
        { chiave: chiave("gndSotto"), points: SOTTO },
      ],
    });
  });

  it("rewritten and laid: one via, of its size, in the new place; the pieces end on it; none of it where it was", async () => {
    const { gesto } = inizia(viaDella("0;-8"));
    const stato = muoviGesto(gesto, { x: 1, y: -7.5 });
    const edits = riscrivi(EDITS, chiudiGesto(gesto, stato, "g3")!.riscritte);
    // the size of the via is a field of its route: the file keeps it, nobody sent it
    expect(edits.pcb_routes[NOMI.indexOf("gndVia")]).toMatchObject({ viaDiameter: 0.5, viaHoleDiameter: 0.25, importato: true, net: "GND", connection: "net.GND" });

    const dopo = aggiorna(edits);
    comeIlFile(dopo, edits);
    expect(rame(dopo).vie).toEqual(["-2;2 0.6/0.3", "1;-7.5 0.5/0.25", "4;-10 0.3/0.2", "6;2 0.6/0.3"]);
    expect(viaIn(dopo, "1;-7.5")).toMatchObject({ manual: true });
    const nuove = (["gndAllaVia", "gndSotto"] as Nome[]).map((n) => edits.pcb_routes[NOMI.indexOf(n)]);
    expect(tratti(nuove.map((r) => ({ punti: percorsoDellaPista(pistaDi(dopo, manualRouteKey(r))), larga: 0.2 })))).toEqual(disegnati(stato));
    expect(piste(dopo).flatMap((e) => percorsoDellaPista(e)).some((q) => q.x === 0 && q.y === -8)).toBe(false);
    expect(distanze(dopo)).toEqual([]);
    const compilata = await compileProject({ ...FILES, [MANUAL_EDITS_PATH]: serializeManualEdits(edits) });
    expect(rame(compilata.circuitJson)).toEqual(rame(dopo));
  }, 120_000);

  it("the place it goes to is on whole microns, where a hand route is read: asked for a place between two, it takes the nearest", () => {
    const { gesto } = inizia(viaDella("0;-8"));
    const stato = muoviGesto(gesto, { x: 1.00004, y: -7.49996 });
    expect(stato.posizione).toEqual({ x: 1, y: -7.5 });
    const fine = muoviGesto(gesto, { x: 0.0126, y: -8 });
    expect(fine.posizione).toEqual({ x: 0.013, y: -8 });
    for (const r of chiudiGesto(gesto, fine, "g3")!.riscritte) {
      for (const q of r.points) expect([Math.round(q.x * 1000) / 1000, Math.round(q.y * 1000) / 1000]).toEqual([q.x, q.y]);
    }
  });
});

describe("spinta, gesto a mano: a route drawn in Instrada between two pins", () => {
  it("a stretch of it dragged sideways: one route rewritten, under the key of its two pads, which does not change", () => {
    const k = chiave("disegnata");
    expect(k).toBe(".R1 > .pin2 ~ .R2 > .pin1");
    // the stretch at 45 degrees from (-8; 0) to (-6; 2), between two horizontal ones
    const { gesto, stato: fermo } = inizia(trattoDi(k, 1));
    expect(fermo.nascosti).toEqual({ pcbTraceIds: [pistaDi(salvata, k).pcb_trace_id], pcbViaIds: [] });
    const stato = muoviGesto(gesto, { x: -7.5, y: 1.5 });
    const NUOVO = [top(-9.49, 0), top(-9, 0), top(-7, 2), top(-2, 2), bottom(-2, 2), bottom(6, 2), top(6, 2), top(8, 0), top(9.49, 0)];
    expect(stato).toMatchObject({ mosso: true, blocco: null, vie: [] });
    expect(disegnati(stato)).toEqual(tratti([{ punti: NUOVO, larga: 0.25 }]));
    const salvataggio = chiudiGesto(gesto, stato, "g4")!;
    expect(salvataggio).toEqual({ routes: [], vias: [], riscritte: [{ chiave: k, points: NUOVO }] });

    const edits = riscrivi(EDITS, salvataggio.riscritte);
    expect(edits.pcb_routes[NOMI.indexOf("disegnata")]).toEqual({ ...route("disegnata"), points: NUOVO });
    const dopo = aggiorna(edits);
    comeIlFile(dopo, edits);
    expect(percorsoDellaPista(pistaDi(dopo, k))).toEqual(NUOVO);
    // its two vias have not moved
    expect(rame(dopo).vie).toEqual(rame(salvata).vie);
    expect(distanze(dopo)).toEqual([]);
  });

  it("a via inside its path moves within the route: the stretches on the two layers follow, and the via is laid where the route now changes layer", () => {
    const k = chiave("disegnata");
    const { gesto, stato: fermo } = inizia(viaDella("-2;2"));
    expect(fermo.nascosti).toEqual({ pcbTraceIds: [pistaDi(salvata, k).pcb_trace_id], pcbViaIds: [viaIn(salvata, "-2;2").pcb_via_id] });
    const stato = muoviGesto(gesto, { x: -1, y: 2.5 });
    const NUOVO = [top(-9.49, 0), top(-8, 0), top(-6, 2), top(-1.5, 2), top(-1, 2.5), bottom(-1, 2.5), bottom(-0.5, 2), bottom(6, 2), top(6, 2), top(8, 0), top(9.49, 0)];
    expect(stato).toMatchObject({ mosso: true, blocco: null, posizione: { x: -1, y: 2.5 }, vie: [{ x: -1, y: 2.5, outerDiameter: 0.6, holeDiameter: 0.3 }] });
    expect(disegnati(stato)).toEqual(tratti([{ punti: NUOVO, larga: 0.25 }]));
    const salvataggio = chiudiGesto(gesto, stato, "g5")!;
    expect(salvataggio).toEqual({ routes: [], vias: [], riscritte: [{ chiave: k, points: NUOVO }] });

    const edits = riscrivi(EDITS, salvataggio.riscritte);
    const dopo = aggiorna(edits);
    comeIlFile(dopo, edits);
    expect(rame(dopo).vie).toEqual(["-1;2.5 0.6/0.3", "0;-8 0.5/0.25", "4;-10 0.3/0.2", "6;2 0.6/0.3"]);
    expect(distanze(dopo)).toEqual([]);
  });
});

describe("spinta, gesto a mano: one gesture on copper of the files and hand copper together", () => {
  it("a lone via of the files with a hand trace ending on it: the via is a correction (`vias`), the trace a rewritten route (`riscritte`), and the board shows both", () => {
    const { gesto, stato: fermo } = inizia(viaDella("4;-10"));
    expect(fermo.nascosti).toEqual({ pcbTraceIds: [pistaDi(salvata, chiave("gndSotto")).pcb_trace_id], pcbViaIds: [viaIn(salvata, "4;-10").pcb_via_id] });
    const stato = muoviGesto(gesto, { x: 5, y: -9.5 });
    const SOTTO = [bottom(0, -8), bottom(4, -8), bottom(4, -8.5), bottom(5, -9.5)];
    expect(stato).toMatchObject({ mosso: true, blocco: null, posizione: { x: 5, y: -9.5 }, vie: [{ x: 5, y: -9.5, outerDiameter: 0.3, holeDiameter: 0.2 }] });
    const salvataggio = chiudiGesto(gesto, stato, "g6")!;
    expect(salvataggio).toEqual({
      routes: [],
      vias: [{ net: "GND", from: { x: 4, y: -10 }, to: { x: 5, y: -9.5 }, holeDiameter: 0.2, outerDiameter: 0.3, layers: ["top", "bottom"], gesto: "g6" }],
      riscritte: [{ chiave: chiave("gndSotto"), points: SOTTO }],
    });

    // the hand routes by their key, then the correction of the via the way a save of copper goes
    const riscritti = riscrivi(EDITS, salvataggio.riscritte);
    const letto = leggiRame({ routes: salvataggio.routes, vias: salvataggio.vias, gesto: "g6" }, { maxRoutes: 200, maxPoints: 2000, maxVias: 500 }, "2026-11-12T10:00:00.000Z");
    if ("errore" in letto) throw new Error(letto.errore);
    expect(verificaRame({ circuitJson: salvata, regole: REGOLE, correnti: riscritti, rame: letto.rame })).toEqual({ ok: true });
    const edits = applyCopperPatch(riscritti, letto.rame).edits;

    const dopo = aggiorna(edits);
    comeIlFile(dopo, edits);
    expect(percorsoDellaPista(pistaDi(dopo, manualRouteKey(edits.pcb_routes[NOMI.indexOf("gndSotto")])))).toEqual(SOTTO);
    expect(tratti([{ punti: SOTTO, larga: 0.2 }])).toEqual(disegnati(stato));
    // the via is the element of the files, moved: its id, its size, where it came from
    expect(rame(dopo).vie).toEqual(["-2;2 0.6/0.3", "0;-8 0.5/0.25", "5;-9.5 0.3/0.2", "6;2 0.6/0.3"]);
    expect(viaIn(dopo, "5;-9.5")).toMatchObject({ pcb_via_id: viaIn(salvata, "4;-10").pcb_via_id, moved_from: { x: 4, y: -10 } });
    expect(distanze(dopo)).toEqual([]);
  });
});

/** hand routes laid on a small board written by hand: two resistors, GND on the first pin of each */
const posa = (routes: unknown[], rame: El[] = []): El[] =>
  applyManualRoutes({
    circuitJson: [schedaVuota(2), ...pezzo("R1", [["1", -10, 0], ["2", -9, 0]]), ...pezzo("R2", [["1", 10, 0], ["2", 11, 0]]), ...rete(1, "GND", ["R1_1", "R2_1"]), ...rame],
    routes: parseManualRoutes(routes),
    vias: [],
    viaDiameter: 0.6,
    viaHoleDiameter: 0.3,
  }).circuitJson as El[];
const REGOLE_DI_SERIE = resolveDesignRules({}).rules;

describe("spinta, gesto a mano: every corner on whole microns", () => {
  /*
   * A stretch at 45 degrees between two stretches at 45 degrees the other way.
   * The lines of two such stretches cross on the grid only every second step,
   * and a hand route is read on whole microns: so this stretch moves by steps
   * of two microns of its line, each corner by one micron along its neighbour.
   * Never a corner between two microns, which the file would round and bend.
   */
  const ZIGZAG = [top(-10, 0), top(-10, 2), top(-8, 4), top(-6, 2), top(-4, 4), top(-4, 8)];
  const prendi = () => {
    const cj = posa([gnd(ZIGZAG)]);
    const esito = iniziaGesto({ circuitJson: cj, regole: REGOLE_DI_SERIE, presa: { tipo: "tratto", pcbTraceId: String(piste(cj)[0].pcb_trace_id), indice: 2 } });
    if ("rifiuto" in esito) throw new Error(esito.rifiuto);
    return esito.gesto;
  };
  const percorso = (gesto: ReturnType<typeof prendi>, dx: number, dy: number) => {
    // from the middle of the stretch, (-7; 3)
    const stato = muoviGesto(gesto, { x: -7 + dx, y: 3 + dy });
    expect(stato.blocco).toBeNull();
    return chiudiGesto(gesto, stato, "g")?.riscritte[0].points ?? null;
  };

  it("moved by half a millimetre each way, the two corners go three quarters of a millimetre along their neighbours", () => {
    expect(percorso(prendi(), 0.5, 0.5)).toEqual([top(-10, 0), top(-10, 2), top(-7.5, 4.5), top(-5.5, 2.5), top(-4, 4), top(-4, 8)]);
  });

  it("asked for less than a step it does not move; asked for a place between two steps it takes the nearest, one micron along each neighbour", () => {
    const gesto = prendi();
    // 0.4 microns of the line: under half a step of two
    expect(percorso(gesto, 0.0002, 0.0002)).toBeNull();
    // 1.4 microns of the line: the step of two
    expect(percorso(gesto, 0.0007, 0.0007)).toEqual([top(-10, 0), top(-10, 2), top(-7.999, 4.001), top(-5.999, 2.001), top(-4, 4), top(-4, 8)]);
  });

  it("wherever the pointer goes, every point is on whole microns and every stretch at 45 or 90 degrees exactly", () => {
    const gesto = prendi();
    let mossi = 0;
    for (let i = 1; i <= 200; i++) {
      // a spread of small and odd movements, both ways across the stretch
      const quanto = ((i * 7919) % 2003) / 4000 - 0.25;
      const punti = percorso(gesto, quanto + i * 0.00001, quanto - i * 0.00003);
      if (!punti) continue;
      mossi++;
      for (const q of punti) expect([Math.abs(inUnita(q.x)) % 10, Math.abs(inUnita(q.y)) % 10], JSON.stringify(q)).toEqual([0, 0]);
      for (let k = 1; k < punti.length; k++) {
        expect(direzioneEsatta(inUnita(punti[k].x) - inUnita(punti[k - 1].x), inUnita(punti[k].y) - inUnita(punti[k - 1].y)), `${i}: ${JSON.stringify(punti)}`).toBe(true);
      }
      // the directions are the ones the route had
      expect(punti.slice(1).map((q, k) => [Math.sign(q.x - punti[k].x), Math.sign(q.y - punti[k].y)])).toEqual([[0, 1], [1, 1], [1, -1], [1, 1], [0, 1]]);
    }
    expect(mossi).toBeGreaterThan(150);
  });
});

describe("spinta, gesto a mano: a via of an import on which nothing ends", () => {
  it("just moves: its route is rewritten, both its points in the new place", () => {
    const cj = posa([gnd([top(0, 5), bottom(0, 5)], { viaDiameter: 0.5, viaHoleDiameter: 0.25 })]);
    const esito = iniziaGesto({ circuitJson: cj, regole: REGOLE_DI_SERIE, presa: { tipo: "via", pcbViaId: String(vie(cj)[0].pcb_via_id) } });
    if ("rifiuto" in esito) throw new Error(esito.rifiuto);
    expect(esito.stato.nascosti).toEqual({ pcbTraceIds: [piste(cj)[0].pcb_trace_id], pcbViaIds: [vie(cj)[0].pcb_via_id] });
    const stato = muoviGesto(esito.gesto, { x: 1.25, y: 6 });
    expect(stato).toMatchObject({ mosso: true, blocco: null, tratti: [], vie: [{ x: 1.25, y: 6, outerDiameter: 0.5, holeDiameter: 0.25 }] });
    expect(chiudiGesto(esito.gesto, stato, "g")).toEqual({
      routes: [],
      vias: [],
      riscritte: [{ chiave: piste(cj)[0].manual_route_id, points: [top(1.25, 6), bottom(1.25, 6)] }],
    });
  });
});

describe("spinta, gesto a mano: what cannot move", () => {
  const rifiuto = (cj: El[], presa: PresaDelRame): string => {
    const esito = iniziaGesto({ circuitJson: cj, regole: REGOLE_DI_SERIE, presa });
    if (!("rifiuto" in esito)) throw new Error("preso, e non doveva");
    return esito.rifiuto;
  };
  const ilTratto = (cj: El[], punti: ManualRoutePoint[]): PresaDelRame => ({
    tipo: "tratto",
    pcbTraceId: String(piste(cj).find((e) => JSON.stringify(percorsoDellaPista(e)) === JSON.stringify(punti))!.pcb_trace_id),
    indice: 0,
  });

  it("where three pieces end in one place it is a T junction: a piece that ends there does not slide", () => {
    const tronco = [top(-10, 0), top(-10, 4)];
    const sinistra = [top(-10, 4), top(-14, 4), top(-14, 8)];
    const destra = [top(-10, 4), top(-6, 4), top(-6, 8)];
    const cj = posa([gnd(tronco), gnd(sinistra), gnd(destra)]);
    // the first stretch of the left branch: one end at the joint of the three
    expect(rifiuto(cj, ilTratto(cj, sinistra))).toBe("bloccato da una giunzione a T con la pista GND");
    // with two pieces only, the same stretch is taken: its neighbour is the trunk
    const due = posa([gnd(tronco), gnd(sinistra)]);
    const preso = iniziaGesto({ circuitJson: due, regole: REGOLE_DI_SERIE, presa: ilTratto(due, sinistra) });
    expect(preso).not.toHaveProperty("rifiuto");
  });

  it("a piece chained to another on the same line has no corner to slide along: it would take a new one", () => {
    const primo = [top(-10, 0), top(-10, 4)];
    const secondo = [top(-10, 4), top(-10, 8)];
    const terzo = [top(-10, 8), top(-6, 8)];
    const cj = posa([gnd(primo), gnd(secondo), gnd(terzo)]);
    expect(rifiuto(cj, ilTratto(cj, secondo))).toBe("bloccato: il tratto vicino e' sulla stessa retta, servirebbe un gomito nuovo");
  });

  it("a via of the files in which only a hand route changes layer: moved, the route would get a via of its own and this one would stay", () => {
    // a lone via of GND the files put at (-10; 4), and a hand piece that goes down through it
    const cj = posa([gnd([top(-10, 0), top(-10, 4), bottom(-10, 4), bottom(-6, 4)])], [viaDi("v_file", -10, 4, 1)]);
    // the route laid no via of its own there: the hole is the one of the files
    expect(vie(cj).map((v) => [v.pcb_via_id, v.manual])).toEqual([["v_file", undefined]]);
    expect(rifiuto(cj, { tipo: "via", pcbViaId: "v_file" })).toBe("bloccato: la via e' dei file e ci cambia strato solo una pista a mano: spostata, resterebbe dov'e'");
  });

  it("two traces with one key (the file holds that route twice): rewriting by key would not say which", () => {
    const doppia = gnd([top(-10, 0), top(-10, 4), top(-6, 4)]);
    const cj = posa([doppia, doppia]);
    expect(piste(cj)).toHaveLength(2);
    expect(rifiuto(cj, { tipo: "tratto", pcbTraceId: String(piste(cj)[0].pcb_trace_id), indice: 1 })).toContain("due piste a mano hanno la stessa chiave nel file");
  });

  it("hand copper that does not carry the key of its route (laid by an older engine) is not moved", () => {
    const cj = posa([gnd([top(-10, 0), top(-10, 4), top(-6, 4)])]).map((e) => {
      if (e.type !== "pcb_trace") return e;
      const senza = { ...e };
      delete senza.manual_route_id;
      return senza;
    });
    expect(rifiuto(cj, { tipo: "tratto", pcbTraceId: String(piste(cj)[0].pcb_trace_id), indice: 1 })).toContain("la pista a mano non porta la chiave della sua route");
  });
});
