/**
 * PARTS THAT HIT EACH OTHER IN ASSEMBLY, AND FOOTPRINTS THAT ARE NOT REAL.
 *
 * Niccolo', 11/11/2026, looking at two boards in the viewer: "ogni pezzo ha il
 * suo INGOMBRO, e' fondamentale per progettare, altrimenti stiamo facendo cose
 * a caso, e non si salda nulla". Three facts behind it, with every check green:
 * - on sbb-dl-principale 26 pairs of parts had pads closer than 0,30 mm (two
 *   resistors at 0,08): the placement check fails a pair only when copper of
 *   two different nets is under the copper clearance, the DRC measures copper;
 * - distances were taken from the pads, not from the body: an LGA module of
 *   22,5 x 26,5 mm read 19,3 x 23,0, and a capacitor 0,25 mm from its body was
 *   "clear";
 * - outlines and designators written as drawings of the BOARD, at fixed
 *   coordinates: a part dragged in the viewer left its outline behind.
 *
 * Three checks over the footprints of ingombro.ts (the declared courtyard as it
 * is, or the exact envelope of body and pads grown by componentCourtyardExcessMm),
 * each face on its own, on every compile and every "Ricontrolla":
 *
 * A. PARTS THAT HIT (an ERROR): two footprints that overlap on one face, by
 *    more than TOLLERANZA_INGOMBRI_MM (ingombro.ts). No threshold on top of the
 *    excess: the excess IS the distance two parts keep, so two footprints that
 *    only touch do not hit. One report per pair, where they overlap most, with
 *    the overlap and the distance between the two exact envelopes; a
 *    through-hole part meets the other face with its holes.
 *    tscircuit's own pcb_courtyard_overlap_error says the opposite on a contact
 *    (two courtyards that touch overlap, for it): on n59 seven pairs stayed
 *    among the errors and in the report's row while the viewer drew them clear.
 *    For every pair of parts this check MEASURES (both have a footprint) its
 *    word is the one that counts, and tscircuit's error is absorbed whether the
 *    pair hits here or not (cortiliAssorbiti; the element stays in the Circuit
 *    JSON). It stays an error only for a pair this check could not measure: a
 *    part with no footprint it can read, or a check that stopped.
 *    It is an error like pad_clearance and like tscircuit's courtyard errors:
 *    the compile is not ok, the board is not ready (the report's red row,
 *    targets.courtyardCollisions, targets.allGreen). Like
 *    them it does not stop the export, which refuses only what the screen does
 *    not show (a plane over a via, two pours touching, pours of an old engine):
 *    a collision is on the board for everyone to see, and a prototype with a
 *    tight pair placed on purpose can still be ordered.
 *
 * B. PARTS WITH NO REAL FOOTPRINT (a warning): a part with no courtyard and no
 *    body, whose footprint is the envelope of its pads alone. A two-pad
 *    resistor or capacitor of a standard size is not among them: its body is
 *    the size's (see formatoDelPassivo). Everything else (modules, ICs,
 *    connectors, inductors, buttons, microphones) is listed by designator.
 *
 * D. PARTS IN A CONNECTOR'S MATING SPACE (a warning): a connector may declare,
 *    inside its footprint, the room the part that goes into it takes (a plug
 *    and its cable, a board, a tool: see spaziDiInnesto in ingombro.ts). Every
 *    other part of its face whose footprint enters that room is listed: "X sta
 *    dove si infila la spina di J2". The room does not grow the connector's
 *    footprint, so it is not in A.
 *
 * C. BOARD DRAWINGS THAT BELONG TO A PART (a warning): silkscreen with no part
 *    (no pcb_component_id) drawn around or next to ONE part: its outline or its
 *    designator written at board level, which does not follow the part when it
 *    moves. The heuristic, declared:
 *    - the board's silkscreen is grouped into drawings: elements whose boxes
 *      come within UNISCI_MM of each other (the strokes of one outline touch,
 *      the letters of a word written as strokes stand 0,13 mm apart);
 *    - a drawing is AN OUTLINE of a part when its box holds the centre of the
 *      part's footprint and stays within the footprint grown by
 *      max(ATTORNO_MM, a quarter of its size), for that part only;
 *    - a small drawing (DESIGNATOR_MAX_MM long, DESIGNATOR_ALTO_MM high at most)
 *      is A DESIGNATOR of a part when it comes within VICINO_MM of that
 *      part's footprint and no other part is within ESCLUSIVO_MM of it;
 *    - anything else does not count: logos, big writings, frames, drawings
 *      over several parts, a label between two parts.
 *    Expected misses: a designator crowded between two parts, an outline
 *    drawn joined to a neighbour's. Expected false reports: a board label
 *    (a pin name, "VBAT") next to a single connector.
 */

