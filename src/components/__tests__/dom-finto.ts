import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";

/*
 * A DOM AS SMALL AS REACT NEEDS, for the tests that have to press a pointer
 * or a key: the suite runs in node, with no jsdom, and until now no test
 * simulated the mouse (the canvas was only read from its static render). The
 * copper gesture of "Sposta" is made of pointer down, moves, frames and a
 * release, and "a pointer down on a part still drags the part" cannot be said
 * from a static render.
 *
 * What is here: nodes that keep their children, their attributes and their
 * listeners; a window with its key listeners and a storage; the animation
 * frames, run by hand; a way to mount a component or a hook with the real
 * react-dom and to send React an event on a node. Nothing is laid out: every
 * node measures the same rectangle at the origin, so with the view the canvas
 * starts from (1 px = 1 mm, y up) a pointer at (x; -y) pixels is at (x; y) mm.
 */

type Ascolto = { tipo: string; f: (e: unknown) => void; cattura: boolean };

export class Nodo {
  parentNode: Nodo | null = null;
  childNodes: Nodo[] = [];
  attributi = new Map<string, string>();
  style: Record<string, unknown> & { setProperty: (k: string, v: unknown) => void } = {
    setProperty(k, v) {
      this[k] = v;
    },
  };
  ascolti: Ascolto[] = [];
  nodeValue: string | null = null;
  /** the pointer ids this node holds (setPointerCapture) */
  catturati = new Set<number>();
  readonly nodeName: string;
  readonly tagName: string;

  constructor(
    readonly nodeType: number,
    nome: string,
    readonly ownerDocument: Nodo | null,
    readonly namespaceURI = "http://www.w3.org/1999/xhtml",
  ) {
    this.nodeName = nome;
    this.tagName = nome;
  }

  get firstChild(): Nodo | null {
    return this.childNodes[0] ?? null;
  }
  get lastChild(): Nodo | null {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }
  get nextSibling(): Nodo | null {
    const fratelli = this.parentNode?.childNodes ?? [];
    return fratelli[fratelli.indexOf(this) + 1] ?? null;
  }
  get textContent(): string {
    return this.nodeType === 3 ? (this.nodeValue ?? "") : this.childNodes.map((c) => c.textContent).join("");
  }
  set textContent(testo: string) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (testo) this.appendChild(new Nodo(3, "#text", this.ownerDocument).conTesto(testo));
  }
  conTesto(testo: string): this {
    this.nodeValue = testo;
    return this;
  }
  appendChild(figlio: Nodo): Nodo {
    figlio.parentNode?.removeChild(figlio);
    figlio.parentNode = this;
    this.childNodes.push(figlio);
    return figlio;
  }
  insertBefore(figlio: Nodo, prima: Nodo | null): Nodo {
    figlio.parentNode?.removeChild(figlio);
    figlio.parentNode = this;
    const i = prima ? this.childNodes.indexOf(prima) : -1;
    if (i < 0) this.childNodes.push(figlio);
    else this.childNodes.splice(i, 0, figlio);
    return figlio;
  }
  removeChild(figlio: Nodo): Nodo {
    this.childNodes = this.childNodes.filter((c) => c !== figlio);
    figlio.parentNode = null;
    return figlio;
  }
  setAttribute(k: string, v: unknown) {
    this.attributi.set(k, String(v));
  }
  setAttributeNS(_ns: string, k: string, v: unknown) {
    this.attributi.set(k, String(v));
  }
  removeAttribute(k: string) {
    this.attributi.delete(k);
  }
  getAttribute(k: string): string | null {
    return this.attributi.get(k) ?? null;
  }
  addEventListener(tipo: string, f: (e: unknown) => void, opzioni?: boolean | { capture?: boolean }) {
    this.ascolti.push({ tipo, f, cattura: typeof opzioni === "boolean" ? opzioni : Boolean(opzioni?.capture) });
  }
  removeEventListener(tipo: string, f: (e: unknown) => void, opzioni?: boolean | { capture?: boolean }) {
    const cattura = typeof opzioni === "boolean" ? opzioni : Boolean(opzioni?.capture);
    this.ascolti = this.ascolti.filter((a) => !(a.tipo === tipo && a.f === f && a.cattura === cattura));
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0 };
  }
  setPointerCapture(id: number) {
    this.catturati.add(id);
  }
  hasPointerCapture(id: number): boolean {
    return this.catturati.has(id);
  }
  releasePointerCapture(id: number) {
    this.catturati.delete(id);
  }

  /** this node and everything under it, in document order */
  *tutti(): Generator<Nodo> {
    yield this;
    for (const c of this.childNodes) yield* c.tutti();
  }
  /** the elements under this node that pass the test */
  cerca(vuole: (n: Nodo) => boolean): Nodo[] {
    return [...this.tutti()].filter((n) => n.nodeType === 1 && vuole(n));
  }
}

