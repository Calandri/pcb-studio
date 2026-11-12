import { describe, expect, it } from "vitest";
import { DEFAULT_DESIGN_RULES, type DesignRules } from "@/lib/design-rules";
import { colateSopraIlRame, runDrcChecks, type DrcViolation, type MisureDrc } from "@/lib/drc";
import { CHECKS_ENGINE_VERSION, nonCertificata } from "@/lib/engine-version";
import { DISTANZA_PROPRIA } from "@/lib/pours";

/*
 * THE POURS AGAINST THE TRACES AND THE PADS OF THE OTHER NETS (drc.ts, check 9,
 * engine 13). The fast update never pours: a trace drawn across the pour of
 * another net, or a part moved onto one, stayed in that copper with every
 * check green and went to the Gerber (spinta-misure.test.ts, measure 6, has
 * the two cases on boards compiled for real, with the export).
 *
 * Here the geometry, on boards written by hand so that every number can be
 * worked out: a board of 40 x 30 mm and a ground pour that is the rectangle
 * from (-10; -5) to (10; 5), with no opening. The pours keep 0.2 mm from the
 * other nets (pourClearanceMm), every pair of copper 0.15 (minClearanceMm),
 * and a pour is forgiven a hundredth: under 0.19 it is a violation.
 */
type El = Record<string, unknown> & { type: string };
const REGOLE: DesignRules = { ...DEFAULT_DESIGN_RULES, minTraceWidthMm: 0.15, minClearanceMm: 0.15, pourClearanceMm: 0.2 };

const SCHEDA: El[] = [
  { type: "pcb_board", pcb_board_id: "scheda", center: { x: 0, y: 0 }, width: 40, height: 30, num_layers: 4, thickness: 1.6 },
  { type: "source_net", source_net_id: "net_gnd", name: "GND", subcircuit_connectivity_map_key: "k_net_gnd" },
  { type: "source_net", source_net_id: "net_sig", name: "SIG", subcircuit_connectivity_map_key: "k_net_sig" },
];
const RETTANGOLO: Array<[number, number]> = [[-10, -5], [10, -5], [10, 5], [-10, 5]];
const colata = (id: string, layer: string, esterno: Array<[number, number]> = RETTANGOLO, propriaMm?: number): El => ({
  type: "pcb_copper_pour",
  pcb_copper_pour_id: id,
  layer,
  source_net_id: "net_gnd",
  shape: "brep",
  brep_shape: { outer_ring: { vertices: esterno.map(([x, y]) => ({ x, y })) }, inner_rings: [] },
  ...(propriaMm !== undefined ? { [DISTANZA_PROPRIA]: propriaMm } : {}),
});
/** what puts a pin of a part on a net: the part, its port, the trace that names the net, the port on the board */
const piedino = (pezzo: string, net: string | null, x: number, y: number, layers: string[]): El[] => [
  { type: "source_component", source_component_id: `sc_${pezzo}`, name: pezzo },
  { type: "source_port", source_port_id: `sp_${pezzo}`, source_component_id: `sc_${pezzo}`, name: "pin1" },
  ...(net
    ? [{ type: "source_trace", source_trace_id: `st_${pezzo}`, display_name: `.${pezzo} > .pin1 to net.${net}`, connected_source_port_ids: [`sp_${pezzo}`], connected_source_net_ids: [`net_${net.toLowerCase()}`], subcircuit_connectivity_map_key: `k_net_${net.toLowerCase()}` }]
    : []),
  { type: "pcb_port", pcb_port_id: `pp_${pezzo}`, source_port_id: `sp_${pezzo}`, x, y, layers },
];
/** a part with one SMD pad, w x h, on a net (or on none) */
const piazzola = (pezzo: string, net: string | null, x: number, y: number, w = 0.6, h = 0.6, layer = "top"): El[] => [
  ...piedino(pezzo, net, x, y, [layer]),
  { type: "pcb_smtpad", pcb_smtpad_id: `pad_${pezzo}`, pcb_port_id: `pp_${pezzo}`, shape: "rect", x, y, width: w, height: h, layer },
];
/** a part with one round through pad, 1 mm of copper around a 0.6 mm hole */
const foro = (pezzo: string, net: string, x: number, y: number): El[] => [
  ...piedino(pezzo, net, x, y, ["top", "bottom"]),
  { type: "pcb_plated_hole", pcb_plated_hole_id: `foro_${pezzo}`, pcb_port_id: `pp_${pezzo}`, shape: "circle", x, y, outer_diameter: 1, hole_diameter: 0.6, layers: ["top", "bottom"] },
];
/** a trace 0.2 mm wide through the points, named by the connection a person would read */
const pista = (id: string, net: string, punti: Array<[number, number]>, layer = "top"): El[] => [
  { type: "source_trace", source_trace_id: `st_${id}`, display_name: `.U1 > .${id} to net.${net}`, connected_source_port_ids: [], connected_source_net_ids: [`net_${net.toLowerCase()}`], subcircuit_connectivity_map_key: `k_net_${net.toLowerCase()}` },
  { type: "pcb_trace", pcb_trace_id: id, source_trace_id: `st_${id}`, route: punti.map(([x, y]) => ({ route_type: "wire", x, y, width: 0.2, layer })) },
];
const via = (id: string, net: string, x: number, y: number): El => ({
  type: "pcb_via", pcb_via_id: id, x, y, outer_diameter: 0.6, hole_diameter: 0.3, layers: ["top", "inner1", "inner2", "bottom"], subcircuit_connectivity_map_key: `k_net_${net.toLowerCase()}`,
});

