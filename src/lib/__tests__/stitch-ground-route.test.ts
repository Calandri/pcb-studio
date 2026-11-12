import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * "Cuci la massa" of the viewer goes through /api/stitch-ground: a look asks
 * to see the project, writing asks what write_file asks, and nothing compiles.
 */
const stato = vi.hoisted(() => ({
  livello: "edit" as "none" | "view" | "edit",
  files: {} as Record<string, string>,
  /** the files the saved board was compiled from: its hash is theirs */
  compilati: {} as Record<string, string>,
  /** the project is in the database */
  esiste: true,
  /** every access asked of the route, in order */
  accessiChiesti: [] as string[],
}));
vi.mock("@/lib/acl", () => ({
  requireProjectAccess: vi.fn(async (_p: string, need: "view" | "edit") => {
    stato.accessiChiesti.push(need);
    return { viewer: null, ok: need === "view" ? stato.livello !== "none" : stato.livello === "edit" };
  }),
}));
vi.mock("@/lib/library-store", async (originale) => ({
  ...(await originale<typeof import("@/lib/library-store")>()),
  getLibraryFsMap: vi.fn(async () => ({})),
}));
const rett = (a: number, b: number, c: number, d: number) => [
  { x: a, y: b },
  { x: c, y: b },
  { x: c, y: d },
  { x: a, y: d },
];
vi.mock("@/lib/project-store", async (originale) => {
  const vero = await originale<typeof import("@/lib/project-store")>();
  return {
  ...vero,
  getProject: vi.fn(async () => ({ ...stato.files })),
  projectExists: vi.fn(async () => stato.esiste),
  getCompileCache: vi.fn(async () => ({
    filesHash: vero.filesHash(stato.compilati),
    summary: {},
    createdAt: "2026-11-12",
    engineVersion: 11,
    circuitJson: [
      { type: "pcb_board", pcb_board_id: "b", width: 20, height: 20, center: { x: 0, y: 0 }, num_layers: 2 },
      { type: "source_net", source_net_id: "source_net_0", name: "GND", subcircuit_connectivity_map_key: "k_gnd" },
      ...["top", "bottom"].map((layer, i) => ({
        type: "pcb_copper_pour",
        pcb_copper_pour_id: `c${i}`,
        layer,
        source_net_id: "source_net_0",
        brep_shape: { outer_ring: { vertices: rett(-9.7, -9.7, 9.7, 9.7) } },
      })),
      { type: "pcb_via", pcb_via_id: "v", x: -8, y: -8, outer_diameter: 0.6, hole_diameter: 0.3, subcircuit_connectivity_map_key: "k_gnd" },
    ],
  })),
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
 * "Non compila": the two ways a board is compiled are stand-ins that count, and
 * the first test shows the tool door (executeTool, the one this route goes
 * through) reaches them. The stitching has no reason to call them, so the count
 * alone would pass whatever it did: what a compile leaves behind (a saved
 * board, a preview) is looked at too, see nessunaCompilazione.
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

const { POST } = await import("@/app/api/stitch-ground/route");
const { executeTool } = await import("@/lib/agent-tools");
const { saveCompileCache, savePreviewCircuit, stampCompileBase } = await import("@/lib/project-store");

/** nothing was compiled and no board was saved: the board in the database is the one of before */
function nessunaCompilazione() {
  expect(compilazioni.n).toBe(0);
  expect(saveCompileCache).not.toHaveBeenCalled();
  expect(savePreviewCircuit).not.toHaveBeenCalled();
  expect(stampCompileBase).not.toHaveBeenCalled();
}
const chiedi = async (body: Record<string, unknown>) => {
  const r = await POST(new Request("http://localhost/api/stitch-ground", { method: "POST", body: JSON.stringify(body) }));
  return { status: r.status, d: (await r.json()) as Record<string, unknown> };
};

describe("/api/stitch-ground", () => {
  beforeEach(() => {
    stato.livello = "edit";
    stato.files = { "main.tsx": "export default () => <board />" };
    stato.compilati = { ...stato.files };
    stato.esiste = true;
    stato.accessiChiesti = [];
    compilazioni.n = 0;
    vi.mocked(saveCompileCache).mockClear();
    vi.mocked(savePreviewCircuit).mockClear();
    vi.mocked(stampCompileBase).mockClear();
  });

  it("lo strumento compile, dalla stessa porta, arriva alla controfigura che conta le compilazioni: una compilazione partita da qui si vedrebbe", async () => {
    const r = await executeTool("p", "compile", {});
    expect(String((r.result as { error?: unknown }).error)).toMatch(/nessuna compilazione deve partire da sola/);
    expect(compilazioni.n).toBe(1);
  });

  it("guardare chiede di vedere il progetto, scrivere chiede la modifica", async () => {
    stato.livello = "view";
    const guarda = await chiedi({ projectId: "p", passoMm: 2.5 });
    expect(guarda.status).toBe(200);
    expect(guarda.d.vie as number).toBeGreaterThan(5);
    expect(guarda.d.fileChanged).toBeUndefined();
    nessunaCompilazione();
    expect(await chiedi({ projectId: "p", passoMm: 2.5, apply: true })).toMatchObject({ status: 403 });
    expect(stato.files["cucitura-massa.tsx"]).toBeUndefined();
    stato.livello = "none";
    expect(await chiedi({ projectId: "p" })).toMatchObject({ status: 403 });
  });

  it("scrive il file, lo restituisce alla pagina e non compila", async () => {
    // as the panel does: the look, then the write with the fingerprint of the look
    const visto = await chiedi({ projectId: "p", passoMm: 2.5 });
    const r = await chiedi({ projectId: "p", passoMm: 2.5, apply: true, impronta: visto.d.impronta });
    expect(r.status).toBe(200);
    expect(r.d).toMatchObject({ scritto: true, fileChanged: { path: "cucitura-massa.tsx" } });
    expect(stato.files["cucitura-massa.tsx"]).toBe((r.d.fileChanged as { content: string }).content);
    expect(stato.files["main.tsx"]).toBe("export default () => <board />");
    nessunaCompilazione();
  });

  it("scheda piu' vecchia dei file: l'anteprima lo dice con scrivibile false, scrivere e' un 422 e il file non nasce", async () => {
    stato.files["main.tsx"] = "export default () => <board><net name=\"GND\" /></board>";
    const guarda = await chiedi({ projectId: "p", passoMm: 2.5 });
    expect(guarda.status).toBe(200);
    expect(guarda.d).toMatchObject({ scheda: "vecchia", schedaPiuVecchiaDeiFile: true, scrivibile: false });
    expect((guarda.d.nonScrivibile as string[])[0]).toMatch(/piu' vecchia dei file/);
    const scrive = await chiedi({ projectId: "p", passoMm: 2.5, apply: true });
    expect(scrive.status).toBe(422);
    expect(String(scrive.d.error)).toMatch(/piu' vecchia dei file/);
    expect(stato.files["cucitura-massa.tsx"]).toBeUndefined();
  });

  it("scrive solo quello che l'anteprima ha mostrato: senza impronta o con quella di altre vie e' un 422 e niente file", async () => {
    const senza = await chiedi({ projectId: "p", passoMm: 2.5, apply: true });
    expect(senza.status).toBe(422);
    expect(String(senza.d.error)).toMatch(/apply chiede l'impronta dell'anteprima/);
    const visto = await chiedi({ projectId: "p", passoMm: 2.5 });
    const altre = await chiedi({ projectId: "p", passoMm: 4, apply: true, impronta: visto.d.impronta });
    expect(altre.status).toBe(422);
    expect(String(altre.d.error)).toMatch(/rifai l'anteprima/);
    expect(stato.files["cucitura-massa.tsx"]).toBeUndefined();
  });

  it("progetto inesistente: 404, niente scritto, e l'accesso in modifica (che lo creerebbe) non viene nemmeno chiesto", async () => {
    stato.esiste = false;
    expect(await chiedi({ projectId: "sbagliato", passoMm: 2.5 })).toMatchObject({ status: 404, d: { error: "il progetto non esiste" } });
    expect(await chiedi({ projectId: "sbagliato", passoMm: 2.5, apply: true, impronta: "12-0123456789abcdef" })).toMatchObject({ status: 404 });
    expect(stato.accessiChiesti).toEqual(["view", "view"]);
    expect(stato.files["cucitura-massa.tsx"]).toBeUndefined();
  });

  it("parametri fuori dai limiti: 422 con il motivo", async () => {
    const r = await chiedi({ projectId: "p", passoMm: 50 });
    expect(r.status).toBe(422);
    expect(String(r.d.error)).toMatch(/passoMm: 50 fuori dai limiti 1..10/);
  });
});
