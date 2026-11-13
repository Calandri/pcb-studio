import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DESIGN_RULES } from "@/lib/design-rules";
import { BoardCanvas } from "../board/BoardCanvas";
import { RouteCanvas } from "../board/RouteCanvas";
import { AvvisoDelGesto, RameInMovimento, forzaDelRameMosso } from "../board/RameInMovimento";
import { nuovoGestoVivo } from "../board/gesto-del-rame";
import { schedaMostraIlRame } from "../workspace/rame-in-attesa";
import { VIEW_PRESETS } from "../ViewPresets";
import { BERSAGLI, SALVATAGGIO, SCHEDA, fileDiPartenza, schedaDa, statoConLaViaIn } from "./rame-di-prova";

/*
 * "Vorrei poter muovere un via con la modalita' sposta ... stessa cosa per le
 * piste" (Niccolo', 2026-11-12). In Sposta la via e il tratto di pista hanno
 * un bersaglio da prendere, per la regola degli strati (strati-visibili.ts):
 * il tratto di uno strato che non si disegna non si prende, la via e' un foro
 * passante e c'e' sempre. Qui il disegno fermo: cosa si puo' prendere, e come
 * si vede il rame di un gesto. Il gesto vero (puntatore, tasti, salvataggio)
 * e' in sposta-rame-gesto.test.ts.
 *
 * Il risolutore non e' quello vero: risponde quello che dice la prova.
 */
const gesto = vi.hoisted(() => ({
  preseDelRame: vi.fn(),
  iniziaGesto: vi.fn(),
  muoviGesto: vi.fn(),
  chiudiGesto: vi.fn(),
}));
vi.mock("@/lib/spinta/gesto", () => gesto);

beforeEach(() => {
  vi.clearAllMocks();
  gesto.preseDelRame.mockReturnValue(BERSAGLI);
});

const flags = VIEW_PRESETS[0].flags;
/** what Studio hands the canvas of Sposta so that copper can be dragged */
const colRame = { regole: DEFAULT_DESIGN_RULES, onGestoDelRame: () => {} };
const sposta = (props: Record<string, unknown>) =>
  renderToStaticMarkup(createElement(BoardCanvas, { circuitJson: SCHEDA, flags, mode: "move", ...colRame, ...props } as never));
const guarda = (props: Record<string, unknown>) =>
  renderToStaticMarkup(createElement(BoardCanvas, { circuitJson: SCHEDA, flags, mode: "view", ...props } as never));
const instrada = (props: Record<string, unknown>) =>
  renderToStaticMarkup(
    createElement(RouteCanvas, { circuitJson: SCHEDA, width: 0.25, pendingRoutes: [], onRoute: () => {}, ...props } as never),
  );

/** the targets of the copper: circles and lines with the cursor of Sposta, each named by what it grabs */
const bersagli = (svg: string) =>
  (svg.match(/<(?:circle|line)[^>]*style="cursor:move"[^>]*>/g) ?? []).map((b) => /data-presa="([^"]+)"/.exec(b)?.[1]).sort();
/** the handles of the parts: the transparent rectangles (board-move-face.test.ts counts them the same way) */
const maniglie = (svg: string) => svg.match(/<rect[^>]*style="cursor:move"[^>]*>/g) ?? [];

