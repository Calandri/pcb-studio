import {
  DEFAULT_DESIGN_RULES,
  distanzaMinimaFra,
  type DesignRules,
  type TipoRame,
} from "./design-rules";
import type { PianiSuVie } from "./engine-version";
import { stessoStrato, stratoDelPad, stratoDelPunto } from "./pcb-route-model";
import { netOfViaKey, padsOffPlane, pourLayersByNet, readPours, tutteLeVia } from "./pours";

export interface DrcViolation {
  rule: string;
  message: string;
  /**
   * Where the problem is on the board (mm, board center = 0,0). Without this
   * a violation says WHAT is wrong but not WHERE: on aggregated ones the
   * points of all occurrences are kept.
   */
  points?: Array<{ x: number; y: number }>;
  /**
   * How many times the rule fired, when the occurrences are aggregated. The
   * points are capped per rule (a board with three thousand crooked exits does
   * not need three thousand dots), the count is not: whoever compares two
   * routes needs the true number.
   */
  count?: number;
}

interface El {
  type: string;
  [key: string]: unknown;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * A STADIUM: a segment with a radius around it. It is the exact shape of a pill
 * pad, of a slotted drill and — with a core of zero length — of a circle, and
 * the distance between two of them is the distance between their cores minus
 * the two radii. No corners to invent.
 */
export interface Capsula {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  r: number;
}

/** the copper of a pad, in the one of three shapes that measures it right */
export type FormaRame =
  | { tipo: "cerchio"; x: number; y: number; r: number }
  | { tipo: "rettangolo"; x: number; y: number; w: number; h: number; rot: number; punti?: Array<{ x: number; y: number }> }
  | { tipo: "capsula"; x: number; y: number; capsula: Capsula };

/** a w x h stadium centred on x,y, its core along the long side, turned by rotDeg */
export function capsulaDa(x: number, y: number, w: number, h: number, rotDeg = 0): Capsula {
  const r = Math.min(w, h) / 2;
  const mezzo = (Math.max(w, h) - Math.min(w, h)) / 2;
  const rad = (rotDeg * Math.PI) / 180;
  const ux = w >= h ? Math.cos(rad) : -Math.sin(rad);
  const uy = w >= h ? Math.sin(rad) : Math.cos(rad);
  return { ax: x - ux * mezzo, ay: y - uy * mezzo, bx: x + ux * mezzo, by: y + uy * mezzo, r };
}

/**
 * THE COPPER OF A THROUGH HOLE, read from the fields ITS shape declares.
 *
 * A plated hole comes in six shapes and each writes its size somewhere else:
 * the round one in `outer_diameter`, the oval and the pill in
 * `outer_width/outer_height`, the ones with a square pad in
 * `rect_pad_width/rect_pad_height`, the polygonal one in `pad_outline`. Reading
 * `outer_diameter ?? hole_diameter` for all of them measured a square pad as the
 * drill inside it, and skipped the pills altogether — the shell tabs of a USB-C
 * receptacle, the copper most likely to touch something, were invisible.
 */
export function rameDelForo(el: El): FormaRame | null {
  const x = num(el.x);
  const y = num(el.y);
  if (x === null || y === null) return null;
  const shape = String(el.shape ?? "");
  if (shape === "circle") {
    const d = num(el.outer_diameter) ?? num(el.hole_diameter);
    if (d !== null && d > 0) return { tipo: "cerchio", x, y, r: d / 2 };
  }
  if (shape === "oval" || shape === "pill") {
    const w = num(el.outer_width);
    const h = num(el.outer_height);
    // an oval sits inside the stadium of the same size: measured as one, it can
    // only be reported a hair closer than it is, never farther
    if (w !== null && h !== null && w > 0 && h > 0) {
      return { tipo: "capsula", x, y, capsula: capsulaDa(x, y, w, h, num(el.ccw_rotation) ?? 0) };
    }
  }
  if (
    shape === "circular_hole_with_rect_pad" ||
    shape === "pill_hole_with_rect_pad" ||
    shape === "rotated_pill_hole_with_rect_pad"
  ) {
    const w = num(el.rect_pad_width);
    const h = num(el.rect_pad_height);
    if (w !== null && h !== null && w > 0 && h > 0) {
      return { tipo: "rettangolo", x, y, w, h, rot: num(el.rect_ccw_rotation) ?? 0 };
    }
  }
  if (shape === "hole_with_polygon_pad" && Array.isArray(el.pad_outline)) {
    // the outline is relative to the hole's position, as the Gerber draws it
    const xs: number[] = [];
    const ys: number[] = [];
    for (const p of el.pad_outline as Array<{ x?: unknown; y?: unknown }>) {
      const px = num(p?.x);
      const py = num(p?.y);
      if (px === null || py === null) continue;
      xs.push(x + px);
      ys.push(y + py);
    }
    if (xs.length >= 3) {
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      return {
        tipo: "rettangolo",
        x: (minX + maxX) / 2,
        y: (minY + maxY) / 2,
        w: maxX - minX,
        h: maxY - minY,
        rot: 0,
      };
    }
  }
  // a shape this code does not know: whatever size the element declares
  const d = num(el.outer_diameter);
  if (d !== null && d > 0) return { tipo: "cerchio", x, y, r: d / 2 };
  const w = num(el.outer_width) ?? num(el.rect_pad_width);
  const h = num(el.outer_height) ?? num(el.rect_pad_height);
  if (w !== null && h !== null && w > 0 && h > 0) {
    return { tipo: "rettangolo", x, y, w, h, rot: num(el.ccw_rotation) ?? 0 };
  }
  const foro = num(el.hole_diameter);
  return foro !== null && foro > 0 ? { tipo: "cerchio", x, y, r: foro / 2 } : null;
}

/**
 * The DRILL of a plated or bare hole, as a stadium: round holes are stadiums
 * with no core, slots have one. The offset is the one the pad shapes declare
 * (a square pad does not have to be centred on its hole).
 *
 * Approximations, said here once: a square or rectangular drill is measured as
 * the stadium of the same size, which is a hair lenient at its corners.
 */
export function foroDi(el: El): Capsula | null {
  const x = num(el.x);
  const y = num(el.y);
  if (x === null || y === null) return null;
  const cx = x + (num(el.hole_offset_x) ?? 0);
  const cy = y + (num(el.hole_offset_y) ?? 0);
  const shape = String(el.shape ?? "");
  const holeShape = String(el.hole_shape ?? "");
  const d = num(el.hole_diameter);
  const w = num(el.hole_width);
  const h = num(el.hole_height);
  let rot = 0;
  if (el.type === "pcb_plated_hole") {
    if (shape === "oval" || shape === "pill") rot = num(el.ccw_rotation) ?? 0;
    else if (shape === "rotated_pill_hole_with_rect_pad") rot = num(el.hole_ccw_rotation) ?? 0;
  } else {
    rot = num(el.ccw_rotation) ?? 0;
  }
  const tondo = holeShape === "circle" || holeShape === "square" || shape === "circle";
  if (!tondo && w !== null && h !== null && w > 0 && h > 0) return capsulaDa(cx, cy, w, h, rot);
  if (d !== null && d > 0) return { ax: cx, ay: cy, bx: cx, by: cy, r: d / 2 };
  if (w !== null && h !== null && w > 0 && h > 0) return capsulaDa(cx, cy, w, h, rot);
  return null;
}

/** how far a point is from a copper shape: 0 inside */
export function distanzaPuntoForma(f: FormaRame, px: number, py: number): number {
  if (f.tipo === "cerchio") return Math.max(0, Math.hypot(px - f.x, py - f.y) - f.r);
  if (f.tipo === "capsula") {
    const c = f.capsula;
    return Math.max(0, pointSegDistance(px, py, c.ax, c.ay, c.bx, c.by) - c.r);
  }
  // into the rectangle's own frame, where it is straight
  const rad = (-(f.rot ?? 0) * Math.PI) / 180;
  const dx = px - f.x;
  const dy = py - f.y;
  const lx = dx * Math.cos(rad) - dy * Math.sin(rad);
  const ly = dx * Math.sin(rad) + dy * Math.cos(rad);
  return Math.hypot(Math.max(Math.abs(lx) - f.w / 2, 0), Math.max(Math.abs(ly) - f.h / 2, 0));
}

/** how far a segment is from a copper shape: 0 when it touches or enters it */
export function distanzaSegmentoForma(
  f: FormaRame,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  if (f.tipo === "cerchio") return Math.max(0, pointSegDistance(f.x, f.y, ax, ay, bx, by) - f.r);
  if (f.tipo === "capsula") {
    const c = f.capsula;
    return Math.max(0, segSegDistanceRaw(ax, ay, bx, by, c.ax, c.ay, c.bx, c.by) - c.r);
  }
  return segToBoxDistance(
    { ax, ay, bx, by },
    {
      minX: f.x - f.w / 2,
      maxX: f.x + f.w / 2,
      minY: f.y - f.h / 2,
      maxY: f.y + f.h / 2,
      rot: f.rot || undefined,
      layer: null,
      label: "",
      group: null,
      kind: "pad",
    },
  );
}

/** the straight box that contains a shape, turned or not */
export function ingombroForma(f: FormaRame): { minX: number; maxX: number; minY: number; maxY: number } {
  if (f.tipo === "cerchio") return { minX: f.x - f.r, maxX: f.x + f.r, minY: f.y - f.r, maxY: f.y + f.r };
  if (f.tipo === "capsula") {
    const c = f.capsula;
    return {
      minX: Math.min(c.ax, c.bx) - c.r,
      maxX: Math.max(c.ax, c.bx) + c.r,
      minY: Math.min(c.ay, c.by) - c.r,
      maxY: Math.max(c.ay, c.by) + c.r,
    };
  }
  const rad = ((f.rot ?? 0) * Math.PI) / 180;
  const hw = (Math.abs(f.w * Math.cos(rad)) + Math.abs(f.h * Math.sin(rad))) / 2;
  const hh = (Math.abs(f.w * Math.sin(rad)) + Math.abs(f.h * Math.cos(rad))) / 2;
  return { minX: f.x - hw, maxX: f.x + hw, minY: f.y - hh, maxY: f.y + hh };
}

/**
 * The copper of an SMT pad. Pills are stadiums, not rectangles: measured by
 * their corners they come out closer than they are to whatever sits diagonally.
 * Polygon pads are measured by the box of their vertices, as everywhere else.
 */
export function rameDelPad(el: El): FormaRame | null {
  const shape = String(el.shape ?? "");
  const centro = centroDaVertici(el as { points?: unknown });
  const x = num(el.x) ?? centro?.x ?? null;
  const y = num(el.y) ?? centro?.y ?? null;
  if (x === null || y === null) return null;
  const rot = num(el.ccw_rotation) ?? 0;
  if (shape === "circle" && num(el.radius) !== null) return { tipo: "cerchio", x, y, r: num(el.radius)! };
  const w = num(el.width);
  const h = num(el.height);
  if ((shape === "pill" || shape === "rotated_pill") && w !== null && h !== null && w > 0 && h > 0) {
    return { tipo: "capsula", x, y, capsula: capsulaDa(x, y, w, h, rot) };
  }
  if (w !== null && h !== null) return { tipo: "rettangolo", x, y, w, h, rot };
  const punti = (el.points as Array<{ x?: unknown; y?: unknown }> | undefined) ?? [];
  const xs = punti.map((p) => num(p?.x)).filter((v): v is number => v !== null);
  const ys = punti.map((p) => num(p?.y)).filter((v): v is number => v !== null);
  if (xs.length > 0 && ys.length > 0) {
    const vertici = punti
      .map((p) => ({ x: num(p?.x), y: num(p?.y) }))
      .filter((p): p is { x: number; y: number } => p.x !== null && p.y !== null);
    return {
      tipo: "rettangolo",
      x,
      y,
      w: Math.max(...xs) - Math.min(...xs),
      h: Math.max(...ys) - Math.min(...ys),
      rot: 0,
      ...(vertici.length >= 3 ? { punti: vertici } : {}),
    };
  }
  const r = num(el.radius);
  return r !== null ? { tipo: "cerchio", x, y, r } : null;
}

/**
 * The center of a pad that does not declare one.
 *
 * Some footprints describe pads as POLYGONS — a list of vertices — and those
 * carry neither x nor y. Everything that reads coordinates skips them: the
 * clearance check, the placement, the autorouter. They are pads you can see
 * on the drawing but that do not exist for the tools, and that is how the
 * four ground pads of a microphone used to disappear without anyone saying
 * so. The center is derived from the vertices: it is an honest
 * approximation, and worth far more than a hole in the data.
 */
function centroDaVertici(el: { points?: unknown }): { x: number; y: number } | null {
  const punti = el.points as Array<{ x?: unknown; y?: unknown }> | undefined;
  if (!Array.isArray(punti) || punti.length === 0) return null;
  const xs = punti.map((p) => (typeof p.x === "number" ? p.x : NaN)).filter(Number.isFinite);
  const ys = punti.map((p) => (typeof p.y === "number" ? p.y : NaN)).filter(Number.isFinite);
  if (xs.length === 0 || ys.length === 0) return null;
  return {
    x: (Math.min(...xs) + Math.max(...xs)) / 2,
    y: (Math.min(...ys) + Math.max(...ys)) / 2,
  };
}

interface Box {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  layer: string | null;
  label: string;
  group: string | null;
  /** degrees the rectangle is turned by, for pads the CAD placed at an angle */
  rot?: number;
  /** what it is, for the pair the clearance rule talks about */
  kind: TipoRame;
  /**
   * Set when the thing is ROUND: a via, a hole, a circular pad. Measured as the
   * square that contains it, a 0.5mm via grows 0.1mm of corner in every
   * diagonal direction and the check reports a clearance the board does not
   * violate — 56 of this board's 67 trace-to-copper reports were that corner.
   */
  raggio?: number;
  /** set when the thing is a STADIUM (pill pads, slots): measured from its core */
  capsula?: Capsula;
  /** the drill, when the thing has one: only this one decides hole to hole */
  foro?: Capsula;
  /** set for a POLYGONAL pad: its real outline (the box is only its extent) */
  poligono?: Array<{ x: number; y: number }>;
}

/** a copper shape as a box the checks can measure */
function boxDaForma(
  f: FormaRame,
  resto: Pick<Box, "layer" | "label" | "group" | "kind">,
): Box {
  if (f.tipo === "cerchio") {
    return { ...resto, minX: f.x - f.r, maxX: f.x + f.r, minY: f.y - f.r, maxY: f.y + f.r, raggio: f.r };
  }
  if (f.tipo === "capsula") return { ...resto, ...ingombroForma(f), capsula: f.capsula };
  return {
    ...resto,
    minX: f.x - f.w / 2,
    maxX: f.x + f.w / 2,
    minY: f.y - f.h / 2,
    maxY: f.y + f.h / 2,
    ...(f.rot ? { rot: f.rot } : {}),
    ...(f.punti ? { poligono: f.punti } : {}),
  };
}

/** the radius of the circle around a box: what it can reach at most, turned or not */
function raggioEsterno(b: Box): number {
  if (b.raggio !== undefined) return b.raggio;
  if (b.capsula) {
    const c = b.capsula;
    return Math.hypot(c.bx - c.ax, c.by - c.ay) / 2 + c.r;
  }
  return Math.hypot(b.maxX - b.minX, b.maxY - b.minY) / 2;
}

/*
 * A MICRON OF SLACK on every dimensional comparison.
 *
 * Coordinates and widths arrive rounded to the micron — a 6 mil trace is
 * 0.1524mm and three decimals make it 0.152 — so comparing them to the
 * nanometre reports violations of rules the board respects: 500 on trace width
 * and 81 on clearance, on a board whose own file says it is fine. A micron is
 * ten times finer than the best fab process, and below it a difference is
 * arithmetic, not copper.
 */
export const TOLLERANZA_MM = 0.001;

/*
 * AND A HUNDREDTH for a poured plane. The solver cuts the circle around a via
 * as a polygon, and the plane's own vias and pads are united to it a hair
 * larger than they are (see abbracciaRamePropio): measured on sbb-dl-principale,
 * the openings of a plane poured at 0.152 mm come out between 0.1476 and 0.1501
 * from the via. A plane that closes over a hole is not a matter of hundredths.
 */
const TOLLERANZA_COLATA_MM = 0.01;

/*
 * HOW FAR FROM THE PAD THE PLANE IS MEASURED, when no rule asks for more. The
 * distance is exact up to here and "far" beyond, so one measure serves every
 * ruleset whose minimum is smaller (see MisureDrc).
 */
const PORTATA_PIANI_MM = 0.5;

/** one via next to the plane of another net: what check 8 measures */
export interface ViaVicinaAUnPiano {
  via: string;
  x: number;
  y: number;
  /** the net of the plane, by name */
  rete: string;
  layer: string;
  /** from the via's pad to the copper of the plane: 0 when they touch or overlap */
  distanzaMm: number;
  /** the clearance the plane declares for itself, when it does (PourShape.clearanceMm) */
  propriaMm?: number;
  /**
   * For such a plane only: from the via's pad to the nearest via or pad of the
   * plane's own net on that layer, the copper the plane holds whole (see
   * abbracciaRamePropio). When that is as near as the plane, the plane's edge
   * there is a via or a pad, which the pair rules judge, not the pour.
   */
  rameProprioMm?: number;
}

/**
 * WHAT A DRC RUN MEASURED THAT DOES NOT DEPEND ON THE RULES.
 *
 * The summary runs the DRC once for the project's rules and once more for each
 * fab class, on the same board: three or four runs on every compile, fast
 * update, trace edit and recheck. The distance from each via to each plane is
 * the same in all of them, only the minimum it is compared with changes. Hand
 * the same object to every run on one board and it is measured in the first
 * and read in the others. Never keep it across two boards.
 */
export interface MisureDrc {
  viaPiani?: { portataMm: number; righe: ViaVicinaAUnPiano[] };
}

/**
 * A POUR READY TO BE ASKED HOW FAR ITS COPPER IS FROM A CIRCLE.
 *
 * The first version of the plane check walked every edge of the pour for every
 * via near it, twice: once to know whether the via is in the copper, once for
 * the distance. Measured by the reviewer of that change (2026-11-11) on a board
 * of 700 vias, 16 pours and 20 000 vertices: a DRC run went from 47 to 700 ms.
 *
 * The edges go into a grid of cells about as wide as the edges are apart, each
 * edge in the cells its box overlaps. The distance asks only the cells the
 * circle and its reach touch; "in the copper" casts its ray along one row of
 * cells and meets only the edges of that row. On each edge the predicate and
 * the arithmetic are the ones of before (dentroPoligono, pointSegDistance), so
 * the answer is the same number, not a close one.
 */
interface IndiceDiColata {
  /** the box of the outer ring: outside it nothing is in the copper */
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  /** the grid, over the box of every ring */
  x0: number;
  y0: number;
  passo: number;
  colonne: number;
  righe: number;
  /** edge k goes from (px, py), the vertex before, to (qx, qy) */
  px: Float64Array;
  py: Float64Array;
  qx: Float64Array;
  qy: Float64Array;
  /** the ring edge k belongs to: 0 the outer one, then the holes */
  anello: Int32Array;
  /** cell c holds the edges inCella[inizio[c]] .. inCella[inizio[c + 1] - 1] */
  inizio: Int32Array;
  inCella: Int32Array;
  /** scratch of the ray: the last ray that met each edge, the parity of each ring */
  visto: Int32Array;
  giro: number;
  dispari: Uint8Array;
}

function indiceDiColata(esterno: Array<{ x: number; y: number }>, buchi: Array<Array<{ x: number; y: number }>>): IndiceDiColata {
  const anelli = [esterno, ...buchi];
  let n = 0;
  for (const a of anelli) n += a.length;
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  const qx = new Float64Array(n);
  const qy = new Float64Array(n);
  const anello = new Int32Array(n);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let k = 0;
  anelli.forEach((punti, a) => {
    for (let i = 0, j = punti.length - 1; i < punti.length; j = i++) {
      const p = punti[j];
      const q = punti[i];
      px[k] = p.x;
      py[k] = p.y;
      qx[k] = q.x;
      qy[k] = q.y;
      anello[k] = a;
      k++;
      if (q.x < x0) x0 = q.x;
      if (q.x > x1) x1 = q.x;
      if (q.y < y0) y0 = q.y;
      if (q.y > y1) y1 = q.y;
      if (a === 0) {
        if (q.x < minX) minX = q.x;
        if (q.x > maxX) maxX = q.x;
        if (q.y < minY) minY = q.y;
        if (q.y > maxY) maxY = q.y;
      }
    }
  });
  /*
   * As many cells as edges, more or less: never finer than a quarter of a
   * millimetre, never coarser than five to start with. An edge is filed in every
   * cell its box overlaps, so a long slanted one fills a square of them: when
   * the edges end up filed more than a few times each the grid is made coarser,
   * down to a single cell if it has to be. The grid only decides how many edges
   * a question looks at, never the answer.
   */
  let passo = Math.min(5, Math.max(0.25, Math.sqrt(((x1 - x0) * (y1 - y0)) / Math.max(1, n))));
  let colonne = 1;
  let righe = 1;
  const celle = new Int32Array(4 * n);
  for (;;) {
    colonne = Math.max(1, Math.ceil((x1 - x0) / passo));
    righe = Math.max(1, Math.ceil((y1 - y0) / passo));
    let posti = 0;
    for (let e = 0; e < n; e++) {
      const c0 = (celle[4 * e] = cellaDi(Math.min(px[e], qx[e]), x0, passo, colonne));
      const c1 = (celle[4 * e + 1] = cellaDi(Math.max(px[e], qx[e]), x0, passo, colonne));
      const r0 = (celle[4 * e + 2] = cellaDi(Math.min(py[e], qy[e]), y0, passo, righe));
      const r1 = (celle[4 * e + 3] = cellaDi(Math.max(py[e], qy[e]), y0, passo, righe));
      posti += (c1 - c0 + 1) * (r1 - r0 + 1);
    }
    if (posti <= 8 * n + 64 || colonne * righe === 1) break;
    passo *= 2;
  }
  // how many edges each cell holds, then the edges themselves
  const inizio = new Int32Array(colonne * righe + 1);
  for (let e = 0; e < n; e++) {
    for (let r = celle[4 * e + 2]; r <= celle[4 * e + 3]; r++) {
      for (let c = celle[4 * e]; c <= celle[4 * e + 1]; c++) inizio[r * colonne + c + 1]++;
    }
  }
  for (let c = 0; c < colonne * righe; c++) inizio[c + 1] += inizio[c];
  const inCella = new Int32Array(inizio[colonne * righe]);
  const cursore = inizio.slice(0, colonne * righe);
  for (let e = 0; e < n; e++) {
    for (let r = celle[4 * e + 2]; r <= celle[4 * e + 3]; r++) {
      for (let c = celle[4 * e]; c <= celle[4 * e + 1]; c++) inCella[cursore[r * colonne + c]++] = e;
    }
  }
  return {
    minX, maxX, minY, maxY, x0, y0, passo, colonne, righe, px, py, qx, qy, anello, inizio, inCella,
    visto: new Int32Array(n),
    giro: 0,
    dispari: new Uint8Array(anelli.length),
  };
}

/** the column (or the row) of the grid a coordinate falls in: the ones outside go to the first or the last */
const cellaDi = (v: number, origine: number, passo: number, quante: number): number =>
  Math.min(quante - 1, Math.max(0, Math.floor((v - origine) / passo)));
const colonnaDi = (ix: IndiceDiColata, x: number): number => cellaDi(x, ix.x0, ix.passo, ix.colonne);
const rigaDi = (ix: IndiceDiColata, y: number): number => cellaDi(y, ix.y0, ix.passo, ix.righe);

/** inside the outer ring and inside no hole: the ray goes right, along the row of cells the point is in */
function nelRameDellaColata(ix: IndiceDiColata, x: number, y: number): boolean {
  if (x < ix.minX || x > ix.maxX || y < ix.minY || y > ix.maxY) return false;
  const riga = rigaDi(ix, y) * ix.colonne;
  const giro = ++ix.giro;
  let esterno = false;
  let buchiDispari = 0;
  for (let c = colonnaDi(ix, x); c < ix.colonne; c++) {
    for (let t = ix.inizio[riga + c]; t < ix.inizio[riga + c + 1]; t++) {
      const k = ix.inCella[t];
      // an edge lies in every cell it crosses: it counts once per ray
      if (ix.visto[k] === giro) continue;
      ix.visto[k] = giro;
      // as dentroPoligono reads it: a is the vertex, b the one before it
      const ay = ix.qy[k];
      const by = ix.py[k];
      if (ay > y === by > y) continue;
      const ax = ix.qx[k];
      if (!(x < ((ix.px[k] - ax) * (y - ay)) / (by - ay) + ax)) continue;
      const a = ix.anello[k];
      if (a === 0) esterno = !esterno;
      else buchiDispari += (ix.dispari[a] ^= 1) ? 1 : -1;
    }
  }
  if (buchiDispari !== 0) ix.dispari.fill(0);
  return esterno && buchiDispari === 0;
}

/**
 * How far a circle is from the copper of a pour: 0 when its centre is in the
 * copper or the copper reaches into it, Infinity when the pour is farther than
 * `portata` from the centre (nobody asks how much farther).
 */
function distanzaCerchioColata(ix: IndiceDiColata, x: number, y: number, raggio: number, portata: number): number {
  if (x < ix.minX - portata || x > ix.maxX + portata || y < ix.minY - portata || y > ix.maxY + portata) return Infinity;
  if (nelRameDellaColata(ix, x, y)) return 0;
  let d = Infinity;
  const c0 = colonnaDi(ix, x - portata);
  const c1 = colonnaDi(ix, x + portata);
  const r1 = rigaDi(ix, y + portata);
  for (let r = rigaDi(ix, y - portata); r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const cella = r * ix.colonne + c;
      for (let t = ix.inizio[cella]; t < ix.inizio[cella + 1]; t++) {
        const k = ix.inCella[t];
        d = Math.min(d, pointSegDistance(x, y, ix.px[k], ix.py[k], ix.qx[k], ix.qy[k]));
      }
    }
  }
  return Math.max(0, d - raggio);
}

