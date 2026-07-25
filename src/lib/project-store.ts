import { neon } from "@neondatabase/serverless";

export type FsMap = Record<string, string>;
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

const DEMO_MAIN = `export default () => (
  <board width="34mm" height="24mm">
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
