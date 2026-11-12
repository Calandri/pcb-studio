/**
 * THE GEOMETRY OF "SPINGI E SPOSTA": whole coordinates, support lines, the
 * exact check of the directions, and the distances.
 *
 * WHOLE NUMBERS. A stretch of trace goes at 0, 45, 90 or 135 degrees, and the
 * gesture must leave it there: not "within three degrees", there. On floats
 * that is a question of tolerances; on whole tenths of a micron (0.0001 mm,
 * the grid a correction of the copper is saved on) it is an equality:
 * `dx == 0 || dy == 0 || |dx| == |dy|`. So everything that decides where a
 * corner goes is done on whole numbers here (lines, crossings, steps), and a
 * corner is never rounded: either it falls on the grid or the move is not made.
 *
 * THE DISTANCES are the ones of the DRC (drc.ts), in millimetres, on the real
 * shapes: there is no second way of measuring. This file only adds what the
 * DRC has no use for (a zone, the foot of a point on a segment).
 *
 * No React, nothing of the server: the solver runs in the viewer.
 */
import { dentroPoligono, pointSegDistance, segSegDistanceRaw } from "../drc";
import type { Sagoma } from "../zona";

export { dentroPoligono, distanzaPuntoForma, distanzaSegmentoForma, pointSegDistance as distanzaPuntoSegmento, segSegDistanceRaw as distanzaSegmenti } from "../drc";

/** how many units of the grid a millimetre is: a unit is a tenth of a micron */
export const UNITA_PER_MM = 1e4;

/**
 * Millimetres as whole units of the grid; a number already on the grid comes
 * back as its own count. Never the negative zero a rounding or a division can
 * give: it is the same place, but it is not written nor compared as one.
 */
export const inUnita = (mm: number): number => Math.round(mm * UNITA_PER_MM) + 0;

/** whole units as millimetres: the number a correction writes (round4 of manual-routes.ts gives the same) */
export const inMm = (unita: number): number => unita / UNITA_PER_MM;

/** a point; in whole units wherever this file works a line or a corner out, in mm for the distances */
export interface Punto {
  x: number;
  y: number;
}

/** one of the eight directions a stretch can have: each component is -1, 0 or 1, and not both 0 */
export interface Direzione {
  dx: number;
  dy: number;
}

/**
 * THE CHECK: a stretch from one point of the grid to another is at 0, 45 or 90
 * degrees, and has a length. In whole units, with no tolerance.
 */
export function direzioneEsatta(dx: number, dy: number): boolean {
  return (dx !== 0 || dy !== 0) && (dx === 0 || dy === 0 || Math.abs(dx) === Math.abs(dy));
}

/** the direction from `a` to `b` (whole units); null when it is not one of the eight, or the two are one place */
export function direzioneFra(a: Punto, b: Punto): Direzione | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return direzioneEsatta(dx, dy) ? { dx: Math.sign(dx), dy: Math.sign(dy) } : null;
}

/** how far a stretch may be from one of the eight directions and still HAVE it, in units: a micron */
export const TOLLERANZA_DI_DIREZIONE = 10;

/**
 * THE DIRECTION A STRETCH HAS, EXACT OR BY A HAIR. The sources of a board
 * write stretches at 45 degrees with their ends rounded: off the exact
 * direction by a few tenths of a micron (measured on a real board: 104 of 994
 * stretches, 101 of them by 0.2 micron at most). Such a stretch has the
 * direction it was drawn at. A move READS that direction and WRITES exact
 * copper: the line it works on goes through the end of the stretch that does
 * not move, at the exact direction.
 *
 * Null when the stretch is further than the tolerance from every direction;
 * a stretch shorter than the tolerance both ways has a direction only if it
 * is exactly at one.
 */
export function direzioneVicina(a: Punto, b: Punto): Direzione | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lungoX = Math.abs(dx);
  const lungoY = Math.abs(dy);
  if (lungoX <= TOLLERANZA_DI_DIREZIONE && lungoY <= TOLLERANZA_DI_DIREZIONE) return direzioneFra(a, b);
  const scarto = Math.min(lungoX, lungoY, Math.abs(lungoX - lungoY));
  if (scarto > TOLLERANZA_DI_DIREZIONE) return null;
  if (scarto === lungoX) return { dx: 0, dy: Math.sign(dy) };
  if (scarto === lungoY) return { dx: Math.sign(dx), dy: 0 };
  return { dx: Math.sign(dx), dy: Math.sign(dy) };
}

export const eDiagonale = (d: Direzione): boolean => d.dx !== 0 && d.dy !== 0;

/** how long one step along a direction is, in mm: a unit, or its diagonal */
export const passoMm = (d: Direzione): number => (eDiagonale(d) ? Math.SQRT2 : 1) / UNITA_PER_MM;

/** the scalar product of two directions: above 0 they turn by 45 degrees or less, 0 a right angle, below 0 an acute corner */
export const prodotto = (a: Direzione, b: Direzione): number => a.dx * b.dx + a.dy * b.dy;

/**
 * How many steps along `d` it takes to go from `da` to `a`, with its sign:
 * negative when `a` is behind. The two must be on one line of that direction.
 */
export function passiLungo(da: Punto, a: Punto, d: Direzione): number {
  return d.dx !== 0 ? (a.x - da.x) * d.dx : (a.y - da.y) * d.dy;
}

