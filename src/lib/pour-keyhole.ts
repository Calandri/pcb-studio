/**
 * A POURED PLANE HAS HOLES. A `<copperpour>` takes one ring.
 *
 * Ground on a real board is not a rectangle: it is a shape with openings, and
 * the openings are where the other nets live. On the board this file was written
 * for, the ground of the top face has fifty-five of them, and seventeen hold
 * copper of another net — the little islands that carry the 3.3V rails to a
 * handful of pads. Import the ground without them and it swallows those islands:
 * two nets, one piece of copper, and the gerbers we export say so to the fab.
 *
 * tscircuit's pour takes `outline`, a single ring, and there is nowhere to put
 * an inner one (checked against the newest @tscircuit/props too, 0.0.604). The
 * solver carves its own clearances around pads, traces, vias and cutouts, and
 * never around another pour.
 *
 * So the holes are stitched into the outer ring: from each hole a narrow channel
 * is cut out to the boundary, and what comes back is one ring that goes round
 * the outside, dives in through the channel, walks the hole, and comes back out.
 * It is the oldest trick there is for drawing a shape with holes on something
 * that only knows how to draw one, and it is exactly what a fab's own tooling
 * does when it flattens a plane.
 *
 * The channel is as wide as the minimum clearance of the board: narrower and the
 * copper would close over it, wider and it would eat the plane.
 */

export interface Punto {
  x: number;
  y: number;
}

export interface EsitoCucitura {
  /** the single ring: outer boundary plus the stitched holes */
  anello: Punto[];
  /** how many holes went in */
  cuciti: number;
  /** the ones that did not, with the reason: nothing is dropped quietly */
  scartati: Array<{ motivo: string; areaMm2: number }>;
}

const areaConSegno = (r: Punto[]): number => {
  let s = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    s += (r[j].x - r[i].x) * (r[j].y + r[i].y);
  }
  return s / 2;
};

export const areaAnello = (r: Punto[]): number => Math.abs(areaConSegno(r));

/** counterclockwise: with this signed area, that is the positive one */
const antiorario = (r: Punto[]): Punto[] =>
  areaConSegno(r) > 0 ? [...r] : [...r].reverse();
const orario = (r: Punto[]): Punto[] =>
  areaConSegno(r) > 0 ? [...r].reverse() : [...r];

/** drops repeated points, and the closing one: a ring is implicitly closed */
const senzaDoppioni = (r: Punto[]): Punto[] => {
  const out: Punto[] = [];
  for (const p of r) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(q.x - p.x, q.y - p.y) > 1e-9) out.push(p);
  }
  while (
    out.length > 1 &&
    Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) < 1e-9
  ) {
    out.pop();
  }
  return out;
};

export function dentroAnello(x: number, y: number, r: Punto[]): boolean {
  let dentro = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const a = r[i];
    const b = r[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) {
      dentro = !dentro;
    }
  }
  return dentro;
}

/** proper crossing of two open segments: touching at an endpoint does not count */
function siIncrociano(a: Punto, b: Punto, c: Punto, d: Punto, eps = 1e-9): boolean {
  const r = { x: b.x - a.x, y: b.y - a.y };
  const s = { x: d.x - c.x, y: d.y - c.y };
  const den = r.x * s.y - r.y * s.x;
  if (Math.abs(den) < 1e-15) return false;
  const t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / den;
  const u = ((c.x - a.x) * r.y - (c.y - a.y) * r.x) / den;
  return t > eps && t < 1 - eps && u > eps && u < 1 - eps;
}

/** distance from a point to a segment, plus where it lands on it */
function distanzaDalLato(
  p: Punto,
  a: Punto,
  b: Punto,
): { d: number; t: number; piede: Punto } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (l2 < 1e-15) return { d: Math.hypot(p.x - a.x, p.y - a.y), t: 0, piede: { ...a } };
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  const piede = { x: a.x + t * dx, y: a.y + t * dy };
  return { d: Math.hypot(p.x - piede.x, p.y - piede.y), t, piede };
}

