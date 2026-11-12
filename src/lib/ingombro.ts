/**
 * THE FOOTPRINT OF A PART IN ASSEMBLY ("l'ingombro del pezzo").
 *
 * Niccolo', 11/11/2026: "ogni pezzo ha il suo INGOMBRO, e' fondamentale per
 * progettare, altrimenti stiamo facendo cose a caso". And the definition, the
 * same evening: "l'ingombro per ogni componente DEVE essere come da datasheet
 * ESATTO + 0,15". What he wants to know is whether two parts hit each other
 * when the board is assembled.
 *
 * One definition, for the check (component-clearance.ts) and for the viewer:
 * - a part whose footprint DECLARES a courtyard: the courtyard is the
 *   footprint, as it is (by convention our footprints write it already as the
 *   exact package plus the excess), with the pads that stick out of it;
 * - otherwise PCB Studio computes it: the EXACT envelope of the package, its
 *   body together with its pads (whichever sticks out more), grown on every
 *   side by the project's componentCourtyardExcessMm (0,15 mm unless
 *   design-rules.json says otherwise; IPC-7351 gives 0,5 / 0,25 / 0,10 per
 *   side, and assemblers ask 0,25-0,3 mm between two 0402).
 *
 * The body is footprint-bounds.ts's (cad_component.size, or the box of the 3D
 * model, see corpoDelPezzo). A resistor or capacitor with two pads and no body
 * gets the body of its standard size (0402, 0603...), deduced from its pads
 * (see formatoDelPassivo). Every other part with no courtyard and no body has
 * an envelope of pads only: it is said apart (the B warning, and a dashed line
 * in the viewer), because its real body is missing.
 *
 * THE ENVELOPE IS TAKEN IN THE PART'S OWN FRAME: the box around body and pads
 * turned with the part, so a QFP at 45 degrees is a turned square and not the
 * upright box around it (on sbb-dl-principale U1, 14,6 mm wide upright).
 *
 * FACES. A part occupies its own face. A through-hole part (plated holes, or
 * pegs through bare holes) occupies the other face too, with its holes and
 * their rings only, grown by the excess: its leads and their solder come
 * through there, its body does not.
 *
 * Everything here is pure geometry over the Circuit JSON, so that the viewer
 * draws and recomputes the same footprints while a part is dragged.
 */

import { footprintParts, type CourtyardShape } from "./footprint-bounds";
import { padGeometry } from "./pcb-route-model";
import { dentro, dSS } from "./pour-pour";

type El = Record<string, unknown>;
export type Punto = { x: number; y: number };
export type Faccia = "top" | "bottom";

export interface Riquadro {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * A shape of a footprint: a polygon (or a segment, or a point) grown by a
 * radius. A rectangle is four points and no radius, a circle one point and its
 * radius, a pill a rectangle and the radius of its ends.
 */
export interface Forma {
  punti: Punto[];
  r: number;
  box: Riquadro;
}

/** what a footprint is read from */
export type FonteIngombro = "cortile" | "piazzole e corpo" | "piazzole e corpo dal formato" | "piazzole";

export interface IngombroDelPezzo {
  /** pcb_component_id */
  id: string;
  /** the designator */
  nome: string;
  faccia: Faccia;
  fonte: FonteIngombro;
  /** the standard size the body was deduced from, for "piazzole e corpo dal formato" */
  formato?: string;
  /**
   * Its footprint is its pads only and its real body is missing (the B warning,
   * a dashed line in the viewer). Not a part that is copper alone: one pad and
   * nothing else, a fiducial or a test pad, whose pad is all of it.
   */
  senzaCorpo: boolean;
  /** the footprint on its own face */
  forme: Forma[];
  /** the exact envelope of body and pads, with no excess, on its own face */
  involucro: Forma;
  /**
   * The envelope holds a body (its own, or its standard size's). False when it
   * is the pads alone: a part with no body, and a part whose body is known
   * only through its declared courtyard (a connector whose body is drawn in
   * the courtyard and nowhere else). A distance from such an envelope is a
   * distance from the pads, not from the part.
   */
  corpoNoto: boolean;
  /** a through-hole part on the other face: its holes and rings, grown by the excess */
  fori: Forma[];
  /** the same with no excess */
  foriEsatti: Forma[];
  /**
   * A connector's mating space: where the part that goes into it (a plug and
   * its cable, a board, a tool) takes room above its face, declared in its
   * footprint (see spaziDiInnesto). Apart from its footprint: it does not grow
   * it, and no part may stand in it.
   */
  innesti: Array<{ forma: Forma; descrizione: string | null }>;
  centro: Punto;
}

const fin = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

const riquadroDi = (punti: Punto[], r: number): Riquadro => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of punti) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX: minX - r, minY: minY - r, maxX: maxX + r, maxY: maxY + r };
};

export const forma = (punti: Punto[], r = 0): Forma => ({ punti, r, box: riquadroDi(punti, r) });

