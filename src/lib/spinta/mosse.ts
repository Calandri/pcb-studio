/**
 * THE TWO ELEMENTARY MOVES of "spingi e sposta", with nothing pushed: what the
 * copper under the mouse does, and what stops it. The chain of pushes on the
 * traces around (risolutore.ts, a later phase) is made of these.
 *
 * MOVE 1, A STRETCH SLIDES SIDEWAYS (traslaTratto). A stretch has a direction
 * (0, 45, 90 or 135 degrees) and so a support line. Moving it is moving that
 * line along its normal: the two stretches next to it get longer or shorter,
 * the corners are where the lines cross. No direction changes, so every angle
 * of the trace is the one it had.
 *
 * MOVE 2, A VIA MOVES (spostaVia). On every trace that stands in the via the
 * stretch that reaches it is drawn again with at most two legs: the first in
 * the direction it had, the second turned by 45 degrees toward the via, or
 * absent. A via is a hole through the board: its traces on every layer follow.
 *
 * EVERY CORNER IS ON THE GRID BY CONSTRUCTION. Corners are worked out on whole
 * tenths of a micron (geometria.ts). Two lines at 45 degrees cross on the grid
 * only every second step, so a diagonal stretch between diagonal neighbours
 * moves by two steps at a time: no corner is ever rounded, which would bend
 * the two stretches that meet in it. Hand copper (a route of manual-edits.json
 * that is not a correction) is read from the file to the micron: when a move
 * touches any, its steps are ten times as long, and every corner falls on
 * whole microns the same way.
 *
 * TRACES CHAINED END TO END ARE ONE RUN OF COPPER. Where a trace ends on the
 * end of one other trace (the routes of an imported net are written like
 * this), that stretch of the other is the neighbour of its last stretch, as
 * the next stretch of its own would be: it gets longer or shorter, and its
 * trace is among the copper the move gives back.
 *
 * BLOCKED is an answer, not an error: the move is not made, the model is not
 * touched, and what blocks is named (which pad, which hole, the edge, which
 * trace and where). Every move starts from the model as it was when the
 * gesture began: nothing accumulates, and going back is free.
 *
 * THE DISTANCE KEPT from the copper of other nets is the one the project draws
 * at (`targetClearanceMm`), and never less than the minimum the check asks for
 * that pair of things (distanzaMinimaFra). Copper that was already nearer than
 * that when the gesture began may stay as near as it was, not nearer: a trace
 * drawn at the factory minimum under a fine-pitch part can still be taken, and
 * no move adds a violation to the ones the board has.
 *
 * Pure and deterministic: the same model and the same move give the same
 * answer. No React, nothing of the server.
 */
import { distanzaMinimaFra, type TipoRame } from "../design-rules";
import { ingombroForma } from "../drc";
import { CONTATTO_MM } from "../gruppi-di-rame";
import { ROUTE_LIMITS, type ManualRoutePoint } from "../manual-routes";
import {
  avanti,
  dentroPoligono,
  distanzaPuntoSegmento,
  distanzaSegmentoForma,
  distanzaSegmentoZona,
  distanzaSegmenti,
  eDiagonale,
  incrocio,
  inMm,
  inUnita,
  passiLungo,
  passoDiTraslazione,
  passoMm,
  piedeSulSegmento,
  prodotto,
  puntoVicino,
  rettaDi,
  traslata,
  UNITA_PER_MM,
  type Direzione,
  type Punto,
} from "./geometria";
import {
  capiDelTratto,
  stessaRete,
  type Modello,
  type PadDelModello,
  type PistaDelModello,
  type Tenuta,
  type TenutaDellaVia,
  type TrattoDelModello,
  type ViaDelModello,
} from "./modello";

/** why a move is not made */
export type MotivoDelBlocco =
  /** a pad of another net, nearer than the distance to keep; or a pad of its own net a trace would enter askew */
  | "pad"
  /** a hole: the copper or the drill of a plated one, a bare one */
  | "foro"
  /** a via: its ring, or its drill */
  | "via"
  /** the outline of the board, or a cutout in it */
  | "bordo"
  | "keepout"
  /** a trace of another net nearer than the distance to keep (nothing is pushed here) */
  | "pista"
  /** a stretch would shrink to nothing */
  | "tratto_sparirebbe"
  /** the trace would fold back on itself at an acute angle */
  | "angolo_acuto"
  /** the stretch leaves a pad: moved sideways, the trace would no longer leave the pad straight */
  | "pad_di_lato"
  | "arco"
  /** copper joined along the run with no corner there: another trace ending on it, a via it runs through */
  | "giunzione_a_t"
  /** the move would need a new corner: a neighbour on the same line, a stretch that ends on a via */
  | "gomito"
  /** the stretch ends on nothing: there is no second neighbour to slide along */
  | "capo_libero"
  /** a stretch of the trace is not at 0, 45 or 90 degrees: no correction of it would be accepted */
  | "direzione"
  /** copper joined to a pad by touching it alone: moved, the connection would open */
  | "collegamento"
  /** the trace or the via cannot be saved as a correction of the files' copper (see `ferma` in modello.ts) */
  | "non_salvabile"
  /** a place beyond a metre, or not a number */
  | "fuori_limite"
  /** no such trace, stretch or via in the model */
  | "non_trovato"
  /** a chain of pushes went over one of its limits: too deep, too many, too long (risolutore.ts) */
  | "catena"
  /** a trace pushed one way would have to go back the other: it is squeezed between two pushes */
  | "stretta";

/** what blocks, named */
export type CosaBlocca =
  /** `ostacolo`: its place in `modello.ostacoli` */
  | { tipo: "pad"; nome: string; id: string; ostacolo: number }
  | { tipo: "foro"; nome: string; id: string; ostacolo: number; metallizzato: boolean }
  /** its place in `modello.vie`, and the name of its net */
  | { tipo: "via"; via: number; rete: string }
  /** `ritaglio`: the id of the cutout, when the edge is one inside the board */
  | { tipo: "bordo"; ritaglio?: string }
  | { tipo: "keepout"; id: string }
  /** its place in `modello.piste`, the name of its connection, and which of its stretches */
  | { tipo: "pista"; pista: number; connessione: string; tratto: number }
  | { tipo: "niente" };

export interface Blocco {
  motivo: MotivoDelBlocco;
  cosa: CosaBlocca;
  /** where on the board, mm: the place of what blocks nearest to the copper that would move, or the corner in question */
  dove: { x: number; y: number; layer?: string };
  /** the sentence for the bar under the viewer */
  messaggio: string;
  /** for a distance: how far the copper would be, and how far it must stay (mm) */
  distanza?: number;
  richiesta?: number;
}

/** a trace with its new path: every point with its layer, a via where two share a place */
export interface PistaMossa {
  /** its place in `modello.piste` */
  pista: number;
  punti: ManualRoutePoint[];
}

