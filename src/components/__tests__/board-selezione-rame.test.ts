import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BoardCanvas } from "../board/BoardCanvas";
import { VIEW_PRESETS } from "../ViewPresets";
import { pezzo, rete, scheda, trace, wire, type El } from "@/lib/__tests__/scheda-di-prova";

/*
 * Le linee tratteggiate di un pezzo selezionato andavano su tutta la rete,
 * anche fra piazzole gia' unite dal rame, e sono state prese per collegamenti
 * aperti (Niccolo', 2026-11-12). Ora c'e' una linea solo dove il rame manca;
 * cio' che e' unito lo dicono le piazzole accese e il rame della rete.
 */
const BOARD = scheda(2);

/** R1 e R2 unite da una pista, R3 fuori: un collegamento aperto, da R3 a R2 */
const UNO_APERTO: El[] = [
  BOARD,
  ...pezzo("R1", [["1", 0, 0]]),
  ...pezzo("R2", [["1", 5, 0]]),
  ...pezzo("R3", [["1", 12, 0]]),
  ...rete(1, "SDA", ["R1_1", "R2_1", "R3_1"]),
  trace("t1", "st_SDA_0", [wire(0, 0), wire(5, 0)]),
];
/** la stessa rete tutta unita */
const TUTTA_UNITA: El[] = [...UNO_APERTO, trace("t2", "st_SDA_2", [wire(5, 0), wire(12, 0)])];

const preset = (key: string) => VIEW_PRESETS.find((p) => p.key === key)!.flags;
const disegna = (circuitJson: El[], props: Record<string, unknown>) =>
  renderToStaticMarkup(createElement(BoardCanvas, { circuitJson, layer: "top", ...props } as never));
/** le linee tratteggiate del pezzo a fuoco */
const tratteggi = (svg: string): string[] => svg.match(/<line [^>]*stroke-dasharray="5 3"[^>]*>/g) ?? [];

describe("selezione di un pezzo: linee solo dove il rame manca", () => {
  it("rete tutta unita: nessuna linea tratteggiata, piazzole e rame della rete accesi", () => {
    const svg = disegna(TUTTA_UNITA, { flags: preset("overview"), hoveredComponentId: "pc_R1" });
    expect(tratteggi(svg)).toHaveLength(0);
    // le tre piazzole della rete sono accese
    expect(svg.match(/fill-opacity="0.35"/g)).toHaveLength(3);
    // e il rame della rete prende il colore delle piazzole: i due tratti di pista
    const rame = /<g data-rame-rete="SDA">(.*?)<\/g>/.exec(svg)?.[1] ?? "";
    expect(rame.match(/<line /g)).toHaveLength(2);
  });

  it("un piedino fuori: una linea sola, da lui alla piazzola piu' vicina del gruppo unito", () => {
    const svg = disegna(UNO_APERTO, { flags: preset("overview"), hoveredComponentId: "pc_R1" });
    const linee = tratteggi(svg);
    // prima erano due: l'albero su tutta la rete passava anche fra R1 e R2, gia' unite
    expect(linee).toHaveLength(1);
    expect(linee[0]).toMatch(/x1="5" y1="0" x2="12" y2="0"|x1="12" y1="0" x2="5" y2="0"/);
  });

  it("niente rame: l'albero unisce tutti i piedini, come prima", () => {
    const senzaRame = UNO_APERTO.filter((e) => e.type !== "pcb_trace");
    expect(tratteggi(disegna(senzaRame, { flags: preset("overview"), hoveredComponentId: "pc_R1" }))).toHaveLength(2);
  });

  it("un pezzo spostato e non ancora applicato ha lasciato il suo rame: le sue linee tornano", () => {
    const svg = disegna(TUTTA_UNITA, {
      flags: preset("overview"),
      mode: "move",
      hoveredComponentId: "pc_R1",
      moveOverrides: { pc_R1: { x: 0, y: 4 } },
    });
    const linee = tratteggi(svg);
    expect(linee).toHaveLength(1);
    // dalla piazzola dov'e' ora (0; 4) alla piu' vicina della rete
    expect(linee[0]).toMatch(/x1="0" y1="4"|x2="0" y2="4"/);
  });
});
