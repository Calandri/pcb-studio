import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BoardCanvas } from "../board/BoardCanvas";
import { COLORE_APERTO, LegendaAperti, type StatoAperti } from "../board/CollegamentiAperti";
import { ElencoAperti } from "../workspace/ElencoAperti";
import { VIEW_PRESETS } from "../ViewPresets";
import { apertiDellaScheda } from "@/lib/open-connections";
import { colata, pezzo, rete, scheda, trace, wire, type El } from "@/lib/__tests__/scheda-di-prova";

/*
 * "Pour non collegati [...] non si vede bene da PCB STUDIO" (Niccolo',
 * 17/11/2026). La colata isolata sta fra i collegamenti aperti: sulla scheda
 * il suo rame pieno e un anello rosso sul suo punto, nel pannello rete, area,
 * strato e punto.
 */
const ISOLA: El[] = [
  scheda(2),
  ...pezzo("C1", [["2", 0, 0]]),
  ...pezzo("C2", [["2", 6, 0]]),
  ...rete(1, "GND", ["C1_2", "C2_2"]),
  trace("t1", "st_GND_0", [wire(0, 0), wire(6, 0)]),
  colata("isola", 1, "top", 10, -2, 14, 2),
];

describe("la colata isolata si vede", () => {
  it("sulla scheda: il suo rame nel colore dei collegamenti aperti e l'anello rosso degli errori", () => {
    const svg = renderToStaticMarkup(
      createElement(BoardCanvas, { circuitJson: ISOLA, layer: "top", flags: VIEW_PRESETS.find((p) => p.key === "connections")!.flags } as never),
    );
    expect(svg).toContain('data-collegamenti-aperti="1"');
    const gruppo = /<g data-colata-isolata="GND#colata0">.*?<\/g>/.exec(svg)?.[0] ?? "";
    expect(gruppo).toContain(`fill="${COLORE_APERTO}"`);
    expect(gruppo).toMatch(/<path d="M10 -2L14 -2L14 2L10 2Z"/);
    expect(gruppo).toMatch(/<circle cx="12" cy="0"[^>]*stroke="#FF6B5A"[^>]*class="drc-marker"/);
    // e la linea fino al piedino piu' vicino della rete
    expect(svg).toMatch(/<g data-aperto="GND#colata0"[^>]*>.*?<line x1="12" y1="0" x2="6" y2="0"/);
  });

  it("nella legenda e nel pannello: rete, area, strato e punto", () => {
    expect(renderToStaticMarkup(createElement(LegendaAperti, { circuitJson: ISOLA }))).toContain("colata isolata");
    const stato: StatoAperti = { elenco: apertiDellaScheda(ISOLA), accesi: true, setAccesi: () => {}, scelto: null, scegli: () => {} };
    const html = renderToStaticMarkup(createElement(ElencoAperti, { aperti: stato, dichiarati: 1 }));
    expect(html).toContain("GND");
    expect(html).toContain("16 mm²");
    expect(html).toContain("colata isolata in (12; 0) → C2.2");
    expect(html).toContain("Top");
    // il conteggio salvato e' lo stesso: nessuna nota
    expect(html).not.toContain("ricontrolla la scheda");
  });
});
