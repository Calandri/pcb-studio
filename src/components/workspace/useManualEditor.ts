"use client";

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import {
  countManualEdits,
  emptyManualEdits,
  normalizeRotation,
  type EditEvent,
  type ManualEdits,
  type ManualPlacement,
  type PlacementPatch,
} from "@/lib/manual-edits";
import { manualRouteKey, type ManualRoute } from "@/lib/manual-routes";
import {
  senzaUltimoGesto,
  conflictMessage,
  rebaseManualEdits,
  withoutSent,
  type HistoryStep,
} from "./manual-history";

export type EditMode = "view" | "move" | "route" | "link";

/** what the board update after a write answers: a background save must not shout in the chat */
export type ApplyResult = { ok: boolean; reason?: string } | void;

/**
 * How long a dropped part waits before saving itself: long enough to take a
 * few nudges with the arrows in one write, short enough that a recompile
 * coming from elsewhere finds almost nothing unsaved.
 */
export const AUTOSAVE_MS = 400;

/** where the board on screen has a part: its origin, turn and face */
export type BoardPlacement = { x: number; y: number; rotation: number; layer: "top" | "bottom" };

/**
 * The board shows the part where the patch put it. To the thousandth of a
 * millimetre, which is what a placement keeps (round3); the turn and the face
 * only when the patch set them.
 */
export function boardAgrees(board: BoardPlacement | null, patch: PlacementPatch): boolean {
  if (!board) return false;
  if (Math.abs(board.x - patch.x) > 0.002 || Math.abs(board.y - patch.y) > 0.002) return false;
  if (patch.rotation !== undefined && normalizeRotation(board.rotation) !== normalizeRotation(patch.rotation)) return false;
  if (patch.layer !== undefined && board.layer !== patch.layer) return false;
  return true;
}

/** the file as this page knows it, with the placements the server just wrote */
export function withPlacements(edits: ManualEdits, written: readonly ManualPlacement[]): ManualEdits {
  const names = new Set(written.map((p) => p.selector));
  return {
    ...edits,
    pcb_placements: [...edits.pcb_placements.filter((p) => !names.has(p.selector)), ...written],
  };
}

/**
 * The moves a board makes useless: those of the parts whose every move is
 * written and whose last written position the board shows (or that were
 * written the old way, `null`). A part with a move still unsent or on its way
 * keeps all of them: its override is the newest thing there is.
 */
export function settledMoves(
  pending: readonly EditEvent[],
  isSent: (e: EditEvent) => boolean,
  writtenAs: WeakMap<EditEvent, PlacementPatch | null>,
  boardOf: (name: string) => BoardPlacement | null,
): Set<EditEvent> {
  const byPart = new Map<string, EditEvent[]>();
  for (const e of pending) {
    const k = partKey(e);
    byPart.set(k, [...(byPart.get(k) ?? []), e]);
  }
  const gone = new Set<EditEvent>();
  for (const events of byPart.values()) {
    if (events.some((e) => !isSent(e) || !writtenAs.has(e))) continue;
    const last = writtenAs.get(events[events.length - 1]);
    if (last === null || (last && boardAgrees(boardOf(last.name), last))) {
      for (const e of events) gone.add(e);
    }
  }
  return gone;
}

/** which part (or port) an event is about: the events of one part go together */
const partKey = (e: EditEvent): string =>
  `${e.edit_event_type ?? e.pcb_edit_event_type ?? ""}|${
    e.component_name ?? e.pcb_component_id ?? e.schematic_component_id ?? e.pcb_port_id ?? ""
  }`;

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
 *
 * MOVES SAVE THEMSELVES (2026-11-09). A part dropped on the board waits
 * AUTOSAVE_MS and is written in the background, by NAME, without locking the
 * canvas or remounting the view; then the board is updated on the fast path.
 * Before, moves stayed in the tab until "Applica": hours of them, and a
 * recompile from elsewhere in between was enough to land them on other parts.
 * A move being written or already written stays on screen as an override
 * until the board that contains it arrives, but it no longer counts as "not
 * applied" and it is never sent twice. Links, unlinks and hand-drawn traces
 * still wait for "Applica": they change the circuit.
 */
