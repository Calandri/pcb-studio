/**
 * THE CHAIN OF PUSHES: the copper in hand moves (a via, a stretch: mosse.ts),
 * and the traces of other nets it comes too close to step aside, each by the
 * least it takes, and push the ones behind them in turn.
 *
 * WHAT IS PUSHED. Only a stretch of a trace of another net that can slide
 * (move 1 can take it: it leaves no pad, ends on no via, is on no T junction).
 * It slides along its normal, its neighbours get longer or shorter, no
 * direction changes: the same move the hand makes, so the copper it leaves is
 * as exact and is saved the same way. Everything else BLOCKS as it always did:
 * pads, holes, vias, the edge, keepouts, and every stretch that cannot slide.
 *
 * FROM THE START, AND ALONG THE WAY THE COPPER CAME. Every solve starts from
 * the board as it was when the gesture began, so a pushed trace goes back by
 * itself when the pointer does. A solve from the start does not remember that
 * a trace was pushed a step ago, and a pusher that is by now PAST the place
 * the trace had would find it far behind and leave it there, on the wrong
 * side. So a trace is not measured against where the pusher is but against
 * the whole way it came since the start: the area its copper swept. A stretch
 * in that area is pushed out of it, to the side it stood on when the gesture
 * began, always that one.
 *
 * NO PING-PONG. Every trace moved has its turn: the copper in hand first, then
 * each pushed trace in the order it was first pushed, the nearest to what
 * pushes before the ones behind it. Between two pieces that are too close the
 * earlier turn pushes and the later gives way, and the hand never does. A
 * stretch pushed one way in a solve is only ever pushed further that way:
 * asked to go back, it is squeezed, and that is a block. And three limits (how
 * deep the chain, counted in ranks: the hand 0, what it pushes 1, what that
 * pushes 2; how many pushes; how long) end any solve that does not end by
 * itself, with a block that names the trace it stopped on.
 *
 * The result is the result of a move (mosse.ts) with the pushed traces among
 * its copper. Deterministic: the same model and the same move give the same
 * answer, but for the limit of time, which is far from what a board takes.
 *
 * No React, nothing of the server.
 */
import { distanzaMinimaFra } from "../design-rules";
import type { ManualRoutePoint } from "../manual-routes";
import { dentroPoligono, distanzaSegmenti, puntoVicino, UNITA_PER_MM, type Direzione } from "./geometria";
import { capiDelTratto, stessaRete, type Modello, type PistaDelModello } from "./modello";
import {
  cosaPista,
  distanzaDaTenere,
  EPS_MM,
  geometriaDellaVia,
  geometriaDelTratto,
  giudica,
  nomeDellaPista,
  segmento,
  type Blocco,
  type EsitoDellaMossa,
  type Geometria,
  type MotivoDelBlocco,
  type Pezzo,
  type Segmento,
} from "./mosse";

/** how deep a chain goes: the copper in hand pushes a trace, that one another, at most this many in a row */
export const PROFONDITA_MASSIMA = 8;
/** how many pushes one position of the pointer may take in all */
export const SPINTE_MASSIME = 60;
/** how long one movement of the pointer may be worked on, ms: a guard against a board that never settles, far above what a board takes */
export const TEMPO_MASSIMO_MS = 150;

export interface LimitiDellaSpinta {
  profondita: number;
  spinte: number;
  tempoMs: number;
}
const LIMITI: LimitiDellaSpinta = { profondita: PROFONDITA_MASSIMA, spinte: SPINTE_MASSIME, tempoMs: TEMPO_MASSIMO_MS };

/** how many times the place of one pushed stretch is corrected before it is said to have no room */
const TENTATIVI = 200;
/** the side of the squares the stretches that can give way are looked up by, mm: wide, so that the lookups of one drag are few */
const QUADRO_MM = 4;

const adesso = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());
/** a stretch of the model as one number */
const chiaveDi = (pista: number, tratto: number): number => pista * 65536 + tratto;

