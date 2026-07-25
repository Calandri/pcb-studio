import { z } from "zod";
import { claimProject, currentViewer, listAccessibleProjects } from "@/lib/acl";
import { listUserOrganizations } from "@/lib/org-store";
import { getProject } from "@/lib/project-store";

export const runtime = "nodejs";

const CreateSchema = z.object({
  id: z
    .string()
    .regex(/^[\w-]{1,64}$/, "id: only letters, digits, - and _"),
  orgId: z.string().uuid().optional(),
});

export async function GET(): Promise<Response> {
  const viewer = await currentViewer();
  if (!viewer) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const [projects, organizations] = await Promise.all([
    listAccessibleProjects(viewer),
    listUserOrganizations(viewer.userId),
  ]);
  return Response.json({ projects, organizations, user: viewer });
}

export async function POST(req: Request): Promise<Response> {
  const viewer = await currentViewer();
  if (!viewer) return Response.json({ error: "unauthenticated" }, { status: 401 });

  const parsed = CreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: parsed.error.issues[0]?.message ?? "invalid body" }, { status: 400 });
  }

  const orgs = await listUserOrganizations(viewer.userId);
  const orgId = parsed.data.orgId ?? orgs[0]?.id ?? null;
  if (parsed.data.orgId && !orgs.some((o) => o.id === parsed.data.orgId)) {
    return Response.json({ error: "not a member of that organization" }, { status: 403 });
  }

  await getProject(parsed.data.id); // crea il progetto col contenuto demo
  await claimProject(parsed.data.id, viewer, orgId);
  return Response.json({ id: parsed.data.id, orgId });
}
