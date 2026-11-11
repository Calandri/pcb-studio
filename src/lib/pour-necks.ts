/**
 * NO PIECE OF A PLANE NARROWER THAN A TRACE.
 *
 * A pour is what is left of an outline after the clearances around everything
 * else are cut out of it, and between two clearances that almost touch it
 * leaves strips and points a few hundredths of a millimetre wide. Measured on
 * BIRDY_BAT on 2026-10-20: 116 such pieces under 0.09 mm on top, bottom and the
 * ground plane, the largest a strip of 0.25 mm2. A fab does not etch copper that
 * narrow reliably: the strip comes out broken or lifts off, and a loose sliver
 * of copper is a short waiting to happen. Altium removes them on its own
 * ("remove necks narrower than"); the solver here did not.
 *
 * So every poured shape is opened with a disc as wide as the narrowest trace
 * the project allows: shrunk by half that width, then grown back by the same.
 * What is wider than a trace comes back exactly as it was, apart from convex
 * corners rounded to the same radius; what is narrower disappears. The result
 * is kept inside the original shape (it is intersected with it), so no
 * clearance can get smaller. A shape that a neck held together comes back in
 * pieces, and the pieces go through the same checks as every other piece of
 * the pour (splinters and empty scraps are dropped by the caller).
 *
 * The round corners of the opening are drawn with as many segments as their
 * radius needs (see pour-geometry.ts). They used to be 64 per turn whatever the
 * radius: with the 0.127 mm minimum width of sbb-dl-principale that is a facet
 * every 6 micrometres, and 661 of the 744 edges of one pour were shorter than
 * 0.02 mm (2026-11-11).
 *
 * The corners the designer drew are not the opening's to round: a strip of
 * copper declared with square corners keeps them where nothing cuts it (see
 * `spigoli`). The corners the clearances cut are rounded, as KiCad does.
 */
import { getManifoldModuleSync } from "@tscircuit/manifold-2d";
import {
  anelloPulito,
  areaConSegno as areaDi,
  cerchio,
  ERRORE_CORDA_MM,
  poligonoCresciuto,
  rettangoloArrotondato,
  segmentiInscritti,
  type Punto,
} from "./pour-geometry";

type Anello = { vertices: Punto[] };
export type FormaColata = { outer_ring?: Anello; inner_rings?: Anello[] };

/** signed area of a ring, positive counter-clockwise */
function areaConSegno(punti: Array<[number, number]>): number {
  let s = 0;
  for (let i = 0; i < punti.length; i++) {
    const [x1, y1] = punti[i];
    const [x2, y2] = punti[(i + 1) % punti.length];
    s += x1 * y2 - x2 * y1;
  }
  return s / 2;
}

const anello = (punti: Array<[number, number]>): Anello => ({
  vertices: punti.map(([x, y]) => ({ x, y })),
});

/** the shape's rings, cleaned (see anelloPulito): the outer one keeps its copper inside, a hole outside */
export function formaPulita(forma: FormaColata): FormaColata {
  const esterno = forma.outer_ring?.vertices;
  if (!esterno || esterno.length < 3) return forma;
  return {
    ...forma,
    outer_ring: { vertices: anelloPulito(esterno, true) },
    inner_rings: (forma.inner_rings ?? []).map((r) => ({ vertices: anelloPulito(r.vertices ?? [], false) })),
  };
}

/**
 * The edges of some rings in a grid of cells, to ask quickly which edges come
 * near a box and whether a point is inside the rings (even-odd).
 */
class Spigoli {
  private readonly ax: number[] = [];
  private readonly ay: number[] = [];
  private readonly bx: number[] = [];
  private readonly by: number[] = [];
  private readonly celle = new Map<number, number[]>();
  private readonly passo: number;
  private readonly x0: number;
  private readonly y0: number;
  private readonly colonne: number;

