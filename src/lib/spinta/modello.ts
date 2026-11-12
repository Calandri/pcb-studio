/**
 * THE COPPER OF A BOARD AS THE GESTURE SEES IT: the model "spingi e sposta"
 * solves on. Read from the Circuit JSON of the saved board, not from the scene
 * of the viewer, which breaks a trace where it changes layer and drops its
 * vias.
 *
 *   - the traces, each a polyline with its vias in their place, its width, its
 *     net and the NAME of its connection (part and pin: the key a correction is
 *     saved by, see ManualRoute.replaces). Copper that is already a hand route
 *     of manual-edits.json (drawn in Instrada, imported from another CAD) says
 *     the key of that route instead: it is not corrected, its route is
 *     rewritten;
 *   - the vias, with hole, ring and net. A compiled via has no name and no net
 *     of its own: the net is read the way gruppi-di-rame.ts reads it;
 *   - what does not move: pads, plated and bare holes with their exact shape,
 *     the outline of the board, its cutouts, its keepouts;
 *   - the rules of the project.
 *
 * AND WHAT DECIDES A BLOCK, known here once so that no move has to look for
 * it: where each stretch ends (a corner of its own trace, a via, a pad, the
 * end of one other trace, a T junction, nothing), what is joined to it along
 * its run with no corner there (a T junction, a via it runs through, a pad it
 * runs over), whether it is at 0, 45 or 90 degrees on the grid, whether its
 * trace is an arc, and whether that trace could be saved moved at all.
 *
 * Coordinates are millimetres to 0.0001, the grid of a correction: the path of
 * a trace is the one percorsoDellaPista gives, which is what `replaces.original`
 * must say. The points of a hand route stand on every tenth of those, 0.001 mm. Nothing here is ever written back: the ids are the ones of THIS
 * board, good to find a trace from the scene and for nothing else.
 *
 * No React, nothing of the server: the model is built in the viewer when a
 * gesture starts.
 */
import type { DesignRules } from "../design-rules";
import {
  contornoScheda,
  distanzaPuntoForma,
  distanzaSegmentoForma,
  foroDi,
  ingombroForma,
  pointSegDistance,
  rameDelForo,
  rameDelPad,
  type Capsula,
  type FormaRame,
} from "../drc";
import { RETE_SCRIVIBILE } from "../ground-stitching-file";
import { CONTATTO_MM, Griglia, retiDelCircuito } from "../gruppi-di-rame";
import { partenzaRicordata, percorsoDellaPista, ROUTE_LIMITS, round4, type ManualRoutePoint } from "../manual-routes";
import { nomiDeiPiedini } from "../open-connections";
import { eStratoDiRame, stratiDiRame } from "../strati-rame";
import { sagomaDiZona, type Sagoma } from "../zona";
import { direzioneVicina, inUnita, scatolaDellaZona, type Direzione, type Punto } from "./geometria";
import { connessioneScritta, larghezza as larghezzaScrivibile, misureDellaVia } from "./verifica";

type El = { type: string; [key: string]: unknown };

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** what stands at one end of a stretch */
export type Capo =
  /** a corner of the trace: its next stretch, on the same layer, starts here */
  | { tipo: "vertice" }
  /** a via stands here: the trace changes layer in it, ends on it, or goes through it */
  | { tipo: "via"; via: number }
  /** the trace ends here, in the copper of a pad or of a plated hole (its place in `ostacoli`) */
  | { tipo: "pad"; ostacolo: number }
  /**
   * The trace ends here, and so does ONE other trace, on the same layer: the
   * two are one run of copper drawn in two pieces (the routes of an imported
   * net are chained like this). That stretch of the other trace is the
   * neighbour of this one, as the next stretch of its own trace would be;
   * `lato` says which of its two ends stands here.
   */
  | { tipo: "catena"; pista: number; tratto: number; lato: 0 | 1 }
  /** the trace ends here on another trace, or where two or more others end: a T junction */
  | { tipo: "giunzione"; pista: number; tratto: number }
  /** the trace ends here on nothing, or changes layer where the board has no via */
  | { tipo: "libero" };

/** copper joined to a stretch along its run, with no corner of the stretch's trace there */
export type Tenuta =
  /** another trace ends on it, at this place: a T junction */
  | { tipo: "pista"; pista: number; x: number; y: number }
  /** it runs through the ring of a via its trace has no corner in */
  | { tipo: "via"; via: number }
  /** it runs over a pad of its net its trace has no end in */
  | { tipo: "pad"; ostacolo: number };

