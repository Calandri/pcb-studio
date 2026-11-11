import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BoardCanvas } from "../board/BoardCanvas";
import { RouteCanvas } from "../board/RouteCanvas";
import { opacitaStrato, stratoScelto, stratoVisibile } from "../board/strati-visibili";
import { VIEW_PRESETS } from "../ViewPresets";

/*
 * "Seleziono il TOP ma vedo TUTTO in ogni layer" (Niccolo', 2026-11-11, su
 * sbb-dl-principale). Tre difetti, uno per modo:
 *   - Guarda: pasta saldante, ingombro e riquadro del mouse dei pezzi del
 *     retro restavano sopra la faccia Top (in Sposta erano gia' tolti);
 *   - Instrada: la vista aveva uno strato suo, non sentiva la scelta a
 *     sinistra e disegnava sempre gli altri strati al 16%, radiografia o no;
 *   - piano interno scelto: la serigrafia del Top restava a un quarto.
 * Una regola sola (strati-visibili.ts): lo strato scelto pieno, gli altri
 * quanto chiede la radiografia, e a zero non si disegnano.
 *
 * La scheda di prova: un pezzo sopra (C1) e uno sotto (R2), ognuno con una
 * piazzola, la sua pasta, il suo ingombro e una pista sulla sua faccia. Ogni
 * misura e' diversa, cosi' una cosa disegnata si riconosce dal suo numero.
 */
const CIRCUIT = [
  { type: "pcb_board", width: 30, height: 20, center: { x: 0, y: 0 }, num_layers: 4 },
  { type: "source_component", source_component_id: "s1", name: "C1" },
  { type: "source_component", source_component_id: "s2", name: "R2" },
  { type: "pcb_component", pcb_component_id: "pc_top", source_component_id: "s1", center: { x: -5, y: 0 }, width: 2, height: 1, rotation: 0, layer: "top" },
  { type: "pcb_component", pcb_component_id: "pc_bot", source_component_id: "s2", center: { x: 5, y: 0 }, width: 2, height: 1, rotation: 0, layer: "bottom" },
  { type: "pcb_smtpad", pcb_smtpad_id: "pad_top", pcb_component_id: "pc_top", shape: "rect", x: -5, y: 0, width: 1.11, height: 0.61, layer: "top" },
  { type: "pcb_smtpad", pcb_smtpad_id: "pad_bot", pcb_component_id: "pc_bot", shape: "rect", x: 5, y: 0, width: 1.22, height: 0.62, layer: "bottom" },
  { type: "pcb_solder_paste", pcb_solder_paste_id: "paste_top", pcb_component_id: "pc_top", shape: "rect", x: -5, y: 0, width: 0.91, height: 0.41, layer: "top" },
  { type: "pcb_solder_paste", pcb_solder_paste_id: "paste_bot", pcb_component_id: "pc_bot", shape: "rect", x: 5, y: 0, width: 0.92, height: 0.42, layer: "bottom" },
  { type: "pcb_courtyard_rect", pcb_courtyard_rect_id: "cy_top", pcb_component_id: "pc_top", center: { x: -5, y: 0 }, width: 2.71, height: 1.71, layer: "top" },
  { type: "pcb_courtyard_rect", pcb_courtyard_rect_id: "cy_bot", pcb_component_id: "pc_bot", center: { x: 5, y: 0 }, width: 2.72, height: 1.72, layer: "bottom" },
  { type: "pcb_silkscreen_path", pcb_silkscreen_path_id: "silk_top", pcb_component_id: "pc_top", layer: "top", stroke_width: 0.131, route: [{ x: -6, y: 1 }, { x: -4, y: 1 }] },
  { type: "pcb_silkscreen_path", pcb_silkscreen_path_id: "silk_bot", pcb_component_id: "pc_bot", layer: "bottom", stroke_width: 0.132, route: [{ x: 4, y: 1 }, { x: 6, y: 1 }] },
  { type: "pcb_trace", pcb_trace_id: "tr_top", route: [{ route_type: "wire", x: -5, y: 0, width: 0.311, layer: "top" }, { route_type: "wire", x: -5, y: 5, width: 0.311, layer: "top" }] },
  { type: "pcb_trace", pcb_trace_id: "tr_bot", route: [{ route_type: "wire", x: 5, y: 0, width: 0.312, layer: "bottom" }, { route_type: "wire", x: 5, y: 5, width: 0.312, layer: "bottom" }] },
  { type: "pcb_trace", pcb_trace_id: "tr_in1", route: [{ route_type: "wire", x: 0, y: 0, width: 0.313, layer: "inner1" }, { route_type: "wire", x: 0, y: 5, width: 0.313, layer: "inner1" }] },
];

