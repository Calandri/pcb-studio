import { neon } from "@neondatabase/serverless";
import { auth } from "@/auth";
import { resolveApiToken } from "./api-tokens";
import type { ProjectRole, ProjectSummary } from "./org-store";

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
  return { userId, email: session.user?.email ?? "" };
}

/**
 * A user's access level on a project. A project without an org (legacy,
 * created before auth) stays accessible to every authenticated user: no data
 * is retroactively hidden from its authors.
 */
export async function projectAccess(
  projectId: string,
  viewer: Viewer | null,
): Promise<AccessLevel> {
  const sql = db();
  const rows = (await sql`
    SELECT org_id, created_by, visibility FROM projects WHERE id = ${projectId} LIMIT 1
  `) as Array<{ org_id: string | null; created_by: string | null; visibility: string }>;

  // project not created yet: any authenticated user can create it
  if (rows.length === 0) return viewer ? "edit" : "none";

  const project = rows[0];
  if (project.org_id === null) return viewer ? "edit" : "none";
  if (!viewer) return project.visibility === "link" ? "view" : "none";
  if (project.created_by === viewer.userId) return "edit";

  const member = (await sql`
    SELECT role FROM organization_members
    WHERE org_id = ${project.org_id} AND user_id = ${viewer.userId} LIMIT 1
  `) as Array<{ role: string }>;
  if (member.length > 0 && project.visibility !== "private") return "edit";
  if (member.length > 0 && project.visibility === "private") {
    // private: only the author and whoever has an explicit share
    const shared = await explicitShare(projectId, viewer.userId);
    return shared ?? "none";
  }

  const shared = await explicitShare(projectId, viewer.userId);
  if (shared) return shared;
  return project.visibility === "link" ? "view" : "none";
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
  return need === "view" ? level !== "none" : level === "edit";
}

export async function requireProjectAccess(
  projectId: string,
  need: "view" | "edit",
): Promise<{ viewer: Viewer | null; ok: boolean }> {
  const viewer = await currentViewer();
  const level = await projectAccess(projectId, viewer);
  const ok = need === "view" ? level !== "none" : level === "edit";
  return { viewer, ok };
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
       OR p.org_id IS NULL
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

/** Assigns owner and organization to a newly created project. */
export async function claimProject(
  projectId: string,
  viewer: Viewer,
  orgId: string | null,
): Promise<void> {
  const sql = db();
  await sql`
    UPDATE projects
    SET created_by = COALESCE(created_by, ${viewer.userId}),
        org_id = COALESCE(org_id, ${orgId})
    WHERE id = ${projectId}
  `;
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
