/**
 * THE COPPER OF A BOARD, GROUPED: which pads, traces, vias and pours are one
 * piece of copper, and which net each of them belongs to.
 *
 * Two questions live here, because everything that draws or checks a board
 * asks them and each place used to answer on its own:
 *
 * - WHICH NET (retiDelCircuito): the pins a schematic trace joins, directly or
 *   through a named net, are one net; a via, a trace and a pour are brought
 *   back to it from whatever they carry (a connectivity key, `net:<id>`, the
 *   router's `source_net_3_mst0`, the `source_net_3` a `<via>` writes in
 *   `pcb_trace_id`, a source trace, a port).
 * - WHICH COPPER (gruppiDiRame): the islands the Gerber will draw. Every trace
 *   is one piece; it touches a pad when a segment reaches the pad's copper on
 *   the same layer; two traces touch where the end of one lands on the other;
 *   a via and a plated hole join every layer; a pour joins what stands in it.
 *
 * The islands are the ones the compile counts the open connections with
 * (route-score.ts, unroutedGroups): that code is here now, and it reads it
 * from here with `isoleDiRame`, which joins exactly what it always joined.
 * `gruppiDiRame` joins what that count leaves out as well: the poured copper,
 * two pads lying on each other, a via written inside a route sitting in a pad.
 *
 * Still on their own: `groupOfTrace` in drc.ts, `gruppi` in
 * ground-stitching.ts and the port maps of house-rules.ts name the net of a
 * piece of copper in their own way.
 */
import {
  distanzaPuntoForma,
  distanzaSegmentoForma,
  ingombroForma,
  pointSegDistance,
  rameDelForo,
  rameDelPad,
  type FormaRame,
} from "./drc";
import { insidePour, readPours, type PourShape } from "./pours";

