import { getSimpleRouteJsonFromCircuitJson } from "@tscircuit/core";
import { DEFAULT_DESIGN_RULES, type DesignRules } from "./design-rules";
import { runDrcChecks } from "./drc";
import { computeUnroutedGroupKeys } from "./route-score";
import { runSolver, spliceTraces, type CircuitElement, type VariantDef } from "./variants";

/**
 * ZONE rip-up: remove the traces that pass inside a rectangle and redo only
 * those, leaving all the rest of the copper untouched.
 *
 * It is the difference between darning a tear and reweaving the sweater. The
 * cut by functional blocks was not enough: on a real board the interesting
 * connections cross the blocks (from the microcontroller to the peripherals)
 * and the power rails are global nets, so the blocks stay almost empty and the
 * problems live in the backbone, which no block contains.
 *
 * It works because tscircuit's routing-problem builder, given the circuit with
 * a few traces missing, asks to route ONLY the connections left uncovered.
 *
 * WARNING, this is a real limitation and must be kept in mind while reading
 * everything else: the surviving copper does NOT become an obstacle. The
 * builder skips the `pcb_trace` elements that have a `source_trace_id`, and
 * all of those produced by the core have one. Measured on bat-bs: with the
 * 104 traces in the circuit the problem has 331 obstacles; deleting them all
 * it still has 331. Those 331 are pads and components. A previous comment here
 * said "384 obstacles still standing" and read them as surviving copper: they
 * are not. Until obstacles are injected by hand, the solver plans as if the
 * board had no traces, and that is where the trace-against-trace violations
 * the loop cannot close come from.
 *
 * The builder, however, always makes the problem as big as the board: same
 * bounds, same 384 obstacles. So a "local" reroute cost almost as much as
 * redoing everything (measured: 357 seconds for two passes, zero gain). That
 * is why the problem is CROPPED to the zone before handing it to the solver:
 * bounds at the rectangle, obstacles only those that touch it, connections
 * only those that fit entirely inside.
 *
 * Hence the rip-up rule: only traces ENTIRELY contained in the zone are
 * removed. A trace that enters and exits would have one end outside the crop,
 * and the router would no longer know where to attach it.
 */

export interface Zone {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  /** how many problems fall in here: used to decide where to start */
  problems: number;
  reasons: string[];
}

