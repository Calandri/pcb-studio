import { describe, expect, it } from "vitest";
import { snapTo45, stitchToPlanes, straightenPinEscapes } from "@/lib/house-rules";

type El = { type: string; [key: string]: unknown };

const routeOf = (circuit: El[], id: string) =>
  (circuit.find((el) => el.pcb_trace_id === id)?.route ?? []) as Array<Record<string, unknown>>;

describe("inserted bends are plain wire points", () => {
  it("snapTo45 does not turn a bend into a second via", () => {
    const circuit: El[] = [
      {
        type: "pcb_trace",
        pcb_trace_id: "t",
        route: [
          { route_type: "wire", x: 0, y: 0, width: 0.2, layer: "top" },
          { route_type: "via", x: 3, y: 1, from_layer: "top", to_layer: "bottom", outer_diameter: 0.6 },
        ],
      },
    ];
    const route = routeOf(snapTo45(circuit), "t");
    expect(route).toHaveLength(3);
    expect(route[1]).toEqual({ route_type: "wire", x: 2, y: 0, width: 0.2, layer: "top" });
    expect(route.filter((p) => p.route_type === "via")).toHaveLength(1);
  });

  it("straightenPinEscapes does not copy the pad's port onto the bend", () => {
    const circuit: El[] = [
      { type: "pcb_smtpad", shape: "rect", pcb_smtpad_id: "p", x: 0, y: 0, width: 1, height: 0.5, layer: "top" },
      {
        type: "pcb_trace",
        pcb_trace_id: "t",
        route: [
          { route_type: "wire", x: 0, y: 0, width: 0.2, layer: "top", start_pcb_port_id: "pp_1" },
          { route_type: "wire", x: 1, y: 1, width: 0.2, layer: "top", end_pcb_port_id: "pp_2" },
        ],
      },
    ];
    const route = routeOf(straightenPinEscapes(circuit), "t");
    expect(route).toHaveLength(3);
    expect(route[1].start_pcb_port_id).toBeUndefined();
    expect(route[1].route_type).toBe("wire");
    expect(route.filter((p) => p.start_pcb_port_id === "pp_1")).toHaveLength(1);
  });
});

describe("stitchToPlanes keeps the wire of a pad that got no via", () => {
  const pour: El = {
    type: "pcb_copper_pour",
    source_net_id: "source_net_0",
    layer: "inner1",
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
  };
  const ground = (id: string, x: number): El[] => [
    { type: "pcb_port", pcb_port_id: `pp_${id}`, source_port_id: `sp_${id}`, x, y: 0, layers: ["top"] },
    { type: "pcb_smtpad", shape: "rect", pcb_smtpad_id: `pad_${id}`, pcb_port_id: `pp_${id}`, x, y: 0, width: 1, height: 1, layer: "top" },
  ];
  const base: El[] = [
    { type: "pcb_board", center: { x: 0, y: 0 }, width: 40, height: 40, num_layers: 4 },
    { type: "source_net", source_net_id: "source_net_0", name: "GND" },
    pour,
    ...ground("a", -5),
    ...ground("b", 5),
    {
      type: "source_trace",
      source_trace_id: "st_gnd",
      subcircuit_connectivity_map_key: "gnd",
      connected_source_port_ids: ["sp_a", "sp_b"],
      connected_source_net_ids: ["source_net_0"],
    },
    {
      type: "pcb_trace",
      pcb_trace_id: "gnd_wire",
      source_trace_id: "st_gnd",
      route: [
        { route_type: "wire", x: -5, y: 0, width: 0.25, layer: "top" },
        { route_type: "wire", x: 5, y: 0, width: 0.25, layer: "top" },
      ],
    },
  ];

  it("drops the ground wire when every pad reached the plane", () => {
    const out = stitchToPlanes(base, undefined, 0);
    expect(out.some((el) => el.pcb_trace_id === "gnd_wire")).toBe(false);
    expect(out.filter((el) => String(el.pcb_via_id ?? "").startsWith("pcb_via_plane_pad_"))).toHaveLength(2);
  });

  it("keeps it when one pad has no room for its via", () => {
    // another net's pad all around pad b: no free spot for the tie via
    const crowded: El = {
      type: "pcb_smtpad",
      shape: "rect",
      pcb_smtpad_id: "wall",
      x: 5,
      y: 0,
      width: 8,
      height: 8,
      layer: "top",
    };
    const out = stitchToPlanes([...base, crowded], undefined, 0);
    expect(out.some((el) => el.pcb_trace_id === "gnd_wire")).toBe(true);
  });
});

describe("straightenPinEscapes on a rotated pad", () => {
  it("leaves an escape along the pad's axis alone and bends a crooked one along that axis", () => {
    const pad: El = { type: "pcb_smtpad", shape: "rotated_rect", pcb_smtpad_id: "p", x: 0, y: 0, width: 1.194, height: 0.305, ccw_rotation: 135, layer: "top" };
    const trace = (id: string, tx: number, ty: number): El => ({
      type: "pcb_trace",
      pcb_trace_id: id,
      route: [
        { route_type: "wire", x: 0, y: 0, width: 0.15, layer: "top" },
        { route_type: "wire", x: tx, y: ty, width: 0.15, layer: "top" },
      ],
    });
    const out = straightenPinEscapes([pad, trace("dritta", -1, 1), trace("storta", -2, 0)]);
    expect(routeOf(out, "dritta")).toHaveLength(2);
    const storta = routeOf(out, "storta");
    expect(storta).toHaveLength(3);
    // the bend sits on the pad's long axis, at 135 degrees from the centre
    const bx = Number(storta[1].x);
    const by = Number(storta[1].y);
    expect(bx).toBeLessThan(0);
    expect(by).toBeCloseTo(-bx, 6);
  });
});
