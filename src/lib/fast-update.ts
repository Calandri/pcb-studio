import { baseHolds, boardBaseOf } from "./board-base";
import { boardFreshness, MANUAL_EDITS_PATH, parseManualEdits, withoutManualEdits } from "./manual-edits";
import { filesHash, type FsMap, type SavedBoardBase } from "./project-store";
import { rerouteLocal, type RerouteLocalResult } from "./reroute-local";
import type { CircuitElement } from "./route-score";
import { vieSemprePassanti } from "./via-layers";

/**
 * What the fast update does with the saved board, decided without touching the
 * database: the route (api/reroute-local) reads, asks here, and writes.
 *
 *  - "compile": the board is not the one of these sources, a part was let go,
 *    or a move cannot be done on a saved board (a part turned to the other
 *    face, a turn that is not a quarter). Only "Aggiorna" brings the board;
 *  - "unchanged": the board is exactly the one of these files and already
 *    shows every hand position. Nothing to write;
 *  - "save": the board to file under the hash of the current files. `board` is
 *    the saved one itself when the hand positions were all on it already and
 *    only its label was behind.
 */
export type FastUpdatePlan =
  | { kind: "compile"; reason: string; result?: Omit<RerouteLocalResult, "summary"> }
  | { kind: "unchanged"; result: Omit<RerouteLocalResult, "summary"> }
  | {
      kind: "save";
      board: CircuitElement[];
      hash: string;
      base: SavedBoardBase;
      /** the saved board went through as it was */
      unchanged: boolean;
      result: Omit<RerouteLocalResult, "summary">;
    };

export function planFastUpdate(
  cached: { filesHash: string; base?: SavedBoardBase | null; circuitJson: unknown[] },
  /** the project's own files */
  fsMap: FsMap,
  /** the same with the library mounted, as the compile sees them */
  full: FsMap,
): FastUpdatePlan {
  const hashNow = filesHash(full);
  const baseNow = boardBaseOf(full);
  const exact = cached.filesHash === hashNow;
  // the board itself says what it was made from; the chain in the file vouches for the older ones
  const held = baseHolds(cached.base, baseNow);
  const fresh =
    exact ||
    held.ok ||
    Boolean(
      !cached.base &&
        boardFreshness({
          cacheFilesHash: cached.filesHash,
          filesHash: hashNow,
          sourcesHash: filesHash(withoutManualEdits(full)),
          edits: parseManualEdits(fsMap[MANUAL_EDITS_PATH]),
        }),
    );
  if (!fresh) {
    const released = !held.ok && held.why === "liberati" ? held.released : [];
    return {
      kind: "compile",
      reason:
        released.length > 0
          ? `${released.slice(0, 6).join(", ")}${released.length > 6 ? "..." : ""} ${
              released.length === 1 ? "e' stato liberato" : "sono stati liberati"
            }: tornano dove li mette il codice solo con Aggiorna`
          : "il codice o lo schematico sono cambiati dopo l'ultima compilazione: la scheda di questi file arriva solo con Aggiorna",
    };
  }

  const redone = rerouteLocal(cached.circuitJson, fsMap, fsMap[MANUAL_EDITS_PATH]);
  /*
   * Nothing to move and nothing to lay: the board already shows every hand
   * position. It IS the board of these files (see board-base.ts), so this is a
   * success, not a refusal. It used to answer ok:false "niente da applicare in
   * locale", and the page told the person to press "Aggiorna" for a part
   * dropped where it already was, or for the second of two quick updates. A
   * hand position naming a part that is not on the board is skipped and
   * reported (orphans), as always.
   */
  const giaGiusta = !redone.result.ok && redone.result.nothing === true;
  if (giaGiusta) {
    const result = { ...redone.result, ok: true, reason: undefined };
    if (exact) return { kind: "unchanged", result };
    /*
     * A board saved before the base existed is vouched for by the chain in the
     * file, and the chain does not see a part let go (a release through the
     * token, on a board no page has opened since): filing that board as it is
     * would leave the part where it was. It asks for the compile, as it did.
     */
    if (!cached.base) {
      return { kind: "compile", reason: redone.result.reason ?? "niente da applicare in locale", result: redone.result };
    }
    // filed under an older hash: it goes under this one as it is, or the page calls it "older than the files"
    return {
      kind: "save",
      // as it is, but no board is saved with a via written on part of the stack (see vieSemprePassanti)
      board: vieSemprePassanti(cached.circuitJson as CircuitElement[]),
      hash: hashNow,
      base: baseNow,
      unchanged: true,
      result,
    };
  }
  if (!redone.result.ok || !redone.circuitJson) {
    return {
      kind: "compile",
      reason: redone.result.reason ?? "la scheda non si e' potuta aggiornare qui",
      result: redone.result,
    };
  }
  return { kind: "save", board: redone.circuitJson, hash: hashNow, base: baseNow, unchanged: false, result: redone.result };
}
