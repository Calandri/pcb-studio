import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BoardCanvas, chiaveInquadratura, vistaDopoRidimensionamento } from "../board/BoardCanvas";
import { VIEW_PRESETS } from "../ViewPresets";

/*
 * f413d3e: passando su un pezzo la barra sotto la scheda cresceva di una riga,
 * il riquadro della scheda cambiava misura e la scheda si reinquadrava: lo zoom
 * tornava indietro da solo (Niccolo', 2026-11-09). Lo zoom cambia solo se lo
 * chiede la persona.
 */
const centroMm = (v: { x: number; y: number; k: number }, s: { w: number; h: number }) => ({
  x: (s.w / 2 - v.x) / v.k,
  y: (v.y - s.h / 2) / v.k,
});

describe("lo zoom resta dov'e'", () => {
  it("ridimensionare il riquadro tiene la scala e il millimetro al centro", () => {
    // 30 px/mm su un angolo della scheda
    const v = { x: -500, y: 900, k: 30 };
    let s = { w: 1000, h: 700 };
    const c0 = centroMm(v, s);
    let w = v;
    for (const dopo of [{ w: 1000, h: 640 }, { w: 732, h: 640 }, { w: 1000, h: 700 }, { w: 1000, h: 699 }]) {
      w = vistaDopoRidimensionamento(w, s, dopo);
      s = dopo;
      expect(w.k).toBe(30);
      const c = centroMm(w, s);
      expect(c.x).toBeCloseTo(c0.x, 9);
      expect(c.y).toBeCloseTo(c0.y, 9);
    }
  });

  it("si reinquadra solo per una scheda diversa, mai per la misura del riquadro", () => {
    const board = { width: 42.5, height: 51.5 };
    expect(chiaveInquadratura(board, false)).toBeNull();
    expect(chiaveInquadratura(board, true)).toBe(chiaveInquadratura({ ...board }, true));
    expect(chiaveInquadratura({ width: 30, height: 20 }, true)).not.toBe(chiaveInquadratura(board, true));
  });

  it("la barra sotto la scheda ha la stessa altezza vuota, col pezzo, con la selezione", () => {
    const CIRCUIT = [
      { type: "pcb_board", width: 20, height: 20, center: { x: 0, y: 0 }, num_layers: 2 },
      { type: "source_component", source_component_id: "s1", name: "U7" },
      { type: "pcb_component", pcb_component_id: "pc_u7", source_component_id: "s1", center: { x: 0, y: 0 }, width: 4, height: 4, rotation: 0, layer: "top" },
    ];
    const info = { pc_u7: { name: "U7", titolo: "Espansore", testo: "Sedici GPIO", fonte: "progetto" as const, valore: "TCA6416" } };
    const barra = (props: Record<string, unknown>) => {
      const html = renderToStaticMarkup(createElement(BoardCanvas, { circuitJson: CIRCUIT, flags: VIEW_PRESETS[0].flags, layer: "top", partInfo: info, ...props } as never));
      return html.slice(html.lastIndexOf("</svg>")).match(/class="flex (h-\[\d+px\]) flex-none/)?.[1];
    };
    const altezze = [barra({ mode: "move" }), barra({ mode: "move", hoveredComponentId: "pc_u7" }), barra({ mode: "move", pickedId: "pc_u7" }), barra({ mode: "view" }), barra({ mode: "view", hoveredComponentId: "pc_u7" })];
    expect(new Set(altezze)).toEqual(new Set(["h-[60px]"]));
  });
});
