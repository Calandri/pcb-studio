import { describe, expect, it } from "vitest";
import { runTscircuitCode } from "@tscircuit/eval";
import { compileProject } from "@/lib/compile";
import { DEFAULT_DESIGN_RULES, DESIGN_RULES_PATH } from "@/lib/design-rules";
import { runDrcChecks } from "@/lib/drc";
import { DISTANZA_PROPRIA, descriviDistanze, distanzeDelleColate, readPours } from "@/lib/pours";
import { conContorniDichiarati, conDistanzeDichiarate, distanzeDichiarate, ricolaPiani } from "@/lib/pours-recompute";

/*
 * A <copperpour> that declares its own clearance (tscircuit's `clearance`
 * prop) is poured and judged with it; one that declares nothing keeps the
 * project's rule, and a board that declares nothing is left exactly as it was.
 * sbb-dl-principale, 2026-11-11: the hand strips need 0.152, the ground fills
 * should keep 0.25, and raising the project rule cut 77 strips.
 */

type P = { x: number; y: number };
type El = Record<string, unknown> & { type: string };
type Pour = El & { layer: string; brep_shape: { outer_ring: { vertices: P[] }; inner_rings?: Array<{ vertices: P[] }> } };

const dentro = (x: number, y: number, a: P[]) => {
  let d = false;
  for (let i = 0, j = a.length - 1; i < a.length; j = i++) {
    if (a[i].y > y !== a[j].y > y && x < ((a[j].x - a[i].x) * (y - a[i].y)) / (a[j].y - a[i].y) + a[i].x) d = !d;
  }
  return d;
};
const coperto = (p: Pour, x: number, y: number) =>
  dentro(x, y, p.brep_shape.outer_ring.vertices) && !(p.brep_shape.inner_rings ?? []).some((r) => dentro(x, y, r.vertices));
const dPS = (p: P, a: P, b: P) => {
  const dx = b.x - a.x, dy = b.y - a.y, l = dx * dx + dy * dy;
  const t = l > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
};
const giro = (a: P, b: P, c: P) => Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
const dSS = (a: P, b: P, c: P, d: P) =>
  giro(a, b, c) * giro(a, b, d) < 0 && giro(c, d, a) * giro(c, d, b) < 0
    ? 0
    : Math.min(dPS(a, c, d), dPS(b, c, d), dPS(c, a, b), dPS(d, a, b));
/** every edge of every ring of the pieces */
const lati = (pezzi: Pour[]): Array<[P, P]> =>
  pezzi.flatMap((p) =>
    [p.brep_shape.outer_ring.vertices, ...(p.brep_shape.inner_rings ?? []).map((r) => r.vertices)].flatMap((a) =>
      a.map((q, i): [P, P] => [a[(i + a.length - 1) % a.length], q]),
    ),
  );
/** from the copper of the pieces to a segment as wide as `w`: 0 when the copper covers it */
const aPista = (pezzi: Pour[], a: P, b: P, w: number) =>
  pezzi.some((p) => coperto(p, (a.x + b.x) / 2, (a.y + b.y) / 2))
    ? 0
    : Math.max(0, Math.min(...lati(pezzi).map(([c, d]) => dSS(a, b, c, d))) - w / 2);
const aCerchio = (pezzi: Pour[], c: P, r: number) =>
  pezzi.some((p) => coperto(p, c.x, c.y)) ? 0 : Math.max(0, Math.min(...lati(pezzi).map(([a, b]) => dPS(c, a, b))) - r);
const aRettangolo = (pezzi: Pour[], x: number, y: number, w: number, h: number) => {
  if (pezzi.some((p) => coperto(p, x, y))) return 0;
  const k = [{ x: x - w / 2, y: y - h / 2 }, { x: x + w / 2, y: y - h / 2 }, { x: x + w / 2, y: y + h / 2 }, { x: x - w / 2, y: y + h / 2 }];
  const bordi = k.map((q, i): [P, P] => [k[(i + 3) % 4], q]);
  return Math.min(...lati(pezzi).flatMap(([a, b]) => bordi.map(([c, d]) => dSS(a, b, c, d))));
};

/*
 * Two ground pours on the top face, the left one asking for 0.4 mm, the right
 * one asking nothing (the rule is 0.15). Through both runs a trace of another
 * net, each holds a pad of that net and a via of yet another.
 */
