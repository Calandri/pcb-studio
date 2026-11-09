/**
 * The shapes of the schematic sheet that tscircuit does not draw for us: the
 * body of an IC with its pins, the net labels, the power and ground symbols.
 *
 * Everything here is pure geometry in sheet coordinates (SVG, y down, units
 * of the Circuit JSON, pin pitch 0.2). It sits apart from schematic-model.ts
 * because these are the rules that decide whether the sheet reads like an
 * engineer's drawing, and they are tested on their own.
 */

export interface Pt {
  x: number;
  y: number;
}

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface SchLabel {
  x: number;
  y: number;
  text: string;
  anchor: "start" | "middle" | "end";
  size: number;
  /**
   * name = designator, value = value or part number, pin = pin name, number =
   * pin number, comment = the one-line note from schematico.json
   */
  tone: "name" | "value" | "pin" | "number" | "comment";
  /** text rotated 90 degrees, reading bottom to top: pins on the top/bottom sides */
  vertical?: boolean;
  /** placed by its component's layout (inside an IC body): the overlap pass leaves it */
  fixed?: boolean;
  /** the whole text, when `text` was cut to fit */
  full?: string;
}

/**
 * Text sizes, in sheet units. One table so that the same thing has the same
 * size everywhere: a designator is a designator, on an IC or on a resistor.
 * The pin pitch is 0.2, so everything written next to a pin stays below it.
 */
export const SCH_TEXT = {
  chipName: 0.18,
  chipPart: 0.13,
  pinName: 0.12,
  pinNumber: 0.09,
  symbolName: 0.15,
  symbolValue: 0.12,
  netLabel: 0.12,
  powerLabel: 0.11,
  sectionTitle: 0.26,
  comment: 0.1,
} as const;

/** approximate width of a monospaced text (advance 0.6 em), in sheet units */
export const textWidth = (text: string, size: number): number => text.length * size * 0.6;

/**
 * Box occupied by a text, from its SVG anchor point (baseline). Cap height is
 * about 0.7 em and descenders 0.2 em: the box covers both.
 */
export function textBox(l: Pick<SchLabel, "x" | "y" | "text" | "anchor" | "size" | "vertical">): Box {
  const w = textWidth(l.text, l.size);
  const lo = l.anchor === "start" ? 0 : l.anchor === "end" ? -w : -w / 2;
  if (l.vertical) {
    // rotated -90 around (x, y): the run goes up, the glyphs grow to the left
    return { minX: l.x - l.size * 0.75, maxX: l.x + l.size * 0.2, minY: l.y - lo - w, maxY: l.y - lo };
  }
  return { minX: l.x + lo, maxX: l.x + lo + w, minY: l.y - l.size * 0.75, maxY: l.y + l.size * 0.2 };
}

export type PinSide = "left" | "right" | "top" | "bottom";

export interface ChipPin extends Pt {
  side: PinSide;
  number: string;
  /** pin name from pinLabels; null when the part has only numbers */
  name: string | null;
}

/**
 * The name to write inside the body, or null. A name that only repeats the
 * number ("1", "pin1") says nothing: the number is already on the pin, and
 * writing it twice is what made the HTL-401 test points read "1".
 */
export function pinCaption(name: string | null | undefined, number: string): string | null {
  if (!name) return null;
  const n = name.trim();
  if (n.length === 0 || n === number || n.toLowerCase() === `pin${number}`) return null;
  return n;
}

/** side of a pin from where it sits around the body, when the JSON does not say */
export function sideOf(p: Pt, box: { x: number; y: number; w: number; h: number }): PinSide {
  const dl = box.x - p.x;
  const dr = p.x - (box.x + box.w);
  const dt = box.y - p.y;
  const db = p.y - (box.y + box.h);
  const m = Math.max(dl, dr, dt, db);
  return m === dl ? "left" : m === dr ? "right" : m === dt ? "top" : "bottom";
}

