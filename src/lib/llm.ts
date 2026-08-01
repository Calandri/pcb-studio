import type Anthropic from "@anthropic-ai/sdk";
import { GLM_MAX_TOKENS, GLM_MODEL, GLM_THINKING_BUDGET, glmClient } from "./glm";
import type { AgentKeyEntry, AgentKeyMap } from "./llm-keys";

/**
 * One turn of the agent, independent of who executes it.
 *
 * The canonical format stays the Anthropic one (text / tool_use /
 * tool_result blocks): it is the richer of the two and the loop is written
 * against it. Gemini speaks another language, so its backend translates in
 * both directions. This way the model can be switched mid-conversation
 * without rewriting the history.
 */
export interface TurnResult {
  content: Anthropic.ContentBlock[];
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
  /** who actually answered, which may not be the first in the list */
  provider: string;
}

export interface TurnRequest {
  system: string;
  tools: Anthropic.Tool[];
  messages: Anthropic.MessageParam[];
}

/**
 * An error for which it makes sense to move to the next model: quota
 * exhausted, plan expired, overload, missing key. A malformed-request error
 * does NOT belong here: switching models would only repeat it.
 */
function isProviderUnavailable(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status;
  if (status === 429 || status === 401 || status === 403 || status === 529) return true;
  if (typeof status === "number" && status >= 500) return true;
  const text = err instanceof Error ? err.message : String(err ?? "");
  return /rate.?limit|quota|expired|insufficient|overloaded|not configured|no key/i.test(
    text,
  );
}

type Provider = {
  name: string;
  configured: () => boolean;
  run: (req: TurnRequest) => Promise<Omit<TurnResult, "provider">>;
};

/** the name says whose key it is: the chat shows who pays for the turn */
function keySuffix(override?: AgentKeyEntry): string {
  return override ? (override.scope === "user" ? " · chiave tua" : " · chiave org") : "";
}

function makeGlmProvider(override?: AgentKeyEntry): Provider {
  return {
    name: `glm (${GLM_MODEL})${keySuffix(override)}`,
    configured: () => Boolean(override?.key ?? process.env.GLM_API_KEY),
    run: async ({ system, tools, messages }) => {
      const response = await glmClient(override?.key)
        .messages.stream({
          model: GLM_MODEL,
          max_tokens: GLM_MAX_TOKENS,
          thinking: { type: "enabled", budget_tokens: GLM_THINKING_BUDGET },
          system,
          tools,
          messages,
        })
        .finalMessage();
      return {
        content: response.content,
        stop_reason: response.stop_reason ?? "end_turn",
        usage: {
          input_tokens: response.usage?.input_tokens ?? 0,
          output_tokens: response.usage?.output_tokens ?? 0,
        },
      };
    },
  };
}

const glmProvider: Provider = makeGlmProvider();

// ------------------------------------------------------------------ gemini

export const GEMINI_AGENT_MODEL = process.env.GEMINI_AGENT_MODEL ?? "gemini-3.6-flash";

/**
 * Gemini 3.x rejects a schema with keys it does not know. Only the subset it
 * accepts is kept, recursively.
 */
function geminiSchema(schema: unknown): Record<string, unknown> | null {
  if (!schema || typeof schema !== "object") return null;
  const s = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof s.type === "string") out.type = s.type;
  if (typeof s.description === "string") out.description = s.description;
  if (Array.isArray(s.enum)) out.enum = s.enum;
  if (s.items) {
    const items = geminiSchema(s.items);
    if (items) out.items = items;
  }
  if (s.properties && typeof s.properties === "object") {
    const props: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(s.properties as Record<string, unknown>)) {
      const converted = geminiSchema(value);
      if (converted) props[key] = converted;
    }
    // an object with empty properties makes a 400: better not to declare it at all
    if (Object.keys(props).length === 0) return null;
    out.properties = props;
    if (Array.isArray(s.required) && s.required.length > 0) out.required = s.required;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function toGeminiTools(tools: Anthropic.Tool[]): unknown[] {
  return [
    {
      functionDeclarations: tools.map((t) => {
        const parameters = geminiSchema(t.input_schema);
        return {
          name: t.name,
          description: t.description ?? "",
          ...(parameters ? { parameters } : {}),
        };
      }),
    },
  ];
}

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
  /**
   * Gemini 3.x signs its tool calls and DEMANDS the signature back in the
   * next turn ("Function call is missing a thought_signature"). There is no
   * room for a signature in the Anthropic format, so it is kept aside,
   * indexed on the block object: the WeakMap empties itself when the
   * conversation is collected.
   */
  thoughtSignature?: string;
}

const thoughtSignatures = new WeakMap<object, string>();

/**
 * Anthropic history -> Gemini contents. `thinking` blocks are not forwarded:
 * they are another model's reasoning, and Gemini has its own. Tool results
 * are bound by NAME (Gemini does not use ids), so we need to remember which
 * name each tool_use_id had.
 */
function toGeminiContents(messages: Anthropic.MessageParam[]): unknown[] {
  const toolNameById = new Map<string, string>();
  const contents: Array<{ role: "user" | "model"; parts: GeminiPart[] }> = [];

  for (const message of messages) {
    const parts: GeminiPart[] = [];
    if (typeof message.content === "string") {
      if (message.content.trim()) parts.push({ text: message.content });
    } else {
      for (const block of message.content) {
        if (block.type === "text" && block.text.trim()) {
          parts.push({ text: block.text });
        } else if (block.type === "tool_use") {
          toolNameById.set(block.id, block.name);
          const signature = thoughtSignatures.get(block);
          parts.push({
            functionCall: {
              name: block.name,
              args: (block.input ?? {}) as Record<string, unknown>,
            },
            ...(signature ? { thoughtSignature: signature } : {}),
          });
        } else if (block.type === "tool_result") {
          const name = toolNameById.get(block.tool_use_id) ?? "tool";
          parts.push({
            functionResponse: { name, response: toResponseObject(block.content) },
          });
        }
      }
    }
    if (parts.length === 0) continue;
    contents.push({ role: message.role === "assistant" ? "model" : "user", parts });
  }
  return contents;
}

