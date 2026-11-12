"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DesignRules } from "@/lib/design-rules";
import { chiudiGesto, iniziaGesto, muoviGesto, preseDelRame, type GestoDelRame } from "@/lib/spinta/gesto";
import type { BersaglioDelRame, SalvataggioDelGesto, StatoDelGesto } from "@/lib/spinta/gesto-tipi";

/*
 * COPPER DRAGGED IN "SPOSTA": a via with its traces, or one straight stretch of
 * a trace. The geometry is not here (lib/spinta/gesto.ts works out where the
 * copper stands and what stops it): here is the gesture as the canvas lives
 * it, from the pointer down on a target to the release.
 *
 * What changes at every frame (the copper in hand, what blocks it) is kept OUT
 * of the canvas state, in a small store only RameInMovimento listens to: the
 * canvas itself is drawn again when a gesture starts and when it ends, never
 * while it lasts, and the still copper not even then unless its hidden list
 * changes (see `nascosti`).
 */

type Punto = { x: number; y: number };

/** a gesture let go that moved something: what to save, and what stays on screen until the saved board shows it */
export interface RameInAttesa {
  /** the id of the drag, new for each one: the same on every correction it makes (see leggiRame) */
  gesto: string;
  /** what chiudiGesto asked to be saved, as it gave it */
  salvataggio: SalvataggioDelGesto;
  /** the copper as the gesture left it */
  stato: StatoDelGesto;
}

/** no gesture waiting: one list for every canvas that has none, so the memos that read it hold */
export const NESSUN_RAME: readonly RameInAttesa[] = [];

/** what the viewer shows of the gesture in hand */
export interface RameVivo {
  /** the copper in hand as it stands now; null when nothing is in hand */
  stato: StatoDelGesto | null;
  /** why the thing under the pointer could not be grabbed, and where: said for a moment */
  rifiuto: (Punto & { frase: string }) | null;
}

const FERMO: RameVivo = { stato: null, rifiuto: null };

/** the gesture in hand as RameInMovimento reads it (useSyncExternalStore) */
export interface GestoVivo {
  subscribe: (ascolta: () => void) => () => void;
  getSnapshot: () => RameVivo;
}

/** the store of one canvas: what is in hand now, and who wants to know when it changes */
export function nuovoGestoVivo(inizio: RameVivo = FERMO): GestoVivo & { set: (ora: RameVivo) => void } {
  let ora = inizio;
  const ascoltano = new Set<() => void>();
  return {
    subscribe: (ascolta) => {
      ascoltano.add(ascolta);
      return () => ascoltano.delete(ascolta);
    },
    getSnapshot: () => ora,
    set: (prossimo) => {
      ora = prossimo;
      for (const ascolta of ascoltano) ascolta();
    },
  };
}

/** the ids a gesture takes out of the still copper, as sets: the pcb_trace and pcb_via drawn moved instead */
export interface RameNascosto {
  piste: ReadonlySet<string>;
  vie: ReadonlySet<string>;
}

