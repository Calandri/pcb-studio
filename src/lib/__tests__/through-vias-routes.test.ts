import { beforeEach, describe, expect, it, vi } from "vitest";
import { runTscircuitCode } from "@tscircuit/eval";

/*
 * sbb-dl-principale, 2026-11-11: the saved board had 32 vias written on the two
 * layers their trace joins, the inner1 ground plane closed over 20 of them, and
 * the board was exportable. Three routes save a board they did not compile:
 * they take it from the cache, and no board leaves them with such a via. The
 * recheck is the one that files a board under today's engine, so it is also
 * the one that has to pour its planes again.
 *
 * And pouring again can leave a plane as it was (the solver of a pour fails or
 * gives nothing back, the whole step fails in the compile): the review of that
 * fix found such a board filed under today's engine all the same, exportable
 * with the plane over the hole. A board with a via in the copper of another
 * net's plane keeps an older engine, from the recheck and from the compile,
 * and the answer says why.
 */
type Punto = { x: number; y: number };
type El = Record<string, unknown> & { type: string } & {
  x?: number; y?: number; layer?: string; layers?: string[]; outer_diameter?: number;
  brep_shape?: { outer_ring: { vertices: Punto[] }; inner_rings?: Array<{ vertices: Punto[] }> };
};

const db = vi.hoisted(() => ({
  row: null as null | { filesHash: string; circuitJson: unknown[]; summary: unknown; createdAt: string; engineVersion: number; base?: unknown },
  files: {} as Record<string, string>,
  saves: [] as Array<{ hash: string; circuitJson: unknown[]; summary: unknown; engine: number }>,
}));

/** how the pour step is made to fail: the solver of a pour throws, or gives nothing back, or the whole step throws */
const guasto = vi.hoisted(() => ({ come: null as null | "solver" | "vuoto" | "tutto" }));
vi.mock("@tscircuit/copper-pour-solver", async (originale) => {
  const vero = await originale<typeof import("@tscircuit/copper-pour-solver")>();
  return {
    ...vero,
    CopperPourPipelineSolver: class extends vero.CopperPourPipelineSolver {
      getOutput() {
        if (guasto.come === "solver") throw new Error("solver in errore");
        if (guasto.come === "vuoto") return { brep_shapes: [] } as unknown as ReturnType<InstanceType<typeof vero.CopperPourPipelineSolver>["getOutput"]>;
        return super.getOutput();
      }
    },
    convertCircuitJsonToInputProblem: ((...args: Parameters<typeof vero.convertCircuitJsonToInputProblem>) => {
      if (guasto.come === "tutto") throw new Error("convertitore in errore");
      return vero.convertCircuitJsonToInputProblem(...args);
    }) as typeof vero.convertCircuitJsonToInputProblem,
  };
});

vi.mock("@/lib/acl", () => ({ requireProjectAccess: vi.fn(async () => ({ viewer: null, ok: true })) }));
vi.mock("@/lib/agent-tools", () => ({ withLibrary: vi.fn(async (f: Record<string, string>) => f) }));
vi.mock("@/lib/project-store", async (originale) => {
  const vero = await originale<typeof import("@/lib/project-store")>();
  return {
    ...vero,
    getProject: vi.fn(async () => db.files),
    getCompileCache: vi.fn(async () => db.row),
    getCompileMeta: vi.fn(async () => (db.row ? { filesHash: db.row.filesHash, createdAt: db.row.createdAt, engineVersion: db.row.engineVersion, base: null } : null)),
    saveCompileCache: vi.fn(async (_p: string, hash: string, circuitJson: unknown[], summary: unknown, engine: number) => {
      db.saves.push({ hash, circuitJson, summary, engine });
      return { saved: true };
    }),
  };
});