import { dalGerber } from "./silkscreen-clearance";
import { distanzaDeiCorpi, leggiIngombri, misuraFra, scontri, TOLLERANZA_INGOMBRI_MM, type Faccia, type IngombroDelPezzo, type Punto, type Riquadro } from "./ingombro";

type El = Record<string, unknown> & { type: string };

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const tre = (v: number) => Math.round(v * 1000) / 1000;

/** two parts that hit each other in assembly */
export interface PezziCheSiScontrano {
  a: string;
  b: string;
  faccia: Faccia;
  /** where the two footprints overlap most */
  x: number;
  y: number;
  /** how deep the footprints overlap: the shortest move that parts them */
  sovrapposizioneMm: number;
  /**
   * Edge to edge between the two exact envelopes (body and pads, no excess); 0
   * when they touch or overlap. null when the body of one of the two is not
   * known (corpoNonNoto): its envelope is its pads alone, and a distance from
   * its pads says nothing of its body (C41 under the body of J3, whose body is
   * only in its courtyard, read "2,187 mm" away).
   */
  distanzaInvolucriMm: number | null;
  /** the parts of the pair whose body is not known (see IngombroDelPezzo.corpoNoto) */
  corpoNonNoto?: string[];
  /** the project's componentCourtyardExcessMm, on the footprints PCB Studio computed */
  eccedenzaMm: number;
  /** what each footprint is: "cortile", "piazzole e corpo", "piazzole e corpo dal formato 0402", "piazzole", "fori di un pezzo passante" */
  fonteA: string;
  fonteB: string;
}

/** a part whose footprint is its pads alone */
export interface PezzoSenzaIngombro {
  pezzo: string;
  faccia: Faccia;
  x: number;
  y: number;
}

/** a part whose outline or designator is a drawing of the board */
export interface DisegnoDiScheda {
  pezzo: string;
  faccia: Faccia;
  tipo: "contorno" | "sigla" | "contorno e sigla";
  /** how many drawings of the board are its */
  disegni: number;
  /** the first of them */
  x: number;
  y: number;
}

/** a part standing where the mating part of a connector goes in */
export interface NelloSpazioDiInnesto {
  pezzo: string;
  connettore: string;
  faccia: Faccia;
  /** what goes in, as the footprint says it ("spina USB-C"), when it does */
  descrizione: string | null;
  /** how deep the part's footprint enters the mating space */
  sovrapposizioneMm: number;
  x: number;
  y: number;
}

/** what the summary says about the footprints (CompileSummary.courtyards) */
export interface IngombriDeiPezzi {
  /** A: every pair that hits, the unlisted ones included */
  count: number;
  /** the project's componentCourtyardExcessMm */
  eccedenzaMm: number;
  /** A is an error: the board is not ready (it does not stop the export) */
  severity: "error";
  /** the fact in words: the worst pair by name, else the warnings */
  detail: string;
  /** the deepest ELENCATI pairs, deepest first */
  scontri: PezziCheSiScontrano[];
  /** B, a warning */
  senzaIngombroVero: { count: number; pezzi: PezzoSenzaIngombro[]; detail: string };
  /** the passives whose body was deduced from their standard size */
  dedottiDalFormato: number;
  /** D, a warning: parts whose footprint enters a connector's mating space (see spaziDiInnesto in ingombro.ts) */
  nelloSpazioDiInnesto?: { count: number; pezzi: NelloSpazioDiInnesto[]; detail: string };
  /** C, a warning; with how many of the board's silkscreen elements are drawings of the board */
  disegniDiScheda: { count: number; pezzi: DisegnoDiScheda[]; detail: string; elementiDiScheda?: number; elementi?: number };
  /** the check itself stopped: the footprints were NOT measured, and why. Absent when they were */
  nonMisurati?: string;
}

