import {
  convertCircuitJsonToInputProblem,
  CopperPourPipelineSolver,
  initializeManifoldGeometry,
} from "@tscircuit/copper-pour-solver";

import { MAX_POUR_CLEARANCE_MM } from "./design-rules";
import { pianiSopraLeVie } from "./drc";
import { ENGINE_VIE_PASSANTI } from "./engine-version";
import { parseLength } from "./pcb-route-model";
import { DISTANZA_PROPRIA, distanzaPropria, planeServedPorts, readPours } from "./pours";
import { getManifoldModuleSync } from "@tscircuit/manifold-2d";
import { capsula, cerchio, poligonoCresciuto, rettangoloArrotondato, type Punto } from "./pour-geometry";
import { abbracciaRamePropio, allargaAnello, formaPulita, senzaColliStretti, type RamePropio } from "./pour-necks";
import { vieDichiarateParziali, vieSemprePassanti } from "./via-layers";

/**
 * THE PLANES, POURED AGAIN ONCE ALL THE COPPER IS ON THE BOARD.
 *
 * tscircuit computes a pour while it builds the board, and it carves it around
 * everything it can see: pads, vias, its own traces, cutouts. The copper of an
 * IMPORTED board is not among those. It arrives after, as manual edits, because
 * that is the whole point of manual edits — the agent rewrites main.tsx every
 * turn and the copper a person drew must survive that.
 *
 * So the pour was computed against a board with no traces on it, and it poured
 * over them. Measured on BAT_BS: the ground plane of the top face had 67
 * openings while 475 traces of other nets ran underneath it. On the screen it
 * reads as "the pour has eaten the traces", which is exactly what it was doing,
 * and in the gerbers it is ground shorted to every signal.
 *
 * The fix is not to move the copper earlier — it belongs where it is — but to
 * pour again at the end, with the same solver tscircuit uses, on a board that
 * now has everything. One extra second per plane, and the plane is the shape it
 * would have had if it had been poured last, which is how a real CAD does it:
 * the pour is always the last thing computed.
 */

interface El {
  type: string;
  [key: string]: unknown;
  /** see PEZZI_DI_TSCIRCUIT */
  [PEZZI_DI_TSCIRCUIT]?: El[];
}

