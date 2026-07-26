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
 * LIMITE NOTO, misurato: strappare una zona riduce le CONNESSIONI da rifare ma
 * NON il problema. Il costruttore costruisce sempre il problema della scheda
 * intera — stessi 384 ostacoli, stessi confini — quindi un giro per zona costa
 * quasi quanto rifare tutto, e tre zone per tre solver diventano nove sbrogli
 * completi. Su bat-bs: 357 secondi, due giri, zero guadagno.
 *
 * La strada per renderlo utile e' ritagliare il problema sulla zona: `bounds`
 * al rettangolo e ostacoli filtrati a quelli che lo toccano. Richiede pero' di
 * strappare solo le piste INTERAMENTE dentro la zona, altrimenti restano
 * connessioni con un capo fuori dal ritaglio.
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
  gap = 6,
  margin = 2.5,
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
    if (near) {
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

/** il circuito senza le piste e le via che passano dentro la zona */
export function ripZone(circuitJson: CircuitElement[], zone: Zone): CircuitElement[] {
  const inside = (x: number | null, y: number | null): boolean =>
    x !== null &&
    y !== null &&
    x >= zone.minX &&
    x <= zone.maxX &&
    y >= zone.minY &&
    y <= zone.maxY;

  return circuitJson.filter((el) => {
    if (el.type === "pcb_via") return !inside(num(el.x), num(el.y));
    if (el.type !== "pcb_trace") return true;
    const route = (el.route as Array<Record<string, unknown>> | undefined) ?? [];
    return !route.some((p) => inside(num(p.x), num(p.y)));
  });
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

  let srj: { connections: unknown[] };
  try {
    const built = getSimpleRouteJsonFromCircuitJson({
      circuitJson: base as never,
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
    srj = built.simpleRouteJson;
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
