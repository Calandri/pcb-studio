import { beforeAll, describe, expect, it, vi } from "vitest";

/*
 * A RIGID-FLEX BOARD COMPILED FOR REAL by tscircuit, and exported by the real
 * route (GET /api/export). The board of flex.test.ts: a rigid part 20 x 20 mm,
 * four layers, and a tail 12 x 20 mm that leaves its bottom edge (y = -10)
 * between x = -6 and x = 6, in one outline. A ground pour with no outline on
 * every layer: tscircuit pours each over the whole piece, tail included.
 *
 * flex.json makes the tail a flexible zone with ONE copper layer, inner1, a
 * window without copper, a cutout, a fold of 180 degrees and a stiffener. What
 * is asked of the compile: the pours of top, inner2 and bottom are cut back
 * from the tail, the one of inner1 goes on into it and stops at the window and
 * around the cutout; of the export: the files of the flexible part, the mask
 * open over the tail, no silkscreen in it. And the same board without
 * flex.json is exported as it always was.
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

import { convertSoupToGerberCommands, stringifyGerberCommandLayers } from "circuit-json-to-gerber";
import JSZip from "jszip";
import { GET as esporta } from "@/app/api/export/route";
import { compileProject, type CompileSummary } from "@/lib/compile";
import { DESIGN_RULES_PATH, resolveDesignRules } from "@/lib/design-rules";
import { CHECKS_ENGINE_VERSION } from "@/lib/engine-version";
import { FILE_COVERLAY, FILE_IRRIGIDITORI, FILE_MECCANICO, FILE_PILA, FLEX_PATH } from "@/lib/flex";
import { ANELLO_DEL_RETINO, conRetino } from "@/lib/flex-retino";
import { flessibileDellaScheda } from "@/lib/flex-zone";
import { senzaRotazioneDiCarico } from "@/lib/gerber-rotation";
import { cuciLaMassa } from "@/lib/ground-stitching";
import { insidePour, readPours } from "@/lib/pours";
import { colateInOrdinePerIlGerber } from "@/lib/pours-recompute";
import { filesHash } from "@/lib/project-store";
import { serigrafiaStampabile } from "@/lib/silk-stroke";
import { comandiConLaMaschera } from "@/lib/solder-mask";
import { viePassantiSuOgniStrato } from "@/lib/via-layers";

const rettangolo = (x1: number, y1: number, x2: number, y2: number): Punto[] => [
  { x: x1, y: y1 },
  { x: x2, y: y1 },
  { x: x2, y: y2 },
  { x: x1, y: y2 },
];
const CODA = rettangolo(-6, -30, 6, -10);
const FINESTRA = rettangolo(-5, -28, -1, -22);
const RITAGLIO = rettangolo(2, -27, 4, -24);

const REGOLE = JSON.stringify({
  preset: "custom",
  rules: { minTraceWidthMm: 0.127, minClearanceMm: 0.152, minBoardEdgeClearanceMm: 0.3, minViaHoleMm: 0.2, minViaDiameterMm: 0.5, pourClearanceMm: 0.2, autoPlaneVias: false, autoroute: false },
});

const MAIN = `export default () => (
  <board outline={[{x:-10,y:-10},{x:-6,y:-10},{x:-6,y:-30},{x:6,y:-30},{x:6,y:-10},{x:10,y:-10},{x:10,y:10},{x:-10,y:10}]} layers={4} thickness="1.6mm" pcbStyle={{ viaHoleDiameter: 0.2, viaPadDiameter: 0.5 }}>
    <net name="GND" />
    <copperpour layer="top" connectsTo="net.GND" />
    <copperpour layer="inner1" connectsTo="net.GND" flottante />
    <copperpour layer="inner2" connectsTo="net.GND" flottante />
    <copperpour layer="bottom" connectsTo="net.GND" flottante />
    <resistor name="R1" resistance="1k" footprint="0402" pcbX={-3} pcbY={4} />
    <resistor name="R2" resistance="1k" footprint="0402" pcbX={3} pcbY={4} />
    <trace from=".R1 > .pin1" to="net.GND" />
    <trace from=".R2 > .pin1" to="net.GND" />
    <silkscreenpath route={[{x:-2,y:7},{x:2,y:7}]} strokeWidth={0.15} layer="top" />
    <silkscreenpath route={[{x:-2,y:-20},{x:2,y:-20}]} strokeWidth={0.15} layer="top" />
  </board>
)
`;

const FLEX = JSON.stringify({
  pila: { spessoreMm: 0.1, coverlay: "giallo", materiali: [{ tipo: "rame", nome: "RA 18um", mm: 0.018 }] },
  zone: [{ nome: "coda", strati: ["inner1"], punti: CODA, finestre: [{ nome: "antenna", punti: FINESTRA }], ritagli: [{ nome: "asola", punti: RITAGLIO }] }],
  pieghe: [{ nome: "ripiega", da: { x: -6, y: -14 }, a: { x: 6, y: -14 }, raggioMm: 1, angolo: 180, verso: "su" }],
  irrigiditori: [{ nome: "rinforzo", lato: "bottom", materiale: "poliimmide", spessoreMm: 0.2, punti: rettangolo(-5.5, -29.5, 5.5, -18) }],
});

interface Compilata {
  files: Record<string, string>;
  circuitJson: El[];
  summary: CompileSummary;
}
/** the same file with the copper of the tail as a grid where it bends: lines of 0,3 every 0,8 at 45 degrees, a millimetre past the curve */
const FLEX_A_GRIGLIA = JSON.stringify({
  ...(JSON.parse(FLEX) as Record<string, unknown>),
  zone: [{ nome: "coda", strati: ["inner1"], punti: CODA, finestre: [{ nome: "antenna", punti: FINESTRA }], ritagli: [{ nome: "asola", punti: RITAGLIO }], retino: { larghezzaMm: 0.3, passoMm: 0.8, angolo: 45, dove: "piega" } }],
});

