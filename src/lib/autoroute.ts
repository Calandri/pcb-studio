import { DEFAULT_DESIGN_RULES, type DesignRules } from "./design-rules";
import { runDrcChecks } from "./drc";
import {
  computeUnroutedGroupKeys,
  scoreCircuit,
  type CircuitScore,
} from "./route-score";
import { straightenPinEscapes, widenThinTraces } from "./house-rules";
import { SOLVERS, type CircuitElement, type VariantDef } from "./variants";
import { rerouteZone, zonesFromProblems, type ProblemPoint, type Zone } from "./rip-up";
import { renderPcbPng, reviewLayout, type VisualReview } from "./vision-review";

/**
 * Sbroglio a giri, con memoria di quello che non va.
 *
 * Un autorouter normale fa una passata e consegna. Qui invece si misura il
 * risultato, si capisce DOVE sono i problemi, si strappa solo quella parte e la
 * si rifà con un solver diverso — e si tiene il nuovo risultato solo se il
 * punteggio migliora. Il ciclo si ferma quando la scheda e' pulita o quando due
 * giri di fila non cambiano niente.
 *
 * Le misure che guidano il ciclo sono di tre nature diverse, ed e' questo il
 * punto: i controlli di fabbricabilita' (DRC) trovano le violazioni di regola,
 * i collegamenti aperti trovano quello che manca, e un modello che GUARDA il
 * disegno trova quello che nessuna regola sa esprimere — giri inutili, grappoli
 * di via, aree sprecate. Tutte e tre finiscono nella stessa lista di zone da
 * rifare.
 *
 * Il motore di sbroglio vero e proprio resta quello di tscircuit: qui si
 * decide COSA rifare e CON COSA, che e' dove si vince.
 */

export interface RouteRound {
  round: number;
  /** zone rifatte in questo giro */
  targets: string[];
  /** perche' erano da rifare */
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
  /** cosa ha visto il modello guardando il disegno, se attivo */
  vision?: VisualReview;
}

export interface RouteOptions {
  maxRounds?: number;
  rules?: DesignRules;
  /** usa un modello vision per trovare quello che le regole non vedono */
  useVision?: boolean;
  /** quante zone rifare al massimo in un giro */
  maxZonesPerRound?: number;
  /** tetto di tempo per l'intero ciclo (default 3 minuti) */
  budgetMs?: number;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** vince chi ha meno errori, poi meno aperti, poi meno DRC, poi meno via, poi meno rame */
function better(a: CircuitScore, b: CircuitScore): boolean {
  if (a.errors !== b.errors) return a.errors < b.errors;
  if (a.unrouted !== b.unrouted) return a.unrouted < b.unrouted;
  if (a.drc !== b.drc) return a.drc < b.drc;
  if (a.vias !== b.vias) return a.vias < b.vias;
  return a.lengthMm < b.lengthMm - 0.01;
}

const isClean = (s: CircuitScore): boolean =>
  s.errors === 0 && s.unrouted === 0 && s.drc === 0;

/**
 * Dove sono i problemi, in coordinate. Un problema senza coordinate non aiuta a
 * decidere dove intervenire: si tiene solo cio' che si sa localizzare.
 */
function findProblems(
  circuitJson: CircuitElement[],
  vision: VisualReview | null,
): ProblemPoint[] {
  const points: ProblemPoint[] = [];

  for (const violation of runDrcChecks(circuitJson)) {
    for (const point of violation.points ?? []) {
      points.push({ x: point.x, y: point.y, reason: violation.rule });
    }
  }

  // collegamenti aperti: i pad scoperti dicono dove manca il rame
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
 * I candidati da provare al giro N. Ogni giro deve tentare qualcosa di DIVERSO,
 * altrimenti ripete identico (i solver sono deterministici) e il ciclo si
 * spegne al secondo giro qualunque sia il numero di giri concesso. Qui lo
 * sforzo sale e i due solver si alternano: prima tentativi rapidi, poi lunghi.
 */
function defsForRound(round: number): VariantDef[] {
  // lo sforzo si ferma a 10: oltre, un giro sulla scheda intera costa minuti e
  // il ciclo non finisce piu'. Meglio piu' giri corti che uno lunghissimo.
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
 * Sbroglia la scheda a giri finche' migliora. Non tocca il piazzamento: quello
 * e' compito dell'agente, che legge il rapporto e sposta i componenti.
 */
export async function routeBoard(
  circuitJson: CircuitElement[],
  opts: RouteOptions = {},
): Promise<{ circuitJson: CircuitElement[]; report: RouteReport }> {
  const maxRounds = Math.max(1, Math.min(opts.maxRounds ?? 3, 12));
  const rules = opts.rules ?? DEFAULT_DESIGN_RULES;
  const maxZones = Math.max(1, Math.min(opts.maxZonesPerRound ?? 3, 8));
  // il ciclo ha un tetto di tempo: gira dentro una compilazione, e una
  // compilazione che non torna e' peggio di una rotta imperfetta
  const budgetMs = Math.max(20_000, opts.budgetMs ?? 180_000);
  const startedAt = Date.now();

  let current = circuitJson;
  let score = scoreCircuit(current);
  const report: RouteReport = {
    rounds: [],
    initialScore: score,
    finalScore: score,
    stoppedBecause: "giri esauriti",
  };

  // uno sguardo al disegno prima di cominciare: quello che trova entra fra i
  // problemi da risolvere insieme alle violazioni di regola
  let vision: VisualReview | null = null;
  if (opts.useVision) {
    try {
      vision = await reviewLayout(renderPcbPng(current as never));
      report.vision = vision;
    } catch {
      // senza occhio si procede lo stesso: e' un aiuto, non un requisito
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

    const problems = findProblems(current, vision);
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
        const attempt = rerouteZone(current, zone, defs, rules);
        if (!attempt) continue;
        const attemptScore = scoreCircuit(attempt.circuitJson);
        if (better(attemptScore, score)) {
          current = attempt.circuitJson;
          score = attemptScore;
          improvedThisRound = true;
          done.push(zoneLabel(zone));
        }
      } catch {
        // una zona che non si lascia rifare non ferma il giro
      }
    }

    report.rounds.push({
      round,
      targets: done,
      reasons: [...reasons],
      score,
      improved: improvedThisRound,
    });

    if (!improvedThisRound) {
      stale += 1;
      // ci si arrende solo dopo aver provato anche i tentativi lunghi
      if (stale >= 3 && round >= 5) {
        report.stoppedBecause = "non migliora piu'";
        break;
      }
    } else {
      stale = 0;
    }
  }

  // le regole di casa valgono sul risultato finale, sempre
  current = straightenPinEscapes(widenThinTraces(current));
  report.finalScore = scoreCircuit(current);
  if (isClean(report.finalScore)) report.stoppedBecause = "pulita";
  return { circuitJson: current, report };
}

/** etichetta leggibile di una zona: dove si trova sulla scheda, in mm */
function zoneLabel(zone: Zone): string {
  const cx = Math.round((zone.minX + zone.maxX) / 2);
  const cy = Math.round((zone.minY + zone.maxY) / 2);
  return `zona (${cx}, ${cy})`;
}
