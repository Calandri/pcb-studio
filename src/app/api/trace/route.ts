import { requireProjectAccess } from "@/lib/acl";
import { withLibrary } from "@/lib/agent-tools";
import { summarizeCircuit } from "@/lib/compile";
import { CHECKS_ENGINE_VERSION } from "@/lib/engine-version";
import {
  boardFreshness,
  MANUAL_EDITS_PATH,
  nextBoardBase,
  parseManualEdits,
  serializeManualEdits,
  withoutManualEdits,
} from "@/lib/manual-edits";
import {
  filesHash,
  getCompileCache,
  getProject,
  saveCompileCache,
  updateProjectFile,
} from "@/lib/project-store";
import { deleteTrace } from "@/lib/trace-edit";

export const runtime = "nodejs";
export const maxDuration = 60;

/** createdAt may come back as a Date or as a string, depending on the driver */
const stamp = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

/**
 * Detaches an existing trace: you select it in Route mode and remove it.
 * The connection is left unrouted — you redraw it by hand right away, or the
 * next full compilation redoes it on its own. No recompilation here: removing
 * copper is a millisecond-scale operation.
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
  if (!pcbTraceId || body.action !== "delete") {
    return Response.json({ error: "serve action=delete e pcbTraceId" }, { status: 400 });
  }

  const { ok } = await requireProjectAccess(projectId, "edit");
  if (!ok) return Response.json({ error: "forbidden" }, { status: 403 });

  const cached = await getCompileCache(projectId).catch(() => null);
  if (!cached?.circuitJson) {
    return Response.json({ error: "nessuna scheda compilata" }, { status: 404 });
  }

  const fsMap = await getProject(projectId);
  const full = await withLibrary(fsMap);
  const sources = withoutManualEdits(full);
  const sourcesHash = filesHash(sources);
  const fresh = boardFreshness({
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

  const result = deleteTrace(cached.circuitJson, pcbTraceId, fsMap[MANUAL_EDITS_PATH]);
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
  if (result.editsChanged) {
    let written: string | null = null;
    try {
      const r = await updateProjectFile(projectId, MANUAL_EDITS_PATH, (current) => {
        const redone = deleteTrace(cached.circuitJson, pcbTraceId, current);
        if (!redone?.editsChanged) return null;
        const before = parseManualEdits(current);
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

  const summary = summarizeCircuit(result.circuitJson as unknown[], fsMap);
  const latest = await getCompileCache(projectId).catch(() => null);
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
  await saveCompileCache(projectId, hash, result.circuitJson, summary, CHECKS_ENGINE_VERSION);

  const unrouted = Array.isArray((summary as { unroutedConnections?: unknown[] }).unroutedConnections)
    ? ((summary as { unroutedConnections?: unknown[] }).unroutedConnections as unknown[]).length
    : null;

  return Response.json({ ok: true, connection: result.connection, unrouted, summary });
}
