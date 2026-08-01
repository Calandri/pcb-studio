import { getSimpleRouteJsonFromCircuitJson } from "@tscircuit/core";
import {
  AutoroutingPipelineSolver,
  AutoroutingPipelineSolver3_HgPortPointPathing,
} from "@tscircuit/capacity-autorouter";
import { DEFAULT_DESIGN_RULES, type DesignRules } from "./design-rules";

/**
 * Section-based variant routing engine ("Fase 3.d").
 *
 * Core's own routing ignores our JLCPCB design rules (it plans vias at
 * 0.2/0.3mm, below the 0.3/0.6 fab minimum), and there is no board prop that
 * reaches the router. So we route ourselves: unroute the compiled circuit,
 * extract each subcircuit's routing problem WITH the design rules injected,
 * and generate N candidates per section from different solver versions and
 * efforts. Candidates are spliced back and scored deterministically.
 */

export interface CircuitElement {
  type: string;
  [key: string]: unknown;
}

export interface SectionInfo {
  key: string;
  name: string;
  subcircuitId: string;
}

export interface CandidateStats {
  traces: number;
  vias: number;
  lengthMm: number;
}

export interface RouteCandidate {
  label: string;
  solver: "v6" | "v3";
  effort: number;
  traces: CircuitElement[];
  stats: CandidateStats;
  /** DRC violations introduced by this candidate's spliced traces */
  drc: number;
}

export interface SectionVariants {
  section: SectionInfo;
  connections: number;
  candidates: RouteCandidate[];
  /** index into candidates, deterministic best pick */
  picked: number;
  /** true when the top-2 candidates are close (human choice worthwhile) */
  closeCall: boolean;
}

type SolverClass = new (
  srj: unknown,
  opts: { effort?: number },
) => {
  solved: boolean;
  failed: boolean;
  error?: string;
  step: () => void;
  getOutputSimpleRouteJson: () => { traces?: CircuitElement[] };
};

/** sections = named subcircuit groups (the board-level root is NOT a section:
 *  cross-section nets keep the core routing, variants are per named section) */
export function findSections(circuitJson: CircuitElement[]): SectionInfo[] {
  const sections: SectionInfo[] = [];
  for (const el of circuitJson) {
    if (el.type !== "source_group" || !el.subcircuit_id || !el.is_subcircuit) continue;
    if (!el.name) continue;
    sections.push({
      key: String(el.name),
      name: String(el.name),
      subcircuitId: String(el.subcircuit_id),
    });
  }
  return sections;
}

/**
 * Remove routing products (pcb_trace, pcb_via) belonging to the given
 * subcircuits only — root-level and other sections' routing stays intact.
 * (`unrouteCircuitJson` strips traces but leaves vias behind, and strips
 * everything including the root backbone we want to keep.)
 */
export function unrouteSections(
  circuitJson: CircuitElement[],
  subcircuitIds: Set<string>,
): CircuitElement[] {
  return circuitJson.filter((el) => {
    if (el.type !== "pcb_trace" && el.type !== "pcb_via") return true;
    // hand-drawn copper is never un-routed: it is the user's will, not a candidate
    if (el.manual === true) return true;
    const sid = el.subcircuit_id ? String(el.subcircuit_id) : null;
    return !(sid && subcircuitIds.has(sid));
  });
}

function traceStats(traces: CircuitElement[]): CandidateStats {
  let vias = 0;
  let length = 0;
  for (const t of traces) {
    const route = (t.route as Array<Record<string, unknown>> | undefined) ?? [];
    for (let i = 0; i < route.length; i++) {
      const p = route[i];
      if (p.route_type === "via") vias++;
      if (i > 0 && p.route_type === "wire" && route[i - 1].route_type === "wire") {
        length += Math.hypot(
          Number(p.x) - Number(route[i - 1].x),
          Number(p.y) - Number(route[i - 1].y),
        );
      }
    }
  }
  return { traces: traces.length, vias, lengthMm: Math.round(length * 10) / 10 };
}

