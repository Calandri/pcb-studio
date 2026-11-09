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
  /**
   * 0-100: how ready the board is to go to the factory. 100 only when
   * `ready`: a board that has not been compiled, has open connections, errors
   * or a compile older than its sources never reaches it.
   */
  readiness: number;
  /** nothing is missing: saved compile of these sources, no blocking problem */
  ready: boolean;
  /** what is still missing before the factory, in Italian, most important first */
  missing: string[];
  /** a saved compile of the server is behind these numbers */
  compiled: boolean;
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
  /** i controlli elettrici: "funziona", che e' un'altra domanda da "si fabbrica" */
  prcViolations?: Array<{ rule?: string; message: string }>;
  unroutedConnections?: string[];
  /** every open connection group: unroutedConnections stops at 40 */
  unroutedTotal?: number;
  /** connection groups on the board, routed or not */
  connectionGroups?: number;
  /** the board was saved before its schematic: the schematic checks are not done */
  schematicPending?: string;
  components?: Array<{ name: string }>;
}

/**
 * Where the circuit on screen comes from. Without it the report cannot tell a
 * checked board from a preview, or from nothing at all.
 */
export interface BoardState {
  /** the circuit is the compile SAVED on the server, not a preview of one running */
  saved: boolean;
  /** the sources changed after that compile */
  stale?: boolean;
  /** the checks engine is newer than the verification in cache */
  checksStale?: boolean;
}

/** whether a Circuit JSON carries a board at all */
const hasBoard = (elements: El[]): boolean => elements.some((e) => e?.type === "pcb_board");

/**
 * A board with parts and no schematic: saved before its schematic was drawn
 * (big boards, see CompileOptions.onBoard). Read from the circuit itself and
 * not only from the summary's flag, because every path that edits the saved
 * board (Applica, a hand trace, a recheck) writes a summary of its own.
 */
