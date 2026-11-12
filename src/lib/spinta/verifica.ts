/**
 * IS THIS COPPER GOOD FOR THIS BOARD? The corrections of the files' copper a
 * gesture makes (a route with `replaces`, a moved via) are checked here before
 * they are written: by the server, which does not trust what the viewer sends,
 * on the saved board.
 *
 * Two questions, in order:
 *   - is it written right (leggiRame): the limits of one save, numbers that
 *     are numbers, names that are names. Anything else is refused with the
 *     reason, never read around;
 *   - is it right for the board (verificaRame): every stretch at 0, 45 or 90
 *     degrees and longer than nothing, the copper it starts from still on the
 *     board, and no distance broken that held before.
 *
 * The distances are the ones of the DRC (runDrcChecks), run on the board
 * before and after: there is no second way of measuring here.
 */
import type { DesignRules } from "../design-rules";
import { runDrcChecks, type DrcViolation } from "../drc";
import { RETE_SCRIVIBILE } from "../ground-stitching-file";
import { retiDelCircuito } from "../gruppi-di-rame";
import { applyCopperPatch, type CopperPatch, type ManualEdits, type PercorsoRiscritto } from "../manual-edits";
import {
  applyManualRoutes,
  manualRouteKey,
  partenzaRicordata,
  percorsoDellaPista,
  ROUTE_LIMITS,
  round4,
  statoDelRame,
  stessoPercorso,
  viaMoveKey,
  type ManualRoute,
  type ManualRoutePoint,
  type ManualViaMove,
} from "../manual-routes";
import { isValidSelector } from "../schematic-connect";
import { eStratoDiRame } from "../strati-rame";
import { inUnita } from "./geometria";

type El = Record<string, unknown>;

/** what one save of copper may carry (Security, point 2 of the plan) */
export interface LimitiDelRame {
  /** the routes that correct the files and the hand routes rewritten, together */
  maxRoutes: number;
  /** the points of all its routes together, and as many again for their starting paths */
  maxPoints: number;
  maxVias: number;
}

/** how long the key of a route can be: two pad selectors of 200 and what joins them, with room */
const CHIAVE_MASSIMA = 500;

const finito = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * A coordinate of a board, or why it is not one. `alMicron`: on the grid of
 * 0.001 mm a hand route is read on, and one that is off it is refused, not
 * rounded: the file would read it back at another place than the one checked.
 */
function coordinata(v: unknown, alMicron = false): number | string {
  if (!finito(v)) return "una coordinata non e' un numero finito";
  if (Math.abs(v) > ROUTE_LIMITS.maxCoordMm) return `una coordinata e' oltre ${ROUTE_LIMITS.maxCoordMm} mm`;
  if (!alMicron) return round4(v);
  const millesimi = Math.round(v * 1000);
  // what a sum of floats leaves between two numbers meant equal, not a tenth of a micron
  if (Math.abs(v * 1000 - millesimi) > 1e-6) return "una coordinata non e' sulla griglia di 0.001 mm";
  return millesimi / 1000;
}

/**
 * The points of a path as they were sent, to 0.0001 mm (or on the grid of
 * 0.001 mm, see coordinata). Nothing is dropped: two equal points in a row
 * are a stretch of no length, and that is for verificaRame to refuse, not for
 * the reading to hide.
 */
function punti(v: unknown, alMicron = false): ManualRoutePoint[] | string {
  if (!Array.isArray(v)) return "i punti non sono una lista";
  const out: ManualRoutePoint[] = [];
  for (const [i, p] of v.entries()) {
    if (typeof p !== "object" || p === null) return `il punto ${i + 1} non e' un punto`;
    const q = p as Record<string, unknown>;
    const x = coordinata(q.x, alMicron);
    const y = coordinata(q.y, alMicron);
    if (typeof x === "string") return `punto ${i + 1}: ${x}`;
    if (typeof y === "string") return `punto ${i + 1}: ${y}`;
    if (!eStratoDiRame(q.layer)) return `punto ${i + 1}: lo strato non e' uno strato di rame`;
    out.push({ x, y, layer: q.layer });
  }
  return out;
}

