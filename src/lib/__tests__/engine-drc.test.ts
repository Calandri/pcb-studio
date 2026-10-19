import { describe, expect, it } from "vitest";
import { foroDi, rameDelForo, runDrcChecks } from "@/lib/drc";

type El = { type: string; [key: string]: unknown };

const board = (extra: Record<string, unknown> = {}): El => ({
  type: "pcb_board",
  center: { x: 0, y: 0 },
  width: 20,
  height: 20,
  num_layers: 2,
  ...extra,
});

/** a net with one source trace joining the given source ports */
const net = (key: string, ports: string[]): El => ({
  type: "source_trace",
  source_trace_id: `st_${key}`,
  subcircuit_connectivity_map_key: key,
  connected_source_port_ids: ports,
  connected_source_net_ids: [],
});

const port = (id: string, x: number, y: number): El => ({
  type: "pcb_port",
  pcb_port_id: `pp_${id}`,
  source_port_id: `sp_${id}`,
  x,
  y,
  layers: ["top"],
});

const pad = (id: string, x: number, y: number, w = 0.2, h = 0.2, extra: Record<string, unknown> = {}): El => ({
  type: "pcb_smtpad",
  shape: "rect",
  pcb_smtpad_id: `pad_${id}`,
  pcb_port_id: `pp_${id}`,
  x,
  y,
  width: w,
  height: h,
  layer: "top",
  ...extra,
});

const rules = (list: ReturnType<typeof runDrcChecks>) => list.map((v) => v.rule);

describe("plated holes are measured by their own shape", () => {
  it("reads the copper of a pill and of a square pad", () => {
    expect(
      rameDelForo({ type: "pcb_plated_hole", shape: "pill", x: 0, y: 0, outer_width: 1, outer_height: 2, hole_width: 0.6, hole_height: 1.6, ccw_rotation: 0 }),
    ).toMatchObject({ tipo: "capsula", capsula: { r: 0.5 } });
    expect(
      rameDelForo({ type: "pcb_plated_hole", shape: "circular_hole_with_rect_pad", x: 0, y: 0, rect_pad_width: 2, rect_pad_height: 1.5, hole_diameter: 0.8 }),
    ).toMatchObject({ tipo: "rettangolo", w: 2, h: 1.5 });
    // the drill of a rect-pad hole follows its offset
    expect(
      foroDi({ type: "pcb_plated_hole", shape: "circular_hole_with_rect_pad", x: 1, y: 1, hole_offset_x: 0.2, hole_offset_y: 0, hole_diameter: 0.8 }),
    ).toMatchObject({ ax: 1.2, ay: 1, r: 0.4 });
  });

  it("sees a pill shell tab next to another net's pad (it used to be skipped)", () => {
    const tab: El = {
      type: "pcb_plated_hole",
      shape: "pill",
      pcb_plated_hole_id: "tab",
      pcb_port_id: "pp_a",
      x: 0,
      y: 0,
      outer_width: 1,
      outer_height: 2,
      hole_width: 0.6,
      hole_height: 1.6,
      ccw_rotation: 0,
      layers: ["top", "bottom"],
    };
    const circuit = [board(), net("A", ["sp_a"]), net("B", ["sp_b"]), port("a", 0, 0), port("b", 0, 1.2), tab, pad("b", 0, 1.2)];
    // the stadium reaches y=1, the pad starts at 1.1: 0.1mm < 0.127
    expect(rules(runDrcChecks(circuit))).toContain("pad_clearance");
    // turned by 90 degrees the tab lies along x and the pad is far
    const turned = circuit.map((el) => (el === tab ? { ...tab, ccw_rotation: 90 } : el));
    expect(rules(runDrcChecks(turned))).not.toContain("pad_clearance");
  });

  it("measures a square pad as the pad, not as its drill", () => {
    const thp: El = {
      type: "pcb_plated_hole",
      shape: "circular_hole_with_rect_pad",
      pcb_plated_hole_id: "thp",
      pcb_port_id: "pp_a",
      x: 0,
      y: 0,
      hole_shape: "circle",
      pad_shape: "rect",
      hole_diameter: 0.8,
      rect_pad_width: 2,
      rect_pad_height: 2,
      layers: ["top", "bottom"],
    };
    const circuit = [board(), net("A", ["sp_a"]), net("B", ["sp_b"]), port("a", 0, 0), port("b", 1.2, 0), thp, pad("b", 1.2, 0)];
    expect(rules(runDrcChecks(circuit))).toContain("pad_clearance");
  });
});

