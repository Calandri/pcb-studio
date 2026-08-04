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
import {
  DEFAULT_DESIGN_RULES,
  FAB_RULESETS,
  resolveDesignRules,
  type DesignRules,
} from "./design-rules";
import { routeBoard, type RouteReport } from "./autoroute";
import { placeComponents, type PlacementReport } from "./placement";
import {
  computeUnroutedGroupKeys,
  scoreCircuit,
  type CircuitScore,
} from "./route-score";
import {
  nudgeCrowdedVias,
  snapTo45,
  stitchToPlanes,
  straightenPinEscapes,
  widenThinTraces,
} from "./house-rules";
import {
  applyManualEditsToFsMap,
  countManualEdits,
  emptyManualEdits,
  injectManualEdits,
  parseManualEdits,
  readAttr,
  scanJsxTags,
  MANUAL_EDITS_PATH,
} from "./manual-edits";
import { applyManualRoutes } from "./manual-routes";
import { ricolaPiani, type EsitoRicolata } from "./pours-recompute";
import { Profiler, routerPhases, type Profile } from "./profile";

/** the pour numbers, in the shape the summary declares them */
const esitoColate = (e: EsitoRicolata): NonNullable<CompileSummary["pours"]> => ({
  ricalcolate: e.ricolate,
  areaPrimaMm2: e.areaPrimaMm2,
  areaDopoMm2: e.areaDopoMm2,
  padRuotati: e.padRuotatiAggiunti,
  apertureRitagliate: e.colateScavate,
  bricioleTolte: e.bricioleTolte,
  orfaneTolte: e.orfaneTolte,
  viaRiconosciute: e.viaRiconosciute,
});
import {
  analyzePlacement,
  emptyPlacementQuality,
  type PlacementQuality,
} from "./placement-quality";
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
  /** electrical rules on the schematic: unconnected pins, single-node nets, reference designators */
  erc: ErcReport;
  /**
   * Where the parts are: overlaps, copper outside the board outline, connectors
   * far from the edge. Comes BEFORE the copper — if two components touch,
   * the autorouter does not start and the board ends up with no traces,
   * through no fault of the routing.
   */
  placement: PlacementQuality;
  /**
   * how many geometric constraints the human has set from the editor:
   * components pinned on the schematic, components pinned on the copper,
   * traces routed by hand. The agent must know this because on those
   * components its placement has no effect anymore.
   */
  manualEdits: { schematic: number; pcb: number; traceHints: number; total: number };
  /** fabrication rules chosen for THIS project (design-rules.json) */
  designRules: { preset: string; label: string; isCustom: boolean; rules: DesignRules };
  /**
   * Where the time went: our phases plus the router's internal ones.
   * Without this, "compilation is slow" stays an impression and one
   * optimizes at random.
   */
  profile: Profile;
  /**
   * where the pad geometry comes from: verified by the manufacturer, written
   * explicitly, a passive's standard size, or generic and therefore only
   * plausible
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
  router: "default" | "local_retry" | "variants" | "loop";
  /** rounds of the routing loop: what was redone and why */
  routeReport?: RouteReport;
  /**
   * What the placer did before routing: how many clearance violations there
   * were between parts, how many remain, how many parts it moved. The agent
   * must know this because a violation that remains here is not a copper
   * problem: it is a part that does not fit, and the design must change.
   */
  placementReport?: PlacementReport;
  /**
   * What the planes did when they were poured again at the end, with all the
   * copper in place: how many were recomputed, how much copper they hold, and
   * what was thrown away. The scraps matter — a piece of an island that our
   * clearances cut loose is copper the file had and the board will not, and
   * nobody would see it go without this line.
   */
  pours?: {
    ricalcolate: number;
    areaPrimaMm2: number;
    areaDopoMm2: number;
    padRuotati: number;
    apertureRitagliate: number;
    bricioleTolte: number;
    orfaneTolte: number;
    viaRiconosciute: number;
  };
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
  /**
   * The positions the placer decided, when it ran. They come out of here so
   * the caller can WRITE them: before, they lived only inside the compile —
   * injected into a copy of the sources and then thrown away. The board in
   * cache had a layout that no file described, so the next compile invented
   * another one, and the parts appeared to move on their own.
   */
  placements?: Array<{
    name: string;
    center: { x: number; y: number };
    /** absolute rotation, when the magnet turned the part */
    rotation?: number;
  }>;
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
  /**
   * Cap on routing-loop rounds (0 = off). Deliberately high: what should stop
   * it is the result or the time, not a counter. The real cap is the time
   * budget inside autoroute.ts.
   */
  routeRounds?: number;
  /** has a vision model look at the drawing and uses what it finds */
  routeVision?: boolean;
  /** time cap for the whole compilation (default 9 minutes) */
  budgetMs?: number;
  /**
   * Tidies up the components before routing. OFF by default: placement is a
   * decision, not a consequence.
   *
   * It used to run on every compilation, and treated as untouchable only the
   * parts registered in manual-edits.json — the ones dragged with the mouse.
   * Everything else got reshuffled, including positions written on purpose in
   * the code by whoever designed the board. Anyone pressing "recompile" after
   * tidying the layout would find it undone, and that is the fastest way to
   * make a tool lose trust: a person's work is not thrown away on the
   * program's own initiative.
   *
   * Now only those who ask for it turn it on.
   */
  place?: boolean;
  /**
   * How many different arrangements to try before choosing (default 10).
   * Violations, estimated copper and density are measured, and the best one
   * wins. The number is parametric on purpose: on a hard board raising it to
   * a hundred or a thousand costs seconds and can change the routing outcome.
   */
  placeAttempts?: number;
  /**
   * Parts to keep still during placement, beyond the ones pinned by the user.
   * Needed for the "only the selected" scope: you tidy one block without
   * reshuffling the board around it.
   */
  placeLocked?: string[];
  /** refinement rounds per zone after the arrangement has been chosen */
  placeZoneRounds?: number;
  /**
   * Whether to lay copper. Default true; with `false` the compile stops at the
   * geometry and the copper of the previous board is CARRIED OVER as it is.
   *
   * "Recompile" and "route" are two different gestures. Recompiling means
   * reading the files again and showing the real board: it takes seconds. The
   * routing takes minutes, redoes work already done, and above all it is a
   * decision — you route when you have finished moving things, not every time
   * you look at the board. Tying the two together meant paying minutes for
   * every refresh and throwing away good copper.
   *
   * The carried-over copper is HONEST, not hidden: the traces of a component
   * that has moved no longer land on its pads, and the checks say so. What
   * fixes them is "close the missing ones", which redoes only those.
   */
  route?: boolean;
  /**
   * The already compiled board whose copper to carry over when `route` is
   * false. Without it, recompiling shows a board with no copper.
   */
  keepCopperFrom?: unknown[];
  /**
   * The floorplan by sections, decided by the model (sezioni.ts): one rectangle
   * per component. When it is there the solver places INSIDE the sections,
   * instead of deciding the layout on its own with a magnet and a repulsion.
   *
   * It arrives from outside and is not computed here on purpose: asking a model
   * is a network call with its own timings and its own failures, and it must not
   * live inside the compile. Whoever wants the sections asks for them first,
   * gets a plan they can read, and then compiles.
   */
  placeZoneOfComponent?: Map<string, { minX: number; maxX: number; minY: number; maxY: number }>;
  /**
   * Progress channel: compilation takes minutes and whoever is watching must
   * see how far along it is, not a spinning bar. Each step says what it is
   * doing and, when it has a drawing to show, it sends it.
   */
  onProgress?: (event: CompileProgress) => void;
}

