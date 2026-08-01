/**
 * What you need to know to route by hand, extracted from the Circuit JSON.
 *
 * The board drawing is already done by buildScene (components/board/render.ts):
 * here there is only what the drawing does not carry and the interaction
 * needs — which port a pad belongs to, which net it is on, and above all
 * WHICH declared connection is being implemented when two pads are joined.
 * Without this last piece a drawn trace remains geometry the compiler does
 * not know what to attach to (see manual-routes.ts).
 */

export interface RoutePad {
  /** pcb_smtpad_id or pcb_plated_hole_id */
  id: string;
  x: number;
  y: number;
  /** half-sides of the pad, for targeting a rectangle instead of a circle */
  hw: number;
  hh: number;
  /**
   * Degrees the pad is turned by.
   *
   * A pad can sit at an angle, and then a box aligned to the axes is not it:
   * clicking on the tip of a diagonal pad missed the copper and started a trace
   * from bare laminate a fraction of a millimetre to the side.
   */
  rot: number;
  /**
   * Direction in which the trace must LEAVE the pad, perpendicular to the
   * edge. Derived from where the pad sits relative to the component body: it
   * is the house rule (straight escape) and without it the first segment
   * comes out diagonally, stuck to the joint's copper.
   */
  escape: { dx: number; dy: number };
  layer: string;
  pcbPortId: string;
  sourcePortId: string;
  /** ".R1 > .pin1" */
  label: string;
  net: string | null;
  /** connectivity key: present even when the net has no name */
  netKey: string | null;
  /** true if it sits on all layers (plated hole) */
  throughHole: boolean;
}

export interface RouteConnection {
  /** display_name of the source_trace, the key manual-routes uses */
  name: string;
  sourceTraceId: string;
  sourcePortIds: string[];
  net: string | null;
}

export interface PcbRouteModel {
  pads: RoutePad[];
  connections: RouteConnection[];
  /** connection -> trace already present on the copper */
  routedByConnection: Map<string, { pcbTraceId: string; points: Array<{ x: number; y: number; layer: string }> }>;
}

type El = Record<string, unknown>;
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

