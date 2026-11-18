/**
 * THE FLEXIBLE PART OF A RIGID-FLEX BOARD, as it is on the board.
 *
 * A rigid-flex board is one piece: a rigid part and one or more flexible tails
 * that leave it, bend and go on in the enclosure. The outline of the board is
 * the outline of the whole piece, rigid part and tails together, as the files
 * draw it (`<board outline>`); what says which part of it bends is the
 * project's flex.json (see flex.ts), and the compile and the recheck put what
 * it says on the board as elements of their own:
 *
 *  - a FLEXIBLE ZONE (ZONA_FLESSIBILE): a polygon in board coordinates and the
 *    copper layers that exist in it. The other layers of the board end where
 *    the zone starts. A zone can have WINDOWS, where the laminate stays and no
 *    layer has copper (the free area an antenna asks for), and CUTOUTS, holes
 *    cut through the tail, which are also on the board as pcb_cutout elements
 *    (RITAGLIO_DEL_FLESSIBILE) so that the outline of the Gerber has them;
 *  - a BEND LINE (PIEGA): a segment across a zone, with the inner radius, the
 *    angle (up to 180 degrees, a tail folded back over the board) and the side
 *    the tail folds to. What curves is not a line: it is the stretch of tail
 *    as long as the arc, half on each side of the line (`fascia`);
 *  - a STIFFENER (IRRIGIDITORE): a polygon glued on one face, with its material,
 *    its thickness and its holes;
 *  - an OPENING OF THE COVERLAY (APERTURA_COVERLAY), per face;
 *  - the STACK of the flexible part (PILA_FLESSIBILE): thickness, coverlay,
 *    materials.
 *
 * TWO OR MORE INDEPENDENT FLEXIBLE LAYERS (an "air gap" or bookbinder
 * construction): when flex.json declares `pila.flessibili`, every zone says
 * which flexible layer of the stack it is on (`flex_layer` on the element) and
 * zones of different layers may lie on top of each other, flat: two tails cut
 * from two sheets that are bonded together only inside the rigid part. The
 * outline of the board is then ALL the material, the rigid part and every sheet
 * flat; a gap closed between two tails is a cutout of the board. Which side of
 * a zone is where the rigid part ends is measured, not guessed: just outside
 * that side there is rigid board (inside the outline, out of the board's
 * cutouts and of every other zone). A bend, a stiffener and an opening of the
 * coverlay name their zone (`pcb_flex_zone_id`), since a point can be in two.
 * Boards whose flex.json has no `pila.flessibili` are read exactly as before.
 *
 * This file only reads them back, for whoever needs to know where the board
 * bends: the checks (drc.ts), the pours, the Gerber and the viewer. It imports
 * nothing of theirs, so each of them can import it.
 */

