import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoardCanvas } from "../board/BoardCanvas";
import type { RameInAttesa } from "../board/gesto-del-rame";
import { VIEW_PRESETS } from "../ViewPresets";
import { REGOLE, schedaDiSpinta } from "@/lib/__tests__/spinta-scheda";
import { apriFinestra, type Finestra, type Nodo } from "./dom-finto";

/*
 * DUPLICA VIA NEL VISORE (16/11/2026): in Sposta con «vie», un clic su una via
 * la sceglie, Cmd+C la copia, Cmd+V ne incolla una copia dove sta il
 * puntatore; dal pannello «Copia via» e «Incolla con un clic» fanno lo stesso
 * col mouse, e ogni clic sulla scheda ne incolla una finche' non si preme
 * «Fine» o Esc. Una copia che non sta non parte, e la scheda dice perche'.
 *
 * Visore vero, risolutore e regole veri, sulla scheda di spinta-scheda.ts (la
 * via sola di PWR in (6; -9)); chi salva e' una spia. Un pixel per millimetro e
 * la y in su; Alt tiene il puntatore fuori dalla griglia.
 */
let f: Finestra;
const salvati: RameInAttesa[] = [];
const scheda = schedaDiSpinta();
const a = (x: number, y: number, campi: Record<string, unknown> = {}) => ({ clientX: x, clientY: -y, altKey: true, ...campi });

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  f = apriFinestra();
  salvati.length = 0;
  await f.monta(
    createElement(BoardCanvas, {
      circuitJson: scheda,
      flags: VIEW_PRESETS[0].flags,
      layer: "top",
      mode: "move",
      cosaSiSposta: "vie",
      regole: REGOLE,
      rameInAttesa: [],
      onGestoDelRame: (g: RameInAttesa) => salvati.push(g),
      onMoveComponent: () => {},
      onPickComponent: () => {},
    } as never),
  );
});
afterEach(() => {
  f.chiudi();
  vi.useRealTimers();
});

const nodo = (vuole: (n: Nodo) => boolean): Nodo | undefined => f.contenitore.cerca(vuole)[0];
const tavola = () => nodo((n) => n.tagName === "svg")!;
const pannello = () => nodo((n) => n.getAttribute("data-duplica-via") !== null);
const testo = (n: Nodo | undefined): string => (n ? [...n.tutti()].map((q) => (q.nodeType === 3 ? q.textContent ?? "" : "")).join("") : "");
const avviso = () => testo(nodo((n) => n.getAttribute("data-blocco-del-gesto") !== null));
const vieSalvate = () => salvati.map((g) => g.salvataggio.vias.map((v) => `${v.net} ${v.to.x};${v.to.y}${v.aggiunta ? " +" : ""}`).join(","));

async function scegliEcopia() {
  const via = nodo((n) => n.getAttribute("data-presa") === "via:v_pwr")!;
  await f.spara(via, "pointerdown", a(6, -9));
  await f.spara(via, "pointerup", a(6, -9));
  expect(nodo((n) => n.getAttribute("data-via-scelta") === "v_pwr")).toBeDefined();
  expect(testo(pannello())).toContain("via scelta: Cmd+C la copia");
  await f.tasto("c", { metaKey: true });
  expect(testo(pannello())).toContain("copiata la via di PWR");
}

