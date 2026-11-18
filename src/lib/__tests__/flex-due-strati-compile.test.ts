import { beforeAll, describe, expect, it, vi } from "vitest";

/*
 * DUE STRATI FLESSIBILI COMPILATI DAVVERO da tscircuit ed esportati dalla
 * route vera. Parte rigida 20 x 20, quattro strati; dal bordo basso (y = -10)
 * escono la coda A sul foglio con inner2 (x -8..1,75, fino a y -32) e la coda B
 * sul foglio con inner1 (x 2,25..8, poi a L fino a x -12 fra y -34 e -31, sotto
 * la coda A): spianate si sovrappongono. Il contorno e' tutto il materiale; la
 * fessura fra le code (x 1,75..2,25, chiusa in fondo dalla L) e' un <cutout>.
 * Colate di massa senza contorno su ogni strato.
 */
type Punto = { x: number; y: number };
type El = Record<string, unknown> & { type: string };

const db = vi.hoisted(() => ({
  row: null as null | { filesHash: string; circuitJson: unknown[]; summary: unknown; createdAt: string; engineVersion: number; base: null },
  files: {} as Record<string, string>,
}));
vi.mock("@/lib/acl", () => ({ requireProjectAccess: vi.fn(async () => ({ viewer: null, ok: true })) }));
vi.mock("@/lib/agent-tools", () => ({ withLibrary: vi.fn(async (f: Record<string, string>) => f) }));
vi.mock("@/lib/project-store", async (originale) => {
  const vero = await originale<typeof import("@/lib/project-store")>();
  return { ...vero, getProject: vi.fn(async () => db.files), getCompileCache: vi.fn(async () => db.row) };
});

import JSZip from "jszip";
import { GET as esporta } from "@/app/api/export/route";
import { compileProject, type CompileSummary } from "@/lib/compile";
import { DESIGN_RULES_PATH } from "@/lib/design-rules";
import { CHECKS_ENGINE_VERSION } from "@/lib/engine-version";
import { fileDelloStrato, FILE_COVERLAY, FILE_PILA, FLEX_PATH } from "@/lib/flex";
import { flessibileDellaScheda } from "@/lib/flex-zone";
import { insidePour, readPours } from "@/lib/pours";
import { filesHash } from "@/lib/project-store";

const R = (x1: number, y1: number, x2: number, y2: number): Punto[] => [
  { x: x1, y: y1 },
  { x: x2, y: y1 },
  { x: x2, y: y2 },
  { x: x1, y: y2 },
];
const pt = (p: Punto[]) => `[${p.map((q) => `{x:${q.x},y:${q.y}}`).join(",")}]`;
const CONTORNO: Punto[] = [
  { x: -10, y: 10 },
  { x: -10, y: -10 },
  { x: -8, y: -10 },
  { x: -8, y: -31 },
  { x: -12, y: -31 },
  { x: -12, y: -34 },
  { x: 8, y: -34 },
  { x: 8, y: -10 },
  { x: 10, y: -10 },
  { x: 10, y: 10 },
];
const CODA_A = R(-8, -32, 1.75, -10);
const CODA_B: Punto[] = [
  { x: 2.25, y: -10 },
  { x: 8, y: -10 },
  { x: 8, y: -34 },
  { x: -12, y: -34 },
  { x: -12, y: -31 },
  { x: 2.25, y: -31 },
];

const REGOLE = JSON.stringify({
  preset: "custom",
  rules: { minTraceWidthMm: 0.127, minClearanceMm: 0.152, minBoardEdgeClearanceMm: 0.3, minViaHoleMm: 0.2, minViaDiameterMm: 0.5, pourClearanceMm: 0.2, autoPlaneVias: false, autoroute: false },
});
const MAIN = `export default () => (
  <board outline={${pt(CONTORNO)}} layers={4} thickness="1.6mm" pcbStyle={{ viaHoleDiameter: 0.2, viaPadDiameter: 0.5 }}>
    <net name="GND" />
    <copperpour layer="top" connectsTo="net.GND" />
    <copperpour layer="inner1" connectsTo="net.GND" flottante />
    <copperpour layer="inner2" connectsTo="net.GND" flottante />
    <copperpour layer="bottom" connectsTo="net.GND" flottante />
    <cutout shape="polygon" points={${pt(R(1.75, -31, 2.25, -10))}} />
    <resistor name="R1" resistance="1k" footprint="0402" pcbX={-3} pcbY={4} />
    <trace from=".R1 > .pin1" to="net.GND" />
  </board>
)
`;
const FLEX = JSON.stringify({
  pila: { spessoreMm: 0.1, coverlay: "giallo", flessibili: [{ nome: "foglio A", strati: ["inner2"] }, { nome: "foglio B", strati: ["inner1"] }] },
  zone: [
    { nome: "coda A", flessibile: "foglio A", punti: CODA_A },
    { nome: "coda B", flessibile: "foglio B", punti: CODA_B },
  ],
  pieghe: [
    { nome: "A1", zona: "coda A", da: { x: -8, y: -13 }, a: { x: 1.75, y: -13 }, raggioMm: 2.2, angolo: 90, verso: "su" },
    { nome: "A2", zona: "coda A", da: { x: -8, y: -19 }, a: { x: 1.75, y: -19 }, raggioMm: 2.2, angolo: 90, verso: "su" },
    { nome: "B1", zona: "coda B", da: { x: 2.25, y: -13 }, a: { x: 8, y: -13 }, raggioMm: 2.2, angolo: 90, verso: "su" },
  ],
});

