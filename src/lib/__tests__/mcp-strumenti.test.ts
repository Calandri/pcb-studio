import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The MCP tools called as a client calls them: a JSON-RPC tools/call over the
 * route, with a personal token. The database is out of the way: the token,
 * the access rule, the log and the stores are stand-ins.
 */
const stato = vi.hoisted(() => ({
  accesso: "edit" as "none" | "view" | "edit",
  rilascio: null as null | (() => Promise<unknown>),
  files: {} as Record<string, string>,
}));
vi.mock("@/lib/api-tokens", () => ({ resolveApiToken: vi.fn(async () => ({ userId: "u1", email: "u1@example.com" })) }));
vi.mock("@/lib/acl", () => ({
  projectAccess: vi.fn(async () => stato.accesso),
  claimProject: vi.fn(async () => {}),
  listAccessibleProjects: vi.fn(async () => []),
  requireProjectAccess: vi.fn(async () => ({ viewer: null, ok: stato.accesso === "edit" })),
}));
vi.mock("@/lib/activity-store", () => ({
  COMPILE_START: "compila la scheda",
  logActivity: vi.fn(async () => {}),
  recordTool: vi.fn(async (_p: string, _a: string, _t: string, _d: string, run: () => Promise<unknown>) => run()),
  readCompileRun: vi.fn(async () => null),
}));
vi.mock("@/lib/manual-edits-store", () => ({
  rilasciaPezzi: vi.fn(async () => {
    if (stato.rilascio) return stato.rilascio();
    return { edits: { schematic_placements: [], pcb_placements: [], manual_trace_hints: [], pcb_routes: [] }, written: true };
  }),
}));
vi.mock("@/lib/project-store", async (originale) => {
  const vero = await originale<typeof import("@/lib/project-store")>();
  return {
    ...vero,
    getProject: vi.fn(async () => ({ ...stato.files })),
    getCompileCache: vi.fn(async () => null),
    writeProjectFile: vi.fn(async (_p: string, path: string, content: string) => {
      stato.files[path] = content;
    }),
  };
});

const { POST } = await import("@/app/api/mcp/[transport]/route");

/** a tools/call as a client sends it; the answer's text, parsed, and whether it is an error */
async function chiamaStrumento(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; result: Record<string, unknown> }> {
  const r = await POST(
    new Request("http://localhost/api/mcp/mcp", {
      method: "POST",
      headers: { authorization: "Bearer pcbs_prova", "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
  );
  const corpo = await r.text();
  const riga = corpo.split("\n").find((l) => l.startsWith("data: ")) ?? corpo;
  const msg = JSON.parse(riga.replace(/^data: /, "")) as { result?: { isError?: boolean; content: Array<{ text: string }> }; error?: unknown };
  if (!msg.result) throw new Error(`nessun risultato: ${corpo.slice(0, 400)}`);
  return { isError: msg.result.isError === true, result: JSON.parse(msg.result.content[0].text) as Record<string, unknown> };
}

describe("release_manual_edits", () => {
  beforeEach(() => {
    stato.accesso = "edit";
    stato.rilascio = null;
  });

  it("frees the named parts", async () => {
    const r = await chiamaStrumento("release_manual_edits", { projectId: "p", names: ["J1"] });
    expect(r).toMatchObject({ isError: false, result: { ok: true, written: true } });
  });

  it("a failure of the database is a clear tool error, with no host, address or password in it", async () => {
    stato.rilascio = async () => {
      throw Object.assign(new Error('password authentication failed for user "neondb_owner" at ep-cool-name-123456.eu-central-1.aws.neon.tech (10.1.2.3)'), { code: "28P01" });
    };
    const r = await chiamaStrumento("release_manual_edits", { projectId: "p", names: ["J1"] });
    expect(r.isError).toBe(true);
    expect(r.result.error).toBe("posizioni a mano NON liberate (autenticazione rifiutata [28P01]): riprova tra poco; se continua, liberale dalla pagina");
    expect(JSON.stringify(r.result)).not.toMatch(/neondb_owner|neon\.tech|10\.1\.2\.3/);
  });
});
