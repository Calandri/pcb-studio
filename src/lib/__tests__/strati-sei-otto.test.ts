import { describe, expect, it } from "vitest";
import { DEFAULT_DESIGN_RULES, type DesignRules } from "@/lib/design-rules";
import { pianiSopraLeVie, runDrcChecks } from "@/lib/drc";
import { cuciLaMassa, type EsitoCucitura, type OpzioniCucitura } from "@/lib/ground-stitching";
import { vieComeElementi } from "@/lib/ground-stitching-file";
import { applyManualRoutes, parseManualRoutes, type ManualRoute } from "@/lib/manual-routes";
import { colateTroppoVicine } from "@/lib/pour-pour";
import { DISTANZA_PROPRIA } from "@/lib/pours";
import {
  COLORE_DEL_RAME,
  STRATI_MASSIMI,
  STRATI_NOTI,
  didascaliaDelloStrato,
  eStratoDiRame,
  nomeDelloStrato,
  pilaDiRame,
  stratiDiRame,
} from "@/lib/strati-rame";
import { stratiDiRame as daViaLayers, vieDichiarateParziali, viePassantiSuOgniStrato, viePerLaForatura, vieSemprePassanti } from "@/lib/via-layers";

/*
 * Le schede a 6 e a 8 strati di rame (2026-11-12). Gli strati di una scheda
 * vengono da un posto solo, strati-rame.ts, dal numero che la scheda dichiara:
 * top, inner1 ... inner(n-2), bottom. Qui la fonte, e ogni controllo che
 * elenca gli strati, su schede costruite a mano con il rame su inner3..inner6:
 * DRC, vie, colata contro colata, piste a mano, cucitura della massa.
 */
type El = { type: string; [key: string]: unknown };
type P = { x: number; y: number };

const SEI = ["top", "inner1", "inner2", "inner3", "inner4", "bottom"];
const OTTO = ["top", "inner1", "inner2", "inner3", "inner4", "inner5", "inner6", "bottom"];
const rett = (x0: number, y0: number, x1: number, y1: number): P[] => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];
const scheda = (n: number, lato = 20): El => ({ type: "pcb_board", pcb_board_id: "b", center: { x: 0, y: 0 }, width: lato, height: lato, num_layers: n });

describe("la fonte unica degli strati di rame", () => {
  it("2, 4, 6 e 8 strati: top, inner1..inner(n-2), bottom", () => {
    expect(stratiDiRame(2)).toEqual(["top", "bottom"]);
    expect(stratiDiRame(4)).toEqual(["top", "inner1", "inner2", "bottom"]);
    expect(stratiDiRame(6)).toEqual(SEI);
    expect(stratiDiRame(8)).toEqual(OTTO);
    expect(STRATI_MASSIMI).toBe(8);
    expect(STRATI_NOTI).toEqual(OTTO);
    // one function, also for whoever imports it from via-layers.ts
    expect(daViaLayers).toBe(stratiDiRame);
  });

  it("un numero che manca, sotto 2 o non intero: come e' sempre stato", () => {
    // missing or not a number: two layers
    expect(stratiDiRame(Number.NaN)).toEqual(["top", "bottom"]);
    expect(stratiDiRame(Number(undefined))).toEqual(["top", "bottom"]);
    // tscircuit accepts layers={1}: two layers all the same
    expect(stratiDiRame(1)).toEqual(["top", "bottom"]);
    expect(stratiDiRame(0)).toEqual(["top", "bottom"]);
    // not whole: rounded down
    expect(stratiDiRame(4.9)).toEqual(["top", "inner1", "inner2", "bottom"]);
  });

  it("un numero dispari da' tanti nomi quanti ne dice; oltre 8 i controlli li nominano tutti, il visore si ferma agli otto che conosce", () => {
    expect(stratiDiRame(3)).toEqual(["top", "inner1", "bottom"]);
    expect(stratiDiRame(5)).toEqual(["top", "inner1", "inner2", "inner3", "bottom"]);
    expect(pilaDiRame(3)).toEqual(["top", "inner1", "bottom"]);
    // ten layers: eight inner names for the checks, the six known ones for what draws them
    expect(stratiDiRame(10)).toEqual(["top", "inner1", "inner2", "inner3", "inner4", "inner5", "inner6", "inner7", "inner8", "bottom"]);
    expect(pilaDiRame(10)).toEqual(OTTO);
    for (const n of [2, 4, 6, 8]) expect(pilaDiRame(n)).toEqual(stratiDiRame(n));
  });

  it("i nomi che legge una persona, e che cosa e' lo strato scelto", () => {
    expect(OTTO.map(nomeDelloStrato)).toEqual(["Top", "Inner 1", "Inner 2", "Inner 3", "Inner 4", "Inner 5", "Inner 6", "Bottom"]);
    expect(OTTO.map(didascaliaDelloStrato)).toEqual([
      "lato componenti",
      "piano interno 1",
      "piano interno 2",
      "piano interno 3",
      "piano interno 4",
      "piano interno 5",
      "piano interno 6",
      "lato saldature",
    ]);
    expect(didascaliaDelloStrato("all")).toBe("tutti gli strati");
  });

  it("riconosce gli otto nomi e nient'altro, e ognuno ha il suo colore", () => {
    for (const s of OTTO) expect(eStratoDiRame(s)).toBe(true);
    for (const s of ["inner7", "inner0", "all", "", null, undefined, 3]) expect(eStratoDiRame(s)).toBe(false);
    expect(Object.keys(COLORE_DEL_RAME)).toEqual(OTTO);
    expect(new Set(Object.values(COLORE_DEL_RAME)).size).toBe(8);
  });
});

