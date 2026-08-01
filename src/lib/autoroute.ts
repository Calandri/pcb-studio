import { DEFAULT_DESIGN_RULES, type DesignRules } from "./design-rules";
import { runDrcChecks } from "./drc";
import {
  computeUnroutedGroupKeys,
  scoreCircuit,
  type CircuitScore,
} from "./route-score";
import {
  nudgeCrowdedVias,
  snapTo45,
  straightenPinEscapes,
  widenThinTraces,
} from "./house-rules";
import { SOLVERS, type CircuitElement, type VariantDef } from "./variants";
import { rerouteZone, zonesFromProblems, type ProblemPoint, type Zone } from "./rip-up";
import { renderPcbPng, reviewLayout, type VisualReview } from "./vision-review";

/**
 * Round-based routing, with memory of what is not working.
 *
 * A normal autorouter makes one pass and delivers. Here instead the result is
 * measured, we figure out WHERE the problems are, only that part is ripped up
 * and redone with a different solver — and the new result is kept only if the
 * score improves. The loop stops when the board is clean or when two rounds
 * in a row change nothing.
 *
 * The measurements driving the loop are of three different kinds, and that is
 * the point: manufacturability checks (DRC) find rule violations, open
 * connections find what is missing, and a model that LOOKS at the drawing
 * finds what no rule can express — pointless detours, via clusters, wasted
 * areas. All three end up in the same list of zones to redo.
 *
 * The actual routing engine is still tscircuit's: here we decide WHAT to redo
 * and WITH WHAT, which is where the win is.
 */

export interface RouteRound {
  round: number;
  /** zones redone in this round */
  targets: string[];
  /** why they had to be redone */
  reasons: string[];
  score: CircuitScore;
  improved: boolean;
}

export interface RouteReport {
  rounds: RouteRound[];
  initialScore: CircuitScore;
  finalScore: CircuitScore;
  stoppedBecause:
    | "pulita"
    | "non migliora piu'"
    | "giri esauriti"
    | "niente da rifare"
    | "tempo scaduto";
  /** what the model saw looking at the drawing, if enabled */
  vision?: VisualReview;
}

