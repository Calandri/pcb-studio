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
import { runDrcChecks } from "./drc";
import { gruppiDiRame } from "./gruppi-di-rame";
import { collegamentiApertiDelRame, type CollegamentoAperto } from "./open-connections";

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

/**
 * Unrouted connectivity groups, judged PAD BY PAD on the copper that is there.
 *
 * It used to be judged per group: a group counted as routed as soon as ONE of
 * its traces existed. On a five-pad net with a single leg drawn the board said
 * "zero open connections" and the checklist went green, with four pads hanging
 * in the air. Now every pad of the group must sit on the same island of copper
 * or the group is open.
 *
 * ONE SOURCE: the open connections of open-connections.ts, the ones the viewer
 * draws. The count used to have islands of its own, of traces, vias and pads
 * only, and took a net with a poured plane as joined by the plane without
 * looking. On sbb-dl-principale (12/11/2026) a pad 0.70 mm away from the pour
 * of its net and a ground pad in a piece of pour cut off from the rest were
 * both "connected": the summary said 1 open where there were 3. Now a pour
 * joins what its copper touches, like any other copper, and a group is open
 * when one of those missing stretches runs between two of its pads.
 */
export function computeUnroutedGroupKeys(circuitJson: CircuitElement[]): Set<string> {
  return new Set(unroutedGroups(circuitJson).keys());
}

/** one open group, as the summary of the compile tells it */
export interface GruppoAperto {
  /**
   * The declared connection that is not made, by the name the compile lists it
   * with: the source trace of the pin the first missing stretch leaves out
   * (".R16 > .2 to net.P3V3_SD"). It used to be the first trace the group
   * declares, whichever pin that named, joined or not.
   */
  nome: string;
  /**
   * The stretches still missing between the pads of the group, each with its
   * two ends: N islands, N - 1 stretches, the same ones the viewer draws.
   */
  tratti: CollegamentoAperto[];
}

/** a source trace by the name the compile lists the declared connections with (compile.ts, traceLabel) */
const nomeDellaTraccia = (el: CircuitElement) => String(el.display_name ?? el.source_trace_id ?? "trace");

/**
 * The same verdict with its evidence: for every open group, the stretches of
 * copper it still misses.
 *
 * A group is the pins the source traces of one connectivity key name (with no
 * key, the pins of one trace). The missing stretches of a net are a tree over
 * its islands of copper; the ones of a group are the part of that tree that
 * runs between the islands its own pins are on. With a key the group is the
 * whole net and has all of them.
 */
export function unroutedGroups(circuitJson: CircuitElement[]): Map<string, GruppoAperto> {
  const out = new Map<string, GruppoAperto>();
  const sourceTraceEls = circuitJson.filter((el) => el.type === "source_trace");
  if (sourceTraceEls.length === 0) return out;
  const rame = gruppiDiRame(circuitJson);
  const { collegamenti } = collegamentiApertiDelRame(circuitJson, rame);
  if (collegamenti.length === 0) return out;

  /** net by net, the tree its missing stretches make over its islands */
  type Ramo = { verso: number; tratto: CollegamentoAperto };
  const alberi = new Map<string, Map<number, Ramo[]>>();
  for (const tratto of collegamenti) {
    let albero = alberi.get(tratto.rete);
    if (!albero) alberi.set(tratto.rete, (albero = new Map()));
    const a = rame.diPorta(tratto.da.porta);
    const b = rame.diPorta(tratto.a.porta);
    for (const [da, verso] of [
      [a, b],
      [b, a],
    ]) {
      const rami = albero.get(da);
      if (rami) rami.push({ verso, tratto });
      else albero.set(da, [{ verso, tratto }]);
    }
  }

  const pcbPortsOfSource = new Map<string, string[]>();
  for (const el of circuitJson) {
    if (el.type !== "pcb_port" || !el.pcb_port_id || !el.source_port_id) continue;
    const list = pcbPortsOfSource.get(String(el.source_port_id)) ?? [];
    list.push(String(el.pcb_port_id));
    pcbPortsOfSource.set(String(el.source_port_id), list);
  }
  /** group by group, its pins and the declared connection that names each */
  const gruppi = new Map<string, Map<string, CircuitElement>>();
  for (const el of sourceTraceEls) {
    const key = String(el.subcircuit_connectivity_map_key ?? el.source_trace_id ?? "");
    if (!key) continue;
    let porte = gruppi.get(key);
    if (!porte) gruppi.set(key, (porte = new Map()));
    for (const sp of (el.connected_source_port_ids as unknown[] | undefined) ?? []) {
      for (const pcb of pcbPortsOfSource.get(String(sp)) ?? []) if (!porte.has(pcb)) porte.set(pcb, el);
    }
  }

  for (const [key, porte] of gruppi) {
    let albero: Map<number, Ramo[]> | undefined;
    const isole = new Set<number>();
    for (const porta of porte.keys()) {
      albero ??= alberi.get(rame.reti.diPorta.get(porta) ?? "");
      const isola = rame.diPorta(porta);
      if (albero?.has(isola)) isole.add(isola);
    }
    // all its pins on one island: whatever else the net misses is not its own
    if (!albero || isole.size < 2) continue;

    // from one of its islands to the others, along the tree
    const [radice] = isole;
    const versoRadice = new Map<number, Ramo | null>([[radice, null]]);
    const coda = [radice];
    for (let i = 0; i < coda.length; i++) {
      for (const ramo of albero.get(coda[i]) ?? []) {
        if (versoRadice.has(ramo.verso)) continue;
        versoRadice.set(ramo.verso, { verso: coda[i], tratto: ramo.tratto });
        coda.push(ramo.verso);
      }
    }
    const suoi = new Set<CollegamentoAperto>();
    for (const isola of isole) {
      for (let ramo = versoRadice.get(isola); ramo && !suoi.has(ramo.tratto); ramo = versoRadice.get(ramo.verso)) {
        suoi.add(ramo.tratto);
      }
    }
    const tratti = collegamenti.filter((c) => suoi.has(c));
    if (tratti.length === 0) continue;
    const dichiarata =
      porte.get(tratti[0].da.porta) ?? porte.get(tratti[0].a.porta) ?? porte.values().next().value;
    out.set(key, { nome: dichiarata ? nomeDellaTraccia(dichiarata) : key, tratti });
  }
  return out;
}
