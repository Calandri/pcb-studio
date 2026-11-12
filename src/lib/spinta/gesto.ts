/**
 * THE GESTURE THAT MOVES COPPER IN "SPOSTA": the four functions the viewer
 * calls (their types are in gesto-tipi.ts, which the viewer shares).
 *
 *   - preseDelRame: what can be grabbed on a board;
 *   - iniziaGesto: the model of the board is read once, when the pointer goes
 *     down, and the thing grabbed says at once whether it can move at all;
 *   - muoviGesto: where the copper stands with the pointer somewhere;
 *   - chiudiGesto: what to save.
 *
 * EVERY POSITION IS WORKED OUT FROM THE START OF THE GESTURE. The model is the
 * board as it was when the pointer went down and is never changed: nothing
 * accumulates, going back is free, and the same pointer place gives the same
 * copper whatever the pointer did before.
 *
 * A VIA CANNOT JUMP PAST A THIN OBSTACLE. The pointer is not followed in one
 * leap: the copper advances toward it in short steps (a quarter of the via's
 * diameter, half the width of a stretch), each solved from the start, and
 * stops at the last one that solves. Then it is brought as near to what blocks
 * as it can go, by halving the last step.
 *
 * Nothing is pushed here: copper of another net nearer than the distance to
 * keep is a block (mosse.ts).
 *
 * COPPER OF THE FILES AND HAND COPPER ARE GRABBED THE SAME WAY, and one gesture
 * can move both (a via of the files with a hand trace ending on it). They are
 * saved apart: the first as corrections (`routes`, `vias`), the hand routes by
 * their key and their new path (`riscritte`).
 *
 * Pure, no React, nothing of the server.
 */
import { DEFAULT_DESIGN_RULES, type DesignRules } from "../design-rules";
import { ingombroForma } from "../drc";
import type {
  BersaglioDelRame,
  BloccoDelGesto,
  PresaDelRame,
  SalvataggioDelGesto,
  StatoDelGesto,
  TrattoInMovimento,
  ViaInMovimento,
} from "./gesto-tipi";
import { capiDelTratto, leggiModello, type Modello } from "./modello";
import { spostaVia, traslaTratto, type Blocco, type EsitoDellaMossa, type RameMosso } from "./mosse";
import { correzioniDellaMossa, riscritteDellaMossa } from "./salvataggio";

declare const sigillo: unique symbol;
/** a gesture in progress: made by iniziaGesto, and read only by the functions of this file */
export interface GestoDelRame {
  readonly [sigillo]: true;
}

interface Interno {
  modello: Modello;
  presa: { tipo: "via"; via: number } | { tipo: "tratto"; pista: number; tratto: number };
  /** where the grabbed thing was when the gesture began: the centre of the via, the middle of the stretch */
  partenza: { x: number; y: number };
  /** for a stretch: the unit vector across it, the only way it moves */
  normale: { x: number; y: number } | null;
  /** how far one step goes at most, mm */
  passo: number;
  /** the traces and the vias the gesture can touch: their places in the model */
  piste: number[];
  vie: number[];
  nascosti: StatoDelGesto["nascosti"];
  /** the copper behind every state handed out, so that closing the gesture need not solve again */
  esiti: WeakMap<StatoDelGesto, RameMosso>;
}

const gesti = new WeakMap<GestoDelRame, Interno>();

const FERMO: RameMosso = { ok: true, piste: [], vie: [], spostamento: { x: 0, y: 0 } };
/** the most steps one movement of the pointer is followed for: 150 mm with the smallest via, far more than a board */
const PASSI_MASSIMI = 2000;
/** how many times the last step is halved to come near what blocks */
const AFFINAMENTI = 6;

const finito = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * What can be grabbed on a board: every via, and every straight stretch of
 * trace. Arcs and stretches that are not at 0, 45 or 90 degrees are left out:
 * they can never move. A thing listed here may still refuse to be grabbed
 * (a stretch that leaves a pad, say): iniziaGesto says why.
 */
export function preseDelRame(circuitJson: unknown[]): BersaglioDelRame[] {
  // which stretch is which does not depend on the rules of the project
  const modello = leggiModello(circuitJson, DEFAULT_DESIGN_RULES);
  const out: BersaglioDelRame[] = [];
  for (const via of modello.vie) {
    if (via.id) out.push({ tipo: "via", pcbViaId: via.id, x: via.x, y: via.y, outerDiameter: via.corona });
  }
  for (const pista of modello.piste) {
    if (!pista.id || pista.arco) continue;
    for (const tratto of pista.tratti) {
      if (!tratto.direzione) continue;
      const [a, b] = capiDelTratto(pista, tratto);
      out.push({
        tipo: "tratto",
        pcbTraceId: pista.id,
        indice: tratto.indiceDiRoute,
        x1: a.x,
        y1: a.y,
        x2: b.x,
        y2: b.y,
        layer: tratto.strato,
        width: pista.larghezza,
      });
    }
  }
  return out;
}

