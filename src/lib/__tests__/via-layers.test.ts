import { describe, expect, it } from "vitest";
import { convertSoupToGerberCommands, stringifyGerberCommandLayers } from "circuit-json-to-gerber";
import { stratiDiRame, viePassantiSuOgniStrato } from "@/lib/via-layers";

const scheda = (n: number) => ({ type: "pcb_board", pcb_board_id: "b", center: { x: 0, y: 0 }, width: 10, height: 10, thickness: 1.4, num_layers: n, material: "fr4" });
const via = { type: "pcb_via", pcb_via_id: "v", x: 1, y: 2, outer_diameter: 0.5, hole_diameter: 0.2, layers: ["top", "bottom"] };

describe("via passanti su ogni strato", () => {
  it("su una 4 strati la via passante ha la corona anche su inner1 e inner2", () => {
    const cj = viePassantiSuOgniStrato([scheda(4), via]);
    expect((cj[1] as { layers: string[] }).layers).toEqual(["top", "inner1", "inner2", "bottom"]);
    const g = stringifyGerberCommandLayers(convertSoupToGerberCommands(cj as never)) as Record<string, string>;
    for (const nome of ["F_Cu", "In1_Cu", "In2_Cu", "B_Cu"]) expect(g[nome]).toMatch(/X0*1000000Y0*2000000D03/);
  });
  it("prima, l'export la disegnava solo fuori", () => {
    const g = stringifyGerberCommandLayers(convertSoupToGerberCommands([scheda(4), via] as never)) as Record<string, string>;
    expect(g.In1_Cu).not.toMatch(/D03/);
  });
  it("una 2 strati e le via cieche restano come sono", () => {
    expect(viePassantiSuOgniStrato([scheda(2), via])[1]).toEqual(via);
    const cieca = { ...via, layers: ["top", "inner1"] };
    expect(viePassantiSuOgniStrato([scheda(4), cieca])[1]).toEqual(cieca);
    expect(stratiDiRame(6)).toEqual(["top", "inner1", "inner2", "inner3", "inner4", "bottom"]);
  });
});
