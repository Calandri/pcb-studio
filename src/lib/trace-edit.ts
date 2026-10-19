import type { CircuitElement } from "./route-score";
import { manualRouteKey } from "./manual-routes";
import { parseManualEdits, serializeManualEdits, type ManualEdits } from "./manual-edits";

type El = Record<string, unknown>;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const viaKey = (x: number, y: number): string => `${Math.round(x * 1000) / 1000},${Math.round(y * 1000) / 1000}`;

/**
 * Removes a trace: its copper and its vias disappear, and the connection
 * is left unrouted (the summary reports it). You then redraw it by hand, or
 * the next full compilation reroutes it automatically with the autorouter.
 *
 * If the trace was drawn by hand, it must also be removed from manual-edits.json:
 * otherwise it would come back from the dead on the next compilation.
 *
 * Two things this used to get wrong:
 *   - the trace's connection was read from `connection_name`, which hand
 *     traces do not carry (and autorouted ones carry as a solver name, not
 *     the display name the routes are keyed by): the route survived in the
 *     file and the next Apply put the copper back. The route is found by the
 *     key written on the copper, then by the connection resolved through
 *     `source_trace_id`;
 *   - vias were matched by `pcb_trace_id`, which a pcb_via does not have: the
 *     holes stayed on the board with nothing attached. They are found by
 *     position, at the trace's own `via` points, and kept when another trace
 *     still passes through them.
 */
export function deleteTrace(
  circuitJson: unknown[],
  pcbTraceId: string,
  manualEditsRaw: string | null | undefined,
): { circuitJson: CircuitElement[]; connection: string | null; edits: ManualEdits; editsChanged: boolean } | null {
  const elements = circuitJson as El[];
  const target = elements.find(
    (el) => el.type === "pcb_trace" && String(el.pcb_trace_id ?? "") === pcbTraceId,
  );
  if (!target) return null;

  const sourceTraceId = typeof target.source_trace_id === "string" ? target.source_trace_id : null;
  const source = sourceTraceId
    ? elements.find((el) => el.type === "source_trace" && el.source_trace_id === sourceTraceId)
    : undefined;
  const connection =
    typeof source?.display_name === "string" && source.display_name
      ? source.display_name
      : target.connection_name
        ? String(target.connection_name)
        : null;

  // the trace's holes, and the ones other copper still needs
  const routeOf = (el: El) => (Array.isArray(el.route) ? (el.route as El[]) : []);
  const itsVias = new Set<string>();
  for (const p of routeOf(target)) {
    const x = num(p.x), y = num(p.y);
    if (p.route_type === "via" && x !== null && y !== null) itsVias.add(viaKey(x, y));
  }
  const stillUsed = new Set<string>();
  for (const el of elements) {
    if (el.type !== "pcb_trace" || el === target) continue;
    for (const p of routeOf(el)) {
      const x = num(p.x), y = num(p.y);
      if (p.route_type === "via" && x !== null && y !== null) stillUsed.add(viaKey(x, y));
    }
  }

  const out = elements.filter((el) => {
    if (el === target) return false;
    if (el.type === "pcb_via") {
      const x = num(el.x), y = num(el.y);
      if (x === null || y === null) return true;
      const k = viaKey(x, y);
      if (itsVias.has(k) && !stillUsed.has(k)) return false;
    }
    return true;
  }) as CircuitElement[];

  const edits = parseManualEdits(manualEditsRaw);
  const before = edits.pcb_routes.length;
  if (target.manual === true) {
    if (typeof target.manual_route_id === "string") {
      // the copper says exactly which route drew it
      const key = target.manual_route_id;
      edits.pcb_routes = edits.pcb_routes.filter((r) => manualRouteKey(r) !== key);
    } else if (connection) {
      // copper compiled before routes carried their key: by connection, as before
      edits.pcb_routes = edits.pcb_routes.filter((r) => r.connection !== connection || r.net || (r.from && r.to));
    }
  }

  return {
    circuitJson: out,
    connection,
    edits,
    editsChanged: edits.pcb_routes.length !== before,
  };
}

export { serializeManualEdits };
