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
 * A valid project identifier: letters, digits, dashes. Needed because
 * reading CREATES the project if it does not exist (that is how you open a
 * new project by typing a name in the URL): without a check, a malformed
 * address like ?project=- leaves behind an ownerless ghost project that
 * then shows up in everyone's list.
 */
const PROJECT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,59}$/i;

export function isValidProjectId(id: string): boolean {
  return PROJECT_ID_RE.test(id);
}

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

  if (rows.length === 0) {
    // a malformed identifier creates nothing: the example project is shown
    // and nothing more, so the list stays clean
    if (!isValidProjectId(projectId)) return { "main.tsx": DEMO_MAIN };
    await sql`
      INSERT INTO projects (id) VALUES (${projectId}) ON CONFLICT (id) DO NOTHING
    `;
    await sql`
      INSERT INTO project_files (project_id, path, content)
      VALUES (${projectId}, 'main.tsx', ${DEMO_MAIN})
      ON CONFLICT (project_id, path) DO NOTHING
    `;
    return { "main.tsx": DEMO_MAIN };
  }

  return Object.fromEntries(rows.map((r) => [r.path, r.content]));
}

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
  await sql`
    INSERT INTO projects (id) VALUES (${projectId}) ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO project_files (project_id, path, content)
    VALUES (${projectId}, ${path}, ${content})
    ON CONFLICT (project_id, path)
    DO UPDATE SET content = EXCLUDED.content, updated_at = now()
  `;
  await sql`UPDATE projects SET updated_at = now() WHERE id = ${projectId}`;
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

export interface AgentRunStats {
  projectId: string;
  ip: string | null;
  steps: number;
  tokensIn: number;
  tokensOut: number;
  stopReason: string;
  durationMs: number;
}

export async function recordAgentRun(run: AgentRunStats): Promise<void> {
  const sql = db();
  if (!sql) return;
  await sql`
    INSERT INTO agent_runs (project_id, ip, steps, tokens_in, tokens_out, stop_reason, duration_ms)
    VALUES (${run.projectId}, ${run.ip}, ${run.steps}, ${run.tokensIn},
            ${run.tokensOut}, ${run.stopReason}, ${run.durationMs})
  `;
}

/** runs in the last hour per IP: the basis of the /api/agent rate limit */
export async function countRecentRunsByIp(ip: string): Promise<number> {
  const sql = db();
  if (!sql) return 0;
  const [row] = (await sql`
    SELECT count(*)::int AS n FROM agent_runs
    WHERE ip = ${ip} AND created_at > now() - interval '1 hour'
  `) as Array<{ n: number }>;
  return row?.n ?? 0;
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

  await sql`
    INSERT INTO projects (id) VALUES (${projectId}) ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO chat_messages (project_id, role, content)
    VALUES (${projectId}, ${role}, ${content})
  `;
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

export async function saveCompileCache(
  projectId: string,
  hash: string,
  circuitJson: unknown[],
  summary: unknown,
  engineVersion = 0,
): Promise<{ saved: boolean; keptPrevious?: boolean }> {
  const sql = db();
  if (!sql) return { saved: false };
  await ensureCompileCacheTable(sql);

  if (routingFailed(summary)) {
    const previous = await getCompileCache(projectId).catch(() => null);
    const previousOk =
      previous && !routingFailed(previous.summary) &&
      (previous.summary as { ok?: boolean } | null)?.ok === true;
    if (previousOk) return { saved: false, keptPrevious: true };
  }

  await sql`
    INSERT INTO project_compiles (project_id, files_hash, circuit_json, summary, engine_version)
    VALUES (${projectId}, ${hash}, ${JSON.stringify(circuitJson)}::jsonb,
            ${JSON.stringify(summary)}::jsonb, ${engineVersion})
    ON CONFLICT (project_id)
    DO UPDATE SET files_hash = EXCLUDED.files_hash,
                  circuit_json = EXCLUDED.circuit_json,
                  summary = EXCLUDED.summary,
                  engine_version = EXCLUDED.engine_version,
                  created_at = now()
  `;
  return { saved: true };
}

/**
 * Updates ONLY the drawing, leaving the summary and hash alone.
 *
 * This is what lets you watch the board take shape: during a long compile the
 * copper forms in stages, and anyone with the page open can watch it instead
 * of staring at the previous drawing for eight minutes. The summary is NOT
 * touched: it is only coherent when the compile is finished, and showing
 * "ready for the factory" percentages computed halfway through would be worse
 * than showing nothing.
 */
export async function savePreviewCircuit(
  projectId: string,
  circuitJson: unknown[],
): Promise<void> {
  const sql = db();
  if (!sql) return;
  try {
    await ensureCompileCacheTable(sql);
    await sql`
      UPDATE project_compiles
      SET circuit_json = ${JSON.stringify(circuitJson)}::jsonb, created_at = now()
      WHERE project_id = ${projectId}
    `;
  } catch {
    // the preview is an extra: if it fails, the compile goes on
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
