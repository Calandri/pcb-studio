import { describe, expect, it } from "vitest";
import { distanzaSegmentoForma, runDrcChecks } from "@/lib/drc";
import { DEFAULT_DESIGN_RULES } from "@/lib/design-rules";

/*
 * tm-4l-q1, 2026-11-12: a stroke of outline 0,053 mm from the pad C15.2 was not
 * reported, and so a stroke of C6 against the pad C5.1. The distance from a
 * segment to a rectangle was taken from the rectangle's corners to the segment
 * only: a short segment running along one side, its two ends in front of that
 * side, between the corners, came out as far as the corners are. The same
 * function measures a trace against a pad of another net in the DRC.
 */
const pad = { tipo: "rettangolo" as const, x: 0.5, y: 0.25, w: 1, h: 0.5, rot: 0 };

describe("segment against rectangle", () => {
  it("a short segment parallel to a side, its ends in front of it, is measured from the side", () => {
    expect(distanzaSegmentoForma(pad, 0.3, 0.55, 0.7, 0.55)).toBeCloseTo(0.05, 9);
    // and from the side below, from the left, from the right
    expect(distanzaSegmentoForma(pad, 0.4, -0.08, 0.6, -0.08)).toBeCloseTo(0.08, 9);
    expect(distanzaSegmentoForma(pad, -0.02, 0.1, -0.02, 0.4)).toBeCloseTo(0.02, 9);
    expect(distanzaSegmentoForma(pad, 1.1, 0.2, 1.1, 0.3)).toBeCloseTo(0.1, 9);
  });

  it("a turned rectangle: the same, in its own frame", () => {
    // the pad turned by 90 degrees around its centre is 0,5 wide and 1 tall: its right side at x = 0,75
    expect(distanzaSegmentoForma({ ...pad, rot: 90 }, 0.8, 0.1, 0.8, 0.4)).toBeCloseTo(0.05, 9);
    // at 45 degrees: a segment parallel to a side, 0,05 out of it, in front of it
    const a = Math.PI / 4;
    const fuori = (u: number, v: number): [number, number] => [0.5 + u * Math.cos(a) - v * Math.sin(a), 0.25 + u * Math.sin(a) + v * Math.cos(a)];
    const [x1, y1] = fuori(-0.2, 0.3);
    const [x2, y2] = fuori(0.2, 0.3);
    expect(distanzaSegmentoForma({ ...pad, rot: 45 }, x1, y1, x2, y2)).toBeCloseTo(0.05, 9);
  });

  it("what was right stays right: through it 0, an end inside 0, past a corner from the corner", () => {
    expect(distanzaSegmentoForma(pad, -1, 0.25, 2, 0.25)).toBe(0);
    expect(distanzaSegmentoForma(pad, 0.5, 0.25, 3, 3)).toBe(0);
    expect(distanzaSegmentoForma(pad, 1.03, 0.54, 2, 0.54)).toBeCloseTo(Math.hypot(0.03, 0.04), 9);
  });

  it("a short trace running along a pad of another net is a trace_pad_clearance violation", () => {
    const cj = [
      { type: "source_net", source_net_id: "n1", name: "A", subcircuit_connectivity_map_key: "k1" },
      { type: "source_net", source_net_id: "n2", name: "B", subcircuit_connectivity_map_key: "k2" },
      { type: "source_component", source_component_id: "s1", name: "C15" },
      { type: "pcb_component", pcb_component_id: "c1", source_component_id: "s1", center: { x: 0.5, y: 0.25 }, layer: "top", rotation: 0, width: 1, height: 0.5 },
      { type: "source_port", source_port_id: "sp1", name: "pin2", source_component_id: "s1", subcircuit_connectivity_map_key: "k1" },
      { type: "pcb_port", pcb_port_id: "pp1", source_port_id: "sp1", pcb_component_id: "c1", x: 0.5, y: 0.25, layers: ["top"] },
      { type: "pcb_smtpad", pcb_smtpad_id: "pad1", pcb_component_id: "c1", pcb_port_id: "pp1", shape: "rect", x: 0.5, y: 0.25, width: 1, height: 0.5, layer: "top" },
      { type: "source_trace", source_trace_id: "st1", subcircuit_connectivity_map_key: "k1", connected_source_port_ids: ["sp1"], connected_source_net_ids: ["n1"] },
      { type: "source_trace", source_trace_id: "st2", subcircuit_connectivity_map_key: "k2", connected_source_port_ids: [], connected_source_net_ids: ["n2"] },
      // a 0,3 mm stretch of net B, 0,15 wide, its edge 0,05 above the pad
      {
        type: "pcb_trace",
        pcb_trace_id: "t1",
        source_trace_id: "st2",
        subcircuit_connectivity_map_key: "k2",
        route: [
          { route_type: "wire", x: 0.35, y: 0.625, width: 0.15, layer: "top" },
          { route_type: "wire", x: 0.65, y: 0.625, width: 0.15, layer: "top" },
        ],
      },
    ];
    const v = runDrcChecks(cj as never, DEFAULT_DESIGN_RULES);
    expect(v).toContainEqual(expect.objectContaining({ rule: "trace_pad_clearance", message: expect.stringMatching(/0\.050mm < min/) }));
  });
});