/** copper that holds a via where it is: joined to it by its ring alone, or through the end of a trace that stands in it */
export type TenutaDellaVia =
  /** a trace that runs through the ring with no corner at the centre */
  | { tipo: "pista"; pista: number; tratto: number }
  /** a pad of its net it stands on, which none of its traces reaches */
  | { tipo: "pad"; ostacolo: number }
  /** a trace ends at its centre INSIDE a pad: the via in the pad is what joins that pad, and the end would leave the pad with it */
  | { tipo: "capo"; ostacolo: number; pista: number };

/** one stretch of a trace: the copper between two points of its path, on one layer */
export interface TrattoDelModello {
  /** its place among the stretches of its trace */
  indice: number;
  /** the two points of the path it joins: `punti[da]` and `punti[da + 1]` */
  da: number;
  /** the index, in the `route` of its pcb_trace, of the point it starts from (it ends at the next): how the viewer names a stretch */
  indiceDiRoute: number;
  strato: ManualRoutePoint["layer"];
  /**
   * From `punti[da]` to `punti[da + 1]`: the direction it has, exactly or within
   * a micron (see direzioneVicina). Null when it is at none: such a stretch is
   * a given where it is, and blocks only a move that would have to read its
   * direction.
   */
  direzione: Direzione | null;
  /** what stands at `punti[da]` and at `punti[da + 1]` */
  capi: [Capo, Capo];
  tiene: Tenuta[];
}

export interface PistaDelModello {
  /** its place in `piste` */
  indice: number;
  /** pcb_trace_id: the id it has on THIS board, to find it from the scene; never saved */
  id: string;
  /** the name of its connection, by part and pin (".R1 > .pin1 to net.GND"); "" when the board gives it none */
  connessione: string;
  /** its net, as retiDelCircuito names it; null when the board does not say */
  rete: string | null;
  /** the name of that net (GND, P3V3), "" when it has none */
  nomeRete: string;
  /** mm; the widest when its stretches differ (the trace is then `ferma`) */
  larghezza: number;
  /** the path, as a correction stores it: mm to 0.0001, a via where two points share a place on two layers */
  punti: ManualRoutePoint[];
  tratti: TrattoDelModello[];
  /** a curve drawn as chords: none of its stretches has a direction to keep */
  arco: boolean;
  /** its first stretch that is at none of 0, 45 or 90 degrees, not even by a hair; -1 when all are */
  storto: number;
  /** the size of the vias it changes layer in; null when it has none */
  via: { diametro: number; foro: number } | null;
  /** why this trace could not be saved moved, in words; null when it can */
  ferma: string | null;
  /** the pads its two ends stand in (their places in `ostacoli`) */
  padDeiCapi: number[];
  /**
   * The key of the hand route this copper was laid for, as the file holds it
   * (the `manual_route_id` of the trace): a route drawn in Instrada or
   * imported, with no `replaces`. Moved, that route is rewritten in its place.
   * null for copper of the files and for the copper of a correction of it,
   * which are saved as corrections.
   */
  aMano: string | null;
  /** the grid its points stand on, in units: 1 for copper saved as a correction (0.0001 mm), 10 for a hand route (0.001 mm, as the file reads it) */
  griglia: number;
}

export interface ViaDelModello {
  /** its place in `vie` */
  indice: number;
  /** pcb_via_id: the id it has on THIS board; never saved */
  id: string;
  x: number;
  y: number;
  /** diameters, mm */
  foro: number;
  corona: number;
  strati: string[];
  rete: string | null;
  nomeRete: string;
  /**
   * Whether a trace changes layer in it (a via point of a route). Such a via
   * travels with the path of its trace; a lone one, with an entry of
   * `pcb_vias` (applyManualRoutes, rule 2).
   */
  diPista: boolean;
  /**
   * Laid by applyManualRoutes where hand copper changes layer (`manual`): the
   * file has no entry for it, it is wherever those traces change layer, and it
   * is laid again at every pass.
   */
  aMano: boolean;
  /** every point of a trace that stands at its centre: the trace, and which point of its path */
  attacchi: Array<{ pista: number; punto: number }>;
  tiene: TenutaDellaVia[];
  /** why it could not be saved moved, in words; null when it can */
  ferma: string | null;
}