export function runSolver(
  SolverClass: SolverClass,
  srj: unknown,
  effort: number,
): CircuitElement[] {
  const solver = new SolverClass(srj, { effort });
  let guard = 0;
  while (!solver.solved && !solver.failed && guard++ < 200_000) solver.step();
  if (solver.failed) throw new Error(solver.error ?? "solver failed");
  return solver.getOutputSimpleRouteJson().traces ?? [];
}

export interface VariantDef {
  solver: "v6" | "v3";
  SolverClass: SolverClass;
  effort: number;
}

/** the two available solvers, for building tailored candidate lists */
export const SOLVERS = {
  v6: AutoroutingPipelineSolver as unknown as SolverClass,
  v3: AutoroutingPipelineSolver3_HgPortPointPathing as unknown as SolverClass,
};

const VARIANT_DEFS: VariantDef[] = [
  { solver: "v6", SolverClass: AutoroutingPipelineSolver as unknown as SolverClass, effort: 1 },
  { solver: "v6", SolverClass: AutoroutingPipelineSolver as unknown as SolverClass, effort: 5 },
  {
    solver: "v3",
    SolverClass: AutoroutingPipelineSolver3_HgPortPointPathing as unknown as SolverClass,
    effort: 1,
  },
];

/**
 * Generate up to `count` routing candidates for ONE section, with the JLCPCB
 * design rules injected into the routing problem itself. `drcEvaluator`
 * (optional) scores each candidate's spliced traces (e.g. via clearance
 * violations introduced by upsized vias) and becomes the primary sort key.
 */
export function generateSectionCandidates(
  base: CircuitElement[],
  section: SectionInfo,
  count = 3,
  rules: DesignRules = DEFAULT_DESIGN_RULES,
  drcEvaluator?: (traces: CircuitElement[]) => number,
  /** tailored candidate list: used to try DIFFERENT things on each round */
  defs: VariantDef[] = VARIANT_DEFS,
): SectionVariants {
  const { simpleRouteJson } = getSimpleRouteJsonFromCircuitJson({
    circuitJson: base as never,
    subcircuit_id: section.subcircuitId,
    minTraceWidth: rules.minTraceWidthMm,
    minViaHoleDiameter: rules.minViaHoleMm,
    minViaPadDiameter: rules.minViaDiameterMm,
    minPadEdgeToPadEdgeClearance: rules.minClearanceMm,
    minTraceToPadEdgeClearance: rules.minClearanceMm,
    minViaEdgeToPadEdgeClearance: rules.minClearanceMm,
    minViaHoleEdgeToViaHoleEdgeClearance: rules.minClearanceMm,
    minPlatedHoleDrillEdgeToDrillEdgeClearance: rules.minClearanceMm,
    minBoardEdgeClearance: rules.minBoardEdgeClearanceMm,
  } as never) as { simpleRouteJson: { connections: unknown[] } };

  const connections = simpleRouteJson.connections.length;
  const candidates: RouteCandidate[] = [];
  for (const def of defs.slice(0, Math.max(1, count))) {
    try {
      const traces = runSolver(def.SolverClass, simpleRouteJson, def.effort);
      candidates.push({
        label: `${def.solver}-eff${def.effort}`,
        solver: def.solver,
        effort: def.effort,
        traces,
        stats: traceStats(traces),
        drc: drcEvaluator ? drcEvaluator(traces) : 0,
      });
    } catch {
      // failed candidates simply don't score
    }
  }

  candidates.sort(
    (a, b) =>
      a.drc - b.drc ||
      a.stats.vias - b.stats.vias ||
      a.stats.lengthMm - b.stats.lengthMm,
  );

  const picked = 0;
  let closeCall = false;
  if (candidates.length >= 2) {
    const [best, second] = [candidates[0], candidates[1]];
    // a human choice is worthwhile when the top-2 are both clean and differ
    // by < 20% on vias / < 10% on length
    closeCall =
      best.drc === second.drc &&
      Math.abs(best.stats.vias - second.stats.vias) <=
        Math.max(1, Math.round(best.stats.vias * 0.2)) &&
      Math.abs(best.stats.lengthMm - second.stats.lengthMm) <=
        Math.max(2, best.stats.lengthMm * 0.1);
  }

  return { section, connections, candidates, picked, closeCall };
}

