import {
  DEFAULT_DESIGN_RULES,
  distanzaMinimaFra,
  type DesignRules,
  type TipoRame,
} from "./design-rules";
import { netOfViaKey, padsOffPlane, pourLayersByNet, readPours, tutteLeVia } from "./pours";

export interface DrcViolation {
  rule: string;
  message: string;
  /**
   * Where the problem is on the board (mm, board center = 0,0). Without this
   * a violation says WHAT is wrong but not WHERE: on aggregated ones the
   * points of all occurrences are kept.
   */
  points?: Array<{ x: number; y: number }>;
}

interface El {
  type: string;
  [key: string]: unknown;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * The center of a pad that does not declare one.
 *
 * Some footprints describe pads as POLYGONS — a list of vertices — and those
 * carry neither x nor y. Everything that reads coordinates skips them: the
 * clearance check, the placement, the autorouter. They are pads you can see
 * on the drawing but that do not exist for the tools, and that is how the
 * four ground pads of a microphone used to disappear without anyone saying
 * so. The center is derived from the vertices: it is an honest
 * approximation, and worth far more than a hole in the data.
 */
function centroDaVertici(el: { points?: unknown }): { x: number; y: number } | null {
  const punti = el.points as Array<{ x?: unknown; y?: unknown }> | undefined;
  if (!Array.isArray(punti) || punti.length === 0) return null;
  const xs = punti.map((p) => (typeof p.x === "number" ? p.x : NaN)).filter(Number.isFinite);
  const ys = punti.map((p) => (typeof p.y === "number" ? p.y : NaN)).filter(Number.isFinite);
  if (xs.length === 0 || ys.length === 0) return null;
  return {
    x: (Math.min(...xs) + Math.max(...xs)) / 2,
    y: (Math.min(...ys) + Math.max(...ys)) / 2,
  };
}

interface Box {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  layer: string | null;
  label: string;
  group: string | null;
  /** degrees the rectangle is turned by, for pads the CAD placed at an angle */
  rot?: number;
  /** what it is, for the pair the clearance rule talks about */
  kind: TipoRame;
  /**
   * Set when the thing is ROUND: a via, a hole, a circular pad. Measured as the
   * square that contains it, a 0.5mm via grows 0.1mm of corner in every
   * diagonal direction and the check reports a clearance the board does not
   * violate — 56 of this board's 67 trace-to-copper reports were that corner.
   */
  raggio?: number;
  /** the drill, when the thing has one: only this one decides hole to hole */
  foro?: number;
}

/*
 * A MICRON OF SLACK on every dimensional comparison.
 *
 * Coordinates and widths arrive rounded to the micron — a 6 mil trace is
 * 0.1524mm and three decimals make it 0.152 — so comparing them to the
 * nanometre reports violations of rules the board respects: 500 on trace width
 * and 81 on clearance, on a board whose own file says it is fine. A micron is
 * ten times finer than the best fab process, and below it a difference is
 * arithmetic, not copper.
 */
const TOLLERANZA_MM = 0.001;

/** the centre of a box, without needing the whole helper */
const centroDi = (r: Box) => ({ x: (r.minX + r.maxX) / 2, y: (r.minY + r.maxY) / 2 });

/** how far a point is from a rectangle that may be turned */
function distanzaPuntoRettangolo(px: number, py: number, r: Box): number {
  const punti = angoliDi(r);
  let dentro = false;
  for (let i = 0, j = punti.length - 1; i < punti.length; j = i++) {
    const a = punti[i];
    const b = punti[j];
    if (a.y > py !== b.y > py && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x) {
      dentro = !dentro;
    }
  }
  if (dentro) return 0;
  let best = Infinity;
  for (let i = 0; i < punti.length; i++) {
    const a = punti[i];
    const b = punti[(i + 1) % punti.length];
    best = Math.min(best, pointSegDistance(px, py, a.x, a.y, b.x, b.y));
  }
  return best;
}

function boxDistance(a: Box, b: Box): number {
  // round against round, and round against everything else
  if (a.raggio !== undefined && b.raggio !== undefined) {
    const ca = centroDi(a);
    const cb = centroDi(b);
    return Math.max(0, Math.hypot(ca.x - cb.x, ca.y - cb.y) - a.raggio - b.raggio);
  }
  if (a.raggio !== undefined || b.raggio !== undefined) {
    const tondo = a.raggio !== undefined ? a : b;
    const altro = a.raggio !== undefined ? b : a;
    const c = centroDi(tondo);
    return Math.max(0, distanzaPuntoRettangolo(c.x, c.y, altro) - (tondo.raggio ?? 0));
  }
  if (a.rot || b.rot) return distanzaFraRettangoli(a, b);
  const dx = Math.max(a.minX - b.maxX, b.minX - a.maxX, 0);
  const dy = Math.max(a.minY - b.maxY, b.minY - a.maxY, 0);
  return Math.hypot(dx, dy);
}

/**
 * The gap between two rectangles when one of them is TURNED.
 *
 * A pad at 45 degrees measured as if it were straight is a pad measured wrong:
 * on an imported board two capacitor pads 0.24mm apart came out at 0.022mm and
 * the check called it a short. Sixty-seven times.
 *
 * The gap is the largest separation found along the four edge directions of the
 * two rectangles — the separating axis theorem. For rectangles it is the real
 * distance whenever a face is what faces the other one, and never more than the
 * real distance otherwise, so the check can only stay cautious, never miss.
 */
/**
 * Which rule the number comes from, said out loud when it is not the general
 * one: a check that reports "less than 0.0254mm" against a board whose stated
 * minimum is 0.1524 looks like a bug in the checker, and whoever reads it
 * deserves to know that the board itself asked for that.
 */
function quale(rules: DesignRules, minimo: number, a: TipoRame, b: TipoRame): string {
  return minimo === rules.minClearanceMm ? "" : ` (regola ${a}-${b} del progetto)`;
}

/** the four corners of a box, turned by its own angle */
function angoliDi(r: Box): Array<{ x: number; y: number }> {
  const cx = (r.minX + r.maxX) / 2;
  const cy = (r.minY + r.maxY) / 2;
  const hw = (r.maxX - r.minX) / 2;
  const hh = (r.maxY - r.minY) / 2;
  const rad = ((r.rot ?? 0) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ].map(([dx, dy]) => ({ x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos }));
}

function distanzaFraRettangoli(a: Box, b: Box): number {
  const A = angoliDi(a);
  const B = angoliDi(b);
  const assi = [a, b].flatMap((r) => {
    const rad = ((r.rot ?? 0) * Math.PI) / 180;
    return [
      { x: Math.cos(rad), y: Math.sin(rad) },
      { x: -Math.sin(rad), y: Math.cos(rad) },
    ];
  });
  let massimo = 0;
  for (const asse of assi) {
    const pa = A.map((p) => p.x * asse.x + p.y * asse.y);
    const pb = B.map((p) => p.x * asse.x + p.y * asse.y);
    const gap = Math.max(Math.min(...pb) - Math.max(...pa), Math.min(...pa) - Math.max(...pb));
    if (gap > massimo) massimo = gap;
  }
  return massimo;
}

/**
 * Deterministic DRC on Circuit JSON: trace widths, via sizes, board-edge
 * clearance, pad-pad / trace-pad / trace-trace clearances between different
 * nets, straight pin escapes. Trace clearances measure the true
 * segment-to-segment distance minus the half-widths (never again delegated
 * to the autorouter's correctness alone).
 */
export function runDrcChecks(
  circuitJson: El[],
  rules: DesignRules = DEFAULT_DESIGN_RULES,
): DrcViolation[] {
  const raw: DrcViolation[] = [];
  const push = (
    rule: string,
    message: string,
    point?: { x: number; y: number } | null,
  ) => {
    if (raw.length < 500) {
      raw.push({ rule, message, points: point ? [point] : undefined });
    }
  };

  // --- port -> connectivity group map (to know whether two pads are on the same net)
  const portGroup = new Map<string, string>();
  for (const el of circuitJson) {
    if (el.type !== "source_trace") continue;
    const key = String(el.subcircuit_connectivity_map_key ?? el.source_trace_id ?? "");
    for (const pid of (el.connected_source_port_ids as string[] | undefined) ?? []) {
      portGroup.set(pid, key);
    }
  }
  const pcbPortToSource = new Map<string, string>();
  for (const el of circuitJson) {
    if (el.type === "pcb_port" && el.pcb_port_id && el.source_port_id) {
      pcbPortToSource.set(String(el.pcb_port_id), String(el.source_port_id));
    }
  }
  const groupOfPcbPort = (pcbPortId: unknown): string | null => {
    const sp = pcbPortToSource.get(String(pcbPortId ?? ""));
    return sp ? (portGroup.get(sp) ?? null) : null;
  };

  /*
   * A via's net deduced from the trace that contains it. Needed because vias
   * produced by the local router carry no `pcb_port_id`: without this, a via
   * placed on the pad it is meant to connect (via-in-pad, by construction on
   * the same net) came out at distance 0 from a pad "of unknown net" and was
   * flagged as a clearance violation. They were false positives that hid the
   * real ones.
   */
  const groupOfTrace = (el: El): string | null => {
    const st = String(el.source_trace_id ?? "");
    if (!st) return null;
    const source = circuitJson.find(
      (e) => e.type === "source_trace" && String(e.source_trace_id ?? "") === st,
    );
    if (!source) return null;
    return String(
      source.subcircuit_connectivity_map_key ?? source.source_trace_id ?? "",
    ) || null;
  };
  const VIA_ON_TRACE_MM = 0.05;
  const viaGroup = new Map<string, string>();
  for (const el of circuitJson) {
    if (el.type !== "pcb_trace") continue;
    const group = groupOfTrace(el);
    if (!group) continue;
    for (const p of (el.route as Array<Record<string, unknown>> | undefined) ?? []) {
      const x = num(p.x);
      const y = num(p.y);
      if (x === null || y === null) continue;
      viaGroup.set(`${x.toFixed(3)},${y.toFixed(3)}`, group);
    }
  }
  const groupOfVia = (el: El): string | null => {
    const own = groupOfPcbPort(el.pcb_port_id);
    if (own) return own;
    /*
     * The key the element carries, which the imported vias now have: it is the
     * same key the traces group by. Looking only for the route point under the
     * hole left 25 of this board's 26 via-to-pad pairs unnamed, and a via
     * sitting in its own pad — which is what via-in-pad is — was reported as a
     * clearance violation. Twenty-five false alarms hiding the one real one.
     */
    const chiave = String(el.subcircuit_connectivity_map_key ?? "");
    if (chiave) return chiave;
    const x = num(el.x);
    const y = num(el.y);
    if (x === null || y === null) return null;
    // the via lands on a route point: a tiny numerical tolerance is accepted
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const key = `${(x + dx * VIA_ON_TRACE_MM).toFixed(3)},${(y + dy * VIA_ON_TRACE_MM).toFixed(3)}`;
        const g = viaGroup.get(key);
        if (g) return g;
      }
    }
    return viaGroup.get(`${x.toFixed(3)},${y.toFixed(3)}`) ?? null;
  };

  // --- 1. trace widths
  for (const el of circuitJson) {
    if (el.type !== "pcb_trace") continue;
    const route = (el.route as Array<{ width?: number }> | undefined) ?? [];
    const widths = route.map((p) => num(p.width)).filter((w): w is number => w !== null);
    const minW = widths.length ? Math.min(...widths) : null;
    /*
     * A micron of slack. Widths arrive rounded — 6 mil is 0.1524mm and a
     * three-decimal rounding makes it 0.152 — and a check that compares
     * manufacturing dimensions to the nanometre reports five hundred violations
     * that no fab would ever see.
     */
    if (minW !== null && minW < rules.minTraceWidthMm - TOLLERANZA_MM) {
      const thin = ((el.route as Array<Record<string, unknown>>) ?? []).find(
        (p) => typeof p.width === "number" && p.width === minW,
      );
      push(
        "min_trace_width",
        `Trace ${el.pcb_trace_id} width ${minW}mm < min ${rules.minTraceWidthMm}mm`,
        thin && num(thin.x) !== null && num(thin.y) !== null
          ? { x: num(thin.x)!, y: num(thin.y)! }
          : null,
      );
    }
  }

  // --- 2. via / hole sizes
  for (const el of circuitJson) {
    if (el.type !== "pcb_via" && el.type !== "pcb_plated_hole") continue;
    const hole = num(el.hole_diameter);
    const outer = num(el.outer_diameter);
    const at =
      num(el.x) !== null && num(el.y) !== null ? { x: num(el.x)!, y: num(el.y)! } : null;
    if (hole !== null && hole < rules.minViaHoleMm - TOLLERANZA_MM) {
      push("min_via_hole", `${el.type} hole ${hole}mm < min ${rules.minViaHoleMm}mm`, at);
    }
    if (el.type === "pcb_via" && outer !== null && outer < rules.minViaDiameterMm - TOLLERANZA_MM) {
      push("min_via_diameter", `via pad ${outer}mm < min ${rules.minViaDiameterMm}mm`, at);
    }
  }

  // --- bbox of pads and holes for board edge + clearances
  const boxes: Box[] = [];
  for (const el of circuitJson) {
    if (el.type === "pcb_smtpad") {
      // polygonal pads do not declare a center: it is derived from the
      // vertices, otherwise the clearance check does not see them at all
      const centro = centroDaVertici(el as { points?: unknown });
      const punti = (el.points as Array<{ x?: unknown; y?: unknown }> | undefined) ?? [];
      const x = num(el.x) ?? centro?.x ?? null;
      const y = num(el.y) ?? centro?.y ?? null;
      if (x === null || y === null) continue;
      const xs = punti.map((p) => (typeof p.x === "number" ? p.x : NaN)).filter(Number.isFinite);
      const ys = punti.map((p) => (typeof p.y === "number" ? p.y : NaN)).filter(Number.isFinite);
      const w =
        num(el.width) ??
        (xs.length ? Math.max(...xs) - Math.min(...xs) : (num(el.radius) ?? 0) * 2);
      const h =
        num(el.height) ??
        (ys.length ? Math.max(...ys) - Math.min(...ys) : (num(el.radius) ?? 0) * 2);
      boxes.push({
        minX: x - w / 2,
        maxX: x + w / 2,
        minY: y - h / 2,
        maxY: y + h / 2,
        layer: el.layer ? String(el.layer) : null,
        label: String(el.pcb_smtpad_id ?? "pad"),
        group: groupOfPcbPort(el.pcb_port_id),
        kind: "pad",
        ...(el.shape === "circle" && num(el.radius) !== null
          ? { raggio: num(el.radius)! }
          : {}),
        ...(num(el.ccw_rotation) ? { rot: num(el.ccw_rotation)! } : {}),
      });
    } else if (el.type === "pcb_plated_hole" || el.type === "pcb_via") {
      const x = num(el.x);
      const y = num(el.y);
      const d = num(el.outer_diameter) ?? num(el.hole_diameter);
      if (x === null || y === null || d === null) continue;
      boxes.push({
        minX: x - d / 2,
        maxX: x + d / 2,
        minY: y - d / 2,
        maxY: y + d / 2,
        layer: null, // spans all layers
        label: String(el.pcb_via_id ?? el.pcb_plated_hole_id ?? el.type),
        group:
          el.type === "pcb_via" ? groupOfVia(el) : groupOfPcbPort(el.pcb_port_id),
        /*
         * A plated hole is a PAD with a hole in it: that is what the board
         * calls it and what the file's rules are written against. Only the
         * bare via is a via.
         */
        kind: el.type === "pcb_via" ? "via" : "pad",
        raggio: d / 2,
        ...(num(el.hole_diameter) ? { foro: num(el.hole_diameter)! } : {}),
      });
    }
  }

  // --- 3. board-edge clearance
  const board = circuitJson.find((el) => el.type === "pcb_board");
  const bw = board ? num(board.width) : null;
  const bh = board ? num(board.height) : null;
  if (board && bw !== null && bh !== null) {
    const center = (board.center as { x?: number; y?: number } | undefined) ?? {};
    const cx = num(center.x) ?? 0;
    const cy = num(center.y) ?? 0;
    const m = rules.minBoardEdgeClearanceMm;
    for (const b of boxes) {
      if (
        b.minX < cx - bw / 2 + m - TOLLERANZA_MM ||
        b.maxX > cx + bw / 2 - m + TOLLERANZA_MM ||
        b.minY < cy - bh / 2 + m - TOLLERANZA_MM ||
        b.maxY > cy + bh / 2 - m + TOLLERANZA_MM
      ) {
        push(
          "board_edge_clearance",
          `${b.label} closer than ${m}mm to the board edge`,
          boxCenter(b),
        );
      }
    }
  }

  /*
   * A PAD WITH NO NET IS NOT AN ELECTRICAL NODE.
   *
   * An imported board has them: the unconnected pins of a microcontroller, the
   * shells of a connector, the fiducials. On BAT_BS there are 40, and the copper
   * of the real board runs right past them because their designer knew they carry
   * nothing. Measuring them like a net puts 169 markers on the drawing and hides
   * whatever else is there — so they are counted and said once, with their name,
   * instead of marked one by one.
   */
  let senzaRete = 0;

  // --- 4. pad-pad clearance between different nets (same layer or through element)
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      if (a.layer && b.layer && a.layer !== b.layer) continue;
      if (a.group !== null && a.group === b.group) continue;
      const minimo = distanzaMinimaFra(rules, a.kind, b.kind);
      if (a.group === null || b.group === null) {
        if (boxDistance(a, b) < minimo - TOLLERANZA_MM) senzaRete++;
        continue;
      }
      const d = boxDistance(a, b);
      if (d < minimo - TOLLERANZA_MM) {
        push(
          "pad_clearance",
          `${a.label} <-> ${b.label}: ${d.toFixed(3)}mm < min ${minimo}mm${quale(rules, minimo, a.kind, b.kind)}`,
          midpoint(boxCenter(a), boxCenter(b)),
        );
      }
    }
  }


  if (senzaRete > 0) {
    // said once, without markers: they are not electrical nodes
    push(
      "vicinanza_pad_senza_rete",
      `${senzaRete} coppie in cui il vicino e' un pad SENZA rete (pin non collegati, gusci di connettore, fiducial): non sono nodi elettrici e non vengono segnati sul disegno`,
    );
  }

  /*
   * --- 4.b DRILL TO DRILL.
   *
   * The only check that looks at the HOLE and not at the copper around it. Two
   * vias whose rings touch can be perfectly legal — a power net brings four of
   * them side by side to carry current — while two that look far apart on
   * screen can have their drills a tenth of a millimetre from each other, and
   * that is where the wall between them breaks out and the board is scrap. It
   * is measured edge to edge, on the drill, whatever net they are on: the
   * drill does not know about nets.
   */
  const fori = boxes.filter((b) => b.foro !== undefined);
  for (let i = 0; i < fori.length; i++) {
    for (let j = i + 1; j < fori.length; j++) {
      const a = fori[i];
      const b = fori[j];
      const ca = centroDi(a);
      const cb = centroDi(b);
      const d = Math.hypot(ca.x - cb.x, ca.y - cb.y) - (a.foro ?? 0) / 2 - (b.foro ?? 0) / 2;
      if (d >= rules.minHoleToHoleMm - TOLLERANZA_MM) continue;
      push(
        "hole_to_hole",
        `${a.label} <-> ${b.label}: fori a ${d.toFixed(3)}mm < min ${rules.minHoleToHoleMm}mm`,
        midpoint(ca, cb),
      );
    }
  }

  /*
   * --- 5.a trace angles (house rule, Niccolo' 2026-07-26)
   * A trace can be horizontal, vertical or at 45 degrees. In-between angles
   * are ugly and that is not how a board is drawn.
   */
  const ANGLE_TOL_DEG = 3;
  for (const el of circuitJson) {
    if (el.type !== "pcb_trace") continue;
    // a curve is exempt: an arc imported from another CAD is a polyline of
    // chords, and none of them is at 0, 45 or 90 by construction
    if (el.arco === true) continue;
    const route = ((el.route as Array<Record<string, unknown>>) ?? []).filter(
      (p) => num(p.x) !== null && num(p.y) !== null,
    );
    for (let i = 1; i < route.length; i++) {
      const ax = num(route[i - 1].x)!;
      const ay = num(route[i - 1].y)!;
      const bx = num(route[i].x)!;
      const by = num(route[i].y)!;
      const dx = bx - ax;
      const dy = by - ay;
      if (Math.hypot(dx, dy) < 0.02) continue;
      const deg = (Math.atan2(Math.abs(dy), Math.abs(dx)) * 180) / Math.PI;
      const off = Math.min(deg, Math.abs(deg - 45), 90 - deg);
      if (off <= ANGLE_TOL_DEG) continue;
      push(
        "trace_angle",
        `${el.pcb_trace_id}: segmento a ${Math.round(deg)}° (ammessi 0, 45, 90)`,
        { x: (ax + bx) / 2, y: (ay + by) / 2 },
      );
    }
  }

  /*
   * --- 5. pin escapes (house rule, Niccolo' 2026-07-26)
   * The trace must leave the pad STRAIGHT — perpendicular to the edge, so
   * horizontal or vertical — and turn at 45 degrees only afterwards. A
   * diagonal segment attached to the pad reduces the joint's useful copper
   * and leaves acute angles where the etching bites deeper.
   */
  /*
   * How crooked an escape can be before calling it diagonal. The criterion
   * is ANGULAR and not in millimeters: a 2mm-long trace that arrives 0.04mm
   * off axis is crooked by one degree — straight to anyone looking at it and
   * to whoever manufactures it. With a threshold in mm, exactly those were
   * being flagged, while the true 45 degrees (exactly 45 degrees) is the only
   * thing worth catching.
   */
  const ESCAPE_MAX_DEG = 12;
  const padAt = (x: number, y: number): El | null =>
    circuitJson.find((el) => {
      if (el.type === "pcb_smtpad") {
        const px = num(el.x);
        const py = num(el.y);
        if (px === null || py === null) return false;
        const w = (num(el.width) ?? (num(el.radius) ?? 0) * 2) / 2;
        const h = (num(el.height) ?? (num(el.radius) ?? 0) * 2) / 2;
        return Math.abs(px - x) <= w + 1e-6 && Math.abs(py - y) <= h + 1e-6;
      }
      // through holes too (pinheaders, connectors): the straight escape applies just the same
      if (el.type === "pcb_plated_hole") {
        const px = num(el.x);
        const py = num(el.y);
        const d = num(el.outer_diameter) ?? num(el.hole_diameter);
        if (px === null || py === null || d === null) return false;
        return Math.hypot(px - x, py - y) <= d / 2 + 1e-6;
      }
      return false;
    }) ?? null;

  let uscite45 = 0;
  for (const el of circuitJson) {
    if (el.type !== "pcb_trace") continue;
    const route = ((el.route as Array<Record<string, unknown>>) ?? []).filter(
      (p) => num(p.x) !== null && num(p.y) !== null,
    );
    if (route.length < 2) continue;
    // we look at the two ends: that is where the trace touches a pad
    for (const [from, to] of [
      [route[0], route[1]],
      [route[route.length - 1], route[route.length - 2]],
    ] as Array<[Record<string, unknown>, Record<string, unknown>]>) {
      const x = num(from.x)!;
      const y = num(from.y)!;
      if (!padAt(x, y)) continue;
      const dx = num(to.x)! - x;
      const dy = num(to.y)! - y;
      if (Math.hypot(dx, dy) < 1e-6) continue;
      const offAxis = escapeOffAxisDeg(dx, dy);
      if (offAxis <= ESCAPE_MAX_DEG) continue;
      /*
       * Copper that arrives from another CAD is counted, not marked. The rule
       * says how a trace is DRAWN here, and an Altium layout is a given: on one
       * imported board it put 172 markers on the drawing, which is a drawing
       * nobody can read any more. The number is said once, at the end.
       */
      if (el.importato === true) {
        uscite45++;
        continue;
      }
      push(
        "pin_escape",
        `${el.pcb_trace_id}: esce dal pad a ${Math.round(offAxis)}° fuori asse invece che dritto`,
        { x, y },
      );
    }
  }
  if (uscite45 > 0) {
    // no coordinates on purpose: it is one line in the report, not a rash of
    // markers over a board somebody else drew
    push(
      "pin_escape_importato",
      `${uscite45} tratti di rame importato escono dal pad a 45°: e' come e' disegnata la scheda di partenza, non un errore introdotto qui`,
    );
  }

  /*
   * --- 6. trace-pad clearance between different nets (Niccolo' 2026-07-26)
   * Until now it was "delegated to the autorouter": if the router got it
   * wrong, nothing stopped it — a trace over another net's pad went
   * unnoticed. Now we measure the true segment-to-pad-bbox distance, minus
   * half the trace width. Same net: ok by construction (it is the intended
   * connection). Traces with no known net (spliced): skipped, no false
   * positives.
   */
  interface WireSeg {
    ax: number;
    ay: number;
    bx: number;
    by: number;
    layer: string | null;
    halfW: number;
    group: string | null;
    label: string;
  }
  const segs: WireSeg[] = [];
  for (const el of circuitJson) {
    if (el.type !== "pcb_trace") continue;
    const group = groupOfTrace(el);
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
      const layer = b.layer ? String(b.layer) : a.layer ? String(a.layer) : null;
      segs.push({
        ax,
        ay,
        bx,
        by,
        layer,
        halfW: (num(b.width) ?? num(a.width) ?? rules.minTraceWidthMm) / 2,
        group,
        label: String(el.pcb_trace_id ?? "trace"),
      });
    }
  }

  for (const seg of segs) {
    if (!seg.group) continue;
    for (const pad of boxes) {
      if (pad.group === null || pad.group === seg.group) continue;
      if (pad.layer && seg.layer && pad.layer !== seg.layer) continue;
      const minimo = distanzaMinimaFra(rules, "trace", pad.kind);
      const d = segToBoxDistance(seg, pad) - seg.halfW;
      if (d < minimo - TOLLERANZA_MM) {
        push(
          "trace_pad_clearance",
          `${seg.label} over ${pad.label}: ${Math.max(0, d).toFixed(3)}mm < min ${minimo}mm${quale(rules, minimo, "trace", pad.kind)}`,
          midpoint(boxCenter(pad), {
            x: (seg.ax + seg.bx) / 2,
            y: (seg.ay + seg.by) / 2,
          }),
        );
      }
    }
  }

  // --- 7. trace-trace clearance between different nets, same layer
  for (let i = 0; i < segs.length; i++) {
    const a = segs[i];
    if (!a.group) continue;
    for (let j = i + 1; j < segs.length; j++) {
      const b = segs[j];
      if (!b.group || a.group === b.group) continue;
      if (a.layer && b.layer && a.layer !== b.layer) continue;
      const minimo = distanzaMinimaFra(rules, "trace", "trace");
      const d = segSegDistance(a, b) - a.halfW - b.halfW;
      if (d < minimo - TOLLERANZA_MM) {
        push(
          "trace_trace_clearance",
          `${a.label} <-> ${b.label}: ${Math.max(0, d).toFixed(3)}mm < min ${minimo}mm${quale(rules, minimo, "trace", "trace")} (${a.layer ?? "?"})`,
          { x: (a.ax + a.bx) / 2, y: (a.ay + a.by) / 2 },
        );
      }
    }
  }

  /*
   * Isolated ground: a pad sitting on a net that has a copper plane but with
   * no via to take it down there.
   *
   * It is the check that closes the right way of doing ground — you place,
   * you route the signal, you pour the plane, and THEN you verify that nobody
   * has been left out. Without it, a pad disconnected from the plane is
   * invisible: the DRC finds it clean, the connections come out closed, and
   * the defect shows up in production with a ground that does not return.
   */
  const planeNetIds = new Set<string>();
  for (const el of circuitJson) {
    if (el.type !== "pcb_copper_pour") continue;
    const net = String(el.source_net_id ?? "");
    if (net) planeNetIds.add(net);
  }
  if (planeNetIds.size > 0) {
    const portsOnPlane = new Set<string>();
    for (const el of circuitJson) {
      if (el.type !== "source_trace") continue;
      const nets = (el.connected_source_net_ids as string[] | undefined) ?? [];
      if (!nets.some((n) => planeNetIds.has(String(n)))) continue;
      for (const p of (el.connected_source_port_ids as string[] | undefined) ?? []) {
        portsOnPlane.add(String(p));
      }
    }
    const pcbPortsOnPlane = new Set<string>();
    for (const el of circuitJson) {
      if (el.type !== "pcb_port") continue;
      if (portsOnPlane.has(String(el.source_port_id ?? ""))) {
        pcbPortsOnPlane.add(String(el.pcb_port_id ?? ""));
      }
    }
    /*
     * A pad IMMERSED in the plane of its own face needs no via: it is already
     * in that copper. Asking for one anyway — as this check used to do — meant
     * demanding 43 useless holes on bat-bs-blocchi, one per ground pad, each
     * connecting copper to itself. The via is needed only when the plane of
     * that net is on ANOTHER face.
     */
    const pours = readPours(circuitJson);
    /*
     * The same function the house rule uses to decide whether a pad needs a
     * via: if the two answered differently, one would add vias the other keeps
     * asking for. It measures from the pad's EDGE and only counts vias of the
     * pad's own net.
     */
    for (const scoperto of padsOffPlane(circuitJson, pours)) {
      push(
        "plane_stitch_missing",
        `${scoperto.pad || "pad"} sta su una rete con il piano, non e' dentro il piano della sua faccia e non ha una via della sua rete accanto`,
        { x: scoperto.x, y: scoperto.y },
      );
    }


    /*
     * The planes of the same net on more than one face must be tied to each
     * other. Without stitching vias the return current, to change layer, has to
     * travel along the plane looking for the nearest signal via: it is the
     * classic loop that turns a ground plane into an antenna.
     */
    const facceDiRete = pourLayersByNet(pours);
    const viaDiRete = tutteLeVia(circuitJson, netOfViaKey(circuitJson, pours));
    for (const [net, facce] of facceDiRete) {
      if (facce.size < 2) continue;
      const cuciture = viaDiRete.filter(
        (v) => [...facce].filter((f) => v.facce.includes(f)).length >= 2,
      ).length;
      if (cuciture === 0) {
        push(
          "plane_stitch_missing",
          `i piani della rete ${net} stanno su ${facce.size} facce (${[...facce].join(", ")}) e nessuna via li collega`,
        );
      }
    }
  }

  // The same violations repeat dozens of times (one per via, per pad...):
  // aggregating them by rule keeps the LLM feedback readable and short.
  const byRule = new Map<string, DrcViolation[]>();
  for (const v of raw) {
    const list = byRule.get(v.rule) ?? [];
    list.push(v);
    byRule.set(v.rule, list);
  }
  const aggregated: DrcViolation[] = [];
  for (const [rule, list] of byRule) {
    if (list.length <= 3) {
      aggregated.push(...list);
    } else {
      aggregated.push({
        rule,
        message: `${list.length}x ${rule}: ${list[0].message} (and ${list.length - 1} more)`,
        // the points of ALL the occurrences: aggregating the text must not
        // make the dots disappear from the board
        points: list.flatMap((v) => v.points ?? []),
      });
    }
  }
  return aggregated;
}

