import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BoardCanvas } from "../board/BoardCanvas";
import { VIEW_PRESETS } from "../ViewPresets";

/*
 * R35 e Q3 come su sbb-dl-retro: R35.2 e Q3.G sulla rete GATE (dichiarata),
 * R35.1 e Q3.D uniti da una pista senza rete. Prima la linea portava il nome
 * del PIN all'estremo ("pin2", "G") e le piazzole accese il nome della rete:
 * tre nomi per un collegamento (2026-11-09). Ora: la rete, uguale da tutti e
 * due i lati; il pin solo piccolo e col suo pezzo; senza rete, i due estremi.
 */
const pad = (id: string, comp: string, port: string, x: number) => [
  { type: "pcb_port", pcb_port_id: `pp_${id}`, source_port_id: `sp_${id}`, pcb_component_id: comp, x, y: 0 },
  { type: "pcb_smtpad", pcb_smtpad_id: `pad_${id}`, pcb_port_id: `pp_${id}`, pcb_component_id: comp, shape: "rect", x, y: 0, width: 0.5, height: 0.5, layer: "top" },
  { type: "source_port", source_port_id: `sp_${id}`, name: port, source_component_id: comp === "pc_r" ? "s_r" : "s_q" },
];
const CIRCUIT = [
  { type: "pcb_board", width: 30, height: 20, center: { x: 0, y: 0 }, num_layers: 2 },
  { type: "source_component", source_component_id: "s_r", name: "R35" },
  { type: "source_component", source_component_id: "s_q", name: "Q3" },
  { type: "pcb_component", pcb_component_id: "pc_r", source_component_id: "s_r", center: { x: -5, y: 0 }, width: 2, height: 1, rotation: 0, layer: "top" },
  { type: "pcb_component", pcb_component_id: "pc_q", source_component_id: "s_q", center: { x: 5, y: 0 }, width: 3, height: 2, rotation: 0, layer: "top" },
  ...pad("r1", "pc_r", "pin1", -5.5),
  ...pad("r2", "pc_r", "pin2", -4.5),
  ...pad("qg", "pc_q", "G", 4),
  ...pad("qd", "pc_q", "D", 5),
  ...pad("qs", "pc_q", "S", 6),
  { type: "source_net", source_net_id: "n_gate", name: "GATE" },
  { type: "source_trace", source_trace_id: "t1", connected_source_port_ids: ["sp_r2", "sp_qg"], connected_source_net_ids: ["n_gate"] },
  { type: "source_trace", source_trace_id: "t2", connected_source_port_ids: ["sp_r1", "sp_qd"], connected_source_net_ids: [] },
];

/** every text written on the board while a part is focused, main line and small line */
const scritte = (focus: string) => {
  const svg = renderToStaticMarkup(
    createElement(BoardCanvas, {
      circuitJson: CIRCUIT,
      flags: VIEW_PRESETS[0].flags,
      layer: "top",
      mode: "move",
      hoveredComponentId: focus,
    } as never),
  );
  const testo = (v: string | undefined) => (v ?? "").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  return [...svg.matchAll(/<text[^>]*>([^<]*)(?:<tspan[^>]*>([^<]*)<\/tspan>)?<\/text>/g)].map((m) => [testo(m[1]), testo(m[2])]);
};

describe("le linee dei collegamenti portano il nome della rete", () => {
  // the second line says where the net goes: how many pins and which (2026-11-09)
  it("da R35: GATE con i piedini dove va, e, senza rete, R35.1 > Q3.D", () => {
    expect(scritte("pc_r")).toEqual(
      expect.arrayContaining([
        ["GATE", "R35.2 · 2 piedini: Q3.G"],
        ["R35.1 > Q3.D", ""],
      ]),
    );
  });

  it("da Q3 la stessa rete si chiama allo stesso modo", () => {
    const t = scritte("pc_q");
    expect(t).toEqual(expect.arrayContaining([["GATE", "Q3.G · 2 piedini: R35.2"], ["Q3.D > R35.1", ""]]));
  });

  it("mai un pin da solo, mai None o undefined", () => {
    for (const focus of ["pc_r", "pc_q"]) {
      for (const [testo, sotto] of scritte(focus)) {
        expect(["G", "D", "S", "pin1", "pin2"]).not.toContain(testo);
        expect(`${testo} ${sotto}`).not.toMatch(/None|undefined|null/);
      }
    }
  });
});