interface Anello {
  vertices: Array<{ x: number; y: number }>;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

export interface EsitoRicolata {
  circuitJson: El[];
  /** how many pours were recomputed, and what it cost them */
  ricolate: number;
  areaPrimaMm2: number;
  areaDopoMm2: number;
  /** rotated pads handed to the solver by hand, because it cannot read them */
  padRuotatiAggiunti: number;
  /** openings cut back into a plane for the pours living inside it */
  colateScavate: number;
  /** splinters thrown away: smaller than a square of the minimum clearance */
  bricioleTolte: number;
  /** small scraps left holding nothing of their net after the carving */
  orfaneTolte: number;
  /** vias of the pour's own net the solver would have carved around */
  viaRiconosciute: number;
  /** copper narrower than the minimum trace width cut out of the pours, mm2 */
  colliTagliatiMm2: number;
  /**
   * Pours that came out with NO piece left: every fragment was a splinter or
   * an empty scrap. They disappear from the board, and this says which, so
   * the summary can report a plane that is gone instead of losing it silently.
   */
  colateSparite: string[];
}

const area = (v: Array<{ x: number; y: number }>): number => {
  let s = 0;
  for (let i = 0; i < v.length; i++) {
    const a = v[i];
    const b = v[(i + 1) % v.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s / 2);
};

/** a rectangle turned around its centre, grown by a margin, as four corners */
function rettangoloRuotato(
  x: number,
  y: number,
  w: number,
  h: number,
  gradi: number,
  margine: number,
): Array<{ x: number; y: number }> {
  const rad = (gradi * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const a = w / 2 + margine;
  const b = h / 2 + margine;
  return [
    [-a, -b],
    [a, -b],
    [a, b],
    [-a, b],
  ].map(([dx, dy]) => ({ x: x + dx * cos - dy * sin, y: y + dx * sin + dy * cos }));
}

/** a rectangle turned by a multiple of 180° is the same rectangle */
const senzaGiro = (gradi: number): boolean => Math.abs(((gradi % 180) + 180) % 180) < 1e-6;

/**
 * The shape of an obstacle before any clearance, carried on the pads this file
 * hands the solver already grown (a turned rectangle, a slot, the outline of
 * another pour), so that ostacoliEsatti can draw them again with round corners.
 */
export type FormaEsatta =
  | { tipo: "rettangolo"; x: number; y: number; w: number; h: number; gradi: number }
  | { tipo: "poligono"; punti: Punto[] };

/**
 * EVERY OBSTACLE IN ITS EXACT SHAPE, GROWN BY THE CLEARANCE.
 *
 * The solver turns each obstacle into a polygon itself, and that is where the
 * pour got its coarse edges (copper-pour-solver dist/index.js): every circle
 * is 32 points ON the circle whatever its radius (circleToPolygon), so the
 * chords stand inside the clearance, 2 micrometres at a via and 6 at a mounting
 * hole, and a big circle is visibly a polygon; a rectangular pad is grown into
 * a rectangle with square corners (processObstaclesForPour), so the gap is the
 * clearance along the sides and 1.4 times it at the corners; a polygon is
 * grown with mitred corners (offsetPolygon); a trace is a rectangle per
 * segment and a 32-gon per point.
 *
 * Here every obstacle the pour must avoid is handed over already grown, as the
 * set of points every copper point must stay out of: a circle grown by the
 * clearance, a rectangle or a pill grown into a rounded rectangle, a trace
 * into one capsule per segment, a polygon grown with round corners, all drawn
 * with as many segments as their radius needs and outside the true curve (see
 * pour-geometry.ts). The solver subtracts a polygon whose key says neither
 * hole nor cutout exactly as given, so it no longer draws any of them. The
 * distance is then the clearance along every side and around every corner,
 * never less, and at most the chord error (2 micrometres) more.
 *
 * Obstacles whose box does not reach the pour's box are left out: they would
 * be subtracted from nothing, and a hand strip of a few square millimetres
 * need not be cut against the whole board.
 *
 * The pads of the pour's own net stay as they are (the solver skips them), and
 * a pad of a shape this does not know is handed back untouched, for the
 * solver to treat as it always did.
 */
export function ostacoliEsatti(
  pads: Array<Record<string, unknown>>,
  chiaveColata: string | undefined,
  margini: { pad: number; trace: number; cutout: number },
  scatola?: { minX: number; minY: number; maxX: number; maxY: number },
): Array<Record<string, unknown>> {
  const fuori: Array<Record<string, unknown>> = [];
  const lontano = (minX: number, minY: number, maxX: number, maxY: number): boolean =>
    !!scatola && (maxX < scatola.minX || minX > scatola.maxX || maxY < scatola.minY || minY > scatola.maxY);
  const scatolaDi = (punti: Punto[]) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of punti) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    return { minX, minY, maxX, maxY };
  };
  for (const pad of pads) {
    const chiave = String(pad.connectivityKey ?? "");
    if (chiaveColata && chiave === chiaveColata) {
      fuori.push(pad);
      continue;
    }
    const foroOTaglio = chiave.startsWith("hole:") || chiave.startsWith("cutout:");
    const m = foroOTaglio ? margini.cutout : margini.pad;
    const id = String(pad.padId ?? "");
    let anelli: Punto[][] | null = null;
    const esatta = pad.formaEsatta as FormaEsatta | undefined;
    const suoMargine = num(pad.margineMm);
    const x = num(pad.x);
    const y = num(pad.y);
    if (esatta && suoMargine !== null) {
      if (esatta.tipo === "rettangolo") {
        const r = Math.max(esatta.w, esatta.h) / 2 + suoMargine;
        if (lontano(esatta.x - r * 1.5, esatta.y - r * 1.5, esatta.x + r * 1.5, esatta.y + r * 1.5)) continue;
        anelli = [
          rettangoloArrotondato(esatta.x, esatta.y, esatta.w + 2 * suoMargine, esatta.h + 2 * suoMargine, suoMargine, esatta.gradi),
        ];
      } else {
        const b = scatolaDi(esatta.punti);
        if (lontano(b.minX - suoMargine, b.minY - suoMargine, b.maxX + suoMargine, b.maxY + suoMargine)) continue;
        anelli = poligonoCresciuto(esatta.punti, suoMargine);
      }
    } else if (pad.shape === "circle" && x !== null && y !== null && num(pad.radius) !== null) {
      const r = num(pad.radius)! + m;
      if (lontano(x - r, y - r, x + r, y + r)) continue;
      anelli = [cerchio(x, y, r)];
    } else if (pad.shape === "rect" && pad.bounds) {
      const b = pad.bounds as { minX: number; minY: number; maxX: number; maxY: number };
      if (lontano(b.minX - m, b.minY - m, b.maxX + m, b.maxY + m)) continue;
      anelli = [
        rettangoloArrotondato((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, b.maxX - b.minX + 2 * m, b.maxY - b.minY + 2 * m, m),
      ];
    } else if (pad.shape === "pill" && x !== null && y !== null) {
      const w = num(pad.width);
      const h = num(pad.height);
      if (w !== null && h !== null) {
        const r = Math.max(w, h) / 2 + m;
        if (lontano(x - r, y - r, x + r, y + r)) continue;
        const raggio = Math.min(num(pad.radius) ?? Math.min(w, h) / 2, w / 2, h / 2);
        anelli = [rettangoloArrotondato(x, y, w + 2 * m, h + 2 * m, raggio + m, num(pad.ccwRotation) ?? 0)];
      }
    } else if (pad.shape === "polygon" && Array.isArray(pad.points)) {
      const punti = (pad.points as Punto[]).filter((p) => num(p?.x) !== null && num(p?.y) !== null);
      const b = scatolaDi(punti);
      const crescita = foroOTaglio ? margini.cutout : 0;
      if (punti.length >= 3 && lontano(b.minX - crescita, b.minY - crescita, b.maxX + crescita, b.maxY + crescita)) continue;
      // a polygon the solver subtracts as it is needs nothing: it is exact already
      if (crescita > 0 && punti.length >= 3) anelli = poligonoCresciuto(punti, crescita);
    } else if (pad.shape === "trace" && Array.isArray(pad.segments)) {
      const r = (num(pad.width) ?? 0) / 2 + margini.trace;
      const punti = (pad.segments as Punto[]).filter((p) => num(p?.x) !== null && num(p?.y) !== null);
      const capsule: Punto[][] = [];
      for (let i = 0; i + 1 < punti.length; i++) {
        const a = punti[i];
        const b = punti[i + 1];
        if (lontano(Math.min(a.x, b.x) - r, Math.min(a.y, b.y) - r, Math.max(a.x, b.x) + r, Math.max(a.y, b.y) + r)) continue;
        if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-9 && i > 0) continue;
        capsule.push(capsula(a, b, r));
      }
      if (capsule.length === 0) continue;
      anelli = capsule;
    }
    if (!anelli || anelli.length === 0) {
      fuori.push(pad);
      continue;
    }
    anelli.forEach((punti, k) =>
      fuori.push({
        shape: "polygon",
        padId: `${id}~${k}`,
        layer: pad.layer,
        // neither hole nor cutout: the solver subtracts it as it is, already grown
        connectivityKey: `unconnected:esatto:${id}`,
        points: punti,
      }),
    );
  }
  return fuori;
}

/** whether a through element lives on this face: its `layers`, or all of them */
function suFaccia(el: El, faccia: string): boolean {
  const layers = el.layers;
  if (!Array.isArray(layers) || layers.length === 0) return true;
  return layers.some((l) => (typeof l === "string" ? l : (l as { name?: unknown })?.name) === faccia);
}

/**
 * THE VIAS THE SOLVER DOES NOT SEE ON THE INNER LAYERS.
 *
 * A through via is written by tscircuit with `layers: ["top", "bottom"]`, and
 * the solver's converter keeps a via only on a layer that list names
 * (dist/index.js, `if (!via.layers.includes(options.layer)) continue`). So on
 * inner1 and inner2 every via is invisible: the plane pours straight over the
 * holes of the other nets. On an imported board it mostly hides, because the
 * file's own outlines already have the openings; where they do not, the plane
 * shorts the via. Measured on BAT_BS on 2026-10-20: the 3V3_MIC via at
 * (2.654, 21) inside the inner1 ground plane, a short from the microphone
 * supply to ground.
 *
 * A via crosses every layer, so it is handed over on that layer too: as an
 * obstacle when it belongs to another net, with the pour's own key when it is
 * the plane's net, so it stays connected.
 *
 * EVERY via, and on the two faces as well. This used to skip a via that did
 * not list both top and bottom, as blind or buried, and to answer nothing for
 * the outer faces. There are no blind vias here (see vieSemprePassanti): the
 * hole is drilled through the board whatever the element lists. On
 * sbb-dl-principale (2026-11-11) the via of a hand-drawn trace from inner2 to
 * bottom listed those two layers only, and the inner1 ground plane closed over
 * 20 such holes of VBUS, VSYS, NRST and the SD lines. The board is normalised
 * before it gets here; this is for the one that was not.
 */
export function viePassanti(
  circuitJson: El[],
  faccia: string,
  netDellaColata: string,
  netDiVia: Map<string, string>,
  chiaveColata: string | undefined,
): Array<Record<string, unknown>> {
  const fuori: Array<Record<string, unknown>> = [];
  for (const el of circuitJson) {
    if (el.type !== "pcb_via") continue;
    const strati = Array.isArray(el.layers) ? (el.layers as unknown[]).map(String) : [];
    if (strati.includes(faccia)) continue; // the converter already has it
    const x = num(el.x);
    const y = num(el.y);
    const d = num(el.outer_diameter);
    if (x === null || y === null || d === null) continue;
    const id = String(el.pcb_via_id ?? "");
    const suaRete = netDiVia.get(id);
    const nostra = suaRete !== undefined && suaRete === netDellaColata && chiaveColata;
    fuori.push({
      shape: "circle",
      padId: id,
      layer: faccia,
      connectivityKey: nostra ? chiaveColata : `unconnected-via:${id}`,
      x,
      y,
      radius: d / 2,
    });
  }
  return fuori;
}

/**
 * THE PADS THE SOLVER CANNOT READ.
 *
 * Its converter knows a handful of shapes — smtpad rect, circle, pill,
 * rotated_pill; plated hole circle and circular_hole_with_rect_pad; round
 * pcb_hole — and everything else is NOTHING to it: the plane flows straight
 * over it. Measured on real boards and on the next one:
 *   - `rotated_rect` smtpads: every component the designer turned (ninety on
 *     one board), the pins of a microcontroller at 45 degrees;
 *   - POLYGON smtpads: the ground pads of the MEMS microphones;
 *   - oval / pill plated holes: the shell of a USB-C receptacle;
 *   - pill_hole_with_rect_pad, rotated_pill_hole_with_rect_pad,
 *     hole_with_polygon_pad; and a circular_hole_with_rect_pad turned by a
 *     quarter, whose rectangle the converter reads unturned;
 *   - non-round pcb_hole: the slots of a connector, copper over a drill.
 * Each is handed over in a shape the solver does subtract. Only for pads of
 * ANOTHER net: a pad on the pour's own net has to touch the plane, which is
 * the point of a plane. Holes have no net and are always cut around.
 *
 * One catch, read in its source: a polygon obstacle is subtracted with margin
 * ZERO unless its key says hole or cutout (dist/index.js:440). Rectangles are
 * therefore handed over already grown by the pour's clearance; a polygon
 * pad, whose outline cannot be grown by hand without getting concave corners
 * wrong, goes with a `cutout:` key, so the solver offsets it itself; a pill
 * goes as a pill, which the solver grows by the pad margin. A grown rectangle
 * also carries the rectangle it was grown from (`formaEsatta`), so the re-pour
 * can draw it again with round corners (see ostacoliEsatti).
 */
export function padRuotati(
  circuitJson: El[],
  faccia: string,
  netDellaColata: string,
  margineMm: number,
  /**
   * Which pads already live on a plane net, by the same reckoning the house
   * rules use: it walks the traces, so a ground pad that no trace names
   * directly still comes out as ground. Reading only `connected_source_net_ids`
   * left thirteen pads netless, and carving the plane away from its own pins is
   * how a return path goes missing.
   */
  serviti: Map<string, string>,
): Array<Record<string, unknown>> {
  const fuori: Array<Record<string, unknown>> = [];
  const poligono = (id: string, points: Array<{ x: number; y: number }>, chiave = `unconnected:${id}`) =>
    fuori.push({ shape: "polygon", padId: id, layer: faccia, connectivityKey: chiave, points });
  /** a turned rectangle grown by the clearance, with the rectangle it came from */
  const rettangolo = (id: string, x: number, y: number, w: number, h: number, gradi: number) =>
    fuori.push({
      shape: "polygon",
      padId: id,
      layer: faccia,
      connectivityKey: `unconnected:${id}`,
      points: rettangoloRuotato(x, y, w, h, gradi, margineMm),
      formaEsatta: { tipo: "rettangolo", x, y, w, h, gradi } satisfies FormaEsatta,
      margineMm,
    });
  for (const el of circuitJson) {
    const shape = String(el.shape ?? "");
    const x = num(el.x);
    const y = num(el.y);

    if (el.type === "pcb_smtpad") {
      if (String(el.layer ?? "") !== faccia) continue;
      // its own net: the plane must reach it, not avoid it
      if (serviti.get(String(el.pcb_port_id ?? "")) === netDellaColata) continue;
      const id = String(el.pcb_smtpad_id ?? "");
      if (shape === "rotated_rect") {
        const w = num(el.width);
        const h = num(el.height);
        if (x === null || y === null || w === null || h === null) continue;
        rettangolo(id, x, y, w, h, num(el.ccw_rotation) ?? 0);
      } else if (shape === "polygon") {
        const punti = ((el.points as Array<{ x?: unknown; y?: unknown }> | undefined) ?? [])
          .map((p) => ({ x: num(p.x), y: num(p.y) }))
          .filter((p): p is { x: number; y: number } => p.x !== null && p.y !== null);
        if (punti.length < 3) continue;
        poligono(id, punti, `cutout:pad_${id}`);
      }
      continue;
    }

    if (el.type === "pcb_plated_hole") {
      if (!suFaccia(el, faccia)) continue;
      if (serviti.get(String(el.pcb_port_id ?? "")) === netDellaColata) continue;
      if (x === null || y === null) continue;
      const id = String(el.pcb_plated_hole_id ?? "");
      if (shape === "oval" || shape === "pill") {
        const w = num(el.outer_width);
        const h = num(el.outer_height);
        if (w === null || h === null) continue;
        fuori.push({
          shape: "pill",
          padId: id,
          layer: faccia,
          connectivityKey: `unconnected-plated-hole:${id}`,
          x,
          y,
          width: w,
          height: h,
          radius: Math.min(w, h) / 2,
          ccwRotation: num(el.ccw_rotation) ?? 0,
        });
      } else if (
        shape === "pill_hole_with_rect_pad" ||
        shape === "rotated_pill_hole_with_rect_pad" ||
        (shape === "circular_hole_with_rect_pad" && !senzaGiro(num(el.rect_ccw_rotation) ?? 0))
      ) {
        const w = num(el.rect_pad_width);
        const h = num(el.rect_pad_height);
        if (w === null || h === null) continue;
        rettangolo(id, x, y, w, h, num(el.rect_ccw_rotation) ?? 0);
      } else if (shape === "hole_with_polygon_pad") {
        const rot = ((num(el.ccw_rotation) ?? 0) * Math.PI) / 180;
        const cos = Math.cos(rot);
        const sin = Math.sin(rot);
        const punti = ((el.pad_outline as Array<{ x?: unknown; y?: unknown }> | undefined) ?? [])
          .map((p) => ({ x: num(p.x), y: num(p.y) }))
          .filter((p): p is { x: number; y: number } => p.x !== null && p.y !== null)
          // the outline is relative to the hole's position
          .map((p) => ({ x: x + p.x * cos - p.y * sin, y: y + p.x * sin + p.y * cos }));
        if (punti.length < 3) continue;
        poligono(id, punti, `cutout:pad_${id}`);
      }
      continue;
    }

    if (el.type === "pcb_hole") {
      const holeShape = String(el.hole_shape ?? "");
      if (holeShape === "circle" || x === null || y === null) continue;
      const id = String(el.pcb_hole_id ?? "");
      const w = num(el.hole_width) ?? num(el.hole_diameter);
      const h = num(el.hole_height) ?? num(el.hole_diameter);
      if (w === null || h === null) continue;
      if (holeShape === "pill" || holeShape === "oval" || holeShape === "rotated_pill") {
        fuori.push({
          shape: "pill",
          padId: id,
          layer: faccia,
          connectivityKey: `hole:${id}`,
          x,
          y,
          width: w,
          height: h,
          radius: Math.min(w, h) / 2,
          ccwRotation: num(el.ccw_rotation) ?? 0,
        });
      } else {
        // rect and square slots: a box, cut around by the hole margin
        rettangolo(id, x, y, w, h, 0);
      }
    }
  }
  return fuori;
}

/**
 * THE VIAS OF THE POUR'S OWN NET, PUT BACK ON ITS SIDE.
 *
 * The solver decides what to carve by comparing strings: an obstacle whose
 * connectivity key is not the pour's key gets subtracted. For a trace it reads
 * that key through the connectivity map and gets the SCOPED form
 * (`subcircuit:...:connectivity:net0`); a standalone `pcb_via` is in no map —
 * nothing references its id — so it falls back to the key written on the
 * element, which is the RAW form (`...net0`). The two never match.
 *
 * The result is a ground plane that opens a hole around each of its own
 * stitching vias: 519 of them on this board, holes where the copper should
 * close, which is exactly what a plane is for. Here the keys of the vias that
 * are on the pour's net are set to the pour's own, so the solver leaves them
 * alone.
 */
function riconosciLeVia(
  problema: { pads?: Array<Record<string, unknown>>; regionsForPour?: Array<Record<string, unknown>> },
  netDiVia: Map<string, string>,
  netDellaColata: string,
): number {
  const chiave = problema.regionsForPour?.[0]?.connectivityKey;
  if (typeof chiave !== "string" || !chiave) return 0;
  let n = 0;
  for (const pad of problema.pads ?? []) {
    const suo = netDiVia.get(String(pad.padId ?? ""));
    if (!suo || suo !== netDellaColata) continue;
    if (pad.connectivityKey === chiave) continue;
    pad.connectivityKey = chiave;
    n++;
  }
  return n;
}

/**
 * WHERE EACH NET HAS COPPER: pads, vias and the points of its traces.
 *
 * It answers one question, asked of every piece a pour breaks into: is there
 * anything of this net inside it? A scrap with nothing inside is copper that
 * connects nothing — the file drew it whole and our clearances cut it loose.
 */
function ancore(circuitJson: El[], serviti: Map<string, string>): Map<string, Array<{ x: number; y: number }>> {
  const out = new Map<string, Array<{ x: number; y: number }>>();
  const metti = (net: string, x: number | null, y: number | null) => {
    if (!net || x === null || y === null) return;
    const l = out.get(net) ?? [];
    l.push({ x, y });
    out.set(net, l);
  };
  /** connectivity key -> net, the only handle a via has */
  const netDiChiave = new Map<string, string>();
  for (const el of circuitJson) {
    if (el.type !== "source_net") continue;
    const k = String(el.subcircuit_connectivity_map_key ?? "");
    if (k) netDiChiave.set(k, String(el.source_net_id ?? ""));
  }
  const netDiTraccia = new Map<string, string>();
  for (const el of circuitJson) {
    if (el.type !== "source_trace") continue;
    const reti = (el.connected_source_net_ids as string[] | undefined) ?? [];
    if (reti[0]) netDiTraccia.set(String(el.source_trace_id ?? ""), String(reti[0]));
  }
  for (const el of circuitJson) {
    if (el.type === "pcb_smtpad" || el.type === "pcb_plated_hole") {
      metti(serviti.get(String(el.pcb_port_id ?? "")) ?? "", num(el.x), num(el.y));
      continue;
    }
    if (el.type === "pcb_via") {
      metti(netDiChiave.get(String(el.subcircuit_connectivity_map_key ?? "")) ?? "", num(el.x), num(el.y));
      continue;
    }
    if (el.type !== "pcb_trace") continue;
    const net = netDiTraccia.get(String(el.source_trace_id ?? "")) ?? "";
    if (!net) continue;
    for (const q of (el.route as Array<Record<string, unknown>> | undefined) ?? []) {
      metti(net, num(q.x), num(q.y));
    }
  }
  return out;
}

/**
 * The copper of the pour's own net on its layer: via rings (vias cross every
 * layer) and pads, as the shapes the pour has to hold whole, each by its real
 * outline (see abbracciaRamePropio for what a bounding box did). A pad of a
 * shape this does not know is left out: better not held than held by a guess.
 */
function ramePropio(
  circuitJson: El[],
  layer: string,
  net: string,
  netDiVia: Map<string, string>,
  serviti: Map<string, string>,
): RamePropio[] {
  if (!net) return [];
  const out: RamePropio[] = [];
  const punti = (v: unknown): Punto[] =>
    ((v as Array<{ x?: unknown; y?: unknown }> | undefined) ?? [])
      .map((p) => ({ x: num(p?.x), y: num(p?.y) }))
      .filter((p): p is Punto => p.x !== null && p.y !== null);
  for (const el of circuitJson) {
    if (el.type === "pcb_via") {
      if (netDiVia.get(String(el.pcb_via_id ?? "")) !== net) continue;
      const x = num(el.x), y = num(el.y), d = num(el.outer_diameter);
      if (x !== null && y !== null && d !== null && d > 0) out.push({ kind: "cerchio", x, y, r: d / 2 });
      continue;
    }
    if (el.type !== "pcb_smtpad" && el.type !== "pcb_plated_hole") continue;
    if (serviti.get(String(el.pcb_port_id ?? "")) !== net) continue;
    if (el.type === "pcb_smtpad" && String(el.layer ?? "top") !== layer) continue;
    if (el.type === "pcb_plated_hole" && !suFaccia(el, layer)) continue;
    const x = num(el.x), y = num(el.y);
    const shape = String(el.shape ?? "");
    if (el.type === "pcb_smtpad") {
      if (shape === "polygon") {
        const p = punti(el.points);
        if (p.length >= 3) out.push({ kind: "poligono", punti: p });
        continue;
      }
      if (x === null || y === null) continue;
      const w = num(el.width), h = num(el.height);
      if (shape === "circle") {
        const r = num(el.radius);
        if (r !== null && r > 0) out.push({ kind: "cerchio", x, y, r });
      } else if (w !== null && h !== null && (shape === "rect" || shape === "rotated_rect")) {
        const raggio = num(el.rect_border_radius) ?? num(el.corner_radius) ?? 0;
        out.push({ kind: "rett", x, y, w, h, rot: shape === "rotated_rect" ? (num(el.ccw_rotation) ?? 0) : 0, raggio });
      } else if (w !== null && h !== null && (shape === "pill" || shape === "rotated_pill")) {
        const raggio = num(el.radius) ?? Math.min(w, h) / 2;
        out.push({ kind: "rett", x, y, w, h, rot: shape === "rotated_pill" ? (num(el.ccw_rotation) ?? 0) : 0, raggio });
      }
      continue;
    }
    if (x === null || y === null) continue;
    if (shape === "circle") {
      const d = num(el.outer_diameter);
      if (d !== null && d > 0) out.push({ kind: "cerchio", x, y, r: d / 2 });
    } else if (shape === "pill" || shape === "oval") {
      const w = num(el.outer_width), h = num(el.outer_height);
      if (w !== null && h !== null) out.push({ kind: "rett", x, y, w, h, rot: num(el.ccw_rotation) ?? 0, raggio: Math.min(w, h) / 2 });
    } else if (
      shape === "circular_hole_with_rect_pad" ||
      shape === "pill_hole_with_rect_pad" ||
      shape === "rotated_pill_hole_with_rect_pad"
    ) {
      const w = num(el.rect_pad_width), h = num(el.rect_pad_height);
      const raggio = num(el.rect_border_radius) ?? 0;
      if (w !== null && h !== null) out.push({ kind: "rett", x, y, w, h, rot: num(el.rect_ccw_rotation) ?? 0, raggio });
    } else if (shape === "hole_with_polygon_pad") {
      const rot = ((num(el.ccw_rotation) ?? 0) * Math.PI) / 180;
      const cos = Math.cos(rot), sin = Math.sin(rot);
      // the outline is relative to the hole's position
      const p = punti(el.pad_outline).map((q) => ({ x: x + q.x * cos - q.y * sin, y: y + q.x * sin + q.y * cos }));
      if (p.length >= 3) out.push({ kind: "poligono", punti: p });
    }
  }
  return out;
}

/** whether a point falls inside a ring */
function dentro(x: number, y: number, anello: Array<{ x: number; y: number }>): boolean {
  let d = false;
  for (let i = 0, j = anello.length - 1; i < anello.length; j = i++) {
    const a = anello[i];
    const b = anello[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) d = !d;
  }
  return d;
}

/** the distance from a point to a ring's edges */
function dalBordo(x: number, y: number, anello: Array<{ x: number; y: number }>): number {
  let d = Infinity;
  for (let i = 0, j = anello.length - 1; i < anello.length; j = i++) {
    const a = anello[j];
    const b = anello[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l2)) : 0;
    d = Math.min(d, Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy)));
  }
  return d;
}