describe("Sposta: cosa si puo' prendere del rame", () => {
  it("in Sposta, con uno strato scelto, c'e' un bersaglio cursor:move per ogni via e per ogni tratto degli strati che si disegnano, e nessuno per i tratti degli strati non disegnati", () => {
    // Top, x-ray at zero: the bottom and the inner plane are not drawn, their stretches cannot be grabbed; the vias go through
    expect(bersagli(sposta({ layer: "top" }))).toEqual(["tratto:tr_top:0", "via:via_a", "via:via_b"]);
    expect(bersagli(sposta({ layer: "bottom" }))).toEqual(["tratto:tr_bot:0", "via:via_a", "via:via_b"]);
    expect(bersagli(sposta({ layer: "inner1" }))).toEqual(["tratto:tr_in1:0", "via:via_a", "via:via_b"]);
    // the x-ray brings the other layers back, dimmed: what is drawn can be grabbed
    const tutti = ["tratto:tr_bot:0", "tratto:tr_in1:0", "tratto:tr_top:0", "via:via_a", "via:via_b"];
    expect(bersagli(sposta({ layer: "top", xray: 40 }))).toEqual(tutti);
    expect(bersagli(sposta({ layer: "all" }))).toEqual(tutti);
    // the solver is asked about the board on screen
    expect(gesto.preseDelRame).toHaveBeenCalledWith(SCHEDA);
  });

  it("un bersaglio sta sopra il suo rame ed e' trasparente: la via nel suo centro, il tratto fra i suoi estremi", () => {
    const svg = sposta({ layer: "top" });
    // their size is not read here: at the zoom a static render has (a pixel a millimetre) it is the minimum of a few pixels
    expect(svg).toMatch(/<circle[^>]*data-presa="via:via_a"[^>]*cx="-5" cy="5"[^>]*fill="transparent"[^>]*style="cursor:move"/);
    expect(svg).toMatch(/<line[^>]*data-presa="tratto:tr_top:0"[^>]*x1="-5" y1="0" x2="-5" y2="5" stroke="transparent"[^>]*style="cursor:move"/);
  });

  it("in Guarda e in Instrada quei bersagli non ci sono", () => {
    expect(bersagli(guarda({ layer: "top" }))).toEqual([]);
    // not even when Guarda is handed what Sposta is handed
    expect(bersagli(guarda({ layer: "all", ...colRame }))).toEqual([]);
    expect(gesto.preseDelRame).not.toHaveBeenCalled();
    expect(bersagli(instrada({ layer: "top" }))).toEqual([]);
    expect(bersagli(instrada({ layer: "all" }))).toEqual([]);
    expect(instrada({ layer: "all" })).not.toContain("data-presa");
  });

  it("senza le regole del progetto, o senza chi salva il gesto, in Sposta il rame non si prende e il risolutore non e' interpellato", () => {
    expect(bersagli(sposta({ layer: "all", regole: undefined }))).toEqual([]);
    expect(bersagli(sposta({ layer: "all", onGestoDelRame: undefined }))).toEqual([]);
    // while parts are being picked for the assistant a drag draws a box: no copper to grab there either
    expect(bersagli(sposta({ layer: "all", selectMode: "components" }))).toEqual([]);
    expect(gesto.preseDelRame).not.toHaveBeenCalled();
  });

  it("i pezzi si prendono come prima: una maniglia per pezzo della faccia, e i bersagli del rame non sono maniglie", () => {
    const svg = sposta({ layer: "top" });
    expect(maniglie(svg)).toHaveLength(1);
    expect(maniglie(sposta({ layer: "top", bothSides: true }))).toHaveLength(2);
    // the same count with no copper to grab at all
    expect(maniglie(sposta({ layer: "top", regole: undefined }))).toHaveLength(1);
    // the targets of the copper that can move come after the handles: copper under a part is grabbed, the part anywhere else on its footprint
    expect(svg.indexOf('data-bersagli-del-rame="mobili"')).toBeGreaterThan(svg.lastIndexOf(maniglie(svg)[0] ?? "nessuna maniglia"));
  });

  it("il rame che non si muovera' mai ha il bersaglio SOTTO le maniglie dei pezzi: premere su un pezzo prende il pezzo, come sempre", () => {
    // the stretch of the top leaves a pad: the solver says so before anyone touches it
    gesto.preseDelRame.mockReturnValue(BERSAGLI.map((b) => (b.tipo === "tratto" && b.pcbTraceId === "tr_top" ? { ...b, fermo: "bloccato: il tratto esce da C1.1 e scivolerebbe di lato" } : b)));
    const svg = sposta({ layer: "top" });
    const maniglia = maniglie(svg)[0] ?? "nessuna maniglia";
    const fermi = svg.indexOf('data-bersagli-del-rame="fermi"');
    const mobili = svg.indexOf('data-bersagli-del-rame="mobili"');
    // the order of the drawing is the order of who takes the press: still copper, then the parts, then the copper that moves
    expect(fermi).toBeGreaterThan(-1);
    expect(fermi).toBeLessThan(svg.indexOf(maniglia));
    expect(mobili).toBeGreaterThan(svg.lastIndexOf(maniglia));
    // the stretch that cannot move is in the first go only, everything else in the second only
    const gruppo = (da: number, a: number) => (svg.slice(da, a).match(/data-presa="([^"]+)"/g) ?? []).map((x) => x.slice(12, -1)).sort();
    expect(gruppo(fermi, svg.indexOf(maniglia))).toEqual(["tratto:tr_top:0"]);
    expect(gruppo(mobili, svg.length)).toEqual(["via:via_a", "via:via_b"]);
    // and it can still be pressed, away from the parts: that is where its sentence is said
    expect(bersagli(svg)).toEqual(["tratto:tr_top:0", "via:via_a", "via:via_b"]);
  });
});