export interface ViaMossa {
  /** its place in `modello.vie` */
  via: number;
  da: { x: number; y: number };
  a: { x: number; y: number };
}

/** the copper a move touched, as it is after the move; empty when the move comes to nothing */
export interface RameMosso {
  ok: true;
  piste: PistaMossa[];
  vie: ViaMossa[];
  /** how far the thing taken really went, mm: what was asked, brought to the grid */
  spostamento: { x: number; y: number };
}

export type EsitoDellaMossa = RameMosso | { ok: false; blocco: Blocco };

/** below this a difference of two distances is arithmetic, not copper: a thousandth of a micron */
export const EPS_MM = 1e-6;
/** two rings of one net are apart when a step of the grid is between them */
const STACCO_MM = 1 / UNITA_PER_MM;

const finito = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const bloccato = (blocco: Blocco): { ok: false; blocco: Blocco } => ({ ok: false, blocco });
const unita = (p: { x: number; y: number }): Punto => ({ x: inUnita(p.x), y: inUnita(p.y) });
const mm = (p: Punto): Punto => ({ x: inMm(p.x), y: inMm(p.y) });
const oltreIlMetro = (p: Punto): boolean => Math.abs(p.x) > ROUTE_LIMITS.maxCoordMm * UNITA_PER_MM || Math.abs(p.y) > ROUTE_LIMITS.maxCoordMm * UNITA_PER_MM;

/** the name a person knows a trace by: its connection, or its net when it is a piece of the copper of a whole net */
export const nomeDellaPista = (p: PistaDelModello): string =>
  (p.aMano?.startsWith("net.") && p.nomeRete) || p.connessione || p.nomeRete || p.id || "senza nome";
export const cosaPista = (p: PistaDelModello, tratto: number): CosaBlocca => ({ tipo: "pista", pista: p.indice, connessione: p.connessione, tratto });
const cosaVia = (v: ViaDelModello): CosaBlocca => ({ tipo: "via", via: v.indice, rete: v.nomeRete });
const cosaPad = (p: PadDelModello): CosaBlocca =>
  p.passante ? { tipo: "foro", nome: p.nome, id: p.id, ostacolo: p.indice, metallizzato: true } : { tipo: "pad", nome: p.nome, id: p.id, ostacolo: p.indice };
/** "dalla via di GND", "sulla via di GND": the via in a sentence, after `da` or `su` */
const viaDopo = (preposizione: "da" | "su", v: ViaDelModello): string =>
  v.nomeRete ? `${preposizione === "da" ? "dalla" : "sulla"} via di ${v.nomeRete}` : `${preposizione} una via`;

/** a segment in mm */
export interface Segmento {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}
export const segmento = (a: { x: number; y: number }, b: { x: number; y: number }): Segmento => ({ ax: a.x, ay: a.y, bx: b.x, by: b.y });
const mezzo = (s: Segmento): { x: number; y: number } => ({ x: (s.ax + s.bx) / 2, y: (s.ay + s.by) / 2 });

/** why a trace cannot be touched at all, whatever the move; null when it can */
function pistaFerma(pista: PistaDelModello): Blocco | null {
  const dove = { x: pista.punti[0].x, y: pista.punti[0].y, layer: pista.punti[0].layer };
  if (pista.arco) {
    return { motivo: "arco", cosa: cosaPista(pista, 0), dove, messaggio: `bloccato: la pista ${nomeDellaPista(pista)} e' un arco` };
  }
  if (pista.ferma) {
    return { motivo: "non_salvabile", cosa: cosaPista(pista, 0), dove, messaggio: `bloccato: ${pista.ferma} (${nomeDellaPista(pista)})` };
  }
  return null;
}

/**
 * A stretch the move would have to read a direction from, and that has none.
 * Only such a stretch blocks: one the move does not touch is a given, whatever
 * its angle.
 */
function bloccoDelTrattoStorto(pista: PistaDelModello, tratto: TrattoDelModello): Blocco {
  const [a, b] = capiDelTratto(pista, tratto);
  return {
    motivo: "direzione",
    cosa: cosaPista(pista, tratto.indice),
    dove: { ...mezzo(segmento(a, b)), layer: tratto.strato },
    messaggio: `bloccato: la pista ${nomeDellaPista(pista)} ha un tratto che non e' a 0, 45 o 90 gradi`,
  };
}

/** the block of something joined to a stretch along its run */
function bloccoDellaTenuta(modello: Modello, tenuta: Tenuta, strato: string): Blocco {
  if (tenuta.tipo === "pista") {
    const altra = modello.piste[tenuta.pista];
    const inizio = altra.punti[0];
    const suo = inizio.x === tenuta.x && inizio.y === tenuta.y ? 0 : altra.tratti.length - 1;
    return {
      motivo: "giunzione_a_t",
      cosa: cosaPista(altra, Math.max(0, suo)),
      dove: { x: tenuta.x, y: tenuta.y, layer: strato },
      messaggio: `bloccato da una giunzione a T con la pista ${nomeDellaPista(altra)}`,
    };
  }
  if (tenuta.tipo === "via") {
    const via = modello.vie[tenuta.via];
    return {
      motivo: "giunzione_a_t",
      cosa: cosaVia(via),
      dove: { x: via.x, y: via.y },
      messaggio: `bloccato: il tratto passa ${viaDopo("su", via)} senza un suo vertice`,
    };
  }
  const pad = modello.ostacoli[tenuta.ostacolo] as PadDelModello;
  return {
    motivo: "collegamento",
    cosa: cosaPad(pad),
    dove: { x: pad.forma.x, y: pad.forma.y, ...(pad.strato ? { layer: pad.strato } : {}) },
    messaggio: `bloccato: la pista tocca ${pad.nome} senza finirci, spostata lo staccherebbe`,
  };
}

/** whether what a stretch held is still held by the copper that takes its place */
function ancoraTenuto(modello: Modello, pista: PistaDelModello, tenuta: Tenuta, nuovi: Segmento[]): boolean {
  const mezza = pista.larghezza / 2;
  return nuovi.some((s) => {
    if (tenuta.tipo === "pista") {
      return distanzaPuntoSegmento(tenuta.x, tenuta.y, s.ax, s.ay, s.bx, s.by) <= mezza + modello.piste[tenuta.pista].larghezza / 2 + CONTATTO_MM;
    }
    if (tenuta.tipo === "via") {
      const via = modello.vie[tenuta.via];
      return distanzaPuntoSegmento(via.x, via.y, s.ax, s.ay, s.bx, s.by) <= mezza + via.corona / 2 + CONTATTO_MM;
    }
    const pad = modello.ostacoli[tenuta.ostacolo] as PadDelModello;
    return distanzaSegmentoForma(pad.forma, s.ax, s.ay, s.bx, s.by) <= mezza + CONTATTO_MM;
  });
}

