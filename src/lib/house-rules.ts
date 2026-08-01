/**
 * House rules applied to the final route, whichever router produced it. They
 * live in a separate module because they are pure transformations on the
 * Circuit JSON: they can be verified without running a compilation.
 */
import { DEFAULT_DESIGN_RULES } from "./design-rules";
import { escapeOffAxisDeg } from "./drc";
import {
  insidePour,
  marginInsidePour,
  netOfViaKey,
  padsOffPlane,
  planeServedPorts,
  planeServedSourcePorts,
  pourLayersByNet,
  readPours,
} from "./pours";

export interface CircuitElement {
  type: string;
  [key: string]: unknown;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * Copy of the circuit in which every trace leaves the pad STRAIGHT: where the
 * router attached a diagonal segment to the pad, a short stretch perpendicular
 * to the pad edge is inserted and only then the route resumes toward the next
 * point. House rule (Niccolo', 2026-07-26): a diagonal attached to the pad
 * reduces the useful copper of the joint and leaves acute angles for etching.
 *
 * As with thin traces, the result competes with the original instead of
 * replacing it: moving copper can bring different nets closer together, and
 * the DRC is the one that decides.
 */
export function straightenPinEscapes(circuitJson: CircuitElement[]): CircuitElement[] {
  const pads = circuitJson.filter((el) => el.type === "pcb_smtpad");
  const padAt = (x: number, y: number): CircuitElement | null =>
    pads.find((el) => {
      const px = num(el.x);
      const py = num(el.y);
      if (px === null || py === null) return false;
      const w = (num(el.width) ?? (num(el.radius) ?? 0) * 2) / 2;
      const h = (num(el.height) ?? (num(el.radius) ?? 0) * 2) / 2;
      return Math.abs(px - x) <= w + 1e-6 && Math.abs(py - y) <= h + 1e-6;
    }) ?? null;

  // same angular criterion as the check: only what is truly crooked is
  // touched, and it is brought on-axis whatever the length of the stretch
  const MAX_DEG = 12;
  const MAX_STUB = 0.3;

  return circuitJson.map((el) => {
    if (el.type !== "pcb_trace") return el;
    if (el.manual === true) return el; // hand-drawn copper is never reshaped
    const route = (el.route as Array<Record<string, unknown>> | undefined) ?? [];
    if (route.length < 2) return el;

    const next = [...route];
    let changed = false;

    // work happens on the two ends: that is where the trace touches a pad
    for (const end of ["start", "end"] as const) {
      const i = end === "start" ? 0 : next.length - 1;
      const j = end === "start" ? 1 : next.length - 2;
      const from = next[i];
      const to = next[j];
      const x = num(from.x);
      const y = num(from.y);
      const tx = num(to.x);
      const ty = num(to.y);
      if (x === null || y === null || tx === null || ty === null) continue;

      const dx = tx - x;
      const dy = ty - y;
      if (Math.hypot(dx, dy) < 1e-6) continue;
      if (escapeOffAxisDeg(dx, dy) <= MAX_DEG) continue; // already on-axis

      const pad = padAt(x, y);
      if (!pad) continue;

      // perpendicular to the edge being exited: on the long side of the pad
      const pw = num(pad.width) ?? 0;
      const ph = num(pad.height) ?? 0;
      const horizontal = pw > ph ? true : ph > pw ? false : Math.abs(dx) >= Math.abs(dy);
      // the straight stretch is at most 0.3mm and in any case less than half
      // the distance to the next point, so as not to overshoot it
      const span = Math.abs(horizontal ? dx : dy);
      const stub = Math.min(MAX_STUB, Math.max(span * 0.4, 0.05));

      const point = {
        ...from,
        x: horizontal ? x + Math.sign(dx) * stub : x,
        y: horizontal ? y : y + Math.sign(dy) * stub,
      };
      next.splice(end === "start" ? 1 : next.length - 1, 0, point);
      changed = true;
    }

    return changed ? { ...el, route: next } : el;
  });
}

/**
 * Copy of the circuit with every trace segment below the minimum width raised
 * to the factory minimum. The solver sometimes thins a stretch to pass between
 * two obstacles: the thin stretch is not manufacturable, but widening it can
 * violate a clearance. That is why the result is pitted against the original
 * instead of replacing it.
 */
export function widenThinTraces(
  circuitJson: CircuitElement[],
  minTraceWidthMm: number = DEFAULT_DESIGN_RULES.minTraceWidthMm,
): CircuitElement[] {
  const min = minTraceWidthMm;
  return circuitJson.map((el) => {
    if (el.type !== "pcb_trace") return el;
    if (el.manual === true) return el; // hand-drawn copper is never reshaped
    const route = el.route as Array<Record<string, unknown>> | undefined;
    if (!route?.some((p) => typeof p.width === "number" && p.width < min)) return el;
    return {
      ...el,
      route: route.map((p) =>
        typeof p.width === "number" && p.width < min ? { ...p, width: min } : p,
      ),
    };
  });
}



/**
 * Copy of the circuit in which every trace segment is horizontal, vertical or
 * at 45 degrees. A crooked segment is split in two — first the on-axis
 * stretch, then the 45-degree one — keeping the two ends IDENTICAL, so without
 * touching the connections: only the path in between changes.
 *
 * House rule (Niccolo', 2026-07-26): intermediate angles are ugly and that is
 * not how a board is drawn.
 */
export function snapTo45(circuitJson: CircuitElement[]): CircuitElement[] {
  const TOL_DEG = 3;
  const isAllowed = (dx: number, dy: number): boolean => {
    if (Math.hypot(dx, dy) < 0.02) return true;
    const deg = (Math.atan2(Math.abs(dy), Math.abs(dx)) * 180) / Math.PI;
    return Math.min(deg, Math.abs(deg - 45), 90 - deg) <= TOL_DEG;
  };

  return circuitJson.map((el) => {
    if (el.type !== "pcb_trace") return el;
    if (el.manual === true) return el; // hand-drawn copper is never reshaped
    const route = (el.route as Array<Record<string, unknown>> | undefined) ?? [];
    if (route.length < 2) return el;

    const out: Array<Record<string, unknown>> = [route[0]];
    let changed = false;
    for (let i = 1; i < route.length; i++) {
      const a = out[out.length - 1];
      const b = route[i];
      const ax = num(a.x);
      const ay = num(a.y);
      const bx = num(b.x);
      const by = num(b.y);
      if (ax === null || ay === null || bx === null || by === null) {
        out.push(b);
        continue;
      }
      const dx = bx - ax;
      const dy = by - ay;
      if (isAllowed(dx, dy)) {
        out.push(b);
        continue;
      }
      // the on-axis stretch covers the difference between the two sides, then
      // it descends at 45 degrees to the arrival point
      const gap = Math.abs(Math.abs(dx) - Math.abs(dy));
      const bend =
        Math.abs(dx) > Math.abs(dy)
          ? { ...b, x: ax + Math.sign(dx) * gap, y: ay }
          : { ...b, x: ax, y: ay + Math.sign(dy) * gap };
      out.push(bend, b);
      changed = true;
    }
    return changed ? { ...el, route: out } : el;
  });
}

/**
 * Copy of the circuit in which no via sits on top of the copper of another
 * net, neither on a pad nor on a passing trace.
 *
 * It is the violation that does not close on its own. The router plans vias
 * where it needs to switch layers, and the most convenient spot is often flush
 * with the pad it has to reach: 0.109mm instead of 0.127 and the board cannot
 * be manufactured. The zone loop does not solve it because redoing the zone
 * brings back the same geometry — the router is deterministic, and from that
 * dead end the via always comes out at the same spot.
 *
 * Here the route is not renegotiated: only the VIA is moved, by a few
 * hundredths, along the grid, into the first free spot that does not quarrel
 * with anyone. The trace follows it, because the via point in the route is the
 * same object: the two segments that reach it bend by that little bit and the
 * ends stay where they are. If no offset frees the via, it is left where it is
 * and the DRC keeps reporting it: a problem that cannot be solved is declared,
 * not hidden.
 *
 * NET MEMBERSHIP is derived from the declared connections, not from the pad.
 * Previously `subcircuit_connectivity_map_key` was read directly from the
 * `pcb_port`, where that field NEVER EXISTS (measured on BAT: 0 ports out of
 * 202): the fallback was `source_port_id`, which is unique per pin, so every
 * pad ended up on a different net from everyone else, including the pad the
 * via was supposed to connect. With that comparison no offset could ever come
 * out clean and the function moved nothing: it was a switched-off fixer that
 * looked switched on. The right map is port -> source_trace -> connectivity
 * key, the same one the DRC uses.
 */
export function nudgeCrowdedVias(
  circuitJson: CircuitElement[],
  clearanceMm: number = DEFAULT_DESIGN_RULES.minClearanceMm,
): CircuitElement[] {
  const vias = circuitJson.filter((el) => el.type === "pcb_via");
  if (vias.length === 0) return circuitJson;

  interface Box {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    group: string;
  }
  /** trace segment of another net: it is as much an obstacle as a pad */
  interface Wire {
    ax: number;
    ay: number;
    bx: number;
    by: number;
    halfW: number;
    group: string;
  }

  // --- port -> net, through the declared connections (as the DRC does)
  const groupOfSourcePort = new Map<string, string>();
  for (const el of circuitJson) {
    if (el.type !== "source_trace") continue;
    const key = String(el.subcircuit_connectivity_map_key ?? el.source_trace_id ?? "");
    for (const pid of (el.connected_source_port_ids as string[] | undefined) ?? []) {
      groupOfSourcePort.set(pid, key);
    }
  }
  const groupOfPort = new Map<string, string>();
  for (const el of circuitJson) {
    if (el.type !== "pcb_port") continue;
    const sp = String(el.source_port_id ?? "");
    const g =
      String(el.subcircuit_connectivity_map_key ?? "") || groupOfSourcePort.get(sp) || "";
    groupOfPort.set(String(el.pcb_port_id ?? ""), g);
  }

  const padBoxes: Box[] = [];
  for (const el of circuitJson) {
    if (el.type !== "pcb_smtpad" && el.type !== "pcb_plated_hole") continue;
    const x = num(el.x);
    const y = num(el.y);
    if (x === null || y === null) continue;
    const radius = num(el.radius);
    const w =
      num(el.width) ?? num(el.outer_width) ?? num(el.outer_diameter) ?? (radius ?? 0) * 2;
    const h =
      num(el.height) ?? num(el.outer_height) ?? num(el.outer_diameter) ?? (radius ?? 0) * 2;
    if (w <= 0 || h <= 0) continue;
    padBoxes.push({
      minX: x - w / 2,
      maxX: x + w / 2,
      minY: y - h / 2,
      maxY: y + h / 2,
      group: groupOfPort.get(String(el.pcb_port_id ?? "")) ?? "",
    });
  }

  /*
   * Traces of the OTHER nets: a via that moves can end up under passing
   * copper, and that is the larger half of the reports (measured on BAT: 66
   * out of 130 are trace-over-via). The segments of the via's own net are not
   * in the list because they move with it.
   */
  const groupOfTrace = new Map<string, string>();
  for (const el of circuitJson) {
    if (el.type !== "source_trace") continue;
    groupOfTrace.set(
      String(el.source_trace_id ?? ""),
      String(el.subcircuit_connectivity_map_key ?? el.source_trace_id ?? ""),
    );
  }
  const wires: Wire[] = [];
  for (const el of circuitJson) {
    if (el.type !== "pcb_trace") continue;
    const group = groupOfTrace.get(String(el.source_trace_id ?? "")) ?? "";
    if (!group) continue;
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
      wires.push({
        ax,
        ay,
        bx,
        by,
        halfW: (num(b.width) ?? num(a.width) ?? DEFAULT_DESIGN_RULES.minTraceWidthMm) / 2,
        group,
      });
    }
  }

  /*
   * THE TWO STRETCHES REACHING THE VIA. Moving the via does not move just the
   * via: the copper entering it and the one leaving it bend to follow it, and
   * they end up where they were not before. Measured: without this check the
   * move closed the via-against-pad violations and opened just as many
   * trace-against-trace ones (on BAT: 33 -> 61). A fixer that moves the
   * problem instead of solving it is not a fixer, so here we also look at
   * where the dragged copper ends up.
   */
  interface Stub {
    x: number;
    y: number;
    halfW: number;
  }
  const stubsOfVia = new Map<string, Stub[]>();
  const viaKey = (x: number, y: number) => `${x.toFixed(3)},${y.toFixed(3)}`;
  for (const el of circuitJson) {
    if (el.type !== "pcb_trace") continue;
    const route = (el.route as Array<Record<string, unknown>> | undefined) ?? [];
    for (let i = 0; i < route.length; i++) {
      if (route[i].route_type !== "via") continue;
      const vx = num(route[i].x);
      const vy = num(route[i].y);
      if (vx === null || vy === null) continue;
      const key = viaKey(vx, vy);
      const list = stubsOfVia.get(key) ?? [];
      for (const n of [route[i - 1], route[i + 1]]) {
        const nx = n ? num(n.x) : null;
        const ny = n ? num(n.y) : null;
        if (nx === null || ny === null) continue;
        list.push({
          x: nx,
          y: ny,
          halfW: (num(n?.width) ?? DEFAULT_DESIGN_RULES.minTraceWidthMm) / 2,
        });
      }
      stubsOfVia.set(key, list);
    }
  }

  const viaGroup = (via: CircuitElement): string =>
    String(via.subcircuit_connectivity_map_key ?? "");

  /** distance between the via circle and the pad rectangle */
  const gapTo = (box: Box, x: number, y: number, r: number): number => {
    const dx = Math.max(box.minX - x, 0, x - box.maxX);
    const dy = Math.max(box.minY - y, 0, y - box.maxY);
    return Math.hypot(dx, dy) - r;
  };
  /** distance between the via circle and the trace copper */
  const gapToWire = (w: Wire, x: number, y: number, r: number): number =>
    pointSegDistance(x, y, w.ax, w.ay, w.bx, w.by) - w.halfW - r;
  /** distance between the via->neighbor stretch and the rectangle of a pad */
  const stubGapToBox = (s: Stub, x: number, y: number, box: Box): number =>
    segToBoxDistance(x, y, s.x, s.y, box) - s.halfW;
  /** distance between the via->neighbor stretch and the copper of another trace */
  const stubGapToWire = (s: Stub, x: number, y: number, w: Wire): number =>
    segSegDistance(x, y, s.x, s.y, w.ax, w.ay, w.bx, w.by) - s.halfW - w.halfW;

  const GRID = 0.05;
  const offsets: Array<{ dx: number; dy: number }> = [];
  for (let ring = 1; ring <= 12; ring++) {
    const d = ring * GRID;
    // axis-aligned offsets first, then diagonals: moving a via along the axis
    // of the trace that serves it is what deforms the route the least
    offsets.push({ dx: d, dy: 0 }, { dx: -d, dy: 0 }, { dx: 0, dy: d }, { dx: 0, dy: -d });
    offsets.push({ dx: d, dy: d }, { dx: d, dy: -d }, { dx: -d, dy: d }, { dx: -d, dy: -d });
  }

  const moved = new Map<string, { from: { x: number; y: number }; to: { x: number; y: number } }>();
  for (const via of vias) {
    const x = num(via.x);
    const y = num(via.y);
    const outer = num(via.outer_diameter) ?? num(via.hole_diameter);
    if (x === null || y === null || outer === null) continue;
    const r = outer / 2;
    const group = viaGroup(via);
    if (!group) continue; // via without a known net: moving it would be blind

    // the via crosses all layers, so it also quarrels with the SMT pads on the
    // opposite side: the layer filter does not apply here
    const foes = padBoxes.filter((b) => b.group !== group);
    const foeWires = wires.filter((w) => w.group !== group);
    const dirty =
      foes.some((b) => gapTo(b, x, y, r) < clearanceMm - 1e-9) ||
      foeWires.some((w) => gapToWire(w, x, y, r) < clearanceMm - 1e-9);
    if (!dirty) continue;

    // the neighbors not to worsen: only those within reach of a half-millimeter
    // move, the others cannot be reached anyway
    const nearby = foes.filter((b) => gapTo(b, x, y, r) < clearanceMm + 1.5);
    const nearbyWires = foeWires.filter((w) => gapToWire(w, x, y, r) < clearanceMm + 1.5);
    const stubs = stubsOfVia.get(viaKey(x, y)) ?? [];
    /*
     * The dragged copper is judged on a wider radius: a 3mm-long stretch
     * rotating by half a millimeter sweeps an area that the neighbors "within
     * 1.5mm of the via" do not describe.
     */
    const reach = Math.max(...stubs.map((s) => Math.hypot(s.x - x, s.y - y)), 0) + 1.5;
    const stubFoes = foes.filter((b) => gapTo(b, x, y, r) < reach);
    const stubFoeWires = foeWires.filter((w) => gapToWire(w, x, y, r) < reach);
    /** the copper dragged by the move must not quarrel with anyone */
    const stubsClean = (nx: number, ny: number): boolean =>
      stubs.every(
        (s) =>
          stubFoes.every((b) => stubGapToBox(s, nx, ny, b) >= clearanceMm - 1e-9) &&
          stubFoeWires.every((w) => stubGapToWire(s, nx, ny, w) >= clearanceMm - 1e-9),
      );
    /*
     * If the stretches were ALREADY out of spec where they were, demanding that
     * the move fix them means never moving the via and leaving standing even
     * the violation that was known to be closable. In that case it is enough
     * that they do not get worse.
     */
    const stubsWereClean = stubsClean(x, y);
    for (const off of offsets) {
      const nx = Math.round((x + off.dx) / GRID) * GRID;
      const ny = Math.round((y + off.dy) / GRID) * GRID;
      const clean =
        nearby.every((b) => gapTo(b, nx, ny, r) >= clearanceMm - 1e-9) &&
        nearbyWires.every((w) => gapToWire(w, nx, ny, r) >= clearanceMm - 1e-9) &&
        (!stubsWereClean || stubsClean(nx, ny));
      if (!clean) continue;
      moved.set(String(via.pcb_via_id ?? ""), { from: { x, y }, to: { x: nx, y: ny } });
      break;
    }
  }
  if (moved.size === 0) return circuitJson;

  const movedPoints = [...moved.values()];
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

  return circuitJson.map((el) => {
    if (el.type === "pcb_via") {
      const m = moved.get(String(el.pcb_via_id ?? ""));
      return m ? { ...el, x: m.to.x, y: m.to.y } : el;
    }
    if (el.type !== "pcb_trace") return el;
    if (el.manual === true) return el; // hand-drawn copper is never reshaped
    const route = el.route as Array<Record<string, unknown>> | undefined;
    if (!route) return el;
    let touched = false;
    const next = route.map((p) => {
      const px = num(p.x);
      const py = num(p.y);
      if (px === null || py === null) return p;
      // the route's layer-change point is the same via: it moves with it,
      // otherwise the trace would stay attached to the old point and the
      // connection would break
      const m = movedPoints.find((v) => near(v.from.x, px) && near(v.from.y, py));
      if (!m || p.route_type !== "via") return p;
      touched = true;
      return { ...p, x: m.to.x, y: m.to.y };
    });
    return touched ? { ...el, route: next } : el;
  });
}

/** distance between two segments, 0 if they intersect */
function segSegDistance(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): number {
  const side = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) =>
    (qx - px) * (ry - py) - (qy - py) * (rx - px);
  const d1 = side(ax, ay, bx, by, cx, cy);
  const d2 = side(ax, ay, bx, by, dx, dy);
  const d3 = side(cx, cy, dx, dy, ax, ay);
  const d4 = side(cx, cy, dx, dy, bx, by);
  if (
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  ) {
    return 0;
  }
  return Math.min(
    pointSegDistance(ax, ay, cx, cy, dx, dy),
    pointSegDistance(bx, by, cx, cy, dx, dy),
    pointSegDistance(cx, cy, ax, ay, bx, by),
    pointSegDistance(dx, dy, ax, ay, bx, by),
  );
}

