import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BoardCanvas } from "../board/BoardCanvas";
import { RouteCanvas } from "../board/RouteCanvas";
import { boardOutlinePath, buildScene, readBoardOutline } from "../board/render";
import { VIEW_PRESETS } from "../ViewPresets";

/*
 * La scheda di htl-401-scheda-unica in piccolo: un rettangolo 40 x 20 con la
 * tacca del connettore USB sul bordo davanti (x -14..-4, y -10..-2). Il
 * circuit JSON porta il contorno in pcb_board.outline; la vista disegnava
 * comunque width x height, e la tacca a schermo non c'era.
 */
const TACCA = [
  { x: -20, y: -10 },
  { x: -14, y: -10 },
  { x: -14, y: -2 },
  { x: -4, y: -2 },
  { x: -4, y: -10 },
  { x: 20, y: -10 },
  { x: 20, y: 10 },
  { x: -20, y: 10 },
];
const scheda = (outline?: unknown) => [
  {
    type: "pcb_board",
    width: 40,
    height: 20,
    center: { x: 0, y: 0 },
    num_layers: 4,
    ...(outline === undefined ? {} : { outline }),
  },
];
const PERCORSO = "M-20 -10 L-14 -10 L-14 -2 L-4 -2 L-4 -10 L20 -10 L20 10 L-20 10 Z";

describe("il contorno vero della scheda arriva nella scena", () => {
  it("con pcb_board.outline la scena lo porta, punto per punto", () => {
    const scene = buildScene(scheda(TACCA))!;
    expect(scene.board.outline).toEqual(TACCA);
    expect(boardOutlinePath(scene.board)).toBe(PERCORSO);
  });

  it("senza outline resta il rettangolo: nessun contorno, nessun percorso", () => {
    const scene = buildScene(scheda())!;
    expect(scene.board.outline).toBeUndefined();
    expect(boardOutlinePath(scene.board)).toBeNull();
  });

  it("un contorno rotto non si disegna: meno di tre punti, un punto senza numero, un NaN", () => {
    expect(readBoardOutline([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toBeUndefined();
    expect(readBoardOutline([{ x: 0, y: 0 }, { x: 1 }, { x: 2, y: 2 }])).toBeUndefined();
    expect(readBoardOutline([{ x: 0, y: 0 }, { x: Number.NaN, y: 1 }, { x: 2, y: 2 }])).toBeUndefined();
    expect(readBoardOutline("non un contorno")).toBeUndefined();
    expect(buildScene(scheda([{ x: 0, y: 0 }, null, { x: 2, y: 2 }]))!.board.outline).toBeUndefined();
  });
});

describe("la tela disegna la scheda con le sue tacche", () => {
  const tela = (circuitJson: unknown[], preset = 0) =>
    renderToStaticMarkup(
      createElement(BoardCanvas, { circuitJson, flags: VIEW_PRESETS[preset].flags, layer: "top" }),
    );

  it("con il contorno la scheda e' un percorso, non il rettangolo largo x alto", () => {
    const svg = tela(scheda(TACCA));
    expect(svg).toContain(`<path d="${PERCORSO}" fill="#0C1A17" stroke="#2C4C42"`);
    expect(svg).not.toMatch(/<rect x="-20" y="-10" width="40" height="20"/);
  });

  it("senza contorno resta il rettangolo di prima", () => {
    const svg = tela(scheda());
    expect(svg).toMatch(/<rect x="-20" y="-10" width="40" height="20" rx="0.6" fill="#0C1A17"/);
    expect(svg).not.toContain(PERCORSO);
  });

  it("anche la vernice segue il contorno: niente verde sopra la tacca", () => {
    const conVernice = VIEW_PRESETS.findIndex((p) => p.flags.is_showing_solder_mask);
    expect(conVernice).toBeGreaterThanOrEqual(0);
    const svg = tela(scheda(TACCA), conVernice);
    expect(svg).toContain(`<path d="${PERCORSO}" fill="#0E5E43" opacity="0.93"`);
    expect(svg).not.toMatch(/<rect x="-20" y="-10" width="40" height="20"/);
  });

  it("la tela delle piste disegna la stessa sagoma", () => {
    const piste = (circuitJson: unknown[]) =>
      renderToStaticMarkup(
        createElement(RouteCanvas, { circuitJson, width: 0.2, pendingRoutes: [], onRoute: () => {} }),
      );
    expect(piste(scheda(TACCA))).toContain(`<path d="${PERCORSO}" fill="#0C1A17" stroke="#2C4C42"`);
    expect(piste(scheda())).toMatch(/<rect x="-20" y="-10" width="40" height="20" rx="0.6" fill="#0C1A17"/);
  });
});
