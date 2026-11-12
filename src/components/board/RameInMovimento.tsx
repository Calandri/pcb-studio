"use client";

import { memo, useSyncExternalStore } from "react";
import type { StatoDelGesto } from "@/lib/spinta/gesto-tipi";
import type { GestoVivo, RameInAttesa } from "./gesto-del-rame";
import { LABEL_FONT, LABEL_METRICS, labelSize } from "./net-labels";
import { LAYER_COLOR, type LayerId } from "./render";
import { opacitaStrato, stratoDiRame, type StratoScelto } from "./strati-visibili";

/*
 * THE COPPER OF A GESTURE (a via dragged with its traces, a stretch of a trace
 * slid sideways: see gesto-del-rame.ts), and what stops it. Only this is drawn
 * again while the pointer moves: the still copper leaves the same traces and
 * vias out from the start of the gesture to its end, so its memo holds, and
 * the canvas around is not drawn again either. The gesture in hand is read
 * from its store, not from the props of the canvas.
 */

/** the red of two parts that hit each other in Sposta: what stops a gesture is said in the same colour */
const COLORE_BLOCCO = "#FF4D5E";

/**
 * How strongly a moved stretch is drawn. On the chosen layer, or with "Tutti",
 * like the copper around it. On any other layer at a half, or as much as the
 * x-ray if that is more: with the x-ray at zero the still copper of that layer
 * is not drawn at all, and copper that moved there must be seen all the same.
 */
export function forzaDelRameMosso(l: LayerId, scelto: StratoScelto, xray: number): number {
  return Math.max(0.5, opacitaStrato(l, scelto, xray));
}

interface Vista {
  /** the layers of the board from the bottom up, the chosen one last: the order the still copper is drawn in */
  drawOrder: LayerId[];
  scelto: StratoScelto;
  xray: number;
}

/** the copper of one gesture where it stands: its stretches layer by layer, then its vias, which are on every layer */
const RameDiUnGesto = memo(function RameDiUnGesto({
  rame,
  drawOrder,
  scelto,
  xray,
}: { rame: Pick<StatoDelGesto, "tratti" | "vie"> } & Vista) {
  // a stretch on a layer the board does not declare is drawn all the same, after the others
  const strati = [
    ...new Set([...drawOrder, ...rame.tratti.flatMap((t) => stratoDiRame(t.layer) ?? [])]),
  ];
  return (
    <>
      {strati.map((l) => {
        const suoi = rame.tratti.filter((t) => t.layer === l);
        if (suoi.length === 0) return null;
        return (
          <g key={l} opacity={forzaDelRameMosso(l, scelto, xray)}>
            {suoi.map((t, i) => (
              <line
                key={i}
                x1={t.x1}
                y1={t.y1}
                x2={t.x2}
                y2={t.y2}
                stroke={LAYER_COLOR[l]}
                strokeWidth={t.width}
                strokeLinecap="round"
              />
            ))}
          </g>
        );
      })}
      {/* the same ring and hole as a via of the still copper (RameFermo) */}
      {rame.vie.map((v, i) => (
        <g key={`via-${i}`}>
          <circle cx={v.x} cy={v.y} r={v.outerDiameter / 2} fill="#C9A227" opacity={0.9} />
          <circle cx={v.x} cy={v.y} r={v.holeDiameter / 2} fill="#06100D" />
        </g>
      ))}
    </>
  );
});

/**
 * The moved copper, in board millimetres (inside the flipped group, where the
 * still copper is): the gestures let go and not on the saved board yet, and
 * over them the one in hand.
 */
export function RameInMovimento({
  vivo,
  inAttesa,
  ...vista
}: { vivo: GestoVivo; inAttesa: readonly RameInAttesa[] } & Vista) {
  const { stato } = useSyncExternalStore(vivo.subscribe, vivo.getSnapshot, vivo.getSnapshot);
  if (!stato && inAttesa.length === 0) return null;
  return (
    <g data-rame-in-movimento="" pointerEvents="none">
      {inAttesa.map((g) => (
        <RameDiUnGesto key={g.gesto} rame={g.stato} {...vista} />
      ))}
      {stato && <RameDiUnGesto rame={stato} {...vista} />}
    </g>
  );
}

/**
 * What stops the gesture in hand: a halo on the thing that blocks, and the
 * sentence that names it, next to it. The same sentence box says, for a
 * moment, why something could not be grabbed at all. Drawn over everything, in
 * board millimetres; the sentence in screen pixels, so it reads at any zoom.
 */
export function AvvisoDelGesto({ vivo, mmPerPx }: { vivo: GestoVivo; mmPerPx: number }) {
  const { stato, rifiuto } = useSyncExternalStore(vivo.subscribe, vivo.getSnapshot, vivo.getSnapshot);
  const blocco = stato?.blocco ?? null;
  const frase = blocco?.motivo ?? rifiuto?.frase;
  if (!frase) return null;
  const alone = blocco?.alone;
  // a halo of a few pixels would not be seen from far away
  const raggio = alone ? Math.max(alone.raggioMm, mmPerPx * 6) : 0;
  const dove = alone ? { x: alone.x + raggio, y: alone.y } : (stato?.posizione ?? rifiuto ?? { x: 0, y: 0 });
  const { w, h } = labelSize(frase, "");
  return (
    <g data-blocco-del-gesto="" pointerEvents="none">
      {alone && (
        <circle
          cx={alone.x}
          cy={alone.y}
          r={raggio}
          fill="rgba(255,77,94,0.16)"
          stroke={COLORE_BLOCCO}
          strokeWidth={mmPerPx * 2}
        />
      )}
      {/* flipped back and scaled to pixels: text inside the board's group would be mirrored */}
      <g transform={`translate(${dove.x} ${dove.y}) scale(${mmPerPx} ${-mmPerPx})`}>
        <rect
          x={8}
          y={-h / 2}
          width={w}
          height={h}
          rx={3}
          fill="#0B1110"
          fillOpacity={0.94}
          stroke={COLORE_BLOCCO}
          strokeOpacity={0.65}
          strokeWidth={1}
        />
        <text
          x={8 + w / 2}
          y={-h / 2 + LABEL_METRICS.PAD_Y + LABEL_METRICS.LINE_1 - 3}
          fontSize={LABEL_FONT}
          textAnchor="middle"
          fill={COLORE_BLOCCO}
          fontFamily="var(--font-plex-mono), monospace"
        >
          {frase}
        </text>
      </g>
    </g>
  );
}
