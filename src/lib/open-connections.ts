/**
 * THE OPEN CONNECTIONS OF A BOARD, as segments to draw: for every net whose
 * pins are not all on one piece of copper, the shortest straight lines that
 * would join its islands, each between two pads.
 *
 * It reads the saved board and nothing else. The islands are the copper's
 * (gruppi-di-rame.ts): traces, vias, plated holes, pours, pads lying on each
 * other. A net in N islands has N - 1 segments, the cheapest tree over them,
 * so two islands are never joined twice.
 *
 * ONE SOURCE for whoever says what is open: the viewer draws these segments,
 * and the summary of the compile counts and lists them (route-score.ts,
 * unroutedGroups: `unroutedTotal` is how many nets have at least one,
 * `unroutedDetail.points` the two ends of each). The summary used to count on
 * its own, a net with a pour as joined without looking, and to give as points
 * the pads outside the island with the most pins: one side of the gap, not the
 * gap.
 *
 * AND EVERY PIECE OF POUR CUT OFF FROM ITS NET is one more (Niccolo',
 * 2026-11-17: "ogni pour deve essere collegato e non flottante a meno di
 * sceglierlo flottante"). The pieces of a net that hold none of its pins were
 * counted nowhere: a ground pour on inner1 with no via to the rest of the
 * ground was one more island with no pad, and the board said "0 aperti". Now
 * an island with copper of a pour of a net and no pin of that net is a missing
 * connection of that net (colataIsolata), from a point on its copper to the
 * nearest pin of the main part of the net, the island with the most pins. A
 * net with no pin at all (a pour on a net nothing else is on) has every piece
 * of pour missing. A `<copperpour flottante>` floats on purpose and is not
 * said (see FLOTTANTE in pours.ts). The islands are the copper's, so the
 * pieces of one pour, and the tiles of one face that overlap, are one piece
 * where they touch or overlap, and a via, a plated hole or a through pad joins
 * the pieces of every layer it goes through.
 *
 * Nothing here routes or places: these are lines on the screen and numbers in
 * a report.
 */
import { gruppiDiRame, type GruppiDiRame, type GruppoDiRame, type RetiDelCircuito } from "./gruppi-di-rame";
import { areaDelRame, areaDellaColata, puntoSulRame, type PourShape } from "./pours";
import { STRATI_NOTI } from "./strati-rame";

interface El {
  type: string;
  [key: string]: unknown;
}

/** one end of an open connection: a pad */
export interface CapoAperto {
  /** the part and its pin, as on the board: "J1.A9", "R32.1" */
  piedino: string;
  /** pcb_component_id of the part */
  componente: string;
  /** pcb_port_id of the pin */
  porta: string;
  x: number;
  y: number;
  /** the copper layer the pad is on; null for a through hole, which is on every layer */
  strato: string | null;
}

/** the poured copper of an island that does not reach the rest of its net */
export interface ColataIsolata {
  /** the copper layers its pours are on, in the order of the stack */
  strati: string[];
  /** its poured copper in mm², what overlaps counted once */
  areaMm2: number;
  /** a point on its copper, where the viewer marks it, and the layer of that copper */
  x: number;
  y: number;
  strato: string;
  /** its island, a place in GruppiDiRame.gruppi: the viewer draws its pours from there */
  gruppo: number;
  /** pcb_copper_pour_id of its pieces of that net */
  colate: string[];
}

export interface CollegamentoAperto {
  /** the same for the same board: its net and its place among the segments of that net */
  id: string;
  /** the net, as gruppi-di-rame.ts and the viewer's pads name it */
  rete: string;
  /** the net's name (GND, VBUS), "" when it has none */
  nome: string;
  /**
   * The two pads to join. `da` is the end on the smaller island, the one left
   * out: fewer pins, and with as many, less copper.
   */
  da: CapoAperto;
  a: CapoAperto;
  lunghezzaMm: number;
  /**
   * The island left out has poured copper of the net: where it is, on which
   * layers, how big. When its island holds no pin of the net, `da` is a point
   * on that copper (no part, no port) and `a` the nearest pin of the main part
   * of the net, or the same point for a net with no pin at all.
   */
  colata?: ColataIsolata;
}

export interface CollegamentiAperti {
  /** net by net, each net's segments from the shortest tree */
  collegamenti: CollegamentoAperto[];
  /** how many nets have at least one */
  reti: number;
  /**
   * They could not be computed, and why (apertiDellaScheda): the board is
   * drawn all the same and whoever shows them says so, instead of an empty
   * list that reads "nothing is open".
   */
  nonCalcolati?: string;
}

