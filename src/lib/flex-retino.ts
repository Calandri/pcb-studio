/**
 * THE COPPER OF A FLEXIBLE ZONE AS A GRID (`retino` in flex.json).
 *
 * A solid plane on a tail that bends is the copper most likely to crack: PCB
 * Basic asks for a grid there ("Use grid ground layer to enhance flexibility
 * and reduce the risk of copper cracking", and in its summary "use hatched
 * ground planes for improved flexibility",
 * https://www.pcbasic.com/blog/flex_pcb_design.html), and where the fab has
 * written what it wants the board follows it (Niccolo', 2026-11-18). A zone of
 * flex.json can ask one:
 *
 *   "retino": { "larghezzaMm": 0.3, "passoMm": 0.8, "angolo": 45, "dove": "piega" }
 *
 * lines `larghezzaMm` wide every `passoMm`, in two directions at right angles,
 * turned by `angolo`; `dove` "piega" lays it on the stretch of tail each bend
 * of the zone curves (Piega.fascia) and `margineMm` beyond it on each side,
 * "tutta" on the whole zone. Everywhere else the copper stays solid.
 *
 * HOW. A grid is a plane with square holes in it, so that is what is written:
 * after the planes are poured, every pour of a layer the zone declares gets,
 * as more holes of its shape, the squares between the lines (side `passoMm` -
 * `larghezzaMm`, on a lattice that starts at the origin of the board, so two
 * pours of one zone share it). The viewer and the Gerber draw a pour with its
 * holes already: they show and write the grid with nothing added.
 *
 * WHAT IT CANNOT BREAK. A square is cut only where it stands whole in the
 * copper of the pour with at least a line's width of copper all around it:
 * from the outline of the pour, from every hole it already has (a via of
 * another net, a window, a cutout) and, by the lattice, from the next square.
 * So no line of the grid and no strip left along an edge is narrower than
 * `larghezzaMm`, which the file may not write under the project's minimum
 * trace width; and since every square is a hole in the middle of copper, the
 * pour stays ONE piece, joined to the plane of the rigid part as it was: no
 * pour is split and none becomes an island. Where a square does not fit, the
 * copper is left solid.
 *
 * The holes of the grid are marked (ANELLO_DEL_RETINO): laying the grid again
 * takes them off first, so a board gets the same grid however many times it is
 * laid, and whoever has to work on the solid plane (the recheck, which takes
 * the necks out of a pour) can have it back (senzaRetino).
 */
import { fasciaDi, flessibileDellaScheda, profondita, ZONA_FLESSIBILE, type Punto, type Retino, type ZonaFlessibile } from "./flex-zone";

type El = Record<string, unknown> & { type: string };
type Anello = { vertices?: Punto[] } & Record<string, unknown>;
type Forma = { outer_ring?: Anello; inner_rings?: Anello[] };

/** what marks a hole of a pour as a square of the grid */
export const ANELLO_DEL_RETINO = "pcb_studio_retino";
/** at most this many squares in one zone, all its pours together: a grid finer than that is a typo */
export const MAX_APERTURE_RETINO = 20_000;
/** a square this near to copper it must keep a line away from is too near: a micron of slack on the line's width */
const SLACK_MM = 1e-6;

const eDelRetino = (a: Anello): boolean => a[ANELLO_DEL_RETINO] === true;

/**
 * The board with its pours solid again: every hole of the grid taken off.
 * A board with no grid on it is given back as it came.
 */
export function senzaRetino<T extends El>(circuitJson: T[]): T[] {
  let cambiato = false;
  const out = circuitJson.map((el) => {
    if (el.type !== "pcb_copper_pour") return el;
    const forma = el.brep_shape as Forma | undefined;
    const buchi = forma?.inner_rings;
    if (!forma || !Array.isArray(buchi) || !buchi.some(eDelRetino)) return el;
    cambiato = true;
    return { ...el, brep_shape: { ...forma, inner_rings: buchi.filter((a) => !eDelRetino(a)) } };
  });
  return cambiato ? out : circuitJson;
}