/** the point `passi` steps from `da` along `d` */
export const avanti = (da: Punto, d: Direzione, passi: number): Punto => ({ x: da.x + d.dx * passi, y: da.y + d.dy * passi });

/**
 * THE SUPPORT LINE of a stretch: every point with `a*x + b*y = c`, where (a, b)
 * is the normal of the direction, itself made of -1, 0 and 1. Moving the
 * stretch sideways is changing `c`, and nothing else: the direction stays.
 */
export interface Retta {
  a: number;
  b: number;
  c: number;
}

/** the line through `p` (whole units) that goes along `d` */
export function rettaDi(p: Punto, d: Direzione): Retta {
  return { a: -d.dy, b: d.dx, c: -d.dy * p.x + d.dx * p.y };
}

/** the same line moved sideways: `c` changed by `quanto` */
export const traslata = (r: Retta, quanto: number): Retta => ({ a: r.a, b: r.b, c: r.c + quanto });

export type Incrocio =
  | { tipo: "punto"; x: number; y: number }
  /** the two lines have one direction: they meet nowhere, or everywhere */
  | { tipo: "parallele" }
  /**
   * Two lines at 45 degrees that cross between two points of the grid, on a
   * half unit. No corner is put there: rounded, it would bend both stretches.
   */
  | { tipo: "mezza_unita" };

/** where two support lines cross, in whole units */
export function incrocio(r: Retta, s: Retta): Incrocio {
  const det = r.a * s.b - r.b * s.a;
  if (det === 0) return { tipo: "parallele" };
  const x = r.c * s.b - r.b * s.c;
  const y = r.a * s.c - r.c * s.a;
  if (x % det !== 0 || y % det !== 0) return { tipo: "mezza_unita" };
  return { tipo: "punto", x: x / det + 0, y: y / det + 0 };
}

/**
 * By how much `c` can change so that the line still crosses `altra` on the
 * grid: any whole number, or only the even ones for two lines at 45 degrees
 * (they cross on the grid every second step).
 */
export function passoDiTraslazione(r: Retta, altra: Retta): number {
  return Math.abs(r.a * altra.b - r.b * altra.a) === 2 ? 2 : 1;
}

/** the point of the segment a-b nearest to p (mm) */
export function piedeSulSegmento(px: number, py: number, ax: number, ay: number, bx: number, by: number): Punto {
  const dx = bx - ax;
  const dy = by - ay;
  const lunga2 = dx * dx + dy * dy;
  if (lunga2 < 1e-12) return { x: ax, y: ay };
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lunga2));
  return { x: ax + t * dx, y: ay + t * dy };
}

/**
 * The point of the segment c-d nearest to the segment a-b (mm): where the two
 * come closest, to say WHERE something blocks. For two segments that cross it
 * is a point of c-d next to the crossing, which is near enough for a marker.
 */
export function puntoVicino(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): Punto {
  const candidati: Array<[number, Punto]> = [
    [pointSegDistance(cx, cy, ax, ay, bx, by), { x: cx, y: cy }],
    [pointSegDistance(dx, dy, ax, ay, bx, by), { x: dx, y: dy }],
    [pointSegDistance(ax, ay, cx, cy, dx, dy), piedeSulSegmento(ax, ay, cx, cy, dx, dy)],
    [pointSegDistance(bx, by, cx, cy, dx, dy), piedeSulSegmento(bx, by, cx, cy, dx, dy)],
  ];
  let scelto = candidati[0];
  for (const c of candidati) if (c[0] < scelto[0]) scelto = c;
  return scelto[1];
}

/**
 * How far a segment is from a zone (a keepout, a cutout: see zona.ts), in mm:
 * 0 when it touches it or enters it. A point is a segment of no length.
 */
export function distanzaSegmentoZona(z: Sagoma, ax: number, ay: number, bx: number, by: number): number {
  if ("tratti" in z) {
    let d = Infinity;
    for (const [p, q] of z.tratti) d = Math.min(d, segSegDistanceRaw(ax, ay, bx, by, p.x, p.y, q.x, q.y));
    return Math.max(0, d - z.r);
  }
  if ("r" in z) return Math.max(0, pointSegDistance(z.x, z.y, ax, ay, bx, by) - z.r);
  if (dentroPoligono(ax, ay, z.punti) || dentroPoligono(bx, by, z.punti)) return 0;
  let d = Infinity;
  for (let i = 0, j = z.punti.length - 1; i < z.punti.length; j = i++) {
    d = Math.min(d, segSegDistanceRaw(ax, ay, bx, by, z.punti[j].x, z.punti[j].y, z.punti[i].x, z.punti[i].y));
  }
  return d;
}

/** the box that holds a zone */
export function scatolaDellaZona(z: Sagoma): { minX: number; maxX: number; minY: number; maxY: number } {
  const punti = "tratti" in z ? z.tratti.flat() : "r" in z ? [{ x: z.x, y: z.y }] : z.punti;
  const r = "r" in z ? z.r : 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of punti) {
    minX = Math.min(minX, p.x - r);
    maxX = Math.max(maxX, p.x + r);
    minY = Math.min(minY, p.y - r);
    maxY = Math.max(maxY, p.y + r);
  }
  return { minX, maxX, minY, maxY };
}
