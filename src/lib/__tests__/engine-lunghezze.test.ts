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
