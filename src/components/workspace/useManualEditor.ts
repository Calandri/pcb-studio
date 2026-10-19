"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  countManualEdits,
  emptyManualEdits,
  type EditEvent,
  type ManualEdits,
} from "@/lib/manual-edits";
import { manualRouteKey, type ManualRoute } from "@/lib/manual-routes";
import {
  conflictMessage,
  rebaseManualEdits,
  withoutSent,
  type HistoryStep,
} from "./manual-history";

export type EditMode = "view" | "move" | "route" | "link";

/** hand-drawn link not yet written into main.tsx */
export interface PendingLink {
  from: string;
  to: string;
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

/**
 * Manual editor state.
 *
 * Two levels, and the difference matters: PENDING edits live in the browser
 * and the viewers draw them on their own (the component stays where you left
 * it, without waiting for the server), SAVED ones live in manual-edits.json
 * and apply to compilation. Moving ten components and recompiling once is the
 * right way to work: re-routing is the expensive part.
 *
 * Undo and redo work on both levels: first they empty the pending edits one at
 * a time, then they move back and forth among the already-saved steps (each
 * of which requires rewriting the file and recompiling), always relative to
 * the file the server holds at that moment.
 */
export function useManualEditor({
  projectId,
  onApplied,
}: {
  projectId: string;
  /**
   * Called after every successful write. `structural` says the circuit has
   * changed (links, hand-routed traces): a full compile is needed. Without it,
   * moves alone are enough and the fast path applies.
   */
  onApplied: (opts?: { structural?: boolean }) => Promise<void> | void;
}) {
  const [mode, setMode] = useState<EditMode>("view");
  const [pending, setPending] = useState<EditEvent[]>([]);
  /*
   * Links are kept apart from moves because they end up in a different place:
   * a move is geometry and goes into manual-edits.json, a link is electrical
   * design and must be written into main.tsx as a <trace>. If a link lived
   * outside the sources the agent would not know it exists.
   */
  const [links, setLinks] = useState<PendingLink[]>([]);
  const [unlinks, setUnlinks] = useState<string[]>([]);
  /** hand-routed traces not yet written into the project */
  const [routes, setRoutes] = useState<ManualRoute[]>([]);
  const [saved, setSaved] = useState<ManualEdits>(emptyManualEdits());
  /*
   * Each saved step keeps the file before AND after it, as the server answered:
   * undo moves back only what the step changed (see manual-history.ts).
   */
  const [past, setPast] = useState<HistoryStep[]>([]);
  const [future, setFuture] = useState<HistoryStep[]>([]);
  const [busy, setBusy] = useState(false);
  /*
   * The guard against two writes at once is a ref, not the state: the state
   * read inside a callback is the one of the render that created it, so two
   * clicks in the same frame both saw `busy === false` and both went.
   */
  const busyRef = useRef(false);
  const savedRef = useRef<ManualEdits>(saved);
  const [error, setError] = useState<string | null>(null);
  // viewers keep an internal drag state: to make an undone edit disappear
  // they must be remounted, changing the props is not enough
  const [viewerKey, setViewerKey] = useState(0);

  const commitSaved = useCallback((edits: ManualEdits) => {
    savedRef.current = edits;
    setSaved(edits);
  }, []);

  /** the file as the server holds it NOW; null when it cannot be read */
  const readSaved = useCallback(async (): Promise<ManualEdits | null> => {
    try {
      const res = await fetch(`/api/manual-edits?projectId=${encodeURIComponent(projectId)}`);
      if (!res.ok) return null;
      const d = await res.json();
      return (d?.edits as ManualEdits | undefined) ?? null;
    } catch {
      return null;
    }
  }, [projectId]);

  useEffect(() => {
    let alive = true;
    void readSaved().then((edits) => {
      if (alive && edits) commitSaved(edits);
    });
    return () => {
      alive = false;
    };
  }, [readSaved, commitSaved]);

  /*
   * While a write is in flight the canvas is locked (Studio covers it), and
   * edits arriving anyway — a key press, a drag that ends — are not taken:
   * they would be drawn on the board that is being replaced, and the ids they
   * carry may not exist in the next one.
   */
  /** the PCB view is controlled: it always passes the full list */
  const replacePending = useCallback((events: EditEvent[]) => {
    if (busyRef.current) return;
    setPending(events.filter((e) => !e.in_progress));
  }, []);

  const addLink = useCallback((link: PendingLink) => {
    if (busyRef.current) return;
    setLinks((l) =>
      // same link drawn twice: count it once, in either direction
      l.some(
        (x) =>
          (x.from === link.from && x.to === link.to) ||
          (x.from === link.to && x.to === link.from),
      )
        ? l
        : [...l, link],
    );
  }, []);

  const addRoute = useCallback((route: ManualRoute) => {
    if (busyRef.current) return;
    // redrawing the same pair of pads replaces the previous path: two traces
    // between the same pads would be double copper. By connection it was
    // wrong: two branches from one pad of a net share the connection name,
    // and the second erased the first
    setRoutes((r) => [...r.filter((x) => manualRouteKey(x) !== manualRouteKey(route)), route]);
  }, []);

  const addUnlink = useCallback((declared: string) => {
    if (busyRef.current) return;
    setUnlinks((u) => (u.includes(declared) ? u : [...u, declared]));
  }, []);

  /** the schematic view emits one event at a time, when the drag ends */
  const pushPending = useCallback((event: EditEvent) => {
    if (event.in_progress || busyRef.current) return;
    setPending((p) => [...p, event]);
  }, []);

  /** runs one write at a time; a second call while one is in flight is dropped */
  const exclusive = useCallback(async (job: () => Promise<void>): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await job();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  /** after a write: the board follows. Its failure does not undo the write */
  const notifyApplied = useCallback(
    async (hint?: { structural?: boolean }) => {
      try {
        await onApplied(hint);
      } catch (err) {
        setError(
          `modifiche salvate, ma la scheda non si e' aggiornata: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    },
    [onApplied],
  );

  const write = useCallback(
    async (
      body: Record<string, unknown>,
      hint?: { structural?: boolean },
    ): Promise<ManualEdits | null> => {
      try {
        const res = await fetch("/api/manual-edits", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectId, ...body }),
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok || !d?.edits) throw new Error(d?.error ?? `HTTP ${res.status}`);
        commitSaved(d.edits as ManualEdits);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return null;
      }
      await notifyApplied(hint);
      return savedRef.current;
    },
    [projectId, commitSaved, notifyApplied],
  );

  /** writes a link (or removes it) inside main.tsx */
  const postConnection = useCallback(
    async (body: Record<string, unknown>): Promise<string | null> => {
      try {
        const res = await fetch("/api/schematic/connect", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectId, ...body }),
        });
        const d = await res.json().catch(() => ({}));
        return res.ok ? null : (d.error ?? `HTTP ${res.status}`);
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    },
    [projectId],
  );

  const dirty = pending.length + links.length + unlinks.length + routes.length;

  /**
   * Writes everything and recompiles once. Links go first: they change the
   * circuit, and it makes sense for the re-routing to start from the final
   * circuit rather than the in-between one.
   *
   * What is cleared afterwards is exactly what was SENT, by identity. Emptying
   * the lists wholesale also wiped whatever arrived while the request was in
   * flight, and those edits were never written anywhere.
   */
  const apply = useCallback(async () => {
    if (dirty === 0) return;
    const sentPending = pending;
    const sentRoutes = routes;
    const sentLinks = links;
    const sentUnlinks = unlinks;
    await exclusive(async () => {
      const problems: string[] = [];
      const failedUnlinks: string[] = [];
      const failedLinks: PendingLink[] = [];
      for (const declared of sentUnlinks) {
        const err = await postConnection({ declared });
        if (err) {
          problems.push(err);
          failedUnlinks.push(declared);
        }
      }
      for (const link of sentLinks) {
        const err = await postConnection({ from: link.from, to: link.to });
        if (err) {
          problems.push(`${link.from} → ${link.to}: ${err}`);
          failedLinks.push(link);
        }
      }
      if (problems.length > 0) setError(problems[0]);
      // links rejected by the server stay pending: throwing them away with the
      // others would force the user to redraw them without knowing why
      setLinks((l) => withoutSent(l, sentLinks, failedLinks));
      setUnlinks((u) => withoutSent(u, sentUnlinks, failedUnlinks));
      const circuitChanged = problems.length < sentLinks.length + sentUnlinks.length;

      if (sentPending.length > 0 || sentRoutes.length > 0) {
        // only the links (written into main.tsx) change the circuit and make
        // the board need recompiling: moves and hand-routed traces apply
        // locally, in a second, without a reroute-everything
        const structural = circuitChanged;
        // the state right before the write, read now: the last one this page
        // saw may be older than what the agent wrote since
        const before = (await readSaved()) ?? savedRef.current;
        const next = await write({ events: sentPending, routes: sentRoutes }, { structural });
        // on failure nothing is discarded: the hand-drawn traces stay pending,
        // they used to be dropped BEFORE the error check and vanished
        if (!next) return;
        setRoutes((r) => withoutSent(r, sentRoutes));
        setPending((p) => withoutSent(p, sentPending));
        setPast((p) => [...p, { before, after: next }].slice(-40));
        setFuture([]);
      } else if (circuitChanged) {
        // no moves to save, but the circuit has changed: recompile
        await notifyApplied({ structural: true });
      }
      setViewerKey((k) => k + 1);
    });
  }, [dirty, pending, links, unlinks, routes, exclusive, postConnection, readSaved, write, notifyApplied]);

  /**
   * Moves a saved step back (undo) or forward again (redo), relative to what
   * the server holds NOW. Posting the stored snapshot as it was overwrote
   * every pin and move saved in the meantime by the agent or another tab.
   */
  const travel = useCallback(
    async (step: HistoryStep, direction: "undo" | "redo"): Promise<boolean> => {
      const fresh = await readSaved();
      if (!fresh) {
        setError(
          `Non riesco a rileggere lo stato salvato: ${
            direction === "undo" ? "annulla" : "ripristina"
          } non eseguito, riprova`,
        );
        return false;
      }
      const result =
        direction === "undo"
          ? rebaseManualEdits(fresh, step.after, step.before)
          : rebaseManualEdits(fresh, step.before, step.after);
      if (!result.ok) {
        commitSaved(fresh);
        setError(conflictMessage(result.conflicts, direction === "undo" ? "annullare" : "ripristinare"));
        return false;
      }
      if (!result.changed) {
        commitSaved(fresh);
        return true;
      }
      return (await write({ action: "set", edits: result.edits }, { structural: true })) !== null;
    },
    [readSaved, commitSaved, write],
  );

  const undo = useCallback(async () => {
    if (busyRef.current) return;
    // undo in the reverse order of doing: links first, which are the last
    // thing drawn, then the moves
    if (routes.length > 0) {
      setRoutes((r) => r.slice(0, -1));
      return;
    }
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
    const step = past[past.length - 1];
    if (!step) return;
    await exclusive(async () => {
      if (!(await travel(step, "undo"))) return;
      setPast((p) => p.slice(0, -1));
      setFuture((f) => [step, ...f].slice(0, 40));
      setViewerKey((k) => k + 1);
    });
  }, [pending, links, unlinks, routes, past, exclusive, travel]);

  const redo = useCallback(async () => {
    const step = future[0];
    if (!step) return;
    await exclusive(async () => {
      if (!(await travel(step, "redo"))) return;
      setFuture((f) => f.slice(1));
      setPast((p) => [...p, step].slice(-40));
      setViewerKey((k) => k + 1);
    });
  }, [future, exclusive, travel]);

  /** throws away what has not been written yet */
  const discard = useCallback(() => {
    if (busyRef.current) return;
    setPending([]);
    setLinks([]);
    setUnlinks([]);
    setRoutes([]);
    setViewerKey((k) => k + 1);
  }, []);

  /** hands a component back to the automatic flow (or everything, with name null) */
  const release = useCallback(
    async (scope: "schematic" | "pcb" | "traces" | "all", name: string | null) => {
      await exclusive(async () => {
        const before = (await readSaved()) ?? savedRef.current;
        const next = await write({ action: "release", scope, name }, { structural: true });
        if (!next) return;
        setPast((p) => [...p, { before, after: next }].slice(-40));
        setFuture([]);
        setPending([]);
        setViewerKey((k) => k + 1);
      });
    },
    [exclusive, readSaved, write],
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
    routes,
    dirty,
    addRoute,
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
