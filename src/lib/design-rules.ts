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
  /**
   * HOW MUCH THE STENCIL OPENING OF A PAD DIFFERS FROM THE PAD, per side (mm).
   *
   * Zero, the Altium and KiCad default, means the paste covers the pad
   * exactly. Negative shrinks it (fine pitch, where bridges are the risk),
   * positive grows it. Missing means zero. Before this rule every pad got 70%
   * of its width and height from tscircuit, half the area: see solder-paste.ts.
   */
  pasteExpansionMm?: number;
  /**
   * WHETHER THE COMPILE MAY ADD ITS OWN VIAS TO THE PLANES.
   *
   * By default it does (stitchToPlanes): a via next to every pad whose net has
   * its plane on another face, and stitching vias on a grid. That is right for a
   * board the router draws. It is wrong for a board whose copper already
   * exists, like one imported from Altium: the vias are added BEFORE the
   * imported traces come back, so they land next to pads those traces already
   * connect, and on BAT_BS they sat 0.07mm from the original vias and on top of
   * other nets' traces. `false` leaves the planes exactly as the file has them.
   */
  autoPlaneVias?: boolean;
  /**
   * PASTE ON THROUGH-HOLE PADS (pin-in-paste). Off unless asked: Altium and
   * KiCad do not paste a through-hole pad, and pasting it on a normal line
   * leaves solder on the ring before the lead goes in. tscircuit pasted every
   * one of them on both faces.
   */
  pasteOnPlatedHoles?: boolean;
  /**
   * WHETHER THE COMPILE RUNS THE AUTOROUTER. By default it does. A board whose
   * copper already exists, like one imported from Altium, has nothing to route:
   * the router still tried for minutes on the connections it cannot see as
   * done, failed every time, and left a routing error on a board with no open
   * connection. On BIRDY_BAT (2026-10-20) it took 5 to 9 minutes of a compile,
   * past the 800 s a production function may run, so the compile was never
   * saved. `false` compiles geometry, the project's own copper, planes and
   * checks: the same board, in a minute.
   */
  autoroute?: boolean;
  /**
   * HOW FAR THE SILKSCREEN STAYS from another silkscreen drawing and from bare
   * copper (the mask openings of pads, plated holes and fiducials), edge to
   * edge, as it prints (see silkscreen-clearance.ts). Missing:
   * SERIGRAFIA_DISTANZA_MM, the 0.15 mm the fabs quote for silkscreen.
   */
  minSilkscreenClearanceMm?: number;
  /**
   * THE EXCESS AROUND A PART: how much a footprint computed by PCB Studio (a
   * part whose footprint declares no courtyard) stands out of the exact
   * envelope of its body and pads, on every side (see ingombro.ts). Two parts
   * whose footprints overlap hit each other in assembly. Missing:
   * INGOMBRO_ECCEDENZA_MM. A declared courtyard is taken as it is.
   */
  componentCourtyardExcessMm?: number;
}

/**
 * The excess of a project that writes none, per side: two parts keep twice it.
 * Niccolo', 2026-11-11: "come da datasheet ESATTO + 0,15", then "facciamo anche
 * 0,2" (IPC-7351 gives 0,5 / 0,25 / 0,10 per side; assemblers ask 0,25-0,3 mm
 * between two 0402). The only place it is written.
 */
export const INGOMBRO_ECCEDENZA_MM = 0.2;

/** the excess around a part the project asks, or the default */
export function eccedenzaDellIngombro(rules: DesignRules): number {
  const v = rules.componentCourtyardExcessMm;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : INGOMBRO_ECCEDENZA_MM;
}

/** the silkscreen clearance of a project that writes none (Niccolo', 2026-11-11) */
export const SERIGRAFIA_DISTANZA_MM = 0.15;

/** the silkscreen clearance the project asks, or the default */
export function distanzaDellaSerigrafia(rules: DesignRules): number {
  const v = rules.minSilkscreenClearanceMm;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : SERIGRAFIA_DISTANZA_MM;
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
  /**
   * What was wrong with the file and what was done about it: a broken JSON
   * that fell back to JLCPCB, a value outside the limits, a target below its
   * minimum. Absent when the file was fine.
   */
  warnings?: string[];
}

