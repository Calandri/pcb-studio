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
const { DESIGN_RULES_PATH, MAX_REGOLE_CHARS, resolveDesignRules, resolveStackup } = await import("@/lib/design-rules");

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

/*
 * The board's stackup, declared in design-rules.json next to preset and rules.
 * ST_CAMERA is the JLCPCB stack JLC06161H-3313 as jlcpcb.com/impedance gives
 * it; its total is added up by hand: 2 x 0,035 of outer copper, 4 x 0,0152 of
 * inner copper, 2 x 0,0994 + 2 x 0,55 + 0,1164 of dielectric
 * = 0,07 + 0,0608 + 1,4152 = 1,546.
 */
describe("write_file of design-rules.json with a stackup", () => {
  const ST_CAMERA = {
    copperMm: [0.035, 0.0152, 0.0152, 0.0152, 0.0152, 0.035],
    dielectrics: [
      { mm: 0.0994, er: 4.1, kind: "prepreg", name: "3313" },
      { mm: 0.55, er: 4.6, kind: "core" },
      { mm: 0.1164, er: 4.16, kind: "prepreg", name: "2116" },
      { mm: 0.55, er: 4.6, kind: "core" },
      { mm: 0.0994, er: 4.1, kind: "prepreg", name: "3313" },
    ],
  };
  beforeEach(() => {
    stato.accesso = "edit";
    stato.files = { "main.tsx": "export default () => <board />" };
    compilazioni.n = 0;
  });
  const scrivi = (corpo: unknown) =>
    chiamaStrumento("write_file", { projectId: "p", path: DESIGN_RULES_PATH, content: typeof corpo === "string" ? corpo : JSON.stringify(corpo) });
  const letto = async () => JSON.parse(((await chiamaStrumento("read_project", { projectId: "p" })).result.files as Record<string, string>)[DESIGN_RULES_PATH]) as Record<string, unknown>;

  it("a valid stackup is accepted with a factory preset and with custom rules, and read back as it was written", async () => {
    const r = await scrivi({ preset: "jlcpcb_standard", stackup: ST_CAMERA });
    expect(r.isError).toBe(false);
    expect(r.result).toMatchObject({ ok: true, path: DESIGN_RULES_PATH, preset: "jlcpcb_standard", stackup: { copperLayers: 6, totalMm: 1.546 } });
    expect(r.result.stackupRemoved).toBeUndefined();
    expect(await letto()).toEqual({ preset: "jlcpcb_standard", stackup: ST_CAMERA });
    expect(resolveStackup(stato.files)).toEqual({ stackup: ST_CAMERA });

    const conRegole = await scrivi({ preset: "custom", rules: { minTraceWidthMm: 0.15, minClearanceMm: 0.15 }, stackup: ST_CAMERA });
    expect(conRegole.result).toMatchObject({ ok: true, preset: "custom", stackup: { copperLayers: 6, totalMm: 1.546 } });
    const file = await letto();
    expect(file.stackup).toEqual(ST_CAMERA);
    // the rules are the ones written, and the stackup is not one of them
    const regole = resolveDesignRules(stato.files);
    expect(regole.warnings).toBeUndefined();
    expect(regole.rules).toMatchObject({ minTraceWidthMm: 0.15, minClearanceMm: 0.15 });
    expect("stackup" in regole.rules).toBe(false);
    expect(compilazioni.n).toBe(0);
  });

  it("a wrong stackup refuses the whole file with the reason, and nothing is written", async () => {
    await scrivi({ preset: "oshpark", stackup: ST_CAMERA });
    const prima = { ...stato.files };
    const casi: Array<[unknown, RegExp]> = [
      [{ preset: "oshpark", stackup: { ...ST_CAMERA, dielectrics: ST_CAMERA.dielectrics.slice(1) } }, /stackup\.dielectrics: ne servono 5, uno per ogni spazio fra i 6 strati di rame \(trovati 4\)/],
      [{ preset: "oshpark", stackup: { copperMm: [0.035], dielectrics: [] } }, /stackup\.copperMm: serve un elenco di almeno due spessori in mm/],
      [{ preset: "oshpark", stackup: { copperMm: [0.035, -0.035], dielectrics: [{ mm: 1.5 }] } }, /stackup\.copperMm\[1\]: -0\.035 deve essere maggiore di zero/],
      [{ preset: "oshpark", stackup: { copperMm: [35, 35], dielectrics: [{ mm: 1.5 }] } }, /stackup\.copperMm\[0\]: 35 oltre il massimo di 10 \(i valori sono in millimetri, non in micron\)/],
      [{ preset: "oshpark", stackup: { copperMm: [0.035, 0.035], dielectrics: [{ er: 4.6 }] } }, /stackup\.dielectrics\[0\]\.mm: manca, lo spessore in millimetri e' obbligatorio/],
      [{ preset: "oshpark", stackup: { copperMm: [0.035, 0.035], dielectrics: [{ mm: 1.5, er: 1 }] } }, /stackup\.dielectrics\[0\]\.er: deve essere un numero maggiore di 1/],
      [{ preset: "oshpark", stackup: { copperMm: [0.035, 0.035], dielectrics: [{ mm: 1.5, kind: "FR4" }] } }, /stackup\.dielectrics\[0\]\.kind: deve essere "prepreg" o "core"/],
      [{ preset: "oshpark", stackup: { copperMm: [0.035, 0.035], dielectrics: [{ mm: 1.5, name: "x".repeat(41) }] } }, /stackup\.dielectrics\[0\]\.name: deve essere un testo da 1 a 40 caratteri/],
      [{ preset: "oshpark", stackup: { copperMm: [0.035, 0.035], dielectrics: [{ mm: 1.5 }], thicknessMm: 1.6 } }, /stackup\.thicknessMm: campo sconosciuto \(ammessi copperMm e dielectrics\)/],
      [{ preset: "oshpark", stackup: { copperMm: [0.035, 0.035], dielectrics: [{ mm: 1.5, tanD: 0.02 }] } }, /stackup\.dielectrics\[0\]\.tanD: campo sconosciuto \(ammessi mm, er, kind, name\)/],
      ['{"preset": "oshpark", "stackup": {"copperMm": [1e999, 0.035], "dielectrics": [{"mm": 1.5}]}}', /stackup\.copperMm\[0\]: deve essere un numero di millimetri maggiore di zero/],
      [{ preset: "custom", rules: { stackup: ST_CAMERA } }, /rules\.stackup: campo sconosciuto/],
    ];
    for (const [corpo, atteso] of casi) {
      const r = await scrivi(corpo);
      const nome = JSON.stringify(corpo).slice(0, 90);
      expect(r.isError, nome).toBe(false);
      expect(r.result.ok, nome).toBeUndefined();
      expect(String(r.result.error), nome).toMatch(/^design-rules\.json non valido: /);
      expect(String(r.result.error), nome).toMatch(atteso);
      // the file that was there, stackup included, is untouched
      expect(stato.files).toEqual(prima);
    }
    expect(compilazioni.n).toBe(0);
  });

  it("the file is whole: rewriting it with the stackup keeps it, without it removes it and the answer says so", async () => {
    await scrivi({ preset: "oshpark", stackup: ST_CAMERA });
    // other rules, the stackup written again: kept
    const tenuta = await scrivi({ preset: "custom", rules: { minTraceWidthMm: 0.2 }, stackup: ST_CAMERA });
    expect(tenuta.result.stackupRemoved).toBeUndefined();
    expect(String(tenuta.result.note)).not.toMatch(/REMOVED/);
    expect((await letto()).stackup).toEqual(ST_CAMERA);
    // other rules, no stackup: removed, and said
    const tolta = await scrivi({ preset: "custom", rules: { minTraceWidthMm: 0.25 } });
    expect(tolta.result).toMatchObject({ ok: true, stackupRemoved: true });
    expect(tolta.result.stackup).toBeUndefined();
    expect(String(tolta.result.note)).toMatch(/The stackup this project declared is REMOVED: the file written carries none/);
    expect("stackup" in (await letto())).toBe(false);
    // nothing to remove the second time: nothing is said
    const dopo = await scrivi({ preset: "oshpark" });
    expect(dopo.result.stackupRemoved).toBeUndefined();
    expect(String(dopo.result.note)).not.toMatch(/REMOVED/);
  });

  it("the tool says how to write a stackup, where an agent reads it", async () => {
    const r = await POST(
      new Request("http://localhost/api/mcp/mcp", {
        method: "POST",
        headers: { authorization: "Bearer pcbs_prova", "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    const corpo = await r.text();
    const riga = corpo.split("\n").find((l) => l.startsWith("data: ")) ?? corpo;
    const strumenti = (JSON.parse(riga.replace(/^data: /, "")) as { result: { tools: Array<{ name: string; description: string }> } }).result.tools;
    const descrizione = strumenti.find((t) => t.name === "write_file")?.description ?? "";
    expect(descrizione).toContain('"stackup"');
    expect(descrizione).toContain("copperMm [>0..10, ...] (2+)");
    expect(descrizione).toContain("dielectrics [{mm >0..10, er >1, kind prepreg/core, name 1..40 chars}, ...] (one fewer than copperMm)");
    expect(descrizione).toContain("scritto senza stackup toglie la pila che c'era");
  });
});