describe("Sposta, una cosa alla volta: i componenti, le piste o le vie", () => {
  it("scelta una cosa nella barra, prende la pressione solo quella; senza scelta si prende tutto, come prima", () => {
    const tutto = sposta({ layer: "top" });
    const pezzi = sposta({ layer: "top", cosaSiSposta: "pezzi" });
    const piste = sposta({ layer: "top", cosaSiSposta: "piste" });
    const vie = sposta({ layer: "top", cosaSiSposta: "vie" });
    expect(maniglie(tutto).length).toBeGreaterThan(0);
    expect(bersagli(tutto).some((b) => b?.startsWith("via:"))).toBe(true);
    expect(bersagli(tutto).some((b) => b?.startsWith("tratto:"))).toBe(true);

    // the parts alone: every handle, and no copper to grab
    expect(maniglie(pezzi)).toHaveLength(maniglie(tutto).length);
    expect(bersagli(pezzi)).toEqual([]);
    expect(pezzi).toContain("Trascina un componente per spostarlo.");

    // the traces alone: the stretches, no via, and no part is there for the pointer
    expect(bersagli(piste)).toEqual(bersagli(tutto).filter((b) => b?.startsWith("tratto:")));
    expect(maniglie(piste)).toEqual([]);
    expect(piste).toMatch(/<rect[^>]*style="cursor:move;pointer-events:none"/);
    expect(piste).toContain("Trascina un tratto dritto di pista: scorre di lato.");

    // the vias alone
    expect(bersagli(vie)).toEqual(bersagli(tutto).filter((b) => b?.startsWith("via:")));
    expect(maniglie(vie)).toEqual([]);
    expect(vie).toContain("Trascina una via: le sue piste la seguono.");
  });
});

