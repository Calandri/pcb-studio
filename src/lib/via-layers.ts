/**
 * A THROUGH VIA HAS A PAD ON EVERY INNER LAYER WHERE IT IS CONNECTED.
 *
 * tscircuit writes a through via as `layers: ["top", "bottom"]`, and
 * circuit-json-to-gerber flashes the via pad only on the layers listed. So on
 * the inner layers the drilled barrel met the copper only where a pour
 * happened to cover it. Measured on BIRDY_BAT on 2026-10-20: a via of NetC28_2
 * sitting on the edge of its pour on inner2 kept copper on less than three
 * quarters of its wall (annular ring -0.035 mm).
 *
 * The first fix drew the pad on EVERY inner layer, and the fab's checker
 * (Eurocircuits, same day) answered with 65 annular-ring errors and two
 * clearance errors, all on pads that connect nothing: an unused inner pad is
 * still a ring a fab has to hold, and two of them 0.7 mm apart are 0.197 mm
 * from each other. Altium ("remove unused pads"), KiCad and the fabs themselves
 * keep only the FUNCTIONAL inner pads.
 *
 * So, for the Gerber, a through via gets its pad on an inner layer when it is
 * connected there: it touches a pour of its own net on that layer, or a trace
 * on that layer reaches it (ends on it or runs over it: a via in the middle of a
 * segment is connected too, as one on BIRDY_BAT's inner2 showed). Everywhere else the inner layer keeps only the
 * clearance the pour engine already cuts around the hole.
 */
import { stratiDiRame } from "./strati-rame";

type El = Record<string, unknown> & { type?: unknown };
type Punto = { x: number; y: number };

// the copper layers of a board: one source, strati-rame.ts (kept here for whoever imports it from this file)
export { stratiDiRame };

/** the layers an element lists, as strings */
const elencati = (v: unknown): string[] => (Array.isArray(v) ? (v as unknown[]).map(String) : []);

/**
 * EVERY VIA IS A THROUGH HOLE.
 *
 * PCB Studio has no blind or buried vias: no design rule names them, and the
 * export writes one plated drill file, from top to bottom. A via can still be
 * WRITTEN as if it stopped halfway. tscircuit gives the via of a hand-drawn
 * trace (`<trace pcbPath>`) only the layers between the two it joins, and the
 * hand routes and the variant engine used to write `[from, to]`. Measured on
 * sbb-dl-principale on 2026-11-11: 32 of 253 vias listed `["inner2", "bottom"]`
 * or `["top", "inner1", "inner2"]`. Everything that reads `layers` took them
 * for blind or buried:
 *   - the pours skipped them on the layers they did not list, so the inner1
 *     ground plane had no opening around 20 of those holes (VBUS, VSYS, NRST,
 *     the SD lines: distance 0.000);
 *   - the drill export left all 32 out of the plated file, because it writes
 *     only the holes whose span is the one it is asked for (see
 *     viePerLaForatura): 247 hits where the board has 279 holes.
 * A board that is open without those holes and shorted to ground with them,
 * and the DRC said 0 errors.
 *
 * So every `pcb_via` lists the whole copper stack of its board, as soon as a
 * board is made or changed, before its planes and its checks are computed and
 * before it is saved. `from_layer` and `to_layer` stay as they are: they say
 * which two layers the trace changes between, not how deep the hole goes. A via
 * that already lists every layer is left alone, in the order it has, and a
 * board with nothing to change comes back as the same array.
 *
 * `declared_layers` keeps what the via listed before: it is how the Gerber
 * tells a via completed here from one tscircuit wrote on every layer (see
 * viePassantiSuOgniStrato), and how a recheck tells that a board was poured
 * when its planes could not see the hole (see ricolaSeLeVieEranoParziali).
 */
export function viaPassante(strati: string[], dichiarati: string[]): { layers: string[]; declared_layers: string[] } {
  return { layers: [...strati], declared_layers: dichiarati };
}

