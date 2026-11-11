import { beforeAll, describe, expect, it } from "vitest";
import { initializeManifoldGeometry } from "@tscircuit/copper-pour-solver";
import { compileProject } from "@/lib/compile";
import { DESIGN_RULES_PATH } from "@/lib/design-rules";
import { anelloPulito, capsula, cerchio, ERRORE_CORDA_MM, rettangoloArrotondato } from "@/lib/pour-geometry";
import { abbracciaRamePropio, colateSenzaColli } from "@/lib/pour-necks";
import { bandaDelBordo, conContorniDichiarati, fileDellaScheda, ricolaPiani } from "@/lib/pours-recompute";

/*
 * The pours of sbb-dl-principale looked rough in the viewer (2026-11-11):
 * staircases around a round zone, 6 micrometre facets, lumps at the bends of
 * the gap between two pours, rectangles with lobes around the vias. These are
 * the properties a pour drawn like a CAD's has, each measured exactly.
 */

type P = { x: number; y: number };
type El = Record<string, unknown> & { type: string };
type Forma = { outer_ring: { vertices: P[] }; inner_rings?: Array<{ vertices: P[] }> };
type Pour = El & { layer: string; brep_shape: Forma };

const E = ERRORE_CORDA_MM;
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
const dentro = (x: number, y: number, a: P[]) => {
  let d = false;
  for (let i = 0, j = a.length - 1; i < a.length; j = i++) {
    if (a[i].y > y !== a[j].y > y && x < ((a[j].x - a[i].x) * (y - a[i].y)) / (a[j].y - a[i].y) + a[i].x) d = !d;
  }
  return d;
};
const anelli = (f: Forma) => [f.outer_ring.vertices, ...(f.inner_rings ?? []).map((r) => r.vertices)];
const lati = (a: P[]): Array<[P, P]> => a.map((q, i): [P, P] => [a[(i + a.length - 1) % a.length], q]);
const area = (v: P[]) => Math.abs(v.reduce((s, p, i) => s + p.x * v[(i + 1) % v.length].y - v[(i + 1) % v.length].x * p.y, 0) / 2);
const colate = (cj: unknown[]) => (cj as El[]).filter((e) => e.type === "pcb_copper_pour") as Pour[];
/** the distance from the copper of the pieces to a polygon: zero when they touch */
const aPoligono = (pezzi: Pour[], k: P[]) =>
  Math.min(...pezzi.flatMap((p) => anelli(p.brep_shape).flatMap((a) => lati(a).flatMap(([a1, b1]) => lati(k).map(([c, d]) => dSS(a1, b1, c, d))))));
const aCerchio = (pezzi: Pour[], c: P, r: number) =>
  Math.min(...pezzi.flatMap((p) => anelli(p.brep_shape).flatMap((a) => lati(a).map(([a1, b1]) => dPS(c, a1, b1))))) - r;
const aPista = (pezzi: Pour[], a: P, b: P, w: number) =>
  Math.min(...pezzi.flatMap((p) => anelli(p.brep_shape).flatMap((r) => lati(r).map(([c, d]) => dSS(a, b, c, d))))) - w / 2;
const rett = (x: number, y: number, w: number, h: number, gradi = 0): P[] => {
  const c = Math.cos((gradi * Math.PI) / 180), s = Math.sin((gradi * Math.PI) / 180);
  return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([dx, dy]) => ({ x: x + dx * c - dy * s, y: y + dx * s + dy * c }));
};

beforeAll(async () => {
  await initializeManifoldGeometry();
});