  constructor(anelli: Punto[][]) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, n = 0;
    for (const a of anelli) {
      for (const p of a) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
      n += a.length;
    }
    this.x0 = minX;
    this.y0 = minY;
    const lato = Math.max(maxX - minX, maxY - minY, 1e-6);
    this.passo = Math.max(lato / Math.max(1, Math.sqrt(n)), 1e-3);
    this.colonne = Math.floor((maxX - minX) / this.passo) + 1;
    for (const a of anelli) {
      for (let i = 0; i < a.length; i++) {
        const p = a[i];
        const q = a[(i + 1) % a.length];
        const k = this.ax.length;
        this.ax.push(p.x);
        this.ay.push(p.y);
        this.bx.push(q.x);
        this.by.push(q.y);
        this.perCelle(Math.min(p.x, q.x), Math.min(p.y, q.y), Math.max(p.x, q.x), Math.max(p.y, q.y), (c) => {
          const l = this.celle.get(c);
          if (l) l.push(k);
          else this.celle.set(c, [k]);
        });
      }
    }
  }

  private perCelle(x1: number, y1: number, x2: number, y2: number, fai: (c: number) => void): void {
    const i1 = Math.max(0, Math.floor((x1 - this.x0) / this.passo));
    const i2 = Math.min(this.colonne - 1, Math.floor((x2 - this.x0) / this.passo));
    const j1 = Math.max(0, Math.floor((y1 - this.y0) / this.passo));
    const j2 = Math.floor((y2 - this.y0) / this.passo);
    for (let j = j1; j <= j2; j++) for (let i = i1; i <= i2; i++) fai(j * this.colonne + i);
  }

  /** the edges whose box meets the given box */
  vicini(x1: number, y1: number, x2: number, y2: number): number[] {
    const visti = new Set<number>();
    this.perCelle(x1, y1, x2, y2, (c) => {
      for (const k of this.celle.get(c) ?? []) visti.add(k);
    });
    return [...visti];
  }

  lato(k: number): [Punto, Punto] {
    return [
      { x: this.ax[k], y: this.ay[k] },
      { x: this.bx[k], y: this.by[k] },
    ];
  }

  /** whether a point is inside the rings, even-odd, by a ray to the right */
  dentro(x: number, y: number): boolean {
    let d = false;
    for (const k of this.vicini(x, y, Infinity, y)) {
      const ay = this.ay[k], by = this.by[k];
      if (ay > y === by > y) continue;
      const xi = ((this.bx[k] - this.ax[k]) * (y - ay)) / (by - ay) + this.ax[k];
      if (x < xi) d = !d;
    }
    return d;
  }
}

const orientamento = (a: Punto, b: Punto, c: Punto): number => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);

/** whether segment pq meets the triangle abc (closed) */
function segmentoNelTriangolo(p: Punto, q: Punto, a: Punto, b: Punto, c: Punto): boolean {
  const dentro = (z: Punto) => {
    const d1 = orientamento(a, b, z), d2 = orientamento(b, c, z), d3 = orientamento(c, a, z);
    const neg = d1 < 0 || d2 < 0 || d3 < 0;
    const pos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(neg && pos);
  };
  if (dentro(p) || dentro(q)) return true;
  const incrocia = (u: Punto, v: Punto) => {
    const o1 = orientamento(p, q, u), o2 = orientamento(p, q, v), o3 = orientamento(u, v, p), o4 = orientamento(u, v, q);
    return o1 * o2 < 0 && o3 * o4 < 0;
  };
  return incrocia(a, b) || incrocia(b, c) || incrocia(c, a);
}

