/**
 * THE POURS OF OTHER NETS A STITCHING VIA GOES THROUGH.
 *
 * A ground via is a through hole: it crosses every layer. On a layer where the
 * ground is not poured and another net is (the P3V3 plane on inner2 of
 * sbb-dongle, 2026-11-12) the via joins nothing, and the next compile pours
 * that plane again with the via in the room: it opens it around the via by the
 * via's ring plus the distance that pour keeps from the other nets, its own
 * when it declares one (pours-recompute.ts hands the solver every via of
 * another net as a circle grown by the pour's margin). Measured on that board:
 * 14 ground vias placed by hand across the plane, the plane open 0.500 mm from
 * the centre of each (ring 0.25 + clearance 0.25), no short. The stitching
 * used to refuse every position within that distance of a pour of another net,
 * a full plane like a pad of copper: on that board zero vias, and the ground
 * islands left with no place.
 *
 * What a via may not do is cut the pour it goes through. A position holds only
 * when the pour, opened there AND around every via proposed before it, is
 * still what it was: no piece comes off it and nothing is left hanging by a
 * neck narrower than the narrowest copper the project allows (minTraceWidthMm:
 * the width under which the re-pour takes a neck away, see pour-necks.ts, so a
 * narrower neck is a cut). A row of vias is measured together, never one by
 * one: each opening alone may leave the plane whole and the row slice it.
 *
 * HOW IT IS MEASURED. The pour is shrunk once by half that width: a point of
 * the shrunk shape is the middle of a disc of copper as wide as the minimum,
 * so the pieces of the shrunk shape are the pieces the re-pour keeps, and a
 * neck narrower than the minimum is a break in it. An opening of radius r is
 * then a disc of radius r plus that half width taken out of the shrunk shape.
 * The pour holds when the shrunk shape has, after, exactly the pieces it had
 * before: none split in two, none gone. So a notch in the edge of a plane and
 * two openings that run into each other are fine (the 14 vias of the dongle
 * stand 0.3 mm inside the edge of the plane and all notch it), a strip cut
 * across is not, nor a small pour the opening swallows or leaves narrower
 * than the minimum, nor a via of the pour's net left on a piece of its own.
 *
 * The disc is drawn outside its circle (LATI_DEL_DISCO sides, at most 5
 * micrometres out for an opening of half a millimetre), and the half width is
 * taken a hair larger (MARGINE_COLLO_MM): a neck this lets through is wider
 * than the minimum by more than the arcs of the re-pour can stray, which draws
 * its own openings outside the circle too, within ERRORE_CORDA_MM. The other
 * way round, a scrap of copper narrower than the minimum plus that hair is not
 * a piece here: the re-pour bins it with the splinters.
 *
 * It needs the geometry runtime (manifold, the one the pours are made with),
 * which loads asynchronously: the tool prepares it (preparaLaGeometria) before
 * it stitches. Without it nothing is measured and tenutaDeiPiani answers null:
 * the stitching then keeps every pour of another net an obstacle, as it did.
 */

import { getManifoldModule, getManifoldModuleSync } from "@tscircuit/manifold-2d";
import { ERRORE_CORDA_MM, segmentiInscritti } from "./pour-geometry";

/** how much wider than the minimum a neck must be to count as kept: more than the arcs of the re-pour stray */
export const MARGINE_COLLO_MM = 0.01;

/**
 * The sides of the disc taken out of the shrunk shape for an opening. Every
 * opening made stays in that shape, and each measure cuts the whole of it: 24
 * sides instead of the 56 a circle of that radius asks for within
 * ERRORE_CORDA_MM keep a plane with a thousand openings under half the points.
 */
const LATI_DEL_DISCO = 24;

/**
 * The openings measured with the geometry runtime in one call, all pours
 * together. Most positions need none (an opening in the solid of a plane, away
 * from its edges and from the other openings, cuts nothing); the others cost a
 * boolean on the whole pour each (2 to 10 ms on a plane of a few thousand
 * points), and a board with large ground islands over a narrow pour could ask
 * for tens of thousands. Past this many the pour is an obstacle again, and the
 * answer says so. A count and not a time: the same call must give the same
 * vias, or the write would not be what the look showed.
 */
export const MAX_MISURE_SUI_PIANI = 2000;

type Anelli = Array<Array<[number, number]>>;
type Modulo = NonNullable<ReturnType<typeof getManifoldModuleSync>>;
type Sezione = ReturnType<Modulo["CrossSection"]["ofPolygons"]>;