/** cosine and sine of a turn in degrees, exact on the quarter turns */
function cs(gradi: number): [number, number] {
  const g = ((gradi % 360) + 360) % 360;
  if (g === 0) return [1, 0];
  if (g === 90) return [0, 1];
  if (g === 180) return [-1, 0];
  if (g === 270) return [0, -1];
  const a = (g * Math.PI) / 180;
  return [Math.cos(a), Math.sin(a)];
}

/** the four corners of a w x h rectangle centred at (x, y), turned by rot degrees counterclockwise */
export function angoli(x: number, y: number, w: number, h: number, rot: number): Punto[] {
  const [c, s] = cs(rot);
  return [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
  ].map(([u, v]) => ({ x: x + u * c - v * s, y: y + u * s + v * c }));
}

/**
 * The box around some points in a frame turned by `gradi`, grown by `cresci`
 * on every side: a rectangle, as four corners in board coordinates.
 */
export function scatolaOrientata(punti: Punto[], gradi: number, cresci = 0): Punto[] {
  const [c, s] = cs(gradi);
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const p of punti) {
    const u = p.x * c + p.y * s;
    const v = -p.x * s + p.y * c;
    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  minU -= cresci;
  maxU += cresci;
  minV -= cresci;
  maxV += cresci;
  return [
    [minU, minV],
    [maxU, minV],
    [maxU, maxV],
    [minU, maxV],
  ].map(([u, v]) => ({ x: u * c - v * s, y: u * s + v * c }));
}

/** a courtyard as a shape of the footprint */
function formaDelCortile(s: CourtyardShape): Forma | null {
  if (s.kind === "circle") return s.r > 0 ? forma([{ x: s.x, y: s.y }], s.r) : null;
  if (s.kind === "poly") {
    const p = s.points.slice();
    // an outline closed on its first point: once is enough
    if (p.length > 1 && Math.abs(p[0].x - p[p.length - 1].x) < 1e-9 && Math.abs(p[0].y - p[p.length - 1].y) < 1e-9) p.pop();
    return p.length >= 1 ? forma(p) : null;
  }
  if (!(s.w > 0) || !(s.h > 0)) return null;
  // a pill: the rectangle inside its rounded ends, grown by their radius
  const r = Math.max(0, Math.min(s.r ?? 0, s.w / 2, s.h / 2));
  return forma(angoli(s.x, s.y, s.w - 2 * r, s.h - 2 * r, s.rot), r);
}

/** how much of its rectangle a declared outline must fill to be read as that rectangle */
const QUASI_RETTANGOLO = 0.9;

/**
 * A DECLARED COURTYARD, as it is: a rect, a circle or a pill as drawn, an
 * outline or a polygon point by point. One exception: an outline that fills at
 * least QUASI_RETTANGOLO of its rectangle in the part's frame is that rectangle.
 * It is the courtyard drawn around pads and body one by one (the "bone" of a
 * capacitor whose pads are taller than its body): its notches are a few
 * hundredths deep, no part fits in them, and IPC-7351 draws a courtyard as a
 * rectangle. An L-shaped outline, or any other shape a connector needs, fills
 * less of its rectangle and stays as drawn.
 */
function cortileDichiarato(s: CourtyardShape, giro: number): Forma | null {
  const f = formaDelCortile(s);
  if (!f || s.kind !== "poly" || f.punti.length < 4) return f;
  const r = scatolaOrientata(f.punti, giro);
  const areaR = Math.hypot(r[1].x - r[0].x, r[1].y - r[0].y) * Math.hypot(r[3].x - r[0].x, r[3].y - r[0].y);
  let doppia = 0;
  for (let i = 0; i < f.punti.length; i++) {
    const a = f.punti[i], b = f.punti[(i + 1) % f.punti.length];
    doppia += a.x * b.y - b.x * a.y;
  }
  return areaR > 0 && Math.abs(doppia) / 2 >= QUASI_RETTANGOLO * areaR - 1e-9 ? forma(r) : f;
}

/**
 * THE FOOTPRINT PCB STUDIO COMPUTES for a part whose footprint declares no
 * courtyard: the smallest rectangle around body and pads in the part's frame
 * (`involucro`, already that rectangle), grown on every side by the excess. One
 * clean rectangle, the same drawn and measured (Niccolo', 2026-11-11: "deve
 * essere perfetta"). The only place that decides its shape: the alternative,
 * body and pads each grown by the excess (a silhouette), is a list of
 * rectangles here, which the check and the viewer already take.
 */
function ingombroCalcolato(involucro: Punto[], cornice: number, eccedenza: number): Forma[] {
  return [forma(scatolaOrientata(involucro, cornice, eccedenza))];
}

/** the copper of a pad or a hole as a shape, grown by `cresci` */
function formaDelPad(el: El, cresci: number): Forma | null {
  const g = padGeometry(el);
  if (!g || !(g.w > 0) || !(g.h > 0)) return null;
  const tondo = el.shape === "circle" || (el.type === "pcb_hole" && (el.hole_shape === "circle" || el.hole_shape === undefined) && Math.abs(g.w - g.h) < 1e-9);
  if (tondo) return forma([{ x: g.x, y: g.y }], g.w / 2 + cresci);
  return forma(angoli(g.x, g.y, g.w + 2 * cresci, g.h + 2 * cresci, g.rot));
}