export const larghezza = (v: unknown): number | string =>
  finito(v) && v >= ROUTE_LIMITS.minWidthMm && v <= ROUTE_LIMITS.maxWidthMm
    ? v
    : `la larghezza deve stare fra ${ROUTE_LIMITS.minWidthMm} e ${ROUTE_LIMITS.maxWidthMm} mm`;

/** the ring and the hole of a via, or why they are not ones */
export function misureDellaVia(corona: unknown, foro: unknown): { corona: number; foro: number } | string {
  if (!finito(corona) || corona < ROUTE_LIMITS.minViaMm || corona > ROUTE_LIMITS.maxViaMm) {
    return `il diametro della via deve stare fra ${ROUTE_LIMITS.minViaMm} e ${ROUTE_LIMITS.maxViaMm} mm`;
  }
  if (!finito(foro) || foro < ROUTE_LIMITS.minViaHoleMm || foro >= corona) {
    return `il foro della via deve stare fra ${ROUTE_LIMITS.minViaHoleMm} mm e il suo diametro`;
  }
  return { corona, foro };
}

/** ".U9 > .pin1 to .USB1 > .pin35", ".R1 > .pin1 to net.GND": two selectors, by part and pin or by net, never an id */
export function connessioneScritta(v: unknown): v is string {
  if (typeof v !== "string" || v.length > 300) return false;
  const capi = v.split(" to ");
  return capi.length === 2 && capi.every((c) => c === c.trim() && isValidSelector(c));
}

/**
 * Reads the copper of one save: the corrections of one gesture, as the action
 * `copper` of /api/manual-edits receives them. Everything is checked and the
 * first thing wrong is said; nothing is clamped or left out in silence, since
 * what is written here wins over the files.
 *
 * Every correction read carries the gesture of the save and the instant
 * `quando`: one drag is one gesture, undone, released and copied as one.
 *
 * `riscritte` are the hand routes of the file the gesture moved (see
 * PercorsoRiscritto): for each the key it has in the file and its new path,
 * and nothing else. An entry that carries anything more is refused: what the
 * route is comes from the file, never from the page. They are read as
 * strictly as the corrections, on the grid of 0.001 mm the hand routes are
 * read on, and count with them in the limits of the save. Whether the file
 * holds a route of that key is asked of the file, by verificaRame.
 */
