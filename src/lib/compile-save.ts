import { schematicMissing } from "./board-report";
import type { CompileSummary } from "./compile";
import { CHECKS_ENGINE_VERSION } from "./engine-version";
import { hasBoard, saveCompileCache, type CompileCache, type SaveCompileResult } from "./project-store";

/**
 * Saves the board without its schematic, as soon as the compile has it (see
 * CompileOptions.onBoard): the same for the page's Ricompila and for the MCP
 * compile, so a big board is on the server within seconds whoever compiles it.
 *
 * Not when the saved row is already the COMPLETE board of these same files:
 * replacing it with one without schematic would only lose the drawing for the
 * length of the compile, and lose it for good if the compile is cut off.
 */
export function earlyBoardSaver(
  projectId: string,
  hash: string,
  previous: CompileCache | null,
): (early: { circuitJson: unknown[]; summary: CompileSummary }) => Promise<SaveCompileResult> {
  const sameAndComplete =
    previous !== null &&
    previous.filesHash === hash &&
    hasBoard(previous.circuitJson) &&
    !schematicMissing(previous.circuitJson) &&
    !(previous.summary as { schematicPending?: unknown } | null)?.schematicPending;
  return async (early) => {
    if (sameAndComplete) {
      return { saved: false, keptPrevious: true, reason: "la scheda salvata e' gia' quella completa di questi file" };
    }
    return saveCompileCache(projectId, hash, early.circuitJson, early.summary, CHECKS_ENGINE_VERSION).catch(
      () => ({ saved: false, reason: "salvataggio anticipato fallito" }),
    );
  };
}