/**
 * THE STANDARD SIZES OF CHIP RESISTORS AND CAPACITORS: imperial code, body
 * length and width (EIA nominal). A two-pad passive with no courtyard and no
 * body gets the body of the largest of these its pads can carry.
 */
const FORMATI: Array<{ nome: string; l: number; w: number }> = [
  { nome: "01005", l: 0.4, w: 0.2 },
  { nome: "0201", l: 0.6, w: 0.3 },
  { nome: "0402", l: 1.0, w: 0.5 },
  { nome: "0603", l: 1.6, w: 0.8 },
  { nome: "0805", l: 2.0, w: 1.25 },
  { nome: "1206", l: 3.2, w: 1.6 },
  { nome: "1210", l: 3.2, w: 2.5 },
  { nome: "1812", l: 4.5, w: 3.2 },
  { nome: "2010", l: 5.0, w: 2.5 },
  { nome: "2512", l: 6.3, w: 3.2 },
];

/** the passives whose body a standard size tells: inductors are not among them (a power inductor is not a chip) */
const PASSIVI = new Set(["simple_resistor", "simple_capacitor"]);

/**
 * Whether a part is a resistor or a capacitor: by its kind, or, for a part an
 * import marked as a generic chip (Altium marks everything simple_chip: the 24
 * resistors of tm-4l-q1), by its designator, R or C and a number.
 */
const ePassivo = (ftype: unknown, nome: string): boolean =>
  (typeof ftype === "string" && PASSIVI.has(ftype)) || (ftype === "simple_chip" && /^[RC]\d/i.test(nome));

/**
 * The body of a two-pad chip passive, from its pads: the largest standard size
 * whose body spans the gap between the pads (its terminals land on them), does
 * not run past their outer ends and is no wider than the pads by more than a
 * quarter of a millimetre. null when the part is not such a passive, or no size
 * fits.
 */
export function formatoDelPassivo(ftype: unknown, nome: string, pads: El[]): { nome: string; corpo: Punto[]; asse: number } | null {
  if (!ePassivo(ftype, nome)) return null;
  if (pads.length !== 2 || pads.some((p) => p.type !== "pcb_smtpad")) return null;
  const g = pads.map((p) => padGeometry(p));
  if (!g[0] || !g[1]) return null;
  const dx = g[1].x - g[0].x, dy = g[1].y - g[0].y;
  const d = Math.hypot(dx, dy);
  if (d < 0.05) return null;
  const ux = dx / d, uy = dy / d;
  /** a pad's extent along the axis between the two pads and across it */
  const estensione = (q: NonNullable<(typeof g)[0]>) => {
    const pts = angoli(q.x, q.y, q.w, q.h, q.rot);
    const lungo = pts.map((p) => p.x * ux + p.y * uy);
    const largo = pts.map((p) => -p.x * uy + p.y * ux);
    return { lungo: Math.max(...lungo) - Math.min(...lungo), largo: Math.max(...largo) - Math.min(...largo) };
  };
  const a = estensione(g[0]), b = estensione(g[1]);
  // two pads of one size, within a little (tm-4l-q1's C23 has one 0,1 mm longer)
  if (Math.abs(a.lungo - b.lungo) > 0.15 || Math.abs(a.largo - b.largo) > 0.15) return null;
  const lungo = (a.lungo + b.lungo) / 2, largo = (a.largo + b.largo) / 2;
  const esterno = d + lungo, gap = d - lungo;
  const adatti = FORMATI.filter((f) => gap <= f.l - 0.1 && f.l <= esterno + 0.02 && f.w <= largo + 0.25 && largo <= f.w + 1.2);
  if (adatti.length === 0) return null;
  const f = adatti.reduce((m, x) => (x.l * x.w > m.l * m.w ? x : m));
  const asse = (Math.atan2(uy, ux) * 180) / Math.PI;
  return { nome: f.nome, corpo: angoli((g[0].x + g[1].x) / 2, (g[0].y + g[1].y) / 2, f.l, f.w, asse), asse };
}

const tuttiGliAngoli = (pads: El[]): Punto[] =>
  pads.flatMap((p) => {
    const g = padGeometry(p);
    return g ? angoli(g.x, g.y, g.w, g.h, g.rot) : [];
  });

/** whether every point of a shape (grown by its radius) is inside one of the shapes given */
const coperta = (f: Forma, da: Forma[]): boolean =>
  f.punti.every((p) =>
    da.some((c) => {
      const bordo = distanzaDalBordo(p, c.punti);
      // how far inside the edge of c the point is, negative outside
      const dentroDi = (c.punti.length >= 3 && dentro(p.x, p.y, c.punti) ? bordo : -bordo) + c.r;
      return dentroDi >= f.r - 1e-9;
    }),
  );

function distanzaDalBordo(p: Punto, punti: Punto[]): number {
  let best = Infinity;
  for (const [a, b] of lati(punti)) best = Math.min(best, dSS(p, p, a, b).d);
  return best;
}