export function leggiRame(
  corpo: { routes?: unknown; vias?: unknown; riscritte?: unknown; gesto?: unknown },
  limiti: LimitiDelRame,
  quando: string,
): { rame: CopperPatch } | { errore: string } {
  const gesto = corpo.gesto;
  if (typeof gesto !== "string" || !/^[\w-]{1,64}$/.test(gesto)) {
    return { errore: "manca il gesto, o non e' un nome (lettere, cifre, _ e -, al piu' 64)" };
  }
  const routesRaw = corpo.routes ?? [];
  const viasRaw = corpo.vias ?? [];
  const riscritteRaw = corpo.riscritte ?? [];
  if (!Array.isArray(routesRaw) || !Array.isArray(viasRaw)) return { errore: "piste e vie devono essere due liste" };
  if (!Array.isArray(riscritteRaw)) return { errore: "le piste riscritte devono essere una lista" };
  if (routesRaw.length + riscritteRaw.length > limiti.maxRoutes) return { errore: `troppe piste in un salvataggio (massimo ${limiti.maxRoutes})` };
  if (viasRaw.length > limiti.maxVias) return { errore: `troppe vie in un salvataggio (massimo ${limiti.maxVias})` };
  if (routesRaw.length === 0 && viasRaw.length === 0 && riscritteRaw.length === 0) return { errore: "nessuna correzione da salvare" };

  const routes: ManualRoute[] = [];
  let quanti = 0;
  let quantiDiPartenza = 0;
  for (const [i, item] of routesRaw.entries()) {
    const dove = `pista ${i + 1}`;
    if (typeof item !== "object" || item === null) return { errore: `${dove}: non e' una pista` };
    const r = item as Record<string, unknown>;
    if (!connessioneScritta(r.connection)) {
      return { errore: `${dove}: la connessione va scritta con pezzo e piedino, o con la rete (".U9 > .pin1 to .USB1 > .pin35", ".R1 > .pin1 to net.GND")` };
    }
    if (typeof r.replaces !== "object" || r.replaces === null) {
      return { errore: `${dove}: manca la pista di partenza (replaces): qui si salvano solo correzioni del rame dei file` };
    }
    const s = r.replaces as Record<string, unknown>;
    const original = punti(s.original);
    if (typeof original === "string") return { errore: `${dove}, pista di partenza: ${original}` };
    if (original.length < 2) return { errore: `${dove}: la pista di partenza ha meno di due punti` };
    const larghezzaDiPartenza = larghezza(s.width);
    if (typeof larghezzaDiPartenza === "string") return { errore: `${dove}, pista di partenza: ${larghezzaDiPartenza}` };
    // with no points of its own it only takes the trace of the files out
    const suoi = punti(r.points ?? []);
    if (typeof suoi === "string") return { errore: `${dove}: ${suoi}` };
    if (suoi.length === 1) return { errore: `${dove}: un punto solo non e' una pista` };
    const larga = larghezza(r.width);
    if (typeof larga === "string") return { errore: `${dove}: ${larga}` };
    quanti += suoi.length;
    quantiDiPartenza += original.length;
    if (quanti > limiti.maxPoints || quantiDiPartenza > limiti.maxPoints) {
      return { errore: `troppi punti in un salvataggio (massimo ${limiti.maxPoints})` };
    }
    let via: { viaDiameter: number; viaHoleDiameter: number } | null = null;
    if (r.viaDiameter !== undefined || r.viaHoleDiameter !== undefined) {
      const misure = misureDellaVia(r.viaDiameter, r.viaHoleDiameter);
      if (typeof misure === "string") return { errore: `${dove}: ${misure}` };
      via = { viaDiameter: misure.corona, viaHoleDiameter: misure.foro };
    }
    routes.push({
      connection: r.connection,
      points: suoi,
      width: larga,
      ...(via ?? {}),
      replaces: { original, width: larghezzaDiPartenza },
      gesto,
      at: quando,
    });
  }

  const vias: ManualViaMove[] = [];
  for (const [i, item] of viasRaw.entries()) {
    const dove = `via ${i + 1}`;
    if (typeof item !== "object" || item === null) return { errore: `${dove}: non e' una via` };
    const r = item as Record<string, unknown>;
    if (typeof r.net !== "string" || r.net.length > 200 || !RETE_SCRIVIBILE.test(r.net)) {
      return { errore: `${dove}: la rete va scritta col suo nome (lettere, cifre e _)` };
    }
    const capi: Array<{ x: number; y: number }> = [];
    for (const capo of [r.from, r.to]) {
      const q = (typeof capo === "object" && capo !== null ? capo : {}) as Record<string, unknown>;
      const x = coordinata(q.x);
      const y = coordinata(q.y);
      if (typeof x === "string") return { errore: `${dove}: ${x}` };
      if (typeof y === "string") return { errore: `${dove}: ${y}` };
      capi.push({ x, y });
    }
    const [from, to] = capi;
    if (from.x === to.x && from.y === to.y) return { errore: `${dove}: non si sposta` };
    const misure = misureDellaVia(r.outerDiameter, r.holeDiameter);
    if (typeof misure === "string") return { errore: `${dove}: ${misure}` };
    if (!Array.isArray(r.layers) || r.layers.length < 2 || r.layers.length > 8 || !r.layers.every(eStratoDiRame) || new Set(r.layers).size !== r.layers.length) {
      return { errore: `${dove}: gli strati vanno scritti tutti, ognuno una volta` };
    }
    vias.push({ net: r.net, from, to, holeDiameter: misure.foro, outerDiameter: misure.corona, layers: [...r.layers], gesto, at: quando });
  }

  const riscritte: PercorsoRiscritto[] = [];
  for (const [i, item] of riscritteRaw.entries()) {
    const dove = `pista riscritta ${i + 1}`;
    if (typeof item !== "object" || item === null || Array.isArray(item)) return { errore: `${dove}: non e' una pista riscritta` };
    const voce = item as Record<string, unknown>;
    const inPiu = Object.keys(voce).filter((k) => k !== "chiave" && k !== "points");
    if (inPiu.length > 0) {
      return { errore: `${dove}: porta solo la chiave e i punti, il resto della pista e' quello del file (in piu': ${inPiu.slice(0, 5).join(", ").slice(0, 80)})` };
    }
    if (typeof voce.chiave !== "string" || voce.chiave === "" || voce.chiave.length > CHIAVE_MASSIMA) {
      return { errore: `${dove}: manca la chiave che la pista ha nel file` };
    }
    // one route of the file, one new path: of two, which one stays would depend on how its key is made
    if (riscritte.some((altra) => altra.chiave === voce.chiave)) return { errore: `${dove}: la stessa pista del file e' riscritta due volte` };
    const suoi = punti(voce.points, true);
    if (typeof suoi === "string") return { errore: `${dove}: ${suoi}` };
    if (suoi.length < 2) return { errore: `${dove}: una pista ha almeno due punti` };
    quanti += suoi.length;
    if (quanti > limiti.maxPoints) return { errore: `troppi punti in un salvataggio (massimo ${limiti.maxPoints})` };
    riscritte.push({ chiave: voce.chiave, points: suoi, gesto, at: quando });
  }
  return { rame: { routes, vias, ...(riscritte.length > 0 ? { riscritte } : {}) } };
}