/** the centre of a box, without needing the whole helper */
const centroDi = (r: Box) => ({ x: (r.minX + r.maxX) / 2, y: (r.minY + r.maxY) / 2 });

/** how far a point is from a rectangle that may be turned */
function distanzaPuntoRettangolo(px: number, py: number, r: Box): number {
  const punti = angoliDi(r);
  let dentro = false;
  for (let i = 0, j = punti.length - 1; i < punti.length; j = i++) {
    const a = punti[i];
    const b = punti[j];
    if (a.y > py !== b.y > py && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x) {
      dentro = !dentro;
    }
  }
  if (dentro) return 0;
  let best = Infinity;
  for (let i = 0; i < punti.length; i++) {
    const a = punti[i];
    const b = punti[(i + 1) % punti.length];
    best = Math.min(best, pointSegDistance(px, py, a.x, a.y, b.x, b.y));
  }
  return best;
}

function boxDistance(a: Box, b: Box): number {
  if (a.poligono || b.poligono) return distanzaConPoligono(a, b);
  // a stadium against anything: measured from its core
  if (a.capsula || b.capsula) {
    const tondo = a.capsula ? a : b;
    const altro = a.capsula ? b : a;
    const c = tondo.capsula!;
    if (altro.capsula) {
      const o = altro.capsula;
      return Math.max(
        0,
        segSegDistanceRaw(c.ax, c.ay, c.bx, c.by, o.ax, o.ay, o.bx, o.by) - c.r - o.r,
      );
    }
    if (altro.raggio !== undefined) {
      const p = centroDi(altro);
      return Math.max(0, pointSegDistance(p.x, p.y, c.ax, c.ay, c.bx, c.by) - c.r - altro.raggio);
    }
    return Math.max(0, segToBoxDistance(c, altro) - c.r);
  }
  // round against round, and round against everything else
  if (a.raggio !== undefined && b.raggio !== undefined) {
    const ca = centroDi(a);
    const cb = centroDi(b);
    return Math.max(0, Math.hypot(ca.x - cb.x, ca.y - cb.y) - a.raggio - b.raggio);
  }
  if (a.raggio !== undefined || b.raggio !== undefined) {
    const tondo = a.raggio !== undefined ? a : b;
    const altro = a.raggio !== undefined ? b : a;
    const c = centroDi(tondo);
    return Math.max(0, distanzaPuntoRettangolo(c.x, c.y, altro) - (tondo.raggio ?? 0));
  }
  if (a.rot || b.rot) return distanzaFraRettangoli(a, b);
  const dx = Math.max(a.minX - b.maxX, b.minX - a.maxX, 0);
  const dy = Math.max(a.minY - b.maxY, b.minY - a.maxY, 0);
  return Math.hypot(dx, dy);
}

