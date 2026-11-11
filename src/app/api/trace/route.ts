import { baseHolds, boardBaseOf } from "@/lib/board-base";
import { requireProjectAccess } from "@/lib/acl";
import { rispostaLibreriaNonLetta, withLibrary } from "@/lib/agent-tools";
import { riportaLoSchematico, summarizeCircuit } from "@/lib/compile";
import { CHECKS_ENGINE_VERSION } from "@/lib/engine-version";
import {
  boardFreshness,
  MANUAL_EDITS_PATH,
  nextBoardBase,
  parseManualEdits,
  serializeManualEdits,
  withoutManualEdits,
  type ManualEdits,
} from "@/lib/manual-edits";
import { manualRouteKey, parseManualRoutes, type ManualRoute } from "@/lib/manual-routes";
import {
  filesHash,
  getCompileCache,
  getCompileMeta,
  getProject,
  saveCompileCache,
  updateProjectFile,
} from "@/lib/project-store";
import { deleteTrace } from "@/lib/trace-edit";
import { vieSemprePassanti } from "@/lib/via-layers";

export const runtime = "nodejs";
export const maxDuration = 60;

/** createdAt may come back as a Date or as a string, depending on the driver */
const stamp = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

/** what one undo may put back: a trace with its vias, and the hand routes it came from */
const RESTORE_LIMITS = { maxElements: 64, maxBytes: 500_000, maxRoutes: 50, maxPoints: 2000 } as const;

/**
 * Detaches an existing trace: you select it in Route mode and remove it.
 * The connection is left unrouted — you redraw it by hand right away, or the
 * next full compilation redoes it on its own. No recompilation here: removing
 * copper is a millisecond-scale operation.
 *
 * The answer says what went (the copper and the hand routes), and
 * action=restore puts exactly that back: Cmd+Z in Instrada. Without it a
 * detached trace was gone for good (tm-4l-r3, 2026-11-10: 828 routes to 821).
 */