type El = Record<string, unknown> & { type: string };
export type Punto = { x: number; y: number };
/** one side of a polygon, or a stretch of one */
export interface Lato {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

export const ZONA_FLESSIBILE = "pcb_flex_zone";
export const PIEGA = "pcb_flex_bend";
export const IRRIGIDITORE = "pcb_flex_stiffener";
export const APERTURA_COVERLAY = "pcb_flex_coverlay_opening";
export const PILA_FLESSIBILE = "pcb_flex_stackup";
/** every element of its own flex.json puts on a board */
export const ELEMENTI_DEL_FLESSIBILE: readonly string[] = [ZONA_FLESSIBILE, PIEGA, IRRIGIDITORE, APERTURA_COVERLAY, PILA_FLESSIBILE];
/** how the id of a pcb_cutout starts when it is a cutout of a flexible zone, put on the board from flex.json */
export const RITAGLIO_DEL_FLESSIBILE = "pcb_cutout_flessibile_";

/** whether an element of a board was put there from flex.json: one of its own, or the pcb_cutout of a cutout of a zone */
export function eDelFlessibile(el: { type?: unknown; pcb_cutout_id?: unknown } | null | undefined): boolean {
  if (!el || typeof el.type !== "string") return false;
  if (ELEMENTI_DEL_FLESSIBILE.includes(el.type)) return true;
  return el.type === "pcb_cutout" && typeof el.pcb_cutout_id === "string" && el.pcb_cutout_id.startsWith(RITAGLIO_DEL_FLESSIBILE);
}

/**
 * THE GRID a zone asks for its copper (`retino` in flex.json): on the flexible
 * part PCB Basic wants the ground hatched, not solid ("Use grid ground layer to
 * enhance flexibility and reduce the risk of copper cracking",
 * https://www.pcbasic.com/blog/flex_pcb_design.html). The pours of the layers
 * of the zone are cut into a grid of lines by the compile (flex-retino.ts).
 */
export interface Retino {
  /** the width of a line of the grid (mm) */
  larghezzaMm: number;
  /** from the middle of a line to the middle of the next (mm) */
  passoMm: number;
  /** degrees the grid is turned by: 45 is the usual one */
  angolo: number;
  /** where the copper is a grid: the stretch of tail a bend curves, with a margin, or the whole zone */
  dove: "piega" | "tutta";
  /** with "piega": how far past the stretch a bend curves the grid goes on, on each side (mm) */
  margineMm: number;
  /** how many openings the compile cut in the pours for it; absent on a board the grid was not laid on yet */
  aperture?: number;
  /** why the compile did not lay it, when it did not */
  nonApplicato?: string;
}

export interface ZonaFlessibile {
  id: string;
  nome: string;
  /** the flexible layer of the stack the zone is on, on a board with independent flexible layers (pila.flessibili) */
  flessibile?: string;
  punti: Punto[];
  /** the copper layers that exist in the zone: top, inner1, inner2, bottom... */
  strati: string[];
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  /** where the tail is cut: the stretches of its sides that are the edge of the board, and the sides of its cutouts */
  bordi: Lato[];
  /** the stretches inside the board: where the rigid part ends and the flexible one starts */
  confini: Lato[];
  /** the windows: the laminate is there, no layer has copper */
  finestre: Array<{ nome: string; punti: Punto[] }>;
  /** the cutouts: holes cut through the tail */
  ritagli: Array<{ nome: string; punti: Punto[] }>;
  /** the grid its copper is cut into, when the zone asks one */
  retino: Retino | null;
}

export interface Piega {
  id: string;
  nome: string;
  a: Punto;
  b: Punto;
  /** the inner radius of the bend (mm) */
  raggioMm: number;
  /** degrees the tail turns by: 180 is a tail folded back over the board */
  angolo: number;
  /** the face the tail folds towards: "su" the top, "giu" the bottom */
  verso: "su" | "giu";
  /** the zone its middle is in, when it is in one */
  zona: ZonaFlessibile | null;
  /**
   * How much tail curves on each side of the line (mm): half the arc of the
   * bend, measured on the middle of the thickness, angolo (in radians) x
   * (raggioMm + spessore / 2) / 2. A fold of 180 degrees at 1 mm of radius on
   * a tail 0.1 mm thick takes 3.3 mm of tail, 1.65 on each side.
   */
  mezzaFasciaMm: number;
  /** the stretch of tail that curves: the line, that much wider on each side */
  fascia: Punto[];
}

export interface Irrigiditore {
  id: string;
  nome: string;
  /** the zone it is glued on, when the board says it (independent flexible layers) */
  zonaId?: string;
  lato: "top" | "bottom";
  punti: Punto[];
  materiale: string;
  spessoreMm: number;
  fori: Array<{ x: number; y: number; diametroMm: number }>;
}

export interface AperturaCoverlay {
  id: string;
  nome: string;
  /** the zone it opens, when the board says it (independent flexible layers) */
  zonaId?: string;
  lato: "top" | "bottom";
  punti: Punto[];
}

export interface PilaFlessibile {
  /** the thickness of the flexible part, coverlay included, stiffeners not (mm) */
  spessoreMm: number;
  coverlay: string;
  materiali: Array<{ tipo: string; nome?: string; mm: number }>;
  /** the independent flexible layers, when the stack has more than one (air gap): absent on a board with one */
  flessibili?: StratoFlessibile[];
}

/**
 * ONE FLEXIBLE LAYER of a stack with independent ones: a sheet of polyimide
 * with its copper layers, its thickness and its coverlay, bonded to the others
 * only inside the rigid part.
 */
export interface StratoFlessibile {
  nome: string;
  /** the copper layers of the board that go on into this sheet */
  strati: string[];
  spessoreMm: number;
  coverlay: string;
  materiali: Array<{ tipo: string; nome?: string; mm: number }>;
}

/** the thickness of the sheet a zone is on: its flexible layer's, or the stack's */
export function spessoreDellaZona(flex: Flessibile, zona: ZonaFlessibile | null | undefined): number | null {
  const suo = zona?.flessibile ? flex.pila?.flessibili?.find((f) => f.nome === zona.flessibile) : undefined;
  return suo?.spessoreMm ?? flex.pila?.spessoreMm ?? null;
}

export interface Flessibile {
  zone: ZonaFlessibile[];
  pieghe: Piega[];
  irrigiditori: Irrigiditore[];
  aperture: AperturaCoverlay[];
  pila: PilaFlessibile | null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

const punti = (v: unknown): Punto[] => {
  const out: Punto[] = [];
  for (const p of Array.isArray(v) ? (v as Array<{ x?: unknown; y?: unknown } | null>) : []) {
    const x = num(p?.x);
    const y = num(p?.y);
    if (x !== null && y !== null) out.push({ x, y });
  }
  return out;
};

const punto = (v: unknown): Punto | null => {
  const p = v as { x?: unknown; y?: unknown } | null | undefined;
  const x = num(p?.x);
  const y = num(p?.y);
  return x !== null && y !== null ? { x, y } : null;
};

/** point inside a polygon, ray casting: a point on a side is on either side of it */
export function nelPoligono(x: number, y: number, poligono: Punto[]): boolean {
  let dentro = false;
  for (let i = 0, j = poligono.length - 1; i < poligono.length; j = i++) {
    const a = poligono[i];
    const b = poligono[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) dentro = !dentro;
  }
  return dentro;
}

/** how far a point is from a segment */
export function dalSegmento(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax;
  const vy = by - ay;
  const l2 = vx * vx + vy * vy;
  const t = l2 < 1e-18 ? 0 : Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / l2));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

/** how far a point is from the outline of a polygon, inside or outside it */
export function dalContorno(x: number, y: number, poligono: Punto[]): number {
  let d = Infinity;
  for (let i = 0, j = poligono.length - 1; i < poligono.length; j = i++) {
    d = Math.min(d, dalSegmento(x, y, poligono[j].x, poligono[j].y, poligono[i].x, poligono[i].y));
  }
  return d;
}

/**
 * How deep a point is in a polygon: its distance from the outline, positive
 * inside and negative outside. A point on a side is at zero.
 */
export function profondita(x: number, y: number, poligono: Punto[]): number {
  const d = dalContorno(x, y, poligono);
  return nelPoligono(x, y, poligono) ? d : -d;
}

/** whether two segments cross or touch */
export function siIncrociano(a: Lato, b: Lato): boolean {
  const verso = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) => (qx - px) * (ry - py) - (qy - py) * (rx - px);
  const d1 = verso(b.ax, b.ay, b.bx, b.by, a.ax, a.ay);
  const d2 = verso(b.ax, b.ay, b.bx, b.by, a.bx, a.by);
  const d3 = verso(a.ax, a.ay, a.bx, a.by, b.ax, b.ay);
  const d4 = verso(a.ax, a.ay, a.bx, a.by, b.bx, b.by);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  const sopra = (px: number, py: number, s: Lato) => dalSegmento(px, py, s.ax, s.ay, s.bx, s.by) < 1e-9;
  return sopra(a.ax, a.ay, b) || sopra(a.bx, a.by, b) || sopra(b.ax, b.ay, a) || sopra(b.bx, b.by, a);
}

