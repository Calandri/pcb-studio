/**
 * From Circuit JSON to the shapes to draw. It is separate from the React
 * component because it is pure, verifiable logic: which elements exist, which
 * layer they are on, what geometry they have. The actual drawing is in BoardCanvas.
 *
 * Coordinates in mm with the board center at (0,0) and y upward, as in the
 * Circuit JSON. The canvas handles the axis flip for the screen.
 */

import { courtyardShape, footprintBoxes, type CourtyardShape } from "@/lib/footprint-bounds";
import { INGOMBRO_ECCEDENZA_MM } from "@/lib/design-rules";
import { retiDelCircuito } from "@/lib/gruppi-di-rame";
import { leggiIngombri, type Forma } from "@/lib/ingombro";
import { COLORE_DEL_RAME, eStratoDiRame, pilaDiRame, type StratoDiRame } from "@/lib/strati-rame";

export interface El {
  type: string;
  [key: string]: unknown;
}

/** a copper layer of the board: the names are in one place, strati-rame.ts */
export type LayerId = StratoDiRame;

/**
 * The copper layers of a board in stackup order, top first: Top, Inner 1 ...
 * Inner N-2, Bottom, from the number the board declares (strati-rame.ts says
 * what an odd or a missing number gives).
 */
export function layerStack(layerCount: number): LayerId[] {
  return pilaDiRame(layerCount);
}

/** the same layers from the bottom up: the order they are painted in, so the top lies over the others */
export function layerDrawOrder(layerCount: number): LayerId[] {
  return layerStack(layerCount).reverse();
}

/**
 * What keys 1, 2, 3... pick, in stackup order: 1 = Top, then the inner layers,
 * the last one = Bottom (1 = Top, 4 = Bottom on a 4-layer board, 1 = Top,
 * 6 = Bottom on a 6-layer one, 2 = Bottom on a 2-layer one). A key past the
 * last layer picks nothing, and 0 is all of them.
 */
export function layerForKey(key: string, layerCount: number): LayerId | "all" | null {
  if (key === "0") return "all";
  if (!/^[1-9]$/.test(key)) return null;
  return layerStack(layerCount)[Number(key) - 1] ?? null;
}

/** copper: top is the warmest, the inner ones are told apart at a glance (see COLORE_DEL_RAME) */
export const LAYER_COLOR: Record<LayerId, string> = COLORE_DEL_RAME;

/**
 * I PAD NON SONO PISTE, e devono vedersi.
 *
 * Disegnati dello stesso colore del rame, una fila di pad di un LQFP e' un
 * pettine di barrette parallele che si interrompono nel nulla: chi guarda legge
 * "piste che fanno cose impossibili", e ha ragione a leggerlo cosi', perche'
 * quelle barrette come piste non avrebbero senso. Un tono piu' chiaro basta a
 * dire "questo e' un piedino": e' la convenzione di ogni CAD, e costa un colore.
 */
export const PAD_COLOR: Record<LayerId, string> = {
  top: "#F7CE8B",
  inner1: "#8DF3D0",
  inner2: "#B6D4FF",
  // the copper colour of the layer, 43% of the way to white, like the two above
  inner3: "#FFBFDF",
  inner4: "#D5F29D",
  inner5: "#9AE4EE",
  inner6: "#E9D4FF",
  bottom: "#DCB176",
};

export interface Board {
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  layers: number;
  thickness: number;
  /**
   * The real shape of the board, in board millimetres, when the project
   * declares one (`pcb_board.outline`): notches for a connector body, cut
   * corners, an L. Absent on a plain rectangle, where width and height say it
   * all.
   */
  outline?: Array<{ x: number; y: number }>;
}

/**
 * The outline worth drawing: at least three points, all finite. Anything else
 * (missing, a stub of two points, a NaN from a bad import) is no outline, and
 * the board falls back to its rectangle instead of drawing a broken shape.
 */
