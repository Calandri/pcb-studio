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
import { CHECKS_ENGINE_VERSION, ENGINE_COLATE_DAI_CONTORNI, ENGINE_VIE_PASSANTI, colateDiUnMotoreDiPrima, motoreDaSalvare, nonCertificata } from "@/lib/engine-version";
import { serigrafiaInConflitto } from "@/lib/silkscreen-clearance";
import { convertSoupToGerberCommands, stringifyGerberCommandLayers } from "circuit-json-to-gerber";
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
  colateDaRifare?: boolean;
  vieParziali?: number;
  engineVersion: number;
  currentEngineVersion: number;
  previousEngineVersion: number;
  nonCertificata?: string;
  summary: {
    message: string;
    drcViolations: Array<{ rule: string }>;
    planesOverVias?: { count: number; detail: string };
    poursFromOlderEngine?: { engine: number; count: number; detail: string };
  };
};
const post = (body: unknown) => new Request("http://x/api", { method: "POST", body: JSON.stringify(body) });
const vie = (cj: unknown[]) => (cj as El[]).filter((e) => e.type === "pcb_via");
const giuDi = (cj: unknown[]) => vie(cj).find((v) => v.from_layer === "inner2" && v.to_layer === "bottom")!;

/**
 * The pour regions of a copper Gerber in the order they are drawn: each dark
 * region with the clear ones that follow it (the holes of that pour).
 */
