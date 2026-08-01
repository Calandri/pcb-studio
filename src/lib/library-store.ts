import { neon } from "@neondatabase/serverless";

export interface LibraryComponent {
  id: number;
  name: string;
  description: string;
  code: string;
  source: "lcsc" | "datasheet" | "llm" | "manual" | "kicad" | "altium";
  sourceRef: string | null;
  version: number;
  /** link to the datasheet (online, or reference to the uploaded PDF) */
  datasheetUrl: string | null;
  /** free notes on usage in the schematic */
  schematicNotes: string;
  /** free notes on footprint/layout */
  layoutNotes: string;
}

function db() {
  const url = process.env.DATABASE_URL;
  return url ? neon(url) : null;
}

/** columns added after the first table: lazy migration, once per lambda */
let libraryColumnsPromise: Promise<void> | null = null;
async function ensureLibraryColumns(sql: NonNullable<ReturnType<typeof db>>): Promise<void> {
  libraryColumnsPromise ??= sql`ALTER TABLE library_components ADD COLUMN IF NOT EXISTS datasheet_url text`
    .then(() => sql`ALTER TABLE library_components ADD COLUMN IF NOT EXISTS schematic_notes text`)
    .then(() => sql`ALTER TABLE library_components ADD COLUMN IF NOT EXISTS layout_notes text`)
    /*
     * The check on `source` was written when the sources were four, and it stayed
     * there while two more arrived: with 'kicad' and 'altium' missing, EVERY
     * footprint import failed on the database with a constraint violation. The
     * KiCad one too, silently, since the day it was written — nobody had imported
     * a footprint until an Altium board arrived with twenty-six.
     */
    .then(() => sql`ALTER TABLE library_components DROP CONSTRAINT IF EXISTS library_components_source_check`)
    .then(
      () => sql`ALTER TABLE library_components ADD CONSTRAINT library_components_source_check
                CHECK (source IN ('lcsc', 'datasheet', 'llm', 'manual', 'kicad', 'altium'))`,
    )
    .then(() => undefined)
    .catch((err) => {
      libraryColumnsPromise = null;
      throw err;
    });
  await libraryColumnsPromise;
}

/** Safe file/identifier name: it is also the name of the importable module. */
export const COMPONENT_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export async function listLibraryComponents(): Promise<
  Array<Omit<LibraryComponent, "code">>
> {
  const sql = db();
  if (!sql) return [];
  const rows = (await sql`
    SELECT DISTINCT ON (name) id, name, description, source, source_ref, version,
           datasheet_url, schematic_notes, layout_notes
    FROM library_components ORDER BY name, version DESC, id DESC
  `) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: Number(r.id),
    name: String(r.name),
    description: String(r.description ?? ""),
    source: r.source as LibraryComponent["source"],
    sourceRef: r.source_ref ? String(r.source_ref) : null,
    version: Number(r.version),
    datasheetUrl: r.datasheet_url ? String(r.datasheet_url) : null,
    schematicNotes: String(r.schematic_notes ?? ""),
    layoutNotes: String(r.layout_notes ?? ""),
  }));
}

export async function getLibraryComponent(
  name: string,
): Promise<LibraryComponent | null> {
  const sql = db();
  if (!sql) return null;
  await ensureLibraryColumns(sql);
  const rows = (await sql`
    SELECT id, name, description, code, source, source_ref, version,
           datasheet_url, schematic_notes, layout_notes
    FROM library_components WHERE name = ${name}
    ORDER BY version DESC, id DESC LIMIT 1
  `) as Array<Record<string, unknown>>;
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: Number(r.id),
    name: String(r.name),
    description: String(r.description ?? ""),
    code: String(r.code),
    source: r.source as LibraryComponent["source"],
    sourceRef: r.source_ref ? String(r.source_ref) : null,
    version: Number(r.version),
    datasheetUrl: r.datasheet_url ? String(r.datasheet_url) : null,
    schematicNotes: String(r.schematic_notes ?? ""),
    layoutNotes: String(r.layout_notes ?? ""),
  };
}

/** updates the metadata of the component sheet (not the code: that is versioned) */
export async function updateLibraryComponent(
  name: string,
  fields: {
    description?: string;
    datasheetUrl?: string | null;
    schematicNotes?: string;
    layoutNotes?: string;
  },
): Promise<void> {
  const sql = db();
  if (!sql) throw new Error("database not configured");
  await ensureLibraryColumns(sql);
  await sql`
    UPDATE library_components SET
      description = COALESCE(${fields.description ?? null}, description),
      datasheet_url = COALESCE(${fields.datasheetUrl ?? null}, datasheet_url),
      schematic_notes = COALESCE(${fields.schematicNotes ?? null}, schematic_notes),
      layout_notes = COALESCE(${fields.layoutNotes ?? null}, layout_notes),
      updated_at = now()
    WHERE name = ${name} AND org_id IS NULL
  `;
}

/** All components as an fsMap `lib/<Name>.tsx`, to be mounted in the project. */
export async function getLibraryFsMap(): Promise<Record<string, string>> {
  const sql = db();
  if (!sql) return {};
  // DISTINCT ON: with duplicate rows for the same name, Object.fromEntries
  // kept whichever one happened to come last, so the project compiled against
  // an arbitrary version of the component
  const rows = (await sql`
    SELECT DISTINCT ON (name) name, code FROM library_components
    ORDER BY name, version DESC, id DESC
  `) as Array<{ name: string; code: string }>;
  return Object.fromEntries(rows.map((r) => [`lib/${r.name}.tsx`, r.code]));
}

