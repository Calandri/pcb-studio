/**
 * Project design rules and manufacturer rulesets (Phase 3.f).
 * Routing and the main DRC use DEFAULT_DESIGN_RULES (JLCPCB standard);
 * the multi-ruleset report evaluates the Circuit JSON against each fab and
 * reports the cheapest factory class the board satisfies (Quilter model:
 * transparent score per ruleset). Values from the fabs' public capabilities —
 * to be double-checked before ordering, they are minimums, not design targets.
 */
export interface DesignRules {
  /** minimum trace width (mm) - JLCPCB standard: 0.127mm (5mil) */
  minTraceWidthMm: number;
  /** minimum copper-to-copper spacing between different nets (mm) - JLCPCB: 0.127mm */
  minClearanceMm: number;
  /** minimum copper margin from the board edge (mm) */
  minBoardEdgeClearanceMm: number;
  /** minimum via hole diameter (mm) - JLCPCB: 0.3mm */
  minViaHoleMm: number;
  /** minimum via pad diameter (mm) - JLCPCB: 0.6mm (annular ring 0.15) */
  minViaDiameterMm: number;
  /**
   * The width you AIM for when there is room (mm). The minimums above are
   * what the factory can do, not what you draw to: drawing at the minimum
   * means zero margin, and an etching variation opens or short-circuits the
   * board. Stay wide where you can and drop to the minimum only where
   * geometry forces it (under a fine-pitch QFP).
   */
  targetTraceWidthMm: number;
  /** spacing to aim for when there is room (mm) */
  targetClearanceMm: number;
  /**
   * How many millimetres of trace a SIGNAL via is worth, when choosing between
   * two routes (Niccolo', 2026-07-29).
   *
   * Copper length is not the only cost, and on a four-layer board it is not even
   * the main one. A via is a hole drilled in the board — it costs money and it is
   * one more mechanical thing that can fail — it is a discontinuity for a fast
   * signal, and above all it is a HOLE IN THE PLANE: the return current, which
   * travels under the trace, finds the plane interrupted and has to go around.
   * Ten vias in a row cut the plane like a saw.
   *
   * So a longer trace is better than a shorter one that dives to the other side
   * and comes back. Five millimetres is the exchange rate: on a 0.2mm trace it is
   * a fraction of an ohm and nothing in inductance, far less than what one hole
   * costs. It is a judgement, so it is written as a number that can be changed
   * instead of hiding inside a comparison.
   *
   * Plane vias do not count: the one tying a pad to the plane is not a choice,
   * and the stitching ones HELP the return current instead of getting in its way.
   */
  viaCostMm: number;
  /**
   * THE DISTANCE FOR ONE PAIR OF THINGS, when the board declares one.
   *
   * A single copper-to-copper minimum is what a fab quotes, not what a board is
   * drawn to. BAT_BS states `PadToViaClearance` at 0.0254mm where its general
   * rule asks 0.1524, and it uses it: under the BGA the fanout vias pass a
   * hundredth of a millimetre from the balls. Measured against one global
   * number those are twenty-two violations that the designer never committed,
   * and twenty-two lines of noise hide the one line that matters.
   *
   * So a pair can have its own minimum. Missing pair: the general one applies.
   * Keys are the two kinds in alphabetical order, `chiaveCoppia` builds them.
   */
  clearanceByPairMm?: Partial<Record<ChiaveCoppia, number>>;
  /**
   * Between two DRILLS, edge to edge. Nothing else measures it: two vias whose
   * rings overlap can still be legal, and two that look far apart can have
   * their holes a tenth of a millimetre from each other, which is where the
   * drill breaks out and the board is scrap. BAT_BS states 0.25mm and its
   * tightest power via cluster sits at 0.258.
   */
  minHoleToHoleMm: number;
  /**
   * How far a POURED PLANE stays from the copper of other nets.
   *
   * It is a different number from the general clearance and it is not the fab's:
   * a pour touches everything, and it is held wider on purpose. In Altium it is
   * written on the polygon and not in the rules — this board asks 0.254mm where
   * its traces get 0.1524 — so on import it is MEASURED from the openings the
   * file's own pours have (see distanzaColataMisurata).
   *
   * Missing: the general clearance, which is what a board with nothing to say
   * about its pours means.
   */
  pourClearanceMm?: number;
}

/** what a clearance rule can talk about */
export type TipoRame = "pad" | "trace" | "via";

export type ChiaveCoppia =
  | "pad-pad"
  | "pad-trace"
  | "pad-via"
  | "trace-trace"
  | "trace-via"
  | "via-via";

/** the key of a pair, in the one order that makes lookups match */
export function chiaveCoppia(a: TipoRame, b: TipoRame): ChiaveCoppia {
  return (a <= b ? `${a}-${b}` : `${b}-${a}`) as ChiaveCoppia;
}

/** how far apart two pieces of copper of different nets have to stay */
export function distanzaMinimaFra(rules: DesignRules, a: TipoRame, b: TipoRame): number {
  const suo = rules.clearanceByPairMm?.[chiaveCoppia(a, b)];
  return typeof suo === "number" && Number.isFinite(suo) && suo > 0 ? suo : rules.minClearanceMm;
}