const compilate: { rigida?: Compilata; flessibile?: Compilata; griglia?: Compilata } = {};
beforeAll(async () => {
  for (const [nome, files] of [
    ["rigida", { "main.tsx": MAIN, [DESIGN_RULES_PATH]: REGOLE }],
    ["flessibile", { "main.tsx": MAIN, [DESIGN_RULES_PATH]: REGOLE, [FLEX_PATH]: FLEX }],
    ["griglia", { "main.tsx": MAIN, [DESIGN_RULES_PATH]: REGOLE, [FLEX_PATH]: FLEX_A_GRIGLIA }],
  ] as Array<["rigida" | "flessibile" | "griglia", Record<string, string>]>) {
    const esito = await compileProject(files);
    compilate[nome] = { files, circuitJson: esito.circuitJson as El[], summary: esito.summary };
  }
}, 300_000);

/** whether a layer has poured copper at a point */
const rameIn = (cj: El[], strato: string, x: number, y: number) => readPours(cj).some((p) => p.layer === strato && insidePour(x, y, p));
const STRATI = ["top", "inner1", "inner2", "bottom"];
const senzaData = (g: string) => g.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, "<data>");

async function esportata(scheda: Compilata): Promise<{ nomi: string[]; testo: (nome: string) => Promise<string> }> {
  db.files = scheda.files;
  db.row = { filesHash: filesHash(scheda.files), circuitJson: scheda.circuitJson, summary: scheda.summary, createdAt: "2026-11-18T10:00:00.000Z", engineVersion: CHECKS_ENGINE_VERSION, base: null };
  const risposta = await esporta(new Request("http://x/api/export?projectId=p&kind=gerber"));
  expect(risposta.status).toBe(200);
  const zip = await JSZip.loadAsync(await risposta.arrayBuffer());
  return { nomi: Object.keys(zip.files).sort(), testo: (nome) => zip.file(nome)!.async("string") };
}

/** every y a Gerber layer writes a coordinate at, in millimetres */
const ordinate = (g: string) => [...g.matchAll(/X-?\d+Y(-?\d+)D0[123]\*/g)].map((m) => Number(m[1]) / 1e6);