describe("the shapes an obstacle is grown into", () => {
  it("a circle is drawn just outside the true one, with as many sides as its radius needs", () => {
    for (const r of [0.0635, 0.377, 1.252, 2.69]) {
      const c = cerchio(0, 0, r);
      expect(c.length % 4).toBe(0);
      for (const [a, b] of lati(c)) {
        expect(Math.hypot(b.x, b.y)).toBeLessThanOrEqual(r + E + 1e-9);
        // every chord stays out of the circle: the clearance is never short
        expect(dPS({ x: 0, y: 0 }, a, b)).toBeGreaterThanOrEqual(r - 1e-9);
      }
    }
    expect(cerchio(0, 0, 0.377).length).toBeLessThanOrEqual(36);
    expect(cerchio(0, 0, 1.252).length).toBeLessThanOrEqual(64);
  });

  it("a capsule and a rounded rectangle keep the distance along their sides and around their corners", () => {
    const k = capsula({ x: 0, y: 0 }, { x: 3, y: 1 }, 0.35);
    for (const [a, b] of lati(k)) expect(dSS(a, b, { x: 0, y: 0 }, { x: 3, y: 1 })).toBeGreaterThanOrEqual(0.35 - 1e-9);
    for (const q of k) expect(dPS(q, { x: 0, y: 0 }, { x: 3, y: 1 })).toBeLessThanOrEqual(0.35 + E + 1e-9);
    const r = rettangoloArrotondato(1, 2, 1.4, 1.0, 0.2, 30);
    const nucleo = rett(1, 2, 1.0, 0.6, 30);
    for (const q of r) expect(Math.min(...lati(nucleo).map(([a, b]) => dPS(q, a, b)))).toBeGreaterThanOrEqual(0.2 - 1e-9);
    for (const q of r) expect(Math.min(...lati(nucleo).map(([a, b]) => dPS(q, a, b)))).toBeLessThanOrEqual(0.2 + E + 1e-9);
  });

  it("cleaning a ring only takes copper away, by a micrometre at most, and a clean ring stays as it is", () => {
    // a square with noise on its bottom side (collinear points, bumps OUT of the copper by 0.4 micrometres)
    // and a dent INTO the copper of half a micrometre on its top side
    const lato: P[] = [];
    for (let i = 0; i <= 40; i++) lato.push({ x: i * 0.05, y: i % 2 ? -0.0000004 : 0 });
    const anello = [...lato, { x: 2, y: 2 }, { x: 1, y: 1.9995 }, { x: 0, y: 2 }];
    const pulito = anelloPulito(anello, true);
    // the bottom side is one edge again; the dent stays, dropping it would add copper
    expect(pulito).toHaveLength(5);
    expect(pulito).toContainEqual({ x: 1, y: 1.9995 });
    // every vertex kept is one of the ring's, so nothing new appears
    for (const q of pulito) expect(anello.some((a) => a.x === q.x && a.y === q.y)).toBe(true);
    expect(area(pulito)).toBeLessThanOrEqual(area(anello) + 1e-9);
    expect(anelloPulito(pulito, true)).toEqual(pulito);
  });
});

/** a board with a ground pour over all of it and copper of another net to keep away from */
const GND = { type: "source_net", source_net_id: "n_gnd", name: "GND", subcircuit_connectivity_map_key: "k_gnd" };
const SCHEDA = { type: "pcb_board", center: { x: 0, y: 0 }, width: 20, height: 20, outline: [] };
const pianoGnd = (outline: P[]): El => ({
  type: "pcb_copper_pour",
  pcb_copper_pour_id: "piano",
  source_net_id: "n_gnd",
  layer: "top",
  shape: "brep",
  brep_shape: { outer_ring: { vertices: outline }, inner_rings: [] },
});

