import { withLibrary } from "./agent-tools";
import { baseHolds, boardBaseOf } from "./board-base";
import {
  boardFreshness,
  MANUAL_EDITS_PATH,
  nextBoardBase,
  parseManualEdits,
  releaseManualEdits,
  sameManualEdits,
  serializeManualEdits,
  withoutManualEdits,
  type ManualEdits,
} from "./manual-edits";
import {
  filesHash,
  getProject,
  stampCompileBase,
  updateProjectFile,
  type CompileCache,
  type FsMap,
  type SavedBoardBase,
} from "./project-store";

/**
 * Applies `transform` to the current manual-edits.json and writes it,
 * conflict-safe. `transform` may run more than once and must not have side
 * effects; it returns null when there is nothing to change. The board_base is
 * recomputed here, never taken from the caller.
 *
 * Every write of the file goes through updateProjectFile: the write lands only
 * on the version that was read, and on a conflict the change is recomputed on
 * the fresh file. Two quick saves used to read the same file and the second
 * erased the first.
 */
export async function commitManualEdits(
  projectId: string,
  // only WHICH board is saved matters here, not the board: see getCompileMeta
  cache: Pick<CompileCache, "filesHash"> | null,
  transform: (current: ManualEdits) => ManualEdits | null,
): Promise<{ edits: ManualEdits; written: boolean }> {
  const files = await getProject(projectId);
  const sources = withoutManualEdits(await withLibrary(files));
  const sourcesHash = filesHash(sources);
  const { written, content } = await updateProjectFile(projectId, MANUAL_EDITS_PATH, (current) => {
    const before = parseManualEdits(current);
    const next = transform(before);
    if (!next) return null;
    if (current !== null && sameManualEdits(before, next)) return null;
    const filesHashBefore = filesHash(
      current === null ? sources : { ...sources, [MANUAL_EDITS_PATH]: current },
    );
    const base = nextBoardBase({
      cacheFilesHash: cache?.filesHash,
      filesHashBefore,
      sourcesHash,
      previous: before.board_base,
    });
    const rest: ManualEdits = { ...next };
    delete rest.board_base;
    return serializeManualEdits({ ...rest, ...(base ? { board_base: base } : {}) });
  });
  return { edits: parseManualEdits(content), written };
}

/** what one release may name: the editor's own limit */
export const MAX_NOMI_RILASCIO = 400;

/**
 * Lets go of the hand-held positions of exactly these parts, on the given scope:
 * every other manual edit stays as it is. The names are required: releasing
 * everything is a different, deliberate gesture of the editor.
 */
export async function rilasciaPezzi(
  projectId: string,
  cache: CompileCache | null,
  names: string[],
  scope: "schematic" | "pcb" | "traces" | "all",
): Promise<{ edits: ManualEdits; written: boolean }> {
  const soli = names.filter((n) => typeof n === "string" && n.length > 0 && n.length <= 120).slice(0, MAX_NOMI_RILASCIO);
  if (soli.length === 0) throw new Error("servono i nomi dei pezzi da liberare");
  return commitManualEdits(projectId, cache, (current) => {
    let next = current;
    for (const n of soli) next = releaseManualEdits(next, scope, n);
    return next;
  });
}

/**
 * How the saved board stands against the files, in the three words the page
 * and the fast update need (see board-base.ts):
 *  - "exact": it is the board of exactly these files;
 *  - "edits": it is the board of these files once the hand positions are
 *    applied to it, which the fast update does in a moment and by itself;
 *  - "stale": something else changed, and only a compile brings the new board.
 *
 * A board saved before the base existed gets its base here, when it is exactly
 * the board of these files: from then on a hand move finds it.
 */
export async function boardStanding(
  projectId: string,
  saved: { filesHash: string; base?: SavedBoardBase | null },
  /** the current files, library included */
  full: FsMap,
): Promise<"exact" | "edits" | "stale"> {
  if (saved.filesHash === filesHash(full)) {
    if (!saved.base) await stampCompileBase(projectId, saved.filesHash, boardBaseOf(full));
    return "exact";
  }
  if (saved.base) return baseHolds(saved.base, boardBaseOf(full)).ok ? "edits" : "stale";
  // a board saved before the base existed: the chain in manual-edits.json vouches for it, as it did
  const legacy = boardFreshness({
    cacheFilesHash: saved.filesHash,
    filesHash: filesHash(full),
    sourcesHash: filesHash(withoutManualEdits(full)),
    edits: parseManualEdits(full[MANUAL_EDITS_PATH]),
  });
  return legacy ? "edits" : "stale";
}
