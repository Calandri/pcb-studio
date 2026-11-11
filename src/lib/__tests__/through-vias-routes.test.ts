import { beforeEach, describe, expect, it, vi } from "vitest";
import { runTscircuitCode } from "@tscircuit/eval";

/*
 * sbb-dl-principale, 2026-11-11: the saved board had 32 vias written on the two
 * layers their trace joins, the inner1 ground plane closed over 20 of them, and
 * the board was exportable. Three routes save a board they did not compile:
 * they take it from the cache, and no board leaves them with such a via. The
 * recheck is the one that files a board under today's engine, so it is also
 * the one that has to pour its planes again.
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

import { POST as acceptBoard } from "@/app/api/accept-board/route";
import { POST as recheck } from "@/app/api/recheck/route";
import { POST as trace } from "@/app/api/trace/route";
import { DESIGN_RULES_PATH } from "@/lib/design-rules";
import { CHECKS_ENGINE_VERSION, ENGINE_VIE_PASSANTI } from "@/lib/engine-version";
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
  }, 120_000);

  it("the board of the older engine is what the bug looked like", () => {
    expect(giuDi(salvata).layers).toEqual(["inner2", "bottom"]);
    expect(dalRame(salvata, "inner1", giuDi(salvata))).toBe(0);
  });

  it("recheck: the vias are completed, the planes are poured again and only then the board is filed under today's engine", async () => {
    const r = await recheck(post({ projectId: "p" }));
    const risposta = (await r.json()) as { ok: boolean; pianiRicolati?: boolean; vieParziali?: number; previousEngineVersion: number; summary: { drcViolations: Array<{ rule: string }> } };
    expect(r.status).toBe(200);
    expect(risposta).toMatchObject({ ok: true, pianiRicolati: true, vieParziali: 2, previousEngineVersion: ENGINE_VIE_PASSANTI - 1 });
    const [s] = db.saves;
    expect(s.engine).toBe(CHECKS_ENGINE_VERSION);
    for (const v of vie(s.circuitJson)) expect(v.layers).toEqual(QUATTRO);
    expect([giuDi(s.circuitJson).from_layer, giuDi(s.circuitJson).to_layer]).toEqual(["inner2", "bottom"]);
    expect(dalRame(s.circuitJson as El[], "inner1", giuDi(s.circuitJson))).toBeGreaterThanOrEqual(0.152 - 0.01);
    expect(risposta.summary.drcViolations.filter((v) => v.rule === "pour_clearance")).toEqual([]);
  }, 120_000);

  it("recheck: a board whose vias all listed the four layers keeps the planes it has", async () => {
    // the same board with its vias on every layer, as tscircuit writes one that goes from top to bottom
    const intere = salvata.map((e) => (e.type === "pcb_via" ? { ...e, layers: QUATTRO, from_layer: "top", to_layer: "bottom" } : e));
    db.row = riga(intere, ENGINE_VIE_PASSANTI - 1);
    const r = await recheck(post({ projectId: "p" }));
    const risposta = (await r.json()) as { ok: boolean; pianiRicolati?: boolean; summary: { drcViolations: Array<{ rule: string }> } };
    expect(risposta.ok).toBe(true);
    expect(risposta.pianiRicolati).toBeUndefined();
    const [s] = db.saves;
    // nothing was poured: the plane is still the one piece without openings it went in with, and the new rule says so
    const piani = (s.circuitJson as El[]).filter((e) => e.type === "pcb_copper_pour" && e.layer === "inner1");
    expect(piani).toHaveLength(1);
    expect(piani[0].brep_shape!.inner_rings ?? []).toHaveLength(0);
    expect(vie(s.circuitJson).map((v) => v.declared_layers)).toEqual([undefined, undefined]);
    expect(risposta.summary.drcViolations.some((v) => v.rule === "pour_clearance")).toBe(true);
  }, 120_000);

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
