import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DESIGN_RULES } from "@/lib/design-rules";
import type { BersaglioDelRame } from "@/lib/spinta/gesto-tipi";
import { BoardCanvas } from "../board/BoardCanvas";
import { PRESA_MINIMA_VIA_SOLA_PX } from "../board/BersagliDelRame";
import { VIEW_PRESETS } from "../ViewPresets";
import { BERSAGLI, SCHEDA } from "./rame-di-prova";

/*
 * «In Sposta con vie selezionato NON riesco a prendere le vie: clicco e
 * trascino e non succede niente» (Niccolo', sbb-dl-principale, 16/11/2026).
 *
 * Nelle viste che mostrano i controlli ("Interferenze", "Tutto") ogni segnale
 * del DRC e ogni conflitto di serigrafia ha un cerchio trasparente di 14 pixel
 * che prende il puntatore, per il suo suggerimento. Era disegnato SOPRA i
 * bersagli del rame: la pressione su una via vicina a un segnale andava al
 * segnale, che non fa niente, e la via non si prendeva, senza una parola. Su
 * una scheda fitta come la principale i segnali stanno proprio accanto alle vie
 * strette (C65, IC6).
 *
 * La prova guarda quello che il browser fa: fra le forme che contengono il
 * punto premuto e prendono il puntatore, vince l'ultima disegnata.
 */
const gesto = vi.hoisted(() => ({
  preseDelRame: vi.fn(),
  iniziaGesto: vi.fn(),
  muoviGesto: vi.fn(),
  chiudiGesto: vi.fn(),
}));
vi.mock("@/lib/spinta/gesto", () => gesto);

const FERMA: BersaglioDelRame = { tipo: "via", pcbViaId: "via_ferma", x: 0, y: -5, outerDiameter: 0.45, fermo: "bloccato: la via e' collegata a TP_GND.1 solo perche' lo tocca" };
beforeEach(() => {
  vi.clearAllMocks();
  gesto.preseDelRame.mockReturnValue([...BERSAGLI, FERMA]);
});

/** "Tutto": the markers of the checks are drawn */
const TUTTO = VIEW_PRESETS.find((p) => p.flags.is_showing_drc_errors)!.flags;
/** a finding of the DRC on each via, and a silkscreen clash beside one: where they are on sbb-dl-principale */
const SEGNALI = [
  { id: "trace_pad_clearance-0", x: -5, y: 5, message: "pista troppo vicina a C65.1", severity: "err" },
  { id: "silk-1", x: 5.2, y: 5.1, message: "serigrafia su una piazzola", severity: "warn" },
  { id: "via_pad-2", x: 0, y: -5, message: "via vicina a TP_GND.1", severity: "warn" },
];

const sposta = (cosaSiSposta: "vie" | "piste" | "pezzi" | undefined) =>
  renderToStaticMarkup(
    createElement(BoardCanvas, {
      circuitJson: SCHEDA,
      flags: TUTTO,
      mode: "move",
      layer: "top",
      regole: DEFAULT_DESIGN_RULES,
      onGestoDelRame: () => {},
      markers: SEGNALI,
      ...(cosaSiSposta ? { cosaSiSposta } : {}),
    } as never),
  );

interface Forma {
  ordine: number;
  presa: string | null;
  cx: number;
  cy: number;
  r: number;
  prende: boolean;
}

/**
 * The circles of the drawing in the order they are drawn, with whether each
 * takes the pointer: not when its fill is "none" (a ring, the markers' visible
 * circle) or when it, or a group it is in, says pointer-events none.
 */
function cerchi(svg: string): Forma[] {
  const out: Forma[] = [];
  const spenti: boolean[] = [];
  const tag = /<(\/?)(g|circle)\b([^>]*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(svg))) {
    const [, chiude, nome, attr, sola] = m;
    const spento = /pointer-events(?:="none"|:\s*none)/.test(attr);
    if (nome === "g") {
      if (chiude) spenti.pop();
      else if (!sola) spenti.push(spento);
      continue;
    }
    const num = (k: string) => Number(new RegExp(`\\b${k}="([^"]+)"`).exec(attr)?.[1] ?? NaN);
    out.push({
      ordine: out.length,
      presa: /data-presa="([^"]+)"/.exec(attr)?.[1] ?? null,
      cx: num("cx"),
      cy: num("cy"),
      r: num("r"),
      prende: !spento && !spenti.includes(true) && !/fill="none"/.test(attr),
    });
  }
  return out;
}

/** what the browser hands a press at (x; y): the last shape drawn that contains it and takes the pointer */
const chiPrende = (svg: string, x: number, y: number): string | null => {
  const sotto = cerchi(svg).filter((c) => c.prende && Math.hypot(c.cx - x, c.cy - y) <= c.r + 1e-9);
  const ultimo = sotto[sotto.length - 1];
  return ultimo ? (ultimo.presa ?? "un segnale dei controlli") : null;
};

describe("Sposta, vie: la pressione su una via va alla via anche dove c'e' un segnale dei controlli", () => {
  it("con le vie scelte la via sotto un segnale del DRC si prende, e anche una via ferma (che dice perche')", () => {
    const svg = sposta("vie");
    expect(chiPrende(svg, -5, 5)).toBe("via:via_a");
    expect(chiPrende(svg, 5, 5)).toBe("via:via_b");
    expect(chiPrende(svg, 0, -5)).toBe("via:via_ferma");
  });

  it("con le piste scelte il tratto sotto un segnale si prende lo stesso; il segnale tiene il suo suggerimento dove non c'e' rame", () => {
    const svg = sposta("piste");
    // the marker of (-5; 5) covers the end of tr_top: its line is drawn after the marker now
    const ordine = (presa: string) => svg.indexOf(`data-presa="${presa}"`);
    const segnale = svg.indexOf('r="14"');
    expect(segnale).toBeGreaterThan(0);
    expect(ordine("tratto:tr_top:0")).toBeGreaterThan(segnale);
    // away from the copper the marker still takes the pointer, for its tooltip
    expect(chiPrende(svg, -5 + 10, 5)).toBe("un segnale dei controlli");
  });

  it("con le vie scelte il bersaglio di una via e' largo almeno PRESA_MINIMA_VIA_SOLA_PX: una via di 0,45 mm da lontano era di pochi pixel", () => {
    // a static render has a pixel a millimetre: the minimum is in millimetres as it is in pixels
    const r = (svg: string, presa: string) => cerchi(svg).find((c) => c.presa === presa)!.r;
    expect(r(sposta("vie"), "via:via_ferma")).toBe(PRESA_MINIMA_VIA_SOLA_PX / 2);
    expect(r(sposta(undefined), "via:via_ferma")).toBe(2.5);
  });
});
