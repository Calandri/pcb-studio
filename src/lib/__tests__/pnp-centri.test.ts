import { describe, expect, it } from "vitest";
import { convertCircuitJsonToPickAndPlaceRows } from "circuit-json-to-pnp-csv";
import { centriDiMontaggio } from "@/lib/bom";

// a microphone whose pads sit at one end (box centre 0.41 mm off the body) and a pin-1 THT connector
const cj = [
  { type: "source_component", source_component_id: "s1", name: "MIC1" },
  { type: "source_component", source_component_id: "s2", name: "J1" },
  { type: "source_component", source_component_id: "s3", name: "R1" },
  { type: "pcb_component", pcb_component_id: "p1", source_component_id: "s1", center: { x: -2.724, y: 15.994 }, display_offset_x: -2.314, display_offset_y: 15.994, layer: "top", rotation: 270 },
  { type: "pcb_component", pcb_component_id: "p2", source_component_id: "s2", center: { x: 1.521, y: -16.602 }, display_offset_x: -2.229, display_offset_y: -16.602, layer: "top", rotation: 180 },
  { type: "pcb_component", pcb_component_id: "p3", source_component_id: "s3", center: { x: 3, y: 4 }, layer: "bottom", rotation: 90 },
  { type: "pcb_plated_hole", pcb_plated_hole_id: "h1", pcb_component_id: "p2", x: -2.229, y: -16.602, shape: "circle", hole_diameter: 0.9, outer_diameter: 1.5 },
];

describe("pick & place sul corpo del componente", () => {
  it("SMD sull'origine del footprint, foro passante sul centro dei pad, senza origine resta com'era", () => {
    const righe = centriDiMontaggio(convertCircuitJsonToPickAndPlaceRows(cj as never), cj);
    const per = Object.fromEntries(righe.map((r) => [r.designator, r]));
    expect([per.MIC1.mid_x, per.MIC1.mid_y]).toEqual([-2.314, 15.994]);
    expect([per.J1.mid_x, per.J1.mid_y]).toEqual([1.521, -16.602]);
    expect([per.R1.mid_x, per.R1.mid_y]).toEqual([3, 4]);
    expect(per.MIC1.rotation).toBe(270);
  });
});
