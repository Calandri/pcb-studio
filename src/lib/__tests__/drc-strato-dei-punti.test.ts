import { describe, expect, it } from "vitest";
import { stratoDiRame } from "@/components/board/strati-visibili";
import { DEFAULT_DESIGN_RULES } from "@/lib/design-rules";
import { runDrcChecks } from "@/lib/drc";

/*
 * "Solo i marcatori della faccia visibile, piu' quelli che toccano tutte e
 * due" (Niccolo', 2026-11-12). The viewer hides a marker whose layer is not
 * drawn (strati-visibili.ts), but the DRC said only WHERE a problem is, not on
 * which layer: every dot was on every face. Here the checker writes the layer
 * next to each point, when the problem is on one.
 *
 * Two nets, A (k1) and B (k2). Every distance below is 0,05 mm between copper
 * edges, under any minimum of the default rules.
 */
const RETI = [
  { type: "source_net", source_net_id: "n1", name: "A", subcircuit_connectivity_map_key: "k1" },
  { type: "source_net", source_net_id: "n2", name: "B", subcircuit_connectivity_map_key: "k2" },
  { type: "source_port", source_port_id: "sp1", name: "pin1", subcircuit_connectivity_map_key: "k1" },
  { type: "source_port", source_port_id: "sp2", name: "pin1", subcircuit_connectivity_map_key: "k2" },
  { type: "pcb_port", pcb_port_id: "pp1", source_port_id: "sp1", x: 0, y: 0, layers: ["bottom"] },
  { type: "pcb_port", pcb_port_id: "pp2", source_port_id: "sp2", x: 0, y: 0, layers: ["bottom"] },
  { type: "source_trace", source_trace_id: "st1", subcircuit_connectivity_map_key: "k1", connected_source_port_ids: ["sp1"], connected_source_net_ids: ["n1"] },
  { type: "source_trace", source_trace_id: "st2", subcircuit_connectivity_map_key: "k2", connected_source_port_ids: ["sp2"], connected_source_net_ids: ["n2"] },
];

/** a straight trace 0,2 wide along x, from x0 to x1 at height y */
const pista = (id: string, rete: 1 | 2, layer: string, y: number, x0 = 0, x1 = 5) => ({
  type: "pcb_trace",
  pcb_trace_id: id,
  source_trace_id: `st${rete}`,
  subcircuit_connectivity_map_key: `k${rete}`,
  route: [
    { route_type: "wire", x: x0, y, width: 0.2, layer },
    { route_type: "wire", x: x1, y, width: 0.2, layer },
  ],
});

const controlla = (els: unknown[]) => runDrcChecks([...RETI, ...els] as never, DEFAULT_DESIGN_RULES);
const punti = (els: unknown[], regola: string) =>
  controlla(els)
    .filter((v) => v.rule === regola)
    .flatMap((v) => v.points ?? []);

