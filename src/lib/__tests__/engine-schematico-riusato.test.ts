import { describe, expect, it } from "vitest";
import { compileProject, graftSchematic, schematicKeyOf } from "@/lib/compile";
import { emptyManualEdits, MANUAL_EDITS_PATH, serializeManualEdits } from "@/lib/manual-edits";

/*
 * sbb-dl-principale (155 parts), 2026-11-09: every "Aggiorna" after a move
 * drew the schematic again, 2:09 on "Disegno lo schematico" with the PCB
 * locked. Moving, turning or flipping parts on the board does not change a
 * wire of the schematic: when nothing else changed, the schematic of the
 * last board is taken as it is.
 */

const MAIN = `export default () => (
  <board width="20mm" height="10mm" routingDisabled>
    <resistor name="R1" resistance="1k" footprint="0402" pcbX={-4} pcbY={0} schSectionName="a" />
    <resistor name="R2" resistance="1k" footprint="0402" pcbX={4} pcbY={0} schSectionName="b" />
    <trace from=".R1 > .pin2" to=".R2 > .pin1" />
  </board>
)
`;

type El = Record<string, unknown> & { type: string };
const schematic = (cj: unknown[]) => JSON.stringify((cj as El[]).filter((e) => e.type.startsWith("schematic_")));
const centerOf = (cj: unknown[], name: string) => {
  const els = cj as El[];
  const src = els.find((e) => e.type === "source_component" && e.name === name)!;
  return (els.find((e) => e.type === "pcb_component" && e.source_component_id === src.source_component_id)!.center as { x: number }).x;
};
const withMoves = (pcb: Array<{ selector: string; center: { x: number; y: number }; rotation?: number }>, sch: Array<{ selector: string; center: { x: number; y: number } }> = []) =>
  serializeManualEdits({ ...emptyManualEdits(), pcb_placements: pcb, schematic_placements: sch });

describe("lo schematico si riusa quando sono cambiate solo le posizioni sul PCB", () => {
  it("la chiave non cambia con posizioni, rotazioni e facce sul PCB, cambia con il codice e con lo schematico a mano", () => {
    const base = { "main.tsx": MAIN };
    const k = schematicKeyOf(base);
    expect(schematicKeyOf({ ...base, [MANUAL_EDITS_PATH]: withMoves([{ selector: "R1", center: { x: 2, y: 1 }, rotation: 90 }]) })).toBe(k);
    expect(schematicKeyOf({ "main.tsx": MAIN.replace('resistance="1k" footprint="0402" pcbX={4}', 'resistance="2k" footprint="0402" pcbX={4}') })).not.toBe(k);
    expect(schematicKeyOf({ ...base, [MANUAL_EDITS_PATH]: withMoves([], [{ selector: "R1", center: { x: 3, y: 3 } }]) })).not.toBe(k);
  });

  it("dopo uno spostamento la scheda e' quella nuova e lo schematico e' quello di prima, senza ridisegnarlo", async () => {
    const prima = await compileProject({ "main.tsx": MAIN }, { route: false });
    expect(prima.summary.schematicKey).toBeTruthy();
    const steps: string[] = [];
    const dopo = await compileProject(
      { "main.tsx": MAIN, [MANUAL_EDITS_PATH]: withMoves([{ selector: "R1", center: { x: -6, y: 0 } }]) },
      {
        route: false,
        schematicFrom: { circuitJson: prima.circuitJson, summary: prima.summary },
        onProgress: (p) => steps.push(p.step),
      },
    );
    expect(dopo.summary.profile.spans.map((s) => s.name)).not.toContain("scheda con schematico (tscircuit)");
    expect(steps).not.toContain("Disegno lo schematico");
    expect(dopo.summary.message).toMatch(/schematico invariato/);
    expect(centerOf(dopo.circuitJson, "R1")).toBeCloseTo(-6, 3);
    expect(schematic(dopo.circuitJson)).toBe(schematic(prima.circuitJson));
    expect(dopo.summary.schematicKey).toBe(prima.summary.schematicKey);
  }, 120_000);

  it("se cambia il codice lo schematico si ridisegna", async () => {
    const prima = await compileProject({ "main.tsx": MAIN }, { route: false });
    const altro = MAIN.replace("<trace", '<resistor name="R3" resistance="1k" footprint="0402" pcbX={0} pcbY={3} schSectionName="a" />\n    <trace');
    const dopo = await compileProject({ "main.tsx": altro }, { route: false, schematicFrom: { circuitJson: prima.circuitJson, summary: prima.summary } });
    expect(dopo.summary.profile.spans.map((s) => s.name)).toContain("scheda con schematico (tscircuit)");
    expect((dopo.circuitJson as El[]).filter((e) => e.type === "schematic_component")).toHaveLength(3);
  }, 120_000);

  it("l'innesto rifiuta uno schematico di altri pezzi", () => {
    const a = [{ type: "source_component", source_component_id: "s1", name: "R1" }, { type: "schematic_component", schematic_component_id: "x" }];
    const b = [{ type: "source_component", source_component_id: "s1", name: "R9" }, { type: "pcb_board" }];
    expect(graftSchematic(b as never, a)).toBeNull();
    const c = [{ type: "source_component", source_component_id: "s1", name: "R1" }, { type: "pcb_board" }];
    expect(graftSchematic(c as never, a)?.map((e) => e.type)).toEqual(["source_component", "pcb_board", "schematic_component"]);
  });
});