interface El {
  type: string;
  [key: string]: unknown;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

// ---------------------------------------------------------------------------
// Which net
// ---------------------------------------------------------------------------

export interface RetiDelCircuito {
  /**
   * The net of every pcb port. Two ports with the same value must be joined by
   * copper. A pin no trace names is a net of its own (its source port); a pcb
   * port with no source port has "".
   */
  diPorta: Map<string, string>;
  /** the name of that net (GND, P3V3...), "" when it has none */
  nomeDiPorta: Map<string, string>;
  /** the name of the pin of every pcb port, as on the schematic: VDD, pin3, A9 */
  pinDiPorta: Map<string, string>;
  /** the name of a net, "" when it has none */
  nome(rete: string): string;
  /** whether at least one trace names that net: the net of a pin left alone is only the pin itself */
  eRete(rete: string): boolean;
  /**
   * The net a key speaks of: a connectivity key, `net:<source_net_id>`, the
   * router's `source_net_3_mst0`, a bare `source_net_3`, a source trace or a
   * source port. null when it names nothing on this board.
   */
  diChiave(chiave: string): string | null;
  /** the net of a pcb_trace: its source trace, else its key */
  diTraccia(el: El): string | null;
  /**
   * The net of a pcb_via: its connectivity key, else the `source_net_*` a
   * `<via>` writes in `pcb_trace_id` (it has no name and no `source_net_id`),
   * else its port. null when the element does not say.
   */
  diVia(el: El): string | null;
  /** the net of a pcb_copper_pour */
  diColata(el: El): string | null;
}

/**
 * Which net every pin, trace, via and pour belongs to.
 *
 * It is NOT read from the pad: pcb_ports carry no connectivity key (verified:
 * 212 ports, zero keys), so using it meant giving every pad a net of its own.
 * Connectivity lives in the SCHEMATIC traces: a trace joins two pins, or hangs
 * them on a named net. Here the pins a trace puts together are joined, and so
 * are the pins hanging on nets of the same name, so ten parts all on P3V3 turn
 * out connected even if no trace joins them pairwise.
 */
export function retiDelCircuito(circuitJson: unknown[]): RetiDelCircuito {
  const elements = circuitJson as El[];
  const padre = new Map<string, string>();
  const radice = (a: string): string => {
    let r = a;
    while (padre.get(r) && padre.get(r) !== r) r = padre.get(r)!;
    padre.set(a, r);
    return r;
  };
  const unisci = (a: string, b: string) => {
    if (!a || !b) return;
    if (!padre.has(a)) padre.set(a, a);
    if (!padre.has(b)) padre.set(b, b);
    const ra = radice(a);
    const rb = radice(b);
    if (ra !== rb) padre.set(ra, rb);
  };

  const pinDiSorgente = new Map<string, string>();
  const nomeDiRete = new Map<string, string>();
  for (const el of elements) {
    if (el.type === "source_port" && el.source_port_id) {
      pinDiSorgente.set(String(el.source_port_id), String(el.name ?? ""));
    } else if (el.type === "source_net" && el.source_net_id) {
      nomeDiRete.set(String(el.source_net_id), String(el.name ?? ""));
    }
  }
  /** a named net as a node of the groups: by NAME, so two nets called the same are one */
  const etichetta = (netId: string) => `net:${nomeDiRete.get(netId) || netId}`;
  for (const el of elements) {
    if (el.type !== "source_trace") continue;
    const porte = ((el.connected_source_port_ids as unknown[] | undefined) ?? []).map(String);
    for (let i = 1; i < porte.length; i++) unisci(porte[0], porte[i]);
    for (const netId of (el.connected_source_net_ids as unknown[] | undefined) ?? []) {
      for (const porta of porte) unisci(porta, etichetta(String(netId)));
    }
  }

  /*
   * The net name of every group, when it has one. A pad on GND or on a power
   * rail must not be connected to some neighbor: it must be DECLARED, and the
   * name is the only thing worth knowing about it.
   */
  const nomeDelGruppo = new Map<string, string>();
  for (const chiave of [...padre.keys()]) {
    if (!chiave.startsWith("net:")) continue;
    nomeDelGruppo.set(radice(chiave), chiave.slice(4));
  }
  const gruppoDi = (nodo: string) => (padre.has(nodo) ? radice(nodo) : nodo);

  const diPorta = new Map<string, string>();
  const nomeDiPorta = new Map<string, string>();
  const pinDiPorta = new Map<string, string>();
  for (const el of elements) {
    if (el.type !== "pcb_port" || !el.pcb_port_id) continue;
    const id = String(el.pcb_port_id);
    const sorgente = String(el.source_port_id ?? "");
    const gruppo = gruppoDi(sorgente);
    pinDiPorta.set(id, pinDiSorgente.get(sorgente) ?? "");
    diPorta.set(id, gruppo);
    nomeDiPorta.set(id, nomeDelGruppo.get(gruppo) ?? "");
  }

  /*
   * What the copper carries, brought back to those groups. The keys are only
   * LOOKED UP, never used to join: the groups stay the ones of the traces.
   */
  const diIdRete = (netId: string) => gruppoDi(etichetta(netId));
  const diTracciaSorgente = new Map<string, string>();
  const diChiaveNota = new Map<string, string>();
  const nota = (chiave: unknown, gruppo: string) => {
    const k = String(chiave ?? "");
    if (k && gruppo && !diChiaveNota.has(k)) diChiaveNota.set(k, gruppo);
  };
  for (const el of elements) {
    if (el.type !== "source_trace") continue;
    const porte = ((el.connected_source_port_ids as unknown[] | undefined) ?? []).map(String);
    const reti = ((el.connected_source_net_ids as unknown[] | undefined) ?? []).map(String);
    const gruppo = porte[0] ? gruppoDi(porte[0]) : reti[0] ? diIdRete(reti[0]) : "";
    if (!gruppo) continue;
    if (el.source_trace_id) diTracciaSorgente.set(String(el.source_trace_id), gruppo);
    nota(el.subcircuit_connectivity_map_key, gruppo);
  }
  for (const el of elements) {
    if (el.type === "source_net" && el.source_net_id) {
      nota(el.subcircuit_connectivity_map_key, diIdRete(String(el.source_net_id)));
    } else if (el.type === "source_port" && el.source_port_id) {
      nota(el.subcircuit_connectivity_map_key, gruppoDi(String(el.source_port_id)));
    }
  }

  const diChiave = (chiave: string): string | null => {
    if (!chiave) return null;
    const nota = diChiaveNota.get(chiave);
    if (nota) return nota;
    if (chiave.startsWith("net:") && nomeDiRete.has(chiave.slice(4))) return diIdRete(chiave.slice(4));
    const rete = /^(source_net_\d+)(_mst.*)?$/.exec(chiave)?.[1];
    if (rete && nomeDiRete.has(rete)) return diIdRete(rete);
    const diTraccia = diTracciaSorgente.get(chiave);
    if (diTraccia) return diTraccia;
    return pinDiSorgente.has(chiave) ? gruppoDi(chiave) : null;
  };

  return {
    diPorta,
    nomeDiPorta,
    pinDiPorta,
    nome: (rete) => nomeDelGruppo.get(rete) ?? "",
    eRete: (rete) => padre.has(rete),
    diChiave,
    diTraccia: (el) =>
      diTracciaSorgente.get(String(el.source_trace_id ?? "")) ??
      diChiave(String(el.subcircuit_connectivity_map_key ?? "")),
    diVia: (el) => {
      const daChiave = diChiave(String(el.subcircuit_connectivity_map_key ?? ""));
      if (daChiave) return daChiave;
      const traccia = String(el.pcb_trace_id ?? "");
      if (/^source_net_\d+/.test(traccia)) {
        const daTraccia = diChiave(traccia);
        if (daTraccia) return daTraccia;
      }
      return diPorta.get(String(el.pcb_port_id ?? "")) || null;
    },
    diColata: (el) => (el.source_net_id ? diIdRete(String(el.source_net_id)) : null),
  };
}

// ---------------------------------------------------------------------------
// Which copper
// ---------------------------------------------------------------------------

/*
 * A hundredth of a millimetre of slack on every contact: router coordinates are
 * rounded, and two pieces of copper that meet on paper must not come out apart
 * by a rounding.
 */
const CONTATTO_MM = 0.01;
/** cell of the spatial index, in mm: small enough to keep the lists short */
const CELLA_MM = 1;
/** cell of the index of the pours' sides: they are short, a few hundredths on every arc */
const CELLA_LATI_MM = 0.5;

/** union-find on integers: the islands of copper */
class Isole {
  private padre: number[] = [];
  nuovo(): number {
    this.padre.push(this.padre.length);
    return this.padre.length - 1;
  }
  radice(x: number): number {
    let r = x;
    while (this.padre[r] !== r) r = this.padre[r];
    while (this.padre[x] !== r) {
      const next = this.padre[x];
      this.padre[x] = r;
      x = next;
    }
    return r;
  }
  unisci(a: number, b: number): void {
    const ra = this.radice(a);
    const rb = this.radice(b);
    if (ra !== rb) this.padre[ra] = rb;
  }
}

/** a uniform grid over the board: what is near a point, without walking everything */
class Griglia<T> {
  private celle = new Map<string, T[]>();
  /** the few things too big for cells (a trace across the whole board): always looked at */
  private grandi: T[] = [];
  aggiungi(minX: number, minY: number, maxX: number, maxY: number, cosa: T): void {
    const x0 = Math.floor((minX - CONTATTO_MM) / CELLA_MM);
    const x1 = Math.floor((maxX + CONTATTO_MM) / CELLA_MM);
    const y0 = Math.floor((minY - CONTATTO_MM) / CELLA_MM);
    const y1 = Math.floor((maxY + CONTATTO_MM) / CELLA_MM);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 400) {
      this.grandi.push(cosa);
      return;
    }
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const k = `${cx},${cy}`;
        const list = this.celle.get(k);
        if (list) list.push(cosa);
        else this.celle.set(k, [cosa]);
      }
    }
  }
  vicini(minX: number, minY: number, maxX: number, maxY: number): Set<T> {
    const out = new Set<T>(this.grandi);
    const x0 = Math.floor((minX - CONTATTO_MM) / CELLA_MM);
    const x1 = Math.floor((maxX + CONTATTO_MM) / CELLA_MM);
    const y0 = Math.floor((minY - CONTATTO_MM) / CELLA_MM);
    const y1 = Math.floor((maxY + CONTATTO_MM) / CELLA_MM);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        for (const cosa of this.celle.get(`${cx},${cy}`) ?? []) out.add(cosa);
      }
    }
    return out;
  }
}