/** a piece of copper this solve has moved, with the turn of its trace and the name it goes by in the solve */
interface InMoto extends Pezzo {
  /** 0 for the copper in hand, then 1, 2... in the order the traces were first pushed: the lower pushes the higher */
  turno: number;
  nome: string;
}

/** one solve: the board as the pushes have left it so far */
interface Risoluzione {
  /** the paths of the traces moved so far, the ones in hand first */
  percorsi: Map<number, ManualRoutePoint[]>;
  inMoto: Map<string, InMoto>;
  /** the stretches of the model that are no longer where the model has them */
  cambiati: Set<number>;
  /** the side each pushed stretch goes to: along its normal, or against it */
  segno: Map<number, number>;
  /** the turn of each trace moved (see InMoto), and its rank: how many pushes in a row lead to it from the hand */
  turno: Map<number, number>;
  rango: Map<number, number>;
  /** how many traces have been pushed so far: the turn of the last */
  turni: number;
  spinte: number;
  manoPiste: Set<number>;
  manoVie: Set<number>;
  coda: string[];
  inCoda: Set<string>;
  inizio: number;
  salta: (pista: number, tratto: number) => boolean;
}

/**
 * How far a segment is from the area the core of a piece swept, from where it
 * was at the start of the gesture to where it is: 0 inside it.
 */
function distanzaDalPercorso(p: Pezzo, s: Segmento): number {
  const q = p.prima;
  if (q.ax === p.ax && q.ay === p.ay && q.bx === p.bx && q.by === p.by) return distanzaSegmenti(p.ax, p.ay, p.bx, p.by, s.ax, s.ay, s.bx, s.by);
  // a ring: the line its centre went along
  if (p.ax === p.bx && p.ay === p.by && q.ax === q.bx && q.ay === q.by) return distanzaSegmenti(q.ax, q.ay, p.ax, p.ay, s.ax, s.ay, s.bx, s.by);
  const giro = [
    { x: q.ax, y: q.ay },
    { x: q.bx, y: q.by },
    { x: p.bx, y: p.by },
    { x: p.ax, y: p.ay },
  ];
  if (dentroPoligono(s.ax, s.ay, giro) || dentroPoligono(s.bx, s.by, giro)) return 0;
  let d = Infinity;
  for (let i = 0; i < 4 && d > 0; i++) {
    const a = giro[i];
    const b = giro[(i + 1) % 4];
    d = Math.min(d, distanzaSegmenti(a.x, a.y, b.x, b.y, s.ax, s.ay, s.bx, s.by));
  }
  return d;
}

/** on which side of a pusher a stretch stands, along the normal `n` of the stretch: 1, -1, or 0 when the pusher is in line with it */
function latoDi(chi: Segmento, v: Segmento, n: { x: number; y: number }): number {
  const suChi = puntoVicino(v.ax, v.ay, v.bx, v.by, chi.ax, chi.ay, chi.bx, chi.by);
  const suLei = puntoVicino(chi.ax, chi.ay, chi.bx, chi.by, v.ax, v.ay, v.bx, v.by);
  const lungo = (suLei.x - suChi.x) * n.x + (suLei.y - suChi.y) * n.y;
  return lungo > 1e-9 ? 1 : lungo < -1e-9 ? -1 : 0;
}

/**
 * How well sliding a stretch takes it away from a pusher, 0 to 1: 1 when the
 * pusher faces it, 0 when it is in line with it and sliding only carries its
 * end along. The stretches that face what pushes go first: often that makes
 * room for the ones next to them as well.
 */
function resa(chi: Segmento, v: Segmento, d: Direzione): number {
  // the pusher is across it: any way out is as good as another
  if (distanzaSegmenti(chi.ax, chi.ay, chi.bx, chi.by, v.ax, v.ay, v.bx, v.by) === 0) return 1;
  const suChi = puntoVicino(v.ax, v.ay, v.bx, v.by, chi.ax, chi.ay, chi.bx, chi.by);
  const suLei = puntoVicino(chi.ax, chi.ay, chi.bx, chi.by, v.ax, v.ay, v.bx, v.by);
  const dx = suLei.x - suChi.x;
  const dy = suLei.y - suChi.y;
  const lunga = Math.hypot(dx, dy);
  return lunga < 1e-9 ? 1 : Math.abs(-d.dy * dx + d.dx * dy) / (lunga * Math.hypot(d.dx, d.dy));
}

