"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildSchematicModel,
  toSchematicY,
  type SchNode,
  type SchematicModel,
} from "@/lib/schematic-model";
import type { EditEvent } from "@/lib/manual-edits";

/**
 * Il foglio schematico, disegnato qui invece che da @tscircuit/schematic-viewer.
 *
 * Il viewer di tscircuit disegna e basta: colori suoi, nessuna selezione
 * multipla, nessun aggancio alla griglia, nessuna evidenziazione della net.
 * Sopra non ci si costruisce un editor. Qui la trasformazione unita' -> pixel
 * e' nostra, ogni simbolo e' un nodo SVG con i suoi eventi, e spostare un
 * componente e' un trascinamento vero con anteprima.
 *
 * Il modello geometrico sta in lib/schematic-model.ts: qui c'e' solo il
 * disegno e l'interazione.
 */

const GRID = 0.2; // passo dei piedini: e' la griglia a cui ha senso agganciarsi

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
}: {
  circuitJson: unknown[] | null;
  projectId: string;
  /** view = si guarda e basta, move = si trascinano i simboli */
  mode: "view" | "move" | "route";
  /** componenti gia' fissati a mano: si vedono, altrimenti non si sa cosa e' bloccato */
  pinnedNames: Set<string>;
  onEditEvent: (event: EditEvent) => void;
  /** cambia per annullare: azzera i trascinamenti non ancora salvati */
  resetKey?: number;
  onSelect?: (name: string | null) => void;
}) {
  const model = useMemo(() => buildSchematicModel(circuitJson), [circuitJson]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 900, h: 600 });
  const [view, setView] = useState({ x: 0, y: 0, k: 30 });
  const [hoverNet, setHoverNet] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** spostamenti applicati in anteprima, per id di componente schematico */
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

  // Annullare o ricompilare azzera i trascinamenti in anteprima. Si aggiusta
  // durante il render invece che in un effetto: cosi' non si vede per un
  // fotogramma il disegno vecchio con gli spostamenti vecchi.
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

  const sheet = useMemo(() => sheetFrame(model), [model]);

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
  }, [sheet, size]);

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

  const onWheel = useCallback((e: React.WheelEvent) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const factor = Math.exp(-e.deltaY / 400);
    setView((v) => {
      const k = Math.min(600, Math.max(4, v.k * factor));
      return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k };
    });
  }, []);

  // Alt tiene libero il movimento: agganciare alla griglia e' giusto di default
  // ma su un simbolo gia' fuori passo impedirebbe di allinearlo a occhio
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
      }
    },
    [toWorld, snap, offsets],
  );

  const endDrag = useCallback(() => {
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
      // l'evento parla in coordinate schematiche: qui la y torna verso l'alto
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
  }, [model, offsets, onEditEvent]);

  if (model.nodes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-faint">
        <span className="dot dot-busy" /> Nessuno schematico compilato.
      </div>
    );
  }

  const px = 1 / view.k; // un pixel in unita' di disegno: tratti sempre nitidi
  const dim = (net: string | null) => (hoverNet && net !== hoverNet ? 0.18 : 1);

  return (
    <div
      ref={wrapRef}
      className="relative h-full w-full overflow-hidden select-none"
      onWheel={onWheel}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        setSelected(new Set());
        onSelect?.(null);
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

        {/* il foglio: cornice e griglia, come su un disegno tecnico */}
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
          {/* divisori e titoli delle sezioni funzionali */}
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

          {/* fili: le alimentazioni in verde, come sul foglio di un progettista */}
          <g fill="none" strokeLinecap="round" strokeLinejoin="round">
            {model.wires.map((w) => (
              <path
                key={w.id}
                d={w.d}
                stroke={w.power ? COLORS.power : COLORS.wire}
                strokeWidth={(w.power ? 1.7 : 1.4) * px}
                opacity={dim(w.net)}
                onPointerEnter={() => setHoverNet(w.net)}
                onPointerLeave={() => setHoverNet(null)}
                style={{ cursor: "crosshair" }}
              />
            ))}
          </g>
          <g pointerEvents="none">
            {model.junctions.map((j, i) => (
              <circle
                key={i}
                cx={j.x}
                cy={j.y}
                r={2.6 * px}
                fill={j.power ? COLORS.power : COLORS.wire}
                opacity={dim(j.net)}
              />
            ))}
          </g>

          {/* etichette di net: i rail non attraversano il foglio, si nominano */}
          <g pointerEvents="none">
            {model.netLabels.map((l, i) => (
              <text
                key={i}
                x={l.x}
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
                transform={off ? `translate(${off.dx} ${off.dy})` : undefined}
                onPointerDown={(e) => startDrag(e, node)}
                onPointerEnter={() => setHoverNet(null)}
                style={{ cursor: movable ? "move" : "pointer" }}
              >
                {/* area di presa: senza questa si prende solo il tratto sottile */}
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

        {/* cartiglio: nome del progetto e foglio, come su una tavola vera */}
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

      {hoverNet && (
        <div className="pointer-events-none absolute left-4 top-4 rounded-[9px] border border-[#1F2C29] bg-[rgba(9,14,13,0.92)] px-3 py-1.5 font-mono text-[11px] text-brand backdrop-blur">
          {hoverNet}
        </div>
      )}
      {movable && (
        <div className="pointer-events-none absolute bottom-4 left-4 rounded-[9px] border border-[#1F2C29] bg-[rgba(9,14,13,0.9)] px-3 py-1.5 text-[11px] text-muted backdrop-blur">
          Griglia {snap ? `${GRID} attiva` : "libera"} · Alt per il movimento libero · Shift per
          selezionare piu&apos; simboli
        </div>
      )}
    </div>
  );
}

/** cornice del foglio attorno al disegno, con un margine generoso */
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
