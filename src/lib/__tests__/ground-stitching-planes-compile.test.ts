import { describe, expect, it } from "vitest";
import { compileProject, type CompileSummary } from "@/lib/compile";
import { DESIGN_RULES_PATH } from "@/lib/design-rules";
import { FILE_CUCITURA, vieDelFile } from "@/lib/ground-stitching-file";
import { eseguiCucitura, statoDellaScheda } from "@/lib/ground-stitching-tool";
import { filesHash } from "@/lib/project-store";

/*
 * sbb-dongle in piccolo, compilato davvero: massa su top, inner1 e bottom, il
 * piano P3V3 pieno su inner2 con due vie della sua rete. Lo strumento propone
 * vie che attraversano il piano, le scrive, e la compilazione ricola il piano
 * aprendolo attorno a ognuna: il piano resta un pezzo solo, con le sue due vie
 * dentro, e i controlli della compilazione dicono quello che dicevano prima.
 */
const MAIN = (uso: boolean) => `${uso ? 'import { CucituraMassa } from "./cucitura-massa"\n' : ""}export default () => (
  <board width="20mm" height="14mm" layers={4}>
    <net name="GND" />
    <net name="P3V3" />
    <copperpour layer="top" connectsTo="net.GND" />
    <copperpour layer="inner1" connectsTo="net.GND" />
    <copperpour layer="inner2" connectsTo="net.P3V3" />
    <copperpour layer="bottom" connectsTo="net.GND" />
    <resistor name="R1" resistance="1k" footprint="0402" pcbX={-5} pcbY={0} />
    <resistor name="R2" resistance="1k" footprint="0402" pcbX={5} pcbY={0} />
    <trace from=".R1 > .pin1" to="net.GND" />
    <trace from=".R2 > .pin2" to="net.GND" />
    <trace from=".R1 > .pin2" to="net.P3V3" />
    <trace from=".R2 > .pin1" to="net.P3V3" />
    <via name="VP1" pcbX={-4} pcbY={2} connectsTo="net.P3V3" fromLayer="top" toLayer="bottom" />
    <via name="VP2" pcbX={4} pcbY={-2} connectsTo="net.P3V3" fromLayer="top" toLayer="bottom" />
    <via name="V1" pcbX={-8} pcbY={-5} connectsTo="net.GND" fromLayer="top" toLayer="bottom" />
    ${uso ? "<CucituraMassa />" : ""}
  </board>
)
`;
const REGOLE = JSON.stringify({
  preset: "custom",
  rules: { minTraceWidthMm: 0.127, minClearanceMm: 0.152, minViaHoleMm: 0.15, minViaDiameterMm: 0.45, pourClearanceMm: 0.2, autoPlaneVias: false, autoroute: false },
});
/** what the re-pour opens around the centre of a stitching via: half the ring (0.5) plus the pour clearance (0.2) */
const APERTURA = 0.45;

type El = Record<string, unknown>;
type P = { x: number; y: number };
type Forma = { outer_ring: { vertices: P[] }; inner_rings?: Array<{ vertices: P[] }> };
const dentro = (x: number, y: number, a: P[]) => {
  let d = false;
  for (let i = 0, j = a.length - 1; i < a.length; j = i++) if (a[i].y > y !== a[j].y > y && x < ((a[j].x - a[i].x) * (y - a[i].y)) / (a[j].y - a[i].y) + a[i].x) d = !d;
  return d;
};
const nelRame = (c: El, x: number, y: number) => {
  const b = c.brep_shape as Forma;
  return dentro(x, y, b.outer_ring.vertices) && !(b.inner_rings ?? []).some((h) => dentro(x, y, h.vertices));
};

