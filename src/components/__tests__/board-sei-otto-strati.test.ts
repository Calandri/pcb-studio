import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildBoardReport } from "@/lib/board-report";
import { BoardCanvas } from "../board/BoardCanvas";
import { RouteCanvas } from "../board/RouteCanvas";
import { LAYER_COLOR, buildScene, layerDrawOrder, layerForKey, layerStack } from "../board/render";
import { stratoDiRame, stratoScelto } from "../board/strati-visibili";
import { VIEW_PRESETS } from "../ViewPresets";
import { LeftRail } from "../workspace/LeftRail";

/*
 * "io vedo solo 4 layer" (Niccolo', 2026-11-12, su st-camera): la scheda
 * dichiara layers={6} thickness="1.6mm", l'intestazione dice "6 strati" e il
 * pannello "Sezione della scheda" mostrava Top, Inner 1, Inner 2, Bottom con
 * le quote 0 / 0,533 / 1,067 / 1,600. Il visore conosceva quattro nomi: il rame
 * di inner3 e inner4 finiva disegnato sul Top, i tasti si fermavano al 4, e
 * Instrada non poteva scendere sotto Inner 2.
 *
 * La scheda di prova: una pista per ogni strato di rame, ognuna con la sua
 * larghezza, cosi' una pista disegnata si riconosce dal suo numero, e una
 * colata su inner3 (il triangolo 1.5 / 2.5 / 3.5).
 */
const PISTA: Record<string, string> = {
  top: "0.311",
  inner1: "0.321",
  inner2: "0.322",
  inner3: "0.323",
  inner4: "0.324",
  inner5: "0.325",
  inner6: "0.326",
  bottom: "0.312",
};
/** the stack a board of n layers has: top, inner1 ... inner(n-2), bottom (what tscircuit writes, see strati-sei-otto-compile.test.ts) */
const PILA: Record<number, string[]> = {
  2: ["top", "bottom"],
  4: ["top", "inner1", "inner2", "bottom"],
  6: ["top", "inner1", "inner2", "inner3", "inner4", "bottom"],
  8: ["top", "inner1", "inner2", "inner3", "inner4", "inner5", "inner6", "bottom"],
};
/** the colours of the copper: the four that were there, and the four chosen for inner3..inner6 */
const COLORE: Record<string, string> = {
  top: "#E8A33C",
  inner1: "#3BE8B0",
  inner2: "#7FB4FF",
  inner3: "#FF8FC7",
  inner4: "#B5E853",
  inner5: "#4DD0E1",
  inner6: "#D9B3FF",
  bottom: "#B9853A",
};

const scheda = (n: number, spessore: number | undefined = 1.6) => [
  { type: "pcb_board", width: 30, height: 20, center: { x: 0, y: 0 }, num_layers: n, ...(spessore !== undefined ? { thickness: spessore } : {}) },
  { type: "source_component", source_component_id: "s1", name: "C1" },
  { type: "pcb_component", pcb_component_id: "pc_top", source_component_id: "s1", center: { x: -5, y: 0 }, width: 2, height: 1, rotation: 0, layer: "top" },
  { type: "pcb_smtpad", pcb_smtpad_id: "pad_top", pcb_component_id: "pc_top", shape: "rect", x: -5, y: 0, width: 1.11, height: 0.61, layer: "top" },
  ...PILA[n].map((l, i) => ({
    type: "pcb_trace",
    pcb_trace_id: `tr_${l}`,
    route: [
      { route_type: "wire", x: -8 + i, y: 0, width: Number(PISTA[l]), layer: l },
      { route_type: "wire", x: -8 + i, y: 5, width: Number(PISTA[l]), layer: l },
    ],
  })),
  ...(n >= 6
    ? [{ type: "pcb_copper_pour", pcb_copper_pour_id: "colata_in3", layer: "inner3", source_net_id: "n", brep_shape: { outer_ring: { vertices: [{ x: 1.5, y: 1.5 }, { x: 3.5, y: 1.5 }, { x: 2.5, y: 3.5 }] } } }]
    : []),
];

