"use client";

import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ViewFlags } from "../ViewPresets";
import { isTypingTarget } from "../keyboard";
import { useVistaCondivisa } from "./vista-condivisa";
import {
  CollegamentiApertiSulVisore,
  LegendaAperti,
  RameDelleReti,
  apertiInVista,
  useInquadraAperto,
  type ApertoScelto,
} from "./CollegamentiAperti";
import { opacitaStrato, stratoScelto } from "./strati-visibili";
import { BersagliDelRame } from "./BersagliDelRame";
import { AvvisoDelGesto, RameInMovimento } from "./RameInMovimento";
import { NESSUN_RAME, useGestoDelRame, type RameInAttesa, type RameNascosto } from "./gesto-del-rame";
import { GRID_DEFAULT, GRID_OPTIONS, ascoltaGriglia, grigliaSalvata, salvaGriglia } from "./griglia";
import {
  DESIGNATOR_FONT,
  LABEL_FONT,
  LABEL_METRICS,
  PIN_FONT,
  latoDi,
  layoutDesignators,
  layoutNetLabels,
  leaderEnd,
  type LatoEtichetta,
  type PlacedNetLabel,
} from "./net-labels";

import type { DesignRules } from "@/lib/design-rules";
import { rameDellaScheda } from "@/lib/open-connections";
import { ETICHETTA_FONTE, type DescrizionePezzo } from "@/lib/part-description";
import { forma, percorsoDellaForma, scontri, type Forma } from "@/lib/ingombro";
import {
  HOLE_COPPER,
  LAYER_COLOR,
  PAD_COLOR,
  layerDrawOrder,
  boardOutlinePath,
  buildScene,
  colatePerRete,
  holeCopper,
  type BoardScene,
  type LayerId,
  type Marker,
} from "./render";

/**
 * Board viewer, written here instead of using the one from
 * @tscircuit/pcb-viewer. The reason is not aesthetic: that viewer draws on
 * canvas and exposes neither the camera matrix nor mouse events,
 * so it was impossible to show the component card on hover,
 * display the solder paste, or place a marker where needed.
 *
 * Here the mm -> pixel transform is ours, the drawing is SVG (so every
 * element is a node with its own events) and the layers light up one by one.
 */