describe("DRC su una scheda a 6 e a 8 strati", () => {
  const RETI: El[] = [
    { type: "source_net", source_net_id: "n1", name: "A", subcircuit_connectivity_map_key: "k1" },
    { type: "source_net", source_net_id: "n2", name: "B", subcircuit_connectivity_map_key: "k2" },
    { type: "source_trace", source_trace_id: "st1", subcircuit_connectivity_map_key: "k1", connected_source_port_ids: [], connected_source_net_ids: ["n1"] },
    { type: "source_trace", source_trace_id: "st2", subcircuit_connectivity_map_key: "k2", connected_source_port_ids: [], connected_source_net_ids: ["n2"] },
  ];
  /** a straight trace 0,2 wide along x from 0 to 5, at height y */
  const pista = (id: string, rete: 1 | 2, layer: string, y: number): El => ({
    type: "pcb_trace",
    pcb_trace_id: id,
    source_trace_id: `st${rete}`,
    subcircuit_connectivity_map_key: `k${rete}`,
    route: [
      { route_type: "wire", x: 0, y, width: 0.2, layer },
      { route_type: "wire", x: 5, y, width: 0.2, layer },
    ],
  });
  const punti = (n: number, els: El[], regola: string) =>
    runDrcChecks([scheda(n), ...RETI, ...els] as never, DEFAULT_DESIGN_RULES)
      .filter((v) => v.rule === regola)
      .flatMap((v) => v.points ?? []);

  it("due piste di reti diverse troppo vicine su un interno oltre il secondo: il punto e' di quello strato", () => {
    // axes 0,25 apart, each 0,2 wide: 0,05 between the edges, under the minimum; the point is halfway along the first
    for (const [n, strato] of [[6, "inner3"], [6, "inner4"], [8, "inner5"], [8, "inner6"]] as const) {
      expect(punti(n, [pista("a", 1, strato, 0), pista("b", 2, strato, 0.25)], "trace_trace_clearance"), strato).toEqual([{ x: 2.5, y: 0, layer: strato }]);
    }
  });

  it("su due interni diversi non si vedono", () => {
    expect(punti(6, [pista("a", 1, "inner3", 0), pista("b", 2, "inner4", 0.25)], "trace_trace_clearance")).toEqual([]);
    expect(punti(8, [pista("a", 1, "inner5", 0), pista("b", 2, "inner6", 0.25)], "trace_trace_clearance")).toEqual([]);
    expect(punti(8, [pista("a", 1, "inner2", 0), pista("b", 2, "inner6", 0.25)], "trace_trace_clearance")).toEqual([]);
  });

  it("un piano che non si apre attorno alla via di un'altra rete, su inner4 e su inner6: detto con il suo strato", () => {
    const regole = { ...DEFAULT_DESIGN_RULES, minClearanceMm: 0.152, pourClearanceMm: 0.152, minViaHoleMm: 0.2, minViaDiameterMm: 0.5 };
    for (const [n, strato, pila] of [[6, "inner4", SEI], [8, "inner6", OTTO]] as const) {
      const piano = (buchi: P[][]): El => ({
        type: "pcb_copper_pour",
        pcb_copper_pour_id: "p",
        layer: strato,
        source_net_id: "n1",
        shape: "brep",
        brep_shape: { outer_ring: { vertices: rett(-9, -9, 9, 9) }, inner_rings: buchi.map((v) => ({ vertices: v })) },
      });
      const via: El = { type: "pcb_via", pcb_via_id: "v", x: 6, y: 0, outer_diameter: 0.5, hole_diameter: 0.2, layers: pila, subcircuit_connectivity_map_key: "k2" };
      const chiuso = [scheda(n), ...RETI, via, piano([])];
      const trovate = runDrcChecks(chiuso as never, regole).filter((v) => v.rule === "pour_clearance");
      expect(trovate.map((v) => v.message.split(":")[0])).toEqual([`v <-> A pour on ${strato}`]);
      expect(trovate[0].points).toEqual([{ x: 6, y: 0, layer: strato }]);
      expect(pianiSopraLeVie(chiuso as never)).toMatchObject({ count: 1, detail: expect.stringContaining(`nel piano A su ${strato}`) });
      // opened 0,25 + 0,2 around the hole: the pad's edge is 0,2 from the copper, over the 0,152 asked
      const aperto = [scheda(n), ...RETI, via, piano([rett(6 - 0.45, -0.45, 6 + 0.45, 0.45)])];
      expect(runDrcChecks(aperto as never, regole).filter((v) => v.rule === "pour_clearance")).toEqual([]);
      expect(pianiSopraLeVie(aperto as never)).toBeUndefined();
    }
  });
});