/**
 * How many degrees the escape is off the nearest axis (horizontal or
 * vertical). 0 = perfectly straight, 45 = fully diagonal.
 */
export function escapeOffAxisDeg(dx: number, dy: number): number {
  const deg = (Math.atan2(Math.abs(dy), Math.abs(dx)) * 180) / Math.PI;
  return Math.min(deg, 90 - deg);
}

function boxCenter(b: Box): { x: number; y: number } {
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
}

function midpoint(
  a: { x: number; y: number },
  b: { x: number; y: number },
): { x: number; y: number } {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** point-to-segment distance */
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
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** segment-to-bbox distance (0 if the segment enters the box) */
function segToBoxDistance(
  seg: { ax: number; ay: number; bx: number; by: number },
  box: Box,
): number {
  if (box.raggio !== undefined) {
    const c = centroDi(box);
    return Math.max(
      0,
      pointSegDistance(c.x, c.y, seg.ax, seg.ay, seg.bx, seg.by) - box.raggio,
    );
  }
  /*
   * The corners are the TURNED ones. Measuring a pad at 45 degrees as if it
   * were straight does not even measure the box that contains it: it measures
   * a different rectangle, in the wrong direction, and on this board that is
   * every pin of a component the designer rotated.
   */
  const punti = angoliDi(box);
  const inside = (x: number, y: number) => {
    let dentro = false;
    for (let i = 0, j = punti.length - 1; i < punti.length; j = i++) {
      const p = punti[i];
      const q = punti[j];
      if (p.y > y !== q.y > y && x < ((q.x - p.x) * (y - p.y)) / (q.y - p.y) + p.x) dentro = !dentro;
    }
    return dentro;
  };
  if (inside(seg.ax, seg.ay) || inside(seg.bx, seg.by)) return 0;
  const corners = punti.map((p) => [p.x, p.y] as const);
  let best = Infinity;
  for (let i = 0; i < 4; i++) {
    const [cx1, cy1] = corners[i];
    const [cx2, cy2] = corners[(i + 1) % 4];
    if (segSegDistanceRaw(seg.ax, seg.ay, seg.bx, seg.by, cx1, cy1, cx2, cy2) === 0) {
      return 0;
    }
    best = Math.min(
      best,
      pointSegDistance(cx1, cy1, seg.ax, seg.ay, seg.bx, seg.by),
      pointSegDistance(cx2, cy2, seg.ax, seg.ay, seg.bx, seg.by),
    );
  }
  return best;
}

/** distance between two segments (0 if they cross) */
function segSegDistanceRaw(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): number {
  const d1 = crossSign(ax, ay, bx, by, cx, cy);
  const d2 = crossSign(ax, ay, bx, by, dx, dy);
  const d3 = crossSign(cx, cy, dx, dy, ax, ay);
  const d4 = crossSign(cx, cy, dx, dy, bx, by);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return 0;
  }
  return Math.min(
    pointSegDistance(ax, ay, cx, cy, dx, dy),
    pointSegDistance(bx, by, cx, cy, dx, dy),
    pointSegDistance(cx, cy, ax, ay, bx, by),
    pointSegDistance(dx, dy, ax, ay, bx, by),
  );
}

function crossSign(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  px: number,
  py: number,
): number {
  return (bx - ax) * (py - ay) - (by - ay) * (px - ax);
}

function segSegDistance(
  a: { ax: number; ay: number; bx: number; by: number },
  b: { ax: number; ay: number; bx: number; by: number },
): number {
  return segSegDistanceRaw(a.ax, a.ay, a.bx, a.by, b.ax, b.ay, b.bx, b.by);
}