/** the sides of a polygon (closed), of a segment, or the point itself */
function lati(punti: Punto[]): Array<[Punto, Punto]> {
  if (punti.length === 1) return [[punti[0], punti[0]]];
  if (punti.length === 2) return [[punti[0], punti[1]]];
  return punti.map((p, i) => [p, punti[(i + 1) % punti.length]] as [Punto, Punto]);
}

/** the label that marks a mating space: "innesto", alone or followed by what goes in ("innesto: spina USB-C") */
const ETICHETTA_INNESTO = /^\s*innesto\b\s*[:\-–]?\s*(.*)$/i;

/**
 * THE MATING SPACE OF A CONNECTOR, declared inside its footprint with two notes
 * (they reach no copper, no silkscreen and no Gerber, the pours and the copper
 * checks do not read them, and they turn, flip and move with the part):
 *
 *   <pcbnotepath route={[{ x: -4.5, y: 3 }, { x: 4.5, y: 3 }, { x: 4.5, y: 12 }, { x: -4.5, y: 12 }]} strokeWidth={0.05} />
 *   <pcbnotetext text="innesto: spina USB-C" pcbX={0} pcbY={7} fontSize={0.6} />
 *
 * The path is the outline of the room the mating part takes above the face, in
 * the footprint's own coordinates like its pads (three points or more, closed
 * by itself); the text says it is a mating space, and what goes in. A closed
 * note path of the part that holds an "innesto" text is a mating space; when
 * the text is outside every path and the part has one closed path only, that
 * path is. Every other note stays a note.
 */
export function spaziDiInnesto(els: El[]): Map<string, Array<{ forma: Forma; descrizione: string | null }>> {
  const percorsi = new Map<string, Punto[][]>();
  const etichette = new Map<string, Array<{ p: Punto; descrizione: string | null }>>();
  for (const el of els) {
    const id = typeof el.pcb_component_id === "string" ? el.pcb_component_id : null;
    if (!id) continue;
    if (el.type === "pcb_note_path") {
      const punti = ((el.route as Array<{ x?: unknown; y?: unknown }> | undefined) ?? [])
        .map((q) => ({ x: fin(q?.x), y: fin(q?.y) }))
        .filter((q): q is Punto => q.x !== null && q.y !== null);
      if (punti.length > 1 && Math.hypot(punti[0].x - punti[punti.length - 1].x, punti[0].y - punti[punti.length - 1].y) < 1e-6) punti.pop();
      if (punti.length >= 3) percorsi.set(id, [...(percorsi.get(id) ?? []), punti]);
    } else if (el.type === "pcb_note_text") {
      const m = ETICHETTA_INNESTO.exec(String(el.text ?? ""));
      const a = el.anchor_position as { x?: unknown; y?: unknown } | undefined;
      const x = fin(a?.x), y = fin(a?.y);
      if (!m || x === null || y === null) continue;
      etichette.set(id, [...(etichette.get(id) ?? []), { p: { x, y }, descrizione: m[1].trim() || null }]);
    }
  }
  const out = new Map<string, Array<{ forma: Forma; descrizione: string | null }>>();
  for (const [id, testi] of etichette) {
    const tutti = percorsi.get(id) ?? [];
    const scelti: Array<{ forma: Forma; descrizione: string | null }> = [];
    for (const punti of tutti) {
      const t = testi.find((q) => dentro(q.p.x, q.p.y, punti));
      if (t) scelti.push({ forma: forma(punti), descrizione: t.descrizione });
    }
    if (scelti.length === 0 && tutti.length === 1) scelti.push({ forma: forma(tutti[0]), descrizione: testi[0].descrizione });
    if (scelti.length > 0) out.set(id, scelti);
  }
  return out;
}

/** a shape that encloses something: a circle or a pill with its radius, a polygon with an area */
function racchiude(f: Forma): boolean {
  if (f.r > 1e-9) return true;
  if (f.punti.length < 3) return false;
  let doppia = 0;
  for (let i = 0; i < f.punti.length; i++) {
    const a = f.punti[i], b = f.punti[(i + 1) % f.punti.length];
    doppia += a.x * b.y - b.x * a.y;
  }
  return Math.abs(doppia) / 2 > 1e-6;
}

/**
 * THE PARTS WHOSE FOOTPRINT IS NOT KNOWN: a part on the board (a
 * pcb_component with its source_component, not a via placed by hand) with no
 * pad, no courtyard that encloses something and no body, so leggiIngombri
 * gives it nothing. Never left out in silence: the check says them (a
 * warning), and they are not measured against anything.
 */
