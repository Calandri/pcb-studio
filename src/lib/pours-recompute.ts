import {
  convertCircuitJsonToInputProblem,
  CopperPourPipelineSolver,
  initializeManifoldGeometry,
} from "@tscircuit/copper-pour-solver";

import { planeServedPorts, readPours } from "./pours";
import { senzaColliStretti } from "./pour-necks";

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
 * A via that spans top to bottom crosses every inner layer, so it is handed
 * over on that layer too: as an obstacle when it belongs to another net, with
 * the pour's own key when it is the plane's net, so it stays connected.
 */
export function viePassanti(
  circuitJson: El[],
  faccia: string,
  netDellaColata: string,
  netDiVia: Map<string, string>,
  chiaveColata: string | undefined,
): Array<Record<string, unknown>> {
  if (faccia === "top" || faccia === "bottom") return [];
  const fuori: Array<Record<string, unknown>> = [];
  for (const el of circuitJson) {
    if (el.type !== "pcb_via") continue;
    const strati = (el.layers as string[] | undefined) ?? [];
    if (strati.includes(faccia)) continue; // the converter already has it
    if (!(strati.includes("top") && strati.includes("bottom"))) continue; // blind or buried: not through here
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
 * therefore handed over already grown by the project's clearance; a polygon
 * pad, whose outline cannot be grown by hand without getting concave corners
 * wrong, goes with a `cutout:` key, so the solver offsets it itself; a pill
 * goes as a pill, which the solver grows by the pad margin.
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
        poligono(id, rettangoloRuotato(x, y, w, h, num(el.ccw_rotation) ?? 0, margineMm));
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
        poligono(id, rettangoloRuotato(x, y, w, h, num(el.rect_ccw_rotation) ?? 0, margineMm));
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
        poligono(id, rettangoloRuotato(x, y, w, h, 0, margineMm));
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
 */
export function bandaDelBordo(
  circuitJson: El[],
  faccia: string,
  bordoMm: number,
): Array<Record<string, unknown>> {
  if (bordoMm <= 0) return [];
  const board = circuitJson.find((el) => el.type === "pcb_board");
  if (!board) return [];
  const centro = (board.center as { x?: number; y?: number } | undefined) ?? {};
  const cx = num(centro.x) ?? 0;
  const cy = num(centro.y) ?? 0;
  const w = num(board.width);
  const h = num(board.height);
  /*
   * The drawn outline when it IS one — three real points at least. An empty
   * `outline: []` (what an export with no custom shape leaves) used to win
   * over width/height and give no band at all, and a point with a missing
   * coordinate went to 0.
   */
  const disegnato = Array.isArray(board.outline)
    ? (board.outline as Array<{ x?: unknown; y?: unknown }>)
        .map((p) => ({ x: num(p?.x), y: num(p?.y) }))
        .filter((p): p is { x: number; y: number } => p.x !== null && p.y !== null)
    : [];
  const contorno = disegnato.length >= 3
    ? disegnato
    : w !== null && h !== null
      ? [
          { x: cx - w / 2, y: cy - h / 2 },
          { x: cx + w / 2, y: cy - h / 2 },
          { x: cx + w / 2, y: cy + h / 2 },
          { x: cx - w / 2, y: cy + h / 2 },
        ]
      : [];
  if (contorno.length < 3) return [];

  const fuori: Array<Record<string, unknown>> = [];
  for (let i = 0; i < contorno.length; i++) {
    const a = contorno[i];
    const b = contorno[(i + 1) % contorno.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l = Math.hypot(dx, dy);
    if (l < 1e-9) continue;
    /* the strip that follows the edge, half of it inside the board */
    const nx = (-dy / l) * bordoMm;
    const ny = (dx / l) * bordoMm;
    fuori.push({
      shape: "polygon",
      padId: `bordo_${i}`,
      layer: faccia,
      connectivityKey: `unconnected:bordo_${i}`,
      points: [
        { x: a.x + nx, y: a.y + ny },
        { x: b.x + nx, y: b.y + ny },
        { x: b.x - nx, y: b.y - ny },
        { x: a.x - nx, y: a.y - ny },
      ],
    });
    /* and a square on the corner, or the strips leave a notch where they meet */
    fuori.push({
      shape: "polygon",
      padId: `angolo_${i}`,
      layer: faccia,
      connectivityKey: `unconnected:angolo_${i}`,
      points: [
        { x: a.x - bordoMm, y: a.y - bordoMm },
        { x: a.x + bordoMm, y: a.y - bordoMm },
        { x: a.x + bordoMm, y: a.y + bordoMm },
        { x: a.x - bordoMm, y: a.y + bordoMm },
      ],
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
 */
function altreColate(
  colate: El[],
  questa: El,
  areaDiQuesta: number,
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
    fuori.push({
      shape: "polygon",
      padId: String(altra.pcb_copper_pour_id ?? ""),
      layer: String(questa.layer ?? ""),
      connectivityKey: `cutout:${String(altra.pcb_copper_pour_id ?? "")}`,
      points: punti.map((p) => ({ x: p.x, y: p.y })),
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
  /** the project's minimum spacing: what the pour keeps from everything else */
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
        pad_margin: clearanceMm,
        trace_margin: clearanceMm,
        /* zero on purpose: the edge is kept by the band, see bandaDelBordo */
        board_edge_margin: 0,
        cutout_margin: clearanceMm,
        outline: contorno,
      } as never,
    );

    /* the rotated pads the converter dropped on the floor, and the pours it
     * cannot see at all */
    const mancanti = padRuotati(
      circuitJson,
      String(pour.layer),
      String(pour.source_net_id ?? ""),
      clearanceMm,
      serviti,
    );
    riconosciute += riconosciLeVia(
      problema as never,
      netDiVia,
      String(pour.source_net_id ?? ""),
    );
    const vicine = altreColate(pours, pour, areaNetta(brep ?? {}));
    const bordo = bandaDelBordo(circuitJson, String(pour.layer), bordoMm);
    const passanti = viePassanti(
      circuitJson,
      String(pour.layer),
      String(pour.source_net_id ?? ""),
      netDiVia,
      (problema as unknown as { regionsForPour?: Array<{ connectivityKey?: string }> }).regionsForPour?.[0]
        ?.connectivityKey,
    );
    if (mancanti.length + vicine.length + bordo.length + passanti.length > 0) {
      const p = problema as unknown as { pads?: Array<Record<string, unknown>> };
      p.pads = [...(p.pads ?? []), ...mancanti, ...vicine, ...bordo, ...passanti];
      aggiunti += mancanti.length;
      scavate += vicine.length;
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
    const tieni = (): void => {
      if (eScheggia(brep ?? {}, clearanceMm)) {
        briciole++;
        sparite.push(String(pour.pcb_copper_pour_id ?? "").replace(/(_r\d+)+$/, ""));
        return;
      }
      nuovi.push(pour);
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

    // no neck narrower than a trace: see pour-necks.ts
    if (larghezzaMinimaMm && larghezzaMinimaMm > 0) {
      const prima = forme.reduce((t, f) => t + areaNetta(f), 0);
      forme = forme.flatMap((f) => senzaColliStretti(f, larghezzaMinimaMm));
      colli += Math.max(0, prima - forme.reduce((t, f) => t + areaNetta(f), 0));
    }

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
      if (eScheggia(forma, clearanceMm)) {
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
      nuovi.push({
        ...pour,
        pcb_copper_pour_id: `${radice}_r${n}`,
        brep_shape: forma,
      });
    });
    if (tenuti === 0) sparite.push(radice || String(pour.pcb_copper_pour_id ?? ""));
  }

  return {
    circuitJson: [...circuitJson.filter((el) => el.type !== "pcb_copper_pour"), ...nuovi],
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

export { num };
