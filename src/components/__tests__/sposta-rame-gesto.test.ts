import { Fragment, act, createElement, useCallback, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DESIGN_RULES } from "@/lib/design-rules";
import { BoardCanvas } from "../board/BoardCanvas";
import { colatePerRete, layerDrawOrder } from "../board/render";
import { VIEW_PRESETS } from "../ViewPresets";
import { EditorBar } from "../workspace/EditorBar";
import { AUTOSAVE_MS, useManualEditor, type ManualEditor } from "../workspace/useManualEditor";
import { apriFinestra, type Finestra, type Nodo } from "./dom-finto";
import { BERSAGLI, NASCOSTI, PISTA_A_MANO, SALVATAGGIO, fileDiPartenza, schedaDa, serverFinto, statoConLaViaIn } from "./rame-di-prova";

/*
 * IL GESTO SUL RAME IN "SPOSTA", col puntatore vero: giu' su una via o su un
 * tratto, i movimenti, i fotogrammi, il rilascio, Esc, Cmd+Z. Il visore e
 * l'editor sono quelli veri, montati con react-dom su un DOM finto
 * (dom-finto.ts) e collegati come li collega Studio; il server e' finto
 * (rame-di-prova.ts) e il risolutore non e' quello vero: risponde quello che
 * dice la prova, cosi' qui si prova il visore e non la geometria.
 *
 * Il visore parte con un pixel per millimetro e la y in su: un puntatore a
 * (x; -y) pixel e' a (x; y) mm.
 */
const gesto = vi.hoisted(() => ({
  preseDelRame: vi.fn(),
  iniziaGesto: vi.fn(),
  muoviGesto: vi.fn(),
  chiudiGesto: vi.fn(),
}));
vi.mock("@/lib/spinta/gesto", () => gesto);

/*
 * Two functions of the drawing are watched, to count who is drawn again:
 * the canvas asks for the order of the layers once per render, and the still
 * copper asks for the pours of each layer once per layer per render.
 */
vi.mock("../board/render", async (vero) => {
  const render = await vero<typeof import("../board/render")>();
  return { ...render, colatePerRete: vi.fn(render.colatePerRete), layerDrawOrder: vi.fn(render.layerDrawOrder) };
});

/** the gesture the mocked solver hands out: the viewer must give it back as it is */
const IN_MANO = { delRisolutore: true };
const FLAGS = { ...VIEW_PRESETS[0].flags, is_showing_copper_pours: true };

let f: Finestra;
let server: ReturnType<typeof serverFinto>;
const spie = {
  onMoveComponent: vi.fn(),
  onPickComponent: vi.fn(),
  /** the board updates asked of the page: the hint, and how many writes were done by then */
  aggiornamenti: [] as Array<{ hint: unknown; scritture: number }>,
};
/** how much of the layers not chosen shows through (the X-ray of the viewer): 0 unless a test asks */
let radiografia = 0;
/** what the page holds at its last render */
const fuori = {} as { editor: ManualEditor; scheda: unknown[] };

/**
 * The editor and the canvas of Sposta wired as Studio wires them: the rules,
 * the gestures waiting, who saves a gesture, and the board that arrives. The
 * fast update is the page's: here it lays the board from the server's file.
 */
function Pagina() {
  const [circuitJson, setCircuitJson] = useState(() => schedaDa(server.stato.file));
  const onApplied = useCallback(async (hint?: { structural?: boolean; background?: boolean }) => {
    spie.aggiornamenti.push({ hint: hint ?? null, scritture: server.scritture().length });
    setCircuitJson(schedaDa(server.stato.file));
    return { ok: true };
  }, []);
  const editor = useManualEditor({ projectId: "p1", onApplied });
  const [vista, setVista] = useState(circuitJson);
  if (vista !== circuitJson) {
    setVista(circuitJson);
    editor.dropShownCopper(circuitJson);
  }
  Object.assign(fuori, { editor, scheda: circuitJson });
  return createElement(
    Fragment,
    null,
    createElement(EditorBar, { editor, scope: "pcb" }),
    createElement(BoardCanvas, {
      circuitJson,
      flags: FLAGS,
      layer: "top",
      xray: radiografia,
      mode: editor.mode === "move" ? "move" : "view",
      regole: DEFAULT_DESIGN_RULES,
      rameInAttesa: editor.copper,
      onGestoDelRame: editor.addCopper,
      onMoveComponent: spie.onMoveComponent,
      onPickComponent: spie.onPickComponent,
    } as never),
  );
}

