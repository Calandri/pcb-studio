import { DEFAULT_DESIGN_RULES, type DesignRules } from "./design-rules";

export interface DrcViolation {
  rule: string;
  message: string;
  /**
   * Dove sta il problema sulla scheda (mm, centro scheda = 0,0). Senza questo
   * una segnalazione dice COSA non va ma non DOVE: sulle aggregate si tengono
   * i punti di tutte le occorrenze.
   */
  points?: Array<{ x: number; y: number }>;
}

interface El {
  type: string;
  [key: string]: unknown;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

interface Box {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  layer: string | null;
  label: string;
  group: string | null;
}

function boxDistance(a: Box, b: Box): number {
  const dx = Math.max(a.minX - b.maxX, b.minX - a.maxX, 0);
  const dy = Math.max(a.minY - b.maxY, b.minY - a.maxY, 0);
  return Math.hypot(dx, dy);
}

/**
 * DRC deterministico su Circuit JSON: larghezze piste, dimensioni via,
 * distanza dal bordo, clearance pad-pad / traccia-pad / traccia-traccia tra
 * net diverse, uscita dai pin dritta. Le clearance di traccia misurano la
 * distanza vera segmento-segmento meno le semi-larghezze (mai piu' delegate
 * alla sola correttezza dell'autorouter).
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

  // --- mappa porta -> gruppo di connettivita' (per sapere se due pad sono sulla stessa net)
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
   * Net di una via dedotta dalla pista che la contiene. Serve perche' le via
   * prodotte dal router locale non portano `pcb_port_id`: senza questo, una
   * via piazzata sul pad che deve collegare (via-in-pad, per costruzione sulla
   * stessa net) risultava a distanza 0 da un pad "di net sconosciuta" e veniva
   * segnalata come violazione di clearance. Erano falsi positivi che
   * nascondevano quelli veri.
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
    const x = num(el.x);
    const y = num(el.y);
    if (x === null || y === null) return null;
    // la via cade su un punto di rotta: si accetta un minimo scarto numerico
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const key = `${(x + dx * VIA_ON_TRACE_MM).toFixed(3)},${(y + dy * VIA_ON_TRACE_MM).toFixed(3)}`;
        const g = viaGroup.get(key);
        if (g) return g;
      }
    }
    return viaGroup.get(`${x.toFixed(3)},${y.toFixed(3)}`) ?? null;
  };

  // --- 1. larghezza piste
  for (const el of circuitJson) {
    if (el.type !== "pcb_trace") continue;
    const route = (el.route as Array<{ width?: number }> | undefined) ?? [];
    const widths = route.map((p) => num(p.width)).filter((w): w is number => w !== null);
    const minW = widths.length ? Math.min(...widths) : null;
    if (minW !== null && minW < rules.minTraceWidthMm - 1e-6) {
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

  // --- 2. dimensioni via / fori
  for (const el of circuitJson) {
    if (el.type !== "pcb_via" && el.type !== "pcb_plated_hole") continue;
    const hole = num(el.hole_diameter);
    const outer = num(el.outer_diameter);
    const at =
      num(el.x) !== null && num(el.y) !== null ? { x: num(el.x)!, y: num(el.y)! } : null;
    if (hole !== null && hole < rules.minViaHoleMm - 1e-6) {
      push("min_via_hole", `${el.type} hole ${hole}mm < min ${rules.minViaHoleMm}mm`, at);
    }
    if (el.type === "pcb_via" && outer !== null && outer < rules.minViaDiameterMm - 1e-6) {
      push("min_via_diameter", `via pad ${outer}mm < min ${rules.minViaDiameterMm}mm`, at);
    }
  }

  // --- bbox di pad e fori per bordo scheda + clearance
  const boxes: Box[] = [];
  for (const el of circuitJson) {
    if (el.type === "pcb_smtpad") {
      const x = num(el.x);
      const y = num(el.y);
      if (x === null || y === null) continue;
      const w = num(el.width) ?? (num(el.radius) ?? 0) * 2;
      const h = num(el.height) ?? (num(el.radius) ?? 0) * 2;
      boxes.push({
        minX: x - w / 2,
        maxX: x + w / 2,
        minY: y - h / 2,
        maxY: y + h / 2,
        layer: el.layer ? String(el.layer) : null,
        label: String(el.pcb_smtpad_id ?? "pad"),
        group: groupOfPcbPort(el.pcb_port_id),
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
        layer: null, // attraversa tutti i layer
        label: String(el.pcb_via_id ?? el.pcb_plated_hole_id ?? el.type),
        group:
          el.type === "pcb_via" ? groupOfVia(el) : groupOfPcbPort(el.pcb_port_id),
      });
    }
  }

  // --- 3. distanza dal bordo scheda
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
        b.minX < cx - bw / 2 + m - 1e-6 ||
        b.maxX > cx + bw / 2 - m + 1e-6 ||
        b.minY < cy - bh / 2 + m - 1e-6 ||
        b.maxY > cy + bh / 2 - m + 1e-6
      ) {
        push(
          "board_edge_clearance",
          `${b.label} closer than ${m}mm to the board edge`,
          boxCenter(b),
        );
      }
    }
  }

  // --- 4. clearance pad-pad tra net diverse (stesso layer o elemento passante)
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      if (a.layer && b.layer && a.layer !== b.layer) continue;
      if (a.group !== null && a.group === b.group) continue;
      const d = boxDistance(a, b);
      if (d < rules.minClearanceMm - 1e-6) {
        push(
          "pad_clearance",
          `${a.label} <-> ${b.label}: ${d.toFixed(3)}mm < min ${rules.minClearanceMm}mm`,
          midpoint(boxCenter(a), boxCenter(b)),
        );
      }
    }
  }


  /*
   * --- 5. uscita dai pin (regola di casa, Niccolo' 2026-07-26)
   * La pista deve staccarsi dal pad DRITTA — perpendicolare al bordo, quindi
   * orizzontale o verticale — e girare a 45 gradi solo dopo. Un segmento
   * diagonale attaccato al pad riduce il rame utile del giunto e lascia angoli
   * acuti dove l'incisione morde di piu'.
   */
  /*
   * Quanto puo' essere storta un'uscita prima di chiamarla diagonale. Il
   * criterio e' ANGOLARE e non in millimetri: una pista lunga 2mm che arriva
   * 0,04mm fuori asse e' storta di un grado — dritta per chiunque la guardi e
   * per chi la produce. Con una soglia in mm venivano segnalate proprio quelle,
   * mentre il 45 gradi vero (45 gradi esatti) e' l'unica cosa da prendere.
   */
  const ESCAPE_MAX_DEG = 12;
  const padAt = (x: number, y: number): El | null =>
    circuitJson.find((el) => {
      if (el.type !== "pcb_smtpad") return false;
      const px = num(el.x);
      const py = num(el.y);
      if (px === null || py === null) return false;
      const w = (num(el.width) ?? (num(el.radius) ?? 0) * 2) / 2;
      const h = (num(el.height) ?? (num(el.radius) ?? 0) * 2) / 2;
      return Math.abs(px - x) <= w + 1e-6 && Math.abs(py - y) <= h + 1e-6;
    }) ?? null;