/** the distance between two segments: zero when they cross */
function fraSegmenti(a: Punto, b: Punto, c: Punto, d: Punto): number {
  const verso = (p: Punto, q: Punto, r: Punto) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = verso(a, b, c);
  const d2 = verso(a, b, d);
  const d3 = verso(c, d, a);
  const d4 = verso(c, d, b);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  const dalSegmento = (p: Punto, q: Punto, r: Punto): number => {
    const vx = r.x - q.x;
    const vy = r.y - q.y;
    const l2 = vx * vx + vy * vy;
    const t = l2 < 1e-18 ? 0 : Math.max(0, Math.min(1, ((p.x - q.x) * vx + (p.y - q.y) * vy) / l2));
    return Math.hypot(p.x - (q.x + t * vx), p.y - (q.y + t * vy));
  };
  return Math.min(dalSegmento(a, c, d), dalSegmento(b, c, d), dalSegmento(c, a, b), dalSegmento(d, a, b));
}

/** point in a ring, ray casting */
function nellAnello(x: number, y: number, anello: Punto[]): boolean {
  let dentro = false;
  for (let i = 0, j = anello.length - 1; i < anello.length; j = i++) {
    const a = anello[i];
    const b = anello[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) dentro = !dentro;
  }
  return dentro;
}

/** the sides of the rings of a pour near a region, in the cells of a grid: what a square is measured against */
class LatiDellaColata {
  private celle = new Map<string, number[]>();
  private lati: Array<[Punto, Punto]> = [];
  constructor(
    anelli: Punto[][],
    private cella: number,
    scatola: { minX: number; minY: number; maxX: number; maxY: number },
  ) {
    for (const anello of anelli) {
      for (let i = 0; i < anello.length; i++) {
        const a = anello[i];
        const b = anello[(i + 1) % anello.length];
        if (Math.max(a.x, b.x) < scatola.minX || Math.min(a.x, b.x) > scatola.maxX || Math.max(a.y, b.y) < scatola.minY || Math.min(a.y, b.y) > scatola.maxY) continue;
        const k = this.lati.push([a, b]) - 1;
        // a side of the outline of a big plane can be a hundred millimetres long: only the cells of the region
        const x0 = Math.floor(Math.max(Math.min(a.x, b.x), scatola.minX) / cella);
        const x1 = Math.floor(Math.min(Math.max(a.x, b.x), scatola.maxX) / cella);
        const y0 = Math.floor(Math.max(Math.min(a.y, b.y), scatola.minY) / cella);
        const y1 = Math.floor(Math.min(Math.max(a.y, b.y), scatola.maxY) / cella);
        for (let gx = x0; gx <= x1; gx++) {
          for (let gy = y0; gy <= y1; gy++) {
            const chiave = `${gx},${gy}`;
            const l = this.celle.get(chiave);
            if (l) l.push(k);
            else this.celle.set(chiave, [k]);
          }
        }
      }
    }
  }
  /** whether a side of the pour comes nearer than `d` to a square, or lies in it */
  vicino(quadrato: Punto[], d: number): boolean {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of quadrato) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
    const visti = new Set<number>();
    for (let gx = Math.floor((minX - d) / this.cella); gx <= Math.floor((maxX + d) / this.cella); gx++) {
      for (let gy = Math.floor((minY - d) / this.cella); gy <= Math.floor((maxY + d) / this.cella); gy++) {
        for (const k of this.celle.get(`${gx},${gy}`) ?? []) {
          if (visti.has(k)) continue;
          visti.add(k);
          const [a, b] = this.lati[k];
          // an end of the side in the square: the side is in it or enters it, even where it only touches a corner
          if (nellAnello(a.x, a.y, quadrato) || nellAnello(b.x, b.y, quadrato)) return true;
          for (let i = 0; i < 4; i++) {
            if (fraSegmenti(a, b, quadrato[i], quadrato[(i + 1) % 4]) < d - SLACK_MM) return true;
          }
        }
      }
    }
    return false;
  }
}