/** how much tail a bend takes on each side of its line (see Piega.mezzaFasciaMm) */
export function mezzaFasciaDellaPiega(raggioMm: number, angolo: number, spessoreMm: number): number {
  return (((angolo * Math.PI) / 180) * (raggioMm + spessoreMm / 2)) / 2;
}

/** a segment made `mezza` wider on each side: the stretch of tail a bend curves */
export function fasciaDi(a: Punto, b: Punto, mezza: number): Punto[] {
  const l = Math.hypot(b.x - a.x, b.y - a.y);
  if (l < 1e-9) return [a, b, b, a];
  const nx = (-(b.y - a.y) / l) * mezza;
  const ny = ((b.x - a.x) / l) * mezza;
  return [
    { x: a.x - nx, y: a.y - ny },
    { x: b.x - nx, y: b.y - ny },
    { x: b.x + nx, y: b.y + ny },
    { x: a.x + nx, y: a.y + ny },
  ];
}

/** the sides of a polygon */
export function latiDi(poligono: Punto[]): Lato[] {
  return poligono.map((a, i) => {
    const b = poligono[(i + 1) % poligono.length];
    return { ax: a.x, ay: a.y, bx: b.x, by: b.y };
  });
}

/**
 * The outline of the board: the declared polygon, or the rectangle of the
 * board. The same reading as contornoScheda in drc.ts, which this file cannot
 * import (drc.ts imports this one).
 */
