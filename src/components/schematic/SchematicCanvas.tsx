"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildSchematicModel, toSchematicY, type SchNode } from "@/lib/schematic-model";
import type { EditEvent } from "@/lib/manual-edits";
import { MarqueeStyle, useCanvasView } from "../canvas-view";
import { schematicOffsetsFromPending } from "./pending-offsets";
import { SchematicSheet, fitView, sheetFrame, type SheetHandlers } from "./SchematicSheet";

/**
 * The schematic sheet, drawn here instead of by @tscircuit/schematic-viewer.
 *
 * The tscircuit viewer only draws: its own colors, no multi-selection,
 * no grid snapping, no net highlighting. You can't build an editor on top
 * of it. Here the unit -> pixel transform is ours, every symbol is an SVG
 * node with its own events, and moving a component is a real drag with a
 * live preview.
 *
 * The geometric model lives in lib/schematic-model.ts, the drawing in
 * SchematicSheet.tsx: here there is only the interaction.
 */

const GRID = 0.2; // pin pitch: the grid that makes sense to snap to

/** stable default: a fresh [] at every render would recompute the offsets each time */
const NO_EVENTS: EditEvent[] = [];

export function SchematicCanvas({
  circuitJson,
  projectId,
  mode,
  pinnedNames,
  onEditEvent,
  pendingEvents = NO_EVENTS,
  resetKey = 0,
  onSelect,
  pendingLinks = [],
  onLink,
  onUnlink,
}: {
  circuitJson: unknown[] | null;
  projectId: string;
  /** view = look only, move = drag the symbols, link = connect the pins */
  mode: "view" | "move" | "route" | "link";
  /** components already pinned by hand: they are shown, otherwise you can't tell what is locked */
  pinnedNames: Set<string>;
  onEditEvent: (event: EditEvent) => void;
  /** the moves not yet applied: the symbols are drawn where they say */
  pendingEvents?: EditEvent[];
  /** changes to undo: clears drags not yet saved */
  resetKey?: number;
  onSelect?: (name: string | null) => void;
  /** links drawn but not yet applied, rendered dashed */
  pendingLinks?: Array<{ from: string; to: string; ax: number; ay: number; bx: number; by: number }>;
  onLink?: (link: { from: string; to: string; ax: number; ay: number; bx: number; by: number }) => void;
  onUnlink?: (declared: string) => void;
}) {
  const model = useMemo(() => buildSchematicModel(circuitJson), [circuitJson]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 900, h: 600 });
  /*
   * Nets lit up on mouse hover. It is a set and not a single net because
   * hovering over a COMPONENT also highlights, and a component touches many
   * nets: "what is connected to what" is answered by lighting up everything
   * the part you are looking at touches, not one wire at a time.
   */
  const [hoverNets, setHoverNets] = useState<Set<string> | null>(null);
  const [hoverName, setHoverName] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /*
   * Preview offsets, by schematic component id: the pending moves (derived,
   * see pending-offsets.ts) plus the drag in progress, which is the only thing
   * this canvas holds on its own.
   */
  const [dragOffsets, setDragOffsets] = useState<Record<string, { dx: number; dy: number }>>({});
  const committedOffsets = useMemo(
    () => schematicOffsetsFromPending(model.nodes, pendingEvents),
    [model, pendingEvents],
  );
  const offsets = useMemo(
    () => ({ ...committedOffsets, ...dragOffsets }),
    [committedOffsets, dragOffsets],
  );
  const [snap, setSnap] = useState(true);
  const pan = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const drag = useRef<{
    ids: string[];
    startX: number;
    startY: number;
    origin: Record<string, { dx: number; dy: number }>;
  } | null>(null);
  const [panning, setPanning] = useState(false);
  const [dragging, setDragging] = useState(false);
  /** first pin already picked: the second click closes the link */
  const [linkFrom, setLinkFrom] = useState<{ selector: string; x: number; y: number } | null>(null);
  /** mouse position in drawing units, for the link rubber band */
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);

  // Undoing or recompiling clears a drag left half-way. Fixed during render
  // instead of in an effect: this way the old drawing with the old offsets
  // never shows for a single frame. The pending moves need no reset: they
  // follow the pending list by themselves.
  const [lastReset, setLastReset] = useState(resetKey);
  if (lastReset !== resetKey) {
    setLastReset(resetKey);
    setDragOffsets({});
  }

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

  // the move handler must not change identity on every click: the link's
  // starting position goes through a ref
  const linkFromRef = useRef<typeof linkFrom>(null);
  useEffect(() => {
    linkFromRef.current = linkFrom;
  }, [linkFrom]);

  const sheet = useMemo(() => sheetFrame(model), [model]);

  const fitRef = useRef<() => void>(() => {});
  const { view, setView, zoomKey, marquee, marqueeDown, marqueeMove, marqueeUp } = useCanvasView({
    ref: wrapRef,
    min: 4,
    max: 600,
    onFit: () => fitRef.current(),
  });

  const fit = useCallback(() => setView(fitView(sheet, size)), [sheet, size, setView]);

  useEffect(() => {
    fitRef.current = fit;
  }, [fit]);
  const fitKey = `${sheet.w.toFixed(2)}x${sheet.h.toFixed(2)}-${Math.round(size.w)}x${Math.round(size.h)}`;
  const lastFit = useRef("");
  useEffect(() => {
    if (lastFit.current === fitKey) return;
    lastFit.current = fitKey;
    fit();
  }, [fitKey, fit]);

  const toWorld = useCallback(
    (clientX: number, clientY: number) => {
      const rect = wrapRef.current?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      return {
        x: (clientX - rect.left - view.x) / view.k,
        y: (clientY - rect.top - view.y) / view.k,
      };
    },
    [view],
  );


  // Alt keeps the movement free: snapping to the grid is right by default,
  // but on a symbol already off-grid it would prevent aligning it by eye
  useEffect(() => {
    const set = (e: KeyboardEvent) => setSnap(!e.altKey);
    window.addEventListener("keydown", set);
    window.addEventListener("keyup", set);
    return () => {
      window.removeEventListener("keydown", set);
      window.removeEventListener("keyup", set);
    };
  }, []);

  const movable = mode === "move";
  const linking = mode === "link";

  // leaving the mode or changing the drawing leaves a link half-done:
  // the first picked pin must be forgotten, otherwise the next click
  // would close a wire the user doesn't remember starting
  const [lastMode, setLastMode] = useState(mode);
  if (lastMode !== mode) {
    setLastMode(mode);
    setLinkFrom(null);
  }

  const clickPort = useCallback(
    (port: { selector: string; x: number; y: number }) => {
      if (!linking) return;
      if (!linkFrom) {
        setLinkFrom(port);
        return;
      }
      if (linkFrom.selector === port.selector) {
        setLinkFrom(null);
        return;
      }
      onLink?.({
        from: linkFrom.selector,
        to: port.selector,
        ax: linkFrom.x,
        ay: linkFrom.y,
        bx: port.x,
        by: port.y,
      });
      setLinkFrom(null);
    },
    [linking, linkFrom, onLink],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLinkFrom(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const startDrag = useCallback(
    (e: React.PointerEvent, node: SchNode) => {
      if (!movable) return;
      e.stopPropagation();
      const world = toWorld(e.clientX, e.clientY);
      const ids = selected.has(node.id) ? [...selected] : [node.id];
      if (!selected.has(node.id)) {
        const next = e.shiftKey ? new Set([...selected, node.id]) : new Set([node.id]);
        setSelected(next);
        onSelect?.(node.name);
      }
      drag.current = {
        ids,
        startX: world.x,
        startY: world.y,
        origin: Object.fromEntries(ids.map((id) => [id, offsets[id] ?? { dx: 0, dy: 0 }])),
      };
      setDragging(true);
      (e.target as Element).setPointerCapture?.(e.pointerId);
    },
    [movable, toWorld, selected, offsets, onSelect],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (marqueeMove(e.clientX, e.clientY)) return;
      if (drag.current) {
        const world = toWorld(e.clientX, e.clientY);
        let dx = world.x - drag.current.startX;
        let dy = world.y - drag.current.startY;
        if (snap) {
          dx = Math.round(dx / GRID) * GRID;
          dy = Math.round(dy / GRID) * GRID;
        }
        const next: Record<string, { dx: number; dy: number }> = {};
        for (const id of drag.current.ids) {
          const base = drag.current.origin[id];
          next[id] = { dx: base.dx + dx, dy: base.dy + dy };
        }
        setDragOffsets(next);
        return;
      }
      if (pan.current) {
        const p = pan.current;
        setView((v) => ({ ...v, x: p.vx + (e.clientX - p.x), y: p.vy + (e.clientY - p.y) }));
        return;
      }
      if (linkFromRef.current) setCursor(toWorld(e.clientX, e.clientY));
    },
    [toWorld, snap, marqueeMove, setView],
  );

  const endDrag = useCallback(() => {
    if (marqueeUp()) return;
    const d = drag.current;
    drag.current = null;
    pan.current = null;
    setPanning(false);
    setDragging(false);
    if (!d) return;
    // the drop becomes a pending move, and from there the offset is derived
    setDragOffsets({});
    for (const id of d.ids) {
      const node = model.nodes.find((n) => n.id === id);
      const off = dragOffsets[id];
      if (!node || !off) continue;
      const base = d.origin[id];
      if (Math.abs(off.dx - base.dx) < 1e-6 && Math.abs(off.dy - base.dy) < 1e-6) continue;
      // the event speaks in schematic coordinates: here y goes back to pointing up
      onEditEvent({
        edit_event_type: "edit_schematic_component_location",
        schematic_component_id: id,
        original_center: { x: node.center.x, y: toSchematicY(node.center.y) },
        new_center: {
          x: node.center.x + off.dx,
          y: toSchematicY(node.center.y + off.dy),
        },
      });
    }
  }, [model, dragOffsets, onEditEvent, marqueeUp]);

  const handlers: SheetHandlers = {
    hover: (nets, name) => {
      setHoverNets(nets);
      setHoverName(name);
    },
    nodeDown: startDrag,
    portDown: clickPort,
    unlink: (declared) => onUnlink?.(declared),
  };

  if (model.nodes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-faint">
        <span className="dot dot-busy" /> Nessuno schematico compilato.
      </div>
    );
  }

  return (
    <div
      ref={wrapRef}
      className="relative h-full w-full overflow-hidden select-none"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        if (marqueeDown(e.clientX, e.clientY)) return;
        if (!linking) {
          setSelected(new Set());
          onSelect?.(null);
        }
        setPanning(true);
        pan.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
      }}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerLeave={endDrag}
      style={{ cursor: dragging || panning ? "grabbing" : movable ? "default" : "grab" }}
    >
      <SchematicSheet
        model={model}
        sheet={sheet}
        view={view}
        size={size}
        projectId={projectId}
        offsets={offsets}
        selected={selected}
        pinnedNames={pinnedNames}
        hoverNets={hoverNets}
        hoverName={hoverName}
        linking={linking}
        movable={movable}
        linkFrom={linkFrom}
        cursor={cursor}
        pendingLinks={pendingLinks}
        on={handlers}
      />

      {marquee && <div style={MarqueeStyle(marquee)} />}
      {zoomKey && !marquee && (
        <div className="pointer-events-none absolute right-4 bottom-4 rounded-[9px] border border-[#1F2C29] bg-[rgba(9,14,13,0.92)] px-3 py-1.5 text-[11px] text-brand backdrop-blur">
          trascina per inquadrare un&apos;area
        </div>
      )}
      {hoverName && (
        <div className="pointer-events-none absolute left-4 top-4 rounded-[9px] border border-[#1F2C29] bg-[rgba(9,14,13,0.92)] px-3 py-1.5 backdrop-blur">
          <span className="font-mono text-[11px] text-brand">{hoverName}</span>
          {hoverNets && hoverNets.size > 1 && (
            <span className="ml-2 font-mono text-[10px] text-[#5F726C]">
              {[...hoverNets].slice(0, 6).join(" · ")}
              {hoverNets.size > 6 ? ` +${hoverNets.size - 6}` : ""}
            </span>
          )}
        </div>
      )}
      {movable && (
        <div className="pointer-events-none absolute bottom-4 left-4 rounded-[9px] border border-[#1F2C29] bg-[rgba(9,14,13,0.9)] px-3 py-1.5 text-[11px] text-muted backdrop-blur">
          Griglia {snap ? `${GRID} attiva` : "libera"} · Alt per il movimento libero · Shift per
          selezionare piu&apos; simboli
        </div>
      )}
      {linking && (
        <div className="pointer-events-none absolute bottom-4 left-4 rounded-[9px] border border-[#1F2C29] bg-[rgba(9,14,13,0.9)] px-3 py-1.5 text-[11px] text-muted backdrop-blur">
          {linkFrom ? (
            <>
              Da <span className="font-mono text-brand">{linkFrom.selector}</span> · clicca il
              secondo piedino, Esc per lasciar perdere
            </>
          ) : (
            <>
              Clicca due piedini per collegarli · i cerchi <span className="text-brand">verdi</span>{" "}
              sono piedini ancora scollegati · clicca un filo o un tratteggio per toglierlo
            </>
          )}
        </div>
      )}
    </div>
  );
}