  for (const el of circuitJson) {
    if (el.type !== "pcb_trace") continue;
    const route = ((el.route as Array<Record<string, unknown>>) ?? []).filter(
      (p) => num(p.x) !== null && num(p.y) !== null,
    );
    if (route.length < 2) continue;
    // si guardano i due capi: e' li' che la pista tocca un pad
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
      push(
        "pin_escape",
        `${el.pcb_trace_id}: esce dal pad a ${Math.round(offAxis)}° fuori asse invece che dritto`,
        { x, y },
      );
    }
  }

  /*
   * --- 6. clearance traccia-pad tra net diverse (Niccolo' 2026-07-26)
   * Fino a qui era "delegata all'autorouter": se il router sbagliava, niente
   * lo fermava — una pista sopra un pad di un'altra net passava inosservata.
   * Ora si misura la distanza vera segmento-bbox del pad, meno la meta'
   * larghezza della pista. Stessa net: ok per costruzione (e' la connessione
   * voluta). Tracce senza net nota (spliced): saltate, niente falsi positivi.
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
      const d = segToBoxDistance(seg, pad) - seg.halfW;
      if (d < rules.minClearanceMm - 1e-6) {
        push(
          "trace_pad_clearance",
          `${seg.label} over ${pad.label}: ${Math.max(0, d).toFixed(3)}mm < min ${rules.minClearanceMm}mm`,
          midpoint(boxCenter(pad), {
            x: (seg.ax + seg.bx) / 2,
            y: (seg.ay + seg.by) / 2,
          }),
        );
      }
    }
  }

  // --- 7. clearance traccia-traccia tra net diverse, stesso layer
  for (let i = 0; i < segs.length; i++) {
    const a = segs[i];
    if (!a.group) continue;
    for (let j = i + 1; j < segs.length; j++) {
      const b = segs[j];
      if (!b.group || a.group === b.group) continue;
      if (a.layer && b.layer && a.layer !== b.layer) continue;
      const d = segSegDistance(a, b) - a.halfW - b.halfW;
      if (d < rules.minClearanceMm - 1e-6) {
        push(
          "trace_trace_clearance",
          `${a.label} <-> ${b.label}: ${Math.max(0, d).toFixed(3)}mm < min ${rules.minClearanceMm}mm (${a.layer ?? "?"})`,
          { x: (a.ax + a.bx) / 2, y: (a.ay + a.by) / 2 },
        );
      }
    }
  }

  // Le stesse violazioni si ripetono decine di volte (una per via, per pad...):
  // aggregarle per regola tiene il feedback all'LLM leggibile e corto.
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
        // i punti di TUTTE le occorrenze: aggregare il testo non deve far
        // sparire i puntini dalla scheda
        points: list.flatMap((v) => v.points ?? []),
      });
    }
  }
  return aggregated;
}

/**
 * Di quanti gradi l'uscita e' fuori dall'asse piu' vicino (orizzontale o
 * verticale). 0 = perfettamente dritta, 45 = diagonale piena.
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

/** distanza punto-segmento */
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

/** distanza segmento-bbox (0 se il segmento entra nel box) */
function segToBoxDistance(
  seg: { ax: number; ay: number; bx: number; by: number },
  box: Box,
): number {
  // un estremo dentro il box, o il segmento incrocia un bordo: distanza 0
  const inside = (x: number, y: number) =>
    x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY;
  if (inside(seg.ax, seg.ay) || inside(seg.bx, seg.by)) return 0;
  const corners = [
    [box.minX, box.minY],
    [box.maxX, box.minY],
    [box.maxX, box.maxY],
    [box.minX, box.maxY],
  ] as const;
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

/** distanza tra due segmenti (0 se si incrociano) */
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