const PUNTO = /\{\s*x\s*:\s*(-?\d+(?:\.\d+)?(?:e-?\d+)?)\s*,\s*y\s*:\s*(-?\d+(?:\.\d+)?(?:e-?\d+)?)\s*\}/g;

/** a `<copperpour>` as the file writes it: what can be read without running the file */
interface CopperpourScritta {
  layer?: string;
  net?: string;
  /** the outline when it is a literal list of points; null when it is missing or built in code */
  outline: Array<{ x: number; y: number }> | null;
  /** no `outline` at all: tscircuit pours it over the whole board */
  senzaContorno: boolean;
  /** the `clearance` exactly as written, when it is written */
  clearance?: string;
}

function copperpourScritte(testo: string): CopperpourScritta[] {
  const out: CopperpourScritta[] = [];
  for (const m of testo.matchAll(/<copperpour\b([^>]*?)\/>/g)) {
    const attr = m[1];
    const layer = /\blayer\s*=\s*["']([\w-]+)["']/.exec(attr)?.[1];
    const net = /\bconnectsTo\s*=\s*["']net\.([\w-]+)["']/.exec(attr)?.[1];
    const lista = /\boutline\s*=\s*\{\s*\[([^\]]*)\]\s*\}/.exec(attr)?.[1];
    let outline: Array<{ x: number; y: number }> | null = null;
    if (lista !== undefined && lista.replace(PUNTO, "").replace(/[\s,]/g, "") === "") {
      const punti = [...lista.matchAll(PUNTO)].map((q) => ({ x: Number(q[1]), y: Number(q[2]) }));
      if (punti.length >= 3) outline = punti;
    }
    // clearance="0.25mm", clearance='0.25', clearance={0.25}, clearance={"10mil"}
    const c = /\bclearance\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*([^}]*?)\s*\})/.exec(attr);
    const clearance = c ? (c[1] ?? c[2] ?? c[3]) : undefined;
    const senzaContorno = !/\boutline\s*=/.test(attr);
    out.push({ layer, net, outline, senzaContorno, ...(clearance !== undefined ? { clearance } : {}) });
  }
  return out;
}

