import { rerouteZone, type Zone } from "./rip-up";
import { SOLVERS, type VariantDef } from "./variants";
import { stitchToPlanes } from "./house-rules";
import { resolveDesignRules } from "./design-rules";
import { parseManualEdits } from "./manual-edits";
import { applyManualRoutes } from "./manual-routes";
import { summarizeCircuit } from "./compile";
import type { CircuitElement } from "./route-score";

/**
 * FAST application of manual moves.
 *
 * A full compile redoes placement + routing of the whole board: minutes. For
 * "I moved a component by two millimetres" that is absurd. Here instead we
 * work on the already compiled board: the component (with pads, holes, ports
 * and silkscreen) is translated inside the cached circuit, the copper of the
 * affected zone is ripped up and redone by the solver (rip-up.ts), the rest
 * of the board does not move. Seconds, not minutes.
 *
 * Honest limits, which the caller handles by falling back to a full compile:
 * - rotations only in multiples of 90 degrees (rectangular pads stay rectangles);
 * - the component must exist in the cache (board never compiled = nothing);
 * - the redone copper is local: for global quality there is still the full
 *   compile, which indeed stays available on explicit request.
 */

type El = Record<string, unknown>;
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** two solvers are enough: the fast one and the stubborn one; v3 as backup */
const DEFS: VariantDef[] = [
  { solver: "v6", SolverClass: SOLVERS.v6, effort: 1 },
  { solver: "v6", SolverClass: SOLVERS.v6, effort: 5 },
  { solver: "v3", SolverClass: SOLVERS.v3, effort: 1 },
];

const rot90 = (dRot: number) => dRot === 90 || dRot === 270;

/** rotates a point around a center, then translates (the same math as the canvas) */
function movePoint(
  x: number,
  y: number,
  cx: number,
  cy: number,
  dRot: number,
  dx: number,
  dy: number,
): { x: number; y: number } {
  const rad = (dRot * Math.PI) / 180;
  const rx = cx + (x - cx) * Math.cos(rad) - (y - cy) * Math.sin(rad);
  const ry = cy + (x - cx) * Math.sin(rad) + (y - cy) * Math.cos(rad);
  return { x: rx + dx, y: ry + dy };
}

/** rectangular element: repositions it and, if needed, swaps width/height */
function moveRect(el: El, keys: { w: string; h: string }, cx: number, cy: number, dRot: number, dx: number, dy: number) {
  const x = num(el.x);
  const y = num(el.y);
  if (x !== null && y !== null) {
    const p = movePoint(x, y, cx, cy, dRot, dx, dy);
    el.x = p.x;
    el.y = p.y;
  }
  /*
   * A polygon pad has no x/y: its shape IS a list of vertices, in absolute
   * coordinates. Moving only x/y left those pads exactly where they were while
   * the rest of the component travelled — the part visibly broke apart, and the
   * four ground pads of a MEMS microphone stayed behind on the board. Every
   * vertex has to travel with the component, and rotate around the same centre.
   */
  const points = el.points as Array<{ x?: unknown; y?: unknown }> | undefined;
  if (Array.isArray(points) && points.length > 0) {
    el.points = points.map((pt) => {
      const px = num(pt.x);
      const py = num(pt.y);
      if (px === null || py === null) return pt;
      return { ...pt, ...movePoint(px, py, cx, cy, dRot, dx, dy) };
    });
  }
  if (rot90(dRot)) {
    const w = el[keys.w];
    el[keys.w] = el[keys.h];
    el[keys.h] = w;
  }
}

interface MovedComponent {
  name: string;
  from: { x: number; y: number };
  to: { x: number; y: number };
  dRot: number;
  w: number;
  h: number;
}

/**
 * Translates the hand-pinned components inside the compiled circuit.
 * Returns null if something cannot be done locally (the caller recompiles).
 */
