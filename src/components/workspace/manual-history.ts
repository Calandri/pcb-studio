import type { EditEvent, ManualEdits, ManualPlacement, PlacementPatch } from "@/lib/manual-edits";
import { manualRouteKey, viaMoveKey, type ManualRoute } from "@/lib/manual-routes";

/*
 * The pure half of the manual editor's bookkeeping: which pending edits were
 * really sent, and how to undo a saved step without overwriting what somebody
 * else saved in the meantime. Kept out of the hook so it can be tested.
 */

/**
 * The list without the items that were sent, compared by IDENTITY: an edit
 * drawn while the request was in flight is a new object and survives, even
 * when it looks the same as one that went. Items in `keep` stay even if sent
 * (the ones the server refused).
 */
export function withoutSent<T>(current: readonly T[], sent: readonly T[], keep: readonly T[] = []): T[] {
  const gone = new Set(sent);
  const back = new Set(keep);
  return current.filter((item) => !gone.has(item) || back.has(item));
}

/** one saved step: the file before and after it, both as the server answered */
export interface HistoryStep {
  before: ManualEdits;
  after: ManualEdits;
}

/** the lists of the file; board_base is the server's bookkeeping, not an edit */
type ListKey = Exclude<keyof ManualEdits, "board_base">;

/** how the entries of each list are identified: the same thing the server replaces by */
const KEY_OF: { [K in ListKey]: (item: ManualEdits[K][number]) => string } = {
  schematic_placements: (p) => p.selector,
  pcb_placements: (p) => p.selector,
  manual_trace_hints: (h) => h.pcb_port_selector,
  // the identity the server replaces by: the pad pair, not the connection
  pcb_routes: (r) => manualRouteKey(r),
  // a moved via: its net and where the files put it
  pcb_vias: (v) => viaMoveKey(v),
};

const LIST_LABEL: Record<ListKey, string> = {
  schematic_placements: "schema",
  pcb_placements: "rame",
  manual_trace_hints: "pista guidata",
  pcb_routes: "pista",
  pcb_vias: "via spostata",
};

