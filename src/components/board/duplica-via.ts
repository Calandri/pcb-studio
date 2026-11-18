"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DesignRules } from "@/lib/design-rules";
import { provaViaNuova, salvataggioDellaVia, statoDellaVia, viaDaCopiare, viaDaTogliere, vieInAttesa, type ViaCopiata } from "@/lib/spinta/via-nuova";
import type { Sagoma } from "@/lib/zona";
import { nuovoGestoId, type RameInAttesa } from "./gesto-del-rame";

/*
 * DUPLICA VIA IN "SPOSTA", with the vias chosen in the bar (the geometry and
 * the rules are in lib/spinta/via-nuova.ts):
 *   - a press on a via chooses it (and drags it, as before);
 *   - Cmd+C (or "Copia" in the panel) copies the via chosen;
 *   - Cmd+V pastes a copy where the pointer is, a click pastes one where it is
 *     clicked while "Incolla" is on (the panel, for whoever does not use the
 *     keyboard). As many as wanted, one after the other; Esc or "Fine" stops
 *     the clicks;
 *   - Canc or Backspace (or "Elimina" in the panel) takes the via chosen out,
 *     if it is one the person pasted: a via put down by mistake used to go
 *     only with Cmd+Z, and only if nothing had been done after it.
 * Each copy is a gesture of its own: on screen at once, saved after the same
 * quiet as a drag, undone by Cmd+Z. One that does not fit is not laid, and the
 * board says why, in red, where it was asked for. A via taken out is a
 * gesture too, undone the same way.
 *
 * The via chosen is kept by WHERE IT STANDS, not by its id: the ids of the
 * pasted vias are numbered anew whenever one is added or taken out.
 */

/** as near as two vias cannot be: a via found within this of a place is the via of that place */
const STESSO_POSTO_MM = 0.002;

/** the via of the board that stands at a place, as the canvas chooses it; null when none does */
export function viaNelPosto(circuitJson: readonly unknown[] | null, dove: { x: number; y: number }): { pcbViaId: string; x: number; y: number } | null {
  for (const el of (circuitJson ?? []) as Array<Record<string, unknown> | null>) {
    if (el?.type !== "pcb_via" || typeof el.x !== "number" || typeof el.y !== "number" || typeof el.pcb_via_id !== "string") continue;
    if (Math.abs(el.x - dove.x) <= STESSO_POSTO_MM && Math.abs(el.y - dove.y) <= STESSO_POSTO_MM) return { pcbViaId: el.pcb_via_id, x: el.x, y: el.y };
  }
  return null;
}

const isTyping = (e: KeyboardEvent): boolean => {
  const t = e.target as { tagName?: string; isContentEditable?: boolean } | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable === true);
};

/** whether a node is inside the panel of the vias or a button of the canvas (the zoom): a press there is not a click on the board */
export const nelPannelloDelleVie = (n: unknown): boolean => {
  type Nodo = { getAttribute?: (k: string) => string | null; parentNode?: unknown; tagName?: string };
  for (let q = n as Nodo | null; q; q = q.parentNode as Nodo | null) {
    if (typeof q.tagName === "string" && q.tagName.toLowerCase() === "button") return true;
    if (typeof q.getAttribute === "function" && q.getAttribute("data-duplica-via") !== null) return true;
  }
  return false;
};

