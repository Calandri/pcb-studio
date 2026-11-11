import { currentViewer, projectAccess } from "@/lib/acl";
import { resolveApiToken } from "@/lib/api-tokens";
import { readCompileRun } from "@/lib/activity-store";
import { CHECKS_ENGINE_VERSION } from "@/lib/engine-version";
import {
  getChatMessages,
  getCompileCache,
  getCompileMeta,
  getPreviewAt,
  getPreviewCircuit,
  getProject,
} from "@/lib/project-store";
import { withLibrary } from "@/lib/agent-tools";
import { boardStanding } from "@/lib/manual-edits-store";
import { listLibraryComponents } from "@/lib/library-store";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const projectId = url.searchParams.get("projectId") ?? "default";
  /*
   * The browser sends a session, a script or an agent its personal token
   * (pcbs_...): the same access rule for both, as in accessoDaRichiesta. With
   * the token refused here, whoever drew a board through the MCP could write
   * and compile it but not read the compiled copper back to check it
   * (sbb-dl-principale, 2026-11-11: "verified on the summary only").
   */
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const viewer = bearer ? await resolveApiToken(bearer) : await currentViewer();
  const level = await projectAccess(projectId, viewer);
  if (level === "none") return Response.json({ error: "forbidden" }, { status: 403 });
  /*
   * `editsOnly` is an invitation to bring the board up to date (the fast
   * update, which writes): only for who may edit. A viewer keeps the plain
   * "older than the files", as before.
   */
  const canEdit = level === "edit";

  /*
   * ?meta=1: solo i metadati della compilazione, senza circuitJson ne' summary.
   * E' la risposta per il controllo periodico della pagina: sapere SE il
   * compilato e' cambiato costa una riga, scaricarlo ogni cinque secondi
   * costava qualche megabyte a botta. Il filesHash si ricalcola comunque per
   * poter dire `stale`: e' il confronto ad avere senso, non la serializzazione.
   */
  if (url.searchParams.get("meta") === "1") {
    const [cache, previewAt, running] = await Promise.all([
      // the metadata only: the board is megabytes, and this runs every five seconds per open tab
      getCompileMeta(projectId),
      getPreviewAt(projectId),
      // a compile running (or cut off) anywhere: the page says so, see readCompileRun
      readCompileRun(projectId),
    ]);
    if (!cache) return Response.json({ projectId, compile: null, previewAt, running });
    let stale = false;
    /*
     * `editsOnly`: the board differs from the files only in hand positions the
     * fast update can apply. Not a reason to block anything or to ask for a
     * compile: the page brings the board up to date by itself.
     */
    let editsOnly = false;
    try {
      const standing = await boardStanding(projectId, cache, await withLibrary(await getProject(projectId)));
      stale = standing !== "exact";
      editsOnly = standing === "edits" && canEdit;
    } catch {
      // se non si riesce a confrontare, meglio non gridare al lupo
    }
    return Response.json({
      projectId,
      compile: {
        stale,
        editsOnly,
        filesHash: cache.filesHash,
        createdAt: cache.createdAt,
        engineVersion: cache.engineVersion,
        currentEngineVersion: CHECKS_ENGINE_VERSION,
        checksStale: cache.engineVersion < CHECKS_ENGINE_VERSION,
      },
      // a compile is running somewhere (agent, MCP, another tab) and has
      // drawn something newer than the saved board
      previewAt,
      running,
    });
  }

  /*
   * ?preview=1: the drawing of the compile still running. Previews used to
   * overwrite the saved board itself; now they live apart (exports never see
   * them) and the page fetches them only when the poll says one is newer.
   */
  if (url.searchParams.get("preview") === "1") {
    return Response.json({ projectId, preview: await getPreviewCircuit(projectId) });
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
    // only hand positions differ: the page updates the board by itself (see ?meta=1)
    let editsOnly = false;
    if (cache) {
      try {
        const standing = await boardStanding(projectId, cache, await withLibrary(await getProject(projectId)));
        stale = standing !== "exact";
        editsOnly = standing === "edits" && canEdit;
      } catch {
        // se non si riesce a confrontare, meglio non gridare al lupo
      }
    }
    return Response.json({
      projectId,
      compile: cache
        ? {
            stale,
            editsOnly,
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
