/**
 * How a route is judged. It lives apart because both the compile and the
 * routing loop use it, and keeping it inside compile.ts created a circular
 * import between the two.
 *
 * The order of the entries is not random: a board with an error cannot be
 * made, one with an open connection does not work, one that violates the
 * rules cannot be manufactured, and only after that come the tastes (fewer
 * vias, less copper).
 */
import { DEFAULT_DESIGN_RULES, type DesignRules } from "./design-rules";
import { runDrcChecks } from "./drc";
import { planeServedSourcePorts, readPours } from "./pours";

export interface CircuitElement {
  type: string;
  [key: string]: unknown;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

export interface CircuitScore {
  errors: number;
  unrouted: number;
  drc: number;
  vias: number;
  /**
   * Only the SIGNAL vias: the ones the router chose in order to change layer.
   * The plane ones — a pad's tie and the stitching between planes — are not a
   * cost: one is not a choice, the others help the return current instead of
   * getting in its way.
   */
  signalVias: number;
  lengthMm: number;
  /**
   * The copper that really costs, in millimetres: length PLUS the signal vias
   * priced at `viaCostMm` each. It is the number to compare two routes with,
   * because copper and holes are two ways of paying for the same connection —
   * and a hole costs more. See DesignRules.viaCostMm
   */
  copperCostMm: number;
}

/**
 * Errors that are the CONSEQUENCE of an incomplete routing, not a failure of
 * the compile: a pin without a trace complains, rightly so, but counting it as
 * a fatal error meant shutting down the variant engine and the refinement
 * loop — which only start at zero errors — exactly on the incomplete boards,
 * i.e. the only ones where they were needed. The lack of copper is already
 * measured by `unrouted`, and measured better: per group, not per pin.
 */
const ROUTING_CONSEQUENCE = new Set([
  "pcb_trace_missing_error",
  "pcb_port_not_connected_error",
  "pcb_autorouting_error",
  "pcb_trace_error",
]);

/**
 * errors + unrouted groups + DRC + via count + length: minimized across the
 * candidates.
 *
 * The rules come from outside. Before, they did not, and the score always
 * used the JLCPCB standard: on a project with its own rules the refinement
 * loop optimized a different board from the one the DRC then measured, and
 * could declare itself "clean" on a route that the check rejected.
 */
export function scoreCircuit(
  circuitJson: CircuitElement[],
  rules: DesignRules = DEFAULT_DESIGN_RULES,
): CircuitScore {
  const signalVias = countSignalVias(circuitJson);
  const lengthMm = totalWireLengthMm(circuitJson);
  return {
    errors: circuitJson.filter(
      (el) => el.type.endsWith("_error") && !ROUTING_CONSEQUENCE.has(el.type),
    ).length,
    unrouted: computeUnroutedGroupKeys(circuitJson).size,
    // count OCCURRENCES, not families: aggregated, 110 crooked exits and
    // just 1 weigh the same and the comparison between two routes misses the difference
    drc: runDrcChecks(circuitJson, rules).reduce(
      (n, v) => n + Math.max(1, v.points?.length ?? 1),
      0,
    ),
    vias: circuitJson.filter((el) => el.type === "pcb_via").length,
    signalVias,
    lengthMm,
    copperCostMm: lengthMm + signalVias * (rules.viaCostMm ?? 0),
  };
}

/**
 * The vias the ROUTER chose, the ones that cost. Ours are recognized by their
 * id (pcb_via_plane_*): the tie to the plane and the stitching between planes
 * are not a route's choice and must not weigh on the comparison — otherwise a
 * board with better-stitched ground would look worse than one without.
 */
function countSignalVias(circuitJson: CircuitElement[]): number {
  let n = 0;
  for (const el of circuitJson) {
    if (el.type !== "pcb_via") continue;
    if (String(el.pcb_via_id ?? "").startsWith("pcb_via_plane_")) continue;
    n++;
  }
  return n;
}

function totalWireLengthMm(circuitJson: CircuitElement[]): number {
  let length = 0;
  for (const el of circuitJson) {
    if (el.type !== "pcb_trace") continue;
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
      length += Math.hypot(bx - ax, by - ay);
    }
  }
  return length;
}

