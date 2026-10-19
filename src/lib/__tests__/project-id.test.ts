import { describe, expect, it } from "vitest";
import { isValidProjectId } from "@/lib/project-store";

describe("isValidProjectId", () => {
  it("accepts the ids the app generates", () => {
    expect(isValidProjectId("bat-bs")).toBe(true);
    expect(isValidProjectId("a1_b2-c3")).toBe(true);
  });

  it("rejects ids that would create ghost projects", () => {
    expect(isValidProjectId("-")).toBe(false);
    expect(isValidProjectId("_x")).toBe(false);
    expect(isValidProjectId("a".repeat(61))).toBe(false);
    expect(isValidProjectId("../etc")).toBe(false);
  });
});
