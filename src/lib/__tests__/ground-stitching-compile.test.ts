import { describe, expect, it } from "vitest";
import { compileProject } from "@/lib/compile";
import { DESIGN_RULES_PATH } from "@/lib/design-rules";
import { FILE_CUCITURA } from "@/lib/ground-stitching-file";
import { eseguiCucitura } from "@/lib/ground-stitching-tool";

/*
 * Il file che lo strumento scrive, compilato davvero da tscircuit: le vie
 * escono con la rete di massa, il foro e la corona scritti, passanti, la massa
 * non si apre attorno a loro e i controlli non trovano niente di nuovo.
 */
const MAIN = (conCucitura: boolean) => `${conCucitura ? 'import { CucituraMassa } from "./cucitura-massa"\n' : ""}export default () => (
  <board width="20mm" height="14mm" layers={4}>
    <net name="GND" />
    <net name="SIG" />
    <copperpour layer="top" connectsTo="net.GND" />
    <copperpour layer="inner1" connectsTo="net.GND" />
    <copperpour layer="inner2" connectsTo="net.GND" />
    <copperpour layer="bottom" connectsTo="net.GND" />
    <resistor name="R1" resistance="1k" footprint="0402" pcbX={-5} pcbY={0} />
    <resistor name="R2" resistance="1k" footprint="0402" pcbX={5} pcbY={0} />
    <trace from=".R1 > .pin1" to="net.GND" />
    <trace from=".R2 > .pin2" to="net.GND" />
    <trace from=".R1 > .pin2" to=".R2 > .pin1" pcbPath={[{ x: -4.49, y: 0 }, { x: 4.49, y: 0 }]} />
    <via name="V1" pcbX={-8} pcbY={-5} connectsTo="net.GND" fromLayer="top" toLayer="bottom" />
    ${conCucitura ? "<CucituraMassa />" : ""}
  </board>
)
`;
const REGOLE = JSON.stringify({
  preset: "custom",
  rules: { minTraceWidthMm: 0.127, minClearanceMm: 0.152, minViaHoleMm: 0.15, minViaDiameterMm: 0.45, pourClearanceMm: 0.2, autoPlaneVias: false, autoroute: false },
});

type El = Record<string, unknown>;
type P = { x: number; y: number };
const dentro = (x: number, y: number, a: P[]) => {
  let d = false;
  for (let i = 0, j = a.length - 1; i < a.length; j = i++) if (a[i].y > y !== a[j].y > y && x < ((a[j].x - a[i].x) * (y - a[i].y)) / (a[j].y - a[i].y) + a[i].x) d = !d;
  return d;
};

describe("cucitura-massa.tsx compilato", () => {
  it("vie della rete di massa, passanti, foro e corona scritti, massa intera attorno, nessun controllo nuovo", async () => {
    const prima = await compileProject({ "main.tsx": MAIN(false), [DESIGN_RULES_PATH]: REGOLE });
    const files: Record<string, string> = { "main.tsx": MAIN(true), [DESIGN_RULES_PATH]: REGOLE };
    const esito = await eseguiCucitura({
      files,
      args: { apply: true, passoMm: 3 },
      cache: { circuitJson: prima.circuitJson as unknown[] },
      scheda: "senza_la_cucitura",
      scrivi: async (path, content) => {
        files[path] = content;
      },
    });
    expect(esito.result).toMatchObject({ ok: true, scritto: true, main: { usaIlFile: true } });
    const proposte = esito.result.vie as number;
    expect(proposte).toBeGreaterThan(3);

    const dopo = await compileProject(files);
    const els = dopo.circuitJson as El[];
    const gnd = els.find((e) => e.type === "source_net" && e.name === "GND")!;
    // every via but V1, the one main.tsx draws itself
    const vie = els.filter((e) => e.type === "pcb_via" && !(e.x === -8 && e.y === -5));
    expect(vie).toHaveLength(proposte);
    for (const v of vie) {
      expect(v.outer_diameter).toBe(0.5);
      expect(v.subcircuit_connectivity_map_key).toBe(gnd.subcircuit_connectivity_map_key);
      expect(v.layers).toEqual(["top", "inner1", "inner2", "bottom"]);
    }
    // the ground pours hold every new via whole, on every layer
    const colate = els.filter((e) => e.type === "pcb_copper_pour" && e.source_net_id === gnd.source_net_id);
    for (const v of vie) {
      for (const layer of ["top", "inner1", "inner2", "bottom"]) {
        const giro = Array.from({ length: 16 }, (_, i) => ({ x: Number(v.x) + 0.249 * Math.cos((i * Math.PI) / 8), y: Number(v.y) + 0.249 * Math.sin((i * Math.PI) / 8) }));
        const coperto = giro.every((q) =>
          colate.some((c) => {
            const b = c.brep_shape as { outer_ring: { vertices: P[] }; inner_rings?: Array<{ vertices: P[] }> };
            return c.layer === layer && dentro(q.x, q.y, b.outer_ring.vertices) && !(b.inner_rings ?? []).some((h) => dentro(q.x, q.y, h.vertices));
          }),
        );
        expect(coperto, `${layer} ${v.x},${v.y}`).toBe(true);
      }
    }
    expect(dopo.summary.drcViolations.map((d) => d.rule).sort()).toEqual(prima.summary.drcViolations.map((d) => d.rule).sort());
    expect(dopo.summary.errors).toEqual(prima.summary.errors);
    expect(files[FILE_CUCITURA]).toMatch(/connectsTo="net.GND"/);
  }, 180_000);
});
