/**
 * Design rules di progetto e ruleset dei fabbricanti (Fase 3.f).
 * Il routing e il DRC principale usano DEFAULT_DESIGN_RULES (JLCPCB standard);
 * il report multi-ruleset valuta il Circuit JSON contro ogni fab e dice la
 * classe di fabbrica piu' economica che la scheda soddisfa (modello Quilter:
 * score trasparente per ruleset). Valori da capability pubbliche dei fab —
 * da ricontrollare prima dell'ordine, sono minimi non target di design.
 */
export interface DesignRules {
  /** larghezza minima pista (mm) - JLCPCB standard: 0.127mm (5mil) */
  minTraceWidthMm: number;
  /** distanza minima rame-rame tra net diverse (mm) - JLCPCB: 0.127mm */
  minClearanceMm: number;
  /** margine minimo del rame dal bordo scheda (mm) */
  minBoardEdgeClearanceMm: number;
  /** diametro minimo foro via (mm) - JLCPCB: 0.3mm */
  minViaHoleMm: number;
  /** diametro minimo pad via (mm) - JLCPCB: 0.6mm (anular ring 0.15) */
  minViaDiameterMm: number;
}

export const DEFAULT_DESIGN_RULES: DesignRules = {
  minTraceWidthMm: 0.127,
  minClearanceMm: 0.127,
  minBoardEdgeClearanceMm: 0.3,
  minViaHoleMm: 0.3,
  minViaDiameterMm: 0.6,
};

export interface FabRuleset {
  key: string;
  label: string;
  /** costo relativo indicativo: 1 = il piu' economico */
  costTier: number;
  rules: DesignRules;
}

/**
 * Ruleset in ordine di costo crescente. Enhanced/HDI permette feature piu'
 * piccole (costa di piu'); OSHPark ha minimi diversi ma comparabili allo
 * standard. Il report dice: "fabbricabile da X (tier N)" = il primo ruleset
 * in ordine di costo con zero violazioni.
 */
export const FAB_RULESETS: FabRuleset[] = [
  {
    key: "jlcpcb_standard",
    label: "JLCPCB standard",
    costTier: 1,
    rules: DEFAULT_DESIGN_RULES,
  },
  {
    key: "oshpark",
    label: "OSHPark 4-layer",
    costTier: 2,
    rules: {
      minTraceWidthMm: 0.1524, // 6 mil
      minClearanceMm: 0.1524,
      minBoardEdgeClearanceMm: 0.38, // 15 mil
      minViaHoleMm: 0.254, // 10 mil
      minViaDiameterMm: 0.508, // 20 mil
    },
  },
  {
    key: "jlcpcb_enhanced",
    label: "JLCPCB enhanced (HDI)",
    costTier: 3,
    rules: {
      minTraceWidthMm: 0.089, // 3.5 mil
      minClearanceMm: 0.089,
      minBoardEdgeClearanceMm: 0.25,
      minViaHoleMm: 0.2,
      minViaDiameterMm: 0.45,
    },
  },
];

// ---------------------------------------------------------------------------
// Regole PER PROGETTO
//
// Fino a qui le regole erano una costante: ogni scheda veniva controllata con i
// minimi JLCPCB standard, anche quando il fornitore era un altro. Il DRC e il
// router accettavano gia' un parametro `rules`, ma nessuno gliene passava di
// diverse. Qui le regole diventano un file del progetto, come manual-edits.json:
// vivono con la scheda, entrano nell'hash dei file (quindi ricompilano la cache
// quando cambiano) e valgono sia per il controllo sia per lo sbroglio.
// ---------------------------------------------------------------------------

export const DESIGN_RULES_PATH = "design-rules.json";

export interface ProjectRules {
  /** chiave di un ruleset noto, oppure "custom" */
  preset: string;
  rules: DesignRules;
  label: string;
  isCustom: boolean;
}

const LIMITS: Record<keyof DesignRules, { min: number; max: number }> = {
  minTraceWidthMm: { min: 0.05, max: 2 },
  minClearanceMm: { min: 0.05, max: 2 },
  minBoardEdgeClearanceMm: { min: 0.1, max: 5 },
  minViaHoleMm: { min: 0.1, max: 2 },
  minViaDiameterMm: { min: 0.2, max: 3 },
};

/**
 * Un valore fuori scala non e' una preferenza, e' un errore di battitura che
 * produrrebbe una scheda invendibile o un DRC che non segnala piu' niente:
 * si riporta dentro i limiti invece di fidarsi.
 */
function clampRules(input: Partial<DesignRules> | undefined): DesignRules {
  const out = { ...DEFAULT_DESIGN_RULES };
  if (!input) return out;
  for (const key of Object.keys(LIMITS) as Array<keyof DesignRules>) {
    const v = input[key];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    const { min, max } = LIMITS[key];
    out[key] = Math.min(max, Math.max(min, v));
  }
  return out;
}

/** legge le regole di un progetto dalla sua mappa file */
export function resolveDesignRules(fsMap: Record<string, string>): ProjectRules {
  const fallback: ProjectRules = {
    preset: FAB_RULESETS[0].key,
    rules: FAB_RULESETS[0].rules,
    label: FAB_RULESETS[0].label,
    isCustom: false,
  };
  const raw = fsMap[DESIGN_RULES_PATH];
  if (!raw) return fallback;

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return fallback;
  }
  if (typeof data !== "object" || data === null) return fallback;
  const obj = data as { preset?: unknown; rules?: unknown };

  const preset = typeof obj.preset === "string" ? obj.preset : "";
  const known = FAB_RULESETS.find((r) => r.key === preset);
  if (known) {
    return { preset: known.key, rules: known.rules, label: known.label, isCustom: false };
  }
  if (preset === "custom") {
    return {
      preset: "custom",
      rules: clampRules(obj.rules as Partial<DesignRules>),
      label: "Regole personalizzate",
      isCustom: true,
    };
  }
  return fallback;
}

export function serializeDesignRules(projectRules: ProjectRules): string {
  const body = projectRules.isCustom
    ? { preset: "custom", rules: projectRules.rules }
    : { preset: projectRules.preset };
  return `${JSON.stringify(body, null, 2)}\n`;
}

/** costruisce le regole da salvare a partire da quello che ha scelto l'utente */
export function buildProjectRules(
  preset: string,
  custom?: Partial<DesignRules>,
): ProjectRules {
  const known = FAB_RULESETS.find((r) => r.key === preset);
  if (known) {
    return { preset: known.key, rules: known.rules, label: known.label, isCustom: false };
  }
  return {
    preset: "custom",
    rules: clampRules(custom),
    label: "Regole personalizzate",
    isCustom: true,
  };
}