/** an event as a browser would hand it over, with what React and the canvas read of it */
function evento(tipo: string, target: unknown, campi: Record<string, unknown>) {
  const e = {
    type: tipo,
    target,
    bubbles: true,
    cancelable: true,
    defaultPrevented: false,
    timeStamp: 0,
    button: 0,
    buttons: 1,
    pointerId: 1,
    clientX: 0,
    clientY: 0,
    altKey: false,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    /** what the listeners asked of the event: read by the tests */
    fermato: false,
    fermatoSubito: false,
    getModifierState: () => false,
    preventDefault() {
      e.defaultPrevented = true;
    },
    stopPropagation() {
      e.fermato = true;
    },
    stopImmediatePropagation() {
      e.fermato = true;
      e.fermatoSubito = true;
    },
    ...campi,
  };
  return e;
}

/** runs the listeners of one node for an event: the capture ones, then the others, as far as the event lets them */
function consegna(ascolti: Ascolto[], e: ReturnType<typeof evento>) {
  for (const cattura of [true, false]) {
    for (const a of ascolti.filter((x) => x.tipo === e.type && x.cattura === cattura)) {
      if (e.fermatoSubito) return;
      a.f(e);
    }
    if (e.fermato) return;
  }
}

export interface Finestra {
  contenitore: Nodo;
  /** the animation frames asked and not run yet */
  frameInAttesa: () => number;
  /** runs the frames asked so far, as one tick of the screen */
  frame: () => Promise<void>;
  /** a key pressed on the page: the window's listeners, capture first */
  tasto: (key: string, campi?: Record<string, unknown>) => Promise<ReturnType<typeof evento>>;
  /** an event on a node, through React: pointerdown, pointermove, pointerup, pointercancel */
  spara: (nodo: Nodo, tipo: string, campi?: Record<string, unknown>) => Promise<ReturnType<typeof evento>>;
  monta: (el: ReactElement) => Promise<{ smonta: () => Promise<void> }>;
  /** mounts a component that only calls hooks: `ora()` is what they returned at the last render */
  montaHook: <T>(usa: () => T) => Promise<{ ora: () => T; smonta: () => Promise<void> }>;
  /** takes the fake window, the frames and the rest off the globals */
  chiudi: () => void;
}

/** puts a fake page on the globals of this test file; `chiudi` takes it off */
export function apriFinestra(): Finestra {
  const g = globalThis as Record<string, unknown>;
  const prima = Object.fromEntries(
    ["window", "ResizeObserver", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT"].map((k) => [k, g[k]]),
  );

  const documento = new Nodo(9, "#document", null);
  const contenitore = new Nodo(1, "DIV", documento);
  const finestra = new Nodo(1, "WINDOW", null) as Nodo & Record<string, unknown>;
  Object.assign(documento, {
    activeElement: null,
    body: null,
    defaultView: { document: documento, HTMLIFrameElement: class {} },
    createElement: (tipo: string) => new Nodo(1, tipo.toUpperCase(), documento),
    createElementNS: (ns: string, tipo: string) => new Nodo(1, tipo, documento, ns),
    createTextNode: (testo: string) => new Nodo(3, "#text", documento).conTesto(testo),
  });
  finestra.localStorage = { getItem: () => null, setItem: () => {} };

  const frames: Array<(() => void) | null> = [];
  g.window = finestra;
  g.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  g.requestAnimationFrame = (f: () => void) => frames.push(f);
  g.cancelAnimationFrame = (id: number) => {
    frames[id - 1] = null;
  };
  g.IS_REACT_ACT_ENVIRONMENT = true;

  const radici: Array<ReturnType<typeof createRoot>> = [];
  const monta = async (el: ReactElement) => {
    const radice = createRoot(contenitore as unknown as Element);
    radici.push(radice);
    await act(async () => radice.render(el));
    return { smonta: () => act(async () => radice.unmount()) };
  };

  return {
    contenitore,
    frameInAttesa: () => frames.filter(Boolean).length,
    frame: () =>
      act(async () => {
        for (const f of frames.splice(0)) f?.();
      }),
    tasto: async (key, campi = {}) => {
      const e = evento("keydown", contenitore, { key, ...campi });
      await act(async () => consegna(finestra.ascolti, e));
      return e;
    },
    spara: async (nodo, tipo, campi = {}) => {
      const e = evento(tipo, nodo, campi);
      // React listens on the root for every event, and finds the handlers from the node the event names
      await act(async () => consegna(contenitore.ascolti, e));
      return e;
    },
    monta,
    montaHook: async <T,>(usa: () => T) => {
      const scatola: { ora?: T } = {};
      const Prova = () => {
        scatola.ora = usa();
        return null;
      };
      const { smonta } = await monta(createElement(Prova));
      return { ora: () => scatola.ora as T, smonta };
    },
    chiudi: () => {
      for (const [k, v] of Object.entries(prima)) {
        if (v === undefined) delete g[k];
        else g[k] = v;
      }
    },
  };
}

/** whether a node, or one it is in, carries the attribute: what a drawing is part of */
export const dentro = (n: Nodo, attributo: string): boolean =>
  n.getAttribute(attributo) !== null || (n.parentNode !== null && dentro(n.parentNode, attributo));
/** the attributes of a node as numbers, in the order asked */
export const numeri = (n: Nodo, ...nomi: string[]) => nomi.map((k) => Number(n.getAttribute(k)));

/** lets the promises already settled run their continuations, inside React's act */
export const respira = () => act(async () => {});
