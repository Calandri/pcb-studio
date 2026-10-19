import { neon } from "@neondatabase/serverless";
import { auth } from "@/auth";
import { isEmailAllowed } from "./access-list";
import { resolveApiToken } from "./api-tokens";
import { getUserRoleInOrg, listUserOrganizations } from "./org-store";
import type { ProjectRole, ProjectSummary } from "./org-store";
import { createProject, isValidProjectId } from "./project-store";

export interface Viewer {
  userId: string;
  email: string;
}

export type AccessLevel = "none" | "view" | "edit";

function db() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not configured");
  return neon(url);
}

/** The authenticated user of the current request, or null. */
export async function currentViewer(): Promise<Viewer | null> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return null;
  // taking an address off the list closes its open sessions too
  if (!isEmailAllowed(session.user?.email)) return null;
  return { userId, email: session.user?.email ?? "" };
}

interface ProjectRow {
  org_id: string | null;
  created_by: string | null;
  visibility: string;
}

async function readProjectRow(projectId: string): Promise<ProjectRow | null> {
  const sql = db();
  const rows = (await sql`
    SELECT org_id, created_by, visibility FROM projects WHERE id = ${projectId} LIMIT 1
  `) as ProjectRow[];
  return rows[0] ?? null;
}

/**
 * A user's access level on a project.
 *
 * A project that does not exist yet is "edit" for a signed-in user: writing
 * to it creates it in their name (requireProjectAccess, claimProject). A row
 * without an owner is NOT open to everyone any more: it used to be "edit" for
 * every signed-in user, and every read created one.
 */
export async function projectAccess(
  projectId: string,
  viewer: Viewer | null,
): Promise<AccessLevel> {
  if (!isValidProjectId(projectId)) return "none";
  const project = await readProjectRow(projectId);
  if (!project) return viewer ? "edit" : "none";
  return accessOnRow(projectId, project, viewer);
}

async function accessOnRow(
  projectId: string,
  project: ProjectRow,
  viewer: Viewer | null,
): Promise<AccessLevel> {
  if (!viewer) return project.visibility === "link" ? "view" : "none";
  if (project.created_by === viewer.userId) return "edit";

  const sql = db();
  const member = project.org_id
    ? ((await sql`
        SELECT role FROM organization_members
        WHERE org_id = ${project.org_id} AND user_id = ${viewer.userId} LIMIT 1
      `) as Array<{ role: string }>)
    : [];
  if (member.length > 0 && project.visibility !== "private") return "edit";

  // private: only the author and whoever has an explicit share
  const shared = await explicitShare(projectId, viewer.userId);
  if (shared) return shared;
  if (member.length > 0) return "none";
  return project.visibility === "link" ? "view" : "none";
}

/** The organization a new project lands in when none is given: the first one. */
async function defaultOrgId(userId: string): Promise<string | null> {
  const orgs = await listUserOrganizations(userId).catch(() => []);
  return orgs[0]?.id ?? null;
}

/**
 * Edit access on a project that does not exist yet means creating it: here,
 * owner included, before the caller writes anything. Without this the first
 * write created an ownerless row.
 */
async function createIfMissing(projectId: string, viewer: Viewer): Promise<void> {
  if (await readProjectRow(projectId)) return;
  await createProject(projectId, {
    userId: viewer.userId,
    orgId: await defaultOrgId(viewer.userId),
  });
}

async function explicitShare(
  projectId: string,
  userId: string,
): Promise<AccessLevel | null> {
  const sql = db();
  const rows = (await sql`
    SELECT role FROM project_shares
    WHERE project_id = ${projectId} AND user_id = ${userId} LIMIT 1
  `) as Array<{ role: ProjectRole }>;
  if (rows.length === 0) return null;
  return rows[0].role === "editor" ? "edit" : "view";
}

/**
 * L'ACCESSO A UN PROGETTO DA UNA RICHIESTA, comunque sia entrata.
 *
 * Il browser manda una sessione, la riga di comando e il server MCP mandano un
 * token personale (pcbs_...). Sono due porte per la stessa casa, e ogni rotta
 * che se le scriveva da sola era un posto in cui potevano divergere: l'import
 * accettava il token, la compilazione no, e da terminale si poteva cambiare una
 * scheda ma non ricompilarla.
 */
export async function accessoDaRichiesta(
  req: Request,
  projectId: string,
  need: "view" | "edit",
): Promise<boolean> {
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const viewer = bearer ? await resolveApiToken(bearer) : await currentViewer();
  const level = await projectAccess(projectId, viewer);
  const ok = need === "view" ? level !== "none" : level === "edit";
  if (ok && need === "edit" && viewer) await createIfMissing(projectId, viewer);
  return ok;
}

