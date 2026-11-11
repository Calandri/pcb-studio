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
  saves: [] as Array<{ hash: string; circuitJson: unknown[]; summary: Record<string, unknown>; opts: unknown; engine: number }>,
}));

vi.mock("@/lib/project-store", async () => {
  const real = await vi.importActual<typeof import("@/lib/project-store")>("@/lib/project-store");
  return {
    ...real,
    getCompileMeta: vi.fn(async () => db.meta),
    getCompileCache: vi.fn(async () => db.row),
    saveCompileCache: vi.fn(async (_p: string, hash: string, circuitJson: unknown[], summary: Record<string, unknown>, engine: number, opts: unknown) => {
      db.saves.push({ hash, circuitJson, summary, opts, engine });
      return { saved: true };
    }),
  };
});

import { boardBaseOf } from "@/lib/board-base";
import { earlyBoardSaver, saveFinishedCompile } from "@/lib/compile-save";
import { schematicKeyOf, type CompileSummary } from "@/lib/compile";
import { CHECKS_ENGINE_VERSION, ENGINE_VIE_PASSANTI } from "@/lib/engine-version";
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
    // filed with the base of the files as they are now: the next hand move finds this board (board-base.ts)
    expect(s.opts).toEqual({ ifUnchangedSince: { filesHash: filesHash(B), createdAt: after }, base: boardBaseOf(B) });
  });

  it("the board the schematic goes onto keeps the engine it was made with, and its vias go through (2026-11-11)", async () => {
    // saved by the fast update from a board of an older engine, with a via written on two layers of four
    const via = { type: "pcb_via", pcb_via_id: "pcb_via_3", x: 1, y: 1, outer_diameter: 0.5, hole_diameter: 0.2, layers: ["inner2", "bottom"], from_layer: "inner2", to_layer: "bottom" };
    const theirs = [{ type: "source_component", source_component_id: "s1", name: "R1" }, { type: "pcb_board", num_layers: 4 }, via];
    const vecchio = CHECKS_ENGINE_VERSION - 1;
    db.meta = { filesHash: filesHash(B), createdAt: after, engineVersion: vecchio };
    db.row = { filesHash: filesHash(B), circuitJson: theirs, summary: {}, createdAt: after, engineVersion: vecchio };
    const r = await saveFinishedCompile("p", filesHash(A), ours, summary(), fresh(B));
    expect(r.grafted).toBe(true);
    const [s] = db.saves;
    // not filed as today's: its planes are the ones of the older engine, and the export asks for a recheck
    expect(s.engine).toBe(vecchio);
    const salvata = s.circuitJson.find((e) => (e as { type: string }).type === "pcb_via") as typeof via;
    expect(salvata.layers).toEqual(["top", "inner1", "inner2", "bottom"]);
    expect([salvata.from_layer, salvata.to_layer]).toEqual(["inner2", "bottom"]);

    // a row of today's engine is filed as today's, as before
    db.saves.length = 0;
    db.row = { ...db.row, engineVersion: CHECKS_ENGINE_VERSION };
    await saveFinishedCompile("p", filesHash(A), ours, summary(), fresh(B));
    expect(db.saves[0].engine).toBe(CHECKS_ENGINE_VERSION);
  });

  it("a board with a plane over a via of another net is never filed under today's engine: early, final or grafted (2026-11-11)", async () => {
    // what the summary carries when the planes could not be poured again (see CompileSummary.planesOverVias)
    const coperta = summary({ planesOverVias: { count: 1, detail: "1 via ha la piazzola nel rame di un piano di un'altra rete" } });
    await saveFinishedCompile("p", filesHash(A), ours, coperta, fresh(A));
    await earlyBoardSaver("p", filesHash(A), null, fresh(A))({ circuitJson: ours, summary: coperta });
    // and the same two saves of a board with nothing of the kind
    await saveFinishedCompile("p", filesHash(A), ours, summary(), fresh(A));
    await earlyBoardSaver("p", filesHash(A), null, fresh(A))({ circuitJson: ours, summary: summary() });
    expect(db.saves.map((s) => s.engine)).toEqual([ENGINE_VIE_PASSANTI - 1, ENGINE_VIE_PASSANTI - 1, CHECKS_ENGINE_VERSION, CHECKS_ENGINE_VERSION]);

    // grafted: the saved board is of today's engine, but a via of SIG stands in the ground plane of inner1
    db.saves.length = 0;
    const quadrato = { vertices: [{ x: -5, y: -5 }, { x: 5, y: -5 }, { x: 5, y: 5 }, { x: -5, y: 5 }] };
    const reti = [
      { type: "source_net", source_net_id: "n_gnd", name: "GND", subcircuit_connectivity_map_key: "k_gnd" },
      { type: "source_net", source_net_id: "n_sig", name: "SIG", subcircuit_connectivity_map_key: "k_sig" },
    ];
    const theirs = [
      { type: "source_component", source_component_id: "s1", name: "R1" },
      { type: "pcb_board", num_layers: 4, center: { x: 0, y: 0 }, width: 20, height: 20 },
      ...reti,
      { type: "pcb_via", pcb_via_id: "v_sig", x: 1, y: 1, outer_diameter: 0.5, hole_diameter: 0.2, layers: ["top", "inner1", "inner2", "bottom"], subcircuit_connectivity_map_key: "k_sig" },
      { type: "pcb_copper_pour", pcb_copper_pour_id: "p", layer: "inner1", source_net_id: "n_gnd", shape: "brep", brep_shape: { outer_ring: quadrato, inner_rings: [] } },
    ];
    db.meta = { filesHash: filesHash(B), createdAt: after, engineVersion: CHECKS_ENGINE_VERSION };
    db.row = { filesHash: filesHash(B), circuitJson: theirs, summary: {}, createdAt: after, engineVersion: CHECKS_ENGINE_VERSION };
    const r = await saveFinishedCompile("p", filesHash(A), [...ours, ...reti], summary(), fresh(B));
    expect(r.grafted).toBe(true);
    expect(db.saves[0].engine).toBe(ENGINE_VIE_PASSANTI - 1);
    expect(db.saves[0].summary.planesOverVias).toMatchObject({ count: 1 });
    expect(String(db.saves[0].summary.message)).toMatch(/v_sig nel piano GND su inner1.*NON e' certificata per l'export/);
  });

  it("se nel frattempo e' cambiato il codice, lo schematico vecchio non si mette sulla scheda nuova", async () => {
    const codice = { ...B, "main.tsx": MAIN.replace("10mm", "12mm") };
    db.meta = { filesHash: filesHash(codice), createdAt: after, engineVersion: 0 };
    db.row = { filesHash: filesHash(codice), circuitJson: [{ type: "pcb_board" }], summary: {}, createdAt: after, engineVersion: 0 };
    const r = await saveFinishedCompile("p", filesHash(A), ours, summary(), fresh(codice));
    expect(r.saved).toBe(false);
    expect(db.saves).toHaveLength(0);
  });

  it("una scheda chiusa senza schematico non copre quella completa degli stessi file, ma copre una senza", async () => {
    // the schematic did not fit in the time left (see stimaDelloSchematico): the board of these files with it stays
    const senza = summary({ schematicPending: "lo schematico non e' partito: restavano 120 s" });
    const pezzi = [{ type: "source_component", source_component_id: "s1", name: "R1" }, { type: "pcb_board" }];
    db.row = { filesHash: filesHash(A), circuitJson: ours, summary: {}, createdAt: before, engineVersion: 0 };
    const r = await saveFinishedCompile("p", filesHash(A), pezzi, senza, fresh(A));
    expect(r.saved).toBe(false);
    expect(r.superseded).toBe(true);
    expect(db.saves).toHaveLength(0);
    // the row saved is itself without schematic (the early board): the outcome goes over it
    db.row = { filesHash: filesHash(A), circuitJson: pezzi, summary: { schematicPending: "in calcolo" }, createdAt: before, engineVersion: 0 };
    expect((await saveFinishedCompile("p", filesHash(A), pezzi, senza, fresh(A))).saved).toBe(true);
    // a complete board of other files: the outcome goes over it too
    db.row = { filesHash: "altri", circuitJson: ours, summary: {}, createdAt: before, engineVersion: 0 };
    expect((await saveFinishedCompile("p", filesHash(A), pezzi, senza, fresh(A))).saved).toBe(true);
    expect(db.saves).toHaveLength(2);
  });

  it("anche la scheda anticipata non copre quella dei file di adesso", async () => {
    db.meta = { filesHash: filesHash(B), createdAt: after, engineVersion: 0 };
    const r = await earlyBoardSaver("p", filesHash(A), null, fresh(B))({ circuitJson: ours, summary: summary() });
    expect(r.saved).toBe(false);
    expect(db.saves).toHaveLength(0);
  });
});
