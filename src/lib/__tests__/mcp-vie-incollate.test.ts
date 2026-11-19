import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Lo strumento MCP edit_pasted_vias chiamato come lo chiama un client: un
 * tools/call col token personale. Toglie o sposta solo le vie incollate, solo
 * per chi possiede il progetto. Database fuori: token, regola di accesso e
 * store sono finti; i file di manual-edits sono in memoria.
 */
const stato = vi.hoisted(() => ({
  proprietario: true,
  files: {} as Record<string, string>,
}));
vi.mock("@/lib/api-tokens", () => ({ resolveApiToken: vi.fn(async () => ({ userId: "u1", email: "u1@example.com" })) }));
vi.mock("@/lib/acl", () => ({
  projectAccess: vi.fn(async () => "edit"),
  canManageProject: vi.fn(async () => stato.proprietario),
  claimProject: vi.fn(async () => {}),
  listAccessibleProjects: vi.fn(async () => []),
  requireProjectAccess: vi.fn(async () => ({ viewer: null, ok: true })),
}));
vi.mock("@/lib/activity-store", () => ({
  COMPILE_START: "compila la scheda",
  logActivity: vi.fn(async () => {}),
  recordTool: vi.fn(async (_p: string, _a: string, _t: string, _d: string, run: () => Promise<unknown>) => run()),
  readCompileRun: vi.fn(async () => null),
}));
vi.mock("@/lib/manual-edits-store", async () => {
  const { parseManualEdits, serializeManualEdits, MANUAL_EDITS_PATH } = await import("@/lib/manual-edits");
  return {
    boardStanding: vi.fn(async () => "exact"),
    commitManualEdits: vi.fn(async (_p: string, _m: unknown, cambia: (e: ReturnType<typeof parseManualEdits>) => ReturnType<typeof parseManualEdits> | null) => {
      const prima = parseManualEdits(stato.files[MANUAL_EDITS_PATH]);
      const dopo = cambia(prima);
      if (dopo) stato.files[MANUAL_EDITS_PATH] = serializeManualEdits(dopo);
      return { edits: dopo ?? prima };
    }),
  };
});
vi.mock("@/lib/project-store", async (originale) => {
  const vero = await originale<typeof import("@/lib/project-store")>();
  return {
    ...vero,
    projectExists: vi.fn(async () => true),
    getProject: vi.fn(async () => ({ ...stato.files })),
    getCompileCache: vi.fn(async () => null),
    getCompileMeta: vi.fn(async () => null),
  };
});

const { POST } = await import("@/app/api/mcp/[transport]/route");
const { emptyManualEdits, MANUAL_EDITS_PATH, parseManualEdits, serializeManualEdits } = await import("@/lib/manual-edits");

async function chiamaStrumento(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; testo: string }> {
  const r = await POST(
    new Request("http://localhost/api/mcp/mcp", {
      method: "POST",
      headers: { authorization: "Bearer pcbs_prova", "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
  );
  const corpo = await r.text();
  const riga = corpo.split("\n").find((l) => l.startsWith("data: ")) ?? corpo;
  const msg = JSON.parse(riga.replace(/^data: /, "")) as { result?: { isError?: boolean; content: Array<{ text: string }> } };
  if (!msg.result) throw new Error(`nessun risultato: ${corpo.slice(0, 400)}`);
  return { isError: msg.result.isError === true, testo: msg.result.content[0].text };
}

const via = (x: number, y: number, aggiunta = true) => ({ net: "GND", from: { x, y }, to: { x, y: aggiunta ? y : y + 1 }, holeDiameter: 0.2, outerDiameter: 0.3, layers: ["top", "bottom"], ...(aggiunta ? { aggiunta: true as const } : {}) });

describe("edit_pasted_vias", () => {
  beforeEach(() => {
    stato.proprietario = true;
    stato.files = { [MANUAL_EDITS_PATH]: serializeManualEdits({ ...emptyManualEdits(), pcb_vias: [via(6, -9), via(8, -9), via(0, -6, false)] }) };
  });

  it("toglie le vie incollate nominate e risponde con le voci cambiate", async () => {
    const r = await chiamaStrumento("edit_pasted_vias", { projectId: "prova", unpaste: [{ net: "GND", x: 6, y: -9 }, { net: "GND", x: 8, y: -9 }] });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.testo).removed).toEqual([
      { net: "GND", x: 6, y: -9 },
      { net: "GND", x: 8, y: -9 },
    ]);
    expect(parseManualEdits(stato.files[MANUAL_EDITS_PATH]).pcb_vias.map((v) => v.aggiunta === true)).toEqual([false]);
  });

  it("solo per chi possiede il progetto; una via dei file non si tocca; uno spostamento senza scheda compilata e' rifiutato", async () => {
    const prima = stato.files[MANUAL_EDITS_PATH];
    stato.proprietario = false;
    const negato = await chiamaStrumento("edit_pasted_vias", { projectId: "prova", unpaste: [{ net: "GND", x: 6, y: -9 }] });
    expect(negato.isError).toBe(true);
    expect(negato.testo).toMatch(/solo chi possiede il progetto/);
    stato.proprietario = true;
    const deiFile = await chiamaStrumento("edit_pasted_vias", { projectId: "prova", unpaste: [{ net: "GND", x: 0, y: -5 }] });
    expect(deiFile.isError).toBe(true);
    expect(deiFile.testo).toMatch(/nessuna via incollata/);
    const senzaScheda = await chiamaStrumento("edit_pasted_vias", { projectId: "prova", movePastedVias: [{ net: "GND", from: { x: 6, y: -9 }, to: { x: 6, y: -8.6 } }] });
    expect(senzaScheda.isError).toBe(true);
    expect(senzaScheda.testo).toMatch(/compila prima/);
    expect(stato.files[MANUAL_EDITS_PATH]).toBe(prima);
  });
});
