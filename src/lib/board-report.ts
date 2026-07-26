/**
 * Traduce il Circuit JSON nei numeri che il workspace mostra: stato di
 * fabbricabilita', verifiche raggruppate, copertura dei layer, stima di costo.
 * Tutto derivato dai dati veri della compilazione, niente valori inventati.
 */

export type Severity = "err" | "warn" | "ok";

export interface CheckRow {
  id: string;
  name: string;
  count: string;
  severity: Severity;
  detail: string;
}

export interface LayerRow {
  id: string;
  name: string;
  depthMm: string;
  coverage: number;
  color: string;
}

export interface BoardReport {
  /** 0-100: quanto la scheda e' pronta per andare in fabbrica */
  readiness: number;
  errors: number;
  warnings: number;
  passed: number;
  checks: CheckRow[];
  layers: LayerRow[];
  widthMm: number | null;
  heightMm: number | null;
  layerCount: number;
  componentCount: number;
  partsWithSupplier: number;
  traceCount: number;
  viaCount: number;
  unrouted: number;
}

interface El {
  type: string;
  [key: string]: unknown;
}

interface SummaryLike {
  errors?: Array<{ type?: string; message: string }>;
  drcViolations?: Array<{ rule?: string; message: string }>;
  unroutedConnections?: string[];
  components?: Array<{ name: string }>;
}

const LAYER_COLORS: Record<string, string> = {
  top: "#F2C078",
  inner1: "#3BE8B0",
  inner2: "#7FB4FF",
  bottom: "#B9853A",
};