const TRACE_TOUCH_MM = 0.4;

/**
 * Unrouted connectivity groups. Two detection modes:
 * - traces with source_trace_id (core routing): id mapping, grouping by net
 * - spliced traces (variant engine, no source ids): a group counts as routed
 *   when at least one of its pads has copper (a wire route point) nearby
 */
export function computeUnroutedGroupKeys(circuitJson: CircuitElement[]): Set<string> {
  const sourceTraceEls = circuitJson.filter((el) => el.type === "source_trace");
  const pcbTraceEls = circuitJson.filter((el) => el.type === "pcb_trace");
  const groupKey = (el: CircuitElement) =>
    String(el.subcircuit_connectivity_map_key ?? el.source_trace_id ?? "");
  const unrouted = new Set<string>();
  if (sourceTraceEls.length === 0) return unrouted;

  /*
   * A connection whose ends are ALL on a poured net is routed by the plane:
   * there is no trace and there must not be one. Without this, removing the
   * ground wires — which is the point of having a plane — made the board report
   * open connections that were not open, and "close the missing ones" would put
   * the wires straight back.
   */
  const pours = readPours(circuitJson);
  const servedByPlane = pours.length > 0 ? planeServedSourcePorts(circuitJson, pours) : new Map();
  const planeGroups = new Set<string>();
  if (servedByPlane.size > 0) {
    for (const el of sourceTraceEls) {
      const ports = ((el.connected_source_port_ids as unknown[] | undefined) ?? []).map(String);
      if (ports.length === 0) continue;
      if (ports.every((p) => servedByPlane.has(p))) planeGroups.add(groupKey(el));
    }
  }

  const hasSourceIds = pcbTraceEls.some((el) => el.source_trace_id);
  if (hasSourceIds) {
    const routedSourceIds = new Set(
      pcbTraceEls.map((el) => String(el.source_trace_id ?? "")).filter(Boolean),
    );
    const routedGroups = new Set(
      sourceTraceEls
        .filter((el) => routedSourceIds.has(String(el.source_trace_id ?? "")))
        .map(groupKey),
    );
    for (const el of sourceTraceEls) {
      const key = groupKey(el);
      if (!routedGroups.has(key) && !planeGroups.has(key)) unrouted.add(key);
    }
    return unrouted;
  }

  // geometric mode: pad positions per group from pcb_ports
  const pcbPortBySourcePort = new Map<string, CircuitElement>();
  for (const el of circuitJson) {
    if (el.type === "pcb_port" && el.source_port_id) {
      pcbPortBySourcePort.set(String(el.source_port_id), el);
    }
  }
  const wirePoints: Array<{ x: number; y: number }> = [];
  for (const el of pcbTraceEls) {
    const route = (el.route as Array<Record<string, unknown>> | undefined) ?? [];
    for (const p of route) {
      if (p.route_type !== "wire") continue;
      const x = num(p.x);
      const y = num(p.y);
      if (x !== null && y !== null) wirePoints.push({ x, y });
    }
  }
  const groupPoints = new Map<string, Array<{ x: number; y: number }>>();
  for (const el of sourceTraceEls) {
    const key = groupKey(el);
    const pts = groupPoints.get(key) ?? [];
    for (const portId of (el.connected_source_port_ids as string[] | undefined) ?? []) {
      const pad = pcbPortBySourcePort.get(String(portId));
      const x = pad ? num(pad.x) : null;
      const y = pad ? num(pad.y) : null;
      if (x !== null && y !== null && !pts.some((p) => p.x === x && p.y === y)) {
        pts.push({ x, y });
      }
    }
    groupPoints.set(key, pts);
  }
  for (const [key, pts] of groupPoints) {
    if (planeGroups.has(key)) continue;
    const touched = pts.some((pt) =>
      wirePoints.some(
        (w) => Math.abs(w.x - pt.x) <= TRACE_TOUCH_MM && Math.abs(w.y - pt.y) <= TRACE_TOUCH_MM,
      ),
    );
    if (!touched) unrouted.add(key);
  }
  return unrouted;
}

