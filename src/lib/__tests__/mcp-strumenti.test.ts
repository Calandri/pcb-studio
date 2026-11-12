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

const compilazioni = vi.hoisted(() => ({ n: 0 }));
vi.mock("@/lib/compile", async (originale) => ({
  ...(await originale<typeof import("@/lib/compile")>()),
  compileProject: vi.fn(async () => {
    compilazioni.n++;
    throw new Error("nessuna compilazione deve partire da sola");
  }),
}));

const { POST } = await import("@/app/api/mcp/[transport]/route");
const { DESIGN_RULES_PATH, MAX_REGOLE_CHARS, resolveDesignRules } = await import("@/lib/design-rules");

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

describe("write_file of design-rules.json", () => {
  beforeEach(() => {
    stato.accesso = "edit";
    stato.files = { "main.tsx": "export default () => <board />" };
    compilazioni.n = 0;
  });
  const scrivi = (content: string) => chiamaStrumento("write_file", { projectId: "p", path: DESIGN_RULES_PATH, content });

  it("a valid file is written as the panel writes it, read back by read_project and by the rules, and nothing compiles", async () => {
    const r = await scrivi(JSON.stringify({ preset: "custom", rules: { minTraceWidthMm: 0.15, minClearanceMm: 0.15, componentCourtyardExcessMm: 0.25, autoroute: false, clearanceByPairMm: { "pad-via": 0.1 } } }));
    expect(r.isError).toBe(false);
    expect(r.result).toMatchObject({ ok: true, path: DESIGN_RULES_PATH, preset: "custom" });
    const letto = await chiamaStrumento("read_project", { projectId: "p" });
    const file = (letto.result.files as Record<string, string>)[DESIGN_RULES_PATH];
    expect(file).toBeDefined();
    const regole = resolveDesignRules({ [DESIGN_RULES_PATH]: file });
    expect(regole).toMatchObject({ preset: "custom", isCustom: true });
    expect(regole.warnings).toBeUndefined();
    expect(regole.rules).toMatchObject({ minTraceWidthMm: 0.15, minClearanceMm: 0.15, componentCourtyardExcessMm: 0.25, autoroute: false, clearanceByPairMm: { "pad-via": 0.1 } });
    // a factory preset alone
    expect((await scrivi('{"preset": "oshpark"}')).result).toMatchObject({ ok: true, preset: "oshpark" });
    expect(compilazioni.n).toBe(0);
  });

  it("every wrong file is refused whole, with the field and its limit, and nothing is written", async () => {
    const prima = { ...stato.files };
    const casi: Array<[string, RegExp]> = [
      ["{ preset: custom", /non e' un JSON valido/],
      ['{"preset": "custom", "rules": {"minTraceWidthMm": NaN}}', /non e' un JSON valido/],
      ['{"preset": "custom", "rules": {"minTraceWidthMm": -0.1}}', /minTraceWidthMm: -0\.1 fuori dai limiti 0\.05\.\.2/],
      ['{"preset": "custom", "rules": {"minClearanceMm": 1e9}}', /minClearanceMm: 1000000000 fuori dai limiti 0\.05\.\.2/],
      ['{"preset": "custom", "rules": {"viaCostMm": 1e999}}', /viaCostMm: deve essere un numero \(limiti 0\.\.50\)/],
      ['{"preset": "custom", "rules": {"componentCourtyardExcessMm": "0.2"}}', /componentCourtyardExcessMm: deve essere un numero \(limiti 0\.\.1\)/],
      ['{"preset": "custom", "rules": {"componentCourtyardExcessMm": 1.5}}', /componentCourtyardExcessMm: 1\.5 fuori dai limiti 0\.\.1/],
      ['{"preset": "custom", "rules": {"autoroute": "no"}}', /autoroute: deve essere true o false/],
      ['{"preset": "custom", "rules": {"minTraceWidthMm": 0.3}}', /targetTraceWidthMm 0\.25 e' sotto il minimo 0\.3$/],
      ['{"preset": "custom", "rules": {"spessoreRame": 35}}', /rules\.spessoreRame: campo sconosciuto/],
      ['{"preset": "custom", "rules": {"clearanceByPairMm": {"pad-pad": 0.001}}}', /clearanceByPairMm\.pad-pad: 0\.001 fuori dai limiti 0\.01\.\.2/],
      ['{"preset": "oshpark", "rules": {"minTraceWidthMm": 0.2}}', /rules: vale solo con preset "custom"/],
      ['{"preset": "pcbway"}', /preset: deve essere uno di jlcpcb_standard, oshpark, jlcpcb_enhanced, custom/],
      ['{"preset": "custom", "rules": {}, "note": "x"}', /note: campo sconosciuto/],
      ["[1, 2]", /serve un oggetto/],
      [JSON.stringify({ preset: "custom", rules: {}, x: "y".repeat(MAX_REGOLE_CHARS) }), /file troppo grande \(\d+ caratteri, massimo 20000\)/],
    ];
    for (const [content, atteso] of casi) {
      const r = await scrivi(content);
      expect(r.isError, content.slice(0, 80)).toBe(false);
      expect(String(r.result.error), content.slice(0, 80)).toMatch(/^design-rules\.json non valido: /);
      expect(String(r.result.error), content.slice(0, 80)).toMatch(atteso);
      expect(stato.files).toEqual(prima);
    }
    expect(compilazioni.n).toBe(0);
  });

  it("what was sent does not come back in the message: only short names and numbers", async () => {
    const r = await scrivi(JSON.stringify({ preset: "custom", rules: { "../../segreti": 1, minClearanceMm: "DROP TABLE progetti" } }));
    const e = String(r.result.error);
    expect(e).toContain("rules.un campo dal nome non valido: campo sconosciuto");
    expect(e).toContain("minClearanceMm: deve essere un numero");
    expect(e).not.toMatch(/segreti|DROP TABLE/);
  });

  it("who may not write a .tsx may not write the rules", async () => {
    stato.accesso = "view";
    const r = await scrivi('{"preset": "oshpark"}');
    expect(r).toMatchObject({ isError: true, result: { error: "serve accesso in modifica a questo progetto" } });
    const tsx = await chiamaStrumento("write_file", { projectId: "p", path: "main.tsx", content: "x" });
    expect(tsx.isError).toBe(true);
    expect(stato.files[DESIGN_RULES_PATH]).toBeUndefined();
  });
});