export interface ProblemPoint {
  x: number;
  y: number;
  reason: string;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * Groups nearby problems into zones. Points less than `gap` apart end up in
 * the same zone: redoing the same area twice would be wasted time, and a zone
 * that contains both also gives the router room to move around.
 */
export function zonesFromProblems(
  points: ProblemPoint[],
  gap = 2.5,
  margin = 2,
  maxSide = 16,
): Zone[] {
  const zones: Zone[] = [];
  for (const p of points) {
    const near = zones.find(
      (z) =>
        p.x >= z.minX - gap &&
        p.x <= z.maxX + gap &&
        p.y >= z.minY - gap &&
        p.y <= z.maxY + gap,
    );
    // a zone cannot grow beyond maxSide: if enlarging it would break the
    // limit a new zone is opened, otherwise all the problems merge into a
    // single rectangle as big as the board and the crop becomes useless
    const wouldFit =
      near &&
      Math.max(near.maxX, p.x + margin) - Math.min(near.minX, p.x - margin) <= maxSide &&
      Math.max(near.maxY, p.y + margin) - Math.min(near.minY, p.y - margin) <= maxSide;
    if (near && wouldFit) {
      near.minX = Math.min(near.minX, p.x - margin);
      near.maxX = Math.max(near.maxX, p.x + margin);
      near.minY = Math.min(near.minY, p.y - margin);
      near.maxY = Math.max(near.maxY, p.y + margin);
      near.problems += 1;
      if (!near.reasons.includes(p.reason)) near.reasons.push(p.reason);
      continue;
    }
    zones.push({
      minX: p.x - margin,
      maxX: p.x + margin,
      minY: p.y - margin,
      maxY: p.y + margin,
      problems: 1,
      reasons: [p.reason],
    });
  }
  return zones.sort((a, b) => b.problems - a.problems);
}

const inZone = (zone: Zone, x: number | null, y: number | null): boolean =>
  x !== null &&
  y !== null &&
  x >= zone.minX &&
  x <= zone.maxX &&
  y >= zone.minY &&
  y <= zone.maxY;

/** the two ends of a cut segment: the router must stitch between these points */
export interface Cut {
  a: Record<string, unknown>;
  b: Record<string, unknown>;
  /**
   * The connection the cut trace belonged to. The copper that stitches this
   * cut is copper of THAT net: without carrying it along it would be born
   * anonymous, hence invisible to the DRC and able to blow up the problem
   * builder on the next pass (see sourceTraceIdResolver in variants).
   */
  sourceTraceId: string | null;
}

/**
 * The stretch of the segment a->b that lies inside the zone, as parameters
 * 0 <= t0 <= t1 <= 1 along it (Liang-Barsky). null when it misses the zone.
 */
export function clipSegmentToZone(
  zone: Zone,
  a: { x: number; y: number },
  b: { x: number; y: number },
): { t0: number; t1: number } | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;
  const edges: Array<[number, number]> = [
    [-dx, a.x - zone.minX],
    [dx, zone.maxX - a.x],
    [-dy, a.y - zone.minY],
    [dy, zone.maxY - a.y],
  ];
  for (const [p, q] of edges) {
    if (Math.abs(p) < 1e-12) {
      if (q < 0) return null; // parallel and outside
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }
  return t0 <= t1 ? { t0, t1 } : null;
}

/** a new route point on the segment a->b at t: a wire point on the segment's layer */
function pointOn(a: Record<string, unknown>, b: Record<string, unknown>, t: number): Record<string, unknown> {
  const ax = num(a.x) ?? 0, ay = num(a.y) ?? 0, bx = num(b.x) ?? 0, by = num(b.y) ?? 0;
  const layer =
    (a.route_type === "via" ? a.to_layer : a.layer) ??
    (b.route_type === "via" ? b.from_layer : b.layer) ??
    "top";
  const width = a.width ?? b.width;
  return {
    route_type: "wire",
    x: Math.round((ax + (bx - ax) * t) * 1e6) / 1e6,
    y: Math.round((ay + (by - ay) * t) * 1e6) / 1e6,
    layer,
    ...(width !== undefined ? { width } : {}),
  };
}

/**
 * The pieces of a route that stay OUTSIDE the zone, and the cuts to stitch.
 *
 * Measured on SEGMENTS, not on vertices: a long straight trace crossing the
 * zone with both ends outside has no vertex inside it, and used to survive
 * untouched right through the copper being redone there. Every segment is
 * clipped against the rectangle; the outside part of a segment that enters
 * ends ON the boundary, and the stretch inside is removed.
 *
 * A cut is recorded wherever copper was removed between two things that must
 * stay joined: between two kept pieces (a backbone crossing the zone), and
 * between a kept piece and the route's own END when that end lies inside the
 * zone (a trace from a pad outside to a pad inside). Without the second kind
 * the head or tail outside was kept with nothing to join it, a floating stub.
 */
export function splitRouteByZone(
  route: Array<Record<string, unknown>>,
  zone: Zone,
): { pieces: Array<Array<Record<string, unknown>>>; cuts: Array<{ a: Record<string, unknown>; b: Record<string, unknown> }>; touched: boolean } {
  const pieces: Array<Array<Record<string, unknown>>> = [];
  const cuts: Array<{ a: Record<string, unknown>; b: Record<string, unknown> }> = [];
  const ok = (p: Record<string, unknown>) => num(p.x) !== null && num(p.y) !== null;
  const pts = route.filter(ok);
  if (pts.length === 0) return { pieces: [route], cuts, touched: false };
  if (pts.length === 1) {
    const inside = inZone(zone, num(pts[0].x), num(pts[0].y));
    return { pieces: inside ? [] : [route], cuts, touched: inside };
  }

  let touched = false;
  let piece: Array<Record<string, unknown>> = [];
  /** where the removed stretch started: a piece's end on the boundary, or the route's start */
  let pendingFrom: Record<string, unknown> | null = null;
  const firstInside = inZone(zone, num(pts[0].x), num(pts[0].y));
  if (!firstInside) piece.push(pts[0]);
  else {
    touched = true;
    pendingFrom = pts[0];
  }

  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const clip = clipSegmentToZone(
      zone,
      { x: num(a.x)!, y: num(a.y)! },
      { x: num(b.x)!, y: num(b.y)! },
    );
    const bInside = inZone(zone, num(b.x), num(b.y));
    if (!clip || clip.t1 - clip.t0 < 1e-9) {
      // the segment does not cross the zone (or only grazes a corner)
      if (piece.length === 0) {
        // coming out of the zone at a vertex
        if (pendingFrom) cuts.push({ a: pendingFrom, b: a });
        pendingFrom = null;
        piece.push(a);
      }
      piece.push(b);
      continue;
    }
    touched = true;
    // the part before the zone
    if (piece.length > 0) {
      if (clip.t0 > 1e-9) piece.push(pointOn(a, b, clip.t0));
      if (piece.length >= 1) {
        pieces.push(piece);
        pendingFrom = piece[piece.length - 1];
      }
      piece = [];
    }
    // the part after the zone
    if (!bInside && clip.t1 < 1 - 1e-9) {
      const exit = pointOn(a, b, clip.t1);
      if (pendingFrom) cuts.push({ a: pendingFrom, b: exit });
      pendingFrom = null;
      piece = [exit, b];
    }
  }
  if (piece.length > 0) pieces.push(piece);
  else if (pendingFrom && pieces.length > 0) {
    // the route ENDS inside the zone: the kept head must reach that end
    cuts.push({ a: pendingFrom, b: pts[pts.length - 1] });
  }
  return { pieces, cuts, touched };
}

