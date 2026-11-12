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
import type { RameInAttesa } from "../board/gesto-del-rame";
import { schedaMostraIlRame } from "./rame-in-attesa";
import {
  senzaUltimoGesto,
  conflictMessage,
  partStates,
  placeRequest,
  rebaseManualEdits,
  routesRequest,
  withPartStates,
  withRoutes,
  withoutSent,
  HISTORY_MAX,
  type EditorStep,
  type HistoryStep,
  type PartState,
  type RemovedTrace,
} from "./manual-history";

export type EditMode = "view" | "move" | "route" | "link";

/** what the board update after a write answers: a background save must not shout in the chat */
/**
 * `needsCompile`: the board cannot follow by itself (the code changed, a part
 * was let go, a part turned to the other face) and only "Aggiorna" brings it.
 * Without it a failure is of the moment, and the page tries again by itself.
 */
export type ApplyResult = { ok: boolean; reason?: string; needsCompile?: boolean } | void;

/**
 * How long a dropped part waits before saving itself: long enough to take a
 * few nudges with the arrows in one write, short enough that a recompile
 * coming from elsewhere finds almost nothing unsaved.
 */
export const AUTOSAVE_MS = 400;

/**
 * Where the board on screen has a part: its origin (null when the board does
 * not say), its centre, turn and face.
 */
export type BoardPlacement = {
  x: number | null;
  y: number | null;
  cx?: number;
  cy?: number;
  rotation: number;
  layer: "top" | "bottom";
};

/**
 * What a written move expects to see on the next board: the patch it wrote
 * (its origin), or, for a part sent back to where the code puts it, the
 * centre it had there. null: written the old way, settled by any board.
 */
export type WrittenAs = PlacementPatch | { name: string; center: { x: number; y: number }; rotation: number } | null;

/**
 * The board shows the part where the patch put it. To the thousandth of a
 * millimetre, which is what a placement keeps (round3); the turn and the face
 * only when the patch set them.
 */