export function contornoDellaScheda(circuitJson: El[]): Punto[] {
  const board = circuitJson.find((el) => el?.type === "pcb_board");
  if (!board) return [];
  const dichiarato = punti(board.outline);
  if (dichiarato.length >= 3) return dichiarato;
  const w = num(board.width);
  const h = num(board.height);
  if (w === null || h === null) return [];
  const centro = punto(board.center) ?? { x: 0, y: 0 };
  return [
    { x: centro.x - w / 2, y: centro.y - h / 2 },
    { x: centro.x + w / 2, y: centro.y - h / 2 },
    { x: centro.x + w / 2, y: centro.y + h / 2 },
    { x: centro.x - w / 2, y: centro.y + h / 2 },
  ];
}

/** a point of a zone's side this near the outline of the board is on it: coordinates are rounded to the micron */
const SUL_BORDO_MM = 0.005;
/** how far apart the points are where a side of a zone is asked whether it is the edge of the board */
const PASSO_LATO_MM = 0.25;
/** and how many of them a side has at most */
const MAX_PASSI_LATO = 400;

/**
 * THE SIDES OF A ZONE, SPLIT IN TWO KINDS: the stretches that run along the
 * outline of the board (`bordi`: the tail is cut there) and those inside the
 * board (`confini`: the rigid part ends there). A side can be both, one stretch
 * after the other, when the tail is narrower than the edge it leaves: it is
 * walked in steps and split where the answer changes. With no outline every
 * side is a boundary.
 */
export function latiDellaZona(zona: Punto[], contorno: Punto[]): { bordi: Lato[]; confini: Lato[] } {
  const bordi: Lato[] = [];
  const confini: Lato[] = [];
  for (const lato of latiDi(zona)) {
    const lungo = Math.hypot(lato.bx - lato.ax, lato.by - lato.ay);
    if (lungo < 1e-9) continue;
    if (contorno.length < 3) {
      confini.push(lato);
      continue;
    }
    // a step of PASSO_LATO_MM, longer on a side of more than a hundred millimetres: the walk is bounded whatever the file draws
    const passi = Math.min(MAX_PASSI_LATO, Math.max(1, Math.ceil(lungo / PASSO_LATO_MM)));
    const a = (k: number): Punto => ({ x: lato.ax + ((lato.bx - lato.ax) * k) / passi, y: lato.ay + ((lato.by - lato.ay) * k) / passi });
    // every step is judged in its middle, so a corner shared with the outline does not decide for the side
    let inizio = 0;
    let tipo: boolean | null = null;
    for (let k = 0; k <= passi; k++) {
      const m = k < passi ? a(k + 0.5) : null;
      const sulBordo = m ? dalContorno(m.x, m.y, contorno) <= SUL_BORDO_MM : null;
      if (sulBordo === tipo) continue;
      if (tipo !== null) {
        const da = a(inizio);
        const fino = a(k);
        (tipo ? bordi : confini).push({ ax: da.x, ay: da.y, bx: fino.x, by: fino.y });
      }
      inizio = k;
      tipo = sulBordo;
    }
  }
  return { bordi, confini };
}

/** how far outside a side of a zone the material is looked at, to tell a cut edge from the rigid boundary (mm) */
const FUORI_DAL_LATO_MM = 0.02;

/**
 * THE SIDES OF A ZONE ON A BOARD WITH INDEPENDENT FLEXIBLE LAYERS: a side is
 * where the rigid part ends (`confini`) where, just outside it, there is rigid
 * board: inside the outline, out of the board's own cutouts and out of every
 * other zone. Everywhere else it is cut (`bordi`): along the outline, along a
 * gap closed between two tails, across a tail of another layer lying over it.
 */
