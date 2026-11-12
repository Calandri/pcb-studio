import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * "Cuci la massa" of the viewer goes through /api/stitch-ground: a look asks
 * to see the project, writing asks what write_file asks, and nothing compiles.
 */
const stato = vi.hoisted(() => ({
  livello: "edit" as "none" | "view" | "edit",
  files: {} as Record<string, string>,
}));
vi.mock("@/lib/acl", () => ({
  requireProjectAccess: vi.fn(async (_p: string, need: "view" | "edit") => ({
    viewer: null,
    ok: need === "view" ? stato.livello !== "none" : stato.livello === "edit",
  })),
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
vi.mock("@/lib/project-store", async (originale) => ({
  ...(await originale<typeof import("@/lib/project-store")>()),
  getProject: vi.fn(async () => ({ ...stato.files })),
  getCompileCache: vi.fn(async () => ({
    filesHash: "x",
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
}));
const compilazioni = vi.hoisted(() => ({ n: 0 }));
vi.mock("@/lib/compile", async (originale) => ({
  ...(await originale<typeof import("@/lib/compile")>()),
  compileProject: vi.fn(async () => {
    compilazioni.n++;
    throw new Error("nessuna compilazione deve partire da sola");
  }),
}));

const { POST } = await import("@/app/api/stitch-ground/route");
const chiedi = async (body: Record<string, unknown>) => {
  const r = await POST(new Request("http://localhost/api/stitch-ground", { method: "POST", body: JSON.stringify(body) }));
  return { status: r.status, d: (await r.json()) as Record<string, unknown> };
};

describe("/api/stitch-ground", () => {
  beforeEach(() => {
    stato.livello = "edit";
    stato.files = { "main.tsx": "export default () => <board />" };
    compilazioni.n = 0;
  });

  it("guardare chiede di vedere il progetto, scrivere chiede la modifica", async () => {
    stato.livello = "view";
    const guarda = await chiedi({ projectId: "p", passoMm: 2.5 });
    expect(guarda.status).toBe(200);
    expect(guarda.d.vie as number).toBeGreaterThan(5);
    expect(guarda.d.fileChanged).toBeUndefined();
    expect(await chiedi({ projectId: "p", passoMm: 2.5, apply: true })).toMatchObject({ status: 403 });
    expect(stato.files["cucitura-massa.tsx"]).toBeUndefined();
    stato.livello = "none";
    expect(await chiedi({ projectId: "p" })).toMatchObject({ status: 403 });
  });

  it("scrive il file, lo restituisce alla pagina e non compila", async () => {
    const r = await chiedi({ projectId: "p", passoMm: 2.5, apply: true });
    expect(r.status).toBe(200);
    expect(r.d).toMatchObject({ scritto: true, fileChanged: { path: "cucitura-massa.tsx" } });
    expect(stato.files["cucitura-massa.tsx"]).toBe((r.d.fileChanged as { content: string }).content);
    expect(stato.files["main.tsx"]).toBe("export default () => <board />");
    expect(compilazioni.n).toBe(0);
  });

  it("parametri fuori dai limiti: 422 con il motivo", async () => {
    const r = await chiedi({ projectId: "p", passoMm: 50 });
    expect(r.status).toBe(422);
    expect(String(r.d.error)).toMatch(/passoMm: 50 fuori dai limiti 1..10/);
  });
});