describe("Duplica via in Sposta", () => {
  it("clic su una via, Cmd+C, e Cmd+V ne incolla una dove sta il puntatore, piu' volte di seguito", async () => {
    await scegliEcopia();
    // nothing moved: the press only chose it
    expect(salvati).toEqual([]);
    await f.spara(tavola(), "pointermove", a(0, -7));
    await f.tasto("v", { metaKey: true });
    await f.spara(tavola(), "pointermove", a(-2, -7));
    await f.tasto("v", { ctrlKey: true });
    expect(vieSalvate()).toEqual(["PWR 0;-7 +", "PWR -2;-7 +"]);
    // each a gesture of its own, drawn at once where it was pasted
    expect(new Set(salvati.map((g) => g.gesto)).size).toBe(2);
    expect(salvati[0].stato.vie).toEqual([{ x: 0, y: -7, outerDiameter: 0.6, holeDiameter: 0.3 }]);
  });

  it("dove non sta non la posa, e la scheda dice perche'", async () => {
    await scegliEcopia();
    await f.spara(tavola(), "pointermove", a(0, 6.5));
    await f.tasto("v", { metaKey: true });
    expect(salvati).toEqual([]);
    expect(avviso()).toContain("bloccato dalla pista");
  });

  it("le zone vietate al rame si vedono con le vie scelte, e una via rifiutata da una di loro la accende e dice di che strato e'", async () => {
    // the keepout of the board is of the top alone: drawn all the same, a via is stopped by it on any layer
    const zone = nodo((n) => n.getAttribute("data-zone-vietate") !== null);
    expect(zone).toBeDefined();
    expect(zone!.cerca((n) => n.tagName === "polygon" || n.tagName === "circle").length).toBeGreaterThan(0);
    expect(nodo((n) => n.getAttribute("data-zona-che-blocca") !== null)).toBeUndefined();

    await scegliEcopia();
    await f.spara(tavola(), "pointermove", a(0, 1.5));
    await f.tasto("v", { metaKey: true });
    expect(salvati).toEqual([]);
    expect(avviso()).toContain("bloccato da una zona vietata al rame su top: la via e' passante e ci entra");
    // the zone that said no is lit, in the warning itself
    expect(nodo((n) => n.getAttribute("data-zona-che-blocca") !== null)).toBeDefined();
  });

  it("col mouse: «Copia via», poi «Incolla con un clic» e ogni clic sulla scheda ne mette una, fino a «Fine» o Esc", async () => {
    const via = nodo((n) => n.getAttribute("data-presa") === "via:v_pwr")!;
    await f.spara(via, "pointerdown", a(6, -9));
    await f.spara(via, "pointerup", a(6, -9));
    const copia = nodo((n) => n.getAttribute("data-duplica-via-copia") !== null)!;
    const incolla = () => nodo((n) => n.getAttribute("data-duplica-via-incolla") !== null)!;
    await f.spara(copia, "click");
    await f.spara(incolla(), "click");
    expect(incolla().getAttribute("aria-pressed")).toBe("true");
    await f.spara(tavola(), "pointerdown", a(0, -7));
    await f.spara(tavola(), "pointerup", a(0, -7));
    await f.spara(tavola(), "pointerdown", a(2, -7));
    await f.spara(tavola(), "pointerup", a(2, -7));
    // a click on a via does not grab it while pasting: it asks for a copy there, which does not fit
    await f.spara(via, "pointerdown", a(6, -9));
    await f.spara(via, "pointerup", a(6, -9));
    expect(vieSalvate()).toEqual(["PWR 0;-7 +", "PWR 2;-7 +"]);
    expect(avviso()).toContain("bloccato dalla via di PWR");
    // the panel's own button is a button, not a click on the board
    await f.spara(incolla(), "pointerdown", a(0, 0));
    expect(salvati).toHaveLength(2);
    // Esc ends the clicks that paste, and the next click on the board pastes nothing
    await f.tasto("Escape");
    expect(incolla().getAttribute("aria-pressed")).toBe("false");
    await f.spara(tavola(), "pointerdown", a(0, -5));
    await f.spara(tavola(), "pointerup", a(0, -5));
    expect(salvati).toHaveLength(2);
  });

  it("con i componenti o le piste scelti il pannello non c'e' e Cmd+V non incolla niente", async () => {
    f.chiudi();
    f = apriFinestra();
    await f.monta(
      createElement(BoardCanvas, {
        circuitJson: scheda,
        flags: VIEW_PRESETS[0].flags,
        layer: "top",
        mode: "move",
        cosaSiSposta: "piste",
        regole: REGOLE,
        rameInAttesa: [],
        onGestoDelRame: (g: RameInAttesa) => salvati.push(g),
        onMoveComponent: () => {},
        onPickComponent: () => {},
      } as never),
    );
    expect(pannello()).toBeUndefined();
    await f.tasto("c", { metaKey: true });
    await f.tasto("v", { metaKey: true });
    expect(salvati).toEqual([]);
  });
});
