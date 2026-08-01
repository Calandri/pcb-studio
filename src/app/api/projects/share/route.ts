import { z } from "zod";
import {
  getProjectVisibility,
  listProjectShares,
  requireProjectAccess,
  setProjectVisibility,
  shareProject,
  unshareProject,
} from "@/lib/acl";

export const runtime = "nodejs";

const ShareSchema = z.object({
  projectId: z.string().regex(/^[\w-]{1,64}$/),
  email: z.string().email().optional(),
  role: z.enum(["viewer", "editor"]).default("viewer"),
  visibility: z.enum(["private", "org", "link"]).optional(),
  removeUserId: z.string().uuid().optional(),
});

export async function GET(req: Request): Promise<Response> {
  const projectId = new URL(req.url).searchParams.get("projectId") ?? "";
  const { ok } = await requireProjectAccess(projectId, "view");
  if (!ok) return Response.json({ error: "forbidden" }, { status: 403 });
  return Response.json({
    shares: await listProjectShares(projectId),
    visibility: await getProjectVisibility(projectId),
  });
}

/** Sharing with a user, removal, or visibility change: requires edit access. */
export async function POST(req: Request): Promise<Response> {
  const parsed = ShareSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid body" }, { status: 400 });
  const { projectId, email, role, visibility, removeUserId } = parsed.data;

  const { ok } = await requireProjectAccess(projectId, "edit");
  if (!ok) return Response.json({ error: "forbidden" }, { status: 403 });

  if (visibility) await setProjectVisibility(projectId, visibility);
  if (removeUserId) await unshareProject(projectId, removeUserId);

  let shareResult: { shared: boolean; reason?: string } | null = null;
  if (email) shareResult = await shareProject(projectId, email, role);

  return Response.json({
    ok: true,
    share: shareResult,
    shares: await listProjectShares(projectId),
  });
}