/** one piece of copper as the move leaves it, to be judged against everything that does not move */
export interface Pezzo extends Segmento {
  /** half the width of a stretch, the radius of a ring */
  mezza: number;
  /** null: a via, copper on every layer */
  strato: string | null;
  tipo: TipoRame;
  rete: string | null;
  /** the diameter of the drill, for a via */
  foro: number;
  /** the copper it takes the place of: as near as that was, this may stay */
  prima: Segmento;
  /** copper that was not there (the second leg of a redone stretch): it may keep a distance its stretch already had, never break one */
  nuovo: boolean;
  /** the trace it is copper of (its place in `modello.piste`); absent for the ring of a via */
  pista?: number;
  /** which stretch of that trace it is, when it is one the model has (a stretch that slid, got longer or shorter); absent for a leg drawn anew */
  tratto?: number;
}

/** the geometry of a move before anything is measured against the board: the copper it gives, piece by piece */
export interface Geometria extends RameMosso {
  pezzi: Pezzo[];
  /** the stretches of the model that are no longer where the model has them */
  cambiati: Array<{ pista: number; tratto: number }>;
}
export type EsitoDellaGeometria = Geometria | { ok: false; blocco: Blocco };
const niente = (): Geometria => ({ ok: true, piste: [], vie: [], spostamento: { x: 0, y: 0 }, pezzi: [], cambiati: [] });

/** how far two kinds of copper of different nets are kept: the distance the project draws at, never under the minimum of the check for that pair */
export function distanzaDaTenere(modello: Modello, a: TipoRame, b: TipoRame): number {
  const { regole } = modello;
  const disegno = finito(regole.targetClearanceMm) && regole.targetClearanceMm > 0 ? regole.targetClearanceMm : 0;
  return Math.max(disegno, distanzaMinimaFra(regole, a, b));
}

/**
 * The copper a move leaves against everything that stays: the traces and vias
 * of other nets, the pads, the holes, the keepouts, the cutouts and the edge.
 * Null when every distance holds; else the worst one, named.
 *
 * `fuori`: the traces and the vias that are moving, whose old copper is still
 * in the model; and `salta`, the stretches somebody else answers for (the
 * solver of the pushes: the ones that are elsewhere already, and the ones that
 * can give way, which it measures on the whole way the copper came).
 */
