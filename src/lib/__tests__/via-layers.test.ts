import { describe, expect, it } from "vitest";
import { convertSoupToGerberCommands, stringifyGerberCommandLayers } from "circuit-json-to-gerber";
import { stratiDiRame, viePassantiSuOgniStrato } from "@/lib/via-layers";

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