/** a piece of the shrunk shape: its outline and its box */
interface Pezzo {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  punti: Array<[number, number]>;
}

interface Foro {
  x: number;
  y: number;
  r: number;
  /** in the solid of the pour, away from its edges and from the other openings: it changes no piece */
  interno?: boolean;
}

interface Stato {
  /** the pour shrunk by half the minimum width, less the openings made so far (but those of `inAttesa`) */
  ristretta: Sezione;
  pezzi: Pezzo[];
  /** every opening made */
  fori: Foro[];
  /** openings in the solid of the pour, not taken out of `ristretta` yet: they change no piece */
  inAttesa: Foro[];
  /** the last opening measured and found to hold, with the shape it leaves: the one `apri` is most often asked next */
  misurata: (Foro & { dopo: Sezione; pezzi: Pezzo[] }) | null;
}

export interface TenutaDeiPiani {
  /**
   * Whether the pour holds with one more opening of radius `raggio` at (x, y),
   * on top of the ones made so far. `chiave`: the pour; `forme`: its outline
   * and its holes, asked once, and those of every other pour of its net on its
   * layer that overlaps or touches it (they are one copper, and are measured
   * as one: an opening over the only place two of them meet cuts none of the
   * two and parts them); `solido(r)`: whether the copper covers the whole disc
   * of radius r there, as the caller measures it (the cheap answer for an
   * opening in the middle of a plane).
   */
  regge(chiave: number, forme: () => Anelli[], x: number, y: number, raggio: number, solido: (r: number) => boolean): boolean;
  /** the opening is there from now on: the ones asked after are measured with it */
  apri(chiave: number, x: number, y: number, raggio: number, solido: (r: number) => boolean): void;
  /** positions refused unmeasured, past MAX_MISURE_SUI_PIANI */
  nonMisurate(): number;
  /** gives back what the geometry runtime holds */
  libera(): void;
}

/** loads the geometry runtime, once: true when tenutaDeiPiani can measure */
export async function preparaLaGeometria(): Promise<boolean> {
  try {
    await getManifoldModule();
    return getManifoldModuleSync() !== null;
  } catch {
    return false;
  }
}

function areaConSegno(punti: Array<[number, number]>): number {
  let s = 0;
  for (let i = 0; i < punti.length; i++) {
    const [x1, y1] = punti[i];
    const [x2, y2] = punti[(i + 1) % punti.length];
    s += x1 * y2 - x2 * y1;
  }
  return s / 2;
}

/**
 * The measure of the pours of one call (see the top of this file), or null
 * when the geometry runtime is not loaded. `larghezzaMinimaMm`: the narrowest
 * copper the project allows.
 */