export function giudica(
  modello: Modello,
  pezzi: Pezzo[],
  fuori: { piste: ReadonlySet<number>; vie: ReadonlySet<number>; salta?: (pista: number, tratto: number) => boolean },
): Blocco | null {
  const { regole } = modello;
  const disegno = finito(regole.targetClearanceMm) && regole.targetClearanceMm > 0 ? regole.targetClearanceMm : 0;
  const richiesta = (a: TipoRame, b: TipoRame): number => distanzaDaTenere(modello, a, b);
  const bordo = regole.minBoardEdgeClearanceMm;
  const fraFori = regole.minHoleToHoleMm;
  const portata = Math.max(
    disegno,
    regole.minClearanceMm,
    bordo,
    fraFori,
    ...Object.values(regole.clearanceByPairMm ?? {}).filter(finito),
  );
  const lati = modello.contorno.length >= 3 ? modello.contorno.map((a, i) => segmento(a, modello.contorno[(i + 1) % modello.contorno.length])) : [];

  const peggio: { margine: number; blocco: Blocco | null } = { margine: Infinity, blocco: null };
  /**
   * One distance: `d` after the move, `serve` to keep, `minimo` the one the
   * check asks, `prima()` what it was before. Copper already nearer than
   * `serve` may stay where it was.
   */
  const prova = (d: number, serve: number, minimo: number, prima: () => number, nuovo: boolean, blocco: () => Blocco) => {
    if (d >= serve - EPS_MM) return;
    const era = prima();
    const soglia = nuovo ? Math.min(serve, Math.max(era, minimo)) : Math.min(serve, era);
    if (d >= soglia - EPS_MM) return;
    const margine = d - soglia;
    if (margine >= peggio.margine) return;
    peggio.margine = margine;
    peggio.blocco = { ...blocco(), ...(Number.isFinite(d) ? { distanza: Math.max(0, d) } : {}), richiesta: soglia };
  };

  for (const p of pezzi) {
    const largo = p.mezza + portata;
    const minX = Math.min(p.ax, p.bx) - largo;
    const maxX = Math.max(p.ax, p.bx) + largo;
    const minY = Math.min(p.ay, p.by) - largo;
    const maxY = Math.max(p.ay, p.by) + largo;

    // the traces of the other nets, on its layer
    for (const rif of modello.vicino.tratti.vicini(minX, minY, maxX, maxY)) {
      if (fuori.piste.has(rif.pista) || fuori.salta?.(rif.pista, rif.tratto)) continue;
      const altra = modello.piste[rif.pista];
      if (stessaRete(altra.rete, p.rete)) continue;
      const suo = altra.tratti[rif.tratto];
      if (p.strato !== null && suo.strato !== p.strato) continue;
      const [c, d] = capiDelTratto(altra, suo);
      const misura = (g: Segmento) => distanzaSegmenti(g.ax, g.ay, g.bx, g.by, c.x, c.y, d.x, d.y) - p.mezza - altra.larghezza / 2;
      prova(misura(p), richiesta(p.tipo, "trace"), distanzaMinimaFra(regole, p.tipo, "trace"), () => misura(p.prima), p.nuovo, () => ({
        motivo: "pista",
        cosa: cosaPista(altra, suo.indice),
        dove: { ...puntoVicino(p.ax, p.ay, p.bx, p.by, c.x, c.y, d.x, d.y), layer: suo.strato },
        messaggio: `bloccato dalla pista ${nomeDellaPista(altra)}`,
      }));
    }

    // the vias: a ring of another net, the ring of a via of its own for a via, and the drills
    for (const i of modello.vicino.vie.vicini(minX, minY, maxX, maxY)) {
      if (fuori.vie.has(i)) continue;
      const via = modello.vie[i];
      const centro = (g: Segmento) => distanzaPuntoSegmento(via.x, via.y, g.ax, g.ay, g.bx, g.by);
      const blocco = (): Blocco => ({ motivo: "via", cosa: cosaVia(via), dove: { x: via.x, y: via.y }, messaggio: `bloccato ${viaDopo("da", via)}` });
      const corone = (g: Segmento) => centro(g) - via.corona / 2 - p.mezza;
      if (!stessaRete(via.rete, p.rete)) {
        prova(corone(p), richiesta(p.tipo, "via"), distanzaMinimaFra(regole, p.tipo, "via"), () => corone(p.prima), p.nuovo, blocco);
      } else if (p.tipo === "via") {
        // a via never stops with its ring on the ring of another, of its own net either
        prova(corone(p), STACCO_MM, 0, () => corone(p.prima), p.nuovo, blocco);
      }
      if (p.tipo === "via") {
        const fori = (g: Segmento) => centro(g) - via.foro / 2 - p.foro / 2;
        prova(fori(p), fraFori, fraFori, () => fori(p.prima), p.nuovo, blocco);
      }
    }

    // pads, holes, keepouts, cutouts
    for (const i of modello.vicino.ostacoli.vicini(minX, minY, maxX, maxY)) {
      const o = modello.ostacoli[i];
      if (o.tipo === "pad") {
        if (p.strato !== null && o.strato !== null && o.strato !== p.strato) continue;
        const blocco = (): Blocco => ({
          motivo: o.passante ? "foro" : "pad",
          cosa: cosaPad(o),
          dove: { x: o.forma.x, y: o.forma.y, ...(o.strato ? { layer: o.strato } : {}) },
          messaggio: o.passante ? `bloccato dal foro ${o.nome}` : `bloccato dalla piazzola ${o.nome}`,
        });
        if (!stessaRete(o.rete, p.rete)) {
          const misura = (g: Segmento) => distanzaSegmentoForma(o.forma, g.ax, g.ay, g.bx, g.by) - p.mezza;
          prova(misura(p), richiesta(p.tipo, "pad"), distanzaMinimaFra(regole, p.tipo, "pad"), () => misura(p.prima), p.nuovo, blocco);
        }
        if (p.tipo === "via" && o.foro) {
          const f = o.foro;
          const fori = (g: Segmento) => distanzaSegmenti(g.ax, g.ay, g.bx, g.by, f.ax, f.ay, f.bx, f.by) - f.r - p.foro / 2;
          prova(fori(p), fraFori, fraFori, () => fori(p.prima), p.nuovo, blocco);
        }
      } else if (o.tipo === "foro") {
        const f = o.foro;
        const nucleo = (g: Segmento) => distanzaSegmenti(g.ax, g.ay, g.bx, g.by, f.ax, f.ay, f.bx, f.by) - f.r;
        const blocco = (): Blocco => ({
          motivo: "foro",
          cosa: { tipo: "foro", nome: o.id || "foro", id: o.id, ostacolo: o.indice, metallizzato: false },
          dove: { x: (f.ax + f.bx) / 2, y: (f.ay + f.by) / 2 },
          messaggio: "bloccato da un foro",
        });
        // copper stays from a bare drill as far as from the edge of the board (as the ground stitching does)
        prova(nucleo(p) - p.mezza, bordo, bordo, () => nucleo(p.prima) - p.mezza, p.nuovo, blocco);
        if (p.tipo === "via") prova(nucleo(p) - p.foro / 2, fraFori, fraFori, () => nucleo(p.prima) - p.foro / 2, p.nuovo, blocco);
      } else {
        const keepout = o.tipo === "keepout";
        if (keepout && o.strati !== null && p.strato !== null && !o.strati.includes(p.strato)) continue;
        const misura = (g: Segmento) => distanzaSegmentoZona(o.sagoma, g.ax, g.ay, g.bx, g.by) - p.mezza;
        // a keepout is entered or not; a cutout is an edge of the board
        const serve = keepout ? 0 : bordo;
        prova(misura(p), serve, serve, () => misura(p.prima), p.nuovo, () => ({
          motivo: keepout ? "keepout" : "bordo",
          cosa: keepout ? { tipo: "keepout", id: o.id } : { tipo: "bordo", ritaglio: o.id },
          dove: mezzo(p),
          messaggio: keepout ? "bloccato da una zona vietata al rame" : "bloccato da un ritaglio della scheda",
        }));
      }
    }

    // the edge of the board: out of it is nearer than any distance
    if (lati.length > 0) {
      const dentro = (g: Segmento) => dentroPoligono(g.ax, g.ay, modello.contorno) && dentroPoligono(g.bx, g.by, modello.contorno);
      const misura = (g: Segmento) => {
        if (!dentro(g)) return -Infinity;
        let d = Infinity;
        for (const l of lati) d = Math.min(d, distanzaSegmenti(g.ax, g.ay, g.bx, g.by, l.ax, l.ay, l.bx, l.by));
        return d - p.mezza;
      };
      prova(misura(p), bordo, bordo, () => misura(p.prima), p.nuovo, () => {
        let vicino = lati[0];
        let d = Infinity;
        for (const l of lati) {
          const qui = distanzaSegmenti(p.ax, p.ay, p.bx, p.by, l.ax, l.ay, l.bx, l.by);
          if (qui < d) [vicino, d] = [l, qui];
        }
        return {
          motivo: "bordo",
          cosa: { tipo: "bordo" },
          dove: puntoVicino(p.ax, p.ay, p.bx, p.by, vicino.ax, vicino.ay, vicino.bx, vicino.by),
          messaggio: "bloccato dal bordo della scheda",
        };
      });
    }
  }
  return peggio.blocco;
}

/**
 * AN END OF A TRACE CARRIED INTO A PAD OF ITS OWN NET (with the via it stands
 * on, or with the corner it shares with the trace chained to it). The check of
 * the exits looks at the two ENDS of every trace: an end in a pad is the exit
 * of that pad, and the stretch that reaches it must leave it straight. A corner
 * in the middle of a trace is not looked at, an end is: so an end does not go
 * into a pad. The pad is taken for its box, as that check takes it. Null when
 * the end stands in none.
 */
function capoInUnPad(modello: Modello, pista: PistaDelModello, capo: { x: number; y: number; layer: string }): Blocco | null {
  for (const j of modello.vicino.ostacoli.vicini(capo.x, capo.y, capo.x, capo.y)) {
    const o = modello.ostacoli[j];
    if (o.tipo !== "pad" || !stessaRete(o.rete, pista.rete) || (o.strato !== null && o.strato !== capo.layer)) continue;
    const box = ingombroForma(o.forma);
    if (capo.x < box.minX - CONTATTO_MM || capo.x > box.maxX + CONTATTO_MM || capo.y < box.minY - CONTATTO_MM || capo.y > box.maxY + CONTATTO_MM) continue;
    return {
      motivo: "pad",
      cosa: cosaPad(o),
      dove: { x: o.forma.x, y: o.forma.y, ...(o.strato ? { layer: o.strato } : {}) },
      messaggio: `bloccato dalla piazzola ${o.nome}: la pista ci entrerebbe di traverso`,
    };
  }
  return null;
}

/** a stretch of a trace as a piece to judge: its new place, and the one it had */
const pezzoDiPista = (pista: PistaDelModello, strato: string, nuovo: Segmento, prima: Segmento, aggiunto = false, tratto?: number): Pezzo => ({
  ...nuovo,
  mezza: pista.larghezza / 2,
  strato,
  tipo: "trace",
  rete: pista.rete,
  foro: 0,
  prima,
  nuovo: aggiunto,
  pista: pista.indice,
  ...(tratto === undefined ? {} : { tratto }),
});

/**
 * How short a stretch may become: never shorter than the trace is wide, and a
 * stretch that already was may not shrink further. Below that it is a stub
 * hidden under its own corners, which is a stretch gone.
 */
