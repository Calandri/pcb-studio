import { describe, expect, it } from "vitest";
import {
  convertSoupToExcellonDrillCommands,
  convertSoupToGerberCommands,
  stringifyExcellonDrill,
  stringifyGerberCommandLayers,
} from "circuit-json-to-gerber";
import {
  stratiDiRame,
  vieDichiarateParziali,
  viePassantiSuOgniStrato,
  viePerLaForatura,
  vieSemprePassanti,
} from "@/lib/via-layers";

const scheda = (n: number) => ({ type: "pcb_board", pcb_board_id: "b", center: { x: 0, y: 0 }, width: 10, height: 10, thickness: 1.4, num_layers: n, material: "fr4" });
const reti = [
  { type: "source_net", source_net_id: "gnd", name: "GND", subcircuit_connectivity_map_key: "k_gnd" },
  { type: "source_net", source_net_id: "sig", name: "SIG", subcircuit_connectivity_map_key: "k_sig" },
];
const quadrato = (x0: number, y0: number, x1: number, y1: number) => ({
  vertices: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }],
});
// piano GND su inner1 su tutta la scheda, con un'apertura attorno alla via di segnale
const piano = { type: "pcb_copper_pour", pcb_copper_pour_id: "p", layer: "inner1", source_net_id: "gnd", brep_shape: { outer_ring: quadrato(-4, -4, 4, 4), inner_rings: [quadrato(1.5, 1.5, 2.5, 2.5)] } };
const viaGnd = { type: "pcb_via", pcb_via_id: "vg", x: -1, y: -1, outer_diameter: 0.5, hole_diameter: 0.15, layers: ["top", "bottom"], subcircuit_connectivity_map_key: "k_gnd" };
const viaSig = { type: "pcb_via", pcb_via_id: "vs", x: 2, y: 2, outer_diameter: 0.5, hole_diameter: 0.15, layers: ["top", "bottom"], subcircuit_connectivity_map_key: "k_sig" };
const pistaInner2 = { type: "pcb_trace", pcb_trace_id: "t", route: [{ route_type: "wire", x: 2, y: 2, layer: "inner2", width: 0.2 }, { route_type: "wire", x: 3, y: 2, layer: "inner2", width: 0.2 }] };
type Via = { pcb_via_id: string; layers: string[] };

describe("corone delle via solo dove la via e' collegata", () => {
  const out = viePassantiSuOgniStrato([scheda(4), ...reti, piano, viaGnd, viaSig, pistaInner2] as never[]) as unknown as Via[];
  const via = (id: string) => out.find((e) => e.pcb_via_id === id)!;
  it("la via GND dentro il piano GND ha la corona su inner1, non su inner2 dove non tocca niente", () => {
    expect(via("vg").layers).toEqual(["top", "inner1", "bottom"]);
  });
  it("la via di segnale nell'apertura del piano non ha corona su inner1, ma su inner2 dove arriva una pista", () => {
    expect(via("vs").layers).toEqual(["top", "inner2", "bottom"]);
  });
  it("nel Gerber la corona della via di segnale c'e' su inner2 e non su inner1", () => {
    const g = stringifyGerberCommandLayers(convertSoupToGerberCommands([scheda(4), ...reti, viaSig, pistaInner2].map((e) => e) as never)) as Record<string, string>;
    const g2 = stringifyGerberCommandLayers(convertSoupToGerberCommands(viePassantiSuOgniStrato([scheda(4), ...reti, viaSig, pistaInner2] as never[]) as never)) as Record<string, string>;
    expect(g.In2_Cu).not.toMatch(/X0*2000000Y0*2000000D03/);
    expect(g2.In2_Cu).toMatch(/X0*2000000Y0*2000000D03/);
    expect(g2.In1_Cu).not.toMatch(/X0*2000000Y0*2000000D03/);
  });
  it("una via sul bordo della sua colata, col centro fuori, e' collegata", () => {
    const bordo = { ...viaGnd, pcb_via_id: "vb", x: 4.1, y: 0 };
    const r = viePassantiSuOgniStrato([scheda(4), ...reti, piano, bordo] as never[]) as unknown as Via[];
    expect(r.find((e) => e.pcb_via_id === "vb")!.layers).toEqual(["top", "inner1", "bottom"]);
  });
  it("una via a meta' di un segmento di pista interna e' collegata", () => {
    const passante = { type: "pcb_trace", pcb_trace_id: "t2", route: [{ route_type: "wire", x: 0, y: 3, layer: "inner2", width: 0.5 }, { route_type: "wire", x: 4, y: 3, layer: "inner2", width: 0.5 }] };
    const v = { ...viaSig, pcb_via_id: "vm", x: 2, y: 3.1 };
    const r = viePassantiSuOgniStrato([scheda(4), ...reti, passante, v] as never[]) as unknown as Via[];
    expect(r.find((e) => e.pcb_via_id === "vm")!.layers).toEqual(["top", "inner2", "bottom"]);
  });
  it("una 2 strati resta com'e', e gli strati di una 6 strati sono nominati in ordine", () => {
    expect(viePassantiSuOgniStrato([scheda(2), viaGnd] as never[])[1]).toEqual(viaGnd);
    expect(stratiDiRame(6)).toEqual(["top", "inner1", "inner2", "inner3", "inner4", "bottom"]);
  });
});