export function latiDellaZonaFraStrati(zona: Punto[], contorno: Punto[], vuoti: Punto[][], altre: Punto[][]): { bordi: Lato[]; confini: Lato[] } {
  const bordi: Lato[] = [];
  const confini: Lato[] = [];
  // counterclockwise: the outside of a side is on its right
  let area = 0;
  for (let i = 0, j = zona.length - 1; i < zona.length; j = i++) area += (zona[j].x + zona[i].x) * (zona[j].y - zona[i].y);
  const antiorario = area < 0;
  const rigido = (x: number, y: number): boolean =>
    (contorno.length < 3 || profondita(x, y, contorno) > 0) && !vuoti.some((v) => nelPoligono(x, y, v)) && !altre.some((a) => profondita(x, y, a) > -FUORI_DAL_LATO_MM / 2);
  for (const lato of latiDi(zona)) {
    const lungo = Math.hypot(lato.bx - lato.ax, lato.by - lato.ay);
    if (lungo < 1e-9) continue;
    const ox = ((antiorario ? 1 : -1) * (lato.by - lato.ay)) / lungo;
    const oy = ((antiorario ? -1 : 1) * (lato.bx - lato.ax)) / lungo;
    const passi = Math.min(MAX_PASSI_LATO, Math.max(1, Math.ceil(lungo / PASSO_LATO_MM)));
    const a = (k: number): Punto => ({ x: lato.ax + ((lato.bx - lato.ax) * k) / passi, y: lato.ay + ((lato.by - lato.ay) * k) / passi });
    let inizio = 0;
    let tipo: boolean | null = null;
    for (let k = 0; k <= passi; k++) {
      const m = k < passi ? a(k + 0.5) : null;
      const confine = m ? rigido(m.x + ox * FUORI_DAL_LATO_MM, m.y + oy * FUORI_DAL_LATO_MM) : null;
      if (confine === tipo) continue;
      if (tipo !== null) {
        const da = a(inizio);
        const fino = a(k);
        (tipo ? confini : bordi).push({ ax: da.x, ay: da.y, bx: fino.x, by: fino.y });
      }
      inizio = k;
      tipo = confine;
    }
  }
  return { bordi, confini };
}

/** the board's own cutouts (not those of a flexible zone), as polygons: a gap closed between two tails is one */
export function vuotiDellaScheda(circuitJson: El[]): Punto[][] {
  const out: Punto[][] = [];
  for (const el of circuitJson) {
    if (el?.type !== "pcb_cutout" || eDelFlessibile(el)) continue;
    if (el.shape === "polygon") {
      const p = punti(el.points);
      if (p.length >= 3) out.push(p);
    } else if (el.shape === "rect") {
      const c = punto(el.center);
      const w = num(el.width);
      const h = num(el.height);
      if (c && w !== null && h !== null) out.push([{ x: c.x - w / 2, y: c.y - h / 2 }, { x: c.x + w / 2, y: c.y - h / 2 }, { x: c.x + w / 2, y: c.y + h / 2 }, { x: c.x - w / 2, y: c.y + h / 2 }]);
    } else if (el.shape === "circle") {
      const c = punto(el.center);
      const r = num(el.radius);
      if (c && r !== null) out.push(Array.from({ length: 24 }, (_, i) => ({ x: c.x + r * Math.cos((i * Math.PI) / 12), y: c.y + r * Math.sin((i * Math.PI) / 12) })));
    }
  }
  return out;
}

/** the grid a zone element carries, when it carries one that can be laid */
function retinoDi(v: unknown): Retino | null {
  const h = v as Record<string, unknown> | null | undefined;
  const larghezza = num(h?.width_mm);
  const passo = num(h?.pitch_mm);
  if (!h || larghezza === null || passo === null || larghezza <= 0 || passo <= larghezza) return null;
  const aperture = num(h.openings);
  return {
    larghezzaMm: larghezza,
    passoMm: passo,
    angolo: num(h.angle_deg) ?? 45,
    dove: h.where === "tutta" ? "tutta" : "piega",
    margineMm: Math.max(0, num(h.margin_mm) ?? 0),
    ...(aperture !== null ? { aperture } : {}),
    ...(typeof h.skipped === "string" ? { nonApplicato: h.skipped } : {}),
  };
}

/**
 * What flex.json put on a board, read back: null for a board with no flexible
 * zone, which is every board that is not a rigid-flex one. The sides of each
 * zone are told apart against the outline the board has now.
 */