/**
 * The gap between two rectangles when one of them is TURNED.
 *
 * A pad at 45 degrees measured as if it were straight is a pad measured wrong:
 * on an imported board two capacitor pads 0.24mm apart came out at 0.022mm and
 * the check called it a short. Sixty-seven times.
 *
 * The gap is the largest separation found along the four edge directions of the
 * two rectangles — the separating axis theorem. For rectangles it is the real
 * distance whenever a face is what faces the other one, and never more than the
 * real distance otherwise, so the check can only stay cautious, never miss.
 */
/**
 * Which rule the number comes from, said out loud when it is not the general
 * one: a check that reports "less than 0.0254mm" against a board whose stated
 * minimum is 0.1524 looks like a bug in the checker, and whoever reads it
 * deserves to know that the board itself asked for that.
 */
function quale(rules: DesignRules, minimo: number, a: TipoRame, b: TipoRame): string {
  return minimo === rules.minClearanceMm ? "" : ` (regola ${a}-${b} del progetto)`;
}

/** the four corners of a box, turned by its own angle */
function angoliDi(r: Box): Array<{ x: number; y: number }> {
  const cx = (r.minX + r.maxX) / 2;
  const cy = (r.minY + r.maxY) / 2;
  const hw = (r.maxX - r.minX) / 2;
  const hh = (r.maxY - r.minY) / 2;
  const rad = ((r.rot ?? 0) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ].map(([dx, dy]) => ({ x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos }));
}