/**
 * Versioned upsert: every save increments the version and archives the
 * previous code in library_component_versions.
 */
export async function saveLibraryComponent(input: {
  name: string;
  description: string;
  code: string;
  source: LibraryComponent["source"];
  sourceRef?: string | null;
}): Promise<{ name: string; version: number }> {
  const sql = db();
  if (!sql) throw new Error("database not configured");
  // the migrations too: this is the write path, and it is where the constraint bites
  await ensureLibraryColumns(sql);

  /*
   * The upsert on ON CONFLICT (org_id, name) never fired: org_id is NULL for
   * personal components, and in Postgres NULL does not collide with NULL, so
   * the unique index never saw the conflict. Every save inserted a new row
   * with version 1 and the read returned the oldest one: editing a library
   * component was impossible, and the save answered "ok".
   * Explicit update first, insert only if there was nothing to update.
   */
  const updated = (await sql`
    UPDATE library_components SET
      description = ${input.description},
      code = ${input.code},
      source = ${input.source},
      source_ref = ${input.sourceRef ?? null},
      version = version + 1,
      updated_at = now()
    WHERE name = ${input.name} AND org_id IS NULL
    RETURNING id, version
  `) as Array<{ id: number; version: number }>;

  const rows =
    updated.length > 0
      ? updated
      : ((await sql`
          INSERT INTO library_components (name, description, code, source, source_ref)
          VALUES (${input.name}, ${input.description}, ${input.code}, ${input.source},
                  ${input.sourceRef ?? null})
          RETURNING id, version
        `) as Array<{ id: number; version: number }>);

  const { id, version } = rows[0];
  await sql`
    INSERT INTO library_component_versions (component_id, version, code)
    VALUES (${id}, ${version}, ${input.code})
    ON CONFLICT (component_id, version) DO NOTHING
  `;
  return { name: input.name, version: Number(version) };
}

/**
 * The manufacturer part number the datasheet belongs to.
 *
 * Until now a datasheet was tied only to a project: a PDF among PDFs, findable
 * by title if the title said anything. With the code, the sheet belongs to a
 * PART — the agent can go from "which capacitor is C1" to its pages without
 * searching by name, and the same PDF is not downloaded seventeen times for the
 * seventeen identical capacitors on a board (on BAT_BS: 31 distinct codes out of
 * 98 components).
 */
async function ensureDatasheetMpn(sql: NonNullable<ReturnType<typeof db>>): Promise<void> {
  await sql`ALTER TABLE datasheets ADD COLUMN IF NOT EXISTS mpn text`;
  await sql`CREATE INDEX IF NOT EXISTS datasheets_mpn_idx ON datasheets (mpn)`;
}

export async function saveDatasheet(input: {
  projectId: string | null;
  title: string;
  sourceUrl: string | null;
  text: string;
  pages: number | null;
  /** the part this sheet describes, when it is known */
  mpn?: string | null;
}): Promise<{ id: number }> {
  const sql = db();
  if (!sql) throw new Error("database not configured");
  await ensureDatasheetMpn(sql);
  const rows = (await sql`
    INSERT INTO datasheets (project_id, title, source_url, text_content, pages, mpn)
    VALUES (${input.projectId}, ${input.title}, ${input.sourceUrl},
            ${input.text}, ${input.pages}, ${input.mpn ?? null})
    RETURNING id
  `) as Array<{ id: number }>;
  return { id: Number(rows[0].id) };
}

/** the codes whose datasheet this project already has: what not to download again */
export async function datasheetMpns(projectId: string): Promise<Set<string>> {
  const sql = db();
  if (!sql) return new Set();
  await ensureDatasheetMpn(sql);
  const rows = (await sql`
    SELECT DISTINCT mpn FROM datasheets
    WHERE mpn IS NOT NULL AND (project_id = ${projectId} OR project_id IS NULL)
  `) as Array<{ mpn: string }>;
  return new Set(rows.map((r) => String(r.mpn)));
}

export async function listDatasheets(
  projectId: string,
): Promise<Array<{ id: number; title: string; pages: number | null; chars: number }>> {
  const sql = db();
  if (!sql) return [];
  const rows = (await sql`
    SELECT id, title, pages, length(text_content) AS chars
    FROM datasheets WHERE project_id = ${projectId} OR project_id IS NULL
    ORDER BY id DESC LIMIT 50
  `) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: Number(r.id),
    title: String(r.title),
    pages: r.pages === null ? null : Number(r.pages),
    chars: Number(r.chars),
  }));
}

/**
 * The text of a datasheet, ONLY if it belongs to the project asking for it.
 *
 * It used to read by id and nothing else: with the id alone the agent of one
 * project could read the datasheets of any other project on the instance. On an
 * instance with more than one customer that is not a detail, it is a way out of
 * their own project.
 */
export async function getDatasheetText(
  id: number,
  projectId?: string,
): Promise<{ title: string; text: string } | null> {
  const sql = db();
  if (!sql) return null;
  const rows = (
    projectId === undefined
      ? await sql`SELECT title, text_content FROM datasheets WHERE id = ${id} LIMIT 1`
      : await sql`
          SELECT title, text_content FROM datasheets
          WHERE id = ${id} AND (project_id = ${projectId} OR project_id IS NULL)
          LIMIT 1
        `
  ) as Array<{ title: string; text_content: string }>;
  if (rows.length === 0) return null;
  return { title: rows[0].title, text: rows[0].text_content };
}