/**
 * Which CONNECTION a solver-produced trace comes from.
 *
 * The solver returns `connection_name`, which is the name of the connection
 * in the routing problem: `source_trace_12`, or `source_net_3` for a whole
 * net, or merged names like `source_trace_69__source_trace_70_mst0` when two
 * connections have been joined together. Here we walk back to the circuit's
 * `source_trace_id`.
 *
 * IT SERVES TWO PURPOSES, both measured and neither of them cosmetic.
 *
 * 1. tscircuit's routing-problem builder EXPLODES on a diagonal `pcb_trace`
 *    that lacks `source_trace_id`
 *    ("getObstaclesFromTrace currently only supports horizontal and vertical
 *    traces"). The capacity autorouter produces diagonals and `spliceTraces`
 *    was writing traces without that field: as soon as a zone was rerouted,
 *    every subsequent rip-up and every round of the variant engine failed.
 *    The error was silently caught and the cycle concluded "no longer
 *    improving" without even having tried. Verified that the PRESENCE of the
 *    field is enough.
 *
 * 2. The DRC derives a trace's net from its `source_trace_id`, and traces
 *    without a net are SKIPPED by clearance checks. Spliced copper was
 *    therefore exempt from the DRC: it wasn't clean, it was invisible.
 */
export function sourceTraceIdResolver(
  circuitJson: CircuitElement[],
): (connectionName: string) => { sourceTraceId: string; subcircuitId: string | null } | null {
  const valid = new Set<string>();
  /** connection -> the subcircuit it belongs to */
  const subcircuitOf = new Map<string, string>();
  /** net -> any one of its connections, as a representative */
  const byNet = new Map<string, string>();
  for (const el of circuitJson) {
    if (el.type !== "source_trace") continue;
    const id = String(el.source_trace_id ?? "");
    if (!id) continue;
    valid.add(id);
    if (typeof el.subcircuit_id === "string") subcircuitOf.set(id, el.subcircuit_id);
    for (const netId of (el.connected_source_net_ids as string[] | undefined) ?? []) {
      if (!byNet.has(netId)) byNet.set(netId, id);
    }
    const key = el.subcircuit_connectivity_map_key;
    if (typeof key === "string" && !byNet.has(key)) byNet.set(key, id);
  }

  type Hit = { sourceTraceId: string; subcircuitId: string | null } | null;
  const cache = new Map<string, Hit>();
  return (connectionName: string): Hit => {
    if (!connectionName) return null;
    const hit = cache.get(connectionName);
    if (hit !== undefined) return hit;
    let id: string | null = null;
    if (valid.has(connectionName)) {
      id = connectionName;
    } else {
      // merged names: take the first real connection that appears
      for (const m of connectionName.matchAll(/source_trace_\d+/g)) {
        if (valid.has(m[0])) {
          id = m[0];
          break;
        }
      }
      if (!id) {
        // net connection: any connection on the same net will do, because
        // downstream code looks at the connectivity key, not the id
        const net = /source_net_\d+/.exec(connectionName)?.[0];
        id = (net ? byNet.get(net) : null) ?? null;
      }
    }
    const out: Hit = id ? { sourceTraceId: id, subcircuitId: subcircuitOf.get(id) ?? null } : null;
    cache.set(connectionName, out);
    return out;
  };
}

/**
 * Splice a candidate's traces into the circuit: pcb_trace elements plus
 * deduped pcb_via elements (vias shared by merged traces on the same net
 * appear once per trace — insert them once per coordinate). Each via inherits
 * the pcb_port_id of the nearest pad (< 1mm): it is on that pad's net in
 * practice, and it lets the DRC skip false same-net clearance positives.
 */
