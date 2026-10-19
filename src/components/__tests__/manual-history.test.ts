import { describe, expect, it } from "vitest";
import {
  conflictMessage,
  fingerprintEdits,
  rebaseManualEdits,
  withoutSent,
} from "@/components/workspace/manual-history";
import { emptyManualEdits, type ManualEdits } from "@/lib/manual-edits";

const at = (selector: string, x: number, y = 0, extra: { auto?: boolean } = {}) => ({
  selector,
  center: { x, y },
  ...extra,
});

const edits = (pcb: ManualEdits["pcb_placements"], rest: Partial<ManualEdits> = {}): ManualEdits => ({
  ...emptyManualEdits(),
  pcb_placements: pcb,
  ...rest,
});

describe("withoutSent", () => {
  it("removes only what was sent, by identity", () => {
    const a = { id: 1 };
    const b = { id: 2 };
    const drawnMeanwhile = { id: 1 }; // same shape as a, but a new edit
    expect(withoutSent([a, b, drawnMeanwhile], [a, b])).toEqual([drawnMeanwhile]);
    expect(withoutSent([a, b, drawnMeanwhile], [a, b])[0]).toBe(drawnMeanwhile);
  });

  it("keeps the sent items the server refused", () => {
    const a = { id: 1 };
    const b = { id: 2 };
    expect(withoutSent([a, b], [a, b], [b])).toEqual([b]);
  });

  it("works on plain strings too (the unlinks)", () => {
    expect(withoutSent(["x", "y", "z"], ["x", "y"], ["y"])).toEqual(["y", "z"]);
  });
});

describe("rebaseManualEdits", () => {
  it("undoes only the entries the step touched, keeping what others saved since", () => {
    const before = edits([at("R1", 1)]);
    const after = edits([at("R1", 5), at("C1", 2)]);
    // the agent pinned U1 after the step
    const fresh = edits([at("R1", 5), at("C1", 2), at("U1", 9)]);
    const r = rebaseManualEdits(fresh, after, before);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.changed).toBe(true);
    expect(r.edits.pcb_placements).toEqual([at("R1", 1), at("U1", 9)]);
  });

  it("refuses when an entry the step touched was changed by someone else", () => {
    const before = edits([at("R1", 1)]);
    const after = edits([at("R1", 5)]);
    const fresh = edits([at("R1", 7)]);
    const r = rebaseManualEdits(fresh, after, before);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.conflicts).toEqual(["R1 (rame)"]);
  });

  it("brings back an entry the step removed", () => {
    const before = edits([at("R1", 1), at("C1", 3)]);
    const after = edits([at("R1", 1)]);
    const fresh = edits([at("R1", 1), at("U1", 4)]);
    const r = rebaseManualEdits(fresh, after, before);
    expect(r.ok && r.edits.pcb_placements).toEqual([at("R1", 1), at("U1", 4), at("C1", 3)]);
  });

  it("redo is the same move the other way, and finds nothing to do twice", () => {
    const before = edits([at("R1", 1)]);
    const after = edits([at("R1", 5)]);
    const undone = rebaseManualEdits(after, after, before);
    expect(undone.ok).toBe(true);
    if (!undone.ok) return;
    const redone = rebaseManualEdits(undone.edits, before, after);
    expect(redone.ok && redone.edits.pcb_placements).toEqual([at("R1", 5)]);
    const again = rebaseManualEdits(after, before, after);
    expect(again.ok && again.changed).toBe(false);
  });

  it("covers every list of the file, each by its own key", () => {
    const route = { connection: ".R1 > .pin1 to net.GND", width: 0.25, points: [] };
    const before = emptyManualEdits();
    const after = edits([], {
      pcb_routes: [route],
      schematic_placements: [at("R1", 2)],
      manual_trace_hints: [{ pcb_port_selector: ".R1 > .pin1", offsets: [{ x: 1, y: 1 }] }],
    });
    const r = rebaseManualEdits(after, after, before);
    expect(r.ok && fingerprintEdits(r.edits)).toBe(fingerprintEdits(emptyManualEdits()));
  });

  it("compares entries whatever order their keys were written in", () => {
    const before = edits([at("R1", 1)]);
    const after = edits([at("R1", 5)]);
    const fresh = edits([{ center: { y: 0, x: 5 }, selector: "R1" }]);
    expect(rebaseManualEdits(fresh, after, before).ok).toBe(true);
  });
});

describe("conflictMessage", () => {
  it("names the first few and counts the rest", () => {
    const msg = conflictMessage(["A (rame)", "B (rame)", "C (rame)", "D (rame)"], "annullare");
    expect(msg).toContain("Non posso annullare: A (rame), B (rame), C (rame) e altri 1");
    expect(msg).toContain("sono stati cambiati");
    expect(conflictMessage(["A (rame)"], "ripristinare")).toContain("e' stato cambiato");
  });
});
