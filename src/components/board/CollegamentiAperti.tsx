"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ViewFlags } from "../ViewPresets";
import { apertiDellaScheda, type CollegamentiAperti, type CollegamentoAperto } from "@/lib/open-connections";

/**
 * THE OPEN CONNECTIONS, ON THE BOARD.
 *
 * The panel said "Collegamenti aperti 2" and named one, and on the board
 * nothing said where they were: "i collegamenti mancanti non c'e' modo di
 * vederli visivamente" (Niccolo', 2026-11-12). The view "Collegamenti
 * mancanti" promised straight lines and drew none (its flag,
 * is_showing_rats_nest, was read by nobody).
 *
 * Here they are drawn: one thin dashed line per missing segment
 * (open-connections.ts), in a colour no copper, selection or footprint has,
 * with a mark at each end. They are lines on the screen: nothing is routed,
 * nothing is placed.
 *
 * WHICH FACE. A segment can start on the top and end on the bottom, and it is
 * drawn whatever face is being looked at: hiding it with its face would hide
 * the very thing that is missing. The END says the face: full when its pad is
 * on the face being looked at (or goes through the board), hollow when it is
 * on another one.
 */
export const COLORE_APERTO = "#FF4FE0";
const BORDO_SCURO = "#06100D";

/** the open connections are on screen: always in the views that show them, elsewhere when the person asked */
export function apertiInVista(flags: Pick<ViewFlags, "is_showing_rats_nest">, accesi: boolean | undefined): boolean {
  return flags.is_showing_rats_nest || accesi === true;
}

/** the one clicked in the panel; `n` is new at every click, so the same one clicked again is framed again */
export interface ApertoScelto {
  id: string;
  n: number;
}

/** the clicks so far, on any board of this page: an `n` is never given twice */
let clic = 0;

/** what the page keeps about the open connections, for the board and for the panel */
export interface StatoAperti {
  /** the open connections of the board on screen */
  elenco: CollegamentiAperti;
  /** the person asked to see them on the board in every view */
  accesi: boolean;
  /** switching them off puts out the one that was lit, too */
  setAccesi: (accesi: boolean) => void;
  scelto: ApertoScelto | null;
  /** go to that one on the board and light it; null puts the light out */
  scegli: (id: string | null) => void;
}

/**
 * The open connections of the board on screen and what the person asked about
 * them. It lives in the page, above the views: the switch stays as it is while
 * the view, the layer or the mode change.
 */
export function useCollegamentiAperti(circuitJson: unknown[] | null): StatoAperti {
  const [accesi, setAccesiStato] = useState(false);
  const [scelto, setScelto] = useState<ApertoScelto | null>(null);
  const elenco = useMemo(() => apertiDellaScheda(circuitJson), [circuitJson]);
  const scegli = useCallback((id: string | null) => {
    setScelto(id === null ? null : { id, n: ++clic });
  }, []);
  const setAccesi = useCallback((v: boolean) => {
    setAccesiStato(v);
    if (!v) setScelto(null);
  }, []);
  return useMemo(() => ({ elenco, accesi, setAccesi, scelto, scegli }), [elenco, accesi, setAccesi, scelto, scegli]);
}

type Vista = { x: number; y: number; k: number };

/**
 * The view that shows one open connection: its middle at the centre of the
 * canvas, and the zoom changed only as much as it takes. Zoomed out until both
 * ends are inside, zoomed in until the segment is long enough to be seen (120
 * pixels, never past 60 px/mm: a pad must not fill the screen).
 */
export function vistaSulCollegamento(
  c: Pick<CollegamentoAperto, "da" | "a">,
  size: { w: number; h: number },
  view: Vista,
): Vista {
  const lunghezza = Math.max(Math.hypot(c.a.x - c.da.x, c.a.y - c.da.y), 1);
  const alPiu = (Math.min(size.w, size.h) * 0.6) / lunghezza;
  const almeno = Math.min(alPiu, 120 / lunghezza, 60);
  const k = Math.min(Math.max(view.k, almeno), alPiu);
  const cx = (c.da.x + c.a.x) / 2;
  const cy = (c.da.y + c.a.y) / 2;
  return { k, x: size.w / 2 - cx * k, y: size.h / 2 + cy * k };
}

/*
 * The click already brought the board there. Guarda and Sposta are two
 * canvases, one mounted at a time: the one that mounts later must not frame
 * again a click the other one answered.
 */
let inquadrato = 0;

/** brings the canvas on the open connection clicked in the panel, once per click */
export function useInquadraAperto(
  circuitJson: unknown[] | null,
  scelto: ApertoScelto | null | undefined,
  size: { w: number; h: number },
  setView: (v: (v: Vista) => Vista) => void,
): void {
  useEffect(() => {
    if (!scelto || !circuitJson || inquadrato === scelto.n) return;
    const c = apertiDellaScheda(circuitJson).collegamenti.find((x) => x.id === scelto.id);
    if (!c) return;
    inquadrato = scelto.n;
    setView((v) => vistaSulCollegamento(c, size, v));
  }, [scelto, circuitJson, size, setView]);
}

/**
 * The open connections of a board, inside the board's flipped SVG group
 * (millimetres, y up). Lines and marks keep their size on screen at any zoom.
 */
