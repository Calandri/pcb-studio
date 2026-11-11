import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * sbb-dl-principale (156 parts, 168 hand traces, ~410 pieces of pour), 11/11/2026:
 * every compile on the server saved the board at ~300 s, then drew the
 * schematic and poured the planes and ran every check a SECOND time on the same
 * files: past the function's 800 s, killed with no outcome, the schematic gone
 * for good. The copper, the pours and the checks are computed once; the
 * schematic is put on the board already computed, and when it cannot end in the
 * time left it does not start.
 */
const conta = vi.hoisted(() => ({ ricolate: 0 }));
vi.mock("@/lib/pours-recompute", async () => {
  const real = await vi.importActual<typeof import("@/lib/pours-recompute")>("@/lib/pours-recompute");
  return {
    ...real,
    ricolaPiani: vi.fn(async (...args: Parameters<typeof real.ricolaPiani>) => {
      conta.ricolate++;
      return real.ricolaPiani(...args);
    }),
  };
});

import {
  compileProject,
  costoDelloSchematico,
  DOPO_LO_SCHEMATICO_MS,
  graftSchematic,
  innestaSchematico,
  SCHEMATICO_SENZA_MISURA_MS,
  schematicKeyOf,
  soloCioCheLeggeLoSchematico,
  stimaDelloSchematico,
  type CompileSummary,
} from "@/lib/compile";

type El = Record<string, unknown> & { type: string };

/** a hand-drawn board: a trace with its path, two vias, two ground pours */
const SCHEDA = `export default () => (
  <board width="24mm" height="12mm" schTraceAutoLabelEnabled>
    <net name="GND" />
    <net name="SIG" />
    <resistor name="R1" resistance="1k" footprint="0805" pcbX={-6} pcbY={0} schSectionName="ingresso" />
    <resistor name="R2" resistance="1k" footprint="0805" pcbX={6} pcbY={0} schSectionName="uscita" />
    <trace from=".R1 > .pin1" to=".R2 > .pin1" pcbPathRelativeTo=".R1 > .pin1" pcbPath={[{ x: 0, y: -3 }, { x: 12, y: -3 }, { x: 12, y: 0 }]} thickness="0.25mm" />
    <trace from=".R1 > .pin2" to="net.GND" />
    <trace from=".R2 > .pin2" to="net.SIG" />
    <via pcbX={-6} pcbY={3} fromLayer="top" toLayer="bottom" outerDiameter="0.6mm" holeDiameter="0.3mm" connectsTo="net.SIG" />
    <copperpour layer="top" connectsTo="net.GND" clearance="0.4mm" outline={[{x: -11, y: -5}, {x: -0.5, y: -5}, {x: -0.5, y: 5}, {x: -11, y: 5}]} />
    <copperpour layer="bottom" connectsTo="net.GND" outline={[{x: 0.5, y: -5}, {x: 11, y: -5}, {x: 11, y: 5}, {x: 0.5, y: 5}]} />
  </board>
)
`;