/*
 * sbb-dl-principale, 2026-11-11: 32 of 253 vias written on part of the stack
 * (the via of a hand-drawn trace that joins an outer layer and an inner one),
 * taken for blind or buried. The fab drills every hole through the board.
 */
describe("every via is a through hole", () => {
  // as tscircuit writes the two vias of a <trace pcbPath> that runs on inner2
  const giu = { type: "pcb_via", pcb_via_id: "giu", pcb_trace_id: "t", x: 2, y: 2, outer_diameter: 0.5, hole_diameter: 0.2, layers: ["inner2", "bottom"], from_layer: "inner2", to_layer: "bottom", subcircuit_connectivity_map_key: "k_sig" };
  const su = { ...giu, pcb_via_id: "su", x: -2, y: 2, layers: ["top", "inner1", "inner2"], from_layer: "top", to_layer: "inner2" };
  const intera = { ...giu, pcb_via_id: "intera", x: 0, y: -2, layers: ["top", "inner1", "inner2", "bottom"], from_layer: "top", to_layer: "bottom" };
  const rovescia = { ...intera, pcb_via_id: "rovescia", x: 1, y: -2, layers: ["bottom", "inner2", "inner1", "top"], from_layer: "bottom", to_layer: "top" };
  type V = typeof giu & { declared_layers?: string[] };
  const via = (cj: unknown[], id: string) => (cj as V[]).find((e) => e.pcb_via_id === id)!;

  it("a via written on part of the stack lists every copper layer, and keeps the two layers its trace joins", () => {
    const out = vieSemprePassanti([scheda(4), giu, su] as never[]);
    for (const id of ["giu", "su"]) expect(via(out, id).layers).toEqual(["top", "inner1", "inner2", "bottom"]);
    expect([via(out, "giu").from_layer, via(out, "giu").to_layer]).toEqual(["inner2", "bottom"]);
    expect([via(out, "su").from_layer, via(out, "su").to_layer]).toEqual(["top", "inner2"]);
    // what it was written with stays readable
    expect(via(out, "giu").declared_layers).toEqual(["inner2", "bottom"]);
    expect(via(out, "su").declared_layers).toEqual(["top", "inner1", "inner2"]);
    // the input is not touched
    expect(giu.layers).toEqual(["inner2", "bottom"]);
  });

  it("a via that already lists every layer is left alone, in the order it has, and the board is the same array", () => {
    const cj = [scheda(4), intera, rovescia] as never[];
    const out = vieSemprePassanti(cj);
    expect(out).toBe(cj);
    const misto = vieSemprePassanti([scheda(4), intera, rovescia, giu] as never[]);
    expect(via(misto, "intera")).toBe(intera);
    expect(via(misto, "rovescia")).toBe(rovescia);
  });

  it("a second pass changes nothing, and a via cut back by hand keeps what it was first written with", () => {
    const una = vieSemprePassanti([scheda(4), giu] as never[]);
    expect(vieSemprePassanti(una)).toBe(una);
    const tagliata = [scheda(4), { ...via(una, "giu"), layers: ["bottom"] }] as never[];
    const due = vieSemprePassanti(tagliata);
    expect(via(due, "giu").layers).toEqual(["top", "inner1", "inner2", "bottom"]);
    expect(via(due, "giu").declared_layers).toEqual(["inner2", "bottom"]);
  });

  it("the stack is the board's: two layers, six layers, and a via with no list at all", () => {
    const solo = { type: "pcb_via", pcb_via_id: "solo", x: 0, y: 0, outer_diameter: 0.5, hole_diameter: 0.2 };
    expect(via(vieSemprePassanti([scheda(2), { ...giu, layers: ["top"] }] as never[]), "giu").layers).toEqual(["top", "bottom"]);
    expect(via(vieSemprePassanti([scheda(6), giu] as never[]), "giu").layers).toEqual(["top", "inner1", "inner2", "inner3", "inner4", "bottom"]);
    expect((vieSemprePassanti([scheda(4), solo] as never[])[1] as unknown as V).layers).toEqual(["top", "inner1", "inner2", "bottom"]);
  });

  it("counts the vias written on part of the stack, before and after they are completed", () => {
    const cj = [scheda(4), giu, su, intera, rovescia, viaGnd] as never[];
    expect(vieDichiarateParziali(cj)).toBe(2);
    expect(vieDichiarateParziali(vieSemprePassanti(cj))).toBe(2);
    expect(vieDichiarateParziali([scheda(4), intera, rovescia, viaGnd] as never[])).toBe(0);
  });
});

