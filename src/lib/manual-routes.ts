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
  /**
   * The two PADS the route joins, as ".R1 > .pin1" selectors, and the stable
   * identity derived from them (manualRouteKey).
   *
   * The connection alone is not an identity: when two pads of a net are not
   * named together by any <trace>, the route falls back to the net's first
   * connection, so two branches drawn from one pad got the same key — the
   * second erased the first, and both replaced copper of the net that had
   * nothing to do with them. With the pads stored the route is keyed by what
   * was drawn, and a route whose pads are not the connection's own is ADDED as
   * a branch instead of replacing anything. Entries written before these
   * fields existed are still read, keyed by their connection as they were.
   */
  from?: string;
  to?: string;
  id?: string;
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
  /**
   * A NET TIE: copper that shorts two nets on purpose, one point on the board
   * and nowhere else. The schematic keeps the two apart, the layout joins them,
   * and every clearance check sees a trace lying on another net's pad. Marked
   * here, the check can leave THIS piece of copper alone without going blind on
   * the two nets everywhere else.
   */
  netTie?: boolean;

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

/** sane bounds for what a route may carry: anything outside is a broken or hostile input */
export const ROUTE_LIMITS = {
  minWidthMm: 0.05,
  maxWidthMm: 10,
  minViaMm: 0.1,
  maxViaMm: 6,
  minViaHoleMm: 0.05,
  /** coordinates beyond a metre are not a board */
  maxCoordMm: 1000,
} as const;

/** ".U1>.VCC", ".U1 >  .VCC" and ".U1 > .VCC" are the same pad */
export function normalizePadSelector(value: string): string {
  return value.trim().replace(/\s*>\s*/g, " > ");
}

/** the identity of a route between two pads: the same whichever end it was drawn from */
export function pairKey(a: string, b: string): string {
  const [x, y] = [normalizePadSelector(a), normalizePadSelector(b)].sort();
  return `${x} ~ ${y}`;
}

/**
 * The key a route is stored and replaced by.
 *   - pads known: the pair, so every branch has its own;
 *   - a net's imported copper: the net plus its geometry, since a net tree is
 *     many routes and none of them replaces another;
 *   - older entries: the connection, as before.
 */
export function manualRouteKey(route: ManualRoute): string {
  if (route.from && route.to) return pairKey(route.from, route.to);
  if (route.net) {
    const sig = route.points.map((p) => `${p.x},${p.y},${p.layer}`).join(";");
    // the geometry as a short digest: the key is written on every piece of copper
    return `net.${route.net} @ ${digest(sig)}`;
  }
  return route.connection;
}

/** two 32-bit FNV-1a passes with different seeds: a compact, stable, non-cryptographic digest */
function digest(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x01000193 + 2) >>> 0;
  }
  return `${a.toString(36)}${b.toString(36)}`;
}

export interface ParseRouteLimits {
  /** how many routes are read at most */
  maxRoutes?: number;
  /** how many points one route may have */
  maxPoints?: number;
}

/**
 * Generous for the FILE, which holds an imported board (thousands of routes,
 * arcs of hundreds of points); the editor's own POST uses tighter ones.
 */
const FILE_LIMITS: Required<ParseRouteLimits> = { maxRoutes: 50_000, maxPoints: 20_000 };

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Reads routes defensively. What is rejected, and why:
 *   - a point with a non-finite or absurd coordinate: the whole route, since a
 *     route with a hole in the middle is not the route that was drawn;
 *   - a point on a layer that does not exist: the whole route. It used to be
 *     moved silently to the top face, i.e. copper where nobody drew it;
 *   - consecutive identical points: dropped (a zero-length segment is noise
 *     for every check), while the same x/y on another layer stays — that is a
 *     via;
 *   - widths and via sizes: clamped to ROUTE_LIMITS, a zero or negative via
 *     is ignored (the project default applies).
 */
