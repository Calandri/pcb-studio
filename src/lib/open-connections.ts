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
 * Nothing here routes or places: these are lines on the screen and numbers in
 * a report.
 */
import { gruppiDiRame, type GruppiDiRame, type RetiDelCircuito } from "./gruppi-di-rame";

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
function alberoFraIsole(isole: CapoAperto[][]): Array<{ da: CapoAperto; a: CapoAperto; d2: number }> {
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
  const out: Array<{ da: CapoAperto; a: CapoAperto; d2: number }> = [];
  for (let passo = 1; passo < n; passo++) {
    let j = -1;
    for (let i = 0; i < n; i++) {
      if (!dentro[i] && meglio[i] && (j === -1 || meglio[i]!.d2 < meglio[j]!.d2)) j = i;
    }
    if (j === -1) break;
    out.push(meglio[j]!);
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
  let reti = 0;
  for (const [rete, isole] of perRete) {
    if (isole.size < 2) continue;
    reti++;
    const nome = rame.reti.nome(rete);
    alberoFraIsole([...isole.values()]).forEach((s, i) => {
      const [pa, ra] = taglia(rete, s.da.porta);
      const [pb, rb] = taglia(rete, s.a.porta);
      const gira = pb < pa || (pb === pa && rb < ra);
      collegamenti.push({
        id: `${nome || rete}#${i}`,
        rete,
        nome,
        da: gira ? s.a : s.da,
        a: gira ? s.da : s.a,
        lunghezzaMm: Math.sqrt(s.d2),
      });
    });
  }
  return { collegamenti, reti };
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
