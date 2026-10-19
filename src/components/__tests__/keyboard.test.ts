import { describe, expect, it } from "vitest";
import { isTypingTarget } from "@/components/keyboard";

const key = (target: unknown, extra: { isComposing?: boolean; keyCode?: number } = {}) =>
  ({ target, isComposing: false, ...extra }) as unknown as KeyboardEvent;

describe("isTypingTarget", () => {
  it("leaves the shortcuts to the canvas on ordinary elements", () => {
    expect(isTypingTarget(key({ tagName: "DIV", isContentEditable: false }))).toBe(false);
    expect(isTypingTarget(key(null))).toBe(false);
  });

  it("gives the key to text fields and selects", () => {
    for (const tagName of ["INPUT", "TEXTAREA", "SELECT"]) {
      expect(isTypingTarget(key({ tagName }))).toBe(true);
    }
  });

  it("gives the key to editable blocks", () => {
    expect(isTypingTarget(key({ tagName: "DIV", isContentEditable: true }))).toBe(true);
  });

  it("ignores keys that belong to an open IME composition", () => {
    expect(isTypingTarget(key({ tagName: "DIV" }, { isComposing: true }))).toBe(true);
    expect(isTypingTarget(key({ tagName: "DIV" }, { keyCode: 229 }))).toBe(true);
  });
});
