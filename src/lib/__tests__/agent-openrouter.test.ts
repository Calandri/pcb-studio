import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyHttpError,
  fromOpenAIMessage,
  INVALID_TOOL_ARGUMENTS,
  invalidToolArguments,
  LlmError,
  mapFinishReason,
  parseCompletion,
  parseToolArguments,
  presetModel,
  resolveKey,
  runAgentTurn,
  toOpenAIMessages,
  type MessageParam,
} from "@/lib/llm";

describe("toOpenAIMessages", () => {
  it("maps text, tool_use and tool_result to the OpenAI chat format", () => {
    const messages: MessageParam[] = [
      { role: "user", content: "fai un 555" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Leggo il file." },
          { type: "tool_use", id: "call_1", name: "read_file", input: { path: "main.tsx" } },
          { type: "tool_use", id: "call_2", name: "list_files", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: '{"path":"main.tsx"}' },
          {
            type: "tool_result",
            tool_use_id: "call_2",
            content: [{ type: "text", text: "a" }, { type: "text", text: "b" }],
            is_error: true,
          },
        ],
      },
    ];
    expect(toOpenAIMessages("sys", messages)).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "fai un 555" },
      {
        role: "assistant",
        content: "Leggo il file.",
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"main.tsx"}' } },
          { id: "call_2", type: "function", function: { name: "list_files", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: '{"path":"main.tsx"}' },
      { role: "tool", tool_call_id: "call_2", content: "a\nb" },
    ]);
  });

  it("uses null content for an assistant turn made only of tool calls, and skips the empty system", () => {
    const out = toOpenAIMessages("  ", [
      { role: "user", content: "x" },
      { role: "assistant", content: [{ type: "tool_use", id: "c", name: "compile", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c", content: "{}" }] },
    ]);
    expect(out[0]).toEqual({ role: "user", content: "x" });
    expect(out[1]).toMatchObject({ role: "assistant", content: null });
  });

  it("repairs the pairing: a call without result gets one, an orphan result is dropped", () => {
    const out = toOpenAIMessages("", [
      { role: "user", content: "x" },
      { role: "assistant", content: [{ type: "tool_use", id: "a", name: "compile", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "zzz", content: "orphan" }] },
      { role: "user", content: "e allora?" },
    ]);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user"]);
    expect(out[2]).toMatchObject({ role: "tool", tool_call_id: "a" });
    expect((out[2] as { content: string }).content).toMatch(/non e' stata eseguita/);
  });

  it("puts tool results before the text of the same user message", () => {
    const out = toOpenAIMessages("", [
      { role: "user", content: "x" },
      { role: "assistant", content: [{ type: "tool_use", id: "a", name: "compile", input: {} }] },
      {
        role: "user",
        content: [
          { type: "text", text: "nota" },
          { type: "tool_result", tool_use_id: "a", content: "{}" },
        ],
      },
    ]);
    expect(out.slice(2)).toEqual([
      { role: "tool", tool_call_id: "a", content: "{}" },
      { role: "user", content: "nota" },
    ]);
  });

  it("turns image blocks into image_url parts", () => {
    const out = toOpenAIMessages("", [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
          { type: "text", text: "guarda" },
        ],
      },
    ]);
    expect(out[0]).toEqual({
      role: "user",
      content: [
        { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
        { type: "text", text: "guarda" },
      ],
    });
  });

  it("round-trips reasoning_details through the thinking block", () => {
    const details = [{ type: "reasoning.text", text: "penso", format: "unknown", index: 0 }];
    const blocks = fromOpenAIMessage(
      {
        content: null,
        reasoning: "penso",
        reasoning_details: details,
        tool_calls: [{ id: "t1", type: "function", function: { name: "compile", arguments: "{}" } }],
      },
      "p",
    );
    expect(blocks[0]).toMatchObject({ type: "thinking", thinking: "penso" });
    const out = toOpenAIMessages("", [
      { role: "user", content: "x" },
      { role: "assistant", content: blocks },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "{}" }] },
    ]);
    expect(out[1]).toMatchObject({ role: "assistant", reasoning_details: details });
  });
});