/** the point you reach walking `lunghezza` along the ring from vertex `i` */
function avanti(r: Punto[], i: number, lunghezza: number): Punto {
  let resto = lunghezza;
  let k = i;
  for (let n = 0; n < r.length; n++) {
    const a = r[k];
    const b = r[(k + 1) % r.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len >= resto) {
      return { x: a.x + ((b.x - a.x) * resto) / len, y: a.y + ((b.y - a.y) * resto) / len };
    }
    resto -= len;
    k = (k + 1) % r.length;
  }
  return { ...r[i] };
}

function indietro(r: Punto[], i: number, lunghezza: number): Punto {
  let resto = lunghezza;
  let k = i;
  for (let n = 0; n < r.length; n++) {
    const a = r[k];
    const b = r[(k - 1 + r.length) % r.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len >= resto) {
      return { x: a.x + ((b.x - a.x) * resto) / len, y: a.y + ((b.y - a.y) * resto) / len };
    }
    resto -= len;
    k = (k - 1 + r.length) % r.length;
  }
  return { ...r[i] };
}

interface Ponte {
  buco: number;
  lato: number;
  t: number;
  bocca1: Punto;
  bocca2: Punto;
  imbocco1: Punto;
  imbocco2: Punto;
  vertice: number;
}

/**
 * Stitches a polygon with holes into ONE ring: from each hole a channel of width
 * `larghezza` out to the boundary.
 *
 * The outer ring is walked counterclockwise and the holes clockwise, which is
 * what makes the result a ring that does not cross itself. The channel lands on
 * the FOOT OF THE PERPENDICULAR to an outer edge, so its two mouths sit on that
 * edge and the channel is exactly as wide as asked. A hole that cannot be
 * reached — too close to the boundary, or every route blocked — is left out and
 * said out loud.
 */