export function vieSemprePassanti<T extends El>(circuitJson: T[]): T[] {
  const scheda = circuitJson.find((el) => el.type === "pcb_board") as El | undefined;
  const strati = stratiDiRame(Number(scheda?.num_layers ?? 2));
  let completate = 0;
  const out = circuitJson.map((el) => {
    if (el.type !== "pcb_via") return el;
    const suoi = elencati(el.layers);
    if (strati.every((s) => suoi.includes(s))) return el;
    completate++;
    // what it listed the FIRST time it was completed: a second pass does not overwrite it
    return { ...el, ...viaPassante(strati, Array.isArray(el.declared_layers) ? elencati(el.declared_layers) : suoi) };
  });
  return completate > 0 ? out : circuitJson;
}

/**
 * How many vias were written on part of the stack, counting the ones already
 * completed (`declared_layers`). A plane poured by an engine older than
 * ENGINE_VIE_PASSANTI did not see those holes on the layers they left out.
 */
export function vieDichiarateParziali(circuitJson: El[]): number {
  let n = 0;
  for (const el of circuitJson) {
    if (el.type !== "pcb_via") continue;
    const suoi = elencati(Array.isArray(el.declared_layers) ? el.declared_layers : el.layers);
    if (!(suoi.includes("top") && suoi.includes("bottom"))) n++;
  }
  return n;
}

/**
 * AND THE DRILL FILE DRILLS IT THROUGH.
 *
 * circuit-json-to-gerber files a plated hole under the span its `from_layer`
 * and `to_layer` name (its `layers`, when it has neither), and writes only the
 * holes of the span it is asked for. The export asks for one file, top to
 * bottom, so a via whose trace goes from inner2 to bottom was in no drill file
 * at all: pads in the Gerber and no hole under them. The span of a via is kept
 * on the board, where it says which layers the trace joins; for the drill, and
 * only there, every via goes from top to bottom. A via that already does is not
 * touched, so the drill file of a board with only such vias is the same file.
 */
