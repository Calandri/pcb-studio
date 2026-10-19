/**
 * How a route is judged. It lives apart because both the compile and the
 * routing loop use it, and keeping it inside compile.ts created a circular
 * import between the two.
 *
 * The order of the entries is not random: a board with an error cannot be
 * made, one with an open connection does not work, one that violates the
 * rules cannot be manufactured, and only after that come the tastes (fewer
 * vias, less copper).
 */
import { DEFAULT_DESIGN_RULES, type DesignRules } from "./design-rules";
import {
  distanzaPuntoForma,
  distanzaSegmentoForma,
  ingombroForma,
  pointSegDistance,
  rameDelForo,
  rameDelPad,
  runDrcChecks,
  type FormaRame,
} from "./drc";
import { planeServedSourcePorts, readPours } from "./pours";

export interface CircuitElement {
  type: string;
  [key: string]: unknown;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

export interface CircuitScore {
  errors: number;
  unrouted: number;
  drc: number;
  vias: number;
  /**
   * Only the SIGNAL vias: the ones the router chose in order to change layer.
   * The plane ones — a pad's tie and the stitching between planes — are not a
   * cost: one is not a choice, the others help the return current instead of
   * getting in its way.
   */
  signalVias: number;
  lengthMm: number;
  /**
   * The copper that really costs, in millimetres: length PLUS the signal vias
   * priced at `viaCostMm` each. It is the number to compare two routes with,
   * because copper and holes are two ways of paying for the same connection —
   * and a hole costs more. See DesignRules.viaCostMm
   */
  copperCostMm: number;
}

/**
 * Errors that are the CONSEQUENCE of an incomplete routing, not a failure of
 * the compile: a pin without a trace complains, rightly so, but counting it as
 * a fatal error meant shutting down the variant engine and the refinement
 * loop — which only start at zero errors — exactly on the incomplete boards,
 * i.e. the only ones where they were needed. The lack of copper is already
 * measured by `unrouted`, and measured better: per group, not per pin.
 */
const ROUTING_CONSEQUENCE = new Set([
  "pcb_trace_missing_error",
  "pcb_port_not_connected_error",
  "pcb_autorouting_error",
  "pcb_trace_error",
]);

/**
 * errors + unrouted groups + DRC + via count + length: minimized across the
 * candidates.
 *
 * The rules come from outside. Before, they did not, and the score always
 * used the JLCPCB standard: on a project with its own rules the refinement
 * loop optimized a different board from the one the DRC then measured, and
 * could declare itself "clean" on a route that the check rejected.
 */
export function scoreCircuit(
  circuitJson: CircuitElement[],
  rules: DesignRules = DEFAULT_DESIGN_RULES,
): CircuitScore {
  const signalVias = countSignalVias(circuitJson);
  const lengthMm = totalWireLengthMm(circuitJson);
  return {
    errors: circuitJson.filter(
      (el) => el.type.endsWith("_error") && !ROUTING_CONSEQUENCE.has(el.type),
    ).length,
    unrouted: computeUnroutedGroupKeys(circuitJson).size,
    // count OCCURRENCES, not families: aggregated, 110 crooked exits and
    // just 1 weigh the same and the comparison between two routes misses the difference
    drc: runDrcChecks(circuitJson, rules).reduce(
      (n, v) => n + (v.count ?? Math.max(1, v.points?.length ?? 1)),
      0,
    ),
    vias: circuitJson.filter((el) => el.type === "pcb_via").length,
    signalVias,
    lengthMm,
    copperCostMm: lengthMm + signalVias * (rules.viaCostMm ?? 0),
  };
}

/**
 * The vias the ROUTER chose, the ones that cost. Ours are recognized by their
 * id (pcb_via_plane_*): the tie to the plane and the stitching between planes
 * are not a route's choice and must not weigh on the comparison — otherwise a
 * board with better-stitched ground would look worse than one without.
 */
function countSignalVias(circuitJson: CircuitElement[]): number {
  let n = 0;
  for (const el of circuitJson) {
    if (el.type !== "pcb_via") continue;
    if (String(el.pcb_via_id ?? "").startsWith("pcb_via_plane_")) continue;
    n++;
  }
  return n;
}

function totalWireLengthMm(circuitJson: CircuitElement[]): number {
  let length = 0;
  for (const el of circuitJson) {
    if (el.type !== "pcb_trace") continue;
    const route = (el.route as Array<Record<string, unknown>> | undefined) ?? [];
    for (let i = 1; i < route.length; i++) {
      const a = route[i - 1];
      const b = route[i];
      if (a.route_type !== "wire" || b.route_type !== "wire") continue;
      const ax = num(a.x);
      const ay = num(a.y);
      const bx = num(b.x);
      const by = num(b.y);
      if (ax === null || ay === null || bx === null || by === null) continue;
      length += Math.hypot(bx - ax, by - ay);
    }
  }
  return length;
}

/*
 * A hundredth of a millimetre of slack on every contact: router coordinates are
 * rounded, and two pieces of copper that meet on paper must not come out apart
 * by a rounding.
 */
const CONTATTO_MM = 0.01;
/** cell of the spatial index, in mm: small enough to keep the lists short */
const CELLA_MM = 1;

/**
 * Unrouted connectivity groups, judged PAD BY PAD on the copper that is there.
 *
 * It used to be judged per group: a group counted as routed as soon as ONE of
 * its traces existed. On a five-pad net with a single leg drawn the board said
 * "zero open connections" and the checklist went green, with four pads hanging
 * in the air. Now every pad of the group must sit on the same island of copper
 * — traces, vias, the pads themselves — or the group is open.
 *
 * Nets with a poured plane keep the plane rule: their pads are connected by
 * the copper they sit in, which this function does not model (pour pieces,
 * thermals, the holes around other nets). Whether each of their pads really
 * reaches the plane is the DRC's `plane_stitch_missing`, which measures it.
 */
export function computeUnroutedGroupKeys(circuitJson: CircuitElement[]): Set<string> {
  return new Set(unroutedGroups(circuitJson).keys());
}

/**
 * The same verdict with its evidence: for every open group, the pcb ports that
 * are NOT on the group's largest island — the pads still waiting for copper.
 */
export function unroutedGroups(circuitJson: CircuitElement[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const sourceTraceEls = circuitJson.filter((el) => el.type === "source_trace");
  if (sourceTraceEls.length === 0) return out;
  const groupKey = (el: CircuitElement) =>
    String(el.subcircuit_connectivity_map_key ?? el.source_trace_id ?? "");

  /*
   * A connection whose ends are ALL on a poured net is routed by the plane:
   * there is no trace and there must not be one. Without this, removing the
   * ground wires — which is the point of having a plane — made the board report
   * open connections that were not open, and "close the missing ones" would put
   * the wires straight back.
   */
  const pours = readPours(circuitJson);
  const servedByPlane = pours.length > 0 ? planeServedSourcePorts(circuitJson, pours) : new Map();
  const planeGroups = new Set<string>();
  if (servedByPlane.size > 0) {
    for (const el of sourceTraceEls) {
      const ports = ((el.connected_source_port_ids as unknown[] | undefined) ?? []).map(String);
      if (ports.length === 0) continue;
      if (ports.every((p) => servedByPlane.has(p))) planeGroups.add(groupKey(el));
    }
  }

  const pcbPortsOfSource = new Map<string, string[]>();
  for (const el of circuitJson) {
    if (el.type !== "pcb_port" || !el.pcb_port_id || !el.source_port_id) continue;
    const list = pcbPortsOfSource.get(String(el.source_port_id)) ?? [];
    list.push(String(el.pcb_port_id));
    pcbPortsOfSource.set(String(el.source_port_id), list);
  }
  const portsOfGroup = new Map<string, Set<string>>();
  for (const el of sourceTraceEls) {
    const key = groupKey(el);
    if (!key || planeGroups.has(key)) continue;
    const set = portsOfGroup.get(key) ?? new Set<string>();
    for (const sp of (el.connected_source_port_ids as unknown[] | undefined) ?? []) {
      // the first pcb port of a source port is enough: the others are the same pin
      const pcb = pcbPortsOfSource.get(String(sp))?.[0];
      if (pcb) set.add(pcb);
    }
    portsOfGroup.set(key, set);
  }
  // a group with fewer than two placed pads has nothing to connect
  const daControllare = [...portsOfGroup].filter(([, ports]) => ports.size >= 2);
  if (daControllare.length === 0) return out;

  const isola = copperIslands(circuitJson);
  for (const [key, ports] of daControllare) {
    const perIsola = new Map<number, string[]>();
    for (const p of ports) {
      const root = isola(p);
      const list = perIsola.get(root) ?? [];
      list.push(p);
      perIsola.set(root, list);
    }
    if (perIsola.size <= 1) continue;
    const isole = [...perIsola.values()].sort((a, b) => b.length - a.length);
    out.set(key, isole.slice(1).flat());
  }
  return out;
}

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

/**
 * Which island of copper each pcb port sits on.
 *
 * The islands are built from what the Gerber will draw: every trace is one
 * piece of copper (its route is continuous, via points included); a trace
 * touches a pad when one of its segments reaches the pad's copper on the same
 * layer; two traces touch when the end of one lands on the other (that is how
 * a router's T-junctions are written); a via touches what reaches its ring.
 * Pads of the same port, and ports the part connects internally, are one node.
 */
export function copperIslands(circuitJson: CircuitElement[]): (pcbPortId: string) => number {
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

  interface Pad {
    nodo: number;
    forma: FormaRame;
    strato: string | null;
  }
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

  interface Tratto {
    nodo: number;
    ax: number;
    ay: number;
    bx: number;
    by: number;
    hw: number;
    strato: string | null;
  }
  interface Capo {
    nodo: number;
    x: number;
    y: number;
    /** half width of the copper at that point: the trace, or the via's ring */
    r: number;
    strato: string | null;
  }
  const tratti = new Griglia<Tratto>();
  const capi: Capo[] = [];
  const aggiungiTratto = (t: Tratto) =>
    tratti.aggiungi(
      Math.min(t.ax, t.bx) - t.hw,
      Math.min(t.ay, t.by) - t.hw,
      Math.max(t.ax, t.bx) + t.hw,
      Math.max(t.ay, t.by) + t.hw,
      t,
    );
  for (const el of circuitJson) {
    if (el.type !== "pcb_trace") continue;
    const route = ((el.route as Array<Record<string, unknown>> | undefined) ?? []).filter(
      (p) => num(p.x) !== null && num(p.y) !== null,
    );
    if (route.length === 0) continue;
    // one route is one piece of copper: its points are drawn one after the other
    const nodo = isole.nuovo();
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
      });
    }
    // the ends, and the via points, are where other copper attaches
    route.forEach((p, i) => {
      const via = p.route_type === "via";
      if (!via && i !== 0 && i !== route.length - 1) return;
      capi.push({
        nodo,
        x: num(p.x)!,
        y: num(p.y)!,
        r: via ? (num(p.outer_diameter) ?? 0.6) / 2 : meta(p),
        strato: stratoDi(p),
      });
    });
  }
  const vie: Capo[] = [];
  for (const el of circuitJson) {
    if (el.type !== "pcb_via") continue;
    const x = num(el.x);
    const y = num(el.y);
    if (x === null || y === null) continue;
    const d = num(el.outer_diameter) ?? num(el.hole_diameter) ?? 0.6;
    const via: Capo = { nodo: isole.nuovo(), x, y, r: d / 2, strato: "*" };
    vie.push(via);
    capi.push(via);
  }

  // pads against the copper of the traces
  for (const pad of pads) {
    const box = ingombroForma(pad.forma);
    for (const t of tratti.vicini(box.minX, box.minY, box.maxX, box.maxY)) {
      if (!stessoStrato(pad.strato, t.strato)) continue;
      if (isole.radice(t.nodo) === isole.radice(pad.nodo)) continue;
      if (distanzaSegmentoForma(pad.forma, t.ax, t.ay, t.bx, t.by) <= t.hw + CONTATTO_MM) {
        isole.unisci(t.nodo, pad.nodo);
      }
    }
  }
  // trace ends, via points and vias landing on a trace
  for (const c of capi) {
    for (const t of tratti.vicini(c.x - c.r, c.y - c.r, c.x + c.r, c.y + c.r)) {
      if (t.nodo === c.nodo || !stessoStrato(c.strato, t.strato)) continue;
      if (isole.radice(t.nodo) === isole.radice(c.nodo)) continue;
      if (pointSegDistance(c.x, c.y, t.ax, t.ay, t.bx, t.by) <= c.r + t.hw + CONTATTO_MM) {
        isole.unisci(t.nodo, c.nodo);
      }
    }
  }
  // vias sitting on a pad: via-in-pad, or the ring touching it
  if (vie.length > 0) {
    const grigliaPad = new Griglia<Pad>();
    for (const pad of pads) {
      const b = ingombroForma(pad.forma);
      grigliaPad.aggiungi(b.minX, b.minY, b.maxX, b.maxY, pad);
    }
    for (const via of vie) {
      for (const pad of grigliaPad.vicini(via.x - via.r, via.y - via.r, via.x + via.r, via.y + via.r)) {
        if (isole.radice(pad.nodo) === isole.radice(via.nodo)) continue;
        if (distanzaPuntoForma(pad.forma, via.x, via.y) <= via.r + CONTATTO_MM) {
          isole.unisci(pad.nodo, via.nodo);
        }
      }
    }
  }

  // a port with no copper at all is an island of its own
  return (pcbPortId: string) => isole.radice(nodoDiPorta.get(pcbPortId) ?? isole.nuovo());
}