/** rectangle on the board, in millimeters, board center = (0,0) */
export interface BoardZone {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * What the drag collects: nothing (it pans the view), the components
 * that end up inside the box, or the box itself as a copper area.
 */
export type SelectMode = "off" | "components" | "zone";

/** where a component really is while it is being moved (not yet recompiled) */
export interface MoveOverride {
  x: number;
  y: number;
  rotation?: number;
  /** the face it has been turned to ("Gira lato"), not yet recompiled */
  layer?: "top" | "bottom";
}

/**
 * The mirror tscircuit applies to a part on the other face, as an SVG matrix:
 * a reflection across the part's own Y axis (the line through its origin at
 * its rotation + 90 degrees): an 0402 at 0 degrees swaps its pads left-right,
 * at 90 degrees top-bottom. Measured on the compiler, the same as compiling it
 * with the other `layer`.
 */
export function mirrorMatrix(ox: number, oy: number, rotationDeg: number) {
  const t = (2 * (rotationDeg + 90) * Math.PI) / 180;
  const c2 = Math.abs(Math.cos(t)) < 1e-12 ? 0 : Math.cos(t);
  const s2 = Math.abs(Math.sin(t)) < 1e-12 ? 0 : Math.sin(t);
  return {
    a: c2,
    b: s2,
    c: s2,
    d: -c2,
    e: ox - (c2 * ox + s2 * oy),
    f: oy - (s2 * ox - c2 * oy),
  };
}
const applyMatrix = (m: ReturnType<typeof mirrorMatrix>, x: number, y: number) => ({
  x: m.a * x + m.c * y + m.e,
  y: m.b * x + m.d * y + m.f,
});

export { chiaveInquadratura, vistaDopoRidimensionamento } from "./vista-condivisa";
export const snapToGrid = (v: number, grid: number) => Math.round(Math.round(v / grid) * grid * 1000) / 1000;

/*
 * Zoom limits in pixels per millimeter, the same for the framing and for the
 * wheel. The framing allowed 0.1 and the wheel stopped at 1: on a board too big
 * to fit at 1 px/mm the first wheel tick JUMPED in instead of zooming out, and
 * there was no way back to the whole board except the framing button.
 */
/**
 * HOW FAR A KEY TURNS THE PARTS in Sposta, in degrees counterclockwise, or null
 * when it is not a turn: R 90, Shift+R 90 the other way (Shift+r arrives as
 * "R"), Alt+R 45 and Alt+Shift+R 45 the other way ("se voglio ruotare di 45
 * gradi e non 90 si puo'?", Niccolo', 2026-11-12). On a Mac Option+R arrives as
 * another character ("®"): with Alt the key is the physical one, KeyR. cmd+R
 * stays a quarter turn, and stopped, so the browser does not reload underneath.
 */
export function rotazioneDaTasto(e: Pick<KeyboardEvent, "key" | "code" | "shiftKey" | "altKey">): number | null {
  const r = e.key === "r" || e.key === "R" || (e.altKey && e.code === "KeyR");
  if (!r) return null;
  const verso = e.shiftKey || e.key === "R" ? -1 : 1;
  return (e.altKey ? 45 : 90) * verso;
}

/** the footprints: their line, the line of two that hit each other, a connector's mating space */
const COLORE_INGOMBRO = "#B48CFF";
const COLORE_SCONTRO = "#FF4D5E";
const COLORE_INNESTO = "#4FC3F7";

const ZOOM_MIN = 0.1;
const ZOOM_MAX = 400;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const snap = (v: number, on: boolean, grid: number) => (on ? snapToGrid(v, grid) : r3(v));

export function BoardCanvas({
  circuitJson,
  flags,
  layer,
  xray = 0,
  markers = [],
  hoveredComponentId,
  onHoverComponent,
  onPickComponent,
  selectMode = "off",
  selectedIds,
  onSelectionChange,
  zone = null,
  onZoneChange,
  mode = "view",
  pickedId = null,
  moveOverrides = {},
  onMoveComponent,
  pinnedNames,
  onRelease,
  bothSides = false,
  partInfo,
  vistaKey,
  eccedenzaIngombroMm,
  anteprimaVie = null,
  apertiAccesi = false,
  apertoScelto = null,
  regole,
  rameInAttesa = NESSUN_RAME,
  onGestoDelRame,
}: {
  circuitJson: unknown[] | null;
  flags: ViewFlags;
  /** layer in the foreground: the others stay visible but dimmed */
  layer: string;
  /** 0-100: how visible the layers that are not in the foreground are */
  xray?: number;
  markers?: Marker[];
  hoveredComponentId?: string | null;
  onHoverComponent?: (id: string | null) => void;
  onPickComponent?: (id: string | null) => void;
  selectMode?: SelectMode;
  selectedIds?: string[];
  onSelectionChange?: (ids: string[]) => void;
  zone?: BoardZone | null;
  onZoneChange?: (zone: BoardZone | null) => void;
  /** "move": components can be dragged, moved from the keyboard, rotated */
  mode?: "view" | "move";
  /** selected component: it is the one that answers to arrows and rotation */
  pickedId?: string | null;
  /** pending moves, indexed by pcb_component_id */
  moveOverrides?: Record<string, MoveOverride>;
  onMoveComponent?: (
    id: string,
    from: { x: number; y: number },
    to: { x: number; y: number },
    rotation?: number,
    /** the other face, when the part is turned over ("Gira lato") */
    layer?: "top" | "bottom",
    /** the same id on every event of one gesture on many parts: undone together */
    gruppo?: string,
  ) => void;
  /**
   * The parts held still by hand, by NAME. In move mode they get a mark on the
   * board: knowing which ones an automatic action will not touch is the
   * difference between "it did nothing" and "it did what I asked".
   */
  pinnedNames?: string[];
  /** lets go of a single part: it is the × on its mark */
  onRelease?: (name: string) => void;
  /**
   * In move mode, the parts of BOTH faces can be seen and grabbed. Off by
   * default: only when the person asks for "Top + Bottom".
   */
  bothSides?: boolean;
  /**
   * What each part is, by pcb_component_id (part-description.ts): the card
   * next to the part in "Sposta" shows it.
   */
  partInfo?: Record<string, DescrizionePezzo & { name: string }>;
  /** whose view this is (the project): shared by every canvas of the board */
  vistaKey?: string;
  /** the project's componentCourtyardExcessMm, for the footprints PCB Studio computes (see ingombro.ts) */
  eccedenzaIngombroMm?: number;
  /**
   * The vias "Cuci la massa" proposes, before anything is written: dots at
   * their size. Vias go through the board, so they are on every layer
   * (strati-visibili.ts) and drawn whatever layer is chosen.
   */
  anteprimaVie?: { punti: Array<{ x: number; y: number; colore: string }>; diametroMm: number } | null;
  /**
   * The open connections (CollegamentiAperti.tsx) are drawn in every view: the
   * person asked for them from the panel. The views that show them by
   * themselves (is_showing_rats_nest) do not need it.
   */
  apertiAccesi?: boolean;
  /** the open connection clicked in the panel: the canvas goes there and lights it */
  apertoScelto?: ApertoScelto | null;
  /**
   * The project's rules. With them and `onGestoDelRame`, in move mode the
   * copper can be dragged too: a via with its traces, a straight stretch of a
   * trace (gesto-del-rame.ts). The solver stops the copper at these distances.
   */
  regole?: DesignRules;
  /** the copper gestures let go and not on the saved board yet: drawn where they were left */
  rameInAttesa?: readonly RameInAttesa[];
  /** a copper gesture was let go and moved something: what to save, and what to keep on screen */
  onGestoDelRame?: (gesto: RameInAttesa) => void;
}) {
  const scene = useMemo(() => buildScene(circuitJson, { eccedenzaIngombroMm }), [circuitJson, eccedenzaIngombroMm]);
  /** the board's real outline as an SVG path; null when it is a plain rectangle */
  const boardPath = useMemo(() => (scene ? boardOutlinePath(scene.board) : null), [scene]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [dragging, setDragging] = useState(false);
  const dragFrom = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  /** a component drag in progress (position already snapped to the grid) */
  /**
   * A drag in progress: the part in hand (id, snapped position) and every part
   * that travels with it (the multi-selection), all by the same displacement.
   */
  const [compDrag, setCompDrag] = useState<{ id: string; x: number; y: number; dx: number; dy: number; ids: string[] } | null>(null);
  /** the pin under the mouse: its net alone is shown (see links) */
  const [padSotto, setPadSotto] = useState<string | null>(null);
  const pezzoDi = useMemo(() => new Map((scene?.components ?? []).map((c) => [c.id, c])), [scene]);
  /** snap pitch, chosen from the standard pitches */
  // the pitch chosen last on this project in this browser (the default on the server and before mount)
  const gridMm = useSyncExternalStore(
    ascoltaGriglia,
    () => grigliaSalvata(vistaKey, window.localStorage),
    () => GRID_DEFAULT,
  );
  const setGridMm = useCallback((mm: number) => salvaGriglia(vistaKey, mm, window.localStorage), [vistaKey]);
  const compDragFrom = useRef<{
    id: string;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    /** where every part of the group was when the drag started */
    gruppo: Array<{ id: string; x: number; y: number; rotation: number }>;
  } | null>(null);
  /** copper in hand: next to the parts' drag, with its own targets and its own state (gesto-del-rame.ts) */
  const rame = useGestoDelRame({
    attivo: mode === "move" && selectMode === "off" && regole !== undefined && onGestoDelRame !== undefined,
    circuitJson,
    regole,
    inAttesa: rameInAttesa,
    onGesto: onGestoDelRame,
  });
  /** the part under the start of a Shift box: a Shift click on it adds or removes it */
  const marqueeSu = useRef<string | null>(null);
  /** box being drawn, in screen coordinates relative to the container */
  const [marquee, setMarquee] = useState<{
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  } | null>(null);
  const marqueeAdd = useRef(false);
  const selected = useMemo(() => new Set(selectedIds ?? []), [selectedIds]);
  /** the names held still by hand: they get the mark in move mode */
  const fermi = useMemo(() => new Set(pinnedNames ?? []), [pinnedNames]);

  /*
   * In move mode only the parts of the face being looked at exist.
   *
   * With Top chosen, the parts on the bottom still had their hover box and
   * their drag handle on top of the top ones: translucent rectangles under
   * C10 and C8 on sbb-dl-retro, and a drag that could pick up a part on the
   * other face ("e' un casino", Niccolo', 2026-11-09). The face follows the
   * chosen layer like the silkscreen does (bottom -> bottom, anything else ->
   * top); both faces only when asked for. "Guarda" is untouched.
   */
  const faccia: LayerId = layer === "bottom" ? "bottom" : "top";
  /*
   * The parts turned to the other face and not applied yet: they are drawn
   * mirrored on that face, and for what can be seen and grabbed they are
   * already there.
   */
  const girati = useMemo(() => {
    const out = new Set<string>();
    if (!scene) return out;
    for (const c of scene.components) {
      const l = moveOverrides[c.id]?.layer;
      if (l && l !== (c.layer === "bottom" ? "bottom" : "top")) out.add(c.id);
    }
    return out;
  }, [scene, moveOverrides]);
  const altraFaccia = (l: LayerId): LayerId => (l === "top" ? "bottom" : l === "bottom" ? "top" : l);
  /** the face a part is on now, pending flip included */
  const latoDiPezzo = useCallback(
    (c: { id: string; layer: LayerId }): LayerId => (girati.has(c.id) ? altraFaccia(c.layer) : c.layer),
    [girati],
  );
  /** the face of something that belongs to a part (pad, silkscreen) */
  const latoDiParte = (componentId: string, l: LayerId): LayerId =>
    girati.has(componentId) ? altraFaccia(l) : l;
  const nascosti = useMemo(() => {
    const out = new Set<string>();
    if (!scene) return out;
    if (mode === "move") {
      if (bothSides) return out;
      for (const c of scene.components) if (latoDiPezzo(c) !== faccia) out.add(c.id);
      return out;
    }
    /*
     * Guarda used to be left alone ("Guarda is untouched", 2026-11-09), and with
     * Top chosen the parts of the bottom kept their hover box, their courtyard
     * and their solder paste over the top face: "seleziono il TOP ma vedo TUTTO"
     * (Niccolo', 2026-11-11). A part whose face is not drawn is not there. With
     * the x-ray up its face comes back dimmed, and so does the part.
     */
    const scelto = stratoScelto(layer);
    for (const c of scene.components) if (opacitaStrato(latoDiPezzo(c), scelto, xray) === 0) out.add(c.id);
    return out;
  }, [scene, mode, bothSides, faccia, latoDiPezzo, layer, xray]);

  // what is no longer visible leaves the selection, the hover and the pick
  useEffect(() => {
    // in Guarda nothing can be dragged: the part picked on the schematic stays picked, it is only not drawn
    if (mode !== "move" || nascosti.size === 0) return;
    if (pickedId && nascosti.has(pickedId)) onPickComponent?.(null);
    if (hoveredComponentId && nascosti.has(hoveredComponentId)) onHoverComponent?.(null);
    if (selectedIds?.some((id) => nascosti.has(id))) {
      onSelectionChange?.(selectedIds.filter((id) => !nascosti.has(id)));
    }
  }, [mode, nascosti, pickedId, hoveredComponentId, selectedIds, onPickComponent, onHoverComponent, onSelectionChange]);


  // --- container measurement: the scale is computed in real pixels
  const [misurato, setMisurato] = useState(false);
  useEffect(() => {
    const node = wrapRef.current;
    if (!node) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) {
        setSize({ w: width, h: height });
        setMisurato(true);
      }
    });
    ro.observe(node);
    return () => ro.disconnect();
  }, []);

  const fit = useCallback(() => {
    if (!scene) return;
    const margin = 28;
    const k = Math.min(
      (size.w - margin * 2) / scene.board.width,
      (size.h - margin * 2) / scene.board.height,
    );
    setView({ x: size.w / 2, y: size.h / 2, k: Math.min(ZOOM_MAX, Math.max(k, ZOOM_MIN)) });
  }, [scene, size]);

  /*
   * THE ZOOM CHANGES ONLY WHEN THE PERSON ASKS (wheel, pinch, dragging the
   * view, FIT): not on hover (the bar under the board grew a line and the
   * board was re-framed, 2026-11-09), not on a resize, not when switching
   * Guarda/Sposta/Instrada or tab. See vista-condivisa.ts.
   */
  useVistaCondivisa({ chiave: vistaKey, board: scene?.board ?? null, misurato, size, view, setView, fit });
  useInquadraAperto(circuitJson, apertoScelto, size, setView);

  const zoomAt = useCallback((px: number, py: number, factor: number) => {
    setView((v) => {
      const k = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v.k * factor));
      // the point under the cursor stays still
      return {
        k,
        x: px - ((px - v.x) * k) / v.k,
        y: py - ((py - v.y) * k) / v.k,
      };
    });
  }, []);

  /*
   * Wheel and pinch live INSIDE the canvas. React's listener is passive,
   * so preventDefault does not take and the browser was zooming the page too
   * (on Mac the trackpad pinch is a wheel with ctrlKey). Attached by hand
   * as in canvas-view.ts: the pinch has small deltas and must be amplified.
   */
  useEffect(() => {
    const node = wrapRef.current;
    if (!node) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = node.getBoundingClientRect();
      const divisor = e.ctrlKey ? 120 : 400;
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.exp(-e.deltaY / divisor));
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  /*
   * From screen pixels to board millimeters. The SVG group applies
   * translate(view.x, view.y) and then scale(k, -k): the y is FLIPPED, because
   * on technical drawings it grows upward and on screen downward.
   * Inverting that scale is the whole conversion.
   */
  const toMm = useCallback(
    (px: number, py: number) => ({ x: (px - view.x) / view.k, y: (view.y - py) / view.k }),
    [view],
  );

  /** the drawn box, in millimeters and with the sides in the right order */
  const marqueeMm = useCallback((): BoardZone | null => {
    if (!marquee) return null;
    const a = toMm(marquee.x0, marquee.y0);
    const b = toMm(marquee.x1, marquee.y1);
    const r3 = (v: number) => Math.round(v * 1000) / 1000;
    return {
      minX: r3(Math.min(a.x, b.x)),
      minY: r3(Math.min(a.y, b.y)),
      maxX: r3(Math.max(a.x, b.x)),
      maxY: r3(Math.max(a.y, b.y)),
    };
  }, [marquee, toMm]);

  /**
   * Where a component really is: compiled position, covered by the
   * pending move, covered in turn by the drag in progress.
   */
  const effOf = useCallback(
    (c: { id: string; x: number; y: number; rotation: number }) => {
      const o = moveOverrides[c.id];
      const base = o ? { x: o.x, y: o.y, rotation: o.rotation ?? c.rotation } : c;
      // the group in hand: every part by the same displacement as the one held
      if (compDrag?.ids.includes(c.id)) {
        return { x: base.x + compDrag.dx, y: base.y + compDrag.dy, rotation: base.rotation };
      }
      return base;
    },
    [compDrag, moveOverrides],
  );

  /*
   * SVG transform for the elements of a moved component (pads, holes,
   * silkscreen, courtyard): rotate around the original center and then
   * translate. Returns undefined when the component is still, so still
   * elements pay nothing. Traces do NOT move: they stay where they were until
   * apply, and that is right - they are the ones that must be redone.
   */
  /**
   * Two transforms, joined without inventing a word.
   *
   * `${undefined}` inside a template literal becomes the STRING "undefined", and
   * an SVG transform attribute that starts with it is invalid: the browser throws
   * away the WHOLE list, rotation included. That is how every pad on a diagonal
   * board came out straight while the data said 45 degrees, and why it looked
   * right only while you were dragging the component, which is the one moment
   * compTx returns a real string.
   */
  const componi = (...pezzi: Array<string | undefined | null | false>): string | undefined =>
    pezzi.filter(Boolean).join(" ") || undefined;

  const compTx = useCallback(
    (componentId: string): string | undefined => {
      if (!componentId || !scene) return undefined;
      const c = scene.components.find((x) => x.id === componentId);
      if (!c) return undefined;
      const eff = effOf(c);
      const dx = eff.x - c.x;
      const dy = eff.y - c.y;
      const dRot = (((eff.rotation - c.rotation) % 360) + 360) % 360;
      const girato = girati.has(c.id);
      if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9 && dRot === 0 && !girato) return undefined;
      // turned over: mirrored first, on the part's own axis, then moved
      const m = girato ? mirrorMatrix(c.ox, c.oy, c.rotation) : null;
      // it turns around the ORIGIN, like the compiler does: see ComponentBox.ox
      return componi(
        `translate(${dx} ${dy}) rotate(${dRot} ${c.ox} ${c.oy})`,
        m && `matrix(${m.a} ${m.b} ${m.c} ${m.d} ${m.e} ${m.f})`,
      );
    },
    [scene, effOf, girati],
  );

  /*
   * The wires of the component being looked at or moved.
   *
   * Moving a part without knowing what it is connected to is like moving
   * furniture with your eyes closed: you find out later, when the copper has
   * to take the long way around. Here every pin of the focused component draws
   * a line toward the nearest pad it shares the connection with, and every pin
   * has its own color - so at a glance you read not only WHO with, but FROM WHERE.
   *
   * It takes the nearest pad of the same net, not all of them: on ground and
   * power that would be hundreds of lines and nothing would be readable.
   */
  const { links, retiFocus } = useMemo(() => {
    const vuoto = { links: [] as never[], retiFocus: [] as Array<{ net: string; colore: string; da: { x: number; y: number }; membri: Array<{ x: number; y: number }> }> };
    const padFocus = padSotto && scene ? scene.pads.find((p) => p.id === padSotto && p.net) ?? null : null;
    const focus = padFocus?.componentId ?? hoveredComponentId ?? (selectedIds?.length === 1 ? selectedIds[0] : null);
    if (!scene || !focus || nascosti.has(focus)) return vuoto;

    /*
     * Where a pad REALLY is now, not where it was when the board was
     * compiled. If its component has been moved or rotated - dragged
     * now, or moved earlier and not yet recompiled - the pad moved with it,
     * and a line pointing at the old position points at nothing.
     *
     * The drawn pads follow the component because they live inside a group that
     * carries the transform; a line between TWO different components cannot
     * live in either group, so here the transform must be applied by hand.
     */
    /** how much the component is being turned right now, in degrees */
    const giroDi = (componentId: string): number => {
      const c = scene.components.find((x) => x.id === componentId);
      if (!c) return 0;
      return ((((effOf(c).rotation - c.rotation) % 360) + 360) % 360);
    };
    const posOf = (pad: { x: number; y: number; componentId: string }) => {
      const c = scene.components.find((x) => x.id === pad.componentId);
      if (!c) return { x: pad.x, y: pad.y };
      const eff = effOf(c);
      const giro = ((((eff.rotation - c.rotation) % 360) + 360) % 360) * (Math.PI / 180);
      // turned over: the pad is mirrored on the part's axis first, like compTx
      const q = girati.has(c.id) ? applyMatrix(mirrorMatrix(c.ox, c.oy, c.rotation), pad.x, pad.y) : pad;
      // same pivot as compTx: the origin, not the centre
      const rx = q.x - c.ox;
      const ry = q.y - c.oy;
      const cos = Math.cos(giro);
      const sin = Math.sin(giro);
      return {
        x: c.ox + rx * cos - ry * sin + (eff.x - c.x),
        y: c.oy + rx * sin + ry * cos + (eff.y - c.y),
      };
    };

    // a pad under the mouse: only its net. Otherwise every net of the part
    const mine = padFocus ? [padFocus] : scene.pads.filter((p) => p.componentId === focus && p.net);
    if (mine.length === 0) return vuoto;
    const out: Array<{
      tipo: "linea" | "pad";
      key: string;
      x1: number;
      y1: number;
      /** for a line: the other end. For a pad: its width and height */
      x2: number;
      y2: number;
      cerchio?: boolean;
      /** for a pad: how far it is turned, so the highlight is turned with it */
      rot?: number;
      /** the NET's name, written once per net; empty on every other end */
      testo: string;
      /** the pins of the focused part on that net, small, under the name: "Q3.G" */
      sotto: string;
      /** where the net goes ("9 piedini: U5.7, ..."): shown in the bar under the board */
      membri?: string;
      /** the side of the part the pad is on: the name is pushed that way */
      lato?: LatoEtichetta;
      /** how far the pad reaches from its centre, mm */
      raggio?: number;
      colore: string;
    }> = [];
    /** the focused part where it is NOW: the side of each pad is measured from it */
    const fuoco = scene.components.find((c) => c.id === focus);
    const centro = fuoco ? effOf(fuoco) : null;
    const versoDi = (pad: (typeof mine)[number], at: { x: number; y: number }) => ({
      lato: latoDi(at.x - (centro?.x ?? at.x), at.y - (centro?.y ?? at.y)),
      raggio: Math.max(pad.w, pad.h) / 2,
    });

    /*
     * What a connection is called on screen: the NET, the same name at every
     * end. It used to be the pin at the end of the line ("G", "D", "pin2") and
     * the net only on lit pads ("VBAT"), so one connection had three names
     * (sbb-dl-retro, 2026-11-09). The pin stays as small text, always with its
     * part ("Q3.G", "R35.2"), never on its own; a net with no name is called
     * by its ends ("R35.2 > Q3.G").
     */
    const nomeDelPezzo = new Map(scene.components.map((c) => [c.id, c.name]));
    const pinPieno = (p: { componentId: string; pin: string }): string => {
      const pezzo = nomeDelPezzo.get(p.componentId) ?? "";
      const pin = p.pin.replace(/^pin(\d+)$/i, "$1");
      return pezzo && pin ? `${pezzo}.${pin}` : pezzo || pin;
    };
    const elenco = (nomi: string[], max = 2) => {
      const unici = [...new Set(nomi.filter(Boolean))];
      return unici.length > max ? `${unici.slice(0, max).join(", ")} +${unici.length - max}` : unici.join(", ");
    };
    /** one label per net: the first end that reaches it writes it */
    const scritte = new Set<string>();
    /*
     * The second line says WHERE the net goes: how many pins, and which.
     * "VBAT_MDM" alone did not say what it was attached to, with the other
     * pins far away or off screen (sbb-dl-retro U1, 2026-11-09). The pins of
     * the part being looked at are counted, not listed: they are the ones lit.
     * Ground and big nets: the count and the first few, then "+N".
     */
    const membri = (pad: (typeof mine)[number], altri: typeof scene.pads) => {
      const tutti = altri.length + 1;
      const fuori = [...new Set(altri.filter((p) => p.componentId !== focus).map(pinPieno).filter(Boolean))];
      const grande = tutti > 20 || /^(A|D|P)?GND\w*$/i.test(pad.netName);
      const max = grande ? 3 : 5;
      const lista = fuori.length > max ? `${fuori.slice(0, max).join(", ")} +${fuori.length - max}` : fuori.join(", ");
      return lista ? `${tutti} piedini: ${lista}` : `${tutti} piedini`;
    };
    const etichetta = (pad: (typeof mine)[number], altri: typeof scene.pads) => {
      if (scritte.has(pad.net)) return { testo: "", sotto: "" };
      scritte.add(pad.net);
      const miei = elenco(mine.filter((p) => p.net === pad.net).map(pinPieno));
      // its own pins first ("J4.3", "U1.EN, U1.IN"), then where the net goes
      /*
       * Next to the pad only the net and the pins (small): where the net goes
       * is written in the bar under the board. A box with "125 piedini: ..."
       * beside the pad covered a strip of the board (Niccolo', 2026-11-09).
       */
      if (pad.netName) return { testo: pad.netName, sotto: miei, membri: membri(pad, altri) };
      return { testo: `${miei} > ${elenco(altri.map(pinPieno))}`, sotto: "", membri: altri.length > 2 ? membri(pad, altri) : "" };
    };
    /*
     * How a connection is shown depends on how many pads it touches.
     *
     * Up to two destinations the LINE is drawn: they are few, readable, and
     * say exactly where that pin goes. From three up the lines
     * would become an unreadable comb - and on ground, which touches
     * thirty-nine, a spiderweb - so the pads get COLORED: the starting one
     * and all the connected ones, with the same tint. You read at a glance
     * which pads are the same node, without a single line on screen.
     */
    /*
     * The color of the lit pads depends on the NET, not on the pin.
     *
     * Coloring by pin, a microphone with four grounds plus SELECT tied to
     * ground showed five different colors on the same node - and the viewer
     * reads "five different grounds", which is exactly the opposite of what
     * was meant. For lines the per-pin color makes sense (it tells WHERE each
     * one starts from); for pads it does not: there the message is
     * "these are the same node".
     */
    const tintaDiRete = (rete: string) => {
      let h = 0;
      for (let k = 0; k < rete.length; k++) h = (h * 31 + rete.charCodeAt(k)) % 360;
      return `hsl(${h} 85% 62%)`;
    };

    const perRete = new Map<string, typeof scene.pads>();
    for (const p of scene.pads) {
      if (!p.net) continue;
      perRete.set(p.net, [...(perRete.get(p.net) ?? []), p]);
    }

    /*
     * WHERE THE NET GOES: the shortest tree joining all its pins (ratsnest), in
     * the net's colour, and every other pin of the net lit. It used to draw a
     * line only for nets of two or three pins and to light the pads of the
     * bigger ones, which far away or off screen said nothing.
     *
     * A LINE ONLY WHERE THE COPPER IS MISSING. The tree used to run over the
     * whole net, between pads a trace already joined too, and its dashed lines
     * were taken for open connections (Niccolo', 2026-11-12). Pads on one
     * island of copper (gruppi-di-rame.ts) cost nothing to join and get no
     * line: what is joined is said by the lit pads and by the net's copper
     * (RameDelleReti). A part moved and not applied yet has left its copper
     * where it was: its pads are alone, and its lines are all there.
     */
    const rame = circuitJson ? rameDellaScheda(circuitJson) : null;
    const isolaDi = (p: { id: string; componentId: string }): string | number => {
      const isola = compTx(p.componentId) ? -1 : (rame?.diPiazzola(p.id) ?? -1);
      return isola < 0 ? p.id : isola;
    };
    const reti: typeof vuoto.retiFocus = [];
    const fatte = new Set<string>();
    for (const pad of mine) {
      const da = posOf(pad);
      const altri = (perRete.get(pad.net) ?? []).filter((p) => p.id !== pad.id);
      if (altri.length === 0) continue;
      const tinta = tintaDiRete(pad.netName || pad.net);
      const nome = etichetta(pad, altri);

      if (!fatte.has(pad.net)) {
        fatte.add(pad.net);
        const tutti = [pad, ...altri];
        const pos = tutti.map(posOf);
        const isola = tutti.map(isolaDi);
        // Prim: O(n^2), a few thousand steps even on ground
        const dentro = new Array<boolean>(pos.length).fill(false);
        const dist = new Array<number>(pos.length).fill(Infinity);
        const da0 = new Array<number>(pos.length).fill(-1);
        dist[0] = 0;
        for (let k = 0; k < pos.length; k++) {
          let u = -1;
          for (let i = 0; i < pos.length; i++) if (!dentro[i] && (u === -1 || dist[i] < dist[u])) u = i;
          dentro[u] = true;
          if (da0[u] >= 0 && isola[da0[u]] !== isola[u]) {
            const v = da0[u];
            out.push({
              tipo: "linea" as const,
              key: `mst-${tutti[v].id}-${tutti[u].id}`,
              x1: pos[v].x,
              y1: pos[v].y,
              x2: pos[u].x,
              y2: pos[u].y,
              testo: "",
              sotto: "",
              colore: tinta,
            });
          }
          for (let i = 0; i < pos.length; i++) {
            if (dentro[i]) continue;
            const d = isola[i] === isola[u] ? 0 : Math.hypot(pos[i].x - pos[u].x, pos[i].y - pos[u].y);
            if (d < dist[i]) {
              dist[i] = d;
              da0[i] = u;
            }
          }
        }
        reti.push({ net: pad.net, colore: tinta, da, membri: pos.slice(1) });
      }

      for (const p of [pad, ...altri]) {
        const a = posOf(p);
        out.push({
          tipo: "pad" as const,
          key: `${pad.id}-ev-${p.id}`,
          x1: a.x,
          y1: a.y,
          x2: p.w,
          y2: p.h,
          cerchio: p.circle,
          // turned like the pad underneath, the turn in progress included
          rot: p.rot + giroDi(p.componentId),
          // the name is written once per net, not on every lit pad
          ...(p.id === pad.id ? { ...nome, ...versoDi(pad, da) } : { testo: "", sotto: "" }),
          colore: tinta,
        });
      }
    }

    return { links: out, retiFocus: reti };
  }, [scene, circuitJson, hoveredComponentId, selectedIds, effOf, compTx, nascosti, girati, padSotto]);

  /*
   * The net names, laid out in screen pixels so they never overlap and keep
   * their size at any zoom: see net-labels.ts. They are drawn outside the
   * flipped group, like the designators.
   */
  const nomiDiRete = useMemo(
    () =>
      layoutNetLabels(
        links
          .filter((l) => l.testo && l.lato)
          .map((l) => ({
            key: l.key,
            x: l.x1,
            y: l.y1,
            lato: l.lato!,
            raggio: l.raggio ?? 0,
            testo: l.testo,
            sotto: l.sotto,
            colore: l.colore,
          })),
        view,
      ),
    [links, view],
  );

  /*
   * The pins of a net that are OFF SCREEN: a small arrow on the edge, in the
   * net's colour, pointing at them. One per direction, not one per pin.
   */
  const frecce = useMemo(() => {
    const out: Array<{ key: string; x: number; y: number; ang: number; colore: string }> = [];
    const M = 12;
    for (const r of retiFocus) {
      const ax = view.x + r.da.x * view.k;
      const ay = view.y - r.da.y * view.k;
      const fx = Math.min(Math.max(ax, M), size.w - M);
      const fy = Math.min(Math.max(ay, M), size.h - M);
      const messe: Array<{ x: number; y: number }> = [];
      for (const m of r.membri) {
        const mx = view.x + m.x * view.k;
        const my = view.y - m.y * view.k;
        if (mx >= 0 && mx <= size.w && my >= 0 && my <= size.h) continue;
        // where the line from the pin toward the member leaves the inset frame
        const dx = mx - fx, dy = my - fy;
        let t = 1;
        if (dx > 0) t = Math.min(t, (size.w - M - fx) / dx);
        if (dx < 0) t = Math.min(t, (M - fx) / dx);
        if (dy > 0) t = Math.min(t, (size.h - M - fy) / dy);
        if (dy < 0) t = Math.min(t, (M - fy) / dy);
        const x = fx + dx * Math.max(0, t), y = fy + dy * Math.max(0, t);
        if (messe.some((q) => Math.hypot(q.x - x, q.y - y) < 22)) continue;
        messe.push({ x, y });
        out.push({ key: `${r.net}-${out.length}`, x, y, ang: (Math.atan2(dy, dx) * 180) / Math.PI, colore: r.colore });
        if (out.length > 60) return out;
      }
    }
    return out;
  }, [retiFocus, view, size]);

  /*
   * The names of the parts in "Sposta": every part of the visible face, next
   * to it, never on another name and off the pads when there is room. They
   * follow a drag. See net-labels.ts, layoutDesignators.
   */
  const designatori = useMemo(() => {
    if (!scene || mode !== "move") return [];
    const parti = scene.components
      .filter((c) => !nascosti.has(c.id) && c.name)
      .map((c) => {
        const e = effOf(c);
        const giro = (((e.rotation - c.rotation) % 360) + 360) % 360;
        const quarto = Math.round(giro % 180) === 90;
        // the footprint's centre turns with the part around its centre
        const a = (giro * Math.PI) / 180;
        const ox = c.dx * Math.cos(a) - c.dy * Math.sin(a);
        const oy = c.dx * Math.sin(a) + c.dy * Math.cos(a);
        return { key: c.id, name: c.name, cx: e.x + ox, cy: e.y + oy, w: quarto ? c.h : c.w, h: quarto ? c.w : c.h };
      });
    const spostamento = new Map(
      scene.components.map((c) => {
        const e = effOf(c);
        return [c.id, { dx: e.x - c.x, dy: e.y - c.y }];
      }),
    );
    const pads = scene.pads
      .filter((p) => bothSides || p.foro || latoDiParte(p.componentId, p.layer) === faccia)
      .map((p) => {
        const d = spostamento.get(p.componentId) ?? { dx: 0, dy: 0 };
        const x = view.x + (p.x + d.dx) * view.k;
        const y = view.y - (p.y + d.dy) * view.k;
        const r = (Math.max(p.w, p.h) * view.k) / 2;
        return { bx: x - r, by: y - r, bw: 2 * r, bh: 2 * r };
      });
    return layoutDesignators(parti, pads, view);
    // latoDiParte reads girati, which is in the list
  }, [scene, mode, nascosti, effOf, view, bothSides, faccia, girati]); // eslint-disable-line react-hooks/exhaustive-deps

  /** the same transform, but on a point in millimeters (for texts outside the flipped group) */
  const mmPointTx = useCallback(
    (componentId: string, x: number, y: number): { x: number; y: number; dRot: number } => {
      const fallback = { x, y, dRot: 0 };
      if (!componentId || !scene) return fallback;
      const c = scene.components.find((cx) => cx.id === componentId);
      if (!c) return fallback;
      const eff = effOf(c);
      const dRot = (((eff.rotation - c.rotation) % 360) + 360) % 360;
      const rad = (dRot * Math.PI) / 180;
      if (girati.has(c.id)) ({ x, y } = applyMatrix(mirrorMatrix(c.ox, c.oy, c.rotation), x, y));
      const rx = c.ox + (x - c.ox) * Math.cos(rad) - (y - c.oy) * Math.sin(rad);
      const ry = c.oy + (x - c.ox) * Math.sin(rad) + (y - c.oy) * Math.cos(rad);
      return { x: rx + (eff.x - c.x), y: ry + (eff.y - c.y), dRot };
    },
    [scene, effOf, girati],
  );

  /*
   * THE PARTS THAT HIT EACH OTHER, NOW. The footprints are drawn where the parts
   * are being held (moved, turned, turned over and not applied yet), and the
   * ones that overlap are red while the part is still in hand: the same
   * collision the check (component-clearance.ts) reports after the compile,
   * computed on the same shapes moved like their part.
   */
  /*
   * Per part, WHAT hits: its own footprint (red on its face) and/or, for a
   * through-hole part, its holes on the other face (red there, where the
   * collision is: USB1's pins against U9 on the bottom are not USB1's top
   * courtyard). A failure here leaves the board drawn, with no red.
   */
  const inCollisione = useMemo(() => {
    const out = new Map<string, { proprie: boolean; fori: boolean }>();
    if (!scene || scene.ingombri.length === 0) return out;
    try {
      const sposta = (id: string, forme: Forma[]): Forma[] =>
        forme.map((f) => forma(f.punti.map((q) => mmPointTx(id, q.x, q.y)), f.r));
      const vivi = scene.ingombri.map((g) => {
        const mosso = Boolean(moveOverrides[g.componentId]) || Boolean(compDrag?.ids.includes(g.componentId)) || girati.has(g.componentId);
        return {
          faccia: (latoDiParte(g.componentId, g.layer) === "bottom" ? "bottom" : "top") as "top" | "bottom",
          forme: mosso ? sposta(g.componentId, g.forme) : g.forme,
          fori: mosso ? sposta(g.componentId, g.fori) : g.fori,
        };
      });
      const segna = (i: number, daiFori: boolean) => {
        const id = scene.ingombri[i].componentId;
        const c = out.get(id) ?? { proprie: false, fori: false };
        if (daiFori) c.fori = true;
        else c.proprie = true;
        out.set(id, c);
      };
      for (const s of scontri(vivi)) {
        segna(s.a, s.daiForiA);
        segna(s.b, s.daiForiB);
      }
    } catch (err) {
      console.error("scontri degli ingombri non calcolati:", err);
      out.clear();
    }
    return out;
    // latoDiParte reads girati, which is in the list
  }, [scene, mmPointTx, moveOverrides, compDrag, girati]); // eslint-disable-line react-hooks/exhaustive-deps

  /*
   * "Gira lato" (F in Sposta): the picked part, and every selected one, goes
   * to the other face. Same place, same rotation, footprint mirrored as
   * tscircuit does for a part on that face. A pending edit like a move: counted
   * in "Applica", undone with Cmd+Z, written to manual-edits.json as `layer`.
   */
  /** the parts a gesture acts on: the multi-selection and the picked part, if visible */
  const bersagli = useCallback((): string[] => {
    const ids = new Set([pickedId, ...(selectedIds ?? [])].filter((v): v is string => Boolean(v)));
    return [...ids].filter((id) => pezzoDi.has(id) && !nascosti.has(id));
  }, [pickedId, selectedIds, nascosti, pezzoDi]);

  const giraLato = useCallback(() => {
    if (!scene) return;
    const gruppo = `g${Date.now()}`;
    for (const id of bersagli()) {
      const comp = pezzoDi.get(id)!;
      const cur = effOf(comp);
      const ora = latoDiPezzo(comp);
      onMoveComponent?.(comp.id, { x: cur.x, y: cur.y }, { x: cur.x, y: cur.y }, cur.rotation, ora === "bottom" ? "top" : "bottom", gruppo);
    }
  }, [scene, bersagli, pezzoDi, effOf, latoDiPezzo, onMoveComponent]);

  /*
   * Keyboard, in move mode: the arrows move the selected component
   * by one grid pitch (Shift = fine pitch), R rotates it by 90° counter-
   * clockwise (Shift+R = clockwise, Alt+R by 45°), Esc deselects it. Every keypress is a
   * pending edit, like a drag: everything is applied at once.
   */
  useEffect(() => {
    if (mode !== "move" || !scene) return;
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e)) return;
      if (e.key === "Escape") {
        onPickComponent?.(null);
        if ((selectedIds?.length ?? 0) > 0) onSelectionChange?.([]);
        return;
      }
      // F turns the part over; R stays the rotation (schematic F is its own view)
      if ((e.key === "f" || e.key === "F") && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        giraLato();
        return;
      }
      const ids = bersagli();
      if (ids.length === 0) return;
      const gruppo = ids.length > 1 ? `g${Date.now()}` : undefined;
      /*
       * R turns the part, plain, no modifier: it is the key everyone presses
       * on a board editor. Routing moved to I (EditorBar). Before, rotation
       * hid behind cmd+R - which is also the browser reload - and R switched
       * mode: you pressed to turn a part and you changed tool, or reloaded
       * the page and lost the pending work.
       *
       * cmd+R keeps working out of habit, and keeps being stopped so the
       * browser does not reload underneath.
       */
      const delta = rotazioneDaTasto(e);
      if (delta !== null) {
        e.preventDefault();
        e.stopPropagation();
        // each part turns in place
        for (const id of ids) {
          const cur = effOf(pezzoDi.get(id)!);
          const rotation = (((cur.rotation + delta) % 360) + 360) % 360;
          onMoveComponent?.(id, { x: cur.x, y: cur.y }, { x: cur.x, y: cur.y }, rotation, undefined, gruppo);
        }
        return;
      }
      const step = e.shiftKey ? 0.1 : gridMm;
      const arrows: Record<string, { dx: number; dy: number }> = {
        ArrowLeft: { dx: -step, dy: 0 },
        ArrowRight: { dx: step, dy: 0 },
        // millimeter y goes upward: arrow up = further up
        ArrowUp: { dx: 0, dy: step },
        ArrowDown: { dx: 0, dy: -step },
      };
      const d = arrows[e.key] as { dx: number; dy: number } | undefined;
      if (!d) return;
      e.preventDefault();
      /*
       * The rotation travels WITH the move.
       *
       * Rotating and then moving used to un-rotate the part: the move event
       * carried no rotation, and whoever collected the pending edits kept only
       * the last event per component — so the 90 degrees just asked for
       * vanished from the preview. Now every move says how the part is turned,
       * and the two edits stop stepping on each other.
       */
      for (const id of ids) {
        const cur = effOf(pezzoDi.get(id)!);
        // one part snaps to the grid; a group moves by the step and keeps its shape
        // and with Shift the step is 0,1 mm: snapped to a coarser grid it would not move at all
        const to = ids.length > 1 || e.shiftKey
          ? { x: Math.round((cur.x + d.dx) * 1000) / 1000, y: Math.round((cur.y + d.dy) * 1000) / 1000 }
          : { x: snap(cur.x + d.dx, true, gridMm), y: snap(cur.y + d.dy, true, gridMm) };
        onMoveComponent?.(id, { x: cur.x, y: cur.y }, to, cur.rotation, undefined, gruppo);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, scene, effOf, onMoveComponent, onPickComponent, gridMm, giraLato, bersagli, pezzoDi, selectedIds, onSelectionChange]);

  if (!scene) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-faint">
        <span className="dot dot-busy" /> Nessuna scheda compilata.
      </div>
    );
  }

  /** "all" (key 0, "Tutti"): every copper layer at full strength, top above */
  const scelto = stratoScelto(layer);
  const tutti = scelto === "all";
  const active: LayerId = scelto === "all" ? "top" : scelto;
  // every copper layer the board declares, from the bottom up (2, 4, 6 or 8: see strati-rame.ts)
  const usedLayers = layerDrawOrder(scene.board.layers);
  /*
   * The chosen layer is drawn LAST, so above all the others.
   * Before, the order was fixed (top copper always on top) and working on an
   * inner plane was impossible: what you were looking at ended up underneath.
   */
  const drawOrder: LayerId[] = [...usedLayers.filter((l) => l !== active), active];
  // the layers that are not in the foreground show through: the
  // x-ray decides how much
  /*
   * X-ray at zero means SEEING ONLY the chosen layer. Before, the others
   * stayed at a tenth "as reference": but if you choose bottom and the
   * x-ray is off, the top copper must not be there, otherwise there is
   * no way to look at one face only and the command does not do what it says.
   * Raising the x-ray brings the other layers back, which is where they belong.
   */
  /*
   * The rule is in strati-visibili.ts, shared with the routing view. One case
   * of its own here: in Sposta with "Top + Bottom" the parts of both faces are
   * being moved, so both faces are at full strength whatever layer is chosen
   * (their pads were at zero with the x-ray off: parts to grab with no pads).
   */
  const dueFacce = mode === "move" && bothSides;
  const layerOpacity = (l: LayerId) =>
    dueFacce && (l === "top" || l === "bottom") ? 1 : opacitaStrato(l, scelto, xray);
  /** the face of a part, to give its courtyard the strength of its face */
  const facciaDiPezzo = new Map(scene.components.map((c) => [c.id, latoDiPezzo(c)] as const));
  /** the silkscreen follows the face being looked at; on an inner plane it comes back with the x-ray */
  const facciaSerigrafia: LayerId = active === "bottom" ? "bottom" : "top";
  const forzaSerigrafia = layerOpacity(facciaSerigrafia);

  const mmPerPx = 1 / view.k;
  const showSilk = flags.is_showing_silkscreen;
  const showMask = flags.is_showing_solder_mask;
  const showPours = flags.is_showing_copper_pours;
  const showCourtyards = flags.is_showing_courtyards;
  // the footprints: where the courtyards are shown, and while parts are being moved
  const showIngombri = showCourtyards || mode === "move";
  const showErrors = flags.is_showing_drc_errors;
  const showPaste = flags.is_showing_paste_mask;

  /*
   * THE BAR UNDER THE BOARD. What the part is, what is selected, where the
   * nets go, the shortcuts: all here, in a strip of its own BELOW the board,
   * never over it. The card used to open next to the part, big, over the
   * parts and the connection lines ("IL POPUP MENTRE SPOSTO NON METTERLO
   * DAVANTI", Niccolo', 2026-11-09). Over the board only the part names and
   * the connection lines are drawn.
   */
  const inMano = compDrag && compDrag.ids.length > 1 ? compDrag.ids : null;
  const gruppoScelto = inMano ?? (mode === "move" ? bersagli() : (selectedIds ?? []));
  const idBarra = hoveredComponentId ?? compDrag?.id ?? pickedId ?? null;
  const infoBarra = idBarra ? partInfo?.[idBarra] ?? null : null;
  const retiBarra = links.filter((l) => l.testo && l.membri).map((l) => `${l.testo}: ${l.membri}`);

  return (
    <div className="flex h-full w-full flex-col">
    <div
      ref={wrapRef}
      className="relative min-h-0 w-full flex-1 overflow-hidden select-none"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const rect = wrapRef.current?.getBoundingClientRect();
        /*
         * In select mode the drag draws a box instead of
         * panning the view: it is the gesture everyone expects when something must
         * be chosen. The view still pans while holding Alt, so you are not
         * trapped in the framing while selecting.
         */
        /*
         * In Sposta, Shift + drag draws the box too (empty area or over parts);
         * plain drag still pans, Alt still means "no snap" on a part.
         */
        const boxInSposta = mode === "move" && e.shiftKey;
        if ((selectMode !== "off" || boxInSposta) && rect && !e.altKey) {
          marqueeAdd.current = e.shiftKey;
          const x = e.clientX - rect.left;
          const y = e.clientY - rect.top;
          if (boxInSposta) {
            const q = toMm(x, y);
            const sotto = scene?.components.find((c) => {
              if (nascosti.has(c.id)) return false;
              const p = effOf(c);
              return Math.abs(q.x - (p.x + c.dx)) <= c.w / 2 && Math.abs(q.y - (p.y + c.dy)) <= c.h / 2;
            });
            marqueeSu.current = sotto?.id ?? null;
          }
          setMarquee({ x0: x, y0: y, x1: x, y1: y });
          (e.target as Element).setPointerCapture?.(e.pointerId);
          return;
        }
        setDragging(true);
        dragFrom.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
        (e.target as Element).setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={(e) => {
        // copper in hand follows the cursor on the same grid as a part (Alt takes it off)
        if (
          rame.muovi(() => {
            const rect = wrapRef.current?.getBoundingClientRect();
            if (!rect) return null;
            const p = toMm(e.clientX - rect.left, e.clientY - rect.top);
            return { x: snap(p.x, !e.altKey, gridMm), y: snap(p.y, !e.altKey, gridMm) };
          })
        ) {
          return;
        }
        // a component in hand follows the cursor, snapped to the grid
        if (compDragFrom.current) {
          const rect = wrapRef.current?.getBoundingClientRect();
          if (!rect) return;
          const p = toMm(e.clientX - rect.left, e.clientY - rect.top);
          const d = compDragFrom.current;
          const x = snap(d.origX + (p.x - d.startX), !e.altKey, gridMm);
          const y = snap(d.origY + (p.y - d.startY), !e.altKey, gridMm);
          setCompDrag({ id: d.id, x, y, dx: x - d.origX, dy: y - d.origY, ids: d.gruppo.map((g) => g.id) });
          return;
        }
        if (marquee) {
          const rect = wrapRef.current?.getBoundingClientRect();
          if (!rect) return;
          setMarquee((m) =>
            m ? { ...m, x1: e.clientX - rect.left, y1: e.clientY - rect.top } : m,
          );
          return;
        }
        if (!dragging || !dragFrom.current) {
          // which pin is under the mouse, among the parts that can be seen
          const rect = wrapRef.current?.getBoundingClientRect();
          if (rect && scene) {
            const q = toMm(e.clientX - rect.left, e.clientY - rect.top);
            const sotto = scene.pads.find((p) => {
              if (!p.net || nascosti.has(p.componentId)) return false;
              const c = pezzoDi.get(p.componentId);
              const eff = c ? effOf(c) : null;
              const x = p.x + (eff && c ? eff.x - c.x : 0);
              const y = p.y + (eff && c ? eff.y - c.y : 0);
              const r = Math.max(p.w, p.h) / 2;
              return Math.abs(q.x - x) <= r && Math.abs(q.y - y) <= r;
            });
            const id = sotto?.id ?? null;
            if (id !== padSotto) setPadSotto(id);
          }
          return;
        }
        const d = dragFrom.current;
        setView((v) => ({ ...v, x: d.vx + (e.clientX - d.x), y: d.vy + (e.clientY - d.y) }));
      }}
      onPointerLeave={() => setPadSotto(null)}
      onPointerCancel={rame.annulla}
      onPointerUp={(e) => {
        // copper in hand is let go here: it becomes a gesture to save
        if (rame.rilascia()) return;
        // the component is dropped here: it becomes a pending edit
        if (compDragFrom.current && compDrag) {
          const d = compDragFrom.current;
          compDragFrom.current = null;
          const dropped = compDrag;
          setCompDrag(null);
          if (dropped.dx !== 0 || dropped.dy !== 0) {
            // every part of the group by the same displacement; the rotation travels too
            const gruppo = d.gruppo.length > 1 ? `g${Date.now()}` : undefined;
            for (const g of d.gruppo) {
              onMoveComponent?.(
                g.id,
                { x: g.x, y: g.y },
                { x: Math.round((g.x + dropped.dx) * 1000) / 1000, y: Math.round((g.y + dropped.dy) * 1000) / 1000 },
                g.rotation,
                undefined,
                gruppo,
              );
            }
          }
          return;
        }
        compDragFrom.current = null;
        if (marquee) {
          const box = marqueeMm();
          // a two-pixel box is a click, not a selection: it is
          // discarded, otherwise every empty click would clear the selection
          const tiny =
            Math.abs(marquee.x1 - marquee.x0) < 4 && Math.abs(marquee.y1 - marquee.y0) < 4;
          setMarquee(null);
          // Sposta: a Shift click on a part adds it to the selection or takes it out
          if (tiny && mode === "move" && selectMode === "off" && marqueeSu.current) {
            const id = marqueeSu.current;
            const ids = selectedIds ?? [];
            onSelectionChange?.(ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);
            marqueeSu.current = null;
            return;
          }
          marqueeSu.current = null;
          if (box && !tiny) {
            if (selectMode === "zone") {
              onZoneChange?.(box);
            } else if (selectMode === "components" || mode === "move") {
              const inside = scene.components
                .filter(
                  (c) =>
                    !nascosti.has(c.id) &&
                    c.x >= box.minX && c.x <= box.maxX && c.y >= box.minY && c.y <= box.maxY,
                )
                .map((c) => c.id);
              const next = marqueeAdd.current
                ? [...new Set([...(selectedIds ?? []), ...inside])]
                : inside;
              onSelectionChange?.(next);
            }
          }
          return;
        }
        // empty click in move mode (not a drag): deselect, the multi-selection too
        if (mode === "move" && dragFrom.current) {
          const moved = Math.hypot(e.clientX - dragFrom.current.x, e.clientY - dragFrom.current.y);
          if (moved < 4) {
            onPickComponent?.(null);
            if ((selectedIds?.length ?? 0) > 0) onSelectionChange?.([]);
          }
        }
        setDragging(false);
        dragFrom.current = null;
      }}
      style={{
        cursor: marquee
          ? "crosshair"
          : selectMode !== "off"
            ? "crosshair"
            : dragging
              ? "grabbing"
              : "grab",
      }}
    >
      <svg width={size.w} height={size.h} className="block">
        {/* mm -> pixel, with the y pointing up as in technical drawing */}
        <g transform={`translate(${view.x} ${view.y}) scale(${view.k} ${-view.k})`}>
          {/*
            The board: its real shape when the project declares an outline
            (notches, cut corners), the rectangle otherwise.
          */}
          {boardPath ? (
            <path
              d={boardPath}
              fill={showMask ? "#0E5E43" : "#0C1A17"}
              stroke="#2C4C42"
              strokeWidth={mmPerPx}
              strokeLinejoin="round"
            />
          ) : (
            <rect
              x={scene.board.centerX - scene.board.width / 2}
              y={scene.board.centerY - scene.board.height / 2}
              width={scene.board.width}
              height={scene.board.height}
              rx={0.6}
              fill={showMask ? "#0E5E43" : "#0C1A17"}
              stroke="#2C4C42"
              strokeWidth={mmPerPx}
            />
          )}

          {/* planes, traces and vias: they do not move with the parts, see RameFermo */}
          <RameFermo
            scene={scene}
            drawOrder={drawOrder}
            showPours={showPours}
            mmPerPx={mmPerPx}
            active={active}
            tutti={tutti}
            xray={xray}
            nascosti={rame.nascosti}
          />
          <RameInMovimento vivo={rame.vivo} inAttesa={rameInAttesa} drawOrder={drawOrder} scelto={scelto} xray={xray} />

          {/*
            THE SOLDER MASK: the green coating, over the copper.
            The flag existed and only changed the colour of the board, so the
            "Montaggio" view promised a board "as it comes out of the factory,
            where the paint covers the copper and the traces are not visible" and
            then showed every trace. Here the paint is a real layer: it goes over
            planes, traces and vias, and what stays bare is what a fab leaves
            bare, the pads and the holes, drawn after it.
            Not fully opaque on purpose: on a real board the copper underneath
            shows as a slightly different green, and that shadow is how you tell a
            plane from empty laminate.
          */}
          {showMask &&
            (boardPath ? (
              // the coating follows the laminate: no paint over a notch
              <path d={boardPath} fill="#0E5E43" opacity={0.93} />
            ) : (
              <rect
                x={scene.board.centerX - scene.board.width / 2}
                y={scene.board.centerY - scene.board.height / 2}
                width={scene.board.width}
                height={scene.board.height}
                rx={0.6}
                fill="#0E5E43"
                opacity={0.93}
              />
            ))}

          {/*
            The mask openings, when the coating is on: a ring of bare laminate
            around each pad, the size the file says (0.05mm here, and zero on the
            pads whose designer set it by hand). It goes over the paint and under
            the copper, which is the order in which a board is made.
          */}
          {showMask &&
            drawOrder.map((l) => (
              <g key={`mask-${l}`} opacity={layerOpacity(l)}>
                {scene.pads
                  .filter((p) => !p.foro && p.layer === l && p.maskMargin > 0)
                  .map((p) =>
                    p.circle ? (
                      <circle
                        key={`m-${p.id}`}
                        transform={compTx(p.componentId)}
                        cx={p.x}
                        cy={p.y}
                        r={p.w / 2 + p.maskMargin}
                        fill="#0C1A17"
                      />
                    ) : (
                      <rect
                        key={`m-${p.id}`}
                        transform={componi(
                          compTx(p.componentId),
                          p.rot ? `rotate(${p.rot} ${p.x} ${p.y})` : null,
                        )}
                        x={p.x - p.w / 2 - p.maskMargin}
                        y={p.y - p.h / 2 - p.maskMargin}
                        width={p.w + p.maskMargin * 2}
                        height={p.h + p.maskMargin * 2}
                        rx={(p.radius || 0.05) + p.maskMargin}
                        fill="#0C1A17"
                      />
                    ),
                  )}
              </g>
            ))}

          {/* pads */}
          {drawOrder.map((l) => (
            <g key={`pad-${l}`} opacity={layerOpacity(l)}>
              {scene.pads
                // through-hole pins are drawn with the holes
                .filter((p) => !p.foro && latoDiParte(p.componentId, p.layer) === l)
                .map((p) =>
                  p.circle ? (
                    <circle
                      key={p.id}
                      transform={compTx(p.componentId)}
                      cx={p.x}
                      cy={p.y}
                      r={p.w / 2}
                      fill={PAD_COLOR[l]}
                      stroke={LAYER_COLOR[l]}
                      strokeWidth={mmPerPx * 0.7}
                    />
                  ) : (
                    <rect
                      key={p.id}
                      /*
                       * The pad's own rotation, composed with its component's
                       * move. POSITIVE, and it is worth saying why: the drawing
                       * lives inside a scale(1,-1), so the group's local frame
                       * has y UP like the board, and SVG's rotate() is a plain
                       * counterclockwise rotation in the frame it is applied in.
                       * Negating it mirrors the pad: measured against the file,
                       * 0.63mm off on the corners against 0.001mm.
                       */
                      transform={componi(
                        compTx(p.componentId),
                        p.rot ? `rotate(${p.rot} ${p.x} ${p.y})` : null,
                      )}
                      x={p.x - p.w / 2}
                      y={p.y - p.h / 2}
                      width={p.w}
                      height={p.h}
                      rx={p.radius || 0.05}
                      fill={PAD_COLOR[l]}
                      stroke={LAYER_COLOR[l]}
                      strokeWidth={mmPerPx * 0.7}
                    />
                  ),
                )}
            </g>
          ))}

          {/* the copper of the focused nets, in their colour: what is already joined */}
          <RameDelleReti circuitJson={circuitJson} reti={retiFocus} mmPerPx={mmPerPx} forza={(s) => layerOpacity(s as LayerId)} />

          {/* the connections of the focused component: one color per pin */}
          {links.length > 0 && (
            <g pointerEvents="none">
              {links.map((l) =>
                l.tipo === "pad" ? (
                  <g key={l.key}>
                    {/* lit pad: it is the same node as the focused one */}
                    {l.cerchio ? (
                      <circle cx={l.x1} cy={l.y1} r={l.x2 / 2 + 0.08} fill="none" stroke={l.colore} strokeWidth={0.12} />
                    ) : (
                      <rect
                        transform={l.rot ? `rotate(${l.rot} ${l.x1} ${l.y1})` : undefined}
                        x={l.x1 - l.x2 / 2 - 0.08}
                        y={l.y1 - l.y2 / 2 - 0.08}
                        width={l.x2 + 0.16}
                        height={l.y2 + 0.16}
                        rx={0.06}
                        fill={l.colore}
                        fillOpacity={0.35}
                        stroke={l.colore}
                        strokeWidth={0.08}
                      />
                    )}
                  </g>
                ) : (
                  <g key={l.key}>
                    {/* a branch of the net's shortest tree: thin, same width at any zoom */}
                    <line
                      x1={l.x1}
                      y1={l.y1}
                      x2={l.x2}
                      y2={l.y2}
                      stroke={l.colore}
                      strokeWidth={1.3}
                      vectorEffect="non-scaling-stroke"
                      strokeDasharray="5 3"
                      opacity={0.9}
                    />
                  </g>
                ),
              )}
            </g>
          )}


          {/*
            plated holes and mechanical holes: only a plated hole has a copper
            ring; a mechanical one is the bare drill with a thin grey edge, so it
            is not read as copper next to the pads around it (see holeCopper)
          */}
          {scene.holes.map((h) => {
            const ring = holeCopper(h);
            return (
              <g key={h.id} transform={compTx(h.componentId)}>
                {ring?.kind === "rect" && (
                  <rect x={ring.x} y={ring.y} width={ring.w} height={ring.h} fill={HOLE_COPPER} />
                )}
                {ring?.kind === "circle" && <circle cx={h.x} cy={h.y} r={ring.r} fill={HOLE_COPPER} />}
                <circle
                  cx={h.x}
                  cy={h.y}
                  r={h.hole / 2}
                  fill="#06100D"
                  {...(h.plated ? {} : { stroke: "#9AA8A2", strokeWidth: mmPerPx * 1.2 })}
                />
              </g>
            );
          })}

          {/* solder paste: the stencil opening, smaller than the pad */}
          {/*
            Per face, like the pads: the paste of the other face used to be drawn
            in full over the face being looked at (the light blue rectangles
            under J3 on sbb-dl-principale with Top chosen, 2026-11-11).
          */}
          {showPaste &&
            drawOrder.filter((l) => layerOpacity(l) > 0).map((l) => (
            <g key={`paste-${l}`} opacity={layerOpacity(l)}>
            {scene.paste.filter((p) => !nascosti.has(p.componentId) && latoDiParte(p.componentId, p.layer) === l).map((p) =>
              p.circle ? (
                <circle
                  key={p.id}
                  transform={compTx(p.componentId)}
                  cx={p.x}
                  cy={p.y}
                  r={p.w / 2}
                  fill="none"
                  stroke="#C9D4FF"
                  strokeWidth={mmPerPx * 1.2}
                />
              ) : (
                <rect
                  key={p.id}
                  // turned like the pad it belongs to: a straight opening drawn
                  // inside a pad at 45 degrees is two rectangles at odds with
                  // each other, and it reads as a pad rotated wrong
                  transform={componi(
                    compTx(p.componentId),
                    p.rot ? `rotate(${p.rot} ${p.x} ${p.y})` : null,
                  )}
                  x={p.x - p.w / 2}
                  y={p.y - p.h / 2}
                  width={p.w}
                  height={p.h}
                  fill="rgba(201,212,255,0.22)"
                  stroke="#C9D4FF"
                  strokeWidth={mmPerPx * 1.2}
                />
              ),
            )}
            </g>
            ))}

          {/*
            The parts you are holding still, in move mode: a small ring with a
            cross, drawn on their origin. Whoever moves things has to know which
            ones an automatic arrangement will not touch, otherwise "rearrange"
            looks like it did nothing. Clicking the mark lets that part go.
          */}
          {mode === "move" &&
            fermi.size > 0 &&
            scene.components
              .filter((c) => fermi.has(c.name) && !nascosti.has(c.id))
              .map((c) => {
                const r = Math.max(0.5, mmPerPx * 7);
                return (
                  <g
                    key={`fermo-${c.id}`}
                    transform={compTx(c.id)}
                    style={{ cursor: onRelease ? "pointer" : "default" }}
                    onClick={(e) => {
                      if (!onRelease) return;
                      e.stopPropagation();
                      onRelease(c.name);
                    }}
                  >
                    <title>{`${c.name} e' tenuto fermo: nessuna azione automatica lo muove. Clicca per lasciarlo andare.`}</title>
                    <circle cx={c.ox} cy={c.oy} r={r} fill="#0B1110" fillOpacity={0.55} stroke="#E3B341" strokeWidth={mmPerPx * 1.2} />
                    <path
                      d={`M ${c.ox - r * 0.45} ${c.oy - r * 0.45} L ${c.ox + r * 0.45} ${c.oy + r * 0.45} M ${c.ox - r * 0.45} ${c.oy + r * 0.45} L ${c.ox + r * 0.45} ${c.oy - r * 0.45}`}
                      stroke="#E3B341"
                      strokeWidth={mmPerPx * 1.4}
                      strokeLinecap="round"
                    />
                  </g>
                );
              })}

          {/*
            THE FOOTPRINT OF EVERY PART (ingombro.ts), where the courtyards were:
            in the views that show them (Interferenze, Montaggio, Tutto) and in
            Sposta. A line 0,05 mm wide on the board (at least a pixel when far
            away), continuous for a courtyard the footprint declares, dashed for
            one PCB Studio computed (body and pads, the excess around them), red
            and lightly filled where two of them overlap, right now. A
            connector's mating space dashed in its own colour. They belong to the
            face of their part, by the rule of strati-visibili.ts.
          */}
          {showIngombri &&
            // a part of the face not drawn is not there, except its holes where they hit on the face that is
            scene.ingombri.filter((g) => !nascosti.has(g.componentId) || inCollisione.get(g.componentId)?.fori).map((g) => {
              const nascosto = nascosti.has(g.componentId);
              const faccia = facciaDiPezzo.get(g.componentId) ?? g.layer;
              const forza = layerOpacity(faccia);
              const scontro = inCollisione.get(g.componentId);
              const rosso = scontro?.proprie === true;
              const linea = Math.max(0.05, mmPerPx);
              const tratteggio = `${Math.max(0.25, mmPerPx * 5)} ${Math.max(0.15, mmPerPx * 3)}`;
              // the holes of a through-hole part that hit on the other face: red on that face, by its rule
              const forzaFori = scontro?.fori ? layerOpacity(faccia === "bottom" ? "top" : "bottom") : 0;
              const fori =
                forzaFori > 0 ? (
                  <g key={`ing-fori-${g.componentId}`} data-ingombro={`fori-${g.componentId}`} transform={compTx(g.componentId)} opacity={forzaFori} style={{ pointerEvents: "none" }}>
                    {g.fori.map((f, i) => (
                      <path key={i} d={percorsoDellaForma(f)} fill="rgba(255,77,94,0.16)" stroke={COLORE_SCONTRO} strokeWidth={linea} />
                    ))}
                  </g>
                ) : null;
              if (nascosto || forza <= 0) return fori;
              return (
                <Fragment key={`ing-${g.componentId}`}>
                {fori}
                <g data-ingombro={`ingombro-${g.componentId}`} transform={compTx(g.componentId)} opacity={forza} style={{ pointerEvents: "none" }}>
                  {g.forme.map((f, i) => (
                    <path
                      key={i}
                      d={percorsoDellaForma(f)}
                      fill={rosso ? "rgba(255,77,94,0.16)" : "none"}
                      stroke={rosso ? COLORE_SCONTRO : COLORE_INGOMBRO}
                      strokeWidth={linea}
                      strokeDasharray={g.dichiarato ? undefined : tratteggio}
                      strokeLinejoin="round"
                    />
                  ))}
                  {g.innesti.map((n, i) => (
                    <path
                      key={`inn-${i}`}
                      d={percorsoDellaForma(n.forma)}
                      fill="none"
                      stroke={COLORE_INNESTO}
                      strokeWidth={linea}
                      strokeDasharray={`${Math.max(0.5, mmPerPx * 8)} ${Math.max(0.25, mmPerPx * 4)}`}
                    />
                  ))}
                </g>
                </Fragment>
              );
            })}

          {/* silkscreen: only the side being looked at. On an inner plane it has
              nothing to do: it is not drawn, and comes back with the x-ray like
              the pads of that face (it stayed at a quarter, over the plane) */}
          {showSilk && forzaSerigrafia > 0 && (
            <g opacity={0.85 * forzaSerigrafia}>
              {scene.silkPaths
                .filter((p) => latoDiParte(p.componentId, p.layer) === facciaSerigrafia)
                .map((s) => (
                <polyline
                  key={s.id}
                  transform={compTx(s.componentId)}
                  points={s.points.map((p) => `${p.x},${p.y}`).join(" ")}
                  fill="none"
                  stroke="#D6E8E2"
                  strokeWidth={s.width}
                  strokeLinecap="round"
                />
              ))}
            </g>
          )}

          {/* the chosen copper zone: stays drawn even after the gesture */}
          {zone && (
            <rect
              x={zone.minX}
              y={zone.minY}
              width={zone.maxX - zone.minX}
              height={zone.maxY - zone.minY}
              fill="rgba(232,178,59,0.10)"
              stroke="#E8B23B"
              strokeWidth={mmPerPx * 1.4}
              strokeDasharray={`${mmPerPx * 5} ${mmPerPx * 4}`}
              style={{ pointerEvents: "none" }}
            />
          )}

          {/* the copper that can never move: under the handles, so a press on a part stays the part's (see BersagliDelRame) */}
          {rame.bersagli.length > 0 && (
            <BersagliDelRame bersagli={rame.bersagli} fermi scelto={scelto} xray={xray} mmPerPx={mmPerPx} onPrendi={rame.prendi} />
          )}

          {/* invisible rectangles over the components: they provide the hover,
              and in move mode they are the handle to drag them */}
          {scene.components.filter((c) => !nascosti.has(c.id)).map((c) => {
            const p = effOf(c);
            const isSelected = selected.has(c.id) || pickedId === c.id;
            const isHovered = hoveredComponentId === c.id;
            const isDragging = Boolean(compDrag?.ids.includes(c.id));
            const isMoved = Boolean(moveOverrides[c.id]);
            return (
              <rect
                key={c.id}
                // the REAL footprint (courtyard, else pads and body), off-centre where it is
                x={p.x + c.dx - c.w / 2}
                y={p.y + c.dy - c.h / 2}
                width={c.w}
                height={c.h}
                /*
                 * Solo la rotazione PENDENTE, non quella assoluta: la larghezza e
                 * l'altezza del componente sono gia' il suo ingombro sulla scheda,
                 * girato. Applicandoci sopra la rotazione assoluta si gira due
                 * volte, e la zona che prende il mouse esce coricata mentre il
                 * pezzo e' in piedi: su 56 componenti ruotati, 42 riquadri
                 * sbagliavano di oltre mezzo millimetro su un lato.
                 */
                transform={
                  p.rotation !== c.rotation
                    ? `rotate(${(((p.rotation - c.rotation) % 360) + 360) % 360} ${p.x} ${p.y})`
                    : undefined
                }
                fill={
                  isSelected
                    ? "rgba(232,178,59,0.22)"
                    : isHovered || isDragging
                      ? "rgba(59,232,176,0.14)"
                      : "transparent"
                }
                stroke={
                  isSelected
                    ? "#E8B23B"
                    : isDragging || isHovered
                      ? "#3BE8B0"
                      : isMoved
                        ? "rgba(59,232,176,0.5)"
                        : "transparent"
                }
                strokeWidth={mmPerPx * (isSelected ? 2 : 1.5)}
                strokeDasharray={isMoved && !isSelected && !isHovered ? `${mmPerPx * 4} ${mmPerPx * 3}` : undefined}
                onPointerDown={(e) => {
                  if (mode !== "move" || e.button !== 0 || selectMode !== "off") return;
                  // Shift: the box (or the Shift click) belongs to the board, see above
                  if (e.shiftKey) return;
                  // the component is grabbed here: the view must NOT start
                  e.stopPropagation();
                  const rect = wrapRef.current?.getBoundingClientRect();
                  if (!rect) return;
                  const at = toMm(e.clientX - rect.left, e.clientY - rect.top);
                  /*
                   * A part of the multi-selection drags the whole selection; any
                   * other part drops the selection and goes alone.
                   */
                  const insieme = (selectedIds ?? []).includes(c.id)
                    ? bersagli()
                    : [c.id];
                  if (insieme.length === 1 && (selectedIds?.length ?? 0) > 0) onSelectionChange?.([]);
                  compDragFrom.current = {
                    id: c.id,
                    startX: at.x,
                    startY: at.y,
                    origX: p.x,
                    origY: p.y,
                    gruppo: insieme.map((id) => {
                      const q = effOf(pezzoDi.get(id)!);
                      return { id, x: q.x, y: q.y, rotation: q.rotation };
                    }),
                  };
                  setCompDrag({ id: c.id, x: p.x, y: p.y, dx: 0, dy: 0, ids: insieme });
                  setPadSotto(null);
                  (e.target as Element).setPointerCapture?.(e.pointerId);
                  onPickComponent?.(c.id);
                }}
                onMouseEnter={() => onHoverComponent?.(c.id)}
                onMouseLeave={() => onHoverComponent?.(null)}
                onClick={(e) => {
                  /*
                   * In select mode the click ADDS AND REMOVES, instead of
                   * opening the component card: you pick one by one
                   * what the box missed, or remove what
                   * it picked up by mistake.
                   */
                  // in Sposta a Shift click was handled by the board (add or remove)
                  if (mode === "move" && e.shiftKey) {
                    e.stopPropagation();
                    return;
                  }
                  if (selectMode === "components") {
                    e.stopPropagation();
                    const ids = selectedIds ?? [];
                    onSelectionChange?.(
                      isSelected ? ids.filter((id) => id !== c.id) : [...ids, c.id],
                    );
                    return;
                  }
                  onPickComponent?.(c.id);
                }}
                style={{ cursor: mode === "move" ? "move" : "pointer" }}
              />
            );
          })}

          {/* the copper that can move: over the handles of the parts, see BersagliDelRame */}
          {rame.bersagli.length > 0 && (
            <BersagliDelRame bersagli={rame.bersagli} scelto={scelto} xray={xray} mmPerPx={mmPerPx} onPrendi={rame.prendi} />
          )}

          {/* automatic-check markers, where they really are */}
          {showErrors &&
            markers.map((m) => {
              // a finding on a face follows that face (strati-visibili.ts); without one it is everywhere
              const forza = m.layer && m.layer !== "all" ? layerOpacity(m.layer) : 1;
              if (forza <= 0) return null;
              return (
              <g
                key={m.id}
                opacity={forza}
                onMouseEnter={(e) => {
                  const rect = wrapRef.current?.getBoundingClientRect();
                  if (rect) setTip({ x: e.clientX - rect.left, y: e.clientY - rect.top, text: m.message });
                }}
                onMouseLeave={() => setTip(null)}
                style={{ cursor: "help" }}
              >
                <circle
                  cx={m.x}
                  cy={m.y}
                  r={mmPerPx * 9}
                  fill="none"
                  stroke={m.severity === "err" ? "#FF6B5A" : "#E8B23B"}
                  strokeWidth={mmPerPx * 1.6}
                  className="drc-marker"
                />
                <circle cx={m.x} cy={m.y} r={mmPerPx * 14} fill="transparent" />
              </g>
              );
            })}

          {/* the stitching vias proposed, not written yet */}
          {anteprimaVie &&
            anteprimaVie.punti.map((p, i) => (
              <circle
                key={`cucitura-${i}`}
                cx={p.x}
                cy={p.y}
                r={Math.max(anteprimaVie.diametroMm / 2, mmPerPx * 2.5)}
                fill={p.colore}
                fillOpacity={0.85}
                stroke="#06100D"
                strokeWidth={mmPerPx}
                pointerEvents="none"
              />
            ))}

          {/* the open connections: over everything, on whatever face is being looked at */}
          {apertiInVista(flags, apertiAccesi) && (
            <CollegamentiApertiSulVisore
              circuitJson={circuitJson}
              mmPerPx={mmPerPx}
              forza={(s) => layerOpacity(s as LayerId)}
              scelto={apertoScelto?.id ?? null}
              sposta={mmPointTx}
            />
          )}

          <AvvisoDelGesto vivo={rame.vivo} mmPerPx={mmPerPx} />
        </g>

        {/* designators must not be mirrored: they are drawn outside the flipped group */}
        {showSilk && forzaSerigrafia > 0 && (
          <g opacity={forzaSerigrafia}>
          {scene.silkTexts
            /*
             * Only the side being looked at, like the silkscreen lines right
             * above. Without the filter you read the 91 references printed on
             * the underside while looking at the component side, mixed in with
             * the 116 that are really there: the traces of the wrong side
             * disappear correctly and their labels stay.
             */
            .filter((t) => latoDiParte(t.componentId, t.layer) === facciaSerigrafia)
            .map((t) => {
            const m = mmPointTx(t.componentId, t.x, t.y);
            const px = view.x + m.x * view.k;
            const py = view.y - m.y * view.k;
            const fontPx = t.size * view.k;
            if (fontPx < 5) return null;
            const rot = t.rotation + m.dRot;
            return (
              <text
                key={t.id}
                x={px}
                y={py}
                fontSize={fontPx}
                textAnchor="middle"
                dominantBaseline="middle"
                fill="rgba(214,232,226,0.72)"
                fontFamily="var(--font-plex-mono), monospace"
                transform={rot ? `rotate(${-rot} ${px} ${py})` : undefined}
                style={{ pointerEvents: "none" }}
              >
                {t.text}
              </text>
            );
          })}
          </g>
        )}
        {/* the pins of the focused nets that are off screen: an arrow on the edge */}
        {frecce.length > 0 && (
          <g pointerEvents="none">
            {frecce.map((f) => (
              <path
                key={f.key}
                d="M 7 0 L -5 -5 L -2 0 L -5 5 Z"
                transform={`translate(${f.x} ${f.y}) rotate(${f.ang})`}
                fill={f.colore}
                stroke="#0B1110"
                strokeWidth={1}
              />
            ))}
          </g>
        )}
        {/* part names in "Sposta": what is being moved, always readable */}
        {designatori.length > 0 && (
          <g pointerEvents="none">
            {designatori.map((d) => {
              const evidente = d.key === hoveredComponentId || d.key === pickedId || d.key === compDrag?.id;
              return (
                <g key={`des-${d.key}`}>
                  {d.leader && (
                    <line
                      x1={d.ax}
                      y1={d.ay}
                      x2={Math.min(Math.max(d.ax, d.bx), d.bx + d.bw)}
                      y2={Math.min(Math.max(d.ay, d.by), d.by + d.bh)}
                      stroke="#9DB8AC"
                      strokeWidth={0.8}
                      opacity={0.6}
                    />
                  )}
                  <rect
                    x={d.bx}
                    y={d.by}
                    width={d.bw}
                    height={d.bh}
                    rx={2.5}
                    fill={evidente ? "#3BE8B0" : "#0B1110"}
                    fillOpacity={evidente ? 1 : 0.88}
                  />
                  <text
                    x={d.bx + d.bw / 2}
                    y={d.by + d.bh - 3.5}
                    fontSize={DESIGNATOR_FONT}
                    textAnchor="middle"
                    fill={evidente ? "#06100D" : "#D6E8E2"}
                    fontWeight={evidente ? 700 : 500}
                    fontFamily="var(--font-plex-mono), monospace"
                  >
                    {d.name}
                  </text>
                </g>
              );
            })}
          </g>
        )}
        {/* net names: on the side of their pad, never on top of each other */}
        {nomiDiRete.length > 0 && (
          <g pointerEvents="none">
            {nomiDiRete.map((l) => (
              <NomeRete key={l.key} l={l} />
            ))}
          </g>
        )}
      </svg>

      {/* the box while it is being drawn: it lives outside the flipped SVG,
          because here the reasoning is in pixels, not millimeters */}
      {marquee && (
        <div
          className="pointer-events-none absolute z-20"
          style={{
            left: Math.min(marquee.x0, marquee.x1),
            top: Math.min(marquee.y0, marquee.y1),
            width: Math.abs(marquee.x1 - marquee.x0),
            height: Math.abs(marquee.y1 - marquee.y0),
            border: `1px dashed ${selectMode === "zone" ? "#E8B23B" : "#3BE8B0"}`,
            background:
              selectMode === "zone" ? "rgba(232,178,59,0.10)" : "rgba(59,232,176,0.10)",
          }}
        />
      )}

      {tip && (
        <div
          className="pointer-events-none absolute z-20 max-w-[280px] rounded-lg border border-[#3E1F1D] bg-[rgba(9,14,13,0.95)] px-2.5 py-1.5 text-[11px] leading-[1.4] text-[#FFB4AB]"
          style={{ left: tip.x + 12, top: tip.y - 8 }}
        >
          {tip.text}
        </div>
      )}

      {/* the footprints could not be computed: the board is drawn, and this says why there are none */}
      {showIngombri && scene.ingombriNonCalcolati !== undefined && (
        <div className="pointer-events-none absolute top-[18px] left-[18px] z-20 max-w-[60%] truncate rounded-md border border-[#3E1F1D] bg-[rgba(9,14,13,0.92)] px-2.5 py-1 text-[11px] text-[#FFB4AB]">
          Ingombri non disegnati: il calcolo si e&apos; fermato ({scene.ingombriNonCalcolati})
        </div>
      )}

      {apertiInVista(flags, apertiAccesi) && <LegendaAperti circuitJson={circuitJson} />}

      {/* view controls, as in the mockup */}
      <div className="absolute top-[18px] right-[18px] flex flex-col gap-1.5">
        <ViewButton title="Avvicina" onClick={() => zoomAt(size.w / 2, size.h / 2, 1.3)}>
          +
        </ViewButton>
        <ViewButton title="Allontana" onClick={() => zoomAt(size.w / 2, size.h / 2, 1 / 1.3)}>
          −
        </ViewButton>
        <ViewButton title="Inquadra la scheda" onClick={fit} mono>
          FIT
        </ViewButton>
      </div>

    </div>
      <BarraSotto
        gruppo={gruppoScelto.length > 1 ? gruppoScelto.map((id) => pezzoDi.get(id)?.name ?? "").filter(Boolean) : []}
        info={gruppoScelto.length > 1 ? null : infoBarra}
        reti={retiBarra}
        mode={mode}
        pickedId={gruppoScelto.length > 1 ? null : pickedId}
        onGira={giraLato}
        gridMm={gridMm}
        onGrid={setGridMm}
        pxPerMm={Math.round(view.k)}
        strati={usedLayers.length}
        rameSiSposta={rame.bersagli.length > 0}
      />
    </div>
  );
}

