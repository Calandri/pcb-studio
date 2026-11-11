import { CHECKS_ENGINE_VERSION, nonCertificata, type ColateDiPrima, type PianiSuVie } from "./engine-version";
import { EARLY_REPLY_MIN_COMPONENTS } from "./compile-early-reply";
import { COMPILE_BUDGET_PIENO_MS, SCHEMATICO_NON_INNESTATO, SCHEMATICO_NON_PARTITO } from "./compile-run";
import { filesHash } from "./project-store";
import { CircuitRunner, runTscircuitCode } from "@tscircuit/eval";
import { getPlatformConfig } from "@tscircuit/eval/platform-config";
import { AutoroutingPipelineSolver } from "@tscircuit/capacity-autorouter";
import { distanzaPuntoForma, ingombroForma, pianiSopraLeVie, rameDelForo, rameDelPad, runDrcChecks, type DrcViolation, type FormaRame, type MisureDrc } from "./drc";
import { stessoStrato, stratoDelPad } from "./pcb-route-model";
import {
  controllaLunghezze,
  leggiGruppi,
  LUNGHEZZE_PATH,
} from "./lunghezze";
import { prcTotal, runPrcChecks, type PrcViolation } from "./prc";
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
  DESIGN_RULES_PATH,
  distanzaDellaSerigrafia,
  FAB_RULESETS,
  resolveDesignRules,
  type DesignRules,
} from "./design-rules";
import { routeBoard, type RouteReport } from "./autoroute";
import { placeComponents, type PlacementReport } from "./placement";
import {
  scoreCircuit,
  unroutedGroups,
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
  findOrphanEdits,
  injectManualEdits,
  parseJsxAttrs,
  parseManualEdits,
  readAttr,
  scanJsxTags,
  scanJsxTagsOrNull,
  MANUAL_EDITS_PATH,
  type JsxAttr,
  type ManualEdits,
  type OrphanEdits,
} from "./manual-edits";
import { applyManualRoutes } from "./manual-routes";
import {
  colateDichiarate,
  conDistanzeDichiarate,
  distanzeDichiarate,
  ricolaPiani,
  type EsitoRicolata,
} from "./pours-recompute";
import { descriviDistanze, distanzeDelleColate, type DistanzaInUso } from "./pours";
import { colateCheSiToccano, colateTroppoVicine, type ColateCheSiToccano } from "./pour-pour";
import { serigrafiaInConflitto, testoSerigrafia, type SerigrafiaInConflitto } from "./silkscreen-clearance";
import { Profiler, routerPhases, type Profile } from "./profile";
import { patchedLibraries } from "./engine-patches.mjs";

/** read once per process: the files do not change while it lives */
let patchesSeen: Profile["patches"] | null = null;
function enginePatches(): Profile["patches"] {
  if (!patchesSeen) {
    try {
      patchesSeen = patchedLibraries(process.cwd()).libraries;
    } catch {
      patchesSeen = [];
    }
  }
  return patchesSeen;
}

/**
 * The pour numbers, in the shape the summary declares them. `senzaPezzi`: the
 * declarations left out because tscircuit poured nothing for them (see
 * colateDichiarate), said with the pours that lost every piece: both are in
 * the code and not on the copper.
 */
const esitoColate = (e: EsitoRicolata, senzaPezzi: string[] = []): NonNullable<CompileSummary["pours"]> => ({
  ricalcolate: e.ricolate,
  areaPrimaMm2: e.areaPrimaMm2,
  areaDopoMm2: e.areaDopoMm2,
  padRuotati: e.padRuotatiAggiunti,
  apertureRitagliate: e.colateScavate,
  bricioleTolte: e.bricioleTolte,
  orfaneTolte: e.orfaneTolte,
  viaRiconosciute: e.viaRiconosciute,
  colateSparite: [...new Set([...e.colateSparite, ...senzaPezzi])],
  colliTagliatiMm2: e.colliTagliatiMm2,
});

/**
 * Orphan hand edits, said in the message too: the agent reads the message
 * first, and an edit that acts on nothing is something it can fix (rename
 * the pin back, or release the edit) only if it knows.
 */
function withOrphans(
  summary: CompileSummary,
  circuitJson: unknown[],
  edits: ManualEdits,
): OrphanEdits | undefined {
  const orphans = findOrphanEdits(circuitJson, edits);
  if (orphans.total === 0) return undefined;
  const names = [
    ...orphans.pcb_placements,
    ...orphans.schematic_placements,
    ...orphans.pcb_routes,
    ...orphans.manual_trace_hints,
  ].slice(0, 8);
  summary.message = `${summary.message} ${orphans.total} modifiche a mano non trovano piu' il loro pezzo (${names.join(", ")}${orphans.total > names.length ? ", ..." : ""}).`;
  return orphans;
}
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
import { leggiStencil, padSenzaPasta, pastaDaiPad, STENCIL_PATH } from "./solder-paste";

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
  /** connections declared in source but with no routed pcb trace (the first 40) */
  unroutedConnections: string[];
  /** every connection group still open: unroutedConnections stops at 40 */
  unroutedTotal?: number;
  /** connection groups on the board, routed or not */
  connectionGroups?: number;
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
  /**
   * hand edits that point at something no longer on the board (a part the
   * agent renamed or removed, a route between pads that are gone): they act
   * on nothing, and the counter above still counted them as "held"
   */
  manualEditsOrphans?: OrphanEdits;
  /**
   * fabrication rules chosen for THIS project (design-rules.json), with what
   * was wrong in the file when something was (broken JSON, values corrected)
   */
  designRules: {
    preset: string;
    label: string;
    isCustom: boolean;
    rules: DesignRules;
    warnings?: string[];
  };
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
    /**
     * pours that lost every piece, and declarations tscircuit poured nothing for
     * (see colateDichiarate): they exist in the code and are not on the copper
     */
    colateSparite?: string[];
    /** copper narrower than the minimum trace width cut out of the pours (pour-necks.ts) */
    colliTagliatiMm2?: number;
  };
  /**
   * THE CLEARANCES THE POURS KEEP: the project's (pourClearanceMm, else
   * minClearanceMm) and the ones a `<copperpour clearance=...>` asks for itself,
   * each with how many pours hold it (see DISTANZA_PROPRIA in pours.ts). With
   * what was wrong in the declarations: a value under the minimum raised to it,
   * one that is not a length, two pours that cannot be told apart. Absent on a
   * board with no pour and nothing declared.
   */
  pourClearances?: {
    regolaMm: number;
    distanze: DistanzaInUso[];
    /** the same in words: "0.152mm (regola, 210 colate), 0.25mm (15 colate)" */
    testo: string;
    avvisi?: string[];
  };
  /**
   * VIAS WHOSE PAD IS IN THE COPPER OF ANOTHER NET'S PLANE: the plane did not
   * open around the hole. It is what is left when a plane could not be poured
   * again (the solver gave up on it and the old shape was kept, or the whole
   * step failed and tscircuit's own pours stayed), and what copper laid on a
   * board that is not poured again looks like. The compile and the recheck do
   * not file such a board under today's engine, so its Gerber is not exported
   * (see motoreDaSalvare). Absent when no via is in that state.
   */
  planesOverVias?: PianiSuVie;
  /**
   * The pours on the board were made by an engine before the one that pours
   * from the declared outlines, and a recheck does not make them again: only a
   * compile does. Written by the recheck alone; the board keeps its older
   * engine and the export refuses it (see colateDiUnMotoreDiPrima). Absent on
   * a compile.
   */
  poursFromOlderEngine?: ColateDiPrima;
  /**
   * Two pours of different nets on one layer that touch, overlap or stand
   * closer than the larger of their two clearances (see pour-pour.ts): a
   * short, or copper the fab cannot keep apart. The export refuses the board
   * while it is so. Absent when every pair keeps its distance.
   */
  poursTooClose?: ColateCheSiToccano;
  /**
   * Silkscreen closer than minSilkscreenClearanceMm to another drawing or to
   * bare copper, or over a hole (see silkscreen-clearance.ts). A warning: not
   * in the DRC count nor in the fab class, and the export goes on. Absent when
   * the silkscreen is clear.
   */
  silkscreen?: SerigrafiaInConflitto;
  /**
   * The board was saved without its schematic, which was still being drawn:
   * the schematic checks below say nothing yet. Absent on a complete compile.
   */
  schematicPending?: string;
  /**
   * What the schematic was drawn from (see schematicKeyOf). Equal on the next
   * compile = same schematic: it is taken from here instead of drawn again.
   */
  schematicKey?: string;
  /**
   * What drawing the schematic cost on this board the last time it was drawn
   * (ms): the tscircuit compile with the schematic minus the one without.
   * Carried from compile to compile, also on a board saved without its
   * schematic, so the next compile knows whether the schematic fits in the
   * time it has (see stimaDelloSchematico).
   */
  schematicCostMs?: number;
  /** on how many parts schematicCostMs was measured: it holds for a board of about as many (see misuraValida) */
  schematicCostParts?: number;
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