/** the widest clearance a pour may ask, for the whole project or for itself (see DISTANZA_PROPRIA) */
export const MAX_POUR_CLEARANCE_MM = 5;

const LIMITS: Record<
  | Exclude<
      keyof DesignRules,
      | "clearanceByPairMm"
      | "pourClearanceMm"
      | "pasteExpansionMm"
      | "minSilkscreenClearanceMm"
      | "componentCourtyardExcessMm"
      | "autoPlaneVias"
      | "pasteOnPlatedHoles"
      | "autoroute"
    >
  | "pourClearanceMm"
  | "pasteExpansionMm"
  | "minSilkscreenClearanceMm"
  | "componentCourtyardExcessMm",
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
  pourClearanceMm: { min: 0.05, max: MAX_POUR_CLEARANCE_MM },
  // a tenth of a millimetre either way is already a lot of paste: beyond
  // that it is a typo, not a stencil
  pasteExpansionMm: { min: -0.1, max: 0.1 },
  // zero: only silkscreen that touches counts; beyond a millimetre it is a typo
  minSilkscreenClearanceMm: { min: 0, max: 1 },
  // zero: the exact envelopes, touching allowed; beyond a millimetre a side it is a typo
  componentCourtyardExcessMm: { min: 0, max: 1 },
};

/** the limits of one pair's own distance (clearanceByPairMm): under ten microns a mangled file */
const LIMITE_COPPIA = { min: 0.01, max: 2 };

/** the switches of the rules: true or false */
const INTERRUTTORI = ["autoPlaneVias", "pasteOnPlatedHoles", "autoroute"] as const;

/**
 * An out-of-range value is not a preference, it is a typo that would produce
 * an unsellable board or a DRC that stops reporting anything: clamp it back
 * within the limits instead of trusting it.
 *
 * And the values are checked AGAINST EACH OTHER, because each one can be within
 * its limits and the set still make no sense: a target width below the minimum
 * (the router would aim at a trace the DRC rejects), a via whose hole is as wide
 * as its pad (no copper ring left at all). Every correction is written in
 * `avvisi`, so it is said instead of silently applied.
 */
function clampRules(input: Partial<DesignRules> | undefined, avvisi: string[] = []): DesignRules {
  const out = { ...DEFAULT_DESIGN_RULES };
  if (!input || typeof input !== "object") return out;
  type Numeriche = Exclude<keyof DesignRules, "clearanceByPairMm" | "autoPlaneVias" | "pasteOnPlatedHoles" | "autoroute">;
  for (const key of Object.keys(LIMITS) as Numeriche[]) {
    const v = input[key];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isFinite(v)) {
      avvisi.push(`${key}: valore non numerico (${JSON.stringify(v)}), uso ${out[key] ?? "il valore di base"}`);
      continue;
    }
    const { min, max } = LIMITS[key];
    out[key] = Math.min(max, Math.max(min, v));
    if (out[key] !== v) avvisi.push(`${key}: ${v} e' fuori dai limiti ${min}-${max}, portato a ${out[key]}`);
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
    coppie[chiave] = Math.min(LIMITE_COPPIA.max, Math.max(LIMITE_COPPIA.min, v));
    if (coppie[chiave] !== v) avvisi.push(`distanza ${chiave}: ${v} portata a ${coppie[chiave]}`);
  }
  if (Object.keys(coppie).length > 0) out.clearanceByPairMm = coppie;
  if (typeof input.autoPlaneVias === "boolean") out.autoPlaneVias = input.autoPlaneVias;
  if (typeof input.pasteOnPlatedHoles === "boolean") out.pasteOnPlatedHoles = input.pasteOnPlatedHoles;
  if (typeof input.autoroute === "boolean") out.autoroute = input.autoroute;

  // --- the values against each other
  if (out.targetTraceWidthMm < out.minTraceWidthMm) {
    avvisi.push(
      `targetTraceWidthMm ${out.targetTraceWidthMm} e' sotto il minimo ${out.minTraceWidthMm}: portato al minimo`,
    );
    out.targetTraceWidthMm = out.minTraceWidthMm;
  }
  if (out.targetClearanceMm < out.minClearanceMm) {
    avvisi.push(
      `targetClearanceMm ${out.targetClearanceMm} e' sotto il minimo ${out.minClearanceMm}: portato al minimo`,
    );
    out.targetClearanceMm = out.minClearanceMm;
  }
  // a via needs copper around its hole: at least five hundredths per side
  const anelloMinimo = 0.1;
  if (out.minViaDiameterMm < out.minViaHoleMm + anelloMinimo) {
    const prima = out.minViaDiameterMm;
    out.minViaDiameterMm = Number(
      Math.min(LIMITS.minViaDiameterMm.max, out.minViaHoleMm + anelloMinimo).toFixed(3),
    );
    avvisi.push(
      `minViaDiameterMm ${prima} non lascia rame attorno al foro da ${out.minViaHoleMm}mm: portato a ${out.minViaDiameterMm}`,
    );
  }
  if (out.pourClearanceMm !== undefined && out.pourClearanceMm < out.minClearanceMm) {
    avvisi.push(
      `pourClearanceMm ${out.pourClearanceMm} e' sotto la distanza minima ${out.minClearanceMm}: portata al minimo`,
    );
    out.pourClearanceMm = out.minClearanceMm;
  }
  return out;
}