/** "*" = every layer: plated holes and through vias */
const stessoStrato = (a: string | null, b: string | null) =>
  a === null || b === null || a === "*" || b === "*" || a === b;

interface Pad {
  nodo: number;
  forma: FormaRame;
  strato: string | null;
  /** what it is: an SMT pad, a plated hole, or a port no pad points at */
  tipo: "smd" | "foro" | "porta";
  id: string;
  porta: string;
  componente: string;
}
interface Tratto {
  nodo: number;
  ax: number;
  ay: number;
  bx: number;
  by: number;
  hw: number;
  strato: string | null;
  /** which trace it is a stretch of: its place in `tracce` */
  traccia: number;
}
interface Capo {
  nodo: number;
  x: number;
  y: number;
  /** half width of the copper at that point: the trace, or the via's ring */
  r: number;
  strato: string | null;
}
interface Via extends Capo {
  id: string;
  /** a pcb_via element, or null for a via point written inside a route */
  el: El | null;
  /** the trace whose route holds it, for a via point */
  traccia: number;
}
interface Traccia {
  nodo: number;
  id: string;
  el: El;
}
interface Colata {
  nodo: number;
  id: string;
  el: El;
  forma: PourShape;
  rete: string | null;
}

interface Unioni {
  isole: Isole;
  nodoDiPorta: Map<string, number>;
  pads: Pad[];
  tracce: Traccia[];
  tratti: Tratto[];
  /** the pcb_via elements, then the via points of the routes */
  vie: Via[];
  colate: Colata[];
}

/**
 * Which island of copper each thing sits on.
 *
 * The islands are built from what the Gerber will draw: every trace is one
 * piece of copper (its route is continuous, via points included); a trace
 * touches a pad when one of its segments reaches the pad's copper on the same
 * layer; two traces touch when the end of one lands on the other (that is how
 * a router's T-junctions are written); a via touches what reaches its ring.
 * Pads of the same port, and ports the part connects internally, are one node.
 *
 * `reti` null: only that, which is what the open connections of the compile
 * are counted on. With the nets in hand, the rest of the copper as well (see
 * unisciIlResto).
 */