/** a new id for a drag: letters and digits, well inside what a `copper` save takes (/^[\w-]{1,64}$/) */
export const nuovoGestoId = (): string => `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** how long "this cannot be grabbed" stays on the board */
const RIFIUTO_MS = 2500;

/** the pointer down on a target, as much of it as the gesture reads */
export interface PuntatoreGiu {
  button: number;
  shiftKey: boolean;
  pointerId: number;
  stopPropagation: () => void;
  currentTarget: {
    setPointerCapture?: (id: number) => void;
    hasPointerCapture?: (id: number) => boolean;
    releasePointerCapture?: (id: number) => void;
  };
}

interface InMano {
  gesto: GestoDelRame;
  /** the last state worked out: what is on screen, and what the release closes on */
  stato: StatoDelGesto;
  /** the hidden copper the canvas has been told of: the one of the start, until a state carries another */
  nascosti: StatoDelGesto["nascosti"];
  /** where the pointer is now, when it has moved since the last state was worked out */
  verso: Punto | null;
  /** the frame that will work it out, if one is asked */
  frame: number | null;
  tasto: (e: KeyboardEvent) => void;
  /** gives the pointer back to the canvas, if the target still holds it */
  molla: () => void;
}

export function useGestoDelRame({
  attivo,
  circuitJson,
  regole,
  inAttesa,
  onGesto,
}: {
  /** copper can be grabbed: in Sposta, with the rules and somebody to save the gesture */
  attivo: boolean;
  circuitJson: unknown[] | null;
  regole: DesignRules | undefined;
  /** the gestures let go and not on the saved board yet */
  inAttesa: readonly RameInAttesa[];
  onGesto: ((g: RameInAttesa) => void) | undefined;
}) {
  const [vivo] = useState(() => nuovoGestoVivo());
  /*
   * What the gesture in hand hides: the only state of the canvas a copper
   * gesture touches. Set when it starts, cleared when it ends, and in between
   * only when the solver hands another list: a trace the gesture pushes aside
   * enters it when it is first pushed and leaves it when the pointer comes
   * back (StatoDelGesto.nascosti: the same object while the set is the same).
   */
  const [nascostiInMano, setNascostiInMano] = useState<StatoDelGesto["nascosti"] | null>(null);
  const inMano = useRef<InMano | null>(null);
  const timerRifiuto = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * What can be grabbed on this board, worked out once per board loaded (not
   * per render: it reads the whole circuit). The solver may still refuse one
   * at grab time.
   */
  const bersagli = useMemo(
    () => (attivo && circuitJson ? preseDelRame(circuitJson) : []),
    [attivo, circuitJson],
  );

  /*
   * What the still copper leaves out: the copper in hand and the copper of the
   * gestures waiting. It changes when a gesture starts, ends or reaches the
   * saved board, and at no pointer move: the memo of the still copper holds.
   */
  const nascosti = useMemo((): RameNascosto | null => {
    const liste = [...(nascostiInMano ? [nascostiInMano] : []), ...inAttesa.map((g) => g.stato.nascosti)];
    if (liste.length === 0) return null;
    return {
      piste: new Set(liste.flatMap((n) => n.pcbTraceIds)),
      vie: new Set(liste.flatMap((n) => n.pcbViaIds)),
    };
  }, [nascostiInMano, inAttesa]);

  const zittisci = useCallback(() => {
    if (timerRifiuto.current !== null) clearTimeout(timerRifiuto.current);
    timerRifiuto.current = null;
  }, []);

  /** says for a moment, on the board, why nothing was grabbed or why the gesture ended */
  const dici = useCallback(
    (frase: string, dove: Punto) => {
      zittisci();
      const rifiuto = { ...dove, frase };
      vivo.set({ stato: null, rifiuto });
      timerRifiuto.current = setTimeout(() => {
        timerRifiuto.current = null;
        if (vivo.getSnapshot().rifiuto === rifiuto) vivo.set(FERMO);
      }, RIFIUTO_MS);
    },
    [vivo, zittisci],
  );

  /** lets go of what is in hand without saving anything: the copper is drawn where it was again */
  const lascia = useCallback((): InMano | null => {
    const m = inMano.current;
    if (!m) return null;
    inMano.current = null;
    if (m.frame !== null) cancelAnimationFrame(m.frame);
    window.removeEventListener("keydown", m.tasto, true);
    m.molla();
    vivo.set(FERMO);
    setNascostiInMano(null);
    return m;
  }, [vivo]);

  /**
   * The copper the gesture hides changed with the last state: the still copper
   * is told, and drawn again without it. Only then: while the pointer moves
   * and the gesture touches the same copper, the canvas is not drawn again.
   */
  const segui = useCallback((m: InMano) => {
    if (m.stato.nascosti === m.nascosti) return;
    m.nascosti = m.stato.nascosti;
    setNascostiInMano(m.nascosti);
  }, []);

  /** the state for the pointer where it is now; false when the solver fell over, and the gesture is over */
  const calcola = useCallback(
    (m: InMano): boolean => {
      if (!m.verso) return true;
      const verso = m.verso;
      m.verso = null;
      try {
        m.stato = muoviGesto(m.gesto, verso);
      } catch (err) {
        // a gesture that cannot be worked out is not left half done: it ends, and says so
        console.error("gesto del rame non calcolato:", err);
        if (inMano.current === m) lascia();
        dici(`gesto interrotto: ${err instanceof Error ? err.message : String(err)}`, m.stato.posizione);
        return false;
      }
      return true;
    },
    [lascia, dici],
  );

  /** pointer down on a target: the gesture starts, or the board says why it cannot */
  const prendi = useCallback(
    (bersaglio: BersaglioDelRame, e: PuntatoreGiu) => {
      // Shift is the selection box, like on a part: it belongs to the board
      if (!attivo || !circuitJson || !regole || e.button !== 0 || e.shiftKey) return;
      // the copper is grabbed here: neither the view nor a part must start
      e.stopPropagation();
      /*
       * One gesture at a time, until the saved board shows it. The keys and
       * the ids of hand copper change at every save: a gesture begun on the
       * board of before would be refused by the server as "board changed".
       * The press is taken all the same, so it does not become the drag of a
       * part that happens to be under the copper.
       */
      if (inMano.current || inAttesa.length > 0) return;
      zittisci();
      const esito = iniziaGesto({
        circuitJson,
        regole,
        presa:
          bersaglio.tipo === "via"
            ? { tipo: "via", pcbViaId: bersaglio.pcbViaId }
            : { tipo: "tratto", pcbTraceId: bersaglio.pcbTraceId, indice: bersaglio.indice },
      });
      if ("rifiuto" in esito) {
        dici(
          esito.rifiuto,
          bersaglio.tipo === "via"
            ? { x: bersaglio.x, y: bersaglio.y }
            : { x: (bersaglio.x1 + bersaglio.x2) / 2, y: (bersaglio.y1 + bersaglio.y2) / 2 },
        );
        return;
      }
      const el = e.currentTarget;
      const id = e.pointerId;
      el.setPointerCapture?.(id);
      /*
       * Esc cancels the gesture and nothing else. The listener is on the window
       * in the capture phase and stops the key there: the same Esc would
       * otherwise also leave Sposta (EditorBar) and drop the selection.
       */
      const tasto = (k: KeyboardEvent) => {
        if (k.key !== "Escape") return;
        k.preventDefault();
        k.stopImmediatePropagation();
        lascia();
      };
      window.addEventListener("keydown", tasto, true);
      inMano.current = {
        gesto: esito.gesto,
        stato: esito.stato,
        nascosti: esito.stato.nascosti,
        verso: null,
        frame: null,
        tasto,
        molla: () => {
          if (el.hasPointerCapture?.(id)) el.releasePointerCapture?.(id);
        },
      };
      vivo.set({ stato: esito.stato, rifiuto: null });
      setNascostiInMano(esito.stato.nascosti);
    },
    [attivo, circuitJson, regole, inAttesa, vivo, lascia, dici, zittisci],
  );

  /**
   * The pointer moved. False when no copper is in hand (the event is somebody
   * else's). The copper is worked out at most once per animation frame, with
   * the place the pointer has when the frame comes: a move of the solver can
   * take milliseconds on a big board, and the pointer sends many per frame.
   */
  const muovi = useCallback(
    (punto: () => Punto | null): boolean => {
      const m = inMano.current;
      if (!m) return false;
      const p = punto();
      if (!p) return true;
      m.verso = p;
      if (m.frame === null) {
        m.frame = requestAnimationFrame(() => {
          m.frame = null;
          if (inMano.current !== m || !calcola(m)) return;
          vivo.set({ stato: m.stato, rifiuto: null });
          segui(m);
        });
      }
      return true;
    },
    [vivo, calcola, segui],
  );

  /**
   * The pointer was let go. False when no copper is in hand. The gesture closes
   * on the last place of the pointer, and what it asks to be saved goes to the
   * editor with its state, which stays on screen until the saved board shows it.
   */
  const rilascia = useCallback((): boolean => {
    const m = inMano.current;
    if (!m) return false;
    // a move whose frame had not come yet counts: the copper is let go where the pointer is
    if (!calcola(m)) return true;
    lascia();
    const gesto = nuovoGestoId();
    const salvataggio = chiudiGesto(m.gesto, m.stato, gesto);
    // nothing moved: nothing to save, and nothing to keep on screen
    if (salvataggio) onGesto?.({ gesto, salvataggio, stato: m.stato });
    return true;
  }, [calcola, lascia, onGesto]);

  /** a pointer the browser took away (pointercancel): like Esc, everything as it was and nothing sent */
  const annulla = useCallback(() => void lascia(), [lascia]);

  // leaving Sposta (or the canvas) with copper in hand: the gesture is dropped, with its key, its frame and its words
  useEffect(() => {
    if (!attivo) return;
    return () => {
      lascia();
      zittisci();
      vivo.set(FERMO);
    };
  }, [attivo, lascia, zittisci, vivo]);

  return { bersagli, nascosti, vivo: vivo as GestoVivo, prendi, muovi, rilascia, annulla };
}
