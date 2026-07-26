import { DEFAULT_DESIGN_RULES, type DesignRules } from "./design-rules";
import { runDrcChecks } from "./drc";
import {
  computeUnroutedGroupKeys,
  scoreCircuit,
  type CircuitScore,
} from "./route-score";
import { straightenPinEscapes, widenThinTraces } from "./house-rules";
import {
  SOLVERS,
  assembleCircuit,
  findSections,
  generateSectionCandidates,
  spliceTraces,
  unrouteSections,
  type CircuitElement,
  type SectionInfo,
  type VariantDef,
} from "./variants";
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
  /** sezioni rifatte in questo giro */
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
  stoppedBecause: "pulita" | "non migliora piu'" | "giri esauriti" | "niente da rifare";
  /** cosa ha visto il modello guardando il disegno, se attivo */
  vision?: VisualReview;
}

export interface RouteOptions {
  maxRounds?: number;
  rules?: DesignRules;
  /** usa un modello vision per trovare quello che le regole non vedono */
  useVision?: boolean;
  /** candidati generati per ogni sezione da rifare (solver/sforzo diversi) */
  candidatesPerSection?: number;
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
 * Riquadro di ogni sezione, dalle posizioni dei suoi componenti: serve a dire
 * a quale sezione appartiene un problema di cui si conoscono le coordinate.
 */
function sectionBoxes(
  circuitJson: CircuitElement[],
  sections: SectionInfo[],
): Map<string, { minX: number; maxX: number; minY: number; maxY: number }> {
  const boxes = new Map<string, { minX: number; maxX: number; minY: number; maxY: number }>();
  for (const el of circuitJson) {
    if (el.type !== "pcb_component") continue;
    const sub = String(el.subcircuit_id ?? "");
    const section = sections.find((s) => s.subcircuitId === sub);
    if (!section) continue;
    const center = (el.center as { x?: number; y?: number } | undefined) ?? {};
    const x = num(center.x);
    const y = num(center.y);
    if (x === null || y === null) continue;
    const w = (num(el.width) ?? 0) / 2;
    const h = (num(el.height) ?? 0) / 2;
    const box = boxes.get(section.key) ?? {
      minX: Infinity,
      maxX: -Infinity,
      minY: Infinity,
      maxY: -Infinity,
    };
    box.minX = Math.min(box.minX, x - w);
    box.maxX = Math.max(box.maxX, x + w);
    box.minY = Math.min(box.minY, y - h);
    box.maxY = Math.max(box.maxY, y + h);
    boxes.set(section.key, box);
  }
  return boxes;
}

/** la sezione il cui riquadro contiene il punto, o la piu' vicina entro 6mm */
function sectionAt(
  boxes: Map<string, { minX: number; maxX: number; minY: number; maxY: number }>,
  x: number,
  y: number,
): string | null {
  let nearest: string | null = null;
  let nearestD = 6;
  for (const [key, b] of boxes) {
    const dx = Math.max(b.minX - x, x - b.maxX, 0);
    const dy = Math.max(b.minY - y, y - b.maxY, 0);
    const d = Math.hypot(dx, dy);
    if (d === 0) return key;
    if (d < nearestD) {
      nearestD = d;
      nearest = key;
    }
  }
  return nearest;
}

/**
 * Le zone da rifare, con il motivo. Un problema senza coordinate non aiuta a
 * scegliere: si tiene solo cio' che si sa localizzare.
 */
function findTargets(
  circuitJson: CircuitElement[],
  sections: SectionInfo[],
  vision: VisualReview | null,
): Map<string, Set<string>> {
  const boxes = sectionBoxes(circuitJson, sections);
  const targets = new Map<string, Set<string>>();
  const add = (key: string | null, reason: string) => {
    if (!key) return;
    const set = targets.get(key) ?? new Set<string>();
    set.add(reason);
    targets.set(key, set);
  };

  for (const violation of runDrcChecks(circuitJson)) {
    for (const point of violation.points ?? []) {
      add(sectionAt(boxes, point.x, point.y), violation.rule);
    }
  }

  // collegamenti aperti: il pad che resta scoperto dice dove intervenire
  const openGroups = computeUnroutedGroupKeys(circuitJson);
  if (openGroups.size > 0) {
    for (const el of circuitJson) {
      if (el.type !== "pcb_port") continue;
      const x = num(el.x);
      const y = num(el.y);
      if (x === null || y === null) continue;
      add(sectionAt(boxes, x, y), "collegamento aperto");
    }
  }

  for (const issue of vision?.issues ?? []) {
    if (issue.severity === "info") continue;
    if (typeof issue.x !== "number" || typeof issue.y !== "number") continue;
    add(sectionAt(boxes, issue.x, issue.y), `vista: ${issue.area}`);
  }

  return targets;
}

/**
 * I candidati da provare al giro N. Ogni giro deve tentare qualcosa di DIVERSO,
 * altrimenti ripete identico (i solver sono deterministici) e il ciclo si
 * spegne al secondo giro qualunque sia il numero di giri concesso. Qui lo
 * sforzo sale e i due solver si alternano: prima tentativi rapidi, poi lunghi.
 */
function defsForRound(round: number): VariantDef[] {
  const efforts = [1, 5, 10, 20, 40];
  const effort = efforts[Math.min(round - 1, efforts.length - 1)];
  const harder = efforts[Math.min(round, efforts.length - 1)];
  return [
    { solver: "v6", SolverClass: SOLVERS.v6, effort },
    { solver: "v3", SolverClass: SOLVERS.v3, effort },
    { solver: "v6", SolverClass: SOLVERS.v6, effort: harder },
  ];
}

/**
 * Rifa' UNA sezione: genera piu' candidati (solver e sforzi diversi), li giudica
 * col DRC come farebbero sulla scheda intera, e restituisce il migliore.
 */
function reroute(
  circuitJson: CircuitElement[],
  section: SectionInfo,
  rules: DesignRules,
  candidates: number,
  defs: VariantDef[],
): CircuitElement[] | null {
  const base = unrouteSections(circuitJson, new Set([section.subcircuitId]));
  const variants = generateSectionCandidates(
    base,
    section,
    candidates,
    rules,
    (traces) => {
      try {
        return runDrcChecks(spliceTraces(base, section.subcircuitId, traces, "loop")).reduce(
          (n, v) => n + Math.max(1, v.points?.length ?? 1),
          0,
        );
      } catch {
        return 0;
      }
    },
    defs,
  );
  const best = variants.candidates[variants.picked];
  if (!best) return null;
  return assembleCircuit(base, [{ section, candidate: best }]);
}

/**
 * Quando il progetto non dichiara blocchi funzionali (<group subcircuit>), si
 * lavora sulla scheda intera come fosse una sezione sola: il ciclo diventa meno
 * chirurgico — rifa' tutto invece della zona guasta — ma continua a mettere in
 * gara solver diversi e a tenere solo cio' che migliora. Dividere per sezioni
 * resta il modo giusto, ed e' per questo che sta nello stile di casa.
 */
function wholeBoardSection(circuitJson: CircuitElement[]): SectionInfo[] {
  const counts = new Map<string, number>();
  for (const el of circuitJson) {
    if (el.type !== "pcb_component") continue;
    const sub = String(el.subcircuit_id ?? "");
    if (sub) counts.set(sub, (counts.get(sub) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [sub, n] of counts) {
    if (n > bestN) {
      best = sub;
      bestN = n;
    }
  }
  return best ? [{ key: "scheda intera", name: "scheda intera", subcircuitId: best }] : [];
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
  const candidates = Math.max(1, Math.min(opts.candidatesPerSection ?? 3, 3));

  const sections = findSections(circuitJson).length
    ? findSections(circuitJson)
    : wholeBoardSection(circuitJson);
  let current = circuitJson;
  let score = scoreCircuit(current);
  const report: RouteReport = {
    rounds: [],
    initialScore: score,
    finalScore: score,
    stoppedBecause: "giri esauriti",
  };

  if (sections.length === 0) {
    report.stoppedBecause = "niente da rifare";
    return { circuitJson: current, report };
  }

  // uno sguardo al disegno prima di cominciare: quello che trova entra fra le
  // zone da rifare insieme alle violazioni di regola
  let vision: VisualReview | null = null;
  if (opts.useVision) {
    try {
      const png = renderPcbPng(current as never);
      vision = await reviewLayout(png);
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

    const targets = findTargets(current, sections, vision);
    if (targets.size === 0) {
      report.stoppedBecause = "niente da rifare";
      break;
    }

    let improvedThisRound = false;
    const done: string[] = [];
    const reasons = new Set<string>();

    for (const [key, why] of targets) {
      const section = sections.find((s) => s.key === key);
      if (!section) continue;
      for (const reason of why) reasons.add(reason);
      try {
        const attempt = reroute(current, section, rules, candidates, defsForRound(round));
        if (!attempt) continue;
        const attemptScore = scoreCircuit(attempt);
        if (better(attemptScore, score)) {
          current = attempt;
          score = attemptScore;
          improvedThisRound = true;
          done.push(key);
        }
      } catch {
        // una sezione che non si lascia rifare non ferma il giro
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
      // ci si arrende solo dopo aver esaurito anche gli sforzi piu' alti:
      // fermarsi al secondo giro uguale sprecherebbe i tentativi lunghi
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