/** a tenth of a micron, as a whole number: the direction of a stretch is judged on these, with no rounding left to argue */
const intero = inUnita;
const posto = (p: { x: number; y: number }): string => `(${round4(p.x)}; ${round4(p.y)})`;

/** one step of a path, between two points in a row: the same whichever way it is walked */
function passo(a: ManualRoutePoint, b: ManualRoutePoint): string {
  const [p, q] = [`${intero(a.x)},${intero(a.y)},${a.layer}`, `${intero(b.x)},${intero(b.y)},${b.layer}`].sort();
  return `${p}|${q}`;
}

/** every step of a path, on the grid of a gesture: what a route had before it was moved */
export function passiDi(points: readonly ManualRoutePoint[]): Set<string> {
  const out = new Set<string>();
  for (let i = 1; i < points.length; i++) out.add(passo(points[i - 1], points[i]));
  return out;
}

/**
 * Every stretch of a route goes at 0, 45 or 90 degrees and has a length: on
 * whole tenths of a micron `dx == 0 || dy == 0 || |dx| == |dy|`, and not both
 * zero. A change of layer is a via: it happens in one place. Null when the
 * route is good, else what is wrong with it.
 *
 * `dati` are the steps the route already had (passiDi of the route as it was):
 * they are not judged. A hand route imported from another CAD may hold
 * stretches at any angle, and those are a given: a gesture answers for the
 * stretches it lays, not for the ones it left where they were.
 */
