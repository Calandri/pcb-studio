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
import { pointSegDistance } from "./drc";
import { retiDelCircuito } from "./gruppi-di-rame";
import { STRATI_NOTI, stratiDiRame, type StratoDiRame } from "./strati-rame";
import { viaPassante, vieSemprePassanti } from "./via-layers";

/** a copper layer a route point can be on: every layer a board can have (strati-rame.ts) */
export type Layer = StratoDiRame;

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

  /**
   * This route REPLACES copper the files draw: the trace of `connection` (named by part and pin, never by id).
   * `original` is that trace as it was when the gesture started: it tells two traces of one connection apart
   * (the nearest path wins) and it is what an undo puts back without a compile. The compile and the fast update
   * take the file's trace OUT and put this one in. If the files no longer have a trace of that connection, the
   * route is an orphan and is NOT applied. With no points of its own the route only takes the file's trace out.
   *
   * Such a route is a CORRECTION of the files, not a drawing: it carries the connection, its path, its width and
   * its vias, and nothing else (no pads, no net, no arc). Its coordinates are kept to 0.0001 mm, where a drawn
   * route is rounded to 0.001: a segment at 45 degrees stays one when both its ends keep the fourth decimal.
   */
  replaces?: { original: ManualRoutePoint[]; width: number };
  /**
   * The gesture it comes from: the same on every correction of one drag, undone, released and copied together.
   * A HAND route carries it too once a gesture of Sposta has moved it (a route drawn in Instrada or imported from
   * another CAD, rewritten in its place: see applyCopperPatch). It stays the hand route it was, on its grid.
   */
  gesto?: string;
  /** when it was made, ISO 8601 */
  at?: string;
}

/** A via the files put at `from`, that the person moved to `to`. */
export interface ManualViaMove {
  /** the net of the via by NAME ("GND", "P3V3"), never an id and never the via's own name (VG12 slips) */
  net: string;
  from: { x: number; y: number };
  to: { x: number; y: number };
  /** the via itself, so that whoever copies the correction into the sources need not read the circuit */
  holeDiameter: number;
  outerDiameter: number;
  layers: string[];
  /** the gesture it comes from: the same on every correction of one drag, undone, released and copied together */
  gesto?: string;
  /** when it was made, ISO 8601 */
  at?: string;
}

type El = Record<string, unknown>;

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const round3 = (v: number): number => Math.round(v * 1000) / 1000;
/** the grid of a correction of the files' copper (see ManualRoute.replaces): a tenth of a micron */
export const round4 = (v: number): number => Math.round(v * 1e4) / 1e4;
/**
 * The layers a route is read on. The list stopped at inner2: a route drawn
 * through inner3 on a 6-layer board was refused whole when read, as "a layer
 * that does not exist".
 */
const LAYERS: readonly Layer[] = STRATI_NOTI;
/** the four layers a route could be written on before, and was laid on whatever the board declares (see conLePisteAMano) */
const SEMPRE_POSATI: readonly string[] = stratiDiRame(4);

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

/** a path as text, for the digest of a key */
const firma = (points: readonly ManualRoutePoint[]): string => points.map((p) => `${p.x},${p.y},${p.layer}`).join(";");

/**
 * The key a route is stored and replaced by.
 *   - a correction of the files' copper (`replaces`): its connection plus the
 *     path it started from. The connection alone is not enough: two <trace> of
 *     one pin toward one net have the same name (measured: two source traces
 *     with one display_name), and keyed by it the correction of the second
 *     erased the one of the first. A trace moved again keeps the starting path
 *     of the first move (see applyCopperPatch), hence its key;
 *   - pads known: the pair, so every branch has its own;
 *   - a net's imported copper: the net plus its geometry, since a net tree is
 *     many routes and none of them replaces another;
 *   - older entries: the connection, as before.
 */
export function manualRouteKey(route: ManualRoute): string {
  if (route.replaces) return `${route.connection} @ ${digest(firma(route.replaces.original))}`;
  if (route.from && route.to) return pairKey(route.from, route.to);
  if (route.net) {
    // the geometry as a short digest: the key is written on every piece of copper
    return `net.${route.net} @ ${digest(firma(route.points))}`;
  }
  return route.connection;
}

