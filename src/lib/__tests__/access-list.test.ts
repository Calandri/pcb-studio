import { describe, expect, it } from "vitest";
import { isEmailAllowed } from "@/lib/access-list";

const prod = { NODE_ENV: "production" };

describe("isEmailAllowed", () => {
  it("lets nobody in, in production, when no list is configured", () => {
    expect(isEmailAllowed("someone@example.com", prod)).toBe(false);
  });

  it("stays open in development without lists", () => {
    expect(isEmailAllowed("someone@example.com", { NODE_ENV: "development" })).toBe(true);
  });

  it("matches exact addresses case-insensitively", () => {
    const env = { ...prod, AUTH_ALLOWED_EMAILS: " Niccolo@Example.com , a@b.it" };
    expect(isEmailAllowed("niccolo@example.com", env)).toBe(true);
    expect(isEmailAllowed("NICCOLO@EXAMPLE.COM", env)).toBe(true);
    expect(isEmailAllowed("other@example.com", env)).toBe(false);
  });

  it("matches whole domains, not suffixes", () => {
    const env = { ...prod, AUTH_ALLOWED_DOMAINS: "3bee.com,@team.it" };
    expect(isEmailAllowed("dev@3bee.com", env)).toBe(true);
    expect(isEmailAllowed("dev@team.it", env)).toBe(true);
    expect(isEmailAllowed("dev@evil3bee.com", env)).toBe(false);
    expect(isEmailAllowed("dev@3bee.com.evil.io", env)).toBe(false);
  });

  it("rejects malformed addresses", () => {
    const env = { ...prod, AUTH_ALLOWED_DOMAINS: "3bee.com" };
    expect(isEmailAllowed("", env)).toBe(false);
    expect(isEmailAllowed(null, env)).toBe(false);
    expect(isEmailAllowed("@3bee.com", env)).toBe(false);
    expect(isEmailAllowed("dev@", env)).toBe(false);
  });
});