function unioniDelRame(circuitJson: El[], reti: RetiDelCircuito | null): Unioni {
  const isole = new Isole();
  const nodoDiPorta = new Map<string, number>();
  const nodoDiSorgente = new Map<string, number>();
  const nodoPorta = (id: string): number => {
    let n = nodoDiPorta.get(id);
    if (n === undefined) {
      n = isole.nuovo();
      nodoDiPorta.set(id, n);
    }
    return n;
  };

  const pads: Pad[] = [];
  const conPad = new Set<string>();
  for (const el of circuitJson) {
    if (el.type !== "pcb_smtpad" && el.type !== "pcb_plated_hole") continue;
    const forma = el.type === "pcb_smtpad" ? rameDelPad(el) : rameDelForo(el);
    if (!forma) continue;
    const porta = el.pcb_port_id ? String(el.pcb_port_id) : "";
    if (porta) conPad.add(porta);
    pads.push({
      nodo: porta ? nodoPorta(porta) : isole.nuovo(),
      forma,
      strato: el.type === "pcb_plated_hole" ? "*" : el.layer ? String(el.layer) : null,
      tipo: el.type === "pcb_plated_hole" ? "foro" : "smd",
      id: String(el.pcb_smtpad_id ?? el.pcb_plated_hole_id ?? ""),
      porta,
      componente: String(el.pcb_component_id ?? ""),
    });
  }
  for (const el of circuitJson) {
    if (el.type !== "pcb_port" || !el.pcb_port_id) continue;
    const id = String(el.pcb_port_id);
    const nodo = nodoPorta(id);
    if (el.source_port_id) nodoDiSorgente.set(String(el.source_port_id), nodo);
    // a port no pad points at: the port's own position stands in for its copper
    const x = num(el.x);
    const y = num(el.y);
    if (conPad.has(id) || x === null || y === null) continue;
    const strati = Array.isArray(el.layers) ? (el.layers as unknown[]).map(String) : [];
    pads.push({
      nodo,
      forma: { tipo: "cerchio", x, y, r: 0.05 },
      strato: strati.length === 1 ? strati[0] : "*",
      tipo: "porta",
      id: "",
      porta: id,
      componente: String(el.pcb_component_id ?? ""),
    });
  }
  // the pins a part joins inside itself (two GND pins of a connector, say)
  for (const el of circuitJson) {
    if (el.type !== "source_component") continue;
    for (const gruppo of (el.internally_connected_source_port_ids as unknown[] | undefined) ?? []) {
      if (!Array.isArray(gruppo)) continue;
      const nodi = gruppo
        .map((sp) => nodoDiSorgente.get(String(sp)))
        .filter((n): n is number => n !== undefined);
      for (let i = 1; i < nodi.length; i++) isole.unisci(nodi[0], nodi[i]);
    }
  }

  const tracce: Traccia[] = [];
  const tratti: Tratto[] = [];
  const griglia = new Griglia<Tratto>();
  const capi: Capo[] = [];
  const viePunto: Via[] = [];
  const aggiungiTratto = (t: Tratto) => {
    tratti.push(t);
    griglia.aggiungi(
      Math.min(t.ax, t.bx) - t.hw,
      Math.min(t.ay, t.by) - t.hw,
      Math.max(t.ax, t.bx) + t.hw,
      Math.max(t.ay, t.by) + t.hw,
      t,
    );
  };
  for (const el of circuitJson) {
    if (el.type !== "pcb_trace") continue;
    const route = ((el.route as Array<Record<string, unknown>> | undefined) ?? []).filter(
      (p) => num(p.x) !== null && num(p.y) !== null,
    );
    if (route.length === 0) continue;
    // one route is one piece of copper: its points are drawn one after the other
    const nodo = isole.nuovo();
    const traccia = tracce.length;
    tracce.push({ nodo, id: String(el.pcb_trace_id ?? ""), el });
    const meta = (p: Record<string, unknown>) => (num(p.width) ?? 0.15) / 2;
    const stratoDi = (p: Record<string, unknown>) =>
      p.route_type === "via" ? "*" : p.layer ? String(p.layer) : null;
    for (let i = 1; i < route.length; i++) {
      const a = route[i - 1];
      const b = route[i];
      const viaA = a.route_type === "via";
      const viaB = b.route_type === "via";
      if (viaA && viaB) continue;
      // a stretch between a wire and a via lies on the wire's layer, as drawn
      const filo = viaA ? b : viaB ? a : b;
      aggiungiTratto({
        nodo,
        ax: num(a.x)!,
        ay: num(a.y)!,
        bx: num(b.x)!,
        by: num(b.y)!,
        hw: meta(viaA || viaB ? filo : b.width !== undefined ? b : a),
        strato: viaA || viaB ? stratoDi(filo) : (stratoDi(b) ?? stratoDi(a)),
        traccia,
      });
    }
    if (route.length === 1) {
      const p = route[0];
      aggiungiTratto({
        nodo,
        ax: num(p.x)!,
        ay: num(p.y)!,
        bx: num(p.x)!,
        by: num(p.y)!,
        hw: meta(p),
        strato: stratoDi(p),
        traccia,
      });
    }
    // the ends, and the via points, are where other copper attaches
    route.forEach((p, i) => {
      const via = p.route_type === "via";
      if (!via && i !== 0 && i !== route.length - 1) return;
      const capo: Capo = {
        nodo,
        x: num(p.x)!,
        y: num(p.y)!,
        r: via ? (num(p.outer_diameter) ?? 0.6) / 2 : meta(p),
        strato: stratoDi(p),
      };
      capi.push(capo);
      if (via) viePunto.push({ ...capo, id: "", el: null, traccia });
    });
  }
  const vie: Via[] = [];
  for (const el of circuitJson) {
    if (el.type !== "pcb_via") continue;
    const x = num(el.x);
    const y = num(el.y);
    if (x === null || y === null) continue;
    const d = num(el.outer_diameter) ?? num(el.hole_diameter) ?? 0.6;
    const via: Via = { nodo: isole.nuovo(), x, y, r: d / 2, strato: "*", id: String(el.pcb_via_id ?? ""), el, traccia: -1 };
    vie.push(via);
    capi.push(via);
  }

  // pads against the copper of the traces
  for (const pad of pads) {
    const box = ingombroForma(pad.forma);
    for (const t of griglia.vicini(box.minX, box.minY, box.maxX, box.maxY)) {
      if (!stessoStrato(pad.strato, t.strato)) continue;
      if (isole.radice(t.nodo) === isole.radice(pad.nodo)) continue;
      if (distanzaSegmentoForma(pad.forma, t.ax, t.ay, t.bx, t.by) <= t.hw + CONTATTO_MM) {
        isole.unisci(t.nodo, pad.nodo);
      }
    }
  }
  // trace ends, via points and vias landing on a trace
  for (const c of capi) {
    for (const t of griglia.vicini(c.x - c.r, c.y - c.r, c.x + c.r, c.y + c.r)) {
      if (t.nodo === c.nodo || !stessoStrato(c.strato, t.strato)) continue;
      if (isole.radice(t.nodo) === isole.radice(c.nodo)) continue;
      if (pointSegDistance(c.x, c.y, t.ax, t.ay, t.bx, t.by) <= c.r + t.hw + CONTATTO_MM) {
        isole.unisci(t.nodo, c.nodo);
      }
    }
  }
  // vias sitting on a pad: via-in-pad, or the ring touching it
  const sulPad = reti ? [...vie, ...viePunto] : vie;
  let grigliaPad: Griglia<Pad> | null = null;
  if (sulPad.length > 0 || reti) {
    grigliaPad = new Griglia<Pad>();
    for (const pad of pads) {
      const b = ingombroForma(pad.forma);
      grigliaPad.aggiungi(b.minX, b.minY, b.maxX, b.maxY, pad);
    }
    for (const via of sulPad) {
      for (const pad of grigliaPad.vicini(via.x - via.r, via.y - via.r, via.x + via.r, via.y + via.r)) {
        if (isole.radice(pad.nodo) === isole.radice(via.nodo)) continue;
        if (distanzaPuntoForma(pad.forma, via.x, via.y) <= via.r + CONTATTO_MM) {
          isole.unisci(pad.nodo, via.nodo);
        }
      }
    }
  }

  const unioni: Unioni = { isole, nodoDiPorta, pads, tracce, tratti, vie: [...vie, ...viePunto], colate: [] };
  if (reti && grigliaPad) unisciIlResto(circuitJson, reti, unioni, grigliaPad);
  return unioni;
}