describe("le vie di una scheda a 6 e a 8 strati", () => {
  const reti: El[] = [
    { type: "source_net", source_net_id: "gnd", name: "GND", subcircuit_connectivity_map_key: "k_gnd" },
    { type: "source_net", source_net_id: "sig", name: "SIG", subcircuit_connectivity_map_key: "k_sig" },
  ];
  type Via = { pcb_via_id: string; layers: string[]; declared_layers?: string[]; from_layer?: string; to_layer?: string };
  const via = (cj: unknown[], id: string) => (cj as Via[]).find((e) => e.pcb_via_id === id)!;

  it("una via scritta su parte della pila elenca tutta la pila della sua scheda", () => {
    // as tscircuit writes the via of a hand-drawn trace that goes from the top down to inner3
    const giu: El = { type: "pcb_via", pcb_via_id: "giu", x: 2, y: 2, outer_diameter: 0.5, hole_diameter: 0.2, layers: ["top", "inner1", "inner2", "inner3"], from_layer: "top", to_layer: "inner3", subcircuit_connectivity_map_key: "k_sig" };
    for (const [n, pila] of [[6, SEI], [8, OTTO]] as const) {
      const out = vieSemprePassanti([scheda(n), giu] as never[]);
      expect(via(out, "giu").layers).toEqual(pila);
      expect(via(out, "giu").declared_layers).toEqual(["top", "inner1", "inner2", "inner3"]);
      expect([via(out, "giu").from_layer, via(out, "giu").to_layer]).toEqual(["top", "inner3"]);
      // a second pass leaves it alone
      expect(vieSemprePassanti(out)).toBe(out);
    }
    // one via of one board written without its top or its bottom
    expect(vieDichiarateParziali([scheda(8), giu] as never[])).toBe(1);
  });

  it("nel Gerber la corona c'e' sugli interni dove la via e' collegata, anche oltre il secondo, e non sugli altri", () => {
    // ground plane on inner4 over the whole board; a signal trace on inner6 that ends on the signal via
    const piano: El = { type: "pcb_copper_pour", pcb_copper_pour_id: "p", layer: "inner4", source_net_id: "gnd", brep_shape: { outer_ring: { vertices: rett(-4, -4, 4, 4) }, inner_rings: [{ vertices: rett(1.5, 1.5, 2.5, 2.5) }] } };
    const viaGnd: El = { type: "pcb_via", pcb_via_id: "vg", x: -1, y: -1, outer_diameter: 0.5, hole_diameter: 0.15, layers: ["top", "bottom"], subcircuit_connectivity_map_key: "k_gnd" };
    const viaSig: El = { type: "pcb_via", pcb_via_id: "vs", x: 2, y: 2, outer_diameter: 0.5, hole_diameter: 0.15, layers: ["top", "bottom"], subcircuit_connectivity_map_key: "k_sig" };
    const pistaInner6: El = { type: "pcb_trace", pcb_trace_id: "t", route: [{ route_type: "wire", x: 2, y: 2, layer: "inner6", width: 0.2 }, { route_type: "wire", x: 3, y: 2, layer: "inner6", width: 0.2 }] };
    const out = viePassantiSuOgniStrato([scheda(8, 10), ...reti, piano, viaGnd, viaSig, pistaInner6] as never[]);
    expect(via(out, "vg").layers).toEqual(["top", "inner4", "bottom"]);
    expect(via(out, "vs").layers).toEqual(["top", "inner6", "bottom"]);
  });

  it("la foratura le prende tutte da top a bottom, qualunque strato colleghino", () => {
    const giu: El = { type: "pcb_via", pcb_via_id: "giu", x: 2, y: 2, outer_diameter: 0.5, hole_diameter: 0.2, layers: ["inner4", "inner5"], from_layer: "inner4", to_layer: "inner5" };
    const out = viePerLaForatura([scheda(8), giu] as never[]) as unknown as Via[];
    expect([via(out, "giu").from_layer, via(out, "giu").to_layer]).toEqual(["top", "bottom"]);
  });
});

