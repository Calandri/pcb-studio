"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ViewFlags } from "../ViewPresets";
import {
  LAYER_COLOR,
  PAD_COLOR,
  LAYER_ORDER,
  buildScene,
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
}

/** standard grid pitches (mil): 0,635 = 25mil, 1,27 = 50mil, 2,54 = 100mil */
const GRID_OPTIONS = [0.25, 0.635, 1.27, 2.54];
const GRID_DEFAULT = 0.635;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const snap = (v: number, on: boolean, grid: number) =>
  on ? r3(Math.round(v / grid) * grid) : r3(v);

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
  ) => void;
  /**
   * The parts held still by hand, by NAME. In move mode they get a mark on the
   * board: knowing which ones an automatic action will not touch is the
   * difference between "it did nothing" and "it did what I asked".
   */
  pinnedNames?: string[];
  /** lets go of a single part: it is the × on its mark */
  onRelease?: (name: string) => void;
}) {
  const scene = useMemo(() => buildScene(circuitJson), [circuitJson]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [dragging, setDragging] = useState(false);
  const dragFrom = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  /** a component drag in progress (position already snapped to the grid) */
  const [compDrag, setCompDrag] = useState<{ id: string; x: number; y: number } | null>(null);
  /** snap pitch, chosen from the standard pitches */
  const [gridMm, setGridMm] = useState(GRID_DEFAULT);
  const compDragFrom = useRef<{
    id: string;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);
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


  // --- container measurement: the scale is computed in real pixels
  useEffect(() => {
    const node = wrapRef.current;
    if (!node) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setSize({ w: width, h: height });
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
    setView({ x: size.w / 2, y: size.h / 2, k: Math.max(k, 0.1) });
  }, [scene, size]);

  // the board is framed when the project changes or when the container changes
  const fitKey = `${scene?.board.width}x${scene?.board.height}-${Math.round(size.w)}x${Math.round(size.h)}`;
  const lastFit = useRef("");
  useEffect(() => {
    if (lastFit.current === fitKey) return;
    lastFit.current = fitKey;
    fit();
  }, [fitKey, fit]);

  const zoomAt = useCallback((px: number, py: number, factor: number) => {
    setView((v) => {
      const k = Math.min(400, Math.max(1, v.k * factor));
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
      if (compDrag?.id === c.id) {
        return { x: compDrag.x, y: compDrag.y, rotation: moveOverrides[c.id]?.rotation ?? c.rotation };
      }
      const o = moveOverrides[c.id];
      return o ? { x: o.x, y: o.y, rotation: o.rotation ?? c.rotation } : c;
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
      if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9 && dRot === 0) return undefined;
      // it turns around the ORIGIN, like the compiler does: see ComponentBox.ox
      return `translate(${dx} ${dy}) rotate(${dRot} ${c.ox} ${c.oy})`;
    },
    [scene, effOf],
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
  const links = useMemo(() => {
    const focus = hoveredComponentId ?? (selectedIds?.length === 1 ? selectedIds[0] : null);
    if (!scene || !focus) return [];

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
      // same pivot as compTx: the origin, not the centre
      const rx = pad.x - c.ox;
      const ry = pad.y - c.oy;
      const cos = Math.cos(giro);
      const sin = Math.sin(giro);
      return {
        x: c.ox + rx * cos - ry * sin + (eff.x - c.x),
        y: c.oy + rx * sin + ry * cos + (eff.y - c.y),
      };
    };

    const mine = scene.pads.filter((p) => p.componentId === focus && p.net);
    if (mine.length === 0) return [];
    const pins = [...new Set(mine.map((p) => p.pin))];
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
      pin: string;
      colore: string;
    }> = [];
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

    for (const pad of mine) {
      const da = posOf(pad);
      const i0 = Math.max(0, pins.indexOf(pad.pin));
      const tinta = `hsl(${Math.round((i0 * 360) / Math.max(1, pins.length))} 85% 62%)`;
      const altri = (perRete.get(pad.net) ?? []).filter((p) => p.id !== pad.id);
      if (altri.length === 0) continue;

      if (altri.length <= 2) {
        let primo = true;
        for (const other of altri) {
          const a = posOf(other);
          out.push({
            tipo: "linea" as const,
            key: `${pad.id}-${other.id}`,
            x1: da.x,
            y1: da.y,
            x2: a.x,
            y2: a.y,
            // the pin name is written once, not on every wire
            pin: primo ? pad.pin : "",
            colore: tinta,
          });
          primo = false;
        }
        continue;
      }

      // many connections: the pads get colored, all with the net tint
      const tintaRete = tintaDiRete(pad.netName || pad.net);
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
          /*
           * The lit pad has to be turned like the pad underneath. Drawn straight
           * over a pad at 45 degrees it is a green square sitting crooked on a
           * diamond, and what it says to whoever is looking is "the rotation is
           * not applied" — which is what it was saying, for real, on the
           * highlight and not on the copper.
           */
          // the pad's own turn PLUS the one in progress: while you rotate a
          // component to see whether its connections improve, the frames that
          // say "these pads are the same node" have to turn with the copper
          rot: p.rot + giroDi(p.componentId),
          // the name is written once per net, not on every lit pad
          pin: p.id === pad.id ? pad.netName || pad.pin : "",
          colore: tintaRete,
        });
      }
    }

    return out;
  }, [scene, hoveredComponentId, selectedIds, effOf]);

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
      const rx = c.ox + (x - c.ox) * Math.cos(rad) - (y - c.oy) * Math.sin(rad);
      const ry = c.oy + (x - c.ox) * Math.sin(rad) + (y - c.oy) * Math.cos(rad);
      return { x: rx + (eff.x - c.x), y: ry + (eff.y - c.y), dRot };
    },
    [scene, effOf],
  );

  /*
   * Keyboard, in move mode: the arrows move the selected component
   * by one grid pitch (Shift = fine pitch), R rotates it by 90° counter-
   * clockwise (Shift+R = clockwise), Esc deselects it. Every keypress is a
   * pending edit, like a drag: everything is applied at once.
   */
  useEffect(() => {
    if (mode !== "move" || !scene) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA)$/.test(t.tagName)) return;
      if (e.key === "Escape") {
        onPickComponent?.(null);
        return;
      }
      const comp = pickedId ? scene.components.find((c) => c.id === pickedId) : null;
      if (!comp) return;
      const cur = effOf(comp);
      const from = { x: cur.x, y: cur.y };
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
      if (e.key === "r" || e.key === "R") {
        e.preventDefault();
        e.stopPropagation();
        // shift turns the other way: Shift+r arrives as "R"
        const delta = e.shiftKey || e.key === "R" ? -90 : 90;
        const rotation = (((cur.rotation + delta) % 360) + 360) % 360;
        onMoveComponent?.(comp.id, from, from, rotation);
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
      onMoveComponent?.(
        comp.id,
        from,
        { x: snap(cur.x + d.dx, true, gridMm), y: snap(cur.y + d.dy, true, gridMm) },
        cur.rotation,
      );
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, scene, pickedId, effOf, onMoveComponent, onPickComponent, gridMm]);

  if (!scene) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-faint">
        <span className="dot dot-busy" /> Nessuna scheda compilata.
      </div>
    );
  }

  const active = (layer === "top" || layer === "bottom" || layer === "inner1" || layer === "inner2"
    ? layer
    : "top") as LayerId;
  const usedLayers = LAYER_ORDER.filter(
    (l) => scene.board.layers >= 4 || l === "top" || l === "bottom",
  );
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
  const layerOpacity = (l: LayerId) => (l === active ? 1 : (xray / 100) * 0.75);

  const mmPerPx = 1 / view.k;
  const showSilk = flags.is_showing_silkscreen;
  const showMask = flags.is_showing_solder_mask;
  const showPours = flags.is_showing_copper_pours;
  const showCourtyards = flags.is_showing_courtyards;
  const showErrors = flags.is_showing_drc_errors;
  const showPaste = flags.is_showing_paste_mask;

  return (
    <div
      ref={wrapRef}
      className="relative h-full w-full overflow-hidden select-none"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const rect = wrapRef.current?.getBoundingClientRect();
        /*
         * In select mode the drag draws a box instead of
         * panning the view: it is the gesture everyone expects when something must
         * be chosen. The view still pans while holding Alt, so you are not
         * trapped in the framing while selecting.
         */
        if (selectMode !== "off" && rect && !e.altKey) {
          marqueeAdd.current = e.shiftKey;
          const x = e.clientX - rect.left;
          const y = e.clientY - rect.top;
          setMarquee({ x0: x, y0: y, x1: x, y1: y });
          (e.target as Element).setPointerCapture?.(e.pointerId);
          return;
        }
        setDragging(true);
        dragFrom.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
        (e.target as Element).setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={(e) => {
        // a component in hand follows the cursor, snapped to the grid
        if (compDragFrom.current) {
          const rect = wrapRef.current?.getBoundingClientRect();
          if (!rect) return;
          const p = toMm(e.clientX - rect.left, e.clientY - rect.top);
          const d = compDragFrom.current;
          setCompDrag({
            id: d.id,
            x: snap(d.origX + (p.x - d.startX), !e.altKey, gridMm),
            y: snap(d.origY + (p.y - d.startY), !e.altKey, gridMm),
          });
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
        if (!dragging || !dragFrom.current) return;
        const d = dragFrom.current;
        setView((v) => ({ ...v, x: d.vx + (e.clientX - d.x), y: d.vy + (e.clientY - d.y) }));
      }}
      onPointerUp={(e) => {
        // the component is dropped here: it becomes a pending edit
        if (compDragFrom.current && compDrag) {
          const d = compDragFrom.current;
          compDragFrom.current = null;
          const dropped = compDrag;
          setCompDrag(null);
          if (dropped.x !== d.origX || dropped.y !== d.origY) {
            // the rotation travels with the drag too: see the arrows above
            const comp = scene?.components.find((x) => x.id === dropped.id);
            onMoveComponent?.(
              dropped.id,
              { x: d.origX, y: d.origY },
              { x: dropped.x, y: dropped.y },
              comp ? effOf(comp).rotation : undefined,
            );
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
          if (box && !tiny) {
            if (selectMode === "zone") {
              onZoneChange?.(box);
            } else if (selectMode === "components") {
              const inside = scene.components
                .filter(
                  (c) =>
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
        // empty click in move mode (not a drag): deselect
        if (mode === "move" && dragFrom.current) {
          const moved = Math.hypot(e.clientX - dragFrom.current.x, e.clientY - dragFrom.current.y);
          if (moved < 4) onPickComponent?.(null);
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
          {/* the board */}
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

          {/* copper planes, from bottom to top */}
          {showPours &&
            drawOrder.map((l) =>
              scene.pours
                .filter((p) => p.layer === l)
                .map((p) => (
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
                    strokeOpacity={l === active ? 0.85 : (xray / 100) * 0.7}
                    opacity={l === active ? 0.45 : (xray / 100) * 0.45}
                  />
                )),
            )}

          {/* traces */}
          {drawOrder.map((l) => (
            <g key={`tr-${l}`} opacity={layerOpacity(l)}>
              {scene.traces
                .filter((t) => t.layer === l && t.points.length > 1)
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
          {scene.vias.map((v) => (
            <g key={v.id}>
              <circle cx={v.x} cy={v.y} r={v.outer / 2} fill="#C9A227" opacity={0.9} />
              <circle cx={v.x} cy={v.y} r={v.hole / 2} fill="#06100D" />
            </g>
          ))}

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
          {showMask && (
            <rect
              x={scene.board.centerX - scene.board.width / 2}
              y={scene.board.centerY - scene.board.height / 2}
              width={scene.board.width}
              height={scene.board.height}
              rx={0.6}
              fill="#0E5E43"
              opacity={0.93}
            />
          )}

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
                  .filter((p) => p.layer === l && p.maskMargin > 0)
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
                .filter((p) => p.layer === l)
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
                    {l.pin && (
                      <text
                        transform={`translate(${l.x1} ${l.y1 + 0.62}) scale(1 -1)`}
                        fontSize={0.34}
                        textAnchor="middle"
                        fill={l.colore}
                        opacity={0.9}
                        style={{ paintOrder: "stroke", stroke: "#0B1110", strokeWidth: 0.14 }}
                      >
                        {l.pin}
                      </text>
                    )}
                  </g>
                ) : (
                  <g key={l.key}>
                    <line
                      x1={l.x1}
                      y1={l.y1}
                      x2={l.x2}
                      y2={l.y2}
                      stroke={l.colore}
                      strokeWidth={0.08}
                      strokeDasharray="0.4 0.25"
                      opacity={0.85}
                    />
                    <circle cx={l.x1} cy={l.y1} r={0.16} fill={l.colore} />
                    <circle cx={l.x2} cy={l.y2} r={0.11} fill={l.colore} opacity={0.75} />
                    {l.pin && (
                      /*
                       * The view flips the vertical axis: without flipping it
                       * back the text reads mirrored and upside down.
                       */
                      <text
                        transform={`translate(${l.x1} ${l.y1 + 0.62}) scale(1 -1)`}
                        fontSize={0.34}
                        textAnchor="middle"
                        fill={l.colore}
                        opacity={0.9}
                        style={{ paintOrder: "stroke", stroke: "#0B1110", strokeWidth: 0.14 }}
                      >
                        {l.pin}
                      </text>
                    )}
                  </g>
                ),
              )}
            </g>
          )}


          {/* plated holes and mechanical holes */}
          {scene.holes.map((h) => (
            <g key={h.id} transform={compTx(h.componentId)}>
              {h.rect && h.padW > 0 ? (
                <rect
                  x={h.x - h.padW / 2}
                  y={h.y - h.padH / 2}
                  width={h.padW}
                  height={h.padH}
                  fill="#E8A33C"
                />
              ) : (
                <circle cx={h.x} cy={h.y} r={h.outer / 2} fill="#E8A33C" />
              )}
              <circle cx={h.x} cy={h.y} r={h.hole / 2} fill="#06100D" />
            </g>
          ))}

          {/* solder paste: the stencil opening, smaller than the pad */}
          {showPaste &&
            scene.paste.map((p) =>
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

          {/*
            The parts you are holding still, in move mode: a small ring with a
            cross, drawn on their origin. Whoever moves things has to know which
            ones an automatic arrangement will not touch, otherwise "rearrange"
            looks like it did nothing. Clicking the mark lets that part go.
          */}
          {mode === "move" &&
            fermi.size > 0 &&
            scene.components
              .filter((c) => fermi.has(c.name))
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

          {/* courtyards */}
          {showCourtyards &&
            scene.courtyards.map((c) => (
              <rect
                key={c.id}
                transform={componi(
                  compTx(c.componentId),
                  c.rot ? `rotate(${c.rot} ${c.x} ${c.y})` : null,
                )}
                x={c.x - c.w / 2}
                y={c.y - c.h / 2}
                width={c.w}
                height={c.h}
                fill="none"
                stroke="#FF6B5A"
                strokeWidth={mmPerPx}
                strokeDasharray={`${mmPerPx * 4} ${mmPerPx * 3}`}
                opacity={0.7}
              />
            ))}

          {/* silkscreen: only the side being looked at, dimmed when
              working on an inner plane (where it has nothing to do) */}
          {showSilk && (
            <g opacity={active === "top" || active === "bottom" ? 0.85 : 0.25}>
              {scene.silkPaths
                .filter((p) => p.layer === (active === "bottom" ? "bottom" : "top"))
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

          {/* invisible rectangles over the components: they provide the hover,
              and in move mode they are the handle to drag them */}
          {scene.components.map((c) => {
            const p = effOf(c);
            const isSelected = selected.has(c.id) || pickedId === c.id;
            const isHovered = hoveredComponentId === c.id;
            const isDragging = compDrag?.id === c.id;
            const isMoved = Boolean(moveOverrides[c.id]);
            return (
              <rect
                key={c.id}
                x={p.x - c.w / 2}
                y={p.y - c.h / 2}
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
                  // the component is grabbed here: the view must NOT start
                  e.stopPropagation();
                  const rect = wrapRef.current?.getBoundingClientRect();
                  if (!rect) return;
                  const at = toMm(e.clientX - rect.left, e.clientY - rect.top);
                  compDragFrom.current = {
                    id: c.id,
                    startX: at.x,
                    startY: at.y,
                    origX: p.x,
                    origY: p.y,
                  };
                  setCompDrag({ id: c.id, x: p.x, y: p.y });
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

          {/* automatic-check markers, where they really are */}
          {showErrors &&
            markers.map((m) => (
              <g
                key={m.id}
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
            ))}
        </g>

        {/* designators must not be mirrored: they are drawn outside the flipped group */}
        {showSilk &&
          scene.silkTexts
            /*
             * Only the side being looked at, like the silkscreen lines right
             * above. Without the filter you read the 91 references printed on
             * the underside while looking at the component side, mixed in with
             * the 116 that are really there: the traces of the wrong side
             * disappear correctly and their labels stay.
             */
            .filter((t) => t.layer === (active === "bottom" ? "bottom" : "top"))
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

      <div className="pointer-events-none absolute bottom-[18px] left-1/2 -translate-x-1/2 font-mono text-[10px] text-[#4E625C]">
        {Math.round(view.k)} px/mm
      </div>

      {/* the move-mode controls: above the "Ricalcola massa" button,
          which occupies the bottom-left corner */}
      {mode === "move" && (
        <div className="absolute bottom-[64px] left-[18px] max-w-[480px] rounded-[9px] border border-[#1F2C29] bg-[rgba(9,14,13,0.9)] px-3 py-1.5 text-[11px] leading-relaxed text-muted backdrop-blur">
          {pickedId ? (
            <span className="text-brand">componente selezionato</span>
          ) : (
            "Trascina un componente per spostarlo."
          )}
          <span className="ml-2 text-faint">
            Alt = niente snap · frecce muovono (Shift = 0,1 mm) · R ruota 90°, ⇧R −90° · Esc
            deseleziona
          </span>
          <span className="mt-1 flex items-center gap-1">
            <span className="text-faint">griglia</span>
            {GRID_OPTIONS.map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => setGridMm(g)}
                className={`rounded border px-1.5 py-px font-mono text-[10px] transition-colors ${
                  gridMm === g
                    ? "border-brand/50 bg-brand-wash text-brand"
                    : "border-[#1F2C29] text-faint hover:text-muted"
                }`}
              >
                {String(g).replace(".", ",")}
              </button>
            ))}
            <span className="text-faint">mm</span>
          </span>
        </div>
      )}
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
