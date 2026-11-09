import { schematicMissing } from "./board-report";
import { graftSchematic, schematicKeyOf, summarizeCircuit, type CompileSummary } from "./compile";
import { CHECKS_ENGINE_VERSION } from "./engine-version";
import {
  filesHash,
  getCompileCache,
  getCompileMeta,
  hasBoard,
  saveCompileCache,
  type CompileCache,
  type FsMap,
  type SaveCompileResult,
} from "./project-store";

/**
 * Is this compile still the newest thing to save? It was started on files
 * that may have changed since: a part dragged in Sposta (saved in a second,
 * the board following on the fast path), the agent writing a file. A compile
 * of the OLD files saved at its end put the old board back over the new one:
 * the parts just moved jumped back, the page said "older than the files", and
 * of two overlapping compiles the first one, finishing last, won
 * (sbb-dl-principale, 2026-11-09: started 22:45:58, saved 22:49:39 over the
 * one started 22:47:23).
 *
 *  - same files as at the start: save, as always;
 *  - nothing saved, or our own early board: save (over exactly that row);
 *  - the saved board is already the one of the CURRENT files: not over it
 *    (the caller may still put its schematic on it, see saveFinishedCompile);
 *  - a board saved after this compile started, of other files: not over it;
 *  - a board older than this compile: ours is newer, save over that row.
 */
type Verdict =
  | { kind: "save"; ifUnchangedSince?: { filesHash: string; createdAt: unknown } }
  | { kind: "current"; files: FsMap; currentHash: string; meta: { filesHash: string; createdAt: unknown } }
  | { kind: "newer" };

const stampMs = (v: unknown): number => (v instanceof Date ? v.getTime() : Date.parse(String(v)));

async function verdict(
  projectId: string,
  hash: string,
  startedAt: number,
  filesNow: () => Promise<FsMap>,
): Promise<Verdict> {
  const files = await filesNow();
  const currentHash = filesHash(files);
  if (currentHash === hash) return { kind: "save" };
  const meta = await getCompileMeta(projectId);
  if (!meta) return { kind: "save" };
  const since = { filesHash: meta.filesHash, createdAt: meta.createdAt };
  if (meta.filesHash === hash) return { kind: "save", ifUnchangedSince: since };
  if (meta.filesHash === currentHash) return { kind: "current", files, currentHash, meta: since };
  if (stampMs(meta.createdAt) < startedAt) return { kind: "save", ifUnchangedSince: since };
  return { kind: "newer" };
}

const NEWER = "nel frattempo e' stata salvata una scheda piu' recente: non la sovrascrivo";
const CURRENT =
  "i file sono cambiati durante la compilazione e la scheda salvata e' gia' quella nuova: non la sovrascrivo";

/**
 * Saves the board without its schematic, as soon as the compile has it (see
 * CompileOptions.onBoard): the same for the page's Ricompila and for the MCP
 * compile, so a big board is on the server within seconds whoever compiles it.
 *
 * Not when the saved row is already the COMPLETE board of these same files:
 * replacing it with one without schematic would only lose the drawing for the
 * length of the compile, and lose it for good if the compile is cut off. Nor
 * when it is no longer the newest board (see verdict).
 */
export function earlyBoardSaver(
  projectId: string,
  hash: string,
  previous: CompileCache | null,
  fresh?: { startedAt: number; filesNow: () => Promise<FsMap> },
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
    try {
      const v = fresh ? await verdict(projectId, hash, fresh.startedAt, fresh.filesNow) : ({ kind: "save" } as Verdict);
      if (v.kind !== "save") return { saved: false, keptPrevious: true, reason: v.kind === "newer" ? NEWER : CURRENT };
      return await saveCompileCache(projectId, hash, early.circuitJson, early.summary, CHECKS_ENGINE_VERSION, {
        ...(v.ifUnchangedSince ? { ifUnchangedSince: v.ifUnchangedSince } : {}),
      });
    } catch {
      return { saved: false, reason: "salvataggio anticipato fallito" };
    }
  };
}

/**
 * Saves a finished compile, if it is still the newest board (see verdict).
 *
 * When the files changed only in the PCB positions while the schematic was
 * being drawn (the person kept moving parts after the board unlocked), the
 * board saved now is the right one and this compile's is not, but this
 * compile's SCHEMATIC is: it is put on the saved board, so the moves stay and
 * the schematic arrives anyway.
 */
export async function saveFinishedCompile(
  projectId: string,
  hash: string,
  circuitJson: unknown[],
  summary: CompileSummary,
  fresh: { startedAt: number; filesNow: () => Promise<FsMap> },
): Promise<SaveCompileResult & { grafted?: boolean; superseded?: boolean }> {
  const v = await verdict(projectId, hash, fresh.startedAt, fresh.filesNow);
  if (v.kind === "save") {
    return saveCompileCache(projectId, hash, circuitJson, summary, CHECKS_ENGINE_VERSION, {
      ...(v.ifUnchangedSince ? { ifUnchangedSince: v.ifUnchangedSince } : {}),
    });
  }
  // not an error: the board on screen is newer than this compile, and right
  if (v.kind === "newer") return { saved: false, keptPrevious: true, superseded: true, reason: NEWER };

  const ours = summary.schematicKey;
  if (!ours || schematicKeyOf(v.files) !== ours) return { saved: false, keptPrevious: true, superseded: true, reason: CURRENT };
  const row = await getCompileCache(projectId).catch(() => null);
  if (!row || row.filesHash !== v.currentHash) return { saved: false, keptPrevious: true, superseded: true, reason: CURRENT };
  const grafted = graftSchematic(row.circuitJson as Parameters<typeof graftSchematic>[0], circuitJson);
  if (!grafted) return { saved: false, keptPrevious: true, superseded: true, reason: CURRENT };
  const nuovo = summarizeCircuit(grafted, v.files);
  nuovo.schematicKey = ours;
  nuovo.profile = summary.profile;
  nuovo.message = `${nuovo.message} (schematico messo sulla scheda con gli spostamenti fatti nel frattempo)`;
  const r = await saveCompileCache(projectId, v.currentHash, grafted, nuovo, CHECKS_ENGINE_VERSION, {
    ifUnchangedSince: { filesHash: row.filesHash, createdAt: row.createdAt },
  });
  return r.saved ? { ...r, grafted: true } : r;
}