/** what is listed of each family; the counts are not capped */
const ELENCATI = 100;
/** two silkscreen elements whose boxes come this close are one drawing */
const UNISCI_MM = 0.15;
/** how far an outline may stand out of the footprint, at least */
const ATTORNO_MM = 1.0;
/** a designator this close to a part's footprint... */
const VICINO_MM = 0.8;
/** ...and no other part this close to it */
const ESCLUSIVO_MM = 1.6;
/** the longest side of a designator, and its shorter one */
const DESIGNATOR_MAX_MM = 4;
const DESIGNATOR_ALTO_MM = 2;
/** a stroke no longer than this is the size of a glyph */
const LETTERA_MM = 1.2;

const fonteDi = (p: IngombroDelPezzo, daiFori: boolean): string =>
  daiFori ? "fori di un pezzo passante" : p.fonte === "piazzole e corpo dal formato" ? `${p.fonte} ${p.formato ?? ""}`.trim() : p.fonte;

/** the key of a pair of parts, whichever comes first */
const chiaveDellaCoppia = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** natural order of designators: C2 before C10 */
const perNome = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });

/** what C found: the parts, and how much of the board's silkscreen is drawn at board level */
interface DisegniTrovati {
  pezzi: DisegnoDiScheda[];
  /** silkscreen elements on the board */
  elementi: number;
  /** of which drawings of the board (no pcb_component_id) */
  diScheda: number;
}

/**
 * C. The board's silkscreen drawings that belong to one part (see the top of
 * this file), one entry per part.
 */
