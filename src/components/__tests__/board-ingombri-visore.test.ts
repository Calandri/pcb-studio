import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BoardCanvas } from "../board/BoardCanvas";
import { VIEW_PRESETS } from "../ViewPresets";

/*
 * USB1 (through-hole, on the top) and U9 (on the bottom, under one of USB1's
 * pins): they hit on the BOTTOM, pins against U9. The red used to go on USB1's
 * courtyard on the top, where nothing hits; it goes on its holes on the bottom.
 */
const CIRCUIT = [
  { type: "pcb_board", width: 30, height: 20, center: { x: 0, y: 0 }, num_layers: 2 },
  { type: "source_component", source_component_id: "s_usb", name: "USB1" },
  { type: "source_component", source_component_id: "s_u9", name: "U9" },
  { type: "pcb_component", pcb_component_id: "USB1", source_component_id: "s_usb", center: { x: 1.27, y: 0 }, width: 4, height: 2, rotation: 0, layer: "top" },
  { type: "pcb_component", pcb_component_id: "U9", source_component_id: "s_u9", center: { x: 0, y: 0 }, width: 1, height: 1, rotation: 0, layer: "bottom" },
  { type: "pcb_plated_hole", pcb_plated_hole_id: "h1", pcb_component_id: "USB1", shape: "circle", x: 0, y: 0, outer_diameter: 1.6, hole_diameter: 1, layers: ["top", "bottom"] },
  { type: "pcb_plated_hole", pcb_plated_hole_id: "h2", pcb_component_id: "USB1", shape: "circle", x: 2.54, y: 0, outer_diameter: 1.6, hole_diameter: 1, layers: ["top", "bottom"] },
  { type: "pcb_courtyard_rect", pcb_courtyard_rect_id: "cy_usb", pcb_component_id: "USB1", center: { x: 1.27, y: 1.5 }, width: 6, height: 6, layer: "top" },
  { type: "pcb_smtpad", pcb_smtpad_id: "p_u9", pcb_component_id: "U9", shape: "rect", x: 0, y: 0, width: 0.6, height: 0.6, layer: "bottom" },
  { type: "pcb_courtyard_rect", pcb_courtyard_rect_id: "cy_u9", pcb_component_id: "U9", center: { x: 0, y: 0 }, width: 1.2, height: 1.2, layer: "bottom" },
];

const flags = { ...VIEW_PRESETS[0].flags, is_showing_courtyards: true };
const vista = (layer: string) => renderToStaticMarkup(createElement(BoardCanvas, { circuitJson: CIRCUIT, flags, mode: "view", layer } as never));
/** the group of a footprint, by its data-ingombro */
const gruppo = (svg: string, chiave: string) => svg.match(new RegExp(`<g[^>]*data-ingombro="${chiave}"[^>]*>(?:(?!</g>).)*</g>`))?.[0] ?? null;
const ROSSO = "#FF4D5E";

describe("the red goes on the face where the parts hit", () => {
  it("on the bottom: USB1's holes red, U9 red", () => {
    const svg = vista("bottom");
    expect(gruppo(svg, "fori-USB1")).toContain(ROSSO);
    expect(gruppo(svg, "ingombro-U9")).toContain(ROSSO);
    // USB1's courtyard is on the top: not drawn on the bottom
    expect(gruppo(svg, "ingombro-USB1")).toBeNull();
  });

  it("on the top: USB1's courtyard drawn, not red; its holes not drawn", () => {
    const svg = vista("top");
    const cortile = gruppo(svg, "ingombro-USB1");
    expect(cortile).not.toBeNull();
    expect(cortile).not.toContain(ROSSO);
    expect(gruppo(svg, "fori-USB1")).toBeNull();
  });
});
