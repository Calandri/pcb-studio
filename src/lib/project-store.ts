import { neon } from "@neondatabase/serverless";
import { createHash } from "node:crypto";

export type FsMap = Record<string, string>;
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** stable hash of the project sources: validity key for the compile cache */
export function filesHash(fsMap: FsMap): string {
  const hash = createHash("sha256");
  for (const path of Object.keys(fsMap).sort()) {
    hash.update(path);
    hash.update("\0");
    hash.update(fsMap[path]);
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 32);
}

// The template is the implicit style example of every new project: every
// component has its functional section and every section its frame, so the
// model starts from an already readable schematic instead of a flat board
// from which it would learn the wrong habit.
const DEMO_MAIN = `export default () => (
  <board width="34mm" height="24mm" autorouter="auto_cloud" schTraceAutoLabelEnabled>
    <schematicsection name="timer" displayName="Timer 555" />
    <schematicsection name="timing" displayName="Rete RC di temporizzazione" />
    <schematicsection name="output" displayName="Uscita LED" />

    <chip
      name="U1"
      footprint="soic8"
      schSectionName="timer"
      pcbX={0}
      pcbY={0}
      pinLabels={{
        pin1: "GND",
        pin2: "TRIG",
        pin3: "OUT",
        pin4: "RESET",
        pin5: "CTRL",
        pin6: "THRES",
        pin7: "DISCH",
        pin8: "VCC",
      }}
    />
    <resistor name="R1" resistance="10k" footprint="0402" schSectionName="timing" pcbX={-10} pcbY={6} />
    <resistor name="R2" resistance="47k" footprint="0402" schSectionName="timing" pcbX={-10} pcbY={0} />
    <resistor name="R3" resistance="220" footprint="0402" schSectionName="output" pcbX={10} pcbY={6} />
    <capacitor name="C1" capacitance="10uF" footprint="0603" schSectionName="timing" pcbX={-10} pcbY={-6} />
    <led name="D1" footprint="0603" schSectionName="output" pcbX={10} pcbY={-6} />
    <net name="VCC" />
    <net name="GND" />

    <trace from=".U1 > .VCC" to="net.VCC" />
    <trace from=".U1 > .RESET" to="net.VCC" />
    <trace from=".U1 > .GND" to="net.GND" />
    <trace from=".R1 > .pin1" to="net.VCC" />
    <trace from=".R1 > .pin2" to=".U1 > .DISCH" />
    <trace from=".R2 > .pin1" to=".U1 > .DISCH" />
    <trace from=".R2 > .pin2" to=".U1 > .THRES" />
    <trace from=".U1 > .THRES" to=".U1 > .TRIG" />
    <trace from=".C1 > .pin1" to=".U1 > .TRIG" />
    <trace from=".C1 > .pin2" to="net.GND" />
    <trace from=".U1 > .OUT" to=".R3 > .pin1" />
    <trace from=".R3 > .pin2" to=".D1 > .anode" />
    <trace from=".D1 > .cathode" to="net.GND" />
  </board>
)
`;

function db() {
  const url = process.env.DATABASE_URL;
  return url ? neon(url) : null;
}

// In-memory fallback (no DATABASE_URL, e.g. offline dev): survives HMR only.
const globalStore = globalThis as unknown as {
  __pcbStudioProjects?: Map<string, FsMap>;
  __pcbStudioChats?: Map<string, ChatMessage[]>;
};
function memProjects(): Map<string, FsMap> {
  return (globalStore.__pcbStudioProjects ??= new Map());
}
function memChats(): Map<string, ChatMessage[]> {
  return (globalStore.__pcbStudioChats ??= new Map());
}

/**
 * A valid project identifier: letters, digits, dashes. The same rule is a
 * CHECK on the projects table (db/schema.sql), so the database refuses what
 * the code would refuse.
 */
const PROJECT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,59}$/i;

export function isValidProjectId(id: string): boolean {
  return PROJECT_ID_RE.test(id);
}