function disegniDellaScheda(els: El[], pezzi: IngombroDelPezzo[]): DisegniTrovati {
  // the elements of the board's silkscreen, each as its box
  const unita: Array<{ faccia: Faccia; box: Riquadro; testo: boolean }> = [];
  let elementi = 0;
  let diScheda = 0;
  for (const el of els) {
    if (!el.type.startsWith("pcb_silkscreen_")) continue;
    elementi++;
    if (el.pcb_component_id) continue;
    diScheda++;
    const faccia: Faccia | null = el.layer === "top" ? "top" : el.layer === "bottom" ? "bottom" : null;
    if (!faccia) continue;
    let punti: Punto[];
    let h: number;
    if (el.type === "pcb_silkscreen_path") {
      punti = ((el.route as Array<{ x?: unknown; y?: unknown }> | undefined) ?? [])
        .map((p) => ({ x: num(p?.x), y: num(p?.y) }))
        .filter((p): p is Punto => p.x !== null && p.y !== null);
      h = (num(el.stroke_width) ?? 0.1) / 2;
    } else {
      // every other kind, as the Gerber writes it (silkscreen-clearance.ts)
      const g = dalGerber(el, faccia);
      punti = [...g.segmenti.flat(), ...g.regioni.flat()];
      h = el.type === "pcb_silkscreen_text" ? (num(el.font_size) ?? 0) / 16 : (num(el.stroke_width) ?? 0.1) / 2;
    }
    if (punti.length === 0) continue;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of punti) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    unita.push({ faccia, box: { minX: minX - h, minY: minY - h, maxX: maxX + h, maxY: maxY + h }, testo: el.type === "pcb_silkscreen_text" });
  }
  if (unita.length === 0) return { pezzi: [], elementi, diScheda };

  // the drawings: elements whose boxes come within UNISCI_MM, swept by x
  const padre = unita.map((_, i) => i);
  const trova = (i: number): number => {
    while (padre[i] !== i) {
      padre[i] = padre[padre[i]];
      i = padre[i];
    }
    return i;
  };
  const ordine = unita.map((_, i) => i).sort((a, b) => unita[a].box.minX - unita[b].box.minX);
  for (let k = 0; k < ordine.length; k++) {
    const u = unita[ordine[k]];
    for (let q = k + 1; q < ordine.length && unita[ordine[q]].box.minX <= u.box.maxX + UNISCI_MM; q++) {
      const v = unita[ordine[q]];
      if (v.faccia !== u.faccia) continue;
      if (v.box.minY > u.box.maxY + UNISCI_MM || u.box.minY > v.box.maxY + UNISCI_MM) continue;
      const ra = trova(ordine[k]), rb = trova(ordine[q]);
      if (ra !== rb) padre[ra] = rb;
    }
  }
  /** a drawing: its box, whether it holds a text, how many elements and how many of them are glyph-sized */
  const disegni = new Map<number, { faccia: Faccia; box: Riquadro; testo: boolean; n: number; lettere: number }>();
  unita.forEach((u, i) => {
    const r = trova(i);
    const lettera = Math.max(u.box.maxX - u.box.minX, u.box.maxY - u.box.minY) <= LETTERA_MM ? 1 : 0;
    const d = disegni.get(r);
    if (!d) disegni.set(r, { faccia: u.faccia, box: { ...u.box }, testo: u.testo, n: 1, lettere: lettera });
    else {
      d.box.minX = Math.min(d.box.minX, u.box.minX);
      d.box.minY = Math.min(d.box.minY, u.box.minY);
      d.box.maxX = Math.max(d.box.maxX, u.box.maxX);
      d.box.maxY = Math.max(d.box.maxY, u.box.maxY);
      d.testo = d.testo || u.testo;
      d.n++;
      d.lettere += lettera;
    }
  });

  // each part's footprint on its own face, as a box
  const riquadri = pezzi.map((p) =>
    p.forme.reduce<Riquadro>(
      (m, f) => ({ minX: Math.min(m.minX, f.box.minX), minY: Math.min(m.minY, f.box.minY), maxX: Math.max(m.maxX, f.box.maxX), maxY: Math.max(m.maxY, f.box.maxY) }),
      { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
    ),
  );
  const luce = (a: Riquadro, b: Riquadro) => Math.hypot(Math.max(a.minX - b.maxX, b.minX - a.maxX, 0), Math.max(a.minY - b.maxY, b.minY - a.maxY, 0));

  const perPezzo = new Map<number, { contorno: number; sigla: number; x: number; y: number }>();
  for (const d of disegni.values()) {
    const B = d.box;
    const bw = B.maxX - B.minX, bh = B.maxY - B.minY;
    const attorno: number[] = [];
    const vicini: number[] = [];
    pezzi.forEach((p, i) => {
      if (p.faccia !== d.faccia) return;
      const I = riquadri[i];
      const cx = (I.minX + I.maxX) / 2, cy = (I.minY + I.maxY) / 2;
      const m = Math.max(ATTORNO_MM, 0.25 * Math.max(I.maxX - I.minX, I.maxY - I.minY));
      if (B.minX <= cx && cx <= B.maxX && B.minY <= cy && cy <= B.maxY && B.minX >= I.minX - m && B.maxX <= I.maxX + m && B.minY >= I.minY - m && B.maxY <= I.maxY + m) {
        attorno.push(i);
      }
      if (luce(B, I) <= ESCLUSIVO_MM) vicini.push(i);
    });
    let di: number | null = null;
    if (attorno.length === 1) di = attorno[0];
    else if (attorno.length === 0 && Math.max(bw, bh) <= DESIGNATOR_MAX_MM && Math.min(bw, bh) <= DESIGNATOR_ALTO_MM) {
      // next to one part only: its designator, or a piece of its outline
      if (vicini.length === 1 && luce(B, riquadri[vicini[0]]) <= VICINO_MM) di = vicini[0];
    }
    if (di === null) continue;
    // writing: a text, or two or more glyph-sized strokes; anything else is outline
    const tipo: "contorno" | "sigla" = d.testo || (d.n >= 2 && d.lettere === d.n) ? "sigla" : "contorno";
    const voce = perPezzo.get(di) ?? { contorno: 0, sigla: 0, x: (B.minX + B.maxX) / 2, y: (B.minY + B.maxY) / 2 };
    voce[tipo]++;
    perPezzo.set(di, voce);
  }
  return {
    pezzi: [...perPezzo.entries()]
      .map(([i, v]) => ({
        pezzo: pezzi[i].nome,
        faccia: pezzi[i].faccia,
        tipo: (v.contorno > 0 && v.sigla > 0 ? "contorno e sigla" : v.contorno > 0 ? "contorno" : "sigla") as DisegnoDiScheda["tipo"],
        disegni: v.contorno + v.sigla,
        x: tre(v.x),
        y: tre(v.y),
      }))
      .sort((a, b) => perNome(a.pezzo, b.pezzo)),
    elementi,
    diScheda,
  };
}