/**
 * The islands of copper AS THE COMPILE COUNTS THEM (route-score.ts): traces,
 * vias, pads, the pins a part joins inside itself. No poured copper: a net
 * with a plane is judged there by the plane rule. A port with no copper at
 * all is an island of its own.
 */
export function isoleDiRame(circuitJson: unknown[]): (pcbPortId: string) => number {
  const { isole, nodoDiPorta } = unioniDelRame(circuitJson as El[], null);
  return (pcbPortId: string) => isole.radice(nodoDiPorta.get(pcbPortId) ?? isole.nuovo());
}

/** the corners of a rectangle of copper, turned as it is */
function angoli(f: Extract<FormaRame, { tipo: "rettangolo" }>): Array<{ x: number; y: number }> {
  const rad = ((f.rot ?? 0) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([sx, sy]) => {
    const lx = (sx * f.w) / 2;
    const ly = (sy * f.h) / 2;
    return { x: f.x + lx * cos - ly * sin, y: f.y + lx * sin + ly * cos };
  });
}

/** how far two pieces of pad copper are: 0 when they touch or overlap */
function distanzaForme(a: FormaRame, b: FormaRame): number {
  if (a.tipo === "cerchio") return Math.max(0, distanzaPuntoForma(b, a.x, a.y) - a.r);
  if (b.tipo === "cerchio") return Math.max(0, distanzaPuntoForma(a, b.x, b.y) - b.r);
  if (a.tipo === "capsula") {
    const c = a.capsula;
    return Math.max(0, distanzaSegmentoForma(b, c.ax, c.ay, c.bx, c.by) - c.r);
  }
  if (b.tipo === "capsula") {
    const c = b.capsula;
    return Math.max(0, distanzaSegmentoForma(a, c.ax, c.ay, c.bx, c.by) - c.r);
  }
  // two rectangles: one inside the other, or a side of one reaching the other
  let d = Math.min(distanzaPuntoForma(b, a.x, a.y), distanzaPuntoForma(a, b.x, b.y));
  const v = angoli(a);
  for (let i = 0; i < 4 && d > 0; i++) {
    const p = v[i];
    const q = v[(i + 1) % 4];
    d = Math.min(d, distanzaSegmentoForma(b, p.x, p.y, q.x, q.y));
  }
  return d;
}

/** whether two segments cross */
function siIncrociano(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): boolean {
  const o = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) =>
    (qx - px) * (ry - py) - (qy - py) * (rx - px);
  const o1 = o(ax, ay, bx, by, cx, cy);
  const o2 = o(ax, ay, bx, by, dx, dy);
  const o3 = o(cx, cy, dx, dy, ax, ay);
  const o4 = o(cx, cy, dx, dy, bx, by);
  return ((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0));
}

/** how far two segments are: 0 when they cross */
function distanzaSegmenti(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): number {
  if (siIncrociano(ax, ay, bx, by, cx, cy, dx, dy)) return 0;
  return Math.min(
    pointSegDistance(ax, ay, cx, cy, dx, dy),
    pointSegDistance(bx, by, cx, cy, dx, dy),
    pointSegDistance(cx, cy, ax, ay, bx, by),
    pointSegDistance(dx, dy, ax, ay, bx, by),
  );
}

/**
 * The sides of the pours of one layer, in a grid: which sides pass near a
 * place. A side is where the pour's copper ends, so whatever reaches a side
 * touches that pour.
 */
class Lati {
  private ax: number[] = [];
  private ay: number[] = [];
  private bx: number[] = [];
  private by: number[] = [];
  /** the pour each side belongs to: its place in `colate` */
  private di: number[] = [];
  private celle = new Map<number, number[]>();
  /** the few sides longer than the grid is worth: always looked at */
  private lunghi: number[] = [];
  private visto: number[] = [];
  private giro = 0;
  private cella(i: number, j: number): number {
    return (i + 32768) * 65536 + (j + 32768);
  }
  aggiungi(ax: number, ay: number, bx: number, by: number, colata: number): void {
    const k = this.ax.length;
    this.ax.push(ax);
    this.ay.push(ay);
    this.bx.push(bx);
    this.by.push(by);
    this.di.push(colata);
    this.visto.push(0);
    const i0 = Math.floor((Math.min(ax, bx) - CONTATTO_MM) / CELLA_LATI_MM);
    const i1 = Math.floor((Math.max(ax, bx) + CONTATTO_MM) / CELLA_LATI_MM);
    const j0 = Math.floor((Math.min(ay, by) - CONTATTO_MM) / CELLA_LATI_MM);
    const j1 = Math.floor((Math.max(ay, by) + CONTATTO_MM) / CELLA_LATI_MM);
    if ((i1 - i0 + 1) * (j1 - j0 + 1) > 1024) {
      this.lunghi.push(k);
      return;
    }
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const c = this.cella(i, j);
        const l = this.celle.get(c);
        if (l) l.push(k);
        else this.celle.set(c, [k]);
      }
    }
  }
  /** every side whose cells meet the box, once: its pour and its two ends. `salta`: a pour whose sides are not wanted */
  vicini(
    minX: number, minY: number, maxX: number, maxY: number,
    visita: (colata: number, ax: number, ay: number, bx: number, by: number) => void,
    salta = -1,
  ): void {
    const giro = ++this.giro;
    const guarda = (k: number) => {
      if (this.visto[k] === giro || this.di[k] === salta) return;
      this.visto[k] = giro;
      visita(this.di[k], this.ax[k], this.ay[k], this.bx[k], this.by[k]);
    };
    for (const k of this.lunghi) guarda(k);
    const i0 = Math.floor((minX - CONTATTO_MM) / CELLA_LATI_MM);
    const i1 = Math.floor((maxX + CONTATTO_MM) / CELLA_LATI_MM);
    const j0 = Math.floor((minY - CONTATTO_MM) / CELLA_LATI_MM);
    const j1 = Math.floor((maxY + CONTATTO_MM) / CELLA_LATI_MM);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const l = this.celle.get(this.cella(i, j));
        if (l) for (const k of l) guarda(k);
      }
    }
  }
}