export async function POST(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "corpo non valido" }, { status: 400 });
  }
  const projectId =
    typeof body.projectId === "string" && body.projectId.length <= 120
      ? body.projectId
      : "default";
  const pcbTraceId = typeof body.pcbTraceId === "string" && body.pcbTraceId.length <= 300 ? body.pcbTraceId : "";
  const restoring = body.action === "restore";
  if (!restoring && (!pcbTraceId || body.action !== "delete")) {
    return Response.json({ error: "serve action=delete e pcbTraceId, o action=restore" }, { status: 400 });
  }

  /*
   * What comes back on restore, checked: only copper of a trace (pcb_trace,
   * pcb_via), a bounded amount, and hand routes that pass the editor's own
   * checks. It goes onto the requester's own board, which they may edit.
   */
  let restoreElements: Array<Record<string, unknown>> = [];
  let restoreRoutes: ReturnType<typeof parseManualRoutes> = [];
  if (restoring) {
    const raw = Array.isArray(body.elements) ? body.elements : [];
    if (raw.length > RESTORE_LIMITS.maxElements || JSON.stringify(raw).length > RESTORE_LIMITS.maxBytes) {
      return Response.json({ error: "troppo rame da rimettere in una volta" }, { status: 413 });
    }
    restoreElements = raw.filter(
      (e): e is Record<string, unknown> =>
        typeof e === "object" &&
        e !== null &&
        ((e as { type?: unknown }).type === "pcb_trace" || (e as { type?: unknown }).type === "pcb_via"),
    );
    restoreRoutes = parseManualRoutes(body.routes, RESTORE_LIMITS);
    if (restoreElements.length === 0 && restoreRoutes.length === 0) {
      return Response.json({ error: "niente da rimettere" }, { status: 400 });
    }
  }

  const { ok } = await requireProjectAccess(projectId, "edit");
  if (!ok) return Response.json({ error: "forbidden" }, { status: 403 });

  const cached = await getCompileCache(projectId).catch(() => null);
  if (!cached?.circuitJson) {
    return Response.json({ error: "nessuna scheda compilata" }, { status: 404 });
  }

  const fsMap = await getProject(projectId);
  let full: Record<string, string>;
  try {
    full = await withLibrary(fsMap);
  } catch (err) {
    return rispostaLibreriaNonLetta(err);
  }
  const sources = withoutManualEdits(full);
  const sourcesHash = filesHash(sources);
  // the board itself says what it was made from (board-base.ts); the chain in the file vouches for the older ones
  const baseNow = boardBaseOf(full);
  const fresh: "exact" | "edits" | false =
    cached.filesHash === filesHash(full)
      ? "exact"
      : baseHolds(cached.base, baseNow).ok
        ? "edits"
        : cached.base
          ? false
          : boardFreshness({
              cacheFilesHash: cached.filesHash,
              filesHash: filesHash(full),
              sourcesHash,
              edits: parseManualEdits(fsMap[MANUAL_EDITS_PATH]),
            });
  if (!fresh) {
    return Response.json(
      { error: "la scheda compilata non e' quella dei file attuali: ricompila prima di staccare piste" },
      { status: 409 },
    );
  }

  /** the board and the file after this action, from the board and the file as they are */
  const change = (
    board: unknown[],
    raw: string | null | undefined,
  ): { circuitJson: unknown[]; edits: ManualEdits; editsChanged: boolean; connection: string | null } | null => {
    if (!restoring) {
      const r = deleteTrace(board, pcbTraceId, raw);
      return r ? { circuitJson: r.circuitJson, edits: r.edits, editsChanged: r.editsChanged, connection: r.connection } : null;
    }
    const idOf = (e: Record<string, unknown>) => String(e.type === "pcb_via" ? e.pcb_via_id : e.pcb_trace_id);
    const present = new Set(
      (board as Array<Record<string, unknown>>)
        .filter((e) => e.type === "pcb_trace" || e.type === "pcb_via")
        .map(idOf),
    );
    const back = restoreElements.filter((e) => !present.has(idOf(e)));
    const edits = parseManualEdits(raw);
    const keys = new Set(edits.pcb_routes.map(manualRouteKey));
    const routes = restoreRoutes.filter((r) => !keys.has(manualRouteKey(r)));
    return {
      circuitJson: [...board, ...back],
      edits: routes.length > 0 ? { ...edits, pcb_routes: [...edits.pcb_routes, ...routes] } : edits,
      editsChanged: routes.length > 0,
      connection: null,
    };
  };

  const result = change(cached.circuitJson, fsMap[MANUAL_EDITS_PATH]);
  if (!result) {
    return Response.json({ error: "pista non trovata nella scheda compilata" }, { status: 404 });
  }

  /*
   * The route comes out of the file on the file as it is NOW (conflict-safe),
   * and the board is filed under the hash of the files it now describes: on a
   * board that was current, removing a hand trace from both keeps it current
   * instead of turning the page stale for a millisecond operation.
   */
  let hash = cached.filesHash;
  let removedRoutes: ManualRoute[] = [];
  if (result.editsChanged) {
    let written: string | null = null;
    try {
      const r = await updateProjectFile(projectId, MANUAL_EDITS_PATH, (current) => {
        const redone = change(cached.circuitJson, current);
        if (!redone?.editsChanged) return null;
        const before = parseManualEdits(current);
        const afterKeys = new Set(redone.edits.pcb_routes.map(manualRouteKey));
        removedRoutes = before.pcb_routes.filter((x) => !afterKeys.has(manualRouteKey(x)));
        const base = nextBoardBase({
          cacheFilesHash: cached.filesHash,
          filesHashBefore: filesHash(current === null ? sources : { ...sources, [MANUAL_EDITS_PATH]: current }),
          sourcesHash,
          previous: before.board_base,
        });
        const next = { ...redone.edits };
        delete next.board_base;
        return serializeManualEdits({ ...next, ...(base ? { board_base: base } : {}) });
      });
      written = r.written ? r.content : null;
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 409 });
    }
    if (written !== null && fresh === "exact") {
      hash = filesHash({ ...sources, [MANUAL_EDITS_PATH]: written });
    }
  }

  /*
   * Every via a through hole before the board is checked and saved (see
   * vieSemprePassanti): the saved board may come from an older engine, and
   * what a restore puts back comes from the page.
   */
  const board = vieSemprePassanti(result.circuitJson as Array<Record<string, unknown>>);
  // a trace taken off does not touch the schematic: its key, its measure and its note stay
  const summary = riportaLoSchematico(summarizeCircuit(board, fsMap), cached.summary);
  // which board is saved now: the metadata is enough, the board is megabytes
  const latest = await getCompileMeta(projectId);
  if (
    !latest ||
    latest.filesHash !== cached.filesHash ||
    stamp(latest.createdAt) !== stamp(cached.createdAt)
  ) {
    return Response.json(
      { error: "la scheda e' cambiata mentre staccavo la pista: non salvo sopra quella nuova, riprova" },
      { status: 409 },
    );
  }
  /*
   * A trace taken off (or put back) changes neither the sources nor which parts
   * are held by hand: the base of the board stays the one it had, or the one
   * of these files when the board was exactly theirs.
   */
  // under the engine the board was made with: a detached trace does not re-evaluate it (see reroute-local)
  await saveCompileCache(projectId, hash, board, summary, Math.min(cached.engineVersion, CHECKS_ENGINE_VERSION), {
    base: cached.base ?? (fresh === "exact" ? baseNow : null),
  });

  const unrouted = Array.isArray((summary as { unroutedConnections?: unknown[] }).unroutedConnections)
    ? ((summary as { unroutedConnections?: unknown[] }).unroutedConnections as unknown[]).length
    : null;

  // what went, for Cmd+Z: the copper taken off the board and the routes taken out of the file
  const kept = new Set(result.circuitJson);
  const removedElements = restoring ? [] : (cached.circuitJson as unknown[]).filter((e) => !kept.has(e));
  return Response.json({
    ok: true,
    connection: result.connection,
    unrouted,
    summary,
    ...(restoring ? {} : { removed: { routes: removedRoutes, elements: removedElements } }),
  });
}
