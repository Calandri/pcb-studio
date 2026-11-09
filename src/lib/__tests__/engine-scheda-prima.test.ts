import { describe, expect, it } from "vitest";
import { compileGeometryOnly, compileProject, type CompileSummary } from "@/lib/compile";

/*
 * fototrappola-frontale (217 parts, 827 connections): a local compile takes 184
 * s, 180 of them in tscircuit's schematic trace solver; the board alone takes 5.
 * On Vercel the whole thing did not fit in the function's 800 s, so nothing was
 * ever saved and the "Sbroglio" tab had nothing to draw. The board is handed to
 * whoever saves it BEFORE the schematic is drawn, and without routing.
 */

const MAIN = `export default () => (
  <board width="20mm" height="10mm" routingDisabled>
    <resistor name="R1" resistance="1k" footprint="0402" pcbX={-4} pcbY={0} schSectionName="a" />
    <resistor name="R2" resistance="1k" footprint="0402" pcbX={4} pcbY={0} schSectionName="b" />
    <trace from=".R1 > .pin2" to=".R2 > .pin1" />
  </board>
)
`;

type El = { type: string };
const count = (cj: unknown[], prefix: string) => (cj as El[]).filter((e) => e.type.startsWith(prefix)).length;

describe("la scheda prima dello schematico", () => {
  it("senza schematico la geometria ha la scheda e nessun elemento di schematico", async () => {
    const cj = await compileGeometryOnly({ "main.tsx": MAIN }, { schematic: false });
    expect(count(cj, "pcb_board")).toBe(1);
    expect(count(cj, "pcb_component")).toBe(2);
    expect(count(cj, "schematic_")).toBe(0);
  }, 120_000);

  it("onBoard riceve la scheda senza schematico prima del risultato completo, e nessuno instrada", async () => {
    const order: string[] = [];
    let early: { circuitJson: unknown[]; summary: CompileSummary } | null = null;
    const result = await compileProject(
      { "main.tsx": MAIN },
      {
        onBoard: async (e) => {
          order.push("scheda");
          early = e;
        },
        onProgress: (p) => {
          if (p.step === "Disegno lo schematico") order.push("schematico");
        },
      },
    );
    order.push("fine");
    expect(order).toEqual(["scheda", "schematico", "fine"]);

    expect(early).not.toBeNull();
    const e = early as unknown as { circuitJson: unknown[]; summary: CompileSummary };
    expect(count(e.circuitJson, "pcb_board")).toBe(1);
    expect(count(e.circuitJson, "schematic_component")).toBe(0);
    expect(e.summary.schematicPending).toBeTruthy();
    expect(e.summary.unroutedTotal).toBe(1);

    // the final board is the complete one: schematic included, nothing pending
    expect(count(result.circuitJson, "schematic_component")).toBe(2);
    expect(result.summary.schematicPending).toBeUndefined();
    // and nobody routed: the open connection is still open, on both
    for (const cj of [e.circuitJson, result.circuitJson]) expect(count(cj, "pcb_trace")).toBe(0);
    expect(result.summary.unroutedTotal).toBe(1);
    expect(result.summary.connectionGroups).toBe(1);
  }, 120_000);

  it("senza onBoard la compilazione e' quella di sempre, in un passo solo", async () => {
    const steps: string[] = [];
    const result = await compileProject({ "main.tsx": MAIN }, { onProgress: (p) => steps.push(p.step) });
    expect(steps).not.toContain("Scheda pronta");
    expect(count(result.circuitJson, "schematic_component")).toBe(2);
  }, 120_000);
});

describe("dove va il tempo della compilazione", () => {
  it("il riepilogo divide la scheda dallo schematico", async () => {
    const result = await compileProject({ "main.tsx": MAIN }, { onBoard: async () => {} });
    const names = result.summary.profile.spans.map((s) => s.name);
    expect(names).toContain("scheda senza schematico (tscircuit)");
    expect(names).toContain("scheda con schematico (tscircuit)");
    expect(result.summary.profile.totalMs).toBeGreaterThan(0);
  }, 120_000);
});