describe("the Gerber of a via that was completed", () => {
  const giu = { type: "pcb_via", pcb_via_id: "giu", x: 2, y: 2, outer_diameter: 0.5, hole_diameter: 0.2, layers: ["inner2", "bottom"], from_layer: "inner2", to_layer: "bottom", subcircuit_connectivity_map_key: "k_sig" };
  const colpo = /X0*2000000Y0*2000000D03/;
  const gerber = (cj: unknown[]) => stringifyGerberCommandLayers(convertSoupToGerberCommands(viePassantiSuOgniStrato(cj as never[]) as never)) as Record<string, string>;

  it("pad on top, on bottom and on the inner layer its trace reaches; on the plane it only crosses, nothing", () => {
    const cj = [scheda(4), ...reti, piano, giu, pistaInner2];
    const out = viePassantiSuOgniStrato(vieSemprePassanti(cj as never[])) as unknown as Via[];
    expect(out.find((e) => e.pcb_via_id === "giu")!.layers).toEqual(["top", "inner2", "bottom"]);
    const g = gerber(vieSemprePassanti(cj as never[]));
    expect(g.F_Cu).toMatch(colpo);
    expect(g.In2_Cu).toMatch(colpo);
    expect(g.B_Cu).toMatch(colpo);
    expect(g.In1_Cu).not.toMatch(colpo);
  });

  it("the export gives the same pads to a board that skipped the step", () => {
    const g = gerber([scheda(4), ...reti, piano, giu, pistaInner2]);
    expect(g.F_Cu).toMatch(colpo);
    expect(g.In2_Cu).toMatch(colpo);
    expect(g.In1_Cu).not.toMatch(colpo);
  });

  it("a via written top and bottom, with nothing reaching it inside, still has its two outer pads only", () => {
    const sola = { ...viaSig, pcb_via_id: "sola" };
    const out = viePassantiSuOgniStrato(vieSemprePassanti([scheda(4), ...reti, sola] as never[])) as unknown as Via[];
    expect(out.find((e) => e.pcb_via_id === "sola")!.layers).toEqual(["top", "bottom"]);
  });

  it("a via tscircuit wrote on every layer comes out as it always did: the Gerber of such a board does not change", () => {
    const quattro = ["top", "inner1", "inner2", "bottom"];
    const nelPiano = { ...viaGnd, pcb_via_id: "g4", layers: quattro, from_layer: "top", to_layer: "bottom" };
    const libera = { ...viaSig, pcb_via_id: "s4", x: -3, y: 3, layers: [...quattro].reverse(), from_layer: "bottom", to_layer: "top" };
    const cj = [scheda(4), ...reti, piano, nelPiano, libera] as never[];
    // nothing to complete: the board that reaches the Gerber is the one that was saved
    expect(vieSemprePassanti(cj)).toBe(cj);
    const out = viePassantiSuOgniStrato(cj) as unknown as Via[];
    expect(out.find((e) => e.pcb_via_id === "g4")!.layers).toEqual(["top", "inner1", "bottom"]);
    // connected on no inner layer: left with the pads it lists (see the note in via-layers.ts)
    expect(out.find((e) => e.pcb_via_id === "s4")).toBe(libera);
  });
});