describe("il rame di un gesto: cosa disegna RameInMovimento", () => {
  const drawOrder = ["bottom", "inner2", "inner1", "top"];
  /** a gesture in hand whose copper is on three layers: the via pushed a trace of the bottom and one of an inner plane */
  const stato = statoConLaViaIn(-3, 6, {
    tratti: [
      { x1: -5, y1: 0, x2: -3, y2: 6, layer: "top", width: 0.311 },
      { x1: 5, y1: 0, x2: 5, y2: 4, layer: "bottom", width: 0.312 },
      { x1: 0, y1: 0, x2: 0, y2: 4, layer: "inner1", width: 0.313 },
    ],
  });
  const disegna = (vista: { scelto: string; xray: number }, s = stato) =>
    renderToStaticMarkup(
      createElement("svg", null, createElement(RameInMovimento, { vivo: nuovoGestoVivo({ stato: s, rifiuto: null }), inAttesa: [], drawOrder, ...vista } as never)),
    );
  /** the opacity of the group a stretch is drawn in, the stretch recognised by its width */
  const forza = (svg: string, larghezza: string) =>
    new RegExp(`<g opacity="([^"]+)">(?:(?!</g>).)*stroke-width="${larghezza.replace(".", "\\.")}"`).exec(svg)?.[1];

  it("un tratto mosso su uno strato non scelto e' nel disegno del gesto con opacita' 0,5, o quella della radiografia se e' piu' alta", () => {
    // x-ray at zero: the still copper of the bottom and of the inner plane is not drawn, the moved copper is, at a half
    const spenta = disegna({ scelto: "top", xray: 0 });
    expect(forza(spenta, "0.311")).toBe("1");
    expect(forza(spenta, "0.312")).toBe("0.5");
    expect(forza(spenta, "0.313")).toBe("0.5");
    // 40% of the x-ray is 0,3: under a half, the half stays
    expect(forza(disegna({ scelto: "top", xray: 40 }), "0.312")).toBe("0.5");
    // the x-ray at its top is 0,75: higher than a half, it wins
    const piena = disegna({ scelto: "top", xray: 100 });
    expect(forza(piena, "0.312")).toBe("0.75");
    expect(forza(piena, "0.313")).toBe("0.75");
    expect(forza(piena, "0.311")).toBe("1");
    // with Tutti, and on its own layer, a moved stretch is like the copper around it
    expect(forza(disegna({ scelto: "all", xray: 0 }), "0.312")).toBe("1");
    expect(forza(disegna({ scelto: "bottom", xray: 0 }), "0.312")).toBe("1");
    expect(forza(disegna({ scelto: "bottom", xray: 0 }), "0.311")).toBe("0.5");
    // the rule, as a number
    expect(forzaDelRameMosso("inner1", "top", 0)).toBe(0.5);
    expect(forzaDelRameMosso("inner1", "top", 80)).toBeCloseTo(0.6, 10);
    expect(forzaDelRameMosso("top", "top", 0)).toBe(1);
  });

  it("disegna i tratti dove sono ora, nel colore del loro strato, e la via con corona e foro: passante, mai attenuata", () => {
    const svg = disegna({ scelto: "bottom", xray: 0 });
    expect(svg).toMatch(/<line x1="-5" y1="0" x2="-3" y2="6" stroke="[^"]+" stroke-width="0\.311" stroke-linecap="round"/);
    // the via is outside every layer group: ring 0,61 and hole 0,31 at (-3; 6)
    expect(svg).toMatch(/<\/g><g><circle cx="-3" cy="6" r="0\.305" fill="#C9A227" opacity="0\.9"><\/circle><circle cx="-3" cy="6" r="0\.155" fill="#06100D">/);
    // nothing in hand and nothing waiting: nothing is drawn
    expect(disegna({ scelto: "top", xray: 0 }, null as never)).toBe("<svg></svg>");
  });

  it("cio' che blocca ha l'alone e la frase; una presa rifiutata dice la sua frase senza alone", () => {
    const avviso = (vivo: unknown) =>
      renderToStaticMarkup(createElement("svg", null, createElement(AvvisoDelGesto, { vivo, mmPerPx: 0.1 } as never)));
    const bloccato = statoConLaViaIn(-3, 6, {
      blocco: { motivo: "bloccato dalla piazzola C1.1", alone: { x: -10, y: -6, raggioMm: 0.9, layer: "top" } },
    });
    const svg = avviso(nuovoGestoVivo({ stato: bloccato, rifiuto: null }));
    expect(svg).toMatch(/<circle cx="-10" cy="-6" r="0\.9" fill="rgba\(255,77,94,0\.16\)" stroke="#FF4D5E"/);
    expect(svg).toContain(">bloccato dalla piazzola C1.1</text>");
    // a block with no place to light: the sentence, next to the grabbed thing
    const senzaPosto = avviso(nuovoGestoVivo({ stato: statoConLaViaIn(-3, 6, { blocco: { motivo: "la pista SDA non ha spazio" } }), rifiuto: null }));
    expect(senzaPosto).not.toContain("<circle");
    expect(senzaPosto).toMatch(/<g transform="translate\(-3 6\) scale\(0\.1 -0\.1\)">.*la pista SDA non ha spazio/);
    const rifiuto = avviso(nuovoGestoVivo({ stato: null, rifiuto: { x: 5, y: 2.5, frase: "questo tratto esce da una piazzola: non si sposta" } }));
    expect(rifiuto).not.toContain("<circle");
    expect(rifiuto).toMatch(/translate\(5 2\.5\).*questo tratto esce da una piazzola: non si sposta/);
    // free copper, nothing refused: nothing over the board
    expect(avviso(nuovoGestoVivo({ stato: statoConLaViaIn(-3, 6), rifiuto: null }))).toBe("<svg></svg>");
  });
});

