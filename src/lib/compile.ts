import { CircuitRunner, runTscircuitCode } from "@tscircuit/eval";
import { getPlatformConfig } from "@tscircuit/eval/platform-config";
import { AutoroutingPipelineSolver } from "@tscircuit/capacity-autorouter";
import { runDrcChecks, type DrcViolation } from "./drc";
import { runPrcChecks, type PrcViolation } from "./prc";
import { emptyErcReport, runErcChecks, type ErcReport } from "./erc";
import {
  analyzeFootprints,
  emptyFootprintProvenance,
  type FootprintProvenance,
} from "./footprint-provenance";
import {
  analyzeSchematic,
  emptySchematicQuality,
  type SchematicQuality,
} from "./schematic-quality";
import { DEFAULT_DESIGN_RULES, FAB_RULESETS } from "./design-rules";
import {
  applyManualEditsToFsMap,
  countManualEdits,
  parseManualEdits,
  MANUAL_EDITS_PATH,
} from "./manual-edits";
import type { FsMap } from "./project-store";
import {
  assembleCircuit,
  findSections,
  generateSectionCandidates,
  spliceTraces,
  unrouteSections,
  type SectionVariants,
} from "./variants";

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
  /** electrical checks (Fase 3.e): decoupling, pour islands, return vias, power widths */
  prcViolations: PrcViolation[];
  /**
   * multi-ruleset fab report (Fase 3.f): violations per manufacturer ruleset,
   * cheapest first. fabClass = cheapest ruleset with zero violations (null =
   * redesign needed). Enhanced/HDI looms allow smaller features at higher cost.
   */
  fabClasses: Array<{ key: string; label: string; costTier: number; violations: number; ok: boolean }>;
  fabClass: string | null;
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
  /**
   * readability of the SCHEMATIC drawing: overlapping symbols, net labels over
   * symbols, wire crossings, sheet density, functional sections found in the
   * sources. Same role congestion/ratsnest play for the PCB.
   */
  schematicQuality: SchematicQuality;
  /** regole elettriche sullo schema: piedini scollegati, net a un nodo, sigle */
  erc: ErcReport;
  /**
   * quanti vincoli geometrici ha messo l'essere umano dall'editor: componenti
   * fissati sullo schema, componenti fissati sul rame, piste instradate a mano.
   * L'agente li deve sapere perche' su quei componenti il suo posizionamento
   * non ha piu' effetto.
   */
  manualEdits: { schematic: number; pcb: number; traceHints: number; total: number };
  /**
   * da dove viene la geometria dei pad: verificata dal produttore, scritta
   * esplicitamente, misura standard di un passivo, oppure generica e quindi
   * solo plausibile
   */
  footprintProvenance: FootprintProvenance;
  /**
   * convergence checklist (Fase 3.h): every loop target with its count, and
   * allGreen when everything passes (errors 0, unrouted 0, DRC 0, PRC 0,
   * schematic overlaps 0, at least one fab ruleset satisfied). The agent
   * iterates until allGreen or explains the trade-off it accepted.
   */
  targets: {
    errors: number;
    unrouted: number;
    drcViolations: number;
    prcViolations: number;
    schematicOverlaps: number;
    fabClass: string | null;
    allGreen: boolean;
  };
  routingAttempts: number;
  router: "default" | "local_retry" | "variants";
  /** per-section variant report (Fase 3.d), present when variants were generated */
  variantReport?: Array<{
    section: string;
    connections: number;
    picked: string | null;
    closeCall: boolean;
    candidates: Array<{ label: string; traces: number; vias: number; lengthMm: number }>;
  }>;
  message: string;
}

export interface CompileResult {
  summary: CompileSummary;
  circuitJson: unknown[];
  /** raw per-section candidates (with traces), when the variant engine ran */
  variants?: SectionVariants[];
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
  /**
   * routing candidates per section generated by the variant engine (Fase 3.d):
   * 0 = legacy core routing only, 1 = rules-compliant single pass (default),
   * 3 = full variant mode with per-section candidate report
   */
  variants?: number;
}

