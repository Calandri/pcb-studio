/**
 * THE SHAPES A POUR IS CUT AROUND, DRAWN THE WAY A CAD DRAWS THEM.
 *
 * Niccolo' looked at the new ground pours of sbb-dl-principale on 2026-11-11 and
 * asked whether the pouring method was a good one: the edges were staircases
 * and scallops, and the largest top pour of one window had 744 edges with a
 * median length of 6 micrometres. The method was sound (cut every obstacle out
 * of the outline, then open the result by the minimum width, as Altium and
 * KiCad do); the shapes it worked on were not.
 *
 * The solver tscircuit ships (@tscircuit/copper-pour-solver) draws every
 * circle, a via of 0.4 mm or a hole of 2.2 mm alike, as 32 points ON the
 * circle, so the chords cut into the clearance (6 micrometres around a 2.2 mm
 * hole, under the clearance the board asks for); it grows a rectangular pad
 * into a bigger rectangle with square corners; and around a polygon it uses a
 * mitred offset. KiCad grows every obstacle by the clearance with round
 * corners, and approximates each arc with as many segments as its radius
 * needs to stay within a maximum error, the polygon always OUTSIDE the true
 * curve so the clearance is never short.
 *
 * Here are those shapes: circles, capsules (a trace segment, the end of a
 * pill) and rounded rectangles, approximated within ERRORE_CORDA_MM and
 * circumscribed (no point of the true shape outside the polygon, no point of
 * the polygon farther than the error from it); a polygon grown with round
 * corners; and the clean-up of a finished ring, which merges what is collinear
 * and drops the vertices an arc does not need, only ever taking copper away.
 */
import { getManifoldModuleSync } from "@tscircuit/manifold-2d";

export type Punto = { x: number; y: number };

/**
 * The most an arc may stray from the true curve, in mm. KiCad's default
 * "maximum allowed deviation" is 5 micrometres; 2 keep a via of 0.45 mm round
 * with 32 segments and a mounting hole with 56, and make no edge of a corner
 * rounded by half the minimum width shorter than about 25 micrometres.
 */
export const ERRORE_CORDA_MM = 0.002;

/**
 * How much a vertex may stand inward of the line through its neighbours and
 * still be dropped when it is cleaned: copper is only ever taken away, by at
 * most this much, and a fab does not see a micrometre.
 */
export const TOLLERANZA_PULIZIA_MM = 0.001;

/**
 * What counts as "on the line" for a vertex whose removal would ADD copper:
 * ten nanometres, the noise of the solver's own rounding (it snaps every
 * point to the nanometre). Nothing is moved toward an obstacle beyond that.
 */
const RUMORE_MM = 1e-5;

/**
 * Segments of a full turn so that a circumscribed polygon of radius r strays
 * from the circle by at most `errore`: r / cos(pi / n) - r <= errore. A
 * multiple of four, so the quarter turns of a rounded rectangle and the half
 * turns of a capsule meet their straight sides on a vertex.
 */
export function segmentiPerCerchio(r: number, errore = ERRORE_CORDA_MM): number {
  if (!(r > 0) || !(errore > 0)) return 8;
  const n = Math.ceil(Math.PI / Math.acos(r / (r + errore)));
  return Math.min(1024, Math.max(8, Math.ceil(n / 4) * 4));
}

/**
 * The same for a polygon drawn ON the circle (what Clipper's round joins do):
 * r - r * cos(pi / n) <= errore.
 */
export function segmentiInscritti(r: number, errore = ERRORE_CORDA_MM): number {
  if (!(r > 0) || !(errore > 0) || errore >= r) return 8;
  const n = Math.ceil(Math.PI / Math.acos(1 - errore / r));
  return Math.min(1024, Math.max(8, Math.ceil(n / 4) * 4));
}

/**
 * Points of an arc of radius r around (cx, cy), from angle `da` for `ampiezza`
 * radians, `fuori` circumscribed (the chords touch the circle, the corners
 * stand outside it) or not (the points on the circle). The tangents of the
 * first and last chord are the arc's own ends, so a straight side that leaves
 * the arc there meets it on a vertex, in line.
 */
function arco(cx: number, cy: number, r: number, da: number, ampiezza: number, n: number, fuori: boolean): Punto[] {
  const passi = Math.max(1, Math.round((ampiezza / (2 * Math.PI)) * n));
  const passo = ampiezza / passi;
  const out: Punto[] = [];
  if (fuori) {
    const R = r / Math.cos(passo / 2);
    for (let k = 0; k < passi; k++) {
      const a = da + (k + 0.5) * passo;
      out.push({ x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) });
    }
  } else {
    for (let k = 0; k <= passi; k++) {
      const a = da + k * passo;
      out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
  }
  return out;
}