describe("fromOpenAIMessage", () => {
  it("parses tool call arguments from JSON strings", () => {
    const blocks = fromOpenAIMessage({
      content: "ok",
      tool_calls: [
        { id: "a", type: "function", function: { name: "write_file", arguments: '{"path":"main.tsx","content":"x"}' } },
      ],
    });
    expect(blocks).toEqual([
      { type: "text", text: "ok" },
      { type: "tool_use", id: "a", name: "write_file", input: { path: "main.tsx", content: "x" } },
    ]);
  });

  it("marks malformed arguments instead of throwing", () => {
    const [block] = fromOpenAIMessage({
      tool_calls: [{ id: "a", type: "function", function: { name: "compile", arguments: '{"variants": 3' } }],
    });
    expect(block.type).toBe("tool_use");
    const input = (block as { input: Record<string, unknown> }).input;
    expect(input[INVALID_TOOL_ARGUMENTS]).toBeDefined();
    expect(invalidToolArguments(input)?.raw).toBe('{"variants": 3');
  });

  it("mints ids that are missing or repeated", () => {
    const blocks = fromOpenAIMessage(
      {
        tool_calls: [
          { id: "", function: { name: "list_files", arguments: "" } },
          { id: "same", function: { name: "list_files", arguments: "{}" } },
          { id: "same", function: { name: "list_files", arguments: "{}" } },
        ],
      },
      "pfx",
    );
    const ids = blocks.map((b) => (b as { id: string }).id);
    expect(new Set(ids).size).toBe(3);
    expect(ids[0]).toBe("pfx_0");
    expect((blocks[0] as { input: unknown }).input).toEqual({});
  });
});

describe("parseToolArguments", () => {
  it("accepts objects, empty strings and JSON objects; rejects the rest", () => {
    expect(parseToolArguments(undefined)).toEqual({ ok: true, input: {} });
    expect(parseToolArguments("")).toEqual({ ok: true, input: {} });
    expect(parseToolArguments({ a: 1 })).toEqual({ ok: true, input: { a: 1 } });
    expect(parseToolArguments('{"a":1}')).toEqual({ ok: true, input: { a: 1 } });
    expect(parseToolArguments("[1,2]").ok).toBe(false);
    expect(parseToolArguments("null").ok).toBe(false);
    expect(parseToolArguments("{oops").ok).toBe(false);
    expect(parseToolArguments(42).ok).toBe(false);
  });
});

describe("mapFinishReason", () => {
  it.each([
    ["tool_calls", true, false, "tool_use"],
    ["stop", true, true, "tool_use"],
    ["stop", false, true, "end_turn"],
    ["stop", false, false, "empty_response"],
    [null, false, true, "end_turn"],
    ["length", false, true, "max_tokens"],
    ["length", true, false, "max_tokens"],
    ["content_filter", false, false, "content_filter"],
    ["error", false, true, "error"],
    ["something_new", true, true, "unknown_finish"],
  ] as const)("%s (tools=%s, text=%s) -> %s", (finish, tools, text, expected) => {
    expect(mapFinishReason(finish, tools, text)).toBe(expected);
  });
});

describe("parseCompletion", () => {
  it("throws a retryable error on finish_reason error", () => {
    expect(() =>
      parseCompletion({ choices: [{ message: { content: "parz" }, finish_reason: "error" }] }),
    ).toThrow(LlmError);
    try {
      parseCompletion({ choices: [{ message: { content: "" }, finish_reason: "error" }] });
    } catch (e) {
      expect((e as LlmError).retryable).toBe(true);
    }
  });

  it("maps in-band error codes like HTTP statuses", () => {
    try {
      parseCompletion({ error: { code: 402, message: "insufficient credits" } }, "user");
      expect.unreachable();
    } catch (e) {
      expect((e as LlmError).kind).toBe("credit");
      expect((e as LlmError).message).toMatch(/la tua chiave/i);
    }
  });

  it("reports length as max_tokens with usage", () => {
    const r = parseCompletion({
      choices: [{ message: { content: "troncat" }, finish_reason: "length" }],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    });
    expect(r.stop_reason).toBe("max_tokens");
    expect(r.usage).toEqual({ input_tokens: 10, output_tokens: 20 });
  });
});

