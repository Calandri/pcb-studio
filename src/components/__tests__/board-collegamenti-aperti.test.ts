import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BoardCanvas } from "../board/BoardCanvas";
import { COLORE_APERTO, LegendaAperti, apertiInVista, vistaSulCollegamento } from "../board/CollegamentiAperti";
import { VIEW_PRESETS } from "../ViewPresets";
import { pezzo, piedinoPassante, rete, scheda, trace, wire, type El } from "@/lib/__tests__/scheda-di-prova";

/*
 * "I collegamenti mancanti non c'e' modo di vederli visivamente" (Niccolo',
 * 2026-11-12): il pannello diceva "Collegamenti aperti 2" e sulla scheda
 * niente. La vista "Collegamenti mancanti" accendeva un flag che nessuno
 * leggeva e non disegnava niente.
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
/** i gruppi dei collegamenti aperti disegnati, uno per tratto */
const aperti = (svg: string): string[] => svg.match(/<g data-aperto="[^"]*"[^>]*>.*?<\/g><\/g>/g) ?? [];

describe("la vista Collegamenti mancanti disegna i collegamenti aperti", () => {
  it("passa le linee al disegno: una per tratto, da piazzola a piazzola", () => {
    const svg = disegna(UNO_APERTO, { flags: preset("connections") });
    expect(svg).toContain('data-collegamenti-aperti="1"');
    const tratti = aperti(svg);
    expect(tratti).toHaveLength(1);
    expect(tratti[0]).toContain('data-rete="SDA"');
    // da R3 (12; 0) a R2 (5; 0), la piazzola piu' vicina del gruppo unito
    expect(tratti[0]).toMatch(new RegExp(`<line x1="12" y1="0" x2="5" y2="0" stroke="${COLORE_APERTO}"[^>]*stroke-dasharray="2 4"`));
    // un segno a ciascun capo
    expect(tratti[0].match(/data-capo=/g)).toHaveLength(2);
  });

  it("anche nella vista Tutto, che accende lo stesso livello", () => {
    expect(disegna(UNO_APERTO, { flags: preset("everything") })).toContain('data-collegamenti-aperti="1"');
  });

  it("una rete tutta unita non ha linee", () => {
    expect(disegna(TUTTA_UNITA, { flags: preset("connections") })).not.toContain("data-collegamenti-aperti");
  });

  it("nelle altre viste non ci sono, finche' la persona non li chiede dal pannello", () => {
    for (const key of ["overview", "assembly", "copper", "interference", "fabrication"]) {
      expect(disegna(UNO_APERTO, { flags: preset(key) })).not.toContain("data-collegamenti-aperti");
      // chiesti dal pannello: ci sono, in ogni vista
      expect(disegna(UNO_APERTO, { flags: preset(key), apertiAccesi: true })).toContain('data-collegamenti-aperti="1"');
    }
    expect(apertiInVista(preset("overview"), false)).toBe(false);
    expect(apertiInVista(preset("overview"), true)).toBe(true);
    expect(apertiInVista(preset("connections"), false)).toBe(true);
  });

  it("in un angolo dice quanti sono e come si leggono i capi; se non ce ne sono lo dice", () => {
    const con = disegna(UNO_APERTO, { flags: preset("connections") });
    expect(con).toContain('data-legenda-aperti="1"');
    expect(con).toContain("1 collegamento aperto");
    expect(con).toContain("capo su questa faccia");
    const senza = disegna(TUTTA_UNITA, { flags: preset("connections") });
    expect(senza).toContain("Nessun collegamento aperto");
    // fuori dalla vista, e non chiesti: nessuna legenda
    expect(disegna(UNO_APERTO, { flags: preset("overview") })).not.toContain("data-legenda-aperti");
  });

  it("se il calcolo si ferma lo dice, invece di una vista vuota che sembra 'niente di aperto'", () => {
    const rotta = [...UNO_APERTO, null] as never as El[];
    const html = renderToStaticMarkup(createElement(LegendaAperti, { circuitJson: rotta }));
    expect(html).toContain("Collegamenti aperti non disegnati");
    expect(html).not.toContain("Nessun collegamento aperto");
  });

  it("si vedono anche in Sposta", () => {
    expect(disegna(UNO_APERTO, { flags: preset("connections"), mode: "move" })).toContain('data-collegamenti-aperti="1"');
  });

  it("quello scelto nel pannello e' evidenziato: linea continua e un anello a ogni capo", () => {
    const svg = disegna(UNO_APERTO, { flags: preset("overview"), apertiAccesi: true, apertoScelto: { id: "SDA#0", n: 1 } });
    const [tratto] = aperti(svg);
    expect(tratto).toContain("data-aperto-scelto");
    expect(tratto).not.toContain("stroke-dasharray");
    expect(tratto.match(/class="drc-marker"/g)).toHaveLength(2);
  });
});

