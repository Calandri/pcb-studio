import { neon } from "@neondatabase/serverless";
import { createHash } from "node:crypto";
/** stable hash of the project sources: validity key for the compile cache */
export function filesHash(fsMap) {
    const hash = createHash("sha256");
    for (const path of Object.keys(fsMap).sort()) {
        hash.update(path);
        hash.update("\0");
        hash.update(fsMap[path]);
        hash.update("\0");
    }
    return hash.digest("hex").slice(0, 32);
}
// Il template e' l'esempio di stile implicito di ogni progetto nuovo: ogni
// componente ha la sua sezione funzionale e ogni sezione la sua cornice, cosi'
// il modello parte da uno schematico gia' leggibile invece che da una scheda
// piatta da cui imparerebbe l'abitudine sbagliata.
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
const globalStore = globalThis;
function memProjects() {
    return (globalStore.__pcbStudioProjects ??= new Map());
}
function memChats() {
    return (globalStore.__pcbStudioChats ??= new Map());
}
export async function getProject(projectId) {
    const sql = db();
    if (!sql) {
        const store = memProjects();
        if (!store.has(projectId))
            store.set(projectId, { "main.tsx": DEMO_MAIN });
        return store.get(projectId);
    }
    const rows = (await sql `
    SELECT path, content FROM project_files WHERE project_id = ${projectId}
  `);
    if (rows.length === 0) {
        await sql `
      INSERT INTO projects (id) VALUES (${projectId}) ON CONFLICT (id) DO NOTHING
    `;
        await sql `
      INSERT INTO project_files (project_id, path, content)
      VALUES (${projectId}, 'main.tsx', ${DEMO_MAIN})
      ON CONFLICT (project_id, path) DO NOTHING
    `;
        return { "main.tsx": DEMO_MAIN };
    }
    return Object.fromEntries(rows.map((r) => [r.path, r.content]));
}
export async function writeProjectFile(projectId, path, content) {
    const sql = db();
    if (!sql) {
        const store = memProjects();
        const fsMap = store.get(projectId) ?? {};
        fsMap[path] = content;
        store.set(projectId, fsMap);
        return;
    }
    await sql `
    INSERT INTO projects (id) VALUES (${projectId}) ON CONFLICT (id) DO NOTHING
  `;
    await sql `
    INSERT INTO project_files (project_id, path, content)
    VALUES (${projectId}, ${path}, ${content})
    ON CONFLICT (project_id, path)
    DO UPDATE SET content = EXCLUDED.content, updated_at = now()
  `;
    await sql `UPDATE projects SET updated_at = now() WHERE id = ${projectId}`;
}
export async function getChatMessages(projectId, limit = 80) {
    const sql = db();
    if (!sql)
        return memChats().get(projectId) ?? [];
    const rows = (await sql `
    SELECT role, content FROM chat_messages
    WHERE project_id = ${projectId}
    ORDER BY id DESC LIMIT ${limit}
  `);
    return rows.reverse();
}
export async function saveRevision(projectId, files, compileSummary) {
    const sql = db();
    if (!sql)
        return;
    await sql `
    INSERT INTO project_revisions (project_id, files, author_type, compile_summary)
    VALUES (${projectId}, ${JSON.stringify(files)}::jsonb, 'agent',
            ${compileSummary ? JSON.stringify(compileSummary) : null}::jsonb)
  `;
}
export async function recordAgentRun(run) {
    const sql = db();
    if (!sql)
        return;
    await sql `
    INSERT INTO agent_runs (project_id, ip, steps, tokens_in, tokens_out, stop_reason, duration_ms)
    VALUES (${run.projectId}, ${run.ip}, ${run.steps}, ${run.tokensIn},
            ${run.tokensOut}, ${run.stopReason}, ${run.durationMs})
  `;
}
/** run nell'ultima ora per IP: base del rate limit di /api/agent */
export async function countRecentRunsByIp(ip) {
    const sql = db();
    if (!sql)
        return 0;
    const [row] = (await sql `
    SELECT count(*)::int AS n FROM agent_runs
    WHERE ip = ${ip} AND created_at > now() - interval '1 hour'
  `);
    return row?.n ?? 0;
}
export async function appendChatMessage(projectId, role, content) {
    const sql = db();
    if (!sql) {
        const chats = memChats();
        chats.set(projectId, [...(chats.get(projectId) ?? []), { role, content }]);
        return;
    }
    await sql `
    INSERT INTO projects (id) VALUES (${projectId}) ON CONFLICT (id) DO NOTHING
  `;
    await sql `
    INSERT INTO chat_messages (project_id, role, content)
    VALUES (${projectId}, ${role}, ${content})
  `;
}
let compileCacheDdlPromise = null;
async function ensureCompileCacheTable(sql) {
    // reset on failure: a transient error must not kill the cache for the
    // lifetime of this lambda instance
    compileCacheDdlPromise ??= sql `
    CREATE TABLE IF NOT EXISTS project_compiles (
      project_id text PRIMARY KEY,
      files_hash text NOT NULL,
      circuit_json jsonb NOT NULL,
      summary jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `
        .then(() => undefined)
        .catch((err) => {
        compileCacheDdlPromise = null;
        throw err;
    });
    await compileCacheDdlPromise;
}
export async function saveCompileCache(projectId, hash, circuitJson, summary) {
    const sql = db();
    if (!sql)
        return;
    await ensureCompileCacheTable(sql);
    await sql `
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
export async function getCompileCache(projectId) {
    const sql = db();
    if (!sql)
        return null;
    try {
        await ensureCompileCacheTable(sql);
        const [row] = (await sql `
      SELECT files_hash, circuit_json, summary, created_at
      FROM project_compiles WHERE project_id = ${projectId}
    `);
        if (!row)
            return null;
        return {
            filesHash: row.files_hash,
            circuitJson: row.circuit_json,
            summary: row.summary,
            createdAt: row.created_at,
        };
    }
    catch {
        return null;
    }
}
let routeVariantsDdlPromise = null;
async function ensureRouteVariantsTable(sql) {
    routeVariantsDdlPromise ??= sql `
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
export async function saveRouteVariants(projectId, filesHash, sections) {
    const sql = db();
    if (!sql)
        return;
    await ensureRouteVariantsTable(sql);
    await sql `DELETE FROM route_variants WHERE project_id = ${projectId}`;
    for (const section of sections) {
        for (const candidate of section.candidates) {
            await sql `
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
export async function getRouteVariants(projectId) {
    const sql = db();
    if (!sql)
        return { filesHash: null, sections: [] };
    try {
        await ensureRouteVariantsTable(sql);
        const rows = (await sql `
      SELECT section_key, variant_label, files_hash, pcb_traces, stats, drc, picked
      FROM route_variants WHERE project_id = ${projectId}
      ORDER BY section_key, variant_label
    `);
        const sections = new Map();
        let filesHash = null;
        for (const row of rows) {
            filesHash = row.files_hash;
            const section = sections.get(row.section_key) ?? {
                sectionKey: row.section_key,
                pickedLabel: null,
                candidates: [],
            };
            if (row.picked)
                section.pickedLabel = row.variant_label;
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
    }
    catch {
        return { filesHash: null, sections: [] };
    }
}
export async function markVariantPicked(projectId, sectionKey, variantLabel) {
    const sql = db();
    if (!sql)
        return;
    await ensureRouteVariantsTable(sql);
    await sql `
    UPDATE route_variants SET picked = (variant_label = ${variantLabel})
    WHERE project_id = ${projectId} AND section_key = ${sectionKey}
  `;
}