const regioniDelGerber = (gbr: string): Array<{ scura: Punto[]; chiare: Punto[][] }> => {
  const out: Array<{ scura: Punto[]; chiare: Punto[][] }> = [];
  let chiara = false;
  let regione: Punto[] | null = null;
  for (const riga of gbr.split("\n")) {
    if (riga.includes("%LPC")) chiara = true;
    else if (riga.includes("%LPD")) chiara = false;
    else if (riga.startsWith("G36")) regione = [];
    else if (riga.startsWith("G37")) {
      if (regione && regione.length >= 3) {
        if (!chiara) out.push({ scura: regione, chiare: [] });
        else out.at(-1)?.chiare.push(regione);
      }
      regione = null;
    } else if (regione) {
      const m = /X(-?\d+)Y(-?\d+)/.exec(riga);
      if (m) regione.push({ x: Number(m[1]) / 1e6, y: Number(m[2]) / 1e6 });
    }
  }
  return out;
};
/** how many times a hole of a pour is drawn over a pour drawn before it: copper the Gerber erases */
const cancellature = (gbr: string) => {
  const regioni = regioniDelGerber(gbr);
  let n = 0;
  regioni.forEach((r, j) => {
    for (const buco of r.chiare) for (const prima of regioni.slice(0, j)) if (prima.scura.some((q) => dentro(q.x, q.y, buco))) n++;
  });
  return n;
};

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

  /*
   * A recheck pours the planes again around the vias, each from the shape it
   * has, and never from the outlines the files declare: that is a compile's
   * job (engine 9). A board of an older engine with pours on it keeps its
   * engine and the answer says to press Aggiorna (review of the CAD-like
   * pours, 2026-11-11: this board came out of the recheck under today's).
   */
  it("recheck: the vias are completed and the planes poured again around them, and the board keeps its engine until a compile pours from the declared outlines", async () => {
    const r = await recheck(post({ projectId: "p" }));
    const risposta = (await r.json()) as Risposta;
    expect(r.status).toBe(200);
    expect(risposta).toMatchObject({ ok: true, pianiRicolati: true, vieParziali: 2, colateDaRifare: true, engineVersion: ENGINE_VIE_PASSANTI - 1, previousEngineVersion: ENGINE_VIE_PASSANTI - 1 });
    expect(risposta.nonCertificata).toMatch(/colat[ae] della scheda (e' stata fatta|sono state fatte) dal motore 6, che non ripartiva dai contorni dichiarati nei file\. La scheda NON e' certificata per l'export finche' le colate non sono rifatte: premi Aggiorna per rifarle/);
    expect(risposta.nonCertificata).not.toMatch(/piano copre una via/);
    expect(risposta.summary.message).toContain(risposta.nonCertificata!);
    const [s] = db.saves;
    expect(s.engine).toBe(ENGINE_VIE_PASSANTI - 1);
    for (const v of vie(s.circuitJson)) expect(v.layers).toEqual(QUATTRO);
    expect([giuDi(s.circuitJson).from_layer, giuDi(s.circuitJson).to_layer]).toEqual(["inner2", "bottom"]);
    expect(dalRame(s.circuitJson as El[], "inner1", giuDi(s.circuitJson))).toBeGreaterThanOrEqual(0.152 - 0.01);
    expect(risposta.summary.drcViolations.filter((v) => v.rule === "pour_clearance")).toEqual([]);
    expect(risposta.summary.planesOverVias).toBeUndefined();
  }, 120_000);

  it("recheck: a board of the engine before the CAD-like pours, with pours, keeps its engine, and the export refuses it with the reason", async () => {
    // a board poured as it should be, no plane over a via, saved by engine 8
    db.row = riga(salvata, CHECKS_ENGINE_VERSION);
    await recheck(post({ projectId: "p" }));
    const buona = db.saves[0].circuitJson;
    expect((buona as El[]).some((e) => e.type === "pcb_copper_pour")).toBe(true);
    db.saves = [];
    db.row = riga(buona, ENGINE_COLATE_DAI_CONTORNI - 1);
    const r = await recheck(post({ projectId: "p" }));
    const risposta = (await r.json()) as Risposta;
    expect(risposta).toMatchObject({ ok: true, saved: true, colateDaRifare: true, engineVersion: ENGINE_COLATE_DAI_CONTORNI - 1, previousEngineVersion: ENGINE_COLATE_DAI_CONTORNI - 1 });
    expect(risposta.pianiRicolati).toBeUndefined();
    expect(risposta.summary.poursFromOlderEngine).toMatchObject({ engine: ENGINE_COLATE_DAI_CONTORNI - 1 });
    expect(risposta.nonCertificata).toMatch(/dal motore 8, che non ripartiva dai contorni dichiarati nei file\. .* premi Aggiorna per rifarle/);
    const [s] = db.saves;
    expect(s.engine).toBe(ENGINE_COLATE_DAI_CONTORNI - 1);

    db.row = { ...riga(s.circuitJson, s.engine), summary: s.summary };
    for (const kind of ["gerber", "pnp"]) {
      const rifiuto = await esporta(new Request(`http://x/api/export?projectId=p&kind=${kind}`));
      expect(rifiuto.status).toBe(409);
      const { error, reason } = (await rifiuto.json()) as { error: string; reason: string };
      expect(reason).toMatch(/dal motore 8, che non ripartiva dai contorni dichiarati nei file\. La scheda NON e' certificata per l'export finche' le colate non sono rifatte: premi Aggiorna per rifarle/);
      expect(error).toBe(`ricompila la scheda prima di esportare: ${reason}`);
    }
  }, 120_000);

  it("recheck: a board of the engine before the CAD-like pours with no pours is filed under today's engine, and exported", async () => {
    db.row = riga(salvata, CHECKS_ENGINE_VERSION);
    await recheck(post({ projectId: "p" }));
    const senzaColate = (db.saves[0].circuitJson as El[]).filter((e) => e.type !== "pcb_copper_pour");
    db.saves = [];
    db.row = riga(senzaColate, ENGINE_COLATE_DAI_CONTORNI - 1);
    const risposta = (await (await recheck(post({ projectId: "p" }))).json()) as Risposta;
    expect(risposta).toMatchObject({ ok: true, saved: true, engineVersion: CHECKS_ENGINE_VERSION });
    expect(risposta.colateDaRifare).toBeUndefined();
    expect(risposta.nonCertificata).toBeUndefined();
    expect(risposta.summary.poursFromOlderEngine).toBeUndefined();
    expect(db.saves[0].engine).toBe(CHECKS_ENGINE_VERSION);
    db.row = { ...riga(db.saves[0].circuitJson, db.saves[0].engine), summary: db.saves[0].summary };
    expect((await esporta(new Request("http://x/api/export?projectId=p&kind=gerber"))).status).toBe(200);
  }, 120_000);

  /*
   * Engine 10 measures the silkscreen and changes no copper: a board of engine
   * 9 comes to today's with "Ricontrolla" alone, its copper and pours as they
   * were, and goes to the export (a silkscreen clash is a warning).
   */
  it("recheck: a board of engine 9 comes to today's engine with a recheck alone, copper and pours untouched, the silkscreen measured", async () => {
    db.row = riga(salvata, CHECKS_ENGINE_VERSION);
    await recheck(post({ projectId: "p" }));
    // poured as it should be, plus a board line of silkscreen across the via at (3.5; 0)
    const linea = { type: "pcb_silkscreen_path", pcb_silkscreen_path_id: "linea", layer: "top", route: [{ x: 3, y: 0 }, { x: 4, y: 0 }], stroke_width: 0.15 };
    const nove = [...(db.saves[0].circuitJson as El[]), linea as El];
    db.saves = [];
    db.row = riga(nove, ENGINE_COLATE_DAI_CONTORNI);
    expect(ENGINE_COLATE_DAI_CONTORNI).toBe(9);
    const risposta = (await (await recheck(post({ projectId: "p" }))).json()) as Risposta & { summary: { silkscreen?: { count: number; conflitti: Array<{ tipo: string; a: string; b: string }> } } };
    expect(risposta).toMatchObject({ ok: true, saved: true, engineVersion: CHECKS_ENGINE_VERSION, currentEngineVersion: CHECKS_ENGINE_VERSION, previousEngineVersion: 9 });
    expect(risposta.colateDaRifare).toBeUndefined();
    expect(risposta.pianiRicolati).toBeUndefined();
    expect(risposta.nonCertificata).toBeUndefined();
    const [s] = db.saves;
    expect(s.engine).toBe(CHECKS_ENGINE_VERSION);
    // the copper and the pours as they were
    const rame = (cj: unknown[]) => (cj as El[]).filter((e) => ["pcb_copper_pour", "pcb_trace", "pcb_via", "pcb_smtpad"].includes(e.type));
    expect(rame(s.circuitJson)).toEqual(rame(nove));
    // the silkscreen measured, the line over the via's hole among it
    expect(risposta.summary.silkscreen).toEqual(serigrafiaInConflitto(s.circuitJson, 0.15));
    expect(risposta.summary.silkscreen!.conflitti).toContainEqual(expect.objectContaining({ tipo: "serigrafia_foro", a: "disegno di scheda", b: expect.stringMatching(/^foro della via/) }));
    expect(risposta.summary.message).toMatch(/AVVISO serigrafia \(non ferma l'export\)/);
    // and the warning does not hold the export back
    db.row = { ...riga(s.circuitJson, s.engine), summary: s.summary };
    expect((await esporta(new Request("http://x/api/export?projectId=p&kind=gerber"))).status).toBe(200);
  }, 120_000);

  /*
   * Engine 11 measures the footprints of the parts and changes no copper: a
   * board of engine 10 comes to 11 with "Ricontrolla" alone, its copper and
   * pours as they were; two parts that hit each other are an error of the
   * summary, and the export goes on.
   */
  it("recheck: a board of engine 10 comes to today's engine (14) with a recheck alone, copper and pours untouched, the footprints measured", async () => {
    db.row = riga(salvata, CHECKS_ENGINE_VERSION);
    await recheck(post({ projectId: "p" }));
    // poured as it should be, plus a part C5 placed by hand 0,1 mm from R1's pads (an 0402 at (-6; 0))
    const r1 = (db.saves[0].circuitJson as El[]).filter((e) => e.type === "pcb_smtpad" && e.layer === "top" && (e.x as number) < -4);
    const sopra = Math.max(...r1.map((e) => (e.y as number) + (e.height as number) / 2));
    const c5 = [
      { type: "source_component", source_component_id: "s_c5", name: "C5", ftype: "simple_capacitor" },
      { type: "pcb_component", pcb_component_id: "pc_c5", source_component_id: "s_c5", center: { x: -6, y: sopra + 0.35 }, layer: "top", rotation: 0, width: 1.6, height: 0.5 },
      { type: "pcb_smtpad", pcb_smtpad_id: "c5_1", pcb_component_id: "pc_c5", shape: "rect", x: -6.5, y: sopra + 0.35, width: 0.6, height: 0.5, layer: "top" },
      { type: "pcb_smtpad", pcb_smtpad_id: "c5_2", pcb_component_id: "pc_c5", shape: "rect", x: -5.5, y: sopra + 0.35, width: 0.6, height: 0.5, layer: "top" },
    ] as El[];
    const dieci = [...(db.saves[0].circuitJson as El[]), ...c5];
    db.saves = [];
    db.row = riga(dieci, 10);
    expect(CHECKS_ENGINE_VERSION).toBe(14);
    const risposta = (await (await recheck(post({ projectId: "p" }))).json()) as Risposta & {
      summary: { courtyards?: { count: number; scontri: Array<{ a: string; b: string; faccia: string }> }; targets: { courtyardCollisions: number; allGreen: boolean } };
    };
    expect(risposta).toMatchObject({ ok: true, saved: true, engineVersion: 14, currentEngineVersion: 14, previousEngineVersion: 10 });
    expect(risposta.colateDaRifare).toBeUndefined();
    expect(risposta.pianiRicolati).toBeUndefined();
    expect(risposta.nonCertificata).toBeUndefined();
    const [s] = db.saves;
    expect(s.engine).toBe(14);
    // the copper and the pours as they were
    const rame = (cj: unknown[]) => (cj as El[]).filter((e) => ["pcb_copper_pour", "pcb_trace", "pcb_via", "pcb_smtpad"].includes(e.type));
    expect(rame(s.circuitJson)).toEqual(rame(dieci));
    // R1 and C5 hit each other: an error of the summary
    expect(risposta.summary.courtyards?.scontri).toEqual([expect.objectContaining({ a: "R1", b: "C5", faccia: "top" })]);
    expect(risposta.summary.targets).toMatchObject({ courtyardCollisions: 1, allGreen: false });
    expect(risposta.summary.message).toMatch(/ERRORE ingombri dei pezzi/);
    // and the export is not refused for it
    db.row = { ...riga(s.circuitJson, s.engine), summary: s.summary };
    expect((await esporta(new Request("http://x/api/export?projectId=p&kind=gerber"))).status).toBe(200);
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
    // not poured again, and still the engine it had: its pours are not this engine's (see the test above)
    expect(risposta).toMatchObject({ ok: true, engineVersion: ENGINE_VIE_PASSANTI - 1, colateDaRifare: true });
    expect(risposta.pianiRicolati).toBeUndefined();
    expect(risposta.nonCertificata).toMatch(/premi Aggiorna per rifarle/);
    expect(risposta.nonCertificata).not.toMatch(/piano copre una via/);
    const [s] = db.saves;
    expect(s.engine).toBe(ENGINE_VIE_PASSANTI - 1);
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

    // the solver works: poured again, filed under today's engine (a board of today's engine: see above), exported
    guasto.come = null;
    db.saves = [];
    db.row = riga(salvata, CHECKS_ENGINE_VERSION);
    await recheck(post({ projectId: "p" }));
    expect(db.saves[0].engine).toBe(CHECKS_ENGINE_VERSION);
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
    db.row = riga(salvata, CHECKS_ENGINE_VERSION);
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
    db.row = riga(salvata, CHECKS_ENGINE_VERSION);
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

  /*
   * The pours are put in that order at the end of a re-pour, and nowhere else:
   * a board saved by another path (the fast update, a trace edit, an Altium
   * import) went to the Gerber in the order it was saved in, and the hole of a
   * plane written after an island of another net erased the island.
   */
  it("export: the pours go to the Gerber in an order where no hole erases copper written before it, whatever saved the board", async () => {
    db.row = riga(salvata, CHECKS_ENGINE_VERSION);
    await recheck(post({ projectId: "p" }));
    const [buona] = db.saves;
    const gnd = (buona.circuitJson as El[]).find((e) => e.type === "source_net" && e.name === "GND")!;
    const altra = { type: "source_net", source_net_id: "n_altra", name: "ALTRA" };
    const quadro = (x0: number, y0: number, x1: number, y1: number) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
    // a ground plane on top with a hole, and an island of another net in the hole, written island first
    const isola = { type: "pcb_copper_pour", pcb_copper_pour_id: "isola", source_net_id: altra.source_net_id, layer: "top", shape: "brep", brep_shape: { outer_ring: { vertices: quadro(3.5, 3.5, 4.5, 4) }, inner_rings: [] } };
    const piano = { type: "pcb_copper_pour", pcb_copper_pour_id: "piano", source_net_id: gnd.source_net_id, layer: "top", shape: "brep", brep_shape: { outer_ring: { vertices: quadro(0, 2, 8, 5.5) }, inner_rings: [{ vertices: quadro(3, 3, 5, 4.5) }] } };
    const salvataCosi = [...buona.circuitJson, altra, isola, piano];
    // in the order it was saved in, the converter erases the island
    const comeSalvata = stringifyGerberCommandLayers(convertSoupToGerberCommands(salvataCosi as never)) as Record<string, string>;
    expect(cancellature(comeSalvata.F_Cu)).toBe(1);

    db.row = { ...riga(salvataCosi, CHECKS_ENGINE_VERSION), summary: buona.summary };
    const ok = await esporta(new Request("http://x/api/export?projectId=p&kind=gerber"));
    expect(ok.status).toBe(200);
    const zip = await JSZip.loadAsync(await ok.arrayBuffer());
    const sopra = await zip.file("F_Cu.gbr")!.async("string");
    expect(regioniDelGerber(sopra).length).toBeGreaterThanOrEqual(2);
    expect(cancellature(sopra)).toBe(0);
    for (const strato of ["In1_Cu", "In2_Cu", "B_Cu"]) expect(cancellature(await zip.file(`${strato}.gbr`)!.async("string"))).toBe(0);
    // the island is there, after the plane's hole
    const regioni = regioniDelGerber(sopra);
    const diIsola = regioni.findIndex((r) => r.scura.every((q) => q.x > 3.5 - 1e-6 && q.x < 4.5 + 1e-6 && q.y > 3.5 - 1e-6 && q.y < 4 + 1e-6));
    const diPiano = regioni.findIndex((r) => r.chiare.length > 0);
    expect(diIsola).toBeGreaterThan(diPiano);
    expect(diPiano).toBeGreaterThanOrEqual(0);
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

  it("export: a board with a doubled trace id is refused with the reason, and goes through without the double", async () => {
    await recheck(post({ projectId: "p" }));
    const buona = (db.saves[0].circuitJson as El[]).filter((e) => e.type !== "pcb_copper_pour");
    const pista = buona.find((e) => e.type === "pcb_trace" && typeof e.pcb_trace_id === "string")!;
    expect(pista).toBeDefined();
    // the trace of the board before, one millimetre away, with the id of the one the files draw (sbb-dl-principale, 12/11/2026)
    const vecchia = { ...pista, route: (pista.route as Array<Record<string, unknown>>).map((p) => ({ ...p, y: (p.y as number) + 1 })) };
    db.row = { ...riga([...buona, vecchia], CHECKS_ENGINE_VERSION), summary: db.saves[0].summary };
    for (const kind of ["gerber", "pnp"]) {
      const rifiuto = await esporta(new Request(`http://x/api/export?projectId=p&kind=${kind}`));
      expect(rifiuto.status).toBe(409);
      const { error } = (await rifiuto.json()) as { error: string };
      expect(error).toContain("ricompila la scheda prima di esportare: 1 elemento della scheda ha l'id di un altro dello stesso tipo: 1 pcb_trace");
      expect(error).toContain(String(pista.pcb_trace_id));
      // this board is drawn in its files (design rules autoroute: false): a compile starts from the files alone
      expect(error).toContain("NON e' certificata per l'export finche' ha elementi in doppio: premi Aggiorna per ricompilarla dai file");
    }
    // a board that is NOT drawn in its files carries the saved copper into every compile: "Aggiorna" is not promised there
    const sbrogliata = { ...FILES, [DESIGN_RULES_PATH]: JSON.stringify({ preset: "custom", rules: { ...JSON.parse(REGOLE).rules, autoroute: true } }) };
    db.files = sbrogliata;
    db.row = { ...riga([...buona, vecchia], CHECKS_ENGINE_VERSION), filesHash: filesHash(sbrogliata), summary: db.saves[0].summary };
    const riportata = await esporta(new Request("http://x/api/export?projectId=p&kind=gerber"));
    expect(riportata.status).toBe(409);
    const testo = ((await riportata.json()) as { error: string }).error;
    expect(testo).toContain("finche' ha elementi in doppio: questa scheda riporta il rame della scheda salvata, quindi Aggiorna puo' non toglierli");
    expect(testo).toContain("va ripulito il rame salvato prima di esportare");
    expect(testo).not.toContain("premi Aggiorna per ricompilarla dai file");
    db.files = FILES;
    db.row = { ...riga([...buona, vecchia], CHECKS_ENGINE_VERSION), summary: db.saves[0].summary };
    // the parts list does not depend on the copper: it still goes
    expect((await esporta(new Request("http://x/api/export?projectId=p&kind=bom"))).status).toBe(200);
    // and the same board without the double is exported
    db.row = { ...riga(buona, CHECKS_ENGINE_VERSION), summary: db.saves[0].summary };
    expect((await esporta(new Request("http://x/api/export?projectId=p&kind=gerber"))).status).toBe(200);
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
    // and while its pours are an older engine's, below the engine that pours from the declared outlines
    const vecchie = { poursFromOlderEngine: colateDiUnMotoreDiPrima([{ type: "pcb_copper_pour" }, { type: "pcb_copper_pour" }], 8) };
    expect(vecchie.poursFromOlderEngine).toMatchObject({ engine: 8, count: 2 });
    expect(motoreDaSalvare(vecchie, 8)).toBe(8);
    expect(motoreDaSalvare(vecchie, 4)).toBe(4);
    expect(motoreDaSalvare(vecchie)).toBe(8);
    expect(motoreDaSalvare({ ...vecchie, ...coperta }, 8)).toBe(ENGINE_VIE_PASSANTI - 1);
    expect(nonCertificata(vecchie)).toMatch(/^le 2 colate della scheda sono state fatte dal motore 8, .* premi Aggiorna per rifarle/);
    expect(colateDiUnMotoreDiPrima([{ type: "pcb_copper_pour" }], CHECKS_ENGINE_VERSION)).toBeNull();
    expect(colateDiUnMotoreDiPrima([{ type: "pcb_board" }], 8)).toBeNull();
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