export function readBoardOutline(raw: unknown): Array<{ x: number; y: number }> | undefined {
  if (!Array.isArray(raw) || raw.length < 3) return undefined;
  const out: Array<{ x: number; y: number }> = [];
  for (const p of raw as Array<{ x?: unknown; y?: unknown } | null>) {
    const x = p?.x;
    const y = p?.y;
    if (typeof x !== "number" || typeof y !== "number") return undefined;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
    out.push({ x, y });
  }
  return out;
}

/**
 * The board as an SVG path, or null when it is a plain rectangle.
 *
 * The canvases drew `width` x `height` no matter what, so a board with a notch
 * for the USB connector looked whole on screen: parts could be dropped into
 * the cut and nothing said the laminate is not there. The polygon already
 * carries its own fillets, so it is drawn as it is.
 */
export function boardOutlinePath(board: Board): string | null {
  const pts = board.outline;
  if (!pts || pts.length < 3) return null;
  return `${pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join(" ")} Z`;
}

export interface TraceSeg {
  layer: LayerId;
  width: number;
  points: Array<{ x: number; y: number }>;
  netKey: string;
  /** source pcb_trace_id: needed to select/detach the whole trace */
  traceId: string;
  /** connection name (display_name of the source_trace) */
  connectionName: string | null;
  /** source_trace it implements: autorouted copper is named by the solver, this is stable */
  sourceTraceId: string | null;
}

export interface Pad {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  radius: number;
  layer: LayerId;
  circle: boolean;
  /**
   * Degrees the pad is turned by, counterclockwise.
   *
   * A pad can be at an angle: the two pads of a crystal drawn on the diagonal,
   * a connector mounted at 45. The circuit says so in `ccw_rotation` and the
   * drawing ignored it, so the pads came out square inside a silkscreen box
   * drawn as a diamond. It is the first thing the eye catches.
   */
  rot: number;
  /**
   * How far the solder mask opening goes beyond the pad, in millimetres.
   *
   * On a board there is a ring of bare laminate around every pad: the coating
   * stops short so the solder has somewhere to sit. Drawing the pad without it
   * gives copper that ends where the green begins, which is not what anybody
   * sees when they look at a board or at the CAD it came from.
   */
  maskMargin: number;
  componentId: string;
  /** pin name, as on the schematic: VDD, CLOCK, pin3... */
  pin: string;
  /** which connection it belongs to: two pads with the same key must be joined */
  net: string;
  /** the net name when it has one: GND, P3V3, MIC_3V3... */
  netName: string;
  /**
   * A through-hole pin (pcb_plated_hole with a port): a pin like any other for
   * nets, names, highlighting and connection lines, drawn by the hole code and
   * not as a pad. J4 on sbb-dl-retro, the button connector, had five pins with
   * no net and no name on hover because only SMD pads were pins (2026-11-09).
   */
  foro?: boolean;
}

export interface Via {
  id: string;
  x: number;
  y: number;
  hole: number;
  outer: number;
}

export interface Hole {
  id: string;
  x: number;
  y: number;
  hole: number;
  /** the copper ring's diameter; for a non-plated hole it is the drill itself */
  outer: number;
  padW: number;
  padH: number;
  rect: boolean;
  componentId: string;
  /**
   * false for a pcb_hole: a bare drill, with no copper around it. Drawn with
   * the ring of a plated hole, the 2.1mm mounting holes of htl-401 showed a
   * 3.4mm copper ring over the modem pads that the files do not have.
   */
  plated: boolean;
}

/** the colour of a plated hole's copper */
export const HOLE_COPPER = "#E8A33C";

/**
 * The copper around a hole, or null when there is none. Only a plated hole has
 * copper: a mechanical hole (pcb_hole) is a drill in the bare laminate, and a
 * ring drawn around it reads as copper touching whatever sits next to it.
 */