/** every check of a compile, as what it says and not where */
const controlli = (s: CompileSummary) => ({
  errori: s.errors.map((e) => `${e.type}: ${e.message}`).sort(),
  drc: s.drcViolations.map((d) => `${d.rule}:${d.count ?? 1}`).sort(),
  prc: s.prcViolations.map((p) => `${p.rule}: ${p.message}`).sort(),
  erc: s.erc.counts,
  classe: s.fabClass,
  serigrafia: s.silkscreen ? { ...s.silkscreen.perTipo, nonMisurata: s.silkscreen.nonMisurata ?? null } : null,
  ingombri: s.targets.courtyardCollisions,
  colateVicine: s.poursTooClose ?? null,
  pianiSopraLeVie: s.planesOverVias ?? null,
  colateSopraIlRame: s.poursOverCopper ?? null,
  aperte: s.unroutedTotal ?? s.unroutedConnections.length,
});

describe("cucitura-massa.tsx attraverso il piano di un'altra rete, compilato", () => {
  it("le vie proposte attraversano il piano P3V3 di inner2; la compilazione lo apre attorno a ognuna, resta un pezzo solo con le sue vie, e nessun controllo cambia", async () => {
    const files: Record<string, string> = { "main.tsx": MAIN(false), [DESIGN_RULES_PATH]: REGOLE };
    const prima = await compileProject(files);
    const chiama = (args: Record<string, unknown>) =>
      eseguiCucitura({
        files,
        args,
        cache: { circuitJson: prima.circuitJson as unknown[] },
        scheda: statoDellaScheda(filesHash({ "main.tsx": MAIN(false), [DESIGN_RULES_PATH]: REGOLE }), files, filesHash),
        scrivi: async (path, content) => {
          files[path] = content;
        },
      });
    const piano = (cj: unknown[]) => (cj as El[]).filter((e) => e.type === "pcb_copper_pour" && e.layer === "inner2");
    expect(piano(prima.circuitJson as unknown[])).toHaveLength(1);

    // the look: vias proposed, every one through the plane, and the answer says so
    const visto = await chiama({ passoMm: 3 });
    const proposte = visto.result.vie as number;
    expect(proposte).toBeGreaterThan(8);
    expect(visto.result).toMatchObject({ ok: true, scrivibile: true, pianiAttraversati: { vie: proposte, piani: [{ rete: "P3V3", strato: "inner2", vie: proposte }] } });
    const scrive = await chiama({ passoMm: 3, apply: true, impronta: visto.result.impronta });
    expect(scrive.result).toMatchObject({ ok: true, scritto: true });
    const scritte = vieDelFile(files[FILE_CUCITURA]);
    expect(scritte).toHaveLength(proposte);

    // the two lines in main.tsx, and the compile
    files["main.tsx"] = MAIN(true);
    const dopo = await compileProject(files);
    const els = dopo.circuitJson as El[];
    const gnd = els.find((e) => e.type === "source_net" && e.name === "GND")!;
    const vie = els.filter((e) => e.type === "pcb_via" && e.subcircuit_connectivity_map_key === gnd.subcircuit_connectivity_map_key && !(e.x === -8 && e.y === -5));
    expect(vie).toHaveLength(proposte);

    // the plane: still one piece, open around every stitching via by the ring plus its clearance, and holding both vias of its net
    const piani = piano(els);
    expect(piani).toHaveLength(1);
    for (const v of vie) {
      for (let k = 0; k < 16; k++) {
        const a = (k * Math.PI) / 8;
        expect(nelRame(piani[0], Number(v.x) + (APERTURA - 0.01) * Math.cos(a), Number(v.y) + (APERTURA - 0.01) * Math.sin(a)), `${v.x},${v.y}`).toBe(false);
      }
    }
    expect(nelRame(piani[0], -4, 2)).toBe(true);
    expect(nelRame(piani[0], 4, -2)).toBe(true);

    // every check of the compile says what it said before the vias
    expect(controlli(dopo.summary)).toEqual(controlli(prima.summary));
    expect(dopo.summary.planesOverVias).toBeUndefined();
    expect(dopo.summary.poursOverCopper).toBeUndefined();
  }, 240_000);
});
