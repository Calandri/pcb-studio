import { requireProjectAccess } from "@/lib/acl";
import { summarizeCircuit } from "@/lib/compile";
import { CHECKS_ENGINE_VERSION } from "@/lib/engine-version";
import { getCompileCache, saveCompileCache } from "@/lib/project-store";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Ricontrollo SENZA ri-routing: rivaluta il circuito compilato in cache con i
 * controlli CORRENTI (DRC, PRC, fabClass, schematic quality) e aggiorna il
 * summary + la versione motore in cache. Le piste non si toccano: se i
 * controlli sono cambiati da quando la scheda e' stata routata, la risposta
 * dice dove sta oggi il problema, senza spostare rame.
 */
export async function POST(req: Request): Promise<Response> {
  let projectId = "default";
  try {
    const body = (await req.json()) as { projectId?: unknown };
    if (typeof body.projectId === "string" && body.projectId.length <= 120) {
      projectId = body.projectId;
    }
  } catch {
    // corpo assente: progetto di default
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
