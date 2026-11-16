"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DesignRules } from "@/lib/design-rules";
import { provaViaNuova, salvataggioDellaVia, statoDellaVia, viaDaCopiare, vieInAttesa, type ViaCopiata } from "@/lib/spinta/via-nuova";
import { nuovoGestoId, type RameInAttesa } from "./gesto-del-rame";

/*
 * DUPLICA VIA IN "SPOSTA", with the vias chosen in the bar (the geometry and
 * the rules are in lib/spinta/via-nuova.ts):
 *   - a press on a via chooses it (and drags it, as before);
 *   - Cmd+C (or "Copia" in the panel) copies the via chosen;
 *   - Cmd+V pastes a copy where the pointer is, a click pastes one where it is
 *     clicked while "Incolla" is on (the panel, for whoever does not use the
 *     keyboard). As many as wanted, one after the other; Esc or "Fine" stops
 *     the clicks.
 * Each copy is a gesture of its own: on screen at once, saved after the same
 * quiet as a drag, undone by Cmd+Z. One that does not fit is not laid, and the
 * board says why, in red, where it was asked for.
 */

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
  /** says on the board, for a moment, why nothing was done */
  dici: (frase: string, dove: { x: number; y: number }) => void;
}) {
  /** the via chosen: its id on this board, and where it is */
  const [scelta, setScelta] = useState<{ pcbViaId: string; x: number; y: number } | null>(null);
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
      setScelta(null);
      setIncolla(false);
    }
  }

  const scegli = useCallback((via: { pcbViaId: string; x: number; y: number }) => setScelta(via), []);

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
        dici(esito.blocco.motivo, dove);
        return;
      }
      const gesto = nuovoGestoId();
      onGesto({ gesto, salvataggio: salvataggioDellaVia(copiata, esito.dove, gesto), stato: statoDellaVia(copiata, esito.dove) });
    },
    [attivo, circuitJson, regole, copiata, onGesto, inAttesa, dici],
  );

  // Cmd+C, Cmd+V, and Esc to stop the clicks that paste
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
      } else if (e.key === "Escape" && incolla) {
        // Esc ends the clicks that paste, and only that: Sposta stays
        e.preventDefault();
        e.stopImmediatePropagation();
        setIncolla(false);
      }
    };
    window.addEventListener("keydown", tasto, true);
    return () => window.removeEventListener("keydown", tasto, true);
  }, [attivo, scelta, copiata, incolla, copia, incollaIn]);

  return {
    scelta,
    copiata,
    incolla: attivo && incolla && copiata !== null,
    setIncolla,
    scegli,
    copia,
    incollaIn,
    /** the pointer moved on the board: where Cmd+V pastes */
    segui: (p: { x: number; y: number } | null) => {
      puntatore.current = p;
    },
  };
}
