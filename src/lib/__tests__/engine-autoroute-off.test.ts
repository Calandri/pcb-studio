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

  /*
   * 2026-11-09, "togli ogni AUTO": nessun compile instrada piu', qualunque cosa
   * dica il progetto e chiunque lo chiami (MCP, agente, pulsante).
   */
  it("anche con autoroute true il compile non instrada e non piazza", async () => {
    const { summary, circuitJson } = await compileProject(
      { "main.tsx": MAIN, [DESIGN_RULES_PATH]: regole(true) },
      { route: true, place: true },
    );
    expect((summary as { message?: string }).message ?? "").toMatch(/rame non toccato/);
    expect(circuitJson.filter((e) => (e as { type: string }).type === "pcb_trace")).toHaveLength(0);
    // R1 resta dove e' scritto: nessun piazzatore l'ha spostato
    const r1 = circuitJson.find(
      (e) => (e as { type: string }).type === "pcb_component" && (e as { center: { x: number } }).center.x < 0,
    ) as { center: { x: number; y: number } } | undefined;
    expect(r1?.center.x).toBeCloseTo(-4, 6);
  }, 120_000);

  it("nemmeno un preset del board che tscircuit instraderebbe da solo", async () => {
    const main = MAIN.replace('<board width="20mm" height="10mm">', '<board width="20mm" height="10mm" autorouter="sequential-trace">');
    const { circuitJson } = await compileProject({ "main.tsx": main });
    expect(circuitJson.filter((e) => (e as { type: string }).type === "pcb_trace")).toHaveLength(0);
  }, 120_000);

  it("la pista disegnata a mano (pcbPath) resta dov'e'", async () => {
    const main = MAIN.replace(
      '<trace from=".R1 > .pin2" to=".R2 > .pin1" />',
      '<trace from=".R1 > .pin2" to=".R2 > .pin1" pcbPath={[{ x: 0, y: 1 }]} />',
    );
    const { circuitJson } = await compileProject({ "main.tsx": main });
    const piste = circuitJson.filter((e) => (e as { type: string }).type === "pcb_trace") as Array<{
      route: Array<{ x: number; y: number }>;
    }>;
    // one trace, exactly the drawn path (pcbPath is relative to the first part: R1 at -4)
    expect(piste).toHaveLength(1);
    expect(piste[0].route.map((p) => [p.x, p.y])).toEqual([
      [-3.49, 0],
      [-4, 1],
      [3.49, 0],
    ]);
  }, 120_000);
});

/*
 * sbb-dl-frontale: due pad sovrapposti mentre si piazza (normale) e tscircuit
 * scriveva "Autorouting was skipped": sembrava uno sbroglio fallito e la scheda
 * nuova non veniva salvata, a schermo restava la vecchia (2026-11-09).
 */
describe("pad sovrapposti mentre si piazza", () => {
  it("la scheda esce lo stesso, con le sovrapposizioni come errori e senza 'sbroglio saltato'", async () => {
    const main = `export default () => (<board width="20mm" height="10mm">
      <capacitor name="C20" capacitance="100nF" footprint="0402" pcbX={0} pcbY={0} />
      <diode name="D13" footprint="0402" pcbX={0.9} pcbY={0} />
      <trace from=".C20 > .pin2" to=".D13 > .pin2" />
    </board>)`;
    const { summary, circuitJson } = await compileProject({ "main.tsx": main });
    const tipi = ((summary as { errors?: Array<{ type?: string }> }).errors ?? []).map((e) => e.type);
    expect(circuitJson.some((e) => (e as { type: string }).type === "pcb_board")).toBe(true);
    expect(tipi).toContain("pcb_footprint_overlap_error");
    expect(tipi).not.toContain("pcb_autorouting_error");
    expect(tipi).not.toContain("root_cause_first");
  }, 120_000);
});