/**
 * THE COPPER THE COUNT OF THE COMPILE LEAVES OUT.
 *
 * - Two pads lying on each other on one layer are one piece of copper.
 * - A pour joins what stands in it or reaches its edge, on its layer: the pads
 *   and the traces of that layer, every via and plated hole (they go through
 *   the board), another pour of its net it overlaps (a ground declared as
 *   tiles that overlap by a tenth so that they fuse). Only copper of ITS net,
 *   or copper that names no net: a pour drawn over another net's pad is a
 *   short for the checks to report, not a connection.
 */
function unisciIlResto(circuitJson: El[], reti: RetiDelCircuito, u: Unioni, grigliaPad: Griglia<Pad>): void {
  const { isole, pads, tracce, tratti, vie, colate } = u;
  const unite = (a: number, b: number) => isole.radice(a) === isole.radice(b);

  // pads on pads
  for (const pad of pads) {
    const box = ingombroForma(pad.forma);
    for (const altro of grigliaPad.vicini(box.minX, box.minY, box.maxX, box.maxY)) {
      if (altro === pad || unite(pad.nodo, altro.nodo) || !stessoStrato(pad.strato, altro.strato)) continue;
      if (distanzaForme(pad.forma, altro.forma) <= CONTATTO_MM) isole.unisci(pad.nodo, altro.nodo);
    }
  }

  for (const el of circuitJson) {
    if (el.type !== "pcb_copper_pour") continue;
    const forma = readPours([el])[0];
    if (!forma) continue;
    colate.push({ nodo: isole.nuovo(), id: String(el.pcb_copper_pour_id ?? ""), el, forma, rete: reti.diColata(el) });
  }
  if (colate.length === 0) return;

  const latiDi = new Map<string, Lati>();
  /** the pours of each layer, to ask "is this point in one of them?" */
  const colateDi = new Map<string, number[]>();
  colate.forEach((c, k) => {
    const strato = c.forma.layer;
    let lati = latiDi.get(strato);
    if (!lati) latiDi.set(strato, (lati = new Lati()));
    const lista = colateDi.get(strato);
    if (lista) lista.push(k);
    else colateDi.set(strato, [k]);
    for (const anello of [c.forma.outer, ...c.forma.holes]) {
      for (let i = 0, j = anello.length - 1; i < anello.length; j = i++) {
        lati.aggiungi(anello[j].x, anello[j].y, anello[i].x, anello[i].y, k);
      }
    }
  });
  const stratiDi = (strato: string | null): string[] =>
    strato === null || strato === "*" ? [...latiDi.keys()] : latiDi.has(strato) ? [strato] : [];
  /** a pour joins copper of its own net, and copper that names none */
  const suoi = (rete: string | null, c: Colata) => rete === null || c.rete === null || rete === c.rete;

  /** the pours of that layer a point stands in */
  const dentro = (x: number, y: number, strato: string, rete: string | null, nodo: number) => {
    for (const k of colateDi.get(strato) ?? []) {
      const c = colate[k];
      const f = c.forma;
      // most pours are somewhere else: the box first, it costs nothing
      if (x < f.minX || x > f.maxX || y < f.minY || y > f.maxY) continue;
      if (!suoi(rete, c) || unite(nodo, c.nodo)) continue;
      if (insidePour(x, y, f)) isole.unisci(nodo, c.nodo);
    }
  };

  for (const pad of pads) {
    const rete = reteDellaPorta(reti, pad.porta);
    const box = ingombroForma(pad.forma);
    for (const strato of stratiDi(pad.strato)) {
      dentro(pad.forma.x, pad.forma.y, strato, rete, pad.nodo);
      latiDi.get(strato)!.vicini(box.minX, box.minY, box.maxX, box.maxY, (k, ax, ay, bx, by) => {
        const c = colate[k];
        if (!suoi(rete, c) || unite(pad.nodo, c.nodo)) return;
        if (distanzaSegmentoForma(pad.forma, ax, ay, bx, by) <= CONTATTO_MM) isole.unisci(pad.nodo, c.nodo);
      });
    }
  }

  const reteDiTraccia = tracce.map((t) => reti.diTraccia(t.el));
  for (const via of vie) {
    const rete = via.el ? reti.diVia(via.el) : reteDiTraccia[via.traccia];
    for (const strato of latiDi.keys()) {
      dentro(via.x, via.y, strato, rete, via.nodo);
      latiDi.get(strato)!.vicini(via.x - via.r, via.y - via.r, via.x + via.r, via.y + via.r, (k, ax, ay, bx, by) => {
        const c = colate[k];
        if (!suoi(rete, c) || unite(via.nodo, c.nodo)) return;
        if (pointSegDistance(via.x, via.y, ax, ay, bx, by) <= via.r + CONTATTO_MM) isole.unisci(via.nodo, c.nodo);
      });
    }
  }

  for (const t of tratti) {
    const rete = reteDiTraccia[t.traccia];
    for (const strato of stratiDi(t.strato)) {
      dentro(t.ax, t.ay, strato, rete, t.nodo);
      dentro(t.bx, t.by, strato, rete, t.nodo);
      latiDi.get(strato)!.vicini(
        Math.min(t.ax, t.bx) - t.hw,
        Math.min(t.ay, t.by) - t.hw,
        Math.max(t.ax, t.bx) + t.hw,
        Math.max(t.ay, t.by) + t.hw,
        (k, ax, ay, bx, by) => {
          const c = colate[k];
          if (!suoi(rete, c) || unite(t.nodo, c.nodo)) return;
          if (distanzaSegmenti(t.ax, t.ay, t.bx, t.by, ax, ay, bx, by) <= t.hw + CONTATTO_MM) isole.unisci(t.nodo, c.nodo);
        },
      );
    }
  }

  // pours of one net on one layer that overlap or touch
  colate.forEach((c, k) => {
    const lati = latiDi.get(c.forma.layer)!;
    for (const anello of [c.forma.outer, ...c.forma.holes]) {
      for (let i = 0, j = anello.length - 1; i < anello.length; j = i++) {
        const p = anello[j];
        const q = anello[i];
        lati.vicini(
          Math.min(p.x, q.x),
          Math.min(p.y, q.y),
          Math.max(p.x, q.x),
          Math.max(p.y, q.y),
          (h, ax, ay, bx, by) => {
            const altra = colate[h];
            if (altra.rete !== c.rete || unite(c.nodo, altra.nodo)) return;
            if (distanzaSegmenti(p.x, p.y, q.x, q.y, ax, ay, bx, by) <= CONTATTO_MM) isole.unisci(c.nodo, altra.nodo);
          },
          k,
        );
      }
    }
    // one wholly inside the other: no side of the two ever meets
    const v = c.forma.outer[0];
    for (const h of colateDi.get(c.forma.layer) ?? []) {
      const altra = colate[h];
      const f = altra.forma;
      if (h === k || v.x < f.minX || v.x > f.maxX || v.y < f.minY || v.y > f.maxY) continue;
      if (altra.rete !== c.rete || unite(c.nodo, altra.nodo)) continue;
      if (insidePour(v.x, v.y, f)) isole.unisci(c.nodo, altra.nodo);
    }
  });
}