/** shortens a text to a width, with an ellipsis: a cut name beats a name on top of another */
export function fit(text: string, size: number, budget: number): string {
  if (textWidth(text, size) <= budget) return text;
  const chars = Math.max(1, Math.floor(budget / (size * 0.6)) - 1);
  return `${text.slice(0, chars)}…`;
}

export interface ChipArt {
  /** pin lines from the body edge to the pin end */
  stubs: string[];
  /** the same lines as segments, for the overlap checks */
  segments: Array<[Pt, Pt]>;
  /** small filled marks of a connector's contacts, inside the body */
  marks: string[];
  labels: SchLabel[];
}

/**
 * An IC drawn like on a datasheet: the body, a line for every pin from the
 * body to its end (where the wire attaches), the pin number on the line
 * outside the body and the pin name inside the body against the edge, the
 * designator above and the part number below.
 *
 * Before, the pins were dots floating 0.4 away from the body, with the number
 * INSIDE the body: nothing tied the wire to the chip, and a chip with only
 * numbers was a box full of digits.
 */
export function chipArt(
  box: { x: number; y: number; w: number; h: number },
  pins: ChipPin[],
  {
    name,
    subtitle,
    connector = false,
    comment = null,
  }: { name: string; subtitle: string | null; connector?: boolean; comment?: string | null },
): ChipArt {
  const stubs: string[] = [];
  const segments: Array<[Pt, Pt]> = [];
  const marks: string[] = [];
  const labels: SchLabel[] = [];
  const right = box.x + box.w;
  const bottom = box.y + box.h;
  // connector contacts take the first hundredths inside the edge
  const inset = connector ? 0.13 : 0.06;

  const captions = pins.map((p) => pinCaption(p.name, p.number));
  const widest = (side: PinSide, size: number) =>
    Math.max(0, ...pins.map((p, i) => (p.side === side && captions[i] ? textWidth(captions[i]!, size) : 0)));

  /*
   * Facing names share the body: left + right must fit in the width, top +
   * bottom in the height. If they do not, the font shrinks (down to a floor
   * that is still readable) and then the longest names are cut. Never two
   * names on top of each other.
   */
  const MIN = 0.08;
  const sizeFor = (a: PinSide, b: PinSide, span: number) => {
    const need = widest(a, SCH_TEXT.pinName) + widest(b, SCH_TEXT.pinName);
    const gap = widest(a, 1) > 0 && widest(b, 1) > 0 ? 0.1 : 0;
    const room = span - inset * 2 - gap;
    if (need <= room || need === 0) return { size: SCH_TEXT.pinName, room, gap };
    return { size: Math.max(MIN, (SCH_TEXT.pinName * room) / need), room, gap };
  };
  const horiz = sizeFor("left", "right", box.w);
  const vert = sizeFor("top", "bottom", box.h);

  let topReach = 0;
  let bottomReach = 0;
  for (const [i, p] of pins.entries()) {
    const caption = captions[i];
    const horizontal = p.side === "left" || p.side === "right";
    const edge =
      p.side === "left" ? { x: box.x, y: p.y }
      : p.side === "right" ? { x: right, y: p.y }
      : p.side === "top" ? { x: p.x, y: box.y }
      : { x: p.x, y: bottom };
    const len = Math.hypot(p.x - edge.x, p.y - edge.y);
    if (len > 1e-6) {
      stubs.push(`M${r(edge.x)} ${r(edge.y)}L${r(p.x)} ${r(p.y)}`);
      segments.push([edge, { x: p.x, y: p.y }]);
    }
    if (p.side === "top") topReach = Math.max(topReach, len);
    if (p.side === "bottom") bottomReach = Math.max(bottomReach, len);

    // number on the pin line, outside the body: where the eye looks for it
    if (len > 0.12) {
      const mid = { x: (edge.x + p.x) / 2, y: (edge.y + p.y) / 2 };
      labels.push(
        horizontal
          ? { x: mid.x, y: mid.y - 0.03, text: p.number, anchor: "middle", size: SCH_TEXT.pinNumber, tone: "number" }
          : { x: mid.x - 0.03, y: mid.y, text: p.number, anchor: "middle", size: SCH_TEXT.pinNumber, tone: "number", vertical: true },
      );
    }

    if (connector) {
      const m = 0.045;
      marks.push(
        horizontal
          ? `M${r(p.side === "left" ? box.x : right - 0.09)} ${r(p.y - m / 2)}h0.09v${m}h-0.09Z`
          : `M${r(p.x - m / 2)} ${r(p.side === "top" ? box.y : bottom - 0.09)}h${m}v0.09h${-m}Z`,
      );
    }

    if (!caption) continue;
    const metrics = horizontal ? horiz : vert;
    const size = metrics.size;
    const own = widest(p.side, size);
    const other = widest(
      horizontal ? (p.side === "left" ? "right" : "left") : p.side === "top" ? "bottom" : "top",
      size,
    );
    // this side's share of the body: all of it if the facing side is empty,
    // otherwise split in proportion to the longest names
    const share =
      other === 0
        ? metrics.room
        : own + other + metrics.gap <= metrics.room
          ? own
          : ((metrics.room - metrics.gap) * own) / (own + other);
    const text = fit(caption, size, share);
    const lift = size * 0.35; // baseline that centers the caps on the pin line
    if (p.side === "left") labels.push({ x: box.x + inset, y: p.y + lift, text, anchor: "start", size, tone: "pin" });
    else if (p.side === "right") labels.push({ x: right - inset, y: p.y + lift, text, anchor: "end", size, tone: "pin" });
    else if (p.side === "top") labels.push({ x: p.x + lift, y: box.y + inset, text, anchor: "end", size, tone: "pin", vertical: true });
    else labels.push({ x: p.x + lift, y: bottom - inset, text, anchor: "start", size, tone: "pin", vertical: true });
  }

  /*
   * Designator above, part number below: the order of every datasheet. But
   * the side with pins belongs to the pins and their labels: with pins below
   * both texts go above (designator on top), with pins above both go below,
   * and only with pins on both sides do they go past the pin ends.
   */
  const hasTop = topReach > 0;
  const hasBottom = bottomReach > 0;
  const nameS = SCH_TEXT.chipName;
  const partS = SCH_TEXT.chipPart;
  const above = (offset: number) => box.y - topReach - 0.06 - offset;
  const below = (offset: number, size: number) => bottom + bottomReach + 0.06 + size * 0.75 + offset;
  let nameY: number;
  let partY: number;
  /** where the comment goes: the line after the value, wherever that stack is */
  let commentY: number;
  const commentS = SCH_TEXT.comment;
  const commentLine = comment ? commentS + 0.06 : 0;
  if (hasBottom && !hasTop) {
    // everything above: the comment is the last line, the one next to the body
    commentY = above(0);
    partY = above(commentLine);
    nameY = above(commentLine + (subtitle ? partS + 0.06 : 0));
  } else if (hasTop && !hasBottom) {
    nameY = below(0, nameS);
    partY = below(nameS * 0.95 + 0.04, partS);
    commentY = below(nameS * 0.95 + 0.04 + (subtitle ? partS * 0.95 + 0.04 : 0), commentS);
  } else if (hasTop && hasBottom) {
    /*
     * Pins all around: outside there is no free side, and a designator past
     * the pin ends lands among the net labels. A big IC has room in the
     * middle of its body, between the pin names: that is where it goes, like
     * on the drawings of a microcontroller.
     */
    const free = {
      x0: box.x + inset + widest("left", horiz.size) + 0.1,
      x1: right - inset - widest("right", horiz.size) - 0.1,
      y0: box.y + inset + widest("top", vert.size) + 0.1,
      y1: bottom - inset - widest("bottom", vert.size) - 0.1,
    };
    // a long part number may shrink a little to fit, not below readable
    const roomW = free.x1 - free.x0;
    const innerPartS = subtitle ? Math.min(partS, roomW / Math.max(1, subtitle.length * 0.6)) : partS;
    // the comment is a third line, only when it fits under the other two
    const commentS = SCH_TEXT.comment;
    const withComment = comment !== null && free.y1 - free.y0 >= nameS + (subtitle ? innerPartS + 0.08 : 0) + commentS + 0.08;
    const lines = nameS + (subtitle ? innerPartS + 0.08 : 0) + (withComment ? commentS + 0.08 : 0);
    if (roomW >= textWidth(name, nameS) && innerPartS >= 0.09 && free.y1 - free.y0 >= lines) {
      const cx = (free.x0 + free.x1) / 2;
      const top = (free.y0 + free.y1) / 2 - lines / 2;
      labels.push({ x: cx, y: top + nameS * 0.75, text: name, anchor: "middle", size: nameS, tone: "name", fixed: true });
      if (subtitle) {
        labels.push({
          x: cx,
          y: top + nameS + 0.08 + innerPartS * 0.75,
          text: subtitle,
          anchor: "middle",
          size: innerPartS,
          tone: "value",
          fixed: true,
        });
      }
      if (withComment && comment) {
        const text = fit(comment, commentS, roomW);
        labels.push({
          x: cx,
          y: top + nameS + (subtitle ? innerPartS + 0.08 : 0) + 0.08 + commentS * 0.75,
          text,
          anchor: "middle",
          size: commentS,
          tone: "comment",
          fixed: true,
          ...(text !== comment ? { full: comment } : {}),
        });
      } else if (comment) {
        // no room inside: under the body, past the pin ends
        labels.push(commentLabel(comment, box.x, below(0, commentS), Math.max(box.w, 1.8)));
      }
      return { stubs, segments, marks, labels };
    }
    nameY = above(0);
    partY = below(0, partS);
    commentY = below(subtitle ? partS * 0.95 + 0.04 : 0, commentS);
  } else {
    nameY = above(0);
    partY = below(0, partS);
    commentY = below(subtitle ? partS * 0.95 + 0.04 : 0, commentS);
  }
  labels.push({ x: box.x, y: nameY, text: name, anchor: "start", size: nameS, tone: "name" });
  if (subtitle) {
    labels.push({ x: box.x, y: partY, text: subtitle, anchor: "start", size: partS, tone: "value" });
  }
  if (comment) labels.push(commentLabel(comment, box.x, commentY, Math.max(box.w, 1.8)));
  return { stubs, segments, marks, labels };
}

