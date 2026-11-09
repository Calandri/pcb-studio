import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * inspect_board went into timeout on fototrappola-frontale (219 parts): it
 * recompiled the whole board on every call, and a big board takes longer than
 * the HTTP answer. It reads the SAVED board now, and says at once when there
 * is none. A compile from here is a bug: the mock below fails the test.
 */

const store = vi.hoisted(() => ({
  cache: null as null | Record<string, unknown>,
  files: { "main.tsx": "export default () => <board />" } as Record<string, string>,
}));

vi.mock("@/lib/compile", () => ({
  compileProject: vi.fn(async () => {
    throw new Error("inspect_board non deve compilare");
  }),
}));

vi.mock("@/lib/agent-tools", () => ({
  withLibrary: async (fsMap: Record<string, string>) => fsMap,
}));

vi.mock("@/lib/project-store", async () => {
  const real = await vi.importActual<typeof import("@/lib/project-store")>("@/lib/project-store");
  return {
    ...real,
    getCompileCache: vi.fn(async () => store.cache),
    getProject: vi.fn(async () => store.files),
  };
});

import { compileProject } from "@/lib/compile";
import { filesHash } from "@/lib/project-store";
import { inspectSavedBoard } from "@/lib/saved-board";

const circuit = [
  { type: "pcb_board", width: 20, height: 20, num_layers: 2 },
  { type: "source_component", source_component_id: "sc1", name: "R1", ftype: "simple_resistor" },
  { type: "pcb_component", pcb_component_id: "pc1", source_component_id: "sc1", center: { x: 1, y: 2 }, layer: "top" },
];

describe("inspect_board legge la scheda salvata", () => {
  beforeEach(() => {
    store.cache = null;
    vi.mocked(compileProject).mockClear();
  });

  it("senza compilazione salvata risponde subito con un errore chiaro, senza compilare", async () => {
    const t0 = Date.now();
    const r = await inspectSavedBoard("fototrappola-frontale");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/nessuna scheda compilata/i);
    expect(compileProject).not.toHaveBeenCalled();
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("una compilazione fallita in cache non e' una scheda", async () => {
    store.cache = { filesHash: "x", circuitJson: [], summary: null, createdAt: "2026-11-09T20:00:00Z", engineVersion: 0 };
    const r = await inspectSavedBoard("p");
    expect(r.ok).toBe(false);
    expect(compileProject).not.toHaveBeenCalled();
  });

  it("con la scheda salvata restituisce componenti e problemi senza ricompilare", async () => {
    store.cache = {
      filesHash: filesHash(store.files),
      circuitJson: circuit,
      summary: {},
      createdAt: "2026-11-09T20:00:00Z",
      engineVersion: 0,
    };
    const r = await inspectSavedBoard("p");
    expect(compileProject).not.toHaveBeenCalled();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.stale).toBe(false);
    expect(r.result.compiledAt).toBe("2026-11-09T20:00:00Z");
    expect(r.result.components.map((c) => c.name)).toEqual(["R1"]);
  });

  it("dice quando la scheda salvata e' piu' vecchia dei sorgenti", async () => {
    store.cache = {
      filesHash: "hash-di-prima",
      circuitJson: circuit,
      summary: {},
      createdAt: "2026-11-09T20:00:00Z",
      engineVersion: 0,
    };
    const r = await inspectSavedBoard("p");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.stale).toBe(true);
    expect(r.result.nota).toMatch(/compile/);
  });
});

describe("lo strumento MCP inspect_board", () => {
  it("non ricompila: usa la scheda salvata", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const route = readFileSync(
      path.join(__dirname, "..", "..", "app", "api", "mcp", "[transport]", "route.ts"),
      "utf8",
    );
    const start = route.indexOf('"inspect_board",');
    expect(start).toBeGreaterThan(-1);
    const end = route.indexOf("server.tool(", start);
    const block = route.slice(start, end === -1 ? undefined : end);
    expect(block).not.toMatch(/compileProject\s*\(/);
    expect(block).toMatch(/inspectSavedBoard\s*\(/);
  });
});
