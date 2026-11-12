import { beforeAll, describe, expect, it, vi } from "vitest";

/*
 * Una scheda a 6 e una a 8 strati di rame, compilate DAVVERO da tscircuit, con
 * una pista su ogni strato e una colata di massa su ogni strato. Tre domande:
 *  1. che nomi scrive il Circuit JSON per gli strati interni (ci si aspettava
 *     inner1..inner4 e inner1..inner6, e nessuno l'aveva verificato);
 *  2. i controlli della compilazione dicono il vero su quegli strati;
 *  3. l'export, per la strada vera (la route /api/export), scrive un file di
 *     rame per strato, e ogni pista sta nel file del suo strato.
 *
 * LA SCHEDA. Larga 30 mm. Una riga per strato, a passo 2,2 mm da y = -8: sulla
 * riga i (0 = top, l'ultima = bottom) R(i+1) a x = -10 e Q(i+1) a x = +10,
 * resistenze 0402, e la pista da R.pin2 a Q.pin1 scritta a mano: parte sul
 * top, scende con una via a x = -9 sullo strato della riga, corre fino a
 * x = +8, risale con una via sul top (il pcbPath e' relativo al pezzo, a
 * x = -10: 1 e 18 sono -9 e +8). La riga 0 resta tutta sul top, senza vie. Le
 * vie sono quindi 2 per ogni strato che non e' il top: 2 x (n - 1).
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
import { DESIGN_RULES_PATH, resolveDesignRules } from "@/lib/design-rules";
import { CHECKS_ENGINE_VERSION } from "@/lib/engine-version";
import { cuciLaMassa } from "@/lib/ground-stitching";
import { MANUAL_EDITS_PATH } from "@/lib/manual-edits";
import { filesHash } from "@/lib/project-store";

const PILA: Record<number, string[]> = {
  4: ["top", "inner1", "inner2", "bottom"],
  6: ["top", "inner1", "inner2", "inner3", "inner4", "bottom"],
  8: ["top", "inner1", "inner2", "inner3", "inner4", "inner5", "inner6", "bottom"],
};
const PASSO = 2.2;
const yDi = (i: number) => -8 + i * PASSO;
/** where the vias of every row are, and so where the run on the row's layer starts and ends */
const X_GIU = -9;
const X_SU = 8;

const REGOLE = JSON.stringify({
  preset: "custom",
  rules: { minTraceWidthMm: 0.127, minClearanceMm: 0.152, minViaHoleMm: 0.2, minViaDiameterMm: 0.5, pourClearanceMm: 0.2, autoPlaneVias: false, autoroute: false },
});

const main = (n: number, opzioni: { piste?: boolean } = {}) => {
  const strati = PILA[n];
  const parti = strati
    .map((_, i) => `<resistor name="R${i + 1}" resistance="1k" footprint="0402" pcbX={-10} pcbY={${yDi(i)}} />\n    <resistor name="Q${i + 1}" resistance="1k" footprint="0402" pcbX={10} pcbY={${yDi(i)}} />`)
    .join("\n    ");
  const piste = strati
    .map((s, i) => {
      const capi = `from=".R${i + 1} > .pin2" to=".Q${i + 1} > .pin1"`;
      if (opzioni.piste === false) return `<trace ${capi} />`;
      const percorso =
        s === "top"
          ? `[{ x: 1, y: 0 }, { x: 18, y: 0 }]`
          : `[{ x: 1, y: 0 }, { x: 1, y: 0, via: true, fromLayer: "top", toLayer: "${s}" }, { x: 1, y: 0 }, { x: 18, y: 0 }, { x: 18, y: 0, via: true, fromLayer: "${s}", toLayer: "top" }, { x: 18, y: 0 }]`;
      return `<trace ${capi} pcbPathRelativeTo=".R${i + 1} > .pin2" pcbPath={${percorso}} thickness="0.2mm" />`;
    })
    .join("\n    ");
  return `export default () => (
  <board width="30mm" height="${n * PASSO + 8}mm" layers={${n}} thickness="1.6mm" pcbStyle={{ viaHoleDiameter: 0.2, viaPadDiameter: 0.5 }}>
    <net name="GND" />
    ${strati.map((s) => `<copperpour layer="${s}" connectsTo="net.GND" />`).join("\n    ")}
    ${parti}
    ${piste}
    ${strati.map((_, i) => `<trace from=".R${i + 1} > .pin1" to="net.GND" />`).join("\n    ")}
  </board>
)
`;
};
const filesDi = (n: number) => ({ "main.tsx": main(n), [DESIGN_RULES_PATH]: REGOLE });

const compilate = new Map<number, { files: Record<string, string>; circuitJson: El[]; summary: CompileSummary }>();
beforeAll(async () => {
  for (const n of [6, 8]) {
    const files = filesDi(n);
    const esito = await compileProject(files);
    compilate.set(n, { files, circuitJson: esito.circuitJson as El[], summary: esito.summary });
  }
}, 240_000);

