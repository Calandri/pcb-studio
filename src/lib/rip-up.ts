import { getSimpleRouteJsonFromCircuitJson } from "@tscircuit/core";
import { DEFAULT_DESIGN_RULES, type DesignRules } from "./design-rules";
import { runDrcChecks } from "./drc";
import { runSolver, spliceTraces, type CircuitElement, type VariantDef } from "./variants";

/**
 * Strappo per ZONA: si tolgono le piste che passano dentro un rettangolo e si
 * fa rifare solo quelle, lasciando intatto tutto il resto del rame.
 *
 * E' la differenza fra rammendare uno strappo e ritessere il maglione. Il
 * taglio per blocchi funzionali non bastava: su una scheda vera i collegamenti
 * interessanti attraversano i blocchi (dal microcontrollore ai periferici) e le
 * alimentazioni sono reti globali, quindi i blocchi restano quasi vuoti e i
 * problemi stanno nella dorsale, che nessun blocco contiene.
 *
 * Funziona perche' il costruttore del problema di routing di tscircuit, dato il
 * circuito con qualche pista in meno, chiede di instradare SOLO le connessioni
 * rimaste scoperte e tiene tutto il rame superstite come ostacolo. Verificato
 * su bat-bs: scheda intera 9 connessioni da fare, dopo lo strappo di una zona
 * 20, con 384 ostacoli ancora in piedi.
 *
 * Il costruttore pero' il problema lo fa sempre grande quanto la scheda: stessi
 * confini, stessi 384 ostacoli. Cosi' uno sbroglio "locale" costava quasi
 * quanto rifare tutto (misurato: 357 secondi per due giri, zero guadagno). Per
 * questo il problema viene RITAGLIATO sulla zona prima di darlo al solver:
 * confini al rettangolo, ostacoli solo quelli che lo toccano, connessioni solo
 * quelle che ci stanno dentro tutte intere.
 *
 * Da qui la regola dello strappo: si tolgono solo le piste INTERAMENTE
 * contenute nella zona. Una pista che entra ed esce avrebbe un capo fuori dal
 * ritaglio, e il router non saprebbe piu' dove attaccarlo.
 */

export interface Zone {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  /** quanti problemi cadono qui dentro: serve a decidere da dove cominciare */
  problems: number;
  reasons: string[];
}