export function pezziSenzaIngombro(circuitJson: unknown[] | null | undefined, pezzi: Array<Pick<IngombroDelPezzo, "id">>): Array<{ id: string; nome: string; faccia: Faccia; centro: Punto }> {
  const els = (Array.isArray(circuitJson) ? circuitJson : []) as El[];
  const noti = new Set(pezzi.map((p) => p.id));
  const sorgenti = new Map<string, El>();
  for (const el of els) if (el.type === "source_component") sorgenti.set(String(el.source_component_id ?? ""), el);
  const out: Array<{ id: string; nome: string; faccia: Faccia; centro: Punto }> = [];
  for (const comp of els) {
    if (comp.type !== "pcb_component") continue;
    const id = String(comp.pcb_component_id ?? "");
    const sorgente = sorgenti.get(String(comp.source_component_id ?? ""));
    if (!sorgente || noti.has(id)) continue;
    const c = comp.center as { x?: unknown; y?: unknown } | undefined;
    out.push({ id, nome: String(sorgente.name ?? id), faccia: comp.layer === "bottom" ? "bottom" : "top", centro: { x: fin(c?.x) ?? 0, y: fin(c?.y) ?? 0 } });
  }
  return out;
}

/**
 * The footprint of every part on the board (see the top of this file).
 * `eccedenzaMm`: the project's componentCourtyardExcessMm.
 */
export function leggiIngombri(circuitJson: unknown[] | null | undefined, eccedenzaMm: number): IngombroDelPezzo[] {
  const els = (Array.isArray(circuitJson) ? circuitJson : []) as El[];
  const e = Number.isFinite(eccedenzaMm) && eccedenzaMm >= 0 ? eccedenzaMm : 0;
  const parti = footprintParts(els, { corpiDaiModelli: true });
  const sorgenti = new Map<string, El>();
  for (const el of els) if (el.type === "source_component") sorgenti.set(String(el.source_component_id ?? ""), el);
  const foriNudi = new Map<string, El[]>();
  for (const el of els) {
    if (el.type !== "pcb_hole" || typeof el.pcb_component_id !== "string") continue;
    foriNudi.set(el.pcb_component_id, [...(foriNudi.get(el.pcb_component_id) ?? []), el]);
  }
  const innesti = spaziDiInnesto(els);
  const out: IngombroDelPezzo[] = [];
  for (const comp of els) {
    if (comp.type !== "pcb_component") continue;
    const id = String(comp.pcb_component_id ?? "");
    // a part: a via placed by hand is a pcb_component with no source_component and no pads
    const sorgente = sorgenti.get(String(comp.source_component_id ?? ""));
    const parte = parti.get(id);
    if (!sorgente || !parte) continue;
    const pads = parte.pads;
    const faccia: Faccia =
      comp.layer === "bottom" ? "bottom" : comp.layer === "top" ? "top" : pads.length > 0 && pads.every((p) => p.layer === "bottom") ? "bottom" : "top";
    const giro = fin(comp.rotation) ?? parte.body?.rot ?? 0;
    const angoliPad = tuttiGliAngoli(pads);

    /*
     * Its declared courtyards that enclose something: one of zero width or of
     * two points is a line, not a courtyard, and taken as the footprint it
     * would leave the body out (the part would read as a segment and its pads).
     * With none left the footprint is computed, as for a part that declares none.
     */
    const cortili = parte.courtyards.map((c) => cortileDichiarato(c, giro)).filter((f): f is Forma => f !== null && racchiude(f));

    // the exact envelope: body and pads, in the part's frame
    let fonte: FonteIngombro;
    let formato: string | undefined;
    let involucro: Punto[];
    let corpoNoto = true;
    /** the frame the envelope is taken in: the part's, or the axis of a passive's two pads */
    let cornice = giro;
    const nome = String(sorgente.name ?? id);
    const dedotto = parte.body ? null : formatoDelPassivo(sorgente.ftype, nome, pads);
    if (parte.body) {
      involucro = scatolaOrientata([...angoliPad, ...angoli(parte.body.x, parte.body.y, parte.body.w, parte.body.h, parte.body.rot)], giro);
      fonte = "piazzole e corpo";
    } else if (dedotto) {
      cornice = dedotto.asse;
      involucro = scatolaOrientata([...angoliPad, ...dedotto.corpo], cornice);
      fonte = "piazzole e corpo dal formato";
      formato = dedotto.nome;
    } else if (angoliPad.length > 0) {
      involucro = scatolaOrientata(angoliPad, giro);
      fonte = "piazzole";
      corpoNoto = false;
    } else {
      // a courtyard and nothing else: the courtyard is all there is
      const pts = parte.courtyards.map(formaDelCortile).filter((f): f is Forma => f !== null && racchiude(f)).flatMap((f) => f.punti);
      if (pts.length === 0) continue;
      involucro = scatolaOrientata(pts, giro);
      fonte = "cortile";
      corpoNoto = false;
    }

    // the footprint: the declared courtyard as it is, or the envelope grown by the excess
    let forme: Forma[];
    if (cortili.length > 0) {
      fonte = "cortile";
      formato = undefined;
      // the pads that stick out of it (a crystal's) are footprint too, each with the excess
      const fuori = pads.map((p) => formaDelPad(p, e)).filter((f): f is Forma => f !== null && !coperta(f, cortili));
      forme = [...cortili, ...fuori];
    } else {
      forme = ingombroCalcolato(involucro, cornice, e);
    }
    if (forme.length === 0) continue;

    // a through-hole part on the other face: its holes and their rings
    const passanti = [...pads.filter((p) => p.type === "pcb_plated_hole"), ...(foriNudi.get(id) ?? [])];
    const fori = passanti.map((p) => formaDelPad(p, e)).filter((f): f is Forma => f !== null);
    const foriEsatti = passanti.map((p) => formaDelPad(p, 0)).filter((f): f is Forma => f !== null);

    const inv = forma(involucro);
    out.push({
      id,
      nome,
      faccia,
      fonte,
      ...(formato ? { formato } : {}),
      senzaCorpo: fonte === "piazzole" && !(pads.length === 1 && pads[0].type === "pcb_smtpad" && passanti.length === 0),
      forme,
      involucro: inv,
      corpoNoto,
      fori,
      foriEsatti,
      innesti: innesti.get(id) ?? [],
      centro: { x: (inv.box.minX + inv.box.maxX) / 2, y: (inv.box.minY + inv.box.maxY) / 2 },
    });
  }
  return out;
}