/** the layers the copper of a trace runs on, in the order it meets them */
const stratiDi = (pista: El) => {
  const out: string[] = [];
  for (const p of pista.route as Array<{ route_type: string; layer?: string }>) {
    if (p.route_type === "wire" && p.layer && out.at(-1) !== p.layer) out.push(p.layer);
  }
  return out;
};
const vicino = (a: number, b: number) => Math.abs(a - b) < 1e-4;

describe.each([6, 8])("una scheda a %i strati compilata da tscircuit", (n) => {
  const pila = PILA[n];
  const scheda = () => compilate.get(n)!;

  it("il Circuit JSON chiama gli interni inner1..inner(n-2), in ordine, e non conosce altri nomi", () => {
    const cj = scheda().circuitJson;
    const board = cj.find((e) => e.type === "pcb_board")!;
    expect(board.num_layers).toBe(n);
    expect(board.thickness).toBe(1.6);
    // every name a piece of copper is written with: the wires of the traces, the vias, the pours
    const nomi = new Set<string>();
    for (const e of cj) {
      if (e.type === "pcb_trace") for (const p of e.route as Array<{ layer?: string; from_layer?: string; to_layer?: string }>) for (const l of [p.layer, p.from_layer, p.to_layer]) if (l) nomi.add(l);
      if (e.type === "pcb_via") for (const l of e.layers as string[]) nomi.add(l);
      if (e.type === "pcb_copper_pour") nomi.add(String(e.layer));
    }
    expect([...nomi].sort()).toEqual([...pila].sort());
  });

  it("ogni pista corre sul suo strato, fra due vie che attraversano tutta la pila", () => {
    const cj = scheda().circuitJson;
    const piste = cj.filter((e) => e.type === "pcb_trace");
    expect(piste).toHaveLength(n);
    // the top row stays on the top; every other goes down to its layer and comes back
    expect(piste.map(stratiDi).sort()).toEqual(pila.map((s) => (s === "top" ? ["top"] : ["top", s, "top"])).sort());
    const vie = cj.filter((e) => e.type === "pcb_via") as Array<El & { x: number; y: number; layers: string[] }>;
    expect(vie).toHaveLength(2 * (n - 1));
    for (const v of vie) expect([...v.layers].sort()).toEqual([...pila].sort());
    // two per row, at x = -9 and x = +8, on every row but the top's
    const attese = pila.slice(1).flatMap((_, k) => [X_GIU, X_SU].map((x) => `${x};${yDi(k + 1).toFixed(3)}`));
    expect(vie.map((v) => `${v.x};${v.y.toFixed(3)}`).sort()).toEqual(attese.sort());
  });

  it("i controlli: nessun errore, nessuna violazione, niente di aperto, e una colata su ogni strato aperta attorno al rame delle altre reti", () => {
    const { summary, circuitJson } = scheda();
    expect(summary.errors).toEqual([]);
    expect(summary.drcViolations).toEqual([]);
    expect(summary.prcViolations).toEqual([]);
    expect(summary.unroutedTotal ?? summary.unroutedConnections.length).toBe(0);
    expect(summary.planesOverVias).toBeUndefined();
    expect(summary.poursTooClose).toBeUndefined();
    const colate = circuitJson.filter((e) => e.type === "pcb_copper_pour") as Array<El & { layer: string; brep_shape: { inner_rings?: unknown[] } }>;
    expect(colate.map((c) => c.layer).sort()).toEqual([...pila].sort());
    /*
     * Below the top the copper of the other nets on a layer is the 2 x (n - 1)
     * vias and, on the layers that have one, the trace of that row, which joins
     * its two vias into one obstacle: 2 x (n - 1) - 2 + 1 = 2n - 3 openings.
     */
    for (const c of colate.filter((q) => q.layer !== "top")) expect((c.brep_shape.inner_rings ?? []).length, c.layer).toBe(2 * n - 3);
  });

  it("Cuci la massa propone vie che stanno lontane dalla pista di ogni strato interno", () => {
    const { files, circuitJson } = scheda();
    const regole = resolveDesignRules(files).rules;
    const e = cuciLaMassa(circuitJson, regole, { bordo: false, passoMm: 1 });
    if (!e.ok) throw new Error(e.errore);
    expect(e.vie.length).toBeGreaterThan(50);
    /*
     * Between the two vias of a row its trace runs along y of the row, 0,2 wide:
     * from the ring of a new via (radius 0,25) to the edge of the trace (0,1) at
     * least the pour clearance of the project, 0,2. So 0,55 between the centres.
     */
    for (const v of e.vie.filter((q) => q.x >= X_GIU && q.x <= X_SU)) {
      for (let i = 0; i < n; i++) expect(Math.abs(v.y - yDi(i)), `via a ${v.x};${v.y}, riga ${i}`).toBeGreaterThanOrEqual(0.55 - 1e-9);
    }
    // and there are vias between the rows of the inner layers, not only outside them
    expect(e.vie.some((v) => v.y > yDi(2) && v.y < yDi(n - 2))).toBe(true);
  });

  it(`l'export scrive ${n} file di rame, ogni pista nel file del suo strato, e la foratura con tutte le vie`, async () => {
    const { files, circuitJson, summary } = scheda();
    db.files = files;
    db.row = { filesHash: filesHash(files), circuitJson, summary, createdAt: "2026-11-12T10:00:00.000Z", engineVersion: CHECKS_ENGINE_VERSION, base: null };
    const risposta = await esporta(new Request("http://x/api/export?projectId=p&kind=gerber"));
    expect(risposta.status).toBe(200);
    const zip = await JSZip.loadAsync(await risposta.arrayBuffer());
    const nomi = Object.keys(zip.files).sort();
    const testo = (nome: string) => zip.file(nome)!.async("string");

    // one copper file per layer: the two faces and In1..In(n-2)
    const rame = ["F_Cu.gbr", ...Array.from({ length: n - 2 }, (_, k) => `In${k + 1}_Cu.gbr`), "B_Cu.gbr"];
    expect(nomi.filter((f) => f.endsWith("_Cu.gbr")).sort()).toEqual([...rame].sort());
    // and the others as on every board: mask, paste and silkscreen of the two faces, the outline, the two drill files
    expect(nomi.filter((f) => !f.endsWith("_Cu.gbr"))).toEqual(
      ["B_Mask.gbr", "B_Paste.gbr", "B_SilkScreen.gbr", "Edge_Cuts.gbr", "F_Mask.gbr", "F_Paste.gbr", "F_SilkScreen.gbr", "drill_plated.drl", "drill_unplated.drl"],
    );

    /** what a copper file draws outside its regions (the pours): the straight runs and the flashes, in mm */
    const disegno = (gbr: string) => {
      // 4.6 format, millimetres: the integers of the file are millionths of a millimetre
      expect(gbr).toContain("%FSLAX46Y46*%");
      expect(gbr).toContain("%MOMM*%");
      const tratti: Array<{ a: Punto; b: Punto }> = [];
      const colpi: Punto[] = [];
      let p: Punto = { x: 0, y: 0 };
      let inRegione = false;
      let regioni = 0;
      for (const riga of gbr.split("\n")) {
        if (riga.startsWith("G36")) {
          inRegione = true;
          regioni++;
        } else if (riga.startsWith("G37")) inRegione = false;
        const m = /^(?:X(-?\d+))?(?:Y(-?\d+))?D0([123])\*$/.exec(riga.trim());
        if (!m) continue;
        const q = { x: m[1] !== undefined ? Number(m[1]) / 1e6 : p.x, y: m[2] !== undefined ? Number(m[2]) / 1e6 : p.y };
        if (!inRegione && m[3] === "1") tratti.push({ a: p, b: q });
        if (!inRegione && m[3] === "3") colpi.push(q);
        p = q;
      }
      return { tratti, colpi, regioni };
    };
    const disegni = new Map<string, ReturnType<typeof disegno>>();
    for (const f of rame) disegni.set(f, disegno(await testo(f)));

    for (const [i, f] of rame.entries()) {
      const gbr = await testo(f);
      // the file says which layer of the stack it is: L1 the top, Ln the bottom, the inner ones between
      expect(gbr).toContain(`%TF.FileFunction,Copper,L${i + 1},${i === 0 ? "Top" : i === n - 1 ? "Bot" : "Inr"}*%`);
      // its pour is in it
      expect(disegni.get(f)!.regioni, f).toBeGreaterThan(0);
      // the run of row i, from the via at -9 to the via at +8 along y of the row: in this file and in no other
      const corsa = (d: ReturnType<typeof disegno>) =>
        d.tratti.some((t) => vicino(t.a.y, yDi(i)) && vicino(t.b.y, yDi(i)) && vicino(Math.min(t.a.x, t.b.x), X_GIU) && vicino(Math.max(t.a.x, t.b.x), X_SU));
      for (const g of rame) expect(corsa(disegni.get(g)!), `la pista della riga ${i} nel file ${g}`).toBe(g === f);
    }

    // the pads of the two vias of an inner row: on the two faces and on the inner layer its trace runs on, not on the other inner rows' layers
    const colpito = (f: string, x: number, y: number) => disegni.get(f)!.colpi.some((c) => vicino(c.x, x) && vicino(c.y, y));
    for (let i = 1; i < n - 1; i++) {
      for (const x of [X_GIU, X_SU]) {
        expect(colpito("F_Cu.gbr", x, yDi(i)) && colpito("B_Cu.gbr", x, yDi(i)) && colpito(rame[i], x, yDi(i)), `via della riga ${i} a x ${x}`).toBe(true);
        for (let j = 1; j < n - 1; j++) if (j !== i) expect(colpito(rame[j], x, yDi(i)), `via della riga ${i} nel file ${rame[j]}`).toBe(false);
      }
    }

    // the plated drill file: from layer 1 to layer n, every via once
    const foratura = await testo("drill_plated.drl");
    expect(foratura).toContain(`TF.FileFunction,Plated,1,${n},PTH`);
    const fori = foratura.split("\n").filter((l) => /^X-?[\d.]+Y-?[\d.]+$/.test(l));
    const attesi = Array.from({ length: n - 1 }, (_, k) => [X_GIU, X_SU].map((x) => `X${x.toFixed(4)}Y${yDi(k + 1).toFixed(4)}`)).flat();
    expect([...fori].sort()).toEqual([...attesi].sort());
  });
});

