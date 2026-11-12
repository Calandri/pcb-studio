import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The order of the Altium pipeline: the project row and its owner come BEFORE
 * the first file is written, and a failure there writes nothing. Everything the
 * pipeline talks to is replaced, so this checks the order and nothing else.
 */

const stato = vi.hoisted(() => ({
  eventi: [] as string[],
  scritti: new Map<string, string>(),
  /** the files the project already has, for an import over an existing project */
  esistenti: new Map<string, string>(),
}));

vi.mock("@/lib/project-store", () => ({
  writeProjectFile: vi.fn(async (id: string, path: string, content: string) => {
    stato.eventi.push(`scrivi ${id} ${path}`);
    stato.scritti.set(path, content);
  }),
  // a write over the file as it is: `change` gets what the project has and gives what to write
  updateProjectFile: vi.fn(async (id: string, path: string, change: (current: string | null) => string | null) => {
    const content = change(stato.esistenti.get(path) ?? null);
    if (content !== null) {
      stato.eventi.push(`scrivi ${id} ${path}`);
      stato.scritti.set(path, content);
    }
    return { written: content !== null, content };
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

import { importAltiumProject } from "@/lib/altium-import";
import { importaAltium } from "@/lib/altium-pipeline";
import { buildProjectRules, DESIGN_RULES_PATH, serializeDesignRules } from "@/lib/design-rules";

const files = [{ path: "board.PcbDoc", data: new ArrayBuffer(8) }];

beforeEach(() => {
  stato.eventi.length = 0;
  stato.scritti.clear();
  stato.esistenti.clear();
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

/*
 * An Altium file that states its limits writes design-rules.json anew
 * (altium-import.ts). Imported over a project that exists, that file replaces
 * one that may declare the board's stackup: the stackup stays.
 */
describe("Altium pipeline over an existing project: the rules are rewritten, the stackup stays", () => {
  /** st-camera: JLCPCB JLC06161H-3313, as jlcpcb.com/impedance gives it */
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
  /** the rules an Altium board brings, as the reader writes them */
  const REGOLE_ALTIUM = serializeDesignRules(buildProjectRules("custom", { minClearanceMm: 0.1524, autoPlaneVias: false, autoroute: false }));
  const conRegole = () =>
    vi.mocked(importAltiumProject).mockResolvedValueOnce({
      fsMap: { "main.tsx": "<board />", [DESIGN_RULES_PATH]: REGOLE_ALTIUM },
      modelli3d: [],
      identita: new Map(),
      routes: [],
      components: 0,
      traces: 0,
      nomi: new Map(),
      warnings: [],
      stats: {},
    } as never);
  const importa = (projectId?: string) =>
    importaAltium({ files, projectId, conDatasheet: false, conFootprint: false, compila: false, preparaProgetto: async () => {} });

  it("the project declared a stackup: the file written has the Altium rules and that stackup", async () => {
    stato.esistenti.set(DESIGN_RULES_PATH, JSON.stringify({ preset: "oshpark", stackup: ST_CAMERA }));
    conRegole();
    await importa("mio-progetto");
    const scritto = JSON.parse(stato.scritti.get(DESIGN_RULES_PATH)!) as { preset: string; rules: Record<string, unknown>; stackup: unknown };
    expect(scritto.preset).toBe("custom");
    expect(scritto.rules).toMatchObject({ minClearanceMm: 0.1524, autoPlaneVias: false, autoroute: false });
    expect(scritto.stackup).toEqual(ST_CAMERA);
  });

  it("no stackup before, or a new project: the rules are written as the reader built them, to the letter", async () => {
    stato.esistenti.set(DESIGN_RULES_PATH, JSON.stringify({ preset: "oshpark" }));
    conRegole();
    await importa("mio-progetto");
    expect(stato.scritti.get(DESIGN_RULES_PATH)).toBe(REGOLE_ALTIUM);
    stato.scritti.clear();
    stato.esistenti.clear();
    conRegole();
    await importa();
    expect(stato.scritti.get(DESIGN_RULES_PATH)).toBe(REGOLE_ALTIUM);
  });
});