const lunghezzaMinima = (pista: PistaDelModello, prima: number): number => Math.min(prima, pista.larghezza);

/** a stretch next to the one that slides: it gets longer or shorter, and its far end stays */
interface Vicino {
  pista: PistaDelModello;
  tratto: TrattoDelModello;
  /** which point of the path of `pista` is the corner it shares with the stretch that slides, and which its far end */
  giunto: number;
  lontano: number;
  /** from its far end toward the shared corner */
  verso: Direzione;
  /** whether, beyond its far end, its trace goes on turning by less than a right angle */
  piega: boolean;
}

const opposta = (d: Direzione): Direzione => ({ dx: -d.dx, dy: -d.dy });

/**
 * The neighbour of a stretch at one of its ends: the next stretch of its own
 * trace at a corner, the end stretch of the other trace where two are chained.
 * Any other end has no neighbour to slide along: the block says which.
 */
function vicinoDi(modello: Modello, pista: PistaDelModello, tratto: TrattoDelModello, lato: 0 | 1): Vicino | Blocco {
  const capo = tratto.capi[lato];
  const p = pista.punti[tratto.da + lato];
  const dove = { x: p.x, y: p.y, layer: tratto.strato };
  const questo = cosaPista(pista, tratto.indice);
  if (capo.tipo === "pad") {
    const pad = modello.ostacoli[capo.ostacolo] as PadDelModello;
    return { motivo: "pad_di_lato", cosa: cosaPad(pad), dove, messaggio: `bloccato: il tratto esce da ${pad.nome} e scivolerebbe di lato` };
  }
  if (capo.tipo === "via") {
    const via = modello.vie[capo.via];
    return { motivo: "gomito", cosa: cosaVia(via), dove, messaggio: `bloccato: il tratto finisce ${viaDopo("su", via)}, servirebbe un gomito nuovo (si sposta la via)` };
  }
  if (capo.tipo === "giunzione") {
    const altra = modello.piste[capo.pista];
    return { motivo: "giunzione_a_t", cosa: cosaPista(altra, capo.tratto), dove, messaggio: `bloccato da una giunzione a T con la pista ${nomeDellaPista(altra)}` };
  }
  if (capo.tipo === "libero") {
    return { motivo: "capo_libero", cosa: questo, dove, messaggio: "bloccato: il tratto finisce nel vuoto" };
  }
  let sua = pista;
  let suo: TrattoDelModello | undefined;
  /** which end of the neighbour is the far one */
  let latoLontano: 0 | 1;
  if (capo.tipo === "vertice") {
    suo = pista.tratti[tratto.indice + (lato === 0 ? -1 : 1)];
    latoLontano = lato;
    if (suo && suo.da !== tratto.da + (lato === 0 ? -1 : 1)) suo = undefined;
  } else {
    sua = modello.piste[capo.pista];
    const ferma = pistaFerma(sua);
    if (ferma) return ferma;
    suo = sua.tratti[capo.tratto];
    latoLontano = capo.lato === 0 ? 1 : 0;
  }
  if (!suo) {
    return { motivo: "gomito", cosa: questo, dove, messaggio: "bloccato: il tratto non ha due tratti vicini da allungare" };
  }
  if (!suo.direzione) return bloccoDelTrattoStorto(sua, suo);
  const oltre = suo.capi[latoLontano].tipo === "vertice" ? sua.tratti[suo.indice + (latoLontano === 0 ? -1 : 1)]?.direzione : null;
  return {
    pista: sua,
    tratto: suo,
    giunto: suo.da + (latoLontano === 0 ? 1 : 0),
    lontano: suo.da + latoLontano,
    verso: latoLontano === 0 ? suo.direzione : opposta(suo.direzione),
    piega: !!oltre && prodotto(oltre, suo.direzione) > 0,
  };
}

/**
 * MOVE 1. The stretch `presa.tratto` of the trace `presa.pista` slides along
 * its normal by what `spostamento` (mm, the movement of the mouse since the
 * gesture began) has of it; the part along the stretch is not a movement.
 *
 * Asked with no movement at all, it says whether the stretch can be taken:
 * EVERY block that does not depend on how far (a pad at its end, a T junction
 * on it, an arc, a neighbour with no direction) comes before the answer
 * "nothing moved", and none of them reads the rules of the project. It is what
 * marks the targets that can never move (preseDelRame).
 */
export function traslaTratto(modello: Modello, presa: { pista: number; tratto: number }, spostamento: { x: number; y: number }): EsitoDellaMossa {
  const g = geometriaDelTratto(modello, presa, spostamento);
  if (!g.ok) return g;
  if (g.pezzi.length > 0) {
    const blocco = giudica(modello, g.pezzi, { piste: new Set(g.piste.map((m) => m.pista)), vie: new Set() });
    if (blocco) return bloccato(blocco);
  }
  return { ok: true, piste: g.piste, vie: g.vie, spostamento: g.spostamento };
}

/**
 * The geometry of move 1, with nothing measured against the rest of the board:
 * the paths of the traces it touches and the three pieces of copper it leaves
 * (the stretch and its two neighbours), or the block of the trace itself (a
 * pad at an end, a stretch that would vanish, an acute corner).
 *
 * `percorsi`: the paths of the traces a solve has ALREADY moved (the chain of
 * pushes, risolutore.ts). The stretch is then taken where it stands now, and
 * what it was at the start of the gesture is still what its pieces remember.
 * `almeno`: the stretch goes at least as far as asked, to the first place of
 * its grid beyond; without it, to the nearest.
 */