const DUE_COLATE = `export default () => (
  <board width="24mm" height="12mm">
    <net name="GND" />
    <net name="SIG" />
    <resistor name="R1" resistance="1k" footprint="0805" pcbX={-6} pcbY={0} />
    <resistor name="R2" resistance="1k" footprint="0805" pcbX={6} pcbY={0} />
    <trace from=".R1 > .pin1" to=".R2 > .pin1" pcbPathRelativeTo=".R1 > .pin1" pcbPath={[{ x: 0, y: -3 }, { x: 12, y: -3 }, { x: 12, y: 0 }]} thickness="0.25mm" />
    <via pcbX={-6} pcbY={3} fromLayer="top" toLayer="bottom" outerDiameter="0.6mm" holeDiameter="0.3mm" connectsTo="net.SIG" />
    <via pcbX={6} pcbY={3} fromLayer="top" toLayer="bottom" outerDiameter="0.6mm" holeDiameter="0.3mm" connectsTo="net.SIG" />
    <copperpour layer="top" connectsTo="net.GND" clearance="0.4mm" outline={[{x: -11, y: -5}, {x: -0.5, y: -5}, {x: -0.5, y: 5}, {x: -11, y: 5}]} />
    <copperpour layer="top" connectsTo="net.GND" outline={[{x: 0.5, y: -5}, {x: 11, y: -5}, {x: 11, y: 5}, {x: 0.5, y: 5}]} />
  </board>
)
`;