const flags = {
  ...VIEW_PRESETS[0].flags,
  is_showing_courtyards: true,
  is_showing_paste_mask: true,
  is_showing_silkscreen: true,
};

const guarda = (props: Record<string, unknown>) =>
  renderToStaticMarkup(createElement(BoardCanvas, { circuitJson: CIRCUIT, flags, mode: "view", ...props } as never));
const sposta = (props: Record<string, unknown>) =>
  renderToStaticMarkup(createElement(BoardCanvas, { circuitJson: CIRCUIT, flags, mode: "move", ...props } as never));
const instrada = (props: Record<string, unknown>) =>
  renderToStaticMarkup(
    createElement(RouteCanvas, { circuitJson: CIRCUIT, width: 0.25, pendingRoutes: [], onRoute: () => {}, ...props } as never),
  );

/** something drawn is recognised by its own size */
const c = (svg: string, misura: string) => svg.includes(`"${misura}"`);
const TOP = { piazzola: "1.11", pasta: "0.91", ingombro: "2.71", serigrafia: "0.131", pista: "0.311" };
const BOT = { piazzola: "1.22", pasta: "0.92", ingombro: "2.72", serigrafia: "0.132", pista: "0.312" };
const IN1 = { pista: "0.313" };
/** the boxes that answer the mouse in Guarda: one per part that can be pointed at */
const riquadri = (svg: string) => svg.match(/<rect[^>]*style="cursor:pointer"[^>]*>/g) ?? [];

describe("la regola degli strati: una sola, per i tre modi", () => {
  it("lo strato scelto e' pieno, gli altri seguono la radiografia e a zero non ci sono", () => {
    expect(opacitaStrato("top", "top", 0)).toBe(1);
    expect(opacitaStrato("bottom", "top", 0)).toBe(0);
    expect(opacitaStrato("inner1", "top", 0)).toBe(0);
    // 40% of the x-ray: 0,40 x 0,75 = 0,30
    expect(opacitaStrato("bottom", "top", 40)).toBeCloseTo(0.3, 10);
    // the x-ray at its top leaves the others at three quarters, never as strong as the chosen one
    expect(opacitaStrato("bottom", "top", 100)).toBe(0.75);
    expect(stratoVisibile("bottom", "top", 0)).toBe(false);
    expect(stratoVisibile("bottom", "top", 1)).toBe(true);
  });

  it("con Tutti ogni strato e' pieno, qualunque radiografia", () => {
    for (const l of ["top", "inner1", "inner2", "bottom"] as const) {
      expect(opacitaStrato(l, "all", 0)).toBe(1);
      expect(opacitaStrato(l, "all", 100)).toBe(1);
    }
  });

  it("una radiografia fuori scala non rompe niente", () => {
    expect(opacitaStrato("bottom", "top", -20)).toBe(0);
    expect(opacitaStrato("bottom", "top", 250)).toBe(0.75);
    expect(opacitaStrato("bottom", "top", Number.NaN)).toBe(0);
  });

  it("la scelta arriva come testo: cio' che non e' uno strato vale top", () => {
    expect(stratoScelto("bottom")).toBe("bottom");
    expect(stratoScelto("inner2")).toBe("inner2");
    expect(stratoScelto("all")).toBe("all");
    expect(stratoScelto("boh")).toBe("top");
    expect(stratoScelto(undefined)).toBe("top");
  });
});

