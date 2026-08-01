import { z } from "zod";
import { claimProject, currentViewer, listAccessibleProjects } from "@/lib/acl";
import { CHECKS_ENGINE_VERSION } from "@/lib/engine-version";
import { listUserOrganizations } from "@/lib/org-store";
import { getCheckStatusByProject, getProject } from "@/lib/project-store";

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
  // check status for the "Controlli" column of the organization console
  const checks: Record<string, import("@/lib/project-store").ProjectCheckStatus> =
    await getCheckStatusByProject(
      projects.map((p) => p.id),
      CHECKS_ENGINE_VERSION,
    ).catch(() => ({}));
  return Response.json({
    projects: projects.map((p) => ({ ...p, checks: checks[p.id] ?? null })),
    organizations,
    user: viewer,
  });
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

  await getProject(parsed.data.id); // creates the project with the demo content
  await claimProject(parsed.data.id, viewer, orgId);
  return Response.json({ id: parsed.data.id, orgId });
}
