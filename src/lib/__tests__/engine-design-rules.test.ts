import { describe, expect, it } from "vitest";
import { buildProjectRules, DESIGN_RULES_PATH, resolveDesignRules } from "@/lib/design-rules";

const file = (content: unknown) => ({
  [DESIGN_RULES_PATH]: typeof content === "string" ? content : JSON.stringify(content),
});

describe("design-rules.json: what is wrong is said", () => {
  it("a broken file falls back to JLCPCB with a warning", () => {
    const r = resolveDesignRules(file("{ preset: oops"));
    expect(r.preset).toBe("jlcpcb_standard");
    expect(r.warnings?.[0]).toMatch(/JSON/);
  });

  it("an unknown preset is said, not swallowed", () => {
    const r = resolveDesignRules(file({ preset: "pcbway" }));
    expect(r.preset).toBe("jlcpcb_standard");
    expect(r.warnings?.[0]).toMatch(/pcbway/);
  });

  it("a clean file has no warnings", () => {
    expect(resolveDesignRules(file({ preset: "oshpark" })).warnings).toBeUndefined();
    expect(resolveDesignRules({}).warnings).toBeUndefined();
  });
});

describe("custom rules are checked against each other", () => {
  it("a target below its minimum is raised to the minimum", () => {
    const r = resolveDesignRules(
      file({ preset: "custom", rules: { minTraceWidthMm: 0.2, targetTraceWidthMm: 0.1, minClearanceMm: 0.2, targetClearanceMm: 0.15 } }),
    );
    expect(r.rules.targetTraceWidthMm).toBe(0.2);
    expect(r.rules.targetClearanceMm).toBe(0.2);
    expect(r.warnings?.length).toBeGreaterThanOrEqual(2);
  });

  it("a via whose hole is as wide as its pad gets a copper ring", () => {
    const r = buildProjectRules("custom", { minViaHoleMm: 0.5, minViaDiameterMm: 0.5 });
    expect(r.rules.minViaDiameterMm).toBeGreaterThan(r.rules.minViaHoleMm);
    expect(r.warnings?.some((w) => w.includes("minViaDiameterMm"))).toBe(true);
  });

  it("out-of-range values are clamped and said", () => {
    const r = buildProjectRules("custom", { minTraceWidthMm: 0.001 });
    expect(r.rules.minTraceWidthMm).toBe(0.05);
    expect(r.warnings?.some((w) => w.includes("minTraceWidthMm"))).toBe(true);
  });
});
