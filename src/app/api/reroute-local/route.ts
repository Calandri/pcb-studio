import { requireProjectAccess } from "@/lib/acl";
import { withLibrary } from "@/lib/agent-tools";
import { summarizeCircuit } from "@/lib/compile";
import { CHECKS_ENGINE_VERSION } from "@/lib/engine-version";
import { MANUAL_EDITS_PATH } from "@/lib/manual-edits";
import {
  filesHash,
  getCompileCache,
  getProject,
  saveCompileCache,
} from "@/lib/project-store";
import { rerouteLocal } from "@/lib/reroute-local";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Applies manual moves WITHOUT recompiling everything: updates the positions
 * in the cached board and redoes only the copper of the touched zone.
 * Seconds instead of minutes. If something cannot be done locally it answers
 * ok:false and the client falls back to a full compile — which stays an
 * explicit user gesture, not an automatism.
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
  const t0 = Date.now();
  try {
    const redone = rerouteLocal(cached.circuitJson, fsMap, fsMap[MANUAL_EDITS_PATH]);
    if (!redone) {
      return Response.json({ ok: false, reason: "spostamento non applicabile in locale" });
    }
    const summary = summarizeCircuit(redone.circuitJson as unknown[], fsMap);
    const hashed = await withLibrary(fsMap);
    await saveCompileCache(
      projectId,
      filesHash(hashed),
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
