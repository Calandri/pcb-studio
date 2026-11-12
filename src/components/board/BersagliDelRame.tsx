"use client";

import { memo, type PointerEvent } from "react";
import type { BersaglioDelRame } from "@/lib/spinta/gesto-tipi";
import type { PuntatoreGiu } from "./gesto-del-rame";
import { stratoDiRame, stratoVisibile, type StratoScelto } from "./strati-visibili";

/*
 * WHAT THE POINTER CAN GRAB OF THE COPPER IN "SPOSTA": one transparent target
 * on every via and on every straight stretch of a trace the solver lists
 * (preseDelRame). By the rule of strati-visibili.ts: a stretch of a layer that
 * is not drawn cannot be grabbed, a via is a through hole and is on every
 * layer.
 *
 * Circles and lines, never rectangles: the transparent rectangles of the
 * canvas are the handles of the parts. Drawn after them, so copper under a
 * part can be grabbed (the vias under a chip), and the part is grabbed
 * anywhere else on its footprint. A target is the copper itself, with a
 * minimum of a few pixels so that a thin trace can be hit: no more, or from
 * far away the targets would cover the parts.
 *
 * Memoized: the canvas is drawn again at every hover and at every frame of a
 * dragged part, and hundreds of targets have nothing to do with that.
 */

/** the least a target measures across, screen pixels */
const PRESA_MINIMA_PX = 5;

export const BersagliDelRame = memo(function BersagliDelRame({
  bersagli,
  scelto,
  xray,
  mmPerPx,
  onPrendi,
}: {
  bersagli: readonly BersaglioDelRame[];
  scelto: StratoScelto;
  xray: number;
  mmPerPx: number;
  onPrendi: (bersaglio: BersaglioDelRame, e: PuntatoreGiu) => void;
}) {
  const minimo = mmPerPx * PRESA_MINIMA_PX;
  const tratto = (b: Extract<BersaglioDelRame, { tipo: "tratto" }>) => (
    <line
      key={`tratto-${b.pcbTraceId}-${b.indice}`}
      data-presa={`tratto:${b.pcbTraceId}:${b.indice}`}
      x1={b.x1}
      y1={b.y1}
      x2={b.x2}
      y2={b.y2}
      stroke="transparent"
      strokeWidth={Math.max(b.width, minimo)}
      strokeLinecap="round"
      // lit under the pointer like a part, with no state of the canvas
      className="hover:stroke-[rgba(59,232,176,0.4)]"
      onPointerDown={(e: PointerEvent<SVGLineElement>) => onPrendi(b, e)}
      style={{ cursor: "move" }}
    />
  );
  const tratti = bersagli.filter((b): b is Extract<BersaglioDelRame, { tipo: "tratto" }> => {
    if (b.tipo !== "tratto") return false;
    const l = stratoDiRame(b.layer);
    return l !== undefined && stratoVisibile(l, scelto, xray);
  });
  return (
    <g data-bersagli-del-rame="">
      {/* the stretches of the chosen layer over the ones that show through, and the vias over every stretch */}
      {tratti.filter((b) => b.layer !== scelto).map(tratto)}
      {tratti.filter((b) => b.layer === scelto).map(tratto)}
      {bersagli.map((b) =>
        b.tipo === "via" ? (
          <circle
            key={`via-${b.pcbViaId}`}
            data-presa={`via:${b.pcbViaId}`}
            cx={b.x}
            cy={b.y}
            r={Math.max(b.outerDiameter, minimo) / 2}
            fill="transparent"
            stroke="transparent"
            strokeWidth={mmPerPx * 1.5}
            className="hover:fill-[rgba(59,232,176,0.14)] hover:stroke-[#3BE8B0]"
            onPointerDown={(e: PointerEvent<SVGCircleElement>) => onPrendi(b, e)}
            style={{ cursor: "move" }}
          />
        ) : null,
      )}
    </g>
  );
});
