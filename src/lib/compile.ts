import { CircuitRunner, runTscircuitCode } from "@tscircuit/eval";
import { getPlatformConfig } from "@tscircuit/eval/platform-config";
import { AutoroutingPipelineSolver } from "@tscircuit/capacity-autorouter";
import { runDrcChecks, type DrcViolation } from "./drc";
import type { FsMap } from "./project-store";

export interface UnroutedDetail {
  /** e.g. ".R1 > .pin1 to net.VCC" */
  name: string;
  nets: string[];
  /** points that still need to be connected (mm, board center = 0,0) */
  points: Array<{ x: number; y: number; layer: string | null }>;
}

export interface CongestionCell {
  cell: string;
  centerX: number;
  centerY: number;
  /** 0-1, share of the cell area covered by copper obstacles */
  coverage: number;
}

export interface RatsnestNet {
  name: string;
  pads: number;
  lengthMm: number;
  centroidX: number;
  centroidY: number;
}

export interface CompileSummary {
  ok: boolean;
  errors: Array<{ type: string; message: string }>;
  components: Array<{ name: string; ftype?: string; value?: string }>;
  nets: string[];
  /** every declared connection, e.g. ".R1 > .pin1 to net.VCC" */
  connections: string[];
  /** connections declared in source but with no routed pcb trace */
  unroutedConnections: string[];
  /** geometric detail for each unrouted connectivity group */
  unroutedDetail: UnroutedDetail[];
  /** deterministic design-rule violations (JLCPCB defaults) */
  drcViolations: DrcViolation[];
  sourceTraces: number;
  pcbTraces: number;
  stats: {
    vias: number;
    totalTraceLengthMm: number;
    traceLengthByLayerMm: Record<string, number>;
  };
  /** most obstacle-covered board cells (routing bottlenecks) */
  congestion: CongestionCell[];
  /** placement quality metrics (pre-routing, from pad positions) */
  ratsnest: {
    totalLengthMm: number;
    estimatedCrossings: number;
    longestNets: RatsnestNet[];
  };
  routingAttempts: number;
  router: "default" | "local_retry";
  message: string;
}

export interface CompileResult {
  summary: CompileSummary;
  circuitJson: unknown[];
}

interface CircuitElement {
  type: string;
  [key: string]: unknown;
}