/**
 * THE CORNERS THE OPENING SHOULD GIVE BACK.
 *
 * At a convex corner of interior angle a, the opening replaces the tip with an
 * arc of radius r tangent to both sides, r / tan(a/2) from the corner. The tip
 * is copper, not a neck, when the disc of that arc fits in the shape (the
 * opening kept the copper around it) and nothing else of the shape enters the
 * triangle between the corner and the two tangent points: then the triangle is
 * handed back and the corner comes out sharp, exactly where it was. A corner
 * whose side is shorter than the tangent distance, or whose triangle a hole or
 * another edge cuts into, stays rounded.
 *
 * `spigoli` says which corners: the vertices of the outline the pour was drawn
 * with (a corner the clearances cut is rounded), or every corner of the shape
 * (a shape poured earlier, whose corners are what they are).
 */
function spigoliDaRimettere(
  forma: FormaColata,
  aperta: Spigoli,
  r: number,
  spigoli: Punto[] | "tutti",
): Punto[][] {
  const esterno = forma.outer_ring?.vertices ?? [];
  const anelli: Array<{ punti: Punto[]; rameDentro: boolean }> = [
    { punti: esterno, rameDentro: true },
    ...(forma.inner_rings ?? []).map((a) => ({ punti: a.vertices ?? [], rameDentro: false })),
  ].filter((a) => a.punti.length >= 3);
  const chiave = (x: number, y: number) => `${Math.round(x * 2e5)},${Math.round(y * 2e5)}`;
  let richiesti: Set<string> | null = null;
  if (spigoli !== "tutti") {
    if (spigoli.length === 0) return [];
    richiesti = new Set<string>();
    for (const p of spigoli) {
      const cx = Math.round(p.x * 2e5), cy = Math.round(p.y * 2e5);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) richiesti.add(`${cx + dx},${cy + dy}`);
    }
  }
  const tutti = new Spigoli(anelli.map((a) => a.punti));
  const out: Punto[][] = [];
  for (const { punti, rameDentro } of anelli) {
    const n = punti.length;
    const lato = (areaDi(punti) > 0 ? 1 : -1) * (rameDentro ? 1 : -1);
    for (let i = 0; i < n; i++) {
      const v = punti[i];
      if (richiesti && !richiesti.has(chiave(v.x, v.y))) continue;
      const a = punti[(i - 1 + n) % n];
      const c = punti[(i + 1) % n];
      // convex for the copper: the turn goes the copper's way
      if (lato * orientamento(a, v, c) <= 0) continue;
      const la = Math.hypot(a.x - v.x, a.y - v.y);
      const lc = Math.hypot(c.x - v.x, c.y - v.y);
      if (la < 1e-9 || lc < 1e-9) continue;
      const u1 = { x: (a.x - v.x) / la, y: (a.y - v.y) / la };
      const u2 = { x: (c.x - v.x) / lc, y: (c.y - v.y) / lc };
      const alfa = Math.acos(Math.max(-1, Math.min(1, u1.x * u2.x + u1.y * u2.y)));
      if (alfa < 1e-3 || alfa > Math.PI - 1e-9) continue;
      const t = (r / Math.tan(alfa / 2)) * 1.001 + 1e-6;
      if (t > la - 1e-7 || t > lc - 1e-7) continue;
      // the disc of the arc: the opening keeps its middle when the disc fits
      const bl = Math.hypot(u1.x + u2.x, u1.y + u2.y);
      const ub = { x: (u1.x + u2.x) / bl, y: (u1.y + u2.y) / bl };
      const prof = r / Math.sin(alfa / 2) - 0.5 * r;
      if (!aperta.dentro(v.x + ub.x * prof, v.y + ub.y * prof)) continue;
      const p1 = { x: v.x + u1.x * t, y: v.y + u1.y * t };
      const p2 = { x: v.x + u2.x * t, y: v.y + u2.y * t };
      // nothing of the shape inside the triangle but the corner's own two sides
      const minX = Math.min(v.x, p1.x, p2.x), maxX = Math.max(v.x, p1.x, p2.x);
      const minY = Math.min(v.y, p1.y, p2.y), maxY = Math.max(v.y, p1.y, p2.y);
      let libero = true;
      for (const k of tutti.vicini(minX, minY, maxX, maxY)) {
        const [p, q] = tutti.lato(k);
        const suo = (z: Punto) => Math.abs(z.x - v.x) < 1e-9 && Math.abs(z.y - v.y) < 1e-9;
        if (suo(p) || suo(q)) continue;
        // shrunk a hair toward its middle, so the sides it shares do not count
        const gx = (v.x + p1.x + p2.x) / 3, gy = (v.y + p1.y + p2.y) / 3;
        const s = (z: Punto) => ({ x: z.x + (gx - z.x) * 1e-6, y: z.y + (gy - z.y) * 1e-6 });
        if (segmentoNelTriangolo(p, q, s(v), s(p1), s(p2))) {
          libero = false;
          break;
        }
      }
      // counter-clockwise, so two that overlap add up instead of cancelling
      if (libero) out.push(orientamento(v, p1, p2) > 0 ? [v, p1, p2] : [v, p2, p1]);
    }
  }
  return out;
}