/**
 * The name of a net, in screen pixels: the net, and under it, small, the pins
 * of the focused part that sit on it ("Q3.G"). An opaque box, so it reads over
 * copper; a short line to its pad when it had to move away to find room.
 */
function NomeRete({ l }: { l: PlacedNetLabel }) {
  const fine = leaderEnd(l);
  const cx = l.bx + l.bw / 2;
  return (
    <g>
      {l.leader && (
        <line x1={l.ax} y1={l.ay} x2={fine.x} y2={fine.y} stroke={l.colore} strokeWidth={1} opacity={0.8} />
      )}
      <rect
        x={l.bx}
        y={l.by}
        width={l.bw}
        height={l.bh}
        rx={3}
        fill="#0B1110"
        fillOpacity={0.94}
        stroke={l.colore}
        strokeOpacity={0.55}
        strokeWidth={1}
      />
      <text
        x={cx}
        y={l.by + LABEL_METRICS.PAD_Y + LABEL_METRICS.LINE_1 - 3}
        fontSize={LABEL_FONT}
        textAnchor="middle"
        fill={l.colore}
        fontFamily="var(--font-plex-mono), monospace"
      >
        {l.testo}
        {l.sotto && (
          <tspan x={cx} dy={LABEL_METRICS.LINE_2} fontSize={PIN_FONT} opacity={0.75}>
            {l.sotto}
          </tspan>
        )}
      </text>
    </g>
  );
}

