import { afterEach, describe, expect, it, vi } from "vitest";
import { postJson } from "@/components/post-json";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("postJson", () => {
  it("answers with the data", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, token: "t" })));
    await expect(postJson("/api/x", {})).resolves.toEqual({
      data: { ok: true, token: "t" },
      error: null,
    });
  });

  it("turns a refusal into the server's message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "non puoi" }, { status: 403 })),
    );
    await expect(postJson("/api/x", {})).resolves.toEqual({ data: null, error: "non puoi" });
  });

  it("turns a network error into a value instead of throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    const out = await postJson("/api/x", {});
    expect(out.data).toBeNull();
    expect(out.error).toMatch(/Rete non raggiungibile/);
  });
});