export function trattiStorti(route: ManualRoute, dati?: ReadonlySet<string>): string | null {
  /*
   * A correction of the files' copper says itself what it started from
   * (`replaces.original`): the stretches it leaves where the files put them
   * are a given too. The sources write a diagonal with its ends rounded, and
   * one tenth of a micron off 45 degrees is how a quarter of the traces of
   * sbb-dl-principale come out (41 of 155, 2026-11-12).
   */
  const lasciati = dati ?? (route.replaces ? passiDi(route.replaces.original) : undefined);
  for (let i = 1; i < route.points.length; i++) {
    const a = route.points[i - 1];
    const b = route.points[i];
    if (lasciati?.has(passo(a, b))) continue;
    const dx = intero(b.x) - intero(a.x);
    const dy = intero(b.y) - intero(a.y);
    if (a.layer !== b.layer) {
      if (dx !== 0 || dy !== 0) return `cambia strato fra ${posto(a)} e ${posto(b)}: una via sta in un punto solo`;
      continue;
    }
    if (dx === 0 && dy === 0) return `ha un tratto di lunghezza zero in ${posto(a)}`;
    if (dx !== 0 && dy !== 0 && Math.abs(dx) !== Math.abs(dy)) {
      return `il tratto da ${posto(a)} a ${posto(b)} non e' a 0, 45 o 90 gradi`;
    }
  }
  return null;
}

/** the checks of the DRC that measure a distance between copper, holes and the edge; the pours are apart (see verificaRame) */
const REGOLE_DI_DISTANZA = new Set(["pad_clearance", "trace_pad_clearance", "trace_trace_clearance", "board_edge_clearance", "hole_to_hole"]);

interface Distanze {
  quante: number;
  /** where, when every occurrence still has its point (the DRC keeps the first 200 of a rule) */
  punti: Set<string> | null;
  esempi: DrcViolation[];
}

function distanzeRotte(violazioni: DrcViolation[]): Map<string, Distanze> {
  const out = new Map<string, Distanze>();
  for (const v of violazioni) {
    if (!REGOLE_DI_DISTANZA.has(v.rule)) continue;
    const d = out.get(v.rule) ?? { quante: 0, punti: new Set<string>(), esempi: [] };
    const quante = v.count ?? 1;
    d.quante += quante;
    d.esempi.push(v);
    if (d.punti && (v.points?.length ?? 0) >= quante) {
      for (const p of v.points ?? []) d.punti.add(`${Math.round(p.x * 1000)},${Math.round(p.y * 1000)},${p.layer ?? ""}`);
    } else {
      d.punti = null;
    }
    out.set(v.rule, d);
  }
  return out;
}

/** the first distance broken after that was not broken before, in the words of the DRC; null when there is none */
function distanzaNuova(prima: DrcViolation[], dopo: DrcViolation[]): string | null {
  const eraRotto = distanzeRotte(prima);
  for (const [regola, ora] of distanzeRotte(dopo)) {
    const era = eraRotto.get(regola);
    if (!era || ora.quante > era.quante) return ora.esempi[0].message;
    if (!ora.punti || !era.punti) continue;
    // as many as before, but elsewhere: the copper stopped breaking one distance and broke another
    for (const v of ora.esempi) {
      for (const p of v.points ?? []) {
        if (!era.punti.has(`${Math.round(p.x * 1000)},${Math.round(p.y * 1000)},${p.layer ?? ""}`)) return v.message;
      }
    }
  }
  return null;
}

export type EsitoDelRame =
  | { ok: true }
  /** `cambiata`: the copper the gesture started from is not on the saved board, which is not the one the person was looking at */
  | { ok: false; motivo: string; cambiata?: true };