describe("the board without flex.json: a rigid board with an odd outline, as before", () => {
  it("tscircuit pours every layer over the whole piece, tail included, and no check of the zones exists", () => {
    const { circuitJson, summary } = compilate.rigida!;
    for (const strato of STRATI) expect(rameIn(circuitJson, strato, 0, -20), strato).toBe(true);
    expect(flessibileDellaScheda(circuitJson)).toBeNull();
    expect(circuitJson.some((e) => e.type.startsWith("pcb_flex_") || e.type === "pcb_cutout")).toBe(false);
    expect(summary.drcViolations.filter((v) => v.rule.startsWith("flex_"))).toEqual([]);
    expect(summary.prcViolations.filter((v) => v.rule === "flex_zone")).toEqual([]);
  });

  it("is exported with the files it always had, each written as the export wrote it before the flexible zones existed", async () => {
    const scheda = compilate.rigida!;
    const zip = await esportata(scheda);
    expect(zip.nomi).toEqual(
      ["B_Cu.gbr", "B_Mask.gbr", "B_Paste.gbr", "B_SilkScreen.gbr", "Edge_Cuts.gbr", "F_Cu.gbr", "F_Mask.gbr", "F_Paste.gbr", "F_SilkScreen.gbr", "In1_Cu.gbr", "In2_Cu.gbr", "drill_plated.drl", "drill_unplated.drl"].sort(),
    );
    // the steps of the export as they were in v0.41.0, on the same board
    const inOrdine = await colateInOrdinePerIlGerber(scheda.circuitJson as unknown as Array<Record<string, unknown>>);
    const ruotate = senzaRotazioneDiCarico(
      stringifyGerberCommandLayers(comandiConLaMaschera(viePassantiSuOgniStrato(inOrdine as never) as never, (cj) => convertSoupToGerberCommands(cj as never)) as never),
    );
    const { layers } = serigrafiaStampabile(ruotate.layers);
    for (const [strato, atteso] of Object.entries(layers)) {
      expect(senzaData(await zip.testo(`${strato}.gbr`)), strato).toBe(senzaData(String(atteso)));
    }
  });
});

