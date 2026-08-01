import { requireProjectAccess } from "@/lib/acl";
import { summarizeCircuit } from "@/lib/compile";
import { CHECKS_ENGINE_VERSION } from "@/lib/engine-version";
import { MANUAL_EDITS_PATH, serializeManualEdits } from "@/lib/manual-edits";
import {
  getCompileCache,
  getProject,
  saveCompileCache,
  writeProjectFile,
} from "@/lib/project-store";
import { deleteTrace } from "@/lib/trace-edit";

export const runtime = "nodejs";
export const maxDuration = 60;

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
  const pcbTraceId = typeof body.pcbTraceId === "string" ? body.pcbTraceId : "";
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
  const result = deleteTrace(cached.circuitJson, pcbTraceId, fsMap[MANUAL_EDITS_PATH]);
  if (!result) {
    return Response.json({ error: "pista non trovata nella scheda compilata" }, { status: 404 });
  }

  if (result.editsChanged) {
    await writeProjectFile(projectId, MANUAL_EDITS_PATH, serializeManualEdits(result.edits));
  }
  const summary = summarizeCircuit(result.circuitJson as unknown[], fsMap);
  await saveCompileCache(
    projectId,
    cached.filesHash,
    result.circuitJson,
    summary,
    CHECKS_ENGINE_VERSION,
  );

  const unrouted = Array.isArray((summary as { unroutedConnections?: unknown[] }).unroutedConnections)
    ? ((summary as { unroutedConnections?: unknown[] }).unroutedConnections as unknown[]).length
    : null;

  return Response.json({ ok: true, connection: result.connection, unrouted, summary });
}
