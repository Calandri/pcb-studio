import { requireProjectAccess } from "@/lib/acl";
import { summarizeCircuit } from "@/lib/compile";
import { CHECKS_ENGINE_VERSION } from "@/lib/engine-version";
import { getCompileCache, saveCompileCache } from "@/lib/project-store";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Recheck WITHOUT re-routing: re-evaluates the cached compiled circuit with
 * the CURRENT checks (DRC, PRC, fabClass, schematic quality) and updates the
 * summary + engine version in cache. The traces are not touched: if the
 * checks changed since the board was routed, the response says where the
 * problem stands today, without moving any copper.
 */
export async function POST(req: Request): Promise<Response> {
  let projectId = "default";
  try {
    const body = (await req.json()) as { projectId?: unknown };
    if (typeof body.projectId === "string" && body.projectId.length <= 120) {
      projectId = body.projectId;
    }
  } catch {
    // no body: default project
  }

  const { ok } = await requireProjectAccess(projectId, "edit");
  if (!ok) return Response.json({ error: "forbidden" }, { status: 403 });

  const cache = await getCompileCache(projectId);
  if (!cache) {
    return Response.json(
      { error: "nessuna compilazione in cache: compila prima il progetto" },
      { status: 404 },
    );
  }

  try {
    const summary = summarizeCircuit(cache.circuitJson);
    await saveCompileCache(
      projectId,
      cache.filesHash,
      cache.circuitJson,
      summary,
      CHECKS_ENGINE_VERSION,
    ).catch(() => {});
    return Response.json({
      ok: true,
      engineVersion: CHECKS_ENGINE_VERSION,
      previousEngineVersion: cache.engineVersion,
      summary,
    });
  } catch (err) {
    return Response.json(
      { error: `recheck failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }
}
