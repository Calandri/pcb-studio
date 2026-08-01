"use client";

import { useCallback, useEffect, useState } from "react";
import {
  countManualEdits,
  emptyManualEdits,
  type EditEvent,
  type ManualEdits,
} from "@/lib/manual-edits";
import type { ManualRoute } from "@/lib/manual-routes";

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
 * a time, then they move back and forth among the already-saved states (each
 * of which requires rewriting the file and recompiling).
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
  const [past, setPast] = useState<ManualEdits[]>([]);
  const [future, setFuture] = useState<ManualEdits[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // viewers keep an internal drag state: to make an undone edit disappear
  // they must be remounted, changing the props is not enough
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

  /** the PCB view is controlled: it always passes the full list */
  const replacePending = useCallback((events: EditEvent[]) => {
    setPending(events.filter((e) => !e.in_progress));
  }, []);

  const addLink = useCallback((link: PendingLink) => {
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
    // redrawing the same connection replaces the previous path:
    // two traces on the same connection would be double copper
    setRoutes((r) => [...r.filter((x) => x.connection !== route.connection), route]);
  }, []);

  const addUnlink = useCallback((declared: string) => {
    setUnlinks((u) => (u.includes(declared) ? u : [...u, declared]));
  }, []);

  /** the schematic view emits one event at a time, when the drag ends */
  const pushPending = useCallback((event: EditEvent) => {
    if (event.in_progress) return;
    setPending((p) => [...p, event]);
  }, []);

  const post = useCallback(
    async (
      body: Record<string, unknown>,
      hint?: { structural?: boolean },
    ): Promise<ManualEdits | null> => {
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
        await onApplied(hint);
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

  /** writes a link (or removes it) inside main.tsx */
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

  const dirty = pending.length + links.length + unlinks.length + routes.length;

  /**
   * Writes everything and recompiles once. Links go first: they change the
   * circuit, and it makes sense for the re-routing to start from the final
   * circuit rather than the in-between one.
   */
  const apply = useCallback(async () => {
    if (dirty === 0 || busy) return;
    setBusy(true);
    setError(null);
    const problems: string[] = [];
    const failedUnlinks: string[] = [];
    const failedLinks: PendingLink[] = [];
    try {
      for (const declared of unlinks) {
        const err = await postConnection({ declared });
        if (err) {
          problems.push(err);
          failedUnlinks.push(declared);
        }
      }
      for (const link of links) {
        const err = await postConnection({ from: link.from, to: link.to });
        if (err) {
          problems.push(`${link.from} → ${link.to}: ${err}`);
          failedLinks.push(link);
        }
      }
    } finally {
      setBusy(false);
    }
    if (problems.length > 0) setError(problems[0]);
    // links rejected by the server stay pending: throwing them away with the
    // others would force the user to redraw them without knowing why
    setLinks(failedLinks);
    setUnlinks(failedUnlinks);

    const before = saved;
    if (pending.length > 0 || routes.length > 0) {
      // only the links (written into main.tsx) change the circuit and make
      // the board need recompiling: moves and hand-routed traces apply
      // locally, in a second, without a reroute-everything
      const structural = links.length > 0 || unlinks.length > 0;
      const next = await post({ events: pending, routes }, { structural });
      // on failure nothing is discarded: the hand-drawn traces stay pending,
      // they used to be dropped BEFORE the error check and vanished
      if (!next) return;
      setRoutes([]);
      setPast((p) => [...p, before].slice(-40));
      setFuture([]);
      setPending([]);
    } else {
      // no moves to save, but the circuit has changed: recompile
      await onApplied({ structural: true });
    }
    setViewerKey((k) => k + 1);
  }, [dirty, busy, pending, links, unlinks, routes, saved, post, postConnection, onApplied]);

  const undo = useCallback(async () => {
    if (busy) return;
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
    const previous = past[past.length - 1];
    if (!previous) return;
    const current = saved;
    const next = await post({ action: "set", edits: previous }, { structural: true });
    if (!next) return;
    setPast((p) => p.slice(0, -1));
    setFuture((f) => [current, ...f].slice(0, 40));
    setViewerKey((k) => k + 1);
  }, [busy, pending, links, unlinks, routes, past, saved, post]);

  const redo = useCallback(async () => {
    if (busy) return;
    const target = future[0];
    if (!target) return;
    const current = saved;
    const next = await post({ action: "set", edits: target }, { structural: true });
    if (!next) return;
    setFuture((f) => f.slice(1));
    setPast((p) => [...p, current].slice(-40));
    setViewerKey((k) => k + 1);
  }, [busy, future, saved, post]);

  /** throws away what has not been written yet */
  const discard = useCallback(() => {
    setPending([]);
    setLinks([]);
    setUnlinks([]);
    setRoutes([]);
    setViewerKey((k) => k + 1);
  }, []);

  /** hands a component back to the automatic flow (or everything, with name null) */
  const release = useCallback(
    async (scope: "schematic" | "pcb" | "traces" | "all", name: string | null) => {
      if (busy) return;
      const before = saved;
      const next = await post({ action: "release", scope, name }, { structural: true });
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