import JSZip from "jszip";
import { POST as acceptBoard } from "@/app/api/accept-board/route";
import { GET as esporta } from "@/app/api/export/route";
import { POST as recheck } from "@/app/api/recheck/route";
import { POST as trace } from "@/app/api/trace/route";
import { compileProject } from "@/lib/compile";
import { saveFinishedCompile } from "@/lib/compile-save";
import { DESIGN_RULES_PATH } from "@/lib/design-rules";
import { CHECKS_ENGINE_VERSION, ENGINE_VIE_PASSANTI, motoreDaSalvare, nonCertificata } from "@/lib/engine-version";
import { filesHash } from "@/lib/project-store";

const MAIN = `export default () => (
  <board width="20mm" height="12mm" layers={4} pcbStyle={{ viaHoleDiameter: 0.2, viaPadDiameter: 0.5 }}>
    <net name="GND" />
    <copperpour layer="inner1" connectsTo="net.GND" />
    <resistor name="R1" resistance="1k" footprint="0402" pcbX={-6} pcbY={0} />
    <resistor name="R2" resistance="1k" footprint="0402" pcbX={6} pcbY={0} layer="bottom" />
    <trace from=".R1 > .pin1" to="net.GND" />
    <trace from=".R1 > .pin2" to=".R2 > .pin2" pcbPathRelativeTo=".R1 > .pin2" pcbPath={[
      { x: 1.5, y: 0 },
      { x: 1.5, y: 0, via: true, fromLayer: "top", toLayer: "inner2" },
      { x: 1.5, y: 0 },
      { x: 9.5, y: 0 },
      { x: 9.5, y: 0, via: true, fromLayer: "inner2", toLayer: "bottom" },
      { x: 9.5, y: 0 },
    ]} thickness="0.25mm" />
  </board>
)
`;
const REGOLE = JSON.stringify({
  preset: "custom",
  rules: { minTraceWidthMm: 0.127, minClearanceMm: 0.152, minViaHoleMm: 0.2, minViaDiameterMm: 0.5, pourClearanceMm: 0.152, autoPlaneVias: false, autoroute: false },
});
const FILES = { "main.tsx": MAIN, [DESIGN_RULES_PATH]: REGOLE };
const QUATTRO = ["top", "inner1", "inner2", "bottom"];

const dentro = (x: number, y: number, a: Punto[]) => {
  let d = false;
  for (let i = 0, j = a.length - 1; i < a.length; j = i++) if (a[i].y > y !== a[j].y > y && x < ((a[j].x - a[i].x) * (y - a[i].y)) / (a[j].y - a[i].y) + a[i].x) d = !d;
  return d;
};
const distSeg = (p: Punto, a: Punto, b: Punto) => {
  const dx = b.x - a.x, dy = b.y - a.y, l = dx * dx + dy * dy;
  const t = l > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
};
/** from the edge of the via's pad to the copper of the planes of one layer: 0 when the pad is in the copper */
const dalRame = (cj: El[], layer: string, via: El) => {
  const piani = cj.filter((e) => e.type === "pcb_copper_pour" && e.layer === layer).map((e) => e.brep_shape!);
  if (piani.some((b) => dentro(via.x!, via.y!, b.outer_ring.vertices) && !(b.inner_rings ?? []).some((r) => dentro(via.x!, via.y!, r.vertices)))) return 0;
  const anelli = piani.flatMap((b) => [b.outer_ring.vertices, ...(b.inner_rings ?? []).map((r) => r.vertices)]);
  return Math.max(0, Math.min(...anelli.flatMap((a) => a.map((q, i) => distSeg({ x: via.x!, y: via.y! }, a[(i + a.length - 1) % a.length], q)))) - via.outer_diameter! / 2);
};
type Risposta = {
  ok: boolean;
  saved?: boolean;
  pianiRicolati?: boolean;
  vieParziali?: number;
  engineVersion: number;
  currentEngineVersion: number;
  previousEngineVersion: number;
  nonCertificata?: string;
  summary: { message: string; drcViolations: Array<{ rule: string }>; planesOverVias?: { count: number; detail: string } };
};
const post = (body: unknown) => new Request("http://x/api", { method: "POST", body: JSON.stringify(body) });
const vie = (cj: unknown[]) => (cj as El[]).filter((e) => e.type === "pcb_via");
const giuDi = (cj: unknown[]) => vie(cj).find((v) => v.from_layer === "inner2" && v.to_layer === "bottom")!;

