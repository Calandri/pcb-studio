import { requireProjectAccess } from "@/lib/acl";
import { CHECKS_ENGINE_VERSION } from "@/lib/engine-version";
import {
  filesHash,
  getChatMessages,
  getCompileCache,
  getProject,
} from "@/lib/project-store";
import { withLibrary } from "@/lib/agent-tools";
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
    /*
     * "Stale" means: the files changed after the last compilation, so the
     * board you see is not the one you are writing. Without this, the UI
     * happily showed an outdated drawing and the viewer thought the change
     * had not been picked up.
     */
    let stale = false;
    if (cache) {
      try {
        stale = cache.filesHash !== filesHash(await withLibrary(await getProject(projectId)));
      } catch {
        // if we cannot compare, better not to cry wolf
      }
    }
    return Response.json({
      projectId,
      compile: cache
        ? {
            stale,
            filesHash: cache.filesHash,
            circuitJson: cache.circuitJson,
            summary: cache.summary,
            createdAt: cache.createdAt,
            engineVersion: cache.engineVersion,
            currentEngineVersion: CHECKS_ENGINE_VERSION,
            // the checks are newer than the verification: the board must be re-checked
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