/**
 * The solver of one gesture: it holds the model the gesture began on, and what
 * is asked of it over and over while the pointer moves (which stretches can
 * give way, which are near a place).
 */
export class Risolutore {
  private readonly cede = new Map<number, boolean>();
  private readonly quadri = new Map<string, Array<{ pista: number; tratto: number }>>();
  /** the furthest any copper is kept from a trace */
  private readonly portata: number;

  constructor(
    private readonly modello: Modello,
    private readonly limiti: LimitiDellaSpinta = LIMITI,
  ) {
    this.portata = Math.max(distanzaDaTenere(modello, "trace", "trace"), distanzaDaTenere(modello, "via", "trace"));
  }

  /** move 2 with the push: the via goes to `a`, and the traces in its way step aside. `inizio`: when the movement of the pointer began to be worked on */
  spostaVia(quale: number, a: { x: number; y: number }, inizio: number = adesso()): EsitoDellaMossa {
    const mano = geometriaDellaVia(this.modello, quale, a);
    return mano.ok ? this.catena(mano, inizio) : mano;
  }

  /** move 1 with the push: the stretch slides, and the traces in its way step aside */
  traslaTratto(presa: { pista: number; tratto: number }, spostamento: { x: number; y: number }, inizio: number = adesso()): EsitoDellaMossa {
    const mano = geometriaDelTratto(this.modello, presa, spostamento);
    return mano.ok ? this.catena(mano, inizio) : mano;
  }

  /** whether a stretch can slide at all, whatever pushes it: asked of the model, once */
  private cedevole(pista: number, tratto: number): boolean {
    const k = chiaveDi(pista, tratto);
    let si = this.cede.get(k);
    if (si === undefined) {
      si = geometriaDelTratto(this.modello, { pista, tratto }, { x: 0, y: 0 }).ok;
      this.cede.set(k, si);
    }
    return si;
  }

  /** the stretches that can give way near a box of the board: looked up by wide squares and kept, the same few squares come back at every step of a drag */
  private quadro(minX: number, minY: number, maxX: number, maxY: number): Array<{ pista: number; tratto: number }> {
    const x0 = Math.floor(minX / QUADRO_MM);
    const y0 = Math.floor(minY / QUADRO_MM);
    const x1 = Math.floor(maxX / QUADRO_MM);
    const y1 = Math.floor(maxY / QUADRO_MM);
    const nome = `${x0},${y0},${x1},${y1}`;
    let suoi = this.quadri.get(nome);
    if (!suoi) {
      suoi = [];
      for (const rif of this.modello.vicino.tratti.vicini(x0 * QUADRO_MM, y0 * QUADRO_MM, (x1 + 1) * QUADRO_MM, (y1 + 1) * QUADRO_MM)) {
        if (this.cedevole(rif.pista, rif.tratto)) suoi.push(rif);
      }
      // in the order of the model, whatever order the grid gives them in
      suoi.sort((a, b) => a.pista - b.pista || a.tratto - b.tratto);
      if (this.quadri.size > 256) this.quadri.clear();
      this.quadri.set(nome, suoi);
    }
    return suoi;
  }

  /** the air between a pusher, all along the way it came, and a stretch of trace half `mezza` wide */
  private luce(chi: Pezzo, s: Segmento, mezza: number): number {
    return distanzaDalPercorso(chi, s) - chi.mezza - mezza;
  }

  /**
   * The air a pusher must leave to a stretch that was at `prima` when the
   * gesture began: the distance to keep, or as little as there was at the
   * start (see `giudica` in mosse.ts: the same rule).
   */
  private soglia(chi: Pezzo, prima: Segmento, mezza: number): number {
    const serve = distanzaDaTenere(this.modello, chi.tipo, "trace");
    const q = chi.prima;
    const era = distanzaSegmenti(q.ax, q.ay, q.bx, q.by, prima.ax, prima.ay, prima.bx, prima.by) - chi.mezza - mezza;
    return chi.nuovo ? Math.min(serve, Math.max(era, distanzaMinimaFra(this.modello.regole, chi.tipo, "trace"))) : Math.min(serve, era);
  }

