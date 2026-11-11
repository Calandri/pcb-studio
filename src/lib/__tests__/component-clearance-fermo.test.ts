import { describe, expect, it, vi } from "vitest";

/*
 * A check that stops never takes the compile down with it, and a board whose
 * footprints were not measured is never shown as one where no part hits
 * another: the reading of the footprints is made to throw here.
 */
vi.mock("@/lib/ingombro", async (originale) => {
  const vero = await originale<typeof import("@/lib/ingombro")>();
  return {
    ...vero,
    leggiIngombri: () => {
      throw new Error("ingombro illeggibile");
    },
  };
});

import { summarizeCircuit } from "@/lib/compile";
import { buildBoardReport } from "@/lib/board-report";

describe("the footprints check that stops", () => {
  it("the compile goes on, says the footprints were not measured, and is not all green", () => {
    const cj = [
      { type: "pcb_board", pcb_board_id: "b", center: { x: 0, y: 0 }, width: 10, height: 10, num_layers: 2 },
      { type: "source_component", source_component_id: "s1", name: "R1", ftype: "simple_resistor" },
      { type: "pcb_component", pcb_component_id: "R1", source_component_id: "s1", center: { x: 0, y: 0 }, layer: "top", rotation: 0, width: 1, height: 0.5 },
      { type: "pcb_smtpad", pcb_smtpad_id: "p1", pcb_component_id: "R1", shape: "rect", x: -0.5, y: 0, width: 0.6, height: 0.5, layer: "top" },
      { type: "pcb_smtpad", pcb_smtpad_id: "p2", pcb_component_id: "R1", shape: "rect", x: 0.5, y: 0, width: 0.6, height: 0.5, layer: "top" },
    ];
    const s = summarizeCircuit(cj);
    expect(s.courtyards).toMatchObject({ count: 0, nonMisurati: "ingombro illeggibile" });
    expect(s.targets.courtyardCollisions).toBe(0);
    expect(s.targets.allGreen).toBe(false);
    expect(s.message).toContain("ATTENZIONE: gli ingombri dei pezzi NON sono stati misurati: il controllo si e' fermato (ingombro illeggibile).");
    // the report says it in amber, never "ok"
    expect(buildBoardReport(cj, s).checks.find((c) => c.id === "place")).toMatchObject({ severity: "warn", count: "non misurati" });
  });
});
