/**
 * Where the net names go on the board, so they never sit on top of each other.
 *
 * They used to be written just above their pad, centred, in millimetres: on
 * R6 of sbb-dl-retro (an 0402, pads half a millimetre apart) "GNSS_PWRCTL" and
 * "CTL_SRC" landed on the same line and read "GNSS_PWRCTLCTL_SRC" (Niccolo',
 * 2026-11-09). Here every name goes on the side of its pad, pushed outward
 * from the part (left pad -> left, top pad -> up), in SCREEN pixels, so it is
 * the same size at any zoom. When two still collide (a QFN, a module, many
 * pins close together) the later one moves to the next free slot and a short
 * leader line ties it to its pad. Names are never shortened.
 */

export type LatoEtichetta = "left" | "right" | "up" | "down";

export interface NetLabelInput {
  key: string;
  /** the pad the name belongs to, board millimetres */
  x: number;
  y: number;
  /** which way it is pushed: away from the part's centre */
  lato: LatoEtichetta;
  /** how far the pad reaches from its centre, mm: the name starts past it */
  raggio: number;
  testo: string;
  sotto: string;
  colore: string;
}

export interface PlacedNetLabel extends NetLabelInput {
  /** the box, screen pixels */
  bx: number;
  by: number;
  bw: number;
  bh: number;
  /** the pad, screen pixels */
  ax: number;
  ay: number;
  /** moved away from its natural place: drawn with a line to the pad */
  leader: boolean;
}

/** font sizes, screen pixels: constant at every zoom */
export const LABEL_FONT = 11;
export const PIN_FONT = 9;
/** a monospace advance (IBM Plex Mono and the fallbacks): 0.6 em */
const ADVANCE = 0.6;
const PAD_X = 5;
const PAD_Y = 3;
const LINE_1 = 13;
const LINE_2 = 11;
/** air between the pad's edge and the box */
const GAP = 5;
/** air between two boxes */
const AIR = 3;

export function labelSize(testo: string, sotto: string): { w: number; h: number } {
  const w = Math.max(testo.length * ADVANCE * LABEL_FONT, sotto.length * ADVANCE * PIN_FONT) + PAD_X * 2;
  const h = PAD_Y * 2 + LINE_1 + (sotto ? LINE_2 : 0);
  return { w: Math.ceil(w), h };
}

/** baseline offsets inside the box, for whoever draws it */
export const LABEL_METRICS = { PAD_Y, LINE_1, LINE_2 } as const;

/** which side of the part a pad is on, from its offset to the part's centre (mm, y up) */
export function latoDi(dx: number, dy: number): LatoEtichetta {
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return "up";
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "up" : "down";
}

const overlaps = (
  a: { bx: number; by: number; bw: number; bh: number },
  b: { bx: number; by: number; bw: number; bh: number },
) =>
  a.bx < b.bx + b.bw + AIR &&
  b.bx < a.bx + a.bw + AIR &&
  a.by < b.by + b.bh + AIR &&
  b.by < a.by + a.bh + AIR;

/**
 * Lays the names out. `view` is the canvas transform: screen = (x*k + vx,
 * vy - y*k). The first name takes its natural place; every next one takes the
 * cheapest free slot: sideways along its edge first (a row of names over a QFN),
 * then one step further out (a second row), never on top of another name.
 */
export function layoutNetLabels(
  labels: NetLabelInput[],
  view: { x: number; y: number; k: number },
): PlacedNetLabel[] {
  const placed: PlacedNetLabel[] = [];
  // the slots, cheapest first: lateral steps cost 1, a step further out 2
  const slots: Array<{ out: number; lat: number }> = [];
  for (let out = 0; out <= 8; out++) {
    for (let m = 0; m <= 10; m++) {
      for (const lat of m === 0 ? [0] : [m, -m]) slots.push({ out, lat });
    }
  }
  slots.sort((a, b) => a.out * 2 + Math.abs(a.lat) - (b.out * 2 + Math.abs(b.lat)));

  for (const l of labels) {
    const { w, h } = labelSize(l.testo, l.sotto);
    const ax = view.x + l.x * view.k;
    const ay = view.y - l.y * view.k;
    const r = Math.max(0, l.raggio) * view.k + GAP;
    // natural place, and the two directions it may slide in
    const base =
      l.lato === "right"
        ? { bx: ax + r, by: ay - h / 2 }
        : l.lato === "left"
          ? { bx: ax - r - w, by: ay - h / 2 }
          : l.lato === "up"
            ? { bx: ax - w / 2, by: ay - r - h }
            : { bx: ax - w / 2, by: ay + r };
    const sideways = l.lato === "left" || l.lato === "right";
    const outward = { right: [1, 0], left: [-1, 0], up: [0, -1], down: [0, 1] }[l.lato];
    const stepOut = sideways ? 28 : h + AIR;
    const stepLat = sideways ? h + AIR : w + AIR;

    let chosen: PlacedNetLabel | null = null;
    for (const s of slots) {
      const dx = outward[0] * s.out * stepOut + (sideways ? 0 : s.lat * stepLat);
      const dy = outward[1] * s.out * stepOut + (sideways ? s.lat * stepLat : 0);
      const cand: PlacedNetLabel = {
        ...l,
        bx: base.bx + dx,
        by: base.by + dy,
        bw: w,
        bh: h,
        ax,
        ay,
        leader: s.out !== 0 || s.lat !== 0,
      };
      if (!placed.some((p) => overlaps(p, cand))) {
        chosen = cand;
        break;
      }
    }
    // a board with more names than slots: the last one goes past every other
    if (!chosen) {
      const bottom = Math.max(...placed.map((p) => p.by + p.bh));
      chosen = { ...l, bx: base.bx, by: bottom + AIR, bw: w, bh: h, ax, ay, leader: true };
    }
    placed.push(chosen);
  }
  return placed;
}

