"use client";

import { memo, useId } from "react";
import type { Flessibile } from "@/lib/flex-zone";

/**
 * THE FLEXIBLE PART OF A RIGID-FLEX BOARD, ON THE BOARD (flex.json, see
 * lib/flex.ts): what bends, drawn over the copper so it is read at a glance.
 *
 *  - a flexible zone: a dashed outline, with a veil of the colour of polyimide;
 *  - its windows without copper: a dotted outline;
 *  - its cutouts: the hole, in the colour of what is under the board;
 *  - a bend: the stretch of tail it curves as a band, and its line dash-dot;
 *  - a stiffener: a hatched grey plate with its holes, dimmer on the bottom.
 *
 * It is drawn inside the group that turns millimetres into pixels (y up), and
 * takes no pointer: a part or a trace under it is clicked as before. Nothing
 * for a board with no flexible zone.
 */
const POLIIMMIDE = "#E0A040";
const PIEGA = "#F2F2F2";
const IRRIGIDITORE = "#A8B3C0";

const punti = (p: Array<{ x: number; y: number }>) => p.map((q) => `${q.x},${q.y}`).join(" ");

export const ParteFlessibile = memo(function ParteFlessibile({ flessibile, mmPerPx }: { flessibile: Flessibile | null; mmPerPx: number }) {
  // one pattern per canvas: Guarda and Instrada can both be in the page, and two patterns with one id are one
  const tratteggio = `irrigiditore-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  if (!flessibile) return null;
  const tratto = Math.max(mmPerPx * 1.5, 0.05);
  return (
    <g pointerEvents="none">
      <defs>
        <pattern id={tratteggio} patternUnits="userSpaceOnUse" width={1} height={1} patternTransform="rotate(45)">
          <line x1={0} y1={0} x2={0} y2={1} stroke={IRRIGIDITORE} strokeWidth={0.25} opacity={0.55} />
        </pattern>
      </defs>
      {flessibile.zone.map((z) => (
        <g key={z.id}>
          <polygon
            points={punti(z.punti)}
            fill={POLIIMMIDE}
            fillOpacity={0.1}
            stroke={POLIIMMIDE}
            strokeWidth={tratto}
            strokeDasharray={`${mmPerPx * 8} ${mmPerPx * 5}`}
            strokeLinejoin="round"
          >
            <title>{`zona flessibile «${z.nome}»: rame solo su ${z.strati.join(", ") || "nessuno strato"}`}</title>
          </polygon>
          {z.finestre.map((f, i) => (
            <polygon
              key={`f-${i}`}
              points={punti(f.punti)}
              fill="none"
              stroke={POLIIMMIDE}
              strokeWidth={tratto}
              strokeDasharray={`${mmPerPx * 2} ${mmPerPx * 3}`}
              strokeLinecap="round"
            >
              <title>{`finestra senza rame «${f.nome}»`}</title>
            </polygon>
          ))}
          {z.ritagli.map((r, i) => (
            <polygon key={`r-${i}`} points={punti(r.punti)} fill="#0F0F0F" stroke="#2C4C42" strokeWidth={mmPerPx} strokeLinejoin="round">
              <title>{`ritaglio «${r.nome}»: un foro nella coda`}</title>
            </polygon>
          ))}
        </g>
      ))}
      {flessibile.irrigiditori.map((r) => (
        <g key={r.id} opacity={r.lato === "top" ? 1 : 0.6}>
          <polygon points={punti(r.punti)} fill={`url(#${tratteggio})`} stroke={IRRIGIDITORE} strokeWidth={tratto} strokeLinejoin="round">
            <title>{`irrigiditore «${r.nome}» (${r.lato}): ${r.materiale} ${r.spessoreMm} mm`}</title>
          </polygon>
          {r.fori.map((f, i) => (
            <circle key={i} cx={f.x} cy={f.y} r={f.diametroMm / 2} fill="none" stroke={IRRIGIDITORE} strokeWidth={tratto} />
          ))}
        </g>
      ))}
      {flessibile.pieghe.map((p) => (
        <g key={p.id}>
          {p.mezzaFasciaMm > 0 && <polygon points={punti(p.fascia)} fill={PIEGA} fillOpacity={0.12} />}
          <line
            x1={p.a.x}
            y1={p.a.y}
            x2={p.b.x}
            y2={p.b.y}
            stroke={PIEGA}
            strokeWidth={tratto * 1.3}
            strokeDasharray={`${mmPerPx * 12} ${mmPerPx * 4} ${mmPerPx * 2} ${mmPerPx * 4}`}
          >
            <title>{`piega «${p.nome}»: ${p.angolo}° verso ${p.verso === "su" ? "il top" : "il bottom"}, raggio interno ${p.raggioMm} mm`}</title>
          </line>
        </g>
      ))}
    </g>
  );
});
