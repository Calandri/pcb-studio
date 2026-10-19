import { describe, expect, it } from "vitest";
import {
  REDACT_ATTR,
  encodeUnderLimit,
  isRedacted,
  screenshotByDefault,
} from "@/components/feedback/redact";

const el = (tagName: string, attrs: Record<string, string> = {}) => ({
  tagName,
  hasAttribute: (n: string) => n in attrs,
  getAttribute: (n: string) => attrs[n] ?? null,
});

describe("isRedacted", () => {
  it("covers marked nodes and password fields", () => {
    expect(isRedacted(el("CODE", { [REDACT_ATTR]: "" }))).toBe(true);
    expect(isRedacted(el("INPUT", { type: "password" }))).toBe(true);
    expect(isRedacted(el("INPUT", { type: "PASSWORD" }))).toBe(true);
  });

  it("leaves the rest of the page alone", () => {
    expect(isRedacted(el("CODE"))).toBe(false);
    expect(isRedacted(el("INPUT", { type: "text" }))).toBe(false);
  });
});

describe("screenshotByDefault", () => {
  it("starts unchecked where keys and tokens are managed", () => {
    expect(screenshotByDefault("/org", false)).toBe(false);
    expect(screenshotByDefault("/team", false)).toBe(false);
    expect(screenshotByDefault("/org/whatever", false)).toBe(false);
  });

  it("starts unchecked on any page that shows a secret", () => {
    expect(screenshotByDefault("/", true)).toBe(false);
  });

  it("starts checked elsewhere", () => {
    expect(screenshotByDefault("/", false)).toBe(true);
    expect(screenshotByDefault("/organic", false)).toBe(true);
  });
});

describe("encodeUnderLimit", () => {
  // a fake encoder: the size grows with width and quality
  const fake = (calls: Array<[number, number]>) => (w: number, q: number) => {
    calls.push([w, q]);
    return "x".repeat(Math.round(w * q * 100));
  };

  it("returns the first attempt that fits", () => {
    const calls: Array<[number, number]> = [];
    const out = encodeUnderLimit(fake(calls), 1600, 0.8, 200_000);
    expect(out.length).toBeLessThanOrEqual(200_000);
    expect(calls).toEqual([[1600, 0.8]]);
  });

  it("lowers the quality first, then the width", () => {
    const calls: Array<[number, number]> = [];
    const out = encodeUnderLimit(fake(calls), 1600, 0.8, 30_000);
    expect(out.length).toBeLessThanOrEqual(30_000);
    expect(calls.slice(0, 4)).toEqual([
      [1600, 0.8],
      [1600, 0.6],
      [1600, 0.45],
      [1600, 0.3],
    ]);
    expect(calls[4][0]).toBe(1200);
  });

  it("gives up instead of looping when nothing fits", () => {
    expect(() => encodeUnderLimit(() => "x".repeat(10), 1600, 0.8, 5)).toThrow(
      "screenshot troppo grande",
    );
  });
});
