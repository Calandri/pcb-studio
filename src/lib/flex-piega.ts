/**
 * THE TAIL OF A RIGID-FLEX BOARD, FOLDED AS IT IS MOUNTED.
 *
 * flex.json says where a tail bends (a line, an angle, a side, an inner
 * radius); this file says where every point of the flat tail ends up once the
 * bends are made, so that the 3D view can show the board as it sits in the
 * enclosure and not as the flat sheet the fab cuts. It also writes the words
 * that say it ("piega 1: 90° verso il top", "in tutto 180° verso il top: torna
 * sopra la scheda"), the same in the PCB view and in 3D.
 *
 * THE MODEL. Coordinates are the board's (mm, Z up, z = 0 in the middle of the
 * rigid board's thickness, where the flexible layers run through it). A bend
 * curves the stretch of tail Piega.fascia: the middle of the tail's thickness
 * is an arc of radius `raggio + spessore / 2` (the inner face at the declared
 * inner radius) and of the declared angle, so the tail keeps its length. The
 * tail beyond the arc goes on straight. Bends are made from the rigid part
 * outwards, each one carrying all the tail beyond it, like folding a strip of
 * paper: a point is first folded by the outermost bend it has reached, then
 * moved along by every bend before it.
 *
 * Which side of a bend line is the rigid part: the side of the stretch where
 * the zone meets the rigid board (ZonaFlessibile.confini). A zone that meets
 * the rigid part nowhere, or bends whose arcs overlap, are not folded: the
 * tail stays flat rather than being drawn wrong (`nonPiegata` says why).
 *
 * Pure geometry, nothing of three: the viewer, its tests and the PCB view use it.
 */
import { dalSegmento, type Flessibile, type Piega, type Punto, type ZonaFlessibile } from "./flex-zone";

/** a point in space, board coordinates in mm, Z up */
export type Punto3 = [number, number, number];

export interface PiegaOrdinata {
  piega: Piega;
  /** 1 for the bend nearest the rigid part, then on along the tail */
  numero: number;
  /** a point of the line */
  c: Punto;
  /** along the line, unit */
  u: Punto;
  /** across the line, unit, pointing away from the rigid part */
  n: Punto;
  /** +1 the tail folds towards the top, -1 towards the bottom */
  s: 1 | -1;
  /** the radius of the middle of the thickness (mm) */
  rm: number;
  /** the angle, radians */
  theta: number;
  /** half the stretch the arc takes: rm * theta / 2 */
  h: number;
  /** where the line is from the rigid part, along n (mm): what orders the bends */
  distanza: number;
}

export interface CodaDaPiegare {
  zona: ZonaFlessibile;
  /** the bends of the zone, from the rigid part outwards; empty when the tail stays flat */
  pieghe: PiegaOrdinata[];
  /** the sum of the angles, positive towards the top (degrees) */
  angoloTotale: number;
  /** why the zone has bends and is not folded, when it is not */
  nonPiegata?: string;
}

export interface Piegatura {
  code: CodaDaPiegare[];
  /** thickness of the flexible part (mm) */
  spessoreMm: number;
}

/** the thickness used when flex.json declares no stack: a single-layer tail */
export const SPESSORE_FLESSIBILE_PREDEFINITO_MM = 0.1;

const sub = (a: Punto, b: Punto): Punto => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (a: Punto, b: Punto): number => a.x * b.x + a.y * b.y;

/** the nearest point of the boundaries with the rigid part to a point */
function vicinoAlRigido(zona: ZonaFlessibile, p: Punto): Punto | null {
  let best: Punto | null = null;
  let bestD = Infinity;
  for (const l of zona.confini) {
    const d = dalSegmento(p.x, p.y, l.ax, l.ay, l.bx, l.by);
    if (d >= bestD) continue;
    const vx = l.bx - l.ax;
    const vy = l.by - l.ay;
    const l2 = vx * vx + vy * vy;
    const t = l2 < 1e-18 ? 0 : Math.max(0, Math.min(1, ((p.x - l.ax) * vx + (p.y - l.ay) * vy) / l2));
    best = { x: l.ax + t * vx, y: l.ay + t * vy };
    bestD = d;
  }
  return best;
}

