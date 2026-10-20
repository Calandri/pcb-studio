import { describe, expect, it } from "vitest";
import { convertSoupToGerberCommands, stringifyGerberCommandLayers } from "circuit-json-to-gerber";
import { SERIGRAFIA_TRATTO_MINIMO_MM, serigrafiaStampabile } from "@/lib/silk-stroke";

const diametri = (gerber: string): number[] =>
  [...gerber.matchAll(/%ADD\d+C,([0-9.]+)/g)].map((m) => Number(m[1]));

describe("serigrafia stampabile", () => {
  it("una lettera da 0,559 mm esce dal Gerber con il tratto minimo, non con 0,07 mm", () => {
    const cj = [
      { type: "pcb_board", pcb_board_id: "b", center: { x: 0, y: 0 }, width: 20, height: 20, thickness: 1.6, num_layers: 2, material: "fr4" },
      {
        type: "pcb_silkscreen_text", pcb_silkscreen_text_id: "t", pcb_component_id: "c", font: "tscircuit2024",
        font_size: 0.559, text: "C29", layer: "top", anchor_position: { x: 1, y: 1 }, anchor_alignment: "center",
      },
      {
        type: "pcb_silkscreen_path", pcb_silkscreen_path_id: "p", pcb_component_id: "c", layer: "bottom",
        route: [{ x: 0, y: 0 }, { x: 2, y: 0 }], stroke_width: 0.25,
      },
    ];
    const grezzi = stringifyGerberCommandLayers(convertSoupToGerberCommands(cj as never)) as Record<string, string>;
    // the library really does draw it at an eighth of the font size
    expect(diametri(grezzi.F_SilkScreen)).toContain(0.069875);

    const { layers, allargate } = serigrafiaStampabile(grezzi);
    expect(allargate).toBeGreaterThan(0);
    const fronte = diametri(layers.F_SilkScreen);
    expect(Math.min(...fronte)).toBeGreaterThanOrEqual(SERIGRAFIA_TRATTO_MINIMO_MM);
    // a pen already wide enough stays as it was
    expect(diametri(layers.B_SilkScreen)).toContain(0.25);
    // copper and mask are not touched
    for (const nome of Object.keys(grezzi)) {
      if (!/silkscreen/i.test(nome)) expect(layers[nome]).toBe(grezzi[nome]);
    }
    // the strokes keep their coordinates: only the aperture table changes
    const corpo = (g: string) => g.split("\n").filter((r) => !r.startsWith("%ADD")).join("\n");
    expect(corpo(layers.F_SilkScreen)).toBe(corpo(grezzi.F_SilkScreen));
  });

  it("lascia stare le aperture rettangolari e quelle gia' larghe", () => {
    const g = "%ADD10C,0.069875*%\n%ADD11R,0.600000X0.640000*%\n%ADD12C,0.200000*%\n%ADD13C,0.100000X0.050000*%\n";
    const { layers, allargate } = serigrafiaStampabile({ F_SilkScreen: g, F_Cu: g });
    expect(allargate).toBe(2);
    expect(layers.F_SilkScreen).toBe("%ADD10C,0.150000*%\n%ADD11R,0.600000X0.640000*%\n%ADD12C,0.200000*%\n%ADD13C,0.150000X0.050000*%\n");
    expect(layers.F_Cu).toBe(g);
  });
});