/** a circle, counter-clockwise; circumscribed unless `dentro` */
export function cerchio(cx: number, cy: number, r: number, errore = ERRORE_CORDA_MM, dentro = false): Punto[] {
  const n = dentro ? segmentiInscritti(r, errore) : segmentiPerCerchio(r, errore);
  if (dentro) return arco(cx, cy, r, 0, 2 * Math.PI, n, false).slice(0, -1);
  return arco(cx, cy, r, 0, 2 * Math.PI, n, true);
}

/**
 * A segment from a to b swept by a disc of radius r: what a trace of width 2r
 * is, and what a trace is plus a clearance. A point when a and b coincide.
 */
export function capsula(a: Punto, b: Punto, r: number, errore = ERRORE_CORDA_MM, dentro = false): Punto[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l = Math.hypot(dx, dy);
  if (l < 1e-9) return cerchio(a.x, a.y, r, errore, dentro);
  const n = dentro ? segmentiInscritti(r, errore) : segmentiPerCerchio(r, errore);
  const dir = Math.atan2(dy, dx);
  return [
    ...arco(b.x, b.y, r, dir - Math.PI / 2, Math.PI, n, !dentro),
    ...arco(a.x, a.y, r, dir + Math.PI / 2, Math.PI, n, !dentro),
  ];
}

/**
 * A w x h rectangle centred on (cx, cy), corners rounded by `raggio` (none at
 * zero, a pill at half the short side), turned counter-clockwise by `gradi`.
 */
