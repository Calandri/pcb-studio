/**
 * Which wires of the schematic are drawn as wires, and where the dots go.
 *
 * tscircuit draws every connection as a wire. On a small board that is the
 * right drawing; on the HTL-401 (183 parts) it leaves wires running across
 * half the sheet, tangled with parts that have nothing to do with them, and
 * the eye cannot follow them anyway. An engineer would cut those wires and
 * write the net name at both ends: that is what happens here. It is only the
 * drawing: the connectivity is still the Circuit JSON's, and the labels drawn
 * in place of a wire carry its net, so highlighting a net lights them too.
 *
 * THE THRESHOLD, measured on the two sheets we look at (units of the Circuit
 * JSON; the typical part, the median of max(width, height), is 0.65 on both):
 * - HTL-401, 243 wires: median length 2.8 parts, 90th percentile 5.2. Only 5
 *   signal wires are longer than 6 parts (the modem USB D+ at 8.9, J8 B5 at
 *   9.9, FB2, R9, D3 between 7.4 and 8.6): they are the ones running between
 *   distant blocks. The other 85 signal wires stay wires.
 * - a 13-part sensor board: the longest signal wire is 3.7 parts (an I2C line
 *   from the connector to the MCU), and it reads well as a wire.
 * So a signal stays a wire up to 6 parts: every wire of a small board stays,
 * the long tail of the big one goes. Rails and grounds are cut much earlier,
 * beyond 2 parts, and a piece of rail goes whole (see schematic-model.ts): on
 * paper a rail is a symbol at every pin, and the only rail wires worth
 * keeping are the short straps between neighbouring pins or a capacitor and
 * its pin (27 of 153 on the HTL-401).
 */

import { r, type Box, type PinSide, type Pt } from "./schematic-shapes";

export type WireReason = "lunghezza" | "alimentazione" | "sezione";

/** a signal wire longer than this many typical parts becomes two labels */
export const LONG_SIGNAL_PARTS = 6;
/** a rail or ground wire longer than this many typical parts becomes symbols */
export const LONG_RAIL_PARTS = 2;
/** how far a wire may stray past the parts of its section before it "leaves" it */
const SECTION_SLACK = 0.3;

/**
 * The size of a typical part: the median, not the mean, so one big MCU does
 * not make every wire look short. Bounded so that an odd sheet (all
 * connectors, all test points) still gets a sane threshold.
 */
export function pieceSize(sizes: Array<{ width: number; height: number }>): number {
  const all = sizes.map((s) => Math.max(s.width, s.height)).filter((v) => v > 0).sort((a, b) => a - b);
  if (all.length === 0) return 0.65;
  const mid = all.length >> 1;
  const median = all.length % 2 === 1 ? all[mid] : (all[mid - 1] + all[mid]) / 2;
  return Math.min(2, Math.max(0.4, median));
}

export function wireLength(segments: Array<[Pt, Pt]>): number {
  let total = 0;
  for (const [a, b] of segments) total += Math.hypot(b.x - a.x, b.y - a.y);
  return total;
}

/**
 * Why a wire is drawn as labels, or null if it stays a wire.
 *
 * @param endSections the section of the part at each end of the wire (null
 *   when the end is not on a part, or the part has no section)
 * @param sectionBox the area of a section's parts
 */
export function wireAsLabels(
  wire: { length: number; power: boolean; points: Pt[]; endSections: Array<string | null> },
  piece: number,
  sectionBox: (name: string) => Box | null,
): WireReason | null {
  if (wire.power && wire.length > LONG_RAIL_PARTS * piece) return "alimentazione";
  if (!wire.power && wire.length > LONG_SIGNAL_PARTS * piece) return "lunghezza";
  const named = [...new Set(wire.endSections.filter((s): s is string => Boolean(s)))];
  // between two sections: it crosses at least one frame
  if (named.length >= 2) return "sezione";
  if (named.length === 1) {
    const b = sectionBox(named[0]);
    if (
      b &&
      wire.points.some(
        (p) =>
          p.x < b.minX - SECTION_SLACK ||
          p.x > b.maxX + SECTION_SLACK ||
          p.y < b.minY - SECTION_SLACK ||
          p.y > b.maxY + SECTION_SLACK,
      )
    ) {
      return "sezione";
    }
  }
  return null;
}

/**
 * The side of a net label that sits on its anchor, for a label growing from
 * `from` towards `to` (netLabelArt's convention: anchored on the left, it
 * grows to the right).
 */
export function sideAlong(from: Pt, to: Pt): PinSide {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "left" : "right";
  return dy >= 0 ? "top" : "bottom";
}

const keyOf = (p: Pt) => `${r(p.x)},${r(p.y)}`;

/**
 * The free ends of a wire (points touched by one segment only), each with
 * the other end of its segment: that is the direction the wire left in.
 */
export function wireEnds(segments: Array<[Pt, Pt]>): Array<{ at: Pt; toward: Pt }> {
  const seen = new Map<string, { count: number; at: Pt; toward: Pt }>();
  for (const [a, b] of segments) {
    if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-9) continue;
    for (const [p, q] of [
      [a, b],
      [b, a],
    ] as const) {
      const k = keyOf(p);
      const cur = seen.get(k);
      if (cur) cur.count += 1;
      else seen.set(k, { count: 1, at: p, toward: q });
    }
  }
  return [...seen.values()].filter((e) => e.count === 1).map(({ at, toward }) => ({ at, toward }));
}

export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * Junction dots: the points where three or more conductors of one net meet.
 *
 * A pin counts as one conductor (its line), a wire ending on a point as one,
 * a wire running through it as two. So a pin with one wire is not a junction
 * (2), a pin with two wires is (3), a T in the middle of a wire is (1 + 2),
 * and the corner of a single wire is not (2). Computed from what is drawn,
 * not taken from tscircuit: a wire drawn as labels takes its dots with it.
 *
 * @param nets one entry per net: its drawn segments and the pin ends on it
 */
export function findJunctions(nets: Array<{ segments: Array<[Pt, Pt]>; pins: Pt[] }>, eps = 1e-3): Pt[] {
  const out: Pt[] = [];
  for (const { segments, pins } of nets) {
    const ends = new Map<string, { p: Pt; count: number }>();
    for (const [a, b] of segments) {
      if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-9) continue;
      for (const p of [a, b]) {
        const k = keyOf(p);
        const cur = ends.get(k);
        if (cur) cur.count += 1;
        else ends.set(k, { p, count: 1 });
      }
    }
    const pinKeys = new Set(pins.map(keyOf));
    for (const [k, { p, count }] of ends) {
      let degree = count + (pinKeys.has(k) ? 1 : 0);
      if (degree < 3) {
        for (const [a, b] of segments) {
          if (Math.hypot(p.x - a.x, p.y - a.y) < eps || Math.hypot(p.x - b.x, p.y - b.y) < eps) continue;
          if (distToSegment(p, a, b) < eps) degree += 2;
          if (degree >= 3) break;
        }
      }
      if (degree >= 3) out.push(p);
    }
  }
  return out;
}