/** a board computed without its schematic: what the schematic is put on (see innestaSchematico) */
interface SchedaCalcolata {
  circuitJson: CircuitElement[];
  rapportoColate: CompileSummary["pours"];
  controlli: ControlliDellaScheda;
  /** traces that no longer land on a pad (danglingTraces) */
  orfane: number;
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
   * Tidies up the components before routing. IGNORED: compileProject forces it
   * off (no automatic placement, 2026-11-09). Placement is a decision, not a
   * consequence.
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
   * Whether to lay copper. IGNORED: compileProject forces `false` (no automatic
   * routing, 2026-11-09), so the compile stops at the geometry and the copper
   * of the previous board is CARRIED OVER as it is.
   *
   * "Recompile" and "route" are two different gestures. Recompiling means
   * reading the files again and showing the real board: it takes seconds. The
   * routing takes minutes, redoes work already done, and above all it is a
   * decision — you route when you have finished moving things, not every time
   * you look at the board. Tying the two together meant paying minutes for
   * every refresh and throwing away good copper.
   *
   * The carried-over copper is HONEST, not hidden: the traces of a component
   * that has moved no longer land on its pads, and the checks say so. They are
   * redrawn by hand.
   */
  route?: boolean;
  /**
   * The already compiled board whose copper to carry over. Without it,
   * recompiling shows only the copper the files draw themselves.
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
  /**
   * The board without its schematic, as soon as it exists: whoever compiles
   * saves it here, before the schematic is drawn.
   *
   * On a big board the schematic is almost the whole compile: on
   * fototrappola-frontale (217 parts, 827 connections) tscircuit's schematic
   * trace solver takes 180 of the 184 seconds of a local compile, the board
   * itself 5. On Vercel the whole thing did not fit in the function's 800
   * seconds, so the compile was cut off before saving and the server never
   * had a board to show. With this the board is saved within seconds, and
   * the schematic follows when it is done; if the function is cut off
   * before, the board stays saved and says its schematic is missing.
   */
  onBoard?: (early: { circuitJson: unknown[]; summary: CompileSummary }) => Promise<unknown>;
  /**
   * The board saved last time (circuit and summary). When its schematic was
   * drawn from the same sources (summary.schematicKey), the schematic is TAKEN
   * from it instead of drawn again: moving a part does not change a single wire
   * of the schematic, and on sbb-dl-principale drawing it again cost 2:09 of a
   * blocked editor for every "Aggiorna" (2026-11-09).
   */
  schematicFrom?: { circuitJson: unknown[]; summary: unknown } | null;
  /**
   * Draw the schematic even when the estimate says it would not end in the
   * time left (see stimaDelloSchematico): the way out for whoever compiles
   * and knows better, at the risk of the function being cut off.
   */
  forceSchematic?: boolean;
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
  // a copy, never the caller's map: whoever hashes it afterwards must hash
  // the project files, not what the runner added to them
  projectFsMap = { ...projectFsMap };
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
  /*
   * The clearance each <copperpour> declares for itself, written on its pours
   * before they are poured again (see conDistanzeDichiarate). Also on the
   * fallback, the board as tscircuit poured it when the re-pour fails: tscircuit
   * already honoured the declared value there, and the checks must judge it by
   * the same one. A board that declares none gets back the array it gave.
   */
  const conDistanzeProprie = (circuitJson: CircuitElement[]): CircuitElement[] =>
    conDistanzeDichiarate(circuitJson as never, projectFsMap, projectRules.rules.minClearanceMm) as never;
  /*
   * A compile never routes and never places, whoever calls it (Niccolo',
   * 2026-11-09: "il routing lo farai sempre tu, togli ogni AUTO"). Copper is
   * drawn by hand (<trace pcbPath>, manual-edits pcb_routes) and parts are put
   * where a person decided; the compile reads the files, carries over the
   * copper already on the board and checks it. On sbb-dl-retro an "Applica"
   * looked like an autorouting run and the page hung: no path may start one.
   */
  opts = { ...opts, route: false, place: false };
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
   * Recompile without routing: the geometry is the new one, the copper is the
   * one that was already there. See CompileOptions.route. One function for the
   * early board (no schematic yet) and the final one, so the two cannot drift.
   * The copper (rameDellaScheda) and the summary (riepilogoDellaScheda) are
   * apart so the final board can reuse the copper and the checks of the early
   * one: see innestaSchematico.
   */
  const rameDellaScheda = async (
    geometry: CircuitElement[],
  ): Promise<{ circuitJson: CircuitElement[]; rapportoColate: CompileSummary["pours"] }> => {
    /*
     * tscircuit writes "Autorouting was skipped because of placement errors"
     * even here, where nobody asked for routing: two overlapping pads while
     * placing (normal, mid-work) and the board looked like a failed routing,
     * which kept the previous board on screen (sbb-dl-frontale, 2026-11-09).
     * The overlaps themselves stay, as errors on the board.
     */
    const senzaSbroglio = geometry.filter((el) => el.type !== "pcb_autorouting_error");
    const conRame = carryCopper(senzaSbroglio, opts.keepCopperFrom ?? []);
    const conMano = applyManualRoutes({
      circuitJson: conRame,
      routes: parsedManualEdits.pcb_routes,
      viaDiameter: projectRules.rules.minViaDiameterMm,
      viaHoleDiameter: projectRules.rules.minViaHoleMm,
    });
    // the planes, poured again with the copper in place: see pours-recompute.ts
    // from the outlines the files declare, not the shrunken ones, when tscircuit poured them: see colateDichiarate
    const dichiarate = colateDichiarate(conMano.circuitJson as never, projectFsMap);
    const ricolate = await ricolaPiani({
      // each with the clearance its <copperpour> declares, if it does: see conDistanzeDichiarate
      circuitJson: conDistanzeProprie(dichiarate.circuitJson as never) as never,
      // a pour holds its own distance, wider than a trace's when the board says so
      clearanceMm:
        projectRules.rules.pourClearanceMm ?? projectRules.rules.minClearanceMm,
      bordoMm: projectRules.rules.minBoardEdgeClearanceMm,
      larghezzaMinimaMm: projectRules.rules.minTraceWidthMm,
    }).catch(() => null);
    // the stencil of each pad is the pad: see solder-paste.ts
    const circuitJson = pastaDaiPad(
      (ricolate?.circuitJson ?? conDistanzeProprie(conMano.circuitJson as never)) as CircuitElement[],
      projectRules.rules.pasteExpansionMm ?? 0,
      { stencil: leggiStencil(projectFsMap).stencil, pasteOnPlatedHoles: projectRules.rules.pasteOnPlatedHoles },
    );
    const rapportoColate = ricolate ? esitoColate(ricolate, dichiarate.senzaPezzi) : undefined;
    return { circuitJson, rapportoColate };
  };
  /** the summary of a board whose copper and checks are already measured */
  const riepilogoDellaScheda = (scheda: SchedaCalcolata, circuitJson: CircuitElement[], controlli: ControlliDellaScheda): CompileSummary => {
    const summary = summarize(circuitJson, projectFsMap, controlli);
    summary.pours = scheda.rapportoColate;
    summary.manualEdits = manualEdits;
    summary.manualEditsOrphans = withOrphans(summary, circuitJson, parsedManualEdits);
    if (placementReport) summary.placementReport = placementReport;
    summary.message = scheda.orfane === 0
      ? `${summary.message} (geometria aggiornata, rame non toccato)`
      : `${summary.message} (geometria aggiornata, rame non toccato: ${scheda.orfane} piste non arrivano piu' su un pad, vanno ridisegnate a mano)`;
    conIlPerche(summary);
    return summary;
  };
  const boardWithoutRouting = async (
    geometry: CircuitElement[],
    announce = false,
  ): Promise<{ summary: CompileSummary; circuitJson: CircuitElement[]; scheda: SchedaCalcolata }> => {
    const { circuitJson, rapportoColate } = await rameDellaScheda(geometry);
    if (announce) say({ step: "Controllo le regole", progress: 0.95, circuitJson });
    const scheda: SchedaCalcolata = {
      circuitJson,
      rapportoColate,
      controlli: controlliDellaScheda(circuitJson, projectFsMap),
      orfane: danglingTraces(circuitJson),
    };
    // a copy for this summary: the checks stay as measured, for the board the schematic goes on
    return { summary: riepilogoDellaScheda(scheda, circuitJson, structuredClone(scheda.controlli)), circuitJson, scheda };
  };

