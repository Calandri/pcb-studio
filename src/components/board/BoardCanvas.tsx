"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ViewFlags } from "../ViewPresets";
import {
  LAYER_COLOR,
  LAYER_ORDER,
  buildScene,
  type BoardScene,
  type LayerId,
  type Marker,
} from "./render";

/**
 * Visualizzatore della scheda, scritto qui invece di usare quello di
 * @tscircuit/pcb-viewer. Il motivo non e' estetico: quel viewer disegna su
 * canvas e non espone ne' la matrice della camera ne' gli eventi del mouse,
 * quindi era impossibile far comparire la scheda del componente passandoci
 * sopra, mostrare la pasta salda, o mettere un marcatore dove serve.
 *
 * Qui la trasformazione mm -> pixel e' nostra, il disegno e' SVG (quindi ogni
 * elemento e' un nodo con i suoi eventi) e gli strati si accendono uno per uno.
 */
export function BoardCanvas({
  circuitJson,
  flags,
  layer,
  xray = 0,
  markers = [],
  hoveredComponentId,
  onHoverComponent,
  onPickComponent,
}: {
  circuitJson: unknown[] | null;
  flags: ViewFlags;
  /** strato in primo piano: gli altri restano visibili ma smorzati */
  layer: string;
  /** 0-100: quanto si vedono gli strati che non sono in primo piano */
  xray?: number;
  markers?: Marker[];
  hoveredComponentId?: string | null;
  onHoverComponent?: (id: string | null) => void;
  onPickComponent?: (id: string) => void;
}) {
  const scene = useMemo(() => buildScene(circuitJson), [circuitJson]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [dragging, setDragging] = useState(false);
  const dragFrom = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);

  // --- misura del contenitore: la scala si calcola in pixel veri
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

  // si inquadra la scheda quando cambia progetto o quando cambia il riquadro
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
      // il punto sotto il cursore resta fermo
      return {
        k,
        x: px - ((px - v.x) * k) / v.k,
        y: py - ((py - v.y) * k) / v.k,
      };
    });
  }, []);

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      const rect = wrapRef.current?.getBoundingClientRect();
      if (!rect) return;
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.exp(-e.deltaY / 400));
    },
    [zoomAt],
  );

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
  // gli strati che non sono in primo piano si vedono in trasparenza: la
  // radiografia decide quanto
  const layerOpacity = (l: LayerId) => (l === active ? 1 : 0.18 + (xray / 100) * 0.6);

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
      onWheel={onWheel}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        setDragging(true);
        dragFrom.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
        (e.target as Element).setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!dragging || !dragFrom.current) return;
        const d = dragFrom.current;
        setView((v) => ({ ...v, x: d.vx + (e.clientX - d.x), y: d.vy + (e.clientY - d.y) }));
      }}
      onPointerUp={() => {
        setDragging(false);
        dragFrom.current = null;
      }}
      style={{ cursor: dragging ? "grabbing" : "grab" }}
    >
      <svg width={size.w} height={size.h} className="block">
        {/* mm -> pixel, con la y verso l'alto come nel disegno tecnico */}
        <g transform={`translate(${view.x} ${view.y}) scale(${view.k} ${-view.k})`}>
          {/* la scheda */}
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

          {/* piani di rame, dal fondo verso l'alto */}
          {showPours &&
            usedLayers.map((l) =>
              scene.pours
                .filter((p) => p.layer === l)
                .map((p) => (
                  <path
                    key={p.id}
                    d={p.path}
                    fillRule="evenodd"
                    fill={LAYER_COLOR[l]}
                    opacity={0.16 * layerOpacity(l)}
                  />
                )),
            )}

          {/* piste */}
          {usedLayers.map((l) => (
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

          {/* piazzole */}
          {usedLayers.map((l) => (
            <g key={`pad-${l}`} opacity={layerOpacity(l)}>
              {scene.pads
                .filter((p) => p.layer === l)
                .map((p) =>
                  p.circle ? (
                    <circle key={p.id} cx={p.x} cy={p.y} r={p.w / 2} fill={LAYER_COLOR[l]} />
                  ) : (
                    <rect
                      key={p.id}
                      x={p.x - p.w / 2}
                      y={p.y - p.h / 2}
                      width={p.w}
                      height={p.h}
                      rx={p.radius || 0.05}
                      fill={LAYER_COLOR[l]}
                    />
                  ),
                )}
            </g>
          ))}

          {/* via: anello di rame col foro passante */}
          {scene.vias.map((v) => (
            <g key={v.id}>
              <circle cx={v.x} cy={v.y} r={v.outer / 2} fill="#C9A227" opacity={0.9} />
              <circle cx={v.x} cy={v.y} r={v.hole / 2} fill="#06100D" />
            </g>
          ))}

          {/* fori metallizzati e fori meccanici */}
          {scene.holes.map((h) => (
            <g key={h.id}>
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

          {/* pasta salda: l'apertura dello stencil, piu' piccola del pad */}
          {showPaste &&
            scene.paste.map((p) =>
              p.circle ? (
                <circle
                  key={p.id}
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

          {/* ingombri */}
          {showCourtyards &&
            scene.courtyards.map((c) => (
              <rect
                key={c.id}
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

          {/* serigrafia */}
          {showSilk && (
            <g opacity={0.85}>
              {scene.silkPaths.map((s) => (
                <polyline
                  key={s.id}
                  points={s.points.map((p) => `${p.x},${p.y}`).join(" ")}
                  fill="none"
                  stroke="#D6E8E2"
                  strokeWidth={s.width}
                  strokeLinecap="round"
                />
              ))}
            </g>
          )}

          {/* riquadri invisibili sopra i componenti: sono loro a dare l'hover */}
          {scene.components.map((c) => (
            <rect
              key={c.id}
              x={c.x - c.w / 2}
              y={c.y - c.h / 2}
              width={c.w}
              height={c.h}
              transform={c.rotation ? `rotate(${c.rotation} ${c.x} ${c.y})` : undefined}
              fill={hoveredComponentId === c.id ? "rgba(59,232,176,0.14)" : "transparent"}
              stroke={hoveredComponentId === c.id ? "#3BE8B0" : "transparent"}
              strokeWidth={mmPerPx * 1.5}
              onMouseEnter={() => onHoverComponent?.(c.id)}
              onMouseLeave={() => onHoverComponent?.(null)}
              onClick={() => onPickComponent?.(c.id)}
              style={{ cursor: "pointer" }}
            />
          ))}

          {/* segnalazioni del controllo automatico, dove sono davvero */}
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

        {/* le sigle non vanno specchiate: si disegnano fuori dal gruppo capovolto */}
        {showSilk &&
          scene.silkTexts.map((t) => {
            const px = view.x + t.x * view.k;
            const py = view.y - t.y * view.k;
            const fontPx = t.size * view.k;
            if (fontPx < 5) return null;
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
                transform={t.rotation ? `rotate(${-t.rotation} ${px} ${py})` : undefined}
                style={{ pointerEvents: "none" }}
              >
                {t.text}
              </text>
            );
          })}
      </svg>

      {tip && (
        <div
          className="pointer-events-none absolute z-20 max-w-[280px] rounded-lg border border-[#3E1F1D] bg-[rgba(9,14,13,0.95)] px-2.5 py-1.5 text-[11px] leading-[1.4] text-[#FFB4AB]"
          style={{ left: tip.x + 12, top: tip.y - 8 }}
        >
          {tip.text}
        </div>
      )}

      {/* comandi della vista, come nel mockup */}
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
