import { describe, expect, it } from "vitest";
import { compileProject } from "@/lib/compile";
import { DESIGN_RULES_PATH, resolveDesignRules } from "@/lib/design-rules";

// due resistenze da collegare e nessuna pista: con l'autorouter acceso il compile prova a instradarle
const MAIN = `export default () => (
  <board width="20mm" height="10mm">
    <resistor name="R1" resistance="1k" footprint="0402" pcbX={-4} pcbY={0} />
    <resistor name="R2" resistance="1k" footprint="0402" pcbX={4} pcbY={0} />
    <trace from=".R1 > .pin2" to=".R2 > .pin1" />
  </board>
)
`;
const regole = (autoroute: boolean) =>
  JSON.stringify({ preset: "custom", rules: { minTraceWidthMm: 0.15, minClearanceMm: 0.15, autoroute } });

describe("autoroute: false, il compile non lancia l'autorouter", () => {
  it("la regola si legge dal file del progetto", () => {
    expect(resolveDesignRules({ [DESIGN_RULES_PATH]: regole(false) }).rules.autoroute).toBe(false);
    expect(resolveDesignRules({ [DESIGN_RULES_PATH]: regole(true) }).rules.autoroute).toBe(true);
  });

  it("con autoroute false si compila una volta sola, senza instradare e senza errore di sbroglio", async () => {
    const { summary, circuitJson } = await compileProject({ "main.tsx": MAIN, [DESIGN_RULES_PATH]: regole(false) });
    const s = summary as { message?: string; routingAttempts?: number };
    expect(s.message).toMatch(/rame non toccato/);
    expect(s.routingAttempts).toBe(1);
    expect(circuitJson.some((e) => (e as { type: string }).type === "pcb_autorouting_error")).toBe(false);
  }, 120_000);

  it("senza la regola l'instradamento parte come sempre", async () => {
    const { summary } = await compileProject({ "main.tsx": MAIN, [DESIGN_RULES_PATH]: regole(true) });
    expect((summary as { message?: string }).message ?? "").not.toMatch(/rame non toccato/);
  }, 300_000);
});
