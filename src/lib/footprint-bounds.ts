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
 *     (cad_component.size);
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

/** the body of the part on the board, when its 3D size is known */
function bodyBounds(cad: El): Bounds | null {
  const size = cad.size as { x?: unknown; y?: unknown } | undefined;
  const pos = cad.position as { x?: unknown; y?: unknown } | undefined;
  const w = fin(size?.x), h = fin(size?.y), x = fin(pos?.x), y = fin(pos?.y);
  if (w === null || h === null || x === null || y === null || w <= 0 || h <= 0) return null;
  const rot = fin((cad.rotation as { z?: unknown } | undefined)?.z) ?? 0;
  return turnedRect(x, y, w, h, rot);
}

/** the real footprint of every part, by pcb_component_id: see the top of this file */
export function footprintBoxes(circuitJson: unknown[] | null | undefined): Map<string, FootprintBox> {
  const pads = new Map<string, Bounds | null>();
  const courts = new Map<string, Bounds | null>();
  const bodies = new Map<string, Bounds | null>();
  for (const raw of circuitJson ?? []) {
    const el = raw as El;
    const cid = typeof el?.pcb_component_id === "string" ? el.pcb_component_id : null;
    if (!cid) continue;
    if (el.type === "pcb_smtpad" || el.type === "pcb_plated_hole") {
      pads.set(cid, join(pads.get(cid) ?? null, padBounds(el)));
    } else if (COURTYARD_TYPES.has(String(el.type))) {
      const s = courtyardShape(el);
      courts.set(cid, join(courts.get(cid) ?? null, s ? shapeBounds(s) : null));
    } else if (el.type === "cad_component") {
      bodies.set(cid, join(bodies.get(cid) ?? null, bodyBounds(el)));
    }
  }
  const out = new Map<string, FootprintBox>();
  for (const cid of new Set([...pads.keys(), ...courts.keys(), ...bodies.keys()])) {
    const p = pads.get(cid) ?? null;
    const c = courts.get(cid) ?? null;
    const b = bodies.get(cid) ?? null;
    if (c) out.set(cid, { ...join(c, p)!, source: "cortile" });
    else if (b) out.set(cid, { ...join(b, p)!, source: "piazzole e corpo" });
    else if (p) out.set(cid, { ...p, source: "piazzole" });
  }
  return out;
}
