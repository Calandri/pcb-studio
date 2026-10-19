import { describe, expect, it } from "vitest";
import { parseFarads, runPrcChecks } from "@/lib/prc";

type El = { type: string; [key: string]: unknown };

describe("parseFarads", () => {
  it("reads capacitances the way schematics write them", () => {
    expect(parseFarads("100n")).toBeCloseTo(1e-7, 15);
    expect(parseFarads("0.1u")).toBeCloseTo(1e-7, 15);
    expect(parseFarads("100nF")).toBeCloseTo(1e-7, 15);
    expect(parseFarads("100 nF 50V")).toBeCloseTo(1e-7, 15);
    expect(parseFarads("4n7")).toBeCloseTo(4.7e-9, 15);
    expect(parseFarads("10µF")).toBeCloseTo(1e-5, 12);
    expect(parseFarads("10µ")).toBeCloseTo(1e-5, 12);
    expect(parseFarads("22pF")).toBeCloseTo(2.2e-11, 18);
    expect(parseFarads("1e-7")).toBeCloseTo(1e-7, 15);
  });

  it("does not take an inductor or a word for a capacitor", () => {
    expect(parseFarads("100nH")).toBeNull();
    expect(parseFarads("abc")).toBeNull();
    expect(parseFarads("")).toBeNull();
  });
});

const nets: El[] = [
  { type: "source_net", source_net_id: "source_net_0", name: "GND" },
  { type: "source_net", source_net_id: "source_net_1", name: "VCC" },
  { type: "source_net", source_net_id: "source_net_2", name: "SIG" },
];

/** a component pin: source port, pcb port and pad */
const pin = (comp: string, id: string, x: number, y: number): El[] => [
  { type: "source_port", source_port_id: `sp_${id}`, source_component_id: comp },
  { type: "pcb_port", pcb_port_id: `pp_${id}`, source_port_id: `sp_${id}`, x, y, layers: ["top"] },
  { type: "pcb_smtpad", shape: "rect", pcb_smtpad_id: `pad_${id}`, pcb_port_id: `pp_${id}`, x, y, width: 0.5, height: 0.5, layer: "top" },
];

const conn = (id: string, key: string, ports: string[], net: string): El => ({
  type: "source_trace",
  source_trace_id: id,
  subcircuit_connectivity_map_key: key,
  connected_source_port_ids: ports,
  connected_source_net_ids: [net],
});

describe("decoupling: a cap written without the F is still checked", () => {
  it("warns on a 100n cap far from its chip", () => {
    const circuit: El[] = [
      ...nets,
      { type: "source_component", source_component_id: "c1", name: "C1", ftype: "simple_capacitor", display_value: "100n" },
      { type: "source_component", source_component_id: "u1", name: "U1", ftype: "simple_chip" },
      ...pin("c1", "c1p", 0, 0),
      ...pin("c1", "c1n", 1, 0),
      ...pin("u1", "u1vcc", 10, 0),
      conn("st1", "vcc", ["sp_c1p", "sp_u1vcc"], "source_net_1"),
      conn("st2", "gnd", ["sp_c1n"], "source_net_0"),
    ];
    expect(runPrcChecks(circuit).map((v) => v.rule)).toContain("decoupling_distance");
  });
});

describe("return vias: a via's net comes from its trace, not from the nearest pad", () => {
  it("a signal via next to a connector's ground pad is not its return path", () => {
    const circuit: El[] = [
      { type: "pcb_board", center: { x: 0, y: 0 }, width: 30, height: 30, num_layers: 4 },
      ...nets,
      { type: "source_component", source_component_id: "j1", name: "J1", ftype: "simple_pinheader" },
      ...pin("j1", "j1gnd", 0, 0),
      ...pin("x", "sig", 5, 0),
      conn("st1", "gnd", ["sp_j1gnd"], "source_net_0"),
      conn("st2", "sig", ["sp_sig"], "source_net_2"),
      {
        type: "pcb_trace",
        pcb_trace_id: "t_sig",
        source_trace_id: "st2",
        route: [
          { route_type: "wire", x: 5, y: 0, width: 0.2, layer: "top" },
          { route_type: "wire", x: 0.4, y: 0, width: 0.2, layer: "top" },
          { route_type: "via", x: 0.4, y: 0, from_layer: "top", to_layer: "bottom" },
          { route_type: "wire", x: 0.4, y: 0, width: 0.2, layer: "bottom" },
        ],
      },
      { type: "pcb_via", pcb_via_id: "v_sig", x: 0.4, y: 0, outer_diameter: 0.6, hole_diameter: 0.3, layers: ["top", "bottom"] },
    ];
    // the nearest-pad guess called this via ground and the warning disappeared
    expect(runPrcChecks(circuit).map((v) => v.rule)).toContain("return_via_connector");
  });
});
