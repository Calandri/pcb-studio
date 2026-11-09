import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BoardCanvas } from "../board/BoardCanvas";
import { buildScene } from "../board/render";
import { VIEW_PRESETS } from "../ViewPresets";

/*
 * sbb-dl-retro, 2026-11-09:
 * - J4 (connettore del tasto, 5 piedini passanti) senza rete ne' nome al passaggio
 *   del mouse: solo i pad SMD erano piedini;
 * - "VBAT_MDM a cosa si attacca?": l'etichetta non diceva dove va la rete.
 */
const port = (id: string, comp: string, src: string, name: string) => [
  { type: "source_port", source_port_id: `sp_${id}`, name, source_component_id: src },
  { type: "pcb_port", pcb_port_id: `pp_${id}`, source_port_id: `sp_${id}`, pcb_component_id: comp },
];
const CIRCUIT = [
  { type: "pcb_board", width: 40, height: 20, center: { x: 0, y: 0 }, num_layers: 2 },
  { type: "source_component", source_component_id: "s_j", name: "J4" },
  { type: "source_component", source_component_id: "s_u", name: "U1" },
  { type: "source_component", source_component_id: "s_c", name: "C2" },
  { type: "source_component", source_component_id: "s_t", name: "TVS1" },
  { type: "pcb_component", pcb_component_id: "pc_j", source_component_id: "s_j", center: { x: -10, y: 0 }, width: 3, height: 10, rotation: 0, layer: "top" },
  { type: "pcb_component", pcb_component_id: "pc_u", source_component_id: "s_u", center: { x: 0, y: 0 }, width: 3, height: 3, rotation: 0, layer: "top" },
  { type: "pcb_component", pcb_component_id: "pc_c", source_component_id: "s_c", center: { x: 8, y: 3 }, width: 1, height: 0.5, rotation: 0, layer: "top" },
  { type: "pcb_component", pcb_component_id: "pc_t", source_component_id: "s_t", center: { x: 15, y: -5 }, width: 1, height: 0.5, rotation: 0, layer: "top" },
  ...port("j3", "pc_j", "s_j", "pin3"),
  { type: "pcb_plated_hole", pcb_plated_hole_id: "ph_j3", pcb_port_id: "pp_j3", pcb_component_id: "pc_j", shape: "circle", hole_diameter: 1, outer_diameter: 1.7, x: -10, y: 0, layers: ["top", "bottom"] },
  ...port("u1", "pc_u", "s_u", "IN"),
  { type: "pcb_smtpad", pcb_smtpad_id: "pad_u1", pcb_port_id: "pp_u1", pcb_component_id: "pc_u", shape: "rect", x: -1, y: 0, width: 0.6, height: 0.6, layer: "top" },
  ...port("c1", "pc_c", "s_c", "pin1"),
  { type: "pcb_smtpad", pcb_smtpad_id: "pad_c1", pcb_port_id: "pp_c1", pcb_component_id: "pc_c", shape: "rect", x: 7.5, y: 3, width: 0.5, height: 0.5, layer: "top" },
  ...port("t1", "pc_t", "s_t", "pin1"),
  { type: "pcb_smtpad", pcb_smtpad_id: "pad_t1", pcb_port_id: "pp_t1", pcb_component_id: "pc_t", shape: "rect", x: 14.5, y: -5, width: 0.5, height: 0.5, layer: "top" },
  { type: "source_net", source_net_id: "n_v", name: "VBAT_MDM" },
  { type: "source_trace", source_trace_id: "t1", connected_source_port_ids: ["sp_j3", "sp_u1", "sp_c1", "sp_t1"], connected_source_net_ids: ["n_v"] },
];

const disegna = (focus: string) =>
  renderToStaticMarkup(
    createElement(BoardCanvas, { circuitJson: CIRCUIT, flags: VIEW_PRESETS[0].flags, layer: "top", mode: "move", hoveredComponentId: focus } as never),
  ).replace(/&gt;/g, ">");

describe("dove va una rete", () => {
  it("un piedino passante e' un piedino: rete, nome, J4.3", () => {
    const pin = buildScene(CIRCUIT)!.pads.find((p) => p.id === "ph_j3")!;
    expect(pin).toMatchObject({ foro: true, pin: "pin3", netName: "VBAT_MDM", componentId: "pc_j" });
    const html = disegna("pc_j");
    expect(html).toContain(">VBAT_MDM<");
    expect(html).toContain("J4.3");
    // where the net goes: in the bar under the board
    expect(html.slice(html.lastIndexOf("</svg>"))).toMatch(/VBAT_MDM: 4 piedini: U1\.IN, C2\.1, TVS1\.1/);
  });

  it("l'albero piu' corto unisce tutti i piedini della rete: 3 linee per 4 piedini", () => {
    const html = disegna("pc_u");
    expect(html.match(/<line [^>]*stroke-dasharray="5 3"/g) ?? []).toHaveLength(3);
    expect(html.slice(html.lastIndexOf("</svg>"))).toMatch(/VBAT_MDM: 4 piedini: J4\.3, C2\.1, TVS1\.1/);
  });
});
