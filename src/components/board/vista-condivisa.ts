"use client";

import { useEffect, useRef } from "react";

/**
 * ONE VIEW OF THE BOARD for every canvas that draws it (Guarda, Sposta,
 * Instrada) and across tab switches (Sbroglio > Schematico > Sbroglio).
 *
 * Each canvas used to frame the board on its own when it was mounted, so going
 * to Instrada and back, or to the schematic and back, zoomed the board out to
 * the whole outline. Now the view lives here, by project, as a scale and the
 * millimetre at the centre of the canvas: a canvas that mounts takes it, and
 * every pan or zoom writes it back. The zoom changes only when the person
 * asks (wheel, pinch, dragging the view, FIT). It lasts as long as the page.
 */

type Vista = { x: number; y: number; k: number };
type Misura = { w: number; h: number };

const viste = new Map<string, { board: string; cx: number; cy: number; k: number }>();

/** what re-frames the board: a different board, once measured; never the container's size */
export function chiaveInquadratura(
  board: { width: number; height: number } | null,
  misurato: boolean,
): string | null {
  if (!board || !misurato) return null;
  return `${board.width}x${board.height}`;
}

/** after a resize: the same millimetre at the centre, the same scale */
export function vistaDopoRidimensionamento(v: Vista, prima: Misura, dopo: Misura): Vista {
  return { k: v.k, x: v.x + (dopo.w - prima.w) / 2, y: v.y + (dopo.h - prima.h) / 2 };
}

/** the view saved for this project and board, placed on a canvas of this size */
export function vistaSalvata(chiave: string | undefined, board: string, size: Misura): Vista | null {
  const s = chiave ? viste.get(chiave) : undefined;
  if (!s || s.board !== board) return null;
  return { k: s.k, x: size.w / 2 - s.cx * s.k, y: size.h / 2 + s.cy * s.k };
}

export function salvaVista(chiave: string | undefined, board: string, v: Vista, size: Misura): void {
  if (!chiave) return;
  viste.set(chiave, { board, k: v.k, cx: (size.w / 2 - v.x) / v.k, cy: (v.y - size.h / 2) / v.k });
}

/**
 * The framing of a canvas: the shared view if there is one, the whole board
 * otherwise, once; a resize keeps scale and centre; every change is shared.
 */
export function useVistaCondivisa({
  chiave,
  board,
  misurato,
  size,
  view,
  setView,
  fit,
}: {
  chiave: string | undefined;
  board: { width: number; height: number } | null;
  misurato: boolean;
  size: Misura;
  view: Vista;
  setView: (v: Vista | ((v: Vista) => Vista)) => void;
  fit: () => void;
}): void {
  const fitKey = chiaveInquadratura(board, misurato);
  const lastFit = useRef("");
  const sizePrima = useRef(size);
  /** the view was just set by the framing: the old one must not be shared */
  const appena = useRef(false);

  useEffect(() => {
    if (!fitKey || lastFit.current === fitKey) return;
    const primaVolta = lastFit.current === "";
    lastFit.current = fitKey;
    // framed on THIS size: the resize below must not shift it again
    sizePrima.current = size;
    appena.current = true;
    const salvata = primaVolta ? vistaSalvata(chiave, fitKey, size) : null;
    if (salvata) setView(salvata);
    else fit();
  }, [fitKey, fit, size, chiave, setView]);

  useEffect(() => {
    const prima = sizePrima.current;
    sizePrima.current = size;
    if (!lastFit.current || (prima.w === size.w && prima.h === size.h)) return;
    setView((v) => vistaDopoRidimensionamento(v, prima, size));
  }, [size, setView]);

  useEffect(() => {
    if (!lastFit.current) return;
    if (appena.current) {
      appena.current = false;
      return;
    }
    salvaVista(chiave, lastFit.current, view, size);
  }, [view, size, chiave]);
}