  /*
   * THE BOARD FIRST, ALONE. Compiled without the schematic (seconds even on a
   * 219-part board) and handed to whoever saves it: see CompileOptions.onBoard.
   * A failure here costs nothing: the full compile below says what is wrong.
   */
  const chiaveSchema = schematicKeyOf(projectFsMap);
  const schemaDiPrima =
    opts.schematicFrom &&
    (opts.schematicFrom.summary as { schematicKey?: unknown } | null)?.schematicKey === chiaveSchema
      ? opts.schematicFrom.circuitJson
      : null;
  /** the board with the previous schematic on it, when the schematic has not changed */
  let innestata: CircuitElement[] | null = null;
  /**
   * The board read without its schematic and computed once (copper, pours,
   * paste, checks): the final board is this one with the schematic put on it,
   * see innestaSchematico.
   */
  let primaPassata: {
    pcbOnly: CircuitElement[];
    scheda: SchedaCalcolata;
    /** the board saved early, and the message of its summary before "(schematico in calcolo)" */
    early: { summary: CompileSummary; circuitJson: CircuitElement[] };
    messaggio: string;
    pezzi: number;
    /** what its copper, pours and checks cost: what computing the board again would cost */
    rameMs: number;
  } | null = null;
  /** what drawing the schematic cost the last time it was measured, and on how many parts: carried to the next compile */
  const costoDiPrima = costoDelloSchematico(opts.schematicFrom?.summary);
  const pezziDi = (cj: CircuitElement[]) => cj.filter((e) => e.type === "source_component").length;
  /** what drawing the schematic cost in this compile, when it drew it: see costoDelloSchematico */
  const misuraDiOra = (pezzi: number) => costoDelloSchematico({ profile: profiler.result(), schematicCostParts: pezzi });
  /** the measure a summary carries to the next compile, next to the parts it was taken on */
  const portaLaMisura = (summary: CompileSummary, misura: MisuraDelloSchematico | null) => {
    if (!misura) return;
    summary.schematicCostMs = misura.ms;
    if (misura.pezzi !== null) summary.schematicCostParts = misura.pezzi;
  };
  /**
   * The board computed without its schematic, closed as the outcome: why it
   * has no schematic goes in schematicPending (the page shows it, the closing
   * line of the log says it first, see rigaDiFine) and in the message.
   */
  const chiudiSenzaSchematico = (
    early: { summary: CompileSummary; circuitJson: CircuitElement[] },
    pezzi: number,
    motivo: string,
  ): CompileResult => {
    early.summary.schematicPending = motivo;
    early.summary.message = `${early.summary.message} SCHEMATICO NON CALCOLATO: ${motivo}.`;
    early.summary.profile = { ...profiler.result(), patches: enginePatches() };
    portaLaMisura(early.summary, misuraDiOra(pezzi) ?? costoDiPrima);
    console.log(`[compile] ${motivo}; chiusa senza schematico in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
    return { summary: early.summary, circuitJson: early.circuitJson };
  };
  if (opts.route === false && (opts.onBoard || schemaDiPrima)) {
    say({
      step: "Leggo la scheda",
      detail: schemaDiPrima ? "lo schematico non e' cambiato: riuso quello salvato" : "prima il rame e i pezzi, lo schematico dopo",
      progress: 0.05,
    });
    let pcbOnly: CircuitElement[] | null = null;
    const inizioPcb = Date.now();
    try {
      pcbOnly = await profiler.run("scheda senza schematico (tscircuit)", () =>
        compileGeometryOnly(fsMap, { schematic: false }),
      );
    } catch {
      pcbOnly = null;
    }
    const pcbMs = Date.now() - inizioPcb;
    if (pcbOnly && schemaDiPrima) innestata = graftSchematic(pcbOnly, schemaDiPrima);
    if (pcbOnly && !innestata && opts.onBoard && pcbOnly.some((el) => el.type === "pcb_board")) {
      const inizioRame = Date.now();
      const early = await profiler.run("rame, colate e controlli della scheda senza schematico", () =>
        boardWithoutRouting(pcbOnly as CircuitElement[]),
      );
      const rameMs = Date.now() - inizioRame;
      portaLaMisura(early.summary, costoDiPrima);
      const pezzi = pezziDi(pcbOnly);
      /*
       * WHETHER THE SCHEMATIC FITS IN THE TIME LEFT. The tscircuit compile with
       * the schematic reads the whole board again and then draws: it is CPU for
       * minutes that nothing can interrupt, so a compile that starts it without
       * the time ends when the platform kills the function, with no word and no
       * outcome in the log (sbb-dl-principale, 11/11/2026: every compile
       * "running" until the 800 s, then interrupted at 900, the schematic gone
       * for good). When it does not fit it does not start: the board is the one
       * just computed, saved as the outcome, and says why it has no schematic.
       */
      const stima = stimaDelloSchematico({
        misura: costoDiPrima,
        pezzi,
        pcbMs,
        // what a compile with the whole function would still have at this point, minus the margin
        tettoMs: COMPILE_BUDGET_PIENO_MS - (Date.now() - startedAt) - MARGINE_SUL_TETTO_MS,
      });
      const restano = timeLeft();
      if (restano < stima.ms) {
        const motivo = motivoNonPartito(restano, stima);
        // whoever compiles may ask for it all the same (forceSchematic)
        if (!opts.forceSchematic) return chiudiSenzaSchematico(early, pezzi, motivo);
        console.log(`[compile] schematico chiesto comunque da chi compila: ${motivo}`);
      }
      primaPassata = { pcbOnly, scheda: early.scheda, early, messaggio: early.summary.message, pezzi, rameMs };
      early.summary.schematicPending =
        "scheda salvata prima dello schematico: lo schematico e i suoi controlli arrivano a fine compilazione";
      // the board saved early carries its timings too: the final save may never come
      early.summary.profile = { ...profiler.result(), patches: enginePatches() };
      early.summary.message = `${early.summary.message} (schematico in calcolo)`;
      try {
        await profiler.run("salvataggio della scheda senza schematico", () =>
          opts.onBoard!({ circuitJson: early.circuitJson, summary: early.summary }),
        );
      } catch {
        // saving early is a bonus: the full compile goes on and saves at the end
      }
      console.log(`[compile] scheda senza schematico pronta in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
      say({ step: "Scheda pronta", detail: "ora disegno lo schematico", progress: 0.15, circuitJson: early.circuitJson });
      /*
       * One turn of the event loop before the schematic: drawing it is minutes
       * of CPU without a single await that reaches the network, and what was
       * just sent (the "board saved" event, the log line) sat in the socket
       * until it ended. On sbb-dl-principale the page heard "Scheda pronta" at
       * 117 s for a board saved at 30 (2026-11-09).
       */
      await new Promise((r) => setTimeout(r, 100));
    }
  }

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
  let geometry: CircuitElement[] | null = innestata;
  if (!geometry) {
    say({
      step: opts.onBoard ? "Disegno lo schematico" : "Leggo la scheda",
      detail: opts.onBoard ? "collegamenti ed etichette: sulle schede grandi e' la parte lunga" : "componenti, piedini, collegamenti",
      progress: opts.onBoard ? 0.2 : 0.05,
    });
    try {
      state.attempts += 1;
      geometry = await profiler.run("scheda con schematico (tscircuit)", () => compileGeometryOnly(fsMap));
    } catch (err) {
      state.fatalError = err instanceof Error ? err.message : String(err);
    }
  } else {
    console.log(`[compile] schematico invariato: riusato, scheda pronta in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
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
    const g = geometry;
    /*
     * THE COPPER AND THE CHECKS ONCE. The board saved early was computed from
     * these same files: its copper, pours, paste and checks are the ones this
     * geometry would give again (see innestaSchematico), so only the schematic
     * goes on it and only the checks that read the schematic are run. Pouring
     * the planes and running every check a second time was ~190 s on Vercel on
     * sbb-dl-principale, and the reason its compiles never ended (11/11/2026).
     * When the two readings of the board differ, the board is computed again
     * from this geometry, as before.
     */
    const prima = primaPassata;
    const innestato = prima
      ? await profiler.run("schematico sulla scheda gia' calcolata e suoi controlli", () => {
          const conSchematico = innestaSchematico(prima.scheda.circuitJson, prima.pcbOnly, g);
          if (!conSchematico) return null;
          say({ step: "Controllo le regole", progress: 0.95, circuitJson: conSchematico });
          // a copy: the early summary keeps the lists it was saved with
          return { summary: riepilogoDellaScheda(prima.scheda, conSchematico, structuredClone(prima.scheda.controlli)), circuitJson: conSchematico };
        })
      : null;
    if (prima && !innestato) {
      /*
       * Computing the board again costs what its first pass cost (pours and
       * checks of the same files), and the time left may no longer hold it:
       * the estimate that let the schematic start counted 30 s after it, not a
       * second board. Without the time the compile closes with the board saved
       * early and says why, as when the schematic does not start, instead of
       * being cut off at the end of the function with no outcome. The same
       * margin as on the measure of the schematic: on Vercel one board took 82
       * and 146 s on the same day.
       */
      const serve = Math.round(prima.rameMs * MARGINE_SULLA_MISURA);
      const restano = timeLeft();
      if (restano < serve) {
        prima.early.summary.message = prima.messaggio;
        return chiudiSenzaSchematico(
          prima.early,
          prima.pezzi,
          motivoNonInnestato(serve, restano),
        );
      }
      console.log("[compile] le due letture della scheda non coincidono: rame, colate e controlli rifatti");
    }
    const { summary, circuitJson } = innestato ?? (await profiler.run("rame, colate e controlli", () => boardWithoutRouting(g, true)));
    /*
     * Where the time went, in the summary and in the function log: on Vercel
     * the same compile takes several times the local one, and without the
     * split nobody can tell the board from the schematic.
     */
    summary.profile = { ...profiler.result(), patches: enginePatches() };
    // what the schematic cost now, or the last measure when it was not drawn: the next compile decides on it
    portaLaMisura(summary, innestata ? costoDiPrima : (misuraDiOra(pezziDi(circuitJson)) ?? costoDiPrima));
    // what this schematic was drawn from: the next compile with the same key reuses it
    if (circuitJson.some((e) => e.type === "schematic_component")) summary.schematicKey = chiaveSchema;
    if (innestata) summary.message = `${summary.message} (schematico invariato, riusato)`;
    console.log(
      `[compile] ${summary.profile.spans.map((sp) => `${sp.name} ${(sp.ms / 1000).toFixed(1)}s`).join(", ")}; totale ${(summary.profile.totalMs / 1000).toFixed(1)}s`,
    );
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
                // the project's vias, not JLCPCB's: the candidate is judged
                // with the copper it will really be written with
                spliceTraces(base, section.subcircuitId, traces, "eval", projectRules.rules),
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
          const assembled = assembleCircuit(base, picks, projectRules.rules);
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
        // on the board without pours, like the first pass: with ground copper
        // on every layer the solver does not close (see routingFsMap above)
        compileWithLocalRouter(routingFsMap, 5, projectRules.rules, routerSay),
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
          compileWithLocalRouter(routingFsMap, efforts[i] ?? 10, projectRules.rules, routerSay),
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
        /*
         * The PROJECT's rules. Without them the loop measured, redid and
         * re-widened every zone against JLCPCB's minimums, on a board whose
         * own rules the final DRC then applied: it could polish a route the
         * check would reject, and leave alone one it would have accepted.
         */
        rules: projectRules.rules,
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
  /*
   * The ground wires are dropped by stitchToPlanes, AFTER it has tried to give
   * every pad its via, and only for the pads that got one. Dropping them first
   * (as a separate pass did) meant that a ground pad with no room for a via
   * lost its only wire before anyone asked whether it had another way down.
   */
  const pours = (geometry ?? []).filter((el) => el.type === "pcb_copper_pour");
  const poured =
    pours.length > 0
      ? [...state.best.circuitJson.filter((el) => el.type !== "pcb_copper_pour"), ...pours]
      : state.best.circuitJson;
  state.best = { ...state.best, circuitJson: poured };

  const routed = snapTo45(
    straightenPinEscapes(
      widenThinTraces(
        nudgeCrowdedVias(
          // a board whose copper already exists keeps its own planes: see autoPlaneVias
          projectRules.rules.autoPlaneVias === false
            ? state.best.circuitJson
            : stitchToPlanes(state.best.circuitJson, projectRules.rules),
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
  // from the outlines the files declare, not the shrunken ones, when tscircuit poured them: see colateDichiarate
  const dichiarate = colateDichiarate(manual.circuitJson as never, projectFsMap);
  const ricolate = await ricolaPiani({
    // each with the clearance its <copperpour> declares, if it does: see conDistanzeDichiarate
    circuitJson: conDistanzeProprie(dichiarate.circuitJson as never) as never,
    clearanceMm:
      projectRules.rules.pourClearanceMm ?? projectRules.rules.minClearanceMm,
    bordoMm: projectRules.rules.minBoardEdgeClearanceMm,
    larghezzaMinimaMm: projectRules.rules.minTraceWidthMm,
  }).catch(() => null);
  // the stencil of each pad is the pad: see solder-paste.ts
  const circuitJson = pastaDaiPad(
    (ricolate?.circuitJson ?? conDistanzeProprie(manual.circuitJson as never)) as CircuitElement[],
    projectRules.rules.pasteExpansionMm ?? 0,
    { stencil: leggiStencil(projectFsMap).stencil, pasteOnPlatedHoles: projectRules.rules.pasteOnPlatedHoles },
  );
  const rapportoColate = ricolate ? esitoColate(ricolate, dichiarate.senzaPezzi) : undefined;
  // we analyze the REAL sources, not the ones with injected props: otherwise
  // every hand-pinned component would be flagged as a spurious schX/schY
  // and the agent would chase a defect that does not exist
  say({ step: "Controllo le regole", progress: 0.95, circuitJson });
  const summary = await profiler.run("controlli (DRC, elettrici, schematico, footprint)", () =>
    summarize(circuitJson, projectFsMap),
  );
  summary.pours = rapportoColate;
  summary.manualEdits = manualEdits;
  summary.manualEditsOrphans = withOrphans(summary, circuitJson, parsedManualEdits);
  conIlPerche(summary);
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

/**
 * A compile or a recheck whose board still has a plane over a via of another
 * net says so in its message, with what follows from it: the board is filed
 * under an older engine and the export refuses it (see motoreDaSalvare). The
 * planes are poured again at the end of every compile, but when that step
 * fails the old ones stay on the board, and nothing else in the answer says it.
 */
export function conIlPerche(summary: CompileSummary): void {
  const perche = nonCertificata(summary);
  if (perche) summary.message = `${summary.message} ATTENZIONE: ${perche}.`;
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

/*
 * THE ROUTER OF A BOARD THAT NAMES NONE. The autorouterMap below only replaces
 * the presets a board declares (auto, auto-local, auto-cloud): a <board> with
 * no `autorouter` prop never looks the map up, and tscircuit falls back to its
 * own local router. On the sonda del suolo the "geometry only" compile was
 * therefore routing the whole board with that router (minutes, thrown away)
 * and leaving a stray "unknown PCB terminal" error behind; a routed compile
 * used it instead of ours, without the project's fab rules. tscircuit reads a
 * missing prop from the platform (getInheritedProperty), so the platform
 * names the preset the map handles.
 */
const PRESET_DI_DIFETTO = "auto";

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
    autorouter: PRESET_DI_DIFETTO,
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
 * What the schematic depends on: every file but the hand-held PCB positions,
 * and in the code files nothing that only the copper reads (see
 * soloCioCheLeggeLoSchematico). The sources, the library, the schematic notes,
 * the schematic placements and the engine: change any of these and the
 * schematic is drawn again; move, turn or flip parts on the board, draw a
 * trace's path, add a via or a pour, and it is not.
 */
export function schematicKeyOf(projectFsMap: FsMap): string {
  const edits = parseManualEdits(projectFsMap[MANUAL_EDITS_PATH]);
  const rest: Record<string, string> = {};
  for (const [k, v] of Object.entries(projectFsMap)) {
    if (k === MANUAL_EDITS_PATH) continue;
    rest[k] = /\.[jt]sx?$/.test(k) ? soloCioCheLeggeLoSchematico(v) : v;
  }
  rest["__schematic_placements__"] = JSON.stringify(edits.schematic_placements);
  rest["__engine__"] = String(CHECKS_ENGINE_VERSION);
  return filesHash(rest);
}

/**
 * Elements only the copper reads: whole, with whatever they carry. Each one
 * checked against the engine (tscircuit as pinned here): with or without it
 * the schematic_* elements of a board are the same, and so are its components,
 * nets and connections. A via adds ports of its own, which no schematic
 * element points at (see stessiSorgenti).
 */
const SOLO_RAME_ELEMENTI = new Set([
  "via",
  "copperpour",
  "silkscreentext",
  "silkscreenpath",
  "silkscreenline",
  "silkscreenrect",
  "silkscreencircle",
  "fabricationnotepath",
  "fabricationnotetext",
  "keepout",
  "cutout",
  "hole",
  "fiducial",
]);
/**
 * Attributes only the copper reads on an element of tscircuit: where a part or
 * a pad is and on which side (pcbX, pcbY, pcbRotation, layer), the path and
 * the width of a hand-drawn trace (pcbPath, pcbPathRelativeTo, thickness). The
 * trace itself stays, with its from and to: it is a wire of the schematic.
 */
const SOLO_RAME_ATTRIBUTI = new Set(["pcbX", "pcbY", "pcbRotation", "layer", "pcbPath", "pcbPathRelativeTo", "thickness"]);

/**
 * An element of tscircuit itself: a lowercase name, as JSX reads it (`<chip>`,
 * `<smtpad>`). `<Pull>` or `<lib.Part>` is a component of the user, whose
 * props mean what its code makes of them: a `layer` there can choose the net a
 * pull goes to, a `pcbRotation` can become the schRotation of what it draws
 * (both seen in review, 11/11/2026). The schematic primitives keep every
 * attribute, whatever its name.
 */
const elementoDiTscircuit = (nome: string): boolean => /^[a-z][a-z0-9]*$/.test(nome) && !nome.startsWith("sch");

/**
 * Whether a value is written out where it stands: a string, or numbers,
 * strings, lists and objects of them (`{-6}`, `{[{ x: 1, y: 2 }]}`). A value
 * that reads anything else (`{props.layer}`, `{giro}`, a call) may carry what
 * the code does elsewhere, and stays in the key.
 */
function valoreScritto(a: JsxAttr): boolean {
  if (a.kind === "string") return true;
  if (a.kind !== "expr") return false;
  const resto = a.raw
    .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`[^`$\\]*`/g, "0")
    // the keys of an object written out
    .replace(/[A-Za-z_$][\w$]*\s*:/g, ":")
    .replace(/\b(?:true|false|null|undefined)\b/g, "0")
    .replace(/(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g, "0");
  return /^[\s0.,:[\]{}()+\-*/]*$/.test(resto);
}

/**
 * A code file without what only the copper reads, when it is written as a
 * JSX literal: the elements and attributes above go, with the blank before
 * them, so a file with one via more or one pcbX less reads the same. Only on
 * the elements of tscircuit (elementoDiTscircuit), and an attribute only when
 * its value is written out (valoreScritto): on a component of the user, or
 * with a value read from a prop or a variable, it stays. Anything else stays
 * as it is: what starts with sch, the symbols, pinLabels, names, values,
 * connections, footprints and their pads, expressions, comments. In doubt an
 * element or an attribute stays: a schematic drawn again costs minutes, an old
 * one reused is wrong. graftSchematic then checks the components, ports, nets
 * and connections before reusing anything. A file the scanner cannot read
 * within its limits (see scanJsxTagsOrNull) enters the key as it is.
 */
export function soloCioCheLeggeLoSchematico(src: string): string {
  if (!src.includes("<")) return src;
  const tags = scanJsxTagsOrNull(src, { includeNested: true });
  if (!tags) return src;
  const tagli: Array<[number, number]> = [];
  /** the blank before a cut: spaces and tabs, and one line break (with what indents it) */
  const conIlBianco = (inizio: number): number => {
    let i = inizio;
    while (i > 0 && (src[i - 1] === " " || src[i - 1] === "\t")) i--;
    if (i > 0 && src[i - 1] === "\n") i--;
    if (i > 0 && src[i - 1] === "\r") i--;
    return i;
  };
  for (const tag of tags) {
    if (!elementoDiTscircuit(tag.name)) continue;
    if (SOLO_RAME_ELEMENTI.has(tag.name)) {
      tagli.push([conIlBianco(tag.start), tag.closeEnd ?? tag.end]);
      continue;
    }
    for (const a of parseJsxAttrs(src.slice(tag.attrsStart, tag.attrsEnd))) {
      if (!SOLO_RAME_ATTRIBUTI.has(a.name) || a.valueStart === -1 || !valoreScritto(a)) continue;
      // attributes may sit one per line: any blank before them goes
      let i = tag.attrsStart + a.nameStart;
      while (i > tag.attrsStart && /\s/.test(src[i - 1])) i--;
      tagli.push([i, tag.attrsStart + a.valueEnd]);
    }
  }
  if (tagli.length === 0) return src;
  tagli.sort((x, y) => x[0] - y[0] || y[1] - x[1]);
  let out = "";
  let da = 0;
  for (const [inizio, fine] of tagli) {
    if (fine <= da) continue;
    out += src.slice(da, Math.max(da, inizio));
    da = Math.max(da, fine);
  }
  return out + src.slice(da);
}

/**
 * The board just read (without schematic) with the schematic of the previous
 * compile on it. Only when every source element the schematic points at is the
 * same one, with the same id and the same name: otherwise null, and the
 * schematic is drawn again.
 */
export function graftSchematic(pcbOnly: CircuitElement[], previous: unknown[]): CircuitElement[] | null {
  const prev = previous as CircuitElement[];
  const schema = prev.filter((e) => String(e.type).startsWith("schematic_"));
  if (!schema.some((e) => e.type === "schematic_component")) return null;
  if (!stessiSorgenti(pcbOnly, prev)) return null;
  return [...pcbOnly.filter((e) => !String(e.type).startsWith("schematic_")), ...schema];
}

/**
 * Whether two circuits have the same source elements the schematic points at
 * and the same things it shows: every component with its kind and values (all
 * it carries but the supplier codes, which tscircuit fetches from the network
 * and which no symbol shows), every port with its name and number, every net,
 * and every connection with the ports and the nets it joins. A trace keeps its
 * id when it is moved to another pin or net, so the id alone said yes to a
 * schematic with the wire somewhere else (review of 11/11/2026). The ports of a
 * <via> do not count: a via has ports (top, bottom, pin1) and no symbol, and no
 * schematic element points at them, so adding vias on the board leaves the
 * schematic as it is. They are numbered after the parts' ports only when the
 * vias come after the parts in the files: when they do not, the parts' ports
 * move and the comparison says no.
 */
function stessiSorgenti(a: CircuitElement[], b: CircuitElement[]): boolean {
  const dellaVia = (els: CircuitElement[]) =>
    new Set(els.filter((e) => e.type === "source_manually_placed_via").map((e) => String(e.source_manually_placed_via_id ?? "")));
  const elenco = (v: unknown) => (Array.isArray(v) ? v.map(String).sort().join(",") : "");
  const firme: Record<string, (e: CircuitElement) => string> = {
    source_component: (e) => JSON.stringify({ ...e, supplier_part_numbers: undefined }),
    source_port: (e) => `${String(e.source_port_id)}|${String(e.name ?? "")}|${String(e.source_component_id ?? "")}|${String(e.pin_number ?? "")}`,
    source_net: (e) => `${String(e.source_net_id)}|${String(e.name ?? "")}`,
    source_trace: (e) =>
      `${String(e.source_trace_id)}|${elenco(e.connected_source_port_ids)}|${elenco(e.connected_source_net_ids)}`,
  };
  const firma = (els: CircuitElement[], vie: Set<string>, tipo: string) =>
    els
      .filter((e) => e.type === tipo && !(tipo === "source_port" && vie.has(String(e.source_component_id ?? ""))))
      .map(firme[tipo])
      .sort()
      .join("\n");
  const vieA = dellaVia(a);
  const vieB = dellaVia(b);
  for (const tipo of Object.keys(firme)) {
    if (firma(a, vieA, tipo) !== firma(b, vieB, tipo)) return false;
  }
  return true;
}

/**
 * An element as a comparable string. Two readings of the same files in one
 * function differ in two things that are not the board: tscircuit numbers
 * every component it renders across the whole process and writes the number
 * into its warnings ("<trace#28(from:...)"), and some warnings get a random id
 * (supplier_footprint_mismatch_warning_xCVCEvBItJ, measured on tm-4l-q1). So
 * the number does not count, and neither does the own id of a warning or an
 * error: the summary reads their type and message.
 */
const impronta = (e: CircuitElement): string => {
  const tipo = String(e.type);
  const el = tipo.endsWith("_warning") || tipo.endsWith("_error") ? { ...e, [`${tipo}_id`]: undefined } : e;
  return JSON.stringify(el).replace(/<(\w+)#\d+/g, "<$1#");
};

/**
 * THE SCHEMATIC PUT ON THE BOARD ALREADY COMPUTED (see compileProject). `scheda`
 * is the board computed from `pcbOnly` (the files read without the schematic):
 * copper carried over, hand routes, pours poured again, paste. `geometry` is
 * the same files read with the schematic. The board that geometry would give
 * is `scheda` itself when the two readings hold the same board, so the
 * schematic elements of `geometry` are put into `scheda`, in the place they
 * have in `geometry`, and nothing is poured or checked again.
 *
 * Only when it is certain, otherwise null and the caller computes the board
 * again from `geometry`, as before:
 *  - the same source elements the schematic points at (stessiSorgenti, as for
 *    graftSchematic);
 *  - the same elements in the two readings apart from the schematic, in any
 *    order: the two runs may finish the pours and some warnings in a
 *    different order (measured on tm-4l-q1), never different ones;
 *  - the schematic sits after elements the board work did not touch: those
 *    before it are the same in `scheda` and in `geometry`, so the result has
 *    the order the board computed from `geometry` would have.
 */
export function innestaSchematico(
  scheda: CircuitElement[],
  pcbOnly: CircuitElement[],
  geometry: CircuitElement[],
): CircuitElement[] | null {
  const loSchematico = (e: CircuitElement) => String(e.type).startsWith("schematic_");
  if (pcbOnly.some(loSchematico) || scheda.some(loSchematico)) return null;
  const senza = geometry.filter((e) => !loSchematico(e));
  if (senza.length !== pcbOnly.length) return null;
  if (!stessiSorgenti(senza, pcbOnly)) return null;
  const a = senza.map(impronta).sort();
  const b = pcbOnly.map(impronta).sort();
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return null;
  /* where each schematic element sits: after how many elements of the board */
  let ultimo = 0;
  let k = 0;
  for (const e of geometry) {
    if (loSchematico(e)) ultimo = k;
    else k++;
  }
  if (ultimo > scheda.length) return null;
  for (let i = 0; i < ultimo; i++) if (impronta(scheda[i]) !== impronta(senza[i])) return null;
  const out: CircuitElement[] = [];
  k = 0;
  for (const e of geometry) {
    if (k >= ultimo && !loSchematico(e)) break;
    if (loSchematico(e)) out.push(e);
    else out.push(scheda[k++]);
  }
  return [...out, ...scheda.slice(ultimo)];
}

/** the name of the tscircuit compile with the schematic in the profile */
const SPAN_CON_SCHEMATICO = "scheda con schematico (tscircuit)";
const SPAN_SENZA_SCHEMATICO = "scheda senza schematico (tscircuit)";

/** what drawing the schematic cost once, and on how many parts (null when not known) */
export interface MisuraDelloSchematico {
  ms: number;
  pezzi: number | null;
}

/**
 * What drawing the schematic cost, read from a saved summary: its own profile
 * when that compile drew it (the compile with the schematic minus the one
 * without, or the whole compile with the schematic when there was no early
 * board, which is more), otherwise the measure it carries (schematicCostMs).
 * With the parts of the board it was taken on (schematicCostParts, or the
 * parts that summary lists). Null when nothing ever measured it.
 */
export function costoDelloSchematico(summary: unknown): MisuraDelloSchematico | null {
  const s = summary as
    | { profile?: { spans?: Array<{ name?: unknown; ms?: unknown }> }; schematicCostMs?: unknown; schematicCostParts?: unknown; components?: unknown }
    | null
    | undefined;
  const numero = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const ms = (nome: string): number | null => numero(s?.profile?.spans?.find((x) => x?.name === nome)?.ms);
  const pezziScritti = numero(s?.schematicCostParts);
  const con = ms(SPAN_CON_SCHEMATICO);
  if (con !== null) {
    const senza = ms(SPAN_SENZA_SCHEMATICO);
    return {
      ms: senza !== null ? Math.max(0, con - senza) : con,
      pezzi: pezziScritti ?? (Array.isArray(s?.components) ? s.components.length : null),
    };
  }
  const portata = numero(s?.schematicCostMs);
  return portata !== null ? { ms: portata, pezzi: pezziScritti } : null;
}

/**
 * Why a compile closed without the schematic, as schematicPending says it and
 * the closing line of the log keeps it whole (see rigaDiFine): short on
 * purpose, the numbers in seconds.
 */
export function motivoNonPartito(restano: number, stima: { ms: number; perche: string }): string {
  return `${SCHEMATICO_NON_PARTITO}: restavano ${Math.round(restano / 1000)} s, ne servono circa ${Math.round(stima.ms / 1000)} (${stima.perche})`;
}
export function motivoNonInnestato(serve: number, restano: number): string {
  return `${SCHEMATICO_NON_INNESTATO}: le due letture della scheda non coincidono e rifarla chiede circa ${Math.round(serve / 1000)} s, ne restavano ${Math.round(restano / 1000)}`;
}

/**
 * What a board saved again without a compile (Sposta, a trace taken off,
 * Ricontrolla, the schematic put on a board moved meanwhile) keeps from the
 * summary it had: its schematic is the same one, and so are the files it was
 * drawn from (schematicKey), the measure of what drawing it cost with its
 * parts (schematicCostMs, schematicCostParts: without it the next compile
 * estimated as if nothing had ever been measured) and the note that it is
 * still missing, or why (schematicPending). One place for every route that
 * rewrites a summary: what is added here travels on all of them.
 */
export function riportaLoSchematico(summary: CompileSummary, prima: unknown): CompileSummary {
  const p = (prima ?? {}) as { schematicKey?: unknown; schematicPending?: unknown };
  if (typeof p.schematicKey === "string") summary.schematicKey = p.schematicKey;
  if (typeof p.schematicPending === "string") summary.schematicPending = p.schematicPending;
  const misura = costoDelloSchematico(prima);
  if (misura) {
    summary.schematicCostMs = misura.ms;
    if (misura.pezzi !== null) summary.schematicCostParts = misura.pezzi;
  }
  return summary;
}

/**
 * What drawing the schematic is assumed to cost on a big board where nothing
 * has measured it: more than the 75-146 s it took on Vercel on
 * sbb-dl-principale (156 parts, 682 connections, 09-11/11/2026).
 */
export const SCHEMATICO_SENZA_MISURA_MS = 240_000;
/**
 * From how many parts a board is big: the same threshold from which the MCP
 * compile answers before the schematic, because from there it takes minutes.
 */
export const PEZZI_SCHEDA_GRANDE = EARLY_REPLY_MIN_COMPONENTS;
/**
 * A small board with nothing measured: its schematic counted as this many
 * times the reading of the board without it, never less than the minimum.
 * Measured locally (11/11/2026): up to 23 parts the schematic costs less than
 * the reading, 39 parts with 160 connections ~10 times; twice that, for room.
 */
export const SCHEMATICO_PICCOLA_PER_LETTURA = 20;
export const SCHEMATICO_PICCOLA_MINIMO_MS = 30_000;
/**
 * The measure of the last schematic, with room: on Vercel the same board
 * measured 82 and 146 s on the same day, and locally 182 s in a fresh process
 * and much less when drawn again in the same one (sbb-dl-principale, 11/11/2026).
 */
export const MARGINE_SULLA_MISURA = 1.5;
/** after the drawing: the schematic put on the board, its checks, the final save */
export const DOPO_LO_SCHEMATICO_MS = 30_000;
/**
 * Between the estimate's ceiling and the end of what a compile with the whole
 * function has: see stimaDelloSchematico.
 */
export const MARGINE_SUL_TETTO_MS = 60_000;

/**
 * Whether a measure taken on a board of `misurati` parts holds for one of
 * `pezzi`: within a tenth of the parts, and at least 4. A board that grew
 * past that is measured again.
 */
export function misuraValida(misura: MisuraDelloSchematico | null, pezzi: number): misura is MisuraDelloSchematico & { pezzi: number } {
  return misura !== null && misura.pezzi !== null && Math.abs(pezzi - misura.pezzi) <= Math.max(4, Math.round(misura.pezzi * 0.1));
}

/**
 * HOW LONG THE REST OF A COMPILE NEEDS once the board is saved:
 *
 *   resto = lettura + disegno + 30 s, at most tetto
 *
 *  - lettura (`pcbMs`): tscircuit reads the whole board again, as it just did
 *    without the schematic in this very compile;
 *  - disegno: the last measure on this board x1.5, when it was taken on a
 *    board with nearly as many parts (misuraValida); otherwise 240 s on a big
 *    board (PEZZI_SCHEDA_GRANDE parts or more) and 20 times the reading, at
 *    least 30 s, on a small one;
 *  - 30 s: the schematic put on the board, its checks, the final save;
 *  - tetto (`tettoMs`): what a compile that had the whole function would
 *    have left at this point, minus a margin. An estimate above it would keep
 *    the board from ever getting a schematic, whatever the compile: such a
 *    board starts when it has the whole function, and its new measure decides
 *    the next time.
 */
export function stimaDelloSchematico(dati: {
  misura: MisuraDelloSchematico | null;
  pezzi: number;
  pcbMs: number;
  tettoMs: number;
}): { ms: number; perche: string } {
  const { misura, pezzi, pcbMs, tettoMs } = dati;
  const s = (ms: number) => Math.round(ms / 1000);
  let disegno: number;
  let perche: string;
  if (misuraValida(misura, pezzi)) {
    disegno = Math.round(misura.ms * MARGINE_SULLA_MISURA);
    perche = `ultimo schematico ${s(misura.ms)} s su ${misura.pezzi} pezzi x1,5`;
  } else if (pezzi >= PEZZI_SCHEDA_GRANDE) {
    disegno = SCHEMATICO_SENZA_MISURA_MS;
    perche = `nessuna misura su ${pezzi} pezzi: ${s(SCHEMATICO_SENZA_MISURA_MS)} s`;
  } else {
    disegno = Math.max(SCHEMATICO_PICCOLA_MINIMO_MS, SCHEMATICO_PICCOLA_PER_LETTURA * pcbMs);
    perche = `scheda piccola (${pezzi} pezzi): ${SCHEMATICO_PICCOLA_PER_LETTURA} volte la lettura, almeno ${s(SCHEMATICO_PICCOLA_MINIMO_MS)} s`;
  }
  const intera = pcbMs + disegno + DOPO_LO_SCHEMATICO_MS;
  const ms = Math.min(intera, Math.max(0, tettoMs));
  perche += `, + lettura ${s(pcbMs)} s + ${s(DOPO_LO_SCHEMATICO_MS)} s`;
  if (ms < intera) perche += `; tetto ${s(ms)} s, la funzione intera`;
  return { ms, perche };
}

/**
 * Moves the copper of the previous board onto the new geometry.
 *
 * Traces and vias are taken as they are: they are absolute geometry, they do not
 * depend on the ids that change at every compile. What DOES depend on
 * them, the link to the source trace, is remapped by connection name, so the
 * "which connections are still open" count keeps working.
 *
 * The carried copper only fills the connections the files leave WITHOUT copper.
 * The previous board also holds the copper the files draw themselves (a
 * <trace> with its pcbPath, a <via>), and the geometry draws it again: carrying
 * it too put every hand-drawn trace and via twice on the board at every
 * "Aggiorna" (htl-401-scheda-unica, 253 traces became 506, then 759). So a
 * connection that already has copper in the geometry keeps that copper only,
 * and its old copper goes, vias included; and nothing is carried on top of an
 * identical piece already there. Recompiling N times gives the same board.
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

  /** the connection the old trace belongs to on the NEW board, if it still exists */
  const nuovoIdDi = (el: CircuitElement): string | undefined => {
    const vecchioId = String(el.source_trace_id ?? "");
    const porte = vecchioId ? vecchie.get(vecchioId) : undefined;
    return porte ? nuove.get(porte) : undefined;
  };
  /** the connections the files already draw: the geometry has copper for them */
  const disegnate = new Set(
    geometry
      .filter((el) => el.type === "pcb_trace" && el.source_trace_id)
      .map((el) => String(el.source_trace_id)),
  );

  /*
   * The old traces of a connection the files now draw go, and the vias that
   * were part of them with them: an old via left alone in the middle of the
   * board would be a hole nothing describes any more.
   */
  const viaKey = (x: unknown, y: unknown) => `${Math.round(Number(x) * 1e4)},${Math.round(Number(y) * 1e4)}`;
  const giaDisegnata = (trace: CircuitElement): boolean => disegnate.has(nuovoIdDi(trace) ?? "");
  const tracceTolte = new Set<string>();
  const tracceTenute = new Set<string>();
  const viaTolte = new Set<string>();
  const viaTenute = new Set<string>();
  for (const el of rame) {
    if (el.type !== "pcb_trace") continue;
    const tolta = giaDisegnata(el);
    const id = String(el.pcb_trace_id ?? "");
    if (id) (tolta ? tracceTolte : tracceTenute).add(id);
    for (const p of (el.route as Array<Record<string, unknown>> | undefined) ?? []) {
      if (p.route_type === "via") (tolta ? viaTolte : viaTenute).add(viaKey(p.x, p.y));
    }
  }
  const dellaTracciaTolta = (via: CircuitElement): boolean => {
    // a via a kept trace still passes through stays, whoever else used it
    const dove = viaKey(via.x, via.y);
    if (viaTenute.has(dove)) return false;
    if (viaTolte.has(dove)) return true;
    // ids are reused across compiles: one a kept trace still uses decides nothing
    const id = String(via.pcb_trace_id ?? "");
    return id !== "" && tracceTolte.has(id) && !tracceTenute.has(id);
  };

  /*
   * And nothing goes on top of an identical piece: the same trace on the same
   * path, the same via in the same spot. It also cleans a board already doubled
   * by the earlier carry, which is what the compile cache holds.
   */
  const impronta = (el: CircuitElement): string =>
    el.type === "pcb_via"
      ? `via ${viaKey(el.x, el.y)}`
      : `trace ${JSON.stringify(
          ((el.route as Array<Record<string, unknown>> | undefined) ?? []).map((p) => [
            p.route_type,
            Math.round(Number(p.x) * 1e4),
            Math.round(Number(p.y) * 1e4),
            p.layer ?? p.from_layer ?? null,
            p.to_layer ?? null,
            p.width ?? null,
          ]),
        )}`;
  const presenti = new Set(
    geometry.filter((el) => el.type === "pcb_trace" || el.type === "pcb_via").map(impronta),
  );

  const riportato: CircuitElement[] = [];
  for (const el of rame) {
    if (el.type === "pcb_trace" ? giaDisegnata(el) : dellaTracciaTolta(el)) continue;
    const chiave = impronta(el);
    if (presenti.has(chiave)) continue;
    presenti.add(chiave);
    const nuovoId = nuovoIdDi(el);
    // a connection that no longer exists keeps the old id: the copper stays
    // visible and the checks report it as orphaned, which is the truth
    riportato.push(nuovoId ? { ...el, source_trace_id: nuovoId } : el);
  }
  return [...geometry, ...riportato];
}

/** traces whose ends no longer land on a pad: copper of parts that have moved */
export function danglingTraces(circuitJson: CircuitElement[]): number {
  const REACH = 0.3;
  /*
   * Every pad, port and via by its points, with the layer it is on (see
   * stratoDelPad): an end on the bottom near the centre of a top pad is not on
   * that pad, and counted as landed it hid a trace that ends on nothing.
   */
  const pad: Array<{ x: number; y: number; strato: string | null }> = [];
  for (const el of circuitJson) {
    if (el.type !== "pcb_smtpad" && el.type !== "pcb_plated_hole" && el.type !== "pcb_port" && el.type !== "pcb_via") continue;
    const strato = stratoDelPad(el);
    const punti = Array.isArray(el.points)
      ? (el.points as Array<{ x?: unknown; y?: unknown }>)
      : [{ x: el.x, y: el.y }];
    for (const p of punti) {
      const x = num(p.x);
      const y = num(p.y);
      if (x !== null && y !== null) pad.push({ x, y, strato });
    }
  }
  /* the copper of every pad, by face: a long pad is entered far from its centre */
  const rame: Array<{ forma: FormaRame; layer: string | null }> = [];
  for (const el of circuitJson) {
    const forma = el.type === "pcb_smtpad" ? rameDelPad(el as never) : el.type === "pcb_plated_hole" ? rameDelForo(el as never) : null;
    if (forma) rame.push({ forma, layer: el.type === "pcb_smtpad" ? String(el.layer ?? "top") : null });
  }
  /* and the pours: a trace may end inside the plane it feeds */
  const colate: Array<{ layer: string; anello: Array<{ x: number; y: number }> }> = [];
  for (const el of circuitJson) {
    if (el.type !== "pcb_copper_pour") continue;
    const anello = (el.brep_shape as { outer_ring?: { vertices?: Array<{ x: number; y: number }> } } | undefined)?.outer_ring?.vertices ??
      (el.points as Array<{ x: number; y: number }> | undefined);
    if (anello && anello.length >= 3) colate.push({ layer: String(el.layer ?? ""), anello });
  }
  const dentroAnello = (x: number, y: number, a: Array<{ x: number; y: number }>) => {
    let d = false;
    for (let i = 0, j = a.length - 1; i < a.length; j = i++) {
      if (a[i].y > y !== a[j].y > y && x < ((a[j].x - a[i].x) * (y - a[i].y)) / (a[j].y - a[i].y) + a[i].x) d = !d;
    }
    return d;
  };
  const vicinoAUnPad = (x: number, y: number, layer: string) =>
    pad.some((p) => stessoStrato(p.strato, layer || null) && Math.abs(p.x - x) <= REACH && Math.abs(p.y - y) <= REACH) ||
    rame.some((r) => (r.layer === null || r.layer === layer) && distanzaPuntoForma(r.forma, x, y) <= 0.01) ||
    colate.some((c) => c.layer === layer && dentroAnello(x, y, c.anello));
  /*
   * A trace drawn by hand ends where the next one starts: on a via of the
   * route, or on the side of another trace (a T junction). Only pads counted
   * before, so every hand-routed board read "254 traces no longer reach a pad"
   * while its Gerbers had no open net at all.
   */
  const segmenti: Array<{ id: unknown; ax: number; ay: number; bx: number; by: number; w: number; layer: string }> = [];
  for (const el of circuitJson) {
    if (el.type !== "pcb_trace") continue;
    const route = (el.route as Array<Record<string, unknown>> | undefined) ?? [];
    for (let i = 0; i < route.length; i++) {
      const p = route[i];
      const x = num(p.x);
      const y = num(p.y);
      if (p.route_type === "via" && x !== null && y !== null) pad.push({ x, y, strato: null });
      const q = route[i + 1];
      if (!q || p.route_type !== "wire" || q.route_type !== "wire") continue;
      const bx = num(q.x);
      const by = num(q.y);
      if (x === null || y === null || bx === null || by === null) continue;
      segmenti.push({ id: el, ax: x, ay: y, bx, by, w: num(p.width) ?? 0.15, layer: String(p.layer ?? "") });
    }
  }
  const suUnaltraPista = (traccia: unknown, x: number, y: number, layer: string) =>
    segmenti.some((s) => {
      if (s.id === traccia || s.layer !== layer) return false;
      const dx = s.bx - s.ax;
      const dy = s.by - s.ay;
      const l2 = dx * dx + dy * dy;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - s.ax) * dx + (y - s.ay) * dy) / l2)) : 0;
      return Math.hypot(x - (s.ax + t * dx), y - (s.ay + t * dy)) <= s.w / 2 + 0.01;
    });

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
      if (!vicinoAUnPad(x, y, String(capo.layer ?? "")) && !suUnaltraPista(el, x, y, String(capo.layer ?? ""))) {
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
export async function compileGeometryOnly(
  fsMap: FsMap,
  opts: {
    /**
     * false: no schematic at all (tscircuit's `schematicDisabled`). The board,
     * its pads and its connections in seconds: on a big board the schematic
     * trace solver is almost the whole compile (see CompileOptions.onBoard).
     */
    schematic?: boolean;
  } = {},
): Promise<CircuitElement[]> {
  const noRouting = () => ({
    createAutorouter: () => ({
      on(event: string, cb: (payload: unknown) => void) {
        if (event === "complete") queueMicrotask(() => cb({ traces: [] }));
      },
      start() {},
      stop() {},
    }),
  });
  /*
   * EVERY preset a <board> or a <group> may name, not only the three we use:
   * tscircuit looks the (normalized) preset up in this map before its own
   * switch, so a board declaring "sequential-trace", "laser_prefab" or
   * "default" would otherwise be routed by tscircuit's router right here, in
   * the compile that must never route.
   */
  const presets = [
    "auto",
    "auto-local",
    "auto-cloud",
    "default",
    "subcircuit",
    "sequential-trace",
    "laser-prefab",
    "auto-jumper",
  ];
  const platform = {
    ...getPlatformConfig({
      autorouterMap: Object.fromEntries(presets.map((p) => [p, noRouting() as never])),
    }),
    autorouter: PRESET_DI_DIFETTO,
    ...(opts.schematic === false ? { schematicDisabled: true } : {}),
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

/**
 * WHAT THE CHECKS MEASURE WITHOUT LOOKING AT THE SCHEMATIC: the open
 * connections, the DRC of every fab class, pour against pour, the electrical
 * checks, matched lengths, paste, congestion, ratsnest, footprints, ERC,
 * placement, planes over vias, the pours' clearances. None of them reads a
 * schematic_* element, so the board without its schematic gives the same
 * numbers as the same board with it: a compile measures them once, on the
 * board it saves before the schematic, and the final summary takes them from
 * there (see compileProject). On sbb-dl-principale (156 parts, ~570 pieces of
 * pour) measuring them twice was part of the second ~190 s of "rame, colate e
 * controlli" that pushed every compile past the function's 800 s (11/11/2026).
 */
interface ControlliDellaScheda {
  unroutedConnections: string[];
  unroutedTotal: number;
  connectionGroups: number;
  unroutedDetail: UnroutedDetail[];
  sourceTraces: number;
  pcbTraces: number;
  stats: CompileSummary["stats"];
  totalTraceLengthMm: number;
  projectRules: ReturnType<typeof resolveDesignRules>;
  drcViolations: DrcViolation[];
  poursTooClose: ReturnType<typeof colateCheSiToccano>;
  /** the silkscreen clashes (see silkscreen-clearance.ts): a check of the board, it reads no schematic */
  silkscreen: SerigrafiaInConflitto | undefined;
  prcViolations: PrcViolation[];
  fabClasses: CompileSummary["fabClasses"];
  fabClass: string | null;
  congestion: CongestionCell[];
  ratsnest: CompileSummary["ratsnest"];
  footprintProvenance: FootprintProvenance;
  erc: ErcReport;
  placement: PlacementQuality;
  planesOverVias: ReturnType<typeof pianiSopraLeVie>;
  pourClearances: CompileSummary["pourClearances"];
  /** the pours' clearances and corrections, as summarize appends them to the message */
  messaggioColate: string;
}

function controlliDellaScheda(circuitJson: CircuitElement[], sources: FsMap): ControlliDellaScheda {
  const netNameById = new Map<string, string>();
  for (const el of circuitJson) {
    if (el.type === "source_net") {
      netNameById.set(String(el.source_net_id ?? ""), String(el.name ?? "?"));
    }
  }
  const sourceTraceEls = circuitJson.filter((el) => el.type === "source_trace");
  const pcbTraceEls = circuitJson.filter((el) => el.type === "pcb_trace");

  const traceLabel = (el: CircuitElement) =>
    String(el.display_name ?? el.source_trace_id ?? "trace");

  // Routing is judged per CONNECTIVITY GROUP, pad by pad: a group is open
  // as long as one of its pads is not on the same copper as the others, even
  // when some of its traces exist (see route-score.ts, unroutedGroups).
  const groupKey = (el: CircuitElement) =>
    String(el.subcircuit_connectivity_map_key ?? el.source_trace_id ?? "");
  const unrouted = unroutedGroups(circuitJson);
  const unroutedKeys = new Set(unrouted.keys());

  // pad positions per connectivity group (for unrouted detail + ratsnest)
  const pcbPortBySourcePort = new Map<string, CircuitElement>();
  const pcbPortById = new Map<string, CircuitElement>();
  for (const el of circuitJson) {
    if (el.type === "pcb_port" && el.source_port_id) {
      pcbPortBySourcePort.set(String(el.source_port_id), el);
    }
    if (el.type === "pcb_port" && el.pcb_port_id) pcbPortById.set(String(el.pcb_port_id), el);
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
      /*
       * The pads still waiting for copper, when the group is half routed:
       * pointing at all of them would send whoever reads it to pads that are
       * already connected.
       */
      const inAttesa: Point[] = [];
      for (const id of unrouted.get(key) ?? []) {
        const port = pcbPortById.get(id);
        const x = num(port?.x);
        const y = num(port?.y);
        if (!port || x === null || y === null) continue;
        const layers = (port.layers as string[] | undefined) ?? [];
        inAttesa.push({ x, y, layer: layers[0] ?? null });
      }
      unroutedDetail.push({
        name: info.label,
        nets: [...info.nets].slice(0, 4),
        points: (inAttesa.length > 0 ? inAttesa : info.points).slice(0, 8).map((p) => ({
          x: round2(p.x),
          y: round2(p.y),
          layer: p.layer,
        })),
      });
    }
    if (unroutedConnections.length >= 40) break;
  }
  // the list above stops at 40: these are the true counts, for the score and the message
  const connectionGroups = groupInfo.size;
  let unroutedTotal = 0;
  for (const info of groupInfo.values()) if (!info.routed) unroutedTotal++;

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
  // what does not depend on the rules is measured in this run and read by the ones of the fab classes below
  const misure: MisureDrc = {};
  const drcViolations = runDrcChecks(circuitJson, projectRules.rules, misure);
  /*
   * Pour against pour, which nothing measured: a ground pour overlapping a
   * strip of another net went through with zero errors (see pour-pour.ts).
   * Listed with the DRC, and said apart because the export refuses it.
   */
  const coppieDiColate = colateTroppoVicine(circuitJson, projectRules.rules.pourClearanceMm ?? projectRules.rules.minClearanceMm);
  const poursTooClose = colateCheSiToccano(circuitJson, projectRules.rules.pourClearanceMm ?? projectRules.rules.minClearanceMm);
  if (coppieDiColate.length > 0) {
    const prima = coppieDiColate[0];
    drcViolations.push({
      rule: "pour_pour_clearance",
      message:
        `${coppieDiColate.length > 1 ? `${coppieDiColate.length}x pour_pour_clearance: ` : ""}` +
        `${prima.a} (${prima.reteA}) <-> ${prima.b} (${prima.reteB}) on ${prima.layer}: ` +
        `${prima.distanzaMm.toFixed(3)}mm < min ${prima.minimoMm}mm${prima.distanzaMm === 0 ? " (the pours touch: a short)" : ""}` +
        `${coppieDiColate.length > 1 ? ` (and ${coppieDiColate.length - 1} more)` : ""}`,
      points: coppieDiColate.slice(0, 200).map((c) => ({ x: c.x, y: c.y })),
      count: coppieDiColate.length,
    });
  }
  // the silkscreen, which nothing measured: a warning kept apart from the DRC (see silkscreen-clearance.ts)
  const silkscreen = serigrafiaInConflitto(circuitJson, distanzaDellaSerigrafia(projectRules.rules));
  const prcViolations = runPrcChecks(circuitJson);
  /*
   * LE LUNGHEZZE APPAIATE, quando il progetto ne porta i gruppi: un bus arriva
   * in fase solo se i suoi fili sono lunghi uguale, e il file lo scrive. E' il
   * primo controllo che guarda se la scheda FUNZIONA e non se si fabbrica, per
   * questo sta con gli altri elettrici. Vedi lunghezze.ts, comprese le due
   * attenzioni: i pezzi di un net tie sono un filo solo, e la nostra misura e'
   * il rame della rete, non il percorso fra due pin.
   */
  for (const e of controllaLunghezze(circuitJson, leggiGruppi(sources[LUNGHEZZE_PATH]))) {
    if (e.dentro) continue;
    const elenco = e.misure
      .map((m) => `${m.net} ${m.lunghezzaMm}mm`)
      .join(", ");
    // a net that cannot be measured is said by name: see lunghezze.ts
    const assenti = e.mancanti.filter((m) => m.motivo === "assente").map((m) => m.net);
    const senzaRame = e.mancanti.filter((m) => m.motivo === "senza_rame").map((m) => m.net);
    const mancano = [
      assenti.length ? `non esistono sulla scheda (nome sbagliato?): ${assenti.join(", ")}` : "",
      senzaRame.length ? `non hanno ancora rame: ${senzaRame.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("; ");
    prcViolations.push({
      rule: "matched_length",
      severity: "warn",
      message: mancano
        ? `il gruppo ${e.gruppo} non si puo' appaiare, alcune reti non si misurano: ${mancano}${elenco ? ` (misurate: ${elenco})` : ""}`
        : `il gruppo ${e.gruppo} vuole le reti lunghe uguale entro ${e.tolleranzaMm}mm e ne ballano ${e.scartoMm}mm (misurato sul rame di ogni rete, non sul percorso fra i due pin come fa Altium): ${elenco}`,
    });
  }
  /*
   * A part whose pads reach the stencil with no opening is a part that is not
   * soldered: said here, by name, because nothing else on the board shows it
   * (see padSenzaPasta in solder-paste.ts).
   */
  for (const p of padSenzaPasta(circuitJson, leggiStencil(sources).stencil)) {
    prcViolations.push({
      rule: "paste_missing",
      severity: "fail",
      message: `${p.nome}: ${p.pad} ${p.pad === 1 ? "piazzola" : "piazzole"} senza apertura nella lamina della pasta, il pezzo non si salda li'. Le aperture del suo datasheet vanno scritte in ${STENCIL_PATH}`,
      ...(p.x !== null && p.y !== null ? { x: p.x, y: p.y } : {}),
    });
  }
  // multi-ruleset: the main DRC already covers the ruleset CHOSEN by the
  // project, which is no longer necessarily the first in the list
  const fabClasses = FAB_RULESETS.map((rs) => {
    const violations =
      rs.key === projectRules.preset
        ? drcViolations.length
        : // what a fab can make: the distance a pour declares for itself is the designer's, not the fab's
          runDrcChecks(circuitJson, rs.rules, misure, { distanzeProprieDelleColate: false }).length;
    return {
      key: rs.key,
      label: rs.label,
      costTier: rs.costTier,
      violations,
      ok: violations === 0,
    };
  }).sort((a, b) => a.costTier - b.costTier);
  /*
   * A project that writes its own rules (a different fab, e.g. Eurocircuits
   * with 0.15mm drills) is checked against them by the main DRC: when that is
   * clean, the board satisfies the class it was drawn for. Before, only the
   * three built-in classes counted, so such a board read "NO RULESET
   * SATISFIED (redesign needed)" with a clean DRC and could never be green.
   */
  if (projectRules.isCustom) {
    fabClasses.unshift({
      key: "custom",
      label: projectRules.label,
      costTier: 0,
      violations: drcViolations.length,
      ok: drcViolations.length === 0,
    });
  }
  const fabClass = fabClasses.find((f) => f.ok)?.label ?? null;
  const congestion = computeCongestion(circuitJson);
  const ratsnest = computeRatsnest(groupInfo);
  const footprintProvenance = analyzeFootprints(circuitJson, sources);
  const erc = runErcChecks(circuitJson);
  const placement = analyzePlacement(circuitJson, projectRules.rules);

  // the vias a plane of another net covers, from what the DRC runs above measured: see pianiSopraLeVie
  const planesOverVias = pianiSopraLeVie(circuitJson, misure);

  /*
   * The clearances the pours keep, and what was wrong in the ones declared:
   * in the message only when a pour keeps one of its own or a declaration had
   * to be corrected, so a board that declares nothing reads as it always did.
   */
  const regolaColate = projectRules.rules.pourClearanceMm ?? projectRules.rules.minClearanceMm;
  const distanzeColate = distanzeDelleColate(circuitJson, regolaColate);
  const avvisiColate = distanzeDichiarate(sources, projectRules.rules.minClearanceMm).avvisi;
  const pourClearances: CompileSummary["pourClearances"] =
    distanzeColate.length || avvisiColate.length
      ? {
          regolaMm: regolaColate,
          distanze: distanzeColate,
          testo: descriviDistanze(distanzeColate),
          ...(avvisiColate.length ? { avvisi: avvisiColate } : {}),
        }
      : undefined;
  const colateProprie = distanzeColate.some((d) => !d.regola) ? ` Colate: ${descriviDistanze(distanzeColate)}.` : "";
  const colateCorrette = avvisiColate.length ? ` ATTENZIONE <copperpour>: ${avvisiColate.join("; ")}.` : "";

  return {
    unroutedConnections,
    unroutedTotal,
    connectionGroups,
    unroutedDetail,
    sourceTraces,
    pcbTraces,
    stats,
    totalTraceLengthMm,
    projectRules,
    drcViolations,
    poursTooClose,
    silkscreen,
    prcViolations,
    fabClasses,
    fabClass,
    congestion,
    ratsnest,
    footprintProvenance,
    erc,
    placement,
    planesOverVias,
    pourClearances,
    messaggioColate: colateProprie + colateCorrette,
  };
}

/**
 * The summary of a compiled circuit. `scheda`: the checks of the same board
 * already measured without its schematic (see ControlliDellaScheda): only
 * what reads the schematic is computed here, so the result is the one a full
 * run gives on the same circuit. The summary holds its lists as they are: a
 * caller reusing them passes its own copy.
 */
function summarize(
  circuitJson: CircuitElement[],
  sources: FsMap = {},
  scheda: ControlliDellaScheda = controlliDellaScheda(circuitJson, sources),
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

  const traceLabel = (el: CircuitElement) =>
    String(el.display_name ?? el.source_trace_id ?? "trace");
  const connections = circuitJson.filter((el) => el.type === "source_trace").map(traceLabel).slice(0, 40);

  const {
    unroutedConnections,
    unroutedTotal,
    connectionGroups,
    unroutedDetail,
    sourceTraces,
    pcbTraces,
    stats,
    totalTraceLengthMm,
    projectRules,
    drcViolations,
    poursTooClose,
    silkscreen,
    prcViolations,
    fabClasses,
    fabClass,
    congestion,
    ratsnest,
    footprintProvenance,
    erc,
    placement,
    planesOverVias,
    pourClearances,
  } = scheda;
  const schematicQuality = analyzeSchematic(circuitJson, sources);

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
    unrouted: unroutedTotal,
    drcViolations: drcViolations.length,
    prcViolations: prcTotal(prcViolations),
    schematicOverlaps:
      schematicQuality.symbolOverlapCount + schematicQuality.labelOverlapCount,
    fabClass,
    allGreen:
      reportedErrors.length === 0 &&
      unroutedConnections.length === 0 &&
      drcViolations.length === 0 &&
      prcTotal(prcViolations) === 0 &&
      schematicQuality.symbolOverlapCount + schematicQuality.labelOverlapCount === 0 &&
      fabClass !== null,
  };
  const message = ok
    ? `Compile OK: ${components.length} components, ${nets.length} nets, ` +
      `${pcbTraces} routed pcb traces (${sourceTraces} source traces` +
      `${unroutedTotal ? `, ${unroutedTotal} UNROUTED` : ""})` +
      `, ${stats.vias} vias, ${round1(totalTraceLengthMm)}mm routed` +
      `${ratsnest.estimatedCrossings ? `, ~${ratsnest.estimatedCrossings} ratsnest crossings` : ""}` +
      `${drcViolations.length ? ` - ${drcViolations.length} DRC violation(s)` : " - DRC clean"}` +
      `${prcViolations.length ? ` - ${prcTotal(prcViolations)} electrical issue(s)` : ""}` +
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
  // a rules file that had to be corrected is said where the agent reads first
  const regoleCorrette = projectRules.warnings?.length
    ? ` ATTENZIONE ${DESIGN_RULES_PATH}: ${projectRules.warnings.join("; ")}.`
    : "";

  return {
    ok,
    errors: reportedErrors,
    components,
    nets,
    connections,
    unroutedConnections,
    unroutedTotal,
    connectionGroups,
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
      ...(projectRules.warnings?.length ? { warnings: projectRules.warnings } : {}),
    },
    // compileProject fills this in, being the only one that knows how long everything took
    profile: { spans: [], totalMs: 0 },
    footprintProvenance,
    targets,
    ...(planesOverVias ? { planesOverVias } : {}),
    ...(poursTooClose ? { poursTooClose } : {}),
    ...(silkscreen ? { silkscreen } : {}),
    ...(pourClearances ? { pourClearances } : {}),
    routingAttempts: 1,
    router: "default",
    message: message + regoleCorrette + scheda.messaggioColate + testoSerigrafia(silkscreen),
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
    } else if (el.type === "pcb_plated_hole") {
      // the copper as its shape declares it, pills and square pads included
      const forma = rameDelForo(el);
      if (!forma) continue;
      const b = ingombroForma(forma);
      addBox(b.minX, b.minY, b.maxX, b.maxY);
    } else if (el.type === "pcb_via") {
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
