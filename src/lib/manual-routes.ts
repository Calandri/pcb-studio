/**
 * Manually routed traces.
 *
 * WHY <pcbtrace> IS NOT ENOUGH. tscircuit accepts a trace with an explicit
 * path, but it is pure geometry: it does not know WHICH connection it is
 * implementing. Left on its own, the router keeps routing that connection on
 * its own (two copper branches on the same net) and the connectivity check
 * keeps saying "trace not connected". Verified: with a <pcbtrace> between two
 * resistors the compiler still emits pcb_trace_missing_error.
 *
 * WHY NOT A HINT. What existed before was a manual_trace_hint, i.e. a
 * suggestion ("go through here") that the router is free to ignore or
 * reinterpret. That is not manual routing: you cannot impose a path, you
 * cannot delete a trace, you cannot move a segment.
 *
 * HOW IT WORKS HERE. The drawn trace declares the connection it implements
 * (the display_name of the source_trace, e.g. ".R1 > .pin1 to net.GND"). Once
 * compilation is done its geometry REPLACES the one produced by the
 * autorouter for that connection: the netlist, the schematic and the BOM stay
 * as they were, only the copper changes. From then on the DRC measures the
 * hand-drawn trace like any other, which is the point where the check becomes
 * useful instead of decorative.
 */

export type Layer = "top" | "bottom" | "inner1" | "inner2";

export interface ManualRoutePoint {
  x: number;
  y: number;
  layer: Layer;
}

export interface ManualRoute {
  /** the connection implemented, e.g. ".R1 > .pin1 to net.GND" */
  connection: string;
  points: ManualRoutePoint[];
  /** width in mm */
  width: number;
  /**
   * This copper is a CURVE, not a run of straight segments.
   *
   * An arc imported from another CAD arrives as a polyline, and every one of its
   * chords sits at whatever angle the curve happens to have. The house rule that
   * wants 0, 45 or 90 degrees is about how a trace is DRAWN, and a curve is not
   * drawn that way: without this flag the 191 arcs of one imported board put 433
   * angle violations in the report, and real ones would be lost among them.
   */
  arco?: boolean;

  /**
   * This copper comes from ANOTHER CAD, it was not drawn here.
   *
   * It changes what may be said about it: the house rules on style — the trace
   * leaves the pad straight, segments at 0, 45 or 90 — are about how pcb-studio
   * DRAWS a board, and an imported board is a given. Measuring an Altium layout
   * against them puts 172 markers on the drawing and buries the findings that
   * matter. The physical checks (widths, clearances) apply to it like to any
   * other copper.
   */
  importato?: boolean;

  /** the via's real size, when the copper brings its own */
  viaDiameter?: number;
  viaHoleDiameter?: number;

  /**
   * The NET this copper belongs to, when it implements a whole net instead of
   * one connection.
   *
   * A board imported from another CAD arrives like this: the copper of a net is
   * a tree of segments that touches all its pads, and nobody wrote down which
   * segment serves which pin — because on copper the question has no meaning.
   * Splitting it into per-connection pieces would mean inventing an answer.
   *
   * A route with `net` replaces the copper of EVERY connection of that net, and
   * the check counts them all as routed: which is the truth, since the copper
   * is there and it touches them.
   */
  net?: string;
}

type El = Record<string, unknown>;

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const round3 = (v: number): number => Math.round(v * 1000) / 1000;
const LAYERS: Layer[] = ["top", "bottom", "inner1", "inner2"];

export function parseManualRoutes(value: unknown): ManualRoute[] {
  if (!Array.isArray(value)) return [];
  const out: ManualRoute[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    if (typeof r.connection !== "string" || !r.connection) continue;
    const net = typeof r.net === "string" && r.net ? r.net : undefined;
    if (!Array.isArray(r.points)) continue;
    const points: ManualRoutePoint[] = [];
    for (const p of r.points) {
      if (typeof p !== "object" || p === null) continue;
      const q = p as Record<string, unknown>;
      if (!Number.isFinite(q.x) || !Number.isFinite(q.y)) continue;
      const layer = LAYERS.includes(q.layer as Layer) ? (q.layer as Layer) : "top";
      points.push({ x: round3(num(q.x)), y: round3(num(q.y)), layer });
    }
    // two points are the minimum for a segment: below that it is not a trace
    if (points.length < 2) continue;
    const width = Number.isFinite(r.width) ? Math.max(0.05, num(r.width)) : 0.15;
    out.push({
      connection: r.connection,
      points,
      width,
      ...(net ? { net } : {}),
      ...(r.arco === true ? { arco: true } : {}),
      ...(r.importato === true ? { importato: true } : {}),
      ...(Number.isFinite(r.viaDiameter) ? { viaDiameter: num(r.viaDiameter) } : {}),
      ...(Number.isFinite(r.viaHoleDiameter) ? { viaHoleDiameter: num(r.viaHoleDiameter) } : {}),
    });
  }
  return out;
}