export function geometriaDelTratto(
  modello: Modello,
  presa: { pista: number; tratto: number },
  spostamento: { x: number; y: number },
  opzioni: { percorsi?: ReadonlyMap<number, ManualRoutePoint[]>; almeno?: boolean } = {},
): EsitoDellaGeometria {
  const puntiDi = (p: PistaDelModello): ManualRoutePoint[] => opzioni.percorsi?.get(p.indice) ?? p.punti;
  const pista = modello.piste[presa.pista];
  const tratto = pista?.tratti[presa.tratto];
  if (!pista || !tratto) {
    return bloccato({ motivo: "non_trovato", cosa: { tipo: "niente" }, dove: { x: 0, y: 0 }, messaggio: "questo tratto non e' sulla scheda" });
  }
  const ferma = pistaFerma(pista);
  if (ferma) return bloccato(ferma);

  const a = puntiDi(pista)[tratto.da];
  const b = puntiDi(pista)[tratto.da + 1];
  const questo = cosaPista(pista, tratto.indice);
  const alCentro = { ...mezzo(segmento(a, b)), layer: tratto.strato };
  // the two neighbours: the stretches before and after, of its own trace or of the one chained to it
  const vp = vicinoDi(modello, pista, tratto, 0);
  if ("motivo" in vp) return bloccato(vp);
  const vn = vicinoDi(modello, pista, tratto, 1);
  if ("motivo" in vn) return bloccato(vn);
  if (tratto.tiene.length > 0) return bloccato(bloccoDellaTenuta(modello, tratto.tiene[0], tratto.strato));
  const ds = tratto.direzione;
  if (!ds) return bloccato(bloccoDelTrattoStorto(pista, tratto));

  const A = unita(a);
  const B = unita(b);
  const P = unita(puntiDi(vp.pista)[vp.lontano]);
  const N = unita(puntiDi(vn.pista)[vn.lontano]);
  const rs = rettaDi(A, ds);
  const rp = rettaDi(P, vp.verso);
  const rn = rettaDi(N, vn.verso);
  for (const [altra, p] of [[rp, a], [rn, b]] as const) {
    if (incrocio(rs, altra).tipo !== "parallele") continue;
    return bloccato({
      motivo: "gomito",
      cosa: questo,
      dove: { x: p.x, y: p.y, layer: tratto.strato },
      messaggio: "bloccato: il tratto vicino e' sulla stessa retta, servirebbe un gomito nuovo",
    });
  }

  if (!finito(spostamento?.x) || !finito(spostamento?.y)) {
    return bloccato({ motivo: "fuori_limite", cosa: { tipo: "niente" }, dove: alCentro, messaggio: "lo spostamento non e' un numero" });
  }
  /*
   * What the movement has of the normal, in steps of the line. A corner goes
   * along its neighbour by one unit for every step of the line, or by half a
   * unit when the two are both at 45 degrees: so the line moves by two steps
   * at a time there, and by ten times as many when the corners must stay on
   * whole microns (hand copper).
   *
   * THE THREE LINES ARE EXACT, each through a point that is on the grid: the
   * neighbours' through their far ends, which do not move, and the stretch's
   * own through its first end. Where the copper was drawn exact they cross in
   * the corners that are there, and the line can move by whole steps from
   * where it is. Where a stretch was off its direction by a hair (see
   * direzioneVicina) they need not cross on the grid as they stand: the places
   * of the line that put BOTH corners on the grid come round every `passo`,
   * and are looked for among the first `passo` of them.
   */
  const griglia = Math.max(pista.griglia, vp.pista.griglia, vn.pista.griglia);
  const passo = griglia * Math.max(passoDiTraslazione(rs, rp), passoDiTraslazione(rs, rn));
  const suGriglia = (i: ReturnType<typeof incrocio>): boolean => i.tipo === "punto" && i.x % griglia === 0 && i.y % griglia === 0;
  const chiesto = (rs.a * spostamento.x + rs.b * spostamento.y) * UNITA_PER_MM;
  let quanto: number | null = null;
  for (let resto = 0; resto < passo; resto++) {
    const prova = traslata(rs, resto);
    if (!suGriglia(incrocio(rp, prova)) || !suGriglia(incrocio(prova, rn))) continue;
    const giri = (chiesto - resto) / passo;
    // "at least": the first place beyond, but not one further for a millionth of a unit a sum of floats left over
    const vicino = resto + passo * (!opzioni.almeno ? Math.round(giri) : chiesto >= 0 ? Math.ceil(giri - 1e-6) : Math.floor(giri + 1e-6));
    if (quanto === null || Math.abs(vicino - chiesto) < Math.abs(quanto - chiesto)) quanto = vicino;
  }
  if (quanto === null) {
    // two neighbours at 45 degrees whose lines never cross a line of the stretch both on the grid: wherever it is asked to go
    return bloccato({ motivo: "direzione", cosa: questo, dove: alCentro, messaggio: "bloccato: un vertice cadrebbe fuori dalla griglia" });
  }
  // less than half a step: the stretch stays as it is, and nothing of the trace is written again
  if (opzioni.almeno ? chiesto === 0 || quanto === 0 : Math.abs(chiesto) < passo / 2) return niente();
  const nuova = traslata(rs, quanto);
  const ia = incrocio(rp, nuova);
  const ib = incrocio(nuova, rn);
  if (ia.tipo !== "punto" || ib.tipo !== "punto") {
    // not reachable with the step above; said rather than rounded if it ever is
    return bloccato({ motivo: "direzione", cosa: questo, dove: alCentro, messaggio: "bloccato: un vertice cadrebbe fuori dalla griglia" });
  }
  if (oltreIlMetro(ia) || oltreIlMetro(ib)) {
    return bloccato({ motivo: "fuori_limite", cosa: questo, dove: { ...mm(ia), layer: tratto.strato }, messaggio: "bloccato: oltre il metro non e' una scheda" });
  }

  // no stretch vanishes, none turns back
  const lunghi: Array<{ pista: PistaDelModello; tratto: TrattoDelModello; d: Direzione; passi: number; erano: number; acuto: boolean; dove: Punto }> = [
    { pista: vp.pista, tratto: vp.tratto, d: vp.verso, passi: passiLungo(P, ia, vp.verso), erano: passiLungo(P, A, vp.verso), acuto: prodotto(vp.verso, ds) > 0 || vp.piega, dove: P },
    { pista, tratto, d: ds, passi: passiLungo(ia, ib, ds), erano: passiLungo(A, B, ds), acuto: prodotto(vp.verso, ds) > 0 || prodotto(ds, opposta(vn.verso)) > 0, dove: ia },
    { pista: vn.pista, tratto: vn.tratto, d: vn.verso, passi: passiLungo(N, ib, vn.verso), erano: passiLungo(N, B, vn.verso), acuto: prodotto(ds, opposta(vn.verso)) > 0 || vn.piega, dove: N },
  ];
  for (const l of lunghi) {
    if (l.passi * passoMm(l.d) >= lunghezzaMinima(l.pista, l.erano * passoMm(l.d)) - EPS_MM) continue;
    const piegata = l.passi < 0 && l.acuto;
    return bloccato({
      motivo: piegata ? "angolo_acuto" : "tratto_sparirebbe",
      cosa: cosaPista(l.pista, l.tratto.indice),
      dove: { ...mm(l.dove), layer: tratto.strato },
      messaggio: piegata
        ? `bloccato: la pista ${nomeDellaPista(l.pista)} tornerebbe indietro con un angolo acuto`
        : `bloccato: un tratto della pista ${nomeDellaPista(l.pista)} sparirebbe`,
    });
  }

  // the paths of the traces the move touches: its own, and the ones chained to it at the two corners
  const percorsi = new Map<number, ManualRoutePoint[]>();
  const metti = (di: PistaDelModello, k: number, dove: Punto) => {
    let punti = percorsi.get(di.indice);
    if (!punti) percorsi.set(di.indice, (punti = [...puntiDi(di)]));
    punti[k] = { ...mm(dove), layer: di.punti[k].layer };
  };
  metti(pista, tratto.da, ia);
  metti(pista, tratto.da + 1, ib);
  metti(vp.pista, vp.giunto, ia);
  metti(vn.pista, vn.giunto, ib);
  const nuovo = (di: PistaDelModello, t: TrattoDelModello): Segmento => {
    const punti = percorsi.get(di.indice)!;
    return segmento(punti[t.da], punti[t.da + 1]);
  };
  // a corner shared with a chained trace is an END of both: it does not go into a pad of their net
  for (const [v, dove] of [[vp, ia], [vn, ib]] as const) {
    if (v.pista === pista) continue;
    const nelPad = capoInUnPad(modello, pista, { ...mm(dove), layer: tratto.strato });
    if (nelPad) return bloccato(nelPad);
  }
  // what the two neighbours held, they still hold
  for (const v of [vp, vn]) {
    for (const tenuta of v.tratto.tiene) {
      if (!ancoraTenuto(modello, v.pista, tenuta, [nuovo(v.pista, v.tratto)])) return bloccato(bloccoDellaTenuta(modello, tenuta, v.tratto.strato));
    }
  }
  // each piece remembers the stretch as the model has it: where it was when the gesture began
  const toccati = [
    { pista: vp.pista, tratto: vp.tratto },
    { pista, tratto },
    { pista: vn.pista, tratto: vn.tratto },
  ];
  const pezzi = toccati.map((x) => pezzoDiPista(x.pista, x.tratto.strato, nuovo(x.pista, x.tratto), segmento(...capiDelTratto(x.pista, x.tratto)), false, x.tratto.indice));

  // the line went `quanto` of its steps along its normal (a; b), which is one unit long, or a diagonal
  const traslazione = quanto / (rs.a * rs.a + rs.b * rs.b) / UNITA_PER_MM;
  return {
    ok: true,
    piste: [...percorsi].map(([indice, punti]) => ({ pista: indice, punti })),
    vie: [],
    spostamento: { x: rs.a * traslazione, y: rs.b * traslazione },
    pezzi,
    cambiati: toccati.map((x) => ({ pista: x.pista.indice, tratto: x.tratto.indice })),
  };
}