export function applyPlacementsToCircuit(
  circuitJson: unknown[],
  manualEditsRaw: string | undefined,
): { circuitJson: CircuitElement[]; moved: MovedComponent[] } | null {
  const edits = parseManualEdits(manualEditsRaw);
  if (edits.pcb_placements.length === 0) return null;

  const elements = circuitJson as El[];
  const nameBySource = new Map<string, string>();
  for (const el of elements) {
    if (el.type === "source_component" && el.source_component_id) {
      nameBySource.set(String(el.source_component_id), String(el.name ?? ""));
    }
  }

  const byId = new Map<string, El>();
  for (const el of elements) {
    if (el.type === "pcb_component" && el.pcb_component_id) {
      byId.set(String(el.pcb_component_id), el);
    }
  }

  const out = structuredClone(elements) as El[];
  const moved: MovedComponent[] = [];

  for (const placement of edits.pcb_placements) {
    const comp = out.find(
      (el) =>
        el.type === "pcb_component" &&
        nameBySource.get(String(el.source_component_id ?? "")) === placement.selector,
    );
    if (!comp) return null;
    const center = (comp.center as { x?: number; y?: number } | undefined) ?? {};
    const centerX = num(center.x);
    const centerY = num(center.y);
    if (centerX === null || centerY === null) return null;
    /*
     * The pivot is the ORIGIN of the component, not its centre.
     *
     * `display_offset` is the position that was REQUESTED (pcbX/pcbY);
     * `center` is where the copper ended up, and the two differ by the offset
     * of the footprint — on the MEMS microphones 0,28 mm, on the USB connector
     * 0,26 mm. tscircuit rotates the footprint around the origin: U4 turned by
     * 180° has its centre on the opposite side of the origin from U3, which is
     * not turned. Rotating around the centre here meant showing one board and
     * saving another: the part turned on screen, then moved by the offset at
     * the next compile. Same story for the translation: the saved placement is
     * a requested ORIGIN, so the displacement is measured from the origin.
     */
    const originX = num(comp.display_offset_x) ?? centerX;
    const originY = num(comp.display_offset_y) ?? centerY;
    const cx = originX;
    const cy = originY;
    const r0 = num(comp.rotation) ?? 0;
    const dRot = (((Number(placement.rotation ?? r0) - r0) % 360) + 360) % 360;
    if (dRot % 90 !== 0) return null;
    const dx = placement.center.x - originX;
    const dy = placement.center.y - originY;
    if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9 && dRot === 0) continue;
    const compId = String(comp.pcb_component_id);

    // the component itself: the centre travels like every other point of it
    const nuovoCentro = movePoint(centerX, centerY, cx, cy, dRot, dx, dy);
    comp.center = { x: nuovoCentro.x, y: nuovoCentro.y };
    /*
     * The origin follows too, otherwise it stays where the part was: and the
     * origin is exactly what "fissa le posizioni" writes into the placements.
     * Leaving it behind meant saving the OLD position — you moved a component,
     * you saved, and it went back where it was.
     */
    comp.display_offset_x = placement.center.x;
    comp.display_offset_y = placement.center.y;
    comp.rotation = (r0 + dRot) % 360;
    if (rot90(dRot)) {
      const w = comp.width;
      comp.width = comp.height;
      comp.height = w;
    }

    // everything that belongs to it: pads, holes, ports, silkscreen, courtyard, paste
    for (const el of out) {
      if (String(el.pcb_component_id ?? "") !== compId || el === comp) continue;
      switch (el.type) {
        case "pcb_smtpad":
        case "pcb_solder_paste":
          moveRect(el, { w: "width", h: "height" }, cx, cy, dRot, dx, dy);
          break;
        case "pcb_plated_hole":
        case "pcb_hole":
          moveRect(el, { w: "rect_pad_width", h: "rect_pad_height" }, cx, cy, dRot, dx, dy);
          break;
        case "pcb_courtyard_rect": {
          const c = (el.center as { x?: number; y?: number } | undefined) ?? {};
          const ex = num(c.x) ?? num(el.x);
          const ey = num(c.y) ?? num(el.y);
          if (ex !== null && ey !== null) {
            const p = movePoint(ex, ey, cx, cy, dRot, dx, dy);
            el.center = { x: p.x, y: p.y };
          }
          if (rot90(dRot)) {
            const w = el.width;
            el.width = el.height;
            el.height = w;
          }
          break;
        }
        case "pcb_silkscreen_text": {
          const a = (el.anchor_position as { x?: number; y?: number } | undefined) ?? {};
          const ax = num(a.x);
          const ay = num(a.y);
          if (ax !== null && ay !== null) {
            el.anchor_position = movePoint(ax, ay, cx, cy, dRot, dx, dy);
          }
          el.ccw_rotation = ((num(el.ccw_rotation) ?? 0) + dRot) % 360;
          break;
        }
        case "pcb_silkscreen_path": {
          const route = (el.route as Array<Record<string, unknown>> | undefined) ?? [];
          for (const p of route) {
            const px = num(p.x);
            const py = num(p.y);
            if (px === null || py === null) continue;
            const q = movePoint(px, py, cx, cy, dRot, dx, dy);
            p.x = q.x;
            p.y = q.y;
          }
          break;
        }
        case "pcb_port": {
          const px = num(el.x);
          const py = num(el.y);
          if (px !== null && py !== null) {
            const q = movePoint(px, py, cx, cy, dRot, dx, dy);
            el.x = q.x;
            el.y = q.y;
          }
          break;
        }
      }
    }

    moved.push({
      name: placement.selector,
      // the zone to rip up is measured on the COPPER, so between centres
      from: { x: centerX, y: centerY },
      to: { x: nuovoCentro.x, y: nuovoCentro.y },
      dRot,
      w: num(comp.width) ?? 2,
      h: num(comp.height) ?? 2,
    });
  }

  return { circuitJson: out as CircuitElement[], moved };
}