/** where a zone wants its grid: the stretches its bends curve, each grown by the margin, or null for the whole zone */
function doveIlRetino(zona: ZonaFlessibile, retino: Retino, pieghe: Array<{ a: Punto; b: Punto; mezzaFasciaMm: number; zona: ZonaFlessibile | null }>): Punto[][] | null {
  if (retino.dove === "tutta") return null;
  return pieghe.filter((p) => p.zona === zona).map((p) => fasciaDi(p.a, p.b, p.mezzaFasciaMm + retino.margineMm));
}

/**
 * The squares of a zone's grid that fit in one pour: each whole in the zone and
 * in the region the grid is asked for, whole in the copper of the pour, and a
 * line's width from every side of the pour. Clockwise, as the holes of a pour
 * are written. `resto` is how many more the zone may still have.
 */
function quadratiPer(forma: Forma, zona: ZonaFlessibile, retino: Retino, regioni: Punto[][] | null, resto: number): Punto[][] {
  const esterno = forma.outer_ring?.vertices ?? [];
  if (esterno.length < 3 || resto <= 0) return [];
  const buchi = (forma.inner_rings ?? []).map((a) => a.vertices ?? []).filter((v) => v.length >= 3);
  // the box of every hole: a plane has hundreds of them and a square is in one at most
  const scatole = buchi.map((b) => {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const q of b) {
      minX = Math.min(minX, q.x);
      maxX = Math.max(maxX, q.x);
      minY = Math.min(minY, q.y);
      maxY = Math.max(maxY, q.y);
    }
    return { minX, maxX, minY, maxY };
  });
  const inUnBuco = (x: number, y: number): boolean =>
    buchi.some((b, k) => x >= scatole[k].minX && x <= scatole[k].maxX && y >= scatole[k].minY && y <= scatole[k].maxY && nellAnello(x, y, b));
  const w = retino.larghezzaMm;
  const p = retino.passoMm;
  const lato = p - w;
  const rad = (retino.angolo * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  /** from the axes of the grid to the board's */
  const inScheda = (u: number, v: number): Punto => ({ x: u * cos - v * sin, y: u * sin + v * cos });
  const zone = regioni ?? [zona.punti];
  const fuori: Punto[][] = [];
  const messi = new Set<string>();
  for (const regione of zone) {
    // the box of the region, in the axes of the grid and on the board
    let u0 = Infinity;
    let u1 = -Infinity;
    let v0 = Infinity;
    let v1 = -Infinity;
    const scatola = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const q of regione) {
      const u = q.x * cos + q.y * sin;
      const v = -q.x * sin + q.y * cos;
      u0 = Math.min(u0, u);
      u1 = Math.max(u1, u);
      v0 = Math.min(v0, v);
      v1 = Math.max(v1, v);
      scatola.minX = Math.min(scatola.minX, q.x - w);
      scatola.maxX = Math.max(scatola.maxX, q.x + w);
      scatola.minY = Math.min(scatola.minY, q.y - w);
      scatola.maxY = Math.max(scatola.maxY, q.y + w);
    }
    const lati = new LatiDellaColata([esterno, ...buchi], Math.max(p, 0.5), scatola);
    for (let i = Math.floor(u0 / p); i <= Math.ceil(u1 / p); i++) {
      for (let j = Math.floor(v0 / p); j <= Math.ceil(v1 / p); j++) {
        if (fuori.length >= resto) return fuori;
        const chiave = `${i},${j}`;
        if (messi.has(chiave)) continue;
        const uc = (i + 0.5) * p;
        const vc = (j + 0.5) * p;
        // clockwise on the board (y up): the way the holes of a pour turn
        const quadrato = [inScheda(uc - lato / 2, vc - lato / 2), inScheda(uc - lato / 2, vc + lato / 2), inScheda(uc + lato / 2, vc + lato / 2), inScheda(uc + lato / 2, vc - lato / 2)];
        // whole in the zone, a line's width from where it starts and ends, and whole in the region the grid is for
        if (!quadrato.every((q) => profondita(q.x, q.y, zona.punti) >= w - SLACK_MM)) continue;
        if (regioni && !quadrato.every((q) => profondita(q.x, q.y, regione) >= -SLACK_MM)) continue;
        // in the copper: its middle on it, and no side of the pour within a line's width of it
        const c = inScheda(uc, vc);
        if (!nellAnello(c.x, c.y, esterno) || inUnBuco(c.x, c.y)) continue;
        if (lati.vicino(quadrato, w)) continue;
        messi.add(chiave);
        fuori.push(quadrato.map((q) => ({ x: Number(q.x.toFixed(6)), y: Number(q.y.toFixed(6)) })));
      }
    }
  }
  return fuori;
}