export function holeCopper(
  h: Hole,
): { kind: "rect"; x: number; y: number; w: number; h: number } | { kind: "circle"; r: number } | null {
  if (!h.plated) return null;
  if (h.rect && h.padW > 0) {
    return { kind: "rect", x: h.x - h.padW / 2, y: h.y - h.padH / 2, w: h.padW, h: h.padH };
  }
  return { kind: "circle", r: h.outer / 2 };
}

export interface Paste {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** the stencil opening follows the pad: if the pad is turned, so is this */
  rot: number;
  layer: LayerId;
  circle: boolean;
  componentId: string;
}

export interface SilkPath {
  id: string;
  layer: LayerId;
  width: number;
  points: Array<{ x: number; y: number }>;
  componentId: string;
}

export interface SilkText {
  id: string;
  x: number;
  y: number;
  size: number;
  text: string;
  layer: LayerId;
  rotation: number;
  componentId: string;
}

/**
 * A courtyard of any kind (rect, circle, pill, outline, polygon), as
 * footprint-bounds.ts reads it: only rects used to be drawn, and the boards
 * imported from KiCad/EasyEDA carry outlines (222 on fototrappola-frontale,
 * none on screen).
 */
export interface Courtyard {
  id: string;
  shape: CourtyardShape;
  componentId: string;
}

export interface Pour {
  id: string;
  layer: LayerId;
  path: string;
  /** the net it is copper of (source_net_id), to paint the pours of one net as one area */
  net: string;
}

/** the pours of one net on one layer, painted together (see colatePerRete) */
export interface ColateDiUnaRete {
  key: string;
  layer: LayerId;
  net: string;
  pours: Pour[];
}

/**
 * THE POURS OF ONE NET ON ONE LAYER ARE ONE AREA OF COPPER.
 *
 * A board drawn by a script declares its ground as tiles that overlap by a
 * tenth of a millimetre so that they fuse, and its hand strips inside the big
 * pour: on sbb-dl-principale (2026-11-11) 197 pairs of ground pours overlap on
 * the bottom face, 152 on the top. Electrically it is one net. But each pour
 * was painted with its own transparency, so where two overlap the colour
 * doubled, and a band 0.1 mm wide and 20 mm long read as a trace across the
 * plane ("sistema ste linee di overlap dritte che sembrano piste").
 *
 * So the pours are grouped by layer and net, in the order they come: the
 * canvas paints each group opaque inside and gives the group its transparency
 * once, so overlaps do not add up and the seams disappear. Pours of two
 * different nets stay in two groups: if they ever overlap, which is a short,
 * the overlap still shows.
 */
export function colatePerRete(pours: Pour[], layer?: LayerId): ColateDiUnaRete[] {
  const gruppi = new Map<string, ColateDiUnaRete>();
  for (const p of pours) {
    if (layer !== undefined && p.layer !== layer) continue;
    const key = `${p.layer}|${p.net}`;
    const g = gruppi.get(key);
    if (g) g.pours.push(p);
    else gruppi.set(key, { key, layer: p.layer, net: p.net, pours: [p] });
  }
  return [...gruppi.values()];
}

export interface ComponentBox {
  id: string;
  sourceId: string;
  /** the name written in the code: R1, U3, C_MIC1 */
  name: string;
  x: number;
  y: number;
  /**
   * The ORIGIN of the component (the requested pcbX/pcbY), which is not its
   * centre when the footprint is off-centre: on the MEMS microphones the two
   * are 0,28 mm apart. The rotation turns around the origin — that is what
   * tscircuit does when it compiles — so the preview needs it, otherwise on
   * screen the part turns around one point and after saving around another.
   */
  ox: number;
  oy: number;
  /**
   * The REAL footprint (footprint-bounds.ts): courtyard, else pads and body,
   * else pads. It used to be pcb_component width/height, which tscircuit
   * computes from pads and holes only: on st-camera 98 parts out of 243 looked
   * smaller than their body, and were placed on top of each other.
   */
  w: number;
  h: number;
  /** where the centre of that footprint is, relative to (x, y): it is off-centre on connectors */
  dx: number;
  dy: number;
  rotation: number;
  layer: LayerId;
}