/**
 * The circuit without the copper inside the zone.
 *
 * Traces entirely contained disappear. Those that ENTER AND EXIT — the long
 * backbones, which are exactly the ones violating clearances — are CUT at the
 * boundary: the stubs outside are kept, the middle segment is thrown away and
 * the two cut points are recorded, and they will become a connection to be
 * stitched back.
 *
 * Without the cut nobody was redoing the backbones and the loop was spinning
 * idle: that is why it stalled at 62 violations saying "no longer improving".
 */
export function ripZone(
  circuitJson: CircuitElement[],
  zone: Zone,
): { circuitJson: CircuitElement[]; cuts: Cut[] } {
  const out: CircuitElement[] = [];
  const cuts: Cut[] = [];

  /*
   * The holes hand copper changes face through. They are marked `manual` by
   * applyManualRoutes; on a board compiled before that marker existed they
   * are recognised by sitting on a `via` point of a hand trace. Deleting one
   * while keeping its trace left copper jumping between faces through nothing.
   */
  const manualViaAt = new Set<string>();
  for (const el of circuitJson) {
    if (el.type !== "pcb_trace" || (el as { manual?: boolean }).manual !== true) continue;
    for (const p of (el.route as Array<Record<string, unknown>> | undefined) ?? []) {
      const x = num(p.x), y = num(p.y);
      if (p.route_type === "via" && x !== null && y !== null) manualViaAt.add(`${x.toFixed(3)},${y.toFixed(3)}`);
    }
  }

  for (const el of circuitJson) {
    /*
     * Hand-drawn copper is sacred: ripZone never touches it, not even when it
     * crosses the zone. Before the `manual` marker existed, a zone rip could
     * silently replace the user's own geometry with automatic copper.
     */
    if ((el as { manual?: boolean }).manual === true) {
      out.push(el);
      continue;
    }
    if (el.type === "pcb_via") {
      const x = num(el.x), y = num(el.y);
      if (x !== null && y !== null && manualViaAt.has(`${x.toFixed(3)},${y.toFixed(3)}`)) {
        out.push(el);
        continue;
      }
      if (!inZone(zone, x, y)) out.push(el);
      continue;
    }
    if (el.type !== "pcb_trace") {
      out.push(el);
      continue;
    }
    const route = (el.route as Array<Record<string, unknown>> | undefined) ?? [];
    if (route.length === 0) {
      out.push(el);
      continue;
    }
    const split = splitRouteByZone(route, zone);
    if (!split.touched) {
      out.push(el); // does not touch the zone
      continue;
    }
    const sourceTraceId = typeof el.source_trace_id === "string" ? el.source_trace_id : null;
    for (const c of split.cuts) cuts.push({ ...c, sourceTraceId });
    for (const [i, kept] of split.pieces.entries()) {
      if (kept.length < 2) continue;
      out.push({ ...el, pcb_trace_id: `${String(el.pcb_trace_id)}_k${i}`, route: kept });
    }
  }

  return { circuitJson: out, cuts };
}