export function parseManualRoutes(value: unknown, limits: ParseRouteLimits = {}): ManualRoute[] {
  if (!Array.isArray(value)) return [];
  const maxRoutes = limits.maxRoutes ?? FILE_LIMITS.maxRoutes;
  const maxPoints = limits.maxPoints ?? FILE_LIMITS.maxPoints;
  const out: ManualRoute[] = [];
  for (const item of value) {
    if (out.length >= maxRoutes) break;
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    if (typeof r.connection !== "string" || !r.connection || r.connection.length > 300) continue;
    const net = typeof r.net === "string" && r.net && r.net.length <= 200 ? r.net : undefined;
    if (!Array.isArray(r.points) || r.points.length > maxPoints) continue;
    const points: ManualRoutePoint[] = [];
    let broken = false;
    for (const p of r.points) {
      if (typeof p !== "object" || p === null) {
        broken = true;
        break;
      }
      const q = p as Record<string, unknown>;
      if (!finite(q.x) || !finite(q.y)) {
        broken = true;
        break;
      }
      if (Math.abs(q.x) > ROUTE_LIMITS.maxCoordMm || Math.abs(q.y) > ROUTE_LIMITS.maxCoordMm) {
        broken = true;
        break;
      }
      // a missing layer is the old default; an unknown one is refused
      const layer = q.layer === undefined ? "top" : (q.layer as Layer);
      if (!LAYERS.includes(layer)) {
        broken = true;
        break;
      }
      const point = { x: round3(q.x), y: round3(q.y), layer };
      const prev = points[points.length - 1];
      if (prev && prev.x === point.x && prev.y === point.y && prev.layer === point.layer) continue;
      points.push(point);
    }
    // two points are the minimum for a segment: below that it is not a trace
    if (broken || points.length < 2) continue;
    const width = finite(r.width)
      ? clamp(r.width, ROUTE_LIMITS.minWidthMm, ROUTE_LIMITS.maxWidthMm)
      : 0.15;
    const viaDiameter =
      finite(r.viaDiameter) && r.viaDiameter > 0
        ? clamp(r.viaDiameter, ROUTE_LIMITS.minViaMm, ROUTE_LIMITS.maxViaMm)
        : undefined;
    const viaHoleDiameter =
      finite(r.viaHoleDiameter) && r.viaHoleDiameter > 0
        ? clamp(
            r.viaHoleDiameter,
            ROUTE_LIMITS.minViaHoleMm,
            Math.max(ROUTE_LIMITS.minViaHoleMm, (viaDiameter ?? ROUTE_LIMITS.maxViaMm) - 0.05),
          )
        : undefined;
    const from = typeof r.from === "string" && r.from && r.from.length <= 200 ? normalizePadSelector(r.from) : undefined;
    const to = typeof r.to === "string" && r.to && r.to.length <= 200 ? normalizePadSelector(r.to) : undefined;
    const pair = from && to && from !== to ? { from, to } : null;
    const route: ManualRoute = {
      connection: r.connection,
      ...(pair ? { from: pair.from, to: pair.to } : {}),
      points,
      width,
      ...(net ? { net } : {}),
      ...(r.arco === true ? { arco: true } : {}),
      ...(r.importato === true ? { importato: true } : {}),
      ...(r.netTie === true ? { netTie: true } : {}),
      ...(viaDiameter !== undefined ? { viaDiameter } : {}),
      ...(viaHoleDiameter !== undefined ? { viaHoleDiameter } : {}),
    };
    if (pair) route.id = manualRouteKey(route);
    out.push(route);
  }
  return out;
}

/**
 * Replaces in `current` the routes that `incoming` redraws (same key) and
 * appends the rest. Redrawing the same two pads replaces the previous path;
 * a second branch from the same pad does not touch the first.
 */
export function mergeManualRoutes(current: ManualRoute[], incoming: ManualRoute[]): ManualRoute[] {
  const keys = new Set(incoming.map(manualRouteKey));
  const dedup = new Map<string, ManualRoute>();
  for (const r of incoming) dedup.set(manualRouteKey(r), r);
  return [...current.filter((r) => !keys.has(manualRouteKey(r))), ...dedup.values()];
}

/**
 * A resolver from ".R1 > .pin1" to the source_port_id it names, on a compiled
 * circuit. The pin is matched on the port name and on its hints, as the
 * editor writes whichever of the two the port has.
 */