export function buildRouteModel(circuitJson: unknown[] | null): PcbRouteModel {
  const empty: PcbRouteModel = { pads: [], connections: [], routedByConnection: new Map() };
  if (!circuitJson?.length) return empty;
  const els = circuitJson as El[];
  const by = (t: string) => els.filter((e) => e.type === t);

  const sourceComponentName = new Map<string, string>();
  for (const c of by("source_component")) {
    const id = str(c.source_component_id), n = str(c.name);
    if (id && n) sourceComponentName.set(id, n);
  }
  const sourcePort = new Map<string, El>();
  for (const p of by("source_port")) {
    const id = str(p.source_port_id);
    if (id) sourcePort.set(id, p);
  }
  const netNameByKey = new Map<string, string>();
  for (const n of by("source_net")) {
    const k = str(n.subcircuit_connectivity_map_key), name = str(n.name);
    if (k && name) netNameByKey.set(k, name);
  }
  const netBySourcePort = new Map<string, string>();
  const netKeyBySourcePort = new Map<string, string>();
  for (const t of by("source_trace")) {
    const key = str(t.subcircuit_connectivity_map_key);
    /*
     * The connectivity KEY always exists, the net name does not (implicit
     * nets have no declared <net>): it is the key that says which pads can be
     * connected to each other; the name is only for display.
     */
    if (key) {
      for (const pid of (Array.isArray(t.connected_source_port_ids) ? t.connected_source_port_ids : []) as unknown[]) {
        if (typeof pid === "string") netKeyBySourcePort.set(pid, key);
      }
    }
    const net = key ? (netNameByKey.get(key) ?? null) : null;
    if (!net) continue;
    for (const pid of (Array.isArray(t.connected_source_port_ids) ? t.connected_source_port_ids : []) as unknown[]) {
      if (typeof pid === "string") netBySourcePort.set(pid, net);
    }
  }

  const pcbPortById = new Map<string, El>();
  for (const p of by("pcb_port")) {
    const id = str(p.pcb_port_id);
    if (id) pcbPortById.set(id, p);
  }

  const labelOf = (sourcePortId: string): string => {
    const sp = sourcePort.get(sourcePortId);
    if (!sp) return sourcePortId;
    const comp = sourceComponentName.get(String(sp.source_component_id)) ?? "?";
    const hints = Array.isArray(sp.port_hints) ? (sp.port_hints as unknown[]) : [];
    const pin = str(sp.name) ?? (hints.find((h) => typeof h === "string") as string | undefined) ?? "?";
    return `.${comp} > .${pin}`;
  };

  const componentCenter = new Map<string, { x: number; y: number }>();
  for (const c of by("pcb_component")) {
    const id = str(c.pcb_component_id);
    const center = c.center as { x?: number; y?: number } | undefined;
    if (id) componentCenter.set(id, { x: num(center?.x), y: num(center?.y) });
  }

  const pads: RoutePad[] = [];
  const addPad = (e: El, through: boolean) => {
    const pcbPortId = str(e.pcb_port_id);
    if (!pcbPortId) return;
    const port = pcbPortById.get(pcbPortId);
    const sourcePortId = port ? str(port.source_port_id) : null;
    if (!sourcePortId) return;
    const w = num(e.width ?? e.outer_width ?? e.hole_diameter ?? 0.6);
    const h = num(e.height ?? e.outer_height ?? e.hole_diameter ?? 0.6);
    /*
     * Pad coordinates are rounded HERE, at the source. They arrive from the
     * Circuit JSON with fifteen decimals: the escape point is rounded to the
     * thousandth, and the stub between the two came out skewed by six
     * hundred-thousandths — i.e. an off-axis segment for the angle check.
     * Nobody notices half a micrometer of pad displacement; a segment at
     * 0.004 degrees, yes.
     */
    const x = round3(num(e.x)), y = round3(num(e.y));
    const center = componentCenter.get(String(e.pcb_component_id ?? ""));
    // escape from the side farthest from the body: on the axis where the
    // offset is largest, because that is the edge the pad faces outward from
    let escape = { dx: 1, dy: 0 };
    if (center) {
      const ox = x - center.x, oy = y - center.y;
      escape = Math.abs(ox) >= Math.abs(oy)
        ? { dx: Math.sign(ox) || 1, dy: 0 }
        : { dx: 0, dy: Math.sign(oy) || 1 };
    }
    pads.push({
      id: String(e.pcb_smtpad_id ?? e.pcb_plated_hole_id ?? pcbPortId),
      x, y,
      hw: Math.max(w, 0.2) / 2,
      hh: Math.max(h, 0.2) / 2,
      rot: typeof e.ccw_rotation === "number" && Number.isFinite(e.ccw_rotation) ? e.ccw_rotation : 0,
      escape,
      layer: through ? "all" : String(e.layer ?? "top"),
      pcbPortId, sourcePortId,
      label: labelOf(sourcePortId),
      net: netBySourcePort.get(sourcePortId) ?? null,
      netKey: netKeyBySourcePort.get(sourcePortId) ?? null,
      throughHole: through,
    });
  };
  for (const e of by("pcb_smtpad")) addPad(e, false);
  for (const e of by("pcb_plated_hole")) addPad(e, true);

  const connections: RouteConnection[] = [];
  for (const t of by("source_trace")) {
    const name = str(t.display_name), id = str(t.source_trace_id);
    if (!name || !id) continue;
    const key = str(t.subcircuit_connectivity_map_key);
    connections.push({
      name, sourceTraceId: id,
      sourcePortIds: ((Array.isArray(t.connected_source_port_ids) ? t.connected_source_port_ids : []) as unknown[])
        .filter((v): v is string => typeof v === "string"),
      net: key ? (netNameByKey.get(key) ?? null) : null,
    });
  }

  const nameByTraceId = new Map(connections.map((c) => [c.sourceTraceId, c.name]));
  const routedByConnection = new Map<string, { pcbTraceId: string; points: Array<{ x: number; y: number; layer: string }> }>();
  for (const t of by("pcb_trace")) {
    const name = nameByTraceId.get(String(t.source_trace_id ?? ""));
    if (!name || routedByConnection.has(name)) continue;
    const points = ((Array.isArray(t.route) ? t.route : []) as El[])
      .filter((p) => p.route_type !== "via")
      .map((p) => ({ x: num(p.x), y: num(p.y), layer: String(p.layer ?? "top") }));
    if (points.length > 1) {
      routedByConnection.set(name, { pcbTraceId: String(t.pcb_trace_id), points });
    }
  }

  return { pads, connections, routedByConnection };
}

/**
 * The declared connection joining two pads. It is what the drawn trace will
 * implement: without it, the geometry does not know what to attach to. If the
 * two pads are on the same net but no <trace> names them both, fall back to
 * the first connection of that net touching the starting pad, because on the
 * copper that net is a single node anyway.
 */
