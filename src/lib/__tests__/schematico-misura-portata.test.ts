import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Review of 11/11/2026: Sposta, a trace taken off and Ricontrolla save the
 * board again with a summary of their own, and the measure of the schematic
 * (schematicCostMs) did not travel with it: the next compile estimated as if
 * nothing had ever been measured on that board. The schematic on the board is
 * the same one, so its key, its measure and its note travel, from one place.
 */
const db = vi.hoisted(() => ({
  row: null as null | { filesHash: string; circuitJson: unknown[]; summary: unknown; createdAt: string; engineVersion: number; base?: unknown },
  files: {} as Record<string, string>,
  saves: [] as Array<{ hash: string; summary: Record<string, unknown> }>,
}));

vi.mock("@/lib/acl", () => ({ requireProjectAccess: vi.fn(async () => ({ viewer: null, ok: true })) }));
vi.mock("@/lib/agent-tools", () => ({ withLibrary: vi.fn(async (f: Record<string, string>) => f) }));
vi.mock("@/lib/project-store", async (originale) => {
  const vero = await originale<typeof import("@/lib/project-store")>();
  return {
    ...vero,
    getProject: vi.fn(async () => db.files),
    getCompileCache: vi.fn(async () => db.row),
    getCompileMeta: vi.fn(async () => (db.row ? { filesHash: db.row.filesHash, createdAt: db.row.createdAt, engineVersion: db.row.engineVersion, base: db.row.base ?? null } : null)),
    saveCompileCache: vi.fn(async (_p: string, hash: string, _cj: unknown[], summary: Record<string, unknown>) => {
      db.saves.push({ hash, summary });
      return { saved: true };
    }),
    updateProjectFile: vi.fn(async (_p: string, path: string, f: (current: string | null) => string | null) => {
      const next = f(db.files[path] ?? null);
      if (next !== null) db.files = { ...db.files, [path]: next };
      return { written: next !== null, content: next };
    }),
  };
});

import { POST as recheck } from "@/app/api/recheck/route";
import { POST as sposta } from "@/app/api/reroute-local/route";
import { POST as staccaPista } from "@/app/api/trace/route";
import { boardBaseOf } from "@/lib/board-base";
import { riportaLoSchematico, summarizeCircuit } from "@/lib/compile";
import { CHECKS_ENGINE_VERSION } from "@/lib/engine-version";
import { parseManualEdits, serializeManualEdits } from "@/lib/manual-edits";
import { filesHash } from "@/lib/project-store";

type El = Record<string, unknown>;
const pezzo = (n: number, name: string, x: number): El[] => [
  { type: "source_component", source_component_id: `sc${n}`, name },
  { type: "pcb_component", pcb_component_id: `pc${n}`, source_component_id: `sc${n}`, center: { x, y: 0 }, rotation: 0, width: 1, height: 0.5, layer: "top" },
  { type: "pcb_smtpad", pcb_smtpad_id: `pad${n}`, pcb_component_id: `pc${n}`, shape: "rect", x, y: 0, width: 0.5, height: 0.5, layer: "top" },
];
/** a saved board with its schematic and a trace */
const scheda = (): El[] => [
  { type: "pcb_board", pcb_board_id: "b", center: { x: 0, y: 0 }, width: 40, height: 30 },
  ...pezzo(1, "R1", 0),
  ...pezzo(2, "C1", 5),
  { type: "source_trace", source_trace_id: "st1", connected_source_port_ids: [], connected_source_net_ids: [], display_name: ".R1 > .pin1 to .C1 > .pin1" },
  { type: "pcb_trace", pcb_trace_id: "t1", source_trace_id: "st1", route: [{ route_type: "wire", x: 0, y: 0, width: 0.2, layer: "top" }, { route_type: "wire", x: 5, y: 0, width: 0.2, layer: "top" }] },
  { type: "schematic_component", schematic_component_id: "x1", source_component_id: "sc1" },
];
const modifiche = (pcb_placements: El[]) => serializeManualEdits({ ...parseManualEdits("{}"), pcb_placements } as never);
const file = (edits: string) => ({ "main.tsx": "export default () => <board />", "manual-edits.json": edits });
/** what the summary of the saved board says about its schematic */
const DI_PRIMA = { message: "salvata", schematicKey: "chiave-dello-schematico", schematicCostMs: 146_000, schematicCostParts: 156 };
const riga = (files: Record<string, string>) => ({
  filesHash: filesHash(files),
  circuitJson: scheda(),
  summary: DI_PRIMA,
  createdAt: "2026-11-11T07:00:00.000Z",
  engineVersion: CHECKS_ENGINE_VERSION,
  base: boardBaseOf(files),
});
const post = (body: unknown) => new Request("http://x/api", { method: "POST", body: JSON.stringify(body) });
const loSchematico = (s: Record<string, unknown>) => ({
  schematicKey: s.schematicKey,
  schematicCostMs: s.schematicCostMs,
  schematicCostParts: s.schematicCostParts,
});

describe("la misura dello schematico resta dopo Sposta, stacca pista e Ricontrolla", () => {
  beforeEach(() => {
    db.saves = [];
  });

  it("Sposta", async () => {
    const prima = file(modifiche([]));
    db.row = riga(prima);
    db.files = file(modifiche([{ selector: "R1", center: { x: 2, y: 0 } }]));
    const r = (await (await sposta(post({ projectId: "p" }))).json()) as { ok: boolean };
    expect(r.ok).toBe(true);
    expect(db.saves).toHaveLength(1);
    expect(loSchematico(db.saves[0].summary)).toEqual(loSchematico(DI_PRIMA));
  });

  it("stacca pista", async () => {
    db.files = file(modifiche([]));
    db.row = riga(db.files);
    const r = (await (await staccaPista(post({ projectId: "p", action: "delete", pcbTraceId: "t1" }))).json()) as { ok: boolean };
    expect(r.ok).toBe(true);
    expect(db.saves).toHaveLength(1);
    expect(loSchematico(db.saves[0].summary)).toEqual(loSchematico(DI_PRIMA));
  });

  it("Ricontrolla", async () => {
    db.files = file(modifiche([]));
    db.row = riga(db.files);
    const r = await recheck(post({ projectId: "p" }));
    expect(r.status).toBe(200);
    expect(db.saves).toHaveLength(1);
    expect(loSchematico(db.saves[0].summary)).toEqual(loSchematico(DI_PRIMA));
  });

  it("un riepilogo appena compilato porta la misura del suo profilo, e la nota che lo schematico manca resta", () => {
    const nuovo = summarizeCircuit(scheda() as never, {});
    const compilato = {
      profile: { spans: [{ name: "scheda senza schematico (tscircuit)", ms: 110_000 }, { name: "scheda con schematico (tscircuit)", ms: 245_000 }] },
      schematicCostParts: 156,
      schematicPending: "lo schematico non e' partito: restavano 120 s",
    };
    expect(riportaLoSchematico(nuovo, compilato)).toMatchObject({ schematicCostMs: 135_000, schematicCostParts: 156, schematicPending: compilato.schematicPending });
    // nothing measured, nothing invented
    const vuoto = riportaLoSchematico(summarizeCircuit(scheda() as never, {}), { message: "x" });
    expect(vuoto.schematicCostMs).toBeUndefined();
    expect(vuoto.schematicKey).toBeUndefined();
  });
});
