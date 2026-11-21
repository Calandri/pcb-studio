import { z } from "zod";
import { currentViewer, projectAccess } from "@/lib/acl";
import { describeComponent, listDescriptions } from "@/lib/component-descriptions";
import { getAgentKeys } from "@/lib/llm-keys";
import { listUserOrganizations } from "@/lib/org-store";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Component descriptions written by the model (datasheet + connections).
 *
 * GET  ?projectId=...        the descriptions already generated, visible to
 *                            everyone who can see the project.
 * POST {projectId, component} generates (or regenerates) the description of
 *                            a component: it costs a model turn, so
 *                            like the agent it requires edit access and
 *                            is paid for with BYOK keys when present.
 */

const PostSchema = z.object({
  projectId: z.string().regex(/^[\w-]{1,64}$/),
  component: z.string().min(1).max(60),
});

export async function GET(req: Request): Promise<Response> {
  const projectId = new URL(req.url).searchParams.get("projectId") ?? "";
  if (!/^[\w-]{1,64}$/.test(projectId)) {
    return Response.json({ error: "projectId non valido" }, { status: 400 });
  }
  const viewer = await currentViewer();
  if ((await projectAccess(projectId, viewer)) === "none") {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  return Response.json({ descriptions: await listDescriptions(projectId) });
}

export async function POST(req: Request): Promise<Response> {
  const parsed = PostSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "richiesta non valida" }, { status: 400 });
  }
  const { projectId, component } = parsed.data;

  const viewer = await currentViewer();
  if (!viewer) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if ((await projectAccess(projectId, viewer)) !== "edit") {
    return Response.json({ error: "forbidden: serve accesso in modifica" }, { status: 403 });
  }

  const orgs = await listUserOrganizations(viewer.userId).catch(() => []);
  const keys = await getAgentKeys(
    viewer.userId,
    orgs.map((o) => o.id),
  ).catch(() => ({}));

  try {
    const result = await describeComponent(projectId, component, keys);
    if (!result) {
      return Response.json(
        { error: `componente ${component} non trovato nella scheda compilata` },
        { status: 404 },
      );
    }
    return Response.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message.slice(0, 300) }, { status: 500 });
  }
}