  /** a block met while pushing a trace, said with the name of the trace that has no room */
  private conNome(blocco: Blocco, pista: PistaDelModello): Blocco {
    if (blocco.cosa.tipo === "pista" && blocco.cosa.pista === pista.indice) return blocco;
    return { ...blocco, messaggio: `${blocco.messaggio}: la pista ${nomeDellaPista(pista)} non ha spazio` };
  }

  /** the copper in hand as it goes, and every trace it has to push: the whole chain, or what stops it */
  private catena(mano: Geometria, inizio: number): EsitoDellaMossa {
    const { modello } = this;
    if (mano.pezzi.length === 0) return { ok: true, piste: mano.piste, vie: mano.vie, spostamento: mano.spostamento };
    const r: Risoluzione = {
      percorsi: new Map(mano.piste.map((m) => [m.pista, m.punti])),
      inMoto: new Map(),
      cambiati: new Set(mano.cambiati.map((c) => chiaveDi(c.pista, c.tratto))),
      segno: new Map(),
      turno: new Map(mano.piste.map((m) => [m.pista, 0])),
      rango: new Map(mano.piste.map((m) => [m.pista, 0])),
      turni: 0,
      spinte: 0,
      manoPiste: new Set(mano.piste.map((m) => m.pista)),
      manoVie: new Set(mano.vie.map((v) => v.via)),
      coda: [],
      inCoda: new Set(),
      inizio,
      salta: (pista, tratto) => r.cambiati.has(chiaveDi(pista, tratto)) || (!r.manoPiste.has(pista) && this.cedevole(pista, tratto)),
    };
    mano.pezzi.forEach((p, i) => {
      const nome = `m${i}`;
      r.inMoto.set(nome, { ...p, turno: 0, nome });
      r.coda.push(nome);
      r.inCoda.add(nome);
    });
    // what cannot give way stops the hand as it always did
    const fermo = giudica(modello, mano.pezzi, { piste: r.manoPiste, vie: r.manoVie, salta: r.salta });
    if (fermo) return { ok: false, blocco: fermo };

    while (r.coda.length > 0) {
      const nome = r.coda.shift()!;
      r.inCoda.delete(nome);
      const blocco = this.sistema(r, nome);
      if (blocco) return { ok: false, blocco };
    }
    return { ok: true, piste: [...r.percorsi].map(([pista, punti]) => ({ pista, punti })), vie: mano.vie, spostamento: mano.spostamento };
  }

