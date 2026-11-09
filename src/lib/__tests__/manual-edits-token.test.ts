import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Col token personale (script, MCP) si possono solo LIBERARE pezzi nominati:
 * su sbb-dl-principale una vecchia J1 tenuta a mano scavalcava il file e solo
 * il browser poteva liberarla (2026-11-09). Niente "libera tutto", niente
 * fissa, niente spostamenti.
 */
const rilascia = vi.fn(async () => ({ edits: { schematic_placements: [], pcb_placements: [], manual_trace_hints: [], pcb_routes: [] }, written: true }));
const commit = vi.fn(async () => {
  throw new Error("una scrittura che col token non deve partire");
});
const accesso = { sessione: false, token: true, esiste: true };

vi.mock("@/lib/acl", () => ({
  requireProjectAccess: async () => ({ ok: accesso.sessione, viewer: null }),
  accessoDaRichiesta: async () => accesso.token,
}));
vi.mock("@/lib/project-store", () => ({
  getCompileCache: async () => null,
  getProject: async () => ({}),
  projectExists: async () => accesso.esiste,
}));
vi.mock("@/lib/manual-edits-store", () => ({ rilasciaPezzi: rilascia, commitManualEdits: commit }));

const { POST } = await import("@/app/api/manual-edits/route");
const chiama = (body: Record<string, unknown>, token = true) =>
  POST(
    new Request("http://x/api/manual-edits", {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer pcbs_prova" } : {}) },
      body: JSON.stringify({ projectId: "prova-salvataggio-retro", ...body }),
    }),
  );

describe("manual-edits col token personale", () => {
  beforeEach(() => {
    rilascia.mockClear();
    commit.mockClear();
    Object.assign(accesso, { sessione: false, token: true, esiste: true });
  });

  it("libera i pezzi nominati, e solo quelli", async () => {
    const r = await chiama({ action: "release", scope: "pcb", names: ["J1"] });
    expect(r.status).toBe(200);
    expect(rilascia).toHaveBeenCalledWith("prova-salvataggio-retro", null, ["J1"], "pcb");
  });

  it("niente 'libera tutto', niente fissa, niente spostamenti, niente sostituzione", async () => {
    for (const body of [
      { action: "release", scope: "pcb", name: null },
      { action: "release", scope: "pcb", names: [] },
      { action: "pin", names: ["J1"] },
      { action: "set", edits: {} },
      { events: [{ edit_event_type: "edit_pcb_component_location" }] },
      { action: "place", placements: [{ name: "J1", x: 1, y: 1 }] },
    ]) {
      expect((await chiama(body)).status, JSON.stringify(body)).toBe(403);
    }
    expect(rilascia).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it("serve il permesso di modifica sul progetto, e il progetto deve esistere", async () => {
    accesso.token = false;
    expect((await chiama({ action: "release", names: ["J1"] })).status).toBe(403);
    Object.assign(accesso, { token: true, esiste: false });
    expect((await chiama({ action: "release", names: ["J1"] })).status).toBe(403);
    expect((await chiama({ action: "release", names: ["J1"] }, false)).status).toBe(403);
    expect(rilascia).not.toHaveBeenCalled();
  });
});
