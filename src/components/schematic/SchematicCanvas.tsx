"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildSchematicModel,
  toSchematicY,
  type SchNode,
  type SchematicModel,
} from "@/lib/schematic-model";
import type { EditEvent } from "@/lib/manual-edits";
import { MarqueeStyle, useCanvasView } from "../canvas-view";

/**
 * The schematic sheet, drawn here instead of by @tscircuit/schematic-viewer.
 *
 * The tscircuit viewer only draws: its own colors, no multi-selection,
 * no grid snapping, no net highlighting. You can't build an editor on top
 * of it. Here the unit -> pixel transform is ours, every symbol is an SVG
 * node with its own events, and moving a component is a real drag with a
 * live preview.
 *
 * The geometric model lives in lib/schematic-model.ts: here there is only
 * drawing and interaction.
 */

const GRID = 0.2; // pin pitch: the grid that makes sense to snap to

const COLORS = {
  sheet: "#0A121C",
  sheetEdge: "#18222E",
  grid: "#1B2735",
  wire: "#5A6B78",
  power: "#0BA36C",
  outline: "#8FA0AA",
  body: "#101A26",
  name: "#C6D2D8",
  value: "#7C8A94",
  faint: "#3E4A57",
  selected: "#3BE8B0",
};

export function SchematicCanvas({
  circuitJson,
  projectId,
  mode,
  pinnedNames,
  onEditEvent,
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
  /** preview offsets applied, by schematic component id */
  const [offsets, setOffsets] = useState<Record<string, { dx: number; dy: number }>>({});
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

  // Undoing or recompiling clears the preview drags. Fixed during render
  // instead of in an effect: this way the old drawing with the old offsets
  // never shows for a single frame.
  const [lastReset, setLastReset] = useState(resetKey);
  if (lastReset !== resetKey) {
    setLastReset(resetKey);
    setOffsets({});
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

  const fit = useCallback(() => {
    const margin = 40;
    const k = Math.min(
      (size.w - margin * 2) / Math.max(sheet.w, 0.001),
      (size.h - margin * 2) / Math.max(sheet.h, 0.001),
    );
    setView({
      x: size.w / 2 - (sheet.x + sheet.w / 2) * k,
      y: size.h / 2 - (sheet.y + sheet.h / 2) * k,
      k: Math.max(k, 1),
    });
  }, [sheet, size, setView]);

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
        const next: Record<string, { dx: number; dy: number }> = { ...offsets };
        for (const id of drag.current.ids) {
          const base = drag.current.origin[id];
          next[id] = { dx: base.dx + dx, dy: base.dy + dy };
        }
        setOffsets(next);
        return;
      }
      if (pan.current) {
        const p = pan.current;
        setView((v) => ({ ...v, x: p.vx + (e.clientX - p.x), y: p.vy + (e.clientY - p.y) }));
        return;
      }
      if (linkFromRef.current) setCursor(toWorld(e.clientX, e.clientY));
    },
    [toWorld, snap, offsets, marqueeMove, setView],
  );

  const endDrag = useCallback(() => {
    if (marqueeUp()) return;
    const d = drag.current;
    drag.current = null;
    pan.current = null;
    setPanning(false);
    setDragging(false);
    if (!d) return;
    for (const id of d.ids) {
      const node = model.nodes.find((n) => n.id === id);
      const off = offsets[id];
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
  }, [model, offsets, onEditEvent, marqueeUp]);

  if (model.nodes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-faint">
        <span className="dot dot-busy" /> Nessuno schematico compilato.
      </div>
    );
  }

  const px = 1 / view.k; // one pixel in drawing units: strokes always crisp
  const dim = (net: string | null) =>
    hoverNets && (!net || !hoverNets.has(net)) ? 0.12 : 1;
  const lit = (net: string | null) => Boolean(hoverNets && net && hoverNets.has(net));

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
      <svg
        width={size.w}
        height={size.h}
        className="block"
        style={{ fontFamily: "var(--font-mono, 'IBM Plex Mono'), monospace" }}
      >
        <defs>
          <pattern
            id="sch-grid"
            width={1 * view.k}
            height={1 * view.k}
            patternUnits="userSpaceOnUse"
            x={view.x}
            y={view.y}
          >
            <circle cx={0} cy={0} r={0.9} fill={COLORS.grid} />
          </pattern>
        </defs>

        {/* the sheet: frame and grid, like on a technical drawing */}
        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          <rect
            x={sheet.x}
            y={sheet.y}
            width={sheet.w}
            height={sheet.h}
            rx={0.3}
            fill={COLORS.sheet}
            stroke={COLORS.sheetEdge}
            strokeWidth={px}
          />
        </g>
        <rect
          x={sheet.x * view.k + view.x}
          y={sheet.y * view.k + view.y}
          width={sheet.w * view.k}
          height={sheet.h * view.k}
          fill="url(#sch-grid)"
          pointerEvents="none"
        />

        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          {/* dividers and titles of the functional sections */}
          <g stroke={COLORS.sheetEdge} strokeWidth={px} opacity={0.9}>
            {model.dividers.map((d, i) => (
              <line key={i} x1={d.x1} y1={d.y1} x2={d.x2} y2={d.y2} />
            ))}
          </g>
          <g fill={COLORS.faint} pointerEvents="none">
            {model.sectionTitles.map((t, i) => (
              <text key={i} x={t.x} y={t.y} fontSize={0.34} letterSpacing={0.02}>
                {t.text}
              </text>
            ))}
          </g>

          {/* wires: power rails in green, like on a designer's sheet */}
          <g fill="none" strokeLinecap="round" strokeLinejoin="round">
            {model.wires.map((w) => (
              <path
                key={w.id}
                d={w.d}
                stroke={w.power ? COLORS.power : lit(w.net) ? COLORS.selected : COLORS.wire}
                strokeWidth={(lit(w.net) ? 2.6 : w.power ? 1.7 : 1.4) * px}
                opacity={dim(w.net)}
                onPointerEnter={() => {
                  setHoverNets(w.net ? new Set([w.net]) : null);
                  setHoverName(w.net);
                }}
                onPointerLeave={() => {
                  setHoverNets(null);
                  setHoverName(null);
                }}
                onClick={(e) => {
                  if (!linking || !w.declaredAs) return;
                  e.stopPropagation();
                  onUnlink?.(w.declaredAs);
                }}
                style={{ cursor: linking && w.declaredAs ? "pointer" : "crosshair" }}
              >
                {linking && w.declaredAs && <title>{`Togli: ${w.declaredAs}`}</title>}
              </path>
            ))}
          </g>
          <g pointerEvents="none">
            {model.junctions.map((j, i) => (
              <circle
                key={i}
                cx={j.x}
                cy={j.y}
                // the junction between multiple wires is bigger than the
                // attachment to a pin: two different things that must be told apart
                r={(j.isNode ? 3 : 2.2) * px}
                fill={j.power ? COLORS.power : COLORS.wire}
                opacity={dim(j.net)}
              />
            ))}
          </g>

          {/* pins: ALWAYS visible (previously only in link mode). Without the
              attachments the symbol frame looks disconnected from the wires. */}
          <g pointerEvents="none">
            {model.nodes.flatMap((node) =>
              node.ports.map((port) => (
                <circle
                  key={`${node.id}:${port.selector}`}
                  cx={port.x}
                  cy={port.y}
                  r={1.8 * px}
                  fill={port.power ? COLORS.power : COLORS.wire}
                  stroke={COLORS.sheet}
                  strokeWidth={0.6 * px}
                  opacity={dim(port.net)}
                />
              )),
            )}
          </g>

          {/* net labels: rails don't cross the sheet, they get named.
              If the label is far from its pin (auto-label), a dashed line
              reconnects it: otherwise you can't tell where it attaches. */}
          <g pointerEvents="none" fill="none">
            {model.netLabels.map((l, i) => {
              if (!l.net) return null;
              // the column layout already knows which pin it is: no search needed
              let best: { x: number; y: number } | null = l.port ?? null;
              if (!best) {
                let bestD = Infinity;
                for (const node of model.nodes) {
                  for (const port of node.ports) {
                    if (port.net !== l.net) continue;
                    const d = Math.hypot(port.x - l.x, port.y - l.y);
                    if (d < bestD) {
                      bestD = d;
                      best = { x: port.x, y: port.y };
                    }
                  }
                }
                if (!best || bestD < 0.45) return null;
              }
              const dot = l.power ? COLORS.power : COLORS.wire;
              const removable = linking && l.declaredAs && l.declaredAs.length > 0;
              return (
                <g key={i}>
                  <path
                    d={`M${best.x} ${best.y}L${l.x} ${l.y}`}
                    stroke={l.power ? COLORS.power : COLORS.faint}
                    strokeWidth={1 * px}
                    strokeDasharray={`${2.5 * px} ${2 * px}`}
                    opacity={dim(l.net)}
                  />
                  {/* the dot at both ends is the connection point: without it,
                      the dashed line looks like it passes near the pin by chance */}
                  <circle cx={best.x} cy={best.y} r={2.2 * px} fill={dot} opacity={dim(l.net)} />
                  <circle cx={l.x} cy={l.y} r={2.2 * px} fill={dot} opacity={dim(l.net)} />
                  {/* in Link mode the dashed line can be clicked to remove the
                      connection: label-only connections have no wire,
                      this is the only place to grab them */}
                  {removable && (
                    <path
                      d={`M${best.x} ${best.y}L${l.x} ${l.y}`}
                      stroke="transparent"
                      strokeWidth={10 * px}
                      pointerEvents="stroke"
                      style={{ cursor: "pointer" }}
                      onClick={(e) => {
                        e.stopPropagation();
                        for (const d of l.declaredAs ?? []) onUnlink?.(d);
                      }}
                    >
                      <title>{`Togli: ${(l.declaredAs ?? []).join(" · ")}`}</title>
                    </path>
                  )}
                </g>
              );
            })}
          </g>

          {/* links drawn and not yet applied: dashed, because the real
              wire will be drawn by the compiler after the re-routing */}
          <g fill="none" pointerEvents="none">
            {pendingLinks.map((l, i) => (
              <path
                key={i}
                d={`M${l.ax} ${l.ay}L${l.bx} ${l.by}`}
                stroke={COLORS.selected}
                strokeWidth={1.8 * px}
                strokeDasharray={`${6 * px} ${4 * px}`}
              />
            ))}
            {linkFrom && cursor && (
              <path
                d={`M${linkFrom.x} ${linkFrom.y}L${cursor.x} ${cursor.y}`}
                stroke={COLORS.selected}
                strokeWidth={1.6 * px}
                strokeDasharray={`${5 * px} ${4 * px}`}
              />
            )}
          </g>

          {/* net labels: rails don't cross the sheet, they get named */}
          <g pointerEvents="none">
            {model.netLabels.map((l, i) => (
              <text
                key={i}
                // the text doesn't start at the dot: a small gap keeps
                // the first (or last) letter of the label readable
                x={l.x + (l.anchor === "start" ? 0.12 : -0.12)}
                y={l.y + 0.06}
                fontSize={0.2}
                textAnchor={l.anchor}
                fill={l.power ? COLORS.power : COLORS.value}
                opacity={dim(l.net)}
              >
                {l.text}
              </text>
            ))}
          </g>

          {model.nodes.map((node) => {
            const off = offsets[node.id];
            const isSelected = selected.has(node.id);
            const pinned = pinnedNames.has(node.name);
            return (
              <g
                key={node.id}
                opacity={
                  hoverNets && !node.ports.some((p) => lit(p.net)) && hoverName !== node.name
                    ? 0.25
                    : 1
                }
                transform={off ? `translate(${off.dx} ${off.dy})` : undefined}
                onPointerDown={(e) => startDrag(e, node)}
                onPointerEnter={() => {
                  const nets = node.ports
                    .map((p) => p.net)
                    .filter((n): n is string => Boolean(n));
                  setHoverNets(nets.length > 0 ? new Set(nets) : null);
                  setHoverName(node.name);
                }}
                onPointerLeave={() => {
                  setHoverNets(null);
                  setHoverName(null);
                }}
                style={{ cursor: movable ? "move" : "pointer" }}
              >
                {/* grab area: without this you only catch the thin stroke */}
                <rect
                  x={node.bbox.minX - 0.1}
                  y={node.bbox.minY - 0.1}
                  width={node.bbox.maxX - node.bbox.minX + 0.2}
                  height={node.bbox.maxY - node.bbox.minY + 0.2}
                  fill="transparent"
                />
                {node.box && (
                  <rect
                    x={node.box.x}
                    y={node.box.y}
                    width={node.box.w}
                    height={node.box.h}
                    rx={0.12}
                    fill={COLORS.body}
                    stroke={isSelected ? COLORS.selected : COLORS.outline}
                    strokeWidth={(isSelected ? 2.4 : 1.7) * px}
                  />
                )}
                {node.paths.map((p, i) => (
                  <path
                    key={i}
                    d={p.d}
                    fill={p.filled ? COLORS.outline : "none"}
                    stroke={isSelected ? COLORS.selected : COLORS.outline}
                    strokeWidth={(isSelected ? 2.2 : 1.5) * px}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                ))}
                {node.labels.map((l, i) => (
                  <text
                    key={i}
                    x={l.x}
                    y={l.y}
                    fontSize={l.size}
                    textAnchor={l.anchor}
                    fill={l.tone === "name" ? COLORS.name : COLORS.value}
                    fontWeight={l.tone === "name" ? 600 : 400}
                    transform={l.vertical ? `rotate(-90 ${l.x} ${l.y})` : undefined}
                    pointerEvents="none"
                  >
                    {l.text}
                  </text>
                ))}
                {linking &&
                  node.ports.map((port) => {
                    const active = linkFrom?.selector === port.selector;
                    return (
                      <circle
                        key={port.selector}
                        cx={port.x}
                        cy={port.y}
                        r={(active ? 6 : 4) * px}
                        fill={active ? COLORS.selected : COLORS.sheet}
                        stroke={
                          active ? COLORS.selected : port.connected ? COLORS.wire : COLORS.power
                        }
                        strokeWidth={1.6 * px}
                        style={{ cursor: "crosshair" }}
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          // the circle is drawn inside the group translated
                          // by the drag: the link coordinates must live in the
                          // same system, otherwise the rubber band starts from
                          // the pin's old position
                          clickPort({
                            selector: port.selector,
                            x: port.x + (off?.dx ?? 0),
                            y: port.y + (off?.dy ?? 0),
                          });
                        }}
                      >
                        <title>
                          {`${port.selector}${port.net ? ` · ${port.net}` : " · scollegato"}`}
                        </title>
                      </circle>
                    );
                  })}
                {pinned && (
                  <circle
                    cx={node.bbox.maxX + 0.14}
                    cy={node.bbox.minY - 0.02}
                    r={0.09}
                    fill={COLORS.selected}
                    pointerEvents="none"
                  >
                    <title>Posizione fissata a mano</title>
                  </circle>
                )}
              </g>
            );
          })}
        </g>

        {/* title block: project name and sheet, like on a real drawing */}
        <g fill={COLORS.faint} fontSize={11} pointerEvents="none">
          <text x={16} y={size.h - 14}>
            {projectId}
            {model.sectionTitles.length > 0 ? ` · ${model.sectionTitles.length} sezioni` : ""}
          </text>
          <text x={size.w - 16} y={size.h - 14} textAnchor="end">
            {model.nodes.length} componenti · {model.wires.length} collegamenti
          </text>
        </g>
      </svg>

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

/** sheet frame around the drawing, with a generous margin */
function sheetFrame(model: SchematicModel): { x: number; y: number; w: number; h: number } {
  const b = model.bounds;
  const margin = Math.max(1.2, (b.maxX - b.minX) * 0.06);
  return {
    x: b.minX - margin,
    y: b.minY - margin,
    w: Math.max(b.maxX - b.minX + margin * 2, 2),
    h: Math.max(b.maxY - b.minY + margin * 2, 2),
  };
}