interface Point {
  x: number;
  y: number;
  layer: string | null;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

const round1 = (v: number): number => Math.round(v * 10) / 10;
const round2 = (v: number): number => Math.round(v * 100) / 100;

export interface CompileOptions {
  /** extra routing attempts with escalating effort when unrouted > 0 (default 2) */
  retries?: number;
}

/**
 * Authoritative server-side compile: same @tscircuit/eval the browser uses,
 * but its summary is what the LLM sees (the self-correction feedback loop).
 *
 * When the first attempt leaves unrouted connections, we retry with the local
 * pipeline autorouter at escalating effort (platform autorouterMap override),
 * keeping the best result. This gives the model rip-up-and-retry for free.
 */
export async function compileProject(
  fsMap: FsMap,
  opts: CompileOptions = {},
): Promise<CompileResult> {
  const retries = Math.max(0, Math.min(opts.retries ?? 2, 3));
  const efforts = [2, 5, 10];

  // state object: flow narrowing can't track assignments made inside closures
  const state: {
    best: { circuitJson: CircuitElement[]; router: CompileSummary["router"] } | null;
    bestScore: { unrouted: number; vias: number } | null;
    attempts: number;
    fatalError: string | null;
  } = { best: null, bestScore: null, attempts: 0, fatalError: null };

  const consider = (circuitJson: CircuitElement[], router: CompileSummary["router"]) => {
    const score = scoreCircuit(circuitJson);
    if (
      !state.bestScore ||
      score.unrouted < state.bestScore.unrouted ||
      (score.unrouted === state.bestScore.unrouted && score.vias < state.bestScore.vias)
    ) {
      state.best = { circuitJson, router };
      state.bestScore = score;
    }
    return score;
  };

  // attempt 0: as-authored (board autorouter prop, cloud freerouting included)
  try {
    state.attempts += 1;
    const cj = (await runTscircuitCode(fsMap, {
      mainComponentPath: "main.tsx",
    })) as CircuitElement[];
    consider(cj, "default");
  } catch (err) {
    state.fatalError = err instanceof Error ? err.message : String(err);
  }

  // retries: local pipeline at escalating effort (rip-up & retry)
  for (let i = 0; i < retries && state.bestScore && state.bestScore.unrouted > 0; i++) {
    try {
      state.attempts += 1;
      const cj = await compileWithLocalRouter(fsMap, efforts[i] ?? 10);
      consider(cj, "local_retry");
    } catch {
      // a failed retry just doesn't improve the best result
    }
  }

  if (!state.best) {
    const message = state.fatalError ?? "compile produced no result";
    return {
      summary: emptySummary(`Compilation failed: ${message}`, {
        type: "compile_exception",
        message,
      }),
      circuitJson: [],
    };
  }

  const circuitJson = state.best.circuitJson;
  const summary = summarize(circuitJson);
  summary.routingAttempts = state.attempts;
  summary.router = state.best.router;
  return { summary, circuitJson };
}

function emptySummary(
  message: string,
  error: { type: string; message: string },
): CompileSummary {
  return {
    ok: false,
    errors: [error],
    components: [],
    nets: [],
    connections: [],
    unroutedConnections: [],
    unroutedDetail: [],
    drcViolations: [],
    sourceTraces: 0,
    pcbTraces: 0,
    stats: { vias: 0, totalTraceLengthMm: 0, traceLengthByLayerMm: {} },
    congestion: [],
    ratsnest: { totalLengthMm: 0, estimatedCrossings: 0, longestNets: [] },
    routingAttempts: 1,
    router: "default",
    message,
  };
}

/** unrouted connectivity groups + via count: the score minimized across retries */
function scoreCircuit(circuitJson: CircuitElement[]): { unrouted: number; vias: number } {
  const sourceTraceEls = circuitJson.filter((el) => el.type === "source_trace");
  const pcbTraceEls = circuitJson.filter((el) => el.type === "pcb_trace");
  const routedSourceIds = new Set(
    pcbTraceEls.map((el) => String(el.source_trace_id ?? "")).filter(Boolean),
  );
  const groupKey = (el: CircuitElement) =>
    String(el.subcircuit_connectivity_map_key ?? el.source_trace_id ?? "");
  const routedGroups = new Set(
    sourceTraceEls
      .filter((el) => routedSourceIds.has(String(el.source_trace_id ?? "")))
      .map(groupKey),
  );
  const unroutedGroups = new Set(
    sourceTraceEls.map(groupKey).filter((k) => !routedGroups.has(k)),
  );
  return {
    unrouted: unroutedGroups.size,
    vias: circuitJson.filter((el) => el.type === "pcb_via").length,
  };
}

/**
 * Re-compile forcing the local pipeline autorouter at the given effort,
 * regardless of the board's autorouter prop: the platform autorouterMap
 * overrides the presets the board may declare (auto/auto_local/auto_cloud).
 */
async function compileWithLocalRouter(
  fsMap: FsMap,
  effort: number,
): Promise<CircuitElement[]> {
  const platform = getPlatformConfig({
    autorouterMap: {
      auto: localRouterDef(effort),
      "auto-local": localRouterDef(effort),
      "auto-cloud": localRouterDef(effort),
    },
  });
  const runner = new CircuitRunner();
  try {
    await runner.setPlatformConfig(platform);
    await runner.executeWithFsMap({ fsMap, mainComponentPath: "main.tsx" });
    await runner.renderUntilSettled();
    return (await runner.getCircuitJson()) as CircuitElement[];
  } finally {
    await runner.kill().catch(() => {});
  }
}

function localRouterDef(effort: number) {
  return {
    createAutorouter: (simpleRouteJson: unknown) =>
      // AutorouterInstance is structurally compatible with BaseSolver's
      // event API used by core (on/start); the types are not exported cleanly.
      new AutoroutingPipelineSolver(simpleRouteJson as never, {
        effort,
      } as never) as never,
  };
}

// ---------------------------------------------------------------------------
// summary building (geometric feedback for the model)
// ---------------------------------------------------------------------------

function summarize(circuitJson: CircuitElement[]): CompileSummary {
  const errors = circuitJson
    .filter((el) => el.type.endsWith("_error"))
    .map((el) => ({
      type: el.type,
      message: String(el.message ?? el.error_type ?? JSON.stringify(el)).slice(0, 500),
    }));

  const components = circuitJson
    .filter((el) => el.type === "source_component")
    .map((el) => ({
      name: String(el.name ?? "?"),
      ftype: el.ftype ? String(el.ftype) : undefined,
      value: el.display_value ? String(el.display_value) : undefined,
    }));

  const netNameById = new Map<string, string>();
  for (const el of circuitJson) {
    if (el.type === "source_net") {
      netNameById.set(String(el.source_net_id ?? ""), String(el.name ?? "?"));
    }
  }
  const nets = [...netNameById.values()];

  const sourceTraceEls = circuitJson.filter((el) => el.type === "source_trace");
  const pcbTraceEls = circuitJson.filter((el) => el.type === "pcb_trace");
  const routedSourceIds = new Set(
    pcbTraceEls.map((el) => String(el.source_trace_id ?? "")).filter(Boolean),
  );

  const traceLabel = (el: CircuitElement) =>
    String(el.display_name ?? el.source_trace_id ?? "trace");
  const connections = sourceTraceEls.map(traceLabel).slice(0, 40);

  // Routing is judged per CONNECTIVITY GROUP, not per source trace: traces on
  // the same net get merged by the router, so only some of them carry the
  // pcb_trace. A group counts as unrouted only if NONE of its traces routed.
  const groupKey = (el: CircuitElement) =>
    String(el.subcircuit_connectivity_map_key ?? el.source_trace_id ?? "");
  const routedGroups = new Set(
    sourceTraceEls
      .filter((el) => routedSourceIds.has(String(el.source_trace_id ?? "")))
      .map(groupKey),
  );

  // pad positions per connectivity group (for unrouted detail + ratsnest)
  const pcbPortBySourcePort = new Map<string, CircuitElement>();
  for (const el of circuitJson) {
    if (el.type === "pcb_port" && el.source_port_id) {
      pcbPortBySourcePort.set(String(el.source_port_id), el);
    }
  }
  const groupInfo = new Map<
    string,
    { label: string; nets: Set<string>; points: Point[]; routed: boolean }
  >();
  for (const el of sourceTraceEls) {
    const key = groupKey(el);
    const info = groupInfo.get(key) ?? {
      label: traceLabel(el),
      nets: new Set<string>(),
      points: [],
      routed: routedGroups.has(key),
    };
    for (const netId of (el.connected_source_net_ids as string[] | undefined) ?? []) {
      const name = netNameById.get(String(netId));
      if (name) info.nets.add(name);
    }
    for (const portId of (el.connected_source_port_ids as string[] | undefined) ?? []) {
      const pad = pcbPortBySourcePort.get(String(portId));
      if (!pad) continue;
      const x = num(pad.x);
      const y = num(pad.y);
      if (x === null || y === null) continue;
      const layers = (pad.layers as string[] | undefined) ?? (pad.layer ? [String(pad.layer)] : []);
      const point: Point = { x, y, layer: layers[0] ?? null };
      if (!info.points.some((p) => p.x === x && p.y === y && p.layer === point.layer)) {
        info.points.push(point);
      }
    }
    groupInfo.set(key, info);
  }

  const unroutedGroupSeen = new Set<string>();
  const unroutedConnections: string[] = [];
  const unroutedDetail: UnroutedDetail[] = [];
  for (const [key, info] of groupInfo) {
    if (info.routed || unroutedGroupSeen.has(key)) continue;
    unroutedGroupSeen.add(key);
    unroutedConnections.push(info.label);
    if (unroutedDetail.length < 10) {
      unroutedDetail.push({
        name: info.label,
        nets: [...info.nets].slice(0, 4),
        points: info.points.slice(0, 8).map((p) => ({
          x: round2(p.x),
          y: round2(p.y),
          layer: p.layer,
        })),
      });
    }
    if (unroutedConnections.length >= 40) break;
  }

  const sourceTraces = sourceTraceEls.length;
  const pcbTraces = pcbTraceEls.length;

  // routing stats: vias + per-layer trace length
  const traceLengthByLayerMm: Record<string, number> = {};
  let totalTraceLengthMm = 0;
  for (const el of pcbTraceEls) {
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
      const len = Math.hypot(bx - ax, by - ay);
      const layer = String(b.layer ?? a.layer ?? "?");
      totalTraceLengthMm += len;
      traceLengthByLayerMm[layer] = (traceLengthByLayerMm[layer] ?? 0) + len;
    }
  }
  for (const k of Object.keys(traceLengthByLayerMm)) {
    traceLengthByLayerMm[k] = round1(traceLengthByLayerMm[k]);
  }
  const stats = {
    vias: circuitJson.filter((el) => el.type === "pcb_via").length,
    totalTraceLengthMm: round1(totalTraceLengthMm),
    traceLengthByLayerMm,
  };

