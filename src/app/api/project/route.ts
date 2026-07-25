import { getProject } from "@/lib/project-store";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const projectId = new URL(req.url).searchParams.get("projectId") ?? "default";
  return Response.json({ projectId, fsMap: getProject(projectId) });
}
