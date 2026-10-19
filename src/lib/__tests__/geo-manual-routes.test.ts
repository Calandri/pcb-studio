import { describe, expect, it } from "vitest";
import {
  applyManualRoutes,
  manualRouteKey,
  mergeManualRoutes,
  pairKey,
  parseManualRoutes,
  type ManualRoute,
} from "@/lib/manual-routes";

type El = Record<string, unknown>;

/**
 * R1.pin1 and C1.pin1 and D1.anode all on GND, but the only <trace>s are
 * "R1.pin1 to net.GND" and "C1.pin1 to net.GND": no source trace names two
 * of the pads together. Plus a direct connection R1.pin2 -> U1.IN.
 */
function board(): El[] {
  return [
    { type: "source_net", source_net_id: "n_gnd", name: "GND", subcircuit_connectivity_map_key: "k_gnd" },
    { type: "source_component", source_component_id: "c_r1", name: "R1" },
    { type: "source_component", source_component_id: "c_c1", name: "C1" },
    { type: "source_component", source_component_id: "c_d1", name: "D1" },
    { type: "source_component", source_component_id: "c_u1", name: "U1" },
    { type: "source_port", source_port_id: "p_r1_1", source_component_id: "c_r1", name: "pin1" },
    { type: "source_port", source_port_id: "p_r1_2", source_component_id: "c_r1", name: "pin2" },
    { type: "source_port", source_port_id: "p_c1_1", source_component_id: "c_c1", name: "pin1" },
    { type: "source_port", source_port_id: "p_d1_a", source_component_id: "c_d1", name: "anode", port_hints: ["anode", "pin1"] },
    { type: "source_port", source_port_id: "p_u1_in", source_component_id: "c_u1", name: "IN" },
    {
      type: "source_trace",
      source_trace_id: "st_r1_gnd",
      display_name: ".R1 > .pin1 to net.GND",
      connected_source_port_ids: ["p_r1_1"],
      connected_source_net_ids: ["n_gnd"],
      subcircuit_connectivity_map_key: "k_gnd",
      subcircuit_id: "sub0",
    },
    {
      type: "source_trace",
      source_trace_id: "st_c1_gnd",
      display_name: ".C1 > .pin1 to net.GND",
      connected_source_port_ids: ["p_c1_1"],
      connected_source_net_ids: ["n_gnd"],
      subcircuit_connectivity_map_key: "k_gnd",
    },
    {
      type: "source_trace",
      source_trace_id: "st_r1_u1",
      display_name: ".R1 > .pin2 to .U1 > .IN",
      connected_source_port_ids: ["p_r1_2", "p_u1_in"],
      subcircuit_connectivity_map_key: "k_sig",
    },
    // the autorouter's copper for R1.pin1 -> GND, reaching U1 somewhere else
    {
      type: "pcb_trace",
      pcb_trace_id: "auto_gnd",
      source_trace_id: "st_r1_gnd",
      route: [
        { route_type: "wire", x: 0, y: 0, layer: "top", width: 0.2 },
        { route_type: "wire", x: 10, y: 0, layer: "top", width: 0.2 },
      ],
    },
    {
      type: "pcb_trace",
      pcb_trace_id: "auto_sig",
      source_trace_id: "st_r1_u1",
      route: [
        { route_type: "wire", x: 1, y: 0, layer: "top", width: 0.2 },
        { route_type: "via", x: 3, y: 0, from_layer: "top", to_layer: "bottom" },
        { route_type: "wire", x: 5, y: 0, layer: "bottom", width: 0.2 },
      ],
    },
    { type: "pcb_via", pcb_via_id: "auto_via", x: 3, y: 0, outer_diameter: 0.6, hole_diameter: 0.3 },
  ];
}

const route = (over: Partial<ManualRoute>): ManualRoute => ({
  connection: ".R1 > .pin1 to net.GND",
  width: 0.2,
  points: [
    { x: 0, y: 0, layer: "top" },
    { x: 0, y: 5, layer: "top" },
  ],
  ...over,
});