describe("classifyHttpError", () => {
  it("names whose key failed and keeps retry only for transient errors", () => {
    expect(classifyHttpError(401, "", "user").message).toMatch(/la tua chiave OpenRouter/);
    expect(classifyHttpError(401, "", "org").message).toMatch(/dell'organizzazione/);
    expect(classifyHttpError(402, "", "server").kind).toBe("credit");
    expect(classifyHttpError(429, "", "user").kind).toBe("rate_limit");
    expect(classifyHttpError(429, "", "user").retryable).toBe(false);
    expect(classifyHttpError(503, "", "user").retryable).toBe(true);
    expect(classifyHttpError(400, '{"error":{"message":"bad schema"}}', "server").message).toMatch(/bad schema/);
  });
});

describe("presetModel", () => {
  it("defaults to the policy presets and accepts only preset slugs", () => {
    expect(presetModel("agent", {})).toBe("@preset/3bee-agent");
    expect(presetModel("vision", {})).toBe("@preset/3bee-vision");
    expect(presetModel("fast", {})).toBe("@preset/3bee-fast");
    expect(presetModel("agent", { OPENROUTER_AGENT_PRESET: "@preset/3bee-deep" })).toBe("@preset/3bee-deep");
    expect(presetModel("agent", { OPENROUTER_AGENT_PRESET: "3bee-deep" })).toBe("@preset/3bee-deep");
    expect(() => presetModel("agent", { OPENROUTER_AGENT_PRESET: "deepseek/deepseek-v4.1-flash" })).toThrow(
      /slug di un preset/,
    );
  });
});

describe("resolveKey", () => {
  it("prefers the BYOK key and never falls back when it is broken", () => {
    const env = { OPENROUTER_API_KEY: "sk-or-server" };
    expect(resolveKey({ openrouter: { key: "sk-or-mine", scope: "user" } }, env)).toEqual({
      key: "sk-or-mine",
      who: "user",
    });
    expect(() => resolveKey({ openrouter: { scope: "user", error: "rotta" } }, env)).toThrow("rotta");
    expect(resolveKey({}, env)).toEqual({ key: "sk-or-server", who: "server" });
    expect(() => resolveKey({}, {})).toThrow(/OPENROUTER_API_KEY/);
  });
});

describe("runAgentTurn", () => {
  const ok = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const completion = {
    choices: [{ message: { content: "fatto" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 5, completion_tokens: 7 },
  };
  const req = { system: "s", tools: [], messages: [{ role: "user" as const, content: "ciao" }] };

  beforeEach(() => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-server-key");
    vi.stubEnv("OPENROUTER_AGENT_PRESET", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("calls the agent preset with an explicit max_tokens", async () => {
    const fetchMock = vi.fn(async () => ok(completion));
    vi.stubGlobal("fetch", fetchMock);
    const r = await runAgentTurn(req);
    expect(r.stop_reason).toBe("end_turn");
    expect(r.provider).toContain("@preset/3bee-agent");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("@preset/3bee-agent");
    expect(typeof body.max_tokens).toBe("number");
    expect(body.tools).toBeUndefined();
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-or-server-key");
  });

  it("does not move a failing BYOK turn onto the server key", async () => {
    const fetchMock = vi.fn(async () => new Response('{"error":{"message":"No auth"}}', { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      runAgentTurn(req, { keys: { openrouter: { key: "sk-or-user-key", scope: "user" } } }),
    ).rejects.toMatchObject({ kind: "auth" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-or-user-key");
  });

  it("refuses to run with a stored key that did not decrypt", async () => {
    const fetchMock = vi.fn(async () => ok(completion));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      runAgentTurn(req, { keys: { openrouter: { scope: "org", error: "non decifrabile" } } }),
    ).rejects.toMatchObject({ kind: "key" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retries once on a transient 503, then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("upstream down", { status: 503 }))
      .mockResolvedValueOnce(ok(completion));
    vi.stubGlobal("fetch", fetchMock);
    const r = await runAgentTurn(req);
    expect(r.content).toEqual([{ type: "text", text: "fatto" }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports a network failure as provider unavailable, not a crash", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed", { cause: new Error("ECONNRESET") });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(runAgentTurn(req)).rejects.toMatchObject({
      kind: "unavailable",
      message: expect.stringMatching(/non raggiungibile.*ECONNRESET/),
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops at once when the caller aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn(async () => ok(completion));
    vi.stubGlobal("fetch", fetchMock);
    await expect(runAgentTurn(req, { signal: controller.signal })).rejects.toMatchObject({ kind: "aborted" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends tools in the OpenAI function format with tool_choice auto", async () => {
    const fetchMock = vi.fn(async () => ok(completion));
    vi.stubGlobal("fetch", fetchMock);
    await runAgentTurn({
      ...req,
      tools: [{ name: "compile", description: "c", input_schema: { type: "object", properties: {} } }],
    });
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.tools).toEqual([
      { type: "function", function: { name: "compile", description: "c", parameters: { type: "object", properties: {} } } },
    ]);
    expect(body.tool_choice).toBe("auto");
  });
});
