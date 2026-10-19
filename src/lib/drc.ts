import {
  DEFAULT_DESIGN_RULES,
  distanzaMinimaFra,
  type DesignRules,
  type TipoRame,
} from "./design-rules";
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
  | { tipo: "rettangolo"; x: number; y: number; w: number; h: number; rot: number }
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
    return {
      tipo: "rettangolo",
      x,
      y,
      w: Math.max(...xs) - Math.min(...xs),
      h: Math.max(...ys) - Math.min(...ys),
      rot: 0,
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
const TOLLERANZA_MM = 0.001;

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
  let gruppoDelPadSotto: (x: number, y: number) => string | null = () => null;
  const groupOfTrace = (el: El): string | null => {
    const st = String(el.source_trace_id ?? "");
    if (st) return groupOfSourceTrace.get(st) || risolviChiave(String(el.subcircuit_connectivity_map_key ?? ""));
    const daChiave = risolviChiave(String(el.subcircuit_connectivity_map_key ?? ""));
    if (daChiave) return daChiave;
    const route = ((el.route as Array<Record<string, unknown>> | undefined) ?? []).filter(
      (p) => num(p.x) !== null && num(p.y) !== null,
    );
    for (const p of [route[0], route[route.length - 1]]) {
      if (!p) continue;
      const g = gruppoDelPadSotto(num(p.x)!, num(p.y)!);
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
  gruppoDelPadSotto = (x, y) => {
    for (const b of boxes) {
      if (b.group === null || b.kind !== "pad") continue;
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
        // the pad the bridge lands on: its centre within the pad, generously
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
  const padAt = (x: number, y: number): El | null =>
    circuitJson.find((el) => {
      if (el.type === "pcb_smtpad") {
        const px = num(el.x);
        const py = num(el.y);
        if (px === null || py === null) return false;
        const w = (num(el.width) ?? (num(el.radius) ?? 0) * 2) / 2;
        const h = (num(el.height) ?? (num(el.radius) ?? 0) * 2) / 2;
        return Math.abs(px - x) <= w + 1e-6 && Math.abs(py - y) <= h + 1e-6;
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
      if (!padAt(x, y)) continue;
      const dx = num(to.x)! - x;
      const dy = num(to.y)! - y;
      if (Math.hypot(dx, dy) < 1e-6) continue;
      const offAxis = escapeOffAxisDeg(dx, dy);
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
    const pours = readPours(circuitJson);
    /*
     * The same function the house rule uses to decide whether a pad needs a
     * via: if the two answered differently, one would add vias the other keeps
     * asking for. It measures from the pad's EDGE and only counts vias of the
     * pad's own net.
     */
    for (const scoperto of padsOffPlane(circuitJson, pours)) {
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
    const facceDiRete = pourLayersByNet(pours);
    const viaDiRete = tutteLeVia(circuitJson, netOfViaKey(circuitJson, pours));
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
  const corners = punti.map((p) => [p.x, p.y] as const);
  let best = Infinity;
  for (let i = 0; i < 4; i++) {
    const [cx1, cy1] = corners[i];
    const [cx2, cy2] = corners[(i + 1) % 4];
    if (segSegDistanceRaw(seg.ax, seg.ay, seg.bx, seg.by, cx1, cy1, cx2, cy2) === 0) {
      return 0;
    }
    best = Math.min(
      best,
      pointSegDistance(cx1, cy1, seg.ax, seg.ay, seg.bx, seg.by),
      pointSegDistance(cx2, cy2, seg.ax, seg.ay, seg.bx, seg.by),
    );
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