/** distance between a segment and a rectangle, 0 if it touches or enters it */
function segToBoxDistance(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  box: { minX: number; maxX: number; minY: number; maxY: number },
): number {
  const inside = (x: number, y: number) =>
    x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY;
  if (inside(ax, ay) || inside(bx, by)) return 0;
  const corners: Array<[number, number]> = [
    [box.minX, box.minY],
    [box.maxX, box.minY],
    [box.maxX, box.maxY],
    [box.minX, box.maxY],
  ];
  let best = Infinity;
  for (let i = 0; i < 4; i++) {
    const [x1, y1] = corners[i];
    const [x2, y2] = corners[(i + 1) % 4];
    const d = segSegDistance(ax, ay, bx, by, x1, y1, x2, y2);
    if (d === 0) return 0;
    best = Math.min(best, d);
  }
  return best;
}

/** distance between a point and a segment (0 if the point lies on it) */
function pointSegDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Ground drops onto the PLANE, it does not cross the board with traces.
 *
 * A four-layer board has an entire plane dedicated to ground: the right way to
 * connect to it is not a trace across the board, it is the plane. Instead the
 * autorouter treats ground like any other net and routes it on the surface — on
 * bat-bs 29 traces and 158 millimetres of copper, 21% of the total, to connect
 * points that had the plane right underneath. That copper occupies the corridors
 * the signals need, and a current return that takes the long way around instead
 * of dropping straight down is an antenna. On a board with microphones and a
 * crystal that is not a cosmetic detail.
 *
 * WHEN A VIA IS NEEDED, though, is a different question, and the first version
 * got it wrong: it put one next to every pad of the net. But if the plane is
 * poured on the pad's OWN face — and on this board ground is poured on top,
 * inner1 and bottom — the pad is already immersed in that copper: it is
 * connected, full stop. Measured on bat-bs-blocchi: 43 of the 51 pads of a
 * poured net were sitting inside the plane of their own face, and each one had
 * been given a via plus a stub trace that connected copper to itself. Fifty-one
 * useless holes in the board, each one a hole the drill has to make, each one an
 * island the pour has to open around itself.
 *
 * So, three cases and three answers:
 * - pad inside the plane of its own face: nothing, it is already connected;
 * - pad on a face WITHOUT the plane of its net: one via just outside the pad,
 *   going down to the face that has it;
 * - planes of the same net on more than one face: STITCHING vias, on a coarse
 *   grid, which is a different job — they do not connect a pad, they tie the
 *   planes to each other so the return current can change layer wherever it
 *   needs to, instead of going looking for the nearest signal via.
 */