export function portSelectorResolver(circuitJson: unknown[]): (selector: string) => string | null {
  const els = circuitJson as El[];
  const componentByName = new Map<string, string>();
  for (const e of els) {
    if (e?.type !== "source_component") continue;
    if (typeof e.name === "string" && typeof e.source_component_id === "string") {
      componentByName.set(e.name, e.source_component_id);
    }
  }
  const portsOf = new Map<string, El[]>();
  for (const e of els) {
    if (e?.type !== "source_port" || typeof e.source_component_id !== "string") continue;
    portsOf.set(e.source_component_id, [...(portsOf.get(e.source_component_id) ?? []), e]);
  }
  return (selector: string) => {
    const m = /^\.(.+?)\s*>\s*\.(.+)$/.exec(selector.trim());
    if (!m) return null;
    const compId = componentByName.get(m[1].trim());
    if (!compId) return null;
    const pin = m[2].trim();
    for (const p of portsOf.get(compId) ?? []) {
      const hints = Array.isArray(p.port_hints) ? (p.port_hints as unknown[]) : [];
      if (p.name === pin || hints.includes(pin)) return typeof p.source_port_id === "string" ? p.source_port_id : null;
    }
    return null;
  };
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
  /** routes ADDED as a further branch of their net, without replacing copper */
  branches: string[];
  /** declared connections that do not exist in the project */
  unknown: string[];
}

/** what an earlier application left behind: recognised so it can be redone, never doubled */
const isAppliedManualCopper = (e: El): boolean =>
  (e.type === "pcb_trace" && String(e.pcb_trace_id ?? "").startsWith("pcb_trace_manual_")) ||
  (e.type === "pcb_via" && (e.manual === true || String(e.pcb_via_id ?? "").startsWith("pcb_via_manual_")));

const markers = (route: ManualRoute): El => ({
  // the marker every later pass respects: hand-drawn copper is never
  // ripped, straightened, widened or un-routed by automatic machinery
  manual: true,
  manual_route_id: manualRouteKey(route),
  ...(route.arco ? { arco: true } : {}),
  ...(route.importato ? { importato: true } : {}),
  ...(route.netTie ? { netTie: true } : {}),
});