  const drcViolations = runDrcChecks(circuitJson);
  const congestion = computeCongestion(circuitJson);
  const ratsnest = computeRatsnest(groupInfo);

  const ok = errors.length === 0;
  const message = ok
    ? `Compile OK: ${components.length} components, ${nets.length} nets, ` +
      `${pcbTraces} routed pcb traces (${sourceTraces} source traces` +
      `${unroutedConnections.length ? `, ${unroutedConnections.length} UNROUTED` : ""})` +
      `, ${stats.vias} vias, ${round1(totalTraceLengthMm)}mm routed` +
      `${ratsnest.estimatedCrossings ? `, ~${ratsnest.estimatedCrossings} ratsnest crossings` : ""}` +
      `${drcViolations.length ? ` - ${drcViolations.length} DRC violation(s)` : " - DRC clean"}.`
    : `Compile finished with ${errors.length} error(s).`;

  return {
    ok,
    errors,
    components,
    nets,
    connections,
    unroutedConnections,
    unroutedDetail,
    drcViolations,
    sourceTraces,
    pcbTraces,
    stats,
    congestion,
    ratsnest,
    routingAttempts: 1,
    router: "default",
    message,
  };
}

/** obstacle coverage per board cell: where routing will struggle */
function computeCongestion(circuitJson: CircuitElement[]): CongestionCell[] {
  const board = circuitJson.find((el) => el.type === "pcb_board");
  const bw = board ? num(board.width) : null;
  const bh = board ? num(board.height) : null;
  if (!board || bw === null || bh === null || bw <= 0 || bh <= 0) return [];
  const center = (board.center as { x?: number; y?: number } | undefined) ?? {};
  const cx = num(center.x) ?? 0;
  const cy = num(center.y) ?? 0;

  const COLS = 6;
  const ROWS = 4;
  const cellW = bw / COLS;
  const cellH = bh / ROWS;
  const cover = Array.from({ length: ROWS }, () => new Array<number>(COLS).fill(0));

  const addBox = (minX: number, minY: number, maxX: number, maxY: number) => {
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const cellMinX = cx - bw / 2 + c * cellW;
        const cellMinY = cy - bh / 2 + r * cellH;
        const ix = Math.max(0, Math.min(maxX, cellMinX + cellW) - Math.max(minX, cellMinX));
        const iy = Math.max(0, Math.min(maxY, cellMinY + cellH) - Math.max(minY, cellMinY));
        cover[r][c] += (ix * iy) / (cellW * cellH);
      }
    }
  };

  for (const el of circuitJson) {
    if (el.type === "pcb_smtpad") {
      const x = num(el.x);
      const y = num(el.y);
      if (x === null || y === null) continue;
      const w = num(el.width) ?? (num(el.radius) ?? 0) * 2;
      const h = num(el.height) ?? (num(el.radius) ?? 0) * 2;
      addBox(x - w / 2, y - h / 2, x + w / 2, y + h / 2);
    } else if (el.type === "pcb_plated_hole" || el.type === "pcb_via") {
      const x = num(el.x);
      const y = num(el.y);
      const d = num(el.outer_diameter) ?? num(el.hole_diameter);
      if (x === null || y === null || d === null) continue;
      addBox(x - d / 2, y - d / 2, x + d / 2, y + d / 2);
    }
  }

  const colLetter = (c: number) => String.fromCharCode(65 + c);
  const cells: CongestionCell[] = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const coverage = Math.min(1, cover[r][c]);
      if (coverage < 0.2) continue;
      cells.push({
        cell: `${colLetter(c)}${r + 1}`,
        centerX: round1(cx - bw / 2 + (c + 0.5) * cellW),
        centerY: round1(cy - bh / 2 + (r + 0.5) * cellH),
        coverage: round2(coverage),
      });
    }
  }
  return cells.sort((a, b) => b.coverage - a.coverage).slice(0, 6);
}