export function flessibileDellaScheda(circuitJson: unknown[] | null | undefined): Flessibile | null {
  const els = (circuitJson ?? []) as El[];
  if (!els.some((el) => el?.type === ZONA_FLESSIBILE)) return null;
  const contorno = contornoDellaScheda(els);
  const flex: Flessibile = { zone: [], pieghe: [], irrigiditori: [], aperture: [], pila: null };
  // independent flexible layers: zones may overlap, and their sides are told apart by what is outside them
  const fraStrati = els.some((el) => el?.type === ZONA_FLESSIBILE && typeof el.flex_layer === "string");
  const vuoti = fraStrati ? vuotiDellaScheda(els) : [];
  const tutte = fraStrati ? els.filter((el) => el?.type === ZONA_FLESSIBILE).map((el) => ({ el, p: punti(el.points) })) : [];
  /** the windows or the cutouts of a zone, as its element carries them */
  const conNome = (v: unknown, comeSiChiama: string): Array<{ nome: string; punti: Punto[] }> => {
    const out: Array<{ nome: string; punti: Punto[] }> = [];
    for (const f of Array.isArray(v) ? (v as Array<Record<string, unknown> | null>) : []) {
      const p = punti(f?.points);
      if (p.length >= 3) out.push({ nome: typeof f?.nome === "string" && f.nome ? f.nome : `${comeSiChiama} ${out.length + 1}`, punti: p });
    }
    return out;
  };
  for (const el of els) {
    if (el?.type !== ZONA_FLESSIBILE) continue;
    const p = punti(el.points);
    if (p.length < 3) continue;
    const xs = p.map((q) => q.x);
    const ys = p.map((q) => q.y);
    const lati = fraStrati
      ? latiDellaZonaFraStrati(p, contorno, vuoti, tutte.filter((t) => t.el !== el && t.p.length >= 3).map((t) => t.p))
      : latiDellaZona(p, contorno);
    const ritagli = conNome(el.cutouts, "ritaglio");
    flex.zone.push({
      id: String(el.pcb_flex_zone_id ?? `zona_${flex.zone.length}`),
      nome: typeof el.nome === "string" && el.nome ? el.nome : `zona ${flex.zone.length + 1}`,
      punti: p,
      strati: Array.isArray(el.layers) ? (el.layers as unknown[]).filter((s): s is string => typeof s === "string") : [],
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minY: Math.min(...ys),
      maxY: Math.max(...ys),
      // the tail is cut along the outline of the board and around its cutouts
      bordi: [...lati.bordi, ...ritagli.flatMap((r) => latiDi(r.punti))],
      confini: lati.confini,
      finestre: conNome(el.windows, "finestra"),
      ritagli,
      retino: retinoDi(el.hatch),
      ...(fraStrati && typeof el.flex_layer === "string" ? { flessibile: el.flex_layer } : {}),
    });
  }
  if (flex.zone.length === 0) return null;
  // the stack first: the stretch of tail a bend curves depends on its thickness
  for (const el of els) {
    if (el?.type !== PILA_FLESSIBILE || flex.pila) continue;
    const spessore = num(el.thickness_mm);
    if (spessore === null || spessore <= 0) continue;
    const materiali: PilaFlessibile["materiali"] = [];
    for (const m of Array.isArray(el.materials) ? (el.materials as Array<Record<string, unknown> | null>) : []) {
      const mm = num(m?.mm);
      if (mm === null || typeof m?.tipo !== "string") continue;
      materiali.push({ tipo: m.tipo, ...(typeof m.nome === "string" ? { nome: m.nome } : {}), mm });
    }
    const flessibili: StratoFlessibile[] = [];
    for (const f of Array.isArray(el.flex_layers) ? (el.flex_layers as Array<Record<string, unknown> | null>) : []) {
      const sp = num(f?.thickness_mm);
      if (typeof f?.name !== "string" || sp === null || sp <= 0) continue;
      const suoi: PilaFlessibile["materiali"] = [];
      for (const m of Array.isArray(f.materials) ? (f.materials as Array<Record<string, unknown> | null>) : []) {
        const mm = num(m?.mm);
        if (mm === null || typeof m?.tipo !== "string") continue;
        suoi.push({ tipo: m.tipo, ...(typeof m.nome === "string" ? { nome: m.nome } : {}), mm });
      }
      flessibili.push({
        nome: f.name,
        strati: Array.isArray(f.copper_layers) ? (f.copper_layers as unknown[]).filter((x): x is string => typeof x === "string") : [],
        spessoreMm: sp,
        coverlay: String(f.coverlay ?? el.coverlay ?? ""),
        materiali: suoi,
      });
    }
    flex.pila = { spessoreMm: spessore, coverlay: String(el.coverlay ?? ""), materiali, ...(flessibili.length > 0 ? { flessibili } : {}) };
  }
  /** the zone an element names, when it names one that is on the board */
  const zonaNominata = (v: unknown): ZonaFlessibile | undefined => (typeof v === "string" ? flex.zone.find((z) => z.id === v) : undefined);
  for (const el of els) {
    if (el?.type === PIEGA) {
      const a = punto(el.from);
      const b = punto(el.to);
      const raggio = num(el.radius_mm);
      // a line with no length has no direction: there is no stretch of tail on its two sides
      if (!a || !b || raggio === null || Math.hypot(b.x - a.x, b.y - a.y) < 1e-9) continue;
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const angolo = num(el.angle_deg) ?? 90;
      // the zone it names, or the one its middle is in; the thickness of that zone's sheet
      const zona = zonaNominata(el.pcb_flex_zone_id) ?? flex.zone.find((z) => profondita(mx, my, z.punti) >= -SUL_BORDO_MM) ?? null;
      const mezza = mezzaFasciaDellaPiega(raggio, angolo, spessoreDellaZona(flex, zona) ?? 0);
      flex.pieghe.push({
        id: String(el.pcb_flex_bend_id ?? `piega_${flex.pieghe.length}`),
        nome: typeof el.nome === "string" && el.nome ? el.nome : `piega ${flex.pieghe.length + 1}`,
        a,
        b,
        raggioMm: raggio,
        angolo,
        verso: el.direction === "su" ? "su" : "giu",
        zona,
        mezzaFasciaMm: mezza,
        fascia: fasciaDi(a, b, mezza),
      });
    } else if (el?.type === IRRIGIDITORE) {
      const p = punti(el.points);
      if (p.length < 3 || (el.layer !== "top" && el.layer !== "bottom")) continue;
      const fori: Irrigiditore["fori"] = [];
      for (const f of Array.isArray(el.holes) ? (el.holes as Array<Record<string, unknown> | null>) : []) {
        const x = num(f?.x);
        const y = num(f?.y);
        const d = num(f?.diameter_mm);
        if (x !== null && y !== null && d !== null && d > 0) fori.push({ x, y, diametroMm: d });
      }
      flex.irrigiditori.push({
        id: String(el.pcb_flex_stiffener_id ?? `irrigiditore_${flex.irrigiditori.length}`),
        nome: typeof el.nome === "string" && el.nome ? el.nome : `irrigiditore ${flex.irrigiditori.length + 1}`,
        ...(zonaNominata(el.pcb_flex_zone_id) ? { zonaId: String(el.pcb_flex_zone_id) } : {}),
        lato: el.layer,
        punti: p,
        materiale: String(el.material ?? ""),
        spessoreMm: num(el.thickness_mm) ?? 0,
        fori,
      });
    } else if (el?.type === APERTURA_COVERLAY) {
      const p = punti(el.points);
      if (p.length < 3 || (el.layer !== "top" && el.layer !== "bottom")) continue;
      flex.aperture.push({
        id: String(el.pcb_flex_coverlay_opening_id ?? `apertura_${flex.aperture.length}`),
        nome: typeof el.nome === "string" && el.nome ? el.nome : `apertura ${flex.aperture.length + 1}`,
        ...(zonaNominata(el.pcb_flex_zone_id) ? { zonaId: String(el.pcb_flex_zone_id) } : {}),
        lato: el.layer,
        punti: p,
      });
    }
  }
  return flex;
}

/** the flexible zone a point is in, by more than `oltre` mm: undefined in the rigid part */
export function zonaDelPunto(flex: Flessibile, x: number, y: number, oltre = 0): ZonaFlessibile | undefined {
  for (const z of flex.zone) {
    if (x < z.minX || x > z.maxX || y < z.minY || y > z.maxY) continue;
    if (profondita(x, y, z.punti) > oltre) return z;
  }
  return undefined;
}

/** whether a polygon holds a set of points whole, each in it or on its edge within `slack` */
export function contieneTutti(poligono: Punto[], cosa: Punto[], slack = SUL_BORDO_MM): boolean {
  return cosa.every((p) => profondita(p.x, p.y, poligono) >= -slack);
}
