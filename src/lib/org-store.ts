import { neon } from "@neondatabase/serverless";

export type OrgRole = "owner" | "admin" | "member";
export type ProjectRole = "viewer" | "editor";

export interface Organization {
  id: string;
  name: string;
  slug: string;
  plan: string;
  role: OrgRole;
}

export interface OrgMember {
  userId: string;
  email: string;
  name: string | null;
  role: OrgRole;
}

export interface ProjectSummary {
  id: string;
  name: string;
  orgId: string | null;
  visibility: "private" | "org" | "link";
  createdBy: string | null;
  updatedAt: string;
  /** how the current user accesses it */
  access: "owner" | "org" | "shared";
}

function db() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not configured");
  return neon(url);
}

function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "org"
  );
}

/**
 * On first login: personal organization + any pending invites accepted
 * automatically (the invite is by email).
 */
export async function ensureUserOrganization(
  userId: string,
  email: string,
): Promise<void> {
  const sql = db();

  const invites = (await sql`
    SELECT org_id, role FROM organization_invites
    WHERE lower(email) = lower(${email}) AND accepted_at IS NULL
  `) as Array<{ org_id: string; role: OrgRole }>;

  for (const invite of invites) {
    await sql`
      INSERT INTO organization_members (org_id, user_id, role)
      VALUES (${invite.org_id}, ${userId}, ${invite.role})
      ON CONFLICT (org_id, user_id) DO NOTHING
    `;
    await sql`
      UPDATE organization_invites SET accepted_at = now()
      WHERE org_id = ${invite.org_id} AND lower(email) = lower(${email})
    `;
  }

  const existing = (await sql`
    SELECT 1 FROM organization_members WHERE user_id = ${userId} LIMIT 1
  `) as unknown[];
  if (existing.length > 0) return;

  const base = slugify(email.split("@")[0]);
  const slug = `${base}-${userId.slice(0, 6)}`;
  const rows = (await sql`
    INSERT INTO organizations (name, slug) VALUES (${email.split("@")[0]}, ${slug})
    RETURNING id
  `) as Array<{ id: string }>;
  await sql`
    INSERT INTO organization_members (org_id, user_id, role)
    VALUES (${rows[0].id}, ${userId}, 'owner')
  `;
}

export async function listUserOrganizations(userId: string): Promise<Organization[]> {
  const sql = db();
  const rows = (await sql`
    SELECT o.id, o.name, o.slug, o.plan, m.role
    FROM organizations o
    JOIN organization_members m ON m.org_id = o.id
    WHERE m.user_id = ${userId}
    ORDER BY o.created_at
  `) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    slug: String(r.slug),
    plan: String(r.plan),
    role: r.role as OrgRole,
  }));
}

export async function getUserRoleInOrg(
  userId: string,
  orgId: string,
): Promise<OrgRole | null> {
  const sql = db();
  const rows = (await sql`
    SELECT role FROM organization_members
    WHERE user_id = ${userId} AND org_id = ${orgId} LIMIT 1
  `) as Array<{ role: OrgRole }>;
  return rows[0]?.role ?? null;
}

export async function createOrganization(
  userId: string,
  name: string,
): Promise<Organization> {
  const sql = db();
  const slug = `${slugify(name)}-${Math.abs(hash(name + userId)) % 10000}`;
  const rows = (await sql`
    INSERT INTO organizations (name, slug) VALUES (${name}, ${slug})
    RETURNING id, name, slug, plan
  `) as Array<Record<string, unknown>>;
  const org = rows[0];
  await sql`
    INSERT INTO organization_members (org_id, user_id, role)
    VALUES (${String(org.id)}, ${userId}, 'owner')
  `;
  return {
    id: String(org.id),
    name: String(org.name),
    slug: String(org.slug),
    plan: String(org.plan),
    role: "owner",
  };
}

export async function listOrgMembers(orgId: string): Promise<OrgMember[]> {
  const sql = db();
  const rows = (await sql`
    SELECT u.id, u.email, u.name, m.role
    FROM organization_members m JOIN users u ON u.id = m.user_id
    WHERE m.org_id = ${orgId}
    ORDER BY m.created_at
  `) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    userId: String(r.id),
    email: String(r.email ?? ""),
    name: r.name ? String(r.name) : null,
    role: r.role as OrgRole,
  }));
}

export async function listOrgInvites(
  orgId: string,
): Promise<Array<{ email: string; role: OrgRole }>> {
  const sql = db();
  const rows = (await sql`
    SELECT email, role FROM organization_invites
    WHERE org_id = ${orgId} AND accepted_at IS NULL ORDER BY created_at DESC
  `) as Array<{ email: string; role: OrgRole }>;
  return rows;
}

/**
 * Email invite: if the user already exists they join immediately, otherwise
 * the invite is consumed at their first login (ensureUserOrganization).
 */
export async function inviteToOrg(
  orgId: string,
  email: string,
  role: OrgRole,
  invitedBy: string,
): Promise<{ joined: boolean }> {
  const sql = db();
  const users = (await sql`
    SELECT id FROM users WHERE lower(email) = lower(${email}) LIMIT 1
  `) as Array<{ id: string }>;

  if (users.length > 0) {
    await sql`
      INSERT INTO organization_members (org_id, user_id, role)
      VALUES (${orgId}, ${users[0].id}, ${role})
      ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role
    `;
    return { joined: true };
  }

  await sql`
    INSERT INTO organization_invites (org_id, email, role, invited_by)
    VALUES (${orgId}, ${email}, ${role}, ${invitedBy})
    ON CONFLICT (org_id, email) DO UPDATE SET role = EXCLUDED.role
  `;
  return { joined: false };
}

export async function removeOrgMember(orgId: string, userId: string): Promise<void> {
  const sql = db();
  await sql`
    DELETE FROM organization_members WHERE org_id = ${orgId} AND user_id = ${userId}
  `;
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}