/**
 * The cheapest tree over the islands of one net: N islands, N - 1 segments,
 * each between the two closest pads of the island it adds and of what is
 * already joined. It starts from the island with the most pins.
 */
function alberoFraIsole(isole: CapoAperto[][]): Array<{ da: CapoAperto; a: CapoAperto; d2: number; nuova: number }> {
  const n = isole.length;
  let primo = 0;
  for (let i = 1; i < n; i++) if (isole[i].length > isole[primo].length) primo = i;
  const dentro = new Array<boolean>(n).fill(false);
  const meglio = new Array<{ da: CapoAperto; a: CapoAperto; d2: number } | null>(n).fill(null);
  const avvicina = (k: number) => {
    for (let j = 0; j < n; j++) {
      if (dentro[j]) continue;
      let m = meglio[j];
      for (const p of isole[k]) {
        for (const q of isole[j]) {
          const d2 = (p.x - q.x) * (p.x - q.x) + (p.y - q.y) * (p.y - q.y);
          if (!m || d2 < m.d2) m = { da: p, a: q, d2 };
        }
      }
      meglio[j] = m;
    }
  };
  dentro[primo] = true;
  avvicina(primo);
  const out: Array<{ da: CapoAperto; a: CapoAperto; d2: number; nuova: number }> = [];
  for (let passo = 1; passo < n; passo++) {
    let j = -1;
    for (let i = 0; i < n; i++) {
      if (!dentro[i] && meglio[i] && (j === -1 || meglio[i]!.d2 < meglio[j]!.d2)) j = i;
    }
    if (j === -1) break;
    out.push({ ...meglio[j]!, nuova: j });
    dentro[j] = true;
    avvicina(j);
  }
  return out;
}

/**
 * The name a person knows a pin by, from its pcb port: the part and its pin as
 * on the board, "J1.A9", "R32.1". The port itself when the board names neither.
 */
export function nomiDeiPiedini(circuitJson: unknown[], reti: RetiDelCircuito): (porta: string) => string {
  const els = circuitJson as El[];
  const nomeDelPezzo = new Map<string, string>();
  const pezzoDellaSorgente = new Map<string, string>();
  for (const el of els) {
    if (el.type === "source_component" && el.source_component_id) {
      nomeDelPezzo.set(String(el.source_component_id), String(el.name ?? ""));
    } else if (el.type === "source_port" && el.source_port_id) {
      pezzoDellaSorgente.set(String(el.source_port_id), String(el.source_component_id ?? ""));
    }
  }
  const pezzoDellaPorta = new Map<string, string>();
  for (const el of els) {
    if (el.type !== "pcb_port" || !el.pcb_port_id) continue;
    pezzoDellaPorta.set(
      String(el.pcb_port_id),
      nomeDelPezzo.get(pezzoDellaSorgente.get(String(el.source_port_id ?? "")) ?? "") ?? "",
    );
  }
  return (porta: string): string => {
    const pezzo = pezzoDellaPorta.get(porta) ?? "";
    const pin = (reti.pinDiPorta.get(porta) ?? "").replace(/^pin(\d+)$/i, "$1");
    return pezzo && pin ? `${pezzo}.${pin}` : pezzo || pin || porta;
  };
}