/**
 * The files of a project. READING CREATES NOTHING: a project that does not
 * exist yet shows the example board and leaves no row behind. It used to
 * insert the project on the first read, without an owner, and an ownerless
 * project was editable by every signed-in user and ended up in everyone's
 * list. Projects are created only by createProject, owner included.
 */
export async function getProject(projectId: string): Promise<FsMap> {
  const sql = db();
  if (!sql) {
    const store = memProjects();
    if (!store.has(projectId)) store.set(projectId, { "main.tsx": DEMO_MAIN });
    return store.get(projectId)!;
  }

  const rows = (await sql`
    SELECT path, content FROM project_files WHERE project_id = ${projectId}
  `) as Array<{ path: string; content: string }>;

  if (rows.length === 0) return { "main.tsx": DEMO_MAIN };
  return Object.fromEntries(rows.map((r) => [r.path, r.content]));
}

export async function projectExists(projectId: string): Promise<boolean> {
  const sql = db();
  if (!sql) return memProjects().has(projectId);
  const rows = (await sql`SELECT 1 FROM projects WHERE id = ${projectId} LIMIT 1`) as unknown[];
  return rows.length > 0;
}

/**
 * Creates the project with its owner in one statement, plus the example
 * main.tsx. Returns false if the id already existed: an existing project is
 * never reassigned (the old claim with COALESCE handed an unclaimed project
 * to whoever asked first).
 */
export async function createProject(
  projectId: string,
  owner: { userId: string; orgId: string | null; name?: string | null },
): Promise<boolean> {
  if (!isValidProjectId(projectId)) {
    throw new Error(`Identificativo di progetto non valido: "${projectId}"`);
  }
  const sql = db();
  if (!sql) {
    const store = memProjects();
    if (store.has(projectId)) return false;
    store.set(projectId, { "main.tsx": DEMO_MAIN });
    return true;
  }
  const created = (await sql`
    INSERT INTO projects (id, name, created_by, org_id)
    VALUES (${projectId}, ${owner.name ?? null}, ${owner.userId}, ${owner.orgId})
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  `) as unknown[];
  if (created.length === 0) return false;
  await sql`
    INSERT INTO project_files (project_id, path, content)
    VALUES (${projectId}, 'main.tsx', ${DEMO_MAIN})
    ON CONFLICT (project_id, path) DO NOTHING
  `;
  return true;
}

/** Postgres foreign_key_violation: the project row is missing */
function missingProject(err: unknown, projectId: string): Error | null {
  if ((err as { code?: string })?.code !== "23503") return null;
  return new Error(`Il progetto "${projectId}" non esiste: va creato prima di scriverci`);
}

/**
 * Writes a file, last write wins. For read-modify-write of a file that
 * someone else may be changing at the same time use updateProjectFile.
 */
export async function writeProjectFile(
  projectId: string,
  path: string,
  content: string,
): Promise<void> {
  const sql = db();
  if (!sql) {
    const store = memProjects();
    const fsMap = store.get(projectId) ?? {};
    fsMap[path] = content;
    store.set(projectId, fsMap);
    return;
  }

  if (!isValidProjectId(projectId)) {
    throw new Error(`Identificativo di progetto non valido: "${projectId}"`);
  }
  try {
    await sql`
      INSERT INTO project_files (project_id, path, content)
      VALUES (${projectId}, ${path}, ${content})
      ON CONFLICT (project_id, path)
      DO UPDATE SET content = EXCLUDED.content,
                    version = project_files.version + 1,
                    updated_at = now()
    `;
  } catch (err) {
    throw missingProject(err, projectId) ?? err;
  }
  await sql`UPDATE projects SET updated_at = now() WHERE id = ${projectId}`;
}

export interface VersionedFile {
  content: string;
  version: number;
}

export async function getProjectFile(
  projectId: string,
  path: string,
): Promise<VersionedFile | null> {
  const sql = db();
  if (!sql) {
    const content = memProjects().get(projectId)?.[path];
    return content === undefined ? null : { content, version: 0 };
  }
  const rows = (await sql`
    SELECT content, version FROM project_files
    WHERE project_id = ${projectId} AND path = ${path} LIMIT 1
  `) as Array<{ content: string; version: number }>;
  return rows[0] ? { content: rows[0].content, version: Number(rows[0].version) } : null;
}