/**
 * The corners of a path where the copper folds back by more than a right
 * angle: two stretches of one layer that meet at 45 degrees, or turn back on
 * themselves. Where the etching bites deeper.
 */
function angoliAcuti(punti: readonly ManualRoutePoint[]): ManualRoutePoint[] {
  const out: ManualRoutePoint[] = [];
  for (let k = 1; k + 1 < punti.length; k++) {
    const [a, b, c] = [punti[k - 1], punti[k], punti[k + 1]];
    if (a.layer !== b.layer || b.layer !== c.layer) continue;
    const [A, B, C] = [unita(a), unita(b), unita(c)];
    if ((B.x - A.x) * (C.x - B.x) + (B.y - A.y) * (C.y - B.y) < 0) out.push(b);
  }
  return out;
}

/** the first acute corner a path has that the path it comes from had not; null when it has no more of them than that one */
function angoloAcutoNuovo(prima: readonly ManualRoutePoint[], dopo: readonly ManualRoutePoint[]): ManualRoutePoint | null {
  const erano = angoliAcuti(prima);
  const sono = angoliAcuti(dopo);
  if (sono.length <= erano.length) return null;
  return sono.find((q) => !erano.some((e) => e.x === q.x && e.y === q.y && e.layer === q.layer)) ?? sono[0];
}

/**
 * The two legs that take a stretch from its fixed end `P` to the new place of
 * the via `V` (whole units): `a` steps along `d`, the direction the stretch
 * had, then `b` steps along `e`, the direction 45 degrees from it on the side
 * of the via; `e` is null when the via is straight ahead. There is always
 * exactly one such pair with `b >= 0`; `a` comes out too short or negative when
 * the via is not ahead of the stretch within 45 degrees.
 */
function gambe(P: Punto, V: Punto, d: Direzione): { a: number; b: number; e: Direzione | null } {
  const dx = V.x - P.x;
  const dy = V.y - P.y;
  if (!eDiagonale(d)) {
    const lungo = dx * d.dx + dy * d.dy;
    const diLato = -dx * d.dy + dy * d.dx;
    const verso = Math.sign(diLato);
    return { a: lungo - Math.abs(diLato), b: Math.abs(diLato), e: verso === 0 ? null : { dx: d.dx - verso * d.dy, dy: d.dy + verso * d.dx } };
  }
  const px = dx * d.dx;
  const py = dy * d.dy;
  return { a: Math.min(px, py), b: Math.abs(px - py), e: px === py ? null : px > py ? { dx: d.dx, dy: 0 } : { dx: 0, dy: d.dy } };
}

/**
 * MOVE 2. The via `quale` goes to `a` (mm, brought to the grid), with the
 * traces that stand in it on every layer.
 *
 * Asked for the place where the via is, it says whether the via can be taken:
 * as for a stretch, every block that does not depend on where it goes comes
 * first, and reads nothing of the rules.
 */
export function spostaVia(modello: Modello, quale: number, a: { x: number; y: number }): EsitoDellaMossa {
  const g = geometriaDellaVia(modello, quale, a);
  if (!g.ok) return g;
  if (g.pezzi.length > 0) {
    const blocco = giudica(modello, g.pezzi, { piste: new Set(g.piste.map((m) => m.pista)), vie: new Set(g.vie.map((v) => v.via)) });
    if (blocco) return bloccato(blocco);
  }
  return { ok: true, piste: g.piste, vie: g.vie, spostamento: g.spostamento };
}