/** the key a moved via is stored by: its net and where the files put it */
export function viaMoveKey(via: Pick<ManualViaMove, "net" | "from">): string {
  return `${via.net} @ ${via.from.x},${via.from.y}`;
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

/** a gesture id as the editor writes it, or undefined */
const gestoDi = (v: unknown): string | undefined => (typeof v === "string" && /^[\w-]{1,64}$/.test(v) ? v : undefined);
/** an ISO 8601 instant, or undefined */
const quandoDi = (v: unknown): string | undefined =>
  typeof v === "string" && v.length <= 40 && Number.isFinite(Date.parse(v)) ? v : undefined;

/**
 * The points of a path, read one by one: null as soon as one is not a point,
 * has a non-finite or absurd coordinate or names a layer that does not exist.
 * Consecutive identical points are dropped; the same place on another layer
 * stays, that is a via.
 */
function leggiPunti(raw: unknown[], arrotonda: (v: number) => number): ManualRoutePoint[] | null {
  const points: ManualRoutePoint[] = [];
  for (const p of raw) {
    if (typeof p !== "object" || p === null) return null;
    const q = p as Record<string, unknown>;
    if (!finite(q.x) || !finite(q.y)) return null;
    if (Math.abs(q.x) > ROUTE_LIMITS.maxCoordMm || Math.abs(q.y) > ROUTE_LIMITS.maxCoordMm) return null;
    // a missing layer is the old default; an unknown one is refused
    const layer = q.layer === undefined ? "top" : (q.layer as Layer);
    if (!LAYERS.includes(layer)) return null;
    const point = { x: arrotonda(q.x), y: arrotonda(q.y), layer };
    const prev = points[points.length - 1];
    if (prev && prev.x === point.x && prev.y === point.y && prev.layer === point.layer) continue;
    points.push(point);
  }
  return points;
}

/**
 * Reads routes defensively. What is rejected, and why:
 *   - a point with a non-finite or absurd coordinate: the whole route, since a
 *     route with a hole in the middle is not the route that was drawn;
 *   - a point on a layer that does not exist (not one of top, inner1..inner6,
 *     bottom): the whole route. It used to be moved silently to the top face,
 *     i.e. copper where nobody drew it. Whether THIS board has the layer is
 *     asked when the route is laid (see conLePisteAMano): the file is read
 *     without a board;
 *   - consecutive identical points: dropped (a zero-length segment is noise
 *     for every check), while the same x/y on another layer stays — that is a
 *     via;
 *   - widths and via sizes: clamped to ROUTE_LIMITS, a zero or negative via
 *     is ignored (the project default applies);
 *   - a `replaces` that does not say what it replaces (no starting path of two
 *     points, no width): the whole route. Read without it the route would be
 *     ADDED next to the trace of the files, which is the doubled copper the
 *     field exists to prevent.
 *
 * A route with `replaces` may have no points at all (it only takes the file's
 * trace out), is kept to 0.0001 mm and carries no pads, no net and no arc: see
 * ManualRoute.replaces. A file written before these fields has none of them
 * and reads as it always did.
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

    let replaces: ManualRoute["replaces"];
    if (r.replaces !== undefined) {
      if (typeof r.replaces !== "object" || r.replaces === null) continue;
      const s = r.replaces as Record<string, unknown>;
      if (!Array.isArray(s.original) || s.original.length > maxPoints || !finite(s.width)) continue;
      const original = leggiPunti(s.original, round4);
      if (!original || original.length < 2) continue;
      replaces = { original, width: clamp(s.width, ROUTE_LIMITS.minWidthMm, ROUTE_LIMITS.maxWidthMm) };
    }

    // a correction with no points of its own only takes the trace out; a drawn route is its points
    const scritti = replaces && r.points === undefined ? [] : r.points;
    if (!Array.isArray(scritti) || scritti.length > maxPoints) continue;
    const points = leggiPunti(scritti, replaces ? round4 : round3);
    // two points are the minimum for a segment: below that it is not a trace
    if (!points || (replaces ? points.length === 1 : points.length < 2)) continue;
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
    const gesto = gestoDi(r.gesto);
    const at = quandoDi(r.at);
    const delGesto = { ...(gesto ? { gesto } : {}), ...(at ? { at } : {}) };
    if (replaces) {
      out.push({
        connection: r.connection,
        points,
        width,
        ...(viaDiameter !== undefined ? { viaDiameter } : {}),
        ...(viaHoleDiameter !== undefined ? { viaHoleDiameter } : {}),
        replaces,
        ...delGesto,
      });
      continue;
    }
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
      ...delGesto,
    };
    if (pair) route.id = manualRouteKey(route);
    out.push(route);
  }
  return out;
}

/** how many moved vias a file is read for at most: as many as its routes */
const MAX_VIE_NEL_FILE = FILE_LIMITS.maxRoutes;

/**
 * Reads the moved vias defensively: an entry that is not one is dropped, never
 * thrown. A file written before the field existed has none: an empty list.
 *   - the net by name, and the two places, finite and on a board, kept to
 *     0.0001 mm; an entry that moves nothing (`to` is `from`) is not a move;
 *   - hole, ring and layers: they are the via whoever copies the correction has
 *     to write, so an entry without them is not one. Sizes are clamped to
 *     ROUTE_LIMITS, like the vias of a route;
 *   - two entries for one via (same net, same `from`): the last one.
 */
export function parseManualViaMoves(value: unknown, max: number = MAX_VIE_NEL_FILE): ManualViaMove[] {
  if (!Array.isArray(value)) return [];
  const perChiave = new Map<string, ManualViaMove>();
  const posto = (v: unknown): { x: number; y: number } | null => {
    if (typeof v !== "object" || v === null) return null;
    const q = v as Record<string, unknown>;
    if (!finite(q.x) || !finite(q.y)) return null;
    if (Math.abs(q.x) > ROUTE_LIMITS.maxCoordMm || Math.abs(q.y) > ROUTE_LIMITS.maxCoordMm) return null;
    return { x: round4(q.x), y: round4(q.y) };
  };
  for (const item of value) {
    if (perChiave.size >= max) break;
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    if (typeof r.net !== "string" || !r.net || r.net.length > 200) continue;
    const from = posto(r.from);
    const to = posto(r.to);
    if (!from || !to || (from.x === to.x && from.y === to.y)) continue;
    if (!finite(r.outerDiameter) || r.outerDiameter <= 0 || !finite(r.holeDiameter) || r.holeDiameter <= 0) continue;
    const outerDiameter = clamp(r.outerDiameter, ROUTE_LIMITS.minViaMm, ROUTE_LIMITS.maxViaMm);
    const holeDiameter = clamp(r.holeDiameter, ROUTE_LIMITS.minViaHoleMm, Math.max(ROUTE_LIMITS.minViaHoleMm, outerDiameter - 0.05));
    if (!Array.isArray(r.layers)) continue;
    const layers = [...new Set(r.layers)];
    if (layers.length < 2 || !layers.every((l): l is Layer => LAYERS.includes(l as Layer))) continue;
    const gesto = gestoDi(r.gesto);
    const at = quandoDi(r.at);
    const via: ManualViaMove = { net: r.net, from, to, holeDiameter, outerDiameter, layers, ...(gesto ? { gesto } : {}), ...(at ? { at } : {}) };
    const chiave = viaMoveKey(via);
    perChiave.delete(chiave);
    perChiave.set(chiave, via);
  }
  return [...perChiave.values()];
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

/** how the corrections of the files' copper stand on a board: see statoDelRame */
export interface StatoDelRame {
  /** corrections whose starting copper is not on the board (rule 3): not laid, by key */
  orfane: { routes: string[]; vias: string[] };
  /** corrections whose result the files already draw (rule 4): not laid, and taken out of the file at the next save */
  assorbite: { routes: string[]; vias: string[] };
}

export interface ApplyResult {
  circuitJson: unknown[];
  /** connections whose geometry was replaced */
  applied: string[];
  /** routes ADDED as a further branch of their net, without replacing copper */
  branches: string[];
  /** declared connections that do not exist in the project */
  unknown: string[];
  /** the corrections of the files' copper that were not laid, and why */
  rame: StatoDelRame;
}

/** what an earlier application left behind: recognised so it can be redone, never doubled */
const isAppliedManualCopper = (e: El): boolean =>
  (e.type === "pcb_trace" && String(e.pcb_trace_id ?? "").startsWith("pcb_trace_manual_")) ||
  (e.type === "pcb_via" && (e.manual === true || String(e.pcb_via_id ?? "").startsWith("pcb_via_manual_")));

/**
 * WHAT THE COPPER OF A CORRECTION REMEMBERS of the trace of the files it took
 * the place of: the starting path of its route (ManualRoute.replaces) and the
 * size the vias of that trace had on the board. It is written on the board
 * because the fast update works on the saved board alone: when the correction
 * is taken out of the file (Cmd+Z, a release) the trace of the files is on no
 * board any more, and without this only a compile brought it back (measured in
 * phase 0).
 *
 * The size of the vias is read on the board, not asked of the route: `replaces`
 * says a path and a width, and a trace put back with the vias of the project's
 * default would be other copper than the one the files draw.
 */
interface Sostituita {
  original: ManualRoutePoint[];
  width: number;
  viaDiameter?: number;
  viaHoleDiameter?: number;
}

/** the same, for a trace a correction took OUT: kept on its source trace, since no copper is left to carry it */
interface Tolta {
  manual_route_id: string;
  /** the id the trace had on this board: it goes back under it */
  pcb_trace_id: string;
  replaces: Sostituita;
}

/** read back from a board, which is data like any other: null when it does not say a path */
function sostituitaDi(v: unknown): Sostituita | null {
  if (typeof v !== "object" || v === null) return null;
  const s = v as Record<string, unknown>;
  if (!Array.isArray(s.original) || !finite(s.width) || s.width <= 0) return null;
  const original = leggiPunti(s.original, round4);
  if (!original || original.length < 2) return null;
  return {
    original,
    width: s.width,
    ...(finite(s.viaDiameter) && s.viaDiameter > 0 ? { viaDiameter: s.viaDiameter } : {}),
    ...(finite(s.viaHoleDiameter) && s.viaHoleDiameter > 0 ? { viaHoleDiameter: s.viaHoleDiameter } : {}),
  };
}

/** the trace of the files as the board draws it again: its starting path, at its width, with its vias */
function percorsoRicordato(r: Sostituita, viaDiameter: number, viaHoleDiameter: number): El[] {
  return toCircuitRoute(
    { connection: "", points: r.original, width: r.width, viaDiameter: r.viaDiameter, viaHoleDiameter: r.viaHoleDiameter },
    viaDiameter,
    viaHoleDiameter,
  );
}

function tolteDi(sorgente: El): Tolta[] {
  if (!Array.isArray(sorgente.manual_removed)) return [];
  const out: Tolta[] = [];
  for (const v of sorgente.manual_removed as unknown[]) {
    if (typeof v !== "object" || v === null) continue;
    const t = v as Record<string, unknown>;
    const replaces = sostituitaDi(t.replaces);
    if (typeof t.manual_route_id !== "string" || typeof t.pcb_trace_id !== "string" || !replaces) continue;
    out.push({ manual_route_id: t.manual_route_id, pcb_trace_id: t.pcb_trace_id, replaces });
  }
  return out;
}

const markers = (route: ManualRoute, ricordo?: Sostituita): El => ({
  // the marker every later pass respects: hand-drawn copper is never
  // ripped, straightened, widened or un-routed by automatic machinery
  manual: true,
  manual_route_id: manualRouteKey(route),
  ...(route.arco ? { arco: true } : {}),
  ...(route.importato ? { importato: true } : {}),
  ...(route.netTie ? { netTie: true } : {}),
  // the copper of a correction: what it took the place of (see Sostituita)
  ...(ricordo ? { replaces: ricordo } : {}),
});

const MARCATORI = ["manual", "manual_route_id", "arco", "importato", "netTie", "replaces"] as const;
/** a trace without what a hand route wrote on it: what it is again once the route is gone, or before another is laid */
function senzaMarcatori(e: El): El {
  const out = { ...e };
  for (const k of MARCATORI) delete out[k];
  return out;
}

/**
 * Two places that are one. Less than a step of the grid of a correction
 * (0.0001 mm): two points of that grid are never taken for one. More than what
 * rounding a number of the board to that grid can move it (0.00005 mm) plus
 * what a sum of floats leaves between two numbers meant equal.
 */
const STESSO_POSTO_MM = 0.00006;
const stessoPosto = (ax: number, ay: number, bx: number, by: number): boolean =>
  Math.abs(ax - bx) < STESSO_POSTO_MM && Math.abs(ay - by) < STESSO_POSTO_MM;
const chiaveDelPosto = (x: unknown, y: unknown): string => `${round4(num(x))},${round4(num(y))}`;

/**
 * The path of a pcb_trace as a route stores it: its wires with their layer, a
 * via being where two of them share a place on two layers. What the editor
 * writes in `replaces.original`, and what a correction is compared with.
 */
export function percorsoDellaPista(pcbTrace: Record<string, unknown>): ManualRoutePoint[] {
  const out: ManualRoutePoint[] = [];
  for (const p of (Array.isArray(pcbTrace.route) ? pcbTrace.route : []) as El[]) {
    if (p.route_type === "via" || !finite(p.x) || !finite(p.y)) continue;
    const point = { x: round4(p.x), y: round4(p.y), layer: String(p.layer ?? "top") as Layer };
    const prev = out[out.length - 1];
    if (prev && prev.x === point.x && prev.y === point.y && prev.layer === point.layer) continue;
    out.push(point);
  }
  return out;
}

/**
 * The path the files drew where the copper of a correction now is: what that
 * copper remembers (see Sostituita), null for any other trace. Whoever moves
 * such a trace again starts from here, not from the path on screen.
 */
export function partenzaRicordata(pcbTrace: Record<string, unknown>): ManualRoutePoint[] | null {
  return pcbTrace.manual === true ? (sostituitaDi(pcbTrace.replaces)?.original ?? null) : null;
}

/** whether two paths are the same copper: the same places on the same layers, read from either end */
export function stessoPercorso(a: readonly ManualRoutePoint[], b: readonly ManualRoutePoint[]): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  const uguali = (p: ManualRoutePoint, q: ManualRoutePoint) => p.layer === q.layer && stessoPosto(p.x, p.y, q.x, q.y);
  return a.every((p, i) => uguali(p, b[i])) || a.every((p, i) => uguali(p, b[b.length - 1 - i]));
}

/** how far two paths are from each other: the farthest a corner of one is from the other */
function distanzaFraPercorsi(a: readonly ManualRoutePoint[], b: readonly ManualRoutePoint[]): number {
  if (a.length === 0 || b.length === 0) return Number.POSITIVE_INFINITY;
  const daUno = (p: ManualRoutePoint, altro: readonly ManualRoutePoint[]): number => {
    let m = Math.hypot(p.x - altro[0].x, p.y - altro[0].y);
    for (let i = 1; i < altro.length; i++) {
      m = Math.min(m, pointSegDistance(p.x, p.y, altro[i - 1].x, altro[i - 1].y, altro[i].x, altro[i].y));
    }
    return m;
  };
  const verso = (da: readonly ManualRoutePoint[], altro: readonly ManualRoutePoint[]) =>
    da.reduce((m, p) => Math.max(m, daUno(p, altro)), 0);
  return Math.max(verso(a, b), verso(b, a));
}

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
 * AND THE CORRECTIONS OF THE FILES' COPPER: a route with `replaces`, a moved
 * via (`vias`). Their six rules are here and nowhere else, so the compile and
 * the fast update give the same board:
 *   1. a route with `replaces` takes OUT the trace the files draw for its
 *      connection, found by the NAME of the connection (part and pin), and
 *      puts its own in: never a second trace next to the first. Where the
 *      trace starts and ends is no key: a part moved by hand carries the
 *      copper of its files along in a compile and not in the fast update. The
 *      starting path only picks one of two traces of one connection, the
 *      nearest. The vias of the trace go with it, unless another trace uses
 *      them;
 *   2. a moved via takes the lone via of its net from `from` to `to`, with the
 *      part and the ports tscircuit puts beside a <via>, tied to the hole by
 *      position alone. A via inside the path of a trace is not moved this way:
 *      it travels with the `replaces` route of its trace;
 *   3. ORPHANS: the trace or the via it starts from is not on the board. The
 *      correction is not laid, and is listed (see statoDelRame);
 *   4. ABSORBED: the files already draw the result (a trace of the connection
 *      on the path of the route; a via of the net in `to` and none in `from`).
 *      The correction is not laid: it leaves the file at the next save;
 *   5. laying them twice gives the same board, with no id doubled: the copper
 *      of a correction carries its key, a moved via where it came from;
 *   6. each one stands alone: one absorbed or orphaned does not stop the rest.
 *
 * And what a correction laid goes back when the correction is gone: the trace
 * of the files on its starting path, the via where the files put it. The saved
 * board remembers both (see Sostituita), so an undo needs no compile.
 *
 * The function can run on a circuit it already ran on — the compile cache
 * goes through it again on every local reroute — so what an earlier pass
 * created (pcb_trace_manual_*, the manual vias) is removed first and rebuilt:
 * running it twice gives the same board, not a doubled branch.
 *
 * AND EVERY VIA OF THE BOARD IT GIVES BACK IS A THROUGH HOLE (see
 * vieSemprePassanti). It is done here because this is the last hand on the
 * copper in every path that lays any: the compile calls it after tscircuit,
 * the carried copper and the house rules, on the board saved early and on the
 * final one, and the fast update calls it on the saved board. What comes next
 * (the planes, the paste, the checks, the save) finds no via written on part
 * of the stack, whoever wrote it: tscircuit for a `<trace pcbPath>`, an older
 * engine on a saved board, the variant engine. A board with nothing to
 * complete comes back as the same array, as before.
 */
export function applyManualRoutes(args: {
  circuitJson: unknown[];
  routes: ManualRoute[];
  /** the moved vias of the same file (ManualEdits.pcb_vias): every caller that lays the routes of a file names them */
  vias?: readonly ManualViaMove[];
  viaDiameter?: number;
  viaHoleDiameter?: number;
}): ApplyResult {
  const esito = conLePisteAMano({ ...args, vias: args.vias ?? [] });
  return { ...esito, circuitJson: vieSemprePassanti(esito.circuitJson as El[]) };
}

/**
 * How the corrections of the files' copper stand on a board, without laying
 * anything: which find nothing to start from (orphans) and which the files
 * already contain (absorbed). The same reading applyManualRoutes lays them
 * with, on a board just compiled as on one they are already laid on.
 */
export function statoDelRame(circuitJson: unknown[], routes: ManualRoute[], vias: readonly ManualViaMove[]): StatoDelRame {
  return leggiIlRame(circuitJson as El[], routes, vias, 0.6, 0.3).stato;
}

interface RameLetto {
  /** the board without the hand copper nobody describes any more, and with the moved vias where they belong */
  els: El[];
  /** whether `els` differs from the board that was given */
  cambiata: boolean;
  /** the routes that can be laid on this board: its layers */
  routes: ManualRoute[];
  strati: string[];
  fuoriPila: string[];
  /** the trace each correction takes the place of; a correction with no points takes it out */
  sostituite: Map<El, ManualRoute>;
  /** the connections of the corrections laid */
  applicate: string[];
  stato: StatoDelRame;
}

/**
 * Reads the board for the hand copper of this file: takes off what an earlier
 * pass laid for routes that are gone (and puts back what those replaced),
 * moves the vias, and finds for every correction the trace it replaces.
 */
function leggiIlRame(
  circuitJson: El[],
  scritte: ManualRoute[],
  spostate: readonly ManualViaMove[],
  viaDiameter: number,
  viaHoleDiameter: number,
): RameLetto {
  /*
   * A ROUTE ON A LAYER THE BOARD DOES NOT HAVE IS NOT LAID.
   *
   * inner3..inner6 are read since the boards of six and eight layers. A board
   * taken back to four keeps in its file the routes drawn on them, and laid on
   * the board they would be copper that no view shows and no Gerber file
   * holds, with the connection counted as routed. Such a route stays in the
   * file, is left off the board (its connection is open again, and says so)
   * and is named in `unknown`. top, bottom, inner1 and inner2 are laid on any
   * board, as they always were: nothing changes for a route that could be
   * written before.
   */
  const strati = stratiDiRame(Number(circuitJson.find((e) => e.type === "pcb_board")?.num_layers ?? 2));
  const posabili = new Set([...strati, ...SEMPRE_POSATI]);
  const fuoriPila: string[] = [];
  const routes = scritte.filter((r) => {
    const mancante = r.points.find((p) => !posabili.has(p.layer));
    if (mancante) fuoriPila.push(`${manualRouteKey(r)} (${mancante.layer}: la scheda ha ${strati.length} strati)`);
    return !mancante;
  });
  /*
   * Hand copper whose route is no longer in the file goes too: a released or
   * deleted route must not survive as copper marked `manual` that nothing
   * describes any more. Only copper that carries its route key is judged this
   * way; older copper without the key is left as it was.
   *
   * The copper of a CORRECTION that is gone gives its place back to the trace
   * of the files: on the path it remembers, with its vias.
   */
  const keys = new Set(routes.map(manualRouteKey));
  let cambiata = false;
  const tornate: El[] = [];
  const els: El[] = [];
  for (const e of circuitJson) {
    if (isAppliedManualCopper(e)) {
      cambiata = true;
      continue;
    }
    if (e.type === "pcb_trace" && e.manual === true && typeof e.manual_route_id === "string" && !keys.has(e.manual_route_id)) {
      cambiata = true;
      const ricordo = sostituitaDi(e.replaces);
      if (!ricordo) continue;
      const tornata = { ...senzaMarcatori(e), route: percorsoRicordato(ricordo, viaDiameter, viaHoleDiameter) };
      tornate.push(tornata);
      els.push(tornata);
      continue;
    }
    if (e.type === "source_trace" && Array.isArray(e.manual_removed)) {
      const tolte = tolteDi(e);
      const ancora = tolte.filter((t) => keys.has(t.manual_route_id));
      if (ancora.length !== (e.manual_removed as unknown[]).length) {
        cambiata = true;
        const senza = { ...e };
        if (ancora.length > 0) senza.manual_removed = ancora;
        else delete senza.manual_removed;
        els.push(senza);
        for (const t of tolte) {
          if (keys.has(t.manual_route_id)) continue;
          tornate.push({
            type: "pcb_trace",
            pcb_trace_id: t.pcb_trace_id,
            source_trace_id: e.source_trace_id,
            ...(typeof e.subcircuit_id === "string" ? { subcircuit_id: e.subcircuit_id } : {}),
            route: percorsoRicordato(t.replaces, viaDiameter, viaHoleDiameter),
          });
        }
        continue;
      }
    }
    els.push(e);
  }
  if (tornate.length > 0) {
    // the traces taken out come back at the end; the ones replaced are already in their place
    const giaDentro = new Set(els);
    const idPresi = new Set(els.filter((e) => e.type === "pcb_trace").map((e) => String(e.pcb_trace_id ?? "")));
    for (const t of tornate) {
      if (giaDentro.has(t)) continue;
      let id = String(t.pcb_trace_id);
      for (let n = 1; idPresi.has(id); n++) id = `${String(t.pcb_trace_id)}_${n}`;
      idPresi.add(id);
      t.pcb_trace_id = id;
      els.push(t);
    }
    els.push(...vieDellePisteTornate(els, tornate, strati, viaDiameter, viaHoleDiameter));
  }

  const conLeVie = vieSpostate(els, spostate);
  const stato: StatoDelRame = {
    orfane: { routes: [], vias: conLeVie.orfane },
    assorbite: { routes: [], vias: conLeVie.assorbite },
  };
  const letto: RameLetto = {
    els: conLeVie.els,
    cambiata: cambiata || conLeVie.els !== els,
    routes,
    strati,
    fuoriPila,
    sostituite: new Map(),
    applicate: [],
    stato,
  };
  const correzioni = routes.filter((r) => r.replaces);
  if (correzioni.length === 0) return letto;

  /*
   * THE TRACE EACH CORRECTION REPLACES, by the name of its connection. Two
   * source traces can have one name (two <trace> of one pin toward one net):
   * the copper of all of them is the copper of that connection.
   */
  const nomeDellaSorgente = new Map<string, string>();
  const tolteDa = new Set<string>();
  for (const e of letto.els) {
    if (e.type !== "source_trace" || typeof e.source_trace_id !== "string" || typeof e.display_name !== "string") continue;
    nomeDellaSorgente.set(e.source_trace_id, e.display_name);
    for (const t of tolteDi(e)) tolteDa.add(t.manual_route_id);
  }
  const perConnessione = new Map<string, El[]>();
  for (const e of letto.els) {
    if (e.type !== "pcb_trace") continue;
    const nome = nomeDellaSorgente.get(String(e.source_trace_id ?? ""));
    if (nome === undefined) continue;
    // pushed, not copied: an imported net is thousands of traces under one name
    const sue = perConnessione.get(nome);
    if (sue) sue.push(e);
    else perConnessione.set(nome, [e]);
  }
  /** a trace of the files is taken by one correction only */
  const prese = new Set<El>();
  for (const route of correzioni) {
    const chiave = manualRouteKey(route);
    const piste = perConnessione.get(route.connection) ?? [];
    // already laid by an earlier pass: the same copper is laid again in its place
    const sua = piste.find((e) => e.manual === true && e.manual_route_id === chiave);
    if (sua) {
      prese.add(sua);
      letto.sostituite.set(sua, route);
      letto.applicate.push(route.connection);
      continue;
    }
    // taken out by an earlier pass: it stays out
    if (route.points.length === 0 && tolteDa.has(chiave)) {
      letto.applicate.push(route.connection);
      continue;
    }
    const deiFile = piste.filter((e) => e.manual !== true && !prese.has(e));
    if (deiFile.length === 0) {
      stato.orfane.routes.push(chiave);
      continue;
    }
    if (route.points.length > 0 && deiFile.some((e) => stessoPercorso(percorsoDellaPista(e), route.points))) {
      stato.assorbite.routes.push(chiave);
      continue;
    }
    let vicina = deiFile[0];
    let distanza = distanzaFraPercorsi(percorsoDellaPista(vicina), route.replaces!.original);
    for (const e of deiFile.slice(1)) {
      const d = distanzaFraPercorsi(percorsoDellaPista(e), route.replaces!.original);
      if (d < distanza) [vicina, distanza] = [e, d];
    }
    prese.add(vicina);
    letto.sostituite.set(vicina, route);
    letto.applicate.push(route.connection);
  }
  return letto;
}

/**
 * The holes of the traces of the files that are back on the board: one
 * `pcb_via` where each changes layer, unless a via is already there. Plain
 * rows, like the ones tscircuit writes for a <trace pcbPath> (the hole is of
 * the files' copper, not hand copper), tied to their trace.
 */
function vieDellePisteTornate(els: El[], tornate: El[], strati: string[], viaDiameter: number, viaHoleDiameter: number): El[] {
  const gia = new Set<string>();
  const idPresi = new Set<string>();
  const chiaveDiSorgente = new Map<string, string>();
  for (const e of els) {
    if (e.type === "pcb_via") {
      gia.add(chiaveDelPosto(e.x, e.y));
      idPresi.add(String(e.pcb_via_id ?? ""));
    } else if (e.type === "source_trace" && typeof e.source_trace_id === "string") {
      const k = e.subcircuit_connectivity_map_key;
      if (typeof k === "string" && k) chiaveDiSorgente.set(e.source_trace_id, k);
    }
  }
  const out: El[] = [];
  let n = 0;
  for (const pista of tornate) {
    for (const p of pista.route as El[]) {
      if (p.route_type !== "via") continue;
      const dove = chiaveDelPosto(p.x, p.y);
      if (gia.has(dove)) continue;
      gia.add(dove);
      let id = `pcb_via_tornata_${n++}`;
      while (idPresi.has(id)) id = `pcb_via_tornata_${n++}`;
      idPresi.add(id);
      const chiave = chiaveDiSorgente.get(String(pista.source_trace_id ?? ""));
      out.push({
        type: "pcb_via",
        pcb_via_id: id,
        pcb_trace_id: pista.pcb_trace_id,
        x: num(p.x),
        y: num(p.y),
        outer_diameter: num(p.via_diameter) || viaDiameter,
        hole_diameter: num(p.via_hole_diameter) || viaHoleDiameter,
        ...viaPassante(strati, [String(p.from_layer ?? "top"), String(p.to_layer ?? "bottom")]),
        from_layer: p.from_layer,
        to_layer: p.to_layer,
        ...(typeof pista.subcircuit_id === "string" ? { subcircuit_id: pista.subcircuit_id } : {}),
        ...(chiave ? { subcircuit_connectivity_map_key: chiave } : {}),
      });
    }
  }
  return out;
}

/**
 * THE MOVED VIAS (rule 2), on a board just compiled as on one they were
 * already moved on.
 *
 * A moved via says on the board where the files put it (`moved_from`): it is
 * how a second pass knows the via in `to` is its own work and not a via the
 * files already draw there (which would make the correction absorbed), and
 * what brings it back when the correction is gone. The part tscircuit lays
 * for a <via> (as wide as its ring: 0.3 x 0.3 mm for a via of its default
 * size) and its three ports name the hole nowhere: they are found where the
 * hole is, and travel with it.
 *
 * A via a trace passes through (a via point of its route) is not moved here:
 * the trace would be left changing layer through nothing.
 */
function vieSpostate(els: El[], spostate: readonly ManualViaMove[]): { els: El[]; orfane: string[]; assorbite: string[] } {
  const vie = els.filter((e) => e.type === "pcb_via");
  if (spostate.length === 0 && !vie.some((v) => v.moved_from !== undefined)) return { els, orfane: [], assorbite: [] };

  const reti = retiDelCircuito(els);
  const nomeDellaRete = (via: El): string => {
    const rete = reti.diVia(via as never);
    return rete ? reti.nome(rete) : "";
  };
  const nellePiste = new Set<string>();
  /** the parts tscircuit lays for a <via>, and what hangs on each: its ports */
  const corpi: El[] = [];
  const delCorpo = new Map<string, El[]>();
  const sorgentiDiVia = new Set<string>();
  for (const e of els) {
    if (e.type === "source_manually_placed_via") sorgentiDiVia.add(String(e.source_manually_placed_via_id ?? ""));
  }
  for (const e of els) {
    if (e.type === "pcb_trace") {
      for (const p of (Array.isArray(e.route) ? e.route : []) as El[]) {
        if (p.route_type === "via") nellePiste.add(chiaveDelPosto(p.x, p.y));
      }
    } else if (e.type === "pcb_component" && sorgentiDiVia.has(String(e.source_component_id ?? ""))) {
      corpi.push(e);
      delCorpo.set(String(e.pcb_component_id ?? ""), []);
    }
  }
  for (const e of els) {
    if (e.type !== "pcb_component" && typeof e.pcb_component_id === "string") delCorpo.get(e.pcb_component_id)?.push(e);
  }

  const cambi = new Map<El, El>();
  const sposta = (via: El, a: { x: number; y: number }, veniva: { x: number; y: number } | null) => {
    const x = num(via.x);
    const y = num(via.y);
    const nuova: El = { ...via, x: a.x, y: a.y };
    if (veniva) nuova.moved_from = { x: veniva.x, y: veniva.y };
    else delete nuova.moved_from;
    cambi.set(via, nuova);
    const corpo = corpi.find((c) => {
      const centro = c.center as { x?: unknown; y?: unknown } | undefined;
      return !cambi.has(c) && centro !== undefined && stessoPosto(num(centro.x), num(centro.y), x, y);
    });
    if (!corpo) return;
    cambi.set(corpo, { ...corpo, center: { ...(corpo.center as object), x: a.x, y: a.y } });
    for (const p of delCorpo.get(String(corpo.pcb_component_id ?? "")) ?? []) {
      if (finite(p.x) && finite(p.y) && stessoPosto(p.x, p.y, x, y)) cambi.set(p, { ...p, x: a.x, y: a.y });
    }
  };
  const postoDi = (v: unknown): { x: number; y: number } | null => {
    if (typeof v !== "object" || v === null) return null;
    const q = v as Record<string, unknown>;
    return finite(q.x) && finite(q.y) ? { x: q.x, y: q.y } : null;
  };

  // the vias an earlier pass moved: to where their correction puts them now, or back when it is gone
  const fatte = new Set<ManualViaMove>();
  for (const via of vie) {
    if (via.moved_from === undefined) continue;
    const veniva = postoDi(via.moved_from);
    if (!veniva) continue;
    const rete = nomeDellaRete(via);
    const sua = spostate.find((s) => !fatte.has(s) && s.net === rete && stessoPosto(s.from.x, s.from.y, veniva.x, veniva.y));
    if (!sua) {
      sposta(via, veniva, null);
      continue;
    }
    fatte.add(sua);
    if (!stessoPosto(num(via.x), num(via.y), sua.to.x, sua.to.y)) sposta(via, sua.to, veniva);
  }

  const orfane: string[] = [];
  const assorbite: string[] = [];
  /** a lone via of that net the files draw at that place, not taken by another correction */
  const deiFile = (rete: string, dove: { x: number; y: number }): El | undefined =>
    vie.find(
      (v) =>
        v.moved_from === undefined &&
        !cambi.has(v) &&
        stessoPosto(num(v.x), num(v.y), dove.x, dove.y) &&
        !nellePiste.has(chiaveDelPosto(v.x, v.y)) &&
        nomeDellaRete(v) === rete,
    );
  for (const s of spostate) {
    if (fatte.has(s)) continue;
    const via = deiFile(s.net, s.from);
    const arrivata = deiFile(s.net, s.to);
    if (via && !arrivata) sposta(via, s.to, s.from);
    else if (!via && arrivata) assorbite.push(viaMoveKey(s));
    // nothing to start from; or a via of the files at both ends, where moving one would put two holes in one place
    else orfane.push(viaMoveKey(s));
  }
  return { els: cambi.size > 0 ? els.map((e) => cambi.get(e) ?? e) : els, orfane, assorbite };
}

function conLePisteAMano({
  circuitJson,
  routes: scritte,
  vias: spostate,
  viaDiameter = 0.6,
  viaHoleDiameter = 0.3,
}: {
  circuitJson: unknown[];
  routes: ManualRoute[];
  vias: readonly ManualViaMove[];
  viaDiameter?: number;
  viaHoleDiameter?: number;
}): ApplyResult {
  const letto = leggiIlRame(circuitJson as El[], scritte, spostate, viaDiameter, viaHoleDiameter);
  const { els, routes, strati, sostituite, stato: rame } = letto;
  if (routes.length === 0) {
    return { circuitJson: letto.cambiata ? els : circuitJson, applied: [], branches: [], unknown: letto.fuoriPila, rame };
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

  const applied: string[] = [...letto.applicate];
  const branchNames: string[] = [];
  const unknown: string[] = [...letto.fuoriPila, ...rame.orfane.routes];
  const replacing = new Map<string, ManualRoute>();
  /** further copper of a connection: a net's tree, or a branch drawn next to it */
  const rami = new Map<string, ManualRoute[]>();
  const addBranch = (id: string, route: ManualRoute) => rami.set(id, [...(rami.get(id) ?? []), route]);

  for (const route of routes) {
    // a correction of the files' copper: its trace was found by leggiIlRame
    if (route.replaces) continue;

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
  if (replacing.size === 0 && rami.size === 0 && sostituite.size === 0) {
    return { circuitJson: els, applied, branches: branchNames, unknown, rame };
  }

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
  /*
   * The vias of a trace a correction replaces go with it, unless another
   * trace that stays uses them (rule 1): a hole two traces share is not the
   * replaced one's to take away.
   */
  if (sostituite.size > 0) {
    const usate = new Set<string>();
    const sue = new Set<string>();
    for (const e of els) {
      if (e.type !== "pcb_trace") continue;
      const va = sostituite.has(e) || (typeof e.source_trace_id === "string" && replacing.has(e.source_trace_id));
      for (const p of (Array.isArray(e.route) ? e.route : []) as El[]) {
        if (p.route_type !== "via") continue;
        (sostituite.has(e) ? sue : va ? doomedVias : usate).add(`${round3(num(p.x))},${round3(num(p.y))}`);
      }
    }
    for (const dove of sue) if (!usate.has(dove)) doomedVias.add(dove);
  }

  /*
   * What the copper of each correction remembers of the trace it replaces
   * (see Sostituita). The size of that trace's vias is the one its holes have
   * on this board; on a board the correction is already laid on, the one it
   * remembered then.
   */
  const viaIn = new Map<string, El>();
  if (sostituite.size > 0) {
    for (const e of els) if (e.type === "pcb_via") viaIn.set(`${round3(num(e.x))},${round3(num(e.y))}`, e);
  }
  const ricordoDella = (e: El, route: ManualRoute): Sostituita => {
    const prima = sostituitaDi(e.replaces);
    let corona = prima?.viaDiameter;
    let foro = prima?.viaHoleDiameter;
    if (!prima) {
      for (const p of (Array.isArray(e.route) ? e.route : []) as El[]) {
        const via = p.route_type === "via" ? viaIn.get(`${round3(num(p.x))},${round3(num(p.y))}`) : undefined;
        if (!via || num(via.outer_diameter) <= 0 || num(via.hole_diameter) <= 0) continue;
        corona = num(via.outer_diameter);
        foro = num(via.hole_diameter);
        break;
      }
    }
    corona ??= route.viaDiameter;
    foro ??= route.viaHoleDiameter;
    return {
      original: route.replaces!.original,
      width: route.replaces!.width,
      ...(corona !== undefined ? { viaDiameter: corona } : {}),
      ...(foro !== undefined ? { viaHoleDiameter: foro } : {}),
    };
  };

  /** what each source trace remembers of the traces the corrections take out of it (see Tolta) */
  const tolte = new Map<string, Tolta[]>();
  for (const [e, route] of sostituite) {
    if (route.points.length > 0 || typeof e.source_trace_id !== "string") continue;
    tolte.set(e.source_trace_id, [
      ...(tolte.get(e.source_trace_id) ?? []),
      { manual_route_id: manualRouteKey(route), pcb_trace_id: String(e.pcb_trace_id ?? ""), replaces: ricordoDella(e, route) },
    ]);
  }

  const out: El[] = [];
  const done = new Set<string>();
  for (const e of els) {
    // a via a correction moved is not the replaced trace's, wherever it landed
    if (e.type === "pcb_via" && e.moved_from === undefined && doomedVias.has(`${round3(num(e.x))},${round3(num(e.y))}`)) {
      continue;
    }
    const correzione = e.type === "pcb_trace" ? sostituite.get(e) : undefined;
    if (correzione) {
      // with no points of its own it only takes the trace out: its source trace remembers it
      if (correzione.points.length < 2) continue;
      const ricordo = ricordoDella(e, correzione);
      out.push({
        ...senzaMarcatori(e),
        ...markers(correzione, ricordo),
        /*
         * A correction that does not say the size of its vias keeps the one
         * of the trace it replaces: a gesture moves copper, it does not make
         * its holes the size of the project's default.
         */
        route: toCircuitRoute(
          {
            ...correzione,
            viaDiameter: correzione.viaDiameter ?? ricordo.viaDiameter,
            viaHoleDiameter: correzione.viaHoleDiameter ?? ricordo.viaHoleDiameter,
          },
          viaDiameter,
          viaHoleDiameter,
        ),
      });
      continue;
    }
    if (e.type === "source_trace" && typeof e.source_trace_id === "string" && tolte.has(e.source_trace_id)) {
      out.push({ ...e, manual_removed: [...tolteDi(e), ...tolte.get(e.source_trace_id)!] });
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
  /*
   * The hole goes through the board whatever two layers the trace joins there,
   * so the via lists the whole stack: `[from, to]`, as it used to, read as a
   * blind via to the planes and to the drill file (see vieSemprePassanti).
   */
  let nVia = 0;
  for (const e of [...out]) {
    if (e.type !== "pcb_trace" || !e.manual) continue;
    for (const p of (Array.isArray(e.route) ? e.route : []) as El[]) {
      if (p.route_type !== "via") continue;
      const key = `${round3(num(p.x))},${round3(num(p.y))}`;
      if (gia.has(key)) continue;
      gia.add(key);
      const dia = num(p.via_diameter) || viaDiameter;
      // the hole of a correction is where its trace changes layer, to the fourth decimal like the trace
      const arrotonda = e.replaces === undefined ? round3 : round4;
      out.push({
        type: "pcb_via",
        pcb_via_id: `pcb_via_manual_${nVia++}`,
        manual: true,
        x: arrotonda(num(p.x)),
        y: arrotonda(num(p.y)),
        outer_diameter: dia,
        hole_diameter: num(p.via_hole_diameter) || viaHoleDiameter,
        ...viaPassante(strati, [String(p.from_layer ?? "top"), String(p.to_layer ?? "bottom")]),
        subcircuit_connectivity_map_key:
          e.subcircuit_connectivity_map_key ??
          chiaveDiSorgente.get(String(e.source_trace_id ?? "")),
      });
    }
  }

  return { circuitJson: out, applied, branches: branchNames, unknown, rame };
}