/** the board as an engine before this one saved it: vias as tscircuit writes them, the inner1 plane over the hole */
let salvata: El[] = [];
const riga = (circuitJson: unknown[], engineVersion: number) => ({
  filesHash: filesHash(FILES),
  circuitJson,
  summary: { message: "vecchia" },
  createdAt: "2026-11-11T07:00:00.000Z",
  engineVersion,
  base: null,
});

describe("the routes that save a board from the cache leave only through vias", () => {
  beforeEach(async () => {
    if (salvata.length === 0) {
      const grezza = (await runTscircuitCode({ "main.tsx": MAIN }, { mainComponentPath: "main.tsx" })) as El[];
      const chiuso: El = {
        ...grezza.find((e) => e.type === "pcb_copper_pour" && e.layer === "inner1")!,
        brep_shape: { outer_ring: { vertices: [{ x: -9, y: -5 }, { x: 9, y: -5 }, { x: 9, y: 5 }, { x: -9, y: 5 }] }, inner_rings: [] },
      };
      salvata = [...grezza.filter((e) => e.type !== "pcb_copper_pour"), chiuso];
    }
    db.files = FILES;
    db.saves = [];
    db.row = riga(salvata, ENGINE_VIE_PASSANTI - 1);
    guasto.come = null;
  }, 120_000);

  it("the board of the older engine is what the bug looked like", () => {
    expect(giuDi(salvata).layers).toEqual(["inner2", "bottom"]);
    expect(dalRame(salvata, "inner1", giuDi(salvata))).toBe(0);
  });

  it("recheck: the vias are completed, the planes are poured again and only then the board is filed under today's engine", async () => {
    const r = await recheck(post({ projectId: "p" }));
    const risposta = (await r.json()) as Risposta;
    expect(r.status).toBe(200);
    expect(risposta).toMatchObject({ ok: true, pianiRicolati: true, vieParziali: 2, engineVersion: CHECKS_ENGINE_VERSION, previousEngineVersion: ENGINE_VIE_PASSANTI - 1 });
    expect(risposta.nonCertificata).toBeUndefined();
    const [s] = db.saves;
    expect(s.engine).toBe(CHECKS_ENGINE_VERSION);
    for (const v of vie(s.circuitJson)) expect(v.layers).toEqual(QUATTRO);
    expect([giuDi(s.circuitJson).from_layer, giuDi(s.circuitJson).to_layer]).toEqual(["inner2", "bottom"]);
    expect(dalRame(s.circuitJson as El[], "inner1", giuDi(s.circuitJson))).toBeGreaterThanOrEqual(0.152 - 0.01);
    expect(risposta.summary.drcViolations.filter((v) => v.rule === "pour_clearance")).toEqual([]);
    expect(risposta.summary.planesOverVias).toBeUndefined();
  }, 120_000);

  it("recheck: a board whose vias all listed the four layers keeps the planes it has", async () => {
    // a board poured as it should be, with its vias written on every layer as tscircuit writes one from top to bottom
    await recheck(post({ projectId: "p" }));
    const buona = (db.saves[0].circuitJson as El[]).map((e) => {
      if (e.type !== "pcb_via") return e;
      const via: El = { ...e, from_layer: "top", to_layer: "bottom" };
      delete via.declared_layers;
      return via;
    });
    const aperture = (cj: unknown[]) =>
      (cj as El[]).filter((e) => e.type === "pcb_copper_pour" && e.layer === "inner1").map((e) => (e.brep_shape!.inner_rings ?? []).length);
    db.saves = [];
    db.row = riga(buona, ENGINE_VIE_PASSANTI - 1);
    const r = await recheck(post({ projectId: "p" }));
    const risposta = (await r.json()) as Risposta;
    expect(risposta).toMatchObject({ ok: true, engineVersion: CHECKS_ENGINE_VERSION });
    expect(risposta.pianiRicolati).toBeUndefined();
    expect(risposta.nonCertificata).toBeUndefined();
    const [s] = db.saves;
    expect(s.engine).toBe(CHECKS_ENGINE_VERSION);
    expect(aperture(s.circuitJson)).toEqual(aperture(buona));
    expect(vie(s.circuitJson).map((v) => v.declared_layers)).toEqual([undefined, undefined]);
  }, 120_000);

  it("recheck: a board with a plane over a via is poured again, whatever its engine and whatever its vias list", async () => {
    // vias on every layer and today's engine: what a via drawn by hand leaves after the fast update, which never pours
    const intere = salvata.map((e) => (e.type === "pcb_via" ? { ...e, layers: QUATTRO, from_layer: "top", to_layer: "bottom" } : e));
    db.row = riga(intere, CHECKS_ENGINE_VERSION);
    const r = await recheck(post({ projectId: "p" }));
    const risposta = (await r.json()) as Risposta;
    expect(r.status).toBe(200);
    expect(risposta).toMatchObject({ ok: true, saved: true, pianiRicolati: true, engineVersion: CHECKS_ENGINE_VERSION });
    expect(risposta.nonCertificata).toBeUndefined();
    expect(risposta.summary.planesOverVias).toBeUndefined();
    const [s] = db.saves;
    expect(s.engine).toBe(CHECKS_ENGINE_VERSION);
    for (const v of vie(s.circuitJson)) expect(dalRame(s.circuitJson as El[], "inner1", v)).toBeGreaterThanOrEqual(0.152 - 0.01);
  }, 120_000);

  it.each(["solver", "vuoto"] as const)(
    "recheck: when the solver of the plane fails (%s) the old plane stays, and the board stays out of the export",
    async (come) => {
      guasto.come = come;
      // an engine older still: the board keeps the one it had
      db.row = riga(salvata, ENGINE_VIE_PASSANTI - 2);
      const r = await recheck(post({ projectId: "p" }));
      const risposta = (await r.json()) as Risposta;
      expect(r.status).toBe(200);
      expect(risposta).toMatchObject({ ok: true, saved: true, engineVersion: ENGINE_VIE_PASSANTI - 2 });
      // both vias of the trace are under the plane that was saved
      expect(risposta.nonCertificata).toMatch(/2 vie hanno la piazzola nel rame di un piano di un'altra rete \(pcb_via_\d+ nel piano GND su inner1 e in un altro punto\)/);
      const [s] = db.saves;
      expect(s.engine).toBe(ENGINE_VIE_PASSANTI - 2);
      // the vias were completed, the plane is the one that was there: still over the hole
      expect(giuDi(s.circuitJson).layers).toEqual(QUATTRO);
      expect(dalRame(s.circuitJson as El[], "inner1", giuDi(s.circuitJson))).toBe(0);
      expect(risposta.summary.drcViolations.some((v) => v.rule === "pour_clearance")).toBe(true);
      // the answer says it in the message too, with what to do
      expect(risposta.summary.message).toContain(risposta.nonCertificata!);
      expect(risposta.nonCertificata).toMatch(/NON e' certificata per l'export .* premi Aggiorna o Ricontrolla per rifare le colate/);

      // and a board that had today's engine loses it
      db.saves = [];
      db.row = riga(salvata, CHECKS_ENGINE_VERSION);
      const oggi = (await (await recheck(post({ projectId: "p" }))).json()) as Risposta;
      expect(oggi).toMatchObject({ engineVersion: ENGINE_VIE_PASSANTI - 1, currentEngineVersion: CHECKS_ENGINE_VERSION });
      expect(db.saves[0].engine).toBe(ENGINE_VIE_PASSANTI - 1);
    },
    120_000,
  );

  it("recheck: when the whole pour step fails nothing is saved", async () => {
    guasto.come = "tutto";
    const r = await recheck(post({ projectId: "p" }));
    expect(r.status).toBe(500);
    expect(((await r.json()) as { error: string }).error).toMatch(/recheck failed/);
    expect(db.saves).toHaveLength(0);
  }, 120_000);

  it.each([null, "solver", "vuoto", "tutto"] as const)(
    "compile: with the pour step %s the board is filed under today's engine only if no plane is over a via",
    async (come) => {
      guasto.come = come;
      const { circuitJson, summary } = await compileProject(FILES);
      for (const v of vie(circuitJson)) expect(v.layers).toEqual(QUATTRO);
      db.row = null;
      const esito = await saveFinishedCompile("p", filesHash(FILES), circuitJson as unknown[], summary, { startedAt: Date.now(), filesNow: async () => FILES });
      expect(esito.saved).toBe(true);
      const [s] = db.saves;
      if (come === null) {
        expect(summary.planesOverVias).toBeUndefined();
        expect(summary.message).not.toMatch(/NON e' certificata/);
        expect(s.engine).toBe(CHECKS_ENGINE_VERSION);
        return;
      }
      // tscircuit's own plane, poured on the two layers the via listed, is still on the board: over the hole
      expect(dalRame(circuitJson as El[], "inner1", giuDi(circuitJson))).toBe(0);
      expect(summary.planesOverVias).toMatchObject({ count: 1 });
      expect(summary.message).toMatch(/ATTENZIONE: 1 via ha la piazzola nel rame di un piano di un'altra rete .* NON e' certificata per l'export/);
      expect(s.engine).toBe(ENGINE_VIE_PASSANTI - 1);
      expect(s.engine).toBeLessThan(CHECKS_ENGINE_VERSION);
    },
    120_000,
  );

  it("export: refused with the reason while a plane covers a via, and with every via in the drill file once it does not", async () => {
    const gerber = () => esporta(new Request("http://x/api/export?projectId=p&kind=gerber"));
    // the solver fails: the board is saved with the plane over the holes, under the engine it had
    guasto.come = "solver";
    await recheck(post({ projectId: "p" }));
    db.row = { ...riga(db.saves[0].circuitJson, db.saves[0].engine), summary: db.saves[0].summary };
    const rifiuto = await gerber();
    expect(rifiuto.status).toBe(409);
    expect(((await rifiuto.json()) as { error: string }).error).toMatch(/ricompila la scheda prima di esportare: 2 vie hanno la piazzola nel rame di un piano di un'altra rete .* NON e' certificata per l'export .* premi Aggiorna o Ricontrolla/);

    // the solver works: poured again, filed under today's engine, exported
    guasto.come = null;
    db.saves = [];
    db.row = riga(salvata, ENGINE_VIE_PASSANTI - 1);
    await recheck(post({ projectId: "p" }));
    db.row = { ...riga(db.saves[0].circuitJson, db.saves[0].engine), summary: db.saves[0].summary };
    const ok = await gerber();
    expect(ok.status).toBe(200);
    const zip = await JSZip.loadAsync(await ok.arrayBuffer());
    const fori = (await zip.file("drill_plated.drl")!.async("string")).split("\n").filter((l) => /^X-?[\d.]+Y-?[\d.]+$/.test(l));
    // both vias of the trace, the one from inner2 to bottom included: it was in no drill file
    expect(fori).toEqual(expect.arrayContaining(["X-4.5000Y0.0000", "X3.5000Y0.0000"]));
    // and its pad on the faces and on inner2, where the trace reaches it, not on the plane it crosses
    const colpo = /X0*3500000Y0*D03/;
    for (const strato of ["F_Cu", "In2_Cu", "B_Cu"]) expect(await zip.file(`${strato}.gbr`)!.async("string")).toMatch(colpo);
    expect(await zip.file("In1_Cu.gbr")!.async("string")).not.toMatch(colpo);
  }, 120_000);

  /*
   * And a board whose pours of two different nets touch (sbb-dl-principale,
   * 17:00-17:37 of 2026-11-11: the ground pour over the USB shield strips,
   * zero errors) is refused the same way, whatever engine it was filed under.
   */
  it("export: a board where two pours of different nets touch is refused with the reason", async () => {
    const gerber = () => esporta(new Request("http://x/api/export?projectId=p&kind=gerber"));
    await recheck(post({ projectId: "p" }));
    const [buona] = db.saves;
    db.row = { ...riga(buona.circuitJson, buona.engine), summary: buona.summary };
    expect((await gerber()).status).toBe(200);
    const gnd = (buona.circuitJson as Array<Record<string, unknown>>).find((e) => e.type === "source_net" && e.name === "GND")!;
    const altra = { type: "source_net", source_net_id: "n_altra", name: "ALTRA" };
    const quadro = (x0: number, x1: number) => ({ outer_ring: { vertices: [{ x: x0, y: 3 }, { x: x1, y: 3 }, { x: x1, y: 5 }, { x: x0, y: 5 }] }, inner_rings: [] });
    const toccano = [
      ...buona.circuitJson,
      altra,
      { type: "pcb_copper_pour", pcb_copper_pour_id: "a", source_net_id: gnd.source_net_id, layer: "top", shape: "brep", brep_shape: quadro(-8, 0.05) },
      { type: "pcb_copper_pour", pcb_copper_pour_id: "b", source_net_id: altra.source_net_id, layer: "top", shape: "brep", brep_shape: quadro(0, 8) },
    ];
    db.row = { ...riga(toccano, CHECKS_ENGINE_VERSION), summary: buona.summary };
    const rifiuto = await gerber();
    expect(rifiuto.status).toBe(409);
    expect(((await rifiuto.json()) as { error: string }).error).toMatch(/colate di reti diverse troppo vicine \(1 si toccano: corto\).* NON e' certificata per l'export/);
  }, 120_000);

  /*
   * The fast update and a trace edit save the board under the engine it had: a
   * via drawn by hand through a plane is on a board of today's engine until the
   * planes are poured again. The export measures the board it is handed.
   */
  it("export: a board of today's engine with a via drawn through a plane is refused, and goes through once the planes are poured again", async () => {
    const gerber = () => esporta(new Request("http://x/api/export?projectId=p&kind=gerber"));
    // a board poured as it should be and filed under today's engine
    await recheck(post({ projectId: "p" }));
    const [buona] = db.saves;
    expect(buona.engine).toBe(CHECKS_ENGINE_VERSION);
    db.row = { ...riga(buona.circuitJson, buona.engine), summary: buona.summary };
    expect((await gerber()).status).toBe(200);

    // a via laid by hand in the middle of the inner1 ground plane: the board is saved as it is, summary included
    const aMano = { type: "pcb_via", pcb_via_id: "pcb_via_manual_0", manual: true, x: 0, y: 3, outer_diameter: 0.5, hole_diameter: 0.2, layers: QUATTRO, subcircuit_connectivity_map_key: giuDi(buona.circuitJson).subcircuit_connectivity_map_key };
    db.row = { ...riga([...buona.circuitJson, aMano], CHECKS_ENGINE_VERSION), summary: buona.summary };
    expect((buona.summary as { planesOverVias?: unknown }).planesOverVias).toBeUndefined();
    for (const kind of ["gerber", "pnp"]) {
      const rifiuto = await esporta(new Request(`http://x/api/export?projectId=p&kind=${kind}`));
      expect(rifiuto.status).toBe(409);
      const { error, reason } = (await rifiuto.json()) as { error: string; reason: string };
      expect(reason).toMatch(/^1 via ha la piazzola nel rame di un piano di un'altra rete \(pcb_via_manual_0 nel piano GND su inner1\)/);
      expect(reason).toMatch(/premi Aggiorna o Ricontrolla per rifare le colate/);
      expect(error).toContain(reason);
    }
    // the parts list does not depend on the copper: it is still given
    expect((await esporta(new Request("http://x/api/export?projectId=p&kind=bom"))).status).toBe(200);

    // "Ricontrolla": the planes are poured again around the new hole, and the same board is exported
    db.saves = [];
    const r = (await (await recheck(post({ projectId: "p" }))).json()) as Risposta;
    expect(r).toMatchObject({ pianiRicolati: true, engineVersion: CHECKS_ENGINE_VERSION });
    db.row = { ...riga(db.saves[0].circuitJson, db.saves[0].engine), summary: db.saves[0].summary };
    const ok = await gerber();
    expect(ok.status).toBe(200);
    const zip = await JSZip.loadAsync(await ok.arrayBuffer());
    expect(await zip.file("drill_plated.drl")!.async("string")).toContain("X0.0000Y3.0000");
  }, 120_000);

  it("export: a board with no planes is not measured and not held back", async () => {
    await recheck(post({ projectId: "p" }));
    const senzaPiani = (db.saves[0].circuitJson as El[]).filter((e) => e.type !== "pcb_copper_pour");
    const aMano = { type: "pcb_via", pcb_via_id: "pcb_via_manual_0", manual: true, x: 0, y: 3, outer_diameter: 0.5, hole_diameter: 0.2, layers: QUATTRO, subcircuit_connectivity_map_key: giuDi(senzaPiani).subcircuit_connectivity_map_key };
    db.row = { ...riga([...senzaPiani, aMano], CHECKS_ENGINE_VERSION), summary: db.saves[0].summary };
    const ok = await esporta(new Request("http://x/api/export?projectId=p&kind=gerber"));
    expect(ok.status).toBe(200);
    const zip = await JSZip.loadAsync(await ok.arrayBuffer());
    expect(await zip.file("drill_plated.drl")!.async("string")).toContain("X0.0000Y3.0000");
  }, 120_000);

  it("the engine a board is filed under: today's, or an older one while a plane covers a via", () => {
    expect(motoreDaSalvare({})).toBe(CHECKS_ENGINE_VERSION);
    expect(motoreDaSalvare(null)).toBe(CHECKS_ENGINE_VERSION);
    expect(motoreDaSalvare({ planesOverVias: { count: 0, detail: "" } })).toBe(CHECKS_ENGINE_VERSION);
    const coperta = { planesOverVias: { count: 3, detail: "3 vie hanno la piazzola nel rame di un piano di un'altra rete" } };
    expect(motoreDaSalvare(coperta)).toBe(ENGINE_VIE_PASSANTI - 1);
    expect(motoreDaSalvare(coperta, 4)).toBe(4);
    expect(motoreDaSalvare(coperta, CHECKS_ENGINE_VERSION + 5)).toBe(ENGINE_VIE_PASSANTI - 1);
    expect(nonCertificata({})).toBeNull();
    expect(nonCertificata(coperta)).toMatch(/^3 vie hanno .*NON e' certificata per l'export/);
  });

  it("accept-board: the board taken as it is goes back with its vias completed, under the engine it was made with", async () => {
    const r = await acceptBoard(post({ projectId: "p" }));
    expect(((await r.json()) as { ok: boolean }).ok).toBe(true);
    const [s] = db.saves;
    for (const v of vie(s.circuitJson)) expect(v.layers).toEqual(QUATTRO);
    expect(giuDi(s.circuitJson).declared_layers).toEqual(["inner2", "bottom"]);
    // still the older engine: its planes were not poured again, and the export asks for a recompile or a recheck
    expect(s.engine).toBe(ENGINE_VIE_PASSANTI - 1);
    expect(s.summary).toEqual({ message: "vecchia" });
  });

  it("trace: a via the page puts back with Cmd+Z comes back as a through hole", async () => {
    // a board of today's engine with one trace taken off: the page sends its copper back
    const pista = salvata.find((e) => e.type === "pcb_trace")!;
    const sue = vie(salvata);
    db.row = riga(salvata.filter((e) => e !== pista && e.type !== "pcb_via"), CHECKS_ENGINE_VERSION);
    const r = await trace(post({ projectId: "p", action: "restore", elements: [pista, ...sue], routes: [] }));
    expect(r.status).toBe(200);
    const [s] = db.saves;
    expect(vie(s.circuitJson)).toHaveLength(2);
    for (const v of vie(s.circuitJson)) expect(v.layers).toEqual(QUATTRO);
    expect(giuDi(s.circuitJson).declared_layers).toEqual(["inner2", "bottom"]);
    expect(s.engine).toBe(CHECKS_ENGINE_VERSION);
  });
});
