import { describe, expect, it } from "vitest";
import { compileProject, type CompileSummary } from "@/lib/compile";
import { DESIGN_RULES_PATH } from "@/lib/design-rules";
import { FILE_CUCITURA, vieDelFile } from "@/lib/ground-stitching-file";
import { eseguiCucitura, statoDellaScheda } from "@/lib/ground-stitching-tool";
import { filesHash } from "@/lib/project-store";

/*
 * Il file che lo strumento scrive, compilato davvero da tscircuit, nel giro che
 * fa una persona: compila, guarda l'anteprima, scrive, aggiunge le due righe a
 * main.tsx, ricompila. Le vie escono con la rete di massa, il foro e la corona
 * scritti, passanti, la massa non si apre attorno a loro, e i controlli della
 * compilazione si confrontano TUTTI, prima e dopo: DRC, errori, controlli
 * elettrici (PRC ed ERC), classi di fabbrica, serigrafia, ingombri, colate,
 * piani sopra le vie, connessioni aperte. Cambiano due cose sole, e il test le
 * dice per nome invece di non guardarle:
 *  - l'ERC conta tre "pin non collegato" per ogni <via> scritta in un file (le
 *    porte top, bottom e pin1 che tscircuit da' a ogni via: V1 di main.tsx ha
 *    gia' le sue tre prima della cucitura). E' dell'ERC, non della cucitura, ma
 *    con N vie sono 3 x N avvisi in piu';
 *  - una classe di fabbrica PIU' SEVERA delle regole del progetto puo' contare
 *    una regola in piu' (OSH Park vuole 0,38 mm dal bordo, il progetto 0,3: la
 *    fila sul bordo sta alla distanza del progetto). La classe del progetto e
 *    quella che la scheda soddisfa non cambiano.
 */
