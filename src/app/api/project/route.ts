import { requireProjectAccess } from "@/lib/acl";
import { getChatMessages, getProject } from "@/lib/project-store";
import { listLibraryComponents } from "@/lib/library-store";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const projectId = new URL(req.url).searchParams.get("projectId") ?? "default";
  const { ok } = await requireProjectAccess(projectId, "view");
  if (!ok) return Response.json({ error: "forbidden" }, { status: 403 });
  const [fsMap, messages, library] = await Promise.all([
    getProject(projectId),
    getChatMessages(projectId),
    listLibraryComponents().catch(() => []),
  ]);
  return Response.json({ projectId, fsMap, messages, library });
}