/**
 * Whether the copper of a save is good for the saved board.
 *
 *   1. every stretch at 0, 45 or 90 degrees, and none of no length;
 *   2. what each correction starts from is on the board as the gesture saw
 *      it: the trace of that connection on that path, the via of that net in
 *      that place, of that size. If it is not, the board changed after the
 *      gesture (a compile, another save) and the copper was solved against
 *      something that is gone;
 *   3. laid on the board, by the same hand that will lay it (applyManualRoutes),
 *      it breaks no distance that held before: the DRC is run on the board
 *      with the corrections the file has now and on the board of the file as
 *      the save leaves it, and the two are compared. A distance already broken
 *      elsewhere is not this copper's fault and does not stop it.
 *
 * A HAND ROUTE REWRITTEN (`rame.riscritte`) is judged the same way, with what
 * is its own: its start is the route the file holds under the key named
 * (gone, the file changed after the gesture); a correction and a curve are
 * not rewritten; and only the stretches the gesture laid answer for their
 * direction (see trattiStorti).
 *
 * TWO KINDS OF SAVE. A gesture (`copper`) writes its corrections INTO the
 * file: the file it leaves is `correnti` with `rame` in it. A save of the
 * whole file (`set`, the undo history) replaces it: `rame` is then the
 * corrections the file did not hold as they are, and `finale` the file as
 * asked for, which may also have dropped some. The copper is judged on the
 * board of THAT file: an undo of a drag that pushed a second trace brings the
 * first back where the second, back in its own place, leaves it room, and
 * judged next to the pushed one it would be refused for a distance the board
 * it asks for does not break.
 *
 * The pours are not measured: the fast update never pours, so copper moved
 * into an old pour is said after the save and stops the export until a
 * compile pours again (colateSopraIlRame), which is the rule of the plan.
 */
export function verificaRame(args: {
  /** the saved board */
  circuitJson: unknown[];
  regole: DesignRules;
  /** manual-edits.json as it is now */
  correnti: ManualEdits;
  /** the corrections that enter the file with this save: read by leggiRame, or picked by correzioniNuove */
  rame: CopperPatch;
  /** the file as the save leaves it, when it replaces the whole file; absent, `correnti` with `rame` written into it */
  finale?: ManualEdits;
}): EsitoDelRame {
  const { circuitJson, regole, correnti, rame, finale } = args;
  for (const route of rame.routes) {
    const storto = trattiStorti(route);
    if (storto) return { ok: false, motivo: `la pista ${route.connection} ${storto}` };
  }

  for (const { chiave, points } of rame.riscritte ?? []) {
    const era = correnti.pcb_routes.find((r) => manualRouteKey(r) === chiave);
    if (!era) {
      return {
        ok: false,
        motivo: `la pista a mano ${chiave.slice(0, 120)} non e' piu' nel file come il gesto l'ha presa: la scheda salvata e' cambiata dopo il gesto, ricaricala e rifallo`,
        cambiata: true,
      };
    }
    if (era.replaces) return { ok: false, motivo: `la pista ${era.connection} e' una correzione del rame dei file: si corregge di nuovo, non si riscrive` };
    if (era.arco) return { ok: false, motivo: `la pista ${era.connection} e' una curva: non si sposta` };
    const storto = trattiStorti({ ...era, points }, passiDi(era.points));
    if (storto) return { ok: false, motivo: `la pista ${era.connection} ${storto}` };
  }

  const scheda = circuitJson as El[];
  const mancante = partenzaMancante(scheda, correnti, rame);
  if (mancante) return { ok: false, motivo: `${mancante}: la scheda salvata e' cambiata dopo il gesto, ricaricala e rifallo`, cambiata: true };

  // what the file will hold, and in it each correction that enters: a trace moved again keeps the key of its first move
  const scritte = finale ? null : applyCopperPatch(correnti, rame);
  const lasciato = finale ?? scritte!.edits;
  const entrate = scritte?.added ?? rame;
  const stato = statoDelRame(scheda, lasciato.pcb_routes, lasciato.pcb_vias);
  const nonPosate = new Set([...stato.orfane.routes, ...stato.orfane.vias, ...stato.assorbite.routes, ...stato.assorbite.vias]);
  const persa =
    entrate.routes.find((r) => nonPosate.has(manualRouteKey(r)))?.connection ??
    entrate.vias.map((v) => (nonPosate.has(viaMoveKey(v)) ? `la via di ${v.net} in ${posto(v.from)}` : null)).find((v) => v !== null);
  if (persa) return { ok: false, motivo: `${persa} non verrebbe posata sulla scheda salvata: la scheda e' cambiata dopo il gesto, ricaricala e rifallo`, cambiata: true };

  const vie = { viaDiameter: regole.minViaDiameterMm, viaHoleDiameter: regole.minViaHoleMm };
  const dopo = applyManualRoutes({ circuitJson, routes: lasciato.pcb_routes, vias: lasciato.pcb_vias, ...vie });
  const rotteDopo = runDrcChecks(dopo.circuitJson as never, regole);
  // nothing broken at all: no need to know how the board stood before
  if (distanzeRotte(rotteDopo).size === 0) return { ok: true };
  const prima = applyManualRoutes({ circuitJson, routes: correnti.pcb_routes, vias: correnti.pcb_vias, ...vie });
  const nuova = distanzaNuova(runDrcChecks(prima.circuitJson as never, regole), rotteDopo);
  return nuova ? { ok: false, motivo: `il rame viola una distanza che prima era rispettata: ${nuova}` } : { ok: true };
}