export interface MisuraDegliIngombri {
  scontri: PezziCheSiScontrano[];
  senzaIngombroVero: PezzoSenzaIngombro[];
  dedottiDalFormato: number;
  disegniDiScheda: DisegnoDiScheda[];
  nelloSpazioDiInnesto: NelloSpazioDiInnesto[];
  /** the board's silkscreen elements, and how many are drawings of the board */
  elementiDiSilkscreen: number;
  elementiDiScheda: number;
  /**
   * The pairs of tscircuit's pcb_courtyard_overlap_error that A measured, by
   * chiaveDellaCoppia of their pcb_component_ids: A's word counts for them,
   * hit or not (see the top of this file)
   */
  cortiliAssorbiti: string[];
}

/**
 * The pairs of tscircuit's courtyard errors whose two parts both have a
 * footprint A measures: their error is absorbed (see the top of this file).
 */
export function cortiliAssorbiti(els: Array<{ type?: unknown; pcb_component_ids?: unknown }>, pezzi: Array<Pick<IngombroDelPezzo, "id">>): string[] {
  const misurati = new Set(pezzi.map((p) => p.id));
  const out: string[] = [];
  for (const el of els) {
    if (el.type !== "pcb_courtyard_overlap_error") continue;
    const ids = Array.isArray(el.pcb_component_ids) ? el.pcb_component_ids.map(String) : [];
    if (ids.length === 2 && misurati.has(ids[0]) && misurati.has(ids[1])) out.push(chiaveDellaCoppia(ids[0], ids[1]));
  }
  return out;
}

/** the three checks (see the top of this file); throws on a Circuit JSON it cannot read */
export function misuraIngombri(circuitJson: unknown[], eccedenzaMm: number): MisuraDegliIngombri {
  const els = (Array.isArray(circuitJson) ? circuitJson : []) as El[];
  const e = Number.isFinite(eccedenzaMm) && eccedenzaMm >= 0 ? eccedenzaMm : 0;
  const pezzi = leggiIngombri(els, e);

  // A
  const trovati: PezziCheSiScontrano[] = scontri(pezzi).map((s) => {
    const A = pezzi[s.a], B = pezzi[s.b];
    const esatta = misuraFra(s.daiForiA ? A.foriEsatti : [A.involucro], s.daiForiB ? B.foriEsatti : [B.involucro]);
    // holes on the other face are exact; a part's own envelope is, when its body is known
    const ignoti = [...(s.daiForiA || A.corpoNoto ? [] : [A.nome]), ...(s.daiForiB || B.corpoNoto ? [] : [B.nome])];
    return {
      a: A.nome,
      b: B.nome,
      faccia: s.faccia,
      x: tre(s.p.x),
      y: tre(s.p.y),
      sovrapposizioneMm: tre(s.sovrapposizione),
      distanzaInvolucriMm: ignoti.length > 0 ? null : tre(esatta ? esatta.distanza : 0),
      ...(ignoti.length > 0 ? { corpoNonNoto: ignoti } : {}),
      eccedenzaMm: e,
      fonteA: fonteDi(A, s.daiForiA),
      fonteB: fonteDi(B, s.daiForiB),
    };
  });
  trovati.sort((p, q) => q.sovrapposizioneMm - p.sovrapposizioneMm || perNome(p.a, q.a));

  // B
  const senzaIngombroVero = pezzi
    .filter((p) => p.senzaCorpo)
    .map((p) => ({ pezzo: p.nome, faccia: p.faccia, x: tre(p.centro.x), y: tre(p.centro.y) }))
    .sort((a, b) => perNome(a.pezzo, b.pezzo));

  // D: the parts of a connector's face that enter its mating space
  const nelloSpazioDiInnesto: NelloSpazioDiInnesto[] = [];
  for (const conn of pezzi) {
    for (const innesto of conn.innesti) {
      for (const p of pezzi) {
        if (p === conn || p.faccia !== conn.faccia) continue;
        const m = misuraFra(p.forme, [innesto.forma], 0);
        if (!m || m.sovrapposizione <= TOLLERANZA_INGOMBRI_MM) continue;
        nelloSpazioDiInnesto.push({
          pezzo: p.nome,
          connettore: conn.nome,
          faccia: conn.faccia,
          descrizione: innesto.descrizione,
          sovrapposizioneMm: tre(m.sovrapposizione),
          x: tre(m.p.x),
          y: tre(m.p.y),
        });
      }
    }
  }
  nelloSpazioDiInnesto.sort((a, b) => perNome(a.connettore, b.connettore) || perNome(a.pezzo, b.pezzo));

  const c = disegniDellaScheda(els, pezzi);
  return {
    scontri: trovati,
    senzaIngombroVero,
    dedottiDalFormato: pezzi.filter((p) => p.fonte === "piazzole e corpo dal formato").length,
    disegniDiScheda: c.pezzi,
    nelloSpazioDiInnesto,
    elementiDiSilkscreen: c.elementi,
    elementiDiScheda: c.diScheda,
    cortiliAssorbiti: cortiliAssorbiti(els, pezzi),
  };
}

