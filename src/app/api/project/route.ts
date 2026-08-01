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

  /*
   * ?meta=1: solo i metadati della compilazione, senza circuitJson ne' summary.
   * E' la risposta per il controllo periodico della pagina: sapere SE il
   * compilato e' cambiato costa una riga, scaricarlo ogni cinque secondi
   * costava qualche megabyte a botta. Il filesHash si ricalcola comunque per
   * poter dire `stale`: e' il confronto ad avere senso, non la serializzazione.
   */
  if (url.searchParams.get("meta") === "1") {
    const cache = await getCompileCache(projectId).catch(() => null);
    if (!cache) return Response.json({ projectId, compile: null });
    let stale = false;
    try {
      stale = cache.filesHash !== filesHash(await withLibrary(await getProject(projectId)));
    } catch {
      // se non si riesce a confrontare, meglio non gridare al lupo
    }
    return Response.json({
      projectId,
      compile: {
        stale,
        filesHash: cache.filesHash,
        createdAt: cache.createdAt,
        engineVersion: cache.engineVersion,
        currentEngineVersion: CHECKS_ENGINE_VERSION,
        checksStale: cache.engineVersion < CHECKS_ENGINE_VERSION,
      },
    });
  }

  // ?circuit=1: also return the server-validated routed Circuit JSON so the
  // FE can render the exact routing the agent checked (no browser re-route)
  if (url.searchParams.get("circuit") === "1") {
    const cache = await getCompileCache(projectId).catch(() => null);
    /*
     * "Vecchia" vuol dire: i file sono cambiati dopo l'ultima compilazione,
     * quindi la scheda che si vede non e' quella che si sta scrivendo. Senza
     * questo l'interfaccia mostrava serenamente un disegno superato e chi
     * guardava pensava che la modifica non fosse stata presa.
     */
    let stale = false;
    if (cache) {
      try {
        stale = cache.filesHash !== filesHash(await withLibrary(await getProject(projectId)));
      } catch {
        // se non si riesce a confrontare, meglio non gridare al lupo
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