/** the pairs, in the order they are shown and written */
export const COPPIE: Array<{ chiave: ChiaveCoppia; label: string }> = [
  { chiave: "pad-pad", label: "pad e pad" },
  { chiave: "pad-trace", label: "pad e pista" },
  { chiave: "pad-via", label: "pad e via" },
  { chiave: "trace-trace", label: "pista e pista" },
  { chiave: "trace-via", label: "pista e via" },
  { chiave: "via-via", label: "via e via" },
];

export const DEFAULT_DESIGN_RULES: DesignRules = {
  minTraceWidthMm: 0.127,
  minClearanceMm: 0.127,
  minBoardEdgeClearanceMm: 0.3,
  minViaHoleMm: 0.3,
  minViaDiameterMm: 0.6,
  // Niccolo's choice (2026-07-26): draw at 0,25 and 0,2, not at the factory
  // minimum. It costs the same and makes the board much more robust in production.
  targetTraceWidthMm: 0.25,
  targetClearanceMm: 0.2,
  viaCostMm: 5,
  // the value the fabs quote for two via drills side by side
  minHoleToHoleMm: 0.25,
};

export interface FabRuleset {
  key: string;
  label: string;
  /** indicative relative cost: 1 = the cheapest */
  costTier: number;
  rules: DesignRules;
}

/**
 * Rulesets in ascending cost order. Enhanced/HDI allows smaller features
 * (costs more); OSHPark has different but comparable minimums to the
 * standard. The report says: "manufacturable by X (tier N)" = the first
 * ruleset in cost order with zero violations.
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
      targetTraceWidthMm: 0.25,
      targetClearanceMm: 0.2,
      viaCostMm: 5,
      minHoleToHoleMm: 0.3,
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
      // on HDI we go narrow by choice: the target drops with the minimums
      targetTraceWidthMm: 0.15,
      targetClearanceMm: 0.15,
      // HDI vias are microvias: cheaper to drill, but still a hole in the plane
      viaCostMm: 3,
      minHoleToHoleMm: 0.2,
    },
  },
];

// ---------------------------------------------------------------------------
// PER-PROJECT rules
//
// Until here the rules were a constant: every board was checked against the
// JLCPCB standard minimums, even when the supplier was someone else. The DRC
// and the router already accepted a `rules` parameter, but nobody passed them
// a different one. Here the rules become a project file, like
// manual-edits.json: they live with the board, join the file hash (so they
// recompile the cache when they change) and apply both to checking and to
// routing.
// ---------------------------------------------------------------------------

export const DESIGN_RULES_PATH = "design-rules.json";

export interface ProjectRules {
  /** key of a known ruleset, or "custom" */
  preset: string;
  rules: DesignRules;
  label: string;
  isCustom: boolean;
}

const LIMITS: Record<
  Exclude<keyof DesignRules, "clearanceByPairMm" | "pourClearanceMm"> | "pourClearanceMm",
  { min: number; max: number }
> = {
  minTraceWidthMm: { min: 0.05, max: 2 },
  minClearanceMm: { min: 0.05, max: 2 },
  minBoardEdgeClearanceMm: { min: 0.1, max: 5 },
  minViaHoleMm: { min: 0.1, max: 2 },
  minViaDiameterMm: { min: 0.2, max: 3 },
  targetTraceWidthMm: { min: 0.05, max: 3 },
  targetClearanceMm: { min: 0.05, max: 3 },
  // zero means "vias are free", which is never true; above 50mm the router
  // would rather cross the whole board than change layer
  viaCostMm: { min: 0, max: 50 },
  minHoleToHoleMm: { min: 0.05, max: 3 },
  pourClearanceMm: { min: 0.05, max: 5 },
};

/**
 * An out-of-range value is not a preference, it is a typo that would produce
 * an unsellable board or a DRC that stops reporting anything: clamp it back
 * within the limits instead of trusting it.
 */
function clampRules(input: Partial<DesignRules> | undefined): DesignRules {
  const out = { ...DEFAULT_DESIGN_RULES };
  if (!input) return out;
  type Numeriche = Exclude<keyof DesignRules, "clearanceByPairMm">;
  for (const key of Object.keys(LIMITS) as Numeriche[]) {
    const v = input[key];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    const { min, max } = LIMITS[key];
    out[key] = Math.min(max, Math.max(min, v));
  }
  /*
   * The pair distances, kept only where they say something: a pair asking for
   * MORE than the general rule is not a special case, it is the general rule
   * badly copied, and one asking for less than ten microns is a mangled file.
   */
  const coppie: Partial<Record<ChiaveCoppia, number>> = {};
  for (const { chiave } of COPPIE) {
    const v = input.clearanceByPairMm?.[chiave];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    coppie[chiave] = Math.min(2, Math.max(0.01, v));
  }
  if (Object.keys(coppie).length > 0) out.clearanceByPairMm = coppie;
  return out;
}

/** reads a project's rules from its file map */
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

/** builds the rules to save from what the user chose */
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