/** what the summary says, and what compile.ts needs to leave tscircuit's errors A measured out of the errors */
export interface EsitoDegliIngombri {
  /** absent when there is nothing to say */
  riepilogo: IngombriDeiPezzi | undefined;
  /** see MisuraDegliIngombri.cortiliAssorbiti: also when A has nothing to say (two courtyards that only touch) */
  cortiliAssorbiti: string[];
}

const elenco = (nomi: string[], quanti = 12) => `${nomi.slice(0, quanti).join(", ")}${nomi.length > quanti ? `, e altri ${nomi.length - quanti}` : ""}`;

/** the same for the summary; never throws: a check that stops says so */
export function ingombriDeiPezzi(circuitJson: unknown[], eccedenzaMm: number): EsitoDegliIngombri {
  let m: MisuraDegliIngombri;
  try {
    m = misuraIngombri(circuitJson, eccedenzaMm);
  } catch (err) {
    /*
     * A check never takes the compile down with it, and a board whose
     * footprints were not measured does not read as one where none hit.
     */
    const perche = (err instanceof Error ? err.message : String(err)).slice(0, 160);
    console.error(`[ingombri] controllo non riuscito: ${perche}`);
    return {
      riepilogo: {
        count: 0,
        eccedenzaMm,
        severity: "error",
        detail: `gli ingombri dei pezzi NON sono stati misurati: il controllo si e' fermato (${perche})`,
        scontri: [],
        senzaIngombroVero: { count: 0, pezzi: [], detail: "" },
        dedottiDalFormato: 0,
        disegniDiScheda: { count: 0, pezzi: [], detail: "" },
        nonMisurati: perche,
      },
      // nothing measured: every error of tscircuit stays
      cortiliAssorbiti: [],
    };
  }
  const n = m.scontri.length, b = m.senzaIngombroVero.length, c = m.disegniDiScheda.length, d = m.nelloSpazioDiInnesto.length;
  if (n === 0 && b === 0 && c === 0 && d === 0) return { riepilogo: undefined, cortiliAssorbiti: m.cortiliAssorbiti };
  const primo = m.scontri[0];
  const dettaglioA = primo
    ? `${n} ${n === 1 ? "coppia di pezzi si scontra" : "coppie di pezzi si scontrano"} in assemblaggio ` +
      `(ingombri sovrapposti sulla stessa faccia di piu' di ${TOLLERANZA_INGOMBRI_MM}mm, abbondanza ${eccedenzaMm}mm): ` +
      `${primo.a} e ${primo.b} su ${primo.faccia}, ingombri sovrapposti di ${primo.sovrapposizioneMm.toFixed(3)}mm, ` +
      `${distanzaDeiCorpi(primo)}, a (${primo.x.toFixed(2)}; ${primo.y.toFixed(2)})`
    : "";
  const dettaglioB = b
    ? `${b} ${b === 1 ? "pezzo" : "pezzi"} senza ingombro vero (${elenco(m.senzaIngombroVero.map((p) => p.pezzo))}): ingombro ricavato dalle sole piazzole, metti nel footprint il corpo vero (cortile)`
    : "";
  const dettaglioD = d
    ? `${d} ${d === 1 ? "pezzo sta" : "pezzi stanno"} dove si infila la parte che entra in un connettore: ` +
      elenco(m.nelloSpazioDiInnesto.map((q) => `${q.pezzo} sta dove si infila ${q.descrizione ? q.descrizione : "la spina"} di ${q.connettore}`), 6)
    : "";
  const dettaglioC = c
    ? `${c} ${c === 1 ? "pezzo ha" : "pezzi hanno"} il contorno o la sigla scritti come disegno di scheda (${elenco(m.disegniDiScheda.map((p) => p.pezzo))}): non seguono il pezzo quando lo sposti ` +
      `(${m.elementiDiScheda} elementi di silkscreen su ${m.elementiDiSilkscreen} sono disegni di scheda)`
    : "";
  return {
    riepilogo: {
      count: n,
      eccedenzaMm,
      severity: "error",
      detail: dettaglioA || [dettaglioD, dettaglioB, dettaglioC].filter(Boolean).join("; "),
      scontri: m.scontri.slice(0, ELENCATI),
      senzaIngombroVero: { count: b, pezzi: m.senzaIngombroVero.slice(0, ELENCATI), detail: dettaglioB },
      dedottiDalFormato: m.dedottiDalFormato,
      ...(d > 0 ? { nelloSpazioDiInnesto: { count: d, pezzi: m.nelloSpazioDiInnesto.slice(0, ELENCATI), detail: dettaglioD } } : {}),
      disegniDiScheda: { count: c, pezzi: m.disegniDiScheda.slice(0, ELENCATI), detail: dettaglioC, elementiDiScheda: m.elementiDiScheda, elementi: m.elementiDiSilkscreen },
    },
    cortiliAssorbiti: m.cortiliAssorbiti,
  };
}