/** tscircuit numbers its components across the process and writes the number into warnings: it does not count */
const norm = (v: unknown) => JSON.stringify(v).replace(/<(\w+)#\d+/g, "<$1#");
const diTipo = (cj: unknown[], tipo: string) => (cj as El[]).filter((e) => e.type === tipo);
const schematico = (cj: unknown[]) => (cj as El[]).filter((e) => e.type.startsWith("schematic_"));
const spans = (s: CompileSummary) => s.profile.spans.map((x) => x.name);
/** what the checks say, without the timings */
const controlli = (s: CompileSummary) => {
  const resto: Partial<CompileSummary> = { ...s };
  delete resto.profile;
  delete resto.schematicCostMs;
  return norm(resto);
};

describe("colate e controlli una volta sola per compilazione", () => {
  beforeEach(() => {
    conta.ricolate = 0;
  });

  it("con la scheda salvata prima dello schematico le colate si ricolano una volta, non due", async () => {
    let anticipata: { circuitJson: unknown[]; summary: CompileSummary } | null = null;
    const r = await compileProject({ "main.tsx": SCHEDA }, { onBoard: async (e) => void (anticipata = e) });
    expect(anticipata).not.toBeNull();
    expect(conta.ricolate).toBe(1);
    // the final board is the complete one, as before
    expect(diTipo(r.circuitJson, "schematic_component")).toHaveLength(2);
    expect(diTipo(r.circuitJson, "pcb_copper_pour").length).toBeGreaterThan(0);
    expect(r.summary.schematicPending).toBeUndefined();
    expect(r.summary.schematicKey).toBeTruthy();
    expect(r.summary.schematicQuality.sections.length).toBe(2);
    // the timings of both parts, and no second pour
    expect(spans(r.summary)).toEqual(
      expect.arrayContaining([
        "scheda senza schematico (tscircuit)",
        "rame, colate e controlli della scheda senza schematico",
        "scheda con schematico (tscircuit)",
        "schematico sulla scheda gia' calcolata e suoi controlli",
      ]),
    );
    expect(spans(r.summary)).not.toContain("rame, colate e controlli");
    expect(r.summary.schematicCostMs).toBeGreaterThanOrEqual(0);
  }, 180_000);

  it("rame, colate, pasta e controlli sono quelli di una compilazione in un passo solo", async () => {
    // one pass, no early board: the board computed from the reading with the schematic, as every compile did
    const unPasso = await compileProject({ "main.tsx": SCHEDA });
    expect(conta.ricolate).toBe(1);
    const dueParti = await compileProject({ "main.tsx": SCHEDA }, { onBoard: async () => {} });
    expect(conta.ricolate).toBe(2);
    for (const tipo of ["pcb_trace", "pcb_via", "pcb_copper_pour", "pcb_solder_paste", "pcb_smtpad", "pcb_component"]) {
      expect(norm(diTipo(dueParti.circuitJson, tipo)), tipo).toBe(norm(diTipo(unPasso.circuitJson, tipo)));
    }
    // the whole circuit, element by element and in the same order
    expect(norm(dueParti.circuitJson)).toBe(norm(unPasso.circuitJson));
    expect(norm(schematico(dueParti.circuitJson))).toBe(norm(schematico(unPasso.circuitJson)));
    // every check and every number of the summary
    expect(controlli(dueParti.summary)).toBe(controlli(unPasso.summary));
  }, 240_000);

  it("se le due letture della scheda non coincidono, l'innesto rinuncia e la scheda si ricalcola", () => {
    const src = [{ type: "source_component", source_component_id: "s1", name: "R1" }];
    const pcb = [...src, { type: "pcb_board", width: 10 }];
    const sch = { type: "schematic_component", schematic_component_id: "sc1", source_component_id: "s1" };
    const calcolata = [...pcb, { type: "pcb_copper_pour", pcb_copper_pour_id: "p0" }];
    // same board: the schematic goes where it sits in the reading with the schematic
    expect(innestaSchematico(calcolata, pcb, [src[0], sch, pcb[1]])?.map((e) => e.type)).toEqual([
      "source_component",
      "schematic_component",
      "pcb_board",
      "pcb_copper_pour",
    ]);
    // another board (a different width): no
    expect(innestaSchematico(calcolata, pcb, [src[0], sch, { type: "pcb_board", width: 12 }])).toBeNull();
    // other parts: no
    expect(innestaSchematico(calcolata, pcb, [{ ...src[0], name: "R9" }, sch, pcb[1]])).toBeNull();
    // the same elements in another order after the schematic: yes
    const due = [...pcb, { type: "source_no_ground_pin_defined_warning", message: "<chip#12(.U1)> no ground" }];
    const lettura = [src[0], sch, { ...due[2], message: "<chip#40(.U1)> no ground" }, pcb[1]];
    expect(innestaSchematico(due, due, lettura)).not.toBeNull();
  });
});

describe("lo schematico parte solo se fa in tempo", () => {
  it("senza il tempo per lo schematico la compilazione chiude con la scheda e dice perche'", async () => {
    let chiamata = false;
    const steps: string[] = [];
    const r = await compileProject(
      { "main.tsx": SCHEDA },
      {
        budgetMs: 60_000,
        // the last schematic of this board cost ten minutes
        schematicFrom: { circuitJson: [], summary: { schematicCostMs: 600_000 } },
        onBoard: async () => void (chiamata = true),
        onProgress: (p) => steps.push(p.step),
      },
    );
    expect(schematico(r.circuitJson)).toHaveLength(0);
    expect(diTipo(r.circuitJson, "pcb_copper_pour").length).toBeGreaterThan(0);
    expect(r.summary.schematicPending).toMatch(/non e' partito/);
    expect(r.summary.schematicPending).toMatch(/600 s/);
    expect(r.summary.message).toMatch(/SCHEMATICO NON CALCOLATO/);
    expect(r.summary.schematicKey).toBeUndefined();
    // the measure stays for the next compile
    expect(r.summary.schematicCostMs).toBe(600_000);
    expect(spans(r.summary)).not.toContain("scheda con schematico (tscircuit)");
    expect(steps).not.toContain("Disegno lo schematico");
    // nothing is said "saved early, schematic on its way": the board is the outcome
    expect(chiamata).toBe(false);
  }, 180_000);

  it("con il tempo che basta lo schematico si disegna", async () => {
    const r = await compileProject(
      { "main.tsx": SCHEDA },
      { budgetMs: 600_000, schematicFrom: { circuitJson: [], summary: { schematicCostMs: 1_000 } }, onBoard: async () => {} },
    );
    expect(diTipo(r.circuitJson, "schematic_component")).toHaveLength(2);
    expect(r.summary.schematicPending).toBeUndefined();
  }, 180_000);

  it("la stima usa l'ultima misura con il suo margine, o la cifra prudente quando non c'e'", () => {
    expect(stimaDelloSchematico(null, 110_000).ms).toBe(110_000 + SCHEMATICO_SENZA_MISURA_MS + DOPO_LO_SCHEMATICO_MS);
    expect(stimaDelloSchematico(150_000, 110_000).ms).toBe(110_000 + 225_000 + DOPO_LO_SCHEMATICO_MS);
    expect(stimaDelloSchematico(null, 110_000).perche).toMatch(/nessuno schematico misurato/);
  });

  it("il costo dello schematico si legge dal profilo salvato, o dalla misura che il riepilogo si porta dietro", () => {
    const profilo = (spans: Array<[string, number]>) => ({ profile: { spans: spans.map(([name, ms]) => ({ name, ms, depth: 0 })), totalMs: 0 } });
    expect(costoDelloSchematico(profilo([["scheda senza schematico (tscircuit)", 110_000], ["scheda con schematico (tscircuit)", 245_000]]))).toBe(135_000);
    // no early board: the whole compile with the schematic, which is more
    expect(costoDelloSchematico(profilo([["scheda con schematico (tscircuit)", 160_000]]))).toBe(160_000);
    // a board saved without its schematic: the measure it carries
    expect(costoDelloSchematico({ ...profilo([["scheda senza schematico (tscircuit)", 110_000]]), schematicCostMs: 90_000 })).toBe(90_000);
    expect(costoDelloSchematico(profilo([["scheda senza schematico (tscircuit)", 110_000]]))).toBeNull();
    expect(costoDelloSchematico(null)).toBeNull();
  });
});

describe("la chiave dello schematico non cambia quando cambia solo il rame", () => {
  const k = schematicKeyOf({ "main.tsx": SCHEDA });
  const con = (da: string, a: string) => {
    expect(SCHEDA.includes(da), da).toBe(true);
    return schematicKeyOf({ "main.tsx": SCHEDA.replace(da, a) });
  };

  it("stessa chiave se cambia il percorso di una pista, una via, una colata, una posizione o una serigrafia", () => {
    expect(con("{ x: 12, y: -3 }, { x: 12, y: 0 }", "{ x: 11, y: -4 }, { x: 12, y: 0 }")).toBe(k);
    expect(con('thickness="0.25mm"', 'thickness="0.3mm"')).toBe(k);
    expect(con("<trace from=\".R1 > .pin2\" to=\"net.GND\" />", "<trace from=\".R1 > .pin2\" to=\"net.GND\" pcbPath={[{ x: 1, y: 1 }]} />")).toBe(k);
    expect(con("    <via pcbX={-6}", "    <via pcbX={2} pcbY={4} connectsTo=\"net.GND\" />\n    <via pcbX={-6}")).toBe(k);
    expect(con("    <via pcbX={-6} pcbY={3} fromLayer=\"top\" toLayer=\"bottom\" outerDiameter=\"0.6mm\" holeDiameter=\"0.3mm\" connectsTo=\"net.SIG\" />\n", "")).toBe(k);
    expect(con("{x: 0.5, y: -5}, {x: 11, y: -5}", "{x: 0.7, y: -5}, {x: 11, y: -5}")).toBe(k);
    expect(con("  </board>", '    <copperpour layer="inner1" connectsTo="net.GND" outline={[{x: 0, y: 0}, {x: 1, y: 0}, {x: 1, y: 1}]} />\n  </board>')).toBe(k);
    expect(con('pcbX={-6} pcbY={0} schSectionName="ingresso"', 'pcbX={-7.5} pcbY={1} pcbRotation={90} layer="bottom" schSectionName="ingresso"')).toBe(k);
    expect(con('pcbX={6} pcbY={0} schSectionName="uscita"', 'schSectionName="uscita"')).toBe(k);
    expect(con("  </board>", '    <silkscreentext text="SBB" pcbX={0} pcbY={5} />\n    <keepout shape="rect" width={1} height={1} pcbX={0} pcbY={0} />\n    <hole pcbX={9} pcbY={4} diameter="1mm" />\n  </board>')).toBe(k);
  });

  it("chiave diversa se cambia un collegamento, un valore, un attributo sch, un pinLabels o un pezzo", () => {
    expect(con('to="net.SIG" />', 'to="net.GND" />')).not.toBe(k);
    expect(con('<trace from=".R1 > .pin2" to="net.GND" />', "")).not.toBe(k);
    expect(con('name="R2" resistance="1k"', 'name="R2" resistance="4.7k"')).not.toBe(k);
    expect(con('schSectionName="uscita"', 'schSectionName="carico"')).not.toBe(k);
    expect(con('schSectionName="uscita"', 'schSectionName="uscita" schRotation={90}')).not.toBe(k);
    expect(con("  </board>", '    <chip name="U1" footprint="soic8" pinLabels={{ pin1: "VCC" }} pcbX={0} pcbY={4} />\n  </board>')).not.toBe(k);
    const conChip = SCHEDA.replace("  </board>", '    <chip name="U1" footprint="soic8" pinLabels={{ pin1: "VCC" }} />\n  </board>');
    expect(schematicKeyOf({ "main.tsx": conChip.replace('pin1: "VCC"', 'pin1: "VDD"') })).not.toBe(schematicKeyOf({ "main.tsx": conChip }));
    // a file that is not code stays in the key as it is
    expect(schematicKeyOf({ "main.tsx": SCHEDA, "dati.json": "{\"x\":1}" })).not.toBe(schematicKeyOf({ "main.tsx": SCHEDA, "dati.json": "{\"x\":2}" }));
  });

  it("toglie solo quello che e' scritto come JSX: una via dentro un commento o una stringa resta", () => {
    expect(soloCioCheLeggeLoSchematico('<board>\n  <via pcbX={1} />\n  <R a="1" pcbX={2} />\n</board>')).toBe('<board>\n  <R a="1" />\n</board>');
    const commento = "// <via pcbX={1} />\nconst s = \"<via pcbX={1} />\"\n";
    expect(soloCioCheLeggeLoSchematico(commento)).toBe(commento);
  });
});

describe("una via in piu' non fa ridisegnare lo schematico", () => {
  it("l'innesto ignora le porte delle vie e guarda quelle dei pezzi", () => {
    const prima = [
      { type: "source_component", source_component_id: "s1", name: "R1" },
      { type: "source_port", source_port_id: "source_port_0", name: "pin1", source_component_id: "s1" },
      { type: "schematic_component", schematic_component_id: "x" },
    ];
    const conVia = [
      prima[0],
      prima[1],
      { type: "source_manually_placed_via", source_manually_placed_via_id: "v0" },
      { type: "source_port", source_port_id: "source_port_1", name: "top", source_component_id: "v0" },
      { type: "pcb_board" },
    ];
    expect(graftSchematic(conVia as never, prima)).not.toBeNull();
    const altraPorta = [prima[0], { ...prima[1], name: "pin2" }, { type: "pcb_board" }];
    expect(graftSchematic(altraPorta as never, prima)).toBeNull();
  });

  it("dopo una via e una colata aggiunte lo schematico salvato si riusa", async () => {
    const prima = await compileProject({ "main.tsx": SCHEDA });
    const dopoFile = SCHEDA.replace(
      "  </board>",
      `    <via pcbX={6} pcbY={3} fromLayer="top" toLayer="bottom" outerDiameter="0.6mm" holeDiameter="0.3mm" connectsTo="net.SIG" />\n    <copperpour layer="bottom" connectsTo="net.GND" outline={[{x: -11, y: -5}, {x: -0.5, y: -5}, {x: -0.5, y: 5}, {x: -11, y: 5}]} />\n  </board>`,
    );
    const dopo = await compileProject(
      { "main.tsx": dopoFile },
      { schematicFrom: { circuitJson: prima.circuitJson, summary: prima.summary }, onBoard: async () => {} },
    );
    expect(dopo.summary.message).toMatch(/schematico invariato/);
    expect(spans(dopo.summary)).not.toContain("scheda con schematico (tscircuit)");
    expect(diTipo(dopo.circuitJson, "pcb_via")).toHaveLength(2);
    expect(norm(schematico(dopo.circuitJson))).toBe(norm(schematico(prima.circuitJson)));
  }, 240_000);
});