describe("Guarda: con uno strato scelto si vede solo quello", () => {
  it("con Top non c'e' niente del retro: ne' piazzola, ne' pasta, ne' ingombro, ne' pista, ne' riquadro del mouse", () => {
    const svg = guarda({ layer: "top" });
    for (const k of Object.keys(TOP) as Array<keyof typeof TOP>) expect(c(svg, TOP[k]), `top ${k}`).toBe(true);
    expect(c(svg, BOT.pasta), "pasta del retro").toBe(false);
    expect(c(svg, BOT.ingombro), "ingombro del retro").toBe(false);
    expect(c(svg, BOT.serigrafia), "serigrafia del retro").toBe(false);
    expect(riquadri(svg)).toHaveLength(1);
    // piazzola e pista del retro: il loro gruppo e' a zero (non si vedono)
    expect(svg).toMatch(/<g opacity="0">(?:(?!<\/g>).)*"1\.22"/);
    expect(svg).toMatch(/<g opacity="0">(?:(?!<\/g>).)*"0\.312"/);
  });

  it("con Bottom non c'e' niente del Top", () => {
    const svg = guarda({ layer: "bottom" });
    expect(c(svg, BOT.pasta)).toBe(true);
    expect(c(svg, BOT.ingombro)).toBe(true);
    expect(c(svg, BOT.serigrafia)).toBe(true);
    expect(c(svg, TOP.pasta)).toBe(false);
    expect(c(svg, TOP.ingombro)).toBe(false);
    expect(c(svg, TOP.serigrafia)).toBe(false);
    expect(riquadri(svg)).toHaveLength(1);
  });

  it("con Tutti ci sono tutte e due le facce", () => {
    const svg = guarda({ layer: "all" });
    expect(c(svg, TOP.pasta) && c(svg, BOT.pasta)).toBe(true);
    expect(c(svg, TOP.ingombro) && c(svg, BOT.ingombro)).toBe(true);
    expect(riquadri(svg)).toHaveLength(2);
  });

  it("la radiografia riporta il retro, attenuato: pasta e ingombro seguono la loro faccia", () => {
    const svg = guarda({ layer: "top", xray: 40 });
    // 0,40 x 0,75 = 0,3: il gruppo della pasta del retro
    expect(svg).toMatch(/<g opacity="0\.3"[^>]*>(?:(?!<\/g>).)*"0\.92"/);
    expect(c(svg, BOT.ingombro)).toBe(true);
    // un pezzo che si vede si puo' indicare
    expect(riquadri(svg)).toHaveLength(2);
  });

  it("su un piano interno, a radiografia spenta, non restano ne' i pezzi ne' la serigrafia delle facce", () => {
    const svg = guarda({ layer: "inner1" });
    expect(c(svg, IN1.pista)).toBe(true);
    expect(c(svg, TOP.pasta) || c(svg, BOT.pasta)).toBe(false);
    expect(c(svg, TOP.ingombro) || c(svg, BOT.ingombro)).toBe(false);
    expect(c(svg, TOP.serigrafia)).toBe(false);
    expect(riquadri(svg)).toHaveLength(0);
    // con la radiografia la serigrafia del Top torna
    expect(c(guarda({ layer: "inner1", xray: 50 }), TOP.serigrafia)).toBe(true);
  });
});

describe("Sposta: resta com'era, e con Top + Bottom le due facce sono piene", () => {
  it("con Top si lavora sul Top: niente pasta ne' ingombro del retro", () => {
    const svg = sposta({ layer: "top" });
    expect(c(svg, TOP.pasta)).toBe(true);
    expect(c(svg, BOT.pasta)).toBe(false);
    expect(c(svg, BOT.ingombro)).toBe(false);
  });

  it("con Top + Bottom le piazzole del retro non restano a zero", () => {
    const svg = sposta({ layer: "top", bothSides: true });
    expect(c(svg, BOT.pasta) && c(svg, BOT.ingombro)).toBe(true);
    expect(svg).not.toMatch(/<g opacity="0">(?:(?!<\/g>).)*"1\.22"/);
    expect(svg).toMatch(/<g opacity="1">(?:(?!<\/g>).)*"1\.22"/);
  });
});

describe("Instrada: segue lo strato e la radiografia scelti a sinistra", () => {
  it("con Top si vede solo il rame del Top", () => {
    const svg = instrada({ layer: "top" });
    expect(c(svg, TOP.pista) && c(svg, TOP.piazzola)).toBe(true);
    expect(c(svg, BOT.pista) || c(svg, BOT.piazzola)).toBe(false);
    expect(c(svg, IN1.pista)).toBe(false);
  });

  it("con Bottom, scelto a sinistra, si lavora sul Bottom (prima restava sul Top)", () => {
    const svg = instrada({ layer: "bottom" });
    expect(c(svg, BOT.pista) && c(svg, BOT.piazzola)).toBe(true);
    expect(c(svg, TOP.pista) || c(svg, TOP.piazzola)).toBe(false);
    // l'etichetta in basso dice lo strato su cui si disegna
    expect(svg).toMatch(/>bottom</);
  });

  it("la radiografia riporta gli altri strati, attenuati", () => {
    const svg = instrada({ layer: "top", xray: 40 });
    expect(svg).toMatch(/<g opacity="0\.3"[^>]*>(?:(?!<\/g>).)*"0\.312"/);
    expect(c(svg, IN1.pista)).toBe(true);
  });

  it("con Tutti si vedono tutti, pieni", () => {
    const svg = instrada({ layer: "all" });
    expect(c(svg, TOP.pista) && c(svg, BOT.pista) && c(svg, IN1.pista)).toBe(true);
    expect(svg).not.toMatch(/<g opacity="0\.\d+"[^>]*>(?:(?!<\/g>).)*"0\.312"/);
  });

  it("senza la scelta di sinistra (prove, vecchi usi) parte dal Top come prima", () => {
    const svg = instrada({});
    expect(c(svg, TOP.pista)).toBe(true);
    expect(c(svg, BOT.pista)).toBe(false);
  });
});
