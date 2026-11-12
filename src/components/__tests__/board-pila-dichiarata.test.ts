import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildBoardReport } from "@/lib/board-report";
import { DESIGN_RULES_PATH, resolveStackup } from "@/lib/design-rules";
import { LeftRail } from "../workspace/LeftRail";

/*
 * Il pannello "Sezione della scheda" con la pila dichiarata dal progetto
 * (design-rules.json, "stackup"): le quote vere al posto di quelle a passo
 * uguale. Chiesto per st-camera (Niccolo', 2026-11-12): sei strati, 1,6 mm,
 * pila JLCPCB JLC06161H-3313.
 *
 * I NUMERI VENGONO DALLA FONTE, mai dall'uscita del codice. ST_CAMERA e' la
 * pila come la da' jlcpcb.com/impedance, e le quote sono sommate a mano (la
 * faccia di sopra di ogni strato di rame, dalla faccia Top):
 *   L1 0
 *   L2 0,035 + 0,0994            = 0,1344
 *   L3 0,1344 + 0,0152 + 0,55    = 0,6996
 *   L4 0,6996 + 0,0152 + 0,1164  = 0,8312
 *   L5 0,8312 + 0,0152 + 0,55    = 1,3964
 *   L6 1,3964 + 0,0152 + 0,0994  = 1,5110
 *   in tutto 1,5110 + 0,035      = 1,5460
 * Le pile a due, quattro e dieci strati non sono di una fabbrica: numeri tondi
 * scelti per la prova, sommati a mano accanto a ognuna.
 */
const ST_CAMERA = {
  copperMm: [0.035, 0.0152, 0.0152, 0.0152, 0.0152, 0.035],
  dielectrics: [
    { mm: 0.0994, er: 4.1, kind: "prepreg", name: "3313" },
    { mm: 0.55, er: 4.6, kind: "core" },
    { mm: 0.1164, er: 4.16, kind: "prepreg", name: "2116" },
    { mm: 0.55, er: 4.6, kind: "core" },
    { mm: 0.0994, er: 4.1, kind: "prepreg", name: "3313" },
  ],
};
/** due strati: Bottom a 0,035 + 1,53 = 1,565; in tutto 1,565 + 0,035 = 1,6 */
const DUE_STRATI = { copperMm: [0.035, 0.035], dielectrics: [{ mm: 1.53 }] };
/** quattro strati: L2 0,035 + 0,2 = 0,235; L3 0,235 + 0,0175 + 1,1 = 1,3525; L4 1,3525 + 0,0175 + 0,2 = 1,57; in tutto 1,57 + 0,035 = 1,605 */
const QUATTRO_STRATI = {
  copperMm: [0.035, 0.0175, 0.0175, 0.035],
  dielectrics: [{ mm: 0.2, kind: "prepreg" }, { mm: 1.1, name: "FR4" }, { mm: 0.2, er: 4.4 }],
};

/** a board of n copper layers, with the thickness it declares (none: a Circuit JSON made by hand) */
const scheda = (n: number, spessore: number | undefined = 1.6) => [
  { type: "pcb_board", width: 30, height: 20, center: { x: 0, y: 0 }, num_layers: n, ...(spessore !== undefined ? { thickness: spessore } : {}) },
];
/** the project's files with this stackup written in design-rules.json: the report reads it from there, as the page does */
const progetto = (stackup: unknown) => ({ [DESIGN_RULES_PATH]: JSON.stringify({ preset: "jlcpcb_standard", stackup }) });
const rapporto = (n: number, stackup?: unknown, spessore?: number, cj: unknown[] = scheda(n, spessore)) =>
  buildBoardReport(cj, null, undefined, stackup === undefined ? undefined : resolveStackup(progetto(stackup)));
const pannello = (report: ReturnType<typeof buildBoardReport>) =>
  renderToStaticMarkup(
    createElement(LeftRail, {
      tab: "pcb", projectId: "p", report, schematic: null, nets: [], parts: [], preset: "overview",
      onPreset: () => {}, layer: "top", onLayer: () => {}, xray: 0, onXray: () => {}, onAskCopilot: () => {}, enclosures: null, scene: null,
    } as never),
  ).replace(/<!-- -->/g, "");