/** the geometry of move 2, with nothing measured against the rest of the board: the ring where it goes, and the legs of its traces */
export function geometriaDellaVia(modello: Modello, quale: number, a: { x: number; y: number }): EsitoDellaGeometria {
  const via = modello.vie[quale];
  if (!via) {
    return bloccato({ motivo: "non_trovato", cosa: { tipo: "niente" }, dove: { x: 0, y: 0 }, messaggio: "questa via non e' sulla scheda" });
  }
  const qui = { x: via.x, y: via.y };
  const questa = cosaVia(via);
  if (via.ferma) return bloccato({ motivo: "non_salvabile", cosa: questa, dove: qui, messaggio: `bloccato: ${via.ferma}` });
  const attaccate = [...new Set(via.attacchi.map((x) => x.pista))];
  for (const i of attaccate) {
    const ferma = pistaFerma(modello.piste[i]);
    if (ferma) return bloccato(ferma);
  }
  if (via.tiene.length > 0) return bloccato(bloccoDellaTenutaDiVia(modello, via, via.tiene[0]));
  // every stretch that reaches it on its layer is drawn again when it moves: one with no direction blocks it wherever it goes
  for (const { pista: i, punto: k } of via.attacchi) {
    const pista = modello.piste[i];
    for (const tratto of pista.tratti) {
      if ((tratto.da === k || tratto.da + 1 === k) && !tratto.direzione) return bloccato(bloccoDelTrattoStorto(pista, tratto));
    }
  }

  if (!finito(a?.x) || !finito(a?.y)) {
    return bloccato({ motivo: "fuori_limite", cosa: { tipo: "niente" }, dove: qui, messaggio: "il posto non e' un numero" });
  }
  const C = unita(via);
  // hand copper stands on whole microns: with any of it attached, so does the place the via goes to
  const griglia = Math.max(1, ...attaccate.map((i) => modello.piste[i].griglia));
  const suGriglia = (v: number): number => Math.round((v * UNITA_PER_MM) / griglia) * griglia + 0;
  const V = { x: suGriglia(a.x), y: suGriglia(a.y) };
  if (oltreIlMetro(V)) return bloccato({ motivo: "fuori_limite", cosa: questa, dove: qui, messaggio: "bloccato: oltre il metro non e' una scheda" });
  if (V.x === C.x && V.y === C.y) return niente();
  const arrivo = mm(V);

  const piste: PistaMossa[] = [];
  const pezzi: Pezzo[] = [];
  const cambiati: Array<{ pista: number; tratto: number }> = [];
  for (const i of attaccate) {
    const pista = modello.piste[i];
    const suoi = new Set(via.attacchi.filter((x) => x.pista === i).map((x) => x.punto));
    const ultimo = pista.punti.length - 1;
    const punti: ManualRoutePoint[] = [];
    /** the stretch between the point `k` of the path, at the via, and its neighbour `fisso`, drawn again; the corner it gains, if any */
    const rifai = (k: number, fisso: number): { blocco: Blocco } | { gomito: ManualRoutePoint | null } => {
      const tratto = pista.tratti.find((t) => t.da === Math.min(k, fisso))!;
      if (!tratto.direzione) return { blocco: bloccoDelTrattoStorto(pista, tratto) };
      const lontano = pista.punti[fisso];
      const P = unita(lontano);
      // from the fixed end toward the via: the direction of the stretch, or its opposite. The first leg is exact, from that end
      const verso = fisso < k ? tratto.direzione : opposta(tratto.direzione);
      const g = gambe(P, V, verso);
      const era = passiLungo(P, C, verso) * passoMm(verso);
      if (g.a * passoMm(verso) < lunghezzaMinima(pista, era) - EPS_MM) {
        const piegata = g.a < 0;
        return {
          blocco: {
            motivo: piegata ? "angolo_acuto" : "tratto_sparirebbe",
            cosa: cosaPista(pista, tratto.indice),
            dove: { x: lontano.x, y: lontano.y, layer: tratto.strato },
            messaggio: piegata
              ? `bloccato: la pista ${nomeDellaPista(pista)} tornerebbe indietro con un angolo acuto`
              : `bloccato: un tratto della pista ${nomeDellaPista(pista)} sparirebbe`,
          },
        };
      }
      const Q = mm(avanti(P, verso, g.a));
      const vecchio = segmento(lontano, pista.punti[k]);
      const nuovi = g.e ? [segmento(lontano, Q), segmento(Q, arrivo)] : [segmento(lontano, arrivo)];
      for (const tenuta of tratto.tiene) {
        if (!ancoraTenuto(modello, pista, tenuta, nuovi)) return { blocco: bloccoDellaTenuta(modello, tenuta, tratto.strato) };
      }
      nuovi.forEach((s, n) => pezzi.push(pezzoDiPista(pista, tratto.strato, s, vecchio, n === 1)));
      cambiati.push({ pista: pista.indice, tratto: tratto.indice });
      return { gomito: g.e ? { ...Q, layer: tratto.strato } : null };
    };
    for (let k = 0; k <= ultimo; k++) {
      const p = pista.punti[k];
      if (!suoi.has(k)) {
        punti.push(p);
        continue;
      }
      if (k > 0 && pista.punti[k - 1].layer === p.layer) {
        const esito = rifai(k, k - 1);
        if ("blocco" in esito) return bloccato(esito.blocco);
        if (esito.gomito) punti.push(esito.gomito);
      }
      punti.push({ ...arrivo, layer: p.layer });
      if (k < ultimo && pista.punti[k + 1].layer === p.layer) {
        const esito = rifai(k, k + 1);
        if ("blocco" in esito) return bloccato(esito.blocco);
        if (esito.gomito) punti.push(esito.gomito);
      }
      if (k === 0 || k === ultimo) {
        const nelPad = capoInUnPad(modello, pista, { ...arrivo, layer: p.layer });
        if (nelPad) return bloccato(nelPad);
      }
    }
    // where the trace goes through the via on one layer, its two stretches are both drawn again: the corner between them is new
    const acuto = angoloAcutoNuovo(pista.punti, punti);
    if (acuto) {
      return bloccato({
        motivo: "angolo_acuto",
        cosa: cosaPista(pista, 0),
        dove: { x: acuto.x, y: acuto.y, layer: acuto.layer },
        messaggio: `bloccato: la pista ${nomeDellaPista(pista)} farebbe un angolo acuto`,
      });
    }
    piste.push({ pista: i, punti });
  }

  const anello: Pezzo = {
    ...segmento(arrivo, arrivo),
    mezza: via.corona / 2,
    strato: null,
    tipo: "via",
    rete: via.rete,
    foro: via.foro,
    prima: segmento(qui, qui),
    nuovo: false,
  };
  return {
    ok: true,
    piste,
    vie: [{ via: via.indice, da: qui, a: arrivo }],
    spostamento: { x: inMm(V.x - C.x), y: inMm(V.y - C.y) },
    pezzi: [anello, ...pezzi],
    cambiati,
  };
}

/** the block of something joined to a via by its ring alone */
function bloccoDellaTenutaDiVia(modello: Modello, via: ViaDelModello, tenuta: TenutaDellaVia): Blocco {
  if (tenuta.tipo === "pista") {
    const pista = modello.piste[tenuta.pista];
    const tratto = pista.tratti[tenuta.tratto];
    const [a, b] = capiDelTratto(pista, tratto);
    return {
      motivo: "giunzione_a_t",
      cosa: cosaPista(pista, tratto.indice),
      dove: { ...piedeSulSegmento(via.x, via.y, a.x, a.y, b.x, b.y), layer: tratto.strato },
      messaggio: `bloccato: la pista ${nomeDellaPista(pista)} passa sulla via senza un suo vertice`,
    };
  }
  const pad = modello.ostacoli[tenuta.ostacolo] as PadDelModello;
  return {
    motivo: "collegamento",
    cosa: cosaPad(pad),
    dove: { x: pad.forma.x, y: pad.forma.y, ...(pad.strato ? { layer: pad.strato } : {}) },
    messaggio:
      tenuta.tipo === "capo"
        ? `bloccato: la via sta nella piazzola ${pad.nome}, dove finisce la sua pista: spostata, la staccherebbe`
        : `bloccato: la via e' collegata a ${pad.nome} solo perche' lo tocca`,
  };
}
