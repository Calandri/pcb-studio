"use client";

import { useCallback, useEffect, useState } from "react";
import {
  countManualEdits,
  emptyManualEdits,
  type EditEvent,
  type ManualEdits,
} from "@/lib/manual-edits";

export type EditMode = "view" | "move" | "route";

/**
 * Stato dell'editor manuale.
 *
 * Due livelli, e la differenza conta: le modifiche IN SOSPESO vivono nel
 * browser e le disegnano i viewer da soli (il componente resta dove lo lasci,
 * senza aspettare il server), quelle SALVATE vivono in manual-edits.json e
 * valgono per la compilazione. Spostare dieci componenti e ricompilare una
 * volta sola e' il modo giusto di lavorare: il ri-sbroglio e' la parte cara.
 *
 * Annulla e ripristina lavorano su entrambi i livelli: prima svuotano le
 * modifiche in sospeso una alla volta, poi tornano indietro fra gli stati gia'
 * salvati (ognuno dei quali richiede di riscrivere il file e ricompilare).
 */
export function useManualEditor({
  projectId,
  onApplied,
}: {
  projectId: string;
  /** chiamato dopo ogni scrittura andata a buon fine: ricompila e ricarica */
  onApplied: () => Promise<void> | void;
}) {
  const [mode, setMode] = useState<EditMode>("view");
  const [pending, setPending] = useState<EditEvent[]>([]);
  const [saved, setSaved] = useState<ManualEdits>(emptyManualEdits());
  const [past, setPast] = useState<ManualEdits[]>([]);
  const [future, setFuture] = useState<ManualEdits[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // i viewer tengono uno stato interno di trascinamento: per far sparire una
  // modifica annullata bisogna rimontarli, non basta cambiare le prop
  const [viewerKey, setViewerKey] = useState(0);

  useEffect(() => {
    let alive = true;
    fetch(`/api/manual-edits?projectId=${encodeURIComponent(projectId)}`)
      .then((r) => r.json())
      .then((d) => {
        if (alive && d?.edits) setSaved(d.edits as ManualEdits);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [projectId]);

  /** la vista PCB e' controllata: passa sempre l'elenco completo */
  const replacePending = useCallback((events: EditEvent[]) => {
    setPending(events.filter((e) => !e.in_progress));
  }, []);

  /** la vista schematica emette un evento alla volta, a trascinamento finito */
  const pushPending = useCallback((event: EditEvent) => {
    if (event.in_progress) return;
    setPending((p) => [...p, event]);
  }, []);

  const post = useCallback(
    async (body: Record<string, unknown>): Promise<ManualEdits | null> => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch("/api/manual-edits", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectId, ...body }),
        });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
        setSaved(d.edits as ManualEdits);
        await onApplied();
        return d.edits as ManualEdits;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [projectId, onApplied],
  );

  /** scrive le modifiche in sospeso e ricompila */
  const apply = useCallback(async () => {
    if (pending.length === 0 || busy) return;
    const before = saved;
    const next = await post({ events: pending });
    if (!next) return;
    setPast((p) => [...p, before].slice(-40));
    setFuture([]);
    setPending([]);
    setViewerKey((k) => k + 1);
  }, [pending, busy, saved, post]);

  const undo = useCallback(async () => {
    if (busy) return;
    if (pending.length > 0) {
      setPending((p) => p.slice(0, -1));
      setViewerKey((k) => k + 1);
      return;
    }
    const previous = past[past.length - 1];
    if (!previous) return;
    const current = saved;
    const next = await post({ action: "set", edits: previous });
    if (!next) return;
    setPast((p) => p.slice(0, -1));
    setFuture((f) => [current, ...f].slice(0, 40));
    setViewerKey((k) => k + 1);
  }, [busy, pending, past, saved, post]);

  const redo = useCallback(async () => {
    if (busy) return;
    const target = future[0];
    if (!target) return;
    const current = saved;
    const next = await post({ action: "set", edits: target });
    if (!next) return;
    setFuture((f) => f.slice(1));
    setPast((p) => [...p, current].slice(-40));
    setViewerKey((k) => k + 1);
  }, [busy, future, saved, post]);

  /** butta via cio' che non e' stato ancora scritto */
  const discard = useCallback(() => {
    setPending([]);
    setViewerKey((k) => k + 1);
  }, []);

  /** riporta all'automatico un componente (o tutto, con name null) */
  const release = useCallback(
    async (scope: "schematic" | "pcb" | "traces" | "all", name: string | null) => {
      if (busy) return;
      const before = saved;
      const next = await post({ action: "release", scope, name });
      if (!next) return;
      setPast((p) => [...p, before].slice(-40));
      setFuture([]);
      setPending([]);
      setViewerKey((k) => k + 1);
    },
    [busy, saved, post],
  );

  const counts = countManualEdits(saved);

  return {
    mode,
    setMode,
    pending,
    saved,
    counts,
    busy,
    error,
    viewerKey,
    canUndo: pending.length > 0 || past.length > 0,
    canRedo: future.length > 0,
    replacePending,
    pushPending,
    apply,
    undo,
    redo,
    discard,
    release,
  };
}

export type ManualEditor = ReturnType<typeof useManualEditor>;