export function buildBoardReport(
  circuitJson: unknown[] | null,
  summary: SummaryLike | null,
): BoardReport {
  const elements = (circuitJson ?? []) as El[];

  const board = elements.find((e) => e.type === "pcb_board");
  const layerCount = Number(board?.num_layers ?? 2) || 2;
  const widthMm = typeof board?.width === "number" ? board.width : null;
  const heightMm = typeof board?.height === "number" ? board.height : null;

  const traces = elements.filter((e) => e.type === "pcb_trace");
  const vias = elements.filter((e) => e.type === "pcb_via");
  const pads = elements.filter((e) => e.type === "pcb_smtpad");
  const components = elements.filter((e) => e.type === "source_component");
  const withSupplier = components.filter((c) => {
    const s = c.supplier_part_numbers as Record<string, unknown> | undefined;
    return s && Object.keys(s).length > 0;
  }).length;

  const errors = summary?.errors ?? [];
  const drc = summary?.drcViolations ?? [];
  const unrouted = summary?.unroutedConnections ?? [];

  // --- verifiche raggruppate per famiglia, con il dettaglio piu' utile
  const checks: CheckRow[] = [];
  const viaRules = drc.filter((v) => /via/i.test(v.rule ?? v.message));
  const clearanceRules = drc.filter((v) => /clearance/i.test(v.rule ?? v.message));
  const widthRules = drc.filter((v) => /trace_width/i.test(v.rule ?? v.message));
  const edgeRules = drc.filter((v) => /edge/i.test(v.rule ?? v.message));
  const overlaps = errors.filter((e) => /overlap|outside/i.test(e.type ?? e.message));

  const row = (
    id: string,
    name: string,
    items: Array<{ message: string }>,
    okDetail: string,
    severity: Severity = "err",
  ): CheckRow => ({
    id,
    name,
    count: items.length === 0 ? "ok" : `${items.length} ${items.length === 1 ? "segnalazione" : "segnalazioni"}`,
    severity: items.length === 0 ? "ok" : severity,
    detail: items.length === 0 ? okDetail : items[0].message.slice(0, 130),
  });

  checks.push(
    row("via", "Fori e anelli delle via", viaRules, "Via entro i minimi di fabbrica.", "warn"),
    row("clear", "Distanze minime", clearanceRules, "Nessun rame troppo ravvicinato."),
    row("width", "Larghezza piste", widthRules, "Tutte le piste sopra la larghezza minima."),
    row("edge", "Margine dal bordo", edgeRules, "Rame a distanza di sicurezza dal bordo."),
    row("place", "Ingombri dei componenti", overlaps, "Nessuna sovrapposizione."),
    {
      id: "routing",
      name: "Collegamenti completati",
      count: unrouted.length === 0 ? "ok" : `${unrouted.length} aperti`,
      severity: unrouted.length === 0 ? "ok" : "err",
      detail:
        unrouted.length === 0
          ? `${traces.length} piste instradate, nessuna connessione aperta.`
          : `Esempio: ${unrouted[0]}`,
    },
  );

  const errorsCount = checks.filter((c) => c.severity === "err").length;
  const warningsCount = checks.filter((c) => c.severity === "warn").length;
  const passedCount = checks.filter((c) => c.severity === "ok").length;

  // readiness: pesa di piu' quello che impedisce davvero di produrre
  const penalty = errorsCount * 18 + warningsCount * 6;
  const readiness = Math.max(0, Math.min(100, 100 - penalty));

  // --- copertura per layer: quanto rame c'e' su ciascuno
  const perLayer = new Map<string, number>();
  for (const t of traces) {
    for (const p of (t.route as Array<{ layer?: string }> | undefined) ?? []) {
      if (p.layer) perLayer.set(p.layer, (perLayer.get(p.layer) ?? 0) + 1);
    }
  }
  for (const p of pads) {
    const l = String(p.layer ?? "top");
    perLayer.set(l, (perLayer.get(l) ?? 0) + 1);
  }
  const pours = elements.filter((e) => e.type === "pcb_copper_pour");
  const maxCount = Math.max(1, ...perLayer.values());

  const layerIds =
    layerCount >= 4 ? ["top", "inner1", "inner2", "bottom"] : ["top", "bottom"];
  const thickness = 1.6;
  const layers: LayerRow[] = layerIds.map((id, i) => {
    const pour = pours.find((p) => p.layer === id);
    const raw = perLayer.get(id) ?? 0;
    return {
      id,
      name:
        id === "top"
          ? "Top"
          : id === "bottom"
            ? "Bottom"
            : `${id === "inner1" ? "Inner 1" : "Inner 2"}${pour ? ` · ${String(pour.connects_to ?? "").replace("net.", "") || "piano"}` : ""}`,
      depthMm: (i * (thickness / (layerIds.length - 1))).toFixed(3).replace(".", ","),
      // un piano di rame copre quasi tutto; sugli altri si scala sul massimo
      coverage: pour ? 92 : Math.round((raw / maxCount) * 88),
      color: LAYER_COLORS[id] ?? "#F2C078",
    };
  });

  return {
    readiness,
    errors: errorsCount,
    warnings: warningsCount,
    passed: passedCount,
    checks,
    layers,
    widthMm,
    heightMm,
    layerCount,
    componentCount: components.length,
    partsWithSupplier: withSupplier,
    traceCount: traces.length,
    viaCount: vias.length,
    unrouted: unrouted.length,
  };
}

/**
 * Stima molto grossolana del costo di prototipazione: serve a dare un ordine di
 * grandezza in euro, non a fare un preventivo. Va sempre presentata come stima.
 */
export function estimateCost(report: BoardReport, quantity = 50): {
  eur: number;
  days: number;
} {
  const areaCm2 =
    report.widthMm && report.heightMm
      ? (report.widthMm * report.heightMm) / 100
      : 25;
  const layerFactor = report.layerCount >= 4 ? 2.4 : 1;
  const boardCost = (1.2 + areaCm2 * 0.11) * layerFactor;
  const setup = report.layerCount >= 4 ? 90 : 35;
  const eur = Math.round(setup + boardCost * quantity);
  const days = report.layerCount >= 4 ? 6 : 4;
  return { eur, days };
}