export interface CompileProgress {
  /** current phase, in Italian, ready to be shown */
  step: string;
  /** short detail: "5 violazioni -> 0", "giro 2, 12 zone rifatte" */
  detail?: string;
  /** indicative progress fraction, 0..1 */
  progress?: number;
  /** the updated drawing, when there is something new to see */
  circuitJson?: unknown[];
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
  projectFsMap: FsMap,
  opts: CompileOptions = {},
): Promise<CompileResult> {
  /*
   * The user's manual edits (manual-edits.json) enter HERE and only here: we
   * compile sources in which the hand-pinned positions have become schX/schY
   * and pcbX/pcbY props, while the project files stay the ones written by the
   * agent. This is what lets the agent rewrite main.tsx as many times as it
   * wants without erasing the human's placement work.
   */
  let fsMap = applyManualEditsToFsMap(projectFsMap);
  const parsedManualEdits = parseManualEdits(projectFsMap[MANUAL_EDITS_PATH]);
  const manualEdits = countManualEdits(parsedManualEdits);
  /*
   * The project's fabrication rules. Until now they were one constant, the
   * same for everyone: the DRC and the router already accepted a parameter,
   * but nobody passed them a different one, so whoever ordered from another
   * manufacturer got measured against the wrong minimums. They are resolved
   * here, once, and they hold for both routing and checking.
   */
  const projectRules = resolveDesignRules(projectFsMap);
  const profiler = new Profiler();

  /*
   * Translates the router's state into something a person understands. The
   * stages have library-style names (highDensityRouteSolver, unravelSolver):
   * here they become phrases, and the progress is the solver's real one, not
   * a fake bar.
   */
  const routerSay = (tick: RouterTick) =>
    say({
      step: "Instrado le piste",
      detail: `${describePhase(tick.phase)} · ${tick.iterations.toLocaleString("it-IT")} iterazioni · ${Math.round(tick.elapsedMs / 1000)}s`,
      progress: 0.35 + Math.min(0.3, tick.progress * 0.3),
    });

  /*
   * When routing gets SKIPPED because of placement errors, retrying it is
   * wasted time: the placement is the same, the router will stop at the same
   * point. Measured on BAT: three passes of ~115s each on the same impossible
   * board, 78% of the total time to produce nothing. Better to stop right
   * away and say WHICH overlap must be fixed.
   */
  const placementBlocked = (circuitJson: CircuitElement[]): boolean =>
    circuitJson.some(
      (el) =>
        el.type === "pcb_autorouting_error" &&
        /placement error/i.test(String(el.message ?? "")),
    );
  /*
   * Time cap for the WHOLE compilation. On Vercel a function is killed at
   * 800 seconds: a compilation that asks for 900 does not fail with an error,
   * it simply saves nothing and the user sees the board as it was before.
   * Better an imperfect route delivered than a perfect one thrown away.
   */
  const budgetMs = Math.max(60_000, opts.budgetMs ?? 540_000);
  const startedAt = Date.now();
  const timeLeft = () => budgetMs - (Date.now() - startedAt);

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
    routeReport: RouteReport | null;
  } = {
    best: null,
    bestScore: null,
    attempts: 0,
    fatalError: null,
    variants: null,
    routeReport: null,
  };
  let placementReport: PlacementReport | null = null;
  /** what the placer decided, to be given back to the caller */
  let placedNow: Array<{ name: string; center: { x: number; y: number } }> | null = null;
  /** the solver has already declared it cannot do the whole board */
  let fullBoardGaveUp = false;
  let blockedByPlacement = false;
  const say = (event: CompileProgress) => {
    try {
      opts.onProgress?.(event);
    } catch {
      // whoever listens must not be able to make the compilation fail
    }
  };

  const consider = (circuitJson: CircuitElement[], router: CompileSummary["router"]) => {
    const score = scoreCircuit(circuitJson, projectRules.rules);
    const prev = state.bestScore;
    /*
     * Same order as autoroute.better(): errors, opens, violations, and last the
     * copper THAT COSTS — length plus the signal vias priced in millimetres. Two
     * different comparisons for the same question is how a candidate wins here
     * and loses there.
     */
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
        score.copperCostMm < prev.copperCostMm)
    ) {
      state.best = { circuitJson, router };
      state.bestScore = score;
    }
    return score;
  };

  /*
   * FIRST STEP: the geometry, without a single trace.
   *
   * Needed for placement, and placement must be done BEFORE routing. Two pads
   * of different components too close together are a violation no autorouter
   * can close: you can reroute the copper as much as you like, those two pads
   * stay where they are. Routing first means spending minutes on a board that
   * was already out of spec from the start, and then redoing everything.
   *
   * It costs one compilation (a minute and a half on a fifty-part board), but
   * it is not an EXTRA compilation: it takes the place of the "as-authored"
   * attempt, which routed with the router declared on the board and which
   * almost always lost the comparison against the later passes anyway.
   */
  say({ step: "Leggo la scheda", detail: "componenti, piedini, collegamenti", progress: 0.05 });
  let geometry: CircuitElement[] | null = null;
  try {
    state.attempts += 1;
    geometry = await compileGeometryOnly(fsMap);
    // PROVA SM (da rimuovere): le colate importate al posto di quelle calcolate
    if (process.env.SM_POURS && geometry) {
      const { readFileSync: leggi } = await import("node:fs");
      const importate = JSON.parse(leggi(process.env.SM_POURS, "utf8")) as CircuitElement[];
      const facce = new Set(importate.map((p) => String(p.layer)));
      geometry = [
        ...geometry.filter((el) => el.type !== "pcb_copper_pour" || !facce.has(String(el.layer))),
        ...importate,
      ];
    }
  } catch (err) {
    state.fatalError = err instanceof Error ? err.message : String(err);
  }

  if (geometry && opts.place === true) {
    say({
      step: "Sistemo i componenti",
      detail: "prima di instradare, i pezzi non si devono toccare",
      progress: 0.25,
      circuitJson: geometry,
    });
    try {
      /*
       * Parts placed by hand by the user are constraints, not suggestions: the
       * solver works around them, it does not move them. Whoever put a
       * component where they wanted it finds it right there.
       */
      const locked = [
        // only what a PERSON placed: the placer's own saved positions are a
        // starting point, not a constraint, otherwise the first rearrange
        // would freeze the board forever
        ...parsedManualEdits.pcb_placements.filter((p) => !p.auto).map((p) => p.selector),
        // and what REALITY placed: see readConstraints
        ...readConstraints(projectFsMap["main.tsx"] ?? "").keys(),
        ...(opts.placeLocked ?? []),
      ];
      const { placements, report } = placeComponents(geometry, {
        rules: projectRules.rules,
        locked,
        blocks: readBlocks(projectFsMap["main.tsx"] ?? ""),
        tags: readTags(projectFsMap["main.tsx"] ?? ""),
        attempts: opts.placeAttempts ?? 10,
        zoneRounds: opts.placeZoneRounds ?? 2,
        zoneOfComponent: opts.placeZoneOfComponent,
        // placement is worth minutes of routing: it may take half a minute
        // for itself, but it must not eat into the router's time
        budgetMs: Math.min(30_000, Math.max(5_000, timeLeft() / 8)),
      });
      placementReport = report;
      if (placements.length > 0) {
        placedNow = placements.map((p) => ({
          name: p.name,
          center: p.center,
          ...(p.rotation !== undefined ? { rotation: p.rotation } : {}),
        }));
        fsMap = {
          ...fsMap,
          "main.tsx": injectManualEdits(fsMap["main.tsx"] ?? "", {
            ...emptyManualEdits(),
            pcb_placements: placements.map((p) => ({
              selector: p.name,
              center: p.center,
              // the magnet can turn a part: dropping the rotation here meant
              // injecting the position of a turned piece with the old orientation
              ...(p.rotation !== undefined ? { rotation: p.rotation } : {}),
            })),
          }),
        };
      }
      say({
        step: "Componenti sistemati",
        detail:
          report.after.violations === 0
            ? `${report.attempts} disposizioni provate, vince la ${report.picked + 1}ª: ${report.before.violations} sovrapposizioni risolte, ${report.moved} pezzi spostati, densita' ${report.densityPct}%`
            : `restano ${report.after.violations} distanze corte: non si risolvono con il rame`,
        progress: 0.3,
      });
    } catch {
      // if placement fails we route as-is: better a badly routed board than
      // no board at all
    }
  }

  /*
   * Recompile without routing: the geometry is the new one, the copper is the
   * one that was already there. See CompileOptions.route
   */
  if (opts.route === false) {
    if (!geometry) {
      const message = state.fatalError ?? "compile produced no result";
      return {
        summary: emptySummary(`Compilation failed: ${message}`, {
          type: "compile_exception",
          message,
        }),
        circuitJson: [],
      };
    }
    say({ step: "Riporto il rame che c'era", detail: "le piste non si rifanno", progress: 0.7 });
    const conRame = carryCopper(geometry, opts.keepCopperFrom ?? []);
    const conMano = applyManualRoutes({
      circuitJson: conRame,
      routes: parsedManualEdits.pcb_routes,
      viaDiameter: projectRules.rules.minViaDiameterMm,
      viaHoleDiameter: projectRules.rules.minViaHoleMm,
    });
    // the planes, poured again with the copper in place: see pours-recompute.ts
    const ricolate = await ricolaPiani({
      circuitJson: conMano.circuitJson as never,
      // a pour holds its own distance, wider than a trace's when the board says so
      clearanceMm:
        projectRules.rules.pourClearanceMm ?? projectRules.rules.minClearanceMm,
      bordoMm: projectRules.rules.minBoardEdgeClearanceMm,
    }).catch(() => null);
    const circuitJson = (ricolate?.circuitJson ?? conMano.circuitJson) as CircuitElement[];
    const rapportoColate = ricolate ? esitoColate(ricolate) : undefined;
    say({ step: "Controllo le regole", progress: 0.95, circuitJson });
    const summary = await summarize(circuitJson, projectFsMap);
    summary.pours = rapportoColate;
    summary.manualEdits = manualEdits;
    if (placementReport) summary.placementReport = placementReport;
    const orfane = danglingTraces(circuitJson);
    summary.message = orfane === 0
      ? `${summary.message} (geometria aggiornata, rame non toccato)`
      : `${summary.message} (geometria aggiornata, rame non toccato: ${orfane} piste non arrivano piu' su un pad, chiudi i mancanti per rifare solo quelle)`;
    return { summary, circuitJson, placements: placedNow ?? undefined };
  }

  /*
   * SECOND STEP: the copper, on the already tidied board.
   */
  /*
   * From here on, routing works on a board WITHOUT poured copper. The pours
   * come back at the end, when the signal copper has settled: that is the
   * order in which a board is drawn, and also the only one that works — with
   * ground copper on every layer the solver no longer closes the board.
   */
  const routingFsMap = withoutCopperPours(fsMap);
  say({ step: "Instrado le piste", detail: "collego i piedini", progress: 0.35 });
  /*
   * The first pass uses OUR router with the project's rules, not the one
   * declared on the <board>.
   *
   * The board's router does not know the manufacturer's minimums: it plans
   * 0.1mm traces and lays them 0.109mm from the pads. Since it is the one
   * laying almost all the copper, the bulk of the violations was born there,
   * and the zone loop then spent its time chasing them one by one without
   * ever reaching zero.
   *
   * Until now this was not possible: our router would not finish on the whole
   * board (223 seconds and gave up). With the components tidied and the
   * corridors reserved it closes in eight seconds, so the right pass has also
   * become the feasible one. If it fails we fall back to the board's pass,
   * which produces an imperfect board anyway.
   */
  try {
    state.attempts += 1;
    const cj = await profiler.run("router di casa, regole del progetto", () =>
      compileWithLocalRouter(routingFsMap, 2, projectRules.rules),
    );
    consider(cj, "local_retry");
    blockedByPlacement = placementBlocked(cj);
    say({ step: "Prima passata fatta", progress: 0.55, circuitJson: cj });
  } catch {
    // our own router gave up: the board's one gets a try
  }
  if (!state.best && !blockedByPlacement) {
    try {
      state.attempts += 1;
      const cj = await profiler.run(
        "compilazione + router della board",
        () => runTscircuitCode(routingFsMap, { mainComponentPath: "main.tsx" }) as Promise<CircuitElement[]>,
      );
      consider(cj, "default");
      blockedByPlacement = placementBlocked(cj);
      say({ step: "Prima passata fatta", progress: 0.55, circuitJson: cj });
    } catch (err) {
      state.fatalError ??= err instanceof Error ? err.message : String(err);
    }
  }

  // variant engine: re-route each named section with design rules injected,
  // keeping the core routing for the board-level backbone
  if (
    variantCount > 0 &&
    timeLeft() > 120_000 &&
    state.best &&
    state.bestScore &&
    state.bestScore.errors === 0
  ) {
    try {
      state.attempts += 1;
      const sections = findSections(state.best.circuitJson);
      if (sections.length > 0) {
        const base = unrouteSections(
          state.best.circuitJson,
          new Set(sections.map((s) => s.subcircuitId)),
        );
        const sectionVariants = sections.map((section) =>
          generateSectionCandidates(base, section, variantCount, projectRules.rules, (traces) => {
            // violations this candidate would introduce if spliced alone
            // (upsized JLCPCB vias can clash with pads the solver planned around)
            try {
              return runDrcChecks(
                spliceTraces(base, section.subcircuitId, traces, "eval"),
                projectRules.rules,
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
   * Retries with the local router at escalating effort as long as connections
   * stay open. Before, this ran ONLY with the variant engine disabled, and
   * that was a hole: variants re-route the individual sections and leave the
   * backbone between one section and another untouched, so an open connection
   * BETWEEN sections (typical of a QFP's pins that must reach faraway parts)
   * was no longer attacked by anyone and the board stayed incomplete. It only
   * costs time when the board is already incomplete, and `consider` keeps the
   * result only if it improves the score.
   */
  /*
   * Local pass WITH THE PROJECT'S RULES.
   *
   * Needed because attempt 0 routes with the router declared on the <board>,
   * which does not know our minimums: it plans 0.2mm vias even when the
   * manufacturer does not go below 0.6. Until now that pass only started if
   * connections were left open, so on an already complete board the project
   * rules stayed a report and never touched the copper.
   *
   * It is paid for only when there is something to gain (DRC other than zero)
   * and `consider` keeps it only if it really improves the score: if the
   * original router did better, its result stays.
   */
  if (!blockedByPlacement && state.bestScore && state.bestScore.errors === 0 && state.bestScore.drc > 0) {
    try {
      state.attempts += 1;
      say({
        step: "Rifaccio con le regole del progetto",
        detail: `${state.bestScore.drc} violazioni da chiudere`,
        progress: 0.6,
      });
      const cj = await profiler.run("ri-sbroglio con le regole del fornitore", () =>
        compileWithLocalRouter(fsMap, 5, projectRules.rules, routerSay),
      );
      consider(cj, "local_retry");
      if (state.best) say({ step: "Seconda passata fatta", progress: 0.7, circuitJson: state.best.circuitJson });
    } catch {
      // if it fails, the board router's result stays, and we stop insisting
      // on the whole board
      fullBoardGaveUp = true;
    }
  }

  /*
   * Retry ladder on the WHOLE board. It stops at the first surrender: if the
   * solver did not close the whole board at a low effort, it will not close
   * it at a high one — it will just take longer to say the same thing. That
   * time is needed by the zone loop, which succeeds on the same boards
   * because it solves small problems instead of one big one.
   */
  for (
    let i = 0;
    i < retries &&
    !fullBoardGaveUp &&
    !blockedByPlacement &&
    state.bestScore &&
    state.bestScore.unrouted > 0 &&
    timeLeft() > 120_000;
    i++
  ) {
    try {
      state.attempts += 1;
      say({
        step: "Ritento lo sbroglio",
        detail: `sforzo ${efforts[i] ?? 10}, ${state.bestScore.unrouted} collegamenti aperti`,
        progress: 0.65,
      });
      consider(
        await profiler.run(`ritentativo locale, sforzo ${efforts[i] ?? 10}`, () =>
          compileWithLocalRouter(fsMap, efforts[i] ?? 10, projectRules.rules, routerSay),
        ),
        "local_retry",
      );
    } catch {
      fullBoardGaveUp = true;
    }
  }

  /*
   * Routing loop: measures, figures out where the problems are, redoes ONLY
   * those zones with different solvers and keeps the result only if it
   * improves. It starts after all the other attempts: it refines the winning
   * route, whichever it is. Before, it ran before the retry ladder and, with
   * the cloud autorouter down, it never started, because that attempt's error
   * excluded it.
   */
  /*
   * The loop starts whenever there is a board and some time. Before, it
   * demanded zero errors, and on a board with open connections errors are
   * never zero: it was off exactly where it was needed. It cannot make
   * anything worse, because every redone zone is kept only if the score
   * improves.
   */
  if ((opts.routeRounds ?? 12) > 0 && timeLeft() > 30_000 && state.best && state.bestScore) {
    try {
      state.attempts += 1;
      say({ step: "Rifinisco le zone peggiori", progress: 0.75 });
      const { circuitJson: looped, report } = await routeBoard(state.best.circuitJson, {
        budgetMs: Math.max(20_000, timeLeft() - 60_000),
        maxRounds: opts.routeRounds ?? 12,
        useVision: opts.routeVision ?? false,
        onRound: (round) =>
          say({
            step: "Rifinisco le zone peggiori",
            detail: `giro ${round.round}: ${round.targets.length} zone rifatte, ${round.score.drc} violazioni`,
            progress: Math.min(0.75 + round.round * 0.02, 0.92),
            circuitJson: round.circuitJson,
          }),
      });
      state.routeReport = report;
      consider(looped, "loop");
    } catch {
      // the loop is an improvement, not a requirement: if it fails, the rest stays
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

  /*
   * House rules applied ALWAYS to the winning route, not put in competition
   * with it: a rule that holds only when convenient is not a rule. Traces go
   * up to the fab minimum and pad escapes become straight regardless of who
   * routed them. If widening or straightening brings two nets closer, the DRC
   * says so right after: the problem is made visible, not hidden by
   * discarding the fix.
   */
  // we widen to the CHOSEN MANUFACTURER's minimum, not the default one:
  // with a coarse manufacturer, going to 0.127 would leave unmanufacturable traces
  /*
   * Vias resting on pads are shifted by a few hundredths before anything
   * else: it is the only violation the loop cannot close on its own, because
   * redoing the zone reproduces the same geometry. Right after, the escapes
   * are straightened and the angles brought back into spec, so the copper
   * that bent to follow the via returns to 0, 45 or 90 degrees.
   */
  /*
   * Ground goes down onto the plane LAST, when the signal copper has settled:
   * it is the order in which a board is drawn by hand — you place, you route
   * the signal, you pour the copper and then you check that no pad has been
   * left isolated. Doing it earlier would mean stitching to the plane pads
   * that the routing still has to move.
   */
  /*
   * The copper is poured: the pours come back from the geometry, where they
   * had been all along, and with them the ground traces become copper in the
   * middle of copper and are thrown away. From this moment a ground pad is
   * connected because it sits inside the copper, not because something
   * reaches it.
   */
  const pours = (geometry ?? []).filter((el) => el.type === "pcb_copper_pour");
  const poured = dropPouredNetTraces([...state.best.circuitJson, ...pours]);
  state.best = { ...state.best, circuitJson: poured };

  const routed = snapTo45(
    straightenPinEscapes(
      widenThinTraces(
        nudgeCrowdedVias(
          stitchToPlanes(state.best.circuitJson, projectRules.rules),
          projectRules.rules.minClearanceMm,
        ),
        projectRules.rules.minTraceWidthMm,
      ),
    ),
  );
  /*
   * Hand-drawn traces enter LAST, after every automatic touch-up: they are a
   * user decision and no house heuristic must straighten or widen them behind
   * their back. From here on the DRC measures them like all the others.
   */
  const manual = applyManualRoutes({
    circuitJson: routed,
    routes: parsedManualEdits.pcb_routes,
    viaDiameter: projectRules.rules.minViaDiameterMm,
    viaHoleDiameter: projectRules.rules.minViaHoleMm,
  });
  /*
   * AND THE PLANES ARE POURED AGAIN, now that all the copper is on the board.
   * tscircuit pours while it builds, and the imported copper arrives after: the
   * plane was carved around a board with no traces on it and poured straight
   * over them. See pours-recompute.ts.
   */
  const ricolate = await ricolaPiani({
    circuitJson: manual.circuitJson as never,
    clearanceMm:
      projectRules.rules.pourClearanceMm ?? projectRules.rules.minClearanceMm,
    bordoMm: projectRules.rules.minBoardEdgeClearanceMm,
  }).catch(() => null);
  const circuitJson = (ricolate?.circuitJson ?? manual.circuitJson) as CircuitElement[];
  const rapportoColate = ricolate ? esitoColate(ricolate) : undefined;
  // we analyze the REAL sources, not the ones with injected props: otherwise
  // every hand-pinned component would be flagged as a spurious schX/schY
  // and the agent would chase a defect that does not exist
  say({ step: "Controllo le regole", progress: 0.95, circuitJson });
  const summary = await profiler.run("controlli (DRC, elettrici, schematico, footprint)", () =>
    summarize(circuitJson, projectFsMap),
  );
  summary.pours = rapportoColate;
  summary.manualEdits = manualEdits;
  /*
   * The router's internal phases are read from the solver at the end of the
   * run and end up in the same list as ours: the time accounting must be a
   * single one, otherwise we keep saying "the router is slow" without knowing
   * which of its forty-one stages.
   */
  for (const phase of routerPhases(lastSolver)) {
    profiler.add(`router: ${phase.name}`, phase.ms, 1);
  }
  summary.profile = profiler.result();
  if (placementReport) {
    summary.placementReport = placementReport;
    if (placementReport.moved > 0) {
      summary.message += ` (posizionamento: ${placementReport.attempts} disposizioni provate, scelta la ${placementReport.picked + 1}ª — ${placementReport.before.violations} -> ${placementReport.after.violations} sovrapposizioni, ${placementReport.moved} pezzi spostati, densita' ${placementReport.densityPct}%, rame stimato ${placementReport.after.netLengthMm}mm)`;
    }
  }
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
  if (state.routeReport) {
    summary.routeReport = state.routeReport;
    const rounds = state.routeReport.rounds.length;
    if (state.best.router === "loop") {
      summary.message +=
        ` (routing loop: ${rounds} round(s), stopped because ${state.routeReport.stoppedBecause})`;
    }
  }
  return {
    summary,
    circuitJson,
    variants: state.variants ?? undefined,
    // so whoever asked for the placement can write it down: see CompileResult
    placements: placedNow ?? undefined,
  };
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
    placement: emptyPlacementQuality(),
    manualEdits: { schematic: 0, pcb: 0, traceHints: 0, total: 0 },
    designRules: {
      preset: FAB_RULESETS[0].key,
      label: FAB_RULESETS[0].label,
      isCustom: false,
      rules: DEFAULT_DESIGN_RULES,
    },
    profile: { spans: [], totalMs: 0 },
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

/**
 * Re-compile forcing the local pipeline autorouter at the given effort,
 * regardless of the board's autorouter prop: the platform autorouterMap
 * overrides the presets the board may declare (auto/auto_local/auto_cloud).
 */
async function compileWithLocalRouter(
  fsMap: FsMap,
  effort: number,
  rules: DesignRules = DEFAULT_DESIGN_RULES,
  onTick?: (tick: RouterTick) => void,
): Promise<CircuitElement[]> {
  const platform = {
    ...getPlatformConfig({
      autorouterMap: {
        auto: localRouterDef(effort, rules, onTick),
        "auto-local": localRouterDef(effort, rules, onTick),
        "auto-cloud": localRouterDef(effort, rules, onTick),
      },
    }),
    /*
     * The courtyard gate does not stop the router: our own check does.
     *
     * tscircuit refuses to route when two courtyards interpenetrate, even by a
     * hundredth. But the courtyard is an ASSEMBLY convention, generous by
     * design — the one on an 0603 carries 0,7 mm of margin per side — while
     * what has to be respected is the distance between COPPER. On this board a
     * decoupling capacitor deliberately hugging the microphone's VDD pin (0,36 mm
     * of air, almost three times the 0,127 mm minimum) has courtyards
     * overlapping by 0,48 mm: the gate refused to route, and the result was a
     * board with 32 open connections and no copper — much worse than the
     * problem it was protecting against.
     *
     * Nothing is hidden: the pcb_courtyard_overlap_error elements stay in the
     * Circuit JSON, and the placement check (placement-quality.ts) measures the
     * clearance pad against pad, which is the rule the factory actually applies.
     */
    placementDrcChecksDisabled: true,
  };
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





/**
 * Poured copper must be removed BEFORE routing and put back AFTER.
 *
 * It is the order in which a board is drawn (Niccolo', 2026-07-27): remove
 * the pour, route without touching the grounds, and pour the copper at the
 * end. It is not a style preference: measured on bat-bs, with ground copper
 * poured on all four layers the solver no longer closes the board, not even
 * in four minutes, because it faces a slab of copper instead of free space.
 * Without pours the same board routes.
 */
function withoutCopperPours(fsMap: FsMap): FsMap {
  const main = fsMap["main.tsx"];
  if (typeof main !== "string" || !main.includes("copperpour")) return fsMap;
  return {
    ...fsMap,
    "main.tsx": main.replace(/^[ \t]*<copperpour\b[^>]*\/>[ \t]*\r?\n/gim, ""),
  };
}

/**
 * Ground traces, after the pour, are copper in the middle of copper: they are
 * thrown away. A ground pad is connected because it SITS INSIDE the pour, not
 * because a trace reaches it — and that trace, besides being useless, steals
 * the corridor from a signal.
 */
function dropPouredNetTraces(circuitJson: CircuitElement[]): CircuitElement[] {
  const pouredNets = new Set<string>();
  for (const el of circuitJson) {
    if (el.type !== "pcb_copper_pour") continue;
    const net = String(el.source_net_id ?? "");
    if (net) pouredNets.add(net);
  }
  if (pouredNets.size === 0) return circuitJson;

  const pouredSourceTraces = new Set<string>();
  for (const el of circuitJson) {
    if (el.type !== "source_trace") continue;
    const nets = (el.connected_source_net_ids as string[] | undefined) ?? [];
    if (nets.some((n) => pouredNets.has(String(n)))) {
      pouredSourceTraces.add(String(el.source_trace_id ?? ""));
    }
  }
  if (pouredSourceTraces.size === 0) return circuitJson;

  return circuitJson.filter(
    (el) =>
      el.type !== "pcb_trace" || !pouredSourceTraces.has(String(el.source_trace_id ?? "")),
  );
}

/**
 * Which logical block each component belongs to, read from the sources.
 *
 * The block lives only in the code (`schSectionName`): it never reaches the
 * Circuit JSON, where everything ends up in a single subcircuit. But it is
 * the most important piece of information the placer can have — a block is a
 * piece of circuit that does one thing, and scattering it across the board
 * means undoing it — so we go and fetch it where it lives.
 */
export function readBlocks(main: string): Map<string, string> {
  const blocks = new Map<string, string>();
  if (!main) return blocks;
  for (const tag of scanJsxTags(main)) {
    const attrs = main.slice(tag.attrsStart, tag.attrsEnd);
    const name = readAttr(attrs, "name");
    const section = readAttr(attrs, "schSectionName");
    if (name && section) blocks.set(name, section);
  }
  return blocks;
}

/**
 * Each component's tags, read from the sources. They say WHAT a part is —
 * mcu, ldo, memory, crystal, connector — which is the only information with
 * which placement can decide how to treat it. The alternative was deducing
 * it from the pin count, which is a riddle: a regulator and a crystal have
 * the same number and are not placed the same way.
 *
 * They live only in the code: tscircuit accepts them and does not carry them
 * into the Circuit JSON.
 */
export function readTags(main: string): Map<string, string> {
  const tags = new Map<string, string>();
  if (!main) return tags;
  for (const tag of scanJsxTags(main)) {
    const attrs = main.slice(tag.attrsStart, tag.attrsEnd);
    const name = readAttr(attrs, "name");
    if (!name) continue;
    // the three levels concatenate: broad (active/passive), narrow (which
    // part of the board it belongs to) and precise (what it is exactly).
    // Whoever reads it uses the level they need, and one line holds them all
    const parts = [
      readAttr(attrs, "kind"),
      readAttr(attrs, "domain"),
      readAttr(attrs, "tags"),
    ].filter(Boolean);
    if (parts.length > 0) tags.set(name, parts.join(", "));
  }
  return tags;
}

/**
 * PHYSICAL CONSTRAINTS: which parts cannot be moved, and why (Niccolo',
 * 2026-07-29).
 *
 * A board has two kinds of components. Some have a place decided by REALITY: the
 * microphone whose acoustic port must face the edge, the connector whose shell
 * has to overhang so the cable can go in, the LED that has to be seen, the
 * mounting hole where the screw goes. Their position is not an optimisation, it
 * is a requirement — moving them by two millimetres to shorten a trace means
 * breaking the product.
 *
 * All the rest — capacitors, resistors, the ESD diode, the regulators — has no
 * place of its own: it goes where the copper is shortest, and that is the
 * magnet's job.
 *
 * So the constraint is DECLARED on the component, with its reason, and stops
 * being a decision to make again every time: `pcbConstraint="the acoustic port
 * must face the left edge"`. Whoever writes the schematic knows why a part is
 * where it is; the placer only needs to know that it must not touch it.
 */
export function readConstraints(main: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!main) return out;
  for (const tag of scanJsxTags(main)) {
    const attrs = main.slice(tag.attrsStart, tag.attrsEnd);
    const name = readAttr(attrs, "name");
    const reason = readAttr(attrs, "pcbConstraint");
    if (name && reason) out.set(name, reason);
  }
  return out;
}

/**
 * Moves the copper of the previous board onto the new geometry.
 *
 * Traces and vias are taken as they are: they are absolute geometry, they do not
 * depend on the ids that change at every compile. What DOES depend on
 * them, the link to the source trace, is remapped by connection name, so the
 * "which connections are still open" count keeps working.
 */
function carryCopper(geometry: CircuitElement[], vecchio: unknown[]): CircuitElement[] {
  /*
   * Traces and vias, NOT the pours: the pours are declared in the sources
   * (<copperpour>) and the geometry already rebuilds them. Carrying them over
   * too would mean two ground planes on top of each other on every layer.
   */
  const rame = (vecchio as CircuitElement[]).filter(
    (el) => el.type === "pcb_trace" || el.type === "pcb_via",
  );
  if (rame.length === 0) return geometry;

  /** the name of a connection, from the old board and from the new one */
  const chiaveDiRete = (elenco: CircuitElement[]) => {
    const nome = new Map<string, string>();
    for (const el of elenco) {
      if (el.type !== "source_trace" || !el.source_trace_id) continue;
      const porte = ((el.connected_source_port_ids as string[] | undefined) ?? [])
        .slice()
        .sort()
        .join("|");
      nome.set(String(el.source_trace_id), porte);
    }
    return nome;
  };
  const vecchie = chiaveDiRete(vecchio as CircuitElement[]);
  const nuove = new Map(
    [...chiaveDiRete(geometry)].map(([id, porte]) => [porte, id] as const),
  );

  return [
    ...geometry,
    ...rame.map((el) => {
      const vecchioId = String(el.source_trace_id ?? "");
      if (!vecchioId) return el;
      const porte = vecchie.get(vecchioId);
      const nuovoId = porte ? nuove.get(porte) : undefined;
      // a connection that no longer exists keeps the old id: the copper stays
      // visible and the checks report it as orphaned, which is the truth
      return nuovoId ? { ...el, source_trace_id: nuovoId } : el;
    }),
  ];
}

/** traces whose ends no longer land on a pad: copper of parts that have moved */
function danglingTraces(circuitJson: CircuitElement[]): number {
  const REACH = 0.3;
  const pad: Array<{ x: number; y: number }> = [];
  for (const el of circuitJson) {
    if (el.type !== "pcb_smtpad" && el.type !== "pcb_plated_hole" && el.type !== "pcb_port") continue;
    const punti = Array.isArray(el.points)
      ? (el.points as Array<{ x?: unknown; y?: unknown }>)
      : [{ x: el.x, y: el.y }];
    for (const p of punti) {
      const x = num(p.x);
      const y = num(p.y);
      if (x !== null && y !== null) pad.push({ x, y });
    }
  }
  const vicinoAUnPad = (x: number, y: number) =>
    pad.some((p) => Math.abs(p.x - x) <= REACH && Math.abs(p.y - y) <= REACH);

  let orfane = 0;
  for (const el of circuitJson) {
    if (el.type !== "pcb_trace") continue;
    const route = ((el.route as Array<Record<string, unknown>> | undefined) ?? []).filter(
      (p) => p.route_type === "wire",
    );
    if (route.length < 2) continue;
    const capi = [route[0], route[route.length - 1]];
    for (const capo of capi) {
      const x = num(capo.x);
      const y = num(capo.y);
      if (x === null || y === null) continue;
      if (!vicinoAUnPad(x, y)) {
        orfane++;
        break;
      }
    }
  }
  return orfane;
}

/**
 * Compiles the geometry only: components, pads, footprints, no copper.
 *
 * The autorouter is replaced with one that delivers zero traces instantly.
 * It is the fastest way to get the true pad positions — the ones needed to
 * decide where to put the parts — without paying the minutes of routing,
 * which at that point would be thrown away anyway.
 */
export async function compileGeometryOnly(fsMap: FsMap): Promise<CircuitElement[]> {
  const noRouting = () => ({
    createAutorouter: () => ({
      on(event: string, cb: (payload: unknown) => void) {
        if (event === "complete") queueMicrotask(() => cb({ traces: [] }));
      },
      start() {},
      stop() {},
    }),
  });
  const platform = getPlatformConfig({
    autorouterMap: {
      auto: noRouting() as never,
      "auto-local": noRouting() as never,
      "auto-cloud": noRouting() as never,
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

/**
 * Last solver built. Only needed to read its per-phase timings at the end of
 * the run: the package measures them internally but does not return them, and
 * without this reference they would stay inside the object where nobody would
 * see them.
 */
let lastSolver: unknown = null;

function localRouterDef(
  effort: number,
  rules: DesignRules = DEFAULT_DESIGN_RULES,
  onTick?: (tick: RouterTick) => void,
) {
  return {
    createAutorouter: (simpleRouteJson: unknown) => {
      const solver = new AutoroutingPipelineSolver(
        withFabRules(simpleRouteJson, rules) as never,
        { effort } as never,
      );
      lastSolver = solver;
      return adaptSolver(solver as never, FULL_BOARD_SOLVE_MS, onTick) as never;
    },
  };
}


/**
 * The routing problem the core passes to the solver carries ITS OWN minimums
 * (0.1mm traces, 0.2/0.3mm vias), below the fab minimums: so the local router
 * completed the routing but with unmanufacturable traces and vias. Here the
 * minimums are rewritten with the project rules before the solver plans,
 * which is the only moment they matter — widening them afterwards would mean
 * moving copper that has already been laid.
 */
function withFabRules(simpleRouteJson: unknown, rules: DesignRules): unknown {
  if (!simpleRouteJson || typeof simpleRouteJson !== "object") return simpleRouteJson;
  const r = rules;
  const srj = simpleRouteJson as Record<string, unknown>;
  const atLeast = (key: string, min: number) => {
    const current = typeof srj[key] === "number" ? (srj[key] as number) : 0;
    if (current < min) srj[key] = min;
  };
  // we aim for the project's width, not the fab minimum: drawing at the
  // minimum means zero margin in production
  atLeast("minTraceWidth", r.targetTraceWidthMm ?? r.minTraceWidthMm);
  atLeast("minViaHoleDiameter", r.minViaHoleMm);
  atLeast("min_via_hole_diameter", r.minViaHoleMm);
  atLeast("minViaPadDiameter", r.minViaDiameterMm);
  atLeast("min_via_pad_diameter", r.minViaDiameterMm);
  atLeast("minViaDiameter", r.minViaDiameterMm);
  atLeast("minTraceToPadEdgeClearance", r.targetClearanceMm ?? r.minClearanceMm);
  /*
   * The other minimum clearances. The section-based path already passed them
   * all (variants.ts, generateSectionCandidates); the whole-board pass
   * declared three out of eight, and the ones left unsaid the solver chose
   * for itself. They are exactly the three families of violations that
   * remained on BAT: via-against-pad, trace-against-via, trace-against-trace.
   */
  atLeast("minViaEdgeToPadEdgeClearance", r.targetClearanceMm ?? r.minClearanceMm);
  atLeast("minPadEdgeToPadEdgeClearance", r.targetClearanceMm ?? r.minClearanceMm);
  atLeast("minViaHoleEdgeToViaHoleEdgeClearance", r.targetClearanceMm ?? r.minClearanceMm);
  atLeast("minPlatedHoleDrillEdgeToDrillEdgeClearance", r.minClearanceMm);
  atLeast("minBoardEdgeClearance", r.minBoardEdgeClearanceMm);
  /*
   * HOW BIG THE COPPER TO BE DRAWN IS. It is the most expensive defect found
   * on BAT: the solver, unless told, plans with a 0.3mm via and a 0.15mm
   * trace (those are its fallback values), then `spliceTraces` writes the vias
   * at `minViaDiameterMm` — 0.6mm on JLCPCB — and the traces at the project's
   * width. Every via is therefore born with 0.15mm of extra copper per side
   * beyond what the router had reserved, and it crashes into what the router
   * had carefully avoided. Measured: putting the vias back at 0.3mm on BAT's
   * result, 70 violations out of 130 disappear on their own. It is not that
   * the vias are too big, it is that the plan did not know about them.
   */
  atLeast("defaultViaDiameter", r.minViaDiameterMm);
  atLeast("defaultTraceThickness", r.targetTraceWidthMm ?? r.minTraceWidthMm);
  // margin from obstacles: where the solver does not find one, it assumes
  // 0.2mm in some places and ZERO in others, and that is where the vias
  // resting on another net's pad are born. We enforce the higher of the two,
  // never one narrower than what the solver would use on its own.
  atLeast("defaultObstacleMargin", Math.max(r.targetClearanceMm ?? r.minClearanceMm, 0.2));
  // each connection can declare its own width: power traces stay wide,
  // signal ones go up to the fab minimum
  for (const conn of (srj.connections as Array<Record<string, unknown>>) ?? []) {
    if (typeof conn.minTraceWidth === "number" && conn.minTraceWidth < r.minTraceWidthMm) {
      conn.minTraceWidth = r.minTraceWidthMm;
    }
  }

  /*
   * Ground is not routed. On a four-layer board it has a plane all to itself:
   * every pad drops onto it with a via three tenths of a millimeter long, and
   * the connection is done. The autorouter instead treats it like any other
   * net and pulls wires for it on the surface — on bat-bs, 29 traces and 158
   * millimeters of copper, 21 percent of the total, to join points that had
   * the plane right underneath. It is not just waste: that copper occupies
   * the corridors the signals need, and a current return that takes the long
   * way around instead of dropping straight down is an antenna.
   *
   * So the connections of nets that have a plane leave the problem, and the
   * plane stitching (stitchToPlanes) takes their place at the end of routing.
   * What remains for the router is the signals, which is its own job.
   */
  /*
   * Ground is NOT removed from the routing problem.
   *
   * It seemed obvious to do it — there is a whole plane waiting for it, why
   * waste 158 millimeters of copper on the surface? — and it was tried: the
   * connections of nets with a plane were removed from the problem and every
   * pad stitched to the plane with a via. The measured result is that the
   * solver no longer closes the board, not even in four minutes: removing
   * connections makes its job harder, not easier, because the pads remain
   * obstacles with no route left to justify them.
   *
   * It is still true that ground should go on the plane. But the way is not
   * to amputate the problem: it is the plane stitching applied AFTER routing,
   * which exists (stitchToPlanes) and can be re-run on demand from the
   * "Ricalcola massa" button.
   */
  return srj;
}


/**
 * tscircuit's core drives the autorouter with an EVENT-based API
 * (`.on("complete"|"error"|"progress")` + `.start()`), while
 * AutoroutingPipelineSolver exposes `solve()` synchronously: without an
 * adapter the core calls `.on` on an object that does not have it and routing
 * breaks ("activeAutorouter.on is not a function"), leaving connections open.
 */
interface SolverLike {
  solve: () => void;
  getOutputSimplifiedPcbTraces: () => unknown[];
  step?: () => void;
  solved?: boolean;
  failed?: boolean;
  /** current stage among the pipeline's 41 */
  getCurrentPhase?: () => string;
  iterations?: number;
  progress?: number;
}

/** router state while it grinds away, to show to whoever is waiting */
export interface RouterTick {
  phase: string;
  iterations: number;
  progress: number;
  elapsedMs: number;
}

/**
 * Time cap for ONE routing pass over the whole board.
 *
 * It used to be 90 seconds, tuned on a board where ground was routed like
 * everything else. With ground out of the problem the router works on
 * different connections and the first pass can take longer: with that cap it
 * never closed, and a board that does not get routed skews every comparison.
 * Four minutes is still a cap — it keeps us from hanging on a solver that
 * does not converge — but it no longer cuts off the ones that were making it.
 *
 * The solver, on a dense board, can grind for minutes and then give up:
 * `solve()` returns without having finished and reading the result explodes
 * with "Cannot get output before solving is complete". That is three minutes
 * spent for zero traces, and it happened twice per compilation. With the cap
 * the surrender is declared early and the leftover time goes to the zone
 * loop, which on the same boards succeeds where the whole-board pass fails
 * (small problems, not one big one).
 */
const FULL_BOARD_SOLVE_MS = 240_000;

function adaptSolver(
  solver: SolverLike,
  deadlineMs = FULL_BOARD_SOLVE_MS,
  onTick?: (tick: RouterTick) => void,
) {
  const handlers = new Map<string, (event: unknown) => void>();
  let stopped = false;
  return {
    on(event: string, cb: (event: unknown) => void) {
      handlers.set(event, cb);
    },
    start() {
      // asynchronous: the handlers are registered after creation
      queueMicrotask(() => {
        if (stopped) return;
        try {
          if (typeof solver.step === "function") {
            const started = Date.now();
            const until = started + deadlineMs;
            /*
             * The step loop is ours, so it is the only place where we can
             * know live how far along the routing is. The solver exposes the
             * current stage, the iterations and the progress, but tells them
             * to no one: here they are read and passed out. Without this, the
             * user watches a bar that does not move for two minutes and
             * thinks it is stuck.
             */
            let lastTick = 0;
            while (!solver.solved && !solver.failed) {
              for (let i = 0; i < 200 && !solver.solved && !solver.failed; i++) {
                solver.step();
              }
              const now = Date.now();
              if (onTick && now - lastTick > 500) {
                lastTick = now;
                onTick({
                  phase: solver.getCurrentPhase?.() ?? "sbroglio",
                  iterations: solver.iterations ?? 0,
                  progress: solver.progress ?? 0,
                  elapsedMs: now - started,
                });
              }
              if (now > until) break;
            }
          } else {
            solver.solve();
          }
          if (stopped) return;
          if (solver.step && !solver.solved) {
            throw new Error(
              `lo sbroglio dell'intera scheda non si e' chiuso entro ${Math.round(deadlineMs / 1000)}s`,
            );
          }
          handlers.get("complete")?.({ traces: solver.getOutputSimplifiedPcbTraces() });
        } catch (error) {
          handlers.get("error")?.({ error });
        }
      });
    },
    /** the core calls this at the end of the phase to release the router */
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
   * When autorouting gets SKIPPED because of placement errors, every
   * connection comes back missing: 11 overlaps produce a hundred
   * trace_missing/port_not_connected that are only the consequence. Listing
   * them all drowns the model and makes it spin on the symptoms.
   * Here the CAUSE is put first and the others are declared derived.
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

  // the project rules hold for the check too, not just for the router:
  // otherwise we would route with one minimum and measure with another
  const projectRules = resolveDesignRules(sources);
  const drcViolations = runDrcChecks(circuitJson, projectRules.rules);
  const prcViolations = runPrcChecks(circuitJson);
  // multi-ruleset: the main DRC already covers the ruleset CHOSEN by the
  // project, which is no longer necessarily the first in the list
  const fabClasses = FAB_RULESETS.map((rs) => {
    const violations =
      rs.key === projectRules.preset
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
  const placement = analyzePlacement(circuitJson, projectRules.rules);

  /*
   * A schematic layout disabled by schX/schY produces an unusable drawing
   * while still compiling without errors. Made blocking: the rule "do not
   * stop until the compile has no errors" is the only lever that forces the
   * model to redo the layout instead of delivering a pile of overlapping
   * symbols.
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
    placement,
    // the true count is written by compileProject, which holds the manual
    // edits file; here we summarize an already compiled circuit
    manualEdits: { schematic: 0, pcb: 0, traceHints: 0, total: 0 },
    designRules: {
      preset: projectRules.preset,
      label: projectRules.label,
      isCustom: projectRules.isCustom,
      rules: projectRules.rules,
    },
    // compileProject fills this in, being the only one that knows how long everything took
    profile: { spans: [], totalMs: 0 },
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

/**
 * Router stage names in Italian. There are forty-one of them and they have
 * library-style names: showing them raw to whoever is waiting does not help,
 * and hiding how far along it is helps even less.
 */
function describePhase(phase: string): string {
  const map: Record<string, string> = {
    preprocessSimpleRouteJsonSolver: "preparo il problema",
    escapeViaLocationSolver: "decido dove uscire dai pad",
    netToPointPairsSolver: "trasformo le net in coppie di punti",
    topologyPlanningSolver: "pianifico la topologia",
    portPointPathingSolver: "cerco i percorsi",
    polyHypergraphPortPointPathingSolver: "cerco i percorsi",
    capacityMeshSolver: "divido la scheda in celle",
    capacityPathingSolver: "instrado sulle celle",
    highDensityRouteSolver: "risolvo le zone dense",
    polyHighDensitySolver: "risolvo le zone dense",
    highDensityRepairSolver: "riparo le zone dense",
    highDensityForceImproveSolver: "miglioro le zone dense",
    exactGeometryDrcForceImproveSolver: "sistemo le distanze",
    globalDrcForceImproveSolver: "sistemo le distanze",
    unravelSolver: "districo le piste intrecciate",
    routeStitchingSolver: "ricucio i tratti",
    traceSimplificationSolver: "semplifico i percorsi",
    traceWidthSolver: "applico le larghezze",
    uselessViaRemovalSolver: "tolgo le via inutili",
    sameNetViaMergerSolver: "unisco le via della stessa net",
    edgeSolver: "collego i bordi delle celle",
  };
  return map[phase] ?? phase;
}