export function schematicMissing(circuitJson: unknown[] | null | undefined): boolean {
  const elements = (circuitJson ?? []) as El[];
  return (
    hasBoard(elements) &&
    elements.some((e) => e?.type === "source_component") &&
    !elements.some((e) => e?.type === "schematic_component")
  );
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
  state?: BoardState,
): BoardReport {
  const elements = (circuitJson ?? []) as El[];
  /*
   * NOTHING CHECKED, NOTHING CERTIFIED. With no circuit and no summary every
   * family below counted zero problems and the score came out 100: "PRONTA PER
   * LA FABBRICA 100%" on fototrappola-frontale, a board never compiled on the
   * server and without a single trace (09/11/2026). No compile, no score.
   */
  const compiled = hasBoard(elements) && summary !== null && (state?.saved ?? true);

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
  // the list stops at 40: the count of open groups is the true number
  const unroutedCount = Math.max(unrouted.length, summary?.unroutedTotal ?? 0);

  // --- checks grouped by family, with the most useful detail
  const checks: CheckRow[] = [];
  const viaRules = drc.filter((v) => /via/i.test(v.rule ?? v.message));
  const clearanceRules = drc.filter((v) => /clearance/i.test(v.rule ?? v.message));
  const widthRules = drc.filter((v) => /trace_width/i.test(v.rule ?? v.message));
  const edgeRules = drc.filter((v) => /edge/i.test(v.rule ?? v.message));
  const escapeRules = drc.filter((v) => /pin_escape/i.test(v.rule ?? v.message));
  const overlaps = errors.filter((e) => /overlap|outside/i.test(e.type ?? e.message));
  /*
   * Everything else tscircuit flags as an error (a pin it could not connect,
   * a footprint it could not read) was counted nowhere: a board full of them
   * still scored 100.
   */
  const otherErrors = errors.filter((e) => !/overlap|outside/i.test(e.type ?? e.message));
  /*
   * I CONTROLLI ELETTRICI, che nel pannello non c'erano.
   *
   * Il riquadro mostrava solo il DRC: se la scheda si riesce a fabbricare. Ma
   * "si fabbrica" e "funziona" sono due domande diverse, e la seconda finiva
   * solo nel sommario che legge l'agente — quindi le lunghezze appaiate, i
   * ritorni di massa ai connettori e il rame morto l'utente non li vedeva. Le
   * lunghezze stanno in una riga loro perche' sono l'unica cosa qui dentro che
   * l'occhio non puo' controllare: due piste identiche a vedersi possono
   * differire di cinque millimetri.
   */
  const prc = summary?.prcViolations ?? [];
  const lunghezze = prc.filter((v) => /matched_length/i.test(v.rule ?? ""));
  const elettrici = prc.filter((v) => !/matched_length/i.test(v.rule ?? ""));

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
    row("errori", "Errori della compilazione", otherErrors, "Nessun errore dal compilatore.", "interference"),
    row(
      "escape",
      "Uscita dai pin",
      escapeRules,
      "Ogni pista esce dal pad dritta, come da regola di casa.",
      "interference",
      "warn",
    ),
    row(
      "lunghezze",
      "Lunghezze appaiate",
      lunghezze,
      "I bus che devono arrivare in fase sono lunghi uguale, entro la tolleranza del progetto.",
      "copper",
      "warn",
    ),
    row(
      "elettrici",
      "Controlli elettrici",
      elettrici,
      "Disaccoppiamenti vicini, ritorni di massa ai connettori, niente rame morto.",
      "interference",
      "warn",
    ),
    {
      id: "routing",
      name: "Collegamenti completati",
      count: unroutedCount === 0 ? "ok" : `${unroutedCount} aperti`,
      severity: unroutedCount === 0 ? "ok" : "err",
      detail:
        unroutedCount === 0
          ? `${traces.length} piste instradate, nessuna connessione aperta.`
          : `Esempio: ${unrouted[0] ?? "una connessione senza rame"}`,
      preset: "connections",
    },
  );

  if (!compiled) {
    checks.length = 0;
    checks.push({
      id: "compilata",
      name: "Scheda compilata",
      count: "manca",
      severity: "err",
      detail: hasBoard(elements)
        ? "Quella a schermo e' l'anteprima di una compilazione in corso: i controlli valgono solo sulla scheda salvata."
        : "Il server non ha una compilazione salvata di questa scheda: premi Ricompila.",
      preset: "overview",
    });
  }

  const errorsCount = checks.filter((c) => c.severity === "err").length;
  const warningsCount = checks.filter((c) => c.severity === "warn").length;
  const passedCount = checks.filter((c) => c.severity === "ok").length;

  // --- what is still missing, the most important first
  const missing: string[] = [];
  if (!compiled) {
    missing.push(
      hasBoard(elements)
        ? "la scheda a schermo e' un'anteprima: aspetta la fine della compilazione"
        : "la scheda non e' compilata: premi Ricompila",
    );
  } else {
    if (state?.stale) missing.push("i sorgenti sono cambiati dopo l'ultima compilazione: premi Ricompila");
    if (unroutedCount > 0) {
      missing.push(`${unroutedCount} ${unroutedCount === 1 ? "rete non instradata" : "reti non instradate"}`);
    }
    for (const c of checks) {
      if (c.severity === "err" && c.id !== "routing") missing.push(`${c.name}: ${c.count}`);
    }
    if (summary?.schematicPending || schematicMissing(elements)) missing.push("lo schematico non e' ancora calcolato");
    if (state?.checksStale) missing.push("i controlli sono piu' nuovi della verifica: premi Ricontrolla");
  }

  // readiness: what really prevents production weighs more
  const penalty = errorsCount * 18 + warningsCount * 6;
  let readiness = Math.max(0, Math.min(100, 100 - penalty));
  if (!compiled) readiness = 0;
  /*
   * Open connections weigh for what they are: a board with no copper at all is
   * not "82% ready" because one family out of ten is red.
   */
  const groups = summary?.connectionGroups ?? 0;
  if (compiled && unroutedCount > 0 && groups > 0) {
    readiness = Math.min(readiness, Math.floor((99 * Math.max(0, groups - unroutedCount)) / groups));
  }
  // 100 means "nothing missing", and only that
  if (missing.length > 0) readiness = Math.min(readiness, 99);

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
    ready: missing.length === 0,
    missing,
    compiled,
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
    unrouted: unroutedCount,
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