export function useDuplicaVia({
  attivo,
  circuitJson,
  regole,
  inAttesa,
  onGesto,
  dici,
}: {
  /** in Sposta, with the vias chosen, the rules and somebody to save a gesture */
  attivo: boolean;
  circuitJson: unknown[] | null;
  regole: DesignRules | undefined;
  /** the gestures waiting: their vias are not on the board yet, and a copy keeps away from them too */
  inAttesa: readonly RameInAttesa[];
  onGesto: ((g: RameInAttesa) => void) | undefined;
  /** says on the board, for a moment, why nothing was done; `zona`: the forbidden zone that said no, drawn with it */
  dici: (frase: string, dove: { x: number; y: number }, zona?: Sagoma) => void;
}) {
  /** where the via chosen stands: the via itself is read on the board in hand (see `scelta`) */
  const [posto, setPosto] = useState<{ x: number; y: number } | null>(null);
  /** the via chosen, on THIS board: gone when no via stands there any more (taken out, undone) */
  const scelta = useMemo(() => (posto ? viaNelPosto(circuitJson, posto) : null), [posto, circuitJson]);
  const [copiata, setCopiata] = useState<ViaCopiata | null>(null);
  /** a click on the board pastes a copy */
  const [incolla, setIncolla] = useState(false);
  /** where the pointer is on the board, mm, already on the grid: where Cmd+V pastes */
  const puntatore = useRef<{ x: number; y: number } | null>(null);

  // leaving Sposta or the vias: nothing chosen, no clicks that paste (the copy stays, for the next time); fixed during render
  const [eraAttivo, setEraAttivo] = useState(attivo);
  if (eraAttivo !== attivo) {
    setEraAttivo(attivo);
    if (!attivo) {
      setPosto(null);
      setIncolla(false);
    }
  }

  const scegli = useCallback((via: { x: number; y: number }) => setPosto({ x: via.x, y: via.y }), []);
  /** the via chosen was dragged: the choice goes with it */
  const segueLaVia = useCallback((dove: { x: number; y: number }) => setPosto((p) => (p ? { x: dove.x, y: dove.y } : p)), []);

  const copia = useCallback(() => {
    if (!attivo || !circuitJson || !regole || !scelta) return;
    const c = viaDaCopiare(circuitJson, regole, scelta.pcbViaId);
    if ("rifiuto" in c) {
      dici(c.rifiuto, scelta);
      return;
    }
    setCopiata(c);
  }, [attivo, circuitJson, regole, scelta, dici]);

  const incollaIn = useCallback(
    (dove: { x: number; y: number }) => {
      if (!attivo || !circuitJson || !regole || !copiata || !onGesto) return;
      const esito = provaViaNuova({ circuitJson, regole, via: copiata, dove, inAttesa: vieInAttesa(inAttesa.map((g) => g.salvataggio)) });
      if (!esito.ok) {
        dici(esito.blocco.motivo, dove, esito.blocco.zona);
        return;
      }
      const gesto = nuovoGestoId();
      onGesto({ gesto, salvataggio: salvataggioDellaVia(copiata, esito.dove, gesto), stato: statoDellaVia(copiata, esito.dove) });
    },
    [attivo, circuitJson, regole, copiata, onGesto, inAttesa, dici],
  );

  /** takes the via chosen out, if it is a pasted one: a gesture like the others, saved in its turn and undone by Cmd+Z */
  const togli = useCallback(() => {
    if (!attivo || !circuitJson || !regole || !scelta || !onGesto) return;
    const via = viaDaTogliere(circuitJson, regole, scelta.pcbViaId);
    if ("rifiuto" in via) {
      dici(via.rifiuto, scelta);
      return;
    }
    onGesto({
      gesto: nuovoGestoId(),
      salvataggio: { routes: [], vias: [], riscritte: [] },
      stato: { nascosti: { pcbTraceIds: [], pcbViaIds: [] }, tratti: [], vie: [], posizione: { x: via.x, y: via.y }, blocco: null, mosso: true },
      togli: via,
    });
    setPosto(null);
  }, [attivo, circuitJson, regole, scelta, onGesto, dici]);

  // Cmd+C, Cmd+V, Canc, and Esc to stop the clicks that paste
  useEffect(() => {
    if (!attivo) return;
    const tasto = (e: KeyboardEvent) => {
      if (isTyping(e)) return;
      const meta = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (meta && k === "c" && scelta) {
        e.preventDefault();
        copia();
      } else if (meta && k === "v" && copiata && puntatore.current) {
        e.preventDefault();
        incollaIn(puntatore.current);
      } else if ((e.key === "Delete" || e.key === "Backspace") && !meta && scelta) {
        e.preventDefault();
        togli();
      } else if (e.key === "Escape" && incolla) {
        // Esc ends the clicks that paste, and only that: Sposta stays
        e.preventDefault();
        e.stopImmediatePropagation();
        setIncolla(false);
      }
    };
    window.addEventListener("keydown", tasto, true);
    return () => window.removeEventListener("keydown", tasto, true);
  }, [attivo, scelta, copiata, incolla, copia, incollaIn, togli]);

  return {
    scelta,
    /** whether the via chosen is one the person pasted: only those are taken out from here */
    incollata: useMemo(
      () =>
        scelta !== null &&
        ((circuitJson ?? []) as Array<Record<string, unknown> | null>).some((e) => e?.type === "pcb_via" && e.pcb_via_id === scelta.pcbViaId && e.aggiunta_da !== undefined),
      [scelta, circuitJson],
    ),
    copiata,
    incolla: attivo && incolla && copiata !== null,
    setIncolla,
    scegli,
    segueLaVia,
    copia,
    togli,
    incollaIn,
    /** the pointer moved on the board: where Cmd+V pastes */
    segui: (p: { x: number; y: number } | null) => {
      puntatore.current = p;
    },
  };
}