export function boardAgrees(board: BoardPlacement | null, patch: Exclude<WrittenAs, null>): boolean {
  if (!board) return false;
  if ("center" in patch) {
    if (board.cx === undefined || board.cy === undefined) return false;
    if (Math.abs(board.cx - patch.center.x) > 0.01 || Math.abs(board.cy - patch.center.y) > 0.01) return false;
    return normalizeRotation(board.rotation) === normalizeRotation(patch.rotation);
  }
  if (board.x === null || board.y === null) return false;
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
  writtenAs: WeakMap<EditEvent, WrittenAs>,
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
 * and apply to compilation.
 *
 * MOVES SAVE THEMSELVES (2026-11-09). A part dropped on the board waits
 * AUTOSAVE_MS and is written in the background, by NAME, as an absolute
 * patch; then the board follows on the fast path. A move being written or
 * already written stays on screen as an override until a board that shows it
 * arrives (dropAgreed). Links, unlinks and hand-drawn traces still wait for
 * "Applica": they change the circuit.
 *
 * COPPER DRAGGED IN SPOSTA SAVES ITSELF TOO (2026-11-12): a via with its
 * traces, a stretch of a trace (lib/spinta). A gesture let go stays on screen
 * where it was left, waits the same AUTOSAVE_MS and is written with ONE
 * `copper` save, which the server checks against the saved board; then the
 * board follows on the fast path, and the gesture leaves the screen when a
 * board that shows it arrives. Refused, it goes at once: the copper is back
 * where it was and the bar says why. One gesture is one step of the history,
 * the file before and after it (see travel).
 *
 * ONE QUEUE, IN ORDER (2026-11-10). Every write of the editor (a save, an
 * undo, a redo, Applica, a release) goes through one queue, one at a time, in
 * the order the person asked for them. Cmd+Z is never dropped: pressed five
 * times, it undoes five steps, each one as soon as the one before is written.
 *
 * UNDO SAYS WHAT CHANGED. Each step keeps exactly what it touched (the parts
 * with their state before and after, the traces written, the trace detached)
 * and undo sends only that: the parts back on screen at once, the same small
 * write as a drag, the board following afterwards. The history keeps
 * HISTORY_MAX steps each way, and a save or a board arriving does not touch it.
 */
export function useManualEditor({
  projectId,
  onApplied,
  syncingRef,
  placementsOf,
  reloadBoard,
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
  /** reloads the saved board: after a detached trace is put back (or detached again) */
  reloadBoard?: () => Promise<void> | void;
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
   * The copper gestures on screen: let go, being written, or written and not
   * on the saved board yet. The list NOW in the ref, like the steps below: the
   * queue reads it when its turn comes. Which ones were sent and which are
   * written is kept by identity, like the moves (sentRef).
   */
  const copperRef = useRef<RameInAttesa[]>([]);
  const [copper, setCopperState] = useState<RameInAttesa[]>([]);
  const copperSentRef = useRef<WeakSet<RameInAttesa>>(new WeakSet());
  const copperWrittenRef = useRef<WeakSet<RameInAttesa>>(new WeakSet());
  /** gestures that came back with a redo: saving them is not a new step, the rest of the redo stays */
  const copperRedoneRef = useRef<WeakSet<RameInAttesa>>(new WeakSet());
  /** the save of the gestures is already in the queue: one let go meanwhile rides with it */
  const copperQueuedRef = useRef(false);
  const [unsentCopper, setUnsentCopper] = useState(0);
  const setCopper = useCallback((next: (c: RameInAttesa[]) => RameInAttesa[]) => {
    copperRef.current = next(copperRef.current);
    setCopperState(copperRef.current);
    setUnsentCopper(copperRef.current.filter((g) => !copperSentRef.current.has(g)).length);
  }, []);
  /*
   * The steps NOW, kept in step with the state at every change: a queued undo
   * picks its step when its turn comes, after the writes before it, not when
   * the key was pressed.
   */
  const pastRef = useRef<EditorStep[]>([]);
  const futureRef = useRef<EditorStep[]>([]);
  const [past, setPastState] = useState<EditorStep[]>([]);
  const [future, setFutureState] = useState<EditorStep[]>([]);
  const setPast = useCallback((next: (p: EditorStep[]) => EditorStep[]) => {
    pastRef.current = next(pastRef.current).slice(-HISTORY_MAX);
    setPastState(pastRef.current);
  }, []);
  const setFuture = useCallback((next: (f: EditorStep[]) => EditorStep[]) => {
    futureRef.current = next(futureRef.current).slice(0, HISTORY_MAX);
    setFutureState(futureRef.current);
  }, []);
  /** a new step done by the person: what could be redone is gone */
  const pushStep = useCallback(
    (step: EditorStep) => {
      setPast((p) => [...p, step]);
      setFuture(() => []);
    },
    [setPast, setFuture],
  );
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
  /*
   * What each written move was written AS (see WrittenAs). A move sent but not
   * here is still on its way. A board that arrives takes the override of a
   * part away only when every move of that part is written and the board shows
   * the last one: an older board (a sync of the previous move, a compile from
   * elsewhere) used to take it away anyway and the part jumped back under the
   * cursor (tm-4l-r3, 2026-11-09).
   */
  const writtenAsRef = useRef<WeakMap<EditEvent, WrittenAs>>(new WeakMap());
  /** the queue of writes: see "ONE QUEUE, IN ORDER" above */
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const queuedRef = useRef(0);
  const [queued, setQueued] = useState(0);
  /** an automatic save is already in the queue: a new drop rides with it */
  const autoQueuedRef = useRef(false);
  /** moves that came back with a redo: saving them is not a new step, the rest of the redo stays */
  const redoneRef = useRef<WeakSet<EditEvent>>(new WeakSet());
  /*
   * The board follows the saves on its own, one update at a time and after
   * them: a save is a few hundred bytes and never waits for the board.
   */
  const syncJobRef = useRef<Promise<void> | null>(null);
  const syncAgainRef = useRef(false);
  /** the error on the bar is the one of a board update that could not be done: it goes when one succeeds */
  const syncErrorRef = useRef<string | null>(null);
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
  /** the latest list, for the async paths: the closure of a callback sees an older render */
  const pendingRef = useRef<EditEvent[]>([]);
  /*
   * Applica and release are explicit writes: while one is in the queue, links
   * and traces wait (they speak in pad ids of the board being replaced). Moves
   * and undo do not wait for anything.
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

  /** after a write: the board follows. Its failure does not undo the write */
  const notifyApplied = useCallback(
    async (hint?: { structural?: boolean; background?: boolean }): Promise<ApplyResult> => {
      // the copper written before this update started: the board that comes back has it, laid or taken back by an undo
      const written = copperRef.current.filter((g) => copperWrittenRef.current.has(g));
      try {
        const r = await onApplied(hint);
        if (written.length > 0 && !(r && r.ok === false)) setCopper((c) => withoutSent(c, written));
        return r;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        setError(`modifiche salvate, ma la scheda non si e' aggiornata: ${reason}`);
        return { ok: false, reason };
      }
    },
    [onApplied, setCopper],
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

  /**
   * The same for copper: a board has arrived, and the gestures written that it
   * shows leave the screen (see schedaMostraIlRame). A board that arrives from
   * elsewhere does it too, e.g. "Aggiorna" after a fast update that could not
   * be done.
   */
  const dropShownCopper = useCallback(
    (circuitJson: readonly unknown[]) => {
      if (copperRef.current.length === 0) return;
      const shown = copperRef.current.filter(
        (g) => copperWrittenRef.current.has(g) && schedaMostraIlRame(circuitJson, g.salvataggio),
      );
      if (shown.length > 0) setCopper((c) => withoutSent(c, shown));
    },
    [setCopper],
  );

  /** raised from the first write until the board has followed the last one: see syncingRef */
  const refreshSyncing = useCallback(() => {
    if (!syncingRef) return;
    syncingRef.current =
      queuedRef.current > 0 || syncJobRef.current !== null || syncedWritesRef.current !== writesRef.current;
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
        const text = r.needsCompile
          ? `spostamenti salvati, la scheda li mostra dopo Aggiorna${r.reason ? `: ${r.reason}` : ""}`
          : `spostamenti salvati, la scheda non li ha ancora seguiti${
              r.reason ? ` (${r.reason})` : ""
            }: riprovo da solo`;
        syncErrorRef.current = text;
        setError(text);
      } else if (syncErrorRef.current !== null) {
        // the board has followed: the warning of the update that could not be done is over,
        // and only that one (a save that failed meanwhile keeps its own words)
        const mine = syncErrorRef.current;
        syncErrorRef.current = null;
        setError((now) => (now === mine ? null : now));
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
   * The same update, asked from outside: the page found the saved board behind
   * the hand positions (a compile that ended on older ones, an update that
   * lost its turn). Not while a write is in the queue or an explicit one runs:
   * those bring the board along themselves when they are done.
   */
  const followBoard = useCallback(() => {
    if (queuedRef.current > 0 || busyRef.current) return;
    syncRef.current();
  }, []);

  /** after the queue is empty: drops waiting go, then the board follows */
  const autoSaveRef = useRef<() => void>(() => {});
  const afterQueue = useCallback(() => {
    if (queuedRef.current > 0) return;
    if (syncedWritesRef.current !== writesRef.current) syncRef.current();
  }, []);

  /**
   * Puts a write in the queue: it runs after every write asked before it. A
   * failure is the job's own business (it says so); the queue goes on.
   */
  const enqueue = useCallback(
    (job: () => Promise<void>): Promise<void> => {
      queuedRef.current += 1;
      setQueued(queuedRef.current);
      refreshSyncing();
      const run = queueRef.current
        .then(job)
        .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
        .finally(() => {
          queuedRef.current -= 1;
          setQueued(queuedRef.current);
          afterQueue();
          refreshSyncing();
        });
      queueRef.current = run;
      return run;
    },
    [afterQueue, refreshSyncing],
  );

  /**
   * An explicit write (Applica, release): in the queue like the others, after
   * the board update in flight (two at once and the second one is refused),
   * with the links and traces held while it runs.
   */
  const exclusive = useCallback(
    async (job: () => Promise<void>): Promise<void> => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setError(null);
      try {
        await enqueue(async () => {
          if (syncJobRef.current) await syncJobRef.current.catch(() => {});
          await job();
        });
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [enqueue],
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

  /** one small write of manual-edits.json: the answer, or an error with the server's words */
  const post = useCallback(
    async (body: Record<string, unknown>, url = "/api/manual-edits"): Promise<Record<string, unknown>> => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, ...body }),
      });
      const d = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || d.ok === false || d.error) throw new Error(String(d.error ?? `HTTP ${res.status}`));
      return d;
    },
    [projectId],
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

  /**
   * Writes these moves. The positions dragged on the board go as absolute
   * patches by name (`placementsOf`): a few hundred bytes, no board read on the
   * server, last write wins per part. What cannot be a patch goes the old way.
   * The undo step is made of exactly what the patches replaced, as the server
   * answered, without reading the whole file back.
   */
  const saveMoves = useCallback(
    async (batch: EditEvent[]): Promise<void> => {
      const { placements, rest } = placementsOf ? placementsOf(batch) : { placements: [], rest: batch };
      const restSet = new Set(rest);
      if (placements.length > 0) {
        const d = await post({ action: "place", placements });
        if (!Array.isArray(d.placements)) throw new Error("risposta senza posizioni");
        const written = d.placements as ManualPlacement[];
        const replaced = (Array.isArray(d.before) ? d.before : []) as Array<{
          selector: string;
          placement: ManualPlacement | null;
        }>;
        commitSaved(withPlacements(savedRef.current, written));
        const states = partStates(batch, placements.map((p) => p.name), replaced, written);
        if (states.before.length > 0) {
          const redone = batch.every((e) => redoneRef.current.has(e));
          if (redone) setPast((p) => [...p, { kind: "pezzi", ...states }]);
          else pushStep({ kind: "pezzi", ...states });
        }
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
        const d = await post({ events: rest });
        if (!d.edits) throw new Error("risposta senza il file");
        const next = d.edits as ManualEdits;
        commitSaved(next);
        pushStep({ kind: "file", before, after: next });
        for (const e of rest) writtenAsRef.current.set(e, null);
        writesRef.current += 1;
      }
    },
    [placementsOf, post, commitSaved, pushStep, setPast, readSaved],
  );

  /**
   * The background save: what is not written yet goes, by name, and the board
   * follows afterwards (syncBoard). Nothing locks the canvas and the view is
   * not remounted: the person keeps dragging while it writes, and what is
   * dropped meanwhile goes with the next round, with its latest position.
   */
  const autoSave = useCallback(() => {
    // an explicit write is in the queue: it takes the moves itself, or the effect reschedules after
    if (busyRef.current || autoQueuedRef.current) return;
    if (unsentNow().length === 0) return;
    autoQueuedRef.current = true;
    void enqueue(async () => {
      autoQueuedRef.current = false;
      // the batch is what is unsent when its turn comes: an undo before it may have taken some
      const batch = unsentNow();
      if (batch.length === 0) return;
      markSent(batch, true);
      try {
        await saveMoves(batch);
      } catch (err) {
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
      // what was dropped meanwhile goes right after, with its latest position
      if (unsentNow().length > 0) autoSaveRef.current();
    });
  }, [unsentNow, markSent, saveMoves, enqueue]);
  useEffect(() => {
    autoSaveRef.current = autoSave;
  }, [autoSave]);

  // a part dropped (or nudged): AUTOSAVE_MS of quiet and it saves itself
  useEffect(() => {
    if (busy || unsentMoves === 0 || autoFailedRef.current === pending) return;
    const t = setTimeout(() => autoSaveRef.current(), AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [pending, unsentMoves, busy]);

  /** a copper gesture let go in Sposta: on screen at once, written after the same quiet as a part */
  const addCopper = useCallback(
    (gesto: RameInAttesa) => {
      setLastSaveOk(false);
      setCopper((c) => [...c, gesto]);
    },
    [setCopper],
  );

  /**
   * Writes the copper gestures not sent yet: ONE `copper` save each, in the
   * order they were made, in the queue like every other write; the board
   * follows afterwards (syncBoard), with no compile. The step of the history
   * is the file before and after the save, both read from the server: the
   * server rewrites what it is sent (a correction moved again keeps its start,
   * the ones the files absorbed leave), so the page cannot work it out.
   */
  const saveCopper = useCallback(() => {
    if (copperQueuedRef.current) return;
    copperQueuedRef.current = true;
    void enqueue(async () => {
      copperQueuedRef.current = false;
      // what is unsent when its turn comes: an undo before it may have taken a gesture back
      for (const g of copperRef.current.filter((x) => !copperSentRef.current.has(x))) {
        copperSentRef.current.add(g);
        setCopper((c) => c);
        const before = (await readSaved()) ?? savedRef.current;
        try {
          const { routes, vias, riscritte } = g.salvataggio;
          await post({ action: "copper", gesto: g.gesto, routes, vias, riscritte });
        } catch (err) {
          // refused (the board changed, a distance broken) or not written: the gesture goes, the copper is back where it was
          setCopper((c) => withoutSent(c, [g]));
          setLastSaveOk(false);
          setError(err instanceof Error ? err.message : String(err));
          continue;
        }
        copperWrittenRef.current.add(g);
        writesRef.current += 1;
        const after = await readSaved();
        if (!after) {
          setError("rame salvato, ma non riesco a rileggere lo stato salvato: questo gesto non si annulla da qui");
          continue;
        }
        commitSaved(after);
        const step: EditorStep = { kind: "file", before, after };
        if (copperRedoneRef.current.has(g)) setPast((p) => [...p, step]);
        else pushStep(step);
        setError(null);
        setLastSaveOk(true);
      }
    });
  }, [enqueue, setCopper, readSaved, post, commitSaved, pushStep, setPast]);

  // a copper gesture let go: AUTOSAVE_MS of quiet, like a part, and it saves itself
  useEffect(() => {
    if (unsentCopper === 0) return;
    const t = setTimeout(saveCopper, AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [copper, unsentCopper, saveCopper]);

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
        /*
         * The traces go by their key, with what they replace coming back for
         * undo: the same small write as a part. They used to travel with the
         * whole file both ways (326 KB with 821 traces on tm-4l-r3).
         */
        try {
          const d = await post({ action: "routes", add: sentRoutes });
          const added = (Array.isArray(d.added) ? d.added : []) as ManualRoute[];
          const replaced = (Array.isArray(d.replaced) ? d.replaced : []) as ManualRoute[];
          commitSaved(withRoutes(savedRef.current, added, []));
          pushStep({ kind: "piste", before: replaced, after: added });
          writesRef.current += 1;
        } catch (err) {
          // on failure nothing is discarded: the hand-drawn traces stay pending
          setError(err instanceof Error ? err.message : String(err));
          return;
        }
        setRoutes((r) => withoutSent(r, sentRoutes));
      }
      if (sentPending.length > 0 || sentRoutes.length > 0 || circuitChanged || syncedWritesRef.current !== writesRef.current) {
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
  }, [dirty, links, unlinks, routes, exclusive, postConnection, notifyApplied, unsentNow, markSent, saveMoves, post, commitSaved, pushStep]);

  /**
   * A step of the whole file back (undo) or forward again (redo), relative to
   * what the server holds NOW. Posting the stored snapshot as it was overwrote
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

  /**
   * Brings the parts to these states: on screen at once (an override per part,
   * like a drag), then the same small write as a drag. The override goes when
   * a board shows the part there.
   */
  const placeParts = useCallback(
    async (states: readonly PartState[]): Promise<void> => {
      const events: EditEvent[] = states.map((s) => ({
        edit_event_type: "edit_pcb_component_location",
        component_name: s.selector,
        original_center: s.center,
        new_center: s.center,
        new_rotation: s.rotation,
        new_layer: s.layer,
      }));
      markSent(events, true);
      setPending((p) => [...p, ...events]);
      try {
        const { placements, remove } = placeRequest(states);
        await post({ action: "place", placements, remove });
      } catch (err) {
        setPending((p) => withoutSent(p, events));
        throw err;
      }
      commitSaved(withPartStates(savedRef.current, states));
      const byName = new Map(placeRequest(states).placements.map((p) => [p.name, p]));
      for (const [i, s] of states.entries()) {
        writtenAsRef.current.set(
          events[i],
          byName.get(s.selector) ?? { name: s.selector, center: s.center, rotation: s.rotation },
        );
      }
      writesRef.current += 1;
    },
    [markSent, post, commitSaved],
  );

  /** a detached trace back on the board (undo), or detached again (redo) */
  const traceStep = useCallback(
    async (step: Extract<EditorStep, { kind: "staccata" }>, direction: "undo" | "redo"): Promise<void> => {
      if (direction === "undo") {
        await post({ action: "restore", routes: step.removed.routes, elements: step.removed.elements }, "/api/trace");
        commitSaved(withRoutes(savedRef.current, step.removed.routes, []));
      } else {
        const d = await post({ action: "delete", pcbTraceId: step.traceId }, "/api/trace");
        const removed = d.removed as RemovedTrace | undefined;
        if (removed) step.removed = removed;
        commitSaved(withRoutes(savedRef.current, [], step.removed.routes.map(manualRouteKey)));
      }
      await reloadBoard?.();
    },
    [post, commitSaved, reloadBoard],
  );

  /** runs one saved step the given way; false if it could not be written */
  const runStep = useCallback(
    async (step: EditorStep, direction: "undo" | "redo"): Promise<boolean> => {
      try {
        if (step.kind === "pezzi") {
          await placeParts(direction === "undo" ? step.before : step.after);
        } else if (step.kind === "piste") {
          const { add, remove } = routesRequest(step, direction);
          await post({ action: "routes", add, remove });
          commitSaved(withRoutes(savedRef.current, add, remove));
          writesRef.current += 1;
        } else if (step.kind === "staccata") {
          await traceStep(step, direction);
        } else if (step.kind === "file") {
          return await travel(step, direction);
        }
        setError(null);
        return true;
      } catch (err) {
        setError(
          `${direction === "undo" ? "Annulla" : "Ripristina"} non riuscito: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return false;
      }
    },
    [placeParts, post, commitSaved, traceStep, travel],
  );

  /** a detached trace becomes a step: Cmd+Z puts it back */
  const recordDetached = useCallback(
    (traceId: string, removed: RemovedTrace) => {
      pushStep({ kind: "staccata", traceId, removed });
    },
    [pushStep],
  );

  /**
   * Cmd+Z. What is only on screen goes back at once (a trace drawn, a link, a
   * gesture not saved yet); a saved step is undone in the queue, after the
   * writes before it, and never dropped: pressed again while one is running, it
   * undoes the next one.
   */
  const undo = useCallback(() => {
    // a copper gesture not sent yet is under AUTOSAVE_MS old, the last thing done: it goes back at once, nothing is written
    const unsentRame = copperRef.current.filter((g) => !copperSentRef.current.has(g));
    if (unsentRame.length > 0) {
      const last = unsentRame[unsentRame.length - 1];
      setCopper((c) => withoutSent(c, [last]));
      setFuture((f) => [{ kind: "rame", gesto: last }, ...f]);
      return;
    }
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
    const unsent = unsentNow();
    if (unsent.length > 0) {
      // a gesture on many parts (same gruppo) is undone in one go, like it was done
      const keep = new Set(senzaUltimoGesto(unsent));
      const gone = unsent.filter((e) => !keep.has(e));
      setPending((p) => withoutSent(p, gone));
      setFuture((f) => [{ kind: "gesto", events: gone }, ...f]);
      setViewerKey((k) => k + 1);
      return;
    }
    void enqueue(async () => {
      const step = pastRef.current[pastRef.current.length - 1];
      if (!step) return;
      setPast((p) => p.slice(0, -1));
      setFuture((f) => [step, ...f]);
      if (!(await runStep(step, "undo"))) {
        // not written: the step is still the last one done
        setFuture((f) => f.filter((s) => s !== step));
        setPast((p) => [...p, step]);
      }
    });
  }, [links, unlinks, routes, unsentNow, enqueue, runStep, setPast, setFuture, setCopper]);

  /** Cmd+Shift+Z: the step undone last, done again, in the same queue */
  const redo = useCallback(() => {
    const first = futureRef.current[0];
    if (!first) return;
    if (first.kind === "gesto") {
      // a gesture that was never saved: it comes back on screen and saves itself
      setFuture((f) => f.slice(1));
      for (const e of first.events) redoneRef.current.add(e);
      setPending((p) => [...p, ...first.events]);
      setViewerKey((k) => k + 1);
      return;
    }
    if (first.kind === "rame") {
      // copper undone before it was saved: back on screen, and it saves itself
      setFuture((f) => f.slice(1));
      copperRedoneRef.current.add(first.gesto);
      setCopper((c) => [...c, first.gesto]);
      return;
    }
    void enqueue(async () => {
      const step = futureRef.current[0];
      if (!step || step.kind === "gesto" || step.kind === "rame") return;
      setFuture((f) => f.slice(1));
      setPast((p) => [...p, step]);
      if (!(await runStep(step, "redo"))) {
        setPast((p) => p.filter((s) => s !== step));
        setFuture((f) => [step, ...f]);
      }
    });
  }, [enqueue, runStep, setPast, setFuture, setCopper]);

  /** throws away what has not been written yet: what is already on the file stays on screen */
  const discard = useCallback(() => {
    if (busyRef.current) return;
    setPending((p) => p.filter((e) => sentRef.current.has(e)));
    setCopper((c) => c.filter((g) => copperSentRef.current.has(g)));
    setLinks([]);
    setUnlinks([]);
    setRoutes([]);
    setViewerKey((k) => k + 1);
  }, [setCopper]);

  /** hands a component back to the automatic flow (or everything, with name null) */
  const release = useCallback(
    async (scope: "schematic" | "pcb" | "traces" | "all", name: string | null) => {
      await exclusive(async () => {
        const before = (await readSaved()) ?? savedRef.current;
        const next = await write({ action: "release", scope, name }, { structural: true });
        if (!next) return;
        pushStep({ kind: "file", before, after: next });
        setPending([]);
        setViewerKey((k) => k + 1);
      });
    },
    [exclusive, readSaved, write, pushStep],
  );

  const counts = countManualEdits(saved);
  const saving = queued > 0;

  return {
    mode,
    setMode,
    pending,
    saved,
    counts,
    busy,
    /** a write of the editor is running or waiting in the queue (the canvas stays free) */
    saving,
    /**
     * For the bar, never blocking: "attesa" a move waits its AUTOSAVE_MS,
     * "salvo" it is being written, "salvato" the last one is on the server.
     */
    saveState: (saving ? "salvo" : unsentMoves + unsentCopper > 0 ? "attesa" : lastSaveOk && !error ? "salvato" : null) as
      | "attesa"
      | "salvo"
      | "salvato"
      | null,
    /** a board arrived (a sync, a recompile, a compile from elsewhere): the overrides it shows go */
    dropAgreed,
    /** the copper gestures let go in Sposta and not on the saved board yet: the canvas draws them */
    copper,
    addCopper,
    /** a board arrived: the copper gestures it shows go */
    dropShownCopper,
    /** the board on screen is being brought up to the saved moves: what arrives meanwhile is ours */
    syncing,
    /** brings the saved board up to the hand positions, as after a move (see followBoard) */
    followBoard,
    error,
    viewerKey,
    links,
    unlinks,
    routes,
    dirty,
    addRoute,
    addLink,
    addUnlink,
    canUndo: dirty > 0 || unsentCopper > 0 || past.length > 0 || saving,
    canRedo: future.length > 0,
    replacePending,
    pushPending,
    recordDetached,
    apply,
    undo,
    redo,
    discard,
    release,
  };
}

export type ManualEditor = ReturnType<typeof useManualEditor>;
