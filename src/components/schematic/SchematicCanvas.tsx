"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildSchematicModel, toSchematicY, type SchNode } from "@/lib/schematic-model";
import {
  MAX_QUERY,
  buildIndex,
  describeTarget,
  highlightFor,
  hitTest,
  resolveKey,
  sameTarget,
  searchSchematic,
  sectionList,
  targetBox,
  targetKey,
  viewForBox,
  type SchTarget,
  type SectionEntry,
} from "@/lib/schematic-interaction";
import type { EditEvent } from "@/lib/manual-edits";
import { MarqueeStyle, useCanvasView } from "../canvas-view";
import { isTypingTarget } from "../keyboard";
import { schematicOffsetsFromPending } from "./pending-offsets";
import { HoverCard, SearchBox, SelectionCard, ViewControls } from "./SchematicOverlay";
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
 * SchematicSheet.tsx: here there is only the interaction. What a click or a
 * hover means (hit test, highlight, cards, search) is pure, in
 * lib/schematic-interaction.ts.
 *
 * Shortcuts: / search, Enter next result, Esc clears, F (or 0) fits the
 * sheet, + and - zoom, arrows pan, Z + drag frames an area.
 */

const GRID = 0.2; // pin pitch: the grid that makes sense to snap to
/** below this many pixels a press-and-release is a click, not a pan */
const CLICK_SLOP = 4;
const SEARCH_LIMIT = 50;

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
  selection = null,
  onSelectionChange,
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
  /**
   * Selection shared with the rest of the app (the board view, the URL), as
   * a key: "U3", "U3.REFP", "VREF". A key that is not on the sheet is ignored.
   */
  selection?: string | null;
  /** a person selected something here: the key, and the part it is about */
  onSelectionChange?: (key: string | null, component: string | null) => void;
}) {
  const model = useMemo(() => buildSchematicModel(circuitJson), [circuitJson]);
  const index = useMemo(() => buildIndex(model, circuitJson), [model, circuitJson]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 900, h: 600 });
  /*
   * The selection is kept as its key, not as ids: after a recompile the ids
   * change, the designators and net names do not, and the selection survives.
   * What is under the pointer is a preview of the same highlight, shown only
   * while nothing is selected.
   */
  const [selKey, setSelKey] = useState<string | null>(selection);
  const target = useMemo(() => resolveKey(index, selKey), [index, selKey]);
  const [hover, setHover] = useState<SchTarget | null>(null);
  const highlight = useMemo(() => highlightFor(model, index, target ?? hover), [model, index, target, hover]);
  const hoverInfo = useMemo(() => (hover ? describeTarget(model, index, hover) : null), [model, index, hover]);
  const selInfo = useMemo(() => (target ? describeTarget(model, index, target) : null), [model, index, target]);
  /** what the automatic framing shows: the selection that arrived from outside */
  const [frameSel, setFrameSel] = useState<string | null>(selection);
  const [lastSelection, setLastSelection] = useState(selection);
  // a selection from outside (the board view, a link) replaces ours and is
  // framed; our own selection coming back from the parent changes nothing
  if (lastSelection !== selection) {
    setLastSelection(selection);
    if (selection !== selKey) {
      setSelKey(selection);
      setFrameSel(selection);
    }
  }
  const [query, setQuery] = useState("");
  const results = useMemo(() => searchSchematic(model, index, query, SEARCH_LIMIT), [model, index, query]);
  const [cursorAt, setCursorAt] = useState(-1);
  const [copied, setCopied] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const hoverCardRef = useRef<HTMLDivElement>(null);
  const sections = useMemo(() => sectionList(model), [model]);
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
  /** where the press started, to tell a click from a pan */
  const pressAt = useRef<{ x: number; y: number } | null>(null);
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
  const { view, setView, zoomBy, zoomKey, marquee, marqueeDown, marqueeMove, marqueeUp } = useCanvasView({
    ref: wrapRef,
    min: 4,
    max: 600,
    onFit: () => fitRef.current(),
  });

  const fit = useCallback(() => {
    setFrameSel(null);
    setView(fitView(sheet, size));
  }, [sheet, size, setView]);

  useEffect(() => {
    fitRef.current = fit;
  }, [fit]);

  /** frames a target: the part with some room around it, a net all of it */
  const frameTarget = useCallback(
    (t: SchTarget | null) => {
      const box = t ? targetBox(model, index, t) : null;
      if (box) setView(viewForBox(box, size, { pad: t?.kind === "net" ? 0.6 : 1.2 }));
    },
    [model, index, size, setView],
  );

  /*
   * Automatic framing: the whole sheet, or the selection that came with the
   * link or from the board view. It runs again when the canvas gets its real
   * size (the first one is a guess) and when the drawing changes size.
   */
  const framed = useMemo(() => (frameSel ? resolveKey(index, frameSel) : null), [index, frameSel]);
  const frameKey = framed ? targetKey(index, framed) : "";
  const fitKey = `${sheet.w.toFixed(2)}x${sheet.h.toFixed(2)}-${Math.round(size.w)}x${Math.round(size.h)}|${frameKey}`;
  const lastFit = useRef("");
  useEffect(() => {
    if (lastFit.current === fitKey) return;
    lastFit.current = fitKey;
    const box = framed ? targetBox(model, index, framed) : null;
    if (box) setView(viewForBox(box, size, { pad: framed?.kind === "net" ? 0.6 : 1.2 }));
    else setView(fitView(sheet, size));
  }, [fitKey, framed, model, index, size, sheet, setView]);

  /** a person picked something: it becomes the selection, shared with the app */
  const select = useCallback(
    (t: SchTarget | null) => {
      const key = t ? targetKey(index, t) : null;
      setSelKey(key);
      setFrameSel(null);
      setCopied(false);
      let component: string | null = null;
      if (t && t.kind !== "net") component = index.nodeById.get(t.kind === "node" ? t.id : t.nodeId)?.name ?? null;
      onSelectionChange?.(key, component);
    },
    [index, onSelectionChange],
  );

  // a key that does not exist on this sheet (an old link, a renamed part) is
  // dropped, so the URL and the board view don't keep pointing at nothing
  useEffect(() => {
    if (selection && !resolveKey(index, selection)) onSelectionChange?.(null, null);
  }, [selection, index, onSelectionChange]);

  const goTo = useCallback(
    (i: number) => {
      const r = results[i];
      if (!r) return;
      setCursorAt(i);
      select(r.target);
      setView(viewForBox(r.box, size, { pad: r.kind === "rete" ? 0.6 : 1.2 }));
    },
    [results, select, size, setView],
  );
  const step = useCallback(
    (delta: 1 | -1) => {
      if (results.length === 0) return;
      const from = cursorAt < 0 ? (delta === 1 ? -1 : 0) : cursorAt;
      goTo((from + delta + results.length) % results.length);
    },
    [results.length, cursorAt, goTo],
  );
  const frameSection = useCallback(
    (s: SectionEntry) => setView(viewForBox(s.box, size, { pad: 0.2, margin: 24, maxK: 600 })),
    [size, setView],
  );

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
      if (e.key === "Escape") {
        setLinkFrom(null);
        if (!isTypingTarget(e)) select(null);
        return;
      }
      if (isTypingTarget(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        fit();
      } else if (e.key.startsWith("Arrow")) {
        // the trackpad-less way to move around: a third of the screen, Shift for a full one
        const stepPx = (e.shiftKey ? 0.9 : 0.3) * Math.min(size.w, size.h);
        const d = { ArrowLeft: [stepPx, 0], ArrowRight: [-stepPx, 0], ArrowUp: [0, stepPx], ArrowDown: [0, -stepPx] }[
          e.key
        ];
        if (!d) return;
        e.preventDefault();
        setView((v) => ({ ...v, x: v.x + d[0], y: v.y + d[1] }));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [select, fit, size, setView]);

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
        if (!e.shiftKey) select({ kind: "node", id: node.id });
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
    [movable, toWorld, selected, offsets, onSelect, select],
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
      const world = toWorld(e.clientX, e.clientY);
      if (linkFromRef.current) setCursor(world);
      // the card follows the pointer without re-rendering the sheet: only a
      // change of WHAT is under it goes through state
      const card = hoverCardRef.current;
      const rect = wrapRef.current?.getBoundingClientRect();
      if (card && rect) {
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const flipX = x > rect.width - 300;
        const flipY = y > rect.height - 120;
        card.style.transform = `translate(${flipX ? x - 14 : x + 16}px, ${flipY ? y - 14 : y + 18}px) translate(${flipX ? "-100%" : "0"}, ${flipY ? "-100%" : "0"})`;
      }
      const next = hitTest(model, index, world, view.k, offsets);
      setHover((cur) => (sameTarget(cur, next) ? cur : next));
    },
    [toWorld, snap, marqueeMove, setView, model, index, view.k, offsets],
  );

  const endDrag = useCallback(() => {
    pressAt.current = null;
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

  /** press and release in the same spot: select what is there, or clear */
  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      const at = pressAt.current;
      const click =
        at && Math.hypot(e.clientX - at.x, e.clientY - at.y) < CLICK_SLOP && !drag.current && !linking;
      endDrag();
      if (!click) return;
      const world = toWorld(e.clientX, e.clientY);
      select(hitTest(model, index, world, view.k, offsets));
    },
    [endDrag, linking, toWorld, select, model, index, view.k, offsets],
  );

  const copyLink = useCallback(() => {
    void navigator.clipboard
      ?.writeText(window.location.href)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  }, []);

  const handlers: SheetHandlers = {
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
    // the commands sit beside the canvas, not inside it: the canvas takes the
    // wheel for the zoom, and a list scrolled inside it would zoom the sheet
    <div className="relative h-full w-full">
      <div
        ref={wrapRef}
        className="absolute inset-0 overflow-hidden select-none"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          if (marqueeDown(e.clientX, e.clientY)) return;
          pressAt.current = { x: e.clientX, y: e.clientY };
          if (!linking) {
            setSelected(new Set());
            onSelect?.(null);
          }
          setPanning(true);
          pan.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
        }}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => {
          endDrag();
          setHover(null);
        }}
        style={{
          cursor: dragging || panning ? "grabbing" : movable ? "default" : hover && !linking ? "pointer" : "grab",
        }}
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
          highlight={highlight}
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
        <HoverCard ref={hoverCardRef} info={dragging || panning ? null : hoverInfo} />
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

      <div className="absolute left-4 top-4 z-10 flex flex-col gap-2">
        <SearchBox
          ref={searchRef}
          query={query}
          onQuery={(q) => {
            setQuery(q);
            setCursorAt(-1);
          }}
          results={results}
          cursor={cursorAt}
          onGo={goTo}
          onStep={step}
          onClose={() => searchRef.current?.blur()}
          maxQuery={MAX_QUERY}
          limit={SEARCH_LIMIT}
        />
        {selInfo && target && (
          <SelectionCard
            key={selKey ?? ""}
            info={selInfo}
            onNet={(net) => {
              select({ kind: "net", net });
              frameTarget({ kind: "net", net });
            }}
            onPart={(name) => {
              const t = resolveKey(index, name);
              select(t);
              frameTarget(t);
            }}
            onFrame={() => frameTarget(target)}
            onClear={() => select(null)}
            onCopyLink={copyLink}
            copied={copied}
          />
        )}
      </div>
      <div className="absolute right-4 top-4 z-10">
        <ViewControls
          onZoomIn={() => zoomBy(1.3)}
          onZoomOut={() => zoomBy(1 / 1.3)}
          onFit={fit}
          sections={sections}
          onSection={frameSection}
        />
      </div>
    </div>
  );
}
