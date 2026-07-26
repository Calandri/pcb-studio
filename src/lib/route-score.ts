/**
 * Come si giudica una rotta. Sta a parte perche' lo usano sia la compilazione
 * sia il ciclo di sbroglio, e tenerlo dentro compile.ts creava un import
 * circolare fra i due.
 *
 * L'ordine delle voci non e' casuale: una scheda con un errore non si fa, una
 * con un collegamento aperto non funziona, una che viola le regole non si
 * produce, e solo dopo vengono i gusti (meno via, meno rame).
 */
import { runDrcChecks } from "./drc";

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
  lengthMm: number;
}

/** errors + unrouted groups + DRC + via count + length: minimized across candidates */
export function scoreCircuit(circuitJson: CircuitElement[]): CircuitScore {
  return {
    errors: circuitJson.filter((el) => el.type.endsWith("_error")).length,
    unrouted: computeUnroutedGroupKeys(circuitJson).size,
    // si contano le OCCORRENZE, non le famiglie: aggregate, 110 uscite storte
    // e 1 sola pesano uguale e il confronto fra due rotte non vede la differenza
    drc: runDrcChecks(circuitJson).reduce(
      (n, v) => n + Math.max(1, v.points?.length ?? 1),
      0,
    ),
    vias: circuitJson.filter((el) => el.type === "pcb_via").length,
    lengthMm: totalWireLengthMm(circuitJson),
  };
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
      if (!routedGroups.has(key)) unrouted.add(key);
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
    const touched = pts.some((pt) =>
      wirePoints.some(
        (w) => Math.abs(w.x - pt.x) <= TRACE_TOUCH_MM && Math.abs(w.y - pt.y) <= TRACE_TOUCH_MM,
      ),
    );
    if (!touched) unrouted.add(key);
  }
  return unrouted;
}