/**
 * THE GRIDS THE ZONES ASK, LAID ON THE POURS OF THE BOARD, after flex.json was
 * put on it (conFlessibile): the holes of a grid laid before are taken off,
 * then every pour of a layer of a zone that asks one gets the squares that fit
 * in it (quadratiPer), and the zone element says how many were cut (`openings`)
 * or why none (`skipped`: "larghezza" when its lines are narrower than
 * `larghezzaMinimaMm`, the project's minimum trace width). A board with no
 * zone asking a grid and no grid on it is given back as it came.
 */
export function conRetino<T extends El>(circuitJson: T[], larghezzaMinimaMm: number): T[] {
  const solido = senzaRetino(circuitJson);
  const flex = flessibileDellaScheda(solido);
  const conGriglia = flex?.zone.filter((z) => z.retino) ?? [];
  if (!flex || conGriglia.length === 0) return solido;
  const sostituiti = new Map<El, El>();
  const tagliate = new Map<string, { aperture: number; nonApplicato?: string }>();
  for (const zona of conGriglia) {
    const retino = zona.retino!;
    if (retino.larghezzaMm < larghezzaMinimaMm - SLACK_MM) {
      tagliate.set(zona.id, { aperture: 0, nonApplicato: "larghezza" });
      continue;
    }
    const regioni = doveIlRetino(zona, retino, flex.pieghe);
    let aperture = 0;
    for (const el of solido) {
      if (el.type !== "pcb_copper_pour" || !zona.strati.includes(String(el.layer ?? ""))) continue;
      // the pour as the zones before this one left it
      const ora = (sostituiti.get(el) ?? el) as El;
      const forma = ora.brep_shape as Forma | undefined;
      if (!forma?.outer_ring) continue;
      const quadrati = quadratiPer(forma, zona, retino, regioni, MAX_APERTURE_RETINO - aperture);
      if (quadrati.length === 0) continue;
      aperture += quadrati.length;
      sostituiti.set(el, {
        ...ora,
        brep_shape: { ...forma, inner_rings: [...(forma.inner_rings ?? []), ...quadrati.map((vertices) => ({ vertices, [ANELLO_DEL_RETINO]: true }))] },
      });
    }
    tagliate.set(zona.id, { aperture });
  }
  return solido.map((el) => {
    if (el.type === ZONA_FLESSIBILE) {
      const esito = tagliate.get(String(el.pcb_flex_zone_id ?? ""));
      if (!esito || typeof el.hatch !== "object" || el.hatch === null) return el;
      return { ...el, hatch: { ...(el.hatch as Record<string, unknown>), openings: esito.aperture, ...(esito.nonApplicato ? { skipped: esito.nonApplicato } : {}) } };
    }
    return (sostituiti.get(el) as T | undefined) ?? el;
  });
}