/** rectangle covering the old and new positions of every moved part */
function zoneFromMoved(moved: MovedComponent[], board: { width: number; height: number; centerX: number; centerY: number }): Zone {
  const MARGIN = 8;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const m of moved) {
    for (const p of [m.from, m.to]) {
      minX = Math.min(minX, p.x - m.w / 2);
      maxX = Math.max(maxX, p.x + m.w / 2);
      minY = Math.min(minY, p.y - m.h / 2);
      maxY = Math.max(maxY, p.y + m.h / 2);
    }
  }
  const bx0 = board.centerX - board.width / 2;
  const by0 = board.centerY - board.height / 2;
  return {
    minX: Math.max(bx0, minX - MARGIN),
    maxX: Math.min(bx0 + board.width, maxX + MARGIN),
    minY: Math.max(by0, minY - MARGIN),
    maxY: Math.min(by0 + board.height, maxY + MARGIN),
    problems: 1,
    reasons: ["moved_component"],
  };
}

export interface RerouteLocalResult {
  ok: boolean;
  reason?: string;
  moved: number;
  rerouted: boolean;
  /** connections with a hand-drawn trace applied */
  manualRoutes: number;
  drc: number | null;
  summary: unknown;
}

/**
 * The full round trip: positions from manual-edits -> updated circuit ->
 * zone rip-up and re-stitch -> hand-drawn traces applied on top (they always
 * win, they are the user's will) -> stitching to the plane -> summary.
 * Saves nothing: the caller decides (and saves the cache).
 */
export function rerouteLocal(
  circuitJson: unknown[],
  fsMap: Record<string, string>,
  manualEditsRaw: string | undefined,
): { circuitJson: CircuitElement[]; result: Omit<RerouteLocalResult, "summary"> } | null {
  const edits = parseManualEdits(manualEditsRaw);
  const applied = applyPlacementsToCircuit(circuitJson, manualEditsRaw);
  // no moves but there are hand-drawn traces: just apply them
  if (!applied || applied.moved.length === 0) {
    if (edits.pcb_routes.length === 0) return null;
    const rules = resolveDesignRules(fsMap).rules;
    const routed = applyManualRoutes({ circuitJson, routes: edits.pcb_routes });
    const next = stitchToPlanes(routed.circuitJson as never, rules) as unknown as CircuitElement[];
    return {
      circuitJson: next,
      result: { ok: true, moved: 0, rerouted: false, manualRoutes: routed.applied.length, drc: null },
    };
  }

  const rules = resolveDesignRules(fsMap).rules;
  const boardEl = (applied.circuitJson as El[]).find((e) => e.type === "pcb_board");
  const bc = (boardEl?.center as { x?: number; y?: number } | undefined) ?? {};
  const board = {
    width: num(boardEl?.width) ?? 100,
    height: num(boardEl?.height) ?? 100,
    centerX: num(bc.x) ?? 0,
    centerY: num(bc.y) ?? 0,
  };
  const zone = zoneFromMoved(applied.moved, board);

  let next = applied.circuitJson;
  let rerouted = false;
  let drc: number | null = null;
  const redone = rerouteZone(next, zone, DEFS, rules);
  if (redone) {
    next = redone.circuitJson;
    rerouted = true;
    drc = redone.drc;
  }
  /*
   * Hand-drawn traces are applied AFTER the zone rip-up: their geometry is
   * explicit intent and wins over any copper the solver redid around it. If
   * one touches a moved pad it stays attached to the old position: the check
   * flags it and it gets redrawn — never silently delete it.
   */
  const routed = applyManualRoutes({ circuitJson: next, routes: edits.pcb_routes });
  next = routed.circuitJson as CircuitElement[];
  next = stitchToPlanes(next as never, rules) as unknown as CircuitElement[];

  return {
    circuitJson: next,
    result: {
      ok: true,
      moved: applied.moved.length,
      rerouted,
      manualRoutes: routed.applied.length,
      drc,
    },
  };
}

export { summarizeCircuit };