/**
 * The strip under the board: what is under the mouse or selected (one line,
 * the description opens with a click), where the nets go, the shortcuts.
 */
function BarraSotto({
  gruppo,
  info,
  reti,
  mode,
  pickedId,
  onGira,
  gridMm,
  onGrid,
  pxPerMm,
  strati,
  rameSiSposta,
}: {
  gruppo: string[];
  info: (DescrizionePezzo & { name: string }) | null;
  reti: string[];
  mode: "view" | "move";
  pickedId: string | null;
  onGira: () => void;
  gridMm: number;
  onGrid: (g: number) => void;
  pxPerMm: number;
  strati: number;
  /** in move mode vias and straight stretches of trace can be dragged too: the hint says so */
  rameSiSposta: boolean;
}) {
  const [aperta, setAperta] = useState(false);
  const descrizione = info ? [info.titolo, info.testo].filter(Boolean).join(" · ") : "";
  return (
    /*
     * FIXED height, always there, whatever it shows: a bar that grew a line on
     * hover changed the size of the board above it (see fitKey).
     */
    <div className="flex h-[60px] flex-none flex-col justify-center gap-0.5 overflow-hidden border-t border-[#1F2C29] bg-[#0A100F] px-3 py-1 text-[11px] leading-snug text-muted">
      <div className={`flex items-baseline gap-2 ${aperta ? "max-h-[32px] overflow-y-auto" : "h-[16px] overflow-hidden"}`}>
        {gruppo.length > 0 ? (
          <span className="truncate">
            <span className="font-semibold text-brand">{gruppo.length} pezzi</span>: {gruppo.join(", ")}
          </span>
        ) : info ? (
          <>
            <span className="flex-none font-mono font-semibold text-brand">{info.name}</span>
            {info.valore && info.valore !== info.titolo && (
              <span className="flex-none font-mono text-[10.5px] text-[#9DB8AC]">{info.valore}</span>
            )}
            {descrizione && (
              <button
                type="button"
                onClick={() => setAperta((a) => !a)}
                title={aperta ? "Chiudi" : `${descrizione}${info.fonte ? ` (${ETICHETTA_FONTE[info.fonte]})` : ""}`}
                className={`min-w-0 text-left text-[#C7D6D1] ${aperta ? "whitespace-normal" : "truncate"}`}
              >
                {descrizione}
                {aperta && info.fonte && <span className="ml-1 text-[9.5px] text-[#5F726C]">({ETICHETTA_FONTE[info.fonte]})</span>}
              </button>
            )}
          </>
        ) : (
          <span className="text-faint">
            {mode === "move"
              ? rameSiSposta
                ? "Trascina un componente, una via o un tratto dritto di pista per spostarlo. Esc annulla, Cmd+Z torna indietro."
                : "Trascina un componente per spostarlo."
              : "Passa sopra un componente per sapere cos'e' e dove vanno le sue reti."}
          </span>
        )}
        {mode === "move" && (pickedId || gruppo.length > 0) && (
          <button
            type="button"
            onClick={onGira}
            title="Porta sull'altra faccia: stessa posizione, impronta specchiata. Si applica con Applica (F)"
            className="ml-auto flex-none rounded border border-[#2C4C42] px-1.5 py-px text-[10.5px] font-semibold text-brand transition-colors hover:bg-brand-wash"
          >
            Gira lato (F)
          </button>
        )}
      </div>
      {!aperta && (
        <div className="h-[15px] truncate text-[10.5px] text-[#9DB8AC]" title={reti.join("\n")}>
          {reti.join("  ·  ")}
        </div>
      )}
      <div className="flex h-[16px] items-center gap-1 overflow-hidden whitespace-nowrap text-[10px] text-faint">
        {mode === "move" && (
          <>
            <span className="truncate">
              Alt niente snap · frecce (Shift 0,1 mm) · R/⇧R ruota · ⌥R 45° · F gira lato · Shift+trascina riquadro ·
              Shift+clic aggiunge/toglie · Esc deseleziona ·
            </span>
            <span>griglia</span>
            {GRID_OPTIONS.map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => onGrid(g)}
                className={`rounded border px-1 py-px font-mono text-[9.5px] transition-colors ${
                  gridMm === g ? "border-brand/50 bg-brand-wash text-brand" : "border-[#1F2C29] text-faint hover:text-muted"
                }`}
              >
                {String(g).replace(".", ",")}
              </button>
            ))}
            <span>mm ·</span>
          </>
        )}
        <span className="ml-auto flex-none font-mono">
          {pxPerMm} px/mm · 1–{strati} uno strato · 0 tutti
        </span>
      </div>
    </div>
  );
}

