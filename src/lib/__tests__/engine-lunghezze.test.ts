import { describe, expect, it } from "vitest";
import { controllaLunghezze } from "@/lib/lunghezze";

type El = { type: string; [key: string]: unknown };

/** a net with its source trace and, when given, one straight trace of that length */
const rete = (nome: string, lunghezzaMm: number | null, y: number): El[] => {
  const k = `k_${nome}`;
  const out: El[] = [
    { type: "source_net", source_net_id: `sn_${nome}`, name: nome, subcircuit_connectivity_map_key: k },
    { type: "source_trace", source_trace_id: `st_${nome}`, subcircuit_connectivity_map_key: k, connected_source_port_ids: [], connected_source_net_ids: [`sn_${nome}`] },
  ];
  if (lunghezzaMm !== null) {
    out.push({
      type: "pcb_trace",
      pcb_trace_id: `t_${nome}`,
      source_trace_id: `st_${nome}`,
      route: [
        { route_type: "wire", x: 0, y, width: 0.2, layer: "top" },
        { route_type: "wire", x: lunghezzaMm, y, width: 0.2, layer: "top" },
      ],
    });
  }
  return out;
};

describe("matched lengths: a net that cannot be measured is reported", () => {
  const circuit = [...rete("D0", 10, 0), ...rete("D1", 10.5, 1), ...rete("D2", null, 2)];

  it("names the misspelled and the unrouted nets, and the group is not matched", () => {
    const [esito] = controllaLunghezze(circuit, [
      { nome: "BUS", tolleranzaMm: 1, reti: ["D0", "D1", "D2", "DX"] },
    ]);
    expect(esito.dentro).toBe(false);
    expect(esito.mancanti).toEqual([
      { net: "D2", motivo: "senza_rame" },
      { net: "DX", motivo: "assente" },
    ]);
  });

  it("a complete group within tolerance is still matched", () => {
    const [esito] = controllaLunghezze(circuit, [{ nome: "BUS", tolleranzaMm: 1, reti: ["D0", "D1"] }]);
    expect(esito.dentro).toBe(true);
    expect(esito.mancanti).toEqual([]);
  });

  it("a group with only one routed net is no longer skipped", () => {
    const out = controllaLunghezze(circuit, [{ nome: "PAIR", tolleranzaMm: 1, reti: ["D0", "D2"] }]);
    expect(out).toHaveLength(1);
    expect(out[0].dentro).toBe(false);
  });
});

describe("matched lengths: a net tie joins the pads on its own layer", () => {
  /** a pad of a net, with the port and the source trace that name its net */
  const padDi = (nome: string, id: string, x: number, layer: string): El[] => [
    { type: "source_trace", source_trace_id: `st_${id}`, subcircuit_connectivity_map_key: `k_${nome}`, connected_source_port_ids: [`sp_${id}`], connected_source_net_ids: [] },
    { type: "pcb_port", pcb_port_id: `pp_${id}`, source_port_id: `sp_${id}` },
    { type: "pcb_smtpad", shape: "rect", pcb_smtpad_id: id, pcb_port_id: `pp_${id}`, x, y: 0, width: 0.3, height: 0.3, layer },
  ];
  const ponte: El = {
    type: "pcb_trace",
    pcb_trace_id: "nt",
    netTie: true,
    route: [
      { route_type: "wire", x: 20, y: 0, width: 0.3, layer: "top" },
      { route_type: "wire", x: 20.5, y: 0, width: 0.3, layer: "top" },
    ],
  };

  it("stitches the two halves it bridges, not a pad of the other face under it", () => {
    const circuit = [
      ...rete("D0", 10, 5),
      ...rete("D1a", 6, 6),
      ...rete("D1b", 4, 7),
      // a pad of D0 on the bottom, right under the bridge's end, first in the file
      ...padDi("D0", "d0_sotto", 20, "bottom"),
      ...padDi("D1a", "nt_1", 20, "top"),
      ...padDi("D1b", "nt_2", 20.5, "top"),
      ponte,
    ];
    const [esito] = controllaLunghezze(circuit, [{ nome: "BUS", tolleranzaMm: 1, reti: ["D0", "D1a", "D1b"] }]);
    // stitched to D0 the halves read 14 mm against 6
    expect(esito.misure.map((m) => m.net).sort()).toEqual(["D0", "D1a+D1b"]);
    expect(esito.dentro).toBe(true);
  });
});