const traces = (cj: unknown[]) => (cj as El[]).filter((e) => e.type === "pcb_trace");

describe("parseManualRoutes", () => {
  it("refuses broken points and unknown layers instead of moving them to the top face", () => {
    const parsed = parseManualRoutes([
      { connection: "a", points: [{ x: 0, y: 0 }, { x: Number.NaN, y: 1 }] },
      { connection: "b", points: [{ x: 0, y: 0, layer: "inner3" }, { x: 1, y: 0, layer: "inner3" }] },
      { connection: "c", points: [{ x: 0, y: 0 }, { x: 1, y: 0, layer: "bottom" }] },
      null,
      { connection: "d", points: [{ x: 0, y: 0 }] },
    ]);
    expect(parsed.map((r) => r.connection)).toEqual(["c"]);
    // a missing layer is the old default
    expect(parsed[0].points[0].layer).toBe("top");
  });

  it("drops zero-length steps but keeps a layer change on the spot (a via)", () => {
    const [r] = parseManualRoutes([
      {
        connection: "a",
        points: [
          { x: 0, y: 0, layer: "top" },
          { x: 0, y: 0, layer: "top" },
          { x: 2, y: 0, layer: "top" },
          { x: 2, y: 0, layer: "bottom" },
          { x: 2, y: 3, layer: "bottom" },
        ],
      },
    ]);
    expect(r.points).toHaveLength(4);
  });

  it("clamps widths and ignores absurd vias", () => {
    const [r] = parseManualRoutes([
      { connection: "a", width: 500, viaDiameter: 0, viaHoleDiameter: -1, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }] },
    ]);
    expect(r.width).toBe(10);
    expect(r.viaDiameter).toBeUndefined();
    expect(r.viaHoleDiameter).toBeUndefined();
    const [s] = parseManualRoutes([
      { connection: "a", width: 0, viaDiameter: 50, viaHoleDiameter: 40, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }] },
    ]);
    expect(s.width).toBe(0.05);
    expect(s.viaDiameter).toBe(6);
    expect(s.viaHoleDiameter!).toBeLessThan(6);
  });

  it("caps the count and the points of what a client sends", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ connection: `c${i}`, points: [{ x: 0, y: 0 }, { x: 1, y: i }] }));
    expect(parseManualRoutes(many, { maxRoutes: 3 })).toHaveLength(3);
    const long = [{ connection: "x", points: Array.from({ length: 50 }, (_, i) => ({ x: i, y: 0 })) }];
    expect(parseManualRoutes(long, { maxPoints: 10 })).toHaveLength(0);
  });

  it("derives a stable id from the two pads, whichever end was drawn first", () => {
    const [a] = parseManualRoutes([{ ...route({}), from: ".R1>.pin1", to: ".C1 > .pin1" }]);
    const [b] = parseManualRoutes([{ ...route({}), from: ".C1 > .pin1", to: ".R1 > .pin1" }]);
    expect(a.id).toBe(pairKey(".R1 > .pin1", ".C1 > .pin1"));
    expect(a.id).toBe(b.id);
  });
});

describe("mergeManualRoutes", () => {
  it("keeps two branches drawn from the same pad, replaces a redraw of the same pair", () => {
    const toC1 = route({ from: ".R1 > .pin1", to: ".C1 > .pin1" });
    const toD1 = route({ from: ".R1 > .pin1", to: ".D1 > .anode" });
    const both = mergeManualRoutes(mergeManualRoutes([], [toC1]), [toD1]);
    expect(both).toHaveLength(2);
    const redraw = route({ from: ".C1 > .pin1", to: ".R1 > .pin1", points: [{ x: 0, y: 0, layer: "top" }, { x: 7, y: 7, layer: "top" }] });
    const after = mergeManualRoutes(both, [redraw]);
    expect(after).toHaveLength(2);
    expect(after.find((r) => manualRouteKey(r) === manualRouteKey(toC1))!.points[1]).toEqual({ x: 7, y: 7, layer: "top" });
  });

  it("still replaces legacy entries by connection", () => {
    const old = route({});
    const again = route({ points: [{ x: 1, y: 1, layer: "top" }, { x: 2, y: 2, layer: "top" }] });
    expect(mergeManualRoutes([old], [again])).toEqual([again]);
  });
});