/** the gap between two boxes, a lower bound of the distance between what they hold */
export const distanzaRiquadri = (a: Riquadro, b: Riquadro): number => {
  const dx = Math.max(a.minX - b.maxX, b.minX - a.maxX, 0);
  const dy = Math.max(a.minY - b.maxY, b.minY - a.maxY, 0);
  return Math.hypot(dx, dy);
};

/** the convex hull of some points (monotone chain), counterclockwise */
function inviluppo(punti: Punto[]): Punto[] {
  const p = [...punti].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length <= 2) return p;
  const croce = (o: Punto, a: Punto, b: Punto) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const giu: Punto[] = [];
  for (const q of p) {
    while (giu.length >= 2 && croce(giu[giu.length - 2], giu[giu.length - 1], q) <= 0) giu.pop();
    giu.push(q);
  }
  const su: Punto[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (su.length >= 2 && croce(su[su.length - 2], su[su.length - 1], q) <= 0) su.pop();
    su.push(q);
  }
  return [...giu.slice(0, -1), ...su.slice(0, -1)];
}

/** the axes that separate two convex shapes, if anything does: the normals of their sides */
function normali(punti: Punto[]): Punto[] {
  const out: Punto[] = [];
  const h = punti.length >= 3 ? inviluppo(punti) : punti;
  for (const [a, b] of lati(h)) {
    const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy);
    if (l < 1e-12) continue;
    out.push({ x: -dy / l, y: dx / l });
    if (h.length === 2) out.push({ x: dx / l, y: dy / l });
  }
  return out;
}

/** twice the signed area of a polygon, counterclockwise positive */
function areaDoppia(punti: Punto[]): number {
  let d = 0;
  for (let i = 0; i < punti.length; i++) {
    const a = punti[i], b = punti[(i + 1) % punti.length];
    d += a.x * b.y - b.x * a.y;
  }
  return d;
}

/** whether a polygon turns always the same way (collinear points allowed) */
function convesso(punti: Punto[]): boolean {
  let segno = 0;
  const n = punti.length;
  for (let i = 0; i < n; i++) {
    const a = punti[i], b = punti[(i + 1) % n], c = punti[(i + 2) % n];
    const z = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(z) < 1e-12) continue;
    if (segno === 0) segno = Math.sign(z);
    else if (Math.sign(z) !== segno) return false;
  }
  return true;
}

/** the area a polygon shares with a convex one: the first clipped by each side of the second (Sutherland-Hodgman) */
function areaComune(soggetto: Punto[], convessoP: Punto[]): number {
  const verso = Math.sign(areaDoppia(convessoP)) || 1;
  const dentroDi = (p: Punto, a: Punto, b: Punto) => verso * ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) >= 0;
  const incrocio = (p: Punto, q: Punto, a: Punto, b: Punto): Punto => {
    const dx = q.x - p.x, dy = q.y - p.y, ex = b.x - a.x, ey = b.y - a.y;
    const den = dx * ey - dy * ex;
    const t = Math.abs(den) < 1e-15 ? 0 : ((a.x - p.x) * ey - (a.y - p.y) * ex) / den;
    return { x: p.x + t * dx, y: p.y + t * dy };
  };
  let out = soggetto;
  for (let i = 0; i < convessoP.length && out.length > 0; i++) {
    const a = convessoP[i], b = convessoP[(i + 1) % convessoP.length];
    const prima = out;
    out = [];
    for (let j = 0; j < prima.length; j++) {
      const p = prima[j], q = prima[(j + 1) % prima.length];
      const pd = dentroDi(p, a, b), qd = dentroDi(q, a, b);
      if (pd) out.push(p);
      if (pd !== qd) out.push(incrocio(p, q, a, b));
    }
  }
  return out.length >= 3 ? Math.abs(areaDoppia(out)) / 2 : 0;
}

export interface Misura {
  /** edge to edge, 0 when the two shapes touch or overlap */
  distanza: number;
  /** how deep they overlap (the shortest move that parts them), 0 when they do not */
  sovrapposizione: number;
  /** the point to mark: where they come nearest, or inside both */
  p: Punto;
}