/** an SMT pad, or the copper of a plated hole */
export interface PadDelModello {
  tipo: "pad";
  indice: number;
  /** pcb_smtpad_id or pcb_plated_hole_id */
  id: string;
  /** the part and its pin, as on the board: "U3.4" */
  nome: string;
  forma: FormaRame;
  /** the layer its copper is on; null for copper on every layer (a plated hole, a pad that names no layer) */
  strato: string | null;
  rete: string | null;
  /** the drill of a plated hole */
  foro: Capsula | null;
  passante: boolean;
}

/** a hole with no copper */
export interface ForoDelModello {
  tipo: "foro";
  indice: number;
  id: string;
  foro: Capsula;
}

/** a zone copper stays out of: a keepout of some layers, or a cutout of the board (an edge inside it) */
export interface ZonaDelModello {
  tipo: "keepout" | "ritaglio";
  indice: number;
  id: string;
  sagoma: Sagoma;
  /** the layers a keepout is of; null for every layer */
  strati: string[] | null;
}

export type Ostacolo = PadDelModello | ForoDelModello | ZonaDelModello;

export interface Modello {
  regole: DesignRules;
  /** the copper layers of the board, top first */
  strati: string[];
  piste: PistaDelModello[];
  vie: ViaDelModello[];
  /** what does not move */
  ostacoli: Ostacolo[];
  /** the outline of the board, mm; empty when the board has none */
  contorno: Punto[];
  /** a trace and a via by the id the scene of the viewer knows them by: their place in `piste` and in `vie` */
  pistaPerId: Map<string, number>;
  viaPerId: Map<string, number>;
  /** what is near a box of the board, for the moves: the stretches, the vias and the obstacles whose copper meets it */
  vicino: {
    tratti: Griglia<{ pista: number; tratto: number }>;
    vie: Griglia<number>;
    ostacoli: Griglia<number>;
  };
}

/** the two ends of a stretch, mm */
export function capiDelTratto(pista: PistaDelModello, tratto: TrattoDelModello): [ManualRoutePoint, ManualRoutePoint] {
  return [pista.punti[tratto.da], pista.punti[tratto.da + 1]];
}

/** whether two pieces of copper are on one net: both must say which, and say the same */
export const stessaRete = (a: string | null, b: string | null): boolean => a !== null && a === b;

/** whether copper on these two layers can touch: null stands for every layer */
const stratiSiToccano = (a: string | null, b: string | null): boolean => a === null || b === null || a === b;

const chiave = (x: number, y: number): string => `${inUnita(x)},${inUnita(y)}`;

/**
 * Reads the model of a board. Elements that are not what they say (a pad with
 * no shape, a via with no place, a number that is not one) are left out, never
 * thrown: a broken board gives a smaller model, and what cannot be moved safely
 * says why (`ferma`).
 */