/**
 * Writes only if the file is still at `expected` (null = the file must not
 * exist yet). False means someone else wrote it in between: re-read and retry.
 */
export async function writeProjectFileIfVersion(
  projectId: string,
  path: string,
  content: string,
  expected: number | null,
): Promise<boolean> {
  const sql = db();
  if (!sql) {
    await writeProjectFile(projectId, path, content);
    return true;
  }
  if (!isValidProjectId(projectId)) {
    throw new Error(`Identificativo di progetto non valido: "${projectId}"`);
  }
  let rows: unknown[];
  try {
    rows = (
      expected === null
        ? await sql`
            INSERT INTO project_files (project_id, path, content)
            VALUES (${projectId}, ${path}, ${content})
            ON CONFLICT (project_id, path) DO NOTHING
            RETURNING version
          `
        : await sql`
            UPDATE project_files
            SET content = ${content}, version = version + 1, updated_at = now()
            WHERE project_id = ${projectId} AND path = ${path} AND version = ${expected}
            RETURNING version
          `
    ) as unknown[];
  } catch (err) {
    throw missingProject(err, projectId) ?? err;
  }
  if (rows.length === 0) return false;
  await sql`UPDATE projects SET updated_at = now() WHERE id = ${projectId}`;
  return true;
}

/**
 * Read-modify-write of one file that cannot lose a concurrent update.
 *
 * Every editor route used to read the whole file, change it and write it
 * back: two saves close together (two quick moves, a drag during a route
 * save, the agent rewriting main.tsx while a wire is drawn in the schematic)
 * read the same state and the second erased the first, silently. Here the
 * write succeeds only on the version that was read; on conflict `change` runs
 * again on the fresh content. `change` returns null when there is nothing to
 * write, and must not have side effects: it can run more than once.
 */
export async function updateProjectFile(
  projectId: string,
  path: string,
  change: (current: string | null) => string | null | Promise<string | null>,
  attempts = 5,
): Promise<{ written: boolean; content: string | null }> {
  for (let i = 0; i < attempts; i++) {
    const current = await getProjectFile(projectId, path);
    const next = await change(current?.content ?? null);
    if (next === null || next === current?.content) {
      return { written: false, content: current?.content ?? null };
    }
    if (await writeProjectFileIfVersion(projectId, path, next, current?.version ?? null)) {
      return { written: true, content: next };
    }
  }
  throw new Error(
    `"${path}" e' stato modificato da un altro salvataggio mentre lo scrivevo: riprova`,
  );
}

export async function getChatMessages(
  projectId: string,
  limit = 80,
): Promise<ChatMessage[]> {
  const sql = db();
  if (!sql) return memChats().get(projectId) ?? [];

  const rows = (await sql`
    SELECT role, content FROM chat_messages
    WHERE project_id = ${projectId}
    ORDER BY id DESC LIMIT ${limit}
  `) as ChatMessage[];
  return rows.reverse();
}

export async function saveRevision(
  projectId: string,
  files: FsMap,
  compileSummary: unknown | null,
): Promise<void> {
  const sql = db();
  if (!sql) return;
  await sql`
    INSERT INTO project_revisions (project_id, files, author_type, compile_summary)
    VALUES (${projectId}, ${JSON.stringify(files)}::jsonb, 'agent',
            ${compileSummary ? JSON.stringify(compileSummary) : null}::jsonb)
  `;
}

export async function appendChatMessage(
  projectId: string,
  role: ChatMessage["role"],
  content: string,
): Promise<void> {
  const sql = db();
  if (!sql) {
    const chats = memChats();
    chats.set(projectId, [...(chats.get(projectId) ?? []), { role, content }]);
    return;
  }

  try {
    await sql`
      INSERT INTO chat_messages (project_id, role, content)
      VALUES (${projectId}, ${role}, ${content})
    `;
  } catch (err) {
    throw missingProject(err, projectId) ?? err;
  }
}

