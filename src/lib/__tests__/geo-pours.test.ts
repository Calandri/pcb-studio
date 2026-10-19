import { describe, expect, it } from "vitest";
import { padsOffPlane, readPours } from "@/lib/pours";
import { bandaDelBordo, padRuotati, ricolaPiani } from "@/lib/pours-recompute";

type El = { type: string; [key: string]: unknown };

const square = (x0: number, y0: number, x1: number, y1: number) => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];

describe("readPours", () => {
  it("bounds a plane with a huge vertex list", () => {
    const ring = Array.from({ length: 250_000 }, (_, i) => ({
      x: Math.cos((i / 250_000) * 2 * Math.PI) * 10,
      y: Math.sin((i / 250_000) * 2 * Math.PI) * 10,
    }));
    const [p] = readPours([{ type: "pcb_copper_pour", source_net_id: "n", layer: "top", brep_shape: { outer_ring: { vertices: ring } } }]);
    expect(p.maxX).toBeCloseTo(10, 6);
    expect(p.minY).toBeCloseTo(-10, 3);
  });
});

describe("bandaDelBordo", () => {
  it("falls back to the board rectangle when the outline is empty", () => {
    const band = bandaDelBordo([{ type: "pcb_board", center: { x: 0, y: 0 }, width: 10, height: 8, outline: [] }], "top", 0.3);
    // four strips and four corner squares
    expect(band).toHaveLength(8);
  });
});

describe("padRuotati: what the pour solver cannot read", () => {
  const els: El[] = [
    // MEMS ground pad (polygon) of another net
    { type: "pcb_smtpad", shape: "polygon", pcb_smtpad_id: "gnd", pcb_port_id: "p_gnd", layer: "top", points: square(0, 0, 1, 1) },
    // USB-C shell, pill plated hole
    { type: "pcb_plated_hole", shape: "pill", pcb_plated_hole_id: "shell", pcb_port_id: "p_shell", x: 5, y: 0, outer_width: 1, outer_height: 2, ccw_rotation: 90, layers: ["top", "bottom"] },
    // slotted NPTH
    { type: "pcb_hole", hole_shape: "pill", pcb_hole_id: "slot", x: 8, y: 0, hole_width: 0.6, hole_height: 1.2 },
    // a quarter-turned rect pad on a round hole: the converter reads it unturned
    { type: "pcb_plated_hole", shape: "circular_hole_with_rect_pad", pcb_plated_hole_id: "tab", x: 2, y: 2, hole_diameter: 0.5, rect_pad_width: 2, rect_pad_height: 1, rect_ccw_rotation: 90, layers: ["top"] },
    // its own net: must be left for the plane to reach
    { type: "pcb_plated_hole", shape: "pill", pcb_plated_hole_id: "own", pcb_port_id: "p_own", x: 9, y: 9, outer_width: 1, outer_height: 2, layers: ["top"] },
    // a plain rect smtpad: the converter already handles it
    { type: "pcb_smtpad", shape: "rect", pcb_smtpad_id: "plain", layer: "top", x: 3, y: 3, width: 1, height: 1 },
  ];
  it("hands every unreadable shape over, except those of the pour's own net", () => {
    const out = padRuotati(els, "top", "n_pour", 0.2, new Map([["p_own", "n_pour"]]));
    const ids = out.map((o) => o.padId).sort();
    expect(ids).toEqual(["gnd", "shell", "slot", "tab"]);
    const shell = out.find((o) => o.padId === "shell")!;
    expect(shell).toMatchObject({ shape: "pill", width: 1, height: 2, ccwRotation: 90 });
    // the polygon goes with a key the solver offsets by the clearance
    expect(String(out.find((o) => o.padId === "gnd")!.connectivityKey)).toMatch(/^cutout:/);
    const tab = out.find((o) => o.padId === "tab")!;
    const xs = (tab.points as Array<{ x: number }>).map((p) => p.x);
    // turned: 1 + 2*0.2 wide in x, not 2
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(1.4, 6);
  });
});

describe("padsOffPlane", () => {
  it("checks polygon ground pads instead of calling them size zero", () => {
    const cj = [
      { type: "source_net", source_net_id: "n_gnd", name: "GND" },
      { type: "source_trace", source_trace_id: "t", connected_source_port_ids: ["s1"], connected_source_net_ids: ["n_gnd"] },
      { type: "pcb_port", pcb_port_id: "pp1", source_port_id: "s1" },
      { type: "pcb_smtpad", shape: "polygon", pcb_smtpad_id: "gnd", pcb_port_id: "pp1", layer: "top", points: square(20, 20, 21, 21) },
      { type: "pcb_copper_pour", source_net_id: "n_gnd", layer: "top", brep_shape: { outer_ring: { vertices: square(0, 0, 10, 10) } } },
    ];
    const off = padsOffPlane(cj, readPours(cj));
    expect(off.map((o) => o.pad)).toEqual(["gnd"]);
  });
});

describe("ricolaPiani", () => {
  it("keeps the pour ids stable when it runs twice", async () => {
    const cj: El[] = [
      { type: "pcb_board", center: { x: 0, y: 0 }, width: 20, height: 20 },
      { type: "source_net", source_net_id: "n_gnd", name: "GND", subcircuit_connectivity_map_key: "k" },
      {
        type: "pcb_copper_pour",
        pcb_copper_pour_id: "pour0",
        source_net_id: "n_gnd",
        layer: "top",
        shape: "brep",
        brep_shape: { outer_ring: { vertices: square(-8, -8, 8, 8) }, inner_rings: [] },
      },
    ];
    const once = await ricolaPiani({ circuitJson: cj, clearanceMm: 0.2, bordoMm: 0.3 });
    const twice = await ricolaPiani({ circuitJson: once.circuitJson, clearanceMm: 0.2, bordoMm: 0.3 });
    const ids = (r: { circuitJson: El[] }) =>
      r.circuitJson.filter((e) => e.type === "pcb_copper_pour").map((e) => e.pcb_copper_pour_id);
    expect(ids(once)).toEqual(["pour0_r0"]);
    expect(ids(twice)).toEqual(["pour0_r0"]);
    expect(once.colateSparite).toEqual([]);
  }, 60_000);
});