/** the pointer at (x; y) millimetres */
const a = (x: number, y: number, campi: Record<string, unknown> = {}) => ({ clientX: x, clientY: -y, ...campi });
/** lets the queue of the editor run to its end: every promise settled, every state drawn */
const calma = async () => {
  for (let i = 0; i < 4; i++) await act(async () => void (await new Promise((fatto) => setImmediate(fatto))));
};
/** time passes: the wait before a save, the moment a refusal stays on the board */
const passa = async (ms: number) => {
  await act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
  await calma();
};

const dentro = (n: Nodo, attributo: string): boolean =>
  n.getAttribute(attributo) !== null || (n.parentNode !== null && dentro(n.parentNode, attributo));
const numeri = (n: Nodo, ...nomi: string[]) => nomi.map((k) => Number(n.getAttribute(k)));
const bersaglio = (presa: string): Nodo => f.contenitore.cerca((n) => n.getAttribute("data-presa") === presa)[0];
const bersagli = () => f.contenitore.cerca((n) => n.getAttribute("data-presa") !== null).map((n) => n.getAttribute("data-presa")).sort();
const maniglia = (): Nodo => f.contenitore.cerca((n) => n.tagName === "rect" && n.style.cursor === "move")[0];
/** the vias of the still copper, and of the copper of a gesture: where their rings are */
const vie = (mosse: boolean) =>
  f.contenitore
    .cerca((n) => n.tagName === "circle" && n.getAttribute("fill") === "#C9A227" && dentro(n, "data-rame-in-movimento") === mosse)
    .map((n) => numeri(n, "cx", "cy"));
/** the trace of the top (0,311 wide) in the still copper: its points, or nothing when a gesture has taken it out */
const pistaFerma = () =>
  f.contenitore.cerca((n) => n.tagName === "polyline" && n.getAttribute("stroke-width") === "0.311").map((n) => n.getAttribute("points"));
/** the stretches a gesture draws */
const trattiMossi = () =>
  f.contenitore.cerca((n) => n.tagName === "line" && dentro(n, "data-rame-in-movimento")).map((n) => numeri(n, "x1", "y1", "x2", "y2"));
