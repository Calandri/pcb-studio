/**
 * Dal Circuit JSON alle forme da disegnare. Sta separato dal componente React
 * perche' e' logica pura e verificabile: quali elementi esistono, su che strato
 * stanno, che geometria hanno. Il disegno vero e' in BoardCanvas.
 *
 * Coordinate in mm col centro scheda in (0,0) e y verso l'alto, come nel
 * Circuit JSON. L'inversione dell'asse per lo schermo la fa il canvas.
 */

export interface El {
  type: string;
  [key: string]: unknown;
}

export type LayerId = "top" | "inner1" | "inner2" | "bottom";

export const LAYER_ORDER: LayerId[] = ["bottom", "inner2", "inner1", "top"];

/** rame: il top e' il piu' caldo, gli interni si distinguono a colpo d'occhio */
export const LAYER_COLOR: Record<LayerId, string> = {
  top: "#E8A33C",
  inner1: "#3BE8B0",
  inner2: "#7FB4FF",
  bottom: "#B9853A",
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
  componentId: string;
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
}

export interface Paste {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  layer: LayerId;
  circle: boolean;
}

export interface SilkPath {
  id: string;
  layer: LayerId;
  width: number;
  points: Array<{ x: number; y: number }>;
}

export interface SilkText {
  id: string;
  x: number;
  y: number;
  size: number;
  text: string;
  layer: LayerId;
  rotation: number;
}

export interface Courtyard {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Pour {
  id: string;
  layer: LayerId;
  path: string;
}

export interface ComponentBox {
  id: string;
  sourceId: string;
  x: number;
  y: number;
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
        // i fori del piano (isole attorno a pad e via) sono anelli interni:
        // con fill-rule evenodd bucano il pieno senza doverli disegnare a parte
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
        // una pista cambia strato attraversando una via: si spezza in segmenti
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
            };
            scene.traces.push(current);
          }
          current.points.push({ x, y });
        }
        break;
      }

      case "pcb_smtpad": {
        const x = num(el.x);
        const y = num(el.y);
        if (x === null || y === null) break;
        const radius = num(el.radius) ?? 0;
        scene.pads.push({
          id: String(el.pcb_smtpad_id ?? `pad${scene.pads.length}`),
          x,
          y,
          w: num(el.width) ?? radius * 2,
          h: num(el.height) ?? radius * 2,
          radius: num(el.rect_border_radius) ?? 0,
          layer: asLayer(el.layer),
          circle: String(el.shape ?? "") === "circle",
          componentId: String(el.pcb_component_id ?? ""),
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
          layer: asLayer(el.layer),
          circle: String(el.shape ?? "").includes("circle"),
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
        });
        break;
      }

      case "pcb_component": {
        const c = (el.center as { x?: number; y?: number } | undefined) ?? {};
        const x = num(c.x);
        const y = num(c.y);
        if (x === null || y === null) break;
        scene.components.push({
          id: String(el.pcb_component_id ?? `comp${scene.components.length}`),
          sourceId: String(el.source_component_id ?? ""),
          x,
          y,
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
