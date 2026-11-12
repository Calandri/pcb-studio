import { readCompileRun } from "./activity-store";
import { withLibrary } from "./agent-tools";
import type { CompileRun } from "./compile-run";
import { resolveDesignRules } from "./design-rules";
import { CHECKS_ENGINE_VERSION, ENGINE_INGOMBRI } from "./engine-version";
import { extractComponents, extractIssues, type InspectComponent, type InspectIssue } from "./inspect";
import { descriviDistanze, distanzeDelleColate } from "./pours";
import type { Profile } from "./profile";
import type { SerigrafiaInConflitto } from "./silkscreen-clearance";
import { cortileAssorbito, cortiliAssorbiti, type IngombriDeiPezzi } from "./component-clearance";
import { leggiIngombri } from "./ingombro";
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
  /**
   * The clearances the pours of the saved board keep, the project's and the
   * ones a `<copperpour clearance=...>` asks for itself, in words ("0.152mm
   * (regola, 210 colate), 0.25mm (15 colate)"), with what the saved compile
   * found wrong in the declarations. Absent on a board with no pour.
   */
  pourClearances?: { testo: string; avvisi?: string[] };
  /**
   * The silkscreen clashes the saved compile found (summary.silkscreen, see
   * silkscreen-clearance.ts), the nearest first like the issues. A warning: the
   * export goes on. Absent when the silkscreen is clear, and on a board checked
   * by an engine before 10 (checksStale: Ricontrolla measures it).
   */
  silkscreen?: SerigrafiaInConflitto;
  /**
   * The footprints of the parts the saved compile measured (summary.courtyards,
   * see component-clearance.ts): pairs that hit each other in assembly (an
   * error), parts with no real footprint, parts in a connector's mating space,
   * outlines written at board level; the first 60 of each. Absent when there
   * is nothing to say, and on a board checked by an engine before 11.
   */
  courtyards?: IngombriDeiPezzi;
  issues: InspectIssue[];
  components: InspectComponent[];
}

/**
 * The saved board without tscircuit's courtyard errors its compile absorbed
 * (component-clearance.ts): the problems inspect_board lists are the ones the
 * summary counts. Only on a board of an engine that absorbs them and whose
 * check did not stop; the pairs are read again from the board (which parts
 * have a footprint: geometry, milliseconds), and if that fails nothing is left
 * out.
 */
function senzaCortiliAssorbiti(circuitJson: unknown[], engineVersion: number, ingombri: IngombriDeiPezzi | undefined): unknown[] {
  if (engineVersion < ENGINE_INGOMBRI || ingombri?.nonMisurati !== undefined) return circuitJson;
  let assorbiti: string[];
  try {
    assorbiti = cortiliAssorbiti(circuitJson as Array<{ type?: unknown; pcb_component_ids?: unknown }>, leggiIngombri(circuitJson, 0));
  } catch {
    return circuitJson;
  }
  return assorbiti.length === 0 ? circuitJson : circuitJson.filter((el) => !cortileAssorbito(el as { type?: unknown }, assorbiti));
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
  const regole = resolveDesignRules(files).rules;
  const distanze = distanzeDelleColate(cache.circuitJson as unknown[], regole.pourClearanceMm ?? regole.minClearanceMm);
  const avvisi = (cache.summary as { pourClearances?: { avvisi?: unknown } } | null)?.pourClearances?.avvisi;
  const serigrafia = (cache.summary as { silkscreen?: SerigrafiaInConflitto } | null)?.silkscreen;
  const ingombri = (cache.summary as { courtyards?: IngombriDeiPezzi } | null)?.courtyards;
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
      ...(distanze.length
        ? {
            pourClearances: {
              testo: descriviDistanze(distanze),
              ...(Array.isArray(avvisi) && avvisi.length ? { avvisi: avvisi.map(String) } : {}),
            },
          }
        : {}),
      ...(serigrafia && typeof serigrafia.count === "number"
        ? { silkscreen: { ...serigrafia, conflitti: (serigrafia.conflitti ?? []).slice(0, 60) } }
        : {}),
      ...(ingombri && typeof ingombri.count === "number"
        ? {
            courtyards: {
              ...ingombri,
              scontri: (ingombri.scontri ?? []).slice(0, 60),
              senzaIngombroVero: { ...ingombri.senzaIngombroVero, pezzi: (ingombri.senzaIngombroVero?.pezzi ?? []).slice(0, 60) },
              disegniDiScheda: { ...ingombri.disegniDiScheda, pezzi: (ingombri.disegniDiScheda?.pezzi ?? []).slice(0, 60) },
              ...(ingombri.nelloSpazioDiInnesto
                ? { nelloSpazioDiInnesto: { ...ingombri.nelloSpazioDiInnesto, pezzi: ingombri.nelloSpazioDiInnesto.pezzi.slice(0, 60) } }
                : {}),
            },
          }
        : {}),
      issues: extractIssues(senzaCortiliAssorbiti(cache.circuitJson as unknown[], cache.engineVersion, ingombri)).slice(0, 60),
      components: extractComponents(cache.circuitJson, files),
    },
  };
}