/**
 * The `<copperpour>` of the file whose outline is written as a literal list of
 * points, with face and net. An outline built from variables or expressions is
 * left out: reading it would mean running the file, and the shape tscircuit
 * gives back stays the best guess for it.
 */
export function contorniDichiarati(
  main: string,
): Array<{ layer: string; net: string; outline: Array<{ x: number; y: number }> }> {
  const out: Array<{ layer: string; net: string; outline: Array<{ x: number; y: number }> }> = [];
  for (const { layer, net, outline } of copperpourScritte(main)) {
    if (layer && net && outline) out.push({ layer, net, outline });
  }
  return out;
}

/** a `<copperpour>` of the project with what it says about its distance */
export interface DistanzaDichiarata {
  /** the file it is written in */
  file: string;
  layer: string;
  /** the net by name, as `connectsTo` writes it */
  net: string;
  /** the literal outline; null when the pour has none or builds it in code */
  outline: Array<{ x: number; y: number }> | null;
  /** the clearance it keeps from the other nets, within the limits; null when it declares none */
  mm: number | null;
}

/**
 * WHAT EVERY `<copperpour>` OF THE PROJECT DECLARES ABOUT ITS DISTANCE.
 *
 * Read in every .tsx of the project, not in main.tsx only: a board drawn by a
 * script keeps its pours wherever the script writes them (sbb-dl-principale has
 * its 229 in righe_2.tsx and righe_3.tsx). The value is tscircuit's own
 * `clearance`, in any unit tscircuit takes (a number is millimetres). The
 * project's minimum clearance stays the minimum: a value under it is raised to
 * it and said in `avvisi`, as design-rules.ts does for pourClearanceMm; so is
 * a value that is not a length, which is ignored, and one above the widest a
 * pour may ask (MAX_POUR_CLEARANCE_MM).
 *
 * A pour is matched to its elements by its outline (see conDistanzeDichiarate),
 * so two pours with no literal outline on the same face and net are the same
 * pour as far as this can tell: when they ask for different distances, neither
 * is applied and that is said too.
 */