  /** one piece of moved copper against every trace of another net it is too close to: each is pushed, or the block */
  private sistema(r: Risoluzione, nome: string): Blocco | null {
    const p = r.inMoto.get(nome);
    if (!p) return null;
    const { modello } = this;
    const urti: Array<{ chi: string; pista: number; tratto: number; resa: number; lontana: number }> = [];
    /** how far a stretch was from a pusher when the gesture began: the nearer is pushed first, and pushes the ones behind it */
    const lontananza = (chi: Pezzo, prima: Segmento): number => distanzaSegmenti(chi.prima.ax, chi.prima.ay, chi.prima.bx, chi.prima.by, prima.ax, prima.ay, prima.bx, prima.by);
    // the box of the whole way the piece came
    const largo = p.mezza + this.portata;
    const q = p.prima;
    const minX = Math.min(p.ax, p.bx, q.ax, q.bx) - largo;
    const maxX = Math.max(p.ax, p.bx, q.ax, q.bx) + largo;
    const minY = Math.min(p.ay, p.by, q.ay, q.by) - largo;
    const maxY = Math.max(p.ay, p.by, q.ay, q.by) + largo;

    // the stretches that can give way and are still where the model has them
    for (const rif of this.quadro(minX, minY, maxX, maxY)) {
      if (rif.pista === p.pista || r.manoPiste.has(rif.pista) || r.cambiati.has(chiaveDi(rif.pista, rif.tratto))) continue;
      const altra = modello.piste[rif.pista];
      if (stessaRete(altra.rete, p.rete)) continue;
      const suo = altra.tratti[rif.tratto];
      if (p.strato !== null && suo.strato !== p.strato) continue;
      const [c, d] = capiDelTratto(altra, suo);
      const mezza = altra.larghezza / 2;
      if (Math.max(c.x, d.x) + mezza < minX || Math.min(c.x, d.x) - mezza > maxX || Math.max(c.y, d.y) + mezza < minY || Math.min(c.y, d.y) - mezza > maxY) continue;
      const s = segmento(c, d);
      if (this.luce(p, s, mezza) >= this.soglia(p, s, mezza) - EPS_MM) continue;
      urti.push({ chi: nome, pista: rif.pista, tratto: rif.tratto, resa: resa(p, s, suo.direzione!), lontana: lontananza(p, s) });
    }

    // the copper this solve has moved already: the earlier turn pushes, and the copper in hand never gives way
    for (const o of r.inMoto.values()) {
      if (o === p || (o.pista !== undefined && o.pista === p.pista) || stessaRete(o.rete, p.rete)) continue;
      if (p.strato !== null && o.strato !== null && o.strato !== p.strato) continue;
      if (o.turno === p.turno) continue;
      const [chi, lei] = o.turno < p.turno ? [o, p] : [p, o];
      if (lei.pista === undefined || lei.tratto === undefined) continue;
      if (this.luce(chi, lei, lei.mezza) >= this.soglia(chi, lei.prima, lei.mezza) - EPS_MM) continue;
      urti.push({
        chi: chi.nome,
        pista: lei.pista,
        tratto: lei.tratto,
        resa: resa(chi, lei, modello.piste[lei.pista].tratti[lei.tratto].direzione!),
        lontana: lontananza(chi, lei.prima),
      });
    }

    // the stretches that face what pushes first, and among them the nearest
    urti.sort((a, b) => b.resa - a.resa || a.lontana - b.lontana || a.pista - b.pista || a.tratto - b.tratto);
    for (const u of urti) {
      const blocco = this.spingi(r, u.chi, u.pista, u.tratto);
      if (blocco) return blocco;
    }
    return null;
  }

