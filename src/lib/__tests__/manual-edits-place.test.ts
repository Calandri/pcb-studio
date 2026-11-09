import { describe, expect, it, vi } from "vitest";
import { applyPlacementPatches, emptyManualEdits, parseManualEdits, parsePlacementPatches, serializeManualEdits } from "@/lib/manual-edits";

/*
 * A part dropped in Sposta is saved as a patch: its name and the absolute
 * place it has to stay, last write wins. On tm-4l-r3 (2026-11-09) each save
 * read the 3,8 MB board and sent back the whole 326 KB file with its 831
 * hand-drawn traces: seconds per drop. The patch needs neither.
 */

vi.mock("@/lib/acl", () => ({
  requireProjectAccess: async () => ({ ok: true, viewer: null }),
  accessoDaRichiesta: async () => false,
}));
// the real store (in memory in the tests), with the board read watched
vi.mock("@/lib/project-store", async (original) => {
  const real = await original<typeof import("@/lib/project-store")>();
  return { ...real, getCompileCache: vi.fn(real.getCompileCache) };
});

describe("le toppe delle posizioni", () => {
  it("si scartano i nomi vuoti, i numeri non finiti o fuori da una scheda, le facce sconosciute; due toppe dello stesso pezzo: l'ultima", () => {
    const p = parsePlacementPatches(
      [
        { name: "", x: 1, y: 1 },
        { name: "R1", x: Number.NaN, y: 1 },
        { name: "R2", x: 1e6, y: 1 },
        { name: "R3", x: 1, y: 1, layer: "inner1" },
        { name: "R4", x: 1, y: 1, rotation: "90" },
        { name: "C1", x: 1, y: 1 },
        { name: "C1", x: 2, y: 3, rotation: -90, layer: "bottom" },
        "R5",
      ],
      100,
    );
    expect(p).toEqual([{ name: "C1", x: 2, y: 3, rotation: 270, layer: "bottom" }]);
    expect(parsePlacementPatches("no", 10)).toEqual([]);
  });

  it("scrivono la posizione, tengono rotazione e faccia gia' scritte se non le dicono, e dicono cosa c'era prima", () => {
    const edits = {
      ...emptyManualEdits(),
      pcb_placements: [{ selector: "U1", center: { x: 0, y: 0 }, rotation: 90, layer: "bottom" as const }],
    };
    const { edits: next, before } = applyPlacementPatches(edits, [
      { name: "U1", x: 5, y: 6 },
      { name: "C9", x: 1.23456, y: 2 },
    ]);
    expect(next.pcb_placements).toEqual([
      { selector: "U1", center: { x: 5, y: 6 }, rotation: 90, layer: "bottom" },
      { selector: "C9", center: { x: 1.235, y: 2 } },
    ]);
    expect(before).toEqual([
      { selector: "U1", placement: { selector: "U1", center: { x: 0, y: 0 }, rotation: 90, layer: "bottom" } },
      { selector: "C9", placement: null },
    ]);
  });
});

describe("POST action place", () => {
  it("scrive solo le posizioni, non legge la scheda e risponde in piccolo", async () => {
    const store = await import("@/lib/project-store");
    const getCache = vi.mocked(store.getCompileCache);
    expect(process.env.DATABASE_URL).toBeUndefined();
    const P = "prova-place-memoria";
    await store.writeProjectFile(P, "main.tsx", "export default () => <board width=\"10mm\" height=\"10mm\" />");
    const routes = Array.from({ length: 300 }, (_, i) => ({
      connection: `n${i}`,
      layer: "top",
      width: 0.2,
      points: [
        { x: 0, y: i / 10 },
        { x: 5, y: i / 10 },
      ],
    }));
    await store.writeProjectFile(
      P,
      "manual-edits.json",
      serializeManualEdits({ ...emptyManualEdits(), pcb_routes: routes as never, pcb_placements: [{ selector: "R1", center: { x: 1, y: 1 } }] }),
    );
    const { POST } = await import("@/app/api/manual-edits/route");
    const r = await POST(
      new Request("http://x/api/manual-edits", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: P, action: "place", placements: [{ name: "R1", x: 3, y: 4 }] }),
      }),
    );
    expect(r.status).toBe(200);
    const text = await r.text();
    const d = JSON.parse(text);
    expect(d.placements).toEqual([{ selector: "R1", center: { x: 3, y: 4 } }]);
    expect(d.before).toEqual([{ selector: "R1", placement: { selector: "R1", center: { x: 1, y: 1 } } }]);
    // not the file back: no traces in the answer
    expect(d.edits).toBeUndefined();
    expect(text.length).toBeLessThan(400);
    expect(getCache).not.toHaveBeenCalled();
    // the file has the new position and keeps everything else
    const saved = parseManualEdits((await store.getProject(P))["manual-edits.json"]);
    expect(saved.pcb_placements).toEqual([{ selector: "R1", center: { x: 3, y: 4 } }]);
    expect(saved.pcb_routes).toHaveLength(routes.length);

    const vuota = await POST(
      new Request("http://x/api/manual-edits", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: P, action: "place", placements: [{ name: "R1", x: "3", y: 4 }] }),
      }),
    );
    expect(vuota.status).toBe(400);
  });
});
