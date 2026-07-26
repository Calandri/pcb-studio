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
