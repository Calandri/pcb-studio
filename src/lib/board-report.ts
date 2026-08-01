/**
 * Translates the Circuit JSON into the numbers the workspace shows:
 * manufacturability status, grouped checks, layer coverage, cost estimate.
 * Everything derived from the real compilation data, no made-up values.
 */

export type Severity = "err" | "warn" | "ok";

export interface CheckRow {
  id: string;
  name: string;
  count: string;
  severity: Severity;
  detail: string;
  /** view to switch on over the board to see what is being talked about */
  preset: string;
}

export interface LayerRow {
  id: string;
  name: string;
  depthMm: string;
  coverage: number;
  color: string;
}

export interface BoardReport {
  /** 0-100: how ready the board is to go to the factory */
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
  // the key can be present with an empty value (e.g. {"JLCPCB Part #": ""}):
  // that component is NOT orderable, and counting it as such lied about the BOM
  const withSupplier = components.filter((c) => {
    const s = c.supplier_part_numbers as Record<string, unknown> | undefined;
    if (!s) return false;
    return Object.values(s).some((v) => {
      const code = Array.isArray(v) ? v[0] : v;
      return Boolean(code) && String(code).trim() !== "";
    });
  }).length;

  const errors = summary?.errors ?? [];
  const drc = summary?.drcViolations ?? [];
  const unrouted = summary?.unroutedConnections ?? [];

  // --- checks grouped by family, with the most useful detail
  const checks: CheckRow[] = [];
  const viaRules = drc.filter((v) => /via/i.test(v.rule ?? v.message));
  const clearanceRules = drc.filter((v) => /clearance/i.test(v.rule ?? v.message));
  const widthRules = drc.filter((v) => /trace_width/i.test(v.rule ?? v.message));
  const edgeRules = drc.filter((v) => /edge/i.test(v.rule ?? v.message));
  const escapeRules = drc.filter((v) => /pin_escape/i.test(v.rule ?? v.message));
  const overlaps = errors.filter((e) => /overlap|outside/i.test(e.type ?? e.message));

  const row = (
    id: string,
    name: string,
    items: Array<{ message: string }>,
    okDetail: string,
    preset: string,
    severity: Severity = "err",
  ): CheckRow => ({
    id,
    name,
    count: items.length === 0 ? "ok" : `${items.length} ${items.length === 1 ? "segnalazione" : "segnalazioni"}`,
    severity: items.length === 0 ? "ok" : severity,
    detail: items.length === 0 ? okDetail : items[0].message.slice(0, 130),
    preset,
  });

  checks.push(
    row("via", "Fori e anelli delle via", viaRules, "Via entro i minimi di fabbrica.", "interference", "warn"),
    row("clear", "Distanze minime", clearanceRules, "Nessun rame troppo ravvicinato.", "interference"),
    row("width", "Larghezza piste", widthRules, "Tutte le piste sopra la larghezza minima.", "copper"),
    row("edge", "Margine dal bordo", edgeRules, "Rame a distanza di sicurezza dal bordo.", "fabrication"),
    row("place", "Ingombri dei componenti", overlaps, "Nessuna sovrapposizione.", "interference"),
    row(
      "escape",
      "Uscita dai pin",
      escapeRules,
      "Ogni pista esce dal pad dritta, come da regola di casa.",
      "interference",
      "warn",
    ),
    {
      id: "routing",
      name: "Collegamenti completati",
      count: unrouted.length === 0 ? "ok" : `${unrouted.length} aperti`,
      severity: unrouted.length === 0 ? "ok" : "err",
      detail:
        unrouted.length === 0
          ? `${traces.length} piste instradate, nessuna connessione aperta.`
          : `Esempio: ${unrouted[0]}`,
      preset: "connections",
    },
  );

  const errorsCount = checks.filter((c) => c.severity === "err").length;
  const warningsCount = checks.filter((c) => c.severity === "warn").length;
  const passedCount = checks.filter((c) => c.severity === "ok").length;

  // readiness: what really prevents production weighs more
  const penalty = errorsCount * 18 + warningsCount * 6;
  const readiness = Math.max(0, Math.min(100, 100 - penalty));

  // --- coverage per layer: how much copper is on each one
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
      // a copper pour covers almost everything; on the others we scale to the max
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
 * Very rough estimate of the prototyping cost: it is meant to give an order
 * of magnitude in euros, not a quote. It must always be presented as an estimate.
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