interface RouteProblem {
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  obstacles: Array<{
    center: { x: number; y: number };
    width: number;
    height: number;
  }>;
  connections: Array<{ pointsToConnect: Array<{ x: number; y: number }> }>;
  [key: string]: unknown;
}

/**
 * The problem cropped to the zone: this is what brings the cost down from
 * minutes to seconds. Keeps the obstacles that TOUCH the rectangle (not only
 * those inside: copper on the edge must be avoided all the same) and the
 * connections that fit entirely inside it.
 */
export function cropToZone(problem: RouteProblem, zone: Zone, margin = 1.5): RouteProblem {
  const box = {
    minX: zone.minX - margin,
    maxX: zone.maxX + margin,
    minY: zone.minY - margin,
    maxY: zone.maxY + margin,
  };
  const touches = (o: { center: { x: number; y: number }; width: number; height: number }) =>
    o.center.x + o.width / 2 >= box.minX &&
    o.center.x - o.width / 2 <= box.maxX &&
    o.center.y + o.height / 2 >= box.minY &&
    o.center.y - o.height / 2 <= box.maxY;

  const inside = (p: { x: number; y: number }) =>
    p.x >= box.minX && p.x <= box.maxX && p.y >= box.minY && p.y <= box.maxY;

  /*
   * Connections are PRUNED, not discarded. A net like GND touches dozens of
   * pads scattered all over the board: demanding that they all fit inside the
   * rectangle meant throwing away every connection and having nothing left to
   * route. The points inside the crop are kept; the rest of the net is taken
   * care of by the copper that was not ripped up.
   */
  const connections = problem.connections
    .map((c) => ({ ...c, pointsToConnect: (c.pointsToConnect ?? []).filter(inside) }))
    .filter((c) => c.pointsToConnect.length >= 2);

  return {
    ...problem,
    bounds: box,
    obstacles: problem.obstacles.filter(touches),
    connections,
  };
}

/**
 * Redoes the copper of ONE zone. Tries several solvers, judges each one with
 * the DRC on the whole board — not on the zone alone, because a trace born
 * here can crash into something elsewhere — and returns the best one.
 */
export function rerouteZone(
  circuitJson: CircuitElement[],
  zone: Zone,
  defs: VariantDef[],
  rules: DesignRules = DEFAULT_DESIGN_RULES,
  opts?: { routeEvenWithoutRip?: boolean },
): { circuitJson: CircuitElement[]; drc: number } | null {
  const r = rerouteZoneDetailed(circuitJson, zone, defs, rules, opts);
  return r.status === "ok" ? { circuitJson: r.circuitJson, drc: r.drc } : null;
}

export type ZoneRerouteOutcome =
  | { status: "ok"; circuitJson: CircuitElement[]; drc: number }
  /** nothing in the zone to rip or to route: the board is fine as it is */
  | { status: "nothing" }
  /** there was work and no solver produced a board that breaks nothing */
  | { status: "failed"; reason: string };

/**
 * rerouteZone with the reason when it gives nothing back. "Nothing to do"
 * and "could not do it" are opposite answers for whoever moved a part: in the
 * first case the board is right, in the second the moved pads are left with
 * the old copper pointing at where they were.
 */
