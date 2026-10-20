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