const MAIN = (uso: "" | "board" | "group") => `${uso ? 'import { CucituraMassa } from "./cucitura-massa"\n' : ""}export default () => (
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
    <silkscreentext text="MASSA" pcbX={0} pcbY={2.6} fontSize={1.2} layer="top" />
    <silkscreenpath route={[{ x: -9, y: -2.6 }, { x: 9, y: -2.6 }]} strokeWidth={0.15} layer="bottom" />
    ${uso === "board" ? "<CucituraMassa />" : uso === "group" ? "<group pcbX={1} pcbY={0.5}><CucituraMassa /></group>" : ""}
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

/** every check of a compile, as what it says and not where: the same before and after means nothing new */
const controlli = (s: CompileSummary) => ({
  errori: s.errors.map((e) => `${e.type}: ${e.message}`).sort(),
  drc: s.drcViolations.map((d) => `${d.rule}:${d.count ?? 1}`).sort(),
  prc: s.prcViolations.map((p) => `${p.rule}: ${p.message}`).sort(),
  erc: s.erc.counts,
  fabbrica: { classe: s.fabClass, classi: Object.fromEntries(s.fabClasses.map((c) => [c.key, `${c.violations}:${c.ok}`])) },
  serigrafia: s.silkscreen ? { ...s.silkscreen.perTipo, nonMisurata: s.silkscreen.nonMisurata ?? null } : null,
  ingombri: s.targets.courtyardCollisions,
  colateVicine: s.poursTooClose ?? null,
  pianiSopraLeVie: s.planesOverVias ?? null,
  aperte: s.unroutedTotal ?? s.unroutedConnections.length,
});

describe("cucitura-massa.tsx compilato", () => {
  it("vie della rete di massa, passanti, foro e corona scritti, massa intera attorno; dei controlli della compilazione cambiano solo i tre avvisi ERC per via e la distanza dal bordo di una classe piu' severa del progetto", async () => {
    // 1. the board as it is, compiled
    const files: Record<string, string> = { "main.tsx": MAIN(""), [DESIGN_RULES_PATH]: REGOLE };
    const prima = await compileProject(files);
    let hashScheda = filesHash(files);
    const chiama = (circuitJson: unknown[], args: Record<string, unknown>) =>
      eseguiCucitura({
        files,
        args,
        cache: { circuitJson },
        scheda: statoDellaScheda(hashScheda, files, filesHash),
        scrivi: async (path, content) => {
          files[path] = content;
        },
      });

    // 2. the look, then the write of what the look showed
    const visto = await chiama(prima.circuitJson as unknown[], { passoMm: 3 });
    expect(visto.result).toMatchObject({ ok: true, scritto: false, scheda: "aggiornata", scrivibile: true, main: { usaIlFile: false } });
    const proposte = visto.result.vie as number;
    expect(proposte).toBeGreaterThan(3);
    // the silkscreen of the board keeps some positions out, on both faces
    expect((visto.result.scarti as Record<string, number>).serigrafia).toBeGreaterThan(0);
    const scrive = await chiama(prima.circuitJson as unknown[], { passoMm: 3, apply: true, impronta: visto.result.impronta });
    expect(scrive.result).toMatchObject({ ok: true, scritto: true });
    expect(files[FILE_CUCITURA]).toMatch(/connectsTo="net.GND"/);
    expect(vieDelFile(files[FILE_CUCITURA])).toHaveLength(proposte);

    // 3. the two lines in main.tsx, and the compile
    files["main.tsx"] = MAIN("board");
    const dopo = await compileProject(files);
    hashScheda = filesHash(files);
    const els = dopo.circuitJson as El[];
    const gnd = els.find((e) => e.type === "source_net" && e.name === "GND")!;
    // every via but V1, the one main.tsx draws itself
    const vie = els.filter((e) => e.type === "pcb_via" && !(e.x === -8 && e.y === -5));
    expect(vie).toHaveLength(proposte);
    for (const v of vie) {
      expect(v.hole_diameter).toBe(0.2);
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
    // every check says what it said before the vias, but for the two things the top of this file names
    const a = controlli(prima.summary);
    const b = controlli(dopo.summary);
    expect({ ...b, erc: null, fabbrica: null }).toEqual({ ...a, erc: null, fabbrica: null });
    // the ERC: three ports for each <via> of the file, as for V1 before, and nothing else
    expect(a.erc.unconnected_pin).toBe(3);
    expect(b.erc).toEqual({ ...a.erc, unconnected_pin: a.erc.unconnected_pin + 3 * proposte });
    // the fab classes: the project's own and the one the board satisfies are the same; only a class stricter than the project at the edge counts a rule more
    expect(b.fabbrica.classe).toBe(a.fabbrica.classe);
    expect(b.fabbrica.classi).toEqual({ ...a.fabbrica.classi, oshpark: "6:false" });
    expect(a.fabbrica.classi.oshpark).toBe("5:false");
    // and the silkscreen of the board was there to be drilled through: with it the check is as before
    expect(b.serigrafia).toEqual(a.serigrafia);

    // 4. run again on the board compiled with the file: the same vias, the same file
    const scritto = files[FILE_CUCITURA];
    const rivisto = await chiama(dopo.circuitJson as unknown[], { passoMm: 3 });
    expect(rivisto.result).toMatchObject({ scheda: "aggiornata", scrivibile: true, main: { usaIlFile: true }, vie: proposte, impronta: visto.result.impronta });
    await chiama(dopo.circuitJson as unknown[], { passoMm: 3, apply: true, impronta: rivisto.result.impronta });
    expect(files[FILE_CUCITURA]).toBe(scritto);
  }, 180_000);

  it("<CucituraMassa /> dentro un <group> spostato: le vie escono spostate, lo strumento lo vede sulla scheda compilata e non scrive", async () => {
    const files: Record<string, string> = { "main.tsx": MAIN(""), [DESIGN_RULES_PATH]: REGOLE };
    const prima = await compileProject(files);
    const base = { files, scrivi: async (path: string, content: string) => void (files[path] = content) };
    const visto = await eseguiCucitura({ ...base, args: { passoMm: 3 }, cache: { circuitJson: prima.circuitJson as unknown[] }, scheda: "aggiornata" });
    await eseguiCucitura({ ...base, args: { passoMm: 3, apply: true, impronta: visto.result.impronta }, cache: { circuitJson: prima.circuitJson as unknown[] }, scheda: "aggiornata" });
    const scritto = files[FILE_CUCITURA];
    const delFile = vieDelFile(scritto);
    expect(delFile.length).toBeGreaterThan(3);

    files["main.tsx"] = MAIN("group");
    const spostata = await compileProject(files);
    // tscircuit moved every via of the file by the offset of the group
    const sullaScheda = (spostata.circuitJson as El[]).filter((e) => e.type === "pcb_via" && !(e.x === -8 && e.y === -5));
    expect(sullaScheda).toHaveLength(delFile.length);
    expect(sullaScheda.map((v) => [Number(v.x), Number(v.y)]).sort()).toEqual(delFile.map((p) => [Math.round((p.x + 1) * 1000) / 1000, Math.round((p.y + 0.5) * 1000) / 1000]).sort());

    const scheda = statoDellaScheda(filesHash(files), files, filesHash);
    expect(scheda).toBe("aggiornata");
    const guarda = await eseguiCucitura({ ...base, args: { passoMm: 3 }, cache: { circuitJson: spostata.circuitJson as unknown[] }, scheda });
    expect(guarda.result).toMatchObject({ ok: true, scrivibile: false, main: { usaIlFile: true, vieNonAlLoroPosto: delFile.length } });
    expect((guarda.result.nonScrivibile as string[]).join(" ")).toMatch(/<group> spostato/);
    const scrive = await eseguiCucitura({ ...base, args: { passoMm: 3, apply: true, impronta: guarda.result.impronta }, cache: { circuitJson: spostata.circuitJson as unknown[] }, scheda });
    expect(scrive.result.error).toMatch(/non sono sulla scheda alle coordinate del file/);
    expect(files[FILE_CUCITURA]).toBe(scritto);
  }, 180_000);
});