describe("un capo sul top e uno sul bottom: si vedono da ogni faccia", () => {
  /** R1 sul top, C1 sul bottom, niente rame: il tratto va da una faccia all'altra */
  const DUE_FACCE: El[] = [BOARD, ...pezzo("R1", [["1", 0, 0, "top"]]), ...pezzo("C1", [["1", 6, 0, "bottom"]]), ...rete(1, "SDA", ["R1_1", "C1_1"])];
  const capiDi = (layer: string, xray = 0) => {
    const [tratto] = aperti(disegna(DUE_FACCE, { flags: preset("connections"), layer, xray }));
    expect(tratto).toBeDefined();
    return (tratto.match(/data-capo="(pieno|vuoto)"><circle cx="(-?[\d.]+)"/g) ?? [])
      .map((m) => /data-capo="(\w+)"><circle cx="(-?[\d.]+)"/.exec(m)!)
      .map((m) => `${m[2] === "0" ? "R1" : "C1"}:${m[1]}`)
      .sort();
  };

  it("guardando il top: pieno il capo sul top, vuoto quello sul bottom; la linea c'e'", () => {
    expect(capiDi("top")).toEqual(["C1:vuoto", "R1:pieno"]);
  });

  it("guardando il bottom: il contrario", () => {
    expect(capiDi("bottom")).toEqual(["C1:pieno", "R1:vuoto"]);
  });

  it("con Tutti gli strati sono pieni tutti e due; con i raggi X l'altra faccia resta vuota", () => {
    expect(capiDi("all")).toEqual(["C1:pieno", "R1:pieno"]);
    expect(capiDi("top", 60)).toEqual(["C1:vuoto", "R1:pieno"]);
  });

  it("un foro passante e' su ogni faccia: pieno da qualunque parte si guardi", () => {
    const conForo: El[] = [BOARD, ...pezzo("C1", [["1", 6, 0, "bottom"]]), ...piedinoPassante("J4", "pin3", 0, 0), ...rete(1, "TASTO", ["C1_1", "J4_pin3"])];
    for (const layer of ["top", "bottom"]) {
      const [tratto] = aperti(disegna(conForo, { flags: preset("connections"), layer }));
      const foro = /data-capo="(\w+)"><circle cx="0"/.exec(tratto)!;
      expect(foro[1]).toBe("pieno");
    }
  });
});

describe("dal pannello alla scheda", () => {
  const tratto = { da: { x: 12, y: 0 }, a: { x: 5, y: 0 } } as never;

  it("porta il mezzo del tratto al centro, senza cambiare uno zoom che va gia' bene", () => {
    const v = vistaSulCollegamento(tratto, { w: 800, h: 600 }, { x: 0, y: 0, k: 30 });
    expect(v.k).toBe(30);
    // il mezzo e' (8,5; 0): a 30 px/mm sta a 255 px dall'origine
    expect(v.x).toBeCloseTo(400 - 8.5 * 30, 6);
    expect(v.y).toBeCloseTo(300, 6);
  });

  it("allontana quanto serve perche' i due capi stiano dentro", () => {
    const v = vistaSulCollegamento(tratto, { w: 800, h: 600 }, { x: 0, y: 0, k: 200 });
    // 7 mm in non piu' del 60% del lato corto
    expect(v.k).toBeCloseTo((600 * 0.6) / 7, 6);
  });

  it("avvicina quanto serve perche' il tratto si veda", () => {
    const v = vistaSulCollegamento(tratto, { w: 800, h: 600 }, { x: 0, y: 0, k: 2 });
    expect(v.k).toBeCloseTo(120 / 7, 6);
    // due piazzole una sopra l'altra su due facce: mai oltre 60 px/mm
    const sopra = { da: { x: 1, y: 1 }, a: { x: 1, y: 1 } } as never;
    expect(vistaSulCollegamento(sopra, { w: 800, h: 600 }, { x: 0, y: 0, k: 2 }).k).toBe(60);
  });
});
