import { requireProjectAccess } from "@/lib/acl";
import { withLibrary } from "@/lib/agent-tools";
import { summarizeCircuit } from "@/lib/compile";
import { CHECKS_ENGINE_VERSION } from "@/lib/engine-version";
import {
  boardFreshness,
  MANUAL_EDITS_PATH,
  parseManualEdits,
  withoutManualEdits,
} from "@/lib/manual-edits";
import {
  filesHash,
  getCompileCache,
  getProject,
  saveCompileCache,
} from "@/lib/project-store";
import { rerouteLocal } from "@/lib/reroute-local";

export const runtime = "nodejs";
export const maxDuration = 120;

/** createdAt may come back as a Date or as a string, depending on the driver */
const stamp = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

/**
 * Applies manual moves WITHOUT recompiling everything: updates the positions
 * in the cached board and redoes only the copper of the touched zone.
 * Seconds instead of minutes. If something cannot be done locally it answers
 * ok:false and the client falls back to a full compile — which stays an
 * explicit user gesture, not an automatism.
 *
 * Two guards, because the result is saved as THE board of the current files:
 *   - the cached board must be the one of these sources, with only manual
 *     edits made on it since (see boardFreshness). If the agent rewrote
 *     main.tsx after the last compile, applying the moves to the old board and
 *     filing it under the new hash showed a stale board as current;
 *   - the cache must still be the one that was read when the work is done:
 *     a compile that finished in the meantime is newer, and is not overwritten.
 */
export async function POST(req: Request): Promise<Response> {
  let projectId = "default";
  try {
    const body = (await req.json()) as { projectId?: unknown };
    if (typeof body.projectId === "string" && body.projectId.length <= 120) {
      projectId = body.projectId;
    }
  } catch {
    // missing body: the default project applies
  }

  const { ok } = await requireProjectAccess(projectId, "edit");
  if (!ok) return Response.json({ error: "forbidden" }, { status: 403 });

  const cached = await getCompileCache(projectId).catch(() => null);
  if (!cached?.circuitJson) {
    return Response.json({ ok: false, reason: "nessuna scheda compilata" });
  }

  const fsMap = await getProject(projectId);
  const full = await withLibrary(fsMap);
  const hashNow = filesHash(full);
  const fresh = boardFreshness({
    cacheFilesHash: cached.filesHash,
    filesHash: hashNow,
    sourcesHash: filesHash(withoutManualEdits(full)),
    edits: parseManualEdits(fsMap[MANUAL_EDITS_PATH]),
  });
  if (!fresh) {
    return Response.json({
      ok: false,
      reason:
        "la scheda compilata non e' quella dei file attuali (i sorgenti sono cambiati dopo l'ultima compilazione): ricompila prima di applicare gli spostamenti",
    });
  }

  const t0 = Date.now();
  try {
    const redone = rerouteLocal(cached.circuitJson, fsMap, fsMap[MANUAL_EDITS_PATH]);
    if (!redone.result.ok || !redone.circuitJson) {
      return Response.json({ ...redone.result, ms: Date.now() - t0 });
    }
    const summary = summarizeCircuit(redone.circuitJson as unknown[], fsMap);
    const latest = await getCompileCache(projectId).catch(() => null);
    if (
      !latest ||
      latest.filesHash !== cached.filesHash ||
      stamp(latest.createdAt) !== stamp(cached.createdAt)
    ) {
      return Response.json({
        ...redone.result,
        ok: false,
        reason:
          "la scheda e' stata ricompilata mentre aggiornavo il rame: non salvo sopra quella nuova, riapplica le modifiche",
        ms: Date.now() - t0,
      });
    }
    await saveCompileCache(
      projectId,
      hashNow,
      redone.circuitJson,
      summary,
      CHECKS_ENGINE_VERSION,
    );
    return Response.json({ ...redone.result, ms: Date.now() - t0, summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ ok: false, reason: message.slice(0, 200) });
  }
}