// ---------------------------------------------------------------------------
// Compile cache: the routed Circuit JSON validated server-side is the truth —
// exports are generated from it (Gerber = what the user sees) and the FE can
// render it instead of re-routing in the browser (routers are not
// deterministic, so FE and BE compiles could diverge).
// ---------------------------------------------------------------------------

export interface CompileCache {
  filesHash: string;
  circuitJson: unknown[];
  summary: unknown;
  createdAt: string;
  /** version of the checks engine that produced this cache */
  engineVersion: number;
}

let compileCacheDdlPromise: Promise<void> | null = null;
async function ensureCompileCacheTable(
  sql: NonNullable<ReturnType<typeof db>>,
): Promise<void> {
  // reset on failure: a transient error must not kill the cache for the
  // lifetime of this lambda instance
  compileCacheDdlPromise ??= sql`
    CREATE TABLE IF NOT EXISTS project_compiles (
      project_id text PRIMARY KEY,
      files_hash text NOT NULL,
      circuit_json jsonb NOT NULL,
      summary jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `
    .then(
      () =>
        sql`ALTER TABLE project_compiles ADD COLUMN IF NOT EXISTS engine_version int NOT NULL DEFAULT 0`,
    )
    // the half-routed drawings live apart from the board: see savePreviewCircuit
    .then(
      () =>
        sql`ALTER TABLE project_compiles ADD COLUMN IF NOT EXISTS preview_circuit_json jsonb`,
    )
    .then(
      () => sql`ALTER TABLE project_compiles ADD COLUMN IF NOT EXISTS preview_at timestamptz`,
    )
    .then(() => undefined)
    .catch((err) => {
      compileCacheDdlPromise = null;
      throw err;
    });
  await compileCacheDdlPromise;
}

/**
 * A compile that failed because of the ROUTER must not wipe the last good one.
 *
 * It really happened: the routing service answered 500, the compile ended
 * with a single trace on the whole board, and that result overwrote a
 * complete board in the cache. From that moment there was nothing left to
 * look at, and the fault belonged to an external service.
 *
 * The rejection is deliberately NARROW: only when the new attempt carries a
 * routing error and the previous one was fine. A board that loses traces
 * because the user removed components must be saveable, so counts are not
 * what matters — the cause is.
 */
function routingFailed(summary: unknown): boolean {
  const errors = (summary as { errors?: Array<{ type?: string }> } | null)?.errors;
  return Array.isArray(errors) && errors.some((e) => e?.type === "pcb_autorouting_error");
}

/**
 * A compile that produced NO BOARD: a syntax error in the sources, an
 * exception in the compiler. Its circuit is `[]`, and saved over a good row it
 * became the board everyone saw — and the one /api/export turned into empty
 * Gerbers. It is not a board: it is a failure, and failures are reported, not
 * stored in place of the last thing that worked.
 */
export function compileBroken(circuitJson: unknown[], summary: unknown): boolean {
  const errors = (summary as { errors?: Array<{ type?: string }> } | null)?.errors;
  if (Array.isArray(errors) && errors.some((e) => e?.type === "compile_exception")) return true;
  return !hasBoard(circuitJson);
}

/** whether a Circuit JSON carries a board at all */
export function hasBoard(circuitJson: unknown): boolean {
  return (
    Array.isArray(circuitJson) &&
    circuitJson.some((el) => (el as { type?: unknown } | null)?.type === "pcb_board")
  );
}

export interface SaveCompileResult {
  saved: boolean;
  /** the row already in cache was kept: the new result was worse than it */
  keptPrevious?: boolean;
  /** why it was not saved, in Italian, ready to be shown */
  reason?: string;
}

