import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BoardCanvas } from "../board/BoardCanvas";
import { buildScene, colatePerRete } from "../board/render";
import { VIEW_PRESETS } from "../ViewPresets";

/*
 * sbb-dl-principale, bottom face (2026-11-11): the ground pour is declared as
 * tiles that overlap by 0.1 mm, and each pour was painted with its own
 * transparency, so every overlap read as a lighter straight band, a trace
 * across the plane. The pours of one net on one layer are one area.
 */
const quadrato = (x0: number, y0: number, x1: number, y1: number) => ({
  outer_ring: { vertices: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }] },
  inner_rings: [],
});
const CIRCUIT = [
  { type: "pcb_board", width: 30, height: 20, center: { x: 0, y: 0 }, num_layers: 2 },
  { type: "source_net", source_net_id: "n_gnd", name: "GND" },
  { type: "source_net", source_net_id: "n_vbat", name: "VBAT" },
  // two tiles of ground that overlap by 0.1 mm, and a VBAT strip apart
  { type: "pcb_copper_pour", pcb_copper_pour_id: "g1", source_net_id: "n_gnd", layer: "bottom", shape: "brep", brep_shape: quadrato(-10, -5, 0.05, 5) },
  { type: "pcb_copper_pour", pcb_copper_pour_id: "g2", source_net_id: "n_gnd", layer: "bottom", shape: "brep", brep_shape: quadrato(-0.05, -5, 10, 5) },
  { type: "pcb_copper_pour", pcb_copper_pour_id: "v1", source_net_id: "n_vbat", layer: "bottom", shape: "brep", brep_shape: quadrato(11, -5, 12, 5) },
  { type: "pcb_copper_pour", pcb_copper_pour_id: "g3", source_net_id: "n_gnd", layer: "top", shape: "brep", brep_shape: quadrato(-10, -5, 10, 5) },
];

describe("the pours of one net on one layer are painted as one area", () => {
  it("are grouped by layer and net", () => {
    const scene = buildScene(CIRCUIT)!;
    const gruppi = colatePerRete(scene.pours, "bottom");
    expect(gruppi.map((g) => [g.net, g.pours.map((p) => p.id)])).toEqual([
      ["n_gnd", ["g1", "g2"]],
      ["n_vbat", ["v1"]],
    ]);
  });

  it("each group carries the transparency once and its pours are opaque inside it, so an overlap adds nothing", () => {
    const html = renderToStaticMarkup(
      createElement(BoardCanvas, { circuitJson: CIRCUIT, flags: VIEW_PRESETS[0].flags, layer: "bottom", mode: "move" } as never),
    );
    const gruppi = [...html.matchAll(/<g opacity="([\d.]+)">((?:<path[^>]*>(?:<\/path>)?)+)<\/g>/g)];
    // the two ground tiles of the bottom face are in the same group, and no path of a pour has its own opacity
    const terra = gruppi.find((g) => g[2].includes('d="M -10 -5 L 0.05 -5') && g[2].includes('d="M -0.05 -5 L 10 -5'));
    expect(terra).toBeDefined();
    expect(terra![2]).not.toMatch(/ opacity=/);
    expect(Number(terra![1])).toBeGreaterThan(0);
  });
});