/** the open connections, from the groups of copper already in hand */
export function collegamentiApertiDelRame(circuitJson: unknown[], rame: GruppiDiRame): CollegamentiAperti {
  const piedino = nomiDeiPiedini(circuitJson, rame.reti);

  /** net -> island -> its pads of that net */
  const perRete = new Map<string, Map<number, CapoAperto[]>>();
  for (const g of rame.gruppi) {
    for (const p of g.piazzole) {
      if (!p.rete || !p.porta) continue;
      let isole = perRete.get(p.rete);
      if (!isole) perRete.set(p.rete, (isole = new Map()));
      const capo: CapoAperto = {
        piedino: piedino(p.porta),
        componente: p.componente,
        porta: p.porta,
        x: p.x,
        y: p.y,
        strato: p.strato,
      };
      const lista = isole.get(g.indice);
      if (lista) lista.push(capo);
      else isole.set(g.indice, [capo]);
    }
  }

  /** how big the island of a pin is: its pins of that net first, then its copper */
  const taglia = (rete: string, porta: string): [number, number] => {
    const g = rame.gruppi[rame.diPorta(porta)];
    return [perRete.get(rete)?.get(g.indice)?.length ?? 0, g.tratti.length + g.vie.length + g.colate.length];
  };

  const collegamenti: CollegamentoAperto[] = [];
  const aperte = new Set<string>();
  for (const [rete, isole] of perRete) {
    if (isole.size < 2) continue;
    aperte.add(rete);
    const nome = rame.reti.nome(rete);
    /** the island of each entry of the tree */
    const diIsola = [...isole.keys()];
    alberoFraIsole([...isole.values()]).forEach((s, i) => {
      const [pa, ra] = taglia(rete, s.da.porta);
      const [pb, rb] = taglia(rete, s.a.porta);
      const gira = pb < pa || (pb === pa && rb < ra);
      // the island it adds has a pour of the net: where it is, so a pin left out in a piece of pour is seen as such
      const colata = colataDellIsola(rame.gruppi[diIsola[s.nuova]], rete, false);
      collegamenti.push({
        id: `${nome || rete}#${i}`,
        rete,
        nome,
        da: gira ? s.a : s.da,
        a: gira ? s.da : s.a,
        lunghezzaMm: Math.sqrt(s.d2),
        ...(colata ? { colata } : {}),
      });
    });
  }

  /*
   * THE PIECES OF POUR THAT REACH NO PIN OF THEIR NET: one missing connection
   * each, from a point on its copper to the nearest pin of the main part of the
   * net, the island with the most of its pins (the one the tree above starts
   * from). After the others, so a board with none lists what it listed before.
   */
  const perReteSenza = new Map<string, number>();
  for (const g of rame.gruppi) {
    for (const rete of retiDelleColate(g)) {
      if (g.piazzole.some((p) => p.rete === rete && p.porta)) continue;
      const colata = colataDellIsola(g, rete, true);
      if (!colata) continue;
      aperte.add(rete);
      const nome = rame.reti.nome(rete) || (rete.startsWith("net:") ? rete.slice(4) : "");
      const k = perReteSenza.get(rete) ?? 0;
      perReteSenza.set(rete, k + 1);
      const isole = perRete.get(rete);
      let principale: CapoAperto[] = [];
      for (const pins of isole?.values() ?? []) if (pins.length > principale.length) principale = pins;
      const da: CapoAperto = {
        // where it is, in the words of the lists that name the pins left out (export, panel)
        piedino: testoDellaColata(colata),
        componente: "",
        porta: "",
        x: colata.x,
        y: colata.y,
        strato: colata.strato,
      };
      let a = da;
      let d2 = 0;
      for (const p of principale) {
        const q = (p.x - da.x) * (p.x - da.x) + (p.y - da.y) * (p.y - da.y);
        if (a === da || q < d2) {
          a = p;
          d2 = q;
        }
      }
      collegamenti.push({ id: `${nome || rete}#colata${k}`, rete, nome, da, a, lunghezzaMm: Math.sqrt(d2), colata });
    }
  }
  return { collegamenti, reti: aperte.size };
}

/** a layer's place in the stack, top first, as an order to sort by */
const ordineStrato = (s: string) => {
  const i = (STRATI_NOTI as readonly string[]).indexOf(s);
  return i < 0 ? STRATI_NOTI.length : i;
};

/**
 * The net of a pour on its island: the one it declares, else the island's own;
 * "" for copper that names none, on an island of none (it floats all the same).
 */
const reteDellaColata = (g: GruppoDiRame, c: GruppoDiRame["colate"][number]) => c.reteDichiarata ?? g.reti[0] ?? "";

/** the nets an island has pours of */
const retiDelleColate = (g: GruppoDiRame): string[] => [...new Set(g.colate.map((c) => reteDellaColata(g, c)))];

/** the pours of that net on an island */
const colateDellaRete = (g: GruppoDiRame, rete: string) => g.colate.filter((c) => reteDellaColata(g, c) === rete);

/**
 * The poured copper of a net on an island, told as a missing connection:
 * layers, area (per layer, overlaps counted once), a point on the biggest
 * piece. Null when the island has no pour of that net, or, when `perSe` (an
 * island that is missing by its pour alone), when every pour of that net on it
 * floats on purpose.
 */