/** the net a pin must be joined to: null for copper that is no pin, and for a pin no trace names */
function reteDellaPorta(reti: RetiDelCircuito, porta: string): string | null {
  const rete = porta ? reti.diPorta.get(porta) : undefined;
  return rete && reti.eRete(rete) ? rete : null;
}

/** a pad, a plated hole, or a port no pad points at */
export interface PiazzolaDiRame {
  /** pcb_smtpad_id or pcb_plated_hole_id; "" for a port with no pad */
  id: string;
  tipo: "smd" | "foro" | "porta";
  /** its pcb_port_id, "" for copper that is no pin */
  porta: string;
  /** its pcb_component_id */
  componente: string;
  x: number;
  y: number;
  /** the layer its copper is on; null for copper on every layer (a plated hole) */
  strato: string | null;
  /** the net it must be joined to; null when it is no pin, or its pin hangs on no connection */
  rete: string | null;
  /** its place in `gruppi` */
  gruppo: number;
}

/** one stretch of a trace, between two points of its route */
export interface TrattoDiRame {
  /** the pcb_trace_id of its trace */
  traccia: string;
  ax: number;
  ay: number;
  bx: number;
  by: number;
  larghezza: number;
  /** null when the route does not say */
  strato: string | null;
  /** the net its trace declares, else the one of the copper it touches */
  rete: string | null;
  gruppo: number;
}

/** a via: a pcb_via element, or a via point written inside a route */
export interface ViaDiRame {
  /** pcb_via_id; "" for a via point of a route */
  id: string;
  /** the pcb_trace_id whose route holds it, for a via point */
  traccia: string | null;
  x: number;
  y: number;
  diametro: number;
  /** the net it declares (see RetiDelCircuito.diVia), else the one of the copper it touches */
  rete: string | null;
  gruppo: number;
}

export interface ColataDiRame {
  /** pcb_copper_pour_id */
  id: string;
  strato: string;
  rete: string | null;
  gruppo: number;
}

/** one island of copper: everything in it is joined */
export interface GruppoDiRame {
  /** its place in `gruppi` */
  indice: number;
  /** the nets declared on it, the one with the most copper first. More than one is two nets on one piece of copper */
  reti: string[];
  piazzole: PiazzolaDiRame[];
  tratti: TrattoDiRame[];
  vie: ViaDiRame[];
  colate: ColataDiRame[];
}

export interface GruppiDiRame {
  /** every island of copper of the board */
  gruppi: GruppoDiRame[];
  /**
   * Net by net, the islands (places in `gruppi`) that hold copper of that net:
   * pins, traces, vias, pours. The PINS of a net all joined are on one of
   * them; a piece of pour or a via that touches nothing is one more.
   */
  perRete: Map<string, number[]>;
  /** who is on which net, and what the nets are called */
  reti: RetiDelCircuito;
  /** the island of a pin, a pad, a via, a trace, a pour, by the id its element carries; -1 when it is not on the board */
  diPorta(pcbPortId: string): number;
  diPiazzola(padId: string): number;
  diVia(pcbViaId: string): number;
  diTraccia(pcbTraceId: string): number;
  diColata(pcbCopperPourId: string): number;
  /** the net of a via, by its pcb_via_id: the one it declares, else the one of the copper it touches */
  reteDiVia(pcbViaId: string): string | null;
  /** every stretch of trace of a net, whichever island it is on */
  trattiDellaRete(rete: string): TrattoDiRame[];
}

