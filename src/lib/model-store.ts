import { neon } from "@neondatabase/serverless";

/**
 * The 3D meshes of a project's components.
 *
 * They live apart from the project files for one reason: size. The models of one
 * imported board are a couple of megabytes of OBJ, and the project files are read
 * whole on every open, by the editor and by every agent. Two megabytes of
 * triangles in that payload would make every read pay for something only the 3D
 * view uses.
 *
 * Text, like the datasheets: an OBJ is text, Postgres stores it, and it goes out
 * through an endpoint that checks who is asking. Keyed by project plus name, so
 * re-importing the same board overwrites its own models instead of piling up
 * copies.
 */

function db() {
  const url = process.env.DATABASE_URL;
  return url ? neon(url) : null;
}

let tabella: Promise<void> | null = null;
async function ensureTable(sql: NonNullable<ReturnType<typeof db>>): Promise<void> {
  tabella ??= sql`
    CREATE TABLE IF NOT EXISTS project_models (
      id bigserial PRIMARY KEY,
      project_id text NOT NULL,
      name text NOT NULL,
      obj text NOT NULL,
      triangles integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (project_id, name)
    )
  `
    .then(() => undefined)
    .catch((err) => {
      tabella = null;
      throw err;
    });
  await tabella;
}

export async function saveProjectModel(input: {
  projectId: string;
  name: string;
  obj: string;
  triangles?: number;
}): Promise<void> {
  const sql = db();
  if (!sql) throw new Error("database not configured");
  await ensureTable(sql);
  await sql`
    INSERT INTO project_models (project_id, name, obj, triangles)
    VALUES (${input.projectId}, ${input.name}, ${input.obj}, ${input.triangles ?? 0})
    ON CONFLICT (project_id, name)
    DO UPDATE SET obj = EXCLUDED.obj, triangles = EXCLUDED.triangles, created_at = now()
  `;
}

export async function getProjectModel(
  projectId: string,
  name: string,
): Promise<{ obj: string } | null> {
  const sql = db();
  if (!sql) return null;
  await ensureTable(sql);
  const rows = (await sql`
    SELECT obj FROM project_models
    WHERE project_id = ${projectId} AND name = ${name} LIMIT 1
  `) as Array<{ obj: string }>;
  return rows.length ? { obj: rows[0].obj } : null;
}

export async function listProjectModels(
  projectId: string,
): Promise<Array<{ name: string; triangles: number; bytes: number }>> {
  const sql = db();
  if (!sql) return [];
  await ensureTable(sql);
  const rows = (await sql`
    SELECT name, triangles, length(obj) AS bytes FROM project_models
    WHERE project_id = ${projectId} ORDER BY name
  `) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    name: String(r.name),
    triangles: Number(r.triangles),
    bytes: Number(r.bytes),
  }));
}
