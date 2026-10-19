import { describe, expect, it } from "vitest";
import {
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  isRetryableStatus,
  mergeActivity,
  nextBackoff,
} from "@/components/workspace/activity-feed";

describe("nextBackoff", () => {
  it("starts short and doubles up to a ceiling", () => {
    expect(nextBackoff(0)).toBe(RETRY_BASE_MS);
    expect(nextBackoff(1)).toBe(RETRY_BASE_MS * 2);
    expect(nextBackoff(3)).toBe(RETRY_BASE_MS * 8);
    expect(nextBackoff(50)).toBe(RETRY_MAX_MS);
  });
});

describe("isRetryableStatus", () => {
  it("gives up on refusals that will not change", () => {
    for (const s of [400, 401, 403, 404]) expect(isRetryableStatus(s)).toBe(false);
  });

  it("retries what may pass", () => {
    for (const s of [408, 429, 500, 502, 503, 504]) expect(isRetryableStatus(s)).toBe(true);
  });
});

describe("mergeActivity", () => {
  const ev = (id: number) => ({ id, tool: "t" });

  it("skips events already shown, also inside the same batch", () => {
    const out = mergeActivity([ev(1), ev(2)], [ev(2), ev(3), ev(3)]);
    expect(out.map((e) => e.id)).toEqual([1, 2, 3]);
  });

  it("returns the same list when nothing is new", () => {
    const prev = [ev(1)];
    expect(mergeActivity(prev, [ev(1)])).toBe(prev);
  });

  it("keeps the latest ones, in id order", () => {
    const out = mergeActivity([ev(5), ev(6)], [ev(4), ev(7)], 3);
    expect(out.map((e) => e.id)).toEqual([5, 6, 7]);
  });
});