describe("the cap is per rule and the count is the true one", () => {
  it("keeps reporting later rules after hundreds of earlier violations", () => {
    const crooked: El[] = Array.from({ length: 600 }, (_, i) => ({
      type: "pcb_trace",
      pcb_trace_id: `crooked_${i}`,
      route: [
        { route_type: "wire", x: -5, y: -5, width: 0.2, layer: "bottom" },
        { route_type: "wire", x: -4, y: -4.7, width: 0.2, layer: "bottom" },
      ],
    }));
    const over: El = {
      type: "pcb_trace",
      pcb_trace_id: "over",
      source_trace_id: "st_A",
      route: [
        { route_type: "wire", x: 3, y: 2, width: 0.2, layer: "top" },
        { route_type: "wire", x: 3, y: 4, width: 0.2, layer: "top" },
      ],
    };
    const circuit = [
      board(),
      net("A", ["sp_a"]),
      net("B", ["sp_b"]),
      port("a", 3, 2),
      port("b", 3, 3),
      pad("a", 3, 2),
      pad("b", 3, 3, 0.4, 0.4),
      ...crooked,
      over,
    ];
    const out = runDrcChecks(circuit);
    const angle = out.find((v) => v.rule === "trace_angle");
    expect(angle?.count).toBe(600);
    expect(angle?.points?.length).toBeLessThan(600);
    expect(rules(out)).toContain("trace_pad_clearance");
  });
});

describe("coverage: tie stubs, bare holes, the real edge", () => {
  it("measures a tie stub with no source trace against other nets' pads", () => {
    const stub: El = {
      type: "pcb_trace",
      pcb_trace_id: "pcb_trace_plane_1",
      // the key stitchToPlanes writes: the pad's source port
      subcircuit_connectivity_map_key: "sp_a",
      route: [
        { route_type: "wire", x: 0, y: 0, width: 0.25, layer: "top" },
        { route_type: "wire", x: 2, y: 0, width: 0.25, layer: "top" },
      ],
    };
    const circuit = [board(), net("A", ["sp_a"]), net("B", ["sp_b"]), port("a", 0, 0), port("b", 1, 0), pad("a", 0, 0), pad("b", 1, 0.3)];
    expect(rules(runDrcChecks([...circuit, stub]))).toContain("trace_pad_clearance");
    // with no key at all, the pad it starts from names it
    const { subcircuit_connectivity_map_key: _k, ...senzaChiave } = stub;
    void _k;
    expect(rules(runDrcChecks([...circuit, senzaChiave as El]))).toContain("trace_pad_clearance");
  });

  it("checks bare holes against the edge and against other drills", () => {
    const hole = (id: string, x: number, y: number): El => ({
      type: "pcb_hole",
      pcb_hole_id: id,
      hole_shape: "circle",
      hole_diameter: 1,
      x,
      y,
    });
    expect(rules(runDrcChecks([board(), hole("h1", 9.3, 0)]))).toContain("board_edge_clearance");
    const via: El = { type: "pcb_via", pcb_via_id: "v1", x: 0.85, y: 5, outer_diameter: 0.6, hole_diameter: 0.3, layers: ["top", "bottom"] };
    expect(rules(runDrcChecks([board(), hole("h2", 0, 5), via]))).toContain("hole_to_hole");
  });

  it("uses the turned extents of a pad, not its straight box", () => {
    // a 2 x 0.2 pad turned by 90 degrees reaches 0.1mm toward the edge, not 1mm
    const circuit = [board(), net("A", ["sp_a"]), port("a", 9.4, 0), pad("a", 9.4, 0, 2, 0.2, { shape: "rotated_rect", ccw_rotation: 90 })];
    expect(rules(runDrcChecks(circuit))).not.toContain("board_edge_clearance");
    const straight = [board(), net("A", ["sp_a"]), port("a", 9.4, 0), pad("a", 9.4, 0, 2, 0.2)];
    expect(rules(runDrcChecks(straight))).toContain("board_edge_clearance");
  });

  it("checks traces against the edge, and follows a notched outline", () => {
    const trace: El = {
      type: "pcb_trace",
      pcb_trace_id: "edge",
      source_trace_id: "st_A",
      route: [
        { route_type: "wire", x: 9.8, y: -5, width: 0.2, layer: "top" },
        { route_type: "wire", x: 9.8, y: 5, width: 0.2, layer: "top" },
      ],
    };
    expect(rules(runDrcChecks([board(), net("A", ["sp_a"]), trace]))).toContain("board_edge_clearance");
    // an L-shaped board: the pad sits in the missing corner, inside the box
    const L = board({
      outline: [
        { x: -10, y: -10 },
        { x: 10, y: -10 },
        { x: 10, y: 0 },
        { x: 0, y: 0 },
        { x: 0, y: 10 },
        { x: -10, y: 10 },
      ],
    });
    const corner = [L, net("A", ["sp_a"]), port("a", 5, 5), pad("a", 5, 5)];
    expect(rules(runDrcChecks(corner))).toContain("board_edge_clearance");
    const inside = [L, net("A", ["sp_a"]), port("a", -5, -5), pad("a", -5, -5)];
    expect(rules(runDrcChecks(inside))).not.toContain("board_edge_clearance");
  });
});