describe("the re-pour keeps the clearance as a CAD does: exactly, on every side and every corner", () => {
  it("around a rectangle, a turned rectangle, a circle, a trace and a via", async () => {
    const m = 0.2;
    const cj: El[] = [
      SCHEDA,
      GND,
      { type: "pcb_smtpad", pcb_smtpad_id: "rect", shape: "rect", layer: "top", x: -5, y: 5, width: 1, height: 0.6 },
      { type: "pcb_smtpad", pcb_smtpad_id: "turned", shape: "rotated_rect", layer: "top", x: 0, y: 5, width: 1, height: 0.5, ccw_rotation: 30 },
      { type: "pcb_smtpad", pcb_smtpad_id: "round", shape: "circle", layer: "top", x: 5, y: 5, radius: 0.4 },
      {
        type: "pcb_trace",
        pcb_trace_id: "t",
        subcircuit_connectivity_map_key: "k_sig",
        route: [
          { route_type: "wire", x: -6, y: -3, width: 0.25, layer: "top" },
          { route_type: "wire", x: 6, y: -3, width: 0.25, layer: "top" },
        ],
      },
      { type: "pcb_via", pcb_via_id: "v", x: 0, y: -6, outer_diameter: 0.5, hole_diameter: 0.25, layers: ["top", "bottom"] },
      pianoGnd(rett(0, 0, 18, 18)),
    ];
    const esito = await ricolaPiani({ circuitJson: cj, clearanceMm: m, bordoMm: 0.3, larghezzaMinimaMm: 0.127 });
    const pezzi = colate(esito.circuitJson);
    expect(pezzi).toHaveLength(1);
    const distanze = {
      rect: aPoligono(pezzi, rett(-5, 5, 1, 0.6)),
      turned: aPoligono(pezzi, rett(0, 5, 1, 0.5, 30)),
      round: aCerchio(pezzi, { x: 5, y: 5 }, 0.4),
      trace: aPista(pezzi, { x: -6, y: -3 }, { x: 6, y: -3 }, 0.25),
      via: aCerchio(pezzi, { x: 0, y: -6 }, 0.25),
    };
    for (const d of Object.values(distanze)) {
      expect(d).toBeGreaterThanOrEqual(m - 1e-6);
      expect(d).toBeLessThanOrEqual(m + E + 1e-6);
    }
    // and constant: every vertex of the opening around the turned pad is the clearance away, corners included
    const buco = pezzi[0].brep_shape.inner_rings!.find((r) => r.vertices.every((q) => Math.hypot(q.x, q.y - 5) < 1.5))!;
    const turned = rett(0, 5, 1, 0.5, 30);
    for (const q of buco.vertices) {
      const d = Math.min(...lati(turned).map(([a, b]) => dPS(q, a, b)));
      expect(d).toBeGreaterThanOrEqual(m - 1e-6);
      expect(d).toBeLessThanOrEqual(m + E + 1e-6);
    }
  }, 60_000);

  it("a round hole gives a round opening: no step, no micro-segment, the clearance all around", async () => {
    const cj: El[] = [SCHEDA, GND, { type: "pcb_hole", pcb_hole_id: "foro", hole_shape: "circle", x: 0, y: 0, hole_diameter: 2.2 }, pianoGnd(rett(0, 0, 18, 18))];
    const esito = await ricolaPiani({ circuitJson: cj, clearanceMm: 0.152, bordoMm: 0.3, larghezzaMinimaMm: 0.127 });
    const [piano] = colate(esito.circuitJson);
    const buco = piano.brep_shape.inner_rings![0].vertices;
    const R = 1.1 + 0.152;
    for (const [a, b] of lati(buco)) {
      expect(Math.hypot(b.x, b.y)).toBeGreaterThanOrEqual(R - 1e-6);
      expect(Math.hypot(b.x, b.y)).toBeLessThanOrEqual(R + E + 1e-6);
      expect(dPS({ x: 0, y: 0 }, a, b)).toBeGreaterThanOrEqual(R - 1e-6);
      expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeGreaterThan(0.05);
    }
    expect(buco.length).toBeLessThanOrEqual(64);
    // the outer ring of a square plane is its four corners: nothing between them
    expect(piano.brep_shape.outer_ring.vertices).toHaveLength(4);
  }, 60_000);

  it("the band along a rounded board edge follows the arc, no square on its vertices", () => {
    const arco = Array.from({ length: 31 }, (_, i) => ({ x: 5 * Math.cos((i / 30) * Math.PI), y: 5 * Math.sin((i / 30) * Math.PI) }));
    const band = bandaDelBordo([{ type: "pcb_board", outline: [...arco, { x: -5, y: -5 }, { x: 5, y: -5 }] }], "top", 0.3);
    expect(band).toHaveLength(33);
    // every point of the band is within the edge clearance of the outline, plus the arc error
    for (const b of band) {
      for (const q of b.points as P[]) {
        const d = Math.min(...lati([...arco, { x: -5, y: -5 }, { x: 5, y: -5 }]).map(([a, c]) => dPS(q, a, c)));
        expect(d).toBeLessThanOrEqual(0.3 + E + 1e-9);
      }
    }
  });

  it("own copper is held by its real shape: a pill is not its bounding box", () => {
    // a strip that reaches the end of a pill pad of its net
    const striscia: Forma = { outer_ring: { vertices: rett(0, -1, 2, 1) }, inner_rings: [] };
    const [unita] = abbracciaRamePropio([striscia], [{ kind: "rett", x: 0, y: 0.5, w: 0.6, h: 2, rot: 0, raggio: 0.3 }]);
    // nothing of the union stands out of the strip or the pill by more than half a micrometre
    for (const q of unita.outer_ring!.vertices) {
      const nellaStriscia = q.y <= -0.5 + 1e-9 && Math.abs(q.x) <= 1 + 1e-9 && q.y >= -1.5 - 1e-9;
      const dallAsse = dPS(q, { x: 0, y: -0.2 }, { x: 0, y: 1.2 });
      expect(nellaStriscia || dallAsse <= 0.3 + 0.0005 + 1e-9).toBe(true);
    }
  });
});

