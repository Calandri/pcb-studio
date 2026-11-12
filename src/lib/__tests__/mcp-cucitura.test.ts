import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * stitch_ground called as an MCP client calls it: a JSON-RPC tools/call over
 * the route, with a personal token. The database is out of the way: the token,
 * the access rule, the log, the stores and the saved board are stand-ins.
 */
const stato = vi.hoisted(() => ({
  accesso: "edit" as "none" | "view" | "edit",
  files: {} as Record<string, string>,
  scheda: null as unknown[] | null,
  /** the files the saved board was compiled from: its hash is theirs */
  compilati: {} as Record<string, string>,
  /** the project is in the database */
  esiste: true,
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
vi.mock("@/lib/library-store", async (originale) => ({
  ...(await originale<typeof import("@/lib/library-store")>()),
  getLibraryFsMap: vi.fn(async () => ({})),
}));
vi.mock("@/lib/project-store", async (originale) => {
  const vero = await originale<typeof import("@/lib/project-store")>();
  return {
    ...vero,
    // a project that is not there reads as the example board, as the real getProject gives it
    getProject: vi.fn(async () => (stato.esiste ? { ...stato.files } : { "main.tsx": "export default () => <board />" })),
    projectExists: vi.fn(async () => stato.esiste),
    getCompileCache: vi.fn(async () =>
      stato.scheda ? { filesHash: vero.filesHash(stato.compilati), circuitJson: stato.scheda, summary: {}, createdAt: "2026-11-12", engineVersion: 11 } : null,
    ),
    writeProjectFile: vi.fn(async (_p: string, path: string, content: string) => {
      stato.files[path] = content;
    }),
    // what a compile leaves behind: a saved board, a preview, the base of a board
    saveCompileCache: vi.fn(async () => ({ saved: true, keptPrevious: false })),
    savePreviewCircuit: vi.fn(async () => {}),
    stampCompileBase: vi.fn(async () => {}),
  };
});
/*
 * "No compile starts": the two ways a board is compiled here are stand-ins that
 * count, and the test below ("the compile tool reaches the stand-in") shows
 * they are the ones the route runs. The stitching has no reason to call them,
 * so the count alone would pass whatever it did: what a compile leaves behind
 * (a saved board, a preview) is looked at too, see nessunaCompilazione.
 */
const compilazioni = vi.hoisted(() => ({ n: 0 }));
vi.mock("@/lib/compile", async (originale) => ({
  ...(await originale<typeof import("@/lib/compile")>()),
  compileProject: vi.fn(async () => {
    compilazioni.n++;
    throw new Error("nessuna compilazione deve partire da sola");
  }),
  compileGeometryOnly: vi.fn(async () => {
    compilazioni.n++;
    throw new Error("nessuna compilazione deve partire da sola");
  }),
}));

const { POST } = await import("@/app/api/mcp/[transport]/route");
const { FILE_CUCITURA } = await import("@/lib/ground-stitching-file");
const { claimProject } = await import("@/lib/acl");
const { writeProjectFile, saveCompileCache, savePreviewCircuit, stampCompileBase } = await import("@/lib/project-store");

/** nothing was compiled and no board was saved: the board in the database is the one of before */
function nessunaCompilazione() {
  expect(compilazioni.n).toBe(0);
  expect(saveCompileCache).not.toHaveBeenCalled();
  expect(savePreviewCircuit).not.toHaveBeenCalled();
  expect(stampCompileBase).not.toHaveBeenCalled();
}

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

/** the write as a client does it: a look, then apply with the fingerprint the look gave back */
async function scriviVisto(args: Record<string, unknown>) {
  const visto = await chiamaStrumento("stitch_ground", args);
  return chiamaStrumento("stitch_ground", { ...args, apply: true, impronta: visto.result.impronta });
}

/** a 4-layer board with ground poured on every layer */
const rett = (a: number, b: number, c: number, d: number) => [
  { x: a, y: b },
  { x: c, y: b },
  { x: c, y: d },
  { x: a, y: d },
];
const SCHEDA = [
  { type: "pcb_board", pcb_board_id: "b", width: 20, height: 20, center: { x: 0, y: 0 }, num_layers: 4 },
  { type: "source_net", source_net_id: "source_net_0", name: "GND", subcircuit_connectivity_map_key: "k_gnd" },
  ...["top", "inner1", "inner2", "bottom"].map((layer, i) => ({
    type: "pcb_copper_pour",
    pcb_copper_pour_id: `c${i}`,
    layer,
    source_net_id: "source_net_0",
    brep_shape: { outer_ring: { vertices: rett(-9.7, -9.7, 9.7, 9.7) } },
  })),
];

describe("stitch_ground over MCP", () => {
  beforeEach(() => {
    stato.accesso = "edit";
    stato.files = { "main.tsx": "export default () => <board />" };
    stato.compilati = { ...stato.files };
    stato.scheda = SCHEDA;
    stato.esiste = true;
    compilazioni.n = 0;
    vi.mocked(claimProject).mockClear();
    vi.mocked(writeProjectFile).mockClear();
    vi.mocked(saveCompileCache).mockClear();
    vi.mocked(savePreviewCircuit).mockClear();
    vi.mocked(stampCompileBase).mockClear();
  });

  it("the compile tool reaches the stand-in that counts compiles: a compile started through this route would be seen", async () => {
    await chiamaStrumento("compile", { projectId: "p" }).catch(() => null);
    expect(compilazioni.n).toBe(1);
  });

  it("dryRun (the default) proposes and writes nothing; it takes viewing access only", async () => {
    stato.accesso = "view";
    const r = await chiamaStrumento("stitch_ground", { projectId: "p" });
    expect(r.isError).toBe(false);
    expect(r.result).toMatchObject({ ok: true, scritto: false, rete: "GND", via: { foroMm: 0.3, coronaMm: 0.6 } });
    expect(r.result.vie as number).toBeGreaterThan(10);
    expect((r.result.coordinate as { griglia: unknown[] }).griglia.length).toBeGreaterThan(0);
    expect(stato.files[FILE_CUCITURA]).toBeUndefined();
    nessunaCompilazione();
  });

  it("apply writes cucitura-massa.tsx, starts no compile, leaves main.tsx alone and says the lines to add", async () => {
    const r = await scriviVisto({ projectId: "p", passoMm: 3 });
    expect(r.isError).toBe(false);
    expect(r.result).toMatchObject({ ok: true, scritto: true, main: { usaIlFile: false } });
    expect(stato.files[FILE_CUCITURA]).toMatch(/connectsTo="net.GND"/);
    expect(stato.files["main.tsx"]).toBe("export default () => <board />");
    nessunaCompilazione();
    // again: the same file
    const primo = stato.files[FILE_CUCITURA];
    await scriviVisto({ projectId: "p", passoMm: 3 });
    expect(stato.files[FILE_CUCITURA]).toBe(primo);
  });

  it("apply writes only what a look showed: without the fingerprint, or with one of other vias, nothing is written", async () => {
    const senza = await chiamaStrumento("stitch_ground", { projectId: "p", apply: true, passoMm: 3 });
    expect(senza).toMatchObject({ isError: true, result: { error: expect.stringMatching(/apply chiede l'impronta dell'anteprima/) } });
    const visto = await chiamaStrumento("stitch_ground", { projectId: "p", passoMm: 3 });
    expect(visto.result.impronta).toMatch(/^\d+-[0-9a-f]{16}$/);
    // the look was at 3 mm, the write asks 2: other vias
    const altre = await chiamaStrumento("stitch_ground", { projectId: "p", passoMm: 2, apply: true, impronta: visto.result.impronta });
    expect(altre).toMatchObject({ isError: true, result: { error: expect.stringMatching(/rifai l'anteprima/) } });
    expect(stato.files[FILE_CUCITURA]).toBeUndefined();
    const giusta = await chiamaStrumento("stitch_ground", { projectId: "p", passoMm: 3, apply: true, impronta: visto.result.impronta });
    expect(giusta.result).toMatchObject({ scritto: true, vie: visto.result.vie });
  });

  it("apply on a board older than the files is refused and writes nothing; the stitching file itself does not make the board old", async () => {
    // written once, on the board of these files
    const primo = await scriviVisto({ projectId: "p", passoMm: 3 });
    expect(primo.result).toMatchObject({ scritto: true, scheda: "aggiornata" });
    const scritto = stato.files[FILE_CUCITURA];
    // a look after it: the file is newer than the board, the board is not older than the project
    const dopo = await chiamaStrumento("stitch_ground", { projectId: "p", passoMm: 3 });
    expect(dopo.result).toMatchObject({ ok: true, scheda: "senza_la_cucitura", scrivibile: true });
    expect(dopo.result.schedaPiuVecchiaDeiFile).toBeUndefined();
    // a part moved in main.tsx and not compiled: the look says so, the write is refused
    stato.files["main.tsx"] = 'export default () => <board><resistor name="R1" resistance="1k" footprint="0402" pcbX={3} /></board>';
    const guarda = await chiamaStrumento("stitch_ground", { projectId: "p", passoMm: 3 });
    expect(guarda.isError).toBe(false);
    expect(guarda.result).toMatchObject({ ok: true, scritto: false, scheda: "vecchia", schedaPiuVecchiaDeiFile: true, scrivibile: false });
    const scrive = await scriviVisto({ projectId: "p", passoMm: 2 });
    expect(scrive.isError).toBe(true);
    expect(String(scrive.result.error)).toMatch(/la scheda salvata e' piu' vecchia dei file/);
    expect(stato.files[FILE_CUCITURA]).toBe(scritto);
  });

  it("with the same access as write_file: none sees nothing, view may look but not write", async () => {
    stato.accesso = "none";
    expect(await chiamaStrumento("stitch_ground", { projectId: "p" })).toMatchObject({ isError: true, result: { error: "nessun accesso a questo progetto" } });
    stato.accesso = "view";
    expect(await chiamaStrumento("stitch_ground", { projectId: "p", apply: true })).toMatchObject({
      isError: true,
      result: { error: "serve accesso in modifica a questo progetto" },
    });
    expect(stato.files[FILE_CUCITURA]).toBeUndefined();
  });

  it("parameters out of their limits are refused with the limit, and nothing is written", async () => {
    const r = await chiamaStrumento("stitch_ground", { projectId: "p", apply: true, passoMm: 0.2, maxVie: 99999, retiLontane: [{ rete: "<script>", distanzaMm: 1 }] });
    expect(r.isError).toBe(true);
    const e = String(r.result.error);
    expect(e).toMatch(/passoMm: 0.2 fuori dai limiti 1..10/);
    expect(e).toMatch(/maxVie: 99999 fuori dai limiti 1..1200/);
    expect(e).toMatch(/retiLontane\[0\]/);
    expect(e).not.toMatch(/script/);
    expect(stato.files[FILE_CUCITURA]).toBeUndefined();
    nessunaCompilazione();
  });

  it("on a project id that does not exist it creates nothing and says so, looking or writing", async () => {
    stato.esiste = false;
    // anyone signed in may edit a project that is not there yet: that is how write_file creates one
    stato.accesso = "edit";
    const guarda = await chiamaStrumento("stitch_ground", { projectId: "sbb-dl-principlae" });
    expect(guarda).toMatchObject({ isError: true, result: { error: expect.stringMatching(/il progetto non esiste/) } });
    const scrive = await chiamaStrumento("stitch_ground", { projectId: "sbb-dl-principlae", apply: true, impronta: "12-0123456789abcdef" });
    expect(scrive).toMatchObject({ isError: true, result: { error: expect.stringMatching(/il progetto non esiste/) } });
    expect(claimProject).not.toHaveBeenCalled();
    expect(writeProjectFile).not.toHaveBeenCalled();
    // write_file through the same route does create it: the stand-in is the one the route calls
    await chiamaStrumento("write_file", { projectId: "nuovo", path: "main.tsx", content: "export default () => <board />" });
    expect(claimProject).toHaveBeenCalledTimes(1);
  });

  it("on a project with no main.tsx there is no board to stitch", async () => {
    stato.files = { "parti.tsx": "export const Parti = () => <></>" };
    const r = await chiamaStrumento("stitch_ground", { projectId: "p" });
    expect(r).toMatchObject({ isError: true, result: { error: expect.stringMatching(/non ha main\.tsx/) } });
    expect(writeProjectFile).not.toHaveBeenCalled();
  });

  it("keepout passes through: all of them by default, solo_rame when asked, and the answer lists the zones that exclude positions", async () => {
    stato.scheda = [...SCHEDA, { type: "pcb_keepout", pcb_keepout_id: "tasto", shape: "rect", center: { x: 0, y: 0 }, width: 8, height: 8, layers: ["top"], description: "TASTO H7,6" }];
    const tutti = await chiamaStrumento("stitch_ground", { projectId: "p", passoMm: 2 });
    expect(tutti.result.keepout).toMatchObject({ modo: "tutti", zone: 1, escludono: [{ id: "tasto", descrizione: "TASTO H7,6", strati: ["top"], massaSotto: true }] });
    const k = tutti.result.keepout as { posizioni: number; conPosto: number };
    expect(k.posizioni).toBeGreaterThan(5);
    expect(k.conPosto).toBeGreaterThan(5);
    const rame = await chiamaStrumento("stitch_ground", { projectId: "p", passoMm: 2, keepout: "solo_rame" });
    expect(rame.result.keepout).toMatchObject({ modo: "solo_rame", posizioni: 0 });
    expect(rame.result.vie).toBe((tutti.result.vie as number) + k.conPosto);
    // the two looks are of different vias: the fingerprint of one does not write the other
    expect(rame.result.impronta).not.toBe(tutti.result.impronta);
    // any other word is refused by the schema of the tool, before the tool is run
    await expect(chiamaStrumento("stitch_ground", { projectId: "p", passoMm: 2, keepout: "nessuno" })).rejects.toThrow(/MCP error/);
  });

  it("with no saved board it says so", async () => {
    stato.scheda = null;
    const r = await chiamaStrumento("stitch_ground", { projectId: "p" });
    expect(r).toMatchObject({ isError: true, result: { error: expect.stringMatching(/compila prima/) } });
  });
});
