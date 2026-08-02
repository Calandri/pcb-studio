import { requireProjectAccess } from "@/lib/acl";
import { summarizeCircuit } from "@/lib/compile";
import { CHECKS_ENGINE_VERSION } from "@/lib/engine-version";
import { withLibrary } from "@/lib/agent-tools";
import { getCompileCache, getProject, saveCompileCache } from "@/lib/project-store";

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
    /*
     * WITH THE SOURCES. summarizeCircuit reads the footprint of each component
     * from the project code — the string never reaches the Circuit JSON — so
     * calling it without them wiped the footprint provenance of every component
     * at each recheck: 98 records became zero, and the board looked like nobody
     * knew where its footprints came from.
     */
    const summary = summarizeCircuit(
      cache.circuitJson,
      await withLibrary(await getProject(projectId)),
    );
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
