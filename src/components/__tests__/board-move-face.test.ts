import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BoardCanvas } from "../board/BoardCanvas";
import { VIEW_PRESETS } from "../ViewPresets";

/*
 * Un pezzo sopra e uno sotto nello stesso punto, come C10 sopra e il suo vicino
 * sul retro di sbb-dl-retro. In "Sposta" con la faccia Top si vede e si prende
 * solo il pezzo di sopra (2026-11-09, "e' un casino"): niente riquadro, niente
 * maniglia per quello di sotto. Le due facce insieme solo se richieste.
 */
const CIRCUIT = [
  { type: "pcb_board", width: 20, height: 20, center: { x: 0, y: 0 }, num_layers: 2 },
  { type: "source_component", source_component_id: "s1", name: "C10" },
  { type: "source_component", source_component_id: "s2", name: "R36" },
  { type: "pcb_component", pcb_component_id: "pc_top", source_component_id: "s1", center: { x: 0, y: 0 }, width: 1, height: 0.5, rotation: 0, layer: "top" },
  { type: "pcb_component", pcb_component_id: "pc_bot", source_component_id: "s2", center: { x: 0.2, y: 0 }, width: 1, height: 0.5, rotation: 0, layer: "bottom" },
  { type: "pcb_courtyard_rect", pcb_courtyard_rect_id: "cy_bot", pcb_component_id: "pc_bot", center: { x: 0.2, y: 0 }, width: 1.4, height: 0.9, layer: "bottom" },
];

const flags = { ...VIEW_PRESETS[0].flags, is_showing_courtyards: true };
/** the drag handles: one invisible rectangle per part that can be grabbed */
const maniglie = (svg: string) => svg.match(/<rect[^>]*style="cursor:move"[^>]*>/g) ?? [];
const disegna = (props: Record<string, unknown>) =>
  renderToStaticMarkup(
    createElement(BoardCanvas, { circuitJson: CIRCUIT, flags, layer: "top", mode: "move", ...props } as never),
  );

describe("Sposta mostra e fa prendere solo i pezzi della faccia scelta", () => {
  it("con Top si prende solo il pezzo di sopra, e il riquadro del retro non c'e'", () => {
    const svg = disegna({});
    expect(maniglie(svg)).toHaveLength(1);
    expect(maniglie(svg)[0]).toMatch(/x="-0.5"/);
    // the courtyard of the bottom part is not drawn over the top face
    expect(svg).not.toMatch(/width="1.4"/);
  });

  it("con Bottom solo quello di sotto", () => {
    const svg = disegna({ layer: "bottom" });
    expect(maniglie(svg)).toHaveLength(1);
    expect(maniglie(svg)[0]).toMatch(/x="-0.3"/);
  });

  it("Top + Bottom, se richiesto, li fa prendere tutti e due", () => {
    const svg = disegna({ bothSides: true });
    expect(maniglie(svg)).toHaveLength(2);
    expect(svg).toMatch(/width="1.4"/);
  });

  it("in Guarda non cambia niente: tutti e due hanno il riquadro del passaggio del mouse", () => {
    const svg = renderToStaticMarkup(
      createElement(BoardCanvas, { circuitJson: CIRCUIT, flags, layer: "top", mode: "view" } as never),
    );
    expect(svg.match(/<rect[^>]*style="cursor:pointer"[^>]*>/g) ?? []).toHaveLength(2);
  });
});