describe("a pour starts again from the outline its file declares, in any file the board imports", () => {
  const REGOLE = JSON.stringify({ preset: "custom", rules: { minTraceWidthMm: 0.127, minClearanceMm: 0.152, pourClearanceMm: 0.152, autoPlaneVias: false, autoroute: false } });
  // a strip with square corners and a long diagonal drawn with a vertex every 0.13 mm and a few micrometres of
  // wobble, as a script writes it: tscircuit cut a square out at every such vertex, a staircase
  const diagonale = Array.from({ length: 23 }, (_, i) => ({ x: Number((3 - i * 0.13).toFixed(3)), y: Number((-1 + i * 0.13 + (i % 2 ? 0.003 : 0)).toFixed(3)) }));
  const contorno: P[] = [{ x: -3, y: -1 }, ...diagonale, { x: 0, y: 2 }, { x: -3, y: 2 }];
  const lista = (v: P[]) => `[${v.map((p) => `{x: ${p.x}, y: ${p.y}}`).join(", ")}]`;
  const STRISCE = `export const Strisce = () => (
  <>
    <copperpour layer="top" connectsTo="net.GND" outline={${lista(contorno)}} />
  </>
)
`;
  const MAI_USATO = `export const Vecchio = () => (<copperpour layer="bottom" connectsTo="net.GND" outline={[{x: -8, y: -8}, {x: 8, y: -8}, {x: 8, y: 8}]} />)\n`;
  const MAIN = `import { Strisce } from "./strisce"
export default () => (
  <board width="24mm" height="16mm">
    <net name="GND" />
    <resistor name="R1" resistance="1k" footprint="0402" pcbX={8} pcbY={-6} />
    <trace from=".R1 > .pin1" to="net.GND" />
    <Strisce />
  </board>
)
`;
  const files = { "main.tsx": MAIN, "strisce.tsx": STRISCE, "vecchio.tsx": MAI_USATO, [DESIGN_RULES_PATH]: REGOLE };

  it("reads the files main.tsx imports, and only those", () => {
    expect(fileDellaScheda(files)).toEqual(["main.tsx", "strisce.tsx"]);
  });

  it("keeps the declared shape where nothing cuts it, corners and diagonal included, and a second compile gives the same copper", async () => {
    const { circuitJson } = await compileProject(files);
    const pezzi = colate(circuitJson);
    expect(pezzi.filter((p) => p.layer === "bottom")).toHaveLength(0);
    const sopra = pezzi.filter((p) => p.layer === "top");
    expect(sopra).toHaveLength(1);
    const v = sopra[0].brep_shape.outer_ring.vertices;
    // every declared corner is there, within 2 micrometres (tscircuit's own pour was 0.2 mm inside it)
    for (const q of [{ x: -3, y: -1 }, { x: 3, y: -1 }, { x: 0, y: 2 }, { x: -3, y: 2 }]) {
      expect(Math.min(...v.map((p) => Math.hypot(p.x - q.x, p.y - q.y)))).toBeLessThan(0.002);
    }
    expect(Math.abs(area(v) - area(contorno))).toBeLessThan(0.002);
    // no step along the diagonal: no edge there runs along an axis
    for (const [a, b] of lati(v)) {
      const sulla = Math.abs(a.x + a.y - 2) < 0.05 && Math.abs(b.x + b.y - 2) < 0.05;
      if (sulla && Math.hypot(b.x - a.x, b.y - a.y) > 0.01) expect(Math.abs(b.x - a.x) > 1e-6 && Math.abs(b.y - a.y) > 1e-6).toBe(true);
    }
    const ancora = await compileProject(files);
    expect(JSON.stringify(colate(ancora.circuitJson))).toBe(JSON.stringify(pezzi));
  }, 120_000);

  it("a recheck leaves a board poured by this engine as it is", async () => {
    const { circuitJson } = await compileProject(files);
    const prima = colate(circuitJson);
    const dopo = colate(await colateSenzaColli(circuitJson as Array<Record<string, unknown> & { type: string }>, 0.127));
    expect(dopo).toHaveLength(prima.length);
    dopo.forEach((p, i) => {
      const a = anelli(prima[i].brep_shape);
      const b = anelli(p.brep_shape);
      expect(b.map((r) => r.length)).toEqual(a.map((r) => r.length));
      b.forEach((r, k) => {
        for (const q of r) expect(Math.min(...a[k].map((z) => Math.hypot(z.x - q.x, z.y - q.y)))).toBeLessThan(1e-6);
      });
    });
  }, 120_000);
});