const flags = { ...VIEW_PRESETS[0].flags, is_showing_copper_pours: true };
const guarda = (n: number, props: Record<string, unknown>) =>
  renderToStaticMarkup(createElement(BoardCanvas, { circuitJson: scheda(n), flags, mode: "view", ...props } as never));
const instrada = (n: number, props: Record<string, unknown>) =>
  renderToStaticMarkup(
    createElement(RouteCanvas, { circuitJson: scheda(n), width: 0.25, pendingRoutes: [], onRoute: () => {}, ...props } as never),
  );
/** the group a trace is drawn in says how strongly its layer shows: its opacity, or null when the trace is not drawn */
const forza = (svg: string, strato: string): string | null => {
  const m = new RegExp(`<g opacity="([^"]+)">(?:(?!</g>).)*stroke-width="${PISTA[strato].replace(".", "\\.")}"`).exec(svg);
  return m ? m[1] : null;
};
/** the trace of a layer is drawn in the colour of that layer */
const colorata = (svg: string, strato: string) => svg.includes(`stroke="${COLORE[strato]}" stroke-width="${PISTA[strato]}"`);

describe("gli strati di una scheda vengono dal numero che dichiara", () => {
  it("2, 4, 6 e 8 strati: top, gli interni in ordine, bottom", () => {
    for (const n of [2, 4, 6, 8]) expect(layerStack(n)).toEqual(PILA[n]);
    // painted from the bottom up, so the top lies over the others
    expect(layerDrawOrder(6)).toEqual(["bottom", "inner4", "inner3", "inner2", "inner1", "top"]);
    expect(layerDrawOrder(4)).toEqual(["bottom", "inner2", "inner1", "top"]);
  });

  it("i colori: i quattro di prima uguali, quattro nuovi per inner3..inner6, tutti diversi", () => {
    expect(LAYER_COLOR).toEqual(COLORE);
    expect(new Set(Object.values(LAYER_COLOR)).size).toBe(8);
  });

  it("la scena tiene il rame di inner3..inner6 sul suo strato (finiva sul Top)", () => {
    const scena = buildScene(scheda(8))!;
    expect(scena.board.layers).toBe(8);
    for (const l of PILA[8]) {
      expect(scena.traces.filter((t) => t.layer === l).map((t) => String(t.width))).toEqual([PISTA[l]]);
    }
    expect(scena.pours.map((p) => p.layer)).toEqual(["inner3"]);
  });

  it("la scelta e il marcatore di un controllo conoscono gli otto nomi, e nient'altro", () => {
    for (const l of PILA[8]) {
      expect(stratoScelto(l)).toBe(l);
      expect(stratoDiRame(l)).toBe(l);
    }
    expect(stratoScelto("inner7")).toBe("top");
    expect(stratoDiRame("inner7")).toBeUndefined();
    expect(stratoDiRame("all")).toBeUndefined();
  });
});

describe("i tasti: 1 = Top, N = Bottom, 0 = tutti", () => {
  it("scheda a 6 strati: 1..6 nell'ordine della pila, 7 non fa niente", () => {
    expect(["1", "2", "3", "4", "5", "6"].map((k) => layerForKey(k, 6))).toEqual(PILA[6]);
    expect(layerForKey("7", 6)).toBeNull();
    expect(layerForKey("0", 6)).toBe("all");
  });

  it("scheda a 8 strati: 1..8, 9 non fa niente", () => {
    expect(["1", "2", "3", "4", "5", "6", "7", "8"].map((k) => layerForKey(k, 8))).toEqual(PILA[8]);
    expect(layerForKey("9", 8)).toBeNull();
    expect(layerForKey("0", 8)).toBe("all");
  });

  it("2 e 4 strati come prima", () => {
    expect(["1", "2", "3", "4", "5"].map((k) => layerForKey(k, 4))).toEqual(["top", "inner1", "inner2", "bottom", null]);
    expect(["1", "2", "3"].map((k) => layerForKey(k, 2))).toEqual(["top", "bottom", null]);
  });

  it("la barra sotto la scheda dice fin dove arrivano", () => {
    const tasti = (n: number) => /1–(?:<!-- -->)?(\d)(?:<!-- -->)? uno strato · 0 tutti/.exec(guarda(n, { layer: "top" }))?.[1];
    expect([2, 4, 6, 8].map(tasti)).toEqual(["2", "4", "6", "8"]);
  });
});