/*
 * A POLYGONAL PAD IS MEASURED ON ITS OUTLINE. Some footprints draw pads as
 * polygons: the corner pins of an X2SON with their chamfer, its thermal pad
 * as a square turned by 45 degrees. Taken as their straight extent, the
 * thermal pad of the SBB dongle's LDO grew into the four pins around it and
 * the check counted four pairs too close that the copper does not have.
 * Everything is reduced to points plus a radius (a circle is its center, a
 * stadium its core, a rectangle its four corners) and measured edge to edge.
 */
function sagomaDi(b: Box): { punti: Array<{ x: number; y: number }>; r: number } {
  if (b.poligono) return { punti: b.poligono, r: 0 };
  if (b.capsula) return { punti: [{ x: b.capsula.ax, y: b.capsula.ay }, { x: b.capsula.bx, y: b.capsula.by }], r: b.capsula.r };
  if (b.raggio !== undefined) return { punti: [centroDi(b)], r: b.raggio };
  return { punti: angoliDi(b), r: 0 };
}

function distanzaConPoligono(a: Box, b: Box): number {
  const A = sagomaDi(a);
  const B = sagomaDi(b);
  const dentro = (p: { x: number; y: number }, P: Array<{ x: number; y: number }>) => P.length >= 3 && dentroPoligono(p.x, p.y, P);
  if (A.punti.some((p) => dentro(p, B.punti)) || B.punti.some((p) => dentro(p, A.punti))) return 0;
  const lati = (P: Array<{ x: number; y: number }>) =>
    P.length === 1 ? [[P[0], P[0]]] : P.length === 2 ? [[P[0], P[1]]] : P.map((p, i) => [p, P[(i + 1) % P.length]]);
  let minimo = Infinity;
  for (const [p, q] of lati(A.punti)) {
    for (const [u, v] of lati(B.punti)) {
      minimo = Math.min(minimo, segSegDistanceRaw(p.x, p.y, q.x, q.y, u.x, u.y, v.x, v.y));
    }
  }
  return Math.max(0, minimo - A.r - B.r);
}

function distanzaFraRettangoli(a: Box, b: Box): number {
  const A = angoliDi(a);
  const B = angoliDi(b);
  const assi = [a, b].flatMap((r) => {
    const rad = ((r.rot ?? 0) * Math.PI) / 180;
    return [
      { x: Math.cos(rad), y: Math.sin(rad) },
      { x: -Math.sin(rad), y: Math.cos(rad) },
    ];
  });
  let massimo = 0;
  for (const asse of assi) {
    const pa = A.map((p) => p.x * asse.x + p.y * asse.y);
    const pb = B.map((p) => p.x * asse.x + p.y * asse.y);
    const gap = Math.max(Math.min(...pb) - Math.max(...pa), Math.min(...pa) - Math.max(...pb));
    if (gap > massimo) massimo = gap;
  }
  return massimo;
}

/**
 * Deterministic DRC on Circuit JSON: trace widths, via sizes, board-edge
 * clearance, pad-pad / trace-pad / trace-trace clearances between different
 * nets, straight pin escapes. Trace clearances measure the true
 * segment-to-segment distance minus the half-widths (never again delegated
 * to the autorouter's correctness alone).
 */