let scheda: { files: Record<string, string>; circuitJson: El[]; summary: CompileSummary };
beforeAll(async () => {
  const files = { "main.tsx": MAIN, [DESIGN_RULES_PATH]: REGOLE, [FLEX_PATH]: FLEX };
  const esito = await compileProject(files);
  scheda = { files, circuitJson: esito.circuitJson as El[], summary: esito.summary };
}, 300_000);

const rameIn = (strato: string, x: number, y: number) => readPours(scheda.circuitJson).some((p) => p.layer === strato && insidePour(x, y, p));

describe("due code di due fogli, compilate davvero", () => {
  it("compila pulita: due zone col loro foglio, tre pieghe, nessun controllo della parte flessibile scatta", () => {
    expect(scheda.summary.errors).toEqual([]);
    const flex = flessibileDellaScheda(scheda.circuitJson)!;
    expect(flex.zone.map((z) => [z.nome, z.flessibile, z.strati])).toEqual([
      ["coda A", "foglio A", ["inner2"]],
      ["coda B", "foglio B", ["inner1"]],
    ]);
    expect(flex.pieghe.map((p) => [p.nome, p.zona?.nome])).toEqual([
      ["A1", "coda A"],
      ["A2", "coda A"],
      ["B1", "coda B"],
    ]);
    expect(scheda.summary.drcViolations.filter((v) => v.rule.startsWith("flex_"))).toEqual([]);
  });

  it("il rame di ogni strato sta nella coda del suo foglio, anche dove le due code si sovrappongono", () => {
    // inner2 (coda A): nella coda A e nella parte comune, non nella coda B sola
    expect(rameIn("inner2", -4, -25)).toBe(true);
    expect(rameIn("inner2", -4, -31.5)).toBe(true);
    expect(rameIn("inner2", 5, -25)).toBe(false);
    expect(rameIn("inner2", -10.5, -32.5)).toBe(false);
    // inner1 (coda B): il contrario
    expect(rameIn("inner1", 5, -25)).toBe(true);
    expect(rameIn("inner1", -4, -31.5)).toBe(true);
    expect(rameIn("inner1", -10.5, -32.5)).toBe(true);
    expect(rameIn("inner1", -4, -25)).toBe(false);
    // top e bottom finiscono dove comincia la parte flessibile
    for (const s of ["top", "bottom"]) {
      expect(rameIn(s, 0, 0), s).toBe(true);
      expect(rameIn(s, -4, -25), s).toBe(false);
      expect(rameIn(s, 5, -25), s).toBe(false);
    }
  });

  it("l'export ha un profilo e un coverlay per foglio, la pila coi due fogli, e la fessura su Edge_Cuts", async () => {
    db.files = scheda.files;
    db.row = { filesHash: filesHash(scheda.files), circuitJson: scheda.circuitJson, summary: scheda.summary, createdAt: "2026-11-18T10:00:00.000Z", engineVersion: CHECKS_ENGINE_VERSION, base: null };
    const risposta = await esporta(new Request("http://x/api/export?projectId=p&kind=gerber"));
    expect(risposta.status).toBe(200);
    const zip = await JSZip.loadAsync(await risposta.arrayBuffer());
    const nomi = Object.keys(zip.files);
    for (const k of [1, 2]) {
      expect(nomi).toContain(fileDelloStrato(k).profilo);
      expect(nomi).toContain(fileDelloStrato(k).coverlay.top);
    }
    expect(nomi).not.toContain(FILE_COVERLAY.top);
    expect(await zip.file(FILE_PILA)!.async("string")).toContain("INDEPENDENT FLEXIBLE LAYERS (AIR GAP)");
    const bordo = await zip.file("Edge_Cuts.gbr")!.async("string");
    // la fessura fra le code: un buco del contorno
    expect(bordo).toMatch(/X0*2250000Y-31000000D0[12]\*/);
  });
});
