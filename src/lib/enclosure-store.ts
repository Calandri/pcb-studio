import { neon } from "@neondatabase/serverless";

/**
 * Enclosures and 3D modules of a project. The source depends on the kind:
 * - parametric: parameter JSON (the JSCAD code is regenerated from the template)
 * - jscad: JSCAD source written by the AI or by hand
 * - import: uploaded CAD file (base64) + file_name with the original format
 */

export type EnclosureKind = "parametric" | "jscad" | "import";

export interface EnclosureRecord {
  name: string;
  kind: EnclosureKind;
  source: string;
  fileName: string | null;
  transform: { x: number; y: number; z: number; rotZ: number };
  visible: boolean;
  updatedAt: string;
}

export const ENCLOSURE_NAME_RE = /^[\w][\w .-]{0,62}$/;

function db() {
  const url = process.env.DATABASE_URL;
  return url ? neon(url) : null;
}

let ddlPromise: Promise<void> | null = null;
async function ensureTable(sql: NonNullable<ReturnType<typeof db>>): Promise<void> {
  // reset on failure: a transient error must not shut down the table for the
  // whole lifetime of the lambda
  ddlPromise ??= sql`
    CREATE TABLE IF NOT EXISTS project_enclosures (
      project_id text NOT NULL,
      name text NOT NULL,
      kind text NOT NULL,
      source text NOT NULL,
      file_name text,
      transform jsonb NOT NULL DEFAULT '{}',
      visible boolean NOT NULL DEFAULT true,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (project_id, name)
    )
  `
    .then(() => undefined)
    .catch((err) => {
      ddlPromise = null;
      throw err;
    });
  await ddlPromise;
}

type Row = Record<string, unknown>;

function toRecord(r: Row): EnclosureRecord {
  const t = (r.transform ?? {}) as Record<string, unknown>;
  return {
    name: String(r.name),
    kind: String(r.kind) as EnclosureKind,
    source: String(r.source),
    fileName: r.file_name ? String(r.file_name) : null,
    transform: {
      x: Number(t.x ?? 0),
      y: Number(t.y ?? 0),
      z: Number(t.z ?? 0),
      rotZ: Number(t.rotZ ?? 0),
    },
    visible: Boolean(r.visible),
    updatedAt: String(r.updated_at),
  };
}

export async function listEnclosures(projectId: string): Promise<EnclosureRecord[]> {
  const sql = db();
  if (!sql) return [];
  await ensureTable(sql);
  const rows = (await sql`
    SELECT name, kind, source, file_name, transform, visible, updated_at
    FROM project_enclosures WHERE project_id = ${projectId}
    ORDER BY updated_at DESC
  `) as Row[];
  return rows.map(toRecord);
}

export async function getEnclosure(
  projectId: string,
  name: string,
): Promise<EnclosureRecord | null> {
  const sql = db();
  if (!sql) return null;
  await ensureTable(sql);
  const rows = (await sql`
    SELECT name, kind, source, file_name, transform, visible, updated_at
    FROM project_enclosures WHERE project_id = ${projectId} AND name = ${name}
    LIMIT 1
  `) as Row[];
  return rows.length > 0 ? toRecord(rows[0]) : null;
}

export async function saveEnclosure(
  projectId: string,
  record: Omit<EnclosureRecord, "updatedAt">,
): Promise<void> {
  const sql = db();
  if (!sql) return;
  await ensureTable(sql);
  await sql`
    INSERT INTO project_enclosures
      (project_id, name, kind, source, file_name, transform, visible)
    VALUES
      (${projectId}, ${record.name}, ${record.kind}, ${record.source},
       ${record.fileName}, ${JSON.stringify(record.transform)}::jsonb, ${record.visible})
    ON CONFLICT (project_id, name)
    DO UPDATE SET kind = EXCLUDED.kind,
                  source = EXCLUDED.source,
                  file_name = EXCLUDED.file_name,
                  transform = EXCLUDED.transform,
                  visible = EXCLUDED.visible,
                  updated_at = now()
  `;
}

export async function updateEnclosure(
  projectId: string,
  name: string,
  patch: {
    newName?: string;
    visible?: boolean;
    transform?: EnclosureRecord["transform"];
  },
): Promise<void> {
  const sql = db();
  if (!sql) return;
  await ensureTable(sql);
  const current = await getEnclosure(projectId, name);
  if (!current) throw new Error(`scocca non trovata: ${name}`);
  await sql`
    UPDATE project_enclosures
    SET name = ${patch.newName ?? name},
        visible = ${patch.visible ?? current.visible},
        transform = ${JSON.stringify(patch.transform ?? current.transform)}::jsonb,
        updated_at = now()
    WHERE project_id = ${projectId} AND name = ${name}
  `;
}

export async function deleteEnclosure(projectId: string, name: string): Promise<void> {
  const sql = db();
  if (!sql) return;
  await ensureTable(sql);
  await sql`
    DELETE FROM project_enclosures WHERE project_id = ${projectId} AND name = ${name}
  `;
}