/** reads a project's rules from its file map */
export function resolveDesignRules(fsMap: Record<string, string>): ProjectRules {
  const fallback = (avviso?: string): ProjectRules => ({
    preset: FAB_RULESETS[0].key,
    rules: FAB_RULESETS[0].rules,
    label: FAB_RULESETS[0].label,
    isCustom: false,
    ...(avviso ? { warnings: [avviso] } : {}),
  });
  const raw = fsMap[DESIGN_RULES_PATH];
  if (!raw) return fallback();

  /*
   * A BROKEN FILE IS SAID, not swallowed. It used to fall back to JLCPCB in
   * silence: whoever had chosen a coarser manufacturer and mistyped one comma
   * got a board routed and checked against minimums their factory cannot make,
   * with every check green.
   */
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return fallback(
      `${DESIGN_RULES_PATH} non e' un JSON valido (${err instanceof Error ? err.message : String(err)}): uso ${FAB_RULESETS[0].label}`,
    );
  }
  if (typeof data !== "object" || data === null) {
    return fallback(`${DESIGN_RULES_PATH} non contiene un oggetto: uso ${FAB_RULESETS[0].label}`);
  }
  const obj = data as { preset?: unknown; rules?: unknown };

  const preset = typeof obj.preset === "string" ? obj.preset : "";
  const known = FAB_RULESETS.find((r) => r.key === preset);
  if (known) {
    return { preset: known.key, rules: known.rules, label: known.label, isCustom: false };
  }
  if (preset === "custom") {
    const avvisi: string[] = [];
    return {
      preset: "custom",
      rules: clampRules(obj.rules as Partial<DesignRules>, avvisi),
      label: "Regole personalizzate",
      isCustom: true,
      ...(avvisi.length > 0 ? { warnings: avvisi } : {}),
    };
  }
  return fallback(
    `${DESIGN_RULES_PATH}: preset ${JSON.stringify(obj.preset ?? null)} sconosciuto (ammessi: ${[
      ...FAB_RULESETS.map((r) => r.key),
      "custom",
    ].join(", ")}): uso ${FAB_RULESETS[0].label}`,
  );
}

/**
 * The file as it is written. `stackup` is what the file says about the board's
 * stackup (see THE STACKUP OF THE BOARD below), written after the rules;
 * missing, the file carries none.
 */
export function serializeDesignRules(projectRules: ProjectRules, stackup?: unknown): string {
  const body = projectRules.isCustom
    ? { preset: "custom", rules: projectRules.rules }
    : { preset: projectRules.preset };
  return `${JSON.stringify(stackup === undefined ? body : { ...body, stackup }, null, 2)}\n`;
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
  const avvisi: string[] = [];
  return {
    preset: "custom",
    rules: clampRules(custom, avvisi),
    label: "Regole personalizzate",
    isCustom: true,
    ...(avvisi.length > 0 ? { warnings: avvisi } : {}),
  };
}