export interface Marker {
  id: string;
  x: number;
  y: number;
  message: string;
  severity: "err" | "warn";
  /**
   * The face (or layer) the finding is on: the marker follows the rule of
   * strati-visibili.ts like what it is about. Absent or "all": on every layer
   * (holes, vias, the edge, what touches both faces), always drawn.
   */
  layer?: LayerId | "all";
}

/**
 * The footprint of a part in assembly (ingombro.ts): the declared courtyard,
 * or the rectangle around body and pads grown by the project's excess, with
 * the room a connector's mating part takes (spaziDiInnesto). Drawn in the
 * views that show courtyards and in Sposta.
 */
export interface IngombroScena {
  componentId: string;
  name: string;
  layer: "top" | "bottom";
  forme: Forma[];
  /** declared in the footprint (a continuous line) or computed by PCB Studio (dashed) */
  dichiarato: boolean;
  /** computed from the pads alone: the real body is missing */
  senzaCorpo: boolean;
  /** a through-hole part on the other face: its holes and rings, for the collisions only */
  fori: Forma[];
  innesti: Array<{ forma: Forma; descrizione: string | null }>;
}

export interface BoardScene {
  board: Board;
  pours: Pour[];
  traces: TraceSeg[];
  pads: Pad[];
  vias: Via[];
  holes: Hole[];
  paste: Paste[];
  silkPaths: SilkPath[];
  silkTexts: SilkText[];
  courtyards: Courtyard[];
  /** the footprint of every part (see IngombroScena) */
  ingombri: IngombroScena[];
  /**
   * The footprints could not be computed, and why: the board is drawn all the
   * same, without them, and the viewer says so in a line (never silence, never
   * a blank PCB view).
   */
  ingombriNonCalcolati?: string;
  components: ComponentBox[];
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * The layer an element says it is on. inner3 and inner4 used to fall back on
 * the top here, so the copper of a 6-layer board was drawn on the wrong layer.
 */
const asLayer = (v: unknown, fallback: LayerId = "top"): LayerId => {
  const s = String(v ?? "");
  return eStratoDiRame(s) ? s : fallback;
};

export function buildScene(
  circuitJson: unknown[] | null,
  /** the project's componentCourtyardExcessMm, for the footprints PCB Studio computes */
  opts: { eccedenzaIngombroMm?: number } = {},
): BoardScene | null {
  if (!circuitJson) return null;
  const elements = circuitJson as El[];

  const boardEl = elements.find((e) => e.type === "pcb_board");
  if (!boardEl) return null;
  const center = (boardEl.center as { x?: number; y?: number } | undefined) ?? {};
  const board: Board = {
    width: num(boardEl.width) ?? 100,
    height: num(boardEl.height) ?? 100,
    centerX: num(center.x) ?? 0,
    centerY: num(center.y) ?? 0,
    layers: num(boardEl.num_layers) ?? 2,
    thickness: num(boardEl.thickness) ?? 1.6,
  };
  const outline = readBoardOutline(boardEl.outline);
  if (outline) board.outline = outline;

  /*
   * Who every pad is: the name of its pin and the connection it belongs to.
   *
   * Needed to say, looking at a component, WHO it is connected to and from
   * which pin - the information that someone moving a part needs more than
   * any other, and that the drawing alone does not carry: on copper a pad is
   * a rectangle like any other.
   *
   * Which pins are one connection is read from the schematic traces, in
   * gruppi-di-rame.ts (retiDelCircuito): the same nets the open connections
   * and the groups of copper are counted by.
   */
  const reti = retiDelCircuito(elements);
  const pinOfPort = reti.pinDiPorta;
  const netOfPort = reti.diPorta;
  const netNameOfPort = reti.nomeDiPorta;
  /** the real footprint of every part: see footprint-bounds.ts */
  const ingombri = footprintBoxes(elements);
  const nomeComponente = new Map<string, string>();
  for (const el of elements) {
    if (el.type === "source_component" && el.source_component_id) {
      nomeComponente.set(String(el.source_component_id), String(el.name ?? ""));
    }
  }
  const scene: BoardScene = {
    board,
    pours: [],
    traces: [],
    pads: [],
    vias: [],
    holes: [],
    paste: [],
    silkPaths: [],
    silkTexts: [],
    courtyards: [],
    ingombri: [],
    components: [],
  };
  try {
    scene.ingombri = leggiIngombri(elements, opts.eccedenzaIngombroMm ?? INGOMBRO_ECCEDENZA_MM).map((p) => ({
      componentId: p.id,
      name: p.nome,
      layer: p.faccia,
      forme: p.forme,
      dichiarato: p.fonte === "cortile",
      senzaCorpo: p.senzaCorpo,
      fori: p.fori,
      innesti: p.innesti,
    }));
  } catch (err) {
    // one odd footprint must not take the whole PCB view down: see ingombriNonCalcolati
    scene.ingombriNonCalcolati = (err instanceof Error ? err.message : String(err)).slice(0, 120);
    console.error("ingombri non calcolati:", err);
  }

  for (const el of elements) {
    switch (el.type) {
      case "pcb_copper_pour": {
        const brep = el.brep_shape as
          | {
              outer_ring?: { vertices?: Array<{ x: number; y: number }> };
              inner_rings?: Array<{ vertices?: Array<{ x: number; y: number }> }>;
            }
          | undefined;
        const ring = (vs?: Array<{ x: number; y: number }>) =>
          vs && vs.length > 2
            ? `M ${vs.map((v) => `${v.x} ${v.y}`).join(" L ")} Z`
            : "";
        const outer = ring(brep?.outer_ring?.vertices);
        if (!outer) break;
        // the holes in the plane (islands around pads and vias) are inner rings:
        // with fill-rule evenodd they punch the fill without being drawn apart
        const inner = (brep?.inner_rings ?? []).map((r) => ring(r.vertices)).join(" ");
        scene.pours.push({
          id: String(el.pcb_copper_pour_id ?? `pour${scene.pours.length}`),
          layer: asLayer(el.layer),
          path: `${outer} ${inner}`.trim(),
          net: String(el.source_net_id ?? ""),
        });
        break;
      }

      case "pcb_trace": {
        const route = (el.route as Array<Record<string, unknown>> | undefined) ?? [];
        // a trace changes layer crossing a via: it is split into segments
        let current: TraceSeg | undefined;
        for (const p of route) {
          const x = num(p.x);
          const y = num(p.y);
          if (x === null || y === null) continue;
          if (p.route_type === "via") {
            current = undefined;
            continue;
          }
          const layer = asLayer(p.layer);
          const width = num(p.width) ?? 0.15;
          if (!current || current.layer !== layer || current.width !== width) {
            const previous: { x: number; y: number } | undefined = current?.points.at(-1);
            current = {
              layer,
              width,
              points: previous ? [previous] : [],
              netKey: String(el.subcircuit_connectivity_map_key ?? ""),
              traceId: String(el.pcb_trace_id ?? ""),
              connectionName: el.connection_name ? String(el.connection_name) : null,
              sourceTraceId: el.source_trace_id ? String(el.source_trace_id) : null,
            };
            scene.traces.push(current);
          }
          current.points.push({ x, y });
        }
        break;
      }

      case "pcb_smtpad": {
        /*
         * A polygonal pad does not declare its center: it is derived from the
         * vertices. Without it, the pad exists on the drawing but is invisible
         * to everything that reasons by coordinates - including the connections
         * shown when a component is moved.
         */
        const punti = (el.points as Array<{ x?: unknown; y?: unknown }> | undefined) ?? [];
        const xs = punti.map((p) => num(p.x)).filter((v): v is number => v !== null);
        const ys = punti.map((p) => num(p.y)).filter((v): v is number => v !== null);
        const x = num(el.x) ?? (xs.length ? (Math.min(...xs) + Math.max(...xs)) / 2 : null);
        const y = num(el.y) ?? (ys.length ? (Math.min(...ys) + Math.max(...ys)) / 2 : null);
        if (x === null || y === null) break;
        const radius = num(el.radius) ?? 0;
        const port = String(el.pcb_port_id ?? "");
        scene.pads.push({
          id: String(el.pcb_smtpad_id ?? `pad${scene.pads.length}`),
          x,
          y,
          w: num(el.width) ?? (xs.length ? Math.max(...xs) - Math.min(...xs) : radius * 2),
          h: num(el.height) ?? (ys.length ? Math.max(...ys) - Math.min(...ys) : radius * 2),
          radius: num(el.rect_border_radius) ?? 0,
          layer: asLayer(el.layer),
          circle: String(el.shape ?? "") === "circle",
          rot: num(el.ccw_rotation) ?? 0,
          maskMargin: num(el.soldermask_margin) ?? 0,
          componentId: String(el.pcb_component_id ?? ""),
          pin: pinOfPort.get(port) ?? "",
          net: netOfPort.get(port) ?? "",
          netName: netNameOfPort.get(port) ?? "",
        });
        break;
      }

      case "pcb_via": {
        const x = num(el.x);
        const y = num(el.y);
        if (x === null || y === null) break;
        const hole = num(el.hole_diameter) ?? 0.3;
        scene.vias.push({
          id: String(el.pcb_via_id ?? `via${scene.vias.length}`),
          x,
          y,
          hole,
          outer: num(el.outer_diameter) ?? hole * 2,
        });
        break;
      }

      case "pcb_plated_hole":
      case "pcb_hole": {
        const x = num(el.x);
        const y = num(el.y);
        if (x === null || y === null) break;
        const hole = num(el.hole_diameter) ?? num(el.hole_width) ?? 0.8;
        const plated = el.type === "pcb_plated_hole";
        scene.holes.push({
          id: String(el.pcb_plated_hole_id ?? el.pcb_hole_id ?? `hole${scene.holes.length}`),
          x,
          y,
          hole,
          // a non-plated hole has no ring: whatever outer_diameter it carries is not copper
          outer: plated ? (num(el.outer_diameter) ?? hole * 1.6) : hole,
          padW: plated ? (num(el.rect_pad_width) ?? 0) : 0,
          padH: plated ? (num(el.rect_pad_height) ?? 0) : 0,
          rect: plated && String(el.shape ?? "").includes("rect"),
          componentId: String(el.pcb_component_id ?? ""),
          plated,
        });
        // a through-hole PIN: it joins the pins, see Pad.foro
        const port = String(el.pcb_port_id ?? "");
        if (plated && port) {
          const rect = String(el.shape ?? "").includes("rect") || String(el.shape ?? "").includes("pill");
          const w = num(el.rect_pad_width) ?? num(el.outer_width) ?? num(el.outer_diameter) ?? hole * 1.6;
          const h = num(el.rect_pad_height) ?? num(el.outer_height) ?? num(el.outer_diameter) ?? hole * 1.6;
          scene.pads.push({
            id: String(el.pcb_plated_hole_id ?? `foro${scene.pads.length}`),
            x,
            y,
            w,
            h,
            radius: 0,
            layer: "top",
            circle: !rect,
            rot: num(el.ccw_rotation) ?? 0,
            maskMargin: 0,
            componentId: String(el.pcb_component_id ?? ""),
            pin: pinOfPort.get(port) ?? "",
            net: netOfPort.get(port) ?? "",
            netName: netNameOfPort.get(port) ?? "",
            foro: true,
          });
        }
        break;
      }

      case "pcb_solder_paste": {
        const x = num(el.x);
        const y = num(el.y);
        if (x === null || y === null) break;
        const radius = num(el.radius) ?? 0;
        scene.paste.push({
          id: String(el.pcb_solder_paste_id ?? `paste${scene.paste.length}`),
          x,
          y,
          w: num(el.width) ?? radius * 2,
          h: num(el.height) ?? radius * 2,
          rot: num(el.ccw_rotation) ?? 0,
          layer: asLayer(el.layer),
          circle: String(el.shape ?? "").includes("circle"),
          componentId: String(el.pcb_component_id ?? ""),
        });
        break;
      }

      case "pcb_silkscreen_path": {
        const route = (el.route as Array<{ x?: number; y?: number }> | undefined) ?? [];
        const points = route
          .map((p) => ({ x: num(p.x), y: num(p.y) }))
          .filter((p): p is { x: number; y: number } => p.x !== null && p.y !== null);
        if (points.length < 2) break;
        scene.silkPaths.push({
          id: String(el.pcb_silkscreen_path_id ?? `silk${scene.silkPaths.length}`),
          layer: asLayer(el.layer),
          width: num(el.stroke_width) ?? 0.1,
          points,
          componentId: String(el.pcb_component_id ?? ""),
        });
        break;
      }

      case "pcb_silkscreen_text": {
        const anchor = (el.anchor_position as { x?: number; y?: number } | undefined) ?? {};
        const x = num(anchor.x);
        const y = num(anchor.y);
        if (x === null || y === null) break;
        scene.silkTexts.push({
          id: String(el.pcb_silkscreen_text_id ?? `silktext${scene.silkTexts.length}`),
          x,
          y,
          size: num(el.font_size) ?? 0.5,
          text: String(el.text ?? ""),
          layer: asLayer(el.layer),
          rotation: num(el.ccw_rotation) ?? 0,
          componentId: String(el.pcb_component_id ?? ""),
        });
        break;
      }

      case "pcb_courtyard_rect":
      case "pcb_courtyard_circle":
      case "pcb_courtyard_pill":
      case "pcb_courtyard_outline":
      case "pcb_courtyard_polygon": {
        const shape = courtyardShape(el);
        if (!shape) break;
        scene.courtyards.push({
          id: String(el[`${String(el.type)}_id`] ?? `cy${scene.courtyards.length}`),
          shape,
          componentId: String(el.pcb_component_id ?? ""),
        });
        break;
      }

      case "pcb_component": {
        // the name lives on the source component, not on the pcb one

        const c = (el.center as { x?: number; y?: number } | undefined) ?? {};
        const x = num(c.x);
        const y = num(c.y);
        if (x === null || y === null) break;
        const id = String(el.pcb_component_id ?? `comp${scene.components.length}`);
        const ingombro = ingombri.get(id);
        scene.components.push({
          id,
          sourceId: String(el.source_component_id ?? ""),
          name: nomeComponente.get(String(el.source_component_id ?? "")) ?? "",
          x,
          y,
          ox: num(el.display_offset_x) ?? x,
          oy: num(el.display_offset_y) ?? y,
          w: ingombro ? ingombro.maxX - ingombro.minX : (num(el.width) ?? 1),
          h: ingombro ? ingombro.maxY - ingombro.minY : (num(el.height) ?? 1),
          dx: ingombro ? (ingombro.minX + ingombro.maxX) / 2 - x : 0,
          dy: ingombro ? (ingombro.minY + ingombro.maxY) / 2 - y : 0,
          rotation: num(el.rotation) ?? 0,
          layer: asLayer(el.layer),
        });
        break;
      }
    }
  }

  return scene;
}