export function leggiModello(circuitJson: unknown[], regole: DesignRules): Modello {
  const els = (Array.isArray(circuitJson) ? circuitJson : []).filter(
    (e): e is El => typeof e === "object" && e !== null && typeof (e as El).type === "string",
  );
  const reti = retiDelCircuito(els);
  const piedino = nomiDeiPiedini(els, reti);
  const scheda = els.find((e) => e.type === "pcb_board");
  const strati = stratiDiRame(Number(scheda?.num_layers ?? 2));

  // --- what does not move
  const ostacoli: Ostacolo[] = [];
  const grigliaOstacoli = new Griglia<number>();
  const metti = (o: Ostacolo, box: { minX: number; maxX: number; minY: number; maxY: number }) => {
    ostacoli.push(o);
    grigliaOstacoli.aggiungi(box.minX, box.minY, box.maxX, box.maxY, o.indice);
  };
  const scatolaDelForo = (c: Capsula) => ({
    minX: Math.min(c.ax, c.bx) - c.r,
    maxX: Math.max(c.ax, c.bx) + c.r,
    minY: Math.min(c.ay, c.by) - c.r,
    maxY: Math.max(c.ay, c.by) + c.r,
  });
  for (const el of els) {
    if (el.type === "pcb_smtpad" || el.type === "pcb_plated_hole") {
      const passante = el.type === "pcb_plated_hole";
      const forma = passante ? rameDelForo(el) : rameDelPad(el);
      const foro = passante ? foroDi(el) : null;
      const id = String(el.pcb_smtpad_id ?? el.pcb_plated_hole_id ?? "");
      if (!forma) {
        // a plated hole whose copper cannot be read is still a drill
        if (foro) metti({ tipo: "foro", indice: ostacoli.length, id, foro }, scatolaDelForo(foro));
        continue;
      }
      const porta = el.pcb_port_id ? String(el.pcb_port_id) : "";
      metti(
        {
          tipo: "pad",
          indice: ostacoli.length,
          id,
          nome: porta ? piedino(porta) : id || "pad",
          forma,
          strato: passante ? null : el.layer ? String(el.layer) : null,
          rete: (porta && reti.diPorta.get(porta)) || null,
          foro,
          passante,
        },
        ingombroForma(forma),
      );
    } else if (el.type === "pcb_hole") {
      const foro = foroDi(el);
      if (foro) metti({ tipo: "foro", indice: ostacoli.length, id: String(el.pcb_hole_id ?? ""), foro }, scatolaDelForo(foro));
    } else if (el.type === "pcb_keepout" || el.type === "pcb_cutout") {
      const sagoma = sagomaDiZona(el);
      if (!sagoma) continue;
      const keepout = el.type === "pcb_keepout";
      // only the layers of this board; a keepout that names none of them is one of the whole board (as ground-stitching.ts reads it)
      const suoi = keepout && Array.isArray(el.layers) ? strati.filter((s) => (el.layers as unknown[]).map(String).includes(s)) : [];
      metti(
        {
          tipo: keepout ? "keepout" : "ritaglio",
          indice: ostacoli.length,
          id: String(el.pcb_keepout_id ?? el.pcb_cutout_id ?? ""),
          sagoma,
          strati: suoi.length > 0 ? suoi : null,
        },
        scatolaDellaZona(sagoma),
      );
    }
  }

  // --- the vias
  const vie: ViaDelModello[] = [];
  const grigliaVie = new Griglia<number>();
  /** the via at a place of the grid; a second one in the same place is not a via of its own */
  const viaIn = new Map<string, number>();
  const viaPerId = new Map<string, number>();
  /** the name of the net each via declares by itself, which is the one a moved via is saved and found again by */
  const nomeDichiarato: string[] = [];
  for (const el of els) {
    if (el.type !== "pcb_via") continue;
    const x = num(el.x);
    const y = num(el.y);
    const corona = num(el.outer_diameter) ?? num(el.hole_diameter);
    if (x === null || y === null || corona === null || corona <= 0) continue;
    const foro = num(el.hole_diameter) ?? regole.minViaHoleMm;
    const rete = reti.diVia(el);
    const suoi = Array.isArray(el.layers) ? [...new Set((el.layers as unknown[]).map(String))] : [];
    const via: ViaDelModello = {
      indice: vie.length,
      id: String(el.pcb_via_id ?? ""),
      x: round4(x),
      y: round4(y),
      foro,
      corona,
      strati: suoi.length >= 2 ? suoi : [...strati],
      rete,
      nomeRete: rete ? reti.nome(rete) : "",
      diPista: false,
      aMano: el.manual === true,
      attacchi: [],
      tiene: [],
      ferma: null,
    };
    const dove = chiave(via.x, via.y);
    const gia = viaIn.get(dove);
    if (gia !== undefined) {
      // two holes in one place: neither can be told from the other by where it is, which is all a correction says
      via.ferma = vie[gia].ferma = "due vie stanno nello stesso posto";
    } else {
      viaIn.set(dove, via.indice);
    }
    if (Math.abs(via.x) > ROUTE_LIMITS.maxCoordMm || Math.abs(via.y) > ROUTE_LIMITS.maxCoordMm) via.ferma ??= "la via sta oltre il metro";
    /*
     * The size of the via as the board says it. One that does not say its hole
     * is drawn with the smallest the rules allow, and is not moved: what a
     * move saves is the via as it is, never a size guessed from the rules (and
     * so no refusal known from the board depends on them: see preseDelRame).
     */
    const misure = num(el.hole_diameter) === null ? "la via non dice il diametro del suo foro" : misureDellaVia(corona, foro);
    if (typeof misure === "string") via.ferma ??= misure;
    if (!via.strati.every(eStratoDiRame) || via.strati.length > 8) via.ferma ??= "la via nomina uno strato che non e' di rame";
    vie.push(via);
    nomeDichiarato.push(via.nomeRete);
    if (via.id) viaPerId.set(via.id, via.indice);
    grigliaVie.aggiungi(via.x - corona / 2, via.y - corona / 2, via.x + corona / 2, via.y + corona / 2, via.indice);
  }

  // --- the traces
  const nomeDellaConnessione = new Map<string, string>();
  for (const el of els) {
    if (el.type === "source_trace" && typeof el.source_trace_id === "string" && typeof el.display_name === "string") {
      nomeDellaConnessione.set(el.source_trace_id, el.display_name);
    }
  }
  const piste: PistaDelModello[] = [];
  const pistaPerId = new Map<string, number>();
  const grigliaTratti = new Griglia<{ pista: number; tratto: number }>();
  /** which point of which trace stands at a via, to tell a corner from a via further down */
  const suVia = new Map<PistaDelModello, Array<number | undefined>>();
  /** the vias a trace of the files (or the copper of a correction) changes layer in, and the ones hand copper does */
  const cambioDeiFile = new Set<number>();
  const cambioAMano = new Set<number>();
  /** how many traces carry each key of a hand route */
  const conLaChiave = new Map<string, number>();
  for (const el of els) {
    if (el.type !== "pcb_trace") continue;
    const punti = percorsoDellaPista(el);
    if (punti.length < 2) continue;
    const route = (Array.isArray(el.route) ? el.route : []) as Array<Record<string, unknown>>;
    const rete = reti.diTraccia(el);
    const connessione = nomeDellaConnessione.get(String(el.source_trace_id ?? "")) ?? "";
    const larghezze = route.filter((p) => p.route_type !== "via").map((p) => num(p.width)).filter((w): w is number => w !== null);
    const larga = larghezze.length > 0 ? Math.max(...larghezze) : regole.minTraceWidthMm;

    let ferma: string | null = null;
    const perche = (motivo: string) => {
      ferma ??= motivo;
    };
    /*
     * HAND COPPER: laid for a route of manual-edits.json that is not a
     * correction (no `replaces`). It is found again by the key of that route,
     * which its copper carries, and nothing else of it is saved: not its
     * connection, which need not have a name with part and pin.
     */
    const aMano = el.manual === true && partenzaRicordata(el) === null;
    const chiaveDellaRoute = aMano && typeof el.manual_route_id === "string" && el.manual_route_id ? el.manual_route_id : null;
    if (aMano && chiaveDellaRoute === null) perche("la pista a mano non porta la chiave della sua route: premi Aggiorna");
    if (chiaveDellaRoute !== null) conLaChiave.set(chiaveDellaRoute, (conLaChiave.get(chiaveDellaRoute) ?? 0) + 1);
    // a hand route is read from the file to the micron: a point between two microns would not come back where it was written
    if (aMano && punti.some((q) => inUnita(q.x) % 10 !== 0 || inUnita(q.y) % 10 !== 0)) perche("la pista a mano ha un punto fuori dalla griglia di 0,001 mm");
    if (!aMano && !connessioneScritta(connessione)) perche("la connessione della pista non ha un nome con pezzo e piedino");
    if (larghezze.some((w) => Math.abs(w - larga) > 1e-9)) perche("la pista cambia larghezza lungo il percorso");
    // the same for a trace that does not say how wide it is: drawn at the minimum of the rules, not moved
    if (larghezze.length === 0) perche("la pista non dice la sua larghezza");
    else if (typeof larghezzaScrivibile(larga) === "string") perche(String(larghezzaScrivibile(larga)));
    if (punti.some((p) => Math.abs(p.x) > ROUTE_LIMITS.maxCoordMm || Math.abs(p.y) > ROUTE_LIMITS.maxCoordMm)) perche("la pista va oltre il metro");
    if (punti.some((p) => !eStratoDiRame(p.layer))) perche("la pista nomina uno strato che non e' di rame");
    // a via point the path does not go through (at an end, or with no change of layer): the path a correction saves would lose it
    for (const [i, p] of route.entries()) {
      if (p.route_type !== "via") continue;
      const prima = route[i - 1];
      const dopo = route[i + 1];
      const li = (q: Record<string, unknown> | undefined) =>
        q !== undefined && q.route_type !== "via" && num(q.x) !== null && num(q.y) !== null && chiave(num(q.x)!, num(q.y)!) === chiave(num(p.x) ?? NaN, num(p.y) ?? NaN);
      if (!li(prima) || !li(dopo) || String(prima?.layer ?? "top") === String(dopo?.layer ?? "top")) {
        perche("la pista ha una via che il suo percorso non attraversa");
      }
      const via = viaIn.get(chiave(num(p.x) ?? NaN, num(p.y) ?? NaN));
      if (via !== undefined) {
        vie[via].diPista = true;
        (aMano ? cambioAMano : cambioDeiFile).add(via);
      }
    }

    const pista: PistaDelModello = {
      indice: piste.length,
      id: String(el.pcb_trace_id ?? ""),
      connessione,
      rete,
      nomeRete: rete ? reti.nome(rete) : "",
      larghezza: larga,
      punti,
      tratti: [],
      arco: el.arco === true,
      storto: -1,
      via: null,
      ferma: null,
      padDeiCapi: [],
      aMano: chiaveDellaRoute,
      griglia: aMano ? 10 : 1,
    };
    // which point of the `route` each point of the path is: the last of the wires that stand in that place (the path drops repeats and via points)
    const inRoute: number[] = [];
    let quale = -1;
    for (const [i, p] of route.entries()) {
      const x = num(p.x);
      const y = num(p.y);
      if (p.route_type === "via" || x === null || y === null) continue;
      const gia = quale >= 0 && punti[quale].x === round4(x) && punti[quale].y === round4(y) && punti[quale].layer === String(p.layer ?? "top");
      if (!gia) quale++;
      inRoute[quale] = i;
    }
    const sulleVie = punti.map((p) => viaIn.get(chiave(p.x, p.y)));
    suVia.set(pista, sulleVie);
    for (const [k, via] of sulleVie.entries()) {
      if (via !== undefined) vie[via].attacchi.push({ pista: pista.indice, punto: k });
    }
    for (let k = 0; k + 1 < punti.length; k++) {
      const a = punti[k];
      const b = punti[k + 1];
      if (a.layer !== b.layer) {
        // a change of layer: in one place, and in a via of the board
        const via = sulleVie[k];
        if (a.x !== b.x || a.y !== b.y) perche("la pista cambia strato fra due posti");
        else if (via === undefined) perche("la pista cambia strato dove la scheda non ha una via");
        else {
          const misura = { diametro: vie[via].corona, foro: vie[via].foro };
          // a correction says one size for its vias; a hand route keeps in the file whatever it says
          if (!aMano && pista.via && (Math.abs(pista.via.diametro - misura.diametro) > 1e-9 || Math.abs(pista.via.foro - misura.foro) > 1e-9)) {
            perche("le vie della pista non hanno tutte la stessa misura");
          }
          pista.via ??= misura;
        }
        continue;
      }
      const direzione = direzioneVicina({ x: inUnita(a.x), y: inUnita(a.y) }, { x: inUnita(b.x), y: inUnita(b.y) });
      if (!direzione && pista.storto < 0) pista.storto = pista.tratti.length;
      const tratto: TrattoDelModello = {
        indice: pista.tratti.length,
        da: k,
        indiceDiRoute: inRoute[k] ?? k,
        strato: a.layer,
        direzione,
        capi: [{ tipo: "libero" }, { tipo: "libero" }],
        tiene: [],
      };
      pista.tratti.push(tratto);
      grigliaTratti.aggiungi(
        Math.min(a.x, b.x) - larga / 2,
        Math.min(a.y, b.y) - larga / 2,
        Math.max(a.x, b.x) + larga / 2,
        Math.max(a.y, b.y) + larga / 2,
        { pista: pista.indice, tratto: tratto.indice },
      );
    }
    pista.ferma = ferma;
    piste.push(pista);
    if (pista.id) pistaPerId.set(pista.id, pista.indice);
  }

  // two traces with one key: the file holds that route twice, and rewriting it by its key would not say which
  for (const pista of piste) {
    if (pista.aMano !== null && (conLaChiave.get(pista.aMano) ?? 0) > 1) pista.ferma ??= "due piste a mano hanno la stessa chiave nel file";
  }

  for (const via of vie) {
    if (via.aMano) {
      // it is laid where a trace changes layer: with none it is copper no route describes any more
      if (!via.diPista) via.ferma ??= "la via a mano non ha una pista che cambi strato in lei: premi Aggiorna";
    } else if (!via.diPista) {
      /*
       * A lone via is saved by the NAME of its net (ManualViaMove.net) and found
       * again by the net the element declares (applyManualRoutes, rule 2): the
       * net of the copper it touches would not find it.
       */
      if (!RETE_SCRIVIBILE.test(nomeDichiarato[via.indice])) via.ferma ??= "la via non e' di una rete con un nome";
    } else if (cambioAMano.has(via.indice) && !cambioDeiFile.has(via.indice)) {
      /*
       * A via of the files that only hand copper changes layer in. The hand
       * route would be rewritten with its change of layer elsewhere, and get a
       * via of its own there; this one would stay where the files put it: an
       * entry of `pcb_vias` moves a via no trace goes through (rule 2).
       */
      via.ferma ??= "la via e' dei file e ci cambia strato solo una pista a mano: spostata, resterebbe dov'e'";
    }
    // for the distances, a via that names no net is on the net of the trace that stands in it
    if (via.rete !== null) continue;
    const sua = via.attacchi.map((a) => piste[a.pista]).find((p) => p.rete !== null);
    if (sua) {
      via.rete = sua.rete;
      via.nomeRete = sua.nomeRete;
    }
  }

  // --- the ends of every stretch
  /** the pad a point of a layer stands in: one of the net first */
  const padSotto = (p: ManualRoutePoint, rete: string | null): number | null => {
    let trovato: number | null = null;
    for (const i of grigliaOstacoli.vicini(p.x, p.y, p.x, p.y)) {
      const o = ostacoli[i];
      if (o.tipo !== "pad" || !stratiSiToccano(o.strato, p.layer) || distanzaPuntoForma(o.forma, p.x, p.y) > 1e-6) continue;
      if (stessaRete(o.rete, rete)) return i;
      trovato ??= i;
    }
    return trovato;
  };
  for (const pista of piste) {
    const sulleVie = suVia.get(pista)!;
    const ultimo = pista.punti.length - 1;
    // the pads its two ends stand in; a trace with no stretch (the route of a via) has ends all the same
    const padDelCapo = new Map<number, number | null>();
    for (const k of new Set([0, ultimo])) {
      const pad = padSotto(pista.punti[k], pista.rete);
      padDelCapo.set(k, pad);
      if (pad === null) continue;
      if (!pista.padDeiCapi.includes(pad)) pista.padDeiCapi.push(pad);
      const via = sulleVie[k];
      if (via !== undefined && !vie[via].tiene.some((t) => t.tipo === "capo" && t.ostacolo === pad)) {
        vie[via].tiene.push({ tipo: "capo", ostacolo: pad, pista: pista.indice });
      }
    }
    for (const tratto of pista.tratti) {
      for (const lato of [0, 1] as const) {
        const k = tratto.da + lato;
        const via = sulleVie[k];
        if (k === 0 || k === ultimo) {
          const pad = padDelCapo.get(k) ?? null;
          tratto.capi[lato] = via !== undefined ? { tipo: "via", via } : pad !== null ? { tipo: "pad", ostacolo: pad } : { tipo: "libero" };
        } else if (via !== undefined) {
          tratto.capi[lato] = { tipo: "via", via };
        } else if (pista.punti[k - 1].layer === pista.punti[k].layer && pista.punti[k].layer === pista.punti[k + 1].layer) {
          tratto.capi[lato] = { tipo: "vertice" };
        }
      }
    }
  }

  // --- what is joined to a stretch with no corner there
  const compatibili = (a: string | null, b: string | null): boolean => a === null || b === null || a === b;
  /*
   * 1. THE ENDS OF THE TRACES that stand on no via and in no pad, and what
   * each meets there on its layer:
   *   - the run of another trace, somewhere along it: a T junction, and that
   *     run holds this end;
   *   - the end of ONE other trace: the two are one run of copper in two
   *     pieces, each the neighbour of the other (see Capo, "catena");
   *   - the ends of two or more others: a T junction made of ends.
   */
  interface CapoDiPista {
    pista: PistaDelModello;
    tratto: TrattoDelModello;
    lato: 0 | 1;
    punto: ManualRoutePoint;
  }
  const capiLiberi = new Map<string, CapoDiPista[]>();
  for (const pista of piste) {
    for (const tratto of new Set([pista.tratti[0], pista.tratti[pista.tratti.length - 1]])) {
      if (!tratto) continue;
      for (const lato of [0, 1] as const) {
        const k = tratto.da + lato;
        if ((k !== 0 && k !== pista.punti.length - 1) || tratto.capi[lato].tipo !== "libero") continue;
        const punto = pista.punti[k];
        const dove = `${chiave(punto.x, punto.y)}|${punto.layer}`;
        const li = capiLiberi.get(dove);
        if (li) li.push({ pista, tratto, lato, punto });
        else capiLiberi.set(dove, [{ pista, tratto, lato, punto }]);
      }
    }
  }
  for (const capi of capiLiberi.values()) {
    for (const { pista, tratto, lato, punto } of capi) {
      // the ends of other traces that stand in this same place
      const insieme = capi.filter((c) => c.pista !== pista && compatibili(c.pista.rete, pista.rete));
      const mezza = pista.larghezza / 2;
      let aT: { pista: number; tratto: number } | null = null;
      for (const rif of grigliaTratti.vicini(punto.x - mezza, punto.y - mezza, punto.x + mezza, punto.y + mezza)) {
        if (rif.pista === pista.indice) continue;
        const altra = piste[rif.pista];
        const suo = altra.tratti[rif.tratto];
        if (suo.strato !== punto.layer || !compatibili(altra.rete, pista.rete)) continue;
        // a stretch that ends here as well is met end to end, not run into
        if (insieme.some((c) => c.tratto === suo)) continue;
        const [a, b] = capiDelTratto(altra, suo);
        if (pointSegDistance(punto.x, punto.y, a.x, a.y, b.x, b.y) > mezza + altra.larghezza / 2 + CONTATTO_MM) continue;
        suo.tiene.push({ tipo: "pista", pista: pista.indice, x: punto.x, y: punto.y });
        aT ??= { pista: altra.indice, tratto: suo.indice };
      }
      if (aT) tratto.capi[lato] = { tipo: "giunzione", ...aT };
      else if (insieme.length === 1) tratto.capi[lato] = { tipo: "catena", pista: insieme[0].pista.indice, tratto: insieme[0].tratto.indice, lato: insieme[0].lato };
      else if (insieme.length > 1) tratto.capi[lato] = { tipo: "giunzione", pista: insieme[0].pista.indice, tratto: insieme[0].tratto.indice };
    }
  }
  // 2. a via a trace runs through without a corner at its centre
  for (const via of vie) {
    const attaccate = new Set(via.attacchi.map((a) => a.pista));
    const r = via.corona / 2;
    for (const rif of grigliaTratti.vicini(via.x - r, via.y - r, via.x + r, via.y + r)) {
      if (attaccate.has(rif.pista)) continue;
      const pista = piste[rif.pista];
      if (!compatibili(pista.rete, via.rete)) continue;
      const tratto = pista.tratti[rif.tratto];
      const [a, b] = capiDelTratto(pista, tratto);
      if (pointSegDistance(via.x, via.y, a.x, a.y, b.x, b.y) > r + pista.larghezza / 2 + CONTATTO_MM) continue;
      tratto.tiene.push({ tipo: "via", via: via.indice });
      via.tiene.push({ tipo: "pista", pista: pista.indice, tratto: tratto.indice });
    }
  }
  // 3. a pad of its net a trace runs over without ending in it, and a pad a via stands on that none of its traces reaches
  const tocca = (pad: PadDelModello, pista: PistaDelModello, tratto: TrattoDelModello): boolean => {
    if (!stratiSiToccano(pad.strato, tratto.strato)) return false;
    const [a, b] = capiDelTratto(pista, tratto);
    return distanzaSegmentoForma(pad.forma, a.x, a.y, b.x, b.y) <= pista.larghezza / 2 + CONTATTO_MM;
  };
  for (const pad of ostacoli) {
    if (pad.tipo !== "pad" || pad.rete === null) continue;
    const box = ingombroForma(pad.forma);
    for (const rif of grigliaTratti.vicini(box.minX, box.minY, box.maxX, box.maxY)) {
      const pista = piste[rif.pista];
      if (pista.rete !== pad.rete || pista.padDeiCapi.includes(pad.indice)) continue;
      const tratto = pista.tratti[rif.tratto];
      if (tocca(pad, pista, tratto)) tratto.tiene.push({ tipo: "pad", ostacolo: pad.indice });
    }
    for (const i of grigliaVie.vicini(box.minX, box.minY, box.maxX, box.maxY)) {
      const via = vie[i];
      if (via.rete !== pad.rete || distanzaPuntoForma(pad.forma, via.x, via.y) > via.corona / 2 + CONTATTO_MM) continue;
      const servita = via.attacchi.some((a) => {
        const pista = piste[a.pista];
        return pista.padDeiCapi.includes(pad.indice) || pista.tratti.some((t) => tocca(pad, pista, t));
      });
      if (!servita) via.tiene.push({ tipo: "pad", ostacolo: pad.indice });
    }
  }

  return {
    regole,
    strati,
    piste,
    vie,
    ostacoli,
    contorno: contornoScheda(scheda),
    pistaPerId,
    viaPerId,
    vicino: { tratti: grigliaTratti, vie: grigliaVie, ostacoli: grigliaOstacoli },
  };
}
