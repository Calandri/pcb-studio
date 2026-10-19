import { describe, expect, it } from "vitest";
import { runSimulation } from "@/lib/simulate";

describe("runSimulation", () => {
  it("summarizes a small RC transient", () => {
    const out = runSimulation(`Test circuit
v1 in 0 dc 5
r1 in out 1k
c1 out 0 1u
.tran 10u 5m
.end
`);
    expect(out.ok).toBe(true);
    expect(out.tran?.points).toBeGreaterThan(100);
    expect(out.tran?.nodes.out?.max).toBeGreaterThan(0);
  });

  it("refuses an analysis that asks for too many points instead of hanging", () => {
    const out = runSimulation(`Test circuit
v1 in 0 dc 5
r1 in out 1k
c1 out 0 1u
.tran 1p 1
.end
`);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/steps/);
  });
});