  /**
   * One push: the stretch slides away from what pushes it, by the least that
   * leaves the air to keep, and the copper it leaves is judged against all
   * that cannot give way. Null when it is done (or was not needed any more),
   * else the block.
   */
  private spingi(r: Risoluzione, nomeDiChi: string, pista: number, tratto: number): Blocco | null {
    const chi = r.inMoto.get(nomeDiChi);
    if (!chi) return null;
    const { modello, limiti } = this;
    const sua = modello.piste[pista];
    const suo = sua.tratti[tratto];
    const mezza = sua.larghezza / 2;
    const prima = segmento(...capiDelTratto(sua, suo));
    const punti = r.percorsi.get(pista) ?? sua.punti;
    const qui = segmento(punti[suo.da], punti[suo.da + 1]);
    const soglia = this.soglia(chi, prima, mezza);
    let luce = this.luce(chi, qui, mezza);
    // an earlier push made room already
    if (luce >= soglia - EPS_MM) return null;

    const nome = nomeDellaPista(sua);
    const cosa = cosaPista(sua, tratto);
    const dove = { x: (qui.ax + qui.bx) / 2, y: (qui.ay + qui.by) / 2, layer: suo.strato };
    const senzaSpazio = (motivo: MotivoDelBlocco, perche = ""): Blocco => ({ motivo, cosa, dove, messaggio: `bloccato: la pista ${nome} non ha spazio${perche}` });
    if (r.manoPiste.has(pista) || !this.cedevole(pista, tratto)) {
      // a stretch that cannot slide: whatever was pushed against it stops there
      const fermo: Blocco = { motivo: "pista", cosa, dove, messaggio: `bloccato dalla pista ${nome}` };
      return chi.turno > 0 && chi.pista !== undefined ? this.conNome(fermo, modello.piste[chi.pista]) : fermo;
    }
    if (adesso() - r.inizio > limiti.tempoMs) return senzaSpazio("catena", ` (il calcolo supera ${limiti.tempoMs} ms)`);
    if (r.spinte >= limiti.spinte) return senzaSpazio("catena", ` (piu' di ${limiti.spinte} spinte in un movimento)`);
    const rango = Math.max(r.rango.get(pista) ?? 0, (chi.pista === undefined ? 0 : (r.rango.get(chi.pista) ?? 0)) + 1);
    if (rango > limiti.profondita) return senzaSpazio("catena", ` (la catena di spinte supera ${limiti.profondita} piste)`);

    // to the side it stood on when the gesture began, always that one
    const d = suo.direzione!;
    const lunga = Math.hypot(d.dx, d.dy);
    const n = { x: -d.dy / lunga, y: d.dx / lunga };
    const lato = latoDi(chi.prima, prima, n) || latoDi(chi, prima, n);
    const k = chiaveDi(pista, tratto);
    const gia = r.segno.get(k);
    if (lato === 0) return senzaSpazio("stretta");
    if (gia !== undefined && gia !== lato) return { motivo: "stretta", cosa, dove, messaggio: `bloccato: la pista ${nome} e' stretta fra due spinte opposte` };

    // the least it takes: further by what is missing, until nothing is
    let quanto = 0;
    let geo: Geometria | null = null;
    let inutili = 0;
    for (let giro = 0; giro < TENTATIVI && luce < soglia - EPS_MM && inutili < 8; giro++) {
      quanto += Math.max(soglia - luce, 1 / UNITA_PER_MM);
      const prova = geometriaDelTratto(modello, { pista, tratto }, { x: n.x * lato * quanto, y: n.y * lato * quanto }, { percorsi: r.percorsi, almeno: true });
      if (!prova.ok) return this.conNome(prova.blocco, sua);
      const pezzo = prova.pezzi.find((x) => x.pista === pista && x.tratto === tratto);
      if (!pezzo) return senzaSpazio("pista");
      geo = prova;
      quanto = Math.hypot(prova.spostamento.x, prova.spostamento.y);
      const ora = this.luce(chi, pezzo, mezza);
      // sliding further that does not take it away from what pushes: its end is only carried along (while the pusher is across it, the air cannot grow yet)
      inutili = ora > luce + EPS_MM || ora <= -chi.mezza - mezza + EPS_MM ? 0 : inutili + 1;
      luce = ora;
    }
    if (!geo || luce < soglia - EPS_MM) return senzaSpazio("pista");

    // the copper in hand is never dragged along by a trace chained to it
    if (geo.piste.some((m) => r.manoPiste.has(m.pista))) return senzaSpazio("pista");
    // what the push leaves, against everything that cannot give way
    const fermo = giudica(modello, geo.pezzi, { piste: new Set(geo.piste.map((m) => m.pista)), vie: r.manoVie, salta: r.salta });
    if (fermo) return this.conNome(fermo, sua);

    r.spinte++;
    r.segno.set(k, lato);
    const turno = r.turno.get(pista) ?? ++r.turni;
    for (const m of geo.piste) {
      r.percorsi.set(m.pista, m.punti);
      if (!r.turno.has(m.pista)) r.turno.set(m.pista, turno);
      r.rango.set(m.pista, Math.max(r.rango.get(m.pista) ?? 0, rango));
    }
    for (const x of geo.pezzi) {
      const kk = chiaveDi(x.pista!, x.tratto!);
      r.cambiati.add(kk);
      const suoNome = `t${kk}`;
      r.inMoto.set(suoNome, { ...x, turno: r.turno.get(x.pista!)!, nome: suoNome });
      if (!r.inCoda.has(suoNome)) {
        r.coda.push(suoNome);
        r.inCoda.add(suoNome);
      }
    }
    return null;
  }
}