export function useManualEditor({
  projectId,
  onApplied,
  syncingRef,
  placementsOf,
}: {
  projectId: string;
  /**
   * Called after every successful write. `structural` says the circuit has
   * changed (links, hand-routed traces): a full compile is needed. Without it,
   * moves alone are enough and the fast path applies. `background` is the
   * automatic save: the answer comes back instead of going into the chat.
   */
  onApplied: (opts?: { structural?: boolean; background?: boolean }) => Promise<ApplyResult> | ApplyResult;
  /**
   * Raised while a background save is updating the board: whoever polls the
   * board must not read the "files newer than the board" of the instant
   * between the write and the update as a real stale board.
   */
  syncingRef?: MutableRefObject<boolean>;
  /**
   * The moves turned into the positions to write, read on the board ON SCREEN
   * (Studio knows it, this hook does not): absolute origins by name, which the
   * server stores as they are. What cannot be turned (a part with no origin on
   * the board, a schematic move) comes back in `rest` and goes the old way.
   */
  placementsOf?: (events: EditEvent[]) => { placements: PlacementPatch[]; rest: EditEvent[] };
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
  const [pastState, setPastState] = useState<HistoryStep[]>([]);
  /*
   * The steps NOW, kept in step with the state at every change: undo picks its
   * step right after waiting for a background save, before any render.
   */
  const pastRef = useRef<HistoryStep[]>([]);
  const setPast = useCallback((next: (p: HistoryStep[]) => HistoryStep[]) => {
    pastRef.current = next(pastRef.current);
    setPastState(pastRef.current);
  }, []);
  const past = pastState;
  const [future, setFuture] = useState<HistoryStep[]>([]);
  const [busy, setBusy] = useState(false);
  /*
   * Moves already sent (being written or written): they are never sent again
   * and do not count as "not applied". A WeakSet keyed by identity, never
   * emptied on success: an async path reading a list one render old must still
   * recognise them, or the displacement would be written twice. Taken out only
   * when the write fails, so that the next save retries them.
   */
  const sentRef = useRef<WeakSet<EditEvent>>(new WeakSet());
  /** the same, for drawing: bumped when sentRef changes */
  const [sentTick, setSentTick] = useState(0);
  const markSent = useCallback((events: readonly EditEvent[], sent: boolean) => {
    for (const e of events) {
      if (sent) sentRef.current.add(e);
      else sentRef.current.delete(e);
    }
    setSentTick((t) => t + 1);
  }, []);
  /** the background save in flight, if any: one write at a time */
  const autoJobRef = useRef<Promise<void> | null>(null);
  const autoAgainRef = useRef(false);
  /*
   * What each written move was written AS: the patch (or null, written the old
   * way). A move sent but not here is still on its way. A board that arrives
   * takes the override of a part away only when every move of that part is
   * written and the board shows the last one: an older board (a sync of the
   * previous move, a compile from elsewhere) used to take it away anyway and
   * the part jumped back under the cursor (tm-4l-r3, 2026-11-09).
   */
  const writtenAsRef = useRef<WeakMap<EditEvent, PlacementPatch | null>>(new WeakMap());
  /*
   * The board follows the saves on its own, one update at a time and after
   * them: a save is a few hundred bytes and never waits for the board.
   */
  const syncJobRef = useRef<Promise<void> | null>(null);
  const syncAgainRef = useRef(false);
  /** writes done, and writes the board had already seen when its last update started */
  const writesRef = useRef(0);
  const syncedWritesRef = useRef(0);
  /** the last background save went through: the bar says "salvato" */
  const [lastSaveOk, setLastSaveOk] = useState(false);
  /** the board is following the saves (syncBoard): the board that arrives is ours */
  const [syncing, setSyncing] = useState(false);
  /*
   * The list as it was when a background save failed: the same list does not
   * try again by itself (a refusal every second would hammer the server), a
   * new gesture or "Applica" does.
   */
  const autoFailedRef = useRef<EditEvent[] | null>(null);
  const [saving, setSaving] = useState(false);
  /** the latest list, for the async paths: the closure of a callback sees an older render */
  const pendingRef = useRef<EditEvent[]>([]);
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

  /*
   * A dropped part is taken ALWAYS, even while "Applica" or an undo is writing:
   * moves travel by name and land on whatever board comes next. Dropping them
   * while busy made the part jump back where it was, with nothing said.
   */
  const pushPending = useCallback((event: EditEvent) => {
    if (event.in_progress) return;
    const isMove =
      event.edit_event_type === "edit_pcb_component_location" ||
      event.edit_event_type === "edit_schematic_component_location";
    if (busyRef.current && !isMove) return;
    setLastSaveOk(false);
    setPending((p) => [...p, event]);
  }, []);

  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  /**
   * Runs one write at a time; a second call while one is in flight is dropped.
   * A background save already on its way is waited for: it carries moves this
   * write must not send again.
   */
  const exclusive = useCallback(async (job: () => Promise<void>): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      if (autoJobRef.current) await autoJobRef.current.catch(() => {});
      // and the board update in flight: two at once and the second one is refused
      if (syncJobRef.current) await syncJobRef.current.catch(() => {});
      await job();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  /** after a write: the board follows. Its failure does not undo the write */
  const notifyApplied = useCallback(
    async (hint?: { structural?: boolean; background?: boolean }): Promise<ApplyResult> => {
      try {
        return await onApplied(hint);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        setError(`modifiche salvate, ma la scheda non si e' aggiornata: ${reason}`);
        return { ok: false, reason };
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
      writesRef.current += 1;
      const seen = writesRef.current;
      await notifyApplied(hint);
      syncedWritesRef.current = seen;
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

  /*
   * Only what has not been sent counts: a move saved in the background is on
   * the file, and "Applica 3" for moves already written would be a lie.
   */
  const [unsentMoves, setUnsentMoves] = useState(0);
  useEffect(() => {
    setUnsentMoves(pending.filter((e) => !sentRef.current.has(e)).length);
  }, [pending, sentTick]);
  const dirty = unsentMoves + links.length + unlinks.length + routes.length;

  /** the moves on screen that are not written yet, read NOW */
  const unsentNow = useCallback(
    () => pendingRef.current.filter((e) => !sentRef.current.has(e)),
    [],
  );
  /** every written move goes, whatever the board: undo, redo and Applica, which rewrite the file on purpose */
  const dropSent = useCallback(() => {
    setPending((p) => {
      const left = p.filter((e) => !sentRef.current.has(e));
      return left.length === p.length ? p : left;
    });
  }, []);

  /**
   * A board has arrived: the overrides it makes useless go, and only those. A
   * part keeps its override while one of its moves is not written yet, or while
   * the board does not show the last one written (see writtenAsRef). The moves
   * written the old way go as soon as they are written, as before.
   */
  const dropAgreed = useCallback((boardOf: (name: string) => BoardPlacement | null) => {
    setPending((p) => {
      const gone = settledMoves(p, (e) => sentRef.current.has(e), writtenAsRef.current, boardOf);
      return gone.size === 0 ? p : p.filter((e) => !gone.has(e));
    });
  }, []);

  /** raised from the first write until the board has followed the last one: see syncingRef */
  const refreshSyncing = useCallback(() => {
    if (!syncingRef) return;
    syncingRef.current =
      autoJobRef.current !== null || syncJobRef.current !== null || syncedWritesRef.current !== writesRef.current;
  }, [syncingRef]);

  /**
   * The board follows the saved positions: the fast path on the server, then
   * the board reloaded. One at a time, the latest wins, never inside a save: a
   * drop is saved in a few hundred milliseconds whatever the board costs.
   */
  const syncRef = useRef<() => void>(() => {});
  const syncBoard = useCallback(() => {
    if (syncJobRef.current) {
      syncAgainRef.current = true;
      return;
    }
    const seen = writesRef.current;
    const job = (async () => {
      const r = await notifyApplied({ background: true });
      syncedWritesRef.current = seen;
      if (r && r.ok === false) {
        // written, but the board on screen is the old one: the overrides stay
        // until a board that shows them arrives (Aggiorna, a recompile)
        setError(
          `spostamenti salvati, ma la scheda non si e' aggiornata${
            r.reason ? ` (${r.reason})` : ""
          }: premi Aggiorna`,
        );
      }
    })().finally(() => {
      syncJobRef.current = null;
      if (syncAgainRef.current) {
        syncAgainRef.current = false;
        syncRef.current();
      } else {
        setSyncing(false);
      }
      refreshSyncing();
    });
    syncJobRef.current = job;
    setSyncing(true);
    refreshSyncing();
  }, [notifyApplied, refreshSyncing]);
  useEffect(() => {
    syncRef.current = syncBoard;
  }, [syncBoard]);

  /**
   * Writes these moves. The positions dragged on the board go as absolute
   * patches by name (`placementsOf`): a few hundred bytes, no board read on the
   * server, last write wins per part. What cannot be a patch goes the old way.
   * The undo step is made of exactly what the patches replaced, as the server
   * answered, without reading the whole file back. False if a write failed.
   */
  const saveMoves = useCallback(
    async (batch: EditEvent[]): Promise<boolean> => {
      const { placements, rest } = placementsOf ? placementsOf(batch) : { placements: [], rest: batch };
      const restSet = new Set(rest);
      if (placements.length > 0) {
        const res = await fetch("/api/manual-edits", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectId, action: "place", placements }),
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok || !Array.isArray(d?.placements)) throw new Error(d?.error ?? `HTTP ${res.status}`);
        const written = d.placements as ManualPlacement[];
        const replaced = (Array.isArray(d.before) ? d.before : []) as Array<{ placement: ManualPlacement | null }>;
        commitSaved(withPlacements(savedRef.current, written));
        const empty = emptyManualEdits();
        setPast((p) =>
          [
            ...p,
            {
              before: { ...empty, pcb_placements: replaced.flatMap((b) => (b.placement ? [b.placement] : [])) },
              after: { ...empty, pcb_placements: written },
            },
          ].slice(-40),
        );
        const byName = new Map(placements.map((pl) => [pl.name, pl]));
        for (const e of batch) {
          if (restSet.has(e)) continue;
          const patch = e.component_name ? byName.get(e.component_name) : undefined;
          if (patch) writtenAsRef.current.set(e, patch);
        }
        writesRef.current += 1;
      }
      if (rest.length > 0) {
        const before = (await readSaved()) ?? savedRef.current;
        const res = await fetch("/api/manual-edits", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectId, events: rest }),
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok || !d?.edits) throw new Error(d?.error ?? `HTTP ${res.status}`);
        const next = d.edits as ManualEdits;
        commitSaved(next);
        setPast((p) => [...p, { before, after: next }].slice(-40));
        for (const e of rest) writtenAsRef.current.set(e, null);
        writesRef.current += 1;
      }
      setFuture([]);
      return true;
    },
    [placementsOf, projectId, commitSaved, setPast, readSaved],
  );

  /**
   * The background save: what is not written yet goes, by name, and the board
   * follows afterwards (syncBoard). Nothing locks the canvas and the view is
   * not remounted: the person keeps dragging while it writes, and what is
   * dropped meanwhile goes with the next round, with its latest position.
   */
  const autoSaveRef = useRef<() => void>(() => {});
  const autoSave = useCallback(() => {
    // an explicit write is running: it takes the moves itself, or reschedules after
    if (busyRef.current) return;
    if (autoJobRef.current) {
      autoAgainRef.current = true;
      return;
    }
    const batch = unsentNow();
    if (batch.length === 0) return;
    markSent(batch, true);
    setSaving(true);
    let failed = false;
    const job = (async () => {
      try {
        await saveMoves(batch);
      } catch (err) {
        failed = true;
        // nothing is thrown away: they go back to "not applied" and the next gesture retries them
        autoFailedRef.current = pendingRef.current;
        markSent(batch, false);
        setLastSaveOk(false);
        setError(
          `salvataggio automatico non riuscito: ${
            err instanceof Error ? err.message : String(err)
          }. Riprova con Applica`,
        );
        return;
      }
      setError(null);
      setLastSaveOk(true);
    })().finally(() => {
      autoJobRef.current = null;
      setSaving(false);
      const again = autoAgainRef.current;
      autoAgainRef.current = false;
      // what was dropped meanwhile goes now, with its latest position; after a
      // failure nothing retries by itself (a new gesture or Applica does)
      if (!failed && (again || unsentNow().length > 0)) {
        autoSaveRef.current();
      } else if (syncedWritesRef.current !== writesRef.current) {
        // nothing left to write: now the board
        syncRef.current();
      }
      refreshSyncing();
    });
    autoJobRef.current = job;
    refreshSyncing();
  }, [unsentNow, markSent, saveMoves, refreshSyncing]);
  useEffect(() => {
    autoSaveRef.current = autoSave;
  }, [autoSave]);

  // a part dropped (or nudged): AUTOSAVE_MS of quiet and it saves itself
  useEffect(() => {
    if (busy || unsentMoves === 0 || autoFailedRef.current === pending) return;
    const t = setTimeout(() => autoSaveRef.current(), AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [pending, unsentMoves, busy]);

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
    const sentRoutes = routes;
    const sentLinks = links;
    const sentUnlinks = unlinks;
    await exclusive(async () => {
      // read after the background save in flight has finished: it may have taken some
      const sentPending = unsentNow();
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

      // only the links (written into main.tsx) change the circuit and make
      // the board need recompiling: moves and hand-routed traces apply
      // locally, in a second, without a reroute-everything
      const structural = circuitChanged;
      if (sentPending.length > 0) {
        markSent(sentPending, true);
        try {
          await saveMoves(sentPending);
        } catch (err) {
          // nothing is discarded: they stay "not applied"
          markSent(sentPending, false);
          setError(err instanceof Error ? err.message : String(err));
          return;
        }
      }
      if (sentRoutes.length > 0) {
        // the state right before the write, read now: the last one this page
        // saw may be older than what the agent wrote since
        const before = (await readSaved()) ?? savedRef.current;
        const next = await write({ events: [], routes: sentRoutes }, { structural });
        // on failure nothing is discarded: the hand-drawn traces stay pending,
        // they used to be dropped BEFORE the error check and vanished
        if (!next) return;
        setRoutes((r) => withoutSent(r, sentRoutes));
        setPast((p) => [...p, { before, after: next }].slice(-40));
        setFuture([]);
      } else if (sentPending.length > 0 || circuitChanged || syncedWritesRef.current !== writesRef.current) {
        const seen = writesRef.current;
        await notifyApplied({ structural });
        syncedWritesRef.current = seen;
      }
      /*
       * No dropSent here: the overrides go when the board that SHOWS them
       * arrives (dropAgreed, from the page). Dropping them after any write
       * put the parts back where the old board had them whenever the board
       * could not follow, and the person saw the move undone.
       */
      setViewerKey((k) => k + 1);
    });
  }, [dirty, links, unlinks, routes, exclusive, postConnection, readSaved, write, notifyApplied, unsentNow, markSent, saveMoves, setPast]);

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
    const unsent = pending.filter((e) => !sentRef.current.has(e));
    if (unsent.length > 0) {
      // a gesture on many parts (same gruppo) is undone in one go, like it was done
      const keep = new Set(senzaUltimoGesto(unsent));
      const gone = unsent.filter((e) => !keep.has(e));
      setPending((p) => withoutSent(p, gone));
      setViewerKey((k) => k + 1);
      return;
    }
    await exclusive(async () => {
      // after the background save in flight: its step is the last one to undo
      const step = pastRef.current[pastRef.current.length - 1];
      if (!step) return;
      if (!(await travel(step, "undo"))) return;
      setPast((p) => p.slice(0, -1));
      setFuture((f) => [step, ...f].slice(0, 40));
      dropSent();
      setViewerKey((k) => k + 1);
    });
  }, [pending, links, unlinks, routes, exclusive, travel, dropSent, setPast]);

  const redo = useCallback(async () => {
    const step = future[0];
    if (!step) return;
    await exclusive(async () => {
      if (!(await travel(step, "redo"))) return;
      setFuture((f) => f.slice(1));
      setPast((p) => [...p, step].slice(-40));
      dropSent();
      setViewerKey((k) => k + 1);
    });
  }, [future, exclusive, travel, dropSent, setPast]);

  /** throws away what has not been written yet: what is already on the file stays on screen */
  const discard = useCallback(() => {
    if (busyRef.current) return;
    setPending((p) => p.filter((e) => sentRef.current.has(e)));
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
    [exclusive, readSaved, write, setPast],
  );

  const counts = countManualEdits(saved);

  return {
    mode,
    setMode,
    pending,
    saved,
    counts,
    busy,
    /** a background save is writing (the canvas stays free) */
    saving,
    /**
     * For the bar, never blocking: "attesa" a move waits its AUTOSAVE_MS,
     * "salvo" it is being written, "salvato" the last one is on the server.
     */
    saveState: (saving ? "salvo" : unsentMoves > 0 ? "attesa" : lastSaveOk && !error ? "salvato" : null) as
      | "attesa"
      | "salvo"
      | "salvato"
      | null,
    /** a board arrived (a sync, a recompile, a compile from elsewhere): the overrides it shows go */
    dropAgreed,
    /** the board on screen is being brought up to the saved moves: what arrives meanwhile is ours */
    syncing,
    error,
    viewerKey,
    links,
    unlinks,
    routes,
    dirty,
    addRoute,
    addLink,
    addUnlink,
    canUndo: dirty > 0 || past.length > 0 || saving,
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
