import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * sbb-dl-principale, 2026-11-09: a compile of the OLD files, saved at its end,
 * put the old board back over the new one. Two overlapping compiles: started
 * 22:45:58 and 22:47:23, the first one finished LAST (22:49:39) and its board
 * stayed, older than the files; and the parts moved in Sposta while it worked
 * jumped back. A compile saves only if it is still the newest board.
 */
const db = vi.hoisted(() => ({
  meta: null as null | { filesHash: string; createdAt: unknown; engineVersion: number },
  row: null as null | { filesHash: string; circuitJson: unknown[]; summary: unknown; createdAt: unknown; engineVersion: number },
  saves: [] as Array<{ hash: string; circuitJson: unknown[]; summary: Record<string, unknown>; opts: unknown }>,
}));

vi.mock("@/lib/project-store", async () => {
  const real = await vi.importActual<typeof import("@/lib/project-store")>("@/lib/project-store");
  return {
    ...real,
    getCompileMeta: vi.fn(async () => db.meta),
    getCompileCache: vi.fn(async () => db.row),
    saveCompileCache: vi.fn(async (_p: string, hash: string, circuitJson: unknown[], summary: Record<string, unknown>, _v: number, opts: unknown) => {
      db.saves.push({ hash, circuitJson, summary, opts });
      return { saved: true };
    }),
  };
});

import { earlyBoardSaver, saveFinishedCompile } from "@/lib/compile-save";
import { schematicKeyOf, type CompileSummary } from "@/lib/compile";
import { emptyManualEdits, MANUAL_EDITS_PATH, serializeManualEdits } from "@/lib/manual-edits";
import { filesHash } from "@/lib/project-store";

const MAIN = "export default () => <board width=\"10mm\" height=\"10mm\" />";
const files = (x: number) => ({
  "main.tsx": MAIN,
  [MANUAL_EDITS_PATH]: serializeManualEdits({ ...emptyManualEdits(), pcb_placements: [{ selector: "R1", center: { x, y: 0 } }] }),
});
const startedAt = Date.parse("2026-11-09T21:45:58Z");
const before = "2026-11-09T21:40:00Z";
const after = "2026-11-09T21:49:13Z";
const A = files(1);
const B = files(2);
const ours = [{ type: "source_component", source_component_id: "s1", name: "R1" }, { type: "pcb_board" }, { type: "schematic_component", schematic_component_id: "sc1" }];
const summary = (extra: Partial<CompileSummary> = {}) => ({ message: "ok", schematicKey: schematicKeyOf(A), ...extra }) as unknown as CompileSummary;
const fresh = (now: Record<string, string>) => ({ startedAt, filesNow: async () => now });

describe("una compilazione si salva solo se e' ancora la scheda piu' nuova", () => {
  beforeEach(() => {
    db.meta = null;
    db.row = null;
    db.saves = [];
  });

  it("file uguali a quelli dell'inizio: si salva come sempre", async () => {
    db.meta = { filesHash: "x", createdAt: after, engineVersion: 0 };
    const r = await saveFinishedCompile("p", filesHash(A), ours, summary(), fresh(A));
    expect(r.saved).toBe(true);
    expect(db.saves).toHaveLength(1);
  });

  it("di due compilazioni sovrapposte, quella partita prima e finita dopo non copre l'altra", async () => {
    // the other one, started later on newer files, saved after we started
    db.meta = { filesHash: "dell-altra", createdAt: after, engineVersion: 0 };
    const r = await saveFinishedCompile("p", filesHash(A), ours, summary(), fresh(files(3)));
    expect(r.saved).toBe(false);
    expect(r.reason).toMatch(/piu' recente/);
    expect(db.saves).toHaveLength(0);
  });

  it("sopra la propria scheda anticipata, o sopra una piu' vecchia, si salva, ma solo su quella riga", async () => {
    db.meta = { filesHash: filesHash(A), createdAt: after, engineVersion: 0 };
    expect((await saveFinishedCompile("p", filesHash(A), ours, summary(), fresh(B))).saved).toBe(true);
    db.meta = { filesHash: "vecchia", createdAt: before, engineVersion: 0 };
    expect((await saveFinishedCompile("p", filesHash(A), ours, summary(), fresh(B))).saved).toBe(true);
    expect(db.saves.map((s) => s.opts)).toEqual([
      { ifUnchangedSince: { filesHash: filesHash(A), createdAt: after } },
      { ifUnchangedSince: { filesHash: "vecchia", createdAt: before } },
    ]);
  });

  it("pezzi spostati mentre si disegnava lo schematico: la scheda salvata resta, e lo schematico ci va sopra", async () => {
    // the fast path saved the board of B (R1 moved) while we drew the schematic of A
    const theirs = [{ type: "source_component", source_component_id: "s1", name: "R1" }, { type: "pcb_board" }, { type: "pcb_component", pcb_component_id: "pc1", center: { x: 2, y: 0 } }];
    db.meta = { filesHash: filesHash(B), createdAt: after, engineVersion: 0 };
    db.row = { filesHash: filesHash(B), circuitJson: theirs, summary: {}, createdAt: after, engineVersion: 0 };
    const r = await saveFinishedCompile("p", filesHash(A), ours, summary(), fresh(B));
    expect(r.saved).toBe(true);
    expect(r.grafted).toBe(true);
    const [s] = db.saves;
    expect(s.hash).toBe(filesHash(B));
    expect(s.circuitJson.map((e) => (e as { type: string }).type)).toEqual(["source_component", "pcb_board", "pcb_component", "schematic_component"]);
    expect(s.summary.schematicKey).toBe(schematicKeyOf(A));
    expect(s.opts).toEqual({ ifUnchangedSince: { filesHash: filesHash(B), createdAt: after } });
  });

  it("se nel frattempo e' cambiato il codice, lo schematico vecchio non si mette sulla scheda nuova", async () => {
    const codice = { ...B, "main.tsx": MAIN.replace("10mm", "12mm") };
    db.meta = { filesHash: filesHash(codice), createdAt: after, engineVersion: 0 };
    db.row = { filesHash: filesHash(codice), circuitJson: [{ type: "pcb_board" }], summary: {}, createdAt: after, engineVersion: 0 };
    const r = await saveFinishedCompile("p", filesHash(A), ours, summary(), fresh(codice));
    expect(r.saved).toBe(false);
    expect(db.saves).toHaveLength(0);
  });

  it("anche la scheda anticipata non copre quella dei file di adesso", async () => {
    db.meta = { filesHash: filesHash(B), createdAt: after, engineVersion: 0 };
    const r = await earlyBoardSaver("p", filesHash(A), null, fresh(B))({ circuitJson: ours, summary: summary() });
    expect(r.saved).toBe(false);
    expect(db.saves).toHaveLength(0);
  });
});