describe("un gesto lasciato resta a schermo finche' la scheda salvata non lo mostra", () => {
  const inAttesa = [{ gesto: "g1", salvataggio: SALVATAGGIO, stato: statoConLaViaIn(-3, 6) }];

  it("il rame fermo lascia fuori la pista e la via del gesto, e RameInMovimento le disegna dove sono state lasciate", () => {
    const prima = sposta({ layer: "top" });
    // the still copper: the trace as a polyline, the via where the board has it
    expect(prima).toMatch(/<polyline points="-5,0 -5,5"[^>]*stroke-width="0\.311"/);
    expect(prima).toMatch(/<circle cx="-5" cy="5" r="0\.305" fill="#C9A227"/);
    expect(prima).not.toContain("data-rame-in-movimento");

    const dopo = sposta({ layer: "top", rameInAttesa: inAttesa });
    expect(dopo).not.toMatch(/<polyline points="-5,0 -5,5"/);
    expect(dopo).not.toMatch(/<circle cx="-5" cy="5" r="0\.305" fill="#C9A227"/);
    expect(dopo).toMatch(/data-rame-in-movimento.*<line x1="-5" y1="0" x2="-3" y2="6"[^>]*stroke-width="0\.311"/);
    expect(dopo).toMatch(/<circle cx="-3" cy="6" r="0\.305" fill="#C9A227"/);
    // the other copper is untouched
    expect(dopo).toMatch(/<circle cx="5" cy="5" r="0\.31" fill="#C9A227"/);
    // the targets stay where the board has the copper: a press on them is taken, and starts nothing (sposta-rame-gesto.test.ts)
    expect(bersagli(dopo)).toEqual(bersagli(prima));
  });

  it("la scheda mostra il gesto quando ha la via al suo posto e le piste col percorso scritto", () => {
    const dopo = { ...fileDiPartenza(), pcb_vias: SALVATAGGIO.vias };
    const conLaPista = { ...dopo, pcb_routes: [...dopo.pcb_routes, ...SALVATAGGIO.routes] };
    const tutto = { ...conLaPista, pcb_routes: [{ ...conLaPista.pcb_routes[0], points: SALVATAGGIO.riscritte[0].points }, ...SALVATAGGIO.routes] };
    // the board of before, the via alone, the via and its trace: not yet
    expect(schedaMostraIlRame(SCHEDA, SALVATAGGIO)).toBe(false);
    expect(schedaMostraIlRame(schedaDa(dopo), SALVATAGGIO)).toBe(false);
    expect(schedaMostraIlRame(schedaDa(conLaPista), SALVATAGGIO)).toBe(false);
    expect(schedaMostraIlRame(schedaDa(tutto), SALVATAGGIO)).toBe(true);
    // a path is the same read from either end, as for the corrections themselves
    const girata = { ...SALVATAGGIO, routes: [{ ...SALVATAGGIO.routes[0], points: [...SALVATAGGIO.routes[0].points].reverse() }] };
    expect(schedaMostraIlRame(schedaDa(tutto), girata)).toBe(true);
    // a route with no points only takes copper out: it asks nothing of the board
    expect(schedaMostraIlRame(SCHEDA, { routes: [{ ...SALVATAGGIO.routes[0], points: [] }], vias: [], riscritte: [] })).toBe(true);
  });
});