describe("Guarda a 6 e 8 strati: con uno strato scelto si vede solo quello", () => {
  for (const n of [6, 8]) {
    it(`${n} strati: ogni strato scelto mostra il suo rame pieno, col suo colore, e gli altri a zero`, () => {
      for (const scelto of PILA[n]) {
        const svg = guarda(n, { layer: scelto });
        for (const l of PILA[n]) {
          expect(forza(svg, l), `scelto ${scelto}, pista di ${l}`).toBe(l === scelto ? "1" : "0");
          expect(colorata(svg, l), `scelto ${scelto}, colore di ${l}`).toBe(true);
        }
      }
    });
  }

  it("la radiografia riporta gli altri strati, attenuati, e Tutti li mostra pieni", () => {
    // 40% of the x-ray: 0,40 x 0,75 = 0,3 (the rule of strati-visibili.ts)
    const radiografia = guarda(6, { layer: "inner3", xray: 40 });
    for (const l of PILA[6]) expect(forza(radiografia, l)).toBe(l === "inner3" ? "1" : "0.3");
    const tutti = guarda(6, { layer: "all" });
    for (const l of PILA[6]) expect(forza(tutti, l)).toBe("1");
  });

  it("la colata di inner3 e' disegnata col colore di inner3, non con quello del Top", () => {
    const svg = guarda(6, { layer: "inner3" });
    expect(svg).toMatch(/d="M 1\.5 1\.5 L 3\.5 1\.5 L 2\.5 3\.5 Z"[^>]*fill="#FF8FC7"/);
    expect(svg).not.toMatch(/d="M 1\.5 1\.5 L 3\.5 1\.5 L 2\.5 3\.5 Z"[^>]*fill="#E8A33C"/);
  });

  it("il marcatore di un controllo su inner3 c'e' con inner3 scelto e non con il Top", () => {
    const markers = [{ id: "m_in3", x: 4, y: 4, message: "due piste troppo vicine", severity: "err", layer: stratoDiRame("inner3") }];
    const conMarcatori = (layer: string) =>
      renderToStaticMarkup(
        createElement(BoardCanvas, { circuitJson: scheda(6), flags: { ...flags, is_showing_drc_errors: true }, mode: "view", markers, layer } as never),
      );
    const anello = (svg: string) => /<circle cx="4" cy="4" r="[^"]+" fill="none"/.test(svg);
    expect(anello(conMarcatori("inner3"))).toBe(true);
    expect(anello(conMarcatori("top"))).toBe(false);
    expect(anello(conMarcatori("inner4"))).toBe(false);
    expect(anello(conMarcatori("all"))).toBe(true);
  });
});

describe("Instrada a 6 e 8 strati", () => {
  for (const n of [6, 8]) {
    it(`${n} strati: su ogni strato si vede solo il suo rame, e l'etichetta dice lo strato su cui si disegna`, () => {
      for (const scelto of PILA[n]) {
        const svg = instrada(n, { layer: scelto });
        for (const l of PILA[n]) expect(svg.includes(`stroke-width="${PISTA[l]}"`), `scelto ${scelto}, pista di ${l}`).toBe(l === scelto);
        expect(colorata(svg, scelto)).toBe(true);
        expect(svg).toContain(`>${scelto}<`);
        // the dot next to the name has the colour of the layer drawn on
        expect(svg).toContain(`background:${COLORE[scelto]}`);
      }
    });
  }

  it("con Tutti si vedono tutti, e l'aiuto dice i tasti della scheda: 1-6, 1-8, e 1-4 come prima", () => {
    const tutti = instrada(6, { layer: "all" });
    for (const l of PILA[6]) expect(colorata(tutti, l)).toBe(true);
    const tasti = (n: number) => /1-(?:<!-- -->)?(\d)(?:<!-- -->)? cambia strato e lascia una via/.exec(instrada(n, { layer: "top" }))?.[1];
    expect([4, 6, 8].map(tasti)).toEqual(["4", "6", "8"]);
  });
});

