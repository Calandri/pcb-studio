import type { ManualEdits } from "@/lib/manual-edits";

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

type ListKey = keyof ManualEdits;

/** how the entries of each list are identified: the same thing the server replaces by */
const KEY_OF: { [K in ListKey]: (item: ManualEdits[K][number]) => string } = {
  schematic_placements: (p) => p.selector,
  pcb_placements: (p) => p.selector,
  manual_trace_hints: (h) => h.pcb_port_selector,
  pcb_routes: (r) => r.connection,
};

const LIST_LABEL: Record<ListKey, string> = {
  schematic_placements: "schema",
  pcb_placements: "rame",
  manual_trace_hints: "pista guidata",
  pcb_routes: "pista",
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

/** fingerprint of a whole manual-edits file */
export function fingerprintEdits(edits: ManualEdits): string {
  return stable(edits);
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
  const out = {} as ManualEdits;
  let changed = false;

  for (const list of Object.keys(KEY_OF) as ListKey[]) {
    const keyOf = KEY_OF[list] as (item: unknown) => string;
    const index = (items: readonly unknown[]) => new Map(items.map((i) => [keyOf(i), i]));
    const fromMap = index(from[list]);
    const toMap = index(to[list]);
    const freshMap = index(fresh[list]);

    // the entries the step touched: present on one side only, or different
    const touched = new Set<string>();
    for (const k of new Set([...fromMap.keys(), ...toMap.keys()])) {
      const a = fromMap.get(k);
      const b = toMap.get(k);
      if (a === undefined || b === undefined || stable(a) !== stable(b)) touched.add(k);
    }

    const result: unknown[] = [];
    for (const item of fresh[list]) {
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
    if (stable(result) !== stable(fresh[list])) changed = true;
    (out as Record<ListKey, unknown[]>)[list] = result;
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