/**
 * The one-line comment of a part: small, under designator and value, cut
 * with an ellipsis to the width given. Never fixed: the overlap pass may move
 * it, and drops it rather than letting it cover a pin or a wire.
 */
export function commentLabel(
  comment: string,
  x: number,
  y: number,
  budget: number,
  anchor: SchLabel["anchor"] = "start",
): SchLabel {
  const size = SCH_TEXT.comment;
  const text = fit(comment, size, budget);
  return { x, y, text, anchor, size, tone: "comment", ...(text !== comment ? { full: comment } : {}) };
}

export type NetLabelShape = "flag" | "ground" | "rail";

export interface NetLabelArt {
  /** outline of the flag, or the lines of the power symbol */
  outline: string;
  /** the flag is a closed shape to fill; a power symbol is only strokes */
  closed: boolean;
  text: Pick<SchLabel, "x" | "y" | "anchor" | "size" | "vertical">;
  box: Box;
}

const DIRS: Record<PinSide, Pt> = {
  // anchor_side says where the anchor sits ON the label: the label grows the other way
  left: { x: 1, y: 0 },
  right: { x: -1, y: 0 },
  top: { x: 0, y: 1 },
  bottom: { x: 0, y: -1 },
};

/**
 * A net label as it is drawn on paper.
 *
 * - flag: the name inside a tag whose point touches the pin, so you see at
 *   once that it is a connection and where it attaches (a bare text next to a
 *   pin reads as a caption of the pin).
 * - ground: the three bars, the name under them (AGND and GND are different nets).
 * - rail: a T bar with the rail name beyond it (VBAT, P3V3).
 */
