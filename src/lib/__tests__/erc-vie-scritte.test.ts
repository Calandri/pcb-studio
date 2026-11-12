import { describe, expect, it } from "vitest";
import { runErcChecks } from "@/lib/erc";

/*
 * A <via> written in a file is not a part with pins. tscircuit gives it three
 * ports (top, bottom, pin1) under a `source_manually_placed_via` and puts none
 * of them in a source trace: the ERC reported each as "?.top non è collegato a
 * nulla". sbb-dl-principale had 543 such lines for its 181 vias, and "Cuci la
 * massa" adds three for every via it writes (PCB Wildy, 2026-11-12).
 *
 * The circuit: R1 with pin1 on a net together with R2.pin1, R1.pin2 left
 * open on purpose, and one via V1 with its three ports.
 */
const circuito = (conVia: boolean) => [
  { type: "source_component", source_component_id: "sc_r1", name: "R1" },
  { type: "source_component", source_component_id: "sc_r2", name: "R2" },
  { type: "source_port", source_port_id: "p_r1_1", name: "pin1", source_component_id: "sc_r1" },
  { type: "source_port", source_port_id: "p_r1_2", name: "pin2", source_component_id: "sc_r1" },
  { type: "source_port", source_port_id: "p_r2_1", name: "pin1", source_component_id: "sc_r2" },
  { type: "source_net", source_net_id: "n_gnd", name: "GND" },
  { type: "source_trace", source_trace_id: "t1", subcircuit_connectivity_map_key: "k_gnd", connected_source_port_ids: ["p_r1_1", "p_r2_1"], connected_source_net_ids: ["n_gnd"] },
  ...(conVia
    ? [
        { type: "source_manually_placed_via", source_manually_placed_via_id: "via_0" },
        { type: "source_port", source_port_id: "p_v_top", name: "top", source_component_id: "via_0" },
        { type: "source_port", source_port_id: "p_v_bottom", name: "bottom", source_component_id: "via_0" },
        { type: "source_port", source_port_id: "p_v_pin1", name: "pin1", source_component_id: "via_0" },
      ]
    : []),
];

describe("the ERC does not take the ports of a written via for pins", () => {
  it("a via adds no unconnected pin: the count is the one of the parts alone", () => {
    const senza = runErcChecks(circuito(false) as never);
    const con = runErcChecks(circuito(true) as never);
    // R1.pin2 is the only pin left open, with the via and without
    expect(senza.counts.unconnected_pin).toBe(1);
    expect(con.counts.unconnected_pin).toBe(1);
    expect(con.counts).toEqual(senza.counts);
    expect(con.violations).toEqual(senza.violations);
  });

  it("the pin of a real part left open is still reported, by name", () => {
    const con = runErcChecks(circuito(true) as never);
    expect(con.violations.filter((v) => v.rule === "unconnected_pin").map((v) => v.message)).toEqual(["R1.pin2 non è collegato a nulla"]);
  });

  it("a port that names no part and no via is still reported: only a via's ports are skipped", () => {
    const orfana = [...circuito(true), { type: "source_port", source_port_id: "p_x", name: "pin9", source_component_id: "non_esiste" }];
    const r = runErcChecks(orfana as never);
    expect(r.counts.unconnected_pin).toBe(2);
    expect(r.violations.map((v) => v.message)).toContain("?.pin9 non è collegato a nulla");
  });

  it("a hundred written vias leave the list free for the real findings", () => {
    const tante = [
      ...circuito(false),
      ...Array.from({ length: 100 }, (_, i) => [
        { type: "source_manually_placed_via", source_manually_placed_via_id: `via_${i}` },
        ...["top", "bottom", "pin1"].map((nome) => ({ type: "source_port", source_port_id: `p_${i}_${nome}`, name: nome, source_component_id: `via_${i}` })),
      ]).flat(),
    ];
    const r = runErcChecks(tante as never);
    // 300 ports of vias used to fill the 200 lines of the list: now there is the one real finding
    expect(r.counts.unconnected_pin).toBe(1);
    expect(r.violations).toHaveLength(1);
  });
});