export async function saveCompileCache(
  projectId: string,
  hash: string,
  circuitJson: unknown[],
  summary: unknown,
  engineVersion = 0,
  opts: {
    /**
     * Save only if the row is still the one read at `createdAt` with this hash.
     * For whoever RE-EVALUATES a cached board (recheck): if a compile has saved
     * a newer board in the meantime, re-evaluating the old one must not put it
     * back.
     */
    ifUnchangedSince?: { filesHash: string; createdAt: unknown };
  } = {},
): Promise<SaveCompileResult> {
  const sql = db();
  if (!sql) return { saved: false };
  await ensureCompileCacheTable(sql);

  // the preview of a compile that is not being saved must not stay on screen
  const dropPreview = () =>
    sql`
      UPDATE project_compiles SET preview_circuit_json = NULL, preview_at = NULL
      WHERE project_id = ${projectId}
    `.catch(() => {});

  if (compileBroken(circuitJson, summary)) {
    // a cheap question, not the whole row: is there a board in cache?
    const [row] = (await sql`
      SELECT circuit_json @> '[{"type":"pcb_board"}]'::jsonb AS has_board
      FROM project_compiles WHERE project_id = ${projectId}
    `.catch(() => [])) as Array<{ has_board: boolean }>;
    if (row?.has_board) {
      await dropPreview();
      return {
        saved: false,
        keptPrevious: true,
        reason:
          "la compilazione non ha prodotto una scheda: resta salvata l'ultima buona, e non corrisponde a questi file finche' l'errore non e' corretto",
      };
    }
  }

  if (routingFailed(summary)) {
    const previous = await getCompileCache(projectId).catch(() => null);
    const previousOk =
      previous && !routingFailed(previous.summary) &&
      (previous.summary as { ok?: boolean } | null)?.ok === true;
    if (previousOk) {
      await dropPreview();
      return {
        saved: false,
        keptPrevious: true,
        reason: "lo sbroglio e' fallito: resta salvata l'ultima scheda buona",
      };
    }
  }

  const json = JSON.stringify(circuitJson);
  const sintesi = JSON.stringify(summary);
  const condizione = opts.ifUnchangedSince;
  if (condizione) {
    const quando =
      condizione.createdAt instanceof Date
        ? condizione.createdAt.toISOString()
        : String(condizione.createdAt);
    /*
     * The row is replaced only if it is still the one that was read. The
     * millisecond of slack is the precision a JS Date keeps of a timestamptz:
     * without it the row just read would look newer than itself.
     */
    const rows = (await sql`
      INSERT INTO project_compiles (project_id, files_hash, circuit_json, summary, engine_version)
      VALUES (${projectId}, ${hash}, ${json}::jsonb, ${sintesi}::jsonb, ${engineVersion})
      ON CONFLICT (project_id)
      DO UPDATE SET files_hash = EXCLUDED.files_hash,
                    circuit_json = EXCLUDED.circuit_json,
                    summary = EXCLUDED.summary,
                    engine_version = EXCLUDED.engine_version,
                    preview_circuit_json = NULL,
                    preview_at = NULL,
                    created_at = now()
      WHERE project_compiles.files_hash = ${condizione.filesHash}
        AND project_compiles.created_at < ${quando}::timestamptz + interval '1 millisecond'
      RETURNING project_id
    `) as Array<{ project_id: string }>;
    return rows.length > 0
      ? { saved: true }
      : {
          saved: false,
          keptPrevious: true,
          reason: "nel frattempo e' stata salvata una scheda piu' recente: non la sovrascrivo",
        };
  }

  // the final save wins over any preview still in flight: it clears it
  await sql`
    INSERT INTO project_compiles (project_id, files_hash, circuit_json, summary, engine_version)
    VALUES (${projectId}, ${hash}, ${json}::jsonb, ${sintesi}::jsonb, ${engineVersion})
    ON CONFLICT (project_id)
    DO UPDATE SET files_hash = EXCLUDED.files_hash,
                  circuit_json = EXCLUDED.circuit_json,
                  summary = EXCLUDED.summary,
                  engine_version = EXCLUDED.engine_version,
                  preview_circuit_json = NULL,
                  preview_at = NULL,
                  created_at = now()
  `;
  return { saved: true };
}

/**
 * Stores the HALF-ROUTED drawing, apart from the board.
 *
 * This is what lets you watch the board take shape: during a long compile the
 * copper forms in stages, and anyone with the page open can watch it instead
 * of staring at the previous drawing for eight minutes.
 *
 * It used to be written INTO `circuit_json`, the column the exports read, with
 * the old hash and the old summary: for the length of a compile the Gerber of
 * the project was a board halfway through routing, certified by the checks of
 * the previous one. And since previews are fire-and-forget, one could land
 * after the final save and replace the finished board with a half-done one.
 *
 * Now it has its own columns, which only getPreviewCircuit reads. It carries
 * the moment it was ISSUED, and it is written only if no final save happened
 * after that moment: the final save clears it, and a preview that arrives late
 * finds the row newer than itself and is dropped.
 */
