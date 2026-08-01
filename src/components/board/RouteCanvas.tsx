"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildRouteModel,
  dirFromPad,
  escapePoint,
  escapePointDir,
  findConnection,
  route45,
  type RoutePad,
} from "@/lib/pcb-route-model";
import type { ManualRoute } from "@/lib/manual-routes";
import { MarqueeStyle, useCanvasView } from "../canvas-view";
import { LAYER_COLOR, PAD_COLOR, LAYER_ORDER, buildScene, type LayerId } from "./render";

/**
 * Manual routing.
 *
 * Replaces the tscircuit viewer in routing mode. That one drew on a canvas,
 * exposed neither the camera nor the events, and above all produced
 * SUGGESTIONS for the autorouter instead of traces: you could not impose a
 * path nor delete one. Here every click adds a real corner, switching
 * layers leaves a via, and the finished path becomes copper that replaces
 * the autorouter's (see lib/manual-routes.ts).
 */

/** pad grab tolerance, in pixels: constant at every zoom level */
const GRAB_PX = 14;

const LAYER_KEYS: Record<string, LayerId> = {
  "1": "top",
  "2": "inner1",
  "3": "inner2",
  "4": "bottom",
};

interface Draft {
  from: RoutePad;
  points: Array<{ x: number; y: number; layer: LayerId }>;
}

