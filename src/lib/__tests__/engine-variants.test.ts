import { describe, expect, it } from "vitest";
import { runDrcChecks } from "@/lib/drc";
import { runSolver, spliceTraces } from "@/lib/variants";

type El = { type: string; [key: string]: unknown };

describe("spliced vias take the net of their own trace", () => {
  const base: El[] = [
    { type: "pcb_board", center: { x: 0, y: 0 }, width: 20, height: 20, num_layers: 2 },
    {
      type: "source_trace",
      source_trace_id: "source_trace_1",
      subcircuit_connectivity_map_key: "netA",
      connected_source_port_ids: ["sp_a"],
      connected_source_net_ids: [],
    },
    {
      type: "source_trace",
      source_trace_id: "source_trace_2",
      subcircuit_connectivity_map_key: "netB",
      connected_source_port_ids: ["sp_b"],
      connected_source_net_ids: [],
    },
    { type: "pcb_port", pcb_port_id: "pp_a", source_port_id: "sp_a", x: -5, y: 0, layers: ["top"] },
    { type: "pcb_port", pcb_port_id: "pp_b", source_port_id: "sp_b", x: 0.5, y: 0, layers: ["top"] },
    { type: "pcb_smtpad", shape: "rect", pcb_smtpad_id: "pad_a", pcb_port_id: "pp_a", x: -5, y: 0, width: 0.4, height: 0.4, layer: "top" },
    { type: "pcb_smtpad", shape: "rect", pcb_smtpad_id: "pad_b", pcb_port_id: "pp_b", x: 0.5, y: 0, width: 0.2, height: 0.2, layer: "top" },
  ];
  // net A's trace drops through a via right next to net B's pad
  const traces: El[] = [
    {
      type: "pcb_trace",
      connection_name: "source_trace_1",
      route: [
        { route_type: "wire", x: -5, y: 0, width: 0.2, layer: "top" },
        { route_type: "wire", x: -0.1, y: 0, width: 0.2, layer: "top" },
        { route_type: "via", x: -0.1, y: 0, from_layer: "top", to_layer: "bottom" },
        { route_type: "wire", x: -0.1, y: 0, width: 0.2, layer: "bottom" },
        { route_type: "wire", x: -0.1, y: 5, width: 0.2, layer: "bottom" },
      ],
    },
  ];

  it("does not borrow the nearest pad's port", () => {
    const out = spliceTraces(base, "sub", traces, "t");
    const via = out.find((el) => el.type === "pcb_via");
    expect(via?.subcircuit_connectivity_map_key).toBe("netA");
    expect(via?.pcb_port_id).toBeUndefined();
  });

  it("so the DRC sees the short it used to hide", () => {
    const out = spliceTraces(base, "sub", traces, "t");
    // via ring to x=0.2, pad from 0.4: 0.2mm is fine; move the pad closer
    const close = out.map((el) =>
      el.type === "pcb_smtpad" && el.pcb_smtpad_id === "pad_b" ? { ...el, x: 0.3 } : el,
    );
    const pairs = runDrcChecks(close).filter((v) => v.rule === "pad_clearance");
    expect(pairs.length).toBeGreaterThan(0);
  });
});

describe("runSolver has a wall-clock deadline", () => {
  it("gives up instead of grinding forever", () => {
    class Lento {
      solved = false;
      failed = false;
      step() {
        const until = Date.now() + 1;
        while (Date.now() < until) {
          // a step that never gets anywhere
        }
      }
      getOutputSimpleRouteJson() {
        return { traces: [] };
      }
    }
    const t0 = Date.now();
    expect(() => runSolver(Lento as never, {}, 1, 50)).toThrow(/interrotto/);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });
});
