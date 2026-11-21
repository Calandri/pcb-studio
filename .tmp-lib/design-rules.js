export const DEFAULT_DESIGN_RULES = {
    minTraceWidthMm: 0.127,
    minClearanceMm: 0.127,
    minBoardEdgeClearanceMm: 0.3,
    minViaHoleMm: 0.3,
    minViaDiameterMm: 0.6,
};
/**
 * Ruleset in ordine di costo crescente. Enhanced/HDI permette feature piu'
 * piccole (costa di piu'); OSHPark ha minimi diversi ma comparabili allo
 * standard. Il report dice: "fabbricabile da X (tier N)" = il primo ruleset
 * in ordine di costo con zero violazioni.
 */
export const FAB_RULESETS = [
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