/** the bends of a board, zone by zone, ordered and ready to fold the tail */
export function piegaturaDi(flex: Flessibile): Piegatura {
  const spessoreMm = flex.pila?.spessoreMm ?? SPESSORE_FLESSIBILE_PREDEFINITO_MM;
  const code: CodaDaPiegare[] = [];
  for (const zona of flex.zone) {
    const proprie = flex.pieghe.filter((p) => p.zona?.id === zona.id);
    const ordinate: PiegaOrdinata[] = [];
    let nonPiegata: string | undefined;
    for (const piega of proprie) {
      const lung = Math.hypot(piega.b.x - piega.a.x, piega.b.y - piega.a.y);
      // flessibileDellaScheda already leaves out a line with no length: kept here so this never divides by zero
      if (!(lung > 1e-9)) continue;
      const u = { x: (piega.b.x - piega.a.x) / lung, y: (piega.b.y - piega.a.y) / lung };
      const mezzo = { x: (piega.a.x + piega.b.x) / 2, y: (piega.a.y + piega.b.y) / 2 };
      const rigido = vicinoAlRigido(zona, mezzo);
      if (!rigido) {
        nonPiegata = "la zona non tocca la parte rigida: non si sa da che parte piega";
        break;
      }
      let n = { x: -u.y, y: u.x };
      let distanza = dot(sub(mezzo, rigido), n);
      if (distanza < 0) {
        n = { x: -n.x, y: -n.y };
        distanza = -distanza;
      }
      const rm = piega.raggioMm + spessoreMm / 2;
      const theta = (Math.max(0, Math.min(180, piega.angolo)) * Math.PI) / 180;
      ordinate.push({ piega, numero: 0, c: piega.a, u, n, s: piega.verso === "su" ? 1 : -1, rm, theta, h: (rm * theta) / 2, distanza });
    }
    ordinate.sort((a, b) => a.distanza - b.distanza);
    ordinate.forEach((p, i) => (p.numero = i + 1));
    // two arcs that overlap along the tail cannot both be made: the tail is left flat rather than drawn through itself
    for (let i = 1; i < ordinate.length && !nonPiegata; i++) {
      const prima = ordinate[i - 1];
      const dopo = ordinate[i];
      const parallele = Math.abs(dot(prima.n, dopo.n)) > 1 - 1e-6;
      if (parallele && dopo.distanza - dopo.h < prima.distanza + prima.h - 1e-6) {
        nonPiegata = `le pieghe ${prima.numero} e ${dopo.numero} sono troppo vicine: i due archi si sovrappongono`;
      }
    }
    const angoloTotale = ordinate.reduce((t, p) => t + p.s * p.piega.angolo, 0);
    code.push({
      zona,
      pieghe: nonPiegata ? [] : ordinate,
      angoloTotale,
      ...(nonPiegata ? { nonPiegata } : {}),
    });
  }
  return { code, spessoreMm };
}

/**
 * A point after one bend. `parziale`: the point is folded where it is (flat
 * before the arc, on the arc, straight after it); otherwise the bend is the
 * rigid motion it gives the whole tail beyond its arc, applied to the point
 * whatever it is (the motion that carries along a tail already folded further on).
 */
function dopoLaPiega(p: PiegaOrdinata, q: Punto3, parziale: boolean): Punto3 {
  const rel = { x: q[0] - p.c.x, y: q[1] - p.c.y };
  const a = dot(rel, p.u);
  const d = dot(rel, p.n);
  const w = q[2];
  const lungo = d + p.h;
  if (parziale && lungo <= 0) return q;
  const arco = 2 * p.h;
  const phi = parziale ? Math.min(lungo, arco) / p.rm : p.theta;
  const oltre = parziale ? Math.max(0, lungo - arco) : lungo - arco;
  const sin = Math.sin(phi);
  const cos = Math.cos(phi);
  // along n and along z: the arc, then straight along the tangent, and the offset from the middle along the normal
  const lungoN = -p.h + p.rm * sin + oltre * cos - w * p.s * sin;
  const lungoZ = p.s * p.rm * (1 - cos) + oltre * p.s * sin + w * cos;
  return [p.c.x + a * p.u.x + lungoN * p.n.x, p.c.y + a * p.u.y + lungoN * p.n.y, lungoZ];
}

