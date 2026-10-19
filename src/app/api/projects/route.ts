import { z } from "zod";
import { currentViewer, listAccessibleProjects } from "@/lib/acl";
import { CHECKS_ENGINE_VERSION } from "@/lib/engine-version";
import { listUserOrganizations } from "@/lib/org-store";
import { createProject, getCheckStatusByProject, isValidProjectId } from "@/lib/project-store";

export const runtime = "nodejs";

const CreateSchema = z.object({
  // the same rule as the database CHECK: an id the create route accepted
  // and the store then refused made the first write fail
  id: z
    .string()
    .refine(isValidProjectId, "id: starts with a letter or digit, then letters, digits, - and _ (max 60)"),
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

  const created = await createProject(parsed.data.id, { userId: viewer.userId, orgId });
  if (!created) {
    return Response.json({ error: "a project with this id already exists" }, { status: 409 });
  }
  return Response.json({ id: parsed.data.id, orgId });
}
