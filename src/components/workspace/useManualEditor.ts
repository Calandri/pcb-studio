"use client";

import { useCallback, useEffect, useState } from "react";
import {
  countManualEdits,
  emptyManualEdits,
  type EditEvent,
  type ManualEdits,
} from "@/lib/manual-edits";

export type EditMode = "view" | "move" | "route" | "link";

/** collegamento tirato a mano e non ancora scritto in main.tsx */
export interface PendingLink {
  from: string;
  to: string;
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

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
  /*
   * I collegamenti stanno a parte dagli spostamenti perche' finiscono in un
   * altro posto: uno spostamento e' geometria e va in manual-edits.json, un
   * collegamento e' progetto elettrico e va scritto in main.tsx come <trace>.
   * Se un collegamento vivesse fuori dalle sorgenti l'agente non saprebbe che
   * esiste.
   */
  const [links, setLinks] = useState<PendingLink[]>([]);
  const [unlinks, setUnlinks] = useState<string[]>([]);
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

  const addLink = useCallback((link: PendingLink) => {
    setLinks((l) =>
      // stesso collegamento tirato due volte: conta una volta sola, in qualsiasi verso
      l.some(
        (x) =>
          (x.from === link.from && x.to === link.to) ||
          (x.from === link.to && x.to === link.from),
      )
        ? l
        : [...l, link],
    );
  }, []);

  const addUnlink = useCallback((declared: string) => {
    setUnlinks((u) => (u.includes(declared) ? u : [...u, declared]));
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

  /** scrive un collegamento (o lo toglie) dentro main.tsx */
  const postConnection = useCallback(
    async (body: Record<string, unknown>): Promise<string | null> => {
      const res = await fetch("/api/schematic/connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, ...body }),
      });
      const d = await res.json().catch(() => ({}));
      return res.ok ? null : (d.error ?? `HTTP ${res.status}`);
    },
    [projectId],
  );

  const dirty = pending.length + links.length + unlinks.length;

  /**
   * Scrive tutto e ricompila una volta sola. I collegamenti vanno per primi:
   * cambiano il circuito, e ha senso che il ri-sbroglio parta dal circuito
   * definitivo invece che da quello di mezzo.
   */
  const apply = useCallback(async () => {
    if (dirty === 0 || busy) return;
    setBusy(true);
    setError(null);
    const problems: string[] = [];
    try {
      for (const declared of unlinks) {
        const err = await postConnection({ declared });
        if (err) problems.push(err);
      }
      for (const link of links) {
        const err = await postConnection({ from: link.from, to: link.to });
        if (err) problems.push(`${link.from} → ${link.to}: ${err}`);
      }
    } finally {
      setBusy(false);
    }
    if (problems.length > 0) setError(problems[0]);
    setLinks([]);
    setUnlinks([]);

    const before = saved;
    if (pending.length > 0) {
      const next = await post({ events: pending });
      if (!next) return;
      setPast((p) => [...p, before].slice(-40));
      setFuture([]);
      setPending([]);
    } else {
      // nessuno spostamento da salvare, ma il circuito e' cambiato: si ricompila
      await onApplied();
    }
    setViewerKey((k) => k + 1);
  }, [dirty, busy, pending, links, unlinks, saved, post, postConnection, onApplied]);

  const undo = useCallback(async () => {
    if (busy) return;
    // si disfa nell'ordine inverso a come si e' fatto: prima i collegamenti,
    // che sono l'ultima cosa che si tira, poi gli spostamenti
    if (unlinks.length > 0) {
      setUnlinks((u) => u.slice(0, -1));
      return;
    }
    if (links.length > 0) {
      setLinks((l) => l.slice(0, -1));
      return;
    }
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
  }, [busy, pending, links, unlinks, past, saved, post]);

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
    setLinks([]);
    setUnlinks([]);
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
    links,
    unlinks,
    dirty,
    addLink,
    addUnlink,
    canUndo: dirty > 0 || past.length > 0,
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
