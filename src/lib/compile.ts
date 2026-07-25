import { runTscircuitCode } from "@tscircuit/eval";
import type { FsMap } from "./project-store";

export interface CompileSummary {
  ok: boolean;
  errors: Array<{ type: string; message: string }>;
  components: Array<{ name: string; ftype?: string; value?: string }>;
  nets: string[];
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

  const sourceTraces = circuitJson.filter((el) => el.type === "source_trace").length;
  const pcbTraces = circuitJson.filter((el) => el.type === "pcb_trace").length;

  const ok = errors.length === 0;
  const message = ok
    ? `Compile OK: ${components.length} components, ${nets.length} nets, ${pcbTraces} routed pcb traces (${sourceTraces} source traces).`
    : `Compile finished with ${errors.length} error(s).`;

  return { ok, errors, components, nets, sourceTraces, pcbTraces, message };
}