function colataDellIsola(g: GruppoDiRame, rete: string, perSe: boolean): ColataIsolata | null {
  const colate = colateDellaRete(g, rete);
  if (colate.length === 0) return null;
  if (perSe && colate.every((c) => c.flottante)) return null;
  const perStrato = new Map<string, PourShape[]>();
  for (const c of colate) {
    const lista = perStrato.get(c.strato);
    if (lista) lista.push(c.forma);
    else perStrato.set(c.strato, [c.forma]);
  }
  let areaMm2 = 0;
  for (const forme of perStrato.values()) areaMm2 += areaDelRame(forme);
  let grande = colate[0];
  let suaArea = areaDellaColata(grande.forma);
  for (const c of colate.slice(1)) {
    const a = areaDellaColata(c.forma);
    if (a > suaArea) {
      grande = c;
      suaArea = a;
    }
  }
  const punto = puntoSulRame(grande.forma);
  return {
    strati: [...perStrato.keys()].sort((a, b) => ordineStrato(a) - ordineStrato(b)),
    areaMm2,
    x: punto.x,
    y: punto.y,
    strato: grande.strato,
    gruppo: g.indice,
    colate: colate.map((c) => c.id),
  };
}

/**
 * A piece of pour cut off from its net, in words: net, layers, area and the
 * point to look at, "colata isolata GND su inner1, 3.42 mm², in (12.30, -4.10)".
 * The same words in the summary of the compile, the refusal of the export and
 * the list of the viewer.
 */
export function descriviColataIsolata(c: Pick<CollegamentoAperto, "nome" | "colata">): string {
  return c.colata ? testoDellaColata(c.colata, c.nome || "senza nome") : "";
}

/** the same words, with the net when it is given */
function testoDellaColata(k: ColataIsolata, nome?: string): string {
  return (
    `colata isolata ${nome ? `${nome} ` : ""}su ${k.strati.join(" + ")}, ${k.areaMm2.toFixed(2)} mm², ` +
    `in (${k.x.toFixed(2)}, ${k.y.toFixed(2)})`
  );
}

/**
 * The open connections of a saved board, from its Circuit JSON alone: for
 * every net, the groups of pads the copper joins (traces, vias, pours, plated
 * holes, pads lying on each other) and, between them, the shortest segments
 * that would make the net one, with the layer of each end, the net's name and
 * the two pins.
 */
export function collegamentiAperti(circuitJson: unknown[]): CollegamentiAperti {
  return collegamentiApertiDelRame(circuitJson, gruppiDiRame(circuitJson));
}

/*
 * ONCE PER BOARD. The board on screen is one array, replaced when a new compile
 * is loaded: whoever asks about the same array (the canvas of Guarda, the one
 * of Sposta, the panel) gets the answer computed the first time.
 *
 * AND NEVER A BLANK PAGE. These are asked for while the page and the canvas
 * are being drawn: a board this code cannot read must cost the lines, not the
 * view. The failure is kept with the board and said (nonCalcolati).
 */
const diScheda = new WeakMap<object, { rame: GruppiDiRame | null; errore?: string; aperti?: CollegamentiAperti }>();

function calcolata(circuitJson: unknown[]) {
  let s = diScheda.get(circuitJson);
  if (!s) {
    try {
      s = { rame: gruppiDiRame(circuitJson) };
    } catch (err) {
      console.error("gruppi di rame non calcolati:", err);
      s = { rame: null, errore: (err instanceof Error ? err.message : String(err)).slice(0, 120) };
    }
    diScheda.set(circuitJson, s);
  }
  return s;
}

/** the groups of copper of the board on screen, computed once per board; null when they could not be computed */
export function rameDellaScheda(circuitJson: unknown[]): GruppiDiRame | null {
  return calcolata(circuitJson).rame;
}

/** the open connections of the board on screen, computed once per board */
export function apertiDellaScheda(circuitJson: unknown[] | null): CollegamentiAperti {
  if (!circuitJson) return { collegamenti: [], reti: 0 };
  const s = calcolata(circuitJson);
  if (!s.aperti) {
    try {
      if (!s.rame) throw new Error(s.errore);
      s.aperti = collegamentiApertiDelRame(circuitJson, s.rame);
    } catch (err) {
      if (s.rame) console.error("collegamenti aperti non calcolati:", err);
      s.aperti = { collegamenti: [], reti: 0, nonCalcolati: (err instanceof Error ? err.message : String(err)).slice(0, 120) };
    }
  }
  return s.aperti;
}