/**
 * Points in Circuit JSON format. Where the trace changes layer a `via` point
 * is inserted: it is the same shape the autorouter produces, so downstream
 * (DRC, Gerber export, viewer) the hand-drawn trace is indistinguishable from
 * a routed one — and that is exactly the goal.
 */
function toCircuitRoute(
  route: ManualRoute,
  viaDiameter: number,
  viaHoleDiameter: number,
): El[] {
  const out: El[] = [];
  const dia = route.viaDiameter ?? viaDiameter;
  const foro = route.viaHoleDiameter ?? viaHoleDiameter;
  for (const [i, p] of route.points.entries()) {
    const previous = route.points[i - 1];
    if (previous && previous.layer !== p.layer) {
      out.push({
        route_type: "via",
        x: p.x,
        y: p.y,
        from_layer: previous.layer,
        to_layer: p.layer,
        via_diameter: dia,
        via_hole_diameter: foro,
      });
    }
    out.push({
      route_type: "wire",
      x: p.x,
      y: p.y,
      layer: p.layer,
      width: route.width,
    });
  }
  return out;
}

export interface ApplyResult {
  circuitJson: unknown[];
  /** connections whose geometry was replaced */
  applied: string[];
  /** declared connections that do not exist in the project */
  unknown: string[];
}

/**
 * Replaces, in the compiled circuit, the geometry of the manually routed
 * connections. The vias that belonged to the old trace are removed along with
 * it, otherwise orphaned holes would remain in the middle of the copper.
 */