describe("what a <copperpour> declares about its distance", () => {
  it("is read in every .tsx, in tscircuit's units, raised to the minimum and said when it is wrong", () => {
    const file = {
      "main.tsx": `<copperpour layer="inner1" connectsTo="net.GND" clearance="0.25mm" />`,
      "righe_2.tsx": [
        `<copperpour layer="top" connectsTo="net.GND" clearance={0.3} outline={[{x: 0, y: 0}, {x: 1, y: 0}, {x: 1, y: 1}]} />`,
        `<copperpour layer="top" connectsTo="net.VBAT" clearance="10mil" outline={[{x: 2, y: 0}, {x: 3, y: 0}, {x: 3, y: 1}]} />`,
        `<copperpour layer="bottom" connectsTo="net.GND" clearance="0.1mm" outline={[{x: 4, y: 0}, {x: 5, y: 0}, {x: 5, y: 1}]} />`,
        `<copperpour layer="bottom" connectsTo="net.P3V3" clearance={larga} outline={[{x: 6, y: 0}, {x: 7, y: 0}, {x: 7, y: 1}]} />`,
        `<copperpour layer="top" connectsTo="net.P3V3" outline={[{x: 8, y: 0}, {x: 9, y: 0}, {x: 9, y: 1}]} />`,
      ].join("\n"),
      "design-rules.json": `{"rules": {}}`,
    };
    const { dichiarate, avvisi } = distanzeDichiarate(file, 0.152);
    expect(dichiarate.map((d) => [d.file, d.layer, d.net, d.mm === null ? null : Number(d.mm.toFixed(6)), d.outline !== null])).toEqual([
      ["main.tsx", "inner1", "GND", 0.25, false],
      ["righe_2.tsx", "top", "GND", 0.3, true],
      ["righe_2.tsx", "top", "VBAT", 0.254, true],
      ["righe_2.tsx", "bottom", "GND", 0.152, true],
      ["righe_2.tsx", "bottom", "P3V3", null, true],
      ["righe_2.tsx", "top", "P3V3", null, true],
    ]);
    expect(avvisi).toEqual([
      "righe_2.tsx: clearance 0.1mm della <copperpour> GND su bottom e' sotto la distanza minima 0.152: portata al minimo",
      "righe_2.tsx: clearance larga della <copperpour> P3V3 su bottom non e' una distanza scritta nel file: ignorata, vale la regola del progetto",
    ]);
    // two outline-less pours of one net on one face asking for different distances cannot be told apart
    const doppie = distanzeDichiarate(
      { "main.tsx": `<copperpour layer="inner1" connectsTo="net.GND" clearance="0.25mm" />\n<copperpour layer="inner1" connectsTo="net.GND" />` },
      0.152,
    );
    expect(doppie.avvisi).toHaveLength(1);
    expect(doppie.avvisi[0]).toContain("le <copperpour> GND su inner1 senza un contorno");
  });

  it("a board that declares nothing gets back the very same array, and the checks say what they always said", async () => {
    const senza = DUE_COLATE.replace(` clearance="0.4mm"`, "");
    const cj = (await runTscircuitCode({ "main.tsx": senza }, { mainComponentPath: "main.tsx" })) as El[];
    const base = conContorniDichiarati(cj as never, senza) as El[];
    expect(conDistanzeDichiarate(base as never, { "main.tsx": senza }, 0.15)).toBe(base);
    const prima = await ricolaPiani({ circuitJson: base as never, clearanceMm: 0.15, bordoMm: 0.3 });
    expect((prima.circuitJson as El[]).some((e) => DISTANZA_PROPRIA in e)).toBe(false);
    const regole = { ...DEFAULT_DESIGN_RULES, minClearanceMm: 0.15, pourClearanceMm: 0.15 };
    expect(runDrcChecks(prima.circuitJson as never, regole)).toEqual(
      runDrcChecks(prima.circuitJson as never, regole, undefined, { distanzeProprieDelleColate: false }),
    );
    expect(descriviDistanze(distanzeDelleColate(prima.circuitJson as never, 0.15))).toMatch(/^0\.15mm \(regola, \d+ colat[ae]\)$/);
  }, 120_000);

  it("a pour with its own clearance keeps it from a trace, a pad and a via, its neighbour without one keeps the rule", async () => {
    const cj = (await runTscircuitCode({ "main.tsx": DUE_COLATE }, { mainComponentPath: "main.tsx" })) as El[];
    const scritte = conDistanzeDichiarate(conContorniDichiarati(cj as never, DUE_COLATE) as never, { "main.tsx": DUE_COLATE }, 0.15) as El[];
    const proprie = scritte.filter((e) => e.type === "pcb_copper_pour").map((e) => e[DISTANZA_PROPRIA]);
    expect(proprie.sort()).toEqual([0.4, undefined]);

    const esito = await ricolaPiani({ circuitJson: scritte as never, clearanceMm: 0.15, bordoMm: 0.3, larghezzaMinimaMm: 0.127 });
    const out = esito.circuitJson as El[];
    const pezzi = out.filter((e) => e.type === "pcb_copper_pour" && e.layer === "top") as Pour[];
    const sinistra = pezzi.filter((p) => p.brep_shape.outer_ring.vertices.every((v) => v.x < 0));
    const destra = pezzi.filter((p) => p.brep_shape.outer_ring.vertices.every((v) => v.x > 0));
    expect(sinistra.length).toBeGreaterThan(0);
    expect(destra.length).toBeGreaterThan(0);
    expect(sinistra.length + destra.length).toBe(pezzi.length);
    // every piece of the left pour carries its clearance on, the right one carries none
    expect(sinistra.every((p) => p[DISTANZA_PROPRIA] === 0.4)).toBe(true);
    expect(destra.every((p) => !(DISTANZA_PROPRIA in p))).toBe(true);

    const pista = out.find((e) => e.type === "pcb_trace") as El & { route: Array<P & { width: number }> };
    const segmenti = pista.route.slice(1).map((q, i) => [pista.route[i], q] as const);
    const daPista = (lato: Pour[]) => Math.min(...segmenti.map(([a, b]) => aPista(lato, a, b, a.width ?? 0.25)));
    const vie = out.filter((e) => e.type === "pcb_via") as Array<El & P & { outer_diameter: number }>;
    const daVia = (lato: Pour[], x: number) => {
      const v = vie.find((q) => Math.abs(q.x - x) < 1e-6)!;
      return aCerchio(lato, v, v.outer_diameter / 2);
    };
    const pads = out.filter((e) => e.type === "pcb_smtpad") as Array<El & P & { width: number; height: number }>;
    const r1 = pads.reduce((a, b) => (b.x < a.x ? b : a)); // R1.pin1, the leftmost pad
    const r2 = pads.filter((q) => q.x > 0).reduce((a, b) => (b.x < a.x ? b : a)); // R2.pin1
    const daPad = (lato: Pour[], q: El & P & { width: number; height: number }) => aRettangolo(lato, q.x, q.y, q.width, q.height);

    for (const d of [daPista(sinistra), daVia(sinistra, -6), daPad(sinistra, r1)]) expect(d).toBeGreaterThanOrEqual(0.4 - 0.01);
    for (const d of [daPista(destra), daVia(destra, 6), daPad(destra, r2)]) {
      expect(d).toBeGreaterThanOrEqual(0.15 - 0.01);
      // the rule and not the neighbour's 0.4: the copper comes right up to it
      expect(d).toBeLessThan(0.2);
    }
  }, 120_000);

  it("a plane yields to a smaller pour that asks for more distance than the plane does", async () => {
    const isola = `export default () => (
      <board width="16mm" height="12mm">
        <net name="GND" />
        <net name="SIG" />
        <copperpour layer="top" connectsTo="net.GND" />
        <copperpour layer="top" connectsTo="net.SIG" clearance="0.4mm" outline={[{x: -1, y: -1}, {x: 1, y: -1}, {x: 1, y: 1}, {x: -1, y: 1}]} />
      </board>
    )`;
    const cj = (await runTscircuitCode({ "main.tsx": isola }, { mainComponentPath: "main.tsx" })) as El[];
    const reti = new Map(cj.filter((e) => e.type === "source_net").map((e) => [String(e.name), String(e.source_net_id)]));
    const scritte = conDistanzeDichiarate(conContorniDichiarati(cj as never, isola) as never, { "main.tsx": isola }, 0.15);
    const esito = await ricolaPiani({ circuitJson: scritte as never, clearanceMm: 0.15, bordoMm: 0.3 });
    const out = esito.circuitJson as Pour[];
    const piano = out.filter((e) => e.type === "pcb_copper_pour" && e.source_net_id === reti.get("GND"));
    const quadrato = out.find((e) => e.type === "pcb_copper_pour" && e.source_net_id === reti.get("SIG"))!;
    expect(piano.length).toBeGreaterThan(0);
    expect(quadrato[DISTANZA_PROPRIA]).toBe(0.4);
    // from the plane to the island: the island's 0.4, not the plane's 0.15
    const v = quadrato.brep_shape.outer_ring.vertices;
    const bordi = v.map((q, i) => [v[(i + v.length - 1) % v.length], q] as const);
    const gap = Math.min(...bordi.map(([a, b]) => aPista(piano, a, b, 0)));
    expect(gap).toBeGreaterThanOrEqual(0.4 - 0.01);
    expect(gap).toBeLessThan(0.5);
  }, 120_000);
});

