import { describe, expect, it } from "vitest";
import { motivoErrore } from "@/lib/error-cause";

describe("motivoErrore", () => {
  it("riporta la causa che il driver nasconde sotto 'fetch failed'", () => {
    const socket = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
    const fetch = new TypeError("fetch failed", { cause: socket });
    const neon = new Error("Error connecting to database: TypeError: fetch failed", { cause: fetch });
    expect(motivoErrore(neon)).toBe(
      "Error connecting to database: TypeError: fetch failed <- causa: fetch failed <- causa: [UND_ERR_SOCKET] other side closed",
    );
  });
  it("segue anche sourceError, dove il driver Neon tiene l'errore di fetch", () => {
    const socket = Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });
    const fetch = new TypeError("fetch failed", { cause: socket });
    const neon = Object.assign(new Error("Error connecting to database: TypeError: fetch failed"), { sourceError: fetch });
    expect(motivoErrore(neon)).toContain("[ETIMEDOUT] connect ETIMEDOUT");
  });
  it("regge valori che non sono errori e taglia i messaggi lunghi", () => {
    expect(motivoErrore("boom")).toBe("boom");
    expect(motivoErrore(new Error("x".repeat(1000)), 50)).toHaveLength(50);
  });
});