/**
 * Authoritative server-side compile: same @tscircuit/eval the browser uses,
 * but its summary is what the LLM sees (the self-correction feedback loop).
 *
 * Attempt 0 is the as-authored compile (board autorouter prop, cloud
 * freerouting included). The variant engine then unroutes the result and
 * re-routes every section with the JLCPCB design rules injected into the
 * routing problem (core plans vias at 0.2/0.3mm, below fab minimums): the
 * rules-compliant assembled circuit competes with attempt 0 on the same
 * deterministic score (errors -> unrouted -> DRC -> vias -> length).
 * If connections are still open after that, the local pipeline re-routes the
 * whole board at escalating effort (with the same fab minimums): the variant
 * engine only touches named sections, so a link BETWEEN sections has no other
 * chance of being closed.
 */
export async function compileProject(
  fsMap: FsMap,
  opts: CompileOptions = {},
): Promise<CompileResult> {
  const retries = Math.max(0, Math.min(opts.retries ?? 2, 3));
  const variantCount = Math.max(0, Math.min(opts.variants ?? 1, 4));
  const efforts = [2, 5, 10];

  // state object: flow narrowing can't track assignments made inside closures
  const state: {
    best: { circuitJson: CircuitElement[]; router: CompileSummary["router"] } | null;
    bestScore: CircuitScore | null;
    attempts: number;
    fatalError: string | null;
    variants: SectionVariants[] | null;
  } = { best: null, bestScore: null, attempts: 0, fatalError: null, variants: null };

  const consider = (circuitJson: CircuitElement[], router: CompileSummary["router"]) => {
    const score = scoreCircuit(circuitJson);
    const prev = state.bestScore;
    if (
      !prev ||
      score.errors < prev.errors ||
      (score.errors === prev.errors && score.unrouted < prev.unrouted) ||
      (score.errors === prev.errors &&
        score.unrouted === prev.unrouted &&
        score.drc < prev.drc) ||
      (score.errors === prev.errors &&
        score.unrouted === prev.unrouted &&
        score.drc === prev.drc &&
        score.vias < prev.vias) ||
      (score.errors === prev.errors &&
        score.unrouted === prev.unrouted &&
        score.drc === prev.drc &&
        score.vias === prev.vias &&
        score.lengthMm < prev.lengthMm)
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

  // variant engine: re-route each named section with design rules injected,
  // keeping the core routing for the board-level backbone
  if (variantCount > 0 && state.best && state.bestScore && state.bestScore.errors === 0) {
    try {
      state.attempts += 1;
      const sections = findSections(state.best.circuitJson);
      if (sections.length > 0) {
        const base = unrouteSections(
          state.best.circuitJson,
          new Set(sections.map((s) => s.subcircuitId)),
        );
        const sectionVariants = sections.map((section) =>
          generateSectionCandidates(base, section, variantCount, undefined, (traces) => {
            // violations this candidate would introduce if spliced alone
            // (upsized JLCPCB vias can clash with pads the solver planned around)
            try {
              return runDrcChecks(
                spliceTraces(base, section.subcircuitId, traces, "eval"),
              ).length;
            } catch {
              return 0;
            }
          }),
        );
        const picks = sectionVariants
          .filter((sv) => sv.candidates.length > 0)
          .map((sv) => ({ section: sv.section, candidate: sv.candidates[sv.picked] }));
        // every section must contribute, otherwise the assembled circuit is incomplete
        if (picks.length === sections.length) {
          state.variants = sectionVariants;
          const assembled = assembleCircuit(base, picks);
          consider(assembled, "variants");
        }
      }
    } catch {
      // a failed variant pass leaves attempt-0 as the best result
    }
  }

  /*
   * Ritenta con il router locale a sforzo crescente finche' restano
   * collegamenti aperti. Prima girava SOLO col motore a varianti disattivato,
   * ed era un buco: le varianti ri-sbrogliano le singole sezioni e lasciano
   * intatta la dorsale fra una sezione e l'altra, quindi un collegamento
   * aperto FRA sezioni (tipico dei pin di un QFP che devono raggiungere pezzi
   * lontani) non veniva piu' attaccato da nessuno e la scheda restava
   * incompleta. Costa tempo solo quando la scheda e' gia' incompleta, e
   * `consider` tiene il risultato solo se migliora il punteggio.
   */
  for (
    let i = 0;
    i < retries && state.bestScore && state.bestScore.unrouted > 0;
    i++
  ) {
    try {
      state.attempts += 1;
      const cj = await compileWithLocalRouter(fsMap, efforts[i] ?? 10);
      consider(cj, "local_retry");
      // e la stessa rotta con le piste sottili portate al minimo di fabbrica:
      // allargare il rame puo' avvicinare net diverse, quindi non si impone —
      // si presenta come alternativa e vince solo se il DRC migliora
      const widened = widenThinTraces(cj);
      consider(widened, "local_retry");
      // e con le uscite dai pad raddrizzate (regola di casa)
      consider(straightenPinEscapes(widened), "local_retry");
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
  const summary = summarize(circuitJson, fsMap);
  summary.routingAttempts = state.attempts;
  summary.router = state.best.router;
  if (state.variants) {
    summary.variantReport = state.variants.map((sv) => ({
      section: sv.section.name,
      connections: sv.connections,
      picked: sv.candidates[sv.picked]?.label ?? null,
      closeCall: sv.closeCall,
      candidates: sv.candidates.map((c) => ({
        label: c.label,
        traces: c.stats.traces,
        vias: c.stats.vias,
        lengthMm: c.stats.lengthMm,
      })),
    }));
  }
  if (state.best.router === "local_retry") {
    summary.message +=
      " (routed by the LOCAL pipeline after the board router left connections unrouted — consider autorouterEffortLevel=\"5x\" or adjusting placement)";
  }
  if (state.best.router === "variants") {
    summary.message += " (routed by the variant engine with JLCPCB design rules)";
  }
  return { summary, circuitJson, variants: state.variants ?? undefined };
}

/** re-summarize an already-assembled circuit (used by pick_variant) */
export function summarizeCircuit(
  circuitJson: unknown[],
  sources: FsMap = {},
): CompileSummary {
  return summarize(circuitJson as CircuitElement[], sources);
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
    prcViolations: [],
    fabClasses: [],
    fabClass: null,
    sourceTraces: 0,
    pcbTraces: 0,
    stats: { vias: 0, totalTraceLengthMm: 0, traceLengthByLayerMm: {} },
    congestion: [],
    ratsnest: { totalLengthMm: 0, estimatedCrossings: 0, longestNets: [] },
    schematicQuality: emptySchematicQuality(),
    erc: emptyErcReport(),
    footprintProvenance: emptyFootprintProvenance(),
    targets: {
      errors: 1,
      unrouted: 0,
      drcViolations: 0,
      prcViolations: 0,
      schematicOverlaps: 0,
      fabClass: null,
      allGreen: false,
    },
    routingAttempts: 1,
    router: "default",
    message,
  };
}

interface CircuitScore {
  errors: number;
  unrouted: number;
  drc: number;
  vias: number;
  lengthMm: number;
}

/** errors + unrouted groups + DRC + via count + length: minimized across candidates */
function scoreCircuit(circuitJson: CircuitElement[]): CircuitScore {
  return {
    errors: circuitJson.filter((el) => el.type.endsWith("_error")).length,
    unrouted: computeUnroutedGroupKeys(circuitJson).size,
    // si contano le OCCORRENZE, non le famiglie: aggregate, 110 uscite storte
    // e 1 sola pesano uguale e il confronto fra due rotte non vede la differenza
    drc: runDrcChecks(circuitJson).reduce(
      (n, v) => n + Math.max(1, v.points?.length ?? 1),
      0,
    ),
    vias: circuitJson.filter((el) => el.type === "pcb_via").length,
    lengthMm: totalWireLengthMm(circuitJson),
  };
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

const TRACE_TOUCH_MM = 0.4;

/**
 * Unrouted connectivity groups. Two detection modes:
 * - traces with source_trace_id (core routing): id mapping, grouping by net
 * - spliced traces (variant engine, no source ids): a group counts as routed
 *   when at least one of its pads has copper (a wire route point) nearby
 */
function computeUnroutedGroupKeys(circuitJson: CircuitElement[]): Set<string> {
  const sourceTraceEls = circuitJson.filter((el) => el.type === "source_trace");
  const pcbTraceEls = circuitJson.filter((el) => el.type === "pcb_trace");
  const groupKey = (el: CircuitElement) =>
    String(el.subcircuit_connectivity_map_key ?? el.source_trace_id ?? "");
  const unrouted = new Set<string>();
  if (sourceTraceEls.length === 0) return unrouted;

  const hasSourceIds = pcbTraceEls.some((el) => el.source_trace_id);
  if (hasSourceIds) {
    const routedSourceIds = new Set(
      pcbTraceEls.map((el) => String(el.source_trace_id ?? "")).filter(Boolean),
    );
    const routedGroups = new Set(
      sourceTraceEls
        .filter((el) => routedSourceIds.has(String(el.source_trace_id ?? "")))
        .map(groupKey),
    );
    for (const el of sourceTraceEls) {
      const key = groupKey(el);
      if (!routedGroups.has(key)) unrouted.add(key);
    }
    return unrouted;
  }

  // geometric mode: pad positions per group from pcb_ports
  const pcbPortBySourcePort = new Map<string, CircuitElement>();
  for (const el of circuitJson) {
    if (el.type === "pcb_port" && el.source_port_id) {
      pcbPortBySourcePort.set(String(el.source_port_id), el);
    }
  }
  const wirePoints: Array<{ x: number; y: number }> = [];
  for (const el of pcbTraceEls) {
    const route = (el.route as Array<Record<string, unknown>> | undefined) ?? [];
    for (const p of route) {
      if (p.route_type !== "wire") continue;
      const x = num(p.x);
      const y = num(p.y);
      if (x !== null && y !== null) wirePoints.push({ x, y });
    }
  }
  const groupPoints = new Map<string, Array<{ x: number; y: number }>>();
  for (const el of sourceTraceEls) {
    const key = groupKey(el);
    const pts = groupPoints.get(key) ?? [];
    for (const portId of (el.connected_source_port_ids as string[] | undefined) ?? []) {
      const pad = pcbPortBySourcePort.get(String(portId));
      const x = pad ? num(pad.x) : null;
      const y = pad ? num(pad.y) : null;
      if (x !== null && y !== null && !pts.some((p) => p.x === x && p.y === y)) {
        pts.push({ x, y });
      }
    }
    groupPoints.set(key, pts);
  }
  for (const [key, pts] of groupPoints) {
    const touched = pts.some((pt) =>
      wirePoints.some(
        (w) => Math.abs(w.x - pt.x) <= TRACE_TOUCH_MM && Math.abs(w.y - pt.y) <= TRACE_TOUCH_MM,
      ),
    );
    if (!touched) unrouted.add(key);
  }
  return unrouted;
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
      adaptSolver(
        new AutoroutingPipelineSolver(
          withFabRules(simpleRouteJson) as never,
          { effort } as never,
        ),
      ) as never,
  };
}


/**
 * Copia del circuito in cui ogni pista esce dal pad DRITTA: dove il router ha
 * attaccato al pad un segmento diagonale, si inserisce un tratto breve
 * perpendicolare al bordo del pad e solo dopo si riparte verso il punto
 * successivo. Regola di casa (Niccolo', 2026-07-26): un diagonale attaccato al
 * pad riduce il rame utile del giunto e lascia angoli acuti all'incisione.
 *
 * Come per le piste sottili, il risultato gareggia con l'originale invece di
 * sostituirlo: spostare rame puo' avvicinare net diverse, e a decidere e' il DRC.
 */
function straightenPinEscapes(circuitJson: CircuitElement[]): CircuitElement[] {
  const pads = circuitJson.filter((el) => el.type === "pcb_smtpad");
  const padAt = (x: number, y: number): CircuitElement | null =>
    pads.find((el) => {
      const px = num(el.x);
      const py = num(el.y);
      if (px === null || py === null) return false;
      const w = (num(el.width) ?? (num(el.radius) ?? 0) * 2) / 2;
      const h = (num(el.height) ?? (num(el.radius) ?? 0) * 2) / 2;
      return Math.abs(px - x) <= w + 1e-6 && Math.abs(py - y) <= h + 1e-6;
    }) ?? null;

  const TOL = 0.02;
  const MAX_STUB = 0.3;

  return circuitJson.map((el) => {
    if (el.type !== "pcb_trace") return el;
    const route = (el.route as Array<Record<string, unknown>> | undefined) ?? [];
    if (route.length < 2) return el;

    const next = [...route];
    let changed = false;

    // si lavora sui due capi: e' li' che la pista tocca un pad
    for (const end of ["start", "end"] as const) {
      const i = end === "start" ? 0 : next.length - 1;
      const j = end === "start" ? 1 : next.length - 2;
      const from = next[i];
      const to = next[j];
      const x = num(from.x);
      const y = num(from.y);
      const tx = num(to.x);
      const ty = num(to.y);
      if (x === null || y === null || tx === null || ty === null) continue;

      const dx = tx - x;
      const dy = ty - y;
      if (Math.abs(dx) <= TOL || Math.abs(dy) <= TOL) continue; // gia' dritta

      const pad = padAt(x, y);
      if (!pad) continue;

      // perpendicolare al bordo da cui si esce: sul lato lungo del pad
      const pw = num(pad.width) ?? 0;
      const ph = num(pad.height) ?? 0;
      const horizontal = pw > ph ? true : ph > pw ? false : Math.abs(dx) >= Math.abs(dy);
      const span = Math.abs(horizontal ? dx : dy);
      const stub = Math.min(MAX_STUB, span * 0.4);
      if (stub <= TOL) continue;

      const point = {
        ...from,
        x: horizontal ? x + Math.sign(dx) * stub : x,
        y: horizontal ? y : y + Math.sign(dy) * stub,
      };
      next.splice(end === "start" ? 1 : next.length - 1, 0, point);
      changed = true;
    }

    return changed ? { ...el, route: next } : el;
  });
}

/**
 * Copia del circuito con ogni segmento di pista sotto la larghezza minima
 * portato al minimo di fabbrica. Il solver a volte assottiglia un tratto per
 * passare in mezzo a due ostacoli: il tratto sottile non e' producibile, ma
 * allargarlo puo' violare una distanza. Per questo il risultato viene messo in
 * gara con l'originale invece che sostituirlo.
 */
function widenThinTraces(circuitJson: CircuitElement[]): CircuitElement[] {
  const min = DEFAULT_DESIGN_RULES.minTraceWidthMm;
  return circuitJson.map((el) => {
    if (el.type !== "pcb_trace") return el;
    const route = el.route as Array<Record<string, unknown>> | undefined;
    if (!route?.some((p) => typeof p.width === "number" && p.width < min)) return el;
    return {
      ...el,
      route: route.map((p) =>
        typeof p.width === "number" && p.width < min ? { ...p, width: min } : p,
      ),
    };
  });
}

/**
 * Il problema di routing che il core passa al solver porta i SUOI minimi
 * (piste 0.1mm, via 0.2/0.3mm), sotto i minimi di fabbrica: cosi' il router
 * locale completava lo sbroglio ma con piste e via non producibili. Qui i
 * minimi vengono riscritti con le regole di progetto prima che il solver
 * pianifichi, che e' l'unico momento in cui contano — allargarli dopo
 * significherebbe spostare rame gia' piazzato.
 */
function withFabRules(simpleRouteJson: unknown): unknown {
  if (!simpleRouteJson || typeof simpleRouteJson !== "object") return simpleRouteJson;
  const r = DEFAULT_DESIGN_RULES;
  const srj = simpleRouteJson as Record<string, unknown>;
  const atLeast = (key: string, min: number) => {
    const current = typeof srj[key] === "number" ? (srj[key] as number) : 0;
    if (current < min) srj[key] = min;
  };
  atLeast("minTraceWidth", r.minTraceWidthMm);
  atLeast("minViaHoleDiameter", r.minViaHoleMm);
  atLeast("min_via_hole_diameter", r.minViaHoleMm);
  atLeast("minViaPadDiameter", r.minViaDiameterMm);
  atLeast("min_via_pad_diameter", r.minViaDiameterMm);
  atLeast("minViaDiameter", r.minViaDiameterMm);
  atLeast("minTraceToPadEdgeClearance", r.minClearanceMm);
  // margine dagli ostacoli: il solver, dove non lo trova, ne assume uno di
  // 0.2mm in certi punti e ZERO in altri, ed e' li' che nascono le via
  // appoggiate al pad di un'altra net. Si impone il piu' alto fra i due, mai
  // uno piu' stretto di quelli che il solver userebbe da solo.
  atLeast("defaultObstacleMargin", Math.max(r.minClearanceMm, 0.2));
  // ogni connessione puo' dichiarare la propria larghezza: le tracce di
  // potenza restano larghe, quelle di segnale salgono al minimo di fabbrica
  for (const conn of (srj.connections as Array<Record<string, unknown>>) ?? []) {
    if (typeof conn.minTraceWidth === "number" && conn.minTraceWidth < r.minTraceWidthMm) {
      conn.minTraceWidth = r.minTraceWidthMm;
    }
  }
  return srj;
}


/**
 * Il core di tscircuit pilota l'autorouter con un'API a EVENTI
 * (`.on("complete"|"error"|"progress")` + `.start()`), mentre
 * AutoroutingPipelineSolver espone `solve()` in modo sincrono: senza adattatore
 * il core chiama `.on` su un oggetto che non ce l'ha e il routing salta
 * ("activeAutorouter.on is not a function"), lasciando le connessioni aperte.
 */
interface SolverLike {
  solve: () => void;
  getOutputSimplifiedPcbTraces: () => unknown[];
}

function adaptSolver(solver: SolverLike) {
  const handlers = new Map<string, (event: unknown) => void>();
  let stopped = false;
  return {
    on(event: string, cb: (event: unknown) => void) {
      handlers.set(event, cb);
    },
    start() {
      // asincrono: gli handler vengono registrati dopo la creazione
      queueMicrotask(() => {
        if (stopped) return;
        try {
          solver.solve();
          if (stopped) return;
          handlers.get("complete")?.({ traces: solver.getOutputSimplifiedPcbTraces() });
        } catch (error) {
          handlers.get("error")?.({ error });
        }
      });
    },
    /** il core lo chiama a fine fase per liberare il router */
    stop() {
      stopped = true;
    },
  };
}

// ---------------------------------------------------------------------------
// summary building (geometric feedback for the model)
// ---------------------------------------------------------------------------

function summarize(
  circuitJson: CircuitElement[],
  sources: FsMap = {},
): CompileSummary {
  const allErrors = circuitJson
    .filter((el) => el.type.endsWith("_error"))
    .map((el) => ({
      type: el.type,
      message: String(el.message ?? el.error_type ?? JSON.stringify(el)).slice(0, 500),
    }));

  /*
   * Quando l'autorouting viene SALTATO per errori di piazzamento, ogni
   * connessione risulta mancante: 11 sovrapposizioni producono un centinaio di
   * trace_missing/port_not_connected che sono solo la conseguenza. Elencarli
   * tutti annega il modello e lo fa girare a vuoto sui sintomi.
   * Qui si mette davanti la CAUSA e si dichiarano derivati gli altri.
   */
  const DERIVED = new Set(["pcb_trace_missing_error", "pcb_port_not_connected_error"]);
  const routingSkipped = allErrors.some(
    (e) => e.type === "pcb_autorouting_error" && /skipped/i.test(e.message),
  );
  const rootCauses = allErrors.filter((e) => !DERIVED.has(e.type));
  const derivedCount = allErrors.length - rootCauses.length;

  const errors = routingSkipped && derivedCount > 0
    ? [
        {
          type: "root_cause_first",
          message:
            `L'autorouting NON e' stato eseguito a causa di ${rootCauses.length} problemi di ` +
            `piazzamento: risolvi SOLO quelli e le ${derivedCount} connessioni mancanti ` +
            `spariranno da sole (sono la conseguenza, non la causa). ` +
            `Sposta i componenti che si sovrappongono e riporta tutto dentro il bordo scheda.`,
        },
        ...rootCauses,
      ]
    : allErrors;

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

  const traceLabel = (el: CircuitElement) =>
    String(el.display_name ?? el.source_trace_id ?? "trace");
  const connections = sourceTraceEls.map(traceLabel).slice(0, 40);

  // Routing is judged per CONNECTIVITY GROUP, not per source trace: traces on
  // the same net get merged by the router, so only some of them carry the
  // pcb_trace. A group counts as unrouted only if NONE of its traces routed
  // (id-based or geometric detection, depending on who produced the traces).
  const groupKey = (el: CircuitElement) =>
    String(el.subcircuit_connectivity_map_key ?? el.source_trace_id ?? "");
  const unroutedKeys = computeUnroutedGroupKeys(circuitJson);

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
      routed: !unroutedKeys.has(key),
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
  const prcViolations = runPrcChecks(circuitJson);
  // multi-ruleset: the main DRC already covers the first (cheapest) ruleset
  const fabClasses = FAB_RULESETS.map((rs) => {
    const violations =
      rs.rules === FAB_RULESETS[0].rules
        ? drcViolations.length
        : runDrcChecks(circuitJson, rs.rules).length;
    return {
      key: rs.key,
      label: rs.label,
      costTier: rs.costTier,
      violations,
      ok: violations === 0,
    };
  }).sort((a, b) => a.costTier - b.costTier);
  const fabClass = fabClasses.find((f) => f.ok)?.label ?? null;
  const congestion = computeCongestion(circuitJson);
  const ratsnest = computeRatsnest(groupInfo);
  const schematicQuality = analyzeSchematic(circuitJson, sources);
  const footprintProvenance = analyzeFootprints(circuitJson, sources);
  const erc = runErcChecks(circuitJson);

  /*
   * Un layout schematico disattivato da schX/schY produce un disegno inservibile
   * pur compilando senza errori. Reso bloccante: la regola "non fermarti finche'
   * il compile ha errori" e' l'unica leva che costringe il modello a rifare il
   * layout invece di consegnare un ammasso di simboli sovrapposti.
   */
  const schematicBlocker =
    schematicQuality.symbolOverlapCount >= 3 && schematicQuality.schCoordFiles.length > 0
      ? [
          {
            type: "schematic_layout_disabled",
            message:
              `${schematicQuality.schCoordFiles.join(", ")} set schX/schY on placed ` +
              `components: this disables the schematic auto layout for the whole group and ` +
              `is why ${schematicQuality.symbolOverlapCount} symbol pairs overlap. Remove ` +
              `every schX/schY and give each component a schSectionName instead.`,
          },
        ]
      : [];
  const reportedErrors = [...schematicBlocker, ...errors];

  const ok = reportedErrors.length === 0;
  // convergence checklist: the agent's loop targets in one place (Fase 3.h)
  const targets = {
    errors: reportedErrors.length,
    unrouted: unroutedConnections.length,
    drcViolations: drcViolations.length,
    prcViolations: prcViolations.length,
    schematicOverlaps:
      schematicQuality.symbolOverlapCount + schematicQuality.labelOverlapCount,
    fabClass,
    allGreen:
      reportedErrors.length === 0 &&
      unroutedConnections.length === 0 &&
      drcViolations.length === 0 &&
      prcViolations.length === 0 &&
      schematicQuality.symbolOverlapCount + schematicQuality.labelOverlapCount === 0 &&
      fabClass !== null,
  };
  const message = ok
    ? `Compile OK: ${components.length} components, ${nets.length} nets, ` +
      `${pcbTraces} routed pcb traces (${sourceTraces} source traces` +
      `${unroutedConnections.length ? `, ${unroutedConnections.length} UNROUTED` : ""})` +
      `, ${stats.vias} vias, ${round1(totalTraceLengthMm)}mm routed` +
      `${ratsnest.estimatedCrossings ? `, ~${ratsnest.estimatedCrossings} ratsnest crossings` : ""}` +
      `${drcViolations.length ? ` - ${drcViolations.length} DRC violation(s)` : " - DRC clean"}` +
      `${prcViolations.length ? ` - ${prcViolations.length} electrical issue(s)` : ""}` +
      ` - fab: ${fabClass ?? "NO RULESET SATISFIED (redesign needed)"}` +
      `${
        schematicQuality.symbolOverlapCount
          ? ` - SCHEMATIC: ${schematicQuality.symbolOverlapCount} overlapping symbol pair(s)`
          : ""
      }` +
      `${
        footprintProvenance.issues.some((i) => i.severity === "fail")
          ? ` - ${footprintProvenance.issues.filter((i) => i.severity === "fail").length} FOOTPRINT non verificati`
          : ""
      }` +
      `${
        schematicQuality.sections.length
          ? ` - schematic in ${schematicQuality.sections.length} sections`
          : " - schematic NOT sectioned"
      }.`
    : `Compile finished with ${reportedErrors.length} error(s).`;

  return {
    ok,
    errors: reportedErrors,
    components,
    nets,
    connections,
    unroutedConnections,
    unroutedDetail,
    drcViolations,
    prcViolations,
    fabClasses,
    fabClass,
    sourceTraces,
    pcbTraces,
    stats,
    congestion,
    ratsnest,
    schematicQuality,
    erc,
    footprintProvenance,
    targets,
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