describe("colata contro colata oltre il quarto strato interno", () => {
  const reti: El[] = [
    { type: "source_net", source_net_id: "n_gnd", name: "GND", subcircuit_connectivity_map_key: "k_gnd" },
    { type: "source_net", source_net_id: "n_usb", name: "USB1_GUSCIO", subcircuit_connectivity_map_key: "k_usb" },
  ];
  const colata = (id: string, net: string, layer: string, esterno: P[], extra: Record<string, unknown> = {}): El => ({
    type: "pcb_copper_pour", pcb_copper_pour_id: id, source_net_id: net, layer,
    brep_shape: { outer_ring: { vertices: esterno }, inner_rings: [] }, ...extra,
  });
  /*
   * The case of pour-pour.test.ts, on any layer: the ground declares 0,25 and
   * holds its via whole (the notch 10..10,5 x 2,75..3,25 around the via at
   * 10,25; 3, pad 0,5); the strip of the other net stands `gap` from that via,
   * at its own 0,152. Where the near copper is the via, the strip's clearance
   * is the minimum: 0,16 passes, 0,10 does not.
   */
  const via: El = { type: "pcb_via", pcb_via_id: "v", x: 10.25, y: 3, outer_diameter: 0.5, hole_diameter: 0.25, layers: ["top", "bottom"], subcircuit_connectivity_map_key: "k_gnd" };
  const conVia = [...rett(0, 0, 10, 10).slice(0, 2), { x: 10, y: 2.75 }, { x: 10.5, y: 2.75 }, { x: 10.5, y: 3.25 }, { x: 10, y: 3.25 }, ...rett(0, 0, 10, 10).slice(2)];
  const caso = (n: number | null, layer: string, gap: number, conLaVia = true): El[] => [
    ...(n === null ? [] : [scheda(n, 40)]),
    ...reti,
    ...(conLaVia ? [via] : []),
    colata("gnd", "n_gnd", layer, conVia, { [DISTANZA_PROPRIA]: 0.25 }),
    colata("usb", "n_usb", layer, rett(10.5 + gap, 2, 13, 4)),
  ];

  it("8 strati: su inner5 e inner6 la via della propria rete e' riconosciuta (l'elenco a mano si fermava a inner4)", () => {
    for (const strato of ["inner5", "inner6"]) {
      expect(colateTroppoVicine(caso(8, strato, 0.16), 0.152), strato).toHaveLength(0);
      const vicine = colateTroppoVicine(caso(8, strato, 0.1), 0.152);
      expect(vicine).toHaveLength(1);
      expect(vicine[0]).toMatchObject({ layer: strato, reteA: "GND", reteB: "USB1_GUSCIO" });
      // the same copper without the via is a plain edge of the ground, 0,16 from the strip where the ground asks 0,25
      expect(colateTroppoVicine(caso(8, strato, 0.16, false), 0.152)).toHaveLength(1);
    }
  });

  it("6 strati su inner3 e inner4, 4 strati su inner1 e inner2, 2 strati sulle facce: le risposte di prima", () => {
    for (const [n, strato] of [[6, "inner3"], [6, "inner4"], [4, "inner1"], [4, "inner2"], [4, "bottom"], [2, "top"], [2, "bottom"]] as const) {
      expect(colateTroppoVicine(caso(n, strato, 0.16), 0.152), `${n} ${strato}`).toHaveLength(0);
      expect(colateTroppoVicine(caso(n, strato, 0.1), 0.152), `${n} ${strato}`).toHaveLength(1);
    }
  });

  it("una colata scritta su uno strato che la scheda non dichiara, o una scheda senza pcb_board: la via la attraversa lo stesso, come prima", () => {
    // tscircuit pours <copperpour layer="inner1"> on a 2-layer board and says nothing
    expect(colateTroppoVicine(caso(2, "inner1", 0.16), 0.152)).toHaveLength(0);
    expect(colateTroppoVicine(caso(4, "inner3", 0.16), 0.152)).toHaveLength(0);
    expect(colateTroppoVicine(caso(null, "bottom", 0.16), 0.152)).toHaveLength(0);
    expect(colateTroppoVicine(caso(null, "bottom", 0.1), 0.152)).toHaveLength(1);
  });

  it("due colate di reti diverse che si toccano su inner6 sono un corto, su inner5 e inner6 non si vedono", () => {
    const sopra = [scheda(8, 40), ...reti, colata("gnd", "n_gnd", "inner6", rett(0, 0, 10, 10)), colata("usb", "n_usb", "inner6", rett(9.5, 2, 12, 4))];
    expect(colateTroppoVicine(sopra, 0.152)).toMatchObject([{ layer: "inner6", distanzaMm: 0 }]);
    const diversi = [scheda(8, 40), ...reti, colata("gnd", "n_gnd", "inner5", rett(0, 0, 10, 10)), colata("usb", "n_usb", "inner6", rett(9.5, 2, 12, 4))];
    expect(colateTroppoVicine(diversi, 0.152)).toEqual([]);
  });
});

