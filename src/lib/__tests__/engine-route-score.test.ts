import { describe, expect, it } from "vitest";
import { computeUnroutedGroupKeys, scoreCircuit, unroutedGroups } from "@/lib/route-score";

type El = { type: string; [key: string]: unknown };

const board: El = { type: "pcb_board", center: { x: 0, y: 0 }, width: 40, height: 40, num_layers: 2 };

/** one pad, its pcb port and source port, on the given layer */
const pin = (id: string, x: number, y: number, layer = "top"): El[] => [
  { type: "pcb_port", pcb_port_id: `pp_${id}`, source_port_id: `sp_${id}`, x, y, layers: [layer] },
  {
    type: "pcb_smtpad",
    shape: "rect",
    pcb_smtpad_id: `pad_${id}`,
    pcb_port_id: `pp_${id}`,
    x,
    y,
    width: 0.6,
    height: 0.6,
    layer,
  },
];

const wire = (x: number, y: number, layer = "top") => ({ route_type: "wire", x, y, width: 0.2, layer });

const trace = (id: string, route: Array<Record<string, unknown>>, sourceTraceId = "st_n1"): El => ({
  type: "pcb_trace",
  pcb_trace_id: id,
  source_trace_id: sourceTraceId,
  route,
});

/** a three-pad net written as the router writes it: two source traces, one key */
const threePadNet: El[] = [
  board,
  ...pin("a", 0, 0),
  ...pin("b", 5, 0),
  ...pin("c", 5, 5),
  {
    type: "source_trace",
    source_trace_id: "st_n1",
    subcircuit_connectivity_map_key: "N",
    connected_source_port_ids: ["sp_a", "sp_b"],
    connected_source_net_ids: [],
  },
  {
    type: "source_trace",
    source_trace_id: "st_n2",
    subcircuit_connectivity_map_key: "N",
    connected_source_port_ids: ["sp_b", "sp_c"],
    connected_source_net_ids: [],
  },
];

describe("unrouted is judged pad by pad", () => {
  it("a net with one leg drawn is still open", () => {
    const circuit = [...threePadNet, trace("t1", [wire(0, 0), wire(5, 0)])];
    // the old per-group verdict said routed: one of its traces existed
    expect(computeUnroutedGroupKeys(circuit).has("N")).toBe(true);
    // and the pad waiting for copper is the one named
    expect(unroutedGroups(circuit).get("N")).toEqual(["pp_c"]);
  });

  it("a T-junction landing on another trace closes it", () => {
    const circuit = [
      ...threePadNet,
      trace("t1", [wire(0, 0), wire(5, 0)]),
      trace("t2", [wire(5, 5), wire(2.5, 2.5), wire(2.5, 0)], "st_n2"),
    ];
    expect(computeUnroutedGroupKeys(circuit).size).toBe(0);
  });

  it("copper on another layer does not connect without a via", () => {
    const pads = [
      board,
      ...pin("a", 0, 0),
      ...pin("b", 6, 0, "bottom"),
      {
        type: "source_trace",
        source_trace_id: "st_n1",
        subcircuit_connectivity_map_key: "N",
        connected_source_port_ids: ["sp_a", "sp_b"],
        connected_source_net_ids: [],
      },
    ];
    const top = trace("t1", [wire(0, 0), wire(3, 0)]);
    const bottom = trace("t2", [wire(3, 0, "bottom"), wire(6, 0, "bottom")]);
    expect(computeUnroutedGroupKeys([...pads, top, bottom]).has("N")).toBe(true);
    const via: El = { type: "pcb_via", pcb_via_id: "v", x: 3, y: 0, outer_diameter: 0.6, hole_diameter: 0.3, layers: ["top", "bottom"] };
    expect(computeUnroutedGroupKeys([...pads, top, bottom, via]).size).toBe(0);
    // a via point inside one route works the same way
    const oneRoute = trace("t3", [
      wire(0, 0),
      wire(3, 0),
      { route_type: "via", x: 3, y: 0, from_layer: "top", to_layer: "bottom" },
      wire(3, 0, "bottom"),
      wire(6, 0, "bottom"),
    ]);
    expect(computeUnroutedGroupKeys([...pads, oneRoute]).size).toBe(0);
  });

  it("pins the part joins inside itself count as joined", () => {
    const circuit = [
      ...threePadNet,
      trace("t1", [wire(0, 0), wire(5, 0)]),
      {
        type: "source_component",
        source_component_id: "sc1",
        internally_connected_source_port_ids: [["sp_b", "sp_c"]],
      },
    ];
    expect(computeUnroutedGroupKeys(circuit).size).toBe(0);
  });

  it("a net with a poured plane keeps the plane rule", () => {
    const circuit = [
      ...threePadNet.map((el) =>
        el.type === "source_trace" ? { ...el, connected_source_net_ids: ["source_net_0"] } : el,
      ),
      {
        type: "pcb_copper_pour",
        source_net_id: "source_net_0",
        layer: "bottom",
        shape: "brep",
        brep_shape: {
          outer_ring: {
            vertices: [
              { x: -20, y: -20 },
              { x: 20, y: -20 },
              { x: 20, y: 20 },
              { x: -20, y: 20 },
            ],
          },
          inner_rings: [],
        },
      },
    ];
    expect(computeUnroutedGroupKeys(circuit).size).toBe(0);
  });

  it("a single-pad net has nothing to connect", () => {
    const circuit = [
      board,
      ...pin("a", 0, 0),
      {
        type: "source_trace",
        source_trace_id: "st_x",
        subcircuit_connectivity_map_key: "X",
        connected_source_port_ids: ["sp_a"],
        connected_source_net_ids: ["source_net_9"],
      },
    ];
    expect(computeUnroutedGroupKeys(circuit).size).toBe(0);
  });
});

describe("scoreCircuit counts every DRC occurrence", () => {
  it("uses the true count of an aggregated rule", () => {
    const crooked = Array.from({ length: 12 }, (_, i) =>
      trace(`c${i}`, [wire(-10, -10 + i), wire(-9, -9.7 + i)], ""),
    );
    const score = scoreCircuit([board, ...crooked]);
    expect(score.drc).toBeGreaterThanOrEqual(12);
  });
});