/** the rows of the panel as the page writes them: the name and, next to it, the depth */
const righe = (html: string) =>
  [...html.matchAll(/>([^<>]+)<\/span><span class="font-mono text-\[9px\] text-\[#4E625C\]">([\d,]+)<\/span>/g)].map((m) => `${m[1]} ${m[2]}`);
/** the faint lines between two rows: the dielectric under a layer */
const dielettrici = (html: string) => [...html.matchAll(/<span class="-my-\[2px\] pl-\[19px\][^"]*">([^<]+)<\/span>/g)].map((m) => m[1]);
/** the paragraphs under the rows, in order */
const note = (html: string) => [...html.matchAll(/<p class="px-1 text-\[10\.5px\][^"]*">([^<]+)<\/p>/g)].map((m) => m[1]);
/** the amber ones only: the warnings */
const avvisi = (html: string) => [...html.matchAll(/<p class="px-1 text-\[10\.5px\] leading-\[1\.4\] text-\[#E8B23B\]">([^<]+)<\/p>/g)].map((m) => m[1]);

const DICHIARATA = (totale: string) =>
  `La pila è quella dichiarata nel progetto: rame e dielettrici fanno in tutto ${totale} mm. Ogni quota è la profondità della faccia di sopra dello strato, misurata dalla faccia Top.`;
const INDICATIVE = (spessore: string) =>
  `Le quote in mm sono indicative: lo spessore della scheda (${spessore} mm) diviso in parti uguali. Non sono la pila vera, quella la decide chi fabbrica la scheda.`;
const RESTANO_INDICATIVE = (spessore: string) => `Le quote in mm restano indicative: lo spessore della scheda (${spessore} mm) diviso in parti uguali.`;

describe("senza pila dichiarata il pannello e' quello di prima", () => {
  it("6 strati: quote a passo uguale e la riga delle quote indicative, alla lettera", () => {
    const r = rapporto(6);
    expect(r.stackup).toEqual({ source: "none" });
    expect(r.nominalDepths).toBe(true);
    const html = pannello(r);
    // 1,6 / 5 = 0,32
    expect(righe(html)).toEqual(["Top 0,000", "Inner 1 0,320", "Inner 2 0,640", "Inner 3 0,960", "Inner 4 1,280", "Bottom 1,600"]);
    expect(note(html)).toEqual([INDICATIVE("1,6")]);
    expect(avvisi(html)).toEqual([]);
    expect(dielettrici(html)).toEqual([]);
  });

  it("un progetto senza design-rules.json, o con un file senza stackup, da' lo stesso resoconto di nessuna pila", () => {
    const base = rapporto(6);
    expect(buildBoardReport(scheda(6), null, undefined, resolveStackup({}))).toEqual(base);
    expect(buildBoardReport(scheda(6), null, undefined, resolveStackup({ [DESIGN_RULES_PATH]: JSON.stringify({ preset: "custom", rules: { minTraceWidthMm: 0.15 } }) }))).toEqual(base);
    // two layers: the two faces, and nothing to say under them
    const due = pannello(rapporto(2));
    expect(righe(due)).toEqual(["Top 0,000", "Bottom 1,600"]);
    expect(note(due)).toEqual([]);
  });
});

describe("con la pila dichiarata e giusta per la scheda: le quote vere", () => {
  it("st-camera, 6 strati, JLC06161H-3313 su 1,6 mm: 0 / 0,1344 / 0,6996 / 0,8312 / 1,3964 / 1,5110", () => {
    const r = rapporto(6, ST_CAMERA);
    expect(r.layers.map((l) => l.depthMm)).toEqual(["0,0000", "0,1344", "0,6996", "0,8312", "1,3964", "1,5110"]);
    expect(r.nominalDepths).toBe(false);
    expect(r.stackup.source).toBe("declared");
    if (r.stackup.source !== "declared") return;
    expect(r.stackup.totalMm).toBeCloseTo(1.546, 9);
    expect(r.stackup.boardThicknessMm).toBe(1.6);
    // 1,6 - 1,546 = 0,054, and a tenth of 1,6 is 0,16: within
    expect(r.stackup.outOfTolerance).toBe(false);
    // the thickness in the header stays the one the board declares
    expect(r.thicknessMm).toBe(1.6);

    const html = pannello(r);
    expect(righe(html)).toEqual(["Top 0,0000", "Inner 1 0,1344", "Inner 2 0,6996", "Inner 3 0,8312", "Inner 4 1,3964", "Bottom 1,5110"]);
    // the line of the nominal depths is gone, and the panel says whose the stackup is, with the total
    expect(note(html)).toEqual([DICHIARATA("1,546")]);
    expect(avvisi(html)).toEqual([]);
    expect(html).not.toContain("indicative");
  });

  it("fra uno strato e l'altro si legge il dielettrico: tipo e nome se ci sono, e lo spessore; er non si mostra", () => {
    const r = rapporto(6, ST_CAMERA);
    expect(r.layers.map((l) => l.dielectricBelow)).toEqual([
      "prepreg 3313 · 0,0994 mm",
      "core · 0,55 mm",
      "prepreg 2116 · 0,1164 mm",
      "core · 0,55 mm",
      "prepreg 3313 · 0,0994 mm",
      undefined,
    ]);
    const html = pannello(r);
    expect(dielettrici(html)).toEqual(["prepreg 3313 · 0,0994 mm", "core · 0,55 mm", "prepreg 2116 · 0,1164 mm", "core · 0,55 mm", "prepreg 3313 · 0,0994 mm"]);
    // each one under its layer and above the next: the names and the dielectrics, in the order of the page
    const ordine = [...html.matchAll(/text-\[12px\] font-semibold text-(?:brand|text)">([^<]+)<|<span class="-my-\[2px\][^"]*">([^<]+)</g)].map((m) => m[1] ?? m[2]);
    expect(ordine).toEqual([
      "Top", "prepreg 3313 · 0,0994 mm",
      "Inner 1", "core · 0,55 mm",
      "Inner 2", "prepreg 2116 · 0,1164 mm",
      "Inner 3", "core · 0,55 mm",
      "Inner 4", "prepreg 3313 · 0,0994 mm",
      "Bottom",
    ]);
    // 4,1 / 4,6 / 4,16 are stored in the file and written nowhere in the panel
    for (const er of ["4,1", "4.1", "4,6", "4.6", "4,16", "4.16"]) expect(dielettrici(html).join(" ") + note(html).join(" ")).not.toContain(er);
  });

  it("un piano resta detto accanto al nome, con la quota vera", () => {
    const conPiano = [...scheda(6), { type: "pcb_copper_pour", pcb_copper_pour_id: "p4", layer: "inner4", connects_to: "net.GND" }];
    expect(righe(pannello(rapporto(6, ST_CAMERA, undefined, conPiano)))).toEqual([
      "Top 0,0000", "Inner 1 0,1344", "Inner 2 0,6996", "Inner 3 0,8312", "Inner 4 · GND 1,3964", "Bottom 1,5110",
    ]);
  });

  it("due strati: Bottom a 1,565, in tutto 1,6; un dielettrico senza tipo ne' nome e' detto dielettrico", () => {
    const r = rapporto(2, DUE_STRATI);
    const html = pannello(r);
    expect(righe(html)).toEqual(["Top 0,0000", "Bottom 1,5650"]);
    expect(dielettrici(html)).toEqual(["dielettrico · 1,53 mm"]);
    expect(note(html)).toEqual([DICHIARATA("1,6")]);
    expect(avvisi(html)).toEqual([]);
  });

  it("quattro strati: 0 / 0,235 / 1,3525 / 1,57, in tutto 1,605 su 1,6", () => {
    const r = rapporto(4, QUATTRO_STRATI);
    const html = pannello(r);
    expect(righe(html)).toEqual(["Top 0,0000", "Inner 1 0,2350", "Inner 2 1,3525", "Bottom 1,5700"]);
    expect(dielettrici(html)).toEqual(["prepreg · 0,2 mm", "FR4 · 1,1 mm", "dielettrico · 0,2 mm"]);
    expect(note(html)).toEqual([DICHIARATA("1,605")]);
    expect(avvisi(html)).toEqual([]);
  });

  it("dieci strati: il pannello ha otto righe, ognuna con la quota del suo posto nella pila, e niente dielettrico dove salta due strati", () => {
    // ten coppers of 0,02 and nine dielectrics of 0,1: a layer every 0,12; inner6 is the seventh (6 x 0,12 = 0,72), bottom the tenth (9 x 0,12 = 1,08); all of it 1,08 + 0,02 = 1,1
    const dieci = { copperMm: Array.from({ length: 10 }, () => 0.02), dielectrics: Array.from({ length: 9 }, () => ({ mm: 0.1, kind: "core" })) };
    const r = rapporto(10, dieci, 1.1);
    const html = pannello(r);
    expect(righe(html)).toEqual(["Top 0,0000", "Inner 1 0,1200", "Inner 2 0,2400", "Inner 3 0,3600", "Inner 4 0,4800", "Inner 5 0,6000", "Inner 6 0,7200", "Bottom 1,0800"]);
    // under top and inner1..inner5; inner6 has inner7 under it, which has no row
    expect(dielettrici(html)).toHaveLength(6);
    expect(r.layers.find((l) => l.id === "inner6")?.dielectricBelow).toBeUndefined();
    expect(note(html)).toEqual([DICHIARATA("1,1")]);
  });
});

describe("la somma della pila contro lo spessore che la scheda dichiara: un avviso, e niente altro", () => {
  const AVVISO = (pila: string, schedaMm: string) =>
    `Attenzione: la pila fa in tutto ${pila} mm, la scheda dichiara ${schedaMm} mm di spessore. La differenza supera il 10%: uno dei due numeri è da correggere.`;

  it("fuori tolleranza: la pila si usa lo stesso, e il pannello scrive i due numeri", () => {
    // 1,546 against 1,2: 0,346 apart, a tenth of 1,2 is 0,12
    const r = rapporto(6, ST_CAMERA, 1.2);
    expect(r.stackup).toMatchObject({ source: "declared", boardThicknessMm: 1.2, outOfTolerance: true });
    const html = pannello(r);
    expect(righe(html)).toEqual(["Top 0,0000", "Inner 1 0,1344", "Inner 2 0,6996", "Inner 3 0,8312", "Inner 4 1,3964", "Bottom 1,5110"]);
    expect(note(html)).toEqual([DICHIARATA("1,546"), AVVISO("1,546", "1,2")]);
    expect(avvisi(html)).toEqual([AVVISO("1,546", "1,2")]);
  });

  it("il confine e' il 10% dello spessore della scheda, da una parte e dall'altra", () => {
    const fuori = (spessore: number) => (rapporto(6, ST_CAMERA, spessore).stackup as { outOfTolerance?: boolean }).outOfTolerance;
    // 1,7: 0,154 apart, limit 0,17. 1,72: 0,174 apart, limit 0,172
    expect(fuori(1.7)).toBe(false);
    expect(fuori(1.72)).toBe(true);
    // 1,41: 0,136 apart, limit 0,141. 1,4 (what tscircuit gives a board that declares none): 0,146 apart, limit 0,14
    expect(fuori(1.41)).toBe(false);
    expect(fuori(1.4)).toBe(true);
  });

  it("una somma esattamente al 10% e' dentro", () => {
    // 0,05 + 1 + 0,05 = 1,1 on a board of 1: 0,1 apart, the limit itself
    expect(rapporto(2, { copperMm: [0.05, 0.05], dielectrics: [{ mm: 1 }] }, 1).stackup).toMatchObject({ source: "declared", outOfTolerance: false });
    // 0,05 + 1,01 + 0,05 = 1,11: 0,11 apart
    expect(rapporto(2, { copperMm: [0.05, 0.05], dielectrics: [{ mm: 1.01 }] }, 1).stackup).toMatchObject({ source: "declared", outOfTolerance: true });
    // 0,05 + 0,8 + 0,05 = 0,9, the limit below; 0,05 + 0,79 + 0,05 = 0,89, past it
    expect(rapporto(2, { copperMm: [0.05, 0.05], dielectrics: [{ mm: 0.8 }] }, 1).stackup).toMatchObject({ outOfTolerance: false });
    expect(rapporto(2, { copperMm: [0.05, 0.05], dielectrics: [{ mm: 0.79 }] }, 1).stackup).toMatchObject({ outOfTolerance: true });
  });

  it("una scheda che non porta uno spessore non ha niente da confrontare", () => {
    const cj = [{ type: "pcb_board", width: 30, height: 20, center: { x: 0, y: 0 }, num_layers: 6 }];
    const r = buildBoardReport(cj, null, undefined, resolveStackup(progetto(ST_CAMERA)));
    expect(r.stackup).toMatchObject({ source: "declared", boardThicknessMm: null, outOfTolerance: false });
    expect(avvisi(pannello(r))).toEqual([]);
  });

  it("niente si blocca e nessun controllo cambia: il resoconto e' lo stesso, tranne le quote", () => {
    const riepilogo = { errors: [], drcViolations: [{ rule: "clearance", message: "due piste troppo vicine" }], unroutedConnections: [], connectionGroups: 3 };
    const cj = [...scheda(6, 1.2), { type: "source_component", source_component_id: "s1", name: "C1" }];
    const senza = buildBoardReport(cj, riepilogo, { saved: true });
    const stessiControlli = (r: ReturnType<typeof buildBoardReport>) => {
      const { layers, nominalDepths, stackup, ...resto } = r;
      void nominalDepths;
      void stackup;
      return { ...resto, layers: layers.map(({ depthMm, dielectricBelow, ...riga }) => (void depthMm, void dielectricBelow, riga)) };
    };
    for (const pila of [ST_CAMERA, QUATTRO_STRATI, { copperMm: [1] }]) {
      const con = buildBoardReport(cj, riepilogo, { saved: true }, resolveStackup(progetto(pila)));
      expect(stessiControlli(con)).toEqual(stessiControlli(senza));
    }
    expect(senza.errors).toBe(1);
  });
});

describe("una pila che non e' di questa scheda non si usa, e il pannello dice perche'", () => {
  it("quattro strati dichiarati su una scheda a sei: quote a passo uguale e il motivo", () => {
    const r = rapporto(6, QUATTRO_STRATI);
    expect(r.stackup).toEqual({ source: "wrong-layers", stackupLayers: 4, boardLayers: 6 });
    expect(r.nominalDepths).toBe(true);
    const html = pannello(r);
    expect(righe(html)).toEqual(["Top 0,000", "Inner 1 0,320", "Inner 2 0,640", "Inner 3 0,960", "Inner 4 1,280", "Bottom 1,600"]);
    expect(dielettrici(html)).toEqual([]);
    expect(note(html)).toEqual(["La pila dichiarata nel progetto ha 4 strati di rame, la scheda ne ha 6: non la uso.", RESTANO_INDICATIVE("1,6")]);
    expect(avvisi(html)).toEqual(["La pila dichiarata nel progetto ha 4 strati di rame, la scheda ne ha 6: non la uso."]);
  });

  it("sei strati dichiarati su una scheda a quattro, e su una a due", () => {
    const quattro = pannello(rapporto(4, ST_CAMERA));
    // 1,6 / 3 = 0,5333
    expect(righe(quattro)).toEqual(["Top 0,000", "Inner 1 0,533", "Inner 2 1,067", "Bottom 1,600"]);
    expect(note(quattro)).toEqual(["La pila dichiarata nel progetto ha 6 strati di rame, la scheda ne ha 4: non la uso.", RESTANO_INDICATIVE("1,6")]);
    // on two layers the two depths are the two faces: only the reason
    const due = pannello(rapporto(2, ST_CAMERA));
    expect(righe(due)).toEqual(["Top 0,000", "Bottom 1,600"]);
    expect(note(due)).toEqual(["La pila dichiarata nel progetto ha 6 strati di rame, la scheda ne ha 2: non la uso."]);
  });

  it("una pila scritta male nel file (arrivata senza passare dal controllo) non si usa, col primo motivo", () => {
    const r = rapporto(4, { copperMm: [0.035, 0.0175, 0, 0.035], dielectrics: [{ mm: 0.2 }, { mm: 1.1 }, { mm: 0.2 }] });
    expect(r.stackup).toEqual({ source: "invalid", reason: "stackup.copperMm[2]: 0 deve essere maggiore di zero" });
    const html = pannello(r);
    expect(righe(html)).toEqual(["Top 0,000", "Inner 1 0,533", "Inner 2 1,067", "Bottom 1,600"]);
    expect(note(html)).toEqual([
      "La pila dichiarata nel progetto non è valida e non la uso: stackup.copperMm[2]: 0 deve essere maggiore di zero.",
      RESTANO_INDICATIVE("1,6"),
    ]);
    expect(dielettrici(html)).toEqual([]);
  });
});