describe("le piste a mano su inner3..inner6", () => {
  /** R1.pin2 to U1.IN, one connection named by one source trace, not routed yet */
  const base = (n: number): El[] => [
    scheda(n),
    { type: "source_component", source_component_id: "c_r1", name: "R1" },
    { type: "source_component", source_component_id: "c_u1", name: "U1" },
    { type: "source_port", source_port_id: "p_r1_2", source_component_id: "c_r1", name: "pin2" },
    { type: "source_port", source_port_id: "p_u1_in", source_component_id: "c_u1", name: "IN" },
    { type: "source_trace", source_trace_id: "st", display_name: ".R1 > .pin2 to .U1 > .IN", connected_source_port_ids: ["p_r1_2", "p_u1_in"], subcircuit_connectivity_map_key: "k_sig" },
  ];
  /** from the top down to `interno` at x 2, along it to x 8, back up to the top */
  const scritta = (interno: string) => ({
    connection: ".R1 > .pin2 to .U1 > .IN",
    from: ".R1 > .pin2",
    to: ".U1 > .IN",
    width: 0.2,
    points: [
      { x: 0, y: 0, layer: "top" },
      { x: 2, y: 0, layer: "top" },
      { x: 2, y: 0, layer: interno },
      { x: 8, y: 0, layer: interno },
      { x: 8, y: 0, layer: "top" },
      { x: 10, y: 0, layer: "top" },
    ],
  });
  const piste = (cj: unknown[]) => (cj as El[]).filter((e) => e.type === "pcb_trace");
  const stratiDellaPista = (cj: unknown[]) =>
    piste(cj).flatMap((t) => (t.route as Array<{ route_type: string; layer?: string }>).filter((p) => p.route_type === "wire").map((p) => p.layer));

  it("si leggono: una pista su inner3, inner4, inner5 o inner6 resta sul suo strato (veniva buttata intera)", () => {
    for (const interno of ["inner3", "inner4", "inner5", "inner6"]) {
      const [letta] = parseManualRoutes([scritta(interno)]);
      expect(letta.points.map((p) => p.layer)).toEqual(["top", "top", interno, interno, "top", "top"]);
    }
    // a name no board has is still refused whole
    expect(parseManualRoutes([scritta("inner7")])).toEqual([]);
    expect(parseManualRoutes([scritta("inner1"), scritta("inner2")])).toHaveLength(2);
  });

  it("si posano sulla scheda che ha quello strato: 6 strati fino a inner4, 8 fino a inner6, con due vie passanti", () => {
    for (const [n, interno, pila] of [[6, "inner3", SEI], [6, "inner4", SEI], [8, "inner5", OTTO], [8, "inner6", OTTO]] as const) {
      const routes = parseManualRoutes([scritta(interno)]) as ManualRoute[];
      const esito = applyManualRoutes({ circuitJson: base(n), routes });
      expect(esito.applied).toEqual([".R1 > .pin2 to .U1 > .IN"]);
      expect(esito.unknown).toEqual([]);
      expect(stratiDellaPista(esito.circuitJson)).toEqual(["top", "top", interno, interno, "top", "top"]);
      const vie = (esito.circuitJson as El[]).filter((e) => e.type === "pcb_via");
      // one hole where it goes down (x 2) and one where it comes back (x 8), each through the whole stack
      expect(vie.map((v) => v.x)).toEqual([2, 8]);
      for (const v of vie) expect(v.layers).toEqual(pila);
      expect(vie.map((v) => v.declared_layers)).toEqual([["top", interno], [interno, "top"]]);
    }
  });

  it("su una scheda che quello strato non ce l'ha non si posano, e lo dicono: niente rame su uno strato che non esiste", () => {
    // a board taken back from six layers to four with a route on inner3 in its file
    const routes = parseManualRoutes([scritta("inner3")]) as ManualRoute[];
    const esito = applyManualRoutes({ circuitJson: base(4), routes });
    expect(piste(esito.circuitJson)).toEqual([]);
    expect(esito.applied).toEqual([]);
    expect(esito.unknown).toEqual([".R1 > .pin2 ~ .U1 > .IN (inner3: la scheda ha 4 strati)"]);
    expect(applyManualRoutes({ circuitJson: base(6), routes: parseManualRoutes([scritta("inner5")]) }).unknown).toEqual([
      ".R1 > .pin2 ~ .U1 > .IN (inner5: la scheda ha 6 strati)",
    ]);
    // inner1 and inner2 are laid on any board, as they always were
    for (const n of [2, 4]) {
      const prima = applyManualRoutes({ circuitJson: base(n), routes: parseManualRoutes([scritta("inner2")]) });
      expect(prima.applied).toEqual([".R1 > .pin2 to .U1 > .IN"]);
      expect(stratiDellaPista(prima.circuitJson)).toEqual(["top", "top", "inner2", "inner2", "top", "top"]);
    }
  });
});

