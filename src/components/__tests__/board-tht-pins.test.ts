import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BoardCanvas } from "../board/BoardCanvas";
import { buildScene } from "../board/render";
import { VIEW_PRESETS } from "../ViewPresets";

/* J4 di sbb-dl-retro, 5 piedini passanti: senza rete ne' nome al passaggio del mouse (2026-11-09) */
const CIRCUIT = [
  { type: "pcb_board", width: 30, height: 20, center: { x: 0, y: 0 }, num_layers: 2 },
  { type: "source_component", source_component_id: "s_j", name: "J4" },
  { type: "source_component", source_component_id: "s_r", name: "R45" },
  { type: "pcb_component", pcb_component_id: "pc_j", source_component_id: "s_j", center: { x: -5, y: 0 }, width: 3, height: 10, rotation: 0, layer: "top" },
  { type: "pcb_component", pcb_component_id: "pc_r", source_component_id: "s_r", center: { x: 5, y: 0 }, width: 1, height: 0.5, rotation: 0, layer: "top" },
  { type: "source_port", source_port_id: "sp_j3", name: "pin3", source_component_id: "s_j" },
  { type: "pcb_port", pcb_port_id: "pp_j3", source_port_id: "sp_j3", pcb_component_id: "pc_j" },
  { type: "pcb_plated_hole", pcb_plated_hole_id: "ph_j3", pcb_port_id: "pp_j3", pcb_component_id: "pc_j", shape: "circle", hole_diameter: 1, outer_diameter: 1.7, x: -5, y: 0, layers: ["top", "bottom"] },
  { type: "source_port", source_port_id: "sp_r1", name: "pin1", source_component_id: "s_r" },
  { type: "pcb_port", pcb_port_id: "pp_r1", source_port_id: "sp_r1", pcb_component_id: "pc_r" },
  { type: "pcb_smtpad", pcb_smtpad_id: "pad_r1", pcb_port_id: "pp_r1", pcb_component_id: "pc_r", shape: "rect", x: 4.5, y: 0, width: 0.5, height: 0.5, layer: "top" },
  { type: "source_net", source_net_id: "n_t", name: "TASTO_J" },
  { type: "source_trace", source_trace_id: "t1", connected_source_port_ids: ["sp_j3", "sp_r1"], connected_source_net_ids: ["n_t"] },
];

describe("i piedini passanti sono piedini", () => {
  it("hanno rete e nome, e al passaggio del mouse si vede la rete", () => {
    expect(buildScene(CIRCUIT)!.pads.find((p) => p.id === "ph_j3")).toMatchObject({ foro: true, pin: "pin3", netName: "TASTO_J" });
    const html = renderToStaticMarkup(
      createElement(BoardCanvas, { circuitJson: CIRCUIT, flags: VIEW_PRESETS[0].flags, layer: "top", mode: "move", hoveredComponentId: "pc_j" } as never),
    );
    expect(html).toContain(">TASTO_J<");
    expect(html).toContain("J4.3");
  });
});