export function runDrcChecks(
  circuitJson: El[],
  rules: DesignRules = DEFAULT_DESIGN_RULES,
  /** what an earlier run on this same board measured, and where this one leaves its own: see MisureDrc */
  misure?: MisureDrc,
  opzioni: {
    /**
     * Whether a pour that declares its own clearance is judged against it
     * (check 8). It is the designer's intent for that pour, like the project's
     * pourClearanceMm, and like it not a fab's: the runs that ask whether a fab
     * class can make the board pass false.
     */
    distanzeProprieDelleColate?: boolean;
  } = {},
): DrcViolation[] {
  const raw: DrcViolation[] = [];
  /*
   * THE CAP IS PER RULE, the count is not capped at all. A single cap for the
   * whole check used to stop listing at 500: a board with five hundred crooked
   * exits filled it before the plane checks ran, and the missing ground
   * stitching — which is at the end — simply was not reported.
   */
  const perRegola = new Map<string, number>();
  const push = (
    rule: string,
    message: string,
    point?: { x: number; y: number } | null,
  ) => {
    const n = (perRegola.get(rule) ?? 0) + 1;
    perRegola.set(rule, n);
    if (n <= MAX_PER_REGOLA) {
      raw.push({ rule, message, points: point ? [point] : undefined });
    }
  };

  // --- port -> connectivity group map (to know whether two pads are on the same net)
  const portGroup = new Map<string, string>();
  const groupOfSourceTrace = new Map<string, string>();
  /** net id -> its group, for keys that name the net instead of the group */
  const gruppoDiRete = new Map<string, string>();
  for (const el of circuitJson) {
    if (el.type !== "source_trace") continue;
    const key = String(el.subcircuit_connectivity_map_key ?? el.source_trace_id ?? "");
    if (el.source_trace_id) groupOfSourceTrace.set(String(el.source_trace_id), key);
    for (const pid of (el.connected_source_port_ids as string[] | undefined) ?? []) {
      portGroup.set(pid, key);
    }
    for (const net of (el.connected_source_net_ids as string[] | undefined) ?? []) {
      if (key && !gruppoDiRete.has(String(net))) gruppoDiRete.set(String(net), key);
    }
  }
  const gruppiNoti = new Set(groupOfSourceTrace.values());
  /*
   * A connectivity key, brought back to the group the pads are measured by.
   *
   * Copper we lay ourselves speaks other dialects: the tie stub to the plane
   * carries the pad's source port, the stitching vias say `net:<id>`, the
   * router's ground tree says `source_net_0_mst3`. Read raw, each of them was a
   * net of its own — a tie stub was skipped by every trace check, a ground via
   * looked like a stranger to the ground pad next to it.
   */
  const risolviChiave = (chiave: string): string | null => {
    if (!chiave) return null;
    if (gruppiNoti.has(chiave)) return chiave;
    const diPorta = portGroup.get(chiave);
    if (diPorta) return diPorta;
    const rete = chiave.startsWith("net:")
      ? chiave.slice(4)
      : (/^(source_net_\d+)_mst/.exec(chiave)?.[1] ?? null);
    if (rete) {
      const g = gruppoDiRete.get(rete);
      if (g) return g;
    }
    return chiave;
  };
  const pcbPortToSource = new Map<string, string>();
  for (const el of circuitJson) {
    if (el.type === "pcb_port" && el.pcb_port_id && el.source_port_id) {
      pcbPortToSource.set(String(el.pcb_port_id), String(el.source_port_id));
    }
  }
  const groupOfPcbPort = (pcbPortId: unknown): string | null => {
    const sp = pcbPortToSource.get(String(pcbPortId ?? ""));
    return sp ? (portGroup.get(sp) ?? null) : null;
  };

  /*
   * Copper with no source trace — the tie stubs that drop a pad onto its plane
   * (pcb_trace_plane_*) — is named by its key, and failing that by the pad it
   * starts from. Before, a trace without `source_trace_id` was skipped by every
   * clearance check: the stub could cross another net's pad and nobody said so.
   */
  let gruppoDelPadSotto: (x: number, y: number, strato: string | null) => string | null = () => null;
  const groupOfTrace = (el: El): string | null => {
    const st = String(el.source_trace_id ?? "");
    if (st) return groupOfSourceTrace.get(st) || risolviChiave(String(el.subcircuit_connectivity_map_key ?? ""));
    const daChiave = risolviChiave(String(el.subcircuit_connectivity_map_key ?? ""));
    if (daChiave) return daChiave;
    const route = ((el.route as Array<Record<string, unknown>> | undefined) ?? []).filter(
      (p) => num(p.x) !== null && num(p.y) !== null,
    );
    // the pad under an end on the end's own layer: the one over it on the other face is another net
    for (const [p, vicino] of [
      [route[0], route[1]],
      [route[route.length - 1], route[route.length - 2]],
    ]) {
      if (!p) continue;
      const g = gruppoDelPadSotto(num(p.x)!, num(p.y)!, stratoDelPunto(p, vicino));
      if (g) return g;
    }
    return null;
  };
  /*
   * A via's net deduced from the trace that contains it. Needed because vias
   * produced by the local router carry no `pcb_port_id`: without this, a via
   * placed on the pad it is meant to connect (via-in-pad, by construction on
   * the same net) came out at distance 0 from a pad "of unknown net" and was
   * flagged as a clearance violation. They were false positives that hid the
   * real ones.
   */
  const VIA_ON_TRACE_MM = 0.05;
  const viaGroup = new Map<string, string>();
  for (const el of circuitJson) {
    if (el.type !== "pcb_trace") continue;
    const group = groupOfTrace(el);
    if (!group) continue;
    for (const p of (el.route as Array<Record<string, unknown>> | undefined) ?? []) {
      const x = num(p.x);
      const y = num(p.y);
      if (x === null || y === null) continue;
      viaGroup.set(`${x.toFixed(3)},${y.toFixed(3)}`, group);
    }
  }
  const groupOfVia = (el: El): string | null => {
    const own = groupOfPcbPort(el.pcb_port_id);
    if (own) return own;
    /*
     * The key the element carries, which the imported vias now have: it is the
     * same key the traces group by. Looking only for the route point under the
     * hole left 25 of this board's 26 via-to-pad pairs unnamed, and a via
     * sitting in its own pad — which is what via-in-pad is — was reported as a
     * clearance violation. Twenty-five false alarms hiding the one real one.
     */
    const chiave = risolviChiave(String(el.subcircuit_connectivity_map_key ?? ""));
    if (chiave) return chiave;
    const x = num(el.x);
    const y = num(el.y);
    if (x === null || y === null) return null;
    // the via lands on a route point: a tiny numerical tolerance is accepted
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const key = `${(x + dx * VIA_ON_TRACE_MM).toFixed(3)},${(y + dy * VIA_ON_TRACE_MM).toFixed(3)}`;
        const g = viaGroup.get(key);
        if (g) return g;
      }
    }
    return viaGroup.get(`${x.toFixed(3)},${y.toFixed(3)}`) ?? null;
  };

  // --- 1. trace widths
  for (const el of circuitJson) {
    if (el.type !== "pcb_trace") continue;
    const route = (el.route as Array<{ width?: number }> | undefined) ?? [];
    const widths = route.map((p) => num(p.width)).filter((w): w is number => w !== null);
    const minW = widths.length ? Math.min(...widths) : null;
    /*
     * A micron of slack. Widths arrive rounded — 6 mil is 0.1524mm and a
     * three-decimal rounding makes it 0.152 — and a check that compares
     * manufacturing dimensions to the nanometre reports five hundred violations
     * that no fab would ever see.
     */
    if (minW !== null && minW < rules.minTraceWidthMm - TOLLERANZA_MM) {
      const thin = ((el.route as Array<Record<string, unknown>>) ?? []).find(
        (p) => typeof p.width === "number" && p.width === minW,
      );
      push(
        "min_trace_width",
        `Trace ${el.pcb_trace_id} width ${minW}mm < min ${rules.minTraceWidthMm}mm`,
        thin && num(thin.x) !== null && num(thin.y) !== null
          ? { x: num(thin.x)!, y: num(thin.y)! }
          : null,
      );
    }
  }

  // --- 2. via / hole sizes
  for (const el of circuitJson) {
    if (el.type !== "pcb_via" && el.type !== "pcb_plated_hole") continue;
    const hole = num(el.hole_diameter);
    const outer = num(el.outer_diameter);
    const at =
      num(el.x) !== null && num(el.y) !== null ? { x: num(el.x)!, y: num(el.y)! } : null;
    if (hole !== null && hole < rules.minViaHoleMm - TOLLERANZA_MM) {
      push("min_via_hole", `${el.type} hole ${hole}mm < min ${rules.minViaHoleMm}mm`, at);
    }
    if (el.type === "pcb_via" && outer !== null && outer < rules.minViaDiameterMm - TOLLERANZA_MM) {
      push("min_via_diameter", `via pad ${outer}mm < min ${rules.minViaDiameterMm}mm`, at);
    }
  }

  // --- bbox of pads and holes for board edge + clearances
  const boxes: Box[] = [];
  for (const el of circuitJson) {
    if (el.type === "pcb_smtpad") {
      // polygonal pads do not declare a center: it is derived from the
      // vertices, otherwise the clearance check does not see them at all
      const forma = rameDelPad(el);
      if (!forma) continue;
      boxes.push(
        boxDaForma(forma, {
          layer: el.layer ? String(el.layer) : null,
          label: String(el.pcb_smtpad_id ?? "pad"),
          group: groupOfPcbPort(el.pcb_port_id),
          kind: "pad",
        }),
      );
    } else if (el.type === "pcb_plated_hole") {
      // the copper as ITS shape declares it: see rameDelForo
      const forma = rameDelForo(el);
      if (!forma) continue;
      const foro = foroDi(el);
      boxes.push({
        ...boxDaForma(forma, {
          layer: null, // spans all layers
          label: String(el.pcb_plated_hole_id ?? el.type),
          group: groupOfPcbPort(el.pcb_port_id),
          /*
           * A plated hole is a PAD with a hole in it: that is what the board
           * calls it and what the file's rules are written against. Only the
           * bare via is a via.
           */
          kind: "pad",
        }),
        ...(foro ? { foro } : {}),
      });
    } else if (el.type === "pcb_via") {
      const x = num(el.x);
      const y = num(el.y);
      const d = num(el.outer_diameter) ?? num(el.hole_diameter);
      if (x === null || y === null || d === null) continue;
      const foro = num(el.hole_diameter);
      boxes.push({
        minX: x - d / 2,
        maxX: x + d / 2,
        minY: y - d / 2,
        maxY: y + d / 2,
        layer: null, // spans all layers
        label: String(el.pcb_via_id ?? el.type),
        group: groupOfVia(el),
        kind: "via",
        raggio: d / 2,
        ...(foro ? { foro: { ax: x, ay: y, bx: x, by: y, r: foro / 2 } } : {}),
      });
    }
  }
  gruppoDelPadSotto = (x, y, strato) => {
    for (const b of boxes) {
      if (b.group === null || b.kind !== "pad" || !stessoStrato(b.layer, strato)) continue;
      if (x < b.minX - 0.01 || x > b.maxX + 0.01 || y < b.minY - 0.01 || y > b.maxY + 0.01) continue;
      return b.group;
    }
    return null;
  };

  /*
   * The bare holes (NPTH): no copper and no net, but a drill the edge and the
   * other drills have to keep their distance from. Before, nothing looked at
   * them: a mounting hole could sit on the outline or overlap a via's drill.
   */
  const foriNudi: Box[] = [];
  for (const el of circuitJson) {
    if (el.type !== "pcb_hole") continue;
    const foro = foroDi(el);
    if (!foro) continue;
    foriNudi.push({
      minX: Math.min(foro.ax, foro.bx) - foro.r,
      maxX: Math.max(foro.ax, foro.bx) + foro.r,
      minY: Math.min(foro.ay, foro.by) - foro.r,
      maxY: Math.max(foro.ay, foro.by) + foro.r,
      layer: null,
      label: String(el.pcb_hole_id ?? "hole"),
      group: null,
      kind: "pad",
      capsula: foro,
      foro,
    });
  }

  // --- 3. board-edge clearance
  /*
   * Measured against the OUTLINE, not against the board's bounding box, and on
   * the real shape of each thing: a pad turned by 45 degrees, a pill, a trace.
   * The box only knew the pads and vias, and only as straight rectangles: a
   * trace running along the edge, a slot, a mounting hole or a pad on a board
   * with a notch were never measured.
   */
  const board = circuitJson.find((el) => el.type === "pcb_board");
  const contorno = contornoScheda(board);
  const bordoM = rules.minBoardEdgeClearanceMm;
  const lati =
    contorno.length >= 3
      ? contorno.map((a, i) => {
          const b = contorno[(i + 1) % contorno.length];
          return { ax: a.x, ay: a.y, bx: b.x, by: b.y };
        })
      : [];
  const dalBordo = (b: Box): number => {
    const c = centroDi(b);
    const raggio = raggioEsterno(b);
    let d = Infinity;
    for (const lato of lati) {
      // far enough not to need the exact measure
      if (pointSegDistance(c.x, c.y, lato.ax, lato.ay, lato.bx, lato.by) - raggio > bordoM + 1) continue;
      d = Math.min(d, segToBoxDistance(lato, b));
    }
    return d;
  };
  if (lati.length > 0) {
    for (const b of [...boxes, ...foriNudi]) {
      const c = centroDi(b);
      if (!dentroPoligono(c.x, c.y, contorno) || dalBordo(b) < bordoM - TOLLERANZA_MM) {
        push(
          "board_edge_clearance",
          `${b.label} closer than ${bordoM}mm to the board edge`,
          boxCenter(b),
        );
      }
    }
  }

  /*
   * THE NET TIES, which are copper that shorts two nets ON PURPOSE.
   *
   * A net tie is a component whose two pads sit on two different nets with a
   * slab of copper across them: the schematic keeps the nets apart, the layout
   * joins them at that one point, and it is how a board ties analogue ground to
   * digital ground exactly once. To a clearance check it looks like a trace
   * lying on another net's pad, and on this board it was eight of the twelve
   * findings that were left.
   *
   * What is exempt is the BRIDGE, against the copper of the two nets it joins,
   * and nothing else: the two nets go on being measured against each other
   * everywhere else on the board, which is the point of tying them in one place.
   */
  const ponti: Array<{ id: string; gruppi: Set<string> }> = [];
  for (const el of circuitJson) {
    if (el.type !== "pcb_trace" || el.netTie !== true) continue;
    const gruppi = new Set<string>();
    for (const p of (el.route as Array<Record<string, unknown>> | undefined) ?? []) {
      const x = num(p.x);
      const y = num(p.y);
      if (x === null || y === null) continue;
      for (const b of boxes) {
        if (b.group === null) continue;
        // the pad the bridge lands on, on the bridge's layer: its centre within the pad, generously
        if (!stessoStrato(b.layer, stratoDelPunto(p))) continue;
        const dx = Math.max(b.minX - x, x - b.maxX, 0);
        const dy = Math.max(b.minY - y, y - b.maxY, 0);
        if (Math.hypot(dx, dy) <= 0.2) gruppi.add(b.group);
      }
    }
    const proprio = groupOfTrace(el);
    if (proprio) gruppi.add(proprio);
    if (gruppi.size > 0) ponti.push({ id: String(el.pcb_trace_id ?? ""), gruppi });
  }
  /** whether this pair is the net tie doing its job */
  const eIlPonte = (idA: string | null, gruppoA: string | null, idB: string | null, gruppoB: string | null) =>
    ponti.some(
      (p) =>
        (p.id === idA && gruppoB !== null && p.gruppi.has(gruppoB)) ||
        (p.id === idB && gruppoA !== null && p.gruppi.has(gruppoA)),
    );

  /*
   * A PAD WITH NO NET IS NOT AN ELECTRICAL NODE.
   *
   * An imported board has them: the unconnected pins of a microcontroller, the
   * shells of a connector, the fiducials. On BAT_BS there are 40, and the copper
   * of the real board runs right past them because their designer knew they carry
   * nothing. Measuring them like a net puts 169 markers on the drawing and hides
   * whatever else is there — so they are counted and said once, with their name,
   * instead of marked one by one.
   */
  let senzaRete = 0;

  // --- 4. pad-pad clearance between different nets (same layer or through element)
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      if (a.layer && b.layer && a.layer !== b.layer) continue;
      if (a.group !== null && a.group === b.group) continue;
      const minimo = distanzaMinimaFra(rules, a.kind, b.kind);
      if (a.group === null || b.group === null) {
        if (boxDistance(a, b) < minimo - TOLLERANZA_MM) senzaRete++;
        continue;
      }
      const d = boxDistance(a, b);
      if (d < minimo - TOLLERANZA_MM) {
        push(
          "pad_clearance",
          `${a.label} <-> ${b.label}: ${d.toFixed(3)}mm < min ${minimo}mm${quale(rules, minimo, a.kind, b.kind)}`,
          midpoint(boxCenter(a), boxCenter(b)),
        );
      }
    }
  }


  if (senzaRete > 0) {
    // said once, without markers: they are not electrical nodes
    push(
      "vicinanza_pad_senza_rete",
      `${senzaRete} coppie in cui il vicino e' un pad SENZA rete (pin non collegati, gusci di connettore, fiducial): non sono nodi elettrici e non vengono segnati sul disegno`,
    );
  }

  /*
   * --- 4.b DRILL TO DRILL.
   *
   * The only check that looks at the HOLE and not at the copper around it. Two
   * vias whose rings touch can be perfectly legal — a power net brings four of
   * them side by side to carry current — while two that look far apart on
   * screen can have their drills a tenth of a millimetre from each other, and
   * that is where the wall between them breaks out and the board is scrap. It
   * is measured edge to edge, on the drill, whatever net they are on: the
   * drill does not know about nets.
   */
  // the bare holes too, and slots measured as slots: see foroDi
  const fori = [...boxes, ...foriNudi].filter((b) => b.foro !== undefined);
  for (let i = 0; i < fori.length; i++) {
    for (let j = i + 1; j < fori.length; j++) {
      const a = fori[i];
      const b = fori[j];
      const fa = a.foro!;
      const fb = b.foro!;
      const ca = centroDi(a);
      const cb = centroDi(b);
      const d =
        segSegDistanceRaw(fa.ax, fa.ay, fa.bx, fa.by, fb.ax, fb.ay, fb.bx, fb.by) - fa.r - fb.r;
      if (d >= rules.minHoleToHoleMm - TOLLERANZA_MM) continue;
      push(
        "hole_to_hole",
        `${a.label} <-> ${b.label}: fori a ${d.toFixed(3)}mm < min ${rules.minHoleToHoleMm}mm`,
        midpoint(ca, cb),
      );
    }
  }

  /*
   * --- 5.a trace angles (house rule, Niccolo' 2026-07-26)
   * A trace can be horizontal, vertical or at 45 degrees. In-between angles
   * are ugly and that is not how a board is drawn.
   */
  const ANGLE_TOL_DEG = 3;
  for (const el of circuitJson) {
    if (el.type !== "pcb_trace") continue;
    // a curve is exempt: an arc imported from another CAD is a polyline of
    // chords, and none of them is at 0, 45 or 90 by construction
    if (el.arco === true) continue;
    const route = ((el.route as Array<Record<string, unknown>>) ?? []).filter(
      (p) => num(p.x) !== null && num(p.y) !== null,
    );
    for (let i = 1; i < route.length; i++) {
      const ax = num(route[i - 1].x)!;
      const ay = num(route[i - 1].y)!;
      const bx = num(route[i].x)!;
      const by = num(route[i].y)!;
      const dx = bx - ax;
      const dy = by - ay;
      if (Math.hypot(dx, dy) < 0.02) continue;
      const deg = (Math.atan2(Math.abs(dy), Math.abs(dx)) * 180) / Math.PI;
      const off = Math.min(deg, Math.abs(deg - 45), 90 - deg);
      if (off <= ANGLE_TOL_DEG) continue;
      push(
        "trace_angle",
        `${el.pcb_trace_id}: segmento a ${Math.round(deg)}° (ammessi 0, 45, 90)`,
        { x: (ax + bx) / 2, y: (ay + by) / 2 },
      );
    }
  }

  /*
   * --- 5. pin escapes (house rule, Niccolo' 2026-07-26)
   * The trace must leave the pad STRAIGHT — perpendicular to the edge, so
   * horizontal or vertical — and turn at 45 degrees only afterwards. A
   * diagonal segment attached to the pad reduces the joint's useful copper
   * and leaves acute angles where the etching bites deeper.
   */
  /*
   * How crooked an escape can be before calling it diagonal. The criterion
   * is ANGULAR and not in millimeters: a 2mm-long trace that arrives 0.04mm
   * off axis is crooked by one degree — straight to anyone looking at it and
   * to whoever manufactures it. With a threshold in mm, exactly those were
   * being flagged, while the true 45 degrees (exactly 45 degrees) is the only
   * thing worth catching.
   */
  const ESCAPE_MAX_DEG = 12;
  /*
   * The pad the trace leaves is one ON THE LAYER of that segment (see
   * stratoDelPad): the first pad under the point in plan view used to do, and
   * on sbb-dl-principale it was the top capacitor pad lying over the bottom
   * ball the trace enters. A through hole is copper on every layer and is left
   * from either side.
   */
  const padAt = (x: number, y: number, strato: string | null): El | null =>
    circuitJson.find((el) => {
      if (el.type === "pcb_smtpad") {
        if (!stessoStrato(stratoDelPad(el), strato)) return false;
        const px = num(el.x);
        const py = num(el.y);
        if (px === null || py === null) return false;
        const w = (num(el.width) ?? (num(el.radius) ?? 0) * 2) / 2;
        const h = (num(el.height) ?? (num(el.radius) ?? 0) * 2) / 2;
        const [lx, ly] = nelPad(el, x - px, y - py);
        return Math.abs(lx) <= w + 1e-6 && Math.abs(ly) <= h + 1e-6;
      }
      // through holes too (pinheaders, connectors): the straight escape applies just the same
      if (el.type === "pcb_plated_hole") {
        const forma = rameDelForo(el);
        return forma !== null && distanzaPuntoForma(forma, x, y) <= 1e-6;
      }
      return false;
    }) ?? null;

  let uscite45 = 0;
  for (const el of circuitJson) {
    if (el.type !== "pcb_trace") continue;
    const route = ((el.route as Array<Record<string, unknown>>) ?? []).filter(
      (p) => num(p.x) !== null && num(p.y) !== null,
    );
    if (route.length < 2) continue;
    // we look at the two ends: that is where the trace touches a pad
    for (const [from, to] of [
      [route[0], route[1]],
      [route[route.length - 1], route[route.length - 2]],
    ] as Array<[Record<string, unknown>, Record<string, unknown>]>) {
      const x = num(from.x)!;
      const y = num(from.y)!;
      const pad = padAt(x, y, stratoDelPunto(from, to));
      if (!pad) continue;
      const dx = num(to.x)! - x;
      const dy = num(to.y)! - y;
      if (Math.hypot(dx, dy) < 1e-6) continue;
      // measured against the pad's own edges: on an LQFP turned by 135 degrees
      // the straight escape IS the 45-degree one
      const offAxis = escapeOffAxisDeg(...nelPad(pad, dx, dy));
      if (offAxis <= ESCAPE_MAX_DEG) continue;
      /*
       * Copper that arrives from another CAD is counted, not marked. The rule
       * says how a trace is DRAWN here, and an Altium layout is a given: on one
       * imported board it put 172 markers on the drawing, which is a drawing
       * nobody can read any more. The number is said once, at the end.
       */
      if (el.importato === true) {
        uscite45++;
        continue;
      }
      push(
        "pin_escape",
        `${el.pcb_trace_id}: esce dal pad a ${Math.round(offAxis)}° fuori asse invece che dritto`,
        { x, y },
      );
    }
  }
  if (uscite45 > 0) {
    // no coordinates on purpose: it is one line in the report, not a rash of
    // markers over a board somebody else drew
    push(
      "pin_escape_importato",
      `${uscite45} tratti di rame importato escono dal pad a 45°: e' come e' disegnata la scheda di partenza, non un errore introdotto qui`,
    );
  }

  /*
   * --- 6. trace-pad clearance between different nets (Niccolo' 2026-07-26)
   * Until now it was "delegated to the autorouter": if the router got it
   * wrong, nothing stopped it — a trace over another net's pad went
   * unnoticed. Now we measure the true segment-to-pad-bbox distance, minus
   * half the trace width. Same net: ok by construction (it is the intended
   * connection). Traces with no known net (spliced): skipped, no false
   * positives.
   */
  interface WireSeg {
    ax: number;
    ay: number;
    bx: number;
    by: number;
    layer: string | null;
    halfW: number;
    group: string | null;
    label: string;
  }
  const segs: WireSeg[] = [];
  for (const el of circuitJson) {
    if (el.type !== "pcb_trace") continue;
    const group = groupOfTrace(el);
    const route = (el.route as Array<Record<string, unknown>> | undefined) ?? [];
    for (let i = 1; i < route.length; i++) {
      const a = route[i - 1];
      const b = route[i];
      if (a.route_type !== "wire" || b.route_type !== "wire") continue;
      const ax = num(a.x);
      const ay = num(a.y);
      const bx = num(b.x);
      const by = num(b.y);
      if (ax === null || ay === null || bx === null || by === null) continue;
      const layer = b.layer ? String(b.layer) : a.layer ? String(a.layer) : null;
      segs.push({
        ax,
        ay,
        bx,
        by,
        layer,
        halfW: (num(b.width) ?? num(a.width) ?? rules.minTraceWidthMm) / 2,
        group,
        label: String(el.pcb_trace_id ?? "trace"),
      });
    }
  }

  // --- 3.b the traces against the board edge (see 3.: the outline, not the box)
  for (const seg of lati.length > 0 ? segs : []) {
    let d = Infinity;
    for (const lato of lati) {
      if (
        Math.max(seg.ax, seg.bx) + seg.halfW + bordoM < Math.min(lato.ax, lato.bx) ||
        Math.min(seg.ax, seg.bx) - seg.halfW - bordoM > Math.max(lato.ax, lato.bx) ||
        Math.max(seg.ay, seg.by) + seg.halfW + bordoM < Math.min(lato.ay, lato.by) ||
        Math.min(seg.ay, seg.by) - seg.halfW - bordoM > Math.max(lato.ay, lato.by)
      ) {
        continue;
      }
      d = Math.min(
        d,
        segSegDistanceRaw(seg.ax, seg.ay, seg.bx, seg.by, lato.ax, lato.ay, lato.bx, lato.by) -
          seg.halfW,
      );
    }
    if (!dentroPoligono(seg.ax, seg.ay, contorno) || d < bordoM - TOLLERANZA_MM) {
      push(
        "board_edge_clearance",
        `${seg.label} closer than ${bordoM}mm to the board edge`,
        { x: (seg.ax + seg.bx) / 2, y: (seg.ay + seg.by) / 2 },
      );
    }
  }

  for (const seg of segs) {
    if (!seg.group) continue;
    for (const pad of boxes) {
      if (pad.group === null || pad.group === seg.group) continue;
      if (pad.layer && seg.layer && pad.layer !== seg.layer) continue;
      if (eIlPonte(seg.label, seg.group, null, pad.group)) continue;
      const minimo = distanzaMinimaFra(rules, "trace", pad.kind);
      const d = segToBoxDistance(seg, pad) - seg.halfW;
      if (d < minimo - TOLLERANZA_MM) {
        push(
          "trace_pad_clearance",
          `${seg.label} over ${pad.label}: ${Math.max(0, d).toFixed(3)}mm < min ${minimo}mm${quale(rules, minimo, "trace", pad.kind)}`,
          midpoint(boxCenter(pad), {
            x: (seg.ax + seg.bx) / 2,
            y: (seg.ay + seg.by) / 2,
          }),
        );
      }
    }
  }

  // --- 7. trace-trace clearance between different nets, same layer
  for (let i = 0; i < segs.length; i++) {
    const a = segs[i];
    if (!a.group) continue;
    for (let j = i + 1; j < segs.length; j++) {
      const b = segs[j];
      if (!b.group || a.group === b.group) continue;
      if (a.layer && b.layer && a.layer !== b.layer) continue;
      if (eIlPonte(a.label, a.group, b.label, b.group)) continue;
      const minimo = distanzaMinimaFra(rules, "trace", "trace");
      const d = segSegDistance(a, b) - a.halfW - b.halfW;
      if (d < minimo - TOLLERANZA_MM) {
        push(
          "trace_trace_clearance",
          `${a.label} <-> ${b.label}: ${Math.max(0, d).toFixed(3)}mm < min ${minimo}mm${quale(rules, minimo, "trace", "trace")} (${a.layer ?? "?"})`,
          { x: (a.ax + a.bx) / 2, y: (a.ay + a.by) / 2 },
        );
      }
    }
  }

  /*
   * Isolated ground: a pad sitting on a net that has a copper plane but with
   * no via to take it down there.
   *
   * It is the check that closes the right way of doing ground — you place,
   * you route the signal, you pour the plane, and THEN you verify that nobody
   * has been left out. Without it, a pad disconnected from the plane is
   * invisible: the DRC finds it clean, the connections come out closed, and
   * the defect shows up in production with a ground that does not return.
   */
  // read once for the checks on the planes that follow: every vertex of every pour is copied to be read
  const colate = readPours(circuitJson);
  const planeNetIds = new Set<string>();
  for (const el of circuitJson) {
    if (el.type !== "pcb_copper_pour") continue;
    const net = String(el.source_net_id ?? "");
    if (net) planeNetIds.add(net);
  }
  if (planeNetIds.size > 0) {
    const portsOnPlane = new Set<string>();
    for (const el of circuitJson) {
      if (el.type !== "source_trace") continue;
      const nets = (el.connected_source_net_ids as string[] | undefined) ?? [];
      if (!nets.some((n) => planeNetIds.has(String(n)))) continue;
      for (const p of (el.connected_source_port_ids as string[] | undefined) ?? []) {
        portsOnPlane.add(String(p));
      }
    }
    const pcbPortsOnPlane = new Set<string>();
    for (const el of circuitJson) {
      if (el.type !== "pcb_port") continue;
      if (portsOnPlane.has(String(el.source_port_id ?? ""))) {
        pcbPortsOnPlane.add(String(el.pcb_port_id ?? ""));
      }
    }
    /*
     * A pad IMMERSED in the plane of its own face needs no via: it is already
     * in that copper. Asking for one anyway — as this check used to do — meant
     * demanding 43 useless holes on bat-bs-blocchi, one per ground pad, each
     * connecting copper to itself. The via is needed only when the plane of
     * that net is on ANOTHER face.
     */
    /*
     * The same function the house rule uses to decide whether a pad needs a
     * via: if the two answered differently, one would add vias the other keeps
     * asking for. It measures from the pad's EDGE and only counts vias of the
     * pad's own net.
     */
    for (const scoperto of padsOffPlane(circuitJson, colate)) {
      push(
        "plane_stitch_missing",
        `${scoperto.pad || "pad"} sta su una rete con il piano, non e' dentro il piano della sua faccia e non ha una via della sua rete accanto`,
        { x: scoperto.x, y: scoperto.y },
      );
    }


    /*
     * The planes of the same net on more than one face must be tied to each
     * other. Without stitching vias the return current, to change layer, has to
     * travel along the plane looking for the nearest signal via: it is the
     * classic loop that turns a ground plane into an antenna.
     */
    const facceDiRete = pourLayersByNet(colate);
    const viaDiRete = tutteLeVia(circuitJson, netOfViaKey(circuitJson, colate));
    for (const [net, facce] of facceDiRete) {
      if (facce.size < 2) continue;
      const cuciture = viaDiRete.filter(
        (v) => [...facce].filter((f) => v.facce.includes(f)).length >= 2,
      ).length;
      if (cuciture === 0) {
        push(
          "plane_stitch_missing",
          `i piani della rete ${net} stanno su ${facce.size} facce (${[...facce].join(", ")}) e nessuna via li collega`,
        );
      }
    }
  }

  /*
   * --- 8. THE PLANES AGAINST THE VIAS OF THE OTHER NETS, ON EVERY LAYER.
   *
   * A via is a hole through the whole board (see vieSemprePassanti), so the
   * plane of another net has to open around it on every layer, the ones the via
   * does not use included. Nothing measured it: the pours were trusted to carve
   * themselves, and the pair checks above know pads, traces and vias but not
   * poured copper. On sbb-dl-principale (2026-11-11) the inner1 ground plane
   * closed over 20 vias of VBUS, VSYS, NRST and the SD lines, which listed only
   * the two layers their trace joins, and this function answered 0 errors. A
   * plane that is not poured again after copper is added (the fast update never
   * pours) is caught here as well.
   *
   * Measured from the via's PAD on every layer, whatever the element lists: it
   * is the circle the pour engine keeps away from, so a board it poured passes
   * whichever layers get a pad in the Gerber. The minimum is the smallest
   * distance that engine leaves by construction: the pour's own clearance, or
   * less where the plane holds a via or a pad of its own net that the project
   * lets nearer to a via than that (the pair rules). A via with no known net is
   * not an electrical node and is left out, as in the pair checks.
   *
   * A plane that declares its own clearance (PourShape.clearanceMm) is held to
   * it, and not to the smaller pair rules, wherever the copper nearest to the
   * via is the poured copper: a ground plane declared at 0.25 that ends 0.2 from
   * a signal via is reported. Where its own via or pad is as near as the plane,
   * that via or pad is the edge, and the minimum is the one above with the
   * plane's value in place of the project's. Not in the runs of the fab
   * classes (see `opzioni`).
   */
  if (colate.length > 0) {
    const coppie = Math.min(distanzaMinimaFra(rules, "via", "via"), distanzaMinimaFra(rules, "pad", "via"));
    const minimoColata = Math.min(rules.pourClearanceMm ?? rules.minClearanceMm, coppie);
    const proprie = opzioni.distanzeProprieDelleColate !== false;
    /* as far out as the widest clearance a plane asks for, so every row it judges is measured */
    let portataServe = minimoColata;
    if (proprie) for (const c of colate) if (c.clearanceMm !== undefined && c.clearanceMm > portataServe) portataServe = c.clearanceMm;
    /* the copper of one net on one layer that a plane of that net holds whole: its vias, and its pads there */
    const rameDi = new Map<string, Box[]>();
    const rameDellaRete = (net: string, gruppi: Set<string>, layer: string): Box[] => {
      const k = `${net}|${layer}`;
      let suo = rameDi.get(k);
      if (!suo) {
        suo = boxes.filter((b) => b.group !== null && gruppi.has(b.group) && (b.layer === null || b.layer === layer));
        rameDi.set(k, suo);
      }
      return suo;
    };
    /*
     * Measured once per board and not once per ruleset (see MisureDrc): every
     * via against every plane of another net, exact up to `portataMm` from the
     * pad. The nets are told apart here, where the groups are known, and that
     * does not depend on the rules either.
     */
    const misura = (portataMm: number): ViaVicinaAUnPiano[] => {
      const reti = new Map<string, { nome: string; gruppi: Set<string> }>();
      for (const el of circuitJson) {
        if (el.type !== "source_net" || !el.source_net_id) continue;
        const id = String(el.source_net_id);
        const chiave = String(el.subcircuit_connectivity_map_key ?? "");
        // every name the net goes by among the vias: its key, the group that key resolves to, `net:<id>`
        const gruppi = new Set<string>([`net:${id}`]);
        if (chiave) gruppi.add(chiave);
        for (const g of [risolviChiave(chiave), gruppoDiRete.get(id)]) if (g) gruppi.add(g);
        reti.set(id, { nome: String(el.name ?? id), gruppi });
      }
      // the index of a pour is built when the first via comes near it: most pours are islands no via goes by
      const piani = colate.map((c) => ({ colata: c, indice: null as IndiceDiColata | null }));
      const righe: ViaVicinaAUnPiano[] = [];
      for (const el of circuitJson) {
        if (el.type !== "pcb_via") continue;
        const x = num(el.x);
        const y = num(el.y);
        const d = num(el.outer_diameter) ?? num(el.hole_diameter);
        if (x === null || y === null || d === null) continue;
        const gruppo = groupOfVia(el);
        if (!gruppo) continue;
        const chiave = String(el.subcircuit_connectivity_map_key ?? "");
        const portata = d / 2 + portataMm;
        for (const piano of piani) {
          const c = piano.colata;
          if (x < c.minX - portata || x > c.maxX + portata || y < c.minY - portata || y > c.maxY + portata) continue;
          const rete = reti.get(c.net);
          // the plane of the via's own net is where the via belongs
          if (rete && (rete.gruppi.has(gruppo) || (chiave !== "" && rete.gruppi.has(chiave)))) continue;
          piano.indice ??= indiceDiColata(c.outer, c.holes);
          const distanzaMm = distanzaCerchioColata(piano.indice, x, y, d / 2, portata);
          if (distanzaMm >= portataMm) continue;
          const riga: ViaVicinaAUnPiano = { via: String(el.pcb_via_id ?? "via"), x, y, rete: rete?.nome ?? (c.net || "?"), layer: c.layer, distanzaMm };
          if (c.clearanceMm !== undefined) {
            riga.propriaMm = c.clearanceMm;
            const questa: Box = { minX: x - d / 2, maxX: x + d / 2, minY: y - d / 2, maxY: y + d / 2, layer: null, label: riga.via, group: gruppo, kind: "via", raggio: d / 2 };
            let vicino = Infinity;
            if (rete) for (const b of rameDellaRete(c.net, rete.gruppi, c.layer)) vicino = Math.min(vicino, boxDistance(questa, b));
            if (Number.isFinite(vicino)) riga.rameProprioMm = vicino;
          }
          righe.push(riga);
        }
      }
      return righe;
    };
    let viaPiani = misure?.viaPiani;
    if (!viaPiani || viaPiani.portataMm < portataServe) {
      const portataMm = Math.max(portataServe, PORTATA_PIANI_MM);
      viaPiani = { portataMm, righe: misura(portataMm) };
      if (misure) misure.viaPiani = viaPiani;
    }
    for (const r of viaPiani.righe) {
      const propria = proprie ? r.propriaMm : undefined;
      const minimo =
        propria === undefined
          ? minimoColata
          : (r.rameProprioMm ?? Infinity) > r.distanzaMm + TOLLERANZA_COLATA_MM
            ? propria
            : Math.min(propria, coppie);
      if (r.distanzaMm >= minimo - TOLLERANZA_COLATA_MM) continue;
      push(
        "pour_clearance",
        `${r.via} <-> ${r.rete} pour on ${r.layer}: ${r.distanzaMm.toFixed(3)}mm < min ${minimo}mm${propria !== undefined && minimo === propria ? " (the pour's own clearance)" : ""}${r.distanzaMm === 0 ? " (the plane does not open around the hole)" : ""}`,
        { x: r.x, y: r.y },
      );
    }
  }

  // The same violations repeat dozens of times (one per via, per pad...):
  // aggregating them by rule keeps the LLM feedback readable and short.
  const byRule = new Map<string, DrcViolation[]>();
  for (const v of raw) {
    const list = byRule.get(v.rule) ?? [];
    list.push(v);
    byRule.set(v.rule, list);
  }
  const aggregated: DrcViolation[] = [];
  for (const [rule, list] of byRule) {
    const totale = perRegola.get(rule) ?? list.length;
    if (totale <= 3) {
      aggregated.push(...list);
    } else {
      aggregated.push({
        rule,
        message: `${totale}x ${rule}: ${list[0].message} (and ${totale - 1} more)`,
        // the points of the occurrences kept (MAX_PER_REGOLA): aggregating the
        // text must not make the dots disappear from the board
        points: list.flatMap((v) => v.points ?? []),
        count: totale,
      });
    }
  }
  return aggregated;
}