describe("Cuci la massa su una scheda a 6 e a 8 strati", () => {
  const REGOLE: DesignRules = {
    ...DEFAULT_DESIGN_RULES,
    minClearanceMm: 0.152,
    minTraceWidthMm: 0.127,
    minViaHoleMm: 0.15,
    minViaDiameterMm: 0.45,
    pourClearanceMm: 0.2,
    minHoleToHoleMm: 0.25,
    minBoardEdgeClearanceMm: 0.3,
  };
  /** the radius of the ring of the vias the tool proposes: 0,5 mm of ring */
  const R = 0.25;
  let k = 0;
  const base = (n: number): El[] => [
    scheda(n),
    { type: "source_net", source_net_id: "source_net_0", name: "GND", subcircuit_connectivity_map_key: "k_gnd", subcircuit_id: "s" },
    { type: "source_net", source_net_id: "source_net_1", name: "SIG", subcircuit_connectivity_map_key: "k_sig", subcircuit_id: "s" },
  ];
  const colata = (layer: string, punti: P[], buchi: P[][] = []): El => ({
    type: "pcb_copper_pour",
    pcb_copper_pour_id: `colata_${k++}`,
    layer,
    source_net_id: "source_net_0",
    shape: "brep",
    brep_shape: { outer_ring: { vertices: punti }, inner_rings: buchi.map((v) => ({ vertices: v })) },
  });
  /** ground over the whole 20 x 20 board, 0,3 from the edge, on these layers */
  const massa = (strati: readonly string[], buchi: P[][] = []): El[] => strati.map((s) => colata(s, rett(-9.7, -9.7, 9.7, 9.7), buchi));
  const cuci = (cj: El[], o: OpzioniCucitura = {}): EsitoCucitura => {
    const e = cuciLaMassa(cj, REGOLE, o);
    if (!e.ok) throw new Error(e.errore);
    return e;
  };
  const dentro = (x: number, y: number, a: P[]) => x > a[0].x && x < a[2].x && y > a[0].y && y < a[2].y;
  const vuoto = rett(-3, -3, 3, 3);
  const attornoAlVuoto = rett(-3 - R, -3 - R, 3 + R, 3 + R);

  it("non nel vuoto di un piano interno oltre il secondo: una finestra solo su inner4, o solo su inner6", () => {
    for (const [n, pila, conFinestra] of [[6, SEI, "inner4"], [8, OTTO, "inner6"]] as const) {
      const interi = pila.filter((s) => s !== conFinestra);
      const e = cuci([...base(n), ...massa(interi), ...massa([conFinestra], [vuoto])], { bordo: false, passoMm: 1 });
      expect(e.vie.length).toBeGreaterThan(100);
      for (const v of e.vie) expect(dentro(v.x, v.y, attornoAlVuoto), `${n} strati, via a ${v.x};${v.y}`).toBe(false);
      expect(e.scarti.manca_massa_interna).toBeGreaterThan(10);
      // the same board with that plane whole puts vias there too
      expect(cuci([...base(n), ...massa(pila)], { bordo: false, passoMm: 1 }).vie.some((v) => dentro(v.x, v.y, vuoto))).toBe(true);
    }
  });

  it("lontana da una pista di un'altra rete su inner5, dove la massa non c'e'", () => {
    // ground on every layer but inner5; a signal trace 0,2 wide along y = 0 on inner5
    const pista: El[] = [
      { type: "source_trace", source_trace_id: "st_t", subcircuit_connectivity_map_key: "k_sig", connected_source_port_ids: [], connected_source_net_ids: [] },
      { type: "pcb_trace", pcb_trace_id: "t", source_trace_id: "st_t", route: [{ route_type: "wire", x: -9, y: 0, width: 0.2, layer: "inner5" }, { route_type: "wire", x: 9, y: 0, width: 0.2, layer: "inner5" }] },
    ];
    const e = cuci([...base(8), ...massa(OTTO.filter((s) => s !== "inner5")), ...pista], { bordo: false, passoMm: 1 });
    expect(e.vie.length).toBeGreaterThan(100);
    // from the edge of the ring to the edge of the trace (half of 0,2) at least the pour clearance of the project
    for (const v of e.vie) expect(Math.abs(v.y) - 0.1 - R).toBeGreaterThanOrEqual(REGOLE.pourClearanceMm! - 1e-9);
    expect(e.scarti.pista_altra_rete).toBeGreaterThan(0);
  });

  it("le vie che propone attraversano tutta la pila della scheda", () => {
    for (const [n, pila] of [[6, SEI], [8, OTTO]] as const) {
      const cj = [...base(n), ...massa(pila)];
      const e = cuci(cj, { bordo: false, passoMm: 5 });
      const vie = vieComeElementi(e, cj);
      expect(vie.length).toBeGreaterThan(4);
      for (const v of vie) expect(v.layers).toEqual(pila);
    }
  });
});