/** what check 9 says of a board: its violations, one line each, as message and dots */
const delleColate = (cj: El[], regole = REGOLE, opzioni?: Parameters<typeof runDrcChecks>[3]): DrcViolation[] =>
  runDrcChecks(cj as never, regole, undefined, opzioni).filter((d) => d.rule === "pour_clearance");
const dette = (cj: El[], regole = REGOLE, opzioni?: Parameters<typeof runDrcChecks>[3]) =>
  delleColate(cj, regole, opzioni).map((d) => [d.message, ...(d.points ?? []).map((p) => `${Number(p.x.toFixed(3))};${Number(p.y.toFixed(3))} ${p.layer}`)]);

describe("check 9: a trace against the pour of another net", () => {
  /*
   * A trace of SIG 0.2 mm wide along the top side of the pour (y = 5), its axis
   * at y: its copper starts 0.1 under the axis, so the gap is y - 5 - 0.1.
   */
  const lungoIlBordo = (y: number) => [...SCHEDA, colata("gnd_top", "top"), ...pista("p1", "SIG", [[-4, y], [4, y]])];

  it("at the pour's distance it is not reported, a hundredth under it neither, under that it is: with the gap, the minimum, the dot and the layer", () => {
    // 5.3 - 5 - 0.1 = 0.2: the distance of the pour
    expect(dette(lungoIlBordo(5.3))).toEqual([]);
    // 5.291 - 5 - 0.1 = 0.191: within the hundredth a poured edge is forgiven
    expect(dette(lungoIlBordo(5.291))).toEqual([]);
    // 5.289 - 5 - 0.1 = 0.189: under 0.19. The dot is on the axis of the trace, where it comes nearest
    expect(dette(lungoIlBordo(5.289))).toEqual([["p1 (.U1 > .p1 to net.SIG) <-> GND pour on top: 0.189mm < min 0.2mm", "-4;5.289 top"]]);
    // a board with no pour is not measured
    expect(dette([...SCHEDA, ...pista("p1", "SIG", [[-4, 5.289], [4, 5.289]])])).toEqual([]);
  });

  it("across the pour it is in its copper, 0 mm: reported where it enters the copper, on the layer of the pour; on ANOTHER layer it is not", () => {
    const attraverso = (stratoPista: string, stratoColata: string) => [...SCHEDA, colata("gnd", stratoColata), ...pista("p1", "SIG", [[-12, 0], [12, 0]], stratoPista)];
    // from x = -12 to 12 along y = 0: it meets the left side of the pour at x = -10
    expect(dette(attraverso("top", "top"))).toEqual([["p1 (.U1 > .p1 to net.SIG) <-> GND pour on top: 0.000mm < min 0.2mm (the trace is in the copper of the pour: a short)", "-10;0 top"]]);
    // the same trace on the bottom, or on the top with the pour on inner1: other copper, nothing to say
    expect(dette(attraverso("bottom", "top"))).toEqual([]);
    expect(dette(attraverso("top", "inner1"))).toEqual([]);
    // an inner trace in an inner pour: the dot is of that inner layer
    expect(dette(attraverso("inner1", "inner1"))).toEqual([["p1 (.U1 > .p1 to net.SIG) <-> GND pour on inner1: 0.000mm < min 0.2mm (the trace is in the copper of the pour: a short)", "-10;0 inner1"]]);
    // a trace that starts and ends inside the pour meets no side of it: the dot is its first point
    expect(dette([...SCHEDA, colata("gnd", "top"), ...pista("p1", "SIG", [[-3, 1], [3, 1]])])).toEqual([
      ["p1 (.U1 > .p1 to net.SIG) <-> GND pour on top: 0.000mm < min 0.2mm (the trace is in the copper of the pour: a short)", "-3;1 top"],
    ]);
  });

  it("a trace of the pour's own net is where the pour belongs, and a trace with no known net is not an electrical node", () => {
    expect(dette([...SCHEDA, colata("gnd", "top"), ...pista("p1", "GND", [[-12, 0], [12, 0]])])).toEqual([]);
    const senzaRete: El = { type: "pcb_trace", pcb_trace_id: "p2", route: [[-12, 1], [12, 1]].map(([x, y]) => ({ route_type: "wire", x, y, width: 0.2, layer: "top" })) };
    expect(dette([...SCHEDA, colata("gnd", "top"), senzaRete])).toEqual([]);
  });

  it("a pour that declares its own clearance is held to it, and not in the runs of the fab classes", () => {
    // the pour asks for 0.3; the trace is 5.35 - 5 - 0.1 = 0.25 from it: under 0.3 - 0.01, over the project's 0.2 - 0.01
    const cj = [...SCHEDA, colata("gnd", "top", RETTANGOLO, 0.3), ...pista("p1", "SIG", [[-4, 5.35], [4, 5.35]])];
    expect(dette(cj)).toEqual([["p1 (.U1 > .p1 to net.SIG) <-> GND pour on top: 0.250mm < min 0.3mm (the pour's own clearance)", "-4;5.35 top"]]);
    expect(dette(cj, REGOLE, { distanzeProprieDelleColate: false })).toEqual([]);
    // 5.4 - 5 - 0.1 = 0.3: the distance it asks for
    expect(dette([...SCHEDA, colata("gnd", "top", RETTANGOLO, 0.3), ...pista("p1", "SIG", [[-4, 5.4], [4, 5.4]])])).toEqual([]);
  });

  it("is measured once for all the rulesets of a board (MisureDrc), and judged by each", () => {
    const cj = lungoIlBordo(5.289);
    const misure: MisureDrc = {};
    expect(runDrcChecks(cj as never, REGOLE, misure).filter((d) => d.rule === "pour_clearance")).toHaveLength(1);
    const righe = misure.rameColate!.righe;
    expect(righe.map((r) => [r.tipo, r.id, r.nome, r.rete, r.layer, Number(r.distanzaMm.toFixed(3))])).toEqual([["trace", "p1", ".U1 > .p1 to net.SIG", "GND", "top", 0.189]]);
    // a ruleset whose pours may come to 0.15: the same rows, read and not measured again, and 0.189 is far enough
    const piuLarghe = runDrcChecks(cj as never, { ...REGOLE, pourClearanceMm: 0.15 }, misure);
    expect(misure.rameColate!.righe).toBe(righe);
    expect(piuLarghe.filter((d) => d.rule === "pour_clearance")).toEqual([]);
  });
});

