import { requireProjectAccess } from "@/lib/acl";
import { getProjectModel, listProjectModels } from "@/lib/model-store";

export const runtime = "nodejs";

/**
 * A component's 3D mesh, as OBJ.
 *
 * The project's `main.tsx` points here (`cadModel={{ objUrl: ... }}`), and it is
 * the GLB builder that fetches it, on the server, while it assembles the board.
 * So the URL has to be reachable and it has to be checked: a mesh belongs to a
 * project, and whoever cannot see the project cannot see its parts either.
 *
 * Without a name it answers with the list, which is how you find out whether an
 * import produced any models at all.
 */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const projectId = url.searchParams.get("projectId") ?? "default";
  const name = url.searchParams.get("name");

  const { ok } = await requireProjectAccess(projectId, "view");
  if (!ok) return Response.json({ error: "forbidden" }, { status: 403 });

  if (!name) {
    return Response.json({ models: await listProjectModels(projectId) });
  }
  const modello = await getProjectModel(projectId, name);
  if (!modello) return Response.json({ error: "modello non trovato" }, { status: 404 });

  return new Response(modello.obj, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      /*
       * A minute, not a year: re-importing the same board writes the same names
       * with new content (that is the point of re-importing), and the GLB is
       * cached by file hash upstream anyway, so this fetch is rare.
       */
      "cache-control": "private, max-age=60",
    },
  });
}
