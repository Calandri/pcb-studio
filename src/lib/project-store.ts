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

const DEMO_MAIN = `export default () => (
  <board width="34mm" height="24mm" autorouter="auto_cloud">
    <chip
      name="U1"
      footprint="soic8"
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
    <resistor name="R1" resistance="10k" footprint="0402" pcbX={-10} pcbY={6} />
    <resistor name="R2" resistance="47k" footprint="0402" pcbX={-10} pcbY={0} />
    <resistor name="R3" resistance="220" footprint="0402" pcbX={10} pcbY={6} />
    <capacitor name="C1" capacitance="10uF" footprint="0603" pcbX={-10} pcbY={-6} />
    <led name="D1" footprint="0603" pcbX={10} pcbY={-6} />
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

/** run nell'ultima ora per IP: base del rate limit di /api/agent */
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
}

let compileCacheDdlPromise: Promise<void> | null = null;
async function ensureCompileCacheTable(
  sql: NonNullable<ReturnType<typeof db>>,
): Promise<void> {
  compileCacheDdlPromise ??= sql`
    CREATE TABLE IF NOT EXISTS project_compiles (
      project_id text PRIMARY KEY,
      files_hash text NOT NULL,
      circuit_json jsonb NOT NULL,
      summary jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `.then(() => undefined);
  await compileCacheDdlPromise;
}

export async function saveCompileCache(
  projectId: string,
  hash: string,
  circuitJson: unknown[],
  summary: unknown,
): Promise<void> {
  const sql = db();
  if (!sql) return;
  await ensureCompileCacheTable(sql);
  await sql`
    INSERT INTO project_compiles (project_id, files_hash, circuit_json, summary)
    VALUES (${projectId}, ${hash}, ${JSON.stringify(circuitJson)}::jsonb,
            ${JSON.stringify(summary)}::jsonb)
    ON CONFLICT (project_id)
    DO UPDATE SET files_hash = EXCLUDED.files_hash,
                  circuit_json = EXCLUDED.circuit_json,
                  summary = EXCLUDED.summary,
                  created_at = now()
  `;
}

export async function getCompileCache(
  projectId: string,
): Promise<CompileCache | null> {
  const sql = db();
  if (!sql) return null;
  try {
    await ensureCompileCacheTable(sql);
    const [row] = (await sql`
      SELECT files_hash, circuit_json, summary, created_at
      FROM project_compiles WHERE project_id = ${projectId}
    `) as Array<{
      files_hash: string;
      circuit_json: unknown[];
      summary: unknown;
      created_at: string;
    }>;
    if (!row) return null;
    return {
      filesHash: row.files_hash,
      circuitJson: row.circuit_json,
      summary: row.summary,
      createdAt: row.created_at,
    };
  } catch {
    return null;
  }
}