/** the longest design-rules.json a tool may write: a full set of rules is well under a kilobyte */
export const MAX_REGOLE_CHARS = 20_000;

/** a key worth repeating in a message: a short identifier, nothing else of what was sent */
const nomeSicuro = (k: string) => (/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(k) ? k : "un campo dal nome non valido");

/** the fields a project's rules may carry, with their limits, for whoever writes the file (the tools' descriptions) */
export function campiDelleRegole(): string {
  return [
    ...Object.entries(LIMITS).map(([k, { min, max }]) => `${k} ${min}..${max}`),
    `clearanceByPairMm {${COPPIE.map((c) => c.chiave).join(", ")}} ${LIMITE_COPPIA.min}..${LIMITE_COPPIA.max}`,
    ...INTERRUTTORI.map((k) => `${k} true/false`),
  ].join("; ");
}

/**
 * A design-rules.json written by a tool (the MCP write_file, the agent's),
 * checked WHOLE before it is written: the same schema and limits the panel of
 * the rules saves with (LIMITS, clampRules, buildProjectRules), but strict.
 * The panel clamps a value out of its limits and says so; a file a tool writes
 * is refused instead, with every field that is wrong and its limit, so nothing
 * is saved half-right and nothing is changed behind the writer's back.
 * - valid JSON, an object, at most MAX_REGOLE_CHARS;
 * - preset: one of FAB_RULESETS or "custom"; rules only with "custom";
 * - every field of rules known, of its type and within its limits, and the
 *   fields consistent with each other (what clampRules would correct);
 * - stackup, with any preset, checked whole too (validaStackup);
 * - nothing of what was sent goes back in a message but short identifiers and
 *   numbers.
 * What is written is the file as the panel writes it (serializeDesignRules).
 * The file is the WHOLE file: one written without stackup carries none, and
 * `stackup` in the answer is the one it carries.
 */