describe("the drill file", () => {
  const giu = { type: "pcb_via", pcb_via_id: "giu", x: 2, y: -1.5, outer_diameter: 0.5, hole_diameter: 0.2, layers: ["inner2", "bottom"], from_layer: "inner2", to_layer: "bottom" };
  const aMano = { type: "pcb_via", pcb_via_id: "pcb_via_manual_0", x: -3, y: 1, outer_diameter: 0.5, hole_diameter: 0.2, layers: ["top", "inner1"] };
  const intera = { type: "pcb_via", pcb_via_id: "intera", x: 4, y: 4, outer_diameter: 0.5, hole_diameter: 0.2, layers: ["bottom", "inner2", "inner1", "top"], from_layer: "bottom", to_layer: "top" };
  const fori = (cj: unknown[]) =>
    stringifyExcellonDrill(convertSoupToExcellonDrillCommands({ circuitJson: cj as never, is_plated: true }))
      .split("\n")
      .filter((l) => /^X-?[\d.]+Y-?[\d.]+$/.test(l));

  it("has the hole of every via, whatever two layers its trace joins", () => {
    const cj = [scheda(4), giu, aMano, intera];
    // as the exporter reads them: only the via that says top to bottom is drilled
    expect(fori(cj)).toEqual(["X4.0000Y4.0000"]);
    // and listing the whole stack is not enough, because it files the hole under from_layer and to_layer
    expect(fori(vieSemprePassanti(cj as never[]))).toEqual(["X-3.0000Y1.0000", "X4.0000Y4.0000"]);
    expect(fori(viePerLaForatura(cj as never[]))).toEqual(["X2.0000Y-1.5000", "X-3.0000Y1.0000", "X4.0000Y4.0000"]);
    expect(fori(viePerLaForatura(vieSemprePassanti(cj as never[])))).toEqual(["X2.0000Y-1.5000", "X-3.0000Y1.0000", "X4.0000Y4.0000"]);
  });

  it("is made from the very same board when every via already goes from top to bottom", () => {
    const cj = [scheda(4), intera, { ...intera, pcb_via_id: "dritta", x: 1, y: 1, layers: ["top", "inner1", "inner2", "bottom"], from_layer: "top", to_layer: "bottom" }, viaGnd] as never[];
    expect(viePerLaForatura(cj)).toBe(cj);
    // the span stays on the board: only the copy handed to the drill is changed
    const out = viePerLaForatura([scheda(4), giu] as never[]) as unknown as Array<typeof giu>;
    expect([out[1].from_layer, out[1].to_layer]).toEqual(["top", "bottom"]);
    expect(giu.from_layer).toBe("inner2");
  });
});
