import { describe, expect, it } from "vitest";
import {
  buildRouteModel,
  padGeometry,
  padHalfExtents,
  parentFrameOffset,
  parseLength,
  pointsBounds,
} from "@/lib/pcb-route-model";

/** a MEMS-like part: four rect signal pads and one polygon ground pad */
function memsBoard(): unknown[] {
  return [
    { type: "source_component", source_component_id: "sc1", name: "U1" },
    { type: "source_port", source_port_id: "sp1", source_component_id: "sc1", name: "GND" },
    { type: "source_port", source_port_id: "sp2", source_component_id: "sc1", name: "VDD" },
    { type: "source_port", source_port_id: "sp3", source_component_id: "sc1", name: "NC" },
    { type: "pcb_component", pcb_component_id: "pc1", source_component_id: "sc1", center: { x: 5, y: 3 }, width: 3.5, height: 2.65, rotation: 0 },
    { type: "pcb_port", pcb_port_id: "pp1", source_port_id: "sp1", pcb_component_id: "pc1", x: 5, y: 3 },
    { type: "pcb_port", pcb_port_id: "pp2", source_port_id: "sp2", pcb_component_id: "pc1", x: 4, y: 3 },
    { type: "pcb_port", pcb_port_id: "pp3", source_port_id: "sp3", pcb_component_id: "pc1", x: 6, y: 3 },
    {
      type: "pcb_smtpad",
      shape: "polygon",
      pcb_smtpad_id: "pad_gnd",
      pcb_component_id: "pc1",
      pcb_port_id: "pp1",
      layer: "top",
      points: [
        { x: 4.5, y: 2.5 },
        { x: 5.5, y: 2.5 },
        { x: 5.5, y: 3.7 },
        { x: 4.5, y: 3.7 },
      ],
    },
    { type: "pcb_smtpad", shape: "circle", pcb_smtpad_id: "pad_vdd", pcb_component_id: "pc1", pcb_port_id: "pp2", layer: "top", x: 4, y: 3, radius: 0.3 },
    // no geometry at all: must not become a pad at the origin
    { type: "pcb_smtpad", shape: "rect", pcb_smtpad_id: "pad_nc", pcb_component_id: "pc1", pcb_port_id: "pp3", layer: "top" },
  ];
}

