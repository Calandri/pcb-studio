import { neon } from "@neondatabase/serverless";

export interface LibraryComponent {
  id: number;
  name: string;
  description: string;
  code: string;
  source: "lcsc" | "datasheet" | "llm" | "manual" | "kicad";
  sourceRef: string | null;
  version: number;
  /** link al datasheet (online, o rimando al PDF caricato) */
  datasheetUrl: string | null;
  /** note libere sull'uso nello schematico */
  schematicNotes: string;
  /** note libere su footprint/layout */
  layoutNotes: string;
}

function db() {
  const url = process.env.DATABASE_URL;
  return url ? neon(url) : null;
}

/** colonne aggiunte dopo la prima tabella: migrazione lazy, una sola volta per lambda */
let libraryColumnsPromise: Promise<void> | null = null;
async function ensureLibraryColumns(sql: NonNullable<ReturnType<typeof db>>): Promise<void> {
  libraryColumnsPromise ??= sql`ALTER TABLE library_components ADD COLUMN IF NOT EXISTS datasheet_url text`
    .then(() => sql`ALTER TABLE library_components ADD COLUMN IF NOT EXISTS schematic_notes text`)
    .then(() => sql`ALTER TABLE library_components ADD COLUMN IF NOT EXISTS layout_notes text`)
    .then(() => undefined)
    .catch((err) => {
      libraryColumnsPromise = null;
      throw err;
    });
  await libraryColumnsPromise;
}

/** Nome file/identificatore sicuro: e' anche il nome del modulo importabile. */
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

/** aggiorna i metadati della scheda componente (non il codice: quello e' versionato) */
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

/** Tutti i componenti come fsMap `lib/<Name>.tsx`, da montare nel progetto. */
export async function getLibraryFsMap(): Promise<Record<string, string>> {
  const sql = db();
  if (!sql) return {};
  // DISTINCT ON: con righe duplicate per lo stesso nome, Object.fromEntries
  // teneva quella che capitava per ultima, quindi il progetto compilava contro
  // una versione arbitraria del componente
  const rows = (await sql`
    SELECT DISTINCT ON (name) name, code FROM library_components
    ORDER BY name, version DESC, id DESC
  `) as Array<{ name: string; code: string }>;
  return Object.fromEntries(rows.map((r) => [`lib/${r.name}.tsx`, r.code]));
}

/**
 * Upsert versionato: ogni salvataggio incrementa la versione e archivia il
 * codice precedente in library_component_versions.
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

  /*
   * L'upsert su ON CONFLICT (org_id, name) non scattava mai: org_id e' NULL
   * per i componenti personali, e in Postgres NULL non collide con NULL, quindi
   * l'indice unico non vedeva il conflitto. Ogni salvataggio inseriva una riga
   * nuova con version 1 e la lettura restituiva la piu' vecchia: modificare un
   * componente di libreria era impossibile, e il salvataggio rispondeva "ok".
   * Update esplicito prima, insert solo se non c'era niente da aggiornare.
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

export async function saveDatasheet(input: {
  projectId: string | null;
  title: string;
  sourceUrl: string | null;
  text: string;
  pages: number | null;
}): Promise<{ id: number }> {
  const sql = db();
  if (!sql) throw new Error("database not configured");
  const rows = (await sql`
    INSERT INTO datasheets (project_id, title, source_url, text_content, pages)
    VALUES (${input.projectId}, ${input.title}, ${input.sourceUrl},
            ${input.text}, ${input.pages})
    RETURNING id
  `) as Array<{ id: number }>;
  return { id: Number(rows[0].id) };
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

export async function getDatasheetText(
  id: number,
): Promise<{ title: string; text: string } | null> {
  const sql = db();
  if (!sql) return null;
  const rows = (await sql`
    SELECT title, text_content FROM datasheets WHERE id = ${id} LIMIT 1
  `) as Array<{ title: string; text_content: string }>;
  if (rows.length === 0) return null;
  return { title: rows[0].title, text: rows[0].text_content };
}