/** the block of a move, as the viewer shows it: the sentence, and where to draw the halo */
function bloccoDelGesto(modello: Modello, blocco: Blocco): BloccoDelGesto {
  const cosa = blocco.cosa;
  if (cosa.tipo === "niente") return { motivo: blocco.messaggio };
  let raggioMm = 0.5;
  if (cosa.tipo === "via") raggioMm = modello.vie[cosa.via].corona / 2;
  else if (cosa.tipo === "pista") raggioMm = Math.max(modello.piste[cosa.pista].larghezza, 0.3);
  else if (cosa.tipo === "pad" || cosa.tipo === "foro") {
    const o = modello.ostacoli[cosa.ostacolo];
    if (o?.tipo === "pad") {
      const box = ingombroForma(o.forma);
      raggioMm = Math.hypot(box.maxX - box.minX, box.maxY - box.minY) / 2;
    } else if (o?.tipo === "foro") {
      raggioMm = Math.hypot(o.foro.bx - o.foro.ax, o.foro.by - o.foro.ay) / 2 + o.foro.r;
    }
  }
  return {
    motivo: blocco.messaggio,
    alone: { x: blocco.dove.x, y: blocco.dove.y, raggioMm, ...(blocco.dove.layer ? { layer: blocco.dove.layer } : {}) },
  };
}

/** the copper of the gesture as it stands after a move: every hidden trace stretch by stretch, every hidden via */
function statoDi(g: Interno, esito: RameMosso, posizione: { x: number; y: number }, blocco: Blocco | null): StatoDelGesto {
  const { modello } = g;
  const mosse = new Map(esito.piste.map((p) => [p.pista, p.punti]));
  const tratti: TrattoInMovimento[] = [];
  for (const i of g.piste) {
    const pista = modello.piste[i];
    const punti = mosse.get(i) ?? pista.punti;
    for (let k = 0; k + 1 < punti.length; k++) {
      const a = punti[k];
      const b = punti[k + 1];
      if (a.layer === b.layer) tratti.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, layer: a.layer, width: pista.larghezza });
    }
  }
  const arrivi = new Map(esito.vie.map((v) => [v.via, v.a]));
  const vie: ViaInMovimento[] = g.vie.map((i) => {
    const via = modello.vie[i];
    const dove = arrivi.get(i) ?? via;
    return { x: dove.x, y: dove.y, outerDiameter: via.corona, holeDiameter: via.foro };
  });
  const stato: StatoDelGesto = {
    nascosti: g.nascosti,
    tratti,
    vie,
    posizione,
    blocco: blocco ? bloccoDelGesto(modello, blocco) : null,
    mosso: esito.piste.length > 0 || esito.vie.length > 0,
  };
  g.esiti.set(stato, esito);
  return stato;
}

/**
 * The gesture starts: the thing under the pointer is found on the board, and
 * asked whether it can move at all. `rifiuto` when it cannot (a stretch that
 * leaves a pad, an arc, copper no correction could be saved for), in words.
 */
export function iniziaGesto(args: {
  circuitJson: unknown[];
  regole: DesignRules;
  presa: PresaDelRame;
}): { gesto: GestoDelRame; stato: StatoDelGesto } | { rifiuto: string } {
  const modello = leggiModello(args.circuitJson, args.regole);
  const { presa } = args;
  let interno: Interno;
  let prova: EsitoDellaMossa;
  if (presa?.tipo === "via") {
    const quale = modello.viaPerId.get(presa.pcbViaId);
    const via = quale === undefined ? undefined : modello.vie[quale];
    if (!via) return { rifiuto: "questa via non e' sulla scheda: ricarica la scheda" };
    // asked for the place where it is: only what does not depend on how far it goes can refuse
    prova = spostaVia(modello, via.indice, via);
    const piste = [...new Set(via.attacchi.map((a) => a.pista))];
    interno = {
      modello,
      presa: { tipo: "via", via: via.indice },
      partenza: { x: via.x, y: via.y },
      normale: null,
      passo: via.corona / 4,
      piste,
      vie: [via.indice],
      nascosti: { pcbTraceIds: piste.map((i) => modello.piste[i].id), pcbViaIds: [via.id] },
      esiti: new WeakMap(),
    };
  } else if (presa?.tipo === "tratto") {
    const quale = modello.pistaPerId.get(presa.pcbTraceId);
    const pista = quale === undefined ? undefined : modello.piste[quale];
    const tratto = pista?.tratti.find((t) => t.indiceDiRoute === presa.indice);
    if (!pista || !tratto) return { rifiuto: "questo tratto non e' sulla scheda: ricarica la scheda" };
    prova = traslaTratto(modello, { pista: pista.indice, tratto: tratto.indice }, { x: 0, y: 0 });
    const [a, b] = capiDelTratto(pista, tratto);
    const lungo = Math.hypot(b.x - a.x, b.y - a.y);
    // its own trace, and the ones chained to it at its two ends: their end stretches follow
    const piste = [pista.indice];
    for (const capo of tratto.capi) {
      if (capo.tipo === "catena" && !piste.includes(capo.pista)) piste.push(capo.pista);
    }
    interno = {
      modello,
      presa: { tipo: "tratto", pista: pista.indice, tratto: tratto.indice },
      partenza: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      normale: { x: -(b.y - a.y) / lungo, y: (b.x - a.x) / lungo },
      passo: pista.larghezza / 2,
      piste,
      vie: [],
      nascosti: { pcbTraceIds: piste.map((i) => modello.piste[i].id), pcbViaIds: [] },
      esiti: new WeakMap(),
    };
  } else {
    return { rifiuto: "non si sa cosa spostare" };
  }
  if (!prova.ok) return { rifiuto: prova.blocco.messaggio };
  const gesto = Object.freeze({}) as GestoDelRame;
  gesti.set(gesto, interno);
  return { gesto, stato: statoDi(interno, FERMO, interno.partenza, null) };
}