/** JSON with sorted keys: two equal entries compare equal whatever order the parser built them in */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(obj[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Fingerprint of the edits in a file. board_base is left out: the server
 * rewrites it on every save on a current board, and counting it would make
 * every undo look like a conflict.
 */
export function fingerprintEdits(edits: ManualEdits): string {
  const { board_base: _base, ...lists } = edits;
  void _base;
  return stable(lists);
}

export type RebaseResult =
  | { ok: true; edits: ManualEdits; changed: boolean }
  | { ok: false; conflicts: string[] };

/**
 * Moves the file from `from` to `to` ONLY where the step changed it, starting
 * from what the server holds now (`fresh`).
 *
 * Undo used to post the whole old snapshot, so a pin or a move written by the
 * agent after the step was silently thrown away with it. Here only the entries
 * the step touched go back; everything else stays as the server has it. When
 * one of those very entries was changed by somebody else after the step (into
 * something other than where we are going), there is no right answer to pick,
 * and the undo is refused with their names.
 */
export function rebaseManualEdits(
  fresh: ManualEdits,
  from: ManualEdits,
  to: ManualEdits,
): RebaseResult {
  const conflicts: string[] = [];
  // the server's bookkeeping stays as the server holds it now
  const out = (fresh.board_base ? { board_base: fresh.board_base } : {}) as ManualEdits;
  let changed = false;

  for (const list of Object.keys(KEY_OF) as ListKey[]) {
    const keyOf = KEY_OF[list] as (item: unknown) => string;
    const index = (items: readonly unknown[]) => new Map(items.map((i) => [keyOf(i), i]));
    const fromMap = index(from[list] ?? []);
    const toMap = index(to[list] ?? []);
    const freshMap = index(fresh[list] ?? []);

    // the entries the step touched: present on one side only, or different
    const touched = new Set<string>();
    for (const k of new Set([...fromMap.keys(), ...toMap.keys()])) {
      const a = fromMap.get(k);
      const b = toMap.get(k);
      if (a === undefined || b === undefined || stable(a) !== stable(b)) touched.add(k);
    }

    const result: unknown[] = [];
    for (const item of fresh[list] ?? []) {
      const k = keyOf(item);
      if (!touched.has(k)) {
        result.push(item);
        continue;
      }
      const target = toMap.get(k);
      if (target !== undefined) result.push(target);
    }
    for (const k of touched) {
      const now = freshMap.get(k);
      const target = toMap.get(k);
      // changed since the step, and not into what we are going back to: a real conflict
      if (stable(now) !== stable(fromMap.get(k)) && stable(now) !== stable(target)) {
        conflicts.push(`${k} (${LIST_LABEL[list]})`);
      }
      // an entry the step removed and that is not on the server: it comes back
      if (now === undefined && target !== undefined) result.push(target);
    }
    if (stable(result) !== stable(fresh[list] ?? [])) changed = true;
    (out as unknown as Record<ListKey, unknown[]>)[list] = result;
  }

  if (conflicts.length > 0) return { ok: false, conflicts };
  return { ok: true, edits: out, changed };
}

/** the message for a refused undo, in the editor's words */
export function conflictMessage(conflicts: string[], verb: "annullare" | "ripristinare"): string {
  const shown = conflicts.slice(0, 3).join(", ");
  const more = conflicts.length > 3 ? ` e altri ${conflicts.length - 3}` : "";
  const one = conflicts.length === 1;
  return `Non posso ${verb}: ${shown}${more} ${
    one ? "e' stato cambiato" : "sono stati cambiati"
  } sul server dopo la tua modifica (dall'agente o da un'altra scheda). Ho ricaricato lo stato salvato.`;
}

/**
 * The pending edits without the last GESTURE: one event, or every trailing
 * event of the same `gruppo` (a multi-selection dragged, turned or flipped in
 * one go). Cmd+Z undoes a gesture the way it was done, not one part at a time.
 */
export function senzaUltimoGesto<T extends { gruppo?: string }>(pending: T[]): T[] {
  const g = pending[pending.length - 1]?.gruppo;
  if (!g) return pending.slice(0, -1);
  let i = pending.length;
  while (i > 0 && pending[i - 1].gruppo === g) i--;
  return pending.slice(0, i);
}

// ---------------------------------------------------------------------------
// The editor's history, step by step (2026-11-10)
//
// Undo used to read the whole file back, rebase it and send it back whole
// (326 KB with 821 traces on tm-4l-r3), then wait for the board: seconds per
// Cmd+Z, and a Cmd+Z pressed meanwhile was dropped. A detached trace could not
// be undone at all. Now every step says exactly what it changed, and undo and
// redo send only that, the same small writes as a dragged part.
// ---------------------------------------------------------------------------

/** a part as a step leaves it: its hand position in the file, and where it is on screen */
export interface PartState {
  selector: string;
  /** the placement in manual-edits.json; null = none, the code decides */
  placement: ManualPlacement | null;
  center: { x: number; y: number };
  rotation: number;
  layer: "top" | "bottom";
}

/** what detaching a trace took away, as the server answered: enough to put it back */
export interface RemovedTrace {
  routes: ManualRoute[];
  elements: unknown[];
}

export type EditorStep =
  /** a step of the whole file (links, release, moves written the old way): see rebaseManualEdits */
  | ({ kind: "file" } & HistoryStep)
  /** parts moved, turned, flipped: their state before and after */
  | { kind: "pezzi"; before: PartState[]; after: PartState[] }
  /** hand traces written by Applica: what they replaced, and what was written */
  | { kind: "piste"; before: ManualRoute[]; after: ManualRoute[] }
  /** a trace detached in Instrada */
  | { kind: "staccata"; traceId: string; removed: RemovedTrace }
  /** only on the redo side: a gesture undone before it was even saved */
  | { kind: "gesto"; events: EditEvent[] };

/** how many steps the editor keeps, each way */
export const HISTORY_MAX = 100;

/**
 * The parts of a saved batch, before and after it. On screen: where the first
 * move of each part started from, and where its last one ended (turn and face
 * merged like the overrides). In the file: what the server says it replaced,
 * and what it wrote.
 */
export function partStates(
  batch: readonly EditEvent[],
  names: readonly string[],
  fileBefore: ReadonlyArray<{ selector: string; placement: ManualPlacement | null }>,
  written: readonly ManualPlacement[],
): { before: PartState[]; after: PartState[] } {
  const before: PartState[] = [];
  const after: PartState[] = [];
  for (const name of names) {
    const evs = batch.filter(
      (e) => e.edit_event_type === "edit_pcb_component_location" && e.component_name === name && e.new_center,
    );
    if (evs.length === 0) continue;
    const first = evs[0];
    const start = {
      center: first.original_center ?? first.new_center!,
      rotation: first.original_rotation ?? 0,
      layer: first.original_layer ?? ("top" as const),
    };
    let rotation = start.rotation;
    let layer = start.layer;
    for (const e of evs) {
      if (e.new_rotation !== undefined) rotation = e.new_rotation;
      if (e.new_layer !== undefined) layer = e.new_layer;
    }
    const last = evs[evs.length - 1];
    before.push({
      selector: name,
      placement: fileBefore.find((b) => b.selector === name)?.placement ?? null,
      ...start,
    });
    after.push({
      selector: name,
      placement: written.find((w) => w.selector === name) ?? null,
      center: last.new_center!,
      rotation,
      layer,
    });
  }
  return { before, after };
}

/** the write that brings the parts to these states: exact patches, and removals for "no placement" */
export function placeRequest(states: readonly PartState[]): {
  placements: Array<PlacementPatch>;
  remove: string[];
} {
  const placements: PlacementPatch[] = [];
  const remove: string[] = [];
  for (const s of states) {
    if (!s.placement) {
      remove.push(s.selector);
      continue;
    }
    placements.push({
      name: s.selector,
      x: s.placement.center.x,
      y: s.placement.center.y,
      ...(s.placement.rotation !== undefined ? { rotation: s.placement.rotation } : {}),
      ...(s.placement.layer !== undefined ? { layer: s.placement.layer } : {}),
      exact: true,
    });
  }
  return { placements, remove };
}

/** the routes write that undoes (or redoes) a "piste" step */
export function routesRequest(
  step: { before: ManualRoute[]; after: ManualRoute[] },
  direction: "undo" | "redo",
): { add: ManualRoute[]; remove: string[] } {
  if (direction === "redo") return { add: step.after, remove: [] };
  const back = new Set(step.before.map(manualRouteKey));
  return { add: step.before, remove: step.after.map(manualRouteKey).filter((k) => !back.has(k)) };
}

/** the file as the page knows it, after an undo or redo of these parts */
export function withPartStates(edits: ManualEdits, states: readonly PartState[]): ManualEdits {
  const names = new Set(states.map((s) => s.selector));
  return {
    ...edits,
    pcb_placements: [
      ...edits.pcb_placements.filter((p) => !names.has(p.selector)),
      ...states.flatMap((s) => (s.placement ? [s.placement] : [])),
    ],
  };
}

/** the file as the page knows it, with routes added and taken away by key */
export function withRoutes(edits: ManualEdits, add: readonly ManualRoute[], remove: readonly string[]): ManualEdits {
  const gone = new Set([...remove, ...add.map(manualRouteKey)]);
  return { ...edits, pcb_routes: [...edits.pcb_routes.filter((r) => !gone.has(manualRouteKey(r))), ...add] };
}
