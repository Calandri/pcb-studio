import { readCompileRun } from "./activity-store";
import { withLibrary } from "./agent-tools";
import type { CompileRun } from "./compile-run";
import { CHECKS_ENGINE_VERSION } from "./engine-version";
import { extractComponents, extractIssues, type InspectComponent, type InspectIssue } from "./inspect";
import type { Profile } from "./profile";
import { filesHash, getCompileCache, getProject, hasBoard } from "./project-store";

const profileOf = (summary: unknown): Profile | undefined => {
  const p = (summary as { profile?: Profile } | null)?.profile;
  return p && Array.isArray(p.spans) ? p : undefined;
};

export interface SavedBoardInspection {
  /** when the board was compiled and saved */
  compiledAt: string;
  /** the sources changed after that compile: positions may be out of date */
  stale: boolean;
  /** the checks engine is newer than the verification in cache */
  checksStale: boolean;
  nota?: string;
  /**
   * Where the saved compile spent its time, and which patched libraries it
   * loaded (summary.profile): the only way to read them from outside after a
   * compile too long for its own HTTP answer.
   */
  profile?: Profile;
  /**
   * The saved board is the one without schematic, saved early: a big board's
   * compile answers then and draws the schematic in the background.
   */
  schematicPending?: string;
  /** a compile of this project still running, or cut off, from the project's log */
  compileRun: CompileRun | null;
  issues: InspectIssue[];
  components: InspectComponent[];
}

/**
 * The snapshot of the board that inspect_board gives: the SAVED compile, never
 * a new one.
 *
 * It used to recompile the whole project on every call. On fototrappola-frontale
 * (219 parts) that is minutes of server, longer than the HTTP answer of the MCP
 * client: the tool timed out and gave nothing. A snapshot is a read: whoever
 * wants a fresh board calls compile (or presses Ricompila) and then inspects.
 * Without a saved board it says so at once, instead of starting a compile.
 */
export async function inspectSavedBoard(
  projectId: string,
): Promise<{ ok: true; result: SavedBoardInspection } | { ok: false; error: string }> {
  const cache = await getCompileCache(projectId).catch(() => null);
  if (!cache || !hasBoard(cache.circuitJson)) {
    return {
      ok: false,
      error:
        "nessuna scheda compilata salvata per questo progetto: chiama compile (o premi Ricompila nella pagina) e poi inspect_board",
    };
  }
  const files = await getProject(projectId);
  let stale = false;
  try {
    stale = cache.filesHash !== filesHash(await withLibrary(files));
  } catch {
    // if the comparison fails, better not to cry wolf: the board is still the saved one
  }
  const checksStale = cache.engineVersion < CHECKS_ENGINE_VERSION;
  const pending = (cache.summary as { schematicPending?: unknown } | null)?.schematicPending;
  const compileRun = await readCompileRun(projectId).catch(() => null);
  const createdAt = cache.createdAt as unknown;
  return {
    ok: true,
    result: {
      compiledAt: createdAt instanceof Date ? createdAt.toISOString() : String(createdAt),
      stale,
      checksStale,
      ...(stale
        ? { nota: "i sorgenti sono cambiati dopo questa compilazione: chiama compile per vedere la scheda di questi file" }
        : {}),
      ...(profileOf(cache.summary) ? { profile: profileOf(cache.summary) } : {}),
      ...(typeof pending === "string" ? { schematicPending: pending } : {}),
      compileRun,
      issues: extractIssues(cache.circuitJson).slice(0, 60),
      components: extractComponents(cache.circuitJson, files),
    },
  };
}
