import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { compileGeometryOnly } from "@/lib/compile";

/*
 * One <schematicsection> per functional section is what the drawing rules ask
 * for, and tscircuit draws the dividers between them with an exact solver that
 * grows by about eight times per section: on the cells of fototrappola-frontale
 * 8 sections take 0.01 s, 10 two seconds, 11 sixteen, 12 twenty-two, 16 more
 * than minutes (09/11/2026). HTL-401 spent 941 of its 954 seconds there, and
 * the 25 sections of fototrappola-frontale never finish. Above 8 sections the
 * dividers come from the rows tscircuit lays the sections in
 * (patches/calculate-cell-boundaries.patch).
 */

// the 25 section cells of fototrappola-frontale, as tscircuit passes them (minX, maxX, minY, maxY)
const FOTOTRAPPOLA: Array<[number, number, number, number]> = [
  [-39.696, -32.544, -10.503, -1.698], [-30.544, -23.589, -7.425, -4.775], [-21.589, -16.444, -7.4, -4.8],
  [-14.444, -5.684, -9.338, -2.863], [-3.684, 5.296, -9.975, -2.225], [7.296, 16.476, -10.795, -1.405],
  [18.476, 24.226, -11.105, -1.095], [26.226, 39.696, -11.7, -0.5], [-47.172, -3.602, -23.671, -15.929],
  [-1.602, 5.488, -23.205, -16.395], [7.488, 21.613, -24.738, -14.862], [23.613, 31.742, -22.9, -16.7],
  [33.742, 41.872, -23.008, -16.593], [43.872, 47.172, -25.9, -13.7], [-47.709, -40.654, -45.04, -36.89],
  [-38.654, -32.284, -54.03, -27.9], [-30.284, -27.634, -45.01, -36.92], [-25.634, -14.744, -50.898, -31.033],
  [-12.744, -7.074, -43.468, -38.463], [-5.074, 0.73, -44.668, -37.263], [2.73, 14.43, -44.98, -36.95],
  [16.43, 28.547, -45.208, -36.722], [30.547, 33.947, -48.165, -33.765], [35.947, 47.709, -44.265, -37.665],
  [-6.274, 6.274, -66.96, -56.03],
];

type Pt = { x: number; y: number };
type Line = { start: Pt; end: Pt };
type Cell = { minX: number; maxX: number; minY: number; maxY: number };

const crosses = (p1: Pt, p2: Pt, a: Pt, b: Pt) => {
  const d = (p: Pt, q: Pt, r: Pt) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  return d(p1, p2, a) * d(p1, p2, b) < 0 && d(a, b, p1) * d(a, b, p2) < 0;
};
const center = (c: Cell): Pt => ({ x: (c.minX + c.maxX) / 2, y: (c.minY + c.maxY) / 2 });
const cutsCell = (l: Line, c: Cell) => {
  const horizontal = Math.abs(l.start.y - l.end.y) < 1e-9;
  return horizontal
    ? l.start.y > c.minY && l.start.y < c.maxY && Math.max(l.start.x, l.end.x) > c.minX && Math.min(l.start.x, l.end.x) < c.maxX
    : l.start.x > c.minX && l.start.x < c.maxX && Math.max(l.start.y, l.end.y) > c.minY && Math.min(l.start.y, l.end.y) < c.maxY;
};

// the package tscircuit itself loads (a dependency of @tscircuit/core, not of ours)
const loadSolver = async () =>
  (await import(
    pathToFileURL(
      path.join(__dirname, "..", "..", "..", "node_modules", ".pnpm", "node_modules", "calculate-cell-boundaries", "dist", "index.js"),
    ).href
  )) as { calculateCellBoundaries: (cells: Cell[]) => Line[] };

describe("cornici dello schematico con tante sezioni", () => {
  it("12 sezioni di fototrappola-frontale in un attimo, ognuna separata dalle altre", async () => {
    const { calculateCellBoundaries } = await loadSolver();
    const cells = FOTOTRAPPOLA.slice(0, 12).map(([minX, maxX, minY, maxY]) => ({ minX, maxX, minY, maxY }));
    const t0 = Date.now();
    const lines = calculateCellBoundaries(cells);
    // the exact solver took 22 s on these 12 cells
    expect(Date.now() - t0).toBeLessThan(2000);
    for (let i = 0; i < cells.length; i++) {
      for (let j = i + 1; j < cells.length; j++) {
        expect(lines.some((l) => crosses(center(cells[i]), center(cells[j]), l.start, l.end))).toBe(true);
      }
    }
    for (const l of lines) for (const c of cells) expect(cutsCell(l, c)).toBe(false);
  });

  it("tutte e 25 le sezioni, che prima non finivano mai", async () => {
    const { calculateCellBoundaries } = await loadSolver();
    const cells = FOTOTRAPPOLA.map(([minX, maxX, minY, maxY]) => ({ minX, maxX, minY, maxY }));
    const lines = calculateCellBoundaries(cells);
    for (let i = 0; i < cells.length; i++) {
      for (let j = i + 1; j < cells.length; j++) {
        expect(lines.some((l) => crosses(center(cells[i]), center(cells[j]), l.start, l.end))).toBe(true);
      }
    }
    for (const l of lines) for (const c of cells) expect(cutsCell(l, c)).toBe(false);
  });

  it("fino a 8 sezioni il disegno resta quello esatto di tscircuit", async () => {
    const { calculateCellBoundaries } = await loadSolver();
    const cells = FOTOTRAPPOLA.slice(0, 8).map(([minX, maxX, minY, maxY]) => ({ minX, maxX, minY, maxY }));
    // one row of eight: the exact solver gives the seven dividers between them, with the right ends
    const lines = calculateCellBoundaries(cells);
    expect(lines).toHaveLength(7);
    expect(lines.every((l) => Math.abs(l.start.x - l.end.x) < 1e-9)).toBe(true);
  });

  it("una scheda con 16 sezioni compila con un titolo per sezione", async () => {
    const SECTIONS = 16;
    const main = `export default () => (
  <board width="60mm" height="40mm" routingDisabled>
${Array.from({ length: SECTIONS }, (_, i) => {
  const x = -27 + (i % 8) * 7;
  const y = i < 8 ? -10 : 10;
  // sections of different sizes, like a real sheet
  const extra = Array.from({ length: i % 4 }, (_, k) => `    <capacitor name="C${i}_${k}" capacitance="100nF" footprint="0402" pcbX={${x}} pcbY={${y + 3 + k}} schSectionName="s${i}" />`).join("\n");
  return `    <resistor name="R${i}A" resistance="1k" footprint="0402" pcbX={${x}} pcbY={${y}} schSectionName="s${i}" />
    <resistor name="R${i}B" resistance="1k" footprint="0402" pcbX={${x + 2}} pcbY={${y}} schSectionName="s${i}" />
${extra}
    <trace from=".R${i}A > .pin2" to=".R${i}B > .pin1" />
    <schematicsection name="s${i}" displayName="Sezione ${i}" />`;
}).join("\n")}
  </board>
)
`;
    const cj = (await compileGeometryOnly({ "main.tsx": main })) as Array<Record<string, unknown> & { type: string }>;
    const titles = cj.filter((e) => e.type === "schematic_text" && !e.schematic_component_id);
    expect(titles.map((t) => t.text).sort()).toEqual(Array.from({ length: SECTIONS }, (_, i) => `Sezione ${i}`).sort());
    expect(cj.filter((e) => e.type === "schematic_line" && !e.schematic_component_id).length).toBeGreaterThan(0);
  }, 90_000);
});
