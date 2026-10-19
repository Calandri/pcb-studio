import { rerouteZoneDetailed, type Zone } from "./rip-up";
import { SOLVERS, type VariantDef } from "./variants";
import { stitchToPlanes } from "./house-rules";
import { resolveDesignRules } from "./design-rules";
import { findOrphanEdits, normalizeRotation, parseManualEdits, type OrphanEdits } from "./manual-edits";
import { parentFrameOffset, parseLength } from "./pcb-route-model";
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
  // exact quarter turns: cos(90°) is 6e-17, and that drifts a pad off-axis
  const c = rot90(dRot) ? 0 : dRot === 180 ? -1 : dRot === 0 ? 1 : Math.cos(rad);
  const s = dRot === 90 ? 1 : dRot === 270 ? -1 : dRot === 0 || dRot === 180 ? 0 : Math.sin(rad);
  const rx = cx + (x - cx) * c - (y - cy) * s;
  const ry = cy + (x - cx) * s + (y - cy) * c;
  return { x: rx + dx, y: ry + dy };
}

/** a vector (an offset relative to its element) only turns, it does not travel */
function turnVector(x: number, y: number, dRot: number): { x: number; y: number } {
  return movePoint(x, y, 0, 0, dRot, 0, 0);
}

/** sizes that trade places when the part turns a quarter */
const SWAPPED_ON_QUARTER: Array<[string, string]> = [
  ["width", "height"],
  ["outer_width", "outer_height"],
  ["hole_width", "hole_height"],
  ["rect_pad_width", "rect_pad_height"],
  ["radius_x", "radius_y"],
];

/** absolute point lists an element may carry */
const POINT_LISTS = ["points", "route", "outline"] as const;
/** absolute single points */
const POINT_FIELDS = ["center", "anchor_position", "from", "to"] as const;
/** element kinds whose orientation is a READING direction, not a symmetric shape */
const TEXT_TYPES = new Set([
  "pcb_silkscreen_text",
  "pcb_fabrication_note_text",
  "pcb_note_text",
]);

/**
 * Moves ONE element that belongs to a moved part, whatever it is.
 *
 * It used to be a switch over the five kinds somebody had met: pill and oval
 * plated holes kept their size on a quarter turn (the USB-C shell holes
 * pointing the wrong way), hole offsets stayed where they were, silkscreen
 * lines, rects and circles, courtyard outlines and polygons and fab notes did
 * not move at all. Here every position an element can carry travels: x/y,
 * x1/y1 and x2/y2, centre, anchor, from/to, every point of `points`, `route`
 * and `outline`; relative vectors (hole offsets, a polygon pad's outline,
 * a dimension's direction) turn; sizes swap on a quarter turn.
 *
 * A shape's own `ccw_rotation` is left alone and the sizes swap instead: a
 * pill w×h turned by 90° is the pill h×w, for a reader that honours the
 * rotation field and for one that ignores it. Text is the exception, because
 * its orientation is the reading direction: its rotation adds up.
 */