describe("the same board with flex.json: a one-layer tail folded by 180 degrees", () => {
  it("compiles clean: the zone, the bend, the stiffener and the cutout are on the board and no check of the zones fires", () => {
    const { circuitJson, summary } = compilate.flessibile!;
    expect(summary.errors).toEqual([]);
    const flex = flessibileDellaScheda(circuitJson)!;
    expect(flex.zone.map((z) => [z.nome, z.strati])).toEqual([["coda", ["inner1"]]]);
    expect(flex.pieghe.map((p) => p.angolo)).toEqual([180]);
    expect(flex.irrigiditori).toHaveLength(1);
    expect(circuitJson.filter((e) => e.type === "pcb_cutout").map((e) => e.pcb_cutout_id)).toEqual(["pcb_cutout_flessibile_0_0"]);
    expect(summary.drcViolations.filter((v) => v.rule.startsWith("flex_"))).toEqual([]);
    // the silkscreen stroke drawn on the tail is said: it is not printed there
    const avvisi = summary.prcViolations.filter((v) => v.rule === "flex_zone");
    expect(avvisi.map((a) => a.message).join(" ")).toContain("un disegno di serigrafia entra nella zona flessibile «coda»");
    expect(avvisi.every((a) => a.severity === "warn")).toBe(true);
  });

  it("the pours of the layers the zone does not declare are cut back from it, by the board's edge clearance", () => {
    const cj = compilate.flessibile!.circuitJson;
    for (const strato of ["top", "inner2", "bottom"]) {
      // nowhere in the tail: along its axis, at its corners, next to the line where it starts
      for (const [x, y] of [[0, -20], [0, -10.2], [-5.5, -29.5], [5.5, -11], [-3, -25], [3, -25.5]]) expect(rameIn(cj, strato, x, y), `${strato} ${x};${y}`).toBe(false);
      // and 0,3 mm short of the line, as from an edge of the board: no copper 0,2 above it, copper 0,45 above it
      expect(rameIn(cj, strato, 0, -9.8), strato).toBe(false);
      expect(rameIn(cj, strato, 0, -9.55), strato).toBe(true);
      // beside the tail the edge of the board is where it was
      expect(rameIn(cj, strato, 8, -9.55), strato).toBe(true);
      expect(rameIn(cj, strato, 0, 0), strato).toBe(true);
    }
  });

  it("the pour of the declared layer goes on into the tail, to 0,3 mm from its cut, and stops at the window and around the cutout", () => {
    const cj = compilate.flessibile!.circuitJson;
    // across the line where the rigid part ends, and down the tail
    for (const [x, y] of [[0, -9.8], [0, -10.2], [0, -14], [0, -29.5], [-5.5, -12], [5.5, -29]]) expect(rameIn(cj, "inner1", x, y), `${x};${y}`).toBe(true);
    // the cut of the tail keeps the edge clearance of the board
    expect(rameIn(cj, "inner1", -5.8, -20)).toBe(false);
    expect(rameIn(cj, "inner1", 0, -29.8)).toBe(false);
    // the window: no copper in it, copper right outside it (a window is cut to the line)
    for (const [x, y] of [[-3, -25], [-4.9, -27.9], [-1.1, -22.1]]) expect(rameIn(cj, "inner1", x, y), `finestra ${x};${y}`).toBe(false);
    expect(rameIn(cj, "inner1", -0.9, -25)).toBe(true);
    expect(rameIn(cj, "inner1", -3, -21.9)).toBe(true);
    // the cutout: no copper in it nor within 0,3 mm of it, copper beyond
    for (const [x, y] of [[3, -25.5], [1.8, -25.5], [3, -23.8]]) expect(rameIn(cj, "inner1", x, y), `ritaglio ${x};${y}`).toBe(false);
    expect(rameIn(cj, "inner1", 1.6, -25.5)).toBe(true);
  });

  it("the rigid part is the one of the board without the file, on the layers the tail does not have", () => {
    const rigida = compilate.rigida!.circuitJson;
    const flessibile = compilate.flessibile!.circuitJson;
    // the same copper wherever the rigid part is, a grid of points one millimetre apart, half a millimetre in from its edge
    for (const strato of STRATI) {
      for (let x = -9.5; x <= 9.5; x += 1) {
        for (let y = -9.5; y <= 9.5; y += 1) expect(rameIn(flessibile, strato, x, y), `${strato} ${x};${y}`).toBe(rameIn(rigida, strato, x, y));
      }
    }
    // and everything on the board that is not a pour or of the flexible part is the same: outline, pads, paste, silkscreen, ports
    const altro = (cj: El[]) => cj.filter((e) => e.type.startsWith("pcb_") && e.type !== "pcb_copper_pour" && !e.type.startsWith("pcb_flex_") && e.type !== "pcb_cutout");
    expect(altro(rigida).length).toBeGreaterThan(10);
    expect(altro(flessibile)).toEqual(altro(rigida));
  });

  it("the export adds the files of the flexible part and cuts mask and silkscreen out of the tail", async () => {
    const zip = await esportata(compilate.flessibile!);
    const rigida = await esportata(compilate.rigida!);
    // the stiffener is on the bottom: no file for the top
    expect(zip.nomi).toEqual([...rigida.nomi, FILE_MECCANICO, FILE_COVERLAY.top, FILE_COVERLAY.bottom, FILE_IRRIGIDITORI.bottom, FILE_PILA].sort());
    // paste and drill are the board's; the copper of the layers the tail does not have stops above it
    for (const nome of ["F_Paste.gbr", "B_Paste.gbr", "drill_plated.drl", "drill_unplated.drl"]) {
      expect(senzaData(await zip.testo(nome)), nome).toBe(senzaData(await rigida.testo(nome)));
    }
    for (const nome of ["F_Cu.gbr", "In2_Cu.gbr", "B_Cu.gbr"]) {
      expect(Math.min(...ordinate(await zip.testo(nome))), nome).toBeGreaterThan(-9.75);
      expect(Math.min(...ordinate(await rigida.testo(nome))), nome).toBeLessThan(-29);
    }
    expect(Math.min(...ordinate(await zip.testo("In1_Cu.gbr")))).toBeCloseTo(-29.7, 2);
    // the mask of both faces: the zone as one opening, down to the end of the tail
    for (const nome of ["F_Mask.gbr", "B_Mask.gbr"]) {
      const maschera = await zip.testo(nome);
      expect((maschera.match(/G36\*/g) ?? []).length, nome).toBe(((await rigida.testo(nome)).match(/G36\*/g) ?? []).length + 1);
      expect(Math.min(...ordinate(maschera)), nome).toBe(-30);
    }
    // the silkscreen: the stroke of the rigid part stays, the one on the tail is gone
    const seri = await zip.testo("F_SilkScreen.gbr");
    expect(ordinate(seri)).toContain(7);
    expect(ordinate(seri)).not.toContain(-20);
    expect(ordinate(await rigida.testo("F_SilkScreen.gbr"))).toContain(-20);
    // the outline: the same one, and the cutout of the tail with it
    const bordo = await zip.testo("Edge_Cuts.gbr");
    expect(bordo).toContain(senzaData(await rigida.testo("Edge_Cuts.gbr")).split("\n").filter((r) => /D0[12]\*$/.test(r)).join("\n"));
    expect(bordo).toMatch(/X0*2000000Y-0*27000000D0[12]\*/);
    // and the files of the flexible part say what the file said
    expect(await zip.testo(FILE_MECCANICO)).toContain("X-6000000Y-14000000D02*");
    expect(await zip.testo(FILE_COVERLAY.top)).toContain("G36*");
    expect(await zip.testo(FILE_IRRIGIDITORI.bottom)).toContain("X-5500000Y-29500000D02*");
    const testo = await zip.testo(FILE_PILA);
    expect(testo).toContain("Project: p");
    expect(testo).toContain('Zone 1 "coda": copper layers of the board that continue in the zone: Inner 1 (1).');
    expect(testo).toContain("angle 180 degrees (folded back over the board)");
    expect(testo).toContain('"rinforzo": bottom side, polyimide (PI), 0.2 mm thick');
  });

  it("Cuci la massa proposes no via in the tail, nor within the project's distance of it", () => {
    const { files, circuitJson } = compilate.flessibile!;
    const e = cuciLaMassa(circuitJson, resolveDesignRules(files).rules, { bordo: false, passoMm: 1 });
    if (!e.ok) throw new Error(e.errore);
    expect(e.vie.length).toBeGreaterThan(20);
    // ring of 0,5 at least: its copper 0,5 mm from the line where the tail starts, between x = -6 and 6
    for (const v of e.vie) {
      if (Math.abs(v.x) <= 6) expect(v.y, `via a ${v.x};${v.y}`).toBeGreaterThanOrEqual(-10 + 0.5 + 0.25 - 1e-9);
      expect(v.y).toBeGreaterThan(-10);
    }
    expect(e.scarti.zona_flessibile ?? 0).toBeGreaterThan(0);
  });
});

