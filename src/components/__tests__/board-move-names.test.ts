import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BoardCanvas } from "../board/BoardCanvas";
import { layoutDesignators } from "../board/net-labels";
import { VIEW_PRESETS } from "../ViewPresets";

/*
 * In "Sposta" si deve sapere COSA si sposta (htl-401, 2026-11-09): il nome di
 * ogni pezzo della faccia visibile, e accanto al pezzo scelto o sotto il mouse
 * una scheda con nome, descrizione e valore.
 */
const CIRCUIT = [
  { type: "pcb_board", width: 20, height: 20, center: { x: 0, y: 0 }, num_layers: 2 },
  { type: "source_component", source_component_id: "s1", name: "U7" },
  { type: "source_component", source_component_id: "s2", name: "R36" },
  { type: "pcb_component", pcb_component_id: "pc_u7", source_component_id: "s1", center: { x: 0, y: 0 }, width: 4, height: 4, rotation: 0, layer: "top" },
  { type: "pcb_component", pcb_component_id: "pc_r36", source_component_id: "s2", center: { x: 5, y: 0 }, width: 1, height: 0.5, rotation: 0, layer: "bottom" },
];
const info = {
  pc_u7: { name: "U7", titolo: "Espansore I/O I2C TCA6416A", testo: "Sedici GPIO su I2C.", fonte: "progetto" as const, valore: "TCA6416ARTWR" },
};
const disegna = (props: Record<string, unknown>) =>
  renderToStaticMarkup(createElement(BoardCanvas, { circuitJson: CIRCUIT, flags: VIEW_PRESETS[0].flags, layer: "top", ...props } as never));

describe("Sposta: i nomi dei pezzi e la loro scheda", () => {
  it("in Sposta il nome di ogni pezzo della faccia visibile, in Guarda no", () => {
    const sposta = disegna({ mode: "move" });
    expect(sposta).toMatch(/>U7<\/text>/);
    expect(sposta).not.toMatch(/>R36<\/text>/);
    expect(disegna({ mode: "view" })).not.toMatch(/>U7<\/text>/);
  });

  it("accanto al pezzo sotto il mouse: nome, descrizione, valore, da dove viene", () => {
    const html = disegna({ mode: "move", hoveredComponentId: "pc_u7", partInfo: info });
    expect(html).toContain("Espansore I/O I2C TCA6416A");
    expect(html).toContain("TCA6416ARTWR");
    expect(html).toContain("scritta nel progetto");
    expect(html).toMatch(/pointer-events-none/);
  });

  it("i nomi non si sovrappongono e stanno fuori dai pad quando c'e' posto", () => {
    const parti = Array.from({ length: 40 }, (_, i) => ({ key: `c${i}`, name: `C${i + 10}`, cx: (i % 8) * 1.2, cy: Math.floor(i / 8) * 1.0, w: 1, h: 0.5 }));
    const pads = parti.flatMap((p) => [-0.45, 0.45].map((dx) => ({ bx: 400 + (p.cx + dx) * 30 - 6, by: 300 - p.cy * 30 - 6, bw: 12, bh: 12 })));
    const out = layoutDesignators(parti, pads, { x: 400, y: 300, k: 30 });
    for (let i = 0; i < out.length; i++)
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i], b = out[j];
        expect(a.bx < b.bx + b.bw && b.bx < a.bx + a.bw && a.by < b.by + b.bh && b.by < a.by + a.bh, `${a.name}/${b.name}`).toBe(false);
      }
  });
});