/** how far apart two shapes are, or how deep they overlap */
export function misuraForme(a: Forma, b: Forma): Misura {
  let d = Infinity;
  let pa: Punto = a.punti[0];
  let pb: Punto = b.punti[0];
  for (const [a0, a1] of lati(a.punti)) {
    for (const [b0, b1] of lati(b.punti)) {
      const m = dSS(a0, a1, b0, b1);
      if (m.d < d) {
        d = m.d;
        pa = m.p;
        pb = dSS(b0, b1, a0, a1).p;
      }
    }
  }
  let dentroUno = false;
  if (d > 1e-12) {
    if (b.punti.length >= 3 && dentro(a.punti[0].x, a.punti[0].y, b.punti)) {
      dentroUno = true;
      pa = pb = a.punti[0];
    } else if (a.punti.length >= 3 && dentro(b.punti[0].x, b.punti[0].y, a.punti)) {
      dentroUno = true;
      pa = pb = b.punti[0];
    }
  }
  const nuclei = dentroUno ? 0 : d;
  const luce = nuclei - a.r - b.r;
  const p = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
  if (luce > 0) return { distanza: luce, sovrapposizione: 0, p };
  if (nuclei > 0) return { distanza: 0, sovrapposizione: -luce, p };
  /*
   * A concave outline (an L, a T) against a convex shape whose sides touch it:
   * on the hull of the L a part resting in its notch would overlap it deeply,
   * while the two only touch. The area they share decides whether the cores
   * overlap at all; when they do, the depth below is still taken on the hulls
   * and may come out larger than the true one (two concave outlines are
   * measured on their hulls as before).
   */
  if (a.punti.length >= 3 && b.punti.length >= 3) {
    const ca = convesso(a.punti), cb = convesso(b.punti);
    if (ca !== cb && areaComune(ca ? b.punti : a.punti, ca ? a.punti : b.punti) <= 1e-9) return { distanza: 0, sovrapposizione: a.r + b.r, p };
  }
  // the cores themselves overlap: the shortest move along a side's normal, on their hulls
  let minimo = Infinity;
  for (const n of [...normali(a.punti), ...normali(b.punti)]) {
    let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity;
    for (const q of a.punti) {
      const t = q.x * n.x + q.y * n.y;
      if (t < amin) amin = t;
      if (t > amax) amax = t;
    }
    for (const q of b.punti) {
      const t = q.x * n.x + q.y * n.y;
      if (t < bmin) bmin = t;
      if (t > bmax) bmax = t;
    }
    minimo = Math.min(minimo, Math.min(amax, bmax) - Math.max(amin, bmin));
  }
  const ib = {
    minX: Math.max(a.box.minX, b.box.minX),
    minY: Math.max(a.box.minY, b.box.minY),
    maxX: Math.min(a.box.maxX, b.box.maxX),
    maxY: Math.min(a.box.maxY, b.box.maxY),
  };
  return {
    distanza: 0,
    sovrapposizione: (Number.isFinite(minimo) ? Math.max(0, minimo) : 0) + a.r + b.r,
    p: ib.minX <= ib.maxX && ib.minY <= ib.maxY ? { x: (ib.minX + ib.maxX) / 2, y: (ib.minY + ib.maxY) / 2 } : p,
  };
}

/** the same between two lists of shapes: the deepest overlap, else the nearest distance */
export function misuraFra(as: Forma[], bs: Forma[], oltre = Infinity): Misura | null {
  let best: Misura | null = null;
  for (const a of as) {
    for (const b of bs) {
      const limite = best ? (best.sovrapposizione > 0 ? 0 : best.distanza) : oltre;
      if (distanzaRiquadri(a.box, b.box) > limite) continue;
      const m = misuraForme(a, b);
      if (!best || m.sovrapposizione > best.sovrapposizione || (best.sovrapposizione === 0 && m.sovrapposizione === 0 && m.distanza < best.distanza)) best = m;
    }
  }
  return best;
}

/** two footprints that overlap: they hit each other in assembly */
export interface Scontro {
  a: number;
  b: number;
  faccia: Faccia;
  /** the overlap of the footprints */
  sovrapposizione: number;
  p: Punto;
  /** the shapes measured: the part's own footprint or, on its other face, its holes */
  daiForiA: boolean;
  daiForiB: boolean;
}

/**
 * TWO FOOTPRINTS THAT ONLY TOUCH DO NOT HIT. An overlap no deeper than this
 * (the micron of slack of every dimensional comparison, as in drc.ts) is a
 * contact: the distance the two parts must keep is already inside their excess.
 * The one value of the check (component-clearance.ts), of the viewer, which
 * colours the same collisions red with scontri, and of the messages that say it.
 * tscircuit reports two courtyards that touch as overlapping: for every pair
 * this check measures, its word is this one (see cortiliAssorbiti).
 */
export const TOLLERANZA_INGOMBRI_MM = 0.001;