export function validaFileDelleRegole(
  content: string,
): { regole: ProjectRules; contenuto: string; stackup?: Stackup } | { errori: string[] } {
  if (content.length > MAX_REGOLE_CHARS) return { errori: [`file troppo grande (${content.length} caratteri, massimo ${MAX_REGOLE_CHARS})`] };
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    return { errori: ["non e' un JSON valido (NaN e Infinity non sono JSON)"] };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return { errori: ["serve un oggetto {\"preset\": ..., \"rules\": {...}}"] };
  const obj = data as Record<string, unknown>;
  const errori: string[] = [];
  for (const k of Object.keys(obj)) {
    if (k !== "preset" && k !== "rules" && k !== "stackup") errori.push(`${nomeSicuro(k)}: campo sconosciuto (ammessi preset, rules e stackup)`);
  }
  let stackup: Stackup | undefined;
  if ("stackup" in obj) {
    const esito = validaStackup(obj.stackup);
    if ("errori" in esito) errori.push(...esito.errori);
    else stackup = esito.stackup;
  }
  const ammessi = [...FAB_RULESETS.map((r) => r.key), "custom"];
  if (typeof obj.preset !== "string" || !ammessi.includes(obj.preset)) errori.push(`preset: deve essere uno di ${ammessi.join(", ")}`);
  if (obj.preset !== "custom") {
    if (obj.rules !== undefined) errori.push('rules: vale solo con preset "custom" (un preset di fabbrica ha le sue regole)');
  } else if (typeof obj.rules !== "object" || obj.rules === null || Array.isArray(obj.rules)) {
    errori.push("rules: serve un oggetto con le regole");
  } else {
    const rules = obj.rules as Record<string, unknown>;
    for (const [k, v] of Object.entries(rules)) {
      if (k in LIMITS) {
        const { min, max } = LIMITS[k as keyof typeof LIMITS];
        if (typeof v !== "number" || !Number.isFinite(v)) errori.push(`${k}: deve essere un numero (limiti ${min}..${max})`);
        else if (v < min || v > max) errori.push(`${k}: ${v} fuori dai limiti ${min}..${max}`);
      } else if ((INTERRUTTORI as readonly string[]).includes(k)) {
        if (typeof v !== "boolean") errori.push(`${k}: deve essere true o false`);
      } else if (k === "clearanceByPairMm") {
        if (typeof v !== "object" || v === null || Array.isArray(v)) {
          errori.push(`clearanceByPairMm: serve un oggetto {${COPPIE.map((c) => `"${c.chiave}"`).join(", ")}}`);
          continue;
        }
        for (const [c, d] of Object.entries(v as Record<string, unknown>)) {
          if (!COPPIE.some((q) => q.chiave === c)) errori.push(`clearanceByPairMm.${/^[a-z]+-[a-z]+$/.test(c) ? c : "?"}: coppia sconosciuta (ammesse ${COPPIE.map((q) => q.chiave).join(", ")})`);
          else if (typeof d !== "number" || !Number.isFinite(d)) errori.push(`clearanceByPairMm.${c}: deve essere un numero (limiti ${LIMITE_COPPIA.min}..${LIMITE_COPPIA.max})`);
          else if (d < LIMITE_COPPIA.min || d > LIMITE_COPPIA.max) errori.push(`clearanceByPairMm.${c}: ${d} fuori dai limiti ${LIMITE_COPPIA.min}..${LIMITE_COPPIA.max}`);
        }
      } else {
        errori.push(`rules.${nomeSicuro(k)}: campo sconosciuto`);
      }
    }
    // the fields against each other: whatever the panel would correct is refused here
    if (errori.length === 0) {
      const avvisi: string[] = [];
      clampRules(rules as Partial<DesignRules>, avvisi);
      errori.push(...avvisi.map((a) => a.replace(/: portat[oa] .*$/, "")));
    }
  }
  if (errori.length > 0) return { errori };
  const regole = buildProjectRules(obj.preset as string, obj.rules as Partial<DesignRules> | undefined);
  return { regole, contenuto: serializeDesignRules(regole, stackup), ...(stackup ? { stackup } : {}) };
}

// ---------------------------------------------------------------------------
// THE STACKUP OF THE BOARD
//
// A board says how many copper layers it has and how thick it is, no more: the
// "Sezione della scheda" panel could only cut the thickness in equal steps.
// st-camera (six layers, 1.6 mm, JLCPCB JLC06161H-3313) has its inner layers
// 0.134, 0.700, 0.831 and 1.396 mm deep, and was shown 0.32, 0.64, 0.96 and
// 1.28. A project can now declare its stackup, in design-rules.json next to
// `preset` and `rules`:
//
//   "stackup": {
//     "copperMm": [0.035, 0.0152, 0.0152, 0.0152, 0.0152, 0.035],
//     "dielectrics": [
//       { "mm": 0.0994, "er": 4.1, "kind": "prepreg", "name": "3313" },
//       { "mm": 0.55, "er": 4.6, "kind": "core" },
//       ...
//     ]
//   }
//
// copperMm has one thickness per copper layer, Top first; dielectrics one entry
// per gap between two layers, top first, so one fewer.
//
// It sits at the top of the file and not inside `rules` because it is not a
// rule: `rules` exists only with preset "custom" and goes whole to the router
// and the checks, while a board on a factory preset has a stackup too, and no
// check reads it. resolveDesignRules does not see it: only the panel does
// (board-report.ts). `er` is kept and nothing is computed from it.
// ---------------------------------------------------------------------------

export interface StackupDielectric {
  /** thickness (mm) */
  mm: number;
  /** relative permittivity: stored for whoever computes an impedance, read by nothing here */
  er?: number;
  kind?: "prepreg" | "core";
  /** what the fab calls it: "3313", "7628" */
  name?: string;
}

export interface Stackup {
  /** thickness of each copper layer (mm), Top first */
  copperMm: number[];
  /** what lies between two copper layers, top first: one fewer than copperMm */
  dielectrics: StackupDielectric[];
}