/**
 * The shape without its necks, as one or more shapes, cleaned. `spigoli`: the
 * corners to keep sharp where they survive (see spigoliDaRimettere); none by
 * default, every corner rounded. If the geometry runtime is not available, or
 * anything goes wrong, the shape is returned untouched: a pour with a sliver
 * is better than no pour.
 */
export function senzaColliStretti(
  forma: FormaColata,
  larghezzaMinimaMm: number,
  spigoli: Punto[] | "tutti" = [],
): FormaColata[] {
  const r = larghezzaMinimaMm / 2;
  if (!(r > 0) || !Number.isFinite(r)) return [forma];
  const m = getManifoldModuleSync();
  if (!m) return [forma];
  const anelli = [forma.outer_ring, ...(forma.inner_rings ?? [])]
    .filter((a): a is Anello => !!a && Array.isArray(a.vertices) && a.vertices.length >= 3)
    .map((a) => a.vertices.map((v) => [v.x, v.y] as [number, number]));
  if (anelli.length === 0) return [forma];
  const daLiberare: Array<{ delete(): void }> = [];
  const cs = <T extends { delete(): void }>(o: T): T => {
    daLiberare.push(o);
    return o;
  };
  try {
    const n = segmentiInscritti(r, ERRORE_CORDA_MM);
    const base = cs(m.CrossSection.ofPolygons(anelli, "EvenOdd"));
    const aperta = cs(cs(base.offset(-r, "Round", 2, n)).offset(r, "Round", 2, n));
    // never outside the shape: Clipper's arcs stand a chord error past a hollow corner
    let dentro = cs(aperta.intersect(base));
    const triangoli = spigoliDaRimettere(
      forma,
      new Spigoli((aperta.toPolygons() as Array<Array<[number, number]>>).map((c) => c.map(([x, y]) => ({ x, y })))),
      r,
      spigoli,
    );
    if (triangoli.length > 0) {
      const punte = cs(m.CrossSection.ofPolygons(triangoli.map((t) => t.map((p) => [p.x, p.y] as [number, number])), "Positive"));
      dentro = cs(cs(dentro.add(punte)).intersect(base));
    }
    const pezzi = dentro.decompose();
    daLiberare.push(...pezzi);
    const out: FormaColata[] = [];
    for (const pezzo of pezzi) {
      const contorni = pezzo.toPolygons() as Array<Array<[number, number]>>;
      const esterni = contorni.filter((c) => c.length >= 3 && areaConSegno(c) > 0);
      if (esterni.length !== 1) {
        // decompose gives one outline per piece; anything else is not a shape we understand
        if (esterni.length === 0) continue;
        return [forma];
      }
      const buchi = contorni.filter((c) => c.length >= 3 && areaConSegno(c) < 0);
      out.push(formaPulita({ outer_ring: anello(esterni[0]), inner_rings: buchi.map(anello) }));
    }
    return out;
  } catch {
    return [forma];
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
 * A ring grown outwards by `deltaMm`, round at the corners, as the outlines of
 * what comes out (one, unless the growth closes a notch into a hole, which is
 * left out: only the outside of a pour keeps the others away). Used to widen
 * the opening a plane leaves around a smaller pour that asks for more distance
 * than the plane does (see altreColate), for the solver's own reading of that
 * opening; the re-pour hands the solver the exact one (see ostacoliEsatti).
 * Without the geometry runtime, or on any failure, the ring comes back as it
 * was: the opening is then the plane's own clearance, as it was before pours
 * could declare one.
 */
export function allargaAnello(punti: Punto[], deltaMm: number): Punto[][] {
  if (!(deltaMm > 0) || !Number.isFinite(deltaMm) || punti.length < 3) return [punti];
  return poligonoCresciuto(punti, deltaMm) ?? [punti];
}

/**
 * The same cleaning for a board that is RE-EVALUATED instead of compiled
 * (POST /api/recheck): its pours were drawn by an older engine, and certifying
 * them for export with the new checks would certify their slivers too. Every
 * pour is opened as above, keeping every corner it has where the copper is
 * solid (a recheck takes necks out, it does not reshape a board); a pour that a
 * neck held together becomes several, and pieces smaller than a square of the
 * minimum width are dropped, as the compile drops its splinters. Opening is
 * idempotent: a board already cleaned comes back as it was.
 */
export async function colateSenzaColli<T extends Record<string, unknown> & { type?: unknown }>(
  circuitJson: T[],
  larghezzaMinimaMm: number,
): Promise<T[]> {
  if (!(larghezzaMinimaMm > 0) || !circuitJson.some((el) => el.type === "pcb_copper_pour")) return circuitJson;
  const { initializeManifoldGeometry } = await import("@tscircuit/copper-pour-solver");
  await initializeManifoldGeometry();
  const minima = larghezzaMinimaMm * larghezzaMinimaMm;
  const areaDiForma = (f: FormaColata): number => {
    const a = (v: Punto[]) =>
      Math.abs(v.reduce((s, p, i) => s + p.x * v[(i + 1) % v.length].y - v[(i + 1) % v.length].x * p.y, 0) / 2);
    return a(f.outer_ring?.vertices ?? []) - (f.inner_rings ?? []).reduce((s, r) => s + a(r.vertices ?? []), 0);
  };
  const out: T[] = [];
  for (const el of circuitJson) {
    const forma = el.brep_shape as FormaColata | undefined;
    if (el.type !== "pcb_copper_pour" || !forma?.outer_ring) {
      out.push(el);
      continue;
    }
    const pezzi = senzaColliStretti(forma, larghezzaMinimaMm, "tutti").filter((p) => areaDiForma(p) >= minima);
    const id = String(el.pcb_copper_pour_id ?? "");
    pezzi.forEach((p, i) =>
      out.push({ ...el, brep_shape: p, ...(pezzi.length > 1 ? { pcb_copper_pour_id: `${id}_n${i}` } : {}) }),
    );
  }
  return out;
}

/**
 * A pour holds ALL of its own net's copper that it touches.
 *
 * The clearance is for the OTHER nets. On sbb-dl-retro, with a pour clearance
 * of 0.25 mm, 64 vias of the pour's own net had the pour's edge through their
 * ring: the via stuck halfway out of its plane, closer to the other net's trace
 * than the plane itself (2026-11-09). Lowering the clearance hid it and doubled
 * the slivers. Here every via ring and pad of the pour's net that the shape
 * touches is united to it, exactly as big as the copper already there: that
 * copper exists and already keeps its own distance from the other
 * nets, so the union adds no copper nearer to anything. Runs before the necks
 * are taken off and once more after, because the opening rounds the joint.
 *
 * EXACTLY the copper there, by its shape. A pill or an oval used to be united
 * as the rectangle around it: its square corners are not copper, and the plane
 * of the other net, which keeps its distance from the pill, did not keep it
 * from them. Measured on the TM board (tm_r3, 2026-11-11): the top NetC1_1
 * strip came within 0.019 mm of the ground plane at the corner of the pill pad
 * of C1, and on sbb-dl-principale the shield strips of the USB receptacle
 * overlapped the ground plane at the corners of its oval holes. A turned pad
 * is turned, a polygon pad is its polygon, and an arc is drawn just around its
 * curve (within half a micrometre, so the whole ring of a via is in the
 * plane), so the union never stands out of the copper by more than that,
 * where the old circles of 48 sides grown by 5 micrometres stood out by 5.
 */
export type RamePropio =
  | { kind: "cerchio"; x: number; y: number; r: number }
  | { kind: "rett"; x: number; y: number; w: number; h: number; rot: number; raggio?: number }
  | { kind: "poligono"; punti: Punto[] };

/** how far an arc of own copper may stand out of its curve: see abbracciaRamePropio */
const ERRORE_RAME_PROPRIO_MM = 0.0005;

/** the polygon of one piece of own copper: all of it, grown by `margineMm`, and out of it by the arc error at most */
export function poligonoDelRame(p: RamePropio, margineMm: number): Punto[] {
  if (p.kind === "cerchio") return cerchio(p.x, p.y, p.r + margineMm, ERRORE_RAME_PROPRIO_MM);
  if (p.kind === "rett") {
    const raggio = Math.max(0, p.raggio ?? 0);
    return rettangoloArrotondato(p.x, p.y, p.w + 2 * margineMm, p.h + 2 * margineMm, raggio > 0 ? raggio + margineMm : 0, p.rot, ERRORE_RAME_PROPRIO_MM);
  }
  return p.punti;
}

export function abbracciaRamePropio(forme: FormaColata[], propri: RamePropio[], margineMm = 0): FormaColata[] {
  if (forme.length === 0 || propri.length === 0) return forme;
  const m = getManifoldModuleSync();
  if (!m) return forme;
  const daLiberare: Array<{ delete(): void }> = [];
  const cs = <T extends { delete(): void }>(o: T): T => {
    daLiberare.push(o);
    return o;
  };
  try {
    const pezzi = forme.map((f) =>
      cs(
        m.CrossSection.ofPolygons(
          [f.outer_ring, ...(f.inner_rings ?? [])]
            .filter((a): a is Anello => !!a && Array.isArray(a.vertices) && a.vertices.length >= 3)
            .map((a) => a.vertices.map((v) => [v.x, v.y] as [number, number])),
          "EvenOdd",
        ),
      ),
    );
    let tutto = cs(m.CrossSection.union(pezzi));
    let aggiunti = 0;
    for (const p of propri) {
      const punti = poligonoDelRame(p, margineMm);
      if (punti.length < 3) continue;
      const forma = cs(m.CrossSection.ofPolygons([punti.map((q) => [q.x, q.y] as [number, number])], "EvenOdd"));
      const comune = cs(tutto.intersect(forma));
      // only what the pour already reaches: a via far from the plane stays its own
      if (comune.area() <= 1e-6) continue;
      tutto = cs(tutto.add(forma));
      aggiunti++;
    }
    if (aggiunti === 0) return forme;
    const out: FormaColata[] = [];
    for (const pezzo of tutto.decompose()) {
      cs(pezzo);
      const contorni = pezzo.toPolygons() as Array<Array<[number, number]>>;
      const esterni = contorni.filter((c) => c.length >= 3 && areaConSegno(c) > 0);
      if (esterni.length !== 1) {
        if (esterni.length === 0) continue;
        return forme;
      }
      const buchi = contorni.filter((c) => c.length >= 3 && areaConSegno(c) < 0);
      out.push({ outer_ring: anello(esterni[0]), inner_rings: buchi.map(anello) });
    }
    return out;
  } catch {
    return forme;
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