/**
 * Where a point of the flat tail goes once the tail is folded: (x, y) on the
 * board, w its height from the middle of the tail's thickness (+ the top face).
 */
export function piegaPunto(coda: CodaDaPiegare, x: number, y: number, w: number): Punto3 {
  const pieghe = coda.pieghe;
  let ultima = -1;
  for (let i = 0; i < pieghe.length; i++) {
    const p = pieghe[i];
    if ((x - p.c.x) * p.n.x + (y - p.c.y) * p.n.y > -p.h) ultima = i;
  }
  if (ultima < 0) return [x, y, w];
  let q = dopoLaPiega(pieghe[ultima], [x, y, w], true);
  for (let j = ultima - 1; j >= 0; j--) q = dopoLaPiega(pieghe[j], q, false);
  return q;
}

/**
 * The lines across the tail where the folded drawing needs a vertex: the
 * steps of every arc, so that a straight edge of a triangle never cuts across
 * a curve. Each is a line { punto on it, normale }: the side it separates is
 * dot(p - punto, normale).
 */
export function lineeDiTaglio(coda: CodaDaPiegare, gradiPerPasso = 7.5): Array<{ punto: Punto; normale: Punto }> {
  const out: Array<{ punto: Punto; normale: Punto }> = [];
  for (const p of coda.pieghe) {
    const passi = Math.max(2, Math.ceil(p.piega.angolo / gradiPerPasso));
    for (let i = 0; i <= passi; i++) {
      const d = -p.h + (2 * p.h * i) / passi;
      out.push({ punto: { x: p.c.x + d * p.n.x, y: p.c.y + d * p.n.y }, normale: p.n });
    }
  }
  return out;
}

const gradi = (v: number): string => `${Number.isInteger(v) ? v : Number(v.toFixed(1))}°`.replace(".", ",");
const faccia = (s: number): string => (s > 0 ? "verso il top" : "verso il bottom");

/** what a bend says next to its line: "piega 1: 90° verso il top" */
export function testoDellaPiega(p: PiegaOrdinata): string {
  return `piega ${p.numero}: ${gradi(p.piega.angolo)} ${faccia(p.s)}`;
}

/** what a tail says of itself, from its bends: "coda flessibile: in tutto 180° verso il top, torna sopra la scheda" */
export function testoDellaCoda(coda: CodaDaPiegare): string {
  const tutte = coda.pieghe.length;
  if (coda.nonPiegata) return `coda flessibile: ${coda.nonPiegata}`;
  if (tutte === 0) return "coda flessibile: nessuna piega dichiarata, resta piana";
  const t = coda.angoloTotale;
  const quanto = Math.abs(t);
  const vicino = (v: number) => Math.abs(quanto - v) < 0.5;
  const pieghe = tutte === 1 ? "una piega" : `${tutte} pieghe`;
  if (vicino(0)) return `coda flessibile: ${pieghe} opposte, in tutto 0°: esce parallela alla scheda`;
  const base = `coda flessibile: ${pieghe}, in tutto ${gradi(quanto)} ${faccia(t)}`;
  if (vicino(180)) return `${base}, torna ${t > 0 ? "sopra" : "sotto"} la scheda`;
  if (vicino(90)) return `${base}, esce in verticale ${t > 0 ? "sopra" : "sotto"} la scheda`;
  return base;
}

/** where a bend's words go on the PCB view: the middle of its line */
export function mezzoDellaPiega(p: PiegaOrdinata): Punto {
  return { x: (p.piega.a.x + p.piega.b.x) / 2, y: (p.piega.a.y + p.piega.b.y) / 2 };
}

/**
 * Where a tail's words go on the PCB view: just past the arc of its last bend,
 * in the middle of that line, so they sit on the tail; with no bend, in the
 * middle of the zone's box.
 */
export function postoDelTestoDellaCoda(coda: CodaDaPiegare, staccoMm = 1.6): Punto {
  const ultima = coda.pieghe.at(-1);
  if (!ultima) return { x: (coda.zona.minX + coda.zona.maxX) / 2, y: (coda.zona.minY + coda.zona.maxY) / 2 };
  const m = mezzoDellaPiega(ultima);
  const d = ultima.h + staccoMm;
  return { x: m.x + d * ultima.n.x, y: m.y + d * ultima.n.y };
}
