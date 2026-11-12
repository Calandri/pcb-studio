/**
 * The REAL footprint of a part on the board: what it occupies, not only where
 * its copper is.
 *
 * WHY. The box the viewer lit up on hover, on selection and in "Sposta" was
 * the one tscircuit stores on pcb_component (getBoundsOfPcbComponents of
 * @tscircuit/core): pads and holes only, no courtyard, no body. On st-camera
 * 98 parts out of 243 came out smaller than their body (J7 by 3,8 mm, PIR1 by
 * 3,35 mm): whoever placed by hand saw smaller parts than they are, and put
 * them on top of each other (Niccolo', 11/11/2026: "molti componenti non hanno
 * il vero ingombro, e' fondamentale"). The viewer also drew only
 * pcb_courtyard_rect, while the boards imported from KiCad/EasyEDA carry
 * pcb_courtyard_outline: fototrappola-frontale has 222 courtyards, all
 * outlines, none on screen. And placement-quality.ts read outlines on its own:
 * two readings of the same thing.
 *
 * One reading for everyone (viewer, selection, Sposta, overlap checks):
 *  1. the courtyard, when the part has one (rect, circle, pill, outline,
 *     polygon), together with the pads, which on some parts stick out of it
 *     (crystals);
 *  2. otherwise the pads together with the body, when its size is known
 *     (cad_component.size, or, when asked, the box of its 3D model: see
 *     corpoDelPezzo);
 *  3. only as a last resort, the pads.
 * The coordinates in the Circuit JSON are already on the board (the face and
 * the rotation of the part applied by tscircuit); a rect or pill courtyard can
 * still carry its own ccw_rotation, and is turned here.
 */

import { padGeometry, padHalfExtents, pointsBounds } from "./pcb-route-model";

type El = Record<string, unknown> & { type?: unknown };

export interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export type CourtyardShape =
  | { kind: "rect"; x: number; y: number; w: number; h: number; rot: number; r?: number }
  | { kind: "circle"; x: number; y: number; r: number }
  | { kind: "poly"; points: Array<{ x: number; y: number }> };

export interface FootprintBox extends Bounds {
  /** where the extent comes from */
  source: "cortile" | "piazzole e corpo" | "piazzole";
}

const fin = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** every courtyard element type tscircuit knows */
export const COURTYARD_TYPES = new Set([
  "pcb_courtyard_rect",
  "pcb_courtyard_circle",
  "pcb_courtyard_pill",
  "pcb_courtyard_outline",
  "pcb_courtyard_polygon",
]);

/** a courtyard element as a shape to draw and measure, null when it has no usable geometry */
export function courtyardShape(el: El): CourtyardShape | null {
  const c = el.center as { x?: unknown; y?: unknown } | undefined;
  switch (el.type) {
    case "pcb_courtyard_rect":
    case "pcb_courtyard_pill": {
      const x = fin(c?.x) ?? fin(el.x);
      const y = fin(c?.y) ?? fin(el.y);
      const w = fin(el.width);
      const h = fin(el.height);
      if (x === null || y === null || w === null || h === null) return null;
      const r = fin(el.radius);
      return {
        kind: "rect",
        x,
        y,
        w,
        h,
        rot: fin(el.ccw_rotation) ?? 0,
        ...(el.type === "pcb_courtyard_pill" ? { r: r ?? Math.min(w, h) / 2 } : {}),
      };
    }
    case "pcb_courtyard_circle": {
      const x = fin(c?.x), y = fin(c?.y), r = fin(el.radius);
      if (x === null || y === null || r === null) return null;
      return { kind: "circle", x, y, r };
    }
    case "pcb_courtyard_outline":
    case "pcb_courtyard_polygon": {
      const raw = (el.type === "pcb_courtyard_outline" ? el.outline : el.points) as unknown;
      if (!Array.isArray(raw)) return null;
      const points = raw
        .map((p) => ({ x: fin((p as { x?: unknown })?.x), y: fin((p as { y?: unknown })?.y) }))
        .filter((p): p is { x: number; y: number } => p.x !== null && p.y !== null);
      return points.length >= 2 ? { kind: "poly", points } : null;
    }
    default:
      return null;
  }
}

/** the axis-aligned box of a w x h rectangle centred at (x, y) and turned by rot degrees */
function turnedRect(x: number, y: number, w: number, h: number, rot: number): Bounds {
  const a = (((rot % 360) + 360) % 360) * (Math.PI / 180);
  const cs = Math.abs(Math.cos(a)) < 1e-9 ? 0 : Math.abs(Math.cos(a));
  const sn = Math.abs(Math.sin(a)) < 1e-9 ? 0 : Math.abs(Math.sin(a));
  const hw = (w * cs + h * sn) / 2;
  const hh = (w * sn + h * cs) / 2;
  return { minX: x - hw, maxX: x + hw, minY: y - hh, maxY: y + hh };
}

export function shapeBounds(s: CourtyardShape): Bounds | null {
  if (s.kind === "rect") return turnedRect(s.x, s.y, s.w, s.h, s.rot);
  if (s.kind === "circle") return { minX: s.x - s.r, maxX: s.x + s.r, minY: s.y - s.r, maxY: s.y + s.r };
  return pointsBounds(s.points);
}

