import { beforeEach, describe, expect, it, vi } from "vitest";

const saved = vi.hoisted(() => ({ calls: [] as Array<{ projectId: string; hash: string }> }));

vi.mock("@/lib/project-store", async () => {
  const real = await vi.importActual<typeof import("@/lib/project-store")>("@/lib/project-store");
  return {
    ...real,
    saveCompileCache: vi.fn(async (projectId: string, hash: string) => {
      saved.calls.push({ projectId, hash });
      return { saved: true };
    }),
  };
});

import { earlyBoardSaver } from "@/lib/compile-save";
import type { CompileSummary } from "@/lib/compile";

const board = [{ type: "pcb_board" }];
const early = { circuitJson: board, summary: { schematicPending: "x" } as unknown as CompileSummary };
const cache = (filesHash: string, summary: unknown) => ({
  filesHash,
  circuitJson: board,
  summary,
  createdAt: "2026-11-09T20:00:00Z",
  engineVersion: 0,
});

describe("salvataggio anticipato della scheda", () => {
  beforeEach(() => {
    saved.calls = [];
  });

  it("senza scheda salvata la salva subito", async () => {
    const r = await earlyBoardSaver("p", "h1", null)(early);
    expect(r.saved).toBe(true);
    expect(saved.calls).toEqual([{ projectId: "p", hash: "h1" }]);
  });

  it("con i file cambiati salva la scheda nuova", async () => {
    await earlyBoardSaver("p", "h2", cache("h1", {}))(early);
    expect(saved.calls).toHaveLength(1);
  });

  it("non sostituisce la scheda completa degli stessi file con una senza schematico", async () => {
    const r = await earlyBoardSaver("p", "h1", cache("h1", {}))(early);
    expect(r.saved).toBe(false);
    expect(saved.calls).toHaveLength(0);
  });

  it("sostituisce una scheda degli stessi file ancora senza schematico", async () => {
    await earlyBoardSaver("p", "h1", cache("h1", { schematicPending: "x" }))(early);
    expect(saved.calls).toHaveLength(1);
  });

  it("sostituisce una scheda degli stessi file che ha i pezzi ma non lo schematico", async () => {
    const senzaSchematico = { ...cache("h1", {}), circuitJson: [...board, { type: "source_component" }] };
    await earlyBoardSaver("p", "h1", senzaSchematico)(early);
    expect(saved.calls).toHaveLength(1);
  });
});