describe("necks are still taken out, declared corners are kept", () => {
  it("two declared squares joined by a 0.1 mm neck come out as two, with their square corners", async () => {
    const forma = [
      { x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 0.95 }, { x: 3, y: 0.95 }, { x: 3, y: 0 }, { x: 5, y: 0 },
      { x: 5, y: 2 }, { x: 3, y: 2 }, { x: 3, y: 1.05 }, { x: 2, y: 1.05 }, { x: 2, y: 2 }, { x: 0, y: 2 },
    ];
    const main = `<copperpour layer="top" connectsTo="net.GND" outline={[${forma.map((p) => `{x: ${p.x}, y: ${p.y}}`).join(", ")}]} />`;
    // tscircuit's own piece of it, inside the outline
    const cj = conContorniDichiarati([SCHEDA, GND, pianoGnd(rett(1, 1, 1.6, 1.6))], main);
    const esito = await ricolaPiani({ circuitJson: cj as El[], clearanceMm: 0.152, bordoMm: 0.3, larghezzaMinimaMm: 0.127 });
    const pezzi = colate(esito.circuitJson);
    expect(pezzi).toHaveLength(2);
    for (const q of [{ x: 0, y: 0 }, { x: 5, y: 2 }, { x: 2, y: 2 }, { x: 3, y: 0 }]) {
      const v = pezzi.flatMap((p) => p.brep_shape.outer_ring.vertices);
      expect(Math.min(...v.map((p) => Math.hypot(p.x - q.x, p.y - q.y)))).toBeLessThan(0.002);
    }
    // the neck is gone: nothing of the copper between x 2.05 and 2.95
    for (const p of pezzi) expect(dentro(2.5, 1, p.brep_shape.outer_ring.vertices)).toBe(false);
  }, 60_000);
});
