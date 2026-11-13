import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * THE FAST UPDATE DOES NOT FILE A BOARD OF FILES THAT ARE NO LONGER THERE.
 *
 * sbb-dl-principale, 2026-11-13: a trace dragged in Sposta, saved, and undone
 * three seconds later. The fast update of the drag was still working (twelve
 * seconds on that board): it had read the files with the correction in, and
 * when it ended it saved its board as the current one and the page showed it,
 * with the copper the undo had just taken out. "Ctrl+Z non va", and the next
 * drag, made on that board, was saved from a start no file had.
 *
 * The route reads the files again before it saves: if they changed while it
 * worked it saves nothing and answers `retry`, and the page asks again.
 */
const db = vi.hoisted(() => ({
  row: null as null | { filesHash: string; circuitJson: unknown[]; summary: unknown; createdAt: string; engineVersion: number; base?: unknown },
  files: {} as Record<string, string>,
  saves: [] as Array<{ hash: string; circuitJson: unknown[] }>,
  /** run once, after the route has read the files the first time: a save that lands while the update works */
  mentreLavora: null as null | (() => void),
}));

vi.mock("@/lib/acl", () => ({ requireProjectAccess: vi.fn(async () => ({ viewer: null, ok: true })) }));
vi.mock("@/lib/agent-tools", () => ({
  withLibrary: vi.fn(async (f: Record<string, string>) => {
    const poi = db.mentreLavora;
    db.mentreLavora = null;
    poi?.();
    return f;
  }),
}));
vi.mock("@/lib/project-store", async (originale) => {
  const vero = await originale<typeof import("@/lib/project-store")>();
  return {
    ...vero,
    getProject: vi.fn(async () => db.files),
    getCompileCache: vi.fn(async () => db.row),
    saveCompileCache: vi.fn(async (_p: string, hash: string, circuitJson: unknown[]) => {
      db.saves.push({ hash, circuitJson });
      return { saved: true };
    }),
  };
});

import { POST as sposta } from "@/app/api/reroute-local/route";
import { boardBaseOf } from "@/lib/board-base";
import { CHECKS_ENGINE_VERSION } from "@/lib/engine-version";
import { parseManualEdits, serializeManualEdits } from "@/lib/manual-edits";
import { filesHash } from "@/lib/project-store";

type El = Record<string, unknown>;
const pezzo = (n: number, name: string, x: number): El[] => [
  { type: "source_component", source_component_id: `sc${n}`, name },
  { type: "pcb_component", pcb_component_id: `pc${n}`, source_component_id: `sc${n}`, center: { x, y: 0 }, rotation: 0, width: 1, height: 0.5, layer: "top" },
  { type: "pcb_smtpad", pcb_smtpad_id: `pad${n}`, pcb_component_id: `pc${n}`, shape: "rect", x, y: 0, width: 0.5, height: 0.5, layer: "top" },
];
const scheda = (): El[] => [{ type: "pcb_board", pcb_board_id: "b", center: { x: 0, y: 0 }, width: 40, height: 30 }, ...pezzo(1, "R1", 0), ...pezzo(2, "C1", 5)];
const modifiche = (pcb_placements: El[]) => serializeManualEdits({ ...parseManualEdits("{}"), pcb_placements } as never);
const file = (edits: string) => ({ "main.tsx": "export default () => <board />", "manual-edits.json": edits });
const riga = (files: Record<string, string>) => ({
  filesHash: filesHash(files),
  circuitJson: scheda(),
  summary: { message: "salvata" },
  createdAt: "2026-11-13T07:00:00.000Z",
  engineVersion: CHECKS_ENGINE_VERSION,
  base: boardBaseOf(files),
});
const post = () => new Request("http://x/api", { method: "POST", body: JSON.stringify({ projectId: "p" }) });
const doveR1 = (cj: unknown[]) => ((cj as El[]).find((e) => e.type === "pcb_component" && e.pcb_component_id === "pc1")!.center as { x: number }).x;

describe("l'aggiornamento veloce e i file che cambiano mentre lavora", () => {
  beforeEach(() => {
    db.saves = [];
    db.mentreLavora = null;
  });

  it("file fermi: la scheda di quei file viene salvata, come sempre", async () => {
    db.row = riga(file(modifiche([])));
    db.files = file(modifiche([{ selector: "R1", center: { x: 2, y: 0 } }]));
    const r = (await (await sposta(post())).json()) as Record<string, unknown>;
    expect(r.ok).toBe(true);
    expect(db.saves).toHaveLength(1);
    expect(db.saves[0].hash).toBe(filesHash(db.files));
    expect(doveR1(db.saves[0].circuitJson)).toBe(2);
  });

  it("un salvataggio arriva mentre lavora: la scheda dei file di prima non viene salvata, e la risposta chiede di riprovare", async () => {
    db.row = riga(file(modifiche([])));
    // the files the update reads: R1 moved to x = 2
    const letti = file(modifiche([{ selector: "R1", center: { x: 2, y: 0 } }]));
    db.files = letti;
    // while it works an undo takes the move out
    const diAdesso = file(modifiche([]));
    db.mentreLavora = () => {
      db.files = diAdesso;
    };
    const r = (await (await sposta(post())).json()) as Record<string, unknown>;
    expect(r).toMatchObject({ ok: false, retry: true, reason: "i file sono cambiati mentre aggiornavo la scheda: riprovo su quelli di adesso" });
    expect(db.saves).toEqual([]);

    // asked again, as the page does: now it is the board of the files of now, with R1 where the undo left it
    const ancora = (await (await sposta(post())).json()) as Record<string, unknown>;
    expect(ancora.ok).toBe(true);
    expect(ancora.retry).toBeUndefined();
    expect(db.saves.map((s) => s.hash)).not.toContain(filesHash(letti));
  });
});