/** ratsnest metrics: MST (Manhattan) length + crossings between net segments */
function computeRatsnest(
  groupInfo: Map<string, { label: string; points: Point[]; routed: boolean }>,
): CompileSummary["ratsnest"] {
  interface Seg {
    ax: number;
    ay: number;
    bx: number;
    by: number;
  }
  const netStats: RatsnestNet[] = [];
  const segsByNet: Seg[][] = [];
  let totalLengthMm = 0;

  for (const info of groupInfo.values()) {
    const pts = info.points;
    if (pts.length < 2) continue;
    // Manhattan MST (Prim) — approximates the ideal routed length
    const inTree = new Set<number>([0]);
    let length = 0;
    const segs: Seg[] = [];
    while (inTree.size < pts.length) {
      let bestD = Infinity;
      let bestI = -1;
      let bestJ = -1;
      for (const i of inTree) {
        for (let j = 0; j < pts.length; j++) {
          if (inTree.has(j)) continue;
          const d =
            Math.abs(pts[i].x - pts[j].x) + Math.abs(pts[i].y - pts[j].y);
          if (d < bestD) {
            bestD = d;
            bestI = i;
            bestJ = j;
          }
        }
      }
      if (bestJ === -1) break;
      inTree.add(bestJ);
      length += bestD;
      segs.push({
        ax: pts[bestI].x,
        ay: pts[bestI].y,
        bx: pts[bestJ].x,
        by: pts[bestJ].y,
      });
    }
    totalLengthMm += length;
    segsByNet.push(segs);
    const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
    const cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
    netStats.push({
      name: info.label.slice(0, 60),
      pads: pts.length,
      lengthMm: round1(length),
      centroidX: round1(cx),
      centroidY: round1(cy),
    });
  }

  // crossings between MST segments of DIFFERENT nets (bounding-box pre-filter)
  let estimatedCrossings = 0;
  for (let i = 0; i < segsByNet.length; i++) {
    for (let j = i + 1; j < segsByNet.length; j++) {
      for (const a of segsByNet[i]) {
        for (const b of segsByNet[j]) {
          if (estimatedCrossings >= 200) break;
          if (segmentsCross(a, b)) estimatedCrossings++;
        }
      }
    }
  }

  return {
    totalLengthMm: round1(totalLengthMm),
    estimatedCrossings,
    longestNets: netStats.sort((a, b) => b.lengthMm - a.lengthMm).slice(0, 5),
  };
}

function segmentsCross(
  a: { ax: number; ay: number; bx: number; by: number },
  b: { ax: number; ay: number; bx: number; by: number },
): boolean {
  const d1 = cross(b, a.ax, a.ay);
  const d2 = cross(b, a.bx, a.by);
  const d3 = cross(a, b.ax, b.ay);
  const d4 = cross(a, b.bx, b.by);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function cross(
  s: { ax: number; ay: number; bx: number; by: number },
  px: number,
  py: number,
): number {
  return (s.bx - s.ax) * (py - s.ay) - (s.by - s.ay) * (px - s.ax);
}
