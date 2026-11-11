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
 * is always inside the original shape, so no clearance can get smaller. A
 * shape that a neck held together comes back in pieces, and the pieces go
 * through the same checks as every other piece of the pour (splinters and
 * empty scraps are dropped by the caller).
 */
import { getManifoldModuleSync } from "@tscircuit/manifold-2d";

type Punto = { x: number; y: number };
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

/**
 * The shape without its necks, as one or more shapes. If the geometry runtime
 * is not available, or anything goes wrong, the shape is returned untouched:
 * a pour with a sliver is better than no pour.
 */
export function senzaColliStretti(forma: FormaColata, larghezzaMinimaMm: number): FormaColata[] {
  const r = larghezzaMinimaMm / 2;
  if (!(r > 0) || !Number.isFinite(r)) return [forma];
  const m = getManifoldModuleSync();
  if (!m) return [forma];
  const anelli = [forma.outer_ring, ...(forma.inner_rings ?? [])]
    .filter((a): a is Anello => !!a && Array.isArray(a.vertices) && a.vertices.length >= 3)
    .map((a) => a.vertices.map((v) => [v.x, v.y] as [number, number]));
  if (anelli.length === 0) return [forma];
  const daLiberare: Array<{ delete(): void }> = [];
  try {
    const base = m.CrossSection.ofPolygons(anelli, "EvenOdd");
    daLiberare.push(base);
    const stretta = base.offset(-r, "Round", 2, 64);
    daLiberare.push(stretta);
    const aperta = stretta.offset(r, "Round", 2, 64);
    daLiberare.push(aperta);
    const pezzi = aperta.decompose();
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
      out.push({ outer_ring: anello(esterni[0]), inner_rings: buchi.map(anello) });
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
 * than the plane does (see altreColate). Without the geometry runtime, or on
 * any failure, the ring comes back as it was: the opening is then the plane's
 * own clearance, as it was before pours could declare one.
 */
export function allargaAnello(punti: Punto[], deltaMm: number): Punto[][] {
  if (!(deltaMm > 0) || !Number.isFinite(deltaMm) || punti.length < 3) return [punti];
  const m = getManifoldModuleSync();
  if (!m) return [punti];
  const daLiberare: Array<{ delete(): void }> = [];
  try {
    // even-odd, so a ring turning either way is the same shape
    const base = m.CrossSection.ofPolygons([punti.map((p) => [p.x, p.y] as [number, number])], "EvenOdd");
    daLiberare.push(base);
    const largo = base.offset(deltaMm, "Round", 2, 64);
    daLiberare.push(largo);
    const fuori = (largo.toPolygons() as Array<Array<[number, number]>>)
      .filter((c) => c.length >= 3 && areaConSegno(c) > 0)
      .map((c) => c.map(([x, y]) => ({ x, y })));
    return fuori.length > 0 ? fuori : [punti];
  } catch {
    return [punti];
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
 * The same cleaning for a board that is RE-EVALUATED instead of compiled
 * (POST /api/recheck): its pours were drawn by an older engine, and certifying
 * them for export with the new checks would certify their slivers too. Every
 * pour is opened as above; a pour that a neck held together becomes several,
 * and pieces smaller than a square of the minimum width are dropped, as the
 * compile drops its splinters. Opening is idempotent: a board already cleaned
 * comes back as it was.
 */
export async function colateSenzaColli<T extends Record<string, unknown> & { type?: unknown }>(
  circuitJson: T[],
  larghezzaMinimaMm: number,
): Promise<T[]> {
  if (!(larghezzaMinimaMm > 0) || !circuitJson.some((el) => el.type === "pcb_copper_pour")) return circuitJson;
  const { initializeManifoldGeometry } = await import("@tscircuit/copper-pour-solver");
  await initializeManifoldGeometry();
  const minima = larghezzaMinimaMm * larghezzaMinimaMm;
  const areaDi = (f: FormaColata): number => {
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
    const pezzi = senzaColliStretti(forma, larghezzaMinimaMm).filter((p) => areaDi(p) >= minima);
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
 * touches is united to it, exactly as big as the copper already there (plus a
 * hair): that copper exists and already keeps its own distance from the other
 * nets, so the union adds no copper nearer to anything. Runs before the necks
 * are taken off and once more after, because the opening rounds the joint.
 */
export type RamePropio =
  | { kind: "cerchio"; x: number; y: number; r: number }
  | { kind: "rett"; x: number; y: number; w: number; h: number; rot: number };

export function abbracciaRamePropio(forme: FormaColata[], propri: RamePropio[], margineMm = 0.005): FormaColata[] {
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
      const forma =
        p.kind === "cerchio"
          ? cs(cs(m.CrossSection.circle(p.r + margineMm, 48)).translate([p.x, p.y]))
          : cs(cs(cs(m.CrossSection.square([p.w + 2 * margineMm, p.h + 2 * margineMm], true)).rotate(p.rot)).translate([p.x, p.y]));
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