describe("the DRC says on which layer each problem is", () => {
  it("two traces of different nets too close on the bottom: the point is of the bottom", () => {
    // axes 0,25 apart, each 0,2 wide: 0,05 between the edges
    const p = punti([pista("a", 1, "bottom", 0), pista("b", 2, "bottom", 0.25)], "trace_trace_clearance");
    expect(p).toEqual([{ x: 2.5, y: 0, layer: "bottom" }]);
  });

  it("the same two traces on an inner plane: the point is of that plane", () => {
    const p = punti([pista("a", 1, "inner2", 0), pista("b", 2, "inner2", 0.25)], "trace_trace_clearance");
    expect(p).toEqual([{ x: 2.5, y: 0, layer: "inner2" }]);
  });

  it("one on the top and one on the bottom do not see each other: no point at all", () => {
    expect(punti([pista("a", 1, "top", 0), pista("b", 2, "bottom", 0.25)], "trace_trace_clearance")).toEqual([]);
  });

  it("a segment at a wrong angle: the point is on the layer of that segment", () => {
    // 20 degrees: tan(20) = 0,36397, so 5 mm along x climb 1,81985
    const storta = {
      type: "pcb_trace",
      pcb_trace_id: "storta",
      source_trace_id: "st1",
      subcircuit_connectivity_map_key: "k1",
      route: [
        { route_type: "wire", x: 0, y: 20, width: 0.2, layer: "inner1" },
        { route_type: "wire", x: 5, y: 21.81985, width: 0.2, layer: "inner1" },
      ],
    };
    const p = punti([storta], "trace_angle");
    expect(p).toHaveLength(1);
    expect(p[0].layer).toBe("inner1");
    expect(p[0].x).toBeCloseTo(2.5, 9);
    expect(p[0].y).toBeCloseTo(20.909925, 6);
  });

  it("a trace against a pad of another net, both on the bottom: the point is of the bottom", () => {
    // pad of A 1 x 0,5 at the origin (top edge at y 0,25); trace of B 0,2 wide with its axis at y 0,4: 0,05 between them
    const pad = { type: "pcb_smtpad", pcb_smtpad_id: "pad_a", pcb_port_id: "pp1", shape: "rect", x: 0, y: 0, width: 1, height: 0.5, layer: "bottom" };
    const p = punti([pad, pista("b", 2, "bottom", 0.4, -0.3, 0.3)], "trace_pad_clearance");
    expect(p).toHaveLength(1);
    expect(p[0].layer).toBe("bottom");
  });

  it("two pads of different nets too close on the bottom: the point is of the bottom", () => {
    // 1 x 0,5 each, centres 1,05 apart: 0,05 between the edges; the point is halfway
    const a = { type: "pcb_smtpad", pcb_smtpad_id: "pad_a", pcb_port_id: "pp1", shape: "rect", x: 20, y: 0, width: 1, height: 0.5, layer: "bottom" };
    const b = { type: "pcb_smtpad", pcb_smtpad_id: "pad_b", pcb_port_id: "pp2", shape: "rect", x: 21.05, y: 0, width: 1, height: 0.5, layer: "bottom" };
    expect(punti([a, b], "pad_clearance")).toEqual([{ x: 20.525, y: 0, layer: "bottom" }]);
  });

  it("what goes through the board has no layer: a via with a hole too small", () => {
    const via = { type: "pcb_via", pcb_via_id: "v1", x: 10, y: 10, hole_diameter: 0.05, outer_diameter: 0.6, layers: ["top", "bottom"] };
    const p = punti([via], "min_via_hole");
    expect(p).toEqual([{ x: 10, y: 10 }]);
    expect("layer" in p[0]).toBe(false);
  });

  it("aggregated occurrences keep each its own layer", () => {
    // four pairs, two on the top and two on the bottom: more than three, so they come back as one line with four points
    const coppie = [
      pista("a1", 1, "top", 0), pista("b1", 2, "top", 0.25),
      pista("a2", 1, "top", 3), pista("b2", 2, "top", 3.25),
      pista("a3", 1, "bottom", 6), pista("b3", 2, "bottom", 6.25),
      pista("a4", 1, "bottom", 9), pista("b4", 2, "bottom", 9.25),
    ];
    const v = controlla(coppie).filter((x) => x.rule === "trace_trace_clearance");
    expect(v).toHaveLength(1);
    expect(v[0].count).toBe(4);
    expect(v[0].points).toEqual([
      { x: 2.5, y: 0, layer: "top" },
      { x: 2.5, y: 3, layer: "top" },
      { x: 2.5, y: 6, layer: "bottom" },
      { x: 2.5, y: 9, layer: "bottom" },
    ]);
  });
});

describe("the viewer reads the checker's layer", () => {
  it("a copper layer stays itself, anything else means every face", () => {
    expect(stratoDiRame("top")).toBe("top");
    expect(stratoDiRame("bottom")).toBe("bottom");
    expect(stratoDiRame("inner1")).toBe("inner1");
    expect(stratoDiRame("inner2")).toBe("inner2");
    // a board checked before the checker named the layer, or a finding through the board
    expect(stratoDiRame(undefined)).toBeUndefined();
    expect(stratoDiRame(null)).toBeUndefined();
    expect(stratoDiRame("all")).toBeUndefined();
    expect(stratoDiRame("")).toBeUndefined();
  });
});