describe("check 9: a pad against the pour of another net", () => {
  it("an SMD pad of another net in the pour is reported in the middle of the pad; a pad of the pour's net, a pad on the other face and a pad with no net are not", () => {
    // 0.6 x 0.6 at (3; 0): well inside the rectangle of the pour
    expect(dette([...SCHEDA, colata("gnd", "top"), ...piazzola("R9", "SIG", 3, 0)])).toEqual([
      ["pad_R9 (R9.pin1) <-> GND pour on top: 0.000mm < min 0.2mm (the pad is in the copper of the pour: a short)", "3;0 top"],
    ]);
    // a ground pad in the ground pour: its own net
    expect(dette([...SCHEDA, colata("gnd", "top"), ...piazzola("R9", "GND", 3, 0)])).toEqual([]);
    // the same pad on the bottom face: the pour is on the top
    expect(dette([...SCHEDA, colata("gnd", "top"), ...piazzola("R9", "SIG", 3, 0, 0.6, 0.6, "bottom")])).toEqual([]);
    // a pin connected to nothing is not an electrical node: left out, as in the pair checks
    expect(dette([...SCHEDA, colata("gnd", "top"), ...piazzola("R9", null, 3, 0)])).toEqual([]);
  });

  it("next to the pour it is measured from its edge: at 0.2 mm nothing, at 0.18 a violation", () => {
    // the pad is 0.6 wide: its left edge is at x - 0.3, the pour ends at x = 10. At x = 10.5 the gap is 0.2, at 10.48 it is 0.18
    expect(dette([...SCHEDA, colata("gnd", "top"), ...piazzola("R9", "SIG", 10.5, 0)])).toEqual([]);
    expect(dette([...SCHEDA, colata("gnd", "top"), ...piazzola("R9", "SIG", 10.48, 0)])).toEqual([["pad_R9 (R9.pin1) <-> GND pour on top: 0.180mm < min 0.2mm", "10.48;0 top"]]);
  });

  it("the copper of a plated hole of another net is measured on EVERY layer, whatever layers the element lists", () => {
    // the hole lists top and bottom; the ground is poured on the top and on inner1: its copper (1 mm across) is in both
    const dentro = [...SCHEDA, colata("gnd_top", "top"), colata("gnd_in1", "inner1"), ...foro("J1", "SIG", 0, 0)];
    expect(dette(dentro)).toEqual([
      ["foro_J1 (J1.pin1) <-> GND pour on top: 0.000mm < min 0.2mm (the pad is in the copper of the pour: a short)", "0;0 top"],
      ["foro_J1 (J1.pin1) <-> GND pour on inner1: 0.000mm < min 0.2mm (the pad is in the copper of the pour: a short)", "0;0 inner1"],
    ]);
    // one through pad in the pours of two layers is one pad
    expect(colateSopraIlRame(dentro as never)).toEqual({
      count: 1,
      detail:
        "1 piazzola sta nel rame di una colata di un'altra rete (la piazzola J1.pin1 nella colata GND su top): e' un corto",
    });
    // beside the pour: its copper has a radius of 0.5, the pour ends at x = 10. At x = 10.7 the gap is 0.2, at 10.68 it is 0.18
    expect(dette([...SCHEDA, colata("gnd_top", "top"), colata("gnd_in1", "inner1"), ...foro("J1", "SIG", 10.7, 0)])).toEqual([]);
    expect(dette([...SCHEDA, colata("gnd_top", "top"), colata("gnd_in1", "inner1"), ...foro("J1", "SIG", 10.68, 0)]).map((d) => d[0])).toEqual([
      "foro_J1 (J1.pin1) <-> GND pour on top: 0.180mm < min 0.2mm",
      "foro_J1 (J1.pin1) <-> GND pour on inner1: 0.180mm < min 0.2mm",
    ]);
    // a ground hole in the ground pours: its own net
    expect(dette([...SCHEDA, colata("gnd_top", "top"), colata("gnd_in1", "inner1"), ...foro("J1", "GND", 0, 0)])).toEqual([]);
  });
});

