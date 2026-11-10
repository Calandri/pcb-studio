import { describe, expect, it } from "vitest";
import { GRID_DEFAULT, GRID_OPTIONS, grigliaSalvata, salvaGriglia } from "../board/griglia";
import { snapToGrid } from "../board/BoardCanvas";
import { applyPlacementPatches, emptyManualEdits, parsePlacementPatches } from "@/lib/manual-edits";
import { boardPartsByName, patchesFromEvents } from "../workspace/placement-patches";

/* Griglia da 0,125 mm in Sposta (Niccolo', 2026-11-10): prima scelta, e nessuno la arrotonda a 0,25. */
describe("griglia 0,125 mm", () => {
  it("e' la prima scelta e l'aggancio tiene i tre decimali", () => {
    expect(GRID_OPTIONS[0]).toBe(0.125);
    expect(snapToGrid(1.19, 0.125)).toBe(1.25);
    expect(snapToGrid(-4.07, 0.125)).toBe(-4.125);
    expect(snapToGrid(10.3 + 0.125, 0.125)).toBe(10.375);
    // forty steps of 0,125 land exactly, without float drift
    let x = 0;
    for (let i = 0; i < 41; i++) x = snapToGrid(x + 0.125, 0.125);
    expect(x).toBe(5.125);
  });

  it("la posizione salvata resta a 0,125: ne' il client ne' il server la riportano a 0,25", () => {
    const board = [
      { type: "source_component", source_component_id: "s1", name: "C1" },
      { type: "pcb_component", pcb_component_id: "p1", source_component_id: "s1", center: { x: 2, y: 3 }, display_offset_x: 2, display_offset_y: 3, rotation: 0, layer: "top" },
    ];
    const { placements } = patchesFromEvents(
      [{ edit_event_type: "edit_pcb_component_location", component_name: "C1", original_center: { x: 2, y: 3 }, new_center: { x: 2.125, y: 2.875 } }],
      boardPartsByName(board),
    );
    expect(placements).toEqual([{ name: "C1", x: 2.125, y: 2.875 }]);
    const { edits } = applyPlacementPatches(emptyManualEdits(), parsePlacementPatches(placements, 10));
    expect(edits.pcb_placements).toEqual([{ selector: "C1", center: { x: 2.125, y: 2.875 } }]);
  });

  it("l'ultima griglia scelta si ricorda per progetto, e un valore sconosciuto torna al predefinito", () => {
    const m = new Map<string, string>();
    const storage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    expect(grigliaSalvata("a", storage)).toBe(GRID_DEFAULT);
    salvaGriglia("a", 0.125, storage);
    expect(grigliaSalvata("a", storage)).toBe(0.125);
    expect(m.get("pcb-studio-griglia:a")).toBe("0.125");
    expect(grigliaSalvata("b", storage)).toBe(GRID_DEFAULT);
    m.set("pcb-studio-griglia:b", "0.3");
    expect(grigliaSalvata("b", storage)).toBe(GRID_DEFAULT);
    expect(grigliaSalvata(undefined, storage)).toBe(GRID_DEFAULT);
  });
});
