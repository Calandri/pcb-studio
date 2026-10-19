import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The order of the Altium pipeline: the project row and its owner come BEFORE
 * the first file is written, and a failure there writes nothing. Everything the
 * pipeline talks to is replaced, so this checks the order and nothing else.
 */

const stato = vi.hoisted(() => ({
  eventi: [] as string[],
  scritti: new Map<string, string>(),
}));

vi.mock("@/lib/project-store", () => ({
  writeProjectFile: vi.fn(async (id: string, path: string, content: string) => {
    stato.eventi.push(`scrivi ${id} ${path}`);
    stato.scritti.set(path, content);
  }),
  getProject: vi.fn(async () => ({})),
  filesHash: vi.fn(() => "h"),
  saveCompileCache: vi.fn(async () => {}),
}));
vi.mock("@/lib/library-store", () => ({ saveLibraryComponent: vi.fn(async () => ({ version: 1 })) }));
vi.mock("@/lib/model-store", () => ({ saveProjectModel: vi.fn(async () => {}) }));
vi.mock("@/lib/altium-datasheets", () => ({
  codiciLcsc: vi.fn(async () => ({
    codici: new Map([["C-1", "C123"]]),
    approssimati: [{ mpn: "LM358", trovato: "LM358D" }],
  })),
  importDatasheetsForIdentities: vi.fn(async () => null),
}));
vi.mock("@/lib/altium-import", async (originale) => {
  const vero = await originale<typeof import("@/lib/altium-import")>();
  return {
    ...vero,
    importAltiumProject: vi.fn(async () => ({
      fsMap: { "main.tsx": '<board>\n    <capacitor name="C_1" capacitance={"1uF"} />\n</board>' },
      modelli3d: [],
      identita: new Map(),
      routes: [],
      components: 1,
      traces: 0,
      nomi: new Map([["C-1", "C_1"]]),
      warnings: [],
      stats: {},
    })),
  };
});

import { importaAltium } from "@/lib/altium-pipeline";

const files = [{ path: "board.PcbDoc", data: new ArrayBuffer(8) }];

beforeEach(() => {
  stato.eventi.length = 0;
  stato.scritti.clear();
});

describe("Altium pipeline", () => {
  it("creates the project with its owner before writing, and says it is new", async () => {
    const report = await importaAltium({
      files,
      conDatasheet: false,
      conFootprint: false,
      compila: false,
      preparaProgetto: async (id, nuovo) => {
        stato.eventi.push(`prepara ${id} ${nuovo}`);
      },
    });
    expect(stato.eventi[0]).toBe(`prepara ${report.projectId} true`);
    expect(stato.eventi.slice(1).every((e) => e.startsWith("scrivi"))).toBe(true);
    expect(stato.eventi.length).toBeGreaterThan(1);
  });

  it("an explicit project is prepared as existing", async () => {
    await importaAltium({
      files,
      projectId: "mio-progetto",
      conDatasheet: false,
      conFootprint: false,
      compila: false,
      preparaProgetto: async (id, nuovo) => {
        stato.eventi.push(`prepara ${id} ${nuovo}`);
      },
    });
    expect(stato.eventi[0]).toBe("prepara mio-progetto false");
  });

  it("writes nothing when the project cannot be prepared", async () => {
    await expect(
      importaAltium({
        files,
        projectId: "di-un-altro",
        conDatasheet: false,
        conFootprint: false,
        compila: false,
        preparaProgetto: async () => {
          throw new Error("nessun permesso di scrittura su di-un-altro");
        },
      }),
    ).rejects.toThrow(/permesso/);
    expect(stato.eventi).toEqual([]);
  });

  it("order codes land on the name main.tsx uses, and approximate ones are not written", async () => {
    const report = await importaAltium({
      files,
      conDatasheet: true,
      conFootprint: false,
      compila: false,
      preparaProgetto: async () => {},
    });
    expect(stato.scritti.get("main.tsx")).toContain(
      '<capacitor name="C_1" supplierPartNumbers={{ jlcpcb: ["C123"] }} capacitance={"1uF"} />',
    );
    expect(report.codiciLcsc).toBe(1);
    expect(report.warnings.join("\n")).toMatch(/LM358 -> LM358D/);
  });
});