export function rerouteZoneDetailed(
  circuitJson: CircuitElement[],
  zone: Zone,
  defs: VariantDef[],
  rules: DesignRules = DEFAULT_DESIGN_RULES,
  opts?: { routeEvenWithoutRip?: boolean },
): ZoneRerouteOutcome {
  const { circuitJson: base, cuts } = ripZone(circuitJson, zone);
  /*
   * By default work happens only if there was copper to rip up: this is the
   * guard that avoids idle passes. For "close the missing ones" the guard is
   * switched off: the connection to close is uncovered by definition, and the
   * solver must be able to route it even if there was nothing to remove in the
   * zone.
   */
  const ripped =
    base.length !== circuitJson.length || cuts.length > 0 || base.some((el, i) => el !== circuitJson[i]);
  if (!opts?.routeEvenWithoutRip && !ripped) {
    return { status: "nothing" };
  }

  let srj: RouteProblem;
  try {
    const built = getSimpleRouteJsonFromCircuitJson({
      circuitJson: base as never,
      /*
       * Only the minimum trace width is passed to the cropped problem.
       * Enforcing the via sizes too (0.3 and 0.6mm) made the search so tight
       * that the solver exhausted its 200,000 steps without finishing:
       * "Cannot get output before solving is complete", and all the work ended
       * up in the bin. There is no need to enforce them here: vias are written
       * at the fab size when the result is spliced back, and if they do not
       * fit at that size it is the DRC that says so and the candidate loses.
       */
      minTraceWidth: rules.targetTraceWidthMm ?? rules.minTraceWidthMm,
    } as never) as { simpleRouteJson: RouteProblem };
    // the crop is the difference between minutes and seconds
    srj = cropToZone(built.simpleRouteJson, zone);
    /*
     * The margin from obstacles is set HERE and not among the builder
     * parameters: it is the only clearance constraint the solver respects
     * without stalling, and it is the one that matters. Without it, the zone
     * reroute placed traces 0.06mm from vias — half the fab minimum — and the
     * loop produced violations instead of removing them.
     */
    const margin = rules.targetClearanceMm ?? rules.minClearanceMm;
    if (((srj as Record<string, unknown>).defaultObstacleMargin as number ?? 0) < margin) {
      (srj as Record<string, unknown>).defaultObstacleMargin = margin;
    }
    /*
     * Cuts become connections with only two points: the solver only needs to
     * know which coordinates to join, they do not have to be pads. This is how
     * a backbone gets redone ONLY in the segment crossing the zone, leaving
     * the two stubs outside untouched.
     */
    /*
     * The cut name CARRIES the cut connection inside it. The solver returns
     * the name as-is on every trace it produces, so it is the simplest way to
     * get the information all the way to the splice without inventing a
     * separate channel: the name -> connection bridge is a single one and it
     * holds for every case.
     */
    srj.connections = [
      ...srj.connections,
      ...cuts.map((cut, i) => ({
        name: cut.sourceTraceId ? `taglio_${i}__${cut.sourceTraceId}` : `taglio_${i}`,
        pointsToConnect: [cut.a, cut.b],
      })),
    ] as typeof srj.connections;
  } catch (err) {
    return {
      status: "failed",
      reason: `il problema di instradamento della zona non si costruisce: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`,
    };
  }
  if (srj.connections.length === 0) {
    return ripped
      ? { status: "failed", reason: "dopo lo strappo nella zona non resta nessun collegamento da rifare" }
      : { status: "nothing" };
  }

  /*
   * How many connections were left unrouted BEFORE. Used as a yardstick: a
   * candidate that closes ten violations by breaking a connection is not a
   * better candidate, it is a broken board. Previously the choice was made on
   * DRC alone, so a broken candidate could beat the healthy one and then be
   * rejected upstream: the result was that the good candidate was never even
   * looked at.
   */
  const unroutedBefore = computeUnroutedGroupKeys(circuitJson).size;

  let best: { circuitJson: CircuitElement[]; drc: number; unrouted: number } | null = null;
  for (const def of defs) {
    try {
      const traces = runSolver(def.SolverClass, srj, def.effort);
      if (traces.length === 0) continue;
      const spliced = spliceTraces(
        base,
        `zone_${Math.round(zone.minX)}_${Math.round(zone.minY)}`,
        traces,
        `z${Math.round(zone.minX)}x${Math.round(zone.minY)}_${def.solver}${def.effort}`,
        rules,
      );
      // the PROJECT rules, not the default ones: otherwise the best candidate
      // is picked according to a fab that is not the chosen one
      const drc = runDrcChecks(spliced, rules).reduce(
        (n, v) => n + Math.max(1, v.points?.length ?? 1),
        0,
      );
      const unrouted = computeUnroutedGroupKeys(spliced).size;
      if (unrouted > unroutedBefore) continue; // broke something: out
      if (!best || unrouted < best.unrouted || (unrouted === best.unrouted && drc < best.drc)) {
        best = { circuitJson: spliced, drc, unrouted };
      }
    } catch {
      // a solver that cannot make it takes nothing away from the others
    }
  }
  return best
    ? { status: "ok", circuitJson: best.circuitJson, drc: best.drc }
    : { status: "failed", reason: "nessun solutore ha rifatto il rame della zona senza staccare altri collegamenti" };
}