function ViewButton({
  children,
  title,
  onClick,
  mono = false,
}: {
  children: React.ReactNode;
  title: string;
  onClick: () => void;
  mono?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      onPointerDown={(e) => e.stopPropagation()}
      className={`grid h-[34px] w-[34px] place-items-center rounded-[10px] border border-[#1F2C29] bg-[rgba(11,17,16,0.9)] text-[#B9CAC5] backdrop-blur transition-colors hover:border-[#3A5A50] hover:text-brand ${
        mono ? "font-mono text-[9px]" : "text-[15px]"
      }`}
    >
      {children}
    </button>
  );
}

export type { BoardScene };

/**
 * The copper that does not move with the parts: planes, traces and vias. A
 * moved part leaves its traces where they are until they are redrawn, so none
 * of this changes while parts are dragged, dropped or saved, and it is drawn
 * once per board, zoom and layer choice instead of on every gesture. On
 * tm-4l-r3 (831 traces, 711 vias) it was 85% of every redraw: 22-39 ms per
 * drop, 3-5 ms without (2026-11-09).
 */
const RameFermo = memo(
  function RameFermo({
    scene,
    drawOrder,
    showPours,
    mmPerPx,
    active,
    tutti,
    xray,
    nascosti,
  }: {
    scene: BoardScene;
    drawOrder: LayerId[];
    showPours: boolean;
    mmPerPx: number;
    active: LayerId;
    tutti: boolean;
    xray: number;
    /**
     * The traces and vias a copper gesture has taken out (in hand, or let go
     * and not on the saved board yet): RameInMovimento draws them moved. The
     * same object from the start of a gesture to its end, so this memo holds
     * while the pointer moves.
     */
    nascosti: RameNascosto | null;
  }) {
    // the rule of strati-visibili.ts; the planes keep their own top strength (0.45, see below)
    const layerOpacity = (l: LayerId) => opacitaStrato(l, tutti ? "all" : active, xray);
    return (
      <>
      {/* copper planes, from bottom to top */}
      {showPours &&
        drawOrder.map((l) =>
          /*
           * One group per net: its pours opaque inside it, the transparency
           * on the group, so two pours of the net that overlap are one area
           * and not a lighter band (see colatePerRete).
           */
          colatePerRete(scene.pours, l).map((g) => (
            <g key={g.key} opacity={tutti || l === active ? 0.45 : (xray / 100) * 0.45}>
            {g.pours.map((p) => (
              <path
                key={p.id}
                d={p.path}
                fillRule="evenodd"
                fill={LAYER_COLOR[l]}
                /*
                 * The plane has its own opacity, not the layers'.
                 * Multiplying the two factors, a ground plane on inner1
                 * while looking at top ended up at 0.16 x 0.1 = 1.6%: it was there
                 * but invisible, and on a 4-layer board the ground plane is
                 * the first thing that must be recognized. Here it stays
                 * discreet under the traces but visible even when it is not
                 * the foreground layer.
                 *
                 * AND IT HAS AN EDGE. At a fifth of the colour a plane that
                 * covers the whole face is a uniform tint over a dark board:
                 * indistinguishable from the board itself, and read as "the
                 * pour is missing" — which happened, twice, on a board whose
                 * ground covers 3216 of its 3551 square millimetres. The
                 * outline is what says there is copper here and it ends
                 * there; the clearances around pads become visible with it.
                 */
                stroke={LAYER_COLOR[l]}
                strokeWidth={mmPerPx * (l === active ? 1.4 : 1)}
                strokeOpacity={tutti || l === active ? 0.85 : (xray / 100) * 0.7}
              />
            ))}
            </g>
          )),
        )}

      {/* traces */}
      {drawOrder.map((l) => (
        <g key={`tr-${l}`} opacity={layerOpacity(l)}>
          {scene.traces
            .filter((t) => t.layer === l && t.points.length > 1 && !nascosti?.piste.has(t.traceId))
            .map((t, i) => (
              <polyline
                key={`${l}-${i}`}
                points={t.points.map((p) => `${p.x},${p.y}`).join(" ")}
                fill="none"
                stroke={LAYER_COLOR[l]}
                strokeWidth={t.width}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ))}
        </g>
      ))}

      {/* via: copper ring with the through hole, UNDER the coating: a via is
          tented, which is why on a finished board you see a green dot and
          not a metal ring (this board's file marks all 640 of them tented) */}
      {scene.vias.filter((v) => !nascosti?.vie.has(v.id)).map((v) => (
        <g key={v.id}>
          <circle cx={v.x} cy={v.y} r={v.outer / 2} fill="#C9A227" opacity={0.9} />
          <circle cx={v.x} cy={v.y} r={v.hole / 2} fill="#06100D" />
        </g>
      ))}
      </>
    );
  },
  // the order of the layers is a new array on every render of the canvas: equal by content
  (a, b) =>
    a.scene === b.scene &&
    a.showPours === b.showPours &&
    a.mmPerPx === b.mmPerPx &&
    a.active === b.active &&
    a.tutti === b.tutti &&
    a.xray === b.xray &&
    a.nascosti === b.nascosti &&
    a.drawOrder.join() === b.drawOrder.join(),
);