/** whether one of tscircuit's errors is a pair A measured, so its word counts (see EsitoDegliIngombri) */
export function cortileAssorbito(el: { type?: unknown; pcb_component_ids?: unknown }, assorbiti: readonly string[]): boolean {
  if (el.type !== "pcb_courtyard_overlap_error" || assorbiti.length === 0) return false;
  const ids = Array.isArray(el.pcb_component_ids) ? el.pcb_component_ids.map(String) : [];
  return ids.length === 2 && assorbiti.includes(chiaveDellaCoppia(ids[0], ids[1]));
}

/** what the compile message says of it */
export function testoIngombri(r: IngombriDeiPezzi | undefined): string {
  if (!r) return "";
  if (r.nonMisurati !== undefined) return ` ATTENZIONE: ${r.detail}.`;
  const parti: string[] = [];
  if (r.count > 0) {
    const primo = r.scontri[0];
    parti.push(
      ` ERRORE ingombri dei pezzi (la scheda non e' pronta, l'export resta possibile): ${r.count} ${r.count === 1 ? "coppia di pezzi si scontra" : "coppie di pezzi si scontrano"} in assemblaggio` +
        (primo ? `, la peggiore ${primo.a} e ${primo.b} su ${primo.faccia} (ingombri sovrapposti di ${primo.sovrapposizioneMm.toFixed(3)}mm)` : "") +
        ".",
    );
  }
  if (r.nelloSpazioDiInnesto && r.nelloSpazioDiInnesto.count > 0) parti.push(` AVVISO ingombri: ${r.nelloSpazioDiInnesto.detail}.`);
  if (r.senzaIngombroVero.count > 0) parti.push(` AVVISO ingombri: ${r.senzaIngombroVero.detail}.`);
  if (r.disegniDiScheda.count > 0) parti.push(` AVVISO ingombri: ${r.disegniDiScheda.detail}.`);
  return parti.join("");
}