/** what a project says about its stackup: the declared one, or why the declared one cannot be used; neither when it declares none */
export interface DeclaredStackup {
  stackup?: Stackup;
  errori?: string[];
}

/** above ten millimetres one layer is microns typed as millimetres: no board is that thick */
const MAX_SPESSORE_STRATO_MM = 10;
const TIPI_DI_DIELETTRICO = ["prepreg", "core"] as const;
const CAMPI_DEL_DIELETTRICO = ["mm", "er", "kind", "name"];
const MAX_NOME_DIELETTRICO = 40;

/** the name of a dielectric: one short line of text, with something in it and no control character */
const nomeDiDielettrico = (v: unknown): v is string =>
  typeof v === "string" &&
  v.trim() !== "" &&
  v.length <= MAX_NOME_DIELETTRICO &&
  ![...v].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);

/** a thickness: a finite number above zero, within the limit */
function spessoreValido(v: unknown, dove: string, errori: string[]): void {
  if (typeof v !== "number" || !Number.isFinite(v)) errori.push(`${dove}: deve essere un numero di millimetri maggiore di zero`);
  else if (v <= 0) errori.push(`${dove}: ${v} deve essere maggiore di zero`);
  else if (v > MAX_SPESSORE_STRATO_MM) errori.push(`${dove}: ${v} oltre il massimo di ${MAX_SPESSORE_STRATO_MM} (i valori sono in millimetri, non in micron)`);
}

/**
 * The stackup of a design-rules.json, checked whole and strict like the rest of
 * the file: every field known, every thickness a finite number above zero, one
 * dielectric per gap. What comes back is rebuilt from the known fields only,
 * and no message repeats a text that was sent.
 */
function validaStackup(v: unknown): { stackup: Stackup } | { errori: string[] } {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    return { errori: ['stackup: serve un oggetto {"copperMm": [...], "dielectrics": [...]}'] };
  }
  const obj = v as Record<string, unknown>;
  const errori: string[] = [];
  for (const k of Object.keys(obj)) {
    if (k !== "copperMm" && k !== "dielectrics") errori.push(`stackup.${nomeSicuro(k)}: campo sconosciuto (ammessi copperMm e dielectrics)`);
  }
  const rame = obj.copperMm;
  let strati = 0;
  if (!Array.isArray(rame) || rame.length < 2) {
    errori.push("stackup.copperMm: serve un elenco di almeno due spessori in mm, uno per strato di rame, dall'alto (Top) al basso (Bottom)");
  } else {
    strati = rame.length;
    rame.forEach((s, i) => spessoreValido(s, `stackup.copperMm[${i}]`, errori));
  }
  const dielettrici = obj.dielectrics;
  if (!Array.isArray(dielettrici)) {
    errori.push("stackup.dielectrics: serve un elenco, uno per ogni spazio fra due strati di rame, dall'alto");
  } else {
    if (strati >= 2 && dielettrici.length !== strati - 1) {
      errori.push(`stackup.dielectrics: ne servono ${strati - 1}, uno per ogni spazio fra i ${strati} strati di rame (trovati ${dielettrici.length})`);
    }
    dielettrici.forEach((d, i) => {
      const dove = `stackup.dielectrics[${i}]`;
      if (typeof d !== "object" || d === null || Array.isArray(d)) {
        errori.push(`${dove}: serve un oggetto {"mm": ...} (facoltativi er, kind, name)`);
        return;
      }
      const o = d as Record<string, unknown>;
      for (const k of Object.keys(o)) {
        if (!CAMPI_DEL_DIELETTRICO.includes(k)) errori.push(`${dove}.${nomeSicuro(k)}: campo sconosciuto (ammessi ${CAMPI_DEL_DIELETTRICO.join(", ")})`);
      }
      if (o.mm === undefined) errori.push(`${dove}.mm: manca, lo spessore in millimetri e' obbligatorio`);
      else spessoreValido(o.mm, `${dove}.mm`, errori);
      if (o.er !== undefined && (typeof o.er !== "number" || !Number.isFinite(o.er) || o.er <= 1)) errori.push(`${dove}.er: deve essere un numero maggiore di 1`);
      if (o.kind !== undefined && !(TIPI_DI_DIELETTRICO as readonly unknown[]).includes(o.kind)) errori.push(`${dove}.kind: deve essere "prepreg" o "core"`);
      if (o.name !== undefined && !nomeDiDielettrico(o.name)) errori.push(`${dove}.name: deve essere un testo da 1 a ${MAX_NOME_DIELETTRICO} caratteri`);
    });
  }
  if (errori.length > 0) return { errori };
  return {
    stackup: {
      copperMm: [...(rame as number[])],
      dielectrics: (dielettrici as Array<Record<string, unknown>>).map((d) => ({
        mm: d.mm as number,
        ...(d.er !== undefined ? { er: d.er as number } : {}),
        ...(d.kind !== undefined ? { kind: d.kind as "prepreg" | "core" } : {}),
        ...(d.name !== undefined ? { name: d.name as string } : {}),
      })),
    },
  };
}

