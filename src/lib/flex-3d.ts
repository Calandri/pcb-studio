/**
 * THE FLEXIBLE TAIL IN 3D: the meshes the 3D view draws for the flexible part
 * of a rigid-flex board, folded as flex.json says (flex-piega.ts) or flat.
 *
 * The board's GLB (api/project/pcb-glb) carries only the rigid part (see
 * flex-glb.ts); the tail is drawn from here, thin as the declared stack:
 *
 *  - the LAMINATE: the zone with its cutouts and the holes drilled in it, a
 *    top and a bottom face and the walls of its edges, in the amber of
 *    polyimide and coverlay, a little transparent so the copper shows;
 *  - its COPPER, on the layers the zone declares: pours (the grid of the
 *    `retino` is in their holes), traces, pads, the rings of vias and plated
 *    holes, cut to the zone;
 *  - the STIFFENERS, on their face, as thick as declared;
 *  - the PARTS whose centre is on the tail, as boxes (their 3D models stay in
 *    the GLB only on the rigid part).
 *
 * Every flat triangle is first cut along the steps of the arcs, so that once
 * folded no straight edge cuts across a curve. Output: plain triangle lists in
 * board coordinates (mm, Z up, z = 0 in the middle of the rigid board), which
 * the viewer turns into three meshes and the tests measure.
 */
import { ShapeUtils, Vector2 } from "three";
import { flessibileDellaScheda, nelPoligono, profondita, type Flessibile, type Punto, type ZonaFlessibile } from "./flex-zone";
import {
  lineeDiTaglio,
  mezzoDellaPiega,
  piegaPunto,
  piegaturaDi,
  testoDellaCoda,
  testoDellaPiega,
  type CodaDaPiegare,
  type Punto3,
} from "./flex-piega";

type El = Record<string, unknown> & { type: string };

export type ParteDelFlessibile = "laminato" | "rame" | "irrigiditore" | "pezzo";

export interface MeshDelFlessibile {
  parte: ParteDelFlessibile;
  colore: string;
  /** 1 opaque */
  opacita: number;
  /** triangles, three vertices of three numbers each, board coordinates (mm, Z up) */
  posizioni: Float32Array;
}

export interface EtichettaDelFlessibile {
  testo: string;
  posizione: Punto3;
}

export interface VistaDelFlessibile {
  meshes: MeshDelFlessibile[];
  etichette: EtichettaDelFlessibile[];
}

export interface ScenaDelFlessibile {
  piegata: VistaDelFlessibile;
  spianata: VistaDelFlessibile;
  /** one line per tail: what its bends make of it */
  testiDelleCode: string[];
  spessoreMm: number;
}

export const COLORE_LAMINATO = "#D9962E";
export const COLORE_RAME = "#B5652E";
export const COLORE_IRRIGIDITORE = "#D6CE9A";
export const COLORE_PEZZO = "#2B3D38";
const OPACITA_LAMINATO = 0.72;
/** segments of a drilled hole or a ring */
const LATI_CERCHIO = 24;
/** how far from the tail a bend's words float (mm) */
const STACCO_ETICHETTA_MM = 1.4;
/** height of a part on the tail with no 3D size (mm) */
const ALTEZZA_PEZZO_MM = 1;

const COPPER_ORDER = ["top", "inner1", "inner2", "inner3", "inner4", "inner5", "inner6", "bottom"];

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function puntiDi(v: unknown): Punto[] {
  const out: Punto[] = [];
  for (const p of Array.isArray(v) ? (v as Array<{ x?: unknown; y?: unknown } | null>) : []) {
    const x = num(p?.x);
    const y = num(p?.y);
    if (x !== null && y !== null) out.push({ x, y });
  }
  return out;
}

const area = (p: Punto[]): number => {
  let a = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += (p[j].x - p[i].x) * (p[j].y + p[i].y);
  return a / 2;
};
const antiorario = (p: Punto[]): Punto[] => (area(p) < 0 ? [...p].reverse() : p);