export function cuciBuchi(
  contorno: Punto[],
  buchi: Punto[][],
  larghezza: number,
): EsitoCucitura {
  const esterno = antiorario(senzaDoppioni(contorno));
  const interni = buchi.map((h) => orario(senzaDoppioni(h)));
  const mezza = larghezza / 2;
  const ponti: Ponte[] = [];
  const scartati: EsitoCucitura["scartati"] = [];

  // biggest first: the ones that matter get the shortest route to the boundary
  const ordine = interni.map((_, i) => i).sort((a, b) => areaAnello(interni[b]) - areaAnello(interni[a]));

  for (const hi of ordine) {
    const buco = interni[hi];
    const candidati: Array<{ len: number; vertice: number; lato: number; t: number; piede: Punto }> = [];
    for (let v = 0; v < buco.length; v++) {
      for (let e = 0; e < esterno.length; e++) {
        const a = esterno[e];
        const b = esterno[(e + 1) % esterno.length];
        const { d, t, piede } = distanzaDalLato(buco[v], a, b);
        if (t <= 0 || t >= 1) continue; // only real perpendicular feet
        candidati.push({ len: d, vertice: v, lato: e, t, piede });
      }
    }
    candidati.sort((a, b) => a.len - b.len);

    let messo = false;
    let motivo = "nessun punto del contorno raggiungibile";
    for (const c of candidati) {
      if (c.len < larghezza * 1.2) {
        motivo = `il buco dista ${c.len.toFixed(4)}mm dal bordo: il canale sarebbe piu' corto della sua larghezza`;
        continue;
      }
      const A = esterno[c.lato];
      const B = esterno[(c.lato + 1) % esterno.length];
      const lungLato = Math.hypot(B.x - A.x, B.y - A.y);
      const dir = { x: (B.x - A.x) / lungLato, y: (B.y - A.y) / lungLato };
      const V = buco[c.vertice];
      const mezzo = { x: (V.x + c.piede.x) / 2, y: (V.y + c.piede.y) / 2 };
      if (!dentroAnello(mezzo.x, mezzo.y, esterno)) {
        motivo = "il canale uscirebbe dal contorno";
        continue;
      }
      if (interni.some((h) => dentroAnello(mezzo.x, mezzo.y, h))) {
        motivo = "il canale passerebbe dentro un altro buco";
        continue;
      }
      if (c.t * lungLato <= mezza + 1e-6 || (1 - c.t) * lungLato <= mezza + 1e-6) {
        motivo = "la bocca del canale cadrebbe oltre lo spigolo del lato";
        continue;
      }

      const bocca1 = { x: c.piede.x - mezza * dir.x, y: c.piede.y - mezza * dir.y };
      const bocca2 = { x: c.piede.x + mezza * dir.x, y: c.piede.y + mezza * dir.y };
      const imbocco1 = avanti(buco, c.vertice, mezza);
      const imbocco2 = indietro(buco, c.vertice, mezza);
      if (Math.hypot(imbocco1.x - imbocco2.x, imbocco1.y - imbocco2.y) < larghezza * 0.5) {
        motivo = "il buco e' troppo stretto dove il canale lo incontra";
        continue;
      }

      const pareti: Array<[Punto, Punto]> = [
        [bocca1, imbocco1],
        [bocca2, imbocco2],
      ];
      let ok = !siIncrociano(bocca1, imbocco1, bocca2, imbocco2);
      if (!ok) motivo = "le due pareti del canale si incrocerebbero";
      for (const [a, b] of ok ? pareti : []) {
        for (let i = 0, j = esterno.length - 1; i < esterno.length && ok; j = i++) {
          if (j === c.lato) continue;
          if (siIncrociano(a, b, esterno[j], esterno[i], 1e-7)) {
            ok = false;
            motivo = "una parete del canale taglierebbe il contorno";
          }
        }
        for (let k = 0; k < interni.length && ok; k++) {
          const h = interni[k];
          for (let i = 0, j = h.length - 1; i < h.length && ok; j = i++) {
            if (k === hi) {
              // its own hole: the sides touching the mouth are where it starts
              const vicino =
                j === c.vertice ||
                i === c.vertice ||
                j === (c.vertice + 1) % h.length ||
                i === (c.vertice - 1 + h.length) % h.length;
              if (vicino) continue;
            }
            if (siIncrociano(a, b, h[j], h[i], 1e-7)) {
              ok = false;
              motivo = "una parete del canale taglierebbe un altro buco";
            }
          }
        }
        for (const p of ok ? ponti : []) {
          const altre: Array<[Punto, Punto]> = [
            [p.bocca1, p.imbocco1],
            [p.bocca2, p.imbocco2],
          ];
          for (const [c1, c2] of altre) {
            if (siIncrociano(a, b, c1, c2, 1e-7)) {
              ok = false;
              motivo = "due canali si incrocerebbero";
            }
          }
        }
        if (!ok) break;
      }
      if (!ok) continue;

      ponti.push({
        buco: hi,
        lato: c.lato,
        t: c.t,
        bocca1,
        bocca2,
        imbocco1,
        imbocco2,
        vertice: c.vertice,
      });
      messo = true;
      break;
    }
    if (!messo) scartati.push({ motivo, areaMm2: Number(areaAnello(buco).toFixed(3)) });
  }

  const perLato = new Map<number, Ponte[]>();
  for (const p of ponti) perLato.set(p.lato, [...(perLato.get(p.lato) ?? []), p]);
  for (const [, lista] of perLato) lista.sort((a, b) => a.t - b.t);

  const anello: Punto[] = [];
  for (let e = 0; e < esterno.length; e++) {
    anello.push(esterno[e]);
    for (const p of perLato.get(e) ?? []) {
      const buco = interni[p.buco];
      anello.push(p.bocca1, p.imbocco1);
      for (let n = 1; n < buco.length; n++) anello.push(buco[(p.vertice + n) % buco.length]);
      anello.push(p.imbocco2, p.bocca2);
    }
  }

  return { anello, cuciti: ponti.length, scartati };
}
