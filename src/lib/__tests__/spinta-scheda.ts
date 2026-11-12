/**
 * THE TEST BOARD OF "SPINGI E SPOSTA", written by hand as a compile writes a
 * board (scheda-di-prova.ts): two layers, 40 x 30 mm with a notch in the top
 * edge, four resistors and a through-hole pin, four nets.
 *
 *        (-20;15)----(-5;15)      (5;15)-----(20;15)
 *            |          |  notch    |           |
 *            |        (-5;11)----(5;11)         |
 *   R1 .1 .2 ==\                          /== .1 .2 R2
 *   | (-15;8)   \___ via ~~~ via ________/   (15;8) |      SIG, y = 6
 *   |                  [keepout, top]   (o) hole    |
 *   +----------- via  GND branch, y = -2            |      AUX, x = 18
 *   |      /----------------------------\           |
 *   |     /            PWR, y = -4       \          |
 *   R3 .1 .2                              .1 .2 R4
 *   | (-15;-8)                  via PWR  (15;-8)
 *   +--------------(J1)        (6;-9)
 *            |   (0;-11)                        |
 *        (-20;-15)--------------------------(20;-15)
 *
 * What is on it, and why:
 *   - SIG: from R1.2 to R2.1 with two stretches at 45 degrees and two vias in
 *     its path (it runs on the bottom between them);
 *   - GND: from R1.1 down the left side to R3.1, a branch that leaves it at a
 *     T junction and ends on a lone via, and a trace from R3.1 to the plated
 *     hole of J1;
 *   - PWR: from R3.2 to R4.1 with two stretches at 45 degrees, and a lone via
 *     no trace reaches;
 *   - AUX: from R2.2 down the right side to R4.2, 2 mm from the edge;
 *   - a keepout of the top layer, a bare hole, the notch.
 * Every trace is 0.2 mm wide and leaves its pads straight; the board breaks no
 * rule of the default set (JLCPCB standard, drawn at 0.2 mm).
 */
import { resolveDesignRules } from "@/lib/design-rules";
import { emptyManualEdits, type ManualEdits } from "@/lib/manual-edits";
import { applyManualRoutes, parseManualRoutes, type ManualRoutePoint } from "@/lib/manual-routes";
import { pezzo, piedinoPassante, rete, scheda, trace, wire, type El } from "./scheda-di-prova";

export const REGOLE = resolveDesignRules({}).rules;

export const CONTORNO = [
  { x: -20, y: -15 },
  { x: 20, y: -15 },
  { x: 20, y: 15 },
  { x: 5, y: 15 },
  { x: 5, y: 11 },
  { x: -5, y: 11 },
  { x: -5, y: 15 },
  { x: -20, y: 15 },
];

/** a via as a compile writes it: through the board, with the key of its net (`n`) and what `pcb_trace_id` says of it */
export const viaDi = (id: string, x: number, y: number, n: number, di: string = `source_net_${n}`): El => ({
  type: "pcb_via",
  pcb_via_id: id,
  x,
  y,
  outer_diameter: 0.6,
  hole_diameter: 0.3,
  layers: ["top", "bottom"],
  from_layer: "top",
  to_layer: "bottom",
  subcircuit_connectivity_map_key: `chiave_${n}`,
  pcb_trace_id: di,
});

/** the point of a route where the trace goes through a via */
export const cambio = (x: number, y: number, da = "top", a = "bottom") => ({ route_type: "via", x, y, from_layer: da, to_layer: a });

export const SIG = ".R1 > .2 to net.SIG";
export const GND = ".R1 > .1 to net.GND";
export const GND_RAMO = ".R3 > .1 to net.GND";
export const GND_J1 = ".J1 > .1 to net.GND";
export const PWR = ".R3 > .2 to net.PWR";
export const AUX = ".R2 > .2 to net.AUX";