export function viePerLaForatura<T extends El>(circuitJson: T[]): T[] {
  const estremi = (el: El): string[] =>
    typeof el.from_layer === "string" && typeof el.to_layer === "string" ? [el.from_layer, el.to_layer] : elencati(el.layers);
  let cambiate = 0;
  const out = circuitJson.map((el) => {
    if (el.type !== "pcb_via") return el;
    const suoi = estremi(el);
    // no layer named at all: the exporter already takes it for a through hole
    if (suoi.length === 0 || (suoi.includes("top") && suoi.includes("bottom"))) return el;
    cambiate++;
    return { ...el, from_layer: "top", to_layer: "bottom" };
  });
  return cambiate > 0 ? out : circuitJson;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function dentro(p: Punto, anello: Punto[]): boolean {
  let s = false;
  for (let i = 0, j = anello.length - 1; i < anello.length; j = i++) {
    const a = anello[i];
    const b = anello[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) s = !s;
  }
  return s;
}

function distanzaDalBordo(p: Punto, anello: Punto[]): number {
  let d = Infinity;
  for (let i = 0, j = anello.length - 1; i < anello.length; j = i++) {
    const a = anello[j];
    const b = anello[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
    d = Math.min(d, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
  }
  return d;
}

/** the via's circle and the pour's copper share at least a point */
function toccaColata(p: Punto, raggio: number, forma: { outer_ring?: { vertices?: Punto[] }; inner_rings?: Array<{ vertices?: Punto[] }> }): boolean {
  const fuori = forma.outer_ring?.vertices ?? [];
  if (fuori.length < 3) return false;
  const buchi = (forma.inner_rings ?? []).map((r) => r.vertices ?? []).filter((r) => r.length >= 3);
  const inRame = dentro(p, fuori) && !buchi.some((b) => dentro(p, b));
  if (inRame) return true;
  // centre outside the copper: it still touches when an edge of the copper is within the pad
  return [fuori, ...buchi].some((r) => distanzaDalBordo(p, r) < raggio);
}

export function viePassantiSuOgniStrato<T extends El>(daScheda: T[]): T[] {
  // a board that skipped the step still goes to the fab with through holes: see vieSemprePassanti
  const circuitJson = vieSemprePassanti(daScheda);
  const scheda = circuitJson.find((el) => el.type === "pcb_board") as El | undefined;
  const strati = stratiDiRame(Number(scheda?.num_layers ?? 2));
  const interni = strati.slice(1, -1);
  if (interni.length === 0) return circuitJson;

  const chiaveDiRete = new Map<string, string>();
  for (const el of circuitJson) {
    if (el.type === "source_net" && typeof el.source_net_id === "string") {
      chiaveDiRete.set(el.source_net_id, String(el.subcircuit_connectivity_map_key ?? ""));
    }
  }
  const colate = circuitJson
    .filter((el) => el.type === "pcb_copper_pour" && interni.includes(String(el.layer)))
    .map((el) => ({
      strato: String(el.layer),
      chiave: chiaveDiRete.get(String(el.source_net_id ?? "")) ?? "",
      forma: (el.brep_shape ?? {}) as Parameters<typeof toccaColata>[2],
    }));
  /** the trace copper on the inner layers, segment by segment, with its width */
  const segmenti: Array<{ strato: string; a: Punto; b: Punto; w: number }> = [];
  for (const el of circuitJson) {
    if (el.type !== "pcb_trace" || !Array.isArray(el.route)) continue;
    const route = el.route as Array<Record<string, unknown>>;
    for (let i = 0; i < route.length; i++) {
      const q = route[i];
      const x = num(q.x);
      const y = num(q.y);
      const l = String(q.layer ?? "");
      if (x === null || y === null || !interni.includes(l)) continue;
      const w = num(q.width) ?? 0;
      const n = route[i + 1];
      const nx = n ? num(n.x) : null;
      const ny = n ? num(n.y) : null;
      if (n && nx !== null && ny !== null && String(n.layer ?? "") === l) segmenti.push({ strato: l, a: { x, y }, b: { x: nx, y: ny }, w });
      else segmenti.push({ strato: l, a: { x, y }, b: { x, y }, w });
    }
  }

  return circuitJson.map((el) => {
    if (el.type !== "pcb_via") return el;
    const x = num(el.x);
    const y = num(el.y);
    const r = (num(el.outer_diameter) ?? 0) / 2;
    if (x === null || y === null || !(r > 0)) return el;
    const p = { x, y };
    const chiave = String(el.subcircuit_connectivity_map_key ?? "");
    const collegati = interni.filter(
      (s) =>
        (chiave !== "" && colate.some((c) => c.strato === s && c.chiave === chiave && toccaColata(p, r, c.forma))) ||
        segmenti.some((q) => q.strato === s && distanzaDalBordo(p, [q.a, q.b]) < r + q.w / 2),
    );
    /*
     * Connected on no inner layer. A via whose list was completed here
     * (`declared_layers`) gets its two outer pads and nothing inside, which is
     * what a via written `["top", "bottom"]` has always got. A via that
     * tscircuit itself wrote on every layer is left with the pads it lists,
     * inner ones included: that is what the export has given it since
     * tscircuit started listing the layers between the two ends (67 of the 253
     * vias of sbb-dl-principale, 2026-11-11), and it is kept on purpose: the
     * Gerber of a board whose vias already list every layer must not change
     * with this fix, and one of them is about to be ordered (tm-4l-r3, same
     * day). Those inner pads connect nothing, which is what the fab's checker
     * refused on 2026-10-20: removing them is a change of its own, to be
     * decided when no order is waiting on it.
     */
    if (collegati.length === 0 && !Array.isArray(el.declared_layers)) return el;
    return { ...el, layers: ["top", ...collegati, "bottom"] };
  });
}
