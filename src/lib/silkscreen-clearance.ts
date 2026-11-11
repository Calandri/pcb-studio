/**
 * SILKSCREEN THAT CLASHES.
 *
 * Nothing measured the silkscreen. On tm-4l-q1 (2026-11-11, around C30, R26
 * and the ANT_GNSS line) the outlines of two parts side by side overlapped, and
 * the designators ran over other outlines and over vias, with every check green:
 * two drawings closer than the fab's line print as one blot, a designator over
 * a hole is drilled away, and the ink that falls on a mask opening is clipped
 * off by the fab. Three families, each face on its own:
 *
 * 1. SILKSCREEN AGAINST ANOTHER DRAWING, edge to edge closer than the project's
 *    minSilkscreenClearanceMm (0.15 mm unless it says otherwise), touching or
 *    crossing included. Two drawings are different when they belong to two
 *    parts, when one is a text, or when they are two drawings of the board that
 *    do not continue into each other (see "what a drawing is").
 * 2. SILKSCREEN AGAINST BARE COPPER, the mask openings: SMT pads, the pads of
 *    plated holes, fiducials and test pads (pads too), vias left untented. The
 *    opening is the pad grown by its soldermask_margin, as the Gerber draws it.
 * 3. SILKSCREEN OVER A HOLE, bare holes and the holes of tented vias: a stroke
 *    that touches the hole, at no distance (a designator over a hole cannot be
 *    read).
 *
 * THE STROKE AS IT PRINTS: every pen thinner than SERIGRAFIA_TRATTO_MINIMO_MM
 * is widened to it in the Gerber (silk-stroke.ts), so it is measured widened.
 *
 * TEXT IS MEASURED ON ITS GLYPHS, the strokes circuit-json-to-gerber writes for
 * it (the font of the Gerber, which is what is printed; the viewer draws the
 * label with a screen font): each text is passed through the converter alone
 * and its strokes are read back from the commands, with the pen the Gerber uses
 * (font_size / 8, widened). Lines, rectangles, circles, ovals and pills are read
 * back the same way, so no geometry is written twice. A text drawn as a
 * knockout counts as its filled box.
 *
 * WHAT A DRAWING IS. A part's strokes and a text are easy: whose they are. The
 * strokes of the board (and those of one part among themselves) are grouped:
 * - strokes that touch, an end or a corner on the other's line (a corner, a T,
 *   the bar of an A), are one drawing: one outline drawn in pieces, a segment
 *   drawn twice, the hatching of a logo ending on its contour;
 * - two SMALL strokes that cross (no wider than PICCOLO_MM) are one drawing:
 *   the X and the + of a font drawn as strokes, the tail of a Q;
 * - small pieces closer than the clearance to each other are one drawing: the
 *   letters of a word written as strokes, at 0.13 mm from each other in the font
 *   these boards use, the two rings of a pin-1 dot, the pieces of a logo.
 * Big strokes (an outline, a hole's circle) join a drawing only by touching it.
 *
 * Inside one part, the only clash is its DESIGNATOR against the rest of its
 * drawing: a text of the part, or a word drawn as strokes (two or more small
 * pieces in a row, of the same height). The rest of a footprint is one drawing:
 * its pin-1 mark next to its outline is the footprint as it was drawn.
 *
 * A WARNING. The fabs print it anyway (they clip the ink off the openings), so
 * it does not stop the export, does not change the fab class and does not keep
 * a board out of today's engine: it is listed apart from the DRC, said in the
 * summary and marked on the board in amber, like the via and escape rules.
 */

import { convertSoupToGerberCommands } from "circuit-json-to-gerber";
import { distanzaSegmentoForma, foroDi, ingombroForma, pointSegDistance, rameDelForo, rameDelPad, TOLLERANZA_MM, type FormaRame } from "./drc";
import { dSS } from "./pour-pour";
import { SERIGRAFIA_TRATTO_MINIMO_MM } from "./silk-stroke";

type El = Record<string, unknown> & { type: string };
type Punto = { x: number; y: number };
type Faccia = "top" | "bottom";

export type TipoConflittoSerigrafia = "serigrafia_serigrafia" | "serigrafia_rame" | "serigrafia_foro";

export interface ConflittoSerigrafia {
  tipo: TipoConflittoSerigrafia;
  faccia: Faccia;
  /** the silkscreen drawing, by name: "sigla di C30", "testo \"VBUS\"", "disegno di scheda" */
  a: string;
  /** what it clashes with: another drawing, "piazzola U2.12 (VBAT)", "foro della via (GND)" */
  b: string;
  x: number;
  y: number;
  /** edge to edge, as printed: 0 when they touch or overlap */
  distanzaMm: number;
  /** the clearance asked (0 for a hole: touching is the clash) */
  minimoMm: number;
  /** a part's own silkscreen on its own pad: the footprint as it was drawn, said apart */
  propria?: true;
}

