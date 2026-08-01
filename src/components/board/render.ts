/**
 * From Circuit JSON to the shapes to draw. It is separate from the React
 * component because it is pure, verifiable logic: which elements exist, which
 * layer they are on, what geometry they have. The actual drawing is in BoardCanvas.
 *
 * Coordinates in mm with the board center at (0,0) and y upward, as in the
 * Circuit JSON. The canvas handles the axis flip for the screen.
 */

export interface El {
  type: string;
  [key: string]: unknown;
}

export type LayerId = "top" | "inner1" | "inner2" | "bottom";

export const LAYER_ORDER: LayerId[] = ["bottom", "inner2", "inner1", "top"];

/** copper: top is the warmest, the inner ones are told apart at a glance */
export const LAYER_COLOR: Record<LayerId, string> = {
  top: "#E8A33C",
  inner1: "#3BE8B0",
  inner2: "#7FB4FF",
  bottom: "#B9853A",
};

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
  bottom: "#DCB176",
};

export interface Board {
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  layers: number;
  thickness: number;
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
  outer: number;
  padW: number;
  padH: number;
  rect: boolean;
  componentId: string;
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

export interface Courtyard {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** turned like the part it belongs to, when the part is turned */
  rot: number;
  componentId: string;
}

export interface Pour {
  id: string;
  layer: LayerId;
  path: string;
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
  w: number;
  h: number;
  rotation: number;
  layer: LayerId;
}

export interface Marker {
  id: string;
  x: number;
  y: number;
  message: string;
  severity: "err" | "warn";
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
  components: ComponentBox[];
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

const asLayer = (v: unknown, fallback: LayerId = "top"): LayerId => {
  const s = String(v ?? "");
  return s === "top" || s === "bottom" || s === "inner1" || s === "inner2" ? s : fallback;
};

export function buildScene(circuitJson: unknown[] | null): BoardScene | null {
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

  /*
   * Who every pad is: the name of its pin and the connection it belongs to.
   *
   * Needed to say, looking at a component, WHO it is connected to and from
   * which pin - the information that someone moving a part needs more than
   * any other, and that the drawing alone does not carry: on copper a pad is
   * a rectangle like any other.
   */
  const pinOfPort = new Map<string, string>();
  const netOfPort = new Map<string, string>();
  const portNameBySourceId = new Map<string, string>();
  for (const raw of elements) {
    const el = raw as Record<string, unknown>;
    if (el.type === "source_port" && el.source_port_id) {
      portNameBySourceId.set(String(el.source_port_id), String(el.name ?? ""));
    }
  }
  /*
   * Which connection every pad belongs to.
   *
   * It is NOT read from the pad: pcb_ports carry no connectivity key
   * (verified: 212 ports, zero keys), so using it meant giving every pad
   * a net of its own and never drawing anything. Connectivity lives in the
   * SCHEMATIC traces: a trace joins two pins, or hangs them on a named net.
   * Here the pins a trace puts together are joined, and propagation runs
   * until the groups stop growing - so ten parts all hanging on P3V3 turn
   * out connected even if no trace joins them pairwise.
   */
  const padre = new Map<string, string>();
  const radice = (a: string): string => {
    let r = a;
    while (padre.get(r) && padre.get(r) !== r) r = padre.get(r)!;
    padre.set(a, r);
    return r;
  };
  const unisci = (a: string, b: string) => {
    if (!a || !b) return;
    if (!padre.has(a)) padre.set(a, a);
    if (!padre.has(b)) padre.set(b, b);
    const ra = radice(a);
    const rb = radice(b);
    if (ra !== rb) padre.set(ra, rb);
  };
  const nomeComponente = new Map<string, string>();
  for (const el of elements) {
    if (el.type === "source_component" && el.source_component_id) {
      nomeComponente.set(String(el.source_component_id), String(el.name ?? ""));
    }
  }
  const nomeDiRete = new Map<string, string>();
  for (const raw of elements) {
    const el = raw as Record<string, unknown>;
    if (el.type === "source_net" && el.source_net_id) {
      nomeDiRete.set(String(el.source_net_id), String(el.name ?? ""));
    }
  }
  for (const raw of elements) {
    const el = raw as Record<string, unknown>;
    if (el.type !== "source_trace") continue;
    const porte = ((el.connected_source_port_ids as string[] | undefined) ?? []).map(String);
    for (let i = 1; i < porte.length; i++) unisci(porte[0], porte[i]);
    for (const netId of (el.connected_source_net_ids as string[] | undefined) ?? []) {
      const etichetta = `net:${nomeDiRete.get(String(netId)) ?? netId}`;
      for (const porta of porte) unisci(porta, etichetta);
    }
  }

  /*
   * The net name of every group, when it has one. A pad on GND or on
   * a power rail must not be connected to some neighbor: it must be DECLARED,
   * and the name is the only thing worth knowing about it.
   */
  const nomeDelGruppo = new Map<string, string>();
  for (const chiave of [...padre.keys()]) {
    if (!chiave.startsWith("net:")) continue;
    nomeDelGruppo.set(radice(chiave), chiave.slice(4));
  }

  const netNameOfPort = new Map<string, string>();
  for (const raw of elements) {
    const el = raw as Record<string, unknown>;
    if (el.type !== "pcb_port" || !el.pcb_port_id) continue;
    const id = String(el.pcb_port_id);
    const sorgente = String(el.source_port_id ?? "");
    const gruppo = padre.has(sorgente) ? radice(sorgente) : sorgente;
    pinOfPort.set(id, portNameBySourceId.get(sorgente) ?? "");
    netOfPort.set(id, gruppo);
    netNameOfPort.set(id, nomeDelGruppo.get(gruppo) ?? "");
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
    components: [],
  };

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
        scene.holes.push({
          id: String(el.pcb_plated_hole_id ?? el.pcb_hole_id ?? `hole${scene.holes.length}`),
          x,
          y,
          hole,
          outer: num(el.outer_diameter) ?? hole * 1.6,
          padW: num(el.rect_pad_width) ?? 0,
          padH: num(el.rect_pad_height) ?? 0,
          rect: String(el.shape ?? "").includes("rect"),
          componentId: String(el.pcb_component_id ?? ""),
        });
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

      case "pcb_courtyard_rect": {
        const c = (el.center as { x?: number; y?: number } | undefined) ?? {};
        const x = num(c.x) ?? num(el.x);
        const y = num(c.y) ?? num(el.y);
        if (x === null || y === null) break;
        scene.courtyards.push({
          id: String(el.pcb_courtyard_rect_id ?? `cy${scene.courtyards.length}`),
          x,
          y,
          w: num(el.width) ?? 0,
          h: num(el.height) ?? 0,
          rot: num(el.ccw_rotation) ?? 0,
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
        scene.components.push({
          id: String(el.pcb_component_id ?? `comp${scene.components.length}`),
          sourceId: String(el.source_component_id ?? ""),
          name: nomeComponente.get(String(el.source_component_id ?? "")) ?? "",
          x,
          y,
          ox: num(el.display_offset_x) ?? x,
          oy: num(el.display_offset_y) ?? y,
          w: num(el.width) ?? 1,
          h: num(el.height) ?? 1,
          rotation: num(el.rotation) ?? 0,
          layer: asLayer(el.layer),
        });
        break;
      }
    }
  }

  return scene;
}