const join = (a: Bounds | null, b: Bounds | null): Bounds | null =>
  !a
    ? b
    : !b
      ? a
      : {
          minX: Math.min(a.minX, b.minX),
          maxX: Math.max(a.maxX, b.maxX),
          minY: Math.min(a.minY, b.minY),
          maxY: Math.max(a.maxY, b.maxY),
        };

/** the copper of one pad or hole, from the pad reading every module shares */
export function padBounds(el: El): Bounds | null {
  const g = padGeometry(el);
  if (!g) return null;
  const { hw, hh } = padHalfExtents(g);
  return { minX: g.x - hw, maxX: g.x + hw, minY: g.y - hh, maxY: g.y + hh };
}

/** the body of a part on the board: a w x h rectangle centred at (x, y), turned by rot degrees */
export interface Corpo {
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
}

/**
 * THE BOX A 3D MODEL DRAWS, when the model is one: a cuboid (or a rounded one),
 * alone or coloured. It is what the imports write over a footprint that comes
 * with its height (circuit-json-to-project) and what the libraries of the SBB
 * boards write for each part: on sbb-dl-principale 138 parts out of 156 carry
 * one and none carries cad_component.size, so their body was never read (BZ1:
 * a 9 x 9 mm buzzer on pads 10 x 3,4 mm). A model loaded from a file (obj,
 * step) has no size the Circuit JSON tells.
 */
function scatolaDelModello(jscad: unknown): { w: number; h: number; dx: number; dy: number } | null {
  let m = jscad as { type?: unknown; shape?: unknown; size?: unknown; center?: unknown } | null | undefined;
  if (m?.type === "colorize") m = m.shape as typeof m;
  if (m?.type !== "cuboid" && m?.type !== "roundedCuboid") return null;
  const size = Array.isArray(m.size) ? m.size : null;
  const w = fin(size?.[0]), h = fin(size?.[1]);
  if (w === null || h === null || w <= 0 || h <= 0) return null;
  const centro = Array.isArray(m.center) ? m.center : [];
  return { w, h, dx: fin(centro[0]) ?? 0, dy: fin(centro[1]) ?? 0 };
}

/** whether an angle in degrees is `a`, modulo 360 */
const vale = (gradi: number, a: number) => Math.abs(((((gradi - a) % 360) + 540) % 360) - 180) < 1e-6;

/** cosine and sine of a turn in degrees, exact on the quarter turns */
function cosSen(gradi: number): [number, number] {
  const g = ((gradi % 360) + 360) % 360;
  if (g === 0) return [1, 0];
  if (g === 90) return [0, 1];
  if (g === 180) return [-1, 0];
  if (g === 270) return [0, -1];
  const a = (g * Math.PI) / 180;
  return [Math.cos(a), Math.sin(a)];
}

/**
 * HOW A 3D MODEL LIES ON THE BOARD, from cad_component.rotation. The 3D viewer
 * (@tscircuit/3d-viewer, getCadModelTransform and useCadModelTransformGraph)
 * puts the model's point v at position + Rx(x) Ry(y) Rz(z) v, three.js Euler
 * "XYZ": turned by z first, then Ry(180) mirrors x, then Rx(180) mirrors y.
 *
 * On the bottom face tscircuit writes {x: 0, y: 180, z: -θ} for a part turned
 * by θ (pcb_component.rotation θ): measured with a compile of tscircuit
 * (12/11/2026, footprint-bounds-bottom.test.ts) and on sbb-dl-principale, where
 * every part on the bottom at 90 carries z 270. Turning by -θ and then
 * mirroring x is mirroring x and then turning by θ, which is what tscircuit
 * does to the pads of a part on the bottom: the model lands on its pads.
 *
 * Reading z as the angle of the body, as before, turned the body of a part on
 * the bottom at 45 / 135 / 225 / 315 by 90 degrees, and mirroring an off-centre
 * box before turning it by -θ put it on the other side of the origin at 90 and
 * 270: a part under the real body read clear.
 *
 * `porta` takes an offset in the model's frame to the board, `angolo` is the
 * angle of a w x h rectangle of the model once on the board. null when the
 * model is stood on a side (x or y neither 0 nor 180): its box on the board is
 * not w x h.
 */
export function modelloSullaScheda(rotazione: unknown): { porta: (dx: number, dy: number) => { x: number; y: number }; angolo: number } | null {
  const r = rotazione as { x?: unknown; y?: unknown; z?: unknown } | undefined;
  const rx = fin(r?.x) ?? 0, ry = fin(r?.y) ?? 0, z = fin(r?.z) ?? 0;
  const specchiaX = vale(ry, 180), specchiaY = vale(rx, 180);
  if ((!specchiaX && !vale(ry, 0)) || (!specchiaY && !vale(rx, 0))) return null;
  const [c, s] = cosSen(z);
  return {
    porta: (dx, dy) => {
      const u = dx * c - dy * s, v = dx * s + dy * c;
      return { x: specchiaX ? -u : u, y: specchiaY ? -v : v };
    },
    // a mirror turns a rectangle at a into one at -a; two mirrors are a half turn, the same rectangle
    angolo: specchiaX !== specchiaY ? ((-z % 360) + 360) % 360 : ((z % 360) + 360) % 360,
  };
}