const avviso = () => f.contenitore.cerca((n) => n.getAttribute("data-blocco-del-gesto") !== null)[0] ?? null;
/** the group of the board in millimetres: its transform is the view */
const vista = () => f.contenitore.cerca((n) => n.tagName === "g" && /^translate\(.*scale\(/.test(n.getAttribute("transform") ?? ""))[0].getAttribute("transform");
/** how many times the canvas, and the still copper (four layers per render), have been drawn */
const disegni = () => ({ visore: vi.mocked(layerDrawOrder).mock.calls.length, fermo: vi.mocked(colatePerRete).mock.calls.length / 4 });
/** the editor as the person sees it */
const editorOra = () => {
  const { mode, pending, copper, dirty, canUndo, canRedo, error, saveState, saved } = fuori.editor;
  return { mode, pending, copper, dirty, canUndo, canRedo, error, saveState, saved };
};

let smonta: (() => Promise<void>) | null = null;
/** the page in Sposta, its file read */
async function apri() {
  ({ smonta } = await f.monta(createElement(Pagina)));
  await calma();
  await act(async () => fuori.editor.setMode("move"));
}
/** via_a taken in hand and dragged to (x; y), its frame run */
async function trascinaLaVia(x: number, y: number, campi: Record<string, unknown> = {}) {
  const via = bersaglio("via:via_a");
  await f.spara(via, "pointerdown", a(-5, 5));
  await f.spara(via, "pointermove", a(x, y, campi));
  await f.frame();
  return via;
}

beforeEach(() => {
  vi.clearAllMocks();
  radiografia = 0;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  f = apriFinestra();
  server = serverFinto();
  vi.stubGlobal("fetch", server.fetch);
  spie.aggiornamenti = [];
  gesto.preseDelRame.mockReturnValue(BERSAGLI);
  gesto.iniziaGesto.mockImplementation(() => ({ gesto: IN_MANO, stato: statoConLaViaIn(-5, 5) }));
  gesto.muoviGesto.mockImplementation((_g: unknown, verso: { x: number; y: number }) => statoConLaViaIn(verso.x, verso.y));
  gesto.chiudiGesto.mockImplementation((_g: unknown, stato: { mosso: boolean }) => (stato.mosso ? SALVATAGGIO : null));
});

afterEach(async () => {
  await smonta?.();
  smonta = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  f.chiudi();
});

describe("il gesto sul rame in Sposta: dal puntatore giu' al rilascio", () => {
  it("durante un gesto il rame fermo riceve le stesse prop fra un movimento del puntatore e l'altro: non si ridisegna, e nemmeno il visore", async () => {
    await apri();
    const via = bersaglio("via:via_a");
    const prima = disegni();

    // the gesture starts: the canvas and the still copper are drawn once more, without the copper in hand
    await f.spara(via, "pointerdown", a(-5, 5));
    const inizio = disegni();
    expect(inizio).toEqual({ visore: prima.visore + 1, fermo: prima.fermo + 1 });
    expect(pistaFerma()).toEqual([]);
    expect(vie(false)).toEqual([[5, 5]]);
    expect(vie(true)).toEqual([[-5, 5]]);

    // the pointer moves, frame after frame: only the copper of the gesture is drawn again
    for (const [x, y] of [[-4, 5.5], [-3, 6], [-2.5, 7], [-3, 6]]) {
      await f.spara(via, "pointermove", a(x, y, { altKey: true }));
      await f.frame();
      expect(vie(true)).toEqual([[x, y]]);
      expect(trattiMossi()).toEqual([[-5, 0, x, y]]);
      expect(disegni()).toEqual(inizio);
    }

    // the gesture ends: the hidden list changes hands (from the gesture to the one waiting), and only then they are drawn again
    await f.spara(via, "pointerup", a(-3, 6, { altKey: true }));
    expect(disegni().fermo).toBeGreaterThan(inizio.fermo);
    expect(pistaFerma()).toEqual([]);
    expect(vie(true)).toEqual([[-3, 6]]);
  });

  it("una pista che il gesto spinge esce dal rame fermo quando viene spinta e ci torna quando il puntatore torna indietro: il rame fermo si ridisegna solo allora", async () => {
    // the inner plane shows through, so its trace is in the still copper to begin with
    radiografia = 60;
    await apri();
    const via = bersaglio("via:via_a");
    /** the hand route of the inner plane (0,313 wide) in the still copper */
    const internaFerma = () => f.contenitore.cerca((n) => n.tagName === "polyline" && n.getAttribute("stroke-width") === "0.313").length;
    // the solver: past x = -2 the via pushes the trace of the inner plane, one millimetre aside; the same list for every such state
    const CON_LA_SPINTA = { pcbTraceIds: ["tr_top", "tr_in1"], pcbViaIds: ["via_a"] };
    gesto.muoviGesto.mockImplementation((_g: unknown, verso: { x: number; y: number }) =>
      verso.x > -2
        ? statoConLaViaIn(verso.x, verso.y, {
            nascosti: CON_LA_SPINTA,
            tratti: [
              { x1: -5, y1: 0, x2: verso.x, y2: verso.y, layer: "top", width: 0.311 },
              { x1: 1, y1: 0, x2: 1, y2: 5, layer: "inner1", width: 0.313 },
            ],
          })
        : statoConLaViaIn(verso.x, verso.y),
    );
    const muovi = async (x: number, y: number) => {
      await f.spara(via, "pointermove", a(x, y, { altKey: true }));
      await f.frame();
    };

    await f.spara(via, "pointerdown", a(-5, 5));
    const inizio = disegni();
    expect(internaFerma()).toBe(1);

    // near, not pushing yet: nothing but the copper in hand is drawn again
    await muovi(-3, 5);
    expect(disegni()).toEqual(inizio);
    expect(internaFerma()).toBe(1);

    // the trace is pushed: it leaves the still copper, which is drawn once more, and the gesture draws it where it was pushed
    await muovi(-1, 5);
    expect(disegni()).toEqual({ visore: inizio.visore + 1, fermo: inizio.fermo + 1 });
    expect(internaFerma()).toBe(0);
    // in the order of the layers: the inner plane under the top
    expect(trattiMossi()).toEqual([[1, 0, 1, 5], [-5, 0, -1, 5]]);

    // pushed further: the same copper, nothing but the gesture is drawn again
    await muovi(-0.5, 5);
    expect(disegni()).toEqual({ visore: inizio.visore + 1, fermo: inizio.fermo + 1 });

    // the pointer comes back: the trace is where it was, in the still copper again
    await muovi(-3, 5);
    expect(disegni()).toEqual({ visore: inizio.visore + 2, fermo: inizio.fermo + 2 });
    expect(internaFerma()).toBe(1);
    expect(trattiMossi()).toEqual([[-5, 0, -3, 5]]);
  });

  it("il puntatore sta sulla griglia di Sposta, Alt la toglie, e il gesto si calcola al piu' una volta per fotogramma con l'ultima posizione", async () => {
    await apri();
    const via = bersaglio("via:via_a");
    await f.spara(via, "pointerdown", a(-5, 5));
    // the solver is asked about the board on screen, with the project's rules and the thing grabbed
    expect(gesto.iniziaGesto).toHaveBeenCalledTimes(1);
    expect(gesto.iniziaGesto).toHaveBeenCalledWith({ circuitJson: fuori.scheda, regole: DEFAULT_DESIGN_RULES, presa: { tipo: "via", pcbViaId: "via_a" } });

    // three moves before the screen ticks: one frame asked, nothing worked out yet
    await f.spara(via, "pointermove", a(-4.9, 5.2));
    await f.spara(via, "pointermove", a(-4, 5.8));
    await f.spara(via, "pointermove", a(-3.1, 6.2));
    expect(f.frameInAttesa()).toBe(1);
    expect(gesto.muoviGesto).not.toHaveBeenCalled();
    await f.frame();
    // once, with the last place, on the 0,635 grid: -3,1 -> -3,175 and 6,2 -> 6,35
    expect(gesto.muoviGesto).toHaveBeenCalledTimes(1);
    expect(gesto.muoviGesto.mock.calls[0][0]).toBe(IN_MANO);
    expect(gesto.muoviGesto.mock.calls[0][1]).toEqual({ x: -3.175, y: 6.35 });

    // Alt: the pointer as it is, to the thousandth
    await f.spara(via, "pointermove", a(-3.1, 6.2, { altKey: true }));
    await f.frame();
    expect(gesto.muoviGesto).toHaveBeenCalledTimes(2);
    expect(gesto.muoviGesto.mock.calls[1]).toEqual([IN_MANO, { x: -3.1, y: 6.2 }]);

    // a frame with no move in between works nothing out
    await f.frame();
    expect(gesto.muoviGesto).toHaveBeenCalledTimes(2);
    await f.spara(via, "pointerup", a(-3.1, 6.2, { altKey: true }));

    // a stretch is grabbed by its trace and by the index of its first point
    await passa(AUTOSAVE_MS);
    await f.spara(bersaglio("tratto:tr_top:0"), "pointerdown", a(-5, 2));
    expect(gesto.iniziaGesto).toHaveBeenLastCalledWith(
      expect.objectContaining({ presa: { tipo: "tratto", pcbTraceId: "tr_top", indice: 0 } }),
    );
  });

  it("Esc durante il gesto lascia lo stato dell'editor e la scheda come erano, e non parte niente", async () => {
    await apri();
    const editorPrima = editorOra();
    const schedaPrima = fuori.scheda;
    const scrittePrima = server.stato.richieste.length;
    const via = await trascinaLaVia(-3, 6, { altKey: true });
    expect(vie(true)).toEqual([[-3, 6]]);
    expect(pistaFerma()).toEqual([]);

    const esc = await f.tasto("Escape");
    // the key stops here: the same Esc would leave Sposta (EditorBar) and drop the picked part (the canvas)
    expect(esc.fermatoSubito).toBe(true);
    expect(esc.defaultPrevented).toBe(true);
    expect(fuori.editor.mode).toBe("move");
    expect(spie.onPickComponent).not.toHaveBeenCalled();
    // the board is drawn as it was: the copper in its place, nothing of the gesture left
    expect(pistaFerma()).toEqual(["-5,0 -5,5"]);
    expect(vie(false)).toEqual([[-5, 5], [5, 5]]);
    expect(vie(true)).toEqual([]);
    expect(trattiMossi()).toEqual([]);
    expect(via.hasPointerCapture(1)).toBe(false);

    // the button comes up later, and the pointer keeps moving: nothing is closed, nothing is saved
    await f.spara(via, "pointermove", a(-2, 7));
    await f.frame();
    await f.spara(via, "pointerup", a(-2, 7));
    await passa(AUTOSAVE_MS * 3);
    expect(gesto.muoviGesto).toHaveBeenCalledTimes(1);
    expect(gesto.chiudiGesto).not.toHaveBeenCalled();
    expect(server.stato.richieste.length).toBe(scrittePrima);
    expect(spie.aggiornamenti).toEqual([]);
    expect(editorOra()).toEqual(editorPrima);
    expect(fuori.scheda).toBe(schedaPrima);
    expect(server.stato.file).toEqual(fileDiPartenza());

    // with nothing in hand Esc is everybody's again: it leaves Sposta as it always did
    const dopo = await f.tasto("Escape");
    expect(dopo.fermatoSubito).toBe(false);
    expect(fuori.editor.mode).toBe("view");
  });

  it("al rilascio parte UN salvataggio copper con l'id del gesto e le tre liste come le ha date chiudiGesto, poi l'aggiornamento veloce; un gesto che non ha mosso niente non manda niente", async () => {
    await apri();
    const via = await trascinaLaVia(-3, 6, { altKey: true });
    await f.spara(via, "pointerup", a(-3, 6, { altKey: true }));

    // closed on the gesture the solver gave and on the last state it worked out, with a new id
    expect(gesto.chiudiGesto).toHaveBeenCalledTimes(1);
    const [gestoChiuso, statoChiuso, id] = gesto.chiudiGesto.mock.calls[0];
    expect(gestoChiuso).toBe(IN_MANO);
    expect(statoChiuso).toBe(gesto.muoviGesto.mock.results[0].value);
    expect(id).toMatch(/^[\w-]{1,64}$/);
    // on screen at once, where it was left, and nothing sent before the wait of a dropped part
    expect(vie(true)).toEqual([[-3, 6]]);
    expect(fuori.editor.saveState).toBe("attesa");
    await passa(AUTOSAVE_MS - 50);
    expect(server.scritture()).toEqual([]);

    await passa(50);
    expect(server.scritture()).toEqual([
      {
        metodo: "POST",
        url: "/api/manual-edits",
        corpo: { projectId: "p1", action: "copper", gesto: id, routes: SALVATAGGIO.routes, vias: SALVATAGGIO.vias, riscritte: SALVATAGGIO.riscritte },
      },
    ]);
    // then the fast update of the parts, once, after the write: in the background, and no compile anywhere
    expect(spie.aggiornamenti).toEqual([{ hint: { background: true }, scritture: 1 }]);
    expect(server.stato.richieste.every((r) => r.url.startsWith("/api/manual-edits"))).toBe(true);
    // the board that came back shows the copper: the gesture leaves the screen, the still copper has it
    expect(fuori.editor.copper).toEqual([]);
    expect(vie(true)).toEqual([]);
    expect(vie(false)).toEqual([[-3, 6], [5, 5]]);
    expect(pistaFerma()).toEqual(["-5,0 -3,6"]);
    expect(fuori.editor.error).toBeNull();
    expect(fuori.editor.saveState).toBe("salvato");

    // a second drag is a second gesture, with another id
    const ancora = bersaglio("via:via_a");
    await f.spara(ancora, "pointerdown", a(-3, 6));
    await f.spara(ancora, "pointermove", a(-2, 7, { altKey: true }));
    // let go before the screen ticked: the last place of the pointer counts all the same
    await f.spara(ancora, "pointerup", a(-2, 7, { altKey: true }));
    expect(gesto.muoviGesto).toHaveBeenLastCalledWith(IN_MANO, { x: -2, y: 7 });
    await passa(AUTOSAVE_MS);
    expect(server.scritture()).toHaveLength(2);
    expect(server.scritture()[1].corpo?.gesto).toMatch(/^[\w-]{1,64}$/);
    expect(server.scritture()[1].corpo?.gesto).not.toBe(id);

    // pressed and let go without moving: chiudiGesto says null, and nothing is sent or kept
    gesto.chiudiGesto.mockReturnValueOnce(null);
    const fermo = bersaglio("via:via_b");
    await f.spara(fermo, "pointerdown", a(5, 5));
    await f.spara(fermo, "pointerup", a(5, 5));
    expect(gesto.chiudiGesto).toHaveBeenCalledTimes(3);
    await passa(AUTOSAVE_MS * 3);
    expect(server.scritture()).toHaveLength(2);
    expect(fuori.editor.copper).toEqual([]);
    expect(spie.aggiornamenti).toHaveLength(2);
  });

  it("un 409 del server mostra la sua frase e il rame torna dov'era", async () => {
    await apri();
    const schedaPrima = fuori.scheda;
    server.stato.rifiuta = "la via finirebbe a 0,05 mm dalla piazzola C1.1 (minimo 0,2)";
    const via = await trascinaLaVia(-3, 6, { altKey: true });
    await f.spara(via, "pointerup", a(-3, 6, { altKey: true }));
    expect(vie(true)).toEqual([[-3, 6]]);

    await passa(AUTOSAVE_MS);
    expect(server.scritture()).toHaveLength(1);
    // the server's sentence, as it wrote it, where the editor says its errors
    const frase = "rame non salvato: la via finirebbe a 0,05 mm dalla piazzola C1.1 (minimo 0,2)";
    expect(fuori.editor.error).toBe(frase);
    expect(f.contenitore.textContent).toContain(frase);
    // the gesture is dropped: the copper is drawn where the board has it, and can be grabbed again
    expect(fuori.editor.copper).toEqual([]);
    expect(vie(true)).toEqual([]);
    expect(trattiMossi()).toEqual([]);
    expect(vie(false)).toEqual([[-5, 5], [5, 5]]);
    expect(pistaFerma()).toEqual(["-5,0 -5,5"]);
    expect(bersagli()).toEqual(["tratto:tr_top:0", "via:via_a", "via:via_b"]);
    // nothing was written: no board update, no step to undo, the same board
    expect(spie.aggiornamenti).toEqual([]);
    expect(fuori.editor.canUndo).toBe(false);
    expect(fuori.scheda).toBe(schedaPrima);
    expect(server.stato.file).toEqual(fileDiPartenza());
  });

  it("un gesto e' un solo passo di annulla: Cmd+Z riporta via e piste dov'erano, Cmd+Shift+Z le rimette", async () => {
    await apri();
    const via = await trascinaLaVia(-3, 6, { altKey: true });
    await f.spara(via, "pointerup", a(-3, 6, { altKey: true }));
    await passa(AUTOSAVE_MS);
    const dopoIlGesto = server.stato.file;
    // the via, its trace and the hand route the gesture rewrote: three things in the file, one gesture
    expect(dopoIlGesto.pcb_vias).toEqual(SALVATAGGIO.vias);
    expect(dopoIlGesto.pcb_routes).toEqual([{ ...PISTA_A_MANO, points: SALVATAGGIO.riscritte[0].points }, ...SALVATAGGIO.routes]);
    expect(fuori.editor.canUndo).toBe(true);
    expect(fuori.editor.canRedo).toBe(false);

    // Cmd+Z: ONE write, the state of before, by the save `set` (the one the server checks)
    await f.tasto("z", { metaKey: true });
    await calma();
    expect(server.scritture()).toHaveLength(2);
    expect(server.scritture()[1].corpo).toEqual({ projectId: "p1", action: "set", edits: fileDiPartenza() });
    expect(server.stato.file).toEqual(fileDiPartenza());
    // via and traces are back where they were, on the board that followed
    expect(vie(false)).toEqual([[-5, 5], [5, 5]]);
    expect(pistaFerma()).toEqual(["-5,0 -5,5"]);
    expect(vie(true)).toEqual([]);
    // it was the only step: there is nothing left to undo, and one thing to redo
    expect(fuori.editor.canUndo).toBe(false);
    expect(fuori.editor.canRedo).toBe(true);
    await f.tasto("z", { metaKey: true });
    await calma();
    expect(server.scritture()).toHaveLength(2);

    // Cmd+Shift+Z: ONE write, the state of after: via, trace and hand route together again
    await f.tasto("z", { metaKey: true, shiftKey: true });
    await calma();
    expect(server.scritture()).toHaveLength(3);
    expect(server.scritture()[2].corpo).toEqual({ projectId: "p1", action: "set", edits: dopoIlGesto });
    expect(vie(false)).toEqual([[-3, 6], [5, 5]]);
    expect(pistaFerma()).toEqual(["-5,0 -3,6"]);
    expect(fuori.editor.canUndo).toBe(true);
    expect(fuori.editor.canRedo).toBe(false);
    // no compile was ever asked: only the file was written, and the board followed on the fast path
    expect(server.stato.richieste.every((r) => r.url.startsWith("/api/manual-edits"))).toBe(true);
    expect(fuori.editor.error).toBeNull();
  });

  it("Cmd+Z prima che il gesto sia scritto lo toglie subito senza mandare niente, e Cmd+Shift+Z lo rimette e lo salva come un passo solo", async () => {
    await apri();
    const via = await trascinaLaVia(-3, 6, { altKey: true });
    await f.spara(via, "pointerup", a(-3, 6, { altKey: true }));
    expect(fuori.editor.canUndo).toBe(true);

    await f.tasto("z", { metaKey: true });
    expect(fuori.editor.copper).toEqual([]);
    expect(vie(true)).toEqual([]);
    expect(vie(false)).toEqual([[-5, 5], [5, 5]]);
    await passa(AUTOSAVE_MS * 3);
    expect(server.scritture()).toEqual([]);
    expect(fuori.editor.canRedo).toBe(true);

    await f.tasto("z", { metaKey: true, shiftKey: true });
    expect(vie(true)).toEqual([[-3, 6]]);
    await passa(AUTOSAVE_MS);
    expect(server.scritture()).toHaveLength(1);
    expect(server.scritture()[0].corpo).toMatchObject({ action: "copper", routes: SALVATAGGIO.routes, vias: SALVATAGGIO.vias });
    expect(vie(false)).toEqual([[-3, 6], [5, 5]]);
    // one step back again, and the file is the one of the start
    await f.tasto("z", { metaKey: true });
    await calma();
    expect(server.stato.file).toEqual(fileDiPartenza());
    expect(fuori.editor.canUndo).toBe(false);
  });

  it("un puntatore giu' su un pezzo trascina ancora il pezzo, e su un bersaglio del rame non trascina ne' il pezzo ne' la vista", async () => {
    await apri();
    const vistaPrima = vista();
    // the part: grabbed by its handle, dragged two millimetres, dropped
    const pezzo = maniglia();
    await f.spara(pezzo, "pointerdown", a(-10, -6));
    await f.spara(pezzo, "pointermove", a(-8, -6, { altKey: true }));
    await f.spara(pezzo, "pointerup", a(-8, -6, { altKey: true }));
    expect(spie.onMoveComponent).toHaveBeenCalledTimes(1);
    expect(spie.onMoveComponent.mock.calls[0].slice(0, 4)).toEqual(["pc_top", { x: -10, y: -6 }, { x: -8, y: -6 }, 0]);
    // no copper gesture came of it
    expect(gesto.iniziaGesto).not.toHaveBeenCalled();
    expect(gesto.muoviGesto).not.toHaveBeenCalled();
    expect(gesto.chiudiGesto).not.toHaveBeenCalled();
    expect(vista()).toBe(vistaPrima);

    // the copper: no part is moved, and the view does not pan under the drag
    const via = await trascinaLaVia(-3, 6, { altKey: true });
    await f.spara(via, "pointerup", a(-3, 6, { altKey: true }));
    expect(gesto.iniziaGesto).toHaveBeenCalledTimes(1);
    expect(spie.onMoveComponent).toHaveBeenCalledTimes(1);
    expect(vista()).toBe(vistaPrima);

    // the same drag on the empty board pans the view, as it always did
    const tavola = f.contenitore.cerca((n) => n.tagName === "svg" && n.getAttribute("class") === "block")[0];
    await f.spara(tavola, "pointerdown", a(0, -8));
    await f.spara(tavola, "pointermove", a(2, -8));
    await f.spara(tavola, "pointerup", a(2, -8));
    expect(vista()).not.toBe(vistaPrima);

    // Shift on copper is the selection box, like on a part: the copper is not grabbed
    await passa(AUTOSAVE_MS);
    await f.spara(bersaglio("via:via_b"), "pointerdown", a(5, 5, { shiftKey: true }));
    await f.spara(bersaglio("via:via_b"), "pointerup", a(5, 5, { shiftKey: true }));
    expect(gesto.iniziaGesto).toHaveBeenCalledTimes(1);
  });

  it("mentre un gesto aspetta la sua scheda non ne parte un altro: il puntatore giu' sul rame non fa niente, nemmeno trascinare un pezzo o la vista", async () => {
    await apri();
    const vistaPrima = vista();
    const via = await trascinaLaVia(-3, 6, { altKey: true });
    await f.spara(via, "pointerup", a(-3, 6, { altKey: true }));
    expect(fuori.editor.copper).toHaveLength(1);
    expect(gesto.iniziaGesto).toHaveBeenCalledTimes(1);

    // let go and not written yet: a press on other copper, and on the copper just moved, starts nothing
    for (const presa of ["via:via_b", "tratto:tr_top:0", "via:via_a"]) {
      const altro = bersaglio(presa);
      const giu = await f.spara(altro, "pointerdown", a(5, 5));
      // taken by the target: it does not reach the board, so no part under it is dragged and the view does not pan
      expect(giu.fermato).toBe(true);
      await f.spara(altro, "pointermove", a(7, 7, { altKey: true }));
      expect(f.frameInAttesa()).toBe(0);
      await f.spara(altro, "pointerup", a(7, 7, { altKey: true }));
    }
    expect(gesto.iniziaGesto).toHaveBeenCalledTimes(1);
    expect(gesto.muoviGesto).toHaveBeenCalledTimes(1);
    expect(gesto.chiudiGesto).toHaveBeenCalledTimes(1);
    expect(spie.onMoveComponent).not.toHaveBeenCalled();
    expect(vista()).toBe(vistaPrima);
    expect(fuori.editor.copper).toHaveLength(1);

    // written, and the board that shows it has arrived: copper can be grabbed again, on that board
    await passa(AUTOSAVE_MS);
    expect(fuori.editor.copper).toEqual([]);
    expect(server.scritture()).toHaveLength(1);
    await f.spara(bersaglio("via:via_b"), "pointerdown", a(5, 5));
    expect(gesto.iniziaGesto).toHaveBeenCalledTimes(2);
    expect(gesto.iniziaGesto).toHaveBeenLastCalledWith(expect.objectContaining({ circuitJson: fuori.scheda, presa: { tipo: "via", pcbViaId: "via_b" } }));
  });

  it("una presa rifiutata dice la sua frase sulla scheda per un momento, e nessun gesto inizia", async () => {
    await apri();
    gesto.iniziaGesto.mockReturnValueOnce({ rifiuto: "questo tratto esce da una piazzola: non si sposta" });
    const tratto = bersaglio("tratto:tr_top:0");
    const giu = await f.spara(tratto, "pointerdown", a(-5, 2));
    // said where the block message goes, on the stretch; and the view does not pan under the press
    expect(avviso()?.textContent).toBe("questo tratto esce da una piazzola: non si sposta");
    expect(giu.fermato).toBe(true);
    expect(pistaFerma()).toEqual(["-5,0 -5,5"]);
    expect(trattiMossi()).toEqual([]);

    await f.spara(tratto, "pointermove", a(-4, 2));
    expect(f.frameInAttesa()).toBe(0);
    await f.spara(tratto, "pointerup", a(-4, 2));
    expect(gesto.muoviGesto).not.toHaveBeenCalled();
    expect(gesto.chiudiGesto).not.toHaveBeenCalled();

    await passa(2000);
    expect(avviso()).not.toBeNull();
    await passa(600);
    expect(avviso()).toBeNull();
    expect(server.scritture()).toEqual([]);
    // Esc is not held by a gesture that never started
    expect((await f.tasto("Escape")).fermatoSubito).toBe(false);
  });

  it("bloccato: l'alone e la frase sono sulla scheda, il rame resta all'ultima posizione buona, e li' si chiude il gesto", async () => {
    await apri();
    const bloccato = statoConLaViaIn(-4, 5.5, {
      blocco: { motivo: "bloccato dalla piazzola C1.1", alone: { x: -10, y: -6, raggioMm: 0.9, layer: "top" } },
    });
    gesto.muoviGesto.mockReturnValue(bloccato);
    const via = await trascinaLaVia(-12, -6, { altKey: true });
    // the pointer is far away: the via is drawn where the solver left it
    expect(gesto.muoviGesto).toHaveBeenLastCalledWith(IN_MANO, { x: -12, y: -6 });
    expect(vie(true)).toEqual([[-4, 5.5]]);
    expect(avviso()?.textContent).toBe("bloccato dalla piazzola C1.1");
    const alone = avviso()!.cerca((n) => n.tagName === "circle");
    expect(alone.map((n) => numeri(n, "cx", "cy", "r"))).toEqual([[-10, -6, 6]]);
    expect(alone[0].getAttribute("stroke")).toBe("#FF4D5E");

    // back in the free: the halo and the sentence go
    gesto.muoviGesto.mockReturnValue(statoConLaViaIn(-4, 5));
    await f.spara(via, "pointermove", a(-4, 5, { altKey: true }));
    await f.frame();
    expect(avviso()).toBeNull();

    // blocked again and let go there: what is saved is the last good place, the state the solver gave
    gesto.muoviGesto.mockReturnValue(bloccato);
    await f.spara(via, "pointermove", a(-12, -6, { altKey: true }));
    await f.frame();
    await f.spara(via, "pointerup", a(-12, -6, { altKey: true }));
    expect(gesto.chiudiGesto.mock.calls[0][1]).toBe(bloccato);
    expect(avviso()).toBeNull();
    expect(fuori.editor.copper.map((g) => g.stato)).toEqual([bloccato]);
  });

  it("un puntatore che il browser si riprende, o l'uscita da Sposta, annullano il gesto come Esc", async () => {
    await apri();
    const via = await trascinaLaVia(-3, 6, { altKey: true });
    await f.spara(via, "pointercancel", a(-3, 6));
    expect(vie(true)).toEqual([]);
    expect(pistaFerma()).toEqual(["-5,0 -5,5"]);
    expect((await f.tasto("Escape", { metaKey: true })).fermatoSubito).toBe(false);
    await act(async () => fuori.editor.setMode("move"));

    await trascinaLaVia(-3, 6, { altKey: true });
    expect(vie(true)).toEqual([[-3, 6]]);
    await act(async () => fuori.editor.setMode("view"));
    // in Guarda there is no copper to grab, and the one in hand is back in its place
    expect(bersagli()).toEqual([]);
    expect(vie(true)).toEqual([]);
    expect(vie(false)).toEqual([[-5, 5], [5, 5]]);
    expect((await f.tasto("Escape")).fermatoSubito).toBe(false);
    await passa(AUTOSAVE_MS * 3);
    expect(gesto.chiudiGesto).not.toHaveBeenCalled();
    expect(server.scritture()).toEqual([]);
    expect(NASCOSTI).toEqual({ pcbTraceIds: ["tr_top"], pcbViaIds: ["via_a"] });
  });
});