function cerchio(cx: number, cy: number, r: number, lati = LATI_CERCHIO): Punto[] {
  const out: Punto[] = [];
  for (let i = 0; i < lati; i++) {
    const a = (2 * Math.PI * i) / lati;
    out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return out;
}

function rettangolo(cx: number, cy: number, w: number, h: number, gradi = 0): Punto[] {
  const a = (gradi * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
  ].map(([x, y]) => ({ x: cx + x * c - y * s, y: cy + x * s + y * c }));
}

/** a polygon with holes, as triangles (earcut, through three) */
function triangola(contorno: Punto[], buchi: Punto[][] = []): Punto[][] {
  if (contorno.length < 3) return [];
  const v = (p: Punto[]) => p.map((q) => new Vector2(q.x, q.y));
  const tutti = [contorno, ...buchi];
  const punti = tutti.flat();
  const indici = ShapeUtils.triangulateShape(v(contorno), buchi.map(v));
  return indici.map((t) => antiorario([punti[t[0]], punti[t[1]], punti[t[2]]]));
}

/** a convex polygon cut to the side of a line where f >= 0 (Sutherland-Hodgman, one edge) */
function taglia(poligono: Punto[], f: (p: Punto) => number): Punto[] {
  const out: Punto[] = [];
  for (let i = 0; i < poligono.length; i++) {
    const a = poligono[i];
    const b = poligono[(i + 1) % poligono.length];
    const fa = f(a);
    const fb = f(b);
    if (fa >= 0) out.push(a);
    if ((fa >= 0) !== (fb >= 0)) {
      const t = fa / (fa - fb);
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return out;
}

/** a convex polygon cut to a convex counterclockwise one */
function dentroAlConvesso(poligono: Punto[], convesso: Punto[]): Punto[] {
  let out = poligono;
  for (let i = 0; i < convesso.length && out.length >= 3; i++) {
    const a = convesso[i];
    const b = convesso[(i + 1) % convesso.length];
    out = taglia(out, (p) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x));
  }
  return out;
}

type Linea = { punto: Punto; normale: Punto };
const lato = (l: Linea) => (p: Punto) => (p.x - l.punto.x) * l.normale.x + (p.y - l.punto.y) * l.normale.y;

/** convex polygons cut along every line, each piece fanned into triangles */
function aStrisce(poligoni: Punto[][], linee: Linea[]): Punto[][] {
  let pezzi = poligoni;
  for (const l of linee) {
    const f = lato(l);
    const prossimi: Punto[][] = [];
    for (const p of pezzi) {
      let sopra = false;
      let sotto = false;
      for (const q of p) {
        const v = f(q);
        if (v > 1e-9) sopra = true;
        else if (v < -1e-9) sotto = true;
      }
      if (!(sopra && sotto)) {
        prossimi.push(p);
        continue;
      }
      const a = taglia(p, f);
      const b = taglia(p, (q) => -f(q));
      if (a.length >= 3) prossimi.push(a);
      if (b.length >= 3) prossimi.push(b);
    }
    pezzi = prossimi;
  }
  const tri: Punto[][] = [];
  for (const p of pezzi) for (let i = 1; i + 1 < p.length; i++) tri.push([p[0], p[i], p[i + 1]]);
  return tri;
}

/** the sides of rings, split where they cross a line: folded, each piece stays straight */
function latiAStrisce(anelli: Punto[][], linee: Linea[]): Array<[Punto, Punto]> {
  const out: Array<[Punto, Punto]> = [];
  for (const anello of anelli) {
    for (let i = 0; i < anello.length; i++) {
      const a = anello[i];
      const b = anello[(i + 1) % anello.length];
      const ts = [0, 1];
      for (const l of linee) {
        const f = lato(l);
        const fa = f(a);
        const fb = f(b);
        if ((fa > 0 && fb < 0) || (fa < 0 && fb > 0)) ts.push(fa / (fa - fb));
      }
      ts.sort((p, q) => p - q);
      for (let k = 0; k + 1 < ts.length; k++) {
        if (ts[k + 1] - ts[k] < 1e-9) continue;
        const p = (t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
        out.push([p(ts[k]), p(ts[k + 1])]);
      }
    }
  }
  return out;
}

type Mappa = (x: number, y: number, w: number) => Punto3;

class Raccolta {
  private readonly dati = new Map<string, { parte: ParteDelFlessibile; colore: string; opacita: number; v: number[] }>();
  aggiungi(parte: ParteDelFlessibile, colore: string, opacita: number, a: Punto3, b: Punto3, c: Punto3): void {
    const chiave = `${parte}|${colore}|${opacita}`;
    let d = this.dati.get(chiave);
    if (!d) this.dati.set(chiave, (d = { parte, colore, opacita, v: [] }));
    d.v.push(...a, ...b, ...c);
  }
  meshes(): MeshDelFlessibile[] {
    return [...this.dati.values()].map((d) => ({ parte: d.parte, colore: d.colore, opacita: d.opacita, posizioni: new Float32Array(d.v) }));
  }
}

/** a flat plate between w0 and w1: top and bottom faces from triangles, walls from its rings */
function lastra(
  r: Raccolta,
  mappa: Mappa,
  triangoli: Punto[][],
  anelli: Punto[][],
  linee: Linea[],
  w0: number,
  w1: number,
  parte: ParteDelFlessibile,
  colore: string,
  opacita: number,
): void {
  for (const t of aStrisce(triangoli, linee)) {
    const [a, b, c] = t;
    r.aggiungi(parte, colore, opacita, mappa(a.x, a.y, w1), mappa(b.x, b.y, w1), mappa(c.x, c.y, w1));
    r.aggiungi(parte, colore, opacita, mappa(a.x, a.y, w0), mappa(c.x, c.y, w0), mappa(b.x, b.y, w0));
  }
  for (const [a, b] of latiAStrisce(anelli, linee)) {
    const a0 = mappa(a.x, a.y, w0);
    const b0 = mappa(b.x, b.y, w0);
    const a1 = mappa(a.x, a.y, w1);
    const b1 = mappa(b.x, b.y, w1);
    r.aggiungi(parte, colore, opacita, a0, b0, b1);
    r.aggiungi(parte, colore, opacita, a0, b1, a1);
  }
}

/** the height of each copper layer of a zone in the tail's thickness */
function quoteDegliStrati(strati: string[], spessore: number): Map<string, number> {
  const ordinati = [...strati].sort((a, b) => COPPER_ORDER.indexOf(a) - COPPER_ORDER.indexOf(b));
  const out = new Map<string, number>();
  const utile = spessore * 0.5;
  ordinati.forEach((s, i) => out.set(s, ordinati.length === 1 ? 0 : utile / 2 - (utile * i) / (ordinati.length - 1)));
  return out;
}

/** the copper of a zone, flat, as polygons per layer (with their holes) */
function rameDellaZona(els: El[], zona: ZonaFlessibile): Map<string, Array<{ contorno: Punto[]; buchi: Punto[][] }>> {
  const strati = new Set(zona.strati);
  const out = new Map<string, Array<{ contorno: Punto[]; buchi: Punto[][] }>>();
  const metti = (layer: string, contorno: Punto[], buchi: Punto[][] = []) => {
    if (!strati.has(layer) || contorno.length < 3) return;
    const xs = contorno.map((p) => p.x);
    const ys = contorno.map((p) => p.y);
    if (Math.max(...xs) < zona.minX || Math.min(...xs) > zona.maxX || Math.max(...ys) < zona.minY || Math.min(...ys) > zona.maxY) return;
    let l = out.get(layer);
    if (!l) out.set(layer, (l = []));
    l.push({ contorno, buchi });
  };
  const toccaLaZona = (a: Punto[]) => {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of a) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    return maxX >= zona.minX && minX <= zona.maxX && maxY >= zona.minY && minY <= zona.maxY;
  };
  const dentro = (x: number, y: number) => x >= zona.minX && x <= zona.maxX && y >= zona.minY && y <= zona.maxY && nelPoligono(x, y, zona.punti);
  for (const el of els) {
    switch (el.type) {
      case "pcb_copper_pour": {
        const brep = el.brep_shape as { outer_ring?: { vertices?: unknown }; inner_rings?: Array<{ vertices?: unknown }> } | undefined;
        const contorno = brep ? puntiDi(brep.outer_ring?.vertices) : puntiDi(el.points);
        // only the holes that reach the zone: a plane of the whole board has hundreds round the vias of the rigid part
        const buchi = (brep?.inner_rings ?? [])
          .map((a) => puntiDi(a?.vertices))
          .filter((a) => a.length >= 3 && toccaLaZona(a));
        metti(String(el.layer ?? ""), contorno, buchi);
        break;
      }
      case "pcb_trace": {
        const route = Array.isArray(el.route) ? (el.route as Array<Record<string, unknown>>) : [];
        for (let i = 0; i + 1 < route.length; i++) {
          const a = route[i];
          const b = route[i + 1];
          if (a.route_type !== "wire" || b.route_type !== "wire" || a.layer !== b.layer) continue;
          const ax = num(a.x), ay = num(a.y), bx = num(b.x), by = num(b.y);
          const w = num(a.width) ?? 0.15;
          if (ax === null || ay === null || bx === null || by === null) continue;
          if (!dentro(ax, ay) && !dentro(bx, by)) continue;
          const l = Math.hypot(bx - ax, by - ay);
          if (l > 1e-9) metti(String(a.layer), rettangolo((ax + bx) / 2, (ay + by) / 2, l, w, (Math.atan2(by - ay, bx - ax) * 180) / Math.PI));
          metti(String(a.layer), cerchio(bx, by, w / 2, 12));
          if (i === 0) metti(String(a.layer), cerchio(ax, ay, w / 2, 12));
        }
        break;
      }
      case "pcb_smtpad": {
        const x = num(el.x), y = num(el.y);
        const layer = String(el.layer ?? "");
        if (el.shape === "polygon") {
          const forma = puntiDi(el.points);
          if (forma.some((q) => dentro(q.x, q.y))) metti(layer, antiorario(forma));
          break;
        }
        if (x === null || y === null || !dentro(x, y)) break;
        if (el.shape === "circle") metti(layer, cerchio(x, y, num(el.radius) ?? 0.2));
        else metti(layer, antiorario(rettangolo(x, y, num(el.width) ?? 0.5, num(el.height) ?? 0.5, num(el.ccw_rotation) ?? num(el.rotation) ?? 0)));
        break;
      }
      case "pcb_via":
      case "pcb_plated_hole": {
        const x = num(el.x), y = num(el.y);
        if (x === null || y === null || !dentro(x, y)) break;
        const fuori = (num(el.outer_diameter) ?? num(el.outer_width) ?? 0.6) / 2;
        const foro = (num(el.hole_diameter) ?? num(el.hole_width) ?? 0.3) / 2;
        for (const s of zona.strati) metti(s, cerchio(x, y, fuori), [cerchio(x, y, foro)]);
        break;
      }
    }
  }
  return out;
}

/** the holes drilled through a zone: vias, plated holes and holes whose centre is in it, round */
function foriDellaZona(els: El[], zona: ZonaFlessibile): Punto[][] {
  const out: Punto[][] = [];
  for (const el of els) {
    if (el.type !== "pcb_via" && el.type !== "pcb_plated_hole" && el.type !== "pcb_hole") continue;
    const x = num(el.x), y = num(el.y);
    const r = (num(el.hole_diameter) ?? num(el.hole_width) ?? 0) / 2;
    if (x === null || y === null || r <= 0) continue;
    // whole inside the zone and out of its cutouts, or earcut would get holes that cross
    if (profondita(x, y, zona.punti) <= r + 0.01) continue;
    if (zona.ritagli.some((t) => profondita(x, y, t.punti) > -(r + 0.01))) continue;
    if (out.some((h) => nelPoligono(x, y, h))) continue;
    out.push(cerchio(x, y, r));
  }
  return out;
}

/** the parts whose centre is on a zone: a box each, flat in the board's frame */
function pezziDellaZona(els: El[], zona: ZonaFlessibile): Array<{ angoli: Punto[]; altezza: number; sotto: boolean }> {
  const cad = new Map<string, El>();
  for (const el of els) if (el.type === "cad_component" && typeof el.pcb_component_id === "string") cad.set(el.pcb_component_id, el);
  const out: Array<{ angoli: Punto[]; altezza: number; sotto: boolean }> = [];
  for (const el of els) {
    if (el.type !== "pcb_component") continue;
    const c = el.center as { x?: unknown; y?: unknown } | undefined;
    const x = num(c?.x), y = num(c?.y);
    if (x === null || y === null || profondita(x, y, zona.punti) <= 0) continue;
    const w = num(el.width) ?? 1;
    const h = num(el.height) ?? 1;
    const size = cad.get(String(el.pcb_component_id))?.size as { z?: unknown } | undefined;
    out.push({
      angoli: rettangolo(x, y, Math.max(w, 0.2), Math.max(h, 0.2), num(el.rotation) ?? 0),
      altezza: num(size?.z) ?? ALTEZZA_PEZZO_MM,
      sotto: el.layer === "bottom",
    });
  }
  return out;
}

function vista(els: El[], flex: Flessibile, coda: CodaDaPiegare, spessore: number, piegata: boolean, r: Raccolta): EtichettaDelFlessibile[] {
  const zona = coda.zona;
  const mappa: Mappa = piegata ? (x, y, w) => piegaPunto(coda, x, y, w) : (x, y, w) => [x, y, w + coda.quotaMm];
  const linee = piegata ? lineeDiTaglio(coda) : [];
  const t2 = spessore / 2;

  // the laminate, with its cutouts and drilled holes
  const contorno = antiorario(zona.punti);
  // earcut takes holes either way round: copies, so the zone read from the board is never changed
  const buchi = [...zona.ritagli.map((t) => [...t.punti]), ...foriDellaZona(els, zona)];
  lastra(r, mappa, triangola(contorno, buchi), [contorno, ...buchi], linee, -t2, t2, "laminato", COLORE_LAMINATO, OPACITA_LAMINATO);

  // its copper, cut to the zone (the zone in convex pieces: its triangles, cutouts left out since the copper has holes there)
  const pezziZona = triangola(contorno);
  const box = pezziZona.map((t) => ({
    minX: Math.min(t[0].x, t[1].x, t[2].x),
    maxX: Math.max(t[0].x, t[1].x, t[2].x),
    minY: Math.min(t[0].y, t[1].y, t[2].y),
    maxY: Math.max(t[0].y, t[1].y, t[2].y),
  }));
  const quote = quoteDegliStrati(zona.strati, spessore);
  for (const [layer, forme] of rameDellaZona(els, zona)) {
    const w = quote.get(layer) ?? 0;
    const tagliati: Punto[][] = [];
    for (const f of forme) {
      for (const t of triangola(antiorario(f.contorno), f.buchi)) {
        const minX = Math.min(t[0].x, t[1].x, t[2].x);
        const maxX = Math.max(t[0].x, t[1].x, t[2].x);
        const minY = Math.min(t[0].y, t[1].y, t[2].y);
        const maxY = Math.max(t[0].y, t[1].y, t[2].y);
        for (let i = 0; i < pezziZona.length; i++) {
          const b = box[i];
          if (maxX < b.minX || minX > b.maxX || maxY < b.minY || minY > b.maxY) continue;
          const pezzo = dentroAlConvesso(t, pezziZona[i]);
          if (pezzo.length >= 3 && Math.abs(area(pezzo)) > 1e-8) tagliati.push(pezzo);
        }
      }
    }
    for (const [a, b, c] of aStrisce(tagliati, linee)) {
      r.aggiungi("rame", COLORE_RAME, 1, mappa(a.x, a.y, w), mappa(b.x, b.y, w), mappa(c.x, c.y, w));
    }
  }

  // the stiffeners of this zone, on their face
  for (const irr of irrigiditoriDellaZona(flex, zona)) {
    const forma = antiorario(irr.punti);
    const fori = irr.fori.map((f) => cerchio(f.x, f.y, f.diametroMm / 2));
    const [w0, w1] = irr.lato === "top" ? [t2, t2 + irr.spessoreMm] : [-t2 - irr.spessoreMm, -t2];
    lastra(r, mappa, triangola(forma, fori), [forma, ...fori], linee, w0, w1, "irrigiditore", COLORE_IRRIGIDITORE, 1);
  }

  // the parts on the tail, as boxes on their face
  for (const p of pezziDellaZona(els, zona)) {
    const [w0, w1] = p.sotto ? [-t2 - p.altezza, -t2] : [t2, t2 + p.altezza];
    const giu = p.angoli.map((q) => mappa(q.x, q.y, w0));
    const su = p.angoli.map((q) => mappa(q.x, q.y, w1));
    const facce: Array<[Punto3, Punto3, Punto3]> = [
      [su[0], su[1], su[2]], [su[0], su[2], su[3]],
      [giu[0], giu[2], giu[1]], [giu[0], giu[3], giu[2]],
    ];
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      facce.push([giu[i], giu[j], su[j]], [giu[i], su[j], su[i]]);
    }
    for (const [a, b, c] of facce) r.aggiungi("pezzo", COLORE_PEZZO, 1, a, b, c);
  }

  // the words: on the outer side of each arc, half way round it; flat, just above the line
  return coda.pieghe.map((p) => {
    const m = mezzoDellaPiega(p);
    const w = piegata ? -p.s * (t2 + STACCO_ETICHETTA_MM) : t2 + STACCO_ETICHETTA_MM;
    return { testo: testoDellaPiega(p), posizione: mappa(m.x, m.y, w) };
  });
}

/** the stiffeners whose centre is in a zone */
function irrigiditoriDellaZona(flex: Flessibile, zona: ZonaFlessibile): Flessibile["irrigiditori"] {
  return flex.irrigiditori.filter((irr) => {
    // the zone it names, on independent flexible layers: two zones may hold it
    if (irr.zonaId) return irr.zonaId === zona.id;
    const cx = irr.punti.reduce((t, p) => t + p.x, 0) / irr.punti.length;
    const cy = irr.punti.reduce((t, p) => t + p.y, 0) / irr.punti.length;
    return profondita(cx, cy, zona.punti) > 0;
  });
}

/**
 * The tail of a rigid-flex board, folded and flat, ready for the 3D view:
 * null for a board with no flexible zone.
 */
export function scenaDelFlessibile(circuitJson: unknown[] | null | undefined): ScenaDelFlessibile | null {
  const els = (circuitJson ?? []) as El[];
  const flex = flessibileDellaScheda(els);
  if (!flex) return null;
  const piegatura = piegaturaDi(flex);
  const piegata = new Raccolta();
  const spianata = new Raccolta();
  const etichetteP: EtichettaDelFlessibile[] = [];
  const etichetteS: EtichettaDelFlessibile[] = [];
  for (const coda of piegatura.code) {
    etichetteP.push(...vista(els, flex, coda, coda.spessoreMm, true, piegata));
    etichetteS.push(...vista(els, flex, coda, coda.spessoreMm, false, spianata));
  }
  return {
    piegata: { meshes: piegata.meshes(), etichette: etichetteP },
    spianata: { meshes: spianata.meshes(), etichette: etichetteS },
    testiDelleCode: piegatura.code.map(testoDellaCoda),
    spessoreMm: piegatura.spessoreMm,
  };
}

/**
 * FROM THE BOARD'S FRAME TO THE GLB'S. The converter (circuit-json-to-gltf)
 * writes the board with X the board's x turned round (-x), Y up (the
 * thickness) and Z the board's y, centred on the middle of the thickness:
 * measured on tm-4l-q1, U2 at (-6.375, -4.25) on the bottom sits in the GLB at
 * (6.375, -0.8, -4.25). It is a rotation, not a mirror, so triangles keep their
 * winding. The tail is put in that frame, as a child of the GLB's scene, and
 * follows whatever the viewer then does to it (the half turn that brings x
 * back, the centring).
 */
export function versoIlGlb(posizioni: Float32Array): Float32Array {
  const out = new Float32Array(posizioni.length);
  for (let i = 0; i < posizioni.length; i += 3) {
    out[i] = -posizioni[i];
    out[i + 1] = posizioni[i + 2];
    out[i + 2] = posizioni[i + 1];
  }
  return out;
}

/** a point from the board's frame to the GLB's (see versoIlGlb) */
export function puntoVersoIlGlb(p: Punto3): Punto3 {
  return [-p[0], p[2], p[1]];
}