export interface ProblemPoint {
  x: number;
  y: number;
  reason: string;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * Raggruppa i problemi vicini in zone. Punti a meno di `gap` finiscono nella
 * stessa zona: rifare due volte la stessa area sarebbe tempo sprecato, e una
 * zona che le contiene entrambe da' anche al router lo spazio per spostarsi.
 */
export function zonesFromProblems(
  points: ProblemPoint[],
  gap = 2.5,
  margin = 2,
  maxSide = 16,
): Zone[] {
  const zones: Zone[] = [];
  for (const p of points) {
    const near = zones.find(
      (z) =>
        p.x >= z.minX - gap &&
        p.x <= z.maxX + gap &&
        p.y >= z.minY - gap &&
        p.y <= z.maxY + gap,
    );
    // una zona non puo' crescere oltre maxSide: se ingrandendola si sfonda il
    // limite si apre una zona nuova, altrimenti tutti i problemi si fondono in
    // un unico rettangolo grande quanto la scheda e il ritaglio non serve piu'
    const wouldFit =
      near &&
      Math.max(near.maxX, p.x + margin) - Math.min(near.minX, p.x - margin) <= maxSide &&
      Math.max(near.maxY, p.y + margin) - Math.min(near.minY, p.y - margin) <= maxSide;
    if (near && wouldFit) {
      near.minX = Math.min(near.minX, p.x - margin);
      near.maxX = Math.max(near.maxX, p.x + margin);
      near.minY = Math.min(near.minY, p.y - margin);
      near.maxY = Math.max(near.maxY, p.y + margin);
      near.problems += 1;
      if (!near.reasons.includes(p.reason)) near.reasons.push(p.reason);
      continue;
    }
    zones.push({
      minX: p.x - margin,
      maxX: p.x + margin,
      minY: p.y - margin,
      maxY: p.y + margin,
      problems: 1,
      reasons: [p.reason],
    });
  }
  return zones.sort((a, b) => b.problems - a.problems);
}

const inZone = (zone: Zone, x: number | null, y: number | null): boolean =>
  x !== null &&
  y !== null &&
  x >= zone.minX &&
  x <= zone.maxX &&
  y >= zone.minY &&
  y <= zone.maxY;

/**
 * Il circuito senza le piste che stanno TUTTE dentro la zona (e senza le loro
 * via). Le piste che entrano ed escono restano dove sono: strapparle
 * lascerebbe un capo fuori dal ritaglio, e il router non saprebbe dove
 * riattaccarlo.
 */
export function ripZone(circuitJson: CircuitElement[], zone: Zone): CircuitElement[] {
  return circuitJson.filter((el) => {
    if (el.type === "pcb_via") return !inZone(zone, num(el.x), num(el.y));
    if (el.type !== "pcb_trace") return true;
    const route = (el.route as Array<Record<string, unknown>> | undefined) ?? [];
    if (route.length === 0) return true;
    return !route.every((p) => inZone(zone, num(p.x), num(p.y)));
  });
}

interface RouteProblem {
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  obstacles: Array<{
    center: { x: number; y: number };
    width: number;
    height: number;
  }>;
  connections: Array<{ pointsToConnect: Array<{ x: number; y: number }> }>;
  [key: string]: unknown;
}

/**
 * Il problema ritagliato sulla zona: e' questo a far scendere il costo da
 * minuti a secondi. Si tengono gli ostacoli che TOCCANO il rettangolo (non solo
 * quelli dentro: il rame sul bordo va evitato lo stesso) e le connessioni che
 * ci stanno dentro per intero.
 */
export function cropToZone(problem: RouteProblem, zone: Zone, margin = 1.5): RouteProblem {
  const box = {
    minX: zone.minX - margin,
    maxX: zone.maxX + margin,
    minY: zone.minY - margin,
    maxY: zone.maxY + margin,
  };
  const touches = (o: { center: { x: number; y: number }; width: number; height: number }) =>
    o.center.x + o.width / 2 >= box.minX &&
    o.center.x - o.width / 2 <= box.maxX &&
    o.center.y + o.height / 2 >= box.minY &&
    o.center.y - o.height / 2 <= box.maxY;

  const inside = (p: { x: number; y: number }) =>
    p.x >= box.minX && p.x <= box.maxX && p.y >= box.minY && p.y <= box.maxY;

  /*
   * Le connessioni si POTANO, non si scartano. Una rete come GND tocca decine
   * di piazzole sparse su tutta la scheda: pretendere che ci stiano tutte nel
   * rettangolo voleva dire buttare via ogni connessione e non avere piu' nulla
   * da instradare. Si tengono i punti dentro il ritaglio; al resto della rete ci
   * pensa il rame che non e' stato strappato.
   */
  const connections = problem.connections
    .map((c) => ({ ...c, pointsToConnect: (c.pointsToConnect ?? []).filter(inside) }))
    .filter((c) => c.pointsToConnect.length >= 2);

  return {
    ...problem,
    bounds: box,
    obstacles: problem.obstacles.filter(touches),
    connections,
  };
}

/**
 * Rifa' il rame di UNA zona. Prova piu' solver, giudica ciascuno col DRC sulla
 * scheda intera — non sulla sola zona, perche' una pista che nasce qui puo'
 * andare a sbattere altrove — e restituisce il migliore.
 */
export function rerouteZone(
  circuitJson: CircuitElement[],
  zone: Zone,
  defs: VariantDef[],
  rules: DesignRules = DEFAULT_DESIGN_RULES,
): { circuitJson: CircuitElement[]; drc: number } | null {
  const base = ripZone(circuitJson, zone);
  if (base.length === circuitJson.length) return null; // niente da strappare

  let srj: RouteProblem;
  try {
    const built = getSimpleRouteJsonFromCircuitJson({
      circuitJson: base as never,
      /*
       * Al problema ritagliato si passa SOLO la larghezza minima delle piste.
       * Imporre anche le misure delle via (0,3 e 0,6mm) rendeva la ricerca
       * cosi' stretta che il solver esauriva i suoi 200.000 passi senza
       * concludere: "Cannot get output before solving is complete", e tutto il
       * lavoro finiva nel cestino. Non serve imporle qui: le via vengono scritte
       * alla misura di fabbrica quando si ricuce il risultato, e se a quella
       * misura non ci stanno e' il DRC a dirlo e il candidato perde.
       */
      minTraceWidth: rules.minTraceWidthMm,
    } as never) as { simpleRouteJson: RouteProblem };
    // il ritaglio e' la differenza fra minuti e secondi
    srj = cropToZone(built.simpleRouteJson, zone);
  } catch {
    return null;
  }
  if (srj.connections.length === 0) return null;

  let best: { circuitJson: CircuitElement[]; drc: number } | null = null;
  for (const def of defs) {
    try {
      const traces = runSolver(def.SolverClass, srj, def.effort);
      if (traces.length === 0) continue;
      const spliced = spliceTraces(
        base,
        `zone_${Math.round(zone.minX)}_${Math.round(zone.minY)}`,
        traces,
        `z${Math.round(zone.minX)}x${Math.round(zone.minY)}_${def.solver}${def.effort}`,
        rules,
      );
      const drc = runDrcChecks(spliced).reduce(
        (n, v) => n + Math.max(1, v.points?.length ?? 1),
        0,
      );
      if (!best || drc < best.drc) best = { circuitJson: spliced, drc };
    } catch {
      // un solver che non ce la fa non toglie niente agli altri
    }
  }
  return best;
}