export function distanzeDichiarate(
  files: unknown,
  minimoMm: number,
): { dichiarate: DistanzaDichiarata[]; avvisi: string[] } {
  const dichiarate: DistanzaDichiarata[] = [];
  const avvisi: string[] = [];
  if (!files || typeof files !== "object") return { dichiarate, avvisi };
  const mappa = files as Record<string, unknown>;
  for (const file of Object.keys(mappa).filter((f) => f.endsWith(".tsx")).sort()) {
    const testo = mappa[file];
    if (typeof testo !== "string" || !testo.includes("copperpour")) continue;
    for (const c of copperpourScritte(testo)) {
      if (!c.layer || !c.net) continue;
      let mm: number | null = null;
      if (c.clearance !== undefined) {
        const letta = parseLength(c.clearance.replace(/^["'`]|["'`]$/g, ""));
        const dove = `${file}: clearance ${c.clearance} della <copperpour> ${c.net} su ${c.layer}`;
        if (letta === null || !(letta > 0)) {
          avvisi.push(`${dove} non e' una distanza scritta nel file: ignorata, vale la regola del progetto`);
        } else if (letta < minimoMm) {
          avvisi.push(`${dove} e' sotto la distanza minima ${minimoMm}: portata al minimo`);
          mm = minimoMm;
        } else if (letta > MAX_POUR_CLEARANCE_MM) {
          avvisi.push(`${dove} e' oltre ${MAX_POUR_CLEARANCE_MM}mm: portata a ${MAX_POUR_CLEARANCE_MM}`);
          mm = MAX_POUR_CLEARANCE_MM;
        } else {
          mm = letta;
        }
      }
      dichiarate.push({ file, layer: c.layer, net: c.net, outline: c.outline, mm });
    }
  }
  const senzaContorno = new Map<string, Set<number | null>>();
  for (const d of dichiarate) {
    if (d.outline) continue;
    const k = `${d.layer}|${d.net}`;
    senzaContorno.set(k, (senzaContorno.get(k) ?? new Set()).add(d.mm));
  }
  for (const [k, valori] of senzaContorno) {
    if (valori.size < 2) continue;
    const [layer, net] = k.split("|");
    avvisi.push(
      `le <copperpour> ${net} su ${layer} senza un contorno scritto come lista di punti chiedono distanze diverse ` +
        `(${[...valori].map((v) => v ?? "regola").join(", ")}): non si distinguono, vale la regola del progetto. ` +
        `Scrivi il contorno di ognuna come lista di punti`,
    );
  }
  return { dichiarate, avvisi };
}

/**
 * THE DECLARED CLEARANCE, WRITTEN ON THE POURS IT BELONGS TO (see
 * DISTANZA_PROPRIA in pours.ts, and distanzeDichiarate for what is declared).
 *
 * tscircuit gives back no trace of which `<copperpour>` an element came from,
 * so it is told by geometry, as conContorniDichiarati does: a piece of face and
 * net that lies inside a declared literal outline belongs to it, the smallest
 * one when outlines nest. A pour with no literal outline (a whole plane, or an
 * outline built in code) gets the pieces of its face and net that no outline
 * claimed. A pour that declares nothing claims its pieces all the same, so a
 * hand strip inside the board keeps the project's rule even when the plane of
 * its net on that face asks for more.
 *
 * Nothing declared and nothing already written: the same array back, element
 * for element, so a board that never declared a distance pours as it always
 * did. On a saved board (recheck) the values are written again from today's
 * files, and one no longer declared is taken away.
 */
export function conDistanzeDichiarate(circuitJson: El[], files: unknown, minimoMm: number): El[] {
  const { dichiarate } = distanzeDichiarate(files, minimoMm);
  const giaScritte = circuitJson.some((el) => el.type === "pcb_copper_pour" && DISTANZA_PROPRIA in el);
  if (!giaScritte && !dichiarate.some((d) => d.mm !== null)) return circuitJson;

  const reteDi = new Map<string, string>();
  for (const el of circuitJson) {
    if (el.type === "source_net") reteDi.set(String(el.name ?? ""), String(el.source_net_id ?? ""));
  }
  const scatola = (v: Array<{ x: number; y: number }>) => {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of v) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    return { minX, maxX, minY, maxY };
  };
  /* the outlines, smallest first: a piece inside two of them is the tighter one's */
  const conContorno = dichiarate
    .filter((d): d is DistanzaDichiarata & { outline: Array<{ x: number; y: number }> } => d.outline !== null)
    .map((d) => ({ d, netId: reteDi.get(d.net), area: area(d.outline), box: scatola(d.outline) }))
    .filter((c) => c.netId !== undefined)
    .sort((a, b) => a.area - b.area);
  /* face and net -> the distance of the pours with no literal outline there, if they agree on one */
  const senzaContorno = new Map<string, number | null | "ambigua">();
  for (const d of dichiarate) {
    if (d.outline) continue;
    const netId = reteDi.get(d.net);
    if (netId === undefined) continue;
    const k = `${d.layer}|${netId}`;
    const prima = senzaContorno.get(k);
    senzaContorno.set(k, prima === undefined || prima === d.mm ? d.mm : "ambigua");
  }

  return circuitJson.map((el) => {
    if (el.type !== "pcb_copper_pour") return el;
    const layer = String(el.layer ?? "");
    const net = String(el.source_net_id ?? "");
    const anello = (el.brep_shape as { outer_ring?: Anello } | undefined)?.outer_ring?.vertices ??
      (el.points as Array<{ x: number; y: number }> | undefined) ?? [];
    let mm: number | null = null;
    const b = anello.length >= 3 ? scatola(anello) : null;
    const suo = b
      ? conContorno.find(
          (c) =>
            c.netId === net &&
            c.d.layer === layer &&
            b.minX >= c.box.minX - 0.01 &&
            b.maxX <= c.box.maxX + 0.01 &&
            b.minY >= c.box.minY - 0.01 &&
            b.maxY <= c.box.maxY + 0.01 &&
            anello.every((v) => dentro(v.x, v.y, c.d.outline) || dalBordo(v.x, v.y, c.d.outline) < 0.01),
        )
      : undefined;
    if (suo) mm = suo.d.mm;
    else {
      const s = senzaContorno.get(`${layer}|${net}`);
      mm = typeof s === "number" ? s : null;
    }
    if (mm === null) {
      if (!(DISTANZA_PROPRIA in el)) return el;
      const senza = { ...el };
      delete senza[DISTANZA_PROPRIA];
      return senza;
    }
    return el[DISTANZA_PROPRIA] === mm ? el : { ...el, [DISTANZA_PROPRIA]: mm };
  });
}

/**
 * The .tsx files main.tsx reaches through its relative imports, main.tsx
 * first and the rest in name order: the files whose `<copperpour>` are on the
 * board. A file the board does not import (a copy kept aside, an old version)
 * draws nothing, and its pours must not be poured.
 */
export function fileDellaScheda(files: Record<string, unknown>): string[] {
  const esiste = (f: string) => typeof files[f] === "string";
  const normalizza = (percorso: string): string => {
    const parti: string[] = [];
    for (const p of percorso.split("/")) {
      if (p === "" || p === ".") continue;
      if (p === "..") parti.pop();
      else parti.push(p);
    }
    return parti.join("/");
  };
  const visti = new Set<string>();
  const coda = ["main.tsx"];
  while (coda.length > 0) {
    const f = coda.shift()!;
    if (visti.has(f) || !esiste(f)) continue;
    visti.add(f);
    const cartella = f.includes("/") ? f.slice(0, f.lastIndexOf("/") + 1) : "";
    for (const m of (files[f] as string).matchAll(/\bfrom\s+["'](\.{1,2}\/[^"']+)["']/g)) {
      const base = normalizza(cartella + m[1]);
      const trovato = [base, `${base}.tsx`, `${base}.ts`, `${base}/index.tsx`, `${base}/index.ts`].find(esiste);
      if (trovato) coda.push(trovato);
    }
  }
  return [...visti].filter((f) => f.endsWith(".tsx")).sort((a, b) => (a === "main.tsx" ? -1 : b === "main.tsx" ? 1 : a < b ? -1 : 1));
}

/** the board outline: the drawn one when it is one, else the width x height rectangle */
function contornoScheda(circuitJson: El[]): Punto[] {
  const board = circuitJson.find((el) => el.type === "pcb_board");
  if (!board) return [];
  const centro = (board.center as { x?: number; y?: number } | undefined) ?? {};
  const cx = num(centro.x) ?? 0;
  const cy = num(centro.y) ?? 0;
  const w = num(board.width);
  const h = num(board.height);
  /*
   * The drawn outline when it IS one: three real points at least. An empty
   * `outline: []` (what an export with no custom shape leaves) used to win
   * over width/height and give no band at all, and a point with a missing
   * coordinate went to 0.
   */
  const disegnato = Array.isArray(board.outline)
    ? (board.outline as Array<{ x?: unknown; y?: unknown }>)
        .map((p) => ({ x: num(p?.x), y: num(p?.y) }))
        .filter((p): p is Punto => p.x !== null && p.y !== null)
    : [];
  if (disegnato.length >= 3) return disegnato;
  if (w === null || h === null) return [];
  return [
    { x: cx - w / 2, y: cy - h / 2 },
    { x: cx + w / 2, y: cy - h / 2 },
    { x: cx + w / 2, y: cy + h / 2 },
    { x: cx - w / 2, y: cy + h / 2 },
  ];
}

/**
 * The pieces tscircuit poured for a pour that conContorniDichiarati put back
 * on its declared outline. Carried under a symbol, which a spread copies and
 * JSON never writes: if the solver throws on the declared outline or gives
 * nothing back, ricolaPiani keeps these (carved by tscircuit, at least) instead
 * of the bare outline, which is carved around nothing.
 */
const PEZZI_DI_TSCIRCUIT: unique symbol = Symbol("pezzi di tscircuit");

/**
 * THE POURS START AGAIN FROM THE OUTLINE THE FILE DRAWS.
 *
 * tscircuit pours a `<copperpour>` keeping its clearance (0.2mm unless the
 * file says otherwise) from the outline itself, as if the outline were the
 * board edge, and ricolaPiani used to take that shrunken shape as its outer
 * ring. Every pour therefore came out about 0.35mm smaller on each side than
 * the one drawn: on the sonda del suolo a strip of ground poured over a
 * resistor pad disappeared, the pad lost its plane, and the online report
 * flagged a missing stitch and a dead island that the Gerbers made from the
 * declared outlines did not have.
 *
 * Each piece tscircuit poured inside a declared outline of the same face and
 * net is replaced by one pour with that outline; ricolaPiani then cuts it
 * against the copper of the finished board, the board edge included.
 *
 * In EVERY file the board imports, not in main.tsx only. A board drawn by a
 * script keeps its pours where the script writes them: sbb-dl-principale has
 * all of its 296 in righe_2, righe_3 and righe_4, so none of them was put back
 * and every one was poured again from what tscircuit had made of it. That
 * shape was the outline shrunk by tscircuit's 0.2mm (0.19mm smaller on every
 * side than drawn, measured on the P3V3_MIC strip), carved around the copper
 * tscircuit could see with its own clearance and not the project's, and cut
 * at every vertex of the outline by a SQUARE: the solver keeps the edge
 * margin with a disc and an axis-aligned square at each corner of the outline
 * it takes for the board (copper-pour-solver dist/index.js, processObstacles,
 * boardOutline), and along the hand-drawn diagonal of a ground pour, a vertex
 * every 0.13mm, the squares are a staircase. The re-pour kept all of it: it
 * can only take copper away from the outline it is given.
 *
 * A `<copperpour>` with no outline at all is poured by tscircuit over the
 * whole board, and so it starts again from the board outline here: the band
 * along the edge is kept by bandaDelBordo, as for every other pour. Only when
 * every `<copperpour>` of its face and net has either a literal outline or
 * none: an outline built in code cannot be read without running the file, and
 * then the shape tscircuit gave back stays the best guess for those pieces.
 *
 * Every declared outline is poured whether or not tscircuit gave a piece for
 * it (a strip narrower than tscircuit's two margins comes back from tscircuit
 * as nothing), unless it lies entirely off the board: that is not a shape of
 * this board (a group moved somewhere else) and is left out. Which pours there
 * are depends on the files alone, never on what tscircuit made of them.
 *
 * `files`: the project's files, or the text of main.tsx alone.
 */
export function conContorniDichiarati(circuitJson: El[], files: unknown): El[] {
  const testi: string[] =
    typeof files === "string"
      ? [files]
      : files && typeof files === "object"
        ? fileDellaScheda(files as Record<string, unknown>)
            .map((f) => (files as Record<string, unknown>)[f])
            .filter((t): t is string => typeof t === "string")
        : [];
  if (!testi.some((t) => t.includes("copperpour"))) return circuitJson;
  const scritte = testi.flatMap((t) => copperpourScritte(t)).filter((c) => c.layer && c.net);
  if (!scritte.length) return circuitJson;
  const reteDi = new Map<string, string>();
  for (const el of circuitJson) {
    if (el.type === "source_net") reteDi.set(String(el.name ?? ""), String(el.source_net_id ?? ""));
  }
  const scheda = contornoScheda(circuitJson);
  let sx0 = Infinity, sy0 = Infinity, sx1 = -Infinity, sy1 = -Infinity;
  for (const p of scheda) {
    sx0 = Math.min(sx0, p.x);
    sy0 = Math.min(sy0, p.y);
    sx1 = Math.max(sx1, p.x);
    sy1 = Math.max(sy1, p.y);
  }
  /* whether the outline's box meets the board's: an outline may run past the edge, the band trims it */
  const sullaScheda = (outline: Punto[]) => {
    if (scheda.length < 3) return true;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of outline) {
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x);
      y1 = Math.max(y1, p.y);
    }
    return x1 >= sx0 && x0 <= sx1 && y1 >= sy0 && y0 <= sy1;
  };
  /* the faces and nets where an outline is built in code: their pieces cannot be told apart */
  const inCodice = new Set(scritte.filter((c) => !c.outline && !c.senzaContorno).map((c) => `${c.layer}|${c.net}`));
  const pours = circuitJson.filter((el) => el.type === "pcb_copper_pour");
  const sostituite = new Set<El>();
  const nuove: El[] = [];
  const anelloDi = (p: El) =>
    (p.brep_shape as { outer_ring?: Anello } | undefined)?.outer_ring?.vertices ??
    (p.points as Array<{ x: number; y: number }> | undefined) ?? [];
  const metti = (i: number, layer: string, netId: string, outline: Punto[], pezzi: El[]) => {
    const modello = pezzi[0] ?? pours.find((p) => String(p.layer ?? "") === layer) ?? pours[0];
    if (!modello) return;
    pezzi.forEach((p) => sostituite.add(p));
    const nuova: El = {
      ...modello,
      pcb_copper_pour_id: `pcb_copper_pour_dichiarata_${i}`,
      layer,
      source_net_id: netId,
      shape: "brep",
      brep_shape: { outer_ring: { vertices: outline }, inner_rings: [] },
    };
    delete nuova.points;                                  // a brep pour carries no polygon points
    nuova[PEZZI_DI_TSCIRCUIT] = pezzi;
    nuove.push(nuova);
  };
  /* the literal outlines first: each takes the pieces tscircuit poured inside it */
  scritte.forEach((d, i) => {
    if (!d.outline) return;
    const netId = reteDi.get(d.net!);
    if (!netId) return;
    const outline = d.outline;
    const pezzi = pours.filter((p) => {
      if (sostituite.has(p) || String(p.layer ?? "") !== d.layer || String(p.source_net_id ?? "") !== netId) return false;
      const anello = anelloDi(p);
      return anello.length >= 3 && anello.every((v) => dentro(v.x, v.y, outline) || dalBordo(v.x, v.y, outline) < 0.01);
    });
    if (!sullaScheda(outline)) return;
    metti(i, d.layer!, netId, outline, pezzi);
  });
  /* then the whole-board ones: one per face and net, with what is left of its pieces */
  const intere = new Set<string>();
  scritte.forEach((d, i) => {
    if (!d.senzaContorno || scheda.length < 3) return;
    const k = `${d.layer}|${d.net}`;
    if (intere.has(k) || inCodice.has(k)) return;
    intere.add(k);
    const netId = reteDi.get(d.net!);
    if (!netId) return;
    const pezzi = pours.filter(
      (p) => !sostituite.has(p) && String(p.layer ?? "") === d.layer && String(p.source_net_id ?? "") === netId,
    );
    metti(i, d.layer!, netId, scheda, pezzi);
  });
  if (!nuove.length) return circuitJson;
  return [...circuitJson.filter((el) => !sostituite.has(el)), ...nuove];
}