/**
 * THE GROUPS OF COPPER OF A BOARD, net by net: from the Circuit JSON of the
 * saved board, with nothing else in hand.
 *
 * Every pad, plated hole, stretch of trace (with its layer), via and pour is
 * in exactly one group, the island of copper it is part of, and carries its
 * net. The pins of a net all joined are in one group; a net with an open
 * connection has its pins in two or more (see open-connections.ts).
 */
export function gruppiDiRame(circuitJson: unknown[]): GruppiDiRame {
  const els = circuitJson as El[];
  const reti = retiDelCircuito(els);
  const u = unioniDelRame(els, reti);
  const { isole } = u;

  const gruppi: GruppoDiRame[] = [];
  const diRadice = new Map<number, GruppoDiRame>();
  /** how much copper of each net an island holds: decides its first net */
  const peso = new Map<GruppoDiRame, Map<string, number>>();
  const gruppoDi = (nodo: number, rete: string | null): GruppoDiRame => {
    const r = isole.radice(nodo);
    let g = diRadice.get(r);
    if (!g) {
      g = { indice: gruppi.length, reti: [], piazzole: [], tratti: [], vie: [], colate: [] };
      gruppi.push(g);
      diRadice.set(r, g);
      peso.set(g, new Map());
    }
    if (rete) {
      const p = peso.get(g)!;
      p.set(rete, (p.get(rete) ?? 0) + 1);
    }
    return g;
  };

  const perPorta = new Map<string, number>();
  const perPiazzola = new Map<string, number>();
  for (const pad of u.pads) {
    const rete = reteDellaPorta(reti, pad.porta);
    const g = gruppoDi(pad.nodo, rete);
    g.piazzole.push({
      id: pad.id,
      tipo: pad.tipo,
      porta: pad.porta,
      componente: pad.componente,
      x: pad.forma.x,
      y: pad.forma.y,
      strato: pad.strato === "*" ? null : pad.strato,
      rete,
      gruppo: g.indice,
    });
    if (pad.porta) perPorta.set(pad.porta, g.indice);
    if (pad.id) perPiazzola.set(pad.id, g.indice);
  }
  // a port with no copper and no position: an island of its own, as the compile counts it
  for (const [porta, nodo] of u.nodoDiPorta) {
    if (!perPorta.has(porta)) perPorta.set(porta, gruppoDi(nodo, null).indice);
  }

  const perTraccia = new Map<string, number>();
  const reteDiTraccia = u.tracce.map((t) => reti.diTraccia(t.el));
  u.tracce.forEach((t, k) => {
    const g = gruppoDi(t.nodo, reteDiTraccia[k]);
    if (t.id) perTraccia.set(t.id, g.indice);
  });
  for (const t of u.tratti) {
    const rete = reteDiTraccia[t.traccia];
    const g = gruppoDi(t.nodo, null);
    g.tratti.push({
      traccia: u.tracce[t.traccia].id,
      ax: t.ax,
      ay: t.ay,
      bx: t.bx,
      by: t.by,
      larghezza: t.hw * 2,
      strato: t.strato === "*" ? null : t.strato,
      rete,
      gruppo: g.indice,
    });
  }

  const perVia = new Map<string, ViaDiRame>();
  for (const via of u.vie) {
    const rete = via.el ? reti.diVia(via.el) : reteDiTraccia[via.traccia];
    const g = gruppoDi(via.nodo, via.el ? rete : null);
    const v: ViaDiRame = {
      id: via.id,
      traccia: via.el ? null : u.tracce[via.traccia].id,
      x: via.x,
      y: via.y,
      diametro: via.r * 2,
      rete,
      gruppo: g.indice,
    };
    g.vie.push(v);
    if (via.id) perVia.set(via.id, v);
  }

  const perColata = new Map<string, number>();
  for (const c of u.colate) {
    const g = gruppoDi(c.nodo, c.rete);
    g.colate.push({ id: c.id, strato: c.forma.layer, rete: c.rete, gruppo: g.indice });
    if (c.id) perColata.set(c.id, g.indice);
  }

  // the nets of every island, and copper that names none takes the one of its island
  const perRete = new Map<string, number[]>();
  for (const g of gruppi) {
    g.reti = [...peso.get(g)!.entries()].sort((a, b) => b[1] - a[1]).map(([rete]) => rete);
    for (const rete of g.reti) {
      const lista = perRete.get(rete);
      if (lista) lista.push(g.indice);
      else perRete.set(rete, [g.indice]);
    }
    const sua = g.reti[0] ?? null;
    if (!sua) continue;
    for (const t of g.tratti) t.rete ??= sua;
    for (const v of g.vie) v.rete ??= sua;
    for (const c of g.colate) c.rete ??= sua;
  }

  return {
    gruppi,
    perRete,
    reti,
    diPorta: (id) => perPorta.get(id) ?? -1,
    diPiazzola: (id) => perPiazzola.get(id) ?? -1,
    diVia: (id) => perVia.get(id)?.gruppo ?? -1,
    diTraccia: (id) => perTraccia.get(id) ?? -1,
    diColata: (id) => perColata.get(id) ?? -1,
    reteDiVia: (id) => perVia.get(id)?.rete ?? null,
    trattiDellaRete: (rete) =>
      (perRete.get(rete) ?? []).flatMap((i) => gruppi[i].tratti.filter((t) => t.rete === rete)),
  };
}
