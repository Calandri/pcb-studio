import { describe, expect, it } from "vitest";
import { pastaDaiPad } from "@/lib/solder-paste";

type El = Record<string, unknown> & { type: string };

const pad = (over: Record<string, unknown>) => ({ type: "pcb_smtpad", pcb_smtpad_id: "p1", layer: "top", x: 1, y: 2, ...over });
const pasta = (over: Record<string, unknown> = {}) => ({
  type: "pcb_solder_paste", pcb_solder_paste_id: "s1", pcb_smtpad_id: "p1", layer: "top", x: 1, y: 2, ...over,
});

describe("the paste of each pad is the pad", () => {
  it("a rect pad gets an opening as large as itself, not tscircuit's 70%", () => {
    const out = pastaDaiPad([pad({ shape: "rect", width: 0.6, height: 0.5 }), pasta({ shape: "rect", width: 0.42, height: 0.35 })] as El[]);
    expect(out[1]).toMatchObject({ shape: "rect", width: 0.6, height: 0.5, x: 1, y: 2 });
  });
  it("the project expansion grows or shrinks every side", () => {
    const out = pastaDaiPad([pad({ shape: "rect", width: 0.6, height: 0.5 }), pasta({ shape: "rect", width: 0.42, height: 0.35 })] as El[], -0.05);
    expect(Number(out[1].width)).toBeCloseTo(0.5);
    expect(Number(out[1].height)).toBeCloseTo(0.4);
  });
  it("a circle pad keeps its shape and takes the expansion on the radius", () => {
    const out = pastaDaiPad([pad({ shape: "circle", radius: 0.3 }), pasta({ shape: "circle", radius: 0.21 })] as El[], 0.02);
    expect(out[1]).toMatchObject({ shape: "circle" });
    expect(Number(out[1].radius)).toBeCloseTo(0.32);
  });
  it("a rotated pad keeps its rotation", () => {
    const out = pastaDaiPad([pad({ shape: "rotated_rect", width: 1, height: 0.3, ccw_rotation: 45 }), pasta({ shape: "rotated_rect", width: 0.7, height: 0.21, ccw_rotation: 45 })] as El[]);
    expect(out[1]).toMatchObject({ shape: "rotated_rect", width: 1, height: 0.3, ccw_rotation: 45 });
  });
  it("an opening drawn by the footprint itself, tied to no pad, is left alone", () => {
    const libera = { type: "pcb_solder_paste", pcb_solder_paste_id: "s9", layer: "top", shape: "circle", x: 0, y: 0, radius: 0.12 };
    const out = pastaDaiPad([libera] as El[]);
    expect(out[0]).toEqual(libera);
  });
  it("a pad under solder mask prints nothing", () => {
    const out = pastaDaiPad([pad({ shape: "rect", width: 0.6, height: 0.5, is_covered_with_solder_mask: true }), pasta({ shape: "rect", width: 0.42, height: 0.35 })] as El[]);
    expect(out.filter((e) => e.type === "pcb_solder_paste")).toHaveLength(0);
  });
  it("an expansion that eats the pad drops the opening instead of printing a pinhole", () => {
    const out = pastaDaiPad([pad({ shape: "rect", width: 0.1, height: 0.1 }), pasta({ shape: "rect", width: 0.07, height: 0.07 })] as El[], -0.1);
    expect(out.filter((e) => e.type === "pcb_solder_paste")).toHaveLength(0);
  });
  it("everything else passes through untouched and in order", () => {
    const via = { type: "pcb_via", x: 0, y: 0 };
    const out = pastaDaiPad([via, pad({ shape: "rect", width: 1, height: 1 }), pasta({ shape: "rect", width: 0.7, height: 0.7 })] as El[]);
    expect(out[0]).toBe(via);
    expect(out).toHaveLength(3);
  });
});

describe("the rule", () => {
  it("is read from the project and clamped", async () => {
    const { resolveDesignRules } = await import("@/lib/design-rules");
    const r = resolveDesignRules({ "design-rules.json": JSON.stringify({ preset: "custom", rules: { pasteExpansionMm: -0.5 } }) });
    expect(r.rules.pasteExpansionMm).toBe(-0.1);
    expect(r.warnings?.join(" ")).toMatch(/pasteExpansionMm/);
    const nulla = resolveDesignRules({ "design-rules.json": JSON.stringify({ preset: "custom", rules: {} }) });
    expect(nulla.rules.pasteExpansionMm).toBeUndefined();
  });
});

describe("autoPlaneVias", () => {
  it("is kept when the project says false, absent otherwise", async () => {
    const { resolveDesignRules } = await import("@/lib/design-rules");
    const off = resolveDesignRules({ "design-rules.json": JSON.stringify({ preset: "custom", rules: { autoPlaneVias: false } }) });
    expect(off.rules.autoPlaneVias).toBe(false);
    const on = resolveDesignRules({ "design-rules.json": JSON.stringify({ preset: "custom", rules: {} }) });
    expect(on.rules.autoPlaneVias).toBeUndefined();
    const sbagliato = resolveDesignRules({ "design-rules.json": JSON.stringify({ preset: "custom", rules: { autoPlaneVias: "no" } }) });
    expect(sbagliato.rules.autoPlaneVias).toBeUndefined();
  });
});