export async function requireProjectAccess(
  projectId: string,
  need: "view" | "edit",
): Promise<{ viewer: Viewer | null; ok: boolean }> {
  const viewer = await currentViewer();
  const level = await projectAccess(projectId, viewer);
  const ok = need === "view" ? level !== "none" : level === "edit";
  if (ok && need === "edit" && viewer) await createIfMissing(projectId, viewer);
  return { viewer, ok };
}

/**
 * Who may change who sees a project (visibility, shares): its author, or an
 * owner/admin of its organization. An editor can change the board, not open
 * it to the world.
 */
export async function canManageProject(projectId: string, viewer: Viewer | null): Promise<boolean> {
  if (!viewer) return false;
  const project = await readProjectRow(projectId);
  if (!project) return false;
  if (project.created_by === viewer.userId) return true;
  if (!project.org_id) return false;
  const role = await getUserRoleInOrg(viewer.userId, project.org_id);
  return role === "owner" || role === "admin";
}

/** Projects visible to the user: their own, their org's, or shared with them. */
export async function listAccessibleProjects(
  viewer: Viewer,
): Promise<ProjectSummary[]> {
  const sql = db();
  const rows = (await sql`
    SELECT DISTINCT p.id, p.name, p.org_id, p.visibility, p.created_by, p.updated_at,
      CASE
        WHEN p.created_by = ${viewer.userId} THEN 'owner'
        WHEN s.user_id IS NOT NULL THEN 'shared'
        ELSE 'org'
      END AS access
    FROM projects p
    LEFT JOIN organization_members m
      ON m.org_id = p.org_id AND m.user_id = ${viewer.userId}
    LEFT JOIN project_shares s
      ON s.project_id = p.id AND s.user_id = ${viewer.userId}
    WHERE p.created_by = ${viewer.userId}
       OR s.user_id IS NOT NULL
       OR (m.user_id IS NOT NULL AND p.visibility <> 'private')
    ORDER BY p.updated_at DESC
    LIMIT 200
  `) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name ?? r.id),
    orgId: r.org_id ? String(r.org_id) : null,
    visibility: r.visibility as ProjectSummary["visibility"],
    createdBy: r.created_by ? String(r.created_by) : null,
    updatedAt: String(r.updated_at),
    access: r.access as ProjectSummary["access"],
  }));
}

/**
 * Makes sure the project exists and belongs to someone: creates it in the
 * viewer's name (in `orgId`, or their first organization) if it is missing.
 * An existing project is left as it is: the old COALESCE handed a project
 * nobody had claimed yet to whoever asked first.
 */
export async function claimProject(
  projectId: string,
  viewer: Viewer,
  orgId: string | null,
): Promise<void> {
  if (await readProjectRow(projectId)) return;
  await createProject(projectId, {
    userId: viewer.userId,
    orgId: orgId ?? (await defaultOrgId(viewer.userId)),
  });
}

export async function shareProject(
  projectId: string,
  email: string,
  role: ProjectRole,
): Promise<{ shared: boolean; reason?: string }> {
  const sql = db();
  const users = (await sql`
    SELECT id FROM users WHERE lower(email) = lower(${email}) LIMIT 1
  `) as Array<{ id: string }>;
  if (users.length === 0) {
    return { shared: false, reason: "user not found: they must sign in once first" };
  }
  await sql`
    INSERT INTO project_shares (project_id, user_id, role)
    VALUES (${projectId}, ${users[0].id}, ${role})
    ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role
  `;
  return { shared: true };
}

export async function unshareProject(projectId: string, userId: string): Promise<void> {
  const sql = db();
  await sql`
    DELETE FROM project_shares WHERE project_id = ${projectId} AND user_id = ${userId}
  `;
}

export async function listProjectShares(
  projectId: string,
): Promise<Array<{ userId: string; email: string; role: ProjectRole }>> {
  const sql = db();
  const rows = (await sql`
    SELECT u.id, u.email, s.role FROM project_shares s
    JOIN users u ON u.id = s.user_id
    WHERE s.project_id = ${projectId}
  `) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    userId: String(r.id),
    email: String(r.email ?? ""),
    role: r.role as ProjectRole,
  }));
}

export async function setProjectVisibility(
  projectId: string,
  visibility: "private" | "org" | "link",
): Promise<void> {
  const sql = db();
  await sql`UPDATE projects SET visibility = ${visibility} WHERE id = ${projectId}`;
}

export async function getProjectVisibility(
  projectId: string,
): Promise<"private" | "org" | "link"> {
  const sql = db();
  const [row] = (await sql`SELECT visibility FROM projects WHERE id = ${projectId}`) as Array<{
    visibility: string;
  }>;
  return (row?.visibility as "private" | "org" | "link") ?? "private";
}