export function applyManualRoutes({
  circuitJson,
  routes,
  viaDiameter = 0.6,
  viaHoleDiameter = 0.3,
}: {
  circuitJson: unknown[];
  routes: ManualRoute[];
  viaDiameter?: number;
  viaHoleDiameter?: number;
}): ApplyResult {
  if (routes.length === 0) {
    return { circuitJson, applied: [], unknown: [] };
  }
  const els = circuitJson as El[];

  const sourceTraceIdByName = new Map<string, string>();
  for (const e of els) {
    if (e.type !== "source_trace") continue;
    const name = e.display_name;
    const id = e.source_trace_id;
    if (typeof name === "string" && typeof id === "string") sourceTraceIdByName.set(name, id);
  }

  /*
   * Which source traces belong to each net: a route that implements a whole net
   * replaces the copper of all of them at once. It is how copper imported from
   * another CAD arrives — one tree per net, not one piece per connection.
   */
  const nameOfNet = new Map<string, string>();
  for (const e of els) {
    if (e.type !== "source_net" || !e.source_net_id) continue;
    nameOfNet.set(String(e.source_net_id), String(e.name ?? ""));
  }
  const tracesOfNetName = new Map<string, string[]>();
  for (const e of els) {
    if (e.type !== "source_trace" || typeof e.source_trace_id !== "string") continue;
    for (const netId of ((e.connected_source_net_ids as unknown[] | undefined) ?? []).map(String)) {
      const name = nameOfNet.get(netId);
      if (!name) continue;
      tracesOfNetName.set(name, [...(tracesOfNetName.get(name) ?? []), e.source_trace_id]);
    }
  }

  const applied: string[] = [];
  const unknown: string[] = [];
  const replacing = new Map<string, ManualRoute>();
  /** further branches of the same connection: a net's copper is a tree */
  const rami = new Map<string, ManualRoute[]>();
  for (const route of routes) {
    if (route.net) {
      const ids = tracesOfNetName.get(route.net) ?? [];
      if (ids.length === 0) {
        unknown.push(`net.${route.net}`);
        continue;
      }
      /*
       * A net's copper is a TREE of segments, not one path: the first segment
       * replaces the copper of the net's first connection, the others are added
       * as further branches of the same connection. It is the shape the router
       * itself produces (several pcb_trace rows with one source_trace_id), and
       * it keeps every millimetre of the imported copper instead of the first
       * piece only.
       */
      if (!replacing.has(ids[0])) {
        replacing.set(ids[0], route);
        applied.push(`net.${route.net}`);
      } else {
        rami.set(ids[0], [...(rami.get(ids[0]) ?? []), route]);
      }
      // the net's other connections carry no copper of their own: it is the
      // same copper, and drawing it twice would be a trace on top of a trace
      for (const id of ids.slice(1)) if (!replacing.has(id)) replacing.set(id, { ...route, points: [] });
      continue;
    }
    const id = sourceTraceIdByName.get(route.connection);
    if (!id) {
      unknown.push(route.connection);
      continue;
    }
    replacing.set(id, route);
    applied.push(route.connection);
  }
  if (replacing.size === 0) return { circuitJson, applied, unknown };

  // the old trace's vias: recognized by position, because the pcb_via
  // element does not carry the source_trace_id
  const doomedVias = new Set<string>();
  for (const e of els) {
    if (e.type !== "pcb_trace") continue;
    const id = e.source_trace_id;
    if (typeof id !== "string" || !replacing.has(id)) continue;
    for (const p of (Array.isArray(e.route) ? e.route : []) as El[]) {
      if (p.route_type === "via") doomedVias.add(`${round3(num(p.x))},${round3(num(p.y))}`);
    }
  }

  const out: El[] = [];
  const done = new Set<string>();
  for (const e of els) {
    if (e.type === "pcb_via" && doomedVias.has(`${round3(num(e.x))},${round3(num(e.y))}`)) {
      continue;
    }
    if (e.type === "pcb_trace" && typeof e.source_trace_id === "string" && replacing.has(e.source_trace_id)) {
      const id = e.source_trace_id;
      if (done.has(id)) continue; // a connection can have several branches: only one replaces it
      done.add(id);
      const route = replacing.get(id)!;
      if (route.points.length < 2) continue; // svuotata: la rete e' coperta altrove
      out.push({
        ...e,
        // the marker every later pass respects: hand-drawn copper is never
        // ripped, straightened, widened or un-routed by automatic machinery
        manual: true,
        ...(route.arco ? { arco: true } : {}),
        ...(route.importato ? { importato: true } : {}),
        route: toCircuitRoute(route, viaDiameter, viaHoleDiameter),
      });
      continue;
    }
    out.push(e);
  }

  // the other branches of a net's copper, added as they are
  let ramo = 0;
  for (const [id, lista] of rami) {
    for (const route of lista) {
      if (route.points.length < 2) continue;
      out.push({
        type: "pcb_trace",
        pcb_trace_id: `pcb_trace_manual_branch_${ramo++}`,
        source_trace_id: id,
        manual: true,
        ...(route.arco ? { arco: true } : {}),
        ...(route.importato ? { importato: true } : {}),
        ...(route.importato ? { importato: true } : {}),
        route: toCircuitRoute(route, viaDiameter, viaHoleDiameter),
      });
    }
  }

  // connections never routed by the autorouter: the manual trace creates them
  for (const [id, route] of replacing) {
    if (done.has(id)) continue;
    // emptied on purpose: it is a net whose copper is already carried by
    // another connection of the same net
    if (route.points.length < 2) continue;
    out.push({
      type: "pcb_trace",
      pcb_trace_id: `pcb_trace_manual_${id}`,
      source_trace_id: id,
      manual: true,
      ...(route.arco ? { arco: true } : {}),
      ...(route.importato ? { importato: true } : {}),
      route: toCircuitRoute(route, viaDiameter, viaHoleDiameter),
    });
  }

  /*
   * A VIA IS AN OBJECT, NOT A POINT INSIDE A LINE.
   *
   * A `via` point in a route only tells the drawing to break the trace there:
   * the viewer, the Gerber export and the plane-stitching check all look for
   * `pcb_via` rows, and there were none. So a board with 640 imported vias was
   * drawn with none at all — copper that stops in mid air on one face and starts
   * again on the other, which is exactly what it looked like.
   *
   * One row per hole, deduplicated by position: several branches of the same net
   * can share a via, and drawing it twice would be two rings on the same hole.
   */
  const gia = new Set<string>();
  for (const e of out) {
    if (e.type === "pcb_via") gia.add(`${round3(num(e.x))},${round3(num(e.y))}`);
  }
  /*
   * WHICH NET THE HOLE IS ON. A pcb_trace carries no connectivity key in this
   * version of tscircuit — it carries the source_trace_id, and the key is on the
   * source trace. Reading only the trace left all 636 imported vias with no net,
   * and a via with no net is invisible to every check that asks "is there a via
   * of this net here": the copper an island hangs from stopped counting, and the
   * islands were reported as dead copper.
   */
  const chiaveDiSorgente = new Map<string, string>();
  for (const e of els) {
    if (e.type !== "source_trace" || typeof e.source_trace_id !== "string") continue;
    const k = e.subcircuit_connectivity_map_key;
    if (typeof k === "string" && k) chiaveDiSorgente.set(e.source_trace_id, k);
  }
  let nVia = 0;
  for (const e of out) {
    if (e.type !== "pcb_trace" || !e.manual) continue;
    for (const p of (Array.isArray(e.route) ? e.route : []) as El[]) {
      if (p.route_type !== "via") continue;
      const key = `${round3(num(p.x))},${round3(num(p.y))}`;
      if (gia.has(key)) continue;
      gia.add(key);
      const dia = num(p.via_diameter) || viaDiameter;
      out.push({
        type: "pcb_via",
        pcb_via_id: `pcb_via_manual_${nVia++}`,
        x: round3(num(p.x)),
        y: round3(num(p.y)),
        outer_diameter: dia,
        hole_diameter: num(p.via_hole_diameter) || viaHoleDiameter,
        layers: [String(p.from_layer ?? "top"), String(p.to_layer ?? "bottom")],
        subcircuit_connectivity_map_key:
          e.subcircuit_connectivity_map_key ??
          chiaveDiSorgente.get(String(e.source_trace_id ?? "")),
      });
    }
  }

  return { circuitJson: out, applied, unknown };
}