export async function savePreviewCircuit(
  projectId: string,
  circuitJson: unknown[],
): Promise<void> {
  const emessa = new Date().toISOString();
  const sql = db();
  if (!sql) return;
  try {
    await ensureCompileCacheTable(sql);
    await sql`
      UPDATE project_compiles
      SET preview_circuit_json = ${JSON.stringify(circuitJson)}::jsonb,
          preview_at = ${emessa}::timestamptz
      WHERE project_id = ${projectId} AND created_at < ${emessa}::timestamptz
    `;
  } catch {
    // the preview is an extra: if it fails, the compile goes on
  }
}

/**
 * The drawing of a compile still running, when there is one newer than the
 * saved board. Never a source for exports: it has no checks behind it.
 */
export async function getPreviewCircuit(
  projectId: string,
): Promise<{ circuitJson: unknown[]; previewAt: string } | null> {
  const sql = db();
  if (!sql) return null;
  try {
    await ensureCompileCacheTable(sql);
    const [row] = (await sql`
      SELECT preview_circuit_json, preview_at FROM project_compiles
      WHERE project_id = ${projectId}
        AND preview_circuit_json IS NOT NULL AND preview_at > created_at
    `) as Array<{ preview_circuit_json: unknown[]; preview_at: string }>;
    return row ? { circuitJson: row.preview_circuit_json, previewAt: row.preview_at } : null;
  } catch {
    return null;
  }
}

export async function getCompileCache(
  projectId: string,
): Promise<CompileCache | null> {
  const sql = db();
  if (!sql) return null;
  try {
    await ensureCompileCacheTable(sql);
    const [row] = (await sql`
      SELECT files_hash, circuit_json, summary, created_at, engine_version
      FROM project_compiles WHERE project_id = ${projectId}
    `) as Array<{
      files_hash: string;
      circuit_json: unknown[];
      summary: unknown;
      created_at: string;
      engine_version: number;
    }>;
    if (!row) return null;
    return {
      filesHash: row.files_hash,
      circuitJson: row.circuit_json,
      summary: row.summary,
      createdAt: row.created_at,
      engineVersion: Number(row.engine_version ?? 0),
    };
  } catch {
    return null;
  }
}

export interface ProjectCheckStatus {
  drcViolations: number;
  prcViolations: number;
  allGreen: boolean;
  checksStale: boolean;
}