/**
 * THE BAND ALONG THE BOARD EDGE, as obstacles.
 *
 * The solver takes one `outline` and keeps `board_edge_margin` away from it —
 * and the outline it is given here is not the board, it is the pour's own
 * boundary, the shape the file drew. So asking it for a 0.3mm edge margin ate
 * 0.3mm off the whole perimeter of every pour: the ground plane of the top face
 * came out at 73% of the copper the file has, and the small islands, which are
 * perimeter and little else, at 28% or nothing at all.
 *
 * The edge clearance belongs at the EDGE. It is handed over as a band of
 * obstacles along the board outline, so a pour that reaches the rout is cut back
 * and a pour in the middle of the board is left alone. The key says neither hole
 * nor cutout on purpose: a polygon obstacle with such a key is subtracted
 * exactly as given, which is what a measured band has to be.
 *
 * One capsule per side of the outline: the side swept by a disc of the edge
 * clearance, so the copper keeps exactly that distance from every side and
 * every corner, an arc around a corner that goes into the board. It used to be
 * a strip per side and an axis-aligned SQUARE on every vertex: along a rounded
 * stretch of outline (the bay around a mounting hole of sbb-dl-principale, a
 * vertex every 0.33mm) the squares made a staircase.
 */
export function bandaDelBordo(
  circuitJson: El[],
  faccia: string,
  bordoMm: number,
): Array<Record<string, unknown>> {
  if (bordoMm <= 0) return [];
  const contorno = contornoScheda(circuitJson);
  if (contorno.length < 3) return [];
  const fuori: Array<Record<string, unknown>> = [];
  for (let i = 0; i < contorno.length; i++) {
    const a = contorno[i];
    const b = contorno[(i + 1) % contorno.length];
    if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-9) continue;
    fuori.push({
      shape: "polygon",
      padId: `bordo_${i}`,
      layer: faccia,
      connectivityKey: `unconnected:bordo_${i}`,
      points: capsula(a, b, bordoMm),
    });
  }
  return fuori;
}

/**
 * THE POURS OF THE OTHER NETS ON THIS FACE.
 *
 * The solver carves a pour around pads, traces, vias and cutouts, and around
 * nothing else: another pour is invisible to it, which is exactly what made a
 * plane close over the islands living inside its openings. A `<copperpour>`
 * writes one ring and cannot say "there is a hole here", so the hole has to be
 * cut again at the end, and here is where.
 *
 * Only the SMALLER pours are subtracted: the big plane gives way to the island
 * and not the other way round, so the gap between them is one clearance and not
 * two, and the island keeps the shape the file drew. Handing them over with a
 * `cutout:` key is what makes the solver apply a margin at all — it offsets a
 * polygon obstacle only when the key says hole or cutout.
 *
 * The gap between two pours is the wider of their two clearances. The solver
 * cuts every cutout by this pour's own (`suaDistanza`); an island that asks
 * for more than that is handed over already grown by the difference, so the
 * plane stands back as far as the island asked.
 */
function altreColate(
  colate: El[],
  questa: El,
  areaDiQuesta: number,
  /** the clearance this pour is poured with */
  suaDistanza: number,
  /** the project's, for a pour that declares none */
  regolaMm: number,
): Array<Record<string, unknown>> {
  const fuori: Array<Record<string, unknown>> = [];
  for (const altra of colate) {
    if (altra === questa) continue;
    if (String(altra.layer ?? "") !== String(questa.layer ?? "")) continue;
    if (String(altra.source_net_id ?? "") === String(questa.source_net_id ?? "")) continue;
    const brep = altra.brep_shape as { outer_ring?: Anello } | undefined;
    const punti = brep?.outer_ring?.vertices ?? [];
    if (punti.length < 3) continue;
    const sua = area(punti);
    /* the bigger one yields; equal areas are decided by id, so the run repeats */
    const cede =
      sua < areaDiQuesta ||
      (sua === areaDiQuesta &&
        String(altra.pcb_copper_pour_id ?? "") < String(questa.pcb_copper_pour_id ?? ""));
    if (!cede) continue;
    const lontana = distanzaPropria(altra) ?? regolaMm;
    const anelli = lontana > suaDistanza ? allargaAnello(punti, lontana - suaDistanza) : [punti];
    /* the outline itself and the whole gap, for the exact obstacle (see ostacoliEsatti) */
    const esatta: FormaEsatta = { tipo: "poligono", punti: punti.map((p) => ({ x: p.x, y: p.y })) };
    anelli.forEach((anello, k) => {
      fuori.push({
        shape: "polygon",
        padId: `${String(altra.pcb_copper_pour_id ?? "")}${k > 0 ? `_${k}` : ""}`,
        layer: String(questa.layer ?? ""),
        connectivityKey: `cutout:${String(altra.pcb_copper_pour_id ?? "")}`,
        points: anello.map((p) => ({ x: p.x, y: p.y })),
        ...(k === 0 ? { formaEsatta: esatta, margineMm: Math.max(lontana, suaDistanza) } : {}),
      });
    });
  }
  return fuori;
}

const areaNetta = (forma: { outer_ring?: Anello; inner_rings?: Anello[] }): number =>
  area(forma.outer_ring?.vertices ?? []) -
  (forma.inner_rings ?? []).reduce((s, r) => s + area(r.vertices ?? []), 0);

/**
 * A splinter: a shape smaller than a square of the clearance, where there is
 * not room for anything at all. The same line for the pieces a re-pour gives
 * back and for an old shape kept because the re-pour gave nothing.
 */