function moveElement(el: El, cx: number, cy: number, dRot: number, dx: number, dy: number): void {
  const move = (x: unknown, y: unknown) => {
    const px = num(x), py = num(y);
    return px === null || py === null ? null : movePoint(px, py, cx, cy, dRot, dx, dy);
  };
  const p = move(el.x, el.y);
  if (p) {
    el.x = p.x;
    el.y = p.y;
  }
  const p1 = move(el.x1, el.y1);
  if (p1) {
    el.x1 = p1.x;
    el.y1 = p1.y;
  }
  const p2 = move(el.x2, el.y2);
  if (p2) {
    el.x2 = p2.x;
    el.y2 = p2.y;
  }
  for (const key of POINT_FIELDS) {
    const v = el[key] as { x?: unknown; y?: unknown } | undefined;
    if (!v || typeof v !== "object") continue;
    const q = move(v.x, v.y);
    if (q) el[key] = { ...v, ...q };
  }
  for (const key of POINT_LISTS) {
    const list = el[key];
    if (!Array.isArray(list)) continue;
    el[key] = list.map((pt: Record<string, unknown>) => {
      const q = pt && typeof pt === "object" ? move(pt.x, pt.y) : null;
      return q ? { ...pt, ...q } : pt;
    });
  }
  if (dRot === 0) return;

  // relative vectors: they turn with the part
  const hx = num(el.hole_offset_x), hy = num(el.hole_offset_y);
  if (hx !== null && hy !== null && (hx !== 0 || hy !== 0)) {
    const v = turnVector(hx, hy, dRot);
    el.hole_offset_x = v.x;
    el.hole_offset_y = v.y;
  }
  if (Array.isArray(el.pad_outline)) {
    el.pad_outline = (el.pad_outline as Array<Record<string, unknown>>).map((pt) => {
      const px = num(pt?.x), py = num(pt?.y);
      return px === null || py === null ? pt : { ...pt, ...turnVector(px, py, dRot) };
    });
  }
  const dir = el.offset_direction as { x?: unknown; y?: unknown } | undefined;
  if (dir && num(dir.x) !== null && num(dir.y) !== null) {
    el.offset_direction = turnVector(num(dir.x)!, num(dir.y)!, dRot);
  }

  if (TEXT_TYPES.has(String(el.type))) {
    el.ccw_rotation = (((num(el.ccw_rotation) ?? 0) + dRot) % 360 + 360) % 360;
  }
  if (num(el.text_ccw_rotation) !== null) {
    el.text_ccw_rotation = ((num(el.text_ccw_rotation)! + dRot) % 360 + 360) % 360;
  }
  if (rot90(dRot) && !TEXT_TYPES.has(String(el.type))) {
    for (const [a, b] of SWAPPED_ON_QUARTER) {
      if (el[a] === undefined && el[b] === undefined) continue;
      const w = el[a];
      el[a] = el[b];
      el[b] = w;
    }
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

export interface PlacementApplication {
  circuitJson: CircuitElement[];
  moved: MovedComponent[];
  /** placements naming a part that is not on this board: skipped, not fatal */
  orphans: string[];
  /** set when a placement cannot be applied here at all: the caller must compile */
  error?: string;
}

/**
 * Translates the hand-pinned components inside the compiled circuit.
 *
 * A placement for a part that is not on the board (renamed, removed) is
 * skipped and reported, and the others are applied: one stale name used to
 * throw the whole local update away. A rotation that is not a quarter turn
 * cannot be done on cached geometry and is an `error`: the caller says so and
 * the user compiles.
 */
export function applyPlacementsToCircuit(
  circuitJson: unknown[],
  manualEditsRaw: string | null | undefined,
): PlacementApplication | null {
  const edits = parseManualEdits(manualEditsRaw);
  if (edits.pcb_placements.length === 0) return null;

  const elements = circuitJson as El[];
  const nameBySource = new Map<string, string>();
  for (const el of elements) {
    if (el.type === "source_component" && el.source_component_id) {
      nameBySource.set(String(el.source_component_id), String(el.name ?? ""));
    }
  }

  const out = structuredClone(elements) as El[];
  const moved: MovedComponent[] = [];
  const orphans: string[] = [];

  const byComponent = new Map<string, El[]>();
  for (const el of out) {
    const id = el.pcb_component_id;
    if (typeof id !== "string" || el.type === "pcb_component") continue;
    if (typeof el.type !== "string" || !el.type.startsWith("pcb_")) continue;
    // errors and warnings are recomputed, they are not geometry of the part
    if (/_(error|warning)$/.test(el.type)) continue;
    byComponent.set(id, [...(byComponent.get(id) ?? []), el]);
  }

  for (const placement of edits.pcb_placements) {
    const comp = out.find(
      (el) =>
        el.type === "pcb_component" &&
        nameBySource.get(String(el.source_component_id ?? "")) === placement.selector,
    );
    const center = (comp?.center as { x?: number; y?: number } | undefined) ?? {};
    const centerX = num(center.x);
    const centerY = num(center.y);
    if (!comp || centerX === null || centerY === null) {
      orphans.push(placement.selector);
      continue;
    }
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
     *
     * The requested origin is relative to the parent group, the geometry is
     * in board coordinates: the pivot is the origin PLUS the group's own, or a
     * part inside <group pcbX={10}> turned around a point ten millimetres off.
     */
    const frame = parentFrameOffset(elements, comp);
    const originRelX = parseLength(comp.display_offset_x);
    const originRelY = parseLength(comp.display_offset_y);
    const originX = originRelX ?? centerX - frame.x;
    const originY = originRelY ?? centerY - frame.y;
    const cx = originRelX !== null ? originRelX + frame.x : centerX;
    const cy = originRelY !== null ? originRelY + frame.y : centerY;
    const r0 = normalizeRotation(comp.rotation) ?? 0;
    const target = normalizeRotation(placement.rotation ?? r0) ?? r0;
    /*
     * Rounded before the test: 90.0000000001 out of a float sum is a quarter
     * turn, and `% 90 !== 0` sent it to a full compile.
     */
    const rawRot = Math.round((((target - r0) % 360) + 360) % 360 * 1e6) / 1e6;
    const quarter = Math.round(rawRot / 90) * 90;
    if (Math.abs(rawRot - quarter) > 1e-6) {
      return {
        circuitJson: out as CircuitElement[],
        moved,
        orphans,
        error: `${placement.selector} va ruotato di ${rawRot}°: qui si fanno solo quarti di giro, serve una compilazione completa`,
      };
    }
    const dRot = quarter % 360;
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

    // everything that belongs to it: pads, holes, ports, silkscreen, courtyard, paste, notes
    for (const el of byComponent.get(compId) ?? []) moveElement(el, cx, cy, dRot, dx, dy);

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

  return { circuitJson: out as CircuitElement[], moved, orphans };
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
  /** hand routes added as a further branch of their net */
  manualBranches: number;
  drc: number | null;
  /** edits that point at nothing on this board (renamed or removed parts, gone connections) */
  orphans: OrphanEdits;
  summary: unknown;
}

/**
 * The full round trip: positions from manual-edits -> updated circuit ->
 * zone rip-up and re-stitch -> hand-drawn traces applied on top (they always
 * win, they are the user's will) -> stitching to the plane -> summary.
 * Saves nothing: the caller decides (and saves the cache).
 *
 * `circuitJson` is null whenever `ok` is false: there is nothing that may be
 * saved. It used to answer ok with zero moves when a placement could not be
 * applied and hand routes existed, and to save moved pads with the OLD copper
 * when the zone could not be rerouted — a board that looked updated and was
 * not.
 */
export function rerouteLocal(
  circuitJson: unknown[],
  fsMap: Record<string, string>,
  manualEditsRaw: string | null | undefined,
): { circuitJson: CircuitElement[] | null; result: Omit<RerouteLocalResult, "summary"> } {
  const edits = parseManualEdits(manualEditsRaw);
  const orphans = findOrphanEdits(circuitJson, edits);
  const rules = resolveDesignRules(fsMap).rules;
  const vias = { viaDiameter: rules.minViaDiameterMm, viaHoleDiameter: rules.minViaHoleMm };
  const fail = (reason: string, moved = 0) => ({
    circuitJson: null,
    result: { ok: false, reason, moved, rerouted: false, manualRoutes: 0, manualBranches: 0, drc: null, orphans },
  });

  const applied = applyPlacementsToCircuit(circuitJson, manualEditsRaw);
  if (applied?.error) return fail(applied.error);

  // no moves: there may be hand-drawn traces to apply, or nothing at all
  if (!applied || applied.moved.length === 0) {
    if (edits.pcb_routes.length === 0) {
      return fail(
        orphans.pcb_placements.length > 0
          ? `nessuno spostamento applicabile: ${orphans.pcb_placements.join(", ")} non sono sulla scheda compilata`
          : "niente da applicare in locale",
      );
    }
    const routed = applyManualRoutes({ circuitJson, routes: edits.pcb_routes, ...vias });
    const next = stitchToPlanes(routed.circuitJson as never, rules) as unknown as CircuitElement[];
    return {
      circuitJson: next,
      result: {
        ok: true,
        moved: 0,
        rerouted: false,
        manualRoutes: routed.applied.length,
        manualBranches: routed.branches.length,
        drc: null,
        orphans,
      },
    };
  }

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
  const redone = rerouteZoneDetailed(next, zone, DEFS, rules);
  if (redone.status === "failed") {
    return fail(
      `spostati ${applied.moved.length} componenti, ma il rame della zona non si e' potuto rifare (${redone.reason})`,
      applied.moved.length,
    );
  }
  if (redone.status === "ok") {
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
  const routed = applyManualRoutes({ circuitJson: next, routes: edits.pcb_routes, ...vias });
  next = routed.circuitJson as CircuitElement[];
  next = stitchToPlanes(next as never, rules) as unknown as CircuitElement[];

  return {
    circuitJson: next,
    result: {
      ok: true,
      moved: applied.moved.length,
      rerouted,
      manualRoutes: routed.applied.length,
      manualBranches: routed.branches.length,
      drc,
      orphans,
    },
  };
}

export { summarizeCircuit };