/**
 * The first correction whose start is not on the saved board, in words; null
 * when every one of them starts from something that is there. The start can
 * be the copper of the files, the copper an earlier correction laid (the
 * person moves it again), or a correction saved a moment ago that the board
 * does not show yet (two drags in a row: the fast update of the first is
 * still running).
 */
function partenzaMancante(scheda: El[], correnti: ManualEdits, rame: CopperPatch): string | null {
  if (rame.routes.length > 0) {
    const nome = new Map<string, string>();
    for (const e of scheda) {
      if (e.type === "source_trace" && typeof e.source_trace_id === "string" && typeof e.display_name === "string") {
        nome.set(e.source_trace_id, e.display_name);
      }
    }
    const piste = scheda.filter((e) => e.type === "pcb_trace");
    for (const route of rame.routes) {
      const da = route.replaces!.original;
      const sullaScheda = piste.some((e) => {
        if (nome.get(String(e.source_trace_id ?? "")) !== route.connection) return false;
        const ricordata = partenzaRicordata(e);
        return stessoPercorso(percorsoDellaPista(e), da) || (ricordata !== null && stessoPercorso(ricordata, da));
      });
      const nelFile = correnti.pcb_routes.some(
        (r) => r.replaces && r.connection === route.connection && (stessoPercorso(r.points, da) || stessoPercorso(r.replaces.original, da)),
      );
      if (!sullaScheda && !nelFile) return `la pista ${route.connection} non e' piu' dove il gesto l'ha presa`;
    }
  }
  if (rame.vias.length > 0) {
    const reti = retiDelCircuito(scheda);
    const vie = scheda.filter((e) => e.type === "pcb_via");
    const li = (v: unknown, dove: { x: number; y: number }): boolean => {
      const q = (typeof v === "object" && v !== null ? v : {}) as Record<string, unknown>;
      return finito(q.x) && finito(q.y) && round4(q.x) === dove.x && round4(q.y) === dove.y;
    };
    for (const via of rame.vias) {
      const sua = vie.find((e) => {
        if (!li(e, via.from) && !li(e.moved_from, via.from)) return false;
        const rete = reti.diVia(e as never);
        return rete !== null && reti.nome(rete) === via.net;
      });
      if (sua) {
        const stessa = (a: unknown, b: number) => finito(a) && Math.abs(a - b) < 0.001;
        if (!stessa(sua.outer_diameter, via.outerDiameter) || !stessa(sua.hole_diameter, via.holeDiameter)) {
          return `la via di ${via.net} in ${posto(via.from)} non ha piu' le misure che il gesto ha letto`;
        }
        continue;
      }
      const nelFile = correnti.pcb_vias.some(
        (v) => v.net === via.net && ((v.to.x === via.from.x && v.to.y === via.from.y) || (v.from.x === via.from.x && v.from.y === via.from.y)),
      );
      if (!nelFile) return `la via di ${via.net} non e' piu' in ${posto(via.from)}`;
    }
  }
  return null;
}