export function RouteCanvas({
  circuitJson,
  width,
  pendingRoutes,
  onRoute,
  resetKey = 0,
  projectId,
  onChanged,
}: {
  circuitJson: unknown[] | null;
  /** trace width in mm */
  width: number;
  pendingRoutes: ManualRoute[];
  onRoute: (route: ManualRoute) => void;
  resetKey?: number;
  /** needed to detach an existing trace via the API */
  projectId?: string;
  /** called after the server has removed a trace: reloads the board */
  onChanged?: () => void;
}) {
  const scene = useMemo(() => buildScene(circuitJson), [circuitJson]);
  const model = useMemo(() => buildRouteModel(circuitJson), [circuitJson]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 900, h: 600 });
  const [layer, setLayer] = useState<LayerId>("top");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [hoverPad, setHoverPad] = useState<RoutePad | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /** existing trace selected by click: it can be detached or redrawn */
  const [selectedTrace, setSelectedTrace] = useState<{
    traceId: string;
    connectionName: string | null;
  } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const pan = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const [panning, setPanning] = useState(false);

  const [lastReset, setLastReset] = useState(resetKey);
  if (lastReset !== resetKey) {
    setLastReset(resetKey);
    setDraft(null);
  }

  useEffect(() => {
    const node = wrapRef.current;
    if (!node) return;
    const ro = new ResizeObserver(([e]) => {
      const { width: w, height: h } = e.contentRect;
      if (w > 0 && h > 0) setSize({ w, h });
    });
    ro.observe(node);
    return () => ro.disconnect();
  }, []);

  const fitRef = useRef<() => void>(() => {});
  const { view, setView, zoomKey, marquee, marqueeDown, marqueeMove, marqueeUp } = useCanvasView({
    ref: wrapRef,
    min: 2,
    max: 400,
    onFit: () => fitRef.current(),
  });

  const fit = useCallback(() => {
    if (!scene) return;
    const m = 40;
    const k = Math.min((size.w - m * 2) / scene.board.width, (size.h - m * 2) / scene.board.height);
    setView({ x: size.w / 2, y: size.h / 2, k: Math.max(k, 2) });
  }, [scene, size, setView]);
  useEffect(() => {
    fitRef.current = fit;
  }, [fit]);
  const fitKey = `${scene?.board.width}x${scene?.board.height}-${Math.round(size.w)}x${Math.round(size.h)}`;
  const lastFit = useRef("");
  useEffect(() => {
    if (lastFit.current === fitKey) return;
    lastFit.current = fitKey;
    fit();
  }, [fitKey, fit]);

  /** screen -> millimeters, with y pointing up as in technical drawing */
  const toMm = useCallback(
    (cx: number, cy: number) => {
      const r = wrapRef.current?.getBoundingClientRect();
      if (!r) return { x: 0, y: 0 };
      return { x: (cx - r.left - view.x) / view.k, y: -(cy - r.top - view.y) / view.k };
    },
    [view],
  );

  /*
   * Pad grab in PIXELS, not millimeters. Previously the radius was half the
   * shorter side: on an 0402 that is 0.25mm, i.e. four pixels at normal
   * zoom, and grabbing one meant centering the pad within four pixels.
   * That was the reason behind "it does not snap to the pins". Here the
   * tolerance is always the same on screen, at any zoom level, and the pad
   * can be grabbed from the edge too, because the test is on the rectangle
   * and not on the center.
   */
  const padAt = useCallback(
    (p: { x: number; y: number }): RoutePad | null => {
      const slack = GRAB_PX / view.k;
      let best: RoutePad | null = null;
      let bestD = Infinity;
      for (const pad of model.pads) {
        if (pad.layer !== "all" && pad.layer !== layer) continue;
        /*
         * On a turned pad the point is turned back first: the rectangle is the
         * pad's own, not one drawn along the axes. Without this the sensitive
         * area of a 45 degree pad is a box that covers laminate on two corners
         * and misses copper on the other two.
         */
        let rx = p.x - pad.x;
        let ry = p.y - pad.y;
        if (pad.rot) {
          const a = (-pad.rot * Math.PI) / 180;
          const c = Math.cos(a);
          const s2 = Math.sin(a);
          [rx, ry] = [rx * c - ry * s2, rx * s2 + ry * c];
        }
        const dx = Math.max(0, Math.abs(rx) - pad.hw);
        const dy = Math.max(0, Math.abs(ry) - pad.hh);
        const d = Math.hypot(dx, dy);
        if (d <= slack && d < bestD) { best = pad; bestD = d; }
      }
      return best;
    },
    [model, layer, view.k],
  );

  /** point-to-segment distance, to grab a trace by click */
  const traceAt = useCallback(
    (p: { x: number; y: number }): { traceId: string; connectionName: string | null } | null => {
      if (!scene) return null;
      const slack = GRAB_PX / view.k;
      let best: { traceId: string; connectionName: string | null } | null = null;
      let bestD = Infinity;
      for (const t of scene.traces) {
        if (!t.traceId) continue;
        for (let i = 0; i + 1 < t.points.length; i++) {
          const a = t.points[i];
          const b = t.points[i + 1];
          const abx = b.x - a.x;
          const aby = b.y - a.y;
          const len2 = abx * abx + aby * aby || 1e-9;
          const tt = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2));
          const d = Math.hypot(p.x - (a.x + tt * abx), p.y - (a.y + tt * aby));
          const tol = Math.max(slack, t.width / 2 + 0.1);
          if (d <= tol && d < bestD) {
            bestD = d;
            best = { traceId: t.traceId, connectionName: t.connectionName };
          }
        }
      }
      return best;
    },
    [scene, view.k],
  );

  /** detaches the selected trace: the connection is left open */
  const deleteSelected = useCallback(
    async (redraw: boolean) => {
      if (!selectedTrace || !projectId || deleting) return;
      setDeleting(true);
      try {
        const r = await fetch("/api/trace", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectId, pcbTraceId: selectedTrace.traceId, action: "delete" }),
        }).then((res) => res.json());
        if (!r?.ok) {
          setNote(`non riesco a staccarla: ${r?.error ?? "errore"}`);
          return;
        }
        const name = selectedTrace.connectionName;
        setSelectedTrace(null);
        if (redraw && name) {
          // restart from the first pad of the connection just detached
          const conn = model.connections.find((c) => c.name === name);
          const pad = conn
            ? model.pads.find((p) => conn.sourcePortIds.includes(p.sourcePortId))
            : null;
          if (pad) {
            const start: LayerId = pad.layer === "all" ? layer : (pad.layer as LayerId);
            setLayer(start);
            const out = escapePoint(pad);
            setDraft({
              from: pad,
              points: [
                { x: pad.x, y: pad.y, layer: start },
                { x: out.x, y: out.y, layer: start },
              ],
            });
            setNote(`ridisegna ${name}: i pad bianchi sono la sua net`);
          } else {
            setNote(`staccata ${name}: ridisegnala partendo da un pad`);
          }
        } else {
          setNote(
            `staccata${name ? ` ${name}` : ""}: il collegamento resta scoperto — ridisegnala o ricompila`,
          );
        }
        onChanged?.();
      } finally {
        setDeleting(false);
      }
    },
    [selectedTrace, projectId, deleting, model, layer, onChanged],
  );

  /** segment preview: two 0/45/90 segments that REACH the cursor */
  const tip = useMemo(() => {
    if (!draft || !cursor) return null;
    const last = draft.points[draft.points.length - 1];
    const target = hoverPad ? { x: hoverPad.x, y: hoverPad.y } : cursor;
    return route45(last, target);
  }, [draft, cursor, hoverPad]);

  const finish = useCallback(
    (pad: RoutePad) => {
      if (!draft) return;
      const conn = findConnection(model, draft.from, pad);
      if (!conn) {
        setNote(`${draft.from.label} e ${pad.label} non sono sulla stessa net: non c'e' niente da collegare`);
        return;
      }
      /*
       * You land on the pad from the side you ARRIVE from, straight on: the
       * house rule wants the first segment on-axis, not a specific side.
       * Previously you always entered from the front (away from the body),
       * and absurd detours appeared when the trace arrived from the side.
       */
      const last = draft.points[draft.points.length - 1];
      const landing = escapePointDir(pad, dirFromPad(pad, last));
      const points = [
        ...draft.points,
        ...route45(last, landing).map((q) => ({ ...q, layer })),
        { x: pad.x, y: pad.y, layer },
      ];
      onRoute({ connection: conn.name, width, points });
      setDraft(null);
      setNote(`instradato ${conn.name}`);
    },
    [draft, model, layer, width, onRoute],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA)$/.test(t.tagName)) return;
      if (e.key === "Escape") { setDraft(null); setSelectedTrace(null); setNote(null); return; }
      // with a trace selected: Del detaches it, R detaches and redraws it
      if (selectedTrace && !draft) {
        if (e.key === "Backspace" || e.key === "Delete") {
          e.preventDefault();
          void deleteSelected(false);
          return;
        }
        if (e.key === "r" || e.key === "R") {
          e.preventDefault();
          void deleteSelected(true);
          return;
        }
      }
      if (e.key === "Backspace" && draft) {
        e.preventDefault();
        setDraft((d) => (!d || d.points.length <= 1 ? null : { ...d, points: d.points.slice(0, -1) }));
        return;
      }
      const next = LAYER_KEYS[e.key];
      if (!next) return;
      e.preventDefault();
      // changing layer while drawing leaves a via at the current point:
      // it is the only way to get to the other side of the copper
      if (draft && next !== layer) {
        const last = draft.points[draft.points.length - 1];
        setDraft({ ...draft, points: [...draft.points, { x: last.x, y: last.y, layer: next }] });
      }
      setLayer(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [draft, layer, selectedTrace, deleteSelected]);

  if (!scene) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-faint">
        <span className="dot dot-busy" /> Nessuna scheda compilata.
      </div>
    );
  }

  const mm = 1 / view.k;
  const usedLayers = LAYER_ORDER.filter((l) => scene.board.layers >= 4 || l === "top" || l === "bottom");
  const dim = (l: LayerId) => (l === layer ? 1 : 0.16);

  return (
    <div
      ref={wrapRef}
      className="relative h-full w-full overflow-hidden select-none"
      style={{ cursor: draft ? "crosshair" : panning ? "grabbing" : "crosshair" }}
      onPointerDown={(e) => {
        if (marqueeDown(e.clientX, e.clientY)) return;
        if (e.button === 1 || e.button === 2 || e.shiftKey) {
          setPanning(true);
          pan.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
          return;
        }
        if (e.button !== 0) return;
        const p = toMm(e.clientX, e.clientY);
        const pad = padAt(p);
        if (!draft) {
          if (!pad) {
            // no pad: maybe a trace to select, otherwise deselect
            const hit = traceAt(p);
            setSelectedTrace(hit);
            setNote(
              hit
                ? `${hit.connectionName ?? "pista"} selezionata: Canc la stacca, R la ridisegna`
                : "parti da un pad: e' li' che la pista deve attaccarsi",
            );
            return;
          }
          setSelectedTrace(null);
          const start: LayerId = pad.layer === "all" ? layer : (pad.layer as LayerId);
          setLayer(start);
          // you exit the pad straight before you can turn: it is the house rule
          // and the DRC checks it as pin_escape
          const out = escapePoint(pad);
          setDraft({
            from: pad,
            points: [
              { x: pad.x, y: pad.y, layer: start },
              { x: out.x, y: out.y, layer: start },
            ],
          });
          setNote(`da ${pad.label}${pad.net ? ` · ${pad.net}` : ""}`);
          return;
        }
        if (pad && pad.pcbPortId !== draft.from.pcbPortId) { finish(pad); return; }
        const last = draft.points[draft.points.length - 1];
        setDraft({
          ...draft,
          points: [...draft.points, ...route45(last, p).map((q) => ({ ...q, layer }))],
        });
      }}
      onPointerMove={(e) => {
        if (marqueeMove(e.clientX, e.clientY)) return;
        if (pan.current) {
          const d = pan.current;
          setView((v) => ({ ...v, x: d.vx + (e.clientX - d.x), y: d.vy + (e.clientY - d.y) }));
          return;
        }
        const p = toMm(e.clientX, e.clientY);
        // until the first corner exists, the pad exit side follows the
        // cursor: you start in the direction you really want to go
        if (draft && draft.points.length === 2) {
          const dir = dirFromPad(draft.from, p);
          const stub = escapePointDir(draft.from, dir);
          if (stub.x !== draft.points[1].x || stub.y !== draft.points[1].y) {
            setDraft({ ...draft, points: [draft.points[0], { ...stub, layer: draft.points[0].layer }] });
          }
        }
        setCursor(p);
        setHoverPad(padAt(p));
      }}
      onPointerUp={() => { if (marqueeUp()) return; pan.current = null; setPanning(false); }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <svg width={size.w} height={size.h} className="block">
        <g transform={`translate(${view.x} ${view.y}) scale(${view.k} ${-view.k})`}>
          <rect
            x={scene.board.centerX - scene.board.width / 2}
            y={scene.board.centerY - scene.board.height / 2}
            width={scene.board.width}
            height={scene.board.height}
            rx={0.6}
            fill="#0C1A17"
            stroke="#2C4C42"
            strokeWidth={mm}
          />

          {/*
            * Copper pours: they were completely missing here, and routing
            * without seeing the ground plane means not knowing where you
            * are going. They sit below everything and stay discreet, but
            * the pour of the layer you are working on stands out from the
            * others.
            */}
          {scene.pours.map((p) => (
            <path
              key={p.id}
              d={p.path}
              fillRule="evenodd"
              fill={LAYER_COLOR[p.layer]}
              opacity={p.layer === layer ? 0.2 : 0.07}
            />
          ))}

          {usedLayers.map((l) => (
            <g key={l} opacity={dim(l)}>
              {scene.traces.filter((t) => t.layer === l && t.points.length > 1).map((t, i) => (
                <polyline
                  key={i}
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

          {/* the selected trace: shown in full, on all layers */}
          {selectedTrace &&
            scene.traces
              .filter((t) => t.traceId === selectedTrace.traceId && t.points.length > 1)
              .map((t, i) => (
                <polyline
                  key={`sel-${i}`}
                  points={t.points.map((p) => `${p.x},${p.y}`).join(" ")}
                  fill="none"
                  stroke="#FFFFFF"
                  strokeWidth={t.width + 4 * mm}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  opacity={0.75}
                />
              ))}

          {scene.vias.map((v, i) => (
            <circle key={i} cx={v.x} cy={v.y} r={v.outer / 2} fill="#9AA7A3" />
          ))}

          {usedLayers.map((l) => (
            <g key={`p-${l}`} opacity={dim(l)}>
              {scene.pads.filter((p) => p.layer === l).map((p) => (
                p.circle
                  ? <circle key={p.id} cx={p.x} cy={p.y} r={p.w / 2} fill={PAD_COLOR[l]} />
                  : <rect key={p.id} transform={p.rot ? `rotate(${p.rot} ${p.x} ${p.y})` : undefined} x={p.x - p.w / 2} y={p.y - p.h / 2} width={p.w} height={p.h} rx={p.radius} fill={PAD_COLOR[l]} />
              ))}
            </g>
          ))}

          {/* traces already hand-drawn, waiting to be applied */}
          {pendingRoutes.map((r, i) => (
            <polyline
              key={i}
              points={r.points.map((p) => `${p.x},${p.y}`).join(" ")}
              fill="none"
              stroke="#3BE8B0"
              strokeWidth={r.width}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray={`${6 * mm} ${3 * mm}`}
            />
          ))}

          {/* pad under the pointer */}
          {hoverPad && (
            <rect
              // turned like the pad: a straight frame around a diamond leaves
              // its corners outside and says the rotation is not applied
              transform={hoverPad.rot ? `rotate(${hoverPad.rot} ${hoverPad.x} ${hoverPad.y})` : undefined}
              x={hoverPad.x - hoverPad.hw - 0.12}
              y={hoverPad.y - hoverPad.hh - 0.12}
              width={hoverPad.hw * 2 + 0.24}
              height={hoverPad.hh * 2 + 0.24}
              rx={0.08}
              fill="none" stroke="#3BE8B0" strokeWidth={2 * mm}
            />
          )}

          {/* the pads of the SAME net as the starting one, in white: they are
              the only ones the trace can close on, and they must be seen
              immediately instead of discovering it from the error message.
              The comparison is on the connectivity key, which also exists
              for unnamed nets */}
          {draft?.from.netKey &&
            model.pads
              .filter((p) => p.netKey === draft.from.netKey && p.pcbPortId !== draft.from.pcbPortId)
              .map((p) => (
                <rect
                  key={`net-${p.pcbPortId}`}
                  transform={p.rot ? `rotate(${p.rot} ${p.x} ${p.y})` : undefined}
                  x={p.x - p.hw - 0.18}
                  y={p.y - p.hh - 0.18}
                  width={p.hw * 2 + 0.36}
                  height={p.hh * 2 + 0.36}
                  rx={0.08}
                  fill="rgba(255,255,255,0.22)"
                  stroke="#FFFFFF"
                  strokeWidth={2.2 * mm}
                />
              ))}

          {/* the trace in progress */}
          {draft && (
            <>
              <polyline
                points={draft.points.map((p) => `${p.x},${p.y}`).join(" ")}
                fill="none" stroke="#3BE8B0" strokeWidth={width}
                strokeLinecap="round" strokeLinejoin="round"
              />
              {draft.points.map((p, i) => {
                const prev = draft.points[i - 1];
                return prev && prev.layer !== p.layer ? (
                  <circle key={i} cx={p.x} cy={p.y} r={0.3} fill="#EDEFEE" stroke="#3BE8B0" strokeWidth={1.4 * mm} />
                ) : null;
              })}
              {tip && (
                <polyline
                  points={[draft.points[draft.points.length - 1], ...tip]
                    .map((q) => `${q.x},${q.y}`)
                    .join(" ")}
                  fill="none" stroke="#3BE8B0" strokeWidth={width}
                  strokeLinecap="round" strokeLinejoin="round" opacity={0.55}
                />
              )}
            </>
          )}
        </g>
      </svg>

      {marquee && <div style={MarqueeStyle(marquee)} />}
      {zoomKey && !marquee && (
        <div className="pointer-events-none absolute right-4 bottom-4 rounded-[9px] border border-[#1F2C29] bg-[rgba(9,14,13,0.92)] px-3 py-1.5 text-[11px] text-brand backdrop-blur">
          trascina per inquadrare un&apos;area
        </div>
      )}

      <div className="pointer-events-none absolute left-4 top-4 flex items-center gap-2 rounded-[9px] border border-[#1F2C29] bg-[rgba(9,14,13,0.92)] px-3 py-1.5 backdrop-blur">
        <span className="h-2 w-2 rounded-full" style={{ background: LAYER_COLOR[layer] }} />
        <span className="font-mono text-[11px] text-text">{layer}</span>
        <span className="font-mono text-[10px] text-faint">{width} mm</span>
      </div>

      <div className="pointer-events-none absolute bottom-4 left-4 max-w-[520px] rounded-[9px] border border-[#1F2C29] bg-[rgba(9,14,13,0.9)] px-3 py-1.5 text-[11px] leading-relaxed text-muted backdrop-blur">
        {note ? <span className="text-brand">{note}</span> : "Clicca un pad per partire, poi clicca per ogni angolo e chiudi su un altro pad. I pad BIANCHI sono la tua stessa net: la pista puo' chiudere solo li'. Clicca una pista esistente per selezionarla e staccarla (Canc) o ridisegnarla (R)."}
        <span className="ml-2 text-faint">
          1-4 cambia strato e lascia una via · Backspace toglie l&apos;ultimo angolo · Esc annulla ·
          Shift trascina la vista · + e - zoom, 0 inquadra tutto, Z e trascina per un&apos;area
        </span>
      </div>

      {hoverPad && (
        <div className="pointer-events-none absolute right-4 top-4 rounded-[9px] border border-[#1F2C29] bg-[rgba(9,14,13,0.92)] px-3 py-1.5 backdrop-blur">
          <span className="font-mono text-[11px] text-text">{hoverPad.label}</span>
          {hoverPad.net && <span className="ml-2 font-mono text-[10px] text-brand">{hoverPad.net}</span>}
        </div>
      )}
    </div>
  );
}