/** where the leader line touches the box: its nearest point to the pad */
export function leaderEnd(l: PlacedNetLabel): { x: number; y: number } {
  return {
    x: Math.min(Math.max(l.ax, l.bx), l.bx + l.bw),
    y: Math.min(Math.max(l.ay, l.by), l.by + l.bh),
  };
}

// ---------------------------------------------------------------------------
// Designators in "Sposta"
// ---------------------------------------------------------------------------

/*
 * In "Sposta" every part of the visible face carries its name (U7, R12, J3):
 * on htl-401 the parts were anonymous pads and there was no way to know what
 * was being moved (Niccolo', 2026-11-09). Same rules as the net names: screen
 * pixels, constant size, never on another name and, when there is room, never
 * on a pad. The name sits next to its part (above, below, right, left); when
 * all four are taken it goes one ring further out with a line to the part.
 */

export const DESIGNATOR_FONT = 10;

export interface DesignatorInput {
  key: string;
  name: string;
  /** the part's box on the board, mm (centre and size) */
  cx: number;
  cy: number;
  w: number;
  h: number;
}

export interface PlacedDesignator {
  key: string;
  name: string;
  bx: number;
  by: number;
  bw: number;
  bh: number;
  /** the part's centre on screen, for the leader line */
  ax: number;
  ay: number;
  leader: boolean;
}

type Box = { bx: number; by: number; bw: number; bh: number };

/** a bucket grid over the screen: checking 90 names against 400 pads stays cheap */
class Griglia {
  private cells = new Map<string, Box[]>();
  constructor(private size = 48) {}
  private keys(b: Box): string[] {
    const out: string[] = [];
    const x0 = Math.floor(b.bx / this.size), x1 = Math.floor((b.bx + b.bw) / this.size);
    const y0 = Math.floor(b.by / this.size), y1 = Math.floor((b.by + b.bh) / this.size);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push(`${x},${y}`);
    return out;
  }
  add(b: Box) {
    for (const k of this.keys(b)) {
      const l = this.cells.get(k);
      if (l) l.push(b);
      else this.cells.set(k, [b]);
    }
  }
  hits(b: Box, air: number): boolean {
    for (const k of this.keys(b)) {
      for (const o of this.cells.get(k) ?? []) {
        if (b.bx < o.bx + o.bw + air && o.bx < b.bx + b.bw + air && b.by < o.by + o.bh + air && o.by < b.by + b.bh + air) {
          return true;
        }
      }
    }
    return false;
  }
}

export function layoutDesignators(
  parts: DesignatorInput[],
  /** pads on screen, pixels: a name avoids them when it can */
  pads: Box[],
  view: { x: number; y: number; k: number },
): PlacedDesignator[] {
  const nomi = new Griglia();
  const rame = new Griglia();
  for (const p of pads) rame.add(p);
  const out: PlacedDesignator[] = [];
  // big parts first: they have the most room around them, and the small ones
  // fill the gaps that are left
  const ordine = [...parts].sort((a, b) => b.w * b.h - a.w * a.h);
  for (const p of ordine) {
    const bw = Math.ceil(p.name.length * ADVANCE * DESIGNATOR_FONT) + 6;
    const bh = DESIGNATOR_FONT + 4;
    const ax = view.x + p.cx * view.k;
    const ay = view.y - p.cy * view.k;
    const hw = (p.w * view.k) / 2;
    const hh = (p.h * view.k) / 2;
    const candidati: Array<Box & { leader: boolean }> = [];
    for (let anello = 0; anello <= 3; anello++) {
      const g = 2 + anello * (bh + 4);
      const leader = anello > 0;
      candidati.push(
        { bx: ax - bw / 2, by: ay - hh - g - bh, bw, bh, leader },
        { bx: ax - bw / 2, by: ay + hh + g, bw, bh, leader },
        { bx: ax + hw + g, by: ay - bh / 2, bw, bh, leader },
        { bx: ax - hw - g - bw, by: ay - bh / 2, bw, bh, leader },
        { bx: ax + hw + g, by: ay - hh - g - bh, bw, bh, leader },
        { bx: ax - hw - g - bw, by: ay - hh - g - bh, bw, bh, leader },
        { bx: ax + hw + g, by: ay + hh + g, bw, bh, leader },
        { bx: ax - hw - g - bw, by: ay + hh + g, bw, bh, leader },
      );
    }
    const scelto =
      candidati.find((c) => !nomi.hits(c, 1) && !rame.hits(c, 0)) ??
      candidati.find((c) => !nomi.hits(c, 1)) ??
      candidati[0];
    nomi.add(scelto);
    out.push({ key: p.key, name: p.name, bx: scelto.bx, by: scelto.by, bw, bh, ax, ay, leader: scelto.leader });
  }
  return out;
}