export function netLabelArt(attach: Pt, side: PinSide, shape: NetLabelShape, text: string): NetLabelArt {
  const d = DIRS[side];
  const n = { x: -d.y, y: d.x }; // perpendicular
  const at = (u: number, v: number): Pt => ({ x: attach.x + d.x * u + n.x * v, y: attach.y + d.y * u + n.y * v });
  const path = (pts: Pt[], close = false) =>
    pts.map((p, i) => `${i === 0 ? "M" : "L"}${r(p.x)} ${r(p.y)}`).join("") + (close ? "Z" : "");
  const vertical = d.x === 0;
  const horizontal = !vertical;

  if (shape === "flag") {
    const size = SCH_TEXT.netLabel;
    const h = 0.17;
    const tip = h / 2;
    const pad = 0.05;
    const len = tip + pad * 2 + textWidth(text, size);
    const outline = path([at(0, 0), at(tip, h / 2), at(len, h / 2), at(len, -h / 2), at(tip, -h / 2)], true);
    const c = at(tip + pad + textWidth(text, size) / 2, 0);
    const label = horizontal
      ? { x: c.x, y: c.y + size * 0.35, anchor: "middle" as const, size }
      : { x: c.x + size * 0.35, y: c.y, anchor: "middle" as const, size, vertical: true };
    return { outline, closed: true, text: label, box: boxOf([at(0, 0), at(len, h / 2), at(len, -h / 2)]) };
  }

  const size = SCH_TEXT.powerLabel;
  let outline: string;
  let reach: number;
  if (shape === "ground") {
    const stem = 0.1;
    outline =
      path([at(0, 0), at(stem, 0)]) +
      path([at(stem, -0.12), at(stem, 0.12)]) +
      path([at(stem + 0.045, -0.075), at(stem + 0.045, 0.075)]) +
      path([at(stem + 0.09, -0.03), at(stem + 0.09, 0.03)]);
    reach = stem + 0.09;
  } else {
    const stem = 0.12;
    outline = path([at(0, 0), at(stem, 0)]) + path([at(stem, -0.1), at(stem, 0.1)]);
    reach = stem;
  }
  // the name beyond the symbol, always read horizontally: a rail name is
  // looked up at a glance, it must not need tilting the head
  let label: NetLabelArt["text"];
  const beyond = at(reach + 0.06, 0);
  if (side === "top") label = { x: beyond.x, y: beyond.y + size * 0.75, anchor: "middle", size };
  else if (side === "bottom") label = { x: beyond.x, y: beyond.y - size * 0.15, anchor: "middle", size };
  else if (side === "left") label = { x: beyond.x, y: beyond.y + size * 0.35, anchor: "start", size };
  else label = { x: beyond.x, y: beyond.y + size * 0.35, anchor: "end", size };
  const tb = textBox({ ...label, text });
  const sym = boxOf([at(0, 0), at(reach, -0.12), at(reach, 0.12)]);
  return {
    outline,
    closed: false,
    text: label,
    box: {
      minX: Math.min(sym.minX, tb.minX),
      minY: Math.min(sym.minY, tb.minY),
      maxX: Math.max(sym.maxX, tb.maxX),
      maxY: Math.max(sym.maxY, tb.maxY),
    },
  };
}

export function boxOf(pts: Pt[]): Box {
  return {
    minX: Math.min(...pts.map((p) => p.x)),
    minY: Math.min(...pts.map((p) => p.y)),
    maxX: Math.max(...pts.map((p) => p.x)),
    maxY: Math.max(...pts.map((p) => p.y)),
  };
}

export const overlaps = (a: Box, b: Box, eps = 0): boolean =>
  a.minX < b.maxX - eps && b.minX < a.maxX - eps && a.minY < b.maxY - eps && b.minY < a.maxY - eps;

export const r = (v: number): number => Math.round(v * 1000) / 1000;
