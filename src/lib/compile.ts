import { runTscircuitCode } from "@tscircuit/eval";
import { runDrcChecks, type DrcViolation } from "./drc";
import type { FsMap } from "./project-store";

export interface CompileSummary {
  ok: boolean;
  errors: Array<{ type: string; message: string }>;
  components: Array<{ name: string; ftype?: string; value?: string }>;
  nets: string[];
  /** every declared connection, e.g. ".R1 > .pin1 to net.VCC" */
  connections: string[];
  /** connections declared in source but with no routed pcb trace */
  unroutedConnections: string[];
  /** deterministic design-rule violations (JLCPCB defaults) */
  drcViolations: DrcViolation[];
  sourceTraces: number;
  pcbTraces: number;
  message: string;
}

interface CircuitElement {
  type: string;
  [key: string]: unknown;
}

/**
 * Authoritative server-side compile: same @tscircuit/eval the browser uses,
 * but its summary is what the LLM sees (the self-correction feedback loop).
 */
export async function compileProject(fsMap: FsMap): Promise<CompileSummary> {
  let circuitJson: CircuitElement[];
  try {
    circuitJson = (await runTscircuitCode(fsMap, {
      mainComponentPath: "main.tsx",
    })) as CircuitElement[];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      errors: [{ type: "compile_exception", message }],
      components: [],
      nets: [],
      connections: [],
      unroutedConnections: [],
      drcViolations: [],
      sourceTraces: 0,
      pcbTraces: 0,
      message: `Compilation failed: ${message}`,
    };
  }

  const errors = circuitJson
    .filter((el) => el.type.endsWith("_error"))
    .map((el) => ({
      type: el.type,
      message: String(el.message ?? el.error_type ?? JSON.stringify(el)).slice(0, 500),
    }));

  const components = circuitJson
    .filter((el) => el.type === "source_component")
    .map((el) => ({
      name: String(el.name ?? "?"),
      ftype: el.ftype ? String(el.ftype) : undefined,
      value: el.display_value ? String(el.display_value) : undefined,
    }));

  const nets = circuitJson
    .filter((el) => el.type === "source_net")
    .map((el) => String(el.name ?? "?"));

  const sourceTraceEls = circuitJson.filter((el) => el.type === "source_trace");
  const pcbTraceEls = circuitJson.filter((el) => el.type === "pcb_trace");
  const routedSourceIds = new Set(
    pcbTraceEls.map((el) => String(el.source_trace_id ?? "")).filter(Boolean),
  );

  const traceLabel = (el: CircuitElement) =>
    String(el.display_name ?? el.source_trace_id ?? "trace");
  const connections = sourceTraceEls.map(traceLabel).slice(0, 40);

  // Routing is judged per CONNECTIVITY GROUP, not per source trace: traces on
  // the same net get merged by the router, so only some of them carry the
  // pcb_trace. A group counts as unrouted only if NONE of its traces routed.
  const groupKey = (el: CircuitElement) =>
    String(el.subcircuit_connectivity_map_key ?? el.source_trace_id ?? "");
  const routedGroups = new Set(
    sourceTraceEls
      .filter((el) => routedSourceIds.has(String(el.source_trace_id ?? "")))
      .map(groupKey),
  );
  const unroutedGroupSeen = new Set<string>();
  const unroutedConnections: string[] = [];
  for (const el of sourceTraceEls) {
    const key = groupKey(el);
    if (!routedGroups.has(key) && !unroutedGroupSeen.has(key)) {
      unroutedGroupSeen.add(key);
      unroutedConnections.push(traceLabel(el));
      if (unroutedConnections.length >= 40) break;
    }
  }

  const sourceTraces = sourceTraceEls.length;
  const pcbTraces = pcbTraceEls.length;

  const drcViolations = runDrcChecks(circuitJson);

  const ok = errors.length === 0;
  const message = ok
    ? `Compile OK: ${components.length} components, ${nets.length} nets, ` +
      `${pcbTraces} routed pcb traces (${sourceTraces} source traces` +
      `${unroutedConnections.length ? `, ${unroutedConnections.length} UNROUTED` : ""})` +
      `${drcViolations.length ? ` - ${drcViolations.length} DRC violation(s)` : " - DRC clean"}.`
    : `Compile finished with ${errors.length} error(s).`;

  return {
    ok,
    errors,
    components,
    nets,
    connections,
    unroutedConnections,
    drcViolations,
    sourceTraces,
    pcbTraces,
    message,
  };
}