export function rettangoloArrotondato(
  cx: number,
  cy: number,
  w: number,
  h: number,
  raggio: number,
  gradi = 0,
  errore = ERRORE_CORDA_MM,
  dentro = false,
): Punto[] {
  const rc = Math.max(0, Math.min(raggio, w / 2, h / 2));
  const hx = w / 2 - rc;
  const hy = h / 2 - rc;
  let locali: Punto[];
  if (rc < 1e-9) {
    locali = [
      { x: -w / 2, y: -h / 2 },
      { x: w / 2, y: -h / 2 },
      { x: w / 2, y: h / 2 },
      { x: -w / 2, y: h / 2 },
    ];
  } else {
    const n = dentro ? segmentiInscritti(rc, errore) : segmentiPerCerchio(rc, errore);
    locali = [
      ...arco(hx, -hy, rc, -Math.PI / 2, Math.PI / 2, n, !dentro),
      ...arco(hx, hy, rc, 0, Math.PI / 2, n, !dentro),
      ...arco(-hx, hy, rc, Math.PI / 2, Math.PI / 2, n, !dentro),
      ...arco(-hx, -hy, rc, Math.PI, Math.PI / 2, n, !dentro),
    ];
  }
  const rad = (gradi * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return locali.map((p) => ({ x: cx + p.x * cos - p.y * sin, y: cy + p.x * sin + p.y * cos }));
}

/** signed area, positive counter-clockwise */
export function areaConSegno(punti: Punto[]): number {
  let s = 0;
  for (let i = 0; i < punti.length; i++) {
    const a = punti[i];
    const b = punti[(i + 1) % punti.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

/**
 * A polygon grown by `deltaMm` with round corners, as the outlines of what
 * comes out (a growth that closes a notch into a hole gives the hole back
 * filled: only what keeps copper away matters here, and a filled notch keeps
 * more of it away). Clipper draws its round corners ON the arc, so the growth
 * asked of it is a hair more than `deltaMm`, by as much as its chords fall
 * short: every point of the result is at least `deltaMm` from the polygon and
 * at most `deltaMm` plus the chord error. Without the geometry runtime, or on
 * any failure, null: the caller keeps what it had.
 */
export function poligonoCresciuto(punti: Punto[], deltaMm: number, errore = ERRORE_CORDA_MM): Punto[][] | null {
  if (punti.length < 3) return null;
  if (!(deltaMm > 0)) return [punti];
  const m = getManifoldModuleSync();
  if (!m) return null;
  const daLiberare: Array<{ delete(): void }> = [];
  try {
    const n = segmentiInscritti(deltaMm, errore);
    const base = m.CrossSection.ofPolygons([punti.map((p) => [p.x, p.y] as [number, number])], "EvenOdd");
    daLiberare.push(base);
    const largo = base.offset(deltaMm / Math.cos(Math.PI / n), "Round", 2, n);
    daLiberare.push(largo);
    const fuori = (largo.toPolygons() as Array<Array<[number, number]>>)
      .map((c) => c.map(([x, y]) => ({ x, y })))
      .filter((c) => c.length >= 3 && areaConSegno(c) > 0);
    return fuori.length > 0 ? fuori : null;
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
 * A FINISHED RING, CLEANED.
 *
 * Booleans and offsets leave on a ring what no CAD would write: points in a
 * straight line, the remainder of an arc step a micrometre long where it meets
 * a side, and on the rounded corners more points than the arc needs. Here a
 * run of vertices is replaced by the chord from the first to the last when no
 * vertex of the run stands more than TOLLERANZA_PULIZIA_MM on the far side of
 * the chord from the copper, and none at all on the copper side (beyond the
 * solver's own rounding): the chord only ever cuts copper away, never moves it
 * toward anything. `rameDentro` says which side the copper is: inside for an
 * outer ring, outside for a hole.
 *
 * It is Douglas-Peucker with that one-sided test: a run that fails is split at
 * its worst vertex, which is kept. Every vertex dropped is within the
 * tolerance of the chord that replaced it, measured on the ring that came in,
 * and a ring already cleaned comes back as it is (the vertices kept are the
 * ones that made a run fail, and they still do), so a board cleaned twice is
 * the same board.
 */
export function anelloPulito(punti: Punto[], rameDentro: boolean, tolleranza = TOLLERANZA_PULIZIA_MM): Punto[] {
  /* consecutive duplicates first: they have no direction */
  const p: Punto[] = [];
  for (const q of punti) {
    const ultimo = p[p.length - 1];
    if (!ultimo || Math.hypot(q.x - ultimo.x, q.y - ultimo.y) > 1e-7) p.push(q);
  }
  while (p.length > 1 && Math.hypot(p[0].x - p[p.length - 1].x, p[0].y - p[p.length - 1].y) <= 1e-7) p.pop();
  const n = p.length;
  if (n < 4) return p;
  const area = areaConSegno(p);
  if (area === 0) return p;
  /* +1: the copper is on the left of each edge; -1: on the right */
  const lato = (area > 0 ? 1 : -1) * (rameDentro ? 1 : -1);
  /** how badly vertex k forbids the chord from a to c: zero when it allows it */
  const violazione = (k: number, ia: number, ic: number): number => {
    const a = p[ia % n];
    const c = p[ic % n];
    const b = p[k % n];
    const dx = c.x - a.x;
    const dy = c.y - a.y;
    const l = Math.hypot(dx, dy);
    if (l < 1e-9) return Math.hypot(b.x - a.x, b.y - a.y) + 1;
    // positive: on the copper side of the chord
    const d = (lato * (dx * (b.y - a.y) - dy * (b.x - a.x))) / l;
    // and within the chord's length, or the run doubles back on itself
    const t = ((b.x - a.x) * dx + (b.y - a.y) * dy) / (l * l);
    return Math.max(0, d - RUMORE_MM, -d - tolleranza, (-t - 1e-9) * l, (t - 1 - 1e-9) * l);
  };
  /*
   * Two anchors that every cleaning of this ring picks again: the lowest-left
   * vertex, and the vertex farthest from it.
   */
  let s = 0;
  for (let i = 1; i < n; i++) if (p[i].x < p[s].x || (p[i].x === p[s].x && p[i].y < p[s].y)) s = i;
  let f = s;
  let lontano = -1;
  for (let i = 0; i < n; i++) {
    const d = Math.hypot(p[i].x - p[s].x, p[i].y - p[s].y);
    if (d > lontano) {
      lontano = d;
      f = i;
    }
  }
  const tieni = new Uint8Array(n);
  tieni[s] = 1;
  tieni[f] = 1;
  const fUnrolled = f > s ? f : f + n;
  const pila: Array<[number, number]> = [
    [s, fUnrolled],
    [fUnrolled, s + n],
  ];
  while (pila.length > 0) {
    const [a, c] = pila.pop()!;
    if (c - a < 2) continue;
    let peggiore = -1;
    let quanto = 0;
    for (let k = a + 1; k < c; k++) {
      const v = violazione(k, a, c);
      if (v > quanto) {
        quanto = v;
        peggiore = k;
      }
    }
    if (peggiore < 0) continue;
    tieni[peggiore % n] = 1;
    pila.push([a, peggiore], [peggiore, c]);
  }
  const out: Punto[] = [];
  for (let i = 0; i < n; i++) if (tieni[i]) out.push(p[i]);
  return out.length >= 3 ? out : p;
}
