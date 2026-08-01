import { z } from "zod";
import { currentViewer } from "@/lib/acl";
import {
  createOrganization,
  getUserRoleInOrg,
  inviteToOrg,
  listOrgInvites,
  listOrgMembers,
  listUserOrganizations,
  removeOrgMember,
} from "@/lib/org-store";

export const runtime = "nodejs";

const ActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create_org"), name: z.string().min(2).max(60) }),
  z.object({
    action: z.literal("invite"),
    orgId: z.string().uuid(),
    email: z.string().email(),
    role: z.enum(["owner", "admin", "member"]).default("member"),
  }),
  z.object({
    action: z.literal("remove_member"),
    orgId: z.string().uuid(),
    userId: z.string().uuid(),
  }),
]);

export async function GET(req: Request): Promise<Response> {
  const viewer = await currentViewer();
  if (!viewer) return Response.json({ error: "unauthenticated" }, { status: 401 });

  const orgId = new URL(req.url).searchParams.get("orgId");
  const organizations = await listUserOrganizations(viewer.userId);
  if (!orgId) return Response.json({ organizations });

  if (!organizations.some((o) => o.id === orgId)) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  const [members, invites] = await Promise.all([
    listOrgMembers(orgId),
    listOrgInvites(orgId),
  ]);
  return Response.json({ organizations, members, invites });
}

export async function POST(req: Request): Promise<Response> {
  const viewer = await currentViewer();
  if (!viewer) return Response.json({ error: "unauthenticated" }, { status: 401 });

  const parsed = ActionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid body" }, { status: 400 });
  const body = parsed.data;

  if (body.action === "create_org") {
    return Response.json({ organization: await createOrganization(viewer.userId, body.name) });
  }

  // inviting and removing require owner/admin of the organization
  const role = await getUserRoleInOrg(viewer.userId, body.orgId);
  if (role !== "owner" && role !== "admin") {
    return Response.json({ error: "forbidden: admin role required" }, { status: 403 });
  }

  if (body.action === "invite") {
    const result = await inviteToOrg(body.orgId, body.email, body.role, viewer.userId);
    return Response.json({ ok: true, ...result, members: await listOrgMembers(body.orgId) });
  }

  if (body.userId === viewer.userId) {
    return Response.json({ error: "cannot remove yourself" }, { status: 400 });
  }
  await removeOrgMember(body.orgId, body.userId);
  return Response.json({ ok: true, members: await listOrgMembers(body.orgId) });
}