export const eScheggia = (forma: { outer_ring?: Anello; inner_rings?: Anello[] }, clearanceMm: number): boolean =>
  areaNetta(forma) < clearanceMm * clearanceMm;

/**
 * THE ORDER THE POURS ARE WRITTEN IN, FOR THE GERBER.
 *
 * circuit-json-to-gerber writes the pours in the order they come, each as a
 * dark region for its outline and CLEAR regions for its holes, and a clear
 * region erases whatever was drawn before it there, other pours included. So
 * a pour whose hole covers copper of another pour must be written before it:
 * an island of another net sitting in a hole of a plane, and, on a board whose
 * ground is declared as overlapping tiles and strips, a tile of the same net
 * that reaches into the hole another tile leaves around a third net (measured
 * on sbb-dl-principale, 2026-11-11: six such pairs on the top face).
 *
 * The biggest first, then every pour after the pours whose holes cover it. If
 * two pours each cover the other with a hole, no order is right, and they keep
 * the biggest-first one.
 */
export function ordinePerIlGerber<T extends Record<string, unknown>>(pours: T[]): T[] {
  type Forma = { outer_ring?: Anello; inner_rings?: Anello[] };
  const base = pours
    .map((el, i) => ({ el, i, a: areaNetta((el.brep_shape ?? {}) as Forma) }))
    .sort((x, y) => y.a - x.a || x.i - y.i)
    .map((x) => x.el);
  const m = getManifoldModuleSync();
  if (!m || !base.some((el) => ((el.brep_shape as Forma | undefined)?.inner_rings ?? []).length > 0)) return base;
  const daLiberare: Array<{ delete(): void }> = [];
  const cs = <O extends { delete(): void }>(o: O): O => {
    daLiberare.push(o);
    return o;
  };
  try {
    const anelliDi = (el: T): Punto[][] => {
      const f = (el.brep_shape ?? {}) as Forma;
      return [f.outer_ring, ...(f.inner_rings ?? [])]
        .map((a) => a?.vertices ?? [])
        .filter((v) => v.length >= 3);
    };
    const scatola = (v: Punto[]) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of v) {
        x0 = Math.min(x0, p.x);
        y0 = Math.min(y0, p.y);
        x1 = Math.max(x1, p.x);
        y1 = Math.max(y1, p.y);
      }
      return { x0, y0, x1, y1 };
    };
    const scatole = base.map((el) => scatola((el.brep_shape as Forma | undefined)?.outer_ring?.vertices ?? []));
    const rame = new Map<number, ReturnType<typeof m.CrossSection.ofPolygons>>();
    const rameDi = (k: number) => {
      let r = rame.get(k);
      if (!r) {
        r = cs(m.CrossSection.ofPolygons(anelliDi(base[k]).map((a) => a.map((p) => [p.x, p.y] as [number, number])), "EvenOdd"));
        rame.set(k, r);
      }
      return r;
    };
    /** dopo[k]: the pours that must be written before pour k */
    const dopo = base.map(() => new Set<number>());
    base.forEach((b, j) => {
      for (const buco of ((b.brep_shape as Forma | undefined)?.inner_rings ?? []).map((r) => r.vertices ?? [])) {
        if (buco.length < 3) continue;
        const sb = scatola(buco);
        let csBuco: ReturnType<typeof m.CrossSection.ofPolygons> | null = null;
        base.forEach((a, k) => {
          if (k === j || String(a.layer ?? "") !== String(b.layer ?? "")) return;
          const sa = scatole[k];
          if (sa.x1 < sb.x0 || sa.x0 > sb.x1 || sa.y1 < sb.y0 || sa.y0 > sb.y1) return;
          csBuco ??= cs(m.CrossSection.ofPolygons([buco.map((p) => [p.x, p.y] as [number, number])], "EvenOdd"));
          if (cs(rameDi(k).intersect(csBuco)).area() > 1e-6) dopo[k].add(j);
        });
      }
    });
    const scritto = new Array<boolean>(base.length).fill(false);
    const out: T[] = [];
    while (out.length < base.length) {
      let scelto = base.findIndex((_, k) => !scritto[k] && [...dopo[k]].every((j) => scritto[j]));
      // a cycle: the biggest-first order decides
      if (scelto < 0) scelto = scritto.indexOf(false);
      scritto[scelto] = true;
      out.push(base[scelto]);
    }
    return out;
  } catch {
    return base;
  } finally {
    for (const o of daLiberare) {
      try {
        o.delete();
      } catch {
        /* already gone */
      }
    }
  }
}