/**
 * THE VIAS A PLANE OF ANOTHER NET COVERS: pad and copper touch or overlap, on
 * any layer. Not a distance to judge against a rule but a hole in a plane with
 * no opening, so it is said apart from the DRC list, counted and in words
 * (CompileSummary.planesOverVias).
 *
 * Read from what a DRC run on this board measured (`misure`), or measured here
 * when nobody has: the export asks the board it is about to hand over, whatever
 * the summary saved with it says. A distance of zero is the same under every
 * ruleset, so the default rules will do; a board with no plane is not measured.
 */
export function pianiSopraLeVie(circuitJson: El[], misure: MisureDrc = {}): PianiSuVie | undefined {
  if (!misure.viaPiani) {
    if (!circuitJson.some((el) => el.type === "pcb_copper_pour")) return undefined;
    runDrcChecks(circuitJson, DEFAULT_DESIGN_RULES, misure);
  }
  const coperte = (misure.viaPiani?.righe ?? []).filter((r) => r.distanzaMm <= 0);
  const vie = new Set(coperte.map((r) => r.via)).size;
  if (vie === 0) return undefined;
  const altri = coperte.length === 2 ? " e in un altro punto" : coperte.length > 2 ? ` e in altri ${coperte.length - 1} punti` : "";
  return {
    count: vie,
    detail:
      `${vie} ${vie === 1 ? "via ha" : "vie hanno"} la piazzola nel rame di un piano di un'altra rete ` +
      `(${coperte[0].via} nel piano ${coperte[0].rete} su ${coperte[0].layer}${altri}): il piano non si e' aperto attorno al foro`,
  };
}

