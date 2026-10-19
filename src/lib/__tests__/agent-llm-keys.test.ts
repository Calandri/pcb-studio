import { describe, expect, it } from "vitest";
import {
  encryptionSecret,
  openApiKey,
  resolveAgentKeys,
  sealApiKey,
  type KeyBinding,
} from "@/lib/llm-keys";

const env = { NODE_ENV: "test", KEY_ENCRYPTION_SECRET: "a-test-secret-that-is-long-enough-123456" };
const alice: KeyBinding = { ownerType: "user", ownerId: "alice", provider: "openrouter" };
const bob: KeyBinding = { ownerType: "user", ownerId: "bob", provider: "openrouter" };

describe("sealApiKey / openApiKey", () => {
  it("round-trips with a version prefix and a fresh salt every time", () => {
    const a = sealApiKey("sk-or-v1-abc", alice, env);
    const b = sealApiKey("sk-or-v1-abc", alice, env);
    expect(a.startsWith("v1:")).toBe(true);
    expect(a).not.toBe(b);
    expect(openApiKey(a, alice, env)).toBe("sk-or-v1-abc");
  });

  it("binds the owner: a ciphertext moved to another row does not open", () => {
    const sealed = sealApiKey("sk-or-v1-abc", alice, env);
    expect(() => openApiKey(sealed, bob, env)).toThrow();
    expect(() => openApiKey(sealed, { ...alice, ownerType: "org" }, env)).toThrow();
  });

  it("does not open with another secret, nor an unknown format", () => {
    const sealed = sealApiKey("sk-or-v1-abc", alice, env);
    expect(() =>
      openApiKey(sealed, alice, { ...env, KEY_ENCRYPTION_SECRET: "another-secret-that-is-long-enough-99" }),
    ).toThrow();
    expect(() => openApiKey(sealed.slice(3), alice, env)).toThrow(/formato/);
  });
});

describe("encryptionSecret", () => {
  it("requires a dedicated, long secret in production", () => {
    expect(() => encryptionSecret({ NODE_ENV: "production", AUTH_SECRET: "x".repeat(40) })).toThrow(
      /KEY_ENCRYPTION_SECRET mancante/,
    );
    expect(() => encryptionSecret({ NODE_ENV: "production", KEY_ENCRYPTION_SECRET: "short" })).toThrow(
      /troppo corto/,
    );
    expect(
      encryptionSecret({ NODE_ENV: "production", KEY_ENCRYPTION_SECRET: "y".repeat(32) }).length,
    ).toBe(32);
  });

  it("falls back on AUTH_SECRET only outside production", () => {
    expect(encryptionSecret({ NODE_ENV: "development", AUTH_SECRET: "dev" }).toString()).toBe("dev");
    expect(() => encryptionSecret({ NODE_ENV: "development" })).toThrow();
  });
});

describe("resolveAgentKeys", () => {
  const org1: KeyBinding = { ownerType: "org", ownerId: "org-1", provider: "openrouter" };
  const org2: KeyBinding = { ownerType: "org", ownerId: "org-2", provider: "openrouter" };
  const row = (b: KeyBinding, key: string) => ({
    owner_type: b.ownerType,
    owner_id: b.ownerId,
    key_ciphertext: sealApiKey(key, b, env),
  });

  it("user key beats org key, and orgs follow the given order", () => {
    const rows = [row(org2, "sk-or-org2"), row(org1, "sk-or-org1"), row(alice, "sk-or-alice")];
    expect(resolveAgentKeys(rows, "alice", ["org-1", "org-2"], env)).toEqual({
      openrouter: { key: "sk-or-alice", scope: "user" },
    });
    expect(resolveAgentKeys(rows.slice(0, 2), "alice", ["org-2", "org-1"], env)).toEqual({
      openrouter: { key: "sk-or-org2", scope: "org" },
    });
    expect(resolveAgentKeys([], "alice", ["org-1"], env)).toEqual({});
  });

  it("returns an error entry, not an empty map, when the stored key does not decrypt", () => {
    const rows = [row(alice, "sk-or-alice")];
    const other = { ...env, KEY_ENCRYPTION_SECRET: "rotated-secret-that-is-long-enough-000" };
    const keys = resolveAgentKeys(rows, "alice", [], other);
    expect(keys.openrouter?.key).toBeUndefined();
    expect(keys.openrouter?.scope).toBe("user");
    expect(keys.openrouter?.error).toMatch(/non si riesce a decifrare/);
  });
});