export function stitchToPlanes(
  circuitJson: CircuitElement[],
  rules = DEFAULT_DESIGN_RULES,
  /**
   * Spacing of the stitching vias, in mm. 8 is a reasonable default for a board
   * of this size: enough to give the return current a way down every few
   * millimetres, few enough not to turn the plane into a colander. Zero turns
   * the stitching off.
   */
  stitchPitchMm = 8,
): CircuitElement[] {
  const pours = readPours(circuitJson);
  if (pours.length === 0) return circuitJson;
  const layersOfNet = pourLayersByNet(pours);
  // the face where each net's plane is, to send the pad's via down to it
  const planeNets = new Map<string, string>();
  for (const [net, layers] of layersOfNet) {
    planeNets.set(net, [...layers].find((l) => l !== "top" && l !== "bottom") ?? [...layers][0]);
  }

  /*
   * pad -> net, PROPAGATED through the ports (pours.ts).
   *
   * Reading only the net named on the trace found 13 ground ports out of 53:
   * the autorouter's spanning tree names only the ports it joins, so most of
   * the ground pads were invisible here — no via where it was needed, and the
   * wires stayed. Propagating port to port turns the tree back into "these
   * fifty-three pads are all ground".
   */
  const netOfPcbPort = planeServedPorts(circuitJson, pours);
  const groupOfPcbPort = new Map<string, string>();
  for (const el of circuitJson) {
    if (el.type !== "pcb_port" || !el.pcb_port_id) continue;
    groupOfPcbPort.set(
      String(el.pcb_port_id),
      String(el.subcircuit_connectivity_map_key ?? el.source_port_id ?? ""),
    );
  }
  if (netOfPcbPort.size === 0) return circuitJson;

  const centerOfComponent = new Map<string, { x: number; y: number }>();
  for (const el of circuitJson) {
    if (el.type !== "pcb_component" || !el.pcb_component_id) continue;
    const c = (el.center as { x?: unknown; y?: unknown } | undefined) ?? {};
    const x = num(c.x);
    const y = num(c.y);
    if (x !== null && y !== null) centerOfComponent.set(String(el.pcb_component_id), { x, y });
  }

  /*
   * Start from scratch: the plane vias placed by a previous pass are thrown
   * away before redoing them. That is what makes this rule REPEATABLE — and it
   * must be, because it is enough to hand-move a component or a trace for the
   * previous vias to end up in the wrong spot. Without this cleanup every
   * recompute would add a layer of vias on top of the old one instead of
   * replacing it.
   */
  const isPlaneStitch = (el: CircuitElement): boolean =>
    String(el.pcb_via_id ?? "").startsWith("pcb_via_plane_") ||
    String(el.pcb_trace_id ?? "").startsWith("pcb_trace_plane_");
  const base = circuitJson.filter((el) => !isPlaneStitch(el));

  const existingVias = base.filter((el) => el.type === "pcb_via");
  const netDiChiave = netOfViaKey(base, pours);
  const added: CircuitElement[] = [];
  let n = 0;

  for (const el of base) {
    if (el.type !== "pcb_smtpad") continue;
    const net = netOfPcbPort.get(String(el.pcb_port_id ?? ""));
    if (!net) continue;
    const x = num(el.x) ?? centroDiPoligono(el)?.x ?? null;
    const y = num(el.y) ?? centroDiPoligono(el)?.y ?? null;
    if (x === null || y === null) continue;

    /*
     * Already immersed in the plane of its own face: connected, nothing to do.
     * This is the case that used to produce a via connecting copper to itself.
     */
    const suaFaccia = String(el.layer ?? "top");
    const sotto = pours.filter((p) => p.net === net && p.layer === suaFaccia);
    if (sotto.some((p) => insidePour(x, y, p))) continue;
    const radius = num(el.radius);
    const w = num(el.width) ?? (radius ?? 0) * 2;
    const h = num(el.height) ?? (radius ?? 0) * 2;

    /*
     * A via of THIS net already right next to it: the pad is fine as it is.
     * "Of this net" is the part that was missing: counting any via at all, a
     * signal via passing a millimetre away was enough to skip the tie, and the
     * pad stayed connected to nothing. Four pads on bat-bs-blocchi.
     */
    const mioGruppo = groupOfPcbPort.get(String(el.pcb_port_id ?? "")) ?? "";
    const near = existingVias.some((v) => {
      const vx = num(v.x);
      const vy = num(v.y);
      if (vx === null || vy === null) return false;
      if (Math.hypot(vx - x, vy - y) >= 1.2) return false;
      const chiave = String(v.subcircuit_connectivity_map_key ?? "");
      return netDiChiave.get(chiave) === net || chiave === mioGruppo;
    });
    if (near) continue;

    /*
     * The via leaves the pad STRAIGHT, toward the outside of the component: it is
     * the same direction in which the placement reserved the space. But the
     * reserved spot can be taken — by a neighbour's pad, by a via the router
     * left there — and putting the via down anyway means a clearance violation.
     * So the four straight directions are tried, starting with the outward one,
     * and the first free one wins. If none is free the first is used anyway and
     * the DRC says so: better a via that is reported than a pad connected to
     * nothing.
     */
    const center = centerOfComponent.get(String(el.pcb_component_id ?? "")) ?? { x, y };
    const dx = x - center.x;
    const dy = y - center.y;
    const clearance = rules.targetClearanceMm ?? rules.minClearanceMm;
    const step = rules.minViaDiameterMm / 2 + clearance;
    const raggioVia = rules.minViaDiameterMm / 2;
    /*
     * The four straight directions, each tried at three distances. Going
     * further out keeps the escape STRAIGHT — the house rule — while a
     * diagonal shortcut would break it. Without the escalation, on a crowded
     * board all four spots at the first distance were taken and the via ended
     * up on top of a neighbour's pad, 0,05 mm of overlap.
     */
    const versi: Array<{ ux: number; uy: number }> =
      Math.abs(dx) >= Math.abs(dy)
        ? [
            { ux: Math.sign(dx || 1), uy: 0 },
            { ux: -Math.sign(dx || 1), uy: 0 },
            { ux: 0, uy: 1 },
            { ux: 0, uy: -1 },
          ]
        : [
            { ux: 0, uy: Math.sign(dy || 1) },
            { ux: 0, uy: -Math.sign(dy || 1) },
            { ux: 1, uy: 0 },
            { ux: -1, uy: 0 },
          ];
    const fuoriAsse: Array<{ x: number; y: number }> = [];
    for (const extra of [0, step, step * 2.4]) {
      for (const v of versi) {
        fuoriAsse.push({
          x: x + v.ux * (w / 2 + step + extra),
          y: y + v.uy * (h / 2 + step + extra),
        });
      }
    }
    /** how much room there is around a point: negative means overlap */
    const ariaAttorno = (px: number, py: number): number => {
      let peggio = Infinity;
      for (const other of [...base, ...added]) {
        if (other === el) continue;
        if (other.type === "pcb_smtpad") {
          const oc = centroDiPoligono(other);
          const ox = num(other.x) ?? oc?.x ?? null;
          const oy = num(other.y) ?? oc?.y ?? null;
          if (ox === null || oy === null) continue;
          const sp = ingombroDiPoligono(other);
          // a ROUND pad declares neither width nor height, it declares a radius:
          // forgetting it made a 1,6mm test point invisible, and a tie via ended
          // up 0,05mm inside it while the rule believed it had a millimetre
          const diametro = (num(other.radius) ?? 0) * 2;
          const ow = num(other.width) ?? sp?.w ?? diametro;
          const oh = num(other.height) ?? sp?.h ?? diametro;
          const gx = Math.max(Math.abs(px - ox) - ow / 2, 0);
          const gy = Math.max(Math.abs(py - oy) - oh / 2, 0);
          peggio = Math.min(peggio, Math.hypot(gx, gy) - raggioVia);
        } else if (
          other.type === "pcb_via" ||
          other.type === "pcb_plated_hole" ||
          other.type === "pcb_hole"
        ) {
          const ox = num(other.x);
          const oy = num(other.y);
          const d = num(other.outer_diameter) ?? num(other.outer_width) ?? rules.minViaDiameterMm;
          if (ox === null || oy === null) continue;
          peggio = Math.min(peggio, Math.hypot(ox - px, oy - py) - d / 2 - raggioVia);
        }
      }
      return peggio;
    };
    /*
     * The first spot with room to spare; if none has it — it happens where the
     * board is dense — the LEAST BAD one, not the first. It used to take the
     * first anyway and one via ended up 0,05 mm inside a neighbour's pad. Now
     * the worst case is the largest gap available, and the DRC reports it if it
     * is still not enough: a defect that is measured is a defect you can fix.
     */
    let posto = fuoriAsse[0];
    let ariaMigliore = -Infinity;
    for (const p of fuoriAsse) {
      const aria = ariaAttorno(p.x, p.y);
      if (aria >= clearance) {
        posto = p;
        ariaMigliore = aria;
        break;
      }
      if (aria > ariaMigliore) {
        ariaMigliore = aria;
        posto = p;
      }
    }
    /*
     * No room anywhere: no via. Forcing it in would mean copper 0,05 mm inside a
     * neighbour's pad — a defect we would be creating ourselves. The pad keeps
     * its wire (the removal below spares it) and the check says it: this pad has
     * no room for its via. Which is a placement problem, and that is where it
     * gets solved.
     */
    if (ariaMigliore < clearance) continue;
    const vx = posto.x;
    const vy = posto.y;

    const id = `pcb_via_plane_pad_${n++}`;
    added.push({
      type: "pcb_via",
      pcb_via_id: id,
      x: Math.round(vx * 1000) / 1000,
      y: Math.round(vy * 1000) / 1000,
      outer_diameter: rules.minViaDiameterMm,
      hole_diameter: rules.minViaHoleMm,
      layers: [String(el.layer ?? "top"), planeNets.get(net) ?? "inner1"],
      subcircuit_connectivity_map_key: groupOfPcbPort.get(String(el.pcb_port_id ?? "")) ?? "",
    } as CircuitElement);
    added.push({
      type: "pcb_trace",
      pcb_trace_id: `pcb_trace_plane_${n}`,
      route: [
        { route_type: "wire", x, y, width: rules.targetTraceWidthMm, layer: String(el.layer ?? "top") },
        {
          route_type: "wire",
          x: Math.round(vx * 1000) / 1000,
          y: Math.round(vy * 1000) / 1000,
          width: rules.targetTraceWidthMm,
          layer: String(el.layer ?? "top"),
        },
      ],
      subcircuit_connectivity_map_key: groupOfPcbPort.get(String(el.pcb_port_id ?? "")) ?? "",
    } as CircuitElement);
  }

  /*
   * STITCHING: vias that tie the planes of the same net to one another.
   *
   * They are not connected to any pad: they exist so that the return current
   * can change layer where it is flowing, instead of travelling along the plane
   * looking for the nearest signal via. Placed on a regular grid, only where
   * the point falls inside every plane involved with room to spare, and away
   * from other copper.
   */
  if (stitchPitchMm > 0) {
    const clearance = rules.targetClearanceMm ?? rules.minClearanceMm;
    const raggio = rules.minViaDiameterMm / 2;
    /** everything already occupying copper: pads, holes, vias (ours included) */
    const occupato: Array<{ x: number; y: number; r: number }> = [];
    for (const el of [...base, ...added]) {
      if (el.type === "pcb_smtpad" || el.type === "pcb_solder_paste") {
        const c = centroDiPoligono(el);
        const px = num(el.x) ?? c?.x ?? null;
        const py = num(el.y) ?? c?.y ?? null;
        /*
         * A polygon pad declares neither width nor height: its shape IS the list
         * of vertices. Reading only width/height turned the four ground pads of
         * a MEMS microphone into points with zero radius, and a stitching via
         * landed on top of one of them.
         */
        const spread = ingombroDiPoligono(el);
        const w = num(el.width) ?? spread?.w ?? (num(el.radius) ?? 0) * 2;
        const h = num(el.height) ?? spread?.h ?? (num(el.radius) ?? 0) * 2;
        if (px !== null && py !== null) occupato.push({ x: px, y: py, r: Math.hypot(w, h) / 2 });
      } else if (el.type === "pcb_via" || el.type === "pcb_plated_hole" || el.type === "pcb_hole") {
        const px = num(el.x);
        const py = num(el.y);
        const d = num(el.outer_diameter) ?? num(el.outer_width) ?? rules.minViaDiameterMm;
        if (px !== null && py !== null) occupato.push({ x: px, y: py, r: d / 2 });
      }
    }
    /*
     * The traces too: a stitching via dropped onto someone else's copper is a
     * clearance violation, and the pour would have to open an island around it
     * right where the signal passes. Only the traces of OTHER nets matter —
     * landing on the copper of one's own net is exactly the point.
     */
    const segmenti: Array<{ ax: number; ay: number; bx: number; by: number; w: number; net: string }> = [];
    for (const el of [...base, ...added]) {
      if (el.type !== "pcb_trace") continue;
      const net = String(el.subcircuit_connectivity_map_key ?? "");
      const route = (el.route as Array<Record<string, unknown>> | undefined) ?? [];
      for (let i = 1; i < route.length; i++) {
        const ax = num(route[i - 1].x);
        const ay = num(route[i - 1].y);
        const bx = num(route[i].x);
        const by = num(route[i].y);
        if (ax === null || ay === null || bx === null || by === null) continue;
        segmenti.push({ ax, ay, bx, by, w: num(route[i].width) ?? rules.minTraceWidthMm, net });
      }
    }
    const libero = (x: number, y: number, netProprio: string) =>
      !occupato.some((o) => Math.hypot(o.x - x, o.y - y) < o.r + raggio + clearance) &&
      !segmenti.some(
        (t) =>
          t.net !== netProprio &&
          pointSegDistance(x, y, t.ax, t.ay, t.bx, t.by) < t.w / 2 + raggio + clearance,
      );

    for (const [net, layers] of layersOfNet) {
      if (layers.size < 2) continue;
      const facce = [...layers];
      const piani = pours.filter((p) => p.net === net);
      const minX = Math.min(...piani.map((p) => p.minX));
      const maxX = Math.max(...piani.map((p) => p.maxX));
      const minY = Math.min(...piani.map((p) => p.minY));
      const maxY = Math.max(...piani.map((p) => p.maxY));
      const gruppo = piani[0]?.net ?? "";
      let messe = 0;
      for (let gx = minX + stitchPitchMm / 2; gx <= maxX; gx += stitchPitchMm) {
        for (let gy = minY + stitchPitchMm / 2; gy <= maxY; gy += stitchPitchMm) {
          const x = Math.round(gx * 1000) / 1000;
          const y = Math.round(gy * 1000) / 1000;
          // inside EVERY plane of the net, with the via's own room to spare
          const dentroTutti = facce.every((f) =>
            piani
              .filter((p) => p.layer === f)
              .some((p) => marginInsidePour(x, y, p) >= raggio + clearance),
          );
          if (!dentroTutti || !libero(x, y, `net:${gruppo}`)) continue;
          occupato.push({ x, y, r: raggio });
          added.push({
            type: "pcb_via",
            pcb_via_id: `pcb_via_plane_stitch_${net}_${messe++}`,
            x,
            y,
            outer_diameter: rules.minViaDiameterMm,
            hole_diameter: rules.minViaHoleMm,
            layers: facce,
            subcircuit_connectivity_map_key: `net:${gruppo}`,
          } as CircuitElement);
        }
      }
    }
  }

  /*
   * And now the wires go: the copper of a poured net, after the plane, is
   * copper in the middle of copper.
   *
   * This is the step that was missing — not because nobody had thought of it,
   * but because it looked for the traces in the wrong place: by the net named on
   * the trace, and the autorouter's ground traces (source_net_0_mst0, mst1...)
   * name only the ports they join. So it found nothing to remove and the ground
   * stayed drawn with wires. Now the ports are followed, which is where the net
   * really is.
   *
   * With one guarantee before removing anything: every pad of that net must be
   * connected to the plane, immersed or with its via — the vias were just added
   * above. If even one is not, the traces of that net stay, because a tidy board
   * that does not work is worse than an ugly one that does.
   */
  const conVia = [...base, ...added];
  /*
   * The guard works pad by pad, not net by net: a single pad with no room for
   * its via used to save the wires of the WHOLE net, and ground went back to
   * being drawn with wires because of one crowded corner.
   */
  const scoperti = padsOffPlane(conVia, pours);
  const sourceDiPcbPort = new Map<string, string>();
  for (const el of conVia) {
    if (el.type !== "pcb_port" || !el.pcb_port_id) continue;
    sourceDiPcbPort.set(String(el.pcb_port_id), String(el.source_port_id ?? ""));
  }
  const porteScoperte = new Set(
    scoperti.map((p) => sourceDiPcbPort.get(p.port) ?? "").filter(Boolean),
  );
  // the traces speak in SOURCE ports, not in pcb ports: this is the map they need
  const servite = planeServedSourcePorts(conVia, pours);
  const daButtare = new Set<string>();
  for (const el of conVia) {
    if (el.type !== "source_trace") continue;
    const porte = ((el.connected_source_port_ids as unknown[] | undefined) ?? []).map(String);
    if (porte.length === 0) continue;
    // every end must be on the plane, and none of them adrift
    if (!porte.every((p) => servite.has(p))) continue;
    if (porte.some((p) => porteScoperte.has(p))) continue;
    daButtare.add(String(el.source_trace_id ?? ""));
  }
  const senzaFili = conVia.filter(
    (el) =>
      el.type !== "pcb_trace" ||
      el.manual === true ||
      String(el.pcb_trace_id ?? "").startsWith("pcb_trace_plane_") ||
      !daButtare.has(String(el.source_trace_id ?? "")),
  );

  return senzaFili;
}