/** occurrences kept with their message and point, per rule; the count goes on */
const MAX_PER_REGOLA = 200;

/** the board outline: the declared polygon, or the rectangle of the board */
function contornoScheda(board: El | undefined): Array<{ x: number; y: number }> {
  if (!board) return [];
  if (Array.isArray(board.outline)) {
    const punti: Array<{ x: number; y: number }> = [];
    for (const p of board.outline as Array<{ x?: unknown; y?: unknown }>) {
      const x = num(p?.x);
      const y = num(p?.y);
      if (x !== null && y !== null) punti.push({ x, y });
    }
    if (punti.length >= 3) return punti;
  }
  const w = num(board.width);
  const h = num(board.height);
  if (w === null || h === null) return [];
  const center = (board.center as { x?: unknown; y?: unknown } | undefined) ?? {};
  const cx = num(center.x) ?? 0;
  const cy = num(center.y) ?? 0;
  return [
    { x: cx - w / 2, y: cy - h / 2 },
    { x: cx + w / 2, y: cy - h / 2 },
    { x: cx + w / 2, y: cy + h / 2 },
    { x: cx - w / 2, y: cy + h / 2 },
  ];
}

/** point inside a polygon, ray casting */
function dentroPoligono(x: number, y: number, poligono: Array<{ x: number; y: number }>): boolean {
  let dentro = false;
  for (let i = 0, j = poligono.length - 1; i < poligono.length; j = i++) {
    const a = poligono[i];
    const b = poligono[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) dentro = !dentro;
  }
  return dentro;
}