/** what the summary says about the silkscreen (CompileSummary.silkscreen) */
export interface SerigrafiaInConflitto {
  /** every clash found, the unlisted ones included */
  count: number;
  perTipo: Record<TipoConflittoSerigrafia, number>;
  /** the project's minSilkscreenClearanceMm */
  toleranceMm: number;
  /** a warning: it does not stop the export */
  severity: "warn";
  /** the fact in words, with the worst clash by name */
  detail: string;
  /** the nearest ELENCATI_PER_TIPO of each family, nearest first */
  conflitti: ConflittoSerigrafia[];
  /** the check itself stopped: the silkscreen was NOT measured, and why. Absent when it was */
  nonMisurata?: string;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const tre = (v: number) => Math.round(v * 1000) / 1000;

/** how near an end of a stroke is to another stroke's line to be on it */
const TOCCA_MM = 0.01;
/** a glyph or a detail: the strokes that cross or crowd each other inside one drawing */
const PICCOLO_MM = 1.2;
/** two glyphs of one word: the same extent across the line of writing, within this */
const STESSA_ALTEZZA_MM = 0.03;
/** and an extent at least this tall (a dash or a dot is not the height of a word) */
const ALTEZZA_MINIMA_MM = 0.3;
/** the clashes of each family listed in the summary, nearest first; the count is not capped */
const ELENCATI_PER_TIPO = 100;
/** the cell of the spatial index */
const CELLA = 0.5;

/** one silkscreen element: a path, a shape, a text */
interface Unita {
  faccia: Faccia;
  /** "c:<pcb_component_id>", "scheda", or "t:<n>" for a text */
  proprietario: string;
  /** the part it is drawn in, null for the board */
  componente: string | null;
  /** the text, for a text */
  testo: string | null;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** one stroke: a segment with the half-width of its pen */
interface Tratto {
  u: number;
  ax: number;
  ay: number;
  bx: number;
  by: number;
  h: number;
}

const larghezza = (u: { minX: number; minY: number; maxX: number; maxY: number }) => Math.max(u.maxX - u.minX, u.maxY - u.minY);

/**
 * The strokes and the filled regions the Gerber writes for one element on its
 * face, read back from the commands: D02 moves, D01 draws from where the pen is,
 * G36/G37 close a region. Strokes drawn in clear polarity (the letters cut out
 * of a knockout) take ink away: they are left out, the box stays whole. Arcs are
 * read as their chords. The board drawings check of component-clearance.ts
 * reads them too.
 */
export function dalGerber(el: El, faccia: Faccia): { segmenti: Array<[Punto, Punto]>; regioni: Punto[][] } {
  const segmenti: Array<[Punto, Punto]> = [];
  const regioni: Punto[][] = [];
  let comandi: Array<Record<string, unknown>> = [];
  try {
    const strati = convertSoupToGerberCommands([el] as never) as unknown as Record<string, Array<Record<string, unknown>>>;
    comandi = strati[faccia === "top" ? "F_SilkScreen" : "B_SilkScreen"] ?? [];
  } catch {
    return { segmenti, regioni };
  }
  let qui: Punto | null = null;
  let regione: Punto[] | null = null;
  let chiara = false;
  for (const c of comandi) {
    const codice = c.command_code;
    if (codice === "LP") chiara = c.polarity === "C";
    else if (codice === "G36") regione = [];
    else if (codice === "G37") {
      if (regione && regione.length >= 3 && !chiara) regioni.push(regione);
      regione = null;
    } else if (codice === "D02" || codice === "D01") {
      const x = num(c.x);
      const y = num(c.y);
      if (x === null || y === null) continue;
      const p = { x, y };
      if (regione) {
        regione.push(p);
      } else if (codice === "D01" && qui && !chiara) {
        segmenti.push([qui, p]);
      }
      qui = p;
    }
  }
  return { segmenti, regioni };
}

/** the pen a silkscreen element is printed with, widened like the Gerber (silk-stroke.ts) */
function pennaDi(el: El): number {
  const w = el.type === "pcb_silkscreen_text" ? (num(el.font_size) ?? 0) / 8 : (num(el.stroke_width) ?? 0.1);
  return Math.max(w, SERIGRAFIA_TRATTO_MINIMO_MM);
}

const FORME = new Set(["pcb_silkscreen_line", "pcb_silkscreen_rect", "pcb_silkscreen_circle", "pcb_silkscreen_oval", "pcb_silkscreen_pill", "pcb_silkscreen_graphic"]);

/** a little union-find, by index */
function unione(n: number) {
  const padre = Array.from({ length: n }, (_, i) => i);
  const trova = (i: number): number => {
    while (padre[i] !== i) {
      padre[i] = padre[padre[i]];
      i = padre[i];
    }
    return i;
  };
  return {
    trova,
    unisci: (a: number, b: number) => {
      const ra = trova(a);
      const rb = trova(b);
      if (ra !== rb) padre[ra] = rb;
    },
  };
}

/** a uniform grid of the strokes of one face */
class Griglia {
  private celle = new Map<number, number[]>();
  private chiave = (gx: number, gy: number) => (gx + 20000) * 40000 + (gy + 20000);
  aggiungi(i: number, minX: number, minY: number, maxX: number, maxY: number): void {
    for (let gx = Math.floor(minX / CELLA); gx <= Math.floor(maxX / CELLA); gx++) {
      for (let gy = Math.floor(minY / CELLA); gy <= Math.floor(maxY / CELLA); gy++) {
        const k = this.chiave(gx, gy);
        const l = this.celle.get(k);
        if (l) l.push(i);
        else this.celle.set(k, [i]);
      }
    }
  }
  /** every index in the cells the box touches, once each (in `visti`, stamped with `marca`) */
  intorno(minX: number, minY: number, maxX: number, maxY: number, visti: Int32Array, marca: number, fai: (j: number) => void): void {
    for (let gx = Math.floor(minX / CELLA); gx <= Math.floor(maxX / CELLA); gx++) {
      for (let gy = Math.floor(minY / CELLA); gy <= Math.floor(maxY / CELLA); gy++) {
        for (const j of this.celle.get(this.chiave(gx, gy)) ?? []) {
          if (visti[j] === marca) continue;
          visti[j] = marca;
          fai(j);
        }
      }
    }
  }
}

/** the board's names: parts, ports with their pin and net */
function nomiDellaScheda(els: El[]) {
  const nomeSorgente = new Map<string, string>();
  for (const el of els) if (el.type === "source_component") nomeSorgente.set(String(el.source_component_id ?? ""), String(el.name ?? ""));
  const nomeParte = new Map<string, string>();
  for (const el of els) {
    if (el.type === "pcb_component") nomeParte.set(String(el.pcb_component_id ?? ""), nomeSorgente.get(String(el.source_component_id ?? "")) || String(el.pcb_component_id ?? "?"));
  }
  const reteDiChiave = new Map<string, string>();
  for (const el of els) {
    if (el.type === "source_net" && el.subcircuit_connectivity_map_key) reteDiChiave.set(String(el.subcircuit_connectivity_map_key), String(el.name ?? ""));
  }
  const porta = new Map<string, El>();
  for (const el of els) if (el.type === "source_port") porta.set(String(el.source_port_id ?? ""), el);
  const pinDi = new Map<string, { pin: string; rete: string | null }>();
  for (const el of els) {
    if (el.type !== "pcb_port") continue;
    const sp = porta.get(String(el.source_port_id ?? ""));
    if (!sp) continue;
    const parte = nomeSorgente.get(String(sp.source_component_id ?? "")) ?? "";
    const pin = String(sp.name ?? (sp.pin_number !== undefined ? `pin${String(sp.pin_number)}` : "?"));
    const chiave = sp.subcircuit_connectivity_map_key ? String(sp.subcircuit_connectivity_map_key) : "";
    pinDi.set(String(el.pcb_port_id ?? ""), { pin: parte ? `${parte}.${pin}` : pin, rete: (chiave && reteDiChiave.get(chiave)) || null });
  }
  const reteDellaVia = (el: El) => (el.subcircuit_connectivity_map_key ? (reteDiChiave.get(String(el.subcircuit_connectivity_map_key)) ?? null) : null);
  return { nomeParte, pinDi, reteDellaVia };
}

/** a copper shape grown by a margin: the mask opening of a pad */
function cresciuta(f: FormaRame, m: number): FormaRame {
  if (!(m > 0)) return f;
  if (f.tipo === "cerchio") return { ...f, r: f.r + m };
  if (f.tipo === "capsula") return { ...f, capsula: { ...f.capsula, r: f.capsula.r + m } };
  // a polygon pad is measured by its box, as everywhere else (see rameDelPad): the box grows
  return { tipo: "rettangolo", x: f.x, y: f.y, w: f.w + 2 * m, h: f.h + 2 * m, rot: f.rot };
}

/** the point of a stroke nearest a shape, near enough to mark it */
function puntoVerso(f: FormaRame, a: Punto, b: Punto): Punto {
  if (f.tipo === "capsula") {
    const c = f.capsula;
    return dSS(a, b, { x: c.ax, y: c.ay }, { x: c.bx, y: c.by }).p;
  }
  return dSS(a, b, { x: f.x, y: f.y }, { x: f.x, y: f.y }).p;
}

function dentro(x: number, y: number, a: Punto[]): boolean {
  let d = false;
  for (let i = 0, j = a.length - 1; i < a.length; j = i++) {
    if (a[i].y > y !== a[j].y > y && x < ((a[j].x - a[i].x) * (y - a[i].y)) / (a[j].y - a[i].y) + a[i].x) d = !d;
  }
  return d;
}

/**
 * Every silkscreen clash on the board, nearest first: one per pair of drawings,
 * or of drawing and pad, or of drawing and hole, at the point where they come
 * nearest. `toleranceMm`: the project's minSilkscreenClearanceMm.
 */
export function conflittiDiSerigrafia(circuitJson: unknown[], toleranceMm: number): ConflittoSerigrafia[] {
  const els = (Array.isArray(circuitJson) ? circuitJson : []) as El[];
  const tol = Number.isFinite(toleranceMm) && toleranceMm >= 0 ? toleranceMm : 0.15;
  const unita: Unita[] = [];
  const tratti: Tratto[] = [];
  /** the filled regions of the silkscreen (shapes and knockouts): their outline is in `tratti`, with no pen */
  const regioni: Array<{ u: number; punti: Punto[] }> = [];
  const testi = new Map<string, number>();

  const nuovaUnita = (el: El, faccia: Faccia, testo: string | null): number => {
    const componente = el.pcb_component_id ? String(el.pcb_component_id) : null;
    let proprietario = componente ? `c:${componente}` : "scheda";
    if (testo !== null) {
      /*
       * A text is a drawing of its own. The same text written twice in the same
       * place is one drawing (the segment drawn twice, for texts).
       */
      const a = (el.anchor_position as { x?: unknown; y?: unknown } | undefined) ?? {};
      const k = [faccia, testo, tre(num(a.x) ?? 0), tre(num(a.y) ?? 0), num(el.font_size), num(el.ccw_rotation) ?? 0, String(el.anchor_alignment ?? "")].join("|");
      const gia = testi.get(k);
      if (gia !== undefined) return gia;
      testi.set(k, unita.length);
      proprietario = `t:${unita.length}`;
    }
    unita.push({ faccia, proprietario, componente, testo, minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
    return unita.length - 1;
  };
  const traccia = (u: number, a: Punto, b: Punto, h: number) => {
    tratti.push({ u, ax: a.x, ay: a.y, bx: b.x, by: b.y, h });
    const U = unita[u];
    U.minX = Math.min(U.minX, a.x, b.x);
    U.minY = Math.min(U.minY, a.y, b.y);
    U.maxX = Math.max(U.maxX, a.x, b.x);
    U.maxY = Math.max(U.maxY, a.y, b.y);
  };

  for (const el of els) {
    const faccia = el.layer === "top" ? "top" : el.layer === "bottom" ? "bottom" : null;
    if (!faccia) continue;
    if (el.type === "pcb_silkscreen_path") {
      const punti = ((el.route as Array<{ x?: unknown; y?: unknown }> | undefined) ?? [])
        .map((p) => ({ x: num(p?.x), y: num(p?.y) }))
        .filter((p): p is Punto => p.x !== null && p.y !== null);
      if (punti.length === 0) continue;
      const u = nuovaUnita(el, faccia, null);
      const h = pennaDi(el) / 2;
      // a path of one point is a dot
      if (punti.length === 1) traccia(u, punti[0], punti[0], h);
      for (let i = 1; i < punti.length; i++) traccia(u, punti[i - 1], punti[i], h);
      continue;
    }
    const testo = el.type === "pcb_silkscreen_text";
    if (!testo && !FORME.has(String(el.type))) continue;
    const { segmenti, regioni: piene } = dalGerber(el, faccia);
    if (segmenti.length === 0 && piene.length === 0) continue;
    const u = nuovaUnita(el, faccia, testo ? String(el.text ?? "") : null);
    const h = pennaDi(el) / 2;
    for (const [a, b] of segmenti) traccia(u, a, b, h);
    for (const r of piene) {
      regioni.push({ u, punti: r });
      for (let i = 0; i < r.length; i++) traccia(u, r[i], r[(i + 1) % r.length], 0);
    }
  }
  if (tratti.length === 0) return [];

  const griglia: Record<Faccia, Griglia> = { top: new Griglia(), bottom: new Griglia() };
  const hMax = tratti.reduce((m, t) => Math.max(m, t.h), 0);
  for (let i = 0; i < tratti.length; i++) {
    const t = tratti[i];
    griglia[unita[t.u].faccia].aggiungi(i, Math.min(t.ax, t.bx), Math.min(t.ay, t.by), Math.max(t.ax, t.bx), Math.max(t.ay, t.by));
  }
  const visti = new Int32Array(tratti.length).fill(-1);

  /*
   * 1. THE PAIRS OF STROKES NEAR EACH OTHER, of different elements on one face:
   * closer than the clearance edge to edge. Each says whether the two touch (an
   * end on the other's line) or cross, which is what the drawings are made of.
   */
  interface Coppia {
    i: number;
    j: number;
    luce: number;
    p: Punto;
    tocca: boolean;
    incrocia: boolean;
  }
  const coppie: Coppia[] = [];
  for (let i = 0; i < tratti.length; i++) {
    const t = tratti[i];
    const U = unita[t.u];
    const r = t.h + hMax + tol;
    griglia[U.faccia].intorno(
      Math.min(t.ax, t.bx) - r,
      Math.min(t.ay, t.by) - r,
      Math.max(t.ax, t.bx) + r,
      Math.max(t.ay, t.by) + r,
      visti,
      i,
      (j) => {
        if (j <= i) return;
        const s = tratti[j];
        if (s.u === t.u) return;
        const a = { x: t.ax, y: t.ay }, b = { x: t.bx, y: t.by }, c = { x: s.ax, y: s.ay }, d = { x: s.bx, y: s.by };
        const m = dSS(a, b, c, d);
        const luce = m.d - t.h - s.h;
        // the micron of slack of every dimensional comparison (see TOLLERANZA_MM)
        if (luce >= tol - TOLLERANZA_MM) return;
        let tocca = false;
        let incrocia = false;
        if (m.d <= TOCCA_MM) {
          tocca =
            pointSegDistance(a.x, a.y, c.x, c.y, d.x, d.y) <= TOCCA_MM ||
            pointSegDistance(b.x, b.y, c.x, c.y, d.x, d.y) <= TOCCA_MM ||
            pointSegDistance(c.x, c.y, a.x, a.y, b.x, b.y) <= TOCCA_MM ||
            pointSegDistance(d.x, d.y, a.x, a.y, b.x, b.y) <= TOCCA_MM;
          incrocia = !tocca;
        }
        coppie.push({ i, j, luce, p: m.p, tocca, incrocia });
      },
    );
  }

  /*
   * 2. THE DRAWINGS (see the header): touching strokes, small crossing strokes,
   * then small pieces crowding each other. Only inside one owner: two parts, or
   * a text and anything, are never one drawing.
   */
  const stessoProprietario = (c: Coppia) => {
    const A = unita[tratti[c.i].u], B = unita[tratti[c.j].u];
    return A.proprietario === B.proprietario && A.testo === null && B.testo === null;
  };
  const pezzi = unione(unita.length);
  for (const c of coppie) {
    if (!stessoProprietario(c)) continue;
    const ua = tratti[c.i].u, ub = tratti[c.j].u;
    if (c.tocca || (c.incrocia && larghezza(unita[ua]) <= PICCOLO_MM && larghezza(unita[ub]) <= PICCOLO_MM)) pezzi.unisci(ua, ub);
  }
  const ingombroPezzo = new Map<number, { minX: number; minY: number; maxX: number; maxY: number }>();
  for (let u = 0; u < unita.length; u++) {
    const r = pezzi.trova(u);
    const U = unita[u];
    const b = ingombroPezzo.get(r);
    if (!b) ingombroPezzo.set(r, { minX: U.minX, minY: U.minY, maxX: U.maxX, maxY: U.maxY });
    else {
      b.minX = Math.min(b.minX, U.minX);
      b.minY = Math.min(b.minY, U.minY);
      b.maxX = Math.max(b.maxX, U.maxX);
      b.maxY = Math.max(b.maxY, U.maxY);
    }
  }
  const piccolo = (pezzo: number) => larghezza(ingombroPezzo.get(pezzo)!) <= PICCOLO_MM;
  const disegni = unione(unita.length);
  for (let u = 0; u < unita.length; u++) disegni.unisci(u, pezzi.trova(u));
  for (const c of coppie) {
    if (!stessoProprietario(c)) continue;
    const pa = pezzi.trova(tratti[c.i].u), pb = pezzi.trova(tratti[c.j].u);
    if (pa !== pb && piccolo(pa) && piccolo(pb)) disegni.unisci(pa, pb);
  }
  const disegnoDi = (u: number) => disegni.trova(u);

  /*
   * A WORD DRAWN AS STROKES: two or more small pieces of one drawing with the
   * same extent across the line of writing (the cap height of its letters).
   */
  const pezziDelDisegno = new Map<number, Set<number>>();
  for (let u = 0; u < unita.length; u++) {
    if (unita[u].testo !== null) continue;
    const d = disegnoDi(u);
    const s = pezziDelDisegno.get(d) ?? new Set<number>();
    s.add(pezzi.trova(u));
    pezziDelDisegno.set(d, s);
  }
  const parola = new Map<number, boolean>();
  const eUnaParola = (d: number): boolean => {
    const gia = parola.get(d);
    if (gia !== undefined) return gia;
    const ps = [...(pezziDelDisegno.get(d) ?? [])].filter(piccolo).map((p) => ingombroPezzo.get(p)!);
    let si = false;
    for (const asse of [0, 1]) {
      const estensioni = ps
        .map((b) => (asse === 0 ? [b.minX, b.maxX] : [b.minY, b.maxY]))
        .filter(([lo, hi]) => hi - lo >= ALTEZZA_MINIMA_MM);
      for (let i = 0; i < estensioni.length && !si; i++) {
        for (let j = i + 1; j < estensioni.length && !si; j++) {
          si = Math.abs(estensioni[i][0] - estensioni[j][0]) <= STESSA_ALTEZZA_MM && Math.abs(estensioni[i][1] - estensioni[j][1]) <= STESSA_ALTEZZA_MM;
        }
      }
    }
    parola.set(d, si);
    return si;
  };

  const { nomeParte, pinDi, reteDellaVia } = nomiDellaScheda(els);
  const nomeDelDisegno = (u: number): string => {
    const U = unita[u];
    const parte = U.componente ? (nomeParte.get(U.componente) ?? U.componente) : null;
    if (U.testo !== null) return `testo "${U.testo}"${parte ? ` di ${parte}` : ""}`;
    const scritta = eUnaParola(disegnoDi(u));
    if (parte) return `${scritta ? "sigla" : "serigrafia"} di ${parte}`;
    return scritta ? "scritta di scheda" : "disegno di scheda";
  };
  /*
   * What a clash is SAID about, so that each is said once: a part's drawing
   * and its designator (an outline drawn in two pieces that both run past the
   * same neighbour is one clash with that neighbour), a text, a drawing of the
   * board.
   */
  const chiaveDelNome = (u: number): string => {
    const U = unita[u];
    if (U.testo !== null) return U.proprietario;
    if (U.componente) return `c:${U.componente}:${eUnaParola(disegnoDi(u)) ? "sigla" : "disegno"}`;
    return `d:${disegnoDi(u)}`;
  };

  /*
   * 3. THE CLASHES BETWEEN DRAWINGS: one per pair, where they come nearest. Two
   * parts, a text and anything, two drawings of the board; inside one part only
   * its designator against the rest of it.
   */
  const fra = new Map<string, { luce: number; p: Punto; ua: number; ub: number }>();
  for (const c of coppie) {
    const ua = tratti[c.i].u, ub = tratti[c.j].u;
    const da = disegnoDi(ua), db = disegnoDi(ub);
    if (da === db) continue;
    const A = unita[ua], B = unita[ub];
    if (A.proprietario === B.proprietario && A.componente !== null && A.testo === null && B.testo === null && !eUnaParola(da) && !eUnaParola(db)) continue;
    const ka = chiaveDelNome(ua), kb = chiaveDelNome(ub);
    if (ka === kb) continue;
    const k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
    const prima = fra.get(k);
    if (!prima || c.luce < prima.luce) fra.set(k, { luce: c.luce, p: c.p, ua, ub });
  }
  const out: ConflittoSerigrafia[] = [];
  for (const { luce, p, ua, ub } of fra.values()) {
    out.push({
      tipo: "serigrafia_serigrafia",
      faccia: unita[ua].faccia,
      a: nomeDelDisegno(ua),
      b: nomeDelDisegno(ub),
      x: tre(p.x),
      y: tre(p.y),
      distanzaMm: tre(Math.max(0, luce)),
      minimoMm: tol,
    });
  }

  /*
   * 4. BARE COPPER AND HOLES. The openings of the mask on each face, and the
   * holes the silkscreen must not touch; each measured against the strokes of
   * its face near it, one clash per drawing (named as above).
   */
  interface Bersaglio {
    facce: Faccia[];
    forma: FormaRame;
    nome: string;
    tipo: "serigrafia_rame" | "serigrafia_foro";
    /** the part the pad belongs to */
    componente: string | null;
  }
  const bersagli: Bersaglio[] = [];
  const facceDi = (el: El): Faccia[] => {
    const l = (el.layers as unknown[] | undefined) ?? [];
    const f: Faccia[] = [];
    if (l.includes("top")) f.push("top");
    if (l.includes("bottom")) f.push("bottom");
    return f;
  };
  const conRete = (base: string, rete: string | null) => (rete ? `${base} (${rete})` : base);
  const delForo = (foro: NonNullable<ReturnType<typeof foroDi>>): FormaRame => ({ tipo: "capsula", x: (foro.ax + foro.bx) / 2, y: (foro.ay + foro.by) / 2, capsula: foro });
  for (const el of els) {
    const componente = el.pcb_component_id ? String(el.pcb_component_id) : null;
    const parte = componente ? nomeParte.get(componente) : undefined;
    if (el.type === "pcb_smtpad") {
      if (el.is_covered_with_solder_mask === true) continue;
      const f = rameDelPad(el);
      const faccia = el.layer === "bottom" ? "bottom" : el.layer === "top" ? "top" : null;
      if (!f || !faccia) continue;
      const pin = pinDi.get(String(el.pcb_port_id ?? ""));
      bersagli.push({
        facce: [faccia],
        forma: cresciuta(f, num(el.soldermask_margin) ?? 0),
        nome: conRete(`piazzola ${pin?.pin ?? parte ?? String(el.pcb_smtpad_id ?? "")}`, pin?.rete ?? null),
        tipo: "serigrafia_rame",
        componente,
      });
    } else if (el.type === "pcb_plated_hole") {
      const pin = pinDi.get(String(el.pcb_port_id ?? ""));
      const chi = pin?.pin ?? parte ?? String(el.pcb_plated_hole_id ?? "");
      if (el.is_covered_with_solder_mask === true) {
        // under the mask only its drill is bare
        const foro = foroDi(el);
        if (foro) bersagli.push({ facce: facceDi(el), forma: delForo(foro), nome: `foro di ${chi}`, tipo: "serigrafia_foro", componente });
        continue;
      }
      const f = rameDelForo(el);
      if (!f) continue;
      bersagli.push({ facce: facceDi(el), forma: cresciuta(f, num(el.soldermask_margin) ?? 0), nome: conRete(`piazzola del foro ${chi}`, pin?.rete ?? null), tipo: "serigrafia_rame", componente });
    } else if (el.type === "pcb_via") {
      const x = num(el.x), y = num(el.y);
      if (x === null || y === null) continue;
      const rete = reteDellaVia(el);
      // a via is tented unless it says otherwise: then only its hole is bare
      if (el.is_tented === false) {
        const d = num(el.outer_diameter);
        if (d !== null && d > 0) bersagli.push({ facce: ["top", "bottom"], forma: { tipo: "cerchio", x, y, r: d / 2 }, nome: conRete("via scoperta", rete), tipo: "serigrafia_rame", componente: null });
        continue;
      }
      const d = num(el.hole_diameter);
      if (d !== null && d > 0) bersagli.push({ facce: ["top", "bottom"], forma: { tipo: "cerchio", x, y, r: d / 2 }, nome: conRete("foro della via", rete), tipo: "serigrafia_foro", componente: null });
    } else if (el.type === "pcb_hole") {
      const foro = foroDi(el);
      if (!foro) continue;
      bersagli.push({ facce: ["top", "bottom"], forma: delForo(foro), nome: `foro non metallizzato da ${tre(2 * foro.r)}mm`, tipo: "serigrafia_foro", componente });
    }
  }
  // the stamps of these queries come after those of the strokes (0..n-1)
  let timbro = tratti.length;
  for (const bersaglio of bersagli) {
    const soglia = bersaglio.tipo === "serigrafia_foro" ? 0 : tol;
    const box = ingombroForma(bersaglio.forma);
    for (const faccia of bersaglio.facce) {
      const peggiore = new Map<string, { luce: number; p: Punto; u: number }>();
      const tieni = (u: number, luce: number, p: () => Punto) => {
        const k = chiaveDelNome(u);
        const prima = peggiore.get(k);
        if (!prima || luce < prima.luce) peggiore.set(k, { luce, p: p(), u });
      };
      timbro++;
      const r = hMax + soglia;
      griglia[faccia].intorno(box.minX - r, box.minY - r, box.maxX + r, box.maxY + r, visti, timbro, (j) => {
        const t = tratti[j];
        const luce = distanzaSegmentoForma(bersaglio.forma, t.ax, t.ay, t.bx, t.by) - t.h;
        // a hole: touching is the clash; copper: closer than the clearance
        if (bersaglio.tipo === "serigrafia_foro" ? luce > 1e-9 : luce >= soglia - TOLLERANZA_MM) return;
        tieni(t.u, luce, () => puntoVerso(bersaglio.forma, { x: t.ax, y: t.ay }, { x: t.bx, y: t.by }));
      });
      // a filled silkscreen region over the opening, with its outline far from it
      for (const reg of regioni) {
        const f = bersaglio.forma;
        if (unita[reg.u].faccia === faccia && dentro(f.x, f.y, reg.punti)) tieni(reg.u, 0, () => ({ x: f.x, y: f.y }));
      }
      for (const { luce, p, u } of peggiore.values()) {
        out.push({
          tipo: bersaglio.tipo,
          faccia,
          a: nomeDelDisegno(u),
          b: bersaglio.nome,
          x: tre(p.x),
          y: tre(p.y),
          distanzaMm: tre(Math.max(0, luce)),
          minimoMm: soglia,
          ...(bersaglio.componente !== null && unita[u].componente === bersaglio.componente ? { propria: true as const } : {}),
        });
      }
    }
  }
  // nearest first; at the same distance a part's own pads after the others
  return out.sort((p, q) => p.distanzaMm - q.distanzaMm || Number(p.propria ?? false) - Number(q.propria ?? false) || p.tipo.localeCompare(q.tipo));
}

const NOMI_DEI_TIPI: Record<TipoConflittoSerigrafia, string> = {
  serigrafia_serigrafia: "fra disegni",
  serigrafia_foro: "sopra fori",
  serigrafia_rame: "su rame scoperto",
};

/** the same for the summary, or undefined when the silkscreen is clear */
export function serigrafiaInConflitto(circuitJson: unknown[], toleranceMm: number): SerigrafiaInConflitto | undefined {
  const tipi = Object.keys(NOMI_DEI_TIPI) as TipoConflittoSerigrafia[];
  const perTipo = Object.fromEntries(tipi.map((t) => [t, 0])) as Record<TipoConflittoSerigrafia, number>;
  let tutti: ConflittoSerigrafia[];
  try {
    tutti = conflittiDiSerigrafia(circuitJson, toleranceMm);
  } catch (err) {
    /*
     * A warning never takes the compile down with it: a silkscreen element
     * this file cannot read would otherwise leave the board without its
     * summary. And it is said, not hidden: a board whose silkscreen was not
     * measured does not read as a clear one.
     */
    const perche = (err instanceof Error ? err.message : String(err)).slice(0, 160);
    console.error(`[serigrafia] controllo non riuscito: ${perche}`);
    return {
      count: 0,
      perTipo,
      toleranceMm,
      severity: "warn",
      detail: `la serigrafia NON e' stata misurata: il controllo si e' fermato (${perche})`,
      conflitti: [],
      nonMisurata: perche,
    };
  }
  if (tutti.length === 0) return undefined;
  for (const c of tutti) perTipo[c.tipo]++;
  const proprie = tutti.filter((c) => c.propria).length;
  const parti = tipi
    .filter((t) => perTipo[t] > 0)
    .map((t) => `${perTipo[t]} ${NOMI_DEI_TIPI[t]}${t === "serigrafia_rame" && proprie > 0 ? `, di cui ${proprie} di un pezzo sulle sue piazzole` : ""}`);
  const c = tutti[0];
  return {
    count: tutti.length,
    perTipo,
    toleranceMm,
    severity: "warn",
    detail:
      `${tutti.length} ${tutti.length === 1 ? "conflitto" : "conflitti"} di serigrafia (${parti.join("; ")}; tolleranza ${toleranceMm}mm): ` +
      `${c.a} e ${c.b} su ${c.faccia}, ${c.distanzaMm.toFixed(3)}mm a (${c.x.toFixed(2)}; ${c.y.toFixed(2)})`,
    // the nearest of each family, so that the pads of a big board do not hide the rest
    conflitti: tipi.flatMap((t) => tutti.filter((x) => x.tipo === t).slice(0, ELENCATI_PER_TIPO)),
  };
}

/** what the compile message says of it: a warning, the export goes on */
export function testoSerigrafia(s: SerigrafiaInConflitto | undefined): string {
  return s ? ` AVVISO serigrafia (non ferma l'export): ${s.detail}.` : "";
}