/** the parts and the nets, with no copper */
export const pezziEReti = (): El[] => [
  ...pezzo("R1", [["1", -15, 8], ["2", -14, 8]]),
  ...pezzo("R2", [["1", 15, 8], ["2", 16, 8]]),
  ...pezzo("R3", [["1", -15, -8], ["2", -14, -8]]),
  ...pezzo("R4", [["1", 15, -8], ["2", 16, -8]]),
  ...piedinoPassante("J1", "1", 0, -11),
  ...rete(1, "GND", ["R1_1", "R3_1", "J1_1"]),
  ...rete(2, "SIG", ["R1_2", "R2_1"]),
  ...rete(3, "PWR", ["R3_2", "R4_1"]),
  ...rete(4, "AUX", ["R2_2", "R4_2"]),
];

export const ilContorno = (): El => ({ ...scheda(2), width: 40, height: 30, outline: CONTORNO });

/** the copper of the board, piece by piece: a test takes one out or writes it another way */
export const rameDiSerie = (): Record<string, El> => ({
  t_sig: trace("t_sig", "st_SIG_0", [
    wire(-14, 8), wire(-12, 8), wire(-10, 6), wire(-4, 6),
    cambio(-4, 6), wire(-4, 6, "bottom"), wire(4, 6, "bottom"), cambio(4, 6, "bottom", "top"),
    wire(4, 6), wire(10, 6), wire(12, 8), wire(15, 8),
  ]),
  v_sig_a: viaDi("v_sig_a", -4, 6, 2, "t_sig"),
  v_sig_b: viaDi("v_sig_b", 4, 6, 2, "t_sig"),
  t_gnd: trace("t_gnd", "st_GND_0", [wire(-15, 8), wire(-17, 8), wire(-17, -8), wire(-15, -8)]),
  t_gnd_ramo: trace("t_gnd_ramo", "st_GND_1", [wire(-17, -2), wire(-8, -2)]),
  v_gnd: viaDi("v_gnd", -8, -2, 1),
  t_gnd_j1: trace("t_gnd_j1", "st_GND_2", [wire(-15, -8), wire(-15, -11), wire(0, -11)]),
  t_pwr: trace("t_pwr", "st_PWR_0", [wire(-14, -8), wire(-14, -6), wire(-12, -4), wire(8, -4), wire(12, -8), wire(15, -8)]),
  v_pwr: viaDi("v_pwr", 6, -9, 3),
  t_aux: trace("t_aux", "st_AUX_0", [wire(16, 8), wire(18, 8), wire(18, -8), wire(16, -8)]),
  keepout: { type: "pcb_keepout", pcb_keepout_id: "zona_1", shape: "rect", center: { x: 0, y: 1.5 }, width: 6, height: 2, layers: ["top"] },
  foro: { type: "pcb_hole", pcb_hole_id: "foro_1", hole_shape: "circle", hole_diameter: 1, x: 10, y: 1 },
});

/**
 * THREE TRACES WITH A STRETCH OFF ITS DIRECTION BY A HAIR, as the sources of a
 * real board write them (a stretch at 45 degrees with its ends rounded): by two
 * tenths of a micron on SIG, by one on PWR, twice, and by a whole micron, the
 * most that still has a direction, on AUX. To hand to schedaDiSpinta.
 */
export const rameQuasiEsatto = (): Record<string, El> => ({
  t_sig: trace("t_sig", "st_SIG_0", [
    wire(-14, 8), wire(-12, 8), wire(-10.0002, 6), wire(-4, 6),
    cambio(-4, 6), wire(-4, 6, "bottom"), wire(4, 6, "bottom"), cambio(4, 6, "bottom", "top"),
    wire(4, 6), wire(10, 6), wire(12, 8), wire(15, 8),
  ]),
  t_pwr: trace("t_pwr", "st_PWR_0", [wire(-14, -8), wire(-14, -6), wire(-12, -4.0001), wire(8, -4.0001), wire(12, -8), wire(15, -8)]),
  t_aux: trace("t_aux", "st_AUX_0", [wire(16, 8), wire(18.001, 8), wire(18, -8), wire(16, -8)]),
});