describe("il pannello Sezione della scheda", () => {
  // without the pour: a row with a plane on it says so next to its name (the last test here)
  const senzaColata = (n: number, spessore?: number) => scheda(n, spessore).filter((e) => e.type !== "pcb_copper_pour");
  const rapporto = (n: number, spessore?: number) => buildBoardReport(senzaColata(n, spessore), null);
  const pannello = (n: number, layer = "top") =>
    renderToStaticMarkup(
      createElement(LeftRail, {
        tab: "pcb", projectId: "p", report: rapporto(n), schematic: null, nets: [], parts: [], preset: "overview",
        onPreset: () => {}, layer, onLayer: () => {}, xray: 0, onXray: () => {}, onAskCopilot: () => {}, enclosures: null, scene: null,
      } as never),
    );
  /** the rows of the panel as the page writes them: the name and, next to it, the depth */
  const righe = (html: string) =>
    [...html.matchAll(/>([^<>]+)<\/span><span class="font-mono text-\[9px\] text-\[#4E625C\]">([\d,]+)<\/span>/g)].map((m) => `${m[1]} ${m[2]}`);

  it("6 strati, 1,6 mm: sei righe, Inner 1..Inner 4, quote a passo 1,6 / 5 = 0,32", () => {
    const r = rapporto(6);
    expect(r.layerCount).toBe(6);
    expect(r.layers.map((l) => l.id)).toEqual(PILA[6]);
    expect(r.layers.map((l) => l.name)).toEqual(["Top", "Inner 1", "Inner 2", "Inner 3", "Inner 4", "Bottom"]);
    expect(r.layers.map((l) => l.depthMm)).toEqual(["0,000", "0,320", "0,640", "0,960", "1,280", "1,600"]);
    // the panel's own top, a shade lighter than the viewer's as it always was; the others are the copper colours
    expect(r.layers.map((l) => l.color)).toEqual(["#F2C078", "#3BE8B0", "#7FB4FF", "#FF8FC7", "#B5E853", "#B9853A"]);
    expect(r.thicknessMm).toBe(1.6);
    expect(r.nominalDepths).toBe(true);
    expect(righe(pannello(6))).toEqual(["Top 0,000", "Inner 1 0,320", "Inner 2 0,640", "Inner 3 0,960", "Inner 4 1,280", "Bottom 1,600"]);
  });

  it("8 strati, 1,6 mm: otto righe, quote a passo 1,6 / 7 = 0,2286", () => {
    const r = rapporto(8);
    expect(r.layers.map((l) => l.name)).toEqual(["Top", "Inner 1", "Inner 2", "Inner 3", "Inner 4", "Inner 5", "Inner 6", "Bottom"]);
    // 0,2286 0,4571 0,6857 0,9143 1,1429 1,3714, to the micron
    expect(r.layers.map((l) => l.depthMm)).toEqual(["0,000", "0,229", "0,457", "0,686", "0,914", "1,143", "1,371", "1,600"]);
  });

  it("le quote stanno sullo spessore della scheda, non su 1,6 fisso", () => {
    // 1 mm on six layers: 1 / 5 = 0,2
    expect(rapporto(6, 1).layers.map((l) => l.depthMm)).toEqual(["0,000", "0,200", "0,400", "0,600", "0,800", "1,000"]);
    expect(rapporto(6, 1).thicknessMm).toBe(1);
    // a board that carries no thickness at all (made by hand): the 1,6 the panel always assumed
    expect(rapporto(4, undefined).layers.map((l) => l.depthMm)).toEqual(["0,000", "0,533", "1,067", "1,600"]);
  });

  it("senza pila dichiarata lo dice in chiaro: le quote sono indicative", () => {
    const html = pannello(6);
    expect(html).toContain("Le quote in mm sono indicative");
    expect(html).toMatch(/lo spessore della scheda \((?:<!-- -->)?1,6(?:<!-- -->)? mm\) diviso in parti\s+uguali/);
    expect(html).toContain("Non sono la pila vera");
    // the keys in the tooltip of "Tutti" are the board's
    expect(html).toContain("Uno solo: 1, 2, 3, 4, 5, 6 in ordine dall&#x27;alto");
    // on two layers the two depths are the two faces: nothing to warn about
    expect(pannello(2)).not.toContain("indicative");
    expect(rapporto(2).nominalDepths).toBe(false);
  });

  it("4 strati, 1,6 mm: le quattro righe di prima, 0 / 0,533 / 1,067 / 1,600, e i colori di prima", () => {
    const r = rapporto(4);
    expect(r.layers.map((l) => l.name)).toEqual(["Top", "Inner 1", "Inner 2", "Bottom"]);
    // 1,6 / 3 = 0,5333
    expect(r.layers.map((l) => l.depthMm)).toEqual(["0,000", "0,533", "1,067", "1,600"]);
    expect(r.layers.map((l) => l.color)).toEqual(["#F2C078", "#3BE8B0", "#7FB4FF", "#B9853A"]);
    expect(righe(pannello(4))).toEqual(["Top 0,000", "Inner 1 0,533", "Inner 2 1,067", "Bottom 1,600"]);
    expect(pannello(4)).toContain("Uno solo: 1, 2, 3, 4 in ordine dall&#x27;alto");
  });

  it("2 strati: Top e Bottom", () => {
    const r = rapporto(2);
    expect(r.layers.map((l) => `${l.name} ${l.depthMm} ${l.color}`)).toEqual(["Top 0,000 #F2C078", "Bottom 1,600 #B9853A"]);
  });

  it("un piano su un interno oltre il secondo e' detto accanto al nome, come su Inner 1 e Inner 2", () => {
    const conPiano = [...scheda(6), { type: "pcb_copper_pour", pcb_copper_pour_id: "p4", layer: "inner4", connects_to: "net.GND" }];
    // the pour of the test board on inner3 names no net, the one added on inner4 does
    expect(buildBoardReport(conPiano, null).layers.map((l) => l.name)).toEqual(["Top", "Inner 1", "Inner 2", "Inner 3 · piano", "Inner 4 · GND", "Bottom"]);
  });
});

describe("2 e 4 strati nel visore restano com'erano", () => {
  it("4 strati: quattro gruppi di piste, dal basso in alto, lo scelto per ultimo", () => {
    const svg = guarda(4, { layer: "inner1" });
    const ordine = [...svg.matchAll(/stroke-width="(0\.3\d\d)"/g)].map((m) => m[1]);
    // bottom, inner2, top, and inner1 (the chosen one) last, so above the others
    expect(ordine).toEqual([PISTA.bottom, PISTA.inner2, PISTA.top, PISTA.inner1]);
    for (const l of PILA[4]) expect(colorata(svg, l)).toBe(true);
  });

  it("2 strati: solo Top e Bottom", () => {
    const svg = guarda(2, { layer: "top" });
    expect([...svg.matchAll(/stroke-width="(0\.3\d\d)"/g)].map((m) => m[1])).toEqual([PISTA.bottom, PISTA.top]);
    expect(forza(svg, "top")).toBe("1");
    expect(forza(svg, "bottom")).toBe("0");
  });
});