/** Gemini wants an object in `functionResponse.response`: a string makes a 400. */
function toResponseObject(content: unknown): Record<string, unknown> {
  if (typeof content === "string") return { result: content };
  if (Array.isArray(content)) {
    const text = content
      .map((b) => (typeof b === "object" && b && "text" in b ? String((b as { text: unknown }).text) : ""))
      .filter(Boolean)
      .join("\n");
    return { result: text };
  }
  if (content && typeof content === "object") return content as Record<string, unknown>;
  return { result: String(content ?? "") };
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: { message?: string; code?: number };
}

function makeGeminiProvider(override?: AgentKeyEntry): Provider {
  const envKey = () => process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  return {
    name: `gemini (${GEMINI_AGENT_MODEL})${keySuffix(override)}`,
    configured: () => Boolean(override?.key ?? envKey()),
    run: async ({ system, tools, messages }) => {
      const apiKey = override?.key ?? envKey();
      if (!apiKey) throw new Error("GEMINI_API_KEY not configured");

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_AGENT_MODEL}:generateContent`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: toGeminiContents(messages),
          tools: toGeminiTools(tools),
          // ZERO-budget thinking makes a 400 when tools are present: a
          // positive budget is needed. Tool choice stays AUTO (the default):
          // in ANY mode Gemini rejects a wide tool set.
          generationConfig: {
            maxOutputTokens: 32000,
            thinkingConfig: { thinkingBudget: 2048 },
          },
        }),
        signal: AbortSignal.timeout(300_000),
      },
    );

    if (!res.ok) {
      const body = await res.text();
      const error = new Error(`gemini HTTP ${res.status}: ${body.slice(0, 300)}`);
      (error as { status?: number }).status = res.status;
      throw error;
    }

    const data = (await res.json()) as GeminiResponse;
    if (data.error) throw new Error(`gemini: ${data.error.message ?? "unknown error"}`);

    const candidate = data.candidates?.[0];
    const content: Anthropic.ContentBlock[] = [];
    let calls = 0;
    for (const [i, part] of (candidate?.content?.parts ?? []).entries()) {
      if (part.text?.trim()) {
        content.push({ type: "text", text: part.text, citations: null } as Anthropic.ContentBlock);
      } else if (part.functionCall) {
        calls += 1;
        const block = {
          type: "tool_use",
          // Gemini emits no ids: a stable one is minted for the turn
          id: `gemini_${Date.now()}_${i}`,
          name: part.functionCall.name,
          input: part.functionCall.args ?? {},
        } as Anthropic.ContentBlock;
        if (part.thoughtSignature) thoughtSignatures.set(block, part.thoughtSignature);
        content.push(block);
      }
    }

    const finish = candidate?.finishReason ?? "STOP";
    return {
      content,
      stop_reason:
        calls > 0 ? "tool_use" : finish === "MAX_TOKENS" ? "max_tokens" : "end_turn",
      usage: {
        input_tokens: data.usageMetadata?.promptTokenCount ?? 0,
        output_tokens: data.usageMetadata?.candidatesTokenCount ?? 0,
      },
    };
  },
  };
}

const geminiProvider: Provider = makeGeminiProvider();

const PROVIDER_FACTORIES: Record<
  string,
  (override?: AgentKeyEntry) => Provider
> = {
  glm: makeGlmProvider,
  gemini: makeGeminiProvider,
};

/**
 * Preference order, overridable with AGENT_MODELS="gemini,glm". With BYOK
 * keys (user/org), providers with their own key go first; the server's keys
 * (env) stay as fallback at the tail.
 */
function providerChain(keys?: AgentKeyMap): Provider[] {
  const order = (process.env.AGENT_MODELS ?? "glm,gemini")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const chain: Provider[] = [];
  for (const key of order) {
    const factory = PROVIDER_FACTORIES[key];
    if (!factory) continue;
    if (keys?.[key as keyof AgentKeyMap]) {
      chain.push(factory(keys[key as keyof AgentKeyMap]));
    }
  }
  for (const key of order) {
    const factory = PROVIDER_FACTORIES[key];
    if (!factory) continue;
    chain.push(factory());
  }
  return chain.length > 0 ? chain : [glmProvider, geminiProvider];
}

/**
 * Runs a turn with the first available model. If the chosen one is out of
 * service (quota exhausted, plan expired, overload) we move to the next one
 * instead of failing the turn: the product must not stop because a
 * subscription expired. `opts.keys` carries the user's/organization's BYOK
 * keys.
 */
export async function runAgentTurn(
  req: TurnRequest,
  opts?: { keys?: AgentKeyMap },
): Promise<TurnResult> {
  const chain = providerChain(opts?.keys);
  const problems: string[] = [];

  for (const provider of chain) {
    if (!provider.configured()) {
      problems.push(`${provider.name}: nessuna chiave`);
      continue;
    }
    try {
      const result = await provider.run(req);
      return { ...result, provider: provider.name };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      problems.push(`${provider.name}: ${message.slice(0, 200)}`);
      if (!isProviderUnavailable(err)) throw err;
    }
  }

  throw new Error(`nessun modello disponibile — ${problems.join(" | ")}`);
}