export interface RouteOptions {
  maxRounds?: number;
  rules?: DesignRules;
  /** use a vision model to find what the rules cannot see */
  useVision?: boolean;
  /** maximum number of zones to redo in one round */
  maxZonesPerRound?: number;
  /** time cap for the entire loop (default 3 minutes) */
  budgetMs?: number;
  /**
   * Called at the end of each round with the updated drawing: it is what lets
   * the viewer watch the board change as it works, instead of staring at a
   * timer for eight minutes.
   */
  onRound?: (round: RouteRound & { circuitJson: CircuitElement[] }) => void;
  /**
   * Route even zones with no copper to rip: an open connection sits in an
   * empty area by definition, and without this the "close the missing" mode
   * would skip exactly what it is meant to close.
   */
  routeEvenWithoutRip?: boolean;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * The winner: fewer errors, then fewer opens, then fewer rule violations, and
 * last the COPPER THAT COSTS — length plus the signal vias priced in
 * millimetres.
 *
 * Before, vias came before length as their own tier: one via more always lost,
 * however much copper it saved. Two opposite mistakes, the same shape — treating
 * two costs as if one were infinite. They are traded instead: a via is worth
 * `viaCostMm` millimetres of trace (five by default), so a route that saves a
 * hole by going three millimetres further round wins, and one that saves twenty
 * millimetres with one more hole wins too. See DesignRules.viaCostMm
 */
function better(a: CircuitScore, b: CircuitScore): boolean {
  if (a.errors !== b.errors) return a.errors < b.errors;
  if (a.unrouted !== b.unrouted) return a.unrouted < b.unrouted;
  if (a.drc !== b.drc) return a.drc < b.drc;
  return a.copperCostMm < b.copperCostMm - 0.01;
}

const isClean = (s: CircuitScore): boolean =>
  s.errors === 0 && s.unrouted === 0 && s.drc === 0;

/**
 * Where the problems are, in coordinates. A problem without coordinates does
 * not help decide where to intervene: only what can be located is kept.
 */
function findProblems(
  circuitJson: CircuitElement[],
  vision: VisualReview | null,
  rules: DesignRules = DEFAULT_DESIGN_RULES,
): ProblemPoint[] {
  const points: ProblemPoint[] = [];

  // the project rules, not the default ones: the zones to redo must be the
  // ones the project DRC rejects, not those of another fab
  for (const violation of runDrcChecks(circuitJson, rules)) {
    for (const point of violation.points ?? []) {
      points.push({ x: point.x, y: point.y, reason: violation.rule });
    }
  }

  // open connections: the exposed pads tell where the copper is missing
  if (computeUnroutedGroupKeys(circuitJson).size > 0) {
    for (const el of circuitJson) {
      if (el.type !== "pcb_port") continue;
      const x = num(el.x);
      const y = num(el.y);
      if (x !== null && y !== null) {
        points.push({ x, y, reason: "collegamento aperto" });
      }
    }
  }

  for (const issue of vision?.issues ?? []) {
    if (issue.severity === "info") continue;
    if (typeof issue.x !== "number" || typeof issue.y !== "number") continue;
    points.push({ x: issue.x, y: issue.y, reason: `vista: ${issue.area}` });
  }

  return points;
}

/**
 * The candidates to try at round N. Each round must attempt something
 * DIFFERENT, otherwise it repeats identically (the solvers are deterministic)
 * and the loop shuts down on the second round no matter how many rounds are
 * allowed. Here the effort increases and the two solvers alternate: quick
 * attempts first, then long ones.
 */
function defsForRound(round: number): VariantDef[] {
  // the effort stops at 10: beyond that, one round on the whole board costs
  // minutes and the loop never ends. More short rounds beat one very long one.
  const efforts = [1, 5, 10, 5, 10];
  const effort = efforts[Math.min(round - 1, efforts.length - 1)];
  const harder = efforts[Math.min(round, efforts.length - 1)];
  return [
    { solver: "v6", SolverClass: SOLVERS.v6, effort },
    { solver: "v3", SolverClass: SOLVERS.v3, effort },
    { solver: "v6", SolverClass: SOLVERS.v6, effort: harder },
  ];
}

/**
 * Routes the board in rounds as long as it improves. It does not touch
 * placement: that is the agent's job — it reads the report and moves the
 * components.
 */
export async function routeBoard(
  circuitJson: CircuitElement[],
  opts: RouteOptions = {},
): Promise<{ circuitJson: CircuitElement[]; report: RouteReport }> {
  // the loop does not stop because it ran out of rounds: it stops when the
  // board is clean, when two rounds in a row do not improve, or when time
  // runs out. Counting rounds was an arbitrary brake: it would exit with
  // "giri esauriti" while there was still ground to cover.
  const maxRounds = Math.max(1, Math.min(opts.maxRounds ?? 12, 40));
  const rules = opts.rules ?? DEFAULT_DESIGN_RULES;
  const maxZones = Math.max(1, Math.min(opts.maxZonesPerRound ?? 6, 12));
  // the loop has a time cap: it runs inside a compilation, and a compilation
  // that never returns is worse than an imperfect route
  const budgetMs = Math.max(20_000, opts.budgetMs ?? 240_000);
  const startedAt = Date.now();

  let current = circuitJson;
  let score = scoreCircuit(current, rules);
  const report: RouteReport = {
    rounds: [],
    initialScore: score,
    finalScore: score,
    stoppedBecause: "giri esauriti",
  };

  // a look at the drawing before starting: what it finds joins the problems
  // to solve alongside the rule violations
  let vision: VisualReview | null = null;
  if (opts.useVision) {
    try {
      vision = await reviewLayout(renderPcbPng(current as never));
      report.vision = vision;
    } catch {
      // without the eye we proceed anyway: it is a help, not a requirement
    }
  }

  let stale = 0;
  for (let round = 1; round <= maxRounds; round++) {
    if (isClean(score)) {
      report.stoppedBecause = "pulita";
      break;
    }
    if (Date.now() - startedAt > budgetMs) {
      report.stoppedBecause = "tempo scaduto";
      break;
    }

    const problems = findProblems(current, vision, rules);
    const zones = zonesFromProblems(problems).slice(0, maxZones);
    if (zones.length === 0) {
      report.stoppedBecause = "niente da rifare";
      break;
    }

    let improvedThisRound = false;
    const done: string[] = [];
    const reasons = new Set<string>();
    const defs = defsForRound(round);

    for (const zone of zones) {
      if (Date.now() - startedAt > budgetMs) break;
      for (const reason of zone.reasons) reasons.add(reason);
      try {
        const attempt = rerouteZone(current, zone, defs, rules, {
          routeEvenWithoutRip: opts.routeEvenWithoutRip,
        });
        if (!attempt) continue;
        const attemptScore = scoreCircuit(attempt.circuitJson, rules);
        if (better(attemptScore, score)) {
          current = attempt.circuitJson;
          score = attemptScore;
          improvedThisRound = true;
          done.push(zoneLabel(zone));
        }
      } catch {
        // a zone that refuses to be redone does not stop the round
      }
    }

    const entry: RouteRound = {
      round,
      targets: done,
      reasons: [...reasons],
      score,
      improved: improvedThisRound,
    };
    report.rounds.push(entry);
    opts.onRound?.({ ...entry, circuitJson: current });

    if (!improvedThisRound) {
      stale += 1;
      // we give up only after trying the long attempts too
      if (stale >= 3) {
        report.stoppedBecause = "non migliora piu'";
        break;
      }
    } else {
      stale = 0;
    }
  }

  /*
   * The house rules apply to the final result, always — including the widths
   * and minimums of the CHOSEN SUPPLIER, which previously did not reach this
   * point: traces were widened to the default even on a project with its own
   * rules. And nudging crowded vias must be done here and not only downstream,
   * otherwise the loop's final score describes a route different from the one
   * that comes out.
   */
  current = snapTo45(
    straightenPinEscapes(
      widenThinTraces(
        nudgeCrowdedVias(current, rules.minClearanceMm),
        rules.minTraceWidthMm,
      ),
    ),
  );
  report.finalScore = scoreCircuit(current, rules);
  if (isClean(report.finalScore)) report.stoppedBecause = "pulita";
  return { circuitJson: current, report };
}

/** human-readable label for a zone: where it sits on the board, in mm */
function zoneLabel(zone: Zone): string {
  const cx = Math.round((zone.minX + zone.maxX) / 2);
  const cy = Math.round((zone.minY + zone.maxY) / 2);
  return `zona (${cx}, ${cy})`;
}