/**
 * Replaces, in the compiled circuit, the geometry of the manually routed
 * connections. The vias that belonged to the old trace are removed along with
 * it, otherwise orphaned holes would remain in the middle of the copper.
 *
 * Three kinds of route:
 *   - its two pads are named together by a source_trace (or it predates the
 *     pad fields): it REPLACES that connection's copper;
 *   - its two pads are on one net but no <trace> names them together: it is
 *     a BRANCH of the net, added next to the copper already there. Replacing
 *     the anchor connection's copper with it disconnected whatever that copper
 *     reached;
 *   - `net`: a whole net's imported tree (see ManualRoute.net).
 *
 * The function can run on a circuit it already ran on — the compile cache
 * goes through it again on every local reroute — so what an earlier pass
 * created (pcb_trace_manual_*, the manual vias) is removed first and rebuilt:
 * running it twice gives the same board, not a doubled branch.
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
  /*
   * Hand copper whose route is no longer in the file goes too: a released or
   * deleted route must not survive as copper marked `manual` that nothing
   * describes any more. Only copper that carries its route key is judged this
   * way; older copper without the key is left as it was.
   */
  const keys = new Set(routes.map(manualRouteKey));
  const els = (circuitJson as El[]).filter(
    (e) =>
      !isAppliedManualCopper(e) &&
      !(e.type === "pcb_trace" && e.manual === true && typeof e.manual_route_id === "string" && !keys.has(e.manual_route_id)),
  );
  if (routes.length === 0) {
    return { circuitJson: els.length === circuitJson.length ? circuitJson : els, applied: [], branches: [], unknown: [] };
  }

  const sourceTraceIdByName = new Map<string, string>();
  const subcircuitOfTrace = new Map<string, string>();
  for (const e of els) {
    if (e.type !== "source_trace") continue;
    const name = e.display_name;
    const id = e.source_trace_id;
    if (typeof name === "string" && typeof id === "string") sourceTraceIdByName.set(name, id);
    if (typeof id === "string" && typeof e.subcircuit_id === "string") subcircuitOfTrace.set(id, e.subcircuit_id);
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

  /** the source trace naming BOTH ports, if any */
  const resolvePort = portSelectorResolver(els);
  const directTrace = (a: string, b: string): string | null => {
    for (const e of els) {
      if (e.type !== "source_trace" || typeof e.source_trace_id !== "string") continue;
      const ports = (e.connected_source_port_ids as unknown[] | undefined) ?? [];
      if (ports.includes(a) && ports.includes(b)) return e.source_trace_id;
    }
    return null;
  };

  const applied: string[] = [];
  const branchNames: string[] = [];
  const unknown: string[] = [];
  const replacing = new Map<string, ManualRoute>();
  /** further copper of a connection: a net's tree, or a branch drawn next to it */
  const rami = new Map<string, ManualRoute[]>();
  const addBranch = (id: string, route: ManualRoute) => rami.set(id, [...(rami.get(id) ?? []), route]);

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
        addBranch(ids[0], route);
      }
      // the net's other connections carry no copper of their own: it is the
      // same copper, and drawing it twice would be a trace on top of a trace
      for (const id of ids.slice(1)) if (!replacing.has(id)) replacing.set(id, { ...route, points: [] });
      continue;
    }

    if (route.from && route.to) {
      const a = resolvePort(route.from);
      const b = resolvePort(route.to);
      if (!a || !b) {
        unknown.push(manualRouteKey(route));
        continue;
      }
      const direct = directTrace(a, b);
      if (direct && !replacing.has(direct)) {
        replacing.set(direct, route);
        applied.push(route.connection);
        continue;
      }
      // not named together: a branch of the net, anchored to its connection
      const anchor = direct ?? sourceTraceIdByName.get(route.connection);
      if (!anchor) {
        unknown.push(route.connection);
        continue;
      }
      addBranch(anchor, route);
      branchNames.push(manualRouteKey(route));
      continue;
    }

    const id = sourceTraceIdByName.get(route.connection);
    if (!id) {
      unknown.push(route.connection);
      continue;
    }
    if (replacing.has(id)) addBranch(id, route);
    else {
      replacing.set(id, route);
      applied.push(route.connection);
    }
  }
  if (replacing.size === 0 && rami.size === 0) return { circuitJson: els, applied, branches: branchNames, unknown };

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
      if (route.points.length < 2) continue; // emptied: the net is carried elsewhere
      out.push({
        ...e,
        ...markers(route),
        route: toCircuitRoute(route, viaDiameter, viaHoleDiameter),
      });
      continue;
    }
    out.push(e);
  }

  const created = (id: string, pcbTraceId: string, route: ManualRoute): El => ({
    type: "pcb_trace",
    pcb_trace_id: pcbTraceId,
    source_trace_id: id,
    /*
     * The subcircuit of the connection: it is what tells the routing-problem
     * builder that the connection already has copper. Without it a local
     * reroute asked the solver to route it again, next to the hand trace.
     */
    ...(subcircuitOfTrace.has(id) ? { subcircuit_id: subcircuitOfTrace.get(id) } : {}),
    ...markers(route),
    route: toCircuitRoute(route, viaDiameter, viaHoleDiameter),
  });

  // the other branches, added as they are
  let ramo = 0;
  for (const [id, lista] of rami) {
    for (const route of lista) {
      if (route.points.length < 2) continue;
      out.push(created(id, `pcb_trace_manual_branch_${ramo++}`, route));
    }
  }

  // connections never routed by the autorouter: the manual trace creates them
  for (const [id, route] of replacing) {
    if (done.has(id)) continue;
    // emptied on purpose: it is a net whose copper is already carried by
    // another connection of the same net
    if (route.points.length < 2) continue;
    out.push(created(id, `pcb_trace_manual_${id}`, route));
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
   * Marked `manual` like the trace it belongs to: a zone rip-up that deleted
   * the hole and kept the hand trace left copper changing face through nothing.
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
  for (const e of [...out]) {
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
        manual: true,
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

  return { circuitJson: out, applied, branches: branchNames, unknown };
}
