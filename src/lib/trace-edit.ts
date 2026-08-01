import type { CircuitElement } from "./route-score";
import { parseManualEdits, serializeManualEdits, type ManualEdits } from "./manual-edits";

type El = Record<string, unknown>;

/**
 * Removes a trace: its copper and its vias disappear, and the connection
 * is left unrouted (the summary reports it). You then redraw it by hand, or
 * the next full compilation reroutes it automatically with the autorouter.
 *
 * If the trace was drawn by hand, it must also be removed from manual-edits.json:
 * otherwise it would come back from the dead on the next compilation.
 */
export function deleteTrace(
  circuitJson: unknown[],
  pcbTraceId: string,
  manualEditsRaw: string | undefined,
): { circuitJson: CircuitElement[]; connection: string | null; edits: ManualEdits; editsChanged: boolean } | null {
  const elements = circuitJson as El[];
  const target = elements.find(
    (el) => el.type === "pcb_trace" && String(el.pcb_trace_id ?? "") === pcbTraceId,
  );
  if (!target) return null;
  const connection = target.connection_name ? String(target.connection_name) : null;

  const out = elements.filter((el) => {
    if (el.type === "pcb_trace" && String(el.pcb_trace_id ?? "") === pcbTraceId) return false;
    if (el.type === "pcb_via" && String(el.pcb_trace_id ?? "") === pcbTraceId) return false;
    return true;
  }) as CircuitElement[];

  const edits = parseManualEdits(manualEditsRaw);
  const before = edits.pcb_routes.length;
  if (connection) {
    edits.pcb_routes = edits.pcb_routes.filter((r) => r.connection !== connection);
  }

  return {
    circuitJson: out,
    connection,
    edits,
    editsChanged: edits.pcb_routes.length !== before,
  };
}

export { serializeManualEdits };
