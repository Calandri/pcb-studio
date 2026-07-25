/**
 * Design rules di progetto. Default: capability standard JLCPCB 2-6 layer.
 * Diventeranno per-progetto (colonna projects.design_rules) quando servira'.
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