/** checks status for the organization console: one query for all projects */
export async function getCheckStatusByProject(
  projectIds: string[],
  currentEngineVersion: number,
): Promise<Record<string, ProjectCheckStatus>> {
  const sql = db();
  if (!sql || projectIds.length === 0) return {};
  try {
    await ensureCompileCacheTable(sql);
    const rows = (await sql`
      SELECT project_id, summary->'targets'->>'drcViolations' AS drc,
             summary->'targets'->>'prcViolations' AS prc,
             summary->'targets'->>'allGreen' AS green,
             engine_version
      FROM project_compiles WHERE project_id = ANY(${projectIds})
    `) as Array<{ project_id: string; drc: string; prc: string; green: string; engine_version: number }>;
    return Object.fromEntries(
      rows.map((r) => [
        r.project_id,
        {
          drcViolations: Number(r.drc ?? 0),
          prcViolations: Number(r.prc ?? 0),
          allGreen: r.green === "true",
          checksStale: Number(r.engine_version ?? 0) < currentEngineVersion,
        },
      ]),
    );
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Route variants (Fase 3.d): per-section routing candidates generated by the
// variant engine. The agent (or the user via chat) re-picks a variant with
// pick_variant; the assembled circuit in project_compiles is then rebuilt.
// ---------------------------------------------------------------------------

export interface StoredVariant {
  sectionKey: string;
  label: string;
  traces: unknown[];
  stats: { traces: number; vias: number; lengthMm: number };
  drc: number;
  picked: boolean;
}

let routeVariantsDdlPromise: Promise<void> | null = null;
async function ensureRouteVariantsTable(
  sql: NonNullable<ReturnType<typeof db>>,
): Promise<void> {
  routeVariantsDdlPromise ??= sql`
    CREATE TABLE IF NOT EXISTS route_variants (
      project_id text NOT NULL,
      section_key text NOT NULL,
      variant_label text NOT NULL,
      files_hash text NOT NULL,
      pcb_traces jsonb NOT NULL,
      stats jsonb NOT NULL,
      drc int NOT NULL DEFAULT 0,
      picked boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (project_id, section_key, variant_label)
    )
  `
    .then(() => undefined)
    .catch((err) => {
      routeVariantsDdlPromise = null;
      throw err;
    });
  await routeVariantsDdlPromise;
}

/** replace all variants of a project after a compile with variants */
export async function saveRouteVariants(
  projectId: string,
  filesHash: string,
  sections: Array<{
    sectionKey: string;
    candidates: Array<{
      label: string;
      traces: unknown[];
      stats: { traces: number; vias: number; lengthMm: number };
      drc: number;
    }>;
    pickedLabel: string;
  }>,
): Promise<void> {
  const sql = db();
  if (!sql) return;
  await ensureRouteVariantsTable(sql);
  await sql`DELETE FROM route_variants WHERE project_id = ${projectId}`;
  for (const section of sections) {
    for (const candidate of section.candidates) {
      await sql`
        INSERT INTO route_variants
          (project_id, section_key, variant_label, files_hash, pcb_traces, stats, drc, picked)
        VALUES (
          ${projectId}, ${section.sectionKey}, ${candidate.label}, ${filesHash},
          ${JSON.stringify(candidate.traces)}::jsonb,
          ${JSON.stringify(candidate.stats)}::jsonb,
          ${candidate.drc}, ${candidate.label === section.pickedLabel}
        )
      `;
    }
  }
}

export async function getRouteVariants(projectId: string): Promise<{
  filesHash: string | null;
  sections: Array<{
    sectionKey: string;
    pickedLabel: string | null;
    candidates: StoredVariant[];
  }>;
}> {
  const sql = db();
  if (!sql) return { filesHash: null, sections: [] };
  try {
    await ensureRouteVariantsTable(sql);
    const rows = (await sql`
      SELECT section_key, variant_label, files_hash, pcb_traces, stats, drc, picked
      FROM route_variants WHERE project_id = ${projectId}
      ORDER BY section_key, variant_label
    `) as Array<{
      section_key: string;
      variant_label: string;
      files_hash: string;
      pcb_traces: unknown[];
      stats: { traces: number; vias: number; lengthMm: number };
      drc: number;
      picked: boolean;
    }>;
    const sections = new Map<
      string,
      { sectionKey: string; pickedLabel: string | null; candidates: StoredVariant[] }
    >();
    let filesHash: string | null = null;
    for (const row of rows) {
      filesHash = row.files_hash;
      const section = sections.get(row.section_key) ?? {
        sectionKey: row.section_key,
        pickedLabel: null,
        candidates: [],
      };
      if (row.picked) section.pickedLabel = row.variant_label;
      section.candidates.push({
        sectionKey: row.section_key,
        label: row.variant_label,
        traces: row.pcb_traces,
        stats: row.stats,
        drc: row.drc,
        picked: row.picked,
      });
      sections.set(row.section_key, section);
    }
    return { filesHash, sections: [...sections.values()] };
  } catch {
    return { filesHash: null, sections: [] };
  }
}

export async function markVariantPicked(
  projectId: string,
  sectionKey: string,
  variantLabel: string,
): Promise<void> {
  const sql = db();
  if (!sql) return;
  await ensureRouteVariantsTable(sql);
  await sql`
    UPDATE route_variants SET picked = (variant_label = ${variantLabel})
    WHERE project_id = ${projectId} AND section_key = ${sectionKey}
  `;
}
