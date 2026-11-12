import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/*
 * A footprint the reading cannot take (a throw in leggiIngombri) used to take
 * the whole PCB view down with it: buildScene had no try. The board is drawn,
 * without footprints, and the viewer says why in one line.
 */
vi.mock("@/lib/ingombro", async (originale) => ({
  ...(await originale<typeof import("@/lib/ingombro")>()),
  leggiIngombri: () => {
    throw new Error("contorno illeggibile");
  },
}));

const { buildScene } = await import("../board/render");
const { BoardCanvas } = await import("../board/BoardCanvas");
const { VIEW_PRESETS } = await import("../ViewPresets");

const CIRCUIT = [
  { type: "pcb_board", width: 30, height: 20, center: { x: 0, y: 0 }, num_layers: 2 },
  { type: "source_component", source_component_id: "s1", name: "C1" },
  { type: "pcb_component", pcb_component_id: "pc1", source_component_id: "s1", center: { x: 0, y: 0 }, width: 2, height: 1, rotation: 0, layer: "top" },
  { type: "pcb_smtpad", pcb_smtpad_id: "pad1", pcb_component_id: "pc1", shape: "rect", x: 0, y: 0, width: 1.37, height: 0.61, layer: "top" },
];

describe("the footprints that cannot be computed", () => {
  it("leave the scene drawn, with no footprints and the reason", () => {
    const scena = buildScene(CIRCUIT as never)!;
    expect(scena).not.toBeNull();
    expect(scena.pads.length).toBe(1);
    expect(scena.ingombri).toEqual([]);
    expect(scena.ingombriNonCalcolati).toBe("contorno illeggibile");
  });

  it("the viewer draws the board and says it in one line", () => {
    const svg = renderToStaticMarkup(
      createElement(BoardCanvas, { circuitJson: CIRCUIT, flags: { ...VIEW_PRESETS[0].flags, is_showing_courtyards: true }, mode: "view", layer: "top" } as never),
    );
    expect(svg).toContain('"1.37"');
    expect(svg).toContain("Ingombri non disegnati: il calcolo si e&#x27; fermato (contorno illeggibile)");
  });
});