/** what a design-rules.json has under `stackup`, as it is written: undefined when the file has none or cannot be read */
function stackupScritto(content: string | null | undefined): unknown {
  if (!content) return undefined;
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  return (data as Record<string, unknown>).stackup;
}

/** whether a design-rules.json says anything about the stackup, right or wrong */
export function dichiaraUnoStackup(content: string | null | undefined): boolean {
  return stackupScritto(content) !== undefined;
}

/**
 * The stackup a project declares, read from its file map. A file can reach a
 * project without passing through validaFileDelleRegole (an import, a project
 * older than a field), so what is there is checked again: a wrong stackup is
 * not used and the reason is given, never half-read.
 */
export function resolveStackup(fsMap: Record<string, string>): DeclaredStackup {
  const scritto = stackupScritto(fsMap[DESIGN_RULES_PATH]);
  if (scritto === undefined) return {};
  const esito = validaStackup(scritto);
  return "errori" in esito ? { errori: esito.errori } : { stackup: esito.stackup };
}

/**
 * THE STACKUP SURVIVES A REWRITE OF THE RULES.
 *
 * Whoever rewrites design-rules.json from a preset and its rules (the panel of
 * the rules, an Altium import over an existing project) builds the file anew
 * and knows nothing about the stackup: written as built, the file would lose
 * it, in silence, at the first rule saved. `prima` is the file as it was,
 * `nuovo` the one just built: what `prima` had under `stackup` goes into
 * `nuovo` as it was written, right or wrong (a wrong one keeps being said by
 * the panel instead of vanishing). A `prima` that is not JSON has nothing to
 * carry over.
 */
export function conLoStackupDi(prima: string | null | undefined, nuovo: string): string {
  const scritto = stackupScritto(prima);
  if (scritto === undefined) return nuovo;
  let data: unknown;
  try {
    data = JSON.parse(nuovo);
  } catch {
    return nuovo;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data) || "stackup" in data) return nuovo;
  return `${JSON.stringify({ ...data, stackup: scritto }, null, 2)}\n`;
}

/**
 * How deep the upper face of each copper layer lies from the Top face (mm),
 * and the whole thickness: the copper and the dielectrics above a layer, added
 * up. Top is at zero; the total ends under the Bottom copper.
 */
export function quoteDelloStackup(stackup: Stackup): { quoteMm: number[]; totaleMm: number } {
  const quoteMm: number[] = [];
  let z = 0;
  stackup.copperMm.forEach((rame, i) => {
    quoteMm.push(z);
    z += rame + (stackup.dielectrics[i]?.mm ?? 0);
  });
  return { quoteMm, totaleMm: z };
}

/** the fields of a stackup with their limits, for whoever writes the file (the tools' descriptions) */
export function campiDelloStackup(): string {
  return (
    `copperMm [>0..${MAX_SPESSORE_STRATO_MM}, ...] (2+); ` +
    `dielectrics [{mm >0..${MAX_SPESSORE_STRATO_MM}, er >1, kind ${TIPI_DI_DIELETTRICO.join("/")}, name 1..${MAX_NOME_DIELETTRICO} chars}, ...] (one fewer than copperMm)`
  );
}