describe("padGeometry", () => {
  it("reads a polygon pad from its vertices, not from a missing x/y", () => {
    const g = padGeometry({ type: "pcb_smtpad", shape: "polygon", points: [{ x: 1, y: 1 }, { x: 3, y: 1 }, { x: 3, y: 2 }] });
    expect(g).toEqual({ x: 2, y: 1.5, w: 2, h: 1, rot: 0 });
  });

  it("reads circles by radius and plated holes by outer diameter", () => {
    expect(padGeometry({ shape: "circle", x: 1, y: 2, radius: 0.25 })).toMatchObject({ w: 0.5, h: 0.5 });
    expect(padGeometry({ type: "pcb_plated_hole", shape: "circle", x: 0, y: 0, outer_diameter: 1.2, hole_diameter: 0.6 })).toMatchObject({ w: 1.2, h: 1.2 });
    // only the drill: still a size, not the 0.6 default
    expect(padGeometry({ type: "pcb_plated_hole", shape: "circle", x: 0, y: 0, hole_diameter: 0.9 })).toMatchObject({ w: 0.9, h: 0.9 });
  });

  it("reads a USB-C shell pill by outer_width/outer_height with its rotation", () => {
    const g = padGeometry({ type: "pcb_plated_hole", shape: "pill", x: 4, y: -1, outer_width: 1, outer_height: 2.1, hole_width: 0.6, hole_height: 1.7, ccw_rotation: 90 });
    expect(g).toEqual({ x: 4, y: -1, w: 1, h: 2.1, rot: 90 });
    const { hw, hh } = padHalfExtents(g!);
    expect(hw).toBeCloseTo(1.05, 9);
    expect(hh).toBeCloseTo(0.5, 9);
  });

  it("reads rect pads of slotted holes and polygon pads relative to the hole", () => {
    expect(padGeometry({ shape: "circular_hole_with_rect_pad", x: 1, y: 1, hole_diameter: 0.5, rect_pad_width: 1.5, rect_pad_height: 1 })).toMatchObject({ w: 1.5, h: 1 });
    const g = padGeometry({ shape: "hole_with_polygon_pad", x: 10, y: 10, pad_outline: [{ x: -1, y: -0.5 }, { x: 1, y: -0.5 }, { x: 1, y: 0.5 }] });
    expect(g).toMatchObject({ x: 10, y: 10, w: 2, h: 1 });
  });

  it("gives null when there is no geometry", () => {
    expect(padGeometry({ shape: "rect" })).toBeNull();
    expect(padGeometry({ shape: "polygon", points: [] })).toBeNull();
  });

  it("measures a rotated rect by the box around it", () => {
    const { hw, hh } = padHalfExtents({ x: 0, y: 0, w: 2, h: 1, rot: 45 });
    expect(hw).toBeCloseTo((2 + 1) * Math.SQRT1_2 / 2, 9);
    expect(hh).toBeCloseTo(hw, 9);
  });

  it("bounds a huge vertex list without blowing the stack", () => {
    const pts = Array.from({ length: 300_000 }, (_, i) => ({ x: i % 1000, y: Math.floor(i / 1000) }));
    expect(pointsBounds(pts)).toEqual({ minX: 0, maxX: 999, minY: 0, maxY: 299 });
  });
});

describe("buildRouteModel", () => {
  it("places the polygon ground pad where it is and skips pads without geometry", () => {
    const model = buildRouteModel(memsBoard());
    const gnd = model.pads.find((p) => p.id === "pad_gnd");
    expect(gnd).toBeDefined();
    expect(gnd!.x).toBeCloseTo(5, 6);
    expect(gnd!.y).toBeCloseTo(3.1, 6);
    expect(gnd!.hw).toBeCloseTo(0.5, 6);
    expect(gnd!.hh).toBeCloseTo(0.6, 6);
    const vdd = model.pads.find((p) => p.id === "pad_vdd");
    expect(vdd!.hw).toBeCloseTo(0.3, 6);
    expect(model.pads.find((p) => p.id === "pad_nc")).toBeUndefined();
  });
});

describe("parentFrameOffset", () => {
  it("is the group's anchor for a part inside a group, zero on the board", () => {
    const els = [
      { type: "pcb_group", pcb_group_id: "g1", anchor_position: { x: 10, y: 5 }, display_offset_x: 10, display_offset_y: 5 },
      { type: "pcb_group", pcb_group_id: "g2", positioned_relative_to_pcb_group_id: "g1", display_offset_x: 3, display_offset_y: -2 },
    ];
    expect(parentFrameOffset(els, { positioned_relative_to_pcb_group_id: "g1" })).toEqual({ x: 10, y: 5 });
    // no anchor written: the chain of explicit offsets
    expect(parentFrameOffset(els, { pcb_group_id: "g2" })).toEqual({ x: 13, y: 3 });
    expect(parentFrameOffset(els, {})).toEqual({ x: 0, y: 0 });
  });
});

describe("parseLength", () => {
  it("knows the units tscircuit accepts", () => {
    expect(parseLength("2mm")).toBe(2);
    expect(parseLength("1cm")).toBe(10);
    expect(parseLength("0.5in")).toBeCloseTo(12.7, 9);
    expect(parseLength("20mil")).toBeCloseTo(0.508, 9);
    expect(parseLength(" -3 ")).toBe(-3);
    expect(parseLength("10 + 2")).toBeNull();
    expect(parseLength("3px")).toBeNull();
  });
});