describe("check 9: the copper measured is the poured one, not the pads and the vias of the pour's net that it holds", () => {
  /*
   * A pour holds whole the pads and the vias of its own net (abbracciaRamePropio):
   * here the ground pad of R5, 1 x 1 mm at (0; 5.3), stands out of the top side
   * of the pour, from y = 4.8 to 5.8, and the pour's outline goes around it.
   */
  const CON_LA_PIAZZOLA: Array<[number, number]> = [[-10, -5], [10, -5], [10, 5], [0.5, 5], [0.5, 5.8], [-0.5, 5.8], [-0.5, 5], [-10, 5]];
  const base = [...SCHEDA, colata("gnd", "top", CON_LA_PIAZZOLA), ...piazzola("R5", "GND", 0, 5.3, 1, 1)];

  it("a trace across a ground pad the pour holds is a `trace over pad` of check 6 and no business of the pour, on a board poured a moment ago too", () => {
    // along y = 5.5 from x = -3 to 3: over the pad, and 5.5 - 0.1 - 5 = 0.4 from the pour everywhere else
    const cj = [...base, ...pista("p1", "SIG", [[-3, 5.5], [3, 5.5]])];
    expect(dette(cj)).toEqual([]);
    expect(colateSopraIlRame(cj as never)).toBeUndefined();
    expect(runDrcChecks(cj as never, REGOLE).filter((d) => d.rule === "trace_pad_clearance").map((d) => d.message)).toEqual(["p1 over pad_R5: 0.000mm < min 0.15mm"]);
  });

  it("the same trace going on into the poured copper is in the pour: reported and counted", () => {
    // it turns down at x = 3 and ends at (3; 4), a millimetre inside the pour
    const cj = [...base, ...pista("p1", "SIG", [[-3, 5.5], [3, 5.5], [3, 4]])];
    expect(dette(cj)).toEqual([["p1 (.U1 > .p1 to net.SIG) <-> GND pour on top: 0.000mm < min 0.2mm (the trace is in the copper of the pour: a short)", "3;5 top"]]);
    expect(colateSopraIlRame(cj as never)?.count).toBe(1);
  });

  it("a trace 0.16 mm from that pad and from nothing else of the pour is judged by the pair rule (0.15), not by the pour's 0.2", () => {
    // along y = 6.06 over the pad: 6.06 - 0.1 - 5.8 = 0.16 from the pad, and 0.96 from the pour's own side
    expect(dette([...base, ...pista("p1", "SIG", [[-0.4, 6.06], [0.4, 6.06]])])).toEqual([]);
    // the same 0.16 from the poured side, away from the pad (x from 3 to 4, y = 5.26): the pour's own distance
    expect(dette([...base, ...pista("p1", "SIG", [[3, 5.26], [4, 5.26]])])).toEqual([["p1 (.U1 > .p1 to net.SIG) <-> GND pour on top: 0.160mm < min 0.2mm", "3;5.26 top"]]);
  });

  it("a trace through the pour that also crosses a via of the pour's net is in the poured copper all the same", () => {
    // a ground via in the middle of the rectangle, the trace of SIG straight through it and through the pour
    const cj = [...SCHEDA, colata("gnd", "top"), via("v_gnd", "GND", 0, 0), ...pista("p1", "SIG", [[-3, 0], [3, 0]])];
    expect(dette(cj).map((d) => d[0])).toEqual(["p1 (.U1 > .p1 to net.SIG) <-> GND pour on top: 0.000mm < min 0.2mm (the trace is in the copper of the pour: a short)"]);
    expect(colateSopraIlRame(cj as never)?.count).toBe(1);
    // and a pad of SIG lying on that via, in the pour as well
    const conLaPiazzola = [...SCHEDA, colata("gnd", "top"), via("v_gnd", "GND", 0, 0), ...piazzola("R9", "SIG", 0.2, 0)];
    expect(dette(conLaPiazzola).map((d) => d[0])).toEqual(["pad_R9 (R9.pin1) <-> GND pour on top: 0.000mm < min 0.2mm (the pad is in the copper of the pour: a short)"]);
  });
});