export function tenutaDeiPiani(larghezzaMinimaMm: number): TenutaDeiPiani | null {
  const m = getManifoldModuleSync();
  if (!m) return null;
  const mezza = (Math.max(0, larghezzaMinimaMm) + MARGINE_COLLO_MM) / 2;
  /** null: a pour that could not be read, or with no copper as wide as the minimum: never gone through */
  const stati = new Map<number, Stato | null>();
  let misure = 0;
  let oltre = 0;

  const butta = (o: { delete(): void } | null | undefined): void => {
    try {
      o?.delete();
    } catch {
      /* already gone */
    }
  };
  const pezziDi = (s: Sezione): Pezzo[] => {
    const out: Pezzo[] = [];
    for (const punti of s.toPolygons() as Anelli) {
      // an outline with its copper inside: one per piece (the holes turn the other way)
      if (punti.length < 3 || areaConSegno(punti) <= 0) continue;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const [x, y] of punti) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      out.push({ minX, maxX, minY, maxY, punti });
    }
    return out;
  };
  /** the disc an opening takes out of the shrunk shape, drawn outside its circle */
  const disco = (f: Foro): Array<[number, number]> => {
    const passo = (2 * Math.PI) / LATI_DEL_DISCO;
    const r = (f.r + mezza) / Math.cos(passo / 2);
    return Array.from({ length: LATI_DEL_DISCO }, (_, k) => [f.x + r * Math.cos((k + 0.5) * passo), f.y + r * Math.sin((k + 0.5) * passo)] as [number, number]);
  };
  /** how far a point of that disc can be from its centre */
  const fin = (raggio: number): number => (raggio + mezza) / Math.cos(Math.PI / LATI_DEL_DISCO) + 1e-9;

  const statoDi = (chiave: number, forme: () => Anelli[]): Stato | null => {
    const noto = stati.get(chiave);
    if (noto !== undefined) return noto;
    let stato: Stato | null = null;
    const daButtare: Sezione[] = [];
    try {
      for (const anelli of forme()) daButtare.push(m.CrossSection.ofPolygons(anelli.filter((a) => a.length >= 3), "EvenOdd"));
      const base = daButtare.length === 1 ? daButtare[0] : m.CrossSection.union(daButtare);
      if (daButtare.length !== 1) daButtare.push(base);
      const ristretta = base.offset(-mezza, "Round", 2, segmentiInscritti(mezza, ERRORE_CORDA_MM));
      const pezzi = pezziDi(ristretta);
      if (pezzi.length > 0) stato = { ristretta, pezzi, fori: [], inAttesa: [], misurata: null };
      else butta(ristretta);
    } catch {
      stato = null;
    } finally {
      daButtare.forEach(butta);
    }
    stati.set(chiave, stato);
    return stato;
  };
  /** the openings waiting, taken out of the shrunk shape in one cut */
  const versa = (s: Stato): void => {
    if (s.inAttesa.length === 0) return;
    const dischi = m.CrossSection.ofPolygons(s.inAttesa.map(disco), "Positive");
    try {
      const dopo = s.ristretta.subtract(dischi);
      butta(s.ristretta);
      s.ristretta = dopo;
      // the ones in the solid only add holes: the outlines of the pieces are the ones read before
      if (s.inAttesa.some((f) => !f.interno)) s.pezzi = pezziDi(dopo);
      s.inAttesa = [];
    } finally {
      butta(dischi);
    }
  };
  /** in the solid of the pour, the minimum width of copper all around, and that far from every other opening */
  const nelPieno = (s: Stato, x: number, y: number, raggio: number, solido: (r: number) => boolean): boolean => {
    const largo = raggio + 2 * mezza;
    return solido(largo) && !s.fori.some((f) => Math.hypot(f.x - x, f.y - y) < largo + f.r);
  };
  const dimentica = (s: Stato): void => {
    butta(s.misurata?.dopo);
    s.misurata = null;
  };

  return {
    regge(chiave, forme, x, y, raggio, solido) {
      const s = statoDi(chiave, forme);
      if (!s) return false;
      // it only adds a hole, and no piece changes: nothing to cut
      if (nelPieno(s, x, y, raggio, solido)) return true;
      if (misure >= MAX_MISURE_SUI_PIANI) {
        oltre++;
        return false;
      }
      misure++;
      try {
        versa(s);
        dimentica(s);
        const foro: Foro = { x, y, r: raggio };
        const dopo = s.ristretta.subtract([disco(foro)]);
        const pezzi = pezziDi(dopo);
        // a piece gone whole: every point of it under the disc (as far as its drawn outline reaches)
        const r = fin(raggio);
        const sparito = s.pezzi.some(
          (p) =>
            p.minX >= x - r && p.maxX <= x + r && p.minY >= y - r && p.maxY <= y + r &&
            p.punti.every(([px, py]) => Math.hypot(px - x, py - y) <= r),
        );
        // and none split: a cut only ever makes pieces, so as many as before is the same ones
        if (!sparito && pezzi.length === s.pezzi.length) {
          s.misurata = { ...foro, dopo, pezzi };
          return true;
        }
        butta(dopo);
        return false;
      } catch {
        return false;
      }
    },
    apri(chiave, x, y, raggio, solido) {
      const s = stati.get(chiave);
      if (!s) return;
      const foro: Foro = { x, y, r: raggio, interno: nelPieno(s, x, y, raggio, solido) };
      s.fori.push(foro);
      const vista = s.misurata;
      if (vista && vista.x === x && vista.y === y && vista.r === raggio && s.inAttesa.length === 0) {
        butta(s.ristretta);
        s.ristretta = vista.dopo;
        s.pezzi = vista.pezzi;
        s.misurata = null;
        return;
      }
      dimentica(s);
      s.inAttesa.push(foro);
    },
    nonMisurate: () => oltre,
    libera() {
      for (const s of stati.values()) {
        if (!s) continue;
        dimentica(s);
        butta(s.ristretta);
      }
      stati.clear();
    },
  };
}