export function findConnection(
  model: PcbRouteModel,
  from: RoutePad,
  to: RoutePad,
): RouteConnection | null {
  const direct = model.connections.find(
    (c) => c.sourcePortIds.includes(from.sourcePortId) && c.sourcePortIds.includes(to.sourcePortId),
  );
  if (direct) return direct;
  if (from.net && from.net === to.net) {
    return (
      model.connections.find((c) => c.net === from.net && c.sourcePortIds.includes(from.sourcePortId)) ??
      model.connections.find((c) => c.net === from.net) ??
      null
    );
  }
  return null;
}

/**
 * Path from one point to another with ONLY 0, 45 or 90 degree segments.
 *
 * Previously the direction of each single segment was snapped to the nearest
 * multiple of 45: the segment stayed valid but did not reach where you
 * clicked, and above all the last segment towards the pad was not snapped at
 * all, so it came out at any angle. Here instead the requested point is
 * ALWAYS REACHED, splitting into two segments: one straight and one at 45.
 * That is what every layout editor does, and it is the only way to guarantee
 * the angle without moving the endpoint.
 *
 * diagonalFirst decides which of the two comes first: needed to leave the
 * starting pad straight and to arrive straight onto the destination pad.
 */
export function route45(
  rawFrom: { x: number; y: number },
  rawTo: { x: number; y: number },
  diagonalFirst = false,
): Array<{ x: number; y: number }> {
  /*
   * Round BEFORE computing, not after. Rounding only the result, a horizontal
   * segment between two unrounded points came out with a thousandth of a
   * millimeter of slope: invisible on the drawing, but it is a segment at
   * 0.03 degrees and the angle check flags it as off-axis.
   */
  const from = { x: round3(rawFrom.x), y: round3(rawFrom.y) };
  const to = { x: round3(rawTo.x), y: round3(rawTo.y) };
  const dx = to.x - from.x, dy = to.y - from.y;
  const ax = Math.abs(dx), ay = Math.abs(dy);
  if (ax < 1e-6 || ay < 1e-6 || Math.abs(ax - ay) < 1e-6) {
    return [to];
  }
  const diag = Math.min(ax, ay);
  const sx = Math.sign(dx), sy = Math.sign(dy);
  const corner = diagonalFirst
    ? { x: from.x + sx * diag, y: from.y + sy * diag }
    : ax > ay
      ? { x: from.x + sx * (ax - diag), y: from.y }
      : { x: from.x, y: from.y + sy * (ay - diag) };
  return [{ x: round3(corner.x), y: round3(corner.y) }, to];
}

/** straight escape point from the pad, before being allowed to turn at 45 */
export function escapePoint(pad: RoutePad, stub = 0.4): { x: number; y: number } {
  const reach = (pad.escape.dx !== 0 ? pad.hw : pad.hh) + stub;
  return {
    x: round3(pad.x + pad.escape.dx * reach),
    y: round3(pad.y + pad.escape.dy * reach),
  };
}

/**
 * Straight escape/entry point from a CHOSEN SIDE of the pad. The house rule
 * (pin_escape) only asks that the first segment be straight on-axis —
 * horizontal or vertical within 12° — not a specific side: the front is the
 * convention, but from the flank is just as legal and often shorter.
 */
export function escapePointDir(
  pad: RoutePad,
  dir: { dx: number; dy: number },
  stub = 0.4,
): { x: number; y: number } {
  const reach = (dir.dx !== 0 ? pad.hw : pad.hh) + stub;
  return {
    x: round3(pad.x + dir.dx * reach),
    y: round3(pad.y + dir.dy * reach),
  };
}

/**
 * The side of the pad facing a point: that is where you enter most directly.
 * With ONE prohibition: never into the component body. If the dominant
 * direction points at the body (the opposite of the pad's natural escape),
 * fall back to the flank: crossing the component with copper is not an option.
 */
export function dirFromPad(
  pad: RoutePad,
  from: { x: number; y: number },
): { dx: number; dy: number } {
  const ox = from.x - pad.x;
  const oy = from.y - pad.y;
  const dominant =
    Math.abs(ox) >= Math.abs(oy)
      ? { dx: Math.sign(ox) || 1, dy: 0 }
      : { dx: 0, dy: Math.sign(oy) || 1 };
  const intoBody =
    (pad.escape.dx !== 0 || pad.escape.dy !== 0) &&
    dominant.dx === -pad.escape.dx &&
    dominant.dy === -pad.escape.dy;
  if (!intoBody) return dominant;
  // the flank is perpendicular to the body axis: always free
  return { dx: 0, dy: oy === 0 ? 1 : Math.sign(oy) };
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000;
