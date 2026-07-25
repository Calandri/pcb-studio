import { getChatMessages, getProject } from "@/lib/project-store";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const projectId = new URL(req.url).searchParams.get("projectId") ?? "default";
  const [fsMap, messages] = await Promise.all([
    getProject(projectId),
    getChatMessages(projectId),
  ]);
  return Response.json({ projectId, fsMap, messages });
}