describe("what the summary and the export say of copper in a pour (colateSopraIlRame, nonCertificata)", () => {
  it("counts traces and pads apart, names the first three by connection or by part and pin with their pour and layer, then `e altre N`", () => {
    const cinque = [...SCHEDA, colata("gnd", "top"), ...[1, 2, 3, 4, 5].flatMap((n) => piazzola(`R${n}`, "SIG", -6 + 2 * n, 0))];
    expect(colateSopraIlRame(cinque as never)).toEqual({
      count: 5,
      detail:
        "5 piazzole stanno nel rame di una colata di un'altra rete (la piazzola R1.pin1 nella colata GND su top, la piazzola R2.pin1 nella colata GND su top, " +
        "la piazzola R3.pin1 nella colata GND su top e altre 2): e' un corto",
    });
    // a trace and three pads: four, the fourth is `un'altra`. The pads are measured first
    const misti = [...SCHEDA, colata("gnd", "top"), ...pista("p1", "SIG", [[-3, 2], [3, 2]]), ...[1, 2, 3].flatMap((n) => piazzola(`R${n}`, "SIG", -6 + 2 * n, 0))];
    expect(colateSopraIlRame(misti as never)).toEqual({
      count: 4,
      detail:
        "1 pista e 3 piazzole stanno nel rame di una colata di un'altra rete (la piazzola R1.pin1 nella colata GND su top, la piazzola R2.pin1 nella colata GND su top, " +
        "la piazzola R3.pin1 nella colata GND su top e un'altra): e' un corto",
    });
    // copper NEAR a pour is a violation of the DRC, not a short: the summary and the export do not hold the board for it
    const vicino = [...SCHEDA, colata("gnd", "top"), ...piazzola("R9", "SIG", 10.48, 0)];
    expect(delleColate(vicino)).toHaveLength(1);
    expect(colateSopraIlRame(vicino as never)).toBeUndefined();
    // read from the measures of a DRC run when there are some, measured here when there are none
    const misure: MisureDrc = {};
    runDrcChecks(cinque as never, REGOLE, misure);
    expect(colateSopraIlRame(cinque as never, misure)?.count).toBe(5);
    expect(colateSopraIlRame(SCHEDA as never)).toBeUndefined();
  });

  it("the reason says what to do, after a plane over a via when there is one too, and the engine is the one that measures it", () => {
    const rame = { count: 1, detail: "1 pista sta nel rame di una colata di un'altra rete (la pista .R1 > .pin2 to .R2 > .pin1 nella colata GND su top): e' un corto" };
    expect(nonCertificata({ poursOverCopper: rame })).toBe(
      `${rame.detail}. La scheda NON e' certificata per l'export finche' una colata copre il rame di un'altra rete: premi Aggiorna per rifare le colate, e se quel rame resta nella colata sposta lui o la colata`,
    );
    expect(nonCertificata({ poursOverCopper: { count: 0, detail: "" } })).toBeNull();
    const conLaVia = nonCertificata({ planesOverVias: { count: 1, detail: "1 via ha la piazzola nel rame di un piano di un'altra rete" }, poursOverCopper: rame })!;
    expect(conLaVia).toMatch(/^1 via ha la piazzola .* premi Aggiorna o Ricontrolla per rifare le colate.*\. 1 pista sta nel rame .* premi Aggiorna per rifare le colate/);
    expect(CHECKS_ENGINE_VERSION).toBeGreaterThanOrEqual(13);
  });
});
