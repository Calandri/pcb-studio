import { requireProjectAccess } from "@/lib/acl";
import { CHECKS_ENGINE_VERSION } from "@/lib/engine-version";
import { getChatMessages, getCompileCache, getProject } from "@/lib/project-store";
import { listLibraryComponents } from "@/lib/library-store";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const projectId = url.searchParams.get("projectId") ?? "default";
  const { ok } = await requireProjectAccess(projectId, "view");
  if (!ok) return Response.json({ error: "forbidden" }, { status: 403 });

  // ?circuit=1: also return the server-validated routed Circuit JSON so the
  // FE can render the exact routing the agent checked (no browser re-route)
  if (url.searchParams.get("circuit") === "1") {
    const cache = await getCompileCache(projectId).catch(() => null);
    return Response.json({
      projectId,
      compile: cache
        ? {
            filesHash: cache.filesHash,
            circuitJson: cache.circuitJson,
            summary: cache.summary,
            createdAt: cache.createdAt,
            engineVersion: cache.engineVersion,
            currentEngineVersion: CHECKS_ENGINE_VERSION,
            // i controlli sono piu' nuovi della verifica: la scheda va ricontrollata
            checksStale: cache.engineVersion < CHECKS_ENGINE_VERSION,
          }
        : null,
    });
  }

  const [fsMap, messages, library] = await Promise.all([
    getProject(projectId),
    getChatMessages(projectId),
    listLibraryComponents().catch(() => []),
  ]);
  return Response.json({ projectId, fsMap, messages, library });
}