/**
 * The copper with the grabbed thing asked to go to `verso`: as far as it gets
 * from the start of the gesture, in short steps, and what stops it there.
 * For a stretch only what `verso` has across the stretch counts.
 */
function risolvi(g: Interno, verso: { x: number; y: number }): { esito: RameMosso; blocco: Blocco | null; posizione: { x: number; y: number } } {
  const { modello, partenza, normale } = g;
  if (!finito(verso?.x) || !finito(verso?.y)) return { esito: FERMO, blocco: null, posizione: partenza };
  const dx = verso.x - partenza.x;
  const dy = verso.y - partenza.y;
  // across the stretch, with its sign; for a via, straight to the place
  const diLato = normale ? dx * normale.x + dy * normale.y : 0;
  const lunga = normale ? Math.abs(diLato) : Math.hypot(dx, dy);
  /** the move with the thing a fraction `t` of the way */
  const mossa = (t: number): EsitoDellaMossa =>
    g.presa.tipo === "via"
      ? spostaVia(modello, g.presa.via, { x: partenza.x + dx * t, y: partenza.y + dy * t })
      : traslaTratto(modello, g.presa, { x: normale!.x * diLato * t, y: normale!.y * diLato * t });

  const passi = Math.max(1, Math.ceil(lunga / g.passo));
  const fin = Math.min(passi, PASSI_MASSIMI);
  let esito = FERMO;
  let blocco: Blocco | null = null;
  let buono = 0;
  for (let i = 1; i <= fin; i++) {
    const t = i / passi;
    const e = mossa(t);
    if (!e.ok) {
      blocco = e.blocco;
      // between the last step that solved and this one: as near to what blocks as it goes
      let cattivo = t;
      for (let n = 0; n < AFFINAMENTI; n++) {
        const meta = (buono + cattivo) / 2;
        const m = mossa(meta);
        if (m.ok) {
          esito = m;
          buono = meta;
        } else {
          blocco = m.blocco;
          cattivo = meta;
        }
      }
      break;
    }
    esito = e;
    buono = t;
  }
  if (!blocco && fin < passi) {
    blocco = { motivo: "fuori_limite", cosa: { tipo: "niente" }, dove: partenza, messaggio: "troppo lontano per un movimento solo: avvicinati a passi" };
  }

  if (g.presa.tipo === "via") {
    return { esito, blocco, posizione: esito.vie[0]?.a ?? partenza };
  }
  // the foot of the pointer on the line the stretch is on now
  const fatto = esito.spostamento.x * normale!.x + esito.spostamento.y * normale!.y;
  return { esito, blocco, posizione: { x: verso.x - normale!.x * (diLato - fatto), y: verso.y - normale!.y * (diLato - fatto) } };
}

/**
 * Where the copper of the gesture stands with the grabbed thing asked to go to
 * `verso` (mm): the centre of a via, any point of the line a stretch is to lie
 * on. Always from the start of the gesture.
 */
export function muoviGesto(gesto: GestoDelRame, verso: { x: number; y: number }): StatoDelGesto {
  const g = gesti.get(gesto);
  if (!g) throw new Error("muoviGesto: il gesto non viene da iniziaGesto");
  const { esito, blocco, posizione } = risolvi(g, verso);
  return statoDi(g, esito, posizione, blocco);
}

/**
 * What the finished gesture asks to be saved, for the state it ended in (one
 * muoviGesto gave); null when nothing moved. `gestoId` is the name of the drag,
 * written on every correction.
 */
export function chiudiGesto(gesto: GestoDelRame, stato: StatoDelGesto, gestoId: string): SalvataggioDelGesto | null {
  const g = gesti.get(gesto);
  if (!g) return null;
  // a state that did not come from here as it is (copied, rebuilt) says where the thing stands: solved again from there
  const esito = g.esiti.get(stato) ?? risolvi(g, stato.posizione).esito;
  if (esito.piste.length === 0 && esito.vie.length === 0) return null;
  // the copper of the files as corrections, the hand routes rewritten by their key
  const rame = correzioniDellaMossa(g.modello, esito, gestoId);
  return { routes: rame.routes, vias: rame.vias, riscritte: riscritteDellaMossa(g.modello, esito) };
}