/** the test board; `rame` replaces or adds pieces of copper by their name, `null` takes one out */
export function schedaDiSpinta(rame: Record<string, El | null> = {}): El[] {
  const pezzi: Record<string, El | null> = { ...rameDiSerie(), ...rame };
  return [ilContorno(), ...pezziEReti(), ...Object.values(pezzi).filter((e): e is El => e !== null)];
}

const su = (x: number, y: number): ManualRoutePoint => ({ x, y, layer: "top" });
const sotto = (x: number, y: number): ManualRoutePoint => ({ x, y, layer: "bottom" });

/**
 * THE SAME COPPER AS HAND ROUTES, written as another CAD writes the copper of
 * a net: pieces of two, three or four points chained end to end, and every via
 * a route of its own (two points in one place on two layers, with its size).
 * SIG, GND and PWR are hand copper; AUX and the lone via of PWR stay copper of
 * the files, so that one board has both.
 */
export const routeAMano = (quasi = false) => {
  const pezzoDi = (net: string, points: ManualRoutePoint[], altro: Record<string, unknown> = {}) => ({ connection: `net.${net}`, net, width: 0.2, points, ...altro });
  const viaDella = (net: string, x: number, y: number) => pezzoDi(net, [su(x, y), sotto(x, y)], { viaDiameter: 0.6, viaHoleDiameter: 0.3 });
  return parseManualRoutes([
    pezzoDi("SIG", [su(-14, 8), su(-12, 8)]),
    pezzoDi("SIG", [su(-12, 8), su(-10, 6)]),
    pezzoDi("SIG", [su(-10, 6), su(-4, 6)]),
    viaDella("SIG", -4, 6),
    pezzoDi("SIG", [sotto(-4, 6), sotto(4, 6)]),
    viaDella("SIG", 4, 6),
    pezzoDi("SIG", [su(4, 6), su(10, 6), su(12, 8), su(15, 8)]),
    pezzoDi("GND", [su(-15, 8), su(-17, 8)]),
    pezzoDi("GND", [su(-17, 8), su(-17, -8)]),
    pezzoDi("GND", [su(-17, -8), su(-15, -8)]),
    // the branch: it leaves the side at a T junction and ends on a via
    pezzoDi("GND", [su(-17, -2), su(-8, -2)]),
    viaDella("GND", -8, -2),
    pezzoDi("GND", [su(-15, -8), su(-15, -11), su(0, -11)]),
    pezzoDi("PWR", [su(-14, -8), su(-14, -6), su(-12, -4)]),
    pezzoDi("PWR", [su(-12, -4), su(8, -4)]),
    // `quasi`: its stretch at 45 degrees off by a micron, the most that still has a direction
    pezzoDi("PWR", [su(8, -4), su(quasi ? 12.001 : 12, -8), su(15, -8)]),
  ]);
};

/** the test board with its copper as hand routes: the saved board, and the file that lays it */
export function schedaAMano(quasi = false): { scheda: El[]; edits: ManualEdits } {
  const { t_aux, v_pwr, keepout, foro } = { ...rameDiSerie(), ...(quasi ? rameQuasiEsatto() : {}) };
  const edits = { ...emptyManualEdits(), pcb_routes: routeAMano(quasi) };
  const posata = applyManualRoutes({
    circuitJson: [ilContorno(), ...pezziEReti(), t_aux, v_pwr, keepout, foro],
    routes: edits.pcb_routes,
    vias: [],
    viaDiameter: REGOLE.minViaDiameterMm,
    viaHoleDiameter: REGOLE.minViaHoleMm,
  });
  return { scheda: posata.circuitJson as El[], edits };
}

/** a generator of numbers in [0, 1) that gives the same run from the same seed (mulberry32) */
export function casuale(seme: number): () => number {
  let a = seme >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