export function CollegamentiApertiSulVisore({
  circuitJson,
  mmPerPx,
  forza,
  scelto = null,
  sposta,
}: {
  circuitJson: unknown[] | null;
  mmPerPx: number;
  /** how strongly a copper layer is drawn (strati-visibili.ts): 1 is the face being looked at */
  forza: (strato: string) => number;
  /** the one clicked in the panel: thicker, continuous, with a ring that pulses at each end */
  scelto?: string | null;
  /** where a point of a part is now, when the part has been moved and not applied yet */
  sposta?: (componentId: string, x: number, y: number) => { x: number; y: number };
}) {
  const { collegamenti } = apertiDellaScheda(circuitJson);
  if (collegamenti.length === 0) return null;
  const raggio = mmPerPx * 4;
  return (
    <g data-collegamenti-aperti={collegamenti.length} pointerEvents="none">
      {collegamenti.map((c) => {
        const evidente = c.id === scelto;
        const capi = [c.da, c.a].map((capo) => ({
          ...(sposta ? sposta(capo.componente, capo.x, capo.y) : { x: capo.x, y: capo.y }),
          // a through hole is on every face; a pad is on the one being looked at, or not
          pieno: capo.strato === null || forza(capo.strato) >= 1,
        }));
        const [p, q] = capi;
        return (
          <g key={c.id} data-aperto={c.id} data-rete={c.nome} {...(evidente ? { "data-aperto-scelto": "" } : {})}>
            {/* a dark edge under the line: it reads over copper and over a pour */}
            <line
              x1={p.x}
              y1={p.y}
              x2={q.x}
              y2={q.y}
              stroke={BORDO_SCURO}
              strokeWidth={evidente ? 5.5 : 3.4}
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
              opacity={0.6}
            />
            <line
              x1={p.x}
              y1={p.y}
              x2={q.x}
              y2={q.y}
              stroke={COLORE_APERTO}
              strokeWidth={evidente ? 2.6 : 1.4}
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
              strokeDasharray={evidente ? undefined : "2 4"}
            />
            {capi.map((capo, i) => (
              <g key={i} data-capo={capo.pieno ? "pieno" : "vuoto"}>
                {evidente && (
                  <circle
                    cx={capo.x}
                    cy={capo.y}
                    r={raggio * 2.4}
                    fill="none"
                    stroke={COLORE_APERTO}
                    strokeWidth={mmPerPx * 1.6}
                    className="drc-marker"
                  />
                )}
                <circle
                  cx={capo.x}
                  cy={capo.y}
                  r={evidente ? raggio * 1.25 : raggio}
                  fill={capo.pieno ? COLORE_APERTO : "rgba(6,16,13,0.72)"}
                  stroke={capo.pieno ? BORDO_SCURO : COLORE_APERTO}
                  strokeWidth={mmPerPx * (capo.pieno ? 1 : 1.5)}
                />
              </g>
            ))}
          </g>
        );
      })}
    </g>
  );
}

/**
 * How to read them, in a corner of the canvas while they are on screen: how
 * many, and what a full and a hollow end mean. With none, it says so: a view
 * that draws nothing would look like a view that does not work.
 */
export function LegendaAperti({ circuitJson }: { circuitJson: unknown[] | null }) {
  const { collegamenti, nonCalcolati } = apertiDellaScheda(circuitJson);
  const n = collegamenti.length;
  if (nonCalcolati !== undefined) {
    // the board is drawn, the lines are not: said, never an empty view that reads "nothing is open"
    return (
      <div
        data-legenda-aperti="non-calcolati"
        className="pointer-events-none absolute top-[18px] left-[18px] z-10 max-w-[70%] truncate rounded-md border border-[#3E1F1D] bg-[rgba(9,14,13,0.92)] px-2.5 py-1 text-[11px] text-[#FFB4AB]"
      >
        Collegamenti aperti non disegnati: il calcolo si è fermato ({nonCalcolati})
      </div>
    );
  }
  return (
    <div
      data-legenda-aperti={n}
      className="pointer-events-none absolute top-[18px] left-[18px] z-10 flex max-w-[70%] items-center gap-2 rounded-md border border-[#1F2C29] bg-[rgba(9,14,13,0.9)] px-2.5 py-1 text-[11px] text-[#C7D6D1]"
    >
      {n === 0 ? (
        <span>Nessun collegamento aperto: ogni rete è unita dal rame</span>
      ) : (
        <>
          <svg width="22" height="8" aria-hidden>
            <line x1="1" y1="4" x2="21" y2="4" stroke={COLORE_APERTO} strokeWidth="1.6" strokeDasharray="2 4" strokeLinecap="round" />
          </svg>
          <span className="font-semibold" style={{ color: COLORE_APERTO }}>
            {n} {n === 1 ? "collegamento aperto" : "collegamenti aperti"}
          </span>
          <svg width="10" height="10" aria-hidden>
            <circle cx="5" cy="5" r="3.6" fill={COLORE_APERTO} />
          </svg>
          <span className="text-[#9DB8AC]">capo su questa faccia</span>
          <svg width="10" height="10" aria-hidden>
            <circle cx="5" cy="5" r="3.4" fill="none" stroke={COLORE_APERTO} strokeWidth="1.5" />
          </svg>
          <span className="text-[#9DB8AC]">su un&apos;altra</span>
        </>
      )}
    </div>
  );
}