/**
 * How many degrees the escape is off the nearest axis (horizontal or
 * vertical). 0 = perfectly straight, 45 = fully diagonal.
 */
/**
 * A vector seen from the pad's own axes. A rotated pad (shape "rotated_rect")
 * has its edges at ccw_rotation degrees: "straight out of the pad" means
 * perpendicular to THOSE edges, not to the board's. Every other shape is
 * already on the board's axes and comes back unchanged.
 */
export function nelPad(pad: Record<string, unknown>, dx: number, dy: number): [number, number] {
  if (pad.shape !== "rotated_rect") return [dx, dy];
  const t = (-(num(pad.ccw_rotation) ?? 0) * Math.PI) / 180;
  return [dx * Math.cos(t) - dy * Math.sin(t), dx * Math.sin(t) + dy * Math.cos(t)];
}

export function escapeOffAxisDeg(dx: number, dy: number): number {
  const deg = (Math.atan2(Math.abs(dy), Math.abs(dx)) * 180) / Math.PI;
  return Math.min(deg, 90 - deg);
}

function boxCenter(b: Box): { x: number; y: number } {
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
}

function midpoint(
  a: { x: number; y: number },
  b: { x: number; y: number },
): { x: number; y: number } {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** point-to-segment distance */
export function pointSegDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** segment-to-bbox distance (0 if the segment enters the box) */
function segToBoxDistance(
  seg: { ax: number; ay: number; bx: number; by: number },
  box: Box,
): number {
  if (box.capsula) {
    const c = box.capsula;
    return Math.max(
      0,
      segSegDistanceRaw(seg.ax, seg.ay, seg.bx, seg.by, c.ax, c.ay, c.bx, c.by) - c.r,
    );
  }
  if (box.raggio !== undefined) {
    const c = centroDi(box);
    return Math.max(
      0,
      pointSegDistance(c.x, c.y, seg.ax, seg.ay, seg.bx, seg.by) - box.raggio,
    );
  }
  /*
   * The corners are the TURNED ones. Measuring a pad at 45 degrees as if it
   * were straight does not even measure the box that contains it: it measures
   * a different rectangle, in the wrong direction, and on this board that is
   * every pin of a component the designer rotated.
   */
  const punti = angoliDi(box);
  const inside = (x: number, y: number) => {
    let dentro = false;
    for (let i = 0, j = punti.length - 1; i < punti.length; j = i++) {
      const p = punti[i];
      const q = punti[j];
      if (p.y > y !== q.y > y && x < ((q.x - p.x) * (y - p.y)) / (q.y - p.y) + p.x) dentro = !dentro;
    }
    return dentro;
  };
  if (inside(seg.ax, seg.ay) || inside(seg.bx, seg.by)) return 0;
  /*
   * Side by side: the segment against every side of the rectangle, both ways
   * (its ends against the side, the side's corners against it). It used to
   * measure from the corners only, and a short segment running along a side,
   * its two ends in front of it, came out as far as the corners: on tm-4l-q1 a
   * stroke 0,053 mm from the pad C15.2 was "clear" (2026-11-12), and a short
   * trace along a pad of another net could pass the DRC the same way.
   */
  let best = Infinity;
  for (let i = 0; i < 4; i++) {
    const p = punti[i];
    const q = punti[(i + 1) % 4];
    const d = segSegDistanceRaw(seg.ax, seg.ay, seg.bx, seg.by, p.x, p.y, q.x, q.y);
    if (d === 0) return 0;
    best = Math.min(best, d);
  }
  return best;
}

/** distance between two segments (0 if they cross) */
function segSegDistanceRaw(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): number {
  const d1 = crossSign(ax, ay, bx, by, cx, cy);
  const d2 = crossSign(ax, ay, bx, by, dx, dy);
  const d3 = crossSign(cx, cy, dx, dy, ax, ay);
  const d4 = crossSign(cx, cy, dx, dy, bx, by);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return 0;
  }
  return Math.min(
    pointSegDistance(ax, ay, cx, cy, dx, dy),
    pointSegDistance(bx, by, cx, cy, dx, dy),
    pointSegDistance(cx, cy, ax, ay, bx, by),
    pointSegDistance(dx, dy, ax, ay, bx, by),
  );
}

function crossSign(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  px: number,
  py: number,
): number {
  return (bx - ax) * (py - ay) - (by - ay) * (px - ax);
}

function segSegDistance(
  a: { ax: number; ay: number; bx: number; by: number },
  b: { ax: number; ay: number; bx: number; by: number },
): number {
  return segSegDistanceRaw(a.ax, a.ay, a.bx, a.by, b.ax, b.ay, b.bx, b.by);
}