/**
 * Every pair of parts whose footprints overlap on one face, by more than
 * TOLLERANZA_INGOMBRI_MM. The index is the boxes sorted by x and swept, so
 * only parts whose boxes meet are measured.
 */
export function scontri(pezzi: Array<Pick<IngombroDelPezzo, "faccia" | "forme" | "fori">>): Scontro[] {
  const out: Scontro[] = [];
  for (const faccia of ["top", "bottom"] as Faccia[]) {
    const voci: Array<{ i: number; forme: Forma[]; box: Riquadro; daiFori: boolean }> = [];
    pezzi.forEach((p, i) => {
      const daiFori = p.faccia !== faccia;
      const forme = daiFori ? p.fori : p.forme;
      if (forme.length === 0) return;
      const box = forme.reduce<Riquadro>(
        (m, f) => ({ minX: Math.min(m.minX, f.box.minX), minY: Math.min(m.minY, f.box.minY), maxX: Math.max(m.maxX, f.box.maxX), maxY: Math.max(m.maxY, f.box.maxY) }),
        { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
      );
      voci.push({ i, forme, box, daiFori });
    });
    voci.sort((p, q) => p.box.minX - q.box.minX);
    for (let i = 0; i < voci.length; i++) {
      const v = voci[i];
      for (let j = i + 1; j < voci.length && voci[j].box.minX <= v.box.maxX; j++) {
        const w = voci[j];
        if (w.box.minY > v.box.maxY || v.box.minY > w.box.maxY) continue;
        // two through-hole parts meet on their own faces, not hole against hole
        if (v.daiFori && w.daiFori) continue;
        const m = misuraFra(v.forme, w.forme, 0);
        if (!m || m.sovrapposizione <= TOLLERANZA_INGOMBRI_MM) continue;
        const [a, b] = v.i < w.i ? [v, w] : [w, v];
        out.push({ a: a.i, b: b.i, faccia, sovrapposizione: m.sovrapposizione, p: m.p, daiForiA: a.daiFori, daiForiB: b.daiFori });
      }
    }
  }
  return out;
}

/**
 * The distance between the two parts of a pair, in words: between body and
 * pads when both bodies are known, otherwise which body is not known and no
 * number (a distance from the pads of a part whose body is only in its
 * courtyard would say a part under that body is clear). The overlap of the
 * footprints stays the number that counts. For the check's pairs
 * (component-clearance.ts) and the viewer's markers alike.
 */
export function distanzaDeiCorpi(s: { distanzaInvolucriMm: number | null; corpoNonNoto?: string[] }): string {
  if (s.distanzaInvolucriMm !== null && s.distanzaInvolucriMm !== undefined) return `corpo e piazzole a ${s.distanzaInvolucriMm.toFixed(3)}mm`;
  const ignoti = s.corpoNonNoto ?? [];
  return ignoti.length > 0 ? `corpo di ${ignoti.join(" e di ")} non noto (conta l'ingombro)` : "corpo non noto (conta l'ingombro)";
}

/**
 * A shape as an SVG path: a polygon, or a polygon grown by its radius (the
 * rounded ends of a pill, a circle), for the viewer.
 */
export function percorsoDellaForma(f: Forma): string {
  const n = (v: number) => Math.round(v * 10000) / 10000;
  if (f.r <= 0) {
    if (f.punti.length < 2) return "";
    return `${f.punti.map((p, i) => `${i === 0 ? "M" : "L"}${n(p.x)} ${n(p.y)}`).join(" ")} Z`;
  }
  if (f.punti.length === 1) {
    const { x, y } = f.punti[0];
    return `M${n(x - f.r)} ${n(y)} A${n(f.r)} ${n(f.r)} 0 1 0 ${n(x + f.r)} ${n(y)} A${n(f.r)} ${n(f.r)} 0 1 0 ${n(x - f.r)} ${n(y)} Z`;
  }
  // the hull grown by the radius: each side moved out, the corners turned round
  const h = f.punti.length >= 3 ? inviluppo(f.punti) : f.punti;
  const pezzi: string[] = [];
  const m = h.length;
  for (let i = 0; i < m; i++) {
    const a = h[i], b = h[(i + 1) % m];
    const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1;
    // outward on a counterclockwise hull (and on either side of a segment, taken once each way)
    const nx = dy / l, ny = -dx / l;
    const da = { x: a.x + nx * f.r, y: a.y + ny * f.r };
    const db = { x: b.x + nx * f.r, y: b.y + ny * f.r };
    pezzi.push(`${i === 0 ? "M" : "A" + n(f.r) + " " + n(f.r) + " 0 0 1"} ${n(da.x)} ${n(da.y)}`, `L${n(db.x)} ${n(db.y)}`);
  }
  // back to the start round the first corner
  const a = h[0], b = h[1 % m];
  const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1;
  pezzi.push(`A${n(f.r)} ${n(f.r)} 0 0 1 ${n(a.x + (dy / l) * f.r)} ${n(a.y + (-dx / l) * f.r)}`, "Z");
  return pezzi.join(" ");
}
