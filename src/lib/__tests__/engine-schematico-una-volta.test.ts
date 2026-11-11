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
  innestaSchematico,
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
  const { profile: _profile, ...resto } = s;
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