describe("le piste disegnate a mano in Instrada su una scheda a 6 strati", () => {
  /*
   * The same six-layer board with no copper written in main.tsx, and one route
   * as Instrada saves it in manual-edits.json: from R4.pin2 on the top, a via
   * at x = -8 down to inner3, along it to x = 0, a via there on to inner4,
   * along it to x = +8, a via back up to the top and on to Q4.pin1. The pads
   * of an 0402 are 0,51 from its centre: R4.pin2 at -9,49 and Q4.pin1 at +9,49.
   */
  const RIGA = 3;
  const y = yDi(RIGA);
  const punti = [
    { x: -9.49, y, layer: "top" },
    { x: -8, y, layer: "top" },
    { x: -8, y, layer: "inner3" },
    { x: 0, y, layer: "inner3" },
    { x: 0, y, layer: "inner4" },
    { x: 8, y, layer: "inner4" },
    { x: 8, y, layer: "top" },
    { x: 9.49, y, layer: "top" },
  ];
  const rotta = { connection: ".R4 > .pin2 to .Q4 > .pin1", from: ".R4 > .pin2", to: ".Q4 > .pin1", width: 0.2, points: punti };
  const files = (n: number) => ({
    "main.tsx": main(n, { piste: false }),
    [DESIGN_RULES_PATH]: REGOLE,
    [MANUAL_EDITS_PATH]: JSON.stringify({ pcb_routes: [rotta] }),
  });

  it("restano sui loro strati dopo la compilazione: top, inner3, inner4, top, con tre vie passanti", async () => {
    const { circuitJson, summary } = await compileProject(files(6));
    const cj = circuitJson as El[];
    const sue = cj.filter((e) => e.type === "pcb_trace" && e.manual === true);
    expect(sue.map(stratiDi)).toEqual([["top", "inner3", "inner4", "top"]]);
    // the route's own points, on the layers it was drawn on
    const fili = (sue[0].route as Array<{ route_type: string; x: number; y: number; layer: string }>).filter((p) => p.route_type === "wire");
    expect(fili.map((p) => ({ x: p.x, y: p.y, layer: p.layer }))).toEqual(punti.map((p) => ({ ...p, y: Math.round(y * 1000) / 1000 })));
    const vie = cj.filter((e) => e.type === "pcb_via") as Array<El & { x: number; layers: string[]; declared_layers?: string[] }>;
    expect(vie.map((v) => v.x).sort((a, b) => a - b)).toEqual([-8, 0, 8]);
    for (const v of vie) expect(v.layers).toEqual(PILA[6]);
    expect(vie.sort((a, b) => a.x - b.x).map((v) => v.declared_layers)).toEqual([["top", "inner3"], ["inner3", "inner4"], ["inner4", "top"]]);
    // that connection is closed; the five nobody drew are open
    expect(summary.unroutedConnections.some((c) => c.includes("R4") && c.includes("Q4"))).toBe(false);
    expect(summary.unroutedTotal ?? summary.unroutedConnections.length).toBe(5);
  }, 120_000);

  it("la stessa pista su una scheda riportata a 4 strati non si posa: il collegamento torna aperto, niente rame su uno strato che non c'e'", async () => {
    // four rows instead of six: R4 and Q4 are still there, inner3 and inner4 are not
    const { circuitJson, summary } = await compileProject(files(4));
    const cj = circuitJson as El[];
    expect(cj.find((e) => e.type === "pcb_board")!.num_layers).toBe(4);
    expect(cj.filter((e) => e.type === "pcb_trace" && e.manual === true)).toEqual([]);
    expect(cj.filter((e) => e.type === "pcb_via")).toEqual([]);
    expect(summary.unroutedConnections.some((c) => c.includes("R4") && c.includes("Q4"))).toBe(true);
  }, 120_000);
});