describe("the same tail with its copper as a grid where it bends (retino)", () => {
  type Anello = { vertices: Punto[] } & Record<string, unknown>;
  const quadratiDi = (cj: El[]) =>
    cj
      .filter((e) => e.type === "pcb_copper_pour")
      .flatMap((e) => ((e.brep_shape as { inner_rings?: Anello[] }).inner_rings ?? []).filter((a) => a[ANELLO_DEL_RETINO] === true).map((a) => ({ strato: String(e.layer), punti: a.vertices })));
  const centro = (v: Punto[]) => ({ x: v.reduce((t, p) => t + p.x, 0) / v.length, y: v.reduce((t, p) => t + p.y, 0) / v.length });

  it("the grid is cut in the pour of inner1 only, around the fold, and the zone says how many squares", () => {
    const cj = compilate.griglia!.circuitJson;
    const q = quadratiDi(cj);
    expect(q.length).toBeGreaterThan(50);
    expect(new Set(q.map((x) => x.strato))).toEqual(new Set(["inner1"]));
    expect(flessibileDellaScheda(cj)!.zone[0].retino).toMatchObject({ aperture: q.length, dove: "piega", margineMm: 1 });
    // the fold curves from y = -12,35 to -15,65: with a millimetre of margin the squares stand between -11,35 and -16,65
    for (const { punti } of q) {
      for (const p of punti) {
        expect(p.y).toBeLessThanOrEqual(-11.35 + 1e-3);
        expect(p.y).toBeGreaterThanOrEqual(-16.65 - 1e-3);
        expect(Math.abs(p.x)).toBeLessThanOrEqual(5.4 + 1e-6);
      }
    }
    // no copper in the middle of a square, copper on the lines around it: a tenth of a millimetre past each of its corners
    for (const { punti } of q.slice(0, 40)) {
      const c = centro(punti);
      expect(rameIn(cj, "inner1", c.x, c.y)).toBe(false);
      for (const p of punti) {
        const l = Math.hypot(p.x - c.x, p.y - c.y);
        expect(rameIn(cj, "inner1", p.x + ((p.x - c.x) / l) * 0.1, p.y + ((p.y - c.y) / l) * 0.1), `${p.x};${p.y}`).toBe(true);
      }
    }
    // below the fold and above it the tail is solid, as it was
    for (const [x, y] of [[0, -18], [0.5, -21], [5, -29], [0, -10.5]]) expect(rameIn(cj, "inner1", x, y), `${x};${y}`).toBe(true);
  });

  it("the copper is one piece as before: the same pours, nothing open, no island, no check of the zones", () => {
    const piena = compilate.flessibile!;
    const griglia = compilate.griglia!;
    const colate = (cj: El[]) => cj.filter((e) => e.type === "pcb_copper_pour").map((e) => `${String(e.layer)}:${String(e.pcb_copper_pour_id)}`).sort();
    expect(colate(griglia.circuitJson)).toEqual(colate(piena.circuitJson));
    // the outline of every pour and every hole it had are the ones of the solid tail: the grid only adds its squares
    const forme = (cj: El[]) =>
      cj
        .filter((e) => e.type === "pcb_copper_pour")
        .map((e) => {
          const f = e.brep_shape as { outer_ring: unknown; inner_rings?: Anello[] };
          return { id: e.pcb_copper_pour_id, esterno: f.outer_ring, buchi: (f.inner_rings ?? []).filter((a) => a[ANELLO_DEL_RETINO] !== true) };
        });
    expect(forme(griglia.circuitJson)).toEqual(forme(piena.circuitJson));
    expect(griglia.summary.errors).toEqual([]);
    expect(griglia.summary.unroutedTotal ?? griglia.summary.unroutedConnections.length).toBe(piena.summary.unroutedTotal ?? piena.summary.unroutedConnections.length);
    expect(griglia.summary.unroutedConnections).toEqual(piena.summary.unroutedConnections);
    expect(griglia.summary.prcViolations.map((v) => v.rule)).toEqual(piena.summary.prcViolations.map((v) => v.rule));
    expect(griglia.summary.drcViolations.map((v) => v.rule)).toEqual(piena.summary.drcViolations.map((v) => v.rule));
    expect(griglia.summary.poursTooClose).toEqual(piena.summary.poursTooClose);
  });

  it("laid again on the board it is on, as a recheck does, it is the same board", () => {
    const { circuitJson, files } = compilate.griglia!;
    expect(conRetino(circuitJson, resolveDesignRules(files).rules.minTraceWidthMm)).toEqual(circuitJson);
  });

  it("the export writes it in In1_Cu, a clear region per square, and every other file is the one of the solid tail", async () => {
    const zip = await esportata(compilate.griglia!);
    const piena = await esportata(compilate.flessibile!);
    expect(zip.nomi).toEqual(piena.nomi);
    const regioni = (g: string) => (g.match(/G36\*/g) ?? []).length;
    const quanti = quadratiDi(compilate.griglia!.circuitJson).length;
    expect(regioni(await zip.testo("In1_Cu.gbr"))).toBe(regioni(await piena.testo("In1_Cu.gbr")) + quanti);
    for (const nome of zip.nomi) {
      if (nome === "In1_Cu.gbr" || nome === FILE_PILA) continue;
      expect(senzaData(await zip.testo(nome)), nome).toBe(senzaData(await piena.testo(nome)));
    }
    expect(await zip.testo(FILE_PILA)).toContain("Copper: cross-hatched (grid), not solid, in the bend area and 1 mm beyond it on each side; solid elsewhere. Lines 0.3 mm wide, pitch 0.8 mm, at 45 degrees");
    expect(await piena.testo(FILE_PILA)).not.toContain("cross-hatched");
  });
});
