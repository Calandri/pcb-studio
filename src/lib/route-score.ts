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
import { isoleDiRame } from "./gruppi-di-rame";
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
      (n, v) => n + (v.count ?? Math.max(1, v.points?.length ?? 1)),
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

/**
 * Unrouted connectivity groups, judged PAD BY PAD on the copper that is there.
 *
 * It used to be judged per group: a group counted as routed as soon as ONE of
 * its traces existed. On a five-pad net with a single leg drawn the board said
 * "zero open connections" and the checklist went green, with four pads hanging
 * in the air. Now every pad of the group must sit on the same island of copper
 * — traces, vias, the pads themselves — or the group is open.
 *
 * Nets with a poured plane keep the plane rule: their pads are connected by
 * the copper they sit in, which this function does not model (pour pieces,
 * thermals, the holes around other nets). Whether each of their pads really
 * reaches the plane is the DRC's `plane_stitch_missing`, which measures it.
 */
export function computeUnroutedGroupKeys(circuitJson: CircuitElement[]): Set<string> {
  return new Set(unroutedGroups(circuitJson).keys());
}

/**
 * The same verdict with its evidence: for every open group, the pcb ports that
 * are NOT on the group's largest island — the pads still waiting for copper.
 */
export function unroutedGroups(circuitJson: CircuitElement[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const sourceTraceEls = circuitJson.filter((el) => el.type === "source_trace");
  if (sourceTraceEls.length === 0) return out;
  const groupKey = (el: CircuitElement) =>
    String(el.subcircuit_connectivity_map_key ?? el.source_trace_id ?? "");

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

  const pcbPortsOfSource = new Map<string, string[]>();
  for (const el of circuitJson) {
    if (el.type !== "pcb_port" || !el.pcb_port_id || !el.source_port_id) continue;
    const list = pcbPortsOfSource.get(String(el.source_port_id)) ?? [];
    list.push(String(el.pcb_port_id));
    pcbPortsOfSource.set(String(el.source_port_id), list);
  }
  const portsOfGroup = new Map<string, Set<string>>();
  for (const el of sourceTraceEls) {
    const key = groupKey(el);
    if (!key || planeGroups.has(key)) continue;
    const set = portsOfGroup.get(key) ?? new Set<string>();
    for (const sp of (el.connected_source_port_ids as unknown[] | undefined) ?? []) {
      // the first pcb port of a source port is enough: the others are the same pin
      const pcb = pcbPortsOfSource.get(String(sp))?.[0];
      if (pcb) set.add(pcb);
    }
    portsOfGroup.set(key, set);
  }
  // a group with fewer than two placed pads has nothing to connect
  const daControllare = [...portsOfGroup].filter(([, ports]) => ports.size >= 2);
  if (daControllare.length === 0) return out;

  const isola = copperIslands(circuitJson);
  for (const [key, ports] of daControllare) {
    const perIsola = new Map<number, string[]>();
    for (const p of ports) {
      const root = isola(p);
      const list = perIsola.get(root) ?? [];
      list.push(p);
      perIsola.set(root, list);
    }
    if (perIsola.size <= 1) continue;
    const isole = [...perIsola.values()].sort((a, b) => b.length - a.length);
    out.set(key, isole.slice(1).flat());
  }
  return out;
}

/**
 * Which island of copper each pcb port sits on.
 *
 * The islands are built from what the Gerber will draw: every trace is one
 * piece of copper (its route is continuous, via points included); a trace
 * touches a pad when one of its segments reaches the pad's copper on the same
 * layer; two traces touch when the end of one lands on the other (that is how
 * a router's T-junctions are written); a via touches what reaches its ring.
 * Pads of the same port, and ports the part connects internally, are one node.
 *
 * The geometry lives in gruppi-di-rame.ts, shared with whoever needs the same
 * islands with their traces and vias (the viewer's open connections): here it
 * is asked for the islands of the count, with no poured copper.
 */
export function copperIslands(circuitJson: CircuitElement[]): (pcbPortId: string) => number {
  return isoleDiRame(circuitJson);
}
