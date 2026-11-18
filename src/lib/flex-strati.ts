/**
 * INDEPENDENT FLEXIBLE LAYERS (pila.flessibili in flex.json): the geometry
 * that two tails lying on top of each other, flat, ask for.
 *
 * Each copper layer of the board goes on into one sheet at most, so the copper
 * of a layer at a point belongs to the zone of that layer's sheet that holds
 * the point. Where a zone of another sheet lies over it, that zone does not
 * end the copper: a zone is a hole in a layer it does not declare only where
 * no zone that declares the layer covers it (zonaSenzaLoStrato). And where two
 * tails leave the rigid part side by side, the gap between them is the cut the
 * fab makes between two sheets: it has a minimum (minFlexSlotMm, fessura).
 *
 * The boolean operations use the geometry runtime of the pours (manifold),
 * loaded once with preparaStratiFlessibili before the planes are poured.
 */
import { getManifoldModule, getManifoldModuleSync } from "@tscircuit/manifold-2d";
import type { Lato, Punto, ZonaFlessibile } from "./flex-zone";

type Anello = Array<[number, number]>;

const areaConSegno = (p: Anello): number => {
  let a = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += (p[j][0] + p[i][0]) * (p[j][1] - p[i][1]);
  return -a / 2;
};

/** loads the geometry runtime, when a board has independent flexible layers: the obstacles of the pours are worked out synchronously after */
export async function preparaStratiFlessibili(raw: string | undefined): Promise<void> {
  if (!raw || !raw.includes("flessibili")) return;
  try {
    await getManifoldModule();
  } catch {
    /* without it the obstacles fall back to the whole zone: see zonaSenzaLoStrato */
  }
}

/** how many times a piece with a hole is split before giving up: a zone has a handful of holes at most */
const MAX_TAGLI = 12;

/**
 * A polygon minus others, as polygons WITHOUT holes (the pour solver and the
 * checks take simple polygons): a piece that comes out with a hole is cut in
 * two through the hole, and again, until none has one (at most MAX_TAGLI cuts
 * deep: past that the outer rings are given as they are, which only ever cuts
 * away more copper, never less). null without the geometry runtime or on any
 * failure: the caller keeps the whole polygon.
 */
export function differenzaSenzaBuchi(a: Punto[], via: Punto[][]): Punto[][] | null {
  if (via.length === 0) return [a];
  const m = getManifoldModuleSync();
  if (!m) return null;
  const daLiberare: Array<{ delete(): void }> = [];
  try {
    const base = m.CrossSection.ofPolygons([a.map((p) => [p.x, p.y] as [number, number])], "EvenOdd");
    daLiberare.push(base);
    const tolte = m.CrossSection.ofPolygons(
      via.map((z) => z.map((p) => [p.x, p.y] as [number, number])),
      "NonZero",
    );
    daLiberare.push(tolte);
    const resto = base.subtract(tolte);
    daLiberare.push(resto);
    const out: Punto[][] = [];
    const lavora = (cs: ReturnType<typeof base.subtract>, profondita: number) => {
      const anelli = cs.toPolygons() as Anello[];
      const buco = anelli.find((r) => areaConSegno(r) < 0);
      if (!buco || profondita >= MAX_TAGLI) {
        for (const r of anelli) if (areaConSegno(r) > 1e-9) out.push(r.map(([x, y]) => ({ x, y })));
        return;
      }
      // cut through the hole, along x at its middle: each half has it open
      const xs = buco.map((p) => p[0]);
      const x = (Math.min(...xs) + Math.max(...xs)) / 2;
      const grande = 1e4;
      for (const [x0, x1] of [
        [-grande, x],
        [x, grande],
      ]) {
        const meta = m.CrossSection.ofPolygons([
          [
            [x0, -grande],
            [x1, -grande],
            [x1, grande],
            [x0, grande],
          ],
        ]);
        daLiberare.push(meta);
        const pezzo = cs.intersect(meta);
        daLiberare.push(pezzo);
        lavora(pezzo, profondita + 1);
      }
    };
    lavora(resto, 0);
    return out;
  } catch {
    return null;
  } finally {
    for (const o of daLiberare) {
      try {
        o.delete();
      } catch {
        /* already gone */
      }
    }
  }
}

/**
 * Where a zone is a hole in a copper layer it does not declare: the zone minus
 * every zone that declares the layer (another sheet lying over it). The whole
 * zone when none does, or without the geometry runtime.
 */
export function zonaSenzaLoStrato(zona: { punti: Punto[] }, strato: string, tutte: Array<{ punti: Punto[]; strati: string[] }>): Punto[][] {
  const sopra = tutte.filter((z) => z !== zona && z.strati.includes(strato)).map((z) => z.punti);
  if (sopra.length === 0) return [zona.punti];
  return differenzaSenzaBuchi(zona.punti, sopra) ?? [zona.punti];
}

/** the distance between two segments, zero when they cross */
function fraSegmenti(a: Lato, b: Lato): number {
  const d = (px: number, py: number, s: Lato) => {
    const vx = s.bx - s.ax;
    const vy = s.by - s.ay;
    const l2 = vx * vx + vy * vy;
    const t = l2 < 1e-18 ? 0 : Math.max(0, Math.min(1, ((px - s.ax) * vx + (py - s.ay) * vy) / l2));
    return Math.hypot(px - (s.ax + t * vx), py - (s.ay + t * vy));
  };
  const verso = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) => (qx - px) * (ry - py) - (qy - py) * (rx - px);
  const d1 = verso(b.ax, b.ay, b.bx, b.by, a.ax, a.ay);
  const d2 = verso(b.ax, b.ay, b.bx, b.by, a.bx, a.by);
  const d3 = verso(a.ax, a.ay, a.bx, a.by, b.ax, b.ay);
  const d4 = verso(a.ax, a.ay, a.bx, a.by, b.bx, b.by);
  if (d1 * d2 < 0 && d3 * d4 < 0) return 0;
  return Math.min(d(a.ax, a.ay, b), d(a.bx, a.by, b), d(b.ax, b.ay, a), d(b.bx, b.by, a));
}

/**
 * THE GAP BETWEEN TWO TAILS OF TWO SHEETS WHERE THEY LEAVE THE RIGID PART: the
 * shortest distance between the stretches of their outlines that are the
 * rigid/flex boundary (ZonaFlessibile.confini), and where it is. null when one
 * of the two has none.
 */
export function fessuraFraLeZone(a: ZonaFlessibile, b: ZonaFlessibile): { mm: number; dove: Punto } | null {
  let best: { mm: number; dove: Punto } | null = null;
  for (const la of a.confini) {
    for (const lb of b.confini) {
      const mm = fraSegmenti(la, lb);
      if (best && mm >= best.mm) continue;
      // the middle of the two nearest ends: where the dot goes
      const capi: Punto[] = [
        { x: la.ax, y: la.ay },
        { x: la.bx, y: la.by },
      ];
      const altri: Punto[] = [
        { x: lb.ax, y: lb.ay },
        { x: lb.bx, y: lb.by },
      ];
      let vicini = { p: capi[0], q: altri[0], d: Infinity };
      for (const p of capi) for (const q of altri) if (Math.hypot(p.x - q.x, p.y - q.y) < vicini.d) vicini = { p, q, d: Math.hypot(p.x - q.x, p.y - q.y) };
      best = { mm, dove: { x: (vicini.p.x + vicini.q.x) / 2, y: (vicini.p.y + vicini.q.y) / 2 } };
    }
  }
  return best;
}