describe("applyManualRoutes", () => {
  it("adds a branch between pads no trace names together, without replacing the net's copper", () => {
    const r = applyManualRoutes({
      circuitJson: board(),
      routes: [
        route({ from: ".R1 > .pin1", to: ".C1 > .pin1" }),
        route({ from: ".R1 > .pin1", to: ".D1 > .pin1", points: [{ x: 0, y: 0, layer: "top" }, { x: -4, y: 0, layer: "top" }] }),
      ],
    });
    const t = traces(r.circuitJson);
    // the autorouted copper of R1.pin1 -> GND is still there
    expect(t.find((e) => e.pcb_trace_id === "auto_gnd")).toBeDefined();
    const branches = t.filter((e) => e.manual === true);
    expect(branches).toHaveLength(2);
    expect(new Set(branches.map((e) => e.manual_route_id)).size).toBe(2);
    expect(r.branches).toHaveLength(2);
    expect(branches[0].subcircuit_id).toBe("sub0");
  });

  it("replaces the copper of a connection that names both pads, and its vias", () => {
    const r = applyManualRoutes({
      circuitJson: board(),
      routes: [
        route({
          connection: ".R1 > .pin2 to .U1 > .IN",
          from: ".R1 > .pin2",
          to: ".U1 > .IN",
          points: [
            { x: 1, y: 0, layer: "top" },
            { x: 1, y: 4, layer: "top" },
            { x: 1, y: 4, layer: "bottom" },
            { x: 5, y: 4, layer: "bottom" },
          ],
        }),
      ],
    });
    const els = r.circuitJson as El[];
    const sig = traces(els).filter((e) => e.source_trace_id === "st_r1_u1");
    expect(sig).toHaveLength(1);
    expect(sig[0].manual).toBe(true);
    // the old via is gone, the new one exists and is marked manual
    const vias = els.filter((e) => e.type === "pcb_via");
    expect(vias.find((v) => v.pcb_via_id === "auto_via")).toBeUndefined();
    expect(vias).toHaveLength(1);
    expect(vias[0]).toMatchObject({ x: 1, y: 4, manual: true });
  });

  it("gives the same board when run twice", () => {
    const routes = [
      route({ from: ".R1 > .pin1", to: ".C1 > .pin1", points: [{ x: 0, y: 0, layer: "top" }, { x: 0, y: 2, layer: "top" }, { x: 0, y: 2, layer: "bottom" }, { x: 4, y: 2, layer: "bottom" }] }),
    ];
    const once = applyManualRoutes({ circuitJson: board(), routes }).circuitJson;
    const twice = applyManualRoutes({ circuitJson: once, routes }).circuitJson;
    const count = (cj: unknown[], type: string) => (cj as El[]).filter((e) => e.type === type).length;
    expect(count(twice, "pcb_trace")).toBe(count(once, "pcb_trace"));
    expect(count(twice, "pcb_via")).toBe(count(once, "pcb_via"));
  });

  it("drops copper whose route has been removed from the file", () => {
    const routes = [route({ from: ".R1 > .pin1", to: ".C1 > .pin1" })];
    const once = applyManualRoutes({ circuitJson: board(), routes }).circuitJson;
    const released = applyManualRoutes({ circuitJson: once, routes: [] }).circuitJson;
    expect(traces(released).filter((e) => e.manual === true)).toHaveLength(0);
  });

  it("reports routes whose pads are not on the board", () => {
    const r = applyManualRoutes({ circuitJson: board(), routes: [route({ from: ".R9 > .pin1", to: ".C1 > .pin1" })] });
    expect(r.unknown).toHaveLength(1);
  });
});