describe("the pour_clearance rule and a plane's own clearance", () => {
  const cerchio = (x: number, y: number, r: number, n = 48): P[] =>
    Array.from({ length: n }, (_, i) => ({ x: x + r * Math.cos((2 * Math.PI * i) / n), y: y + r * Math.sin((2 * Math.PI * i) / n) }));
  const quadrato = (s: number): P[] => [{ x: -s, y: -s }, { x: s, y: -s }, { x: s, y: s }, { x: -s, y: s }];
  const STRATI = ["top", "inner1", "inner2", "bottom"];
  const via = (id: string, x: number, net: number): El => ({
    type: "pcb_via", pcb_via_id: id, x, y: 0, outer_diameter: 0.5, hole_diameter: 0.2, layers: STRATI, subcircuit_connectivity_map_key: `k${net}`,
  });
  /** a ground plane on inner1 with an opening around a signal via, its edge 0.2 mm from the via's pad */
  const scheda = (propria?: number, altre: El[] = []): El[] => [
    { type: "pcb_board", center: { x: 0, y: 0 }, width: 20, height: 20, num_layers: 4 },
    ...[0, 1].map((n): El => ({ type: "source_net", source_net_id: `n${n}`, name: `N${n}`, subcircuit_connectivity_map_key: `k${n}` })),
    via("segnale", 0, 1),
    ...altre,
    {
      type: "pcb_copper_pour",
      pcb_copper_pour_id: "piano",
      layer: "inner1",
      source_net_id: "n0",
      shape: "brep",
      brep_shape: { outer_ring: { vertices: quadrato(8) }, inner_rings: [{ vertices: cerchio(0, 0, 0.25 + 0.2) }] },
      ...(propria !== undefined ? { [DISTANZA_PROPRIA]: propria } : {}),
    },
  ];
  const regole = { ...DEFAULT_DESIGN_RULES, minClearanceMm: 0.152, pourClearanceMm: 0.152, minViaHoleMm: 0.2, minViaDiameterMm: 0.5 };
  const colata = (cj: El[], opzioni?: { distanzeProprieDelleColate?: boolean }) =>
    runDrcChecks(cj, regole, undefined, opzioni).filter((v) => v.rule === "pour_clearance").map((v) => v.message);

  it("judges a plane by the clearance it declares, and the fab classes by the rule", () => {
    expect(readPours(scheda(0.25))[0].clearanceMm).toBe(0.25);
    expect(readPours(scheda())[0]).not.toHaveProperty("clearanceMm");
    // the rule: 0.2 is wide enough
    expect(colata(scheda())).toEqual([]);
    // the plane asked for 0.25 and stopped at 0.2
    const [riga, ...resto] = colata(scheda(0.25));
    expect(resto).toEqual([]);
    expect(riga).toMatch(/^segnale <-> N0 pour on inner1: 0\.\d+mm < min 0\.25mm \(the pour's own clearance\)$/);
    expect(Number(/: (0\.\d+)mm/.exec(riga)![1])).toBeCloseTo(0.2, 2);
    // a plane that asks for less than it keeps is fine
    expect(colata(scheda(0.18))).toEqual([]);
    // what a fab can make does not depend on what the designer asked of the pour
    expect(colata(scheda(0.25), { distanzeProprieDelleColate: false })).toEqual([]);
  });

  it("where the plane's own via is the edge nearest the other via, the pair rules judge it, as before", () => {
    // a ground via 0.2 mm from the signal via, held whole by the plane: that via ring is the copper nearest to it
    expect(colata(scheda(0.25, [via("massa", 0.7, 0)]))).toEqual([]);
    // closer than the pair rules allow, it is reported all the same, against them
    const stretta = scheda(0.25, [via("massa", 0.6, 0)]).map((e) =>
      e.type === "pcb_copper_pour"
        ? { ...e, brep_shape: { outer_ring: { vertices: quadrato(8) }, inner_rings: [{ vertices: cerchio(0, 0, 0.25 + 0.1) }] } }
        : e,
    );
    const [troppo, ...resto] = colata(stretta);
    expect(resto).toEqual([]);
    expect(troppo).toMatch(/< min 0\.152mm$/);
    // and a plane that holds no via of its own there is held to its 0.25
    expect(colata(stretta.filter((e) => e.pcb_via_id !== "massa"))[0]).toMatch(/< min 0\.25mm \(the pour's own clearance\)$/);
  });
});

describe("the summary lists the clearances in use", () => {
  it("names the declared ones, raises the one under the minimum and says so", async () => {
    const codice = DUE_COLATE.replace(
      `<copperpour layer="top" connectsTo="net.GND" outline={[{x: 0.5`,
      `<copperpour layer="bottom" connectsTo="net.GND" clearance="0.05mm" outline={[{x: -11, y: -5}, {x: 11, y: -5}, {x: 11, y: 5}, {x: -11, y: 5}]} />\n    <copperpour layer="top" connectsTo="net.GND" outline={[{x: 0.5`,
    );
    const regole = JSON.stringify({ preset: "custom", rules: { minClearanceMm: 0.15, pourClearanceMm: 0.2, minTraceWidthMm: 0.127, autoroute: false, autoPlaneVias: false } });
    const { summary, circuitJson } = await compileProject({ "main.tsx": codice, [DESIGN_RULES_PATH]: regole });
    const colate = (circuitJson as El[]).filter((e) => e.type === "pcb_copper_pour");
    expect(new Set(colate.map((e) => e[DISTANZA_PROPRIA]))).toEqual(new Set([0.4, 0.15, undefined]));
    const p = summary.pourClearances!;
    expect(p.regolaMm).toBe(0.2);
    expect(p.distanze.map((d) => [d.mm, d.regola])).toEqual([[0.15, false], [0.2, true], [0.4, false]]);
    expect(p.testo).toMatch(/^0\.15mm \(\d+ colat[ae]\), 0\.2mm \(regola, \d+ colat[ae]\), 0\.4mm \(\d+ colat[ae]\)$/);
    expect(p.avvisi).toEqual(["main.tsx: clearance 0.05mm della <copperpour> GND su bottom e' sotto la distanza minima 0.15: portata al minimo"]);
    expect(summary.message).toContain(` Colate: ${p.testo}.`);
    expect(summary.message).toContain("ATTENZIONE <copperpour>: main.tsx: clearance 0.05mm");
  }, 180_000);
});
