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