/** width and height of a polygon pad, from the spread of its vertices */
function ingombroDiPoligono(el: CircuitElement): { w: number; h: number } | null {
  const pts = el.points as Array<{ x?: unknown; y?: unknown }> | undefined;
  if (!Array.isArray(pts) || pts.length === 0) return null;
  const xs: number[] = [];
  const ys: number[] = [];
  for (const p of pts) {
    const x = num(p.x);
    const y = num(p.y);
    if (x !== null && y !== null) {
      xs.push(x);
      ys.push(y);
    }
  }
  if (xs.length === 0) return null;
  return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

/** centre of a polygon pad, which has no x/y of its own: only vertices */
function centroDiPoligono(el: CircuitElement): { x: number; y: number } | null {
  const pts = el.points as Array<{ x?: unknown; y?: unknown }> | undefined;
  if (!Array.isArray(pts) || pts.length === 0) return null;
  const xs: number[] = [];
  const ys: number[] = [];
  for (const p of pts) {
    const x = num(p.x);
    const y = num(p.y);
    if (x !== null && y !== null) {
      xs.push(x);
      ys.push(y);
    }
  }
  if (xs.length === 0) return null;
  return {
    x: (Math.min(...xs) + Math.max(...xs)) / 2,
    y: (Math.min(...ys) + Math.max(...ys)) / 2,
  };
}