export async function ricolaPiani({
  circuitJson,
  clearanceMm,
  bordoMm,
  larghezzaMinimaMm,
}: {
  circuitJson: El[];
  /**
   * The narrowest copper the project allows (its minimum trace width): no piece
   * of a pour comes out narrower than this. See pour-necks.ts. Left out, the
   * pours are kept as the solver draws them.
   */
  larghezzaMinimaMm?: number;
  /**
   * The project's pour clearance: what a pour keeps from everything else,
   * unless its element carries its own (DISTANZA_PROPRIA, written by
   * conDistanzeDichiarate), which then holds for that pour alone.
   */
  clearanceMm: number;
  /**
   * And from the edge of the board, which is a different number and a stricter
   * one: copper that reaches the rout leaves burrs and shorts on the panel.
   * Trusting the outline for it was wrong — measured 0.207mm against a rule that
   * asks for 0.3.
   */
  bordoMm: number;
}): Promise<EsitoRicolata> {
  const pours = circuitJson.filter((el) => el.type === "pcb_copper_pour");
  if (pours.length === 0) {
    return { circuitJson, ricolate: 0, areaPrimaMm2: 0, areaDopoMm2: 0, padRuotatiAggiunti: 0, colateScavate: 0, bricioleTolte: 0, orfaneTolte: 0, viaRiconosciute: 0, colateSparite: [], colliTagliatiMm2: 0 };
  }

  await initializeManifoldGeometry();
  const serviti = planeServedPorts(circuitJson, readPours(circuitJson));
  const punti = ancore(circuitJson, serviti);
  /** which net every via is on, read from the key the element carries */
  const netDiVia = new Map<string, string>();
  {
    const netDiChiave = new Map<string, string>();
    for (const el of circuitJson) {
      if (el.type !== "source_net") continue;
      const k = String(el.subcircuit_connectivity_map_key ?? "");
      if (k) netDiChiave.set(k, String(el.source_net_id ?? ""));
    }
    for (const el of circuitJson) {
      if (el.type !== "pcb_via") continue;
      const net = netDiChiave.get(String(el.subcircuit_connectivity_map_key ?? ""));
      if (net) netDiVia.set(String(el.pcb_via_id ?? ""), net);
    }
  }

  const nuovi: El[] = [];
  let areaPrima = 0;
  let areaDopo = 0;
  let ricolate = 0;
  let aggiunti = 0;
  let scavate = 0;
  let briciole = 0;
  let orfane = 0;
  let riconosciute = 0;
  let colli = 0;
  const sparite: string[] = [];
  /** pieces already named per original pour: ids stay unique across its fragments */
  const pezziDi = new Map<string, number>();

  for (const pour of pours) {
    const brep = pour.brep_shape as { outer_ring?: Anello; inner_rings?: Anello[] } | undefined;
    const contorno = brep?.outer_ring?.vertices ?? [];
    if (contorno.length < 3) {
      nuovi.push(pour);
      continue;
    }
    areaPrima += areaNetta(brep ?? {});
    /* the distance this pour keeps: its own when its <copperpour> declares one */
    const suaDistanza = distanzaPropria(pour) ?? clearanceMm;

    /*
     * The outline is the one this pour already has: the shape the file drew,
     * board edge already accounted for. What is recomputed is what it has to
     * keep away from — and this time the imported copper is in the room.
     */
    const problema = convertCircuitJsonToInputProblem(
      circuitJson as never,
      {
        layer: String(pour.layer) as never,
        source_net_id: String(pour.source_net_id ?? ""),
        pad_margin: suaDistanza,
        trace_margin: suaDistanza,
        /* zero on purpose: the edge is kept by the band, see bandaDelBordo */
        board_edge_margin: 0,
        cutout_margin: suaDistanza,
        outline: contorno,
      } as never,
    );

    /* the rotated pads the converter dropped on the floor, and the pours it
     * cannot see at all */
    const mancanti = padRuotati(
      circuitJson,
      String(pour.layer),
      String(pour.source_net_id ?? ""),
      suaDistanza,
      serviti,
    );
    riconosciute += riconosciLeVia(
      problema as never,
      netDiVia,
      String(pour.source_net_id ?? ""),
    );
    const vicine = altreColate(pours, pour, areaNetta(brep ?? {}), suaDistanza, clearanceMm);
    const bordo = bandaDelBordo(circuitJson, String(pour.layer), bordoMm);
    const passanti = viePassanti(
      circuitJson,
      String(pour.layer),
      String(pour.source_net_id ?? ""),
      netDiVia,
      (problema as unknown as { regionsForPour?: Array<{ connectivityKey?: string }> }).regionsForPour?.[0]
        ?.connectivityKey,
    );
    const p = problema as unknown as {
      pads?: Array<Record<string, unknown>>;
      regionsForPour?: Array<{ connectivityKey?: string; padMargin?: number; traceMargin?: number; cutout_margin?: number }>;
    };
    p.pads = [...(p.pads ?? []), ...mancanti, ...vicine, ...bordo, ...passanti];
    aggiunti += mancanti.length;
    scavate += vicine.length;
    /*
     * And every one of them drawn here, grown by the clearance with round
     * corners and arcs within 2 micrometres, instead of by the solver: see
     * ostacoliEsatti. Only those that reach this pour's box.
     */
    {
      const regione = p.regionsForPour?.[0];
      const margini = {
        pad: regione?.padMargin ?? suaDistanza,
        trace: regione?.traceMargin ?? suaDistanza,
        cutout: regione?.cutout_margin ?? suaDistanza,
      };
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const q of contorno) {
        minX = Math.min(minX, q.x);
        minY = Math.min(minY, q.y);
        maxX = Math.max(maxX, q.x);
        maxY = Math.max(maxY, q.y);
      }
      const d = 0.01;
      p.pads = ostacoliEsatti(p.pads, regione?.connectivityKey, margini, { minX: minX - d, minY: minY - d, maxX: maxX + d, maxY: maxY + d });
    }

    /*
     * A plane that will not solve keeps the shape it had: better the old one
     * than none, and the numbers below say it did not change. Unless the old
     * one is itself a splinter: on BIRDY_BAT v1.1 a ground polygon squeezed
     * between two RTC pins 0.4 mm apart (0.2 of clearance from each) came out
     * of the compiler as a strip 0.0001 mm wide, the re-pour found no room and
     * gave nothing back, and the strip went to the Gerber as copper 0.025 mm
     * from a trace. A kept shape passes the same splinter test as a new one.
     */
    /*
     * A pour put back on its declared outline (conContorniDichiarati) has no
     * old shape of its own: its outline is carved around nothing. What it keeps
     * instead are the pieces tscircuit poured for it, under the same splinter
     * test: carved by tscircuit at least, and a plane left over a hole by them
     * is what keeps the board out of the export (see motoreDaSalvare).
     */
    const diTscircuit = pour[PEZZI_DI_TSCIRCUIT];
    const tieni = (): void => {
      const vecchie = diTscircuit ?? [pour];
      let tenute = 0;
      for (const vecchia of vecchie) {
        const forma = (vecchia.brep_shape ?? {}) as { outer_ring?: Anello; inner_rings?: Anello[] };
        if (eScheggia(forma, suaDistanza)) {
          briciole++;
          continue;
        }
        nuovi.push(vecchia);
        tenute++;
      }
      if (tenute === 0) sparite.push(String(pour.pcb_copper_pour_id ?? "").replace(/(_r\d+)+$/, ""));
    };
    let forme: Array<{ outer_ring?: Anello; inner_rings?: Anello[] }> = [];
    try {
      forme = new CopperPourPipelineSolver(problema).getOutput().brep_shapes ?? [];
    } catch {
      tieni();
      continue;
    }
    if (forme.length === 0) {
      tieni();
      continue;
    }

    // the pour's own vias and pads, whole inside it: see abbracciaRamePropio
    const propri = ramePropio(circuitJson, String(pour.layer), String(pour.source_net_id ?? ""), netDiVia, serviti);
    forme = abbracciaRamePropio(forme, propri);

    // no neck narrower than a trace: see pour-necks.ts. AFTER the union, and the
    // union once more after it, because the opening rounds the joint of a ring
    // The corners of the outline the pour was drawn with stay sharp where
    // nothing cuts them; the corners the clearances cut are rounded.
    if (larghezzaMinimaMm && larghezzaMinimaMm > 0) {
      const prima = forme.reduce((t, f) => t + areaNetta(f), 0);
      forme = forme.flatMap((f) => senzaColliStretti(f, larghezzaMinimaMm, contorno));
      colli += Math.max(0, prima - forme.reduce((t, f) => t + areaNetta(f), 0));
      forme = abbracciaRamePropio(forme, propri);
    }
    // and no point a CAD would not write: see anelloPulito
    forme = forme.map(formaPulita);

    ricolate++;
    /*
     * The id of the pour as the FILE has it: a second run on an already
     * re-poured board used to name its pieces `_r0_r0`, then `_r0_r0_r0`,
     * and nothing downstream recognised them as the same plane.
     */
    const radice = String(pour.pcb_copper_pour_id ?? "").replace(/(_r\d+)+$/, "");
    let tenuti = 0;
    forme.forEach((forma) => {
      /*
       * The splinters go in the bin. Cutting a plane with booleans leaves
       * shapes of a thousandth of a square millimetre — 97 of this board's 203,
       * a third of a square millimetre in all: nothing a fab can hold and
       * nothing that carries current, but each one is a pour of its own, drawn
       * on the screen and reported as dead copper by the electrical checks. The
       * line is a square of the minimum clearance, under which there is not
       * room for anything at all.
       */
      const suaArea = areaNetta(forma);
      if (eScheggia(forma, suaDistanza)) {
        briciole++;
        return;
      }
      /*
       * And the scraps that hold nothing. A piece under a square millimetre with
       * no pad, no via and no trace of its net inside it is copper that connects
       * nothing: the file drew the island whole and our clearances cut a corner
       * of it loose. Left in, the electrical check reports it as dead copper,
       * which it is. Big pieces are never dropped, however empty they look:
       * losing a plane by mistake is not worth a tidy report.
       */
      if (suaArea < 1) {
        const anello = forma.outer_ring?.vertices ?? [];
        const suoi = punti.get(String(pour.source_net_id ?? "")) ?? [];
        if (anello.length >= 3 && !suoi.some((q) => dentro(q.x, q.y, anello))) {
          orfane++;
          return;
        }
      }
      areaDopo += suaArea;
      tenuti++;
      const n = pezziDi.get(radice) ?? 0;
      pezziDi.set(radice, n + 1);
      const pezzo: El = {
        ...pour,
        pcb_copper_pour_id: `${radice}_r${n}`,
        brep_shape: forma,
      };
      delete pezzo[PEZZI_DI_TSCIRCUIT];
      nuovi.push(pezzo);
    });
    if (tenuti === 0) sparite.push(radice || String(pour.pcb_copper_pour_id ?? ""));
  }

  const ordinate = ordinePerIlGerber(nuovi);

  return {
    circuitJson: [...circuitJson.filter((el) => el.type !== "pcb_copper_pour"), ...ordinate],
    ricolate,
    areaPrimaMm2: Number(areaPrima.toFixed(1)),
    areaDopoMm2: Number(areaDopo.toFixed(1)),
    padRuotatiAggiunti: aggiunti,
    colateScavate: scavate,
    bricioleTolte: briciole,
    orfaneTolte: orfane,
    viaRiconosciute: riconosciute,
    colateSparite: sparite,
    colliTagliatiMm2: Number(colli.toFixed(3)),
  };
}

/**
 * A BOARD POURED WHEN ITS PLANES COULD NOT SEE EVERY HOLE, POURED AGAIN.
 *
 * For a board that is RE-EVALUATED instead of compiled (POST /api/recheck).
 * Before ENGINE_VIE_PASSANTI a via written on part of the stack was invisible
 * to the planes of the layers it left out (see viePassanti), so the saved board
 * of such an engine can carry a plane with no opening around a hole of another
 * net. A recheck files the board under today's engine, which is what lets it be
 * exported: it must not certify those planes. They are poured again here, by
 * the same solver and with the project's distances, each from the piece the
 * board already has, and a pour whose element carries its own clearance with
 * that one (the caller writes it from today's files: conDistanzeDichiarate).
 *
 * Only a board that has such a via AND was made by an older engine, or a
 * board on which a plane covers a via of another net today, whatever made it:
 * a via drawn by hand and laid by the fast update, which never pours, stands in
 * the planes it crosses until somebody pours them again, and the export
 * refuses the board until then (pianiSopraLeVie). Every other board keeps its
 * planes to the last vertex: pouring again is not free of rounding, and a board
 * checked and about to be ordered must come out of a recheck with the copper it
 * went in with.
 *
 * `ricolata` says that the planes went through the solver, NOT that they came
 * back opened. ricolaPiani keeps the shape a pour had whenever its solver
 * throws or gives nothing back (see `tieni` there), and from here nobody can
 * tell which. What keeps such a board out of the export is the measure made on
 * the result: a via whose pad is still in the copper of another net's plane
 * (CompileSummary.planesOverVias) and the engine the board is then filed under
 * (motoreDaSalvare). Only a failure of the whole step reaches the caller as an
 * error.
 */
export async function ricolaSeLeVieEranoParziali({
  circuitJson,
  engineVersion,
  clearanceMm,
  bordoMm,
  larghezzaMinimaMm,
}: {
  circuitJson: El[];
  /** the engine the saved board was made with */
  engineVersion: number;
  clearanceMm: number;
  bordoMm: number;
  larghezzaMinimaMm?: number;
}): Promise<{ circuitJson: El[]; ricolata: boolean; vieParziali: number }> {
  const vieParziali = vieDichiarateParziali(circuitJson);
  const diUnMotoreDiPrima = vieParziali > 0 && engineVersion < ENGINE_VIE_PASSANTI;
  if (!diUnMotoreDiPrima && !pianiSopraLeVie(circuitJson)) return { circuitJson, ricolata: false, vieParziali };
  const esito = await ricolaPiani({ circuitJson: vieSemprePassanti(circuitJson), clearanceMm, bordoMm, larghezzaMinimaMm });
  return { circuitJson: esito.circuitJson, ricolata: esito.ricolate > 0, vieParziali };
}

export { num };