/**
 * The body of a part on the board, from its cad_component: the size tscircuit
 * writes, else (`dalModello`) the box of its 3D model, laid on the board as the
 * 3D viewer lays the model (see modelloSullaScheda). null when neither says.
 */
export function corpoDelPezzo(cad: El, opts: { dalModello?: boolean } = {}): Corpo | null {
  const pos = cad.position as { x?: unknown; y?: unknown } | undefined;
  const x = fin(pos?.x), y = fin(pos?.y);
  if (x === null || y === null) return null;
  const giacitura = modelloSullaScheda(cad.rotation);
  if (!giacitura) return null;
  const size = cad.size as { x?: unknown; y?: unknown } | undefined;
  const w = fin(size?.x), h = fin(size?.y);
  if (w !== null && h !== null && w > 0 && h > 0) return { x, y, w, h, rot: giacitura.angolo };
  if (!opts.dalModello) return null;
  const s = scatolaDelModello(cad.model_jscad);
  if (!s) return null;
  // a box off the model's origin travels with the model
  const d = giacitura.porta(s.dx, s.dy);
  return { x: x + d.x, y: y + d.y, w: s.w, h: s.h, rot: giacitura.angolo };
}

/** the body of the part on the board, when its size is known */
function bodyBounds(cad: El, dalModello: boolean): Bounds | null {
  const c = corpoDelPezzo(cad, { dalModello });
  return c ? turnedRect(c.x, c.y, c.w, c.h, c.rot) : null;
}

/** what a part's footprint is read from, element by element, and the box it comes to */
export interface FootprintPart {
  box: FootprintBox;
  /** its courtyards, as shapes */
  courtyards: CourtyardShape[];
  /** its SMT pads and plated holes */
  pads: El[];
  /** its body, when known */
  body: Corpo | null;
}

/**
 * Options of the reading. `corpiDaiModelli`: the body of a part with no
 * cad_component.size is the box of its 3D model, when the model is a box (see
 * scatolaDelModello). Off unless asked: the viewer and the placement check read
 * the size alone, as before.
 */
export interface FootprintOptions {
  corpiDaiModelli?: boolean;
}

/** the real footprint of every part, by pcb_component_id, with what it is read from: see the top of this file */
export function footprintParts(circuitJson: unknown[] | null | undefined, opts: FootprintOptions = {}): Map<string, FootprintPart> {
  const pads = new Map<string, Bounds | null>();
  const courts = new Map<string, Bounds | null>();
  const bodies = new Map<string, Bounds | null>();
  const padEls = new Map<string, El[]>();
  const courtShapes = new Map<string, CourtyardShape[]>();
  const bodyOf = new Map<string, Corpo>();
  const dalModello = opts.corpiDaiModelli === true;
  for (const raw of circuitJson ?? []) {
    const el = raw as El;
    const cid = typeof el?.pcb_component_id === "string" ? el.pcb_component_id : null;
    if (!cid) continue;
    if (el.type === "pcb_smtpad" || el.type === "pcb_plated_hole") {
      pads.set(cid, join(pads.get(cid) ?? null, padBounds(el)));
      padEls.set(cid, [...(padEls.get(cid) ?? []), el]);
    } else if (COURTYARD_TYPES.has(String(el.type))) {
      const s = courtyardShape(el);
      courts.set(cid, join(courts.get(cid) ?? null, s ? shapeBounds(s) : null));
      if (s) courtShapes.set(cid, [...(courtShapes.get(cid) ?? []), s]);
    } else if (el.type === "cad_component") {
      bodies.set(cid, join(bodies.get(cid) ?? null, bodyBounds(el, dalModello)));
      const c = corpoDelPezzo(el, { dalModello });
      if (c && !bodyOf.has(cid)) bodyOf.set(cid, c);
    }
  }
  const out = new Map<string, FootprintPart>();
  for (const cid of new Set([...pads.keys(), ...courts.keys(), ...bodies.keys()])) {
    const p = pads.get(cid) ?? null;
    const c = courts.get(cid) ?? null;
    const b = bodies.get(cid) ?? null;
    const box: FootprintBox | null = c
      ? { ...join(c, p)!, source: "cortile" }
      : b
        ? { ...join(b, p)!, source: "piazzole e corpo" }
        : p
          ? { ...p, source: "piazzole" }
          : null;
    if (box) out.set(cid, { box, courtyards: courtShapes.get(cid) ?? [], pads: padEls.get(cid) ?? [], body: bodyOf.get(cid) ?? null });
  }
  return out;
}

/** the real footprint of every part, by pcb_component_id: see the top of this file */
export function footprintBoxes(circuitJson: unknown[] | null | undefined, opts: FootprintOptions = {}): Map<string, FootprintBox> {
  const out = new Map<string, FootprintBox>();
  for (const [cid, part] of footprintParts(circuitJson, opts)) out.set(cid, part.box);
  return out;
}
