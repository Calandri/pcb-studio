"use client";

import { memo, useId, useMemo } from "react";
import { mezzoDellaPiega, piegaturaDi, postoDelTestoDellaCoda, testoDellaCoda, testoDellaPiega } from "@/lib/flex-piega";
import type { Flessibile, Punto } from "@/lib/flex-zone";

/**
 * THE FLEXIBLE PART OF A RIGID-FLEX BOARD, ON THE BOARD (flex.json, see
 * lib/flex.ts): what bends, drawn over the copper so it is read at a glance.
 *
 *  - a flexible zone: a dashed outline, with a veil of the colour of polyimide.
 *    Its copper as a grid (`retino`) is not drawn here: it is in the pours,
 *    which are drawn with their holes like every other pour;
 *  - its windows without copper: a dotted outline;
 *  - its cutouts: the hole, in the colour of what is under the board;
 *  - a bend: the stretch of tail it curves as a band, and its line dash-dot;
 *  - a stiffener: a hatched grey plate with its holes, dimmer on the bottom;
 *  - the WORDS that say how the tail is folded, worked out from flex.json
 *    (flex-piega.ts): on each bend line its number, angle and side ("piega 1:
 *    90° verso il top"), and on the tail what the bends make of it together
 *    ("in tutto 180° verso il top, torna sopra la scheda"). Two dashed lines
 *    alone did not say whether the tail turned by 90 or by 180 degrees.
 *
 * It is drawn inside the group that turns millimetres into pixels (y up), and
 * takes no pointer: a part or a trace under it is clicked as before. Nothing
 * for a board with no flexible zone.
 */
const POLIIMMIDE = "#E0A040";
/**
 * On independent flexible layers (pila.flessibili) every sheet has its colour,
 * so two tails lying on top of each other, flat, are told apart: the first is
 * the amber of polyimide, the others cyan, violet and green.
 */
const COLORI_DEI_FOGLI = [POLIIMMIDE, "#4FC3F7", "#C792EA", "#9CCC65"];
const coloreDelFoglio = (flessibile: Flessibile, nome: string | undefined): string => {
  if (!nome) return POLIIMMIDE;
  const i = flessibile.pila?.flessibili?.findIndex((f) => f.nome === nome) ?? -1;
  return COLORI_DEI_FOGLI[Math.max(0, i) % COLORI_DEI_FOGLI.length];
};
const PIEGA = "#F2F2F2";
const IRRIGIDITORE = "#A8B3C0";

const punti = (p: Array<{ x: number; y: number }>) => p.map((q) => `${q.x},${q.y}`).join(" ");

/**
 * Words on the board: the drawing is inside a scale(1,-1) (y up), so the text
 * is turned back upright where it stands, and kept along its line but never
 * upside down. A constant size on screen, with a dark halo so it reads over copper.
 */
function Scritta({ dove, gradi, testo, mmPerPx, colore, peso }: { dove: Punto; gradi: number; testo: string; mmPerPx: number; colore: string; peso: number }) {
  const g = ((gradi % 180) + 180) % 180;
  const dritto = g > 90 ? g - 180 : g;
  return (
    <text
      transform={`translate(${dove.x} ${dove.y}) scale(1 -1) rotate(${-dritto})`}
      textAnchor="middle"
      dominantBaseline="middle"
      fontSize={mmPerPx * 12}
      fontWeight={peso}
      fill={colore}
      stroke="#0B1512"
      strokeWidth={mmPerPx * 3}
      strokeLinejoin="round"
      paintOrder="stroke"
    >
      {testo}
    </text>
  );
}

export const ParteFlessibile = memo(function ParteFlessibile({ flessibile, mmPerPx }: { flessibile: Flessibile | null; mmPerPx: number }) {
  // one pattern per canvas: Guarda and Instrada can both be in the page, and two patterns with one id are one
  const tratteggio = `irrigiditore-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  const piegatura = useMemo(() => (flessibile ? piegaturaDi(flessibile) : null), [flessibile]);
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
        <g key={z.id} data-flessibile={z.flessibile}>
          <polygon
            points={punti(z.punti)}
            fill={coloreDelFoglio(flessibile, z.flessibile)}
            fillOpacity={0.1}
            stroke={coloreDelFoglio(flessibile, z.flessibile)}
            strokeWidth={tratto}
            strokeDasharray={`${mmPerPx * 8} ${mmPerPx * 5}`}
            strokeLinejoin="round"
          >
            <title>
              {`zona flessibile «${z.nome}»${z.flessibile ? ` (strato flessibile «${z.flessibile}»)` : ""}: rame solo su ${z.strati.join(", ") || "nessuno strato"}` +
                (z.retino ? `, a griglia ${z.retino.dove === "tutta" ? "in tutta la zona" : "sulla piega"} (linee ${z.retino.larghezzaMm} mm, passo ${z.retino.passoMm} mm)` : "")}
            </title>
          </polygon>
          {z.finestre.map((f, i) => (
            <polygon
              key={`f-${i}`}
              points={punti(f.punti)}
              fill="none"
              stroke={coloreDelFoglio(flessibile, z.flessibile)}
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
      {piegatura?.code.map((coda) => (
        <g key={`testi-${coda.zona.id}`}>
          {coda.pieghe.map((p) => (
            <Scritta
              key={p.piega.id}
              dove={mezzoDellaPiega(p)}
              gradi={(Math.atan2(p.u.y, p.u.x) * 180) / Math.PI}
              testo={testoDellaPiega(p)}
              mmPerPx={mmPerPx}
              colore={coda.zona.flessibile ? coloreDelFoglio(flessibile, coda.zona.flessibile) : PIEGA}
              peso={600}
            />
          ))}
          <Scritta
            dove={postoDelTestoDellaCoda(coda, mmPerPx * 14)}
            gradi={coda.pieghe[0] ? (Math.atan2(coda.pieghe[0].u.y, coda.pieghe[0].u.x) * 180) / Math.PI : 0}
            testo={testoDellaCoda(coda)}
            mmPerPx={mmPerPx}
            colore={coloreDelFoglio(flessibile, coda.zona.flessibile)}
            peso={500}
          />
        </g>
      ))}
    </g>
  );
});