export function spliceTraces(
  base: CircuitElement[],
  subcircuitId: string,
  traces: CircuitElement[],
  tag: string,
  rules: DesignRules = DEFAULT_DESIGN_RULES,
): CircuitElement[] {
  const pads: Array<{ x: number; y: number; pcb_port_id: string }> = [];
  for (const el of base) {
    if (el.type !== "pcb_smtpad" && el.type !== "pcb_plated_hole") continue;
    if (typeof el.x !== "number" || typeof el.y !== "number" || !el.pcb_port_id) continue;
    pads.push({ x: el.x, y: el.y, pcb_port_id: String(el.pcb_port_id) });
  }
  const nearestPadPort = (x: number, y: number): string | null => {
    let best: string | null = null;
    let bestD = 1.0;
    for (const p of pads) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bestD) {
        bestD = d;
        best = p.pcb_port_id;
      }
    }
    return best;
  };

  const out = [...base];
  /*
   * The bridge between the connection name and the circuit connection is
   * built on the COMPLETE starting circuit: `base` has already lost the
   * ripped-up traces, but the `source_trace` elements are all still there,
   * because rip-up touches the copper, not the design.
   */
  const resolveSource = sourceTraceIdResolver(base);
  const viaSeen = new Set<string>();
  let n = 0;
  for (const t of traces) {
    if (t.type !== "pcb_trace") continue;
    n++;
    const from = resolveSource(String(t.connection_name ?? t.connectionName ?? ""));
    out.push({
      type: "pcb_trace",
      pcb_trace_id: `${tag}_t${n}`,
      /*
       * The subcircuit is the REAL one of the connection, not the convenient
       * label passed by the caller. It is `subcircuit_id` that tells the
       * problem builder a connection has already been routed: with a
       * made-up label (`zone_-17_-2`) the freshly laid copper did not
       * count, and on the next round the builder asked to redo 47
       * connections instead of 6.
       */
      subcircuit_id: from?.subcircuitId ?? subcircuitId,
      // without this the new copper is invisible to the DRC and blows up the
      // problem builder on the next round: see sourceTraceIdResolver
      ...(from ? { source_trace_id: from.sourceTraceId } : {}),
      ...(t.connection_name ? { connection_name: t.connection_name } : {}),
      route: t.route,
    });
    const route = (t.route as Array<Record<string, unknown>> | undefined) ?? [];
    for (const p of route) {
      if (p.route_type !== "via") continue;
      const key = `${Number(p.x).toFixed(3)},${Number(p.y).toFixed(3)}`;
      if (viaSeen.has(key)) continue;
      viaSeen.add(key);
      const portId = nearestPadPort(Number(p.x), Number(p.y));
      out.push({
        type: "pcb_via",
        pcb_via_id: `${tag}_via_${viaSeen.size}`,
        subcircuit_id: subcircuitId,
        ...(portId ? { pcb_port_id: portId } : {}),
        x: Number(p.x),
        y: Number(p.y),
        hole_diameter: rules.minViaHoleMm,
        outer_diameter: rules.minViaDiameterMm,
        from_layer: p.from_layer,
        to_layer: p.to_layer,
        layers: [p.from_layer, p.to_layer],
      });
    }
  }
  return out;
}

/** assemble the final circuit: unrouted base + the picked candidate per section */
export function assembleCircuit(
  base: CircuitElement[],
  picks: Array<{ section: SectionInfo; candidate: RouteCandidate }>,
  rules: DesignRules = DEFAULT_DESIGN_RULES,
): CircuitElement[] {
  let out = base;
  for (const pick of picks) {
    out = spliceTraces(
      out,
      pick.section.subcircuitId,
      pick.candidate.traces,
      `${pick.section.key}_${pick.candidate.label}`,
      rules,
    );
  }
  return out;
}

