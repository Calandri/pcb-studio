import type { AgentKeyMap } from "./llm-keys";

/**
 * Every model call of PCB Studio, through ONE backend: OpenRouter presets.
 *
 * 3Bee model policy (workspace `catalog/models.yml`): the code names a PRESET,
 * never a model id, so changing model is a dashboard edit with no deploy.
 * - `agent`  -> @preset/3bee-agent  (agentic loops, TEXT ONLY)
 * - `vision` -> @preset/3bee-vision (images: review_layout)
 * - `fast`   -> @preset/3bee-fast   (cheap one-shot tasks: descriptions)
 * Each slug is overridable from env (OPENROUTER_<ROLE>_PRESET) but only with
 * another preset slug: a model id there is a configuration error.
 *
 * The loop keeps its own message representation (text / tool_use /
 * tool_result / thinking blocks, the shape of the Anthropic Messages API it
 * was written against). This module converts it to and from the OpenAI chat
 * format OpenRouter speaks, in both directions.
 */

// ------------------------------------------------------------ message model

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * The model's reasoning as OpenRouter returned it. `signature` carries the
 * raw `reasoning_details`, which must go back unchanged on the next request
 * of the same tool loop (several providers refuse a continuation without it).
 */
export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  signature: string;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | Array<{ type: "text"; text: string }>;
  is_error?: boolean;
}

export interface ImageBlock {
  type: "image";
  source:
    | { type: "base64"; media_type: string; data: string }
    | { type: "url"; url: string };
}

export type ContentBlock = TextBlock | ToolUseBlock | ThinkingBlock;
export type MessageBlock = ContentBlock | ToolResultBlock | ImageBlock;

export interface MessageParam {
  role: "user" | "assistant";
  content: string | MessageBlock[];
}

export interface ToolDefinition {
  name: string;
  description?: string;
  input_schema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
}

/**
 * Why the model stopped. Only `tool_use` continues the loop and only
 * `end_turn` is a normal end: every other value is a visible stop.
 */
export type StopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "content_filter"
  | "empty_response"
  | "error"
  | "unknown_finish";

export interface TurnResult {
  content: ContentBlock[];
  stop_reason: StopReason;
  usage: { input_tokens: number; output_tokens: number };
  /** who answered and with whose key, shown in the chat */
  provider: string;
}

export interface TurnRequest {
  system: string;
  tools: ToolDefinition[];
  messages: MessageParam[];
}

export type PresetRole = "agent" | "vision" | "fast";

export interface TurnOptions {
  /** BYOK keys of the user / organization */
  keys?: AgentKeyMap;
  /** which preset answers (default: agent) */
  preset?: PresetRole;
  /** cancels the request: client gone, run stopped */
  signal?: AbortSignal;
  /** per-request timeout; default per preset */
  timeoutMs?: number;
  /** output budget; default per preset */
  maxTokens?: number;
}

// ------------------------------------------------------------------ errors

export type LlmErrorKind =
  | "config" // server misconfiguration: no key, bad preset slug
  | "key" // the stored BYOK key cannot be used
  | "auth" // 401: key rejected
  | "credit" // 402: no credit on the key
  | "rate_limit" // 429
  | "content_filter" // 403 moderation
  | "bad_request" // 400/404/413: the request itself
  | "unavailable" // network, timeout, 5xx, finish_reason error
  | "aborted"; // the caller cancelled

export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  readonly status?: number;
  constructor(kind: LlmErrorKind, message: string, status?: number) {
    super(message);
    this.name = "LlmError";
    this.kind = kind;
    this.status = status;
  }
  /** transient failures worth one more attempt */
  get retryable(): boolean {
    return this.kind === "unavailable";
  }
}

// ----------------------------------------------------------------- presets

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

const PRESETS: Record<
  PresetRole,
  { env: string; slug: string; maxTokens: number; timeoutMs: number }
> = {
  /*
   * max_tokens is ALWAYS explicit: without it OpenRouter reserves the model's
   * maximum output against the credit before answering, and a low balance
   * turns into 402 on every call. The agent's budget is wide because the
   * preset reasons before answering and the reasoning is paid from it.
   */
  agent: { env: "OPENROUTER_AGENT_PRESET", slug: "3bee-agent", maxTokens: 32_000, timeoutMs: 300_000 },
  vision: { env: "OPENROUTER_VISION_PRESET", slug: "3bee-vision", maxTokens: 6_000, timeoutMs: 120_000 },
  fast: { env: "OPENROUTER_FAST_PRESET", slug: "3bee-fast", maxTokens: 6_000, timeoutMs: 120_000 },
};

const PRESET_SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/** `@preset/<slug>` for a role, from env or the default slug */
export function presetModel(role: PresetRole, env: Record<string, string | undefined> = process.env): string {
  const spec = PRESETS[role];
  const raw = (env[spec.env] ?? "").trim();
  if (!raw) return `@preset/${spec.slug}`;
  const slug = raw.startsWith("@preset/") ? raw.slice("@preset/".length) : raw;
  if (!PRESET_SLUG_RE.test(slug)) {
    throw new LlmError(
      "config",
      `${spec.env} deve essere lo slug di un preset OpenRouter (es. ${spec.slug}), non un id di modello: "${raw.slice(0, 80)}"`,
    );
  }
  return `@preset/${slug}`;
}

// ------------------------------------------------------- OpenAI chat format

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type OpenAIContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type OpenAIMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | OpenAIContentPart[] }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: OpenAIToolCall[];
      reasoning_details?: unknown[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

const REASONING_SIGNATURE_PREFIX = "openrouter.reasoning_details:";

function reasoningDetailsOf(block: ThinkingBlock): unknown[] | null {
  if (!block.signature.startsWith(REASONING_SIGNATURE_PREFIX)) return null;
  try {
    const parsed = JSON.parse(block.signature.slice(REASONING_SIGNATURE_PREFIX.length));
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function toolResultText(block: ToolResultBlock): string {
  if (typeof block.content === "string") return block.content;
  return block.content
    .map((b) => (b && typeof b === "object" && typeof b.text === "string" ? b.text : ""))
    .filter(Boolean)
    .join("\n");
}

function imageUrl(block: ImageBlock): string {
  return block.source.type === "base64"
    ? `data:${block.source.media_type};base64,${block.source.data}`
    : block.source.url;
}

const NO_RESULT_NOTE = "[nessun risultato: la chiamata non e' stata eseguita]";

/**
 * Internal history -> OpenAI chat messages.
 *
 * tool_use blocks become `tool_calls` with JSON-string arguments, tool_result
 * blocks become `role: "tool"` messages bound by `tool_call_id`. The pairing
 * is repaired on the way out: a call without its result gets an explicit
 * "not executed" result, and a result without its call is dropped, because
 * every OpenAI-compatible backend answers 400 to either.
 */
export function toOpenAIMessages(system: string, messages: MessageParam[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  if (system.trim()) out.push({ role: "system", content: system });

  for (const message of messages) {
    if (typeof message.content === "string") {
      if (message.role === "assistant") {
        if (message.content.trim()) out.push({ role: "assistant", content: message.content });
      } else {
        out.push({ role: "user", content: message.content });
      }
      continue;
    }

    if (message.role === "assistant") {
      const text = message.content
        .filter((b): b is TextBlock => b.type === "text")
        .map((b) => b.text)
        .filter((t) => t.trim())
        .join("\n\n");
      const toolCalls: OpenAIToolCall[] = message.content
        .filter((b): b is ToolUseBlock => b.type === "tool_use")
        .map((b) => ({
          id: b.id,
          type: "function",
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        }));
      const details = message.content
        .filter((b): b is ThinkingBlock => b.type === "thinking")
        .flatMap((b) => reasoningDetailsOf(b) ?? []);
      if (!text && toolCalls.length === 0) continue;
      out.push({
        role: "assistant",
        content: text || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        ...(details.length > 0 ? { reasoning_details: details } : {}),
      });
      continue;
    }

    // user message: tool results first (they must follow the assistant's
    // tool_calls directly), then whatever text or image the user added
    const parts: OpenAIContentPart[] = [];
    for (const block of message.content) {
      if (block.type === "tool_result") {
        out.push({ role: "tool", tool_call_id: block.tool_use_id, content: toolResultText(block) });
      } else if (block.type === "text") {
        if (block.text.trim()) parts.push({ type: "text", text: block.text });
      } else if (block.type === "image") {
        parts.push({ type: "image_url", image_url: { url: imageUrl(block) } });
      }
    }
    if (parts.length === 0) continue;
    const onlyText = parts.every((p) => p.type === "text");
    out.push({
      role: "user",
      content: onlyText ? parts.map((p) => (p as { text: string }).text).join("\n\n") : parts,
    });
  }

  return repairToolPairing(out);
}

function repairToolPairing(messages: OpenAIMessage[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  let open: string[] = []; // tool_call ids still waiting for a result
  const flushOpen = () => {
    for (const id of open) out.push({ role: "tool", tool_call_id: id, content: NO_RESULT_NOTE });
    open = [];
  };
  for (const m of messages) {
    if (m.role === "tool") {
      const i = open.indexOf(m.tool_call_id);
      if (i === -1) continue; // orphan result: its call is not in the history
      open.splice(i, 1);
      out.push(m);
      continue;
    }
    flushOpen();
    out.push(m);
    if (m.role === "assistant" && m.tool_calls) open = m.tool_calls.map((c) => c.id);
  }
  flushOpen();
  return out;
}

export function toOpenAITools(tools: ToolDefinition[]): unknown[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description ?? "",
      parameters: t.input_schema,
    },
  }));
}

/**
 * Marker put in a tool_use input when the model sent arguments that are not
 * a JSON object. The loop answers with an error tool result instead of
 * running the tool, so the model sees what went wrong.
 */
export const INVALID_TOOL_ARGUMENTS = "__invalid_tool_arguments";

export function invalidToolArguments(
  input: Record<string, unknown> | null | undefined,
): { error: string; raw: string } | null {
  const marker = input?.[INVALID_TOOL_ARGUMENTS];
  if (!marker || typeof marker !== "object") return null;
  const m = marker as { error?: unknown; raw?: unknown };
  return { error: String(m.error ?? ""), raw: String(m.raw ?? "") };
}

export function parseToolArguments(
  raw: unknown,
): { ok: true; input: Record<string, unknown> } | { ok: false; error: string; raw: string } {
  if (raw === undefined || raw === null) return { ok: true, input: {} };
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return { ok: true, input: raw as Record<string, unknown> };
  }
  if (typeof raw !== "string") {
    return { ok: false, error: `arguments of type ${typeof raw}`, raw: String(raw).slice(0, 2000) };
  }
  if (!raw.trim()) return { ok: true, input: {} };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "arguments are not a JSON object", raw: raw.slice(0, 2000) };
    }
    return { ok: true, input: parsed as Record<string, unknown> };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      raw: raw.slice(0, 2000),
    };
  }
}

interface OpenAIResponseMessage {
  content?: string | Array<{ type?: string; text?: string }> | null;
  refusal?: string | null;
  reasoning?: string | null;
  reasoning_details?: unknown;
  tool_calls?: Array<{
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: unknown };
  }> | null;
}

/** OpenAI assistant message -> internal content blocks */
export function fromOpenAIMessage(
  message: OpenAIResponseMessage | null | undefined,
  idPrefix = `call_${Date.now().toString(36)}`,
): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  if (!message) return blocks;

  if (Array.isArray(message.reasoning_details) && message.reasoning_details.length > 0) {
    blocks.push({
      type: "thinking",
      thinking: typeof message.reasoning === "string" ? message.reasoning : "",
      signature: REASONING_SIGNATURE_PREFIX + JSON.stringify(message.reasoning_details),
    });
  }

  const text =
    typeof message.content === "string"
      ? message.content
      : Array.isArray(message.content)
        ? message.content.map((p) => (typeof p?.text === "string" ? p.text : "")).join("")
        : "";
  if (text.trim()) {
    blocks.push({ type: "text", text });
  } else if (typeof message.refusal === "string" && message.refusal.trim()) {
    blocks.push({ type: "text", text: message.refusal });
  }

  const seen = new Set<string>();
  for (const [i, call] of (message.tool_calls ?? []).entries()) {
    if (!call) continue;
    let id = typeof call.id === "string" ? call.id.trim() : "";
    // some backends omit or repeat ids: the loop binds results by id
    if (!id || seen.has(id)) id = `${idPrefix}_${i}`;
    seen.add(id);
    const parsed = parseToolArguments(call.function?.arguments);
    blocks.push({
      type: "tool_use",
      id,
      name: String(call.function?.name ?? ""),
      input: parsed.ok
        ? parsed.input
        : { [INVALID_TOOL_ARGUMENTS]: { error: parsed.error, raw: parsed.raw } },
    });
  }
  return blocks;
}

/**
 * OpenAI finish_reason -> StopReason. Explicit on purpose: before, anything
 * that was not a tool call ended the turn like a finished answer, so a
 * truncated or filtered reply looked like the agent had simply stopped.
 */
export function mapFinishReason(
  finish: string | null | undefined,
  hasToolCalls: boolean,
  hasText: boolean,
): StopReason {
  switch (finish) {
    case "length":
      return "max_tokens";
    case "content_filter":
      return "content_filter";
    case "error":
      return "error";
    case "tool_calls":
    case "function_call":
    case "stop":
    case null:
    case undefined:
    case "":
      if (hasToolCalls) return "tool_use";
      return hasText ? "end_turn" : "empty_response";
    default:
      return "unknown_finish";
  }
}

// --------------------------------------------------------------- transport

type Who = "user" | "org" | "server";

function whoLabel(who: Who): string {
  if (who === "user") return "la tua chiave OpenRouter";
  if (who === "org") return "la chiave OpenRouter dell'organizzazione";
  return "la chiave OpenRouter del server";
}

function keySuffix(who: Who): string {
  if (who === "user") return " · chiave tua";
  if (who === "org") return " · chiave org";
  return "";
}

/**
 * The key for this call. A BYOK key, when present, is the ONLY candidate: if
 * it fails, the error is reported, the turn does not move onto the server's
 * key (whoever set a key expects to pay, and expects to know when it breaks).
 */
export function resolveKey(
  keys: AgentKeyMap | undefined,
  env: Record<string, string | undefined> = process.env,
): { key: string; who: Who } {
  const entry = keys?.openrouter;
  if (entry) {
    if (entry.error !== undefined) throw new LlmError("key", entry.error);
    return { key: entry.key, who: entry.scope };
  }
  const server = env.OPENROUTER_API_KEY?.trim();
  if (!server) {
    throw new LlmError(
      "config",
      "Nessuna chiave OpenRouter disponibile: il server non ha OPENROUTER_API_KEY e non c'e' una chiave personale o dell'organizzazione.",
    );
  }
  return { key: server, who: "server" };
}

function upstreamMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } | string };
    const msg = typeof parsed.error === "string" ? parsed.error : parsed.error?.message;
    if (typeof msg === "string" && msg.trim()) return msg.trim().slice(0, 300);
  } catch {
    // not JSON: fall through
  }
  return body.trim().slice(0, 200);
}

/** HTTP status (or OpenRouter error code) -> LlmError, in Italian for the chat */
export function classifyHttpError(status: number, body: string, who: Who): LlmError {
  const detail = upstreamMessage(body);
  const tail = detail ? `: ${detail}` : "";
  switch (status) {
    case 401:
      return new LlmError("auth", `OpenRouter ha rifiutato ${whoLabel(who)} (401)${tail}`, status);
    case 402:
      return new LlmError("credit", `${capitalize(whoLabel(who))} non ha credito sufficiente (402)${tail}`, status);
    case 403:
      return new LlmError("content_filter", `OpenRouter ha bloccato la richiesta (403, moderazione)${tail}`, status);
    case 404:
      return new LlmError("bad_request", `Preset non trovato o senza un modello adatto alla richiesta (404)${tail}`, status);
    case 408:
      return new LlmError("unavailable", `OpenRouter non ha risposto in tempo (408)${tail}`, status);
    case 413:
      return new LlmError("bad_request", `Richiesta troppo grande per il modello (413)${tail}`, status);
    case 429:
      return new LlmError("rate_limit", `Troppe richieste con ${whoLabel(who)} (429): riprova fra poco${tail}`, status);
    default:
      if (status >= 500) {
        return new LlmError("unavailable", `Modello non disponibile in questo momento (${status})${tail}`, status);
      }
      return new LlmError("bad_request", `Richiesta rifiutata dal modello (${status})${tail}`, status);
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

interface OpenAIChatResponse {
  choices?: Array<{
    message?: OpenAIResponseMessage;
    finish_reason?: string | null;
    native_finish_reason?: string | null;
    error?: { code?: number; message?: string };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { code?: number | string; message?: string };
}

/** one signal that fires on the caller's abort OR on the timeout */
function linkedSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; timedOut: () => boolean; dispose: () => void } {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) controller.abort(parent.reason);
  else parent?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("timeout"));
  }, Math.max(1, timeoutMs));
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}

async function postChat(
  body: Record<string, unknown>,
  key: string,
  who: Who,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<OpenAIChatResponse> {
  if (signal?.aborted) throw new LlmError("aborted", "richiesta annullata");
  const linked = linkedSignal(signal, timeoutMs);
  try {
    let res: Response;
    let text: string;
    try {
      res = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          "x-title": "PCB Studio",
        },
        body: JSON.stringify(body),
        signal: linked.signal,
      });
      text = await res.text();
    } catch (err) {
      if (signal?.aborted) throw new LlmError("aborted", "richiesta annullata");
      if (linked.timedOut()) {
        throw new LlmError(
          "unavailable",
          `OpenRouter non ha risposto entro ${Math.round(timeoutMs / 1000)} s`,
        );
      }
      const cause = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err);
      throw new LlmError("unavailable", `OpenRouter non raggiungibile: ${cause.slice(0, 200)}`);
    }
    if (!res.ok) throw classifyHttpError(res.status, text, who);
    try {
      return JSON.parse(text) as OpenAIChatResponse;
    } catch {
      throw new LlmError("unavailable", "Risposta di OpenRouter non leggibile (non e' JSON)");
    }
  } finally {
    linked.dispose();
  }
}

/** the completion body -> TurnResult (minus provider); throws on in-band errors */
export function parseCompletion(data: OpenAIChatResponse, who: Who = "server"): Omit<TurnResult, "provider"> {
  if (data.error) {
    const code = Number(data.error.code);
    const body = JSON.stringify({ error: { message: data.error.message ?? "" } });
    throw Number.isFinite(code) && code >= 400
      ? classifyHttpError(code, body, who)
      : new LlmError("unavailable", `Errore del modello: ${String(data.error.message ?? "sconosciuto").slice(0, 300)}`);
  }
  const choice = data.choices?.[0];
  if (!choice) throw new LlmError("unavailable", "Risposta del modello senza contenuto (nessuna choice)");
  if (choice.error || choice.finish_reason === "error") {
    const msg = choice.error?.message ?? choice.native_finish_reason ?? "errore del provider";
    throw new LlmError("unavailable", `Il modello si e' interrotto a meta' risposta: ${String(msg).slice(0, 200)}`);
  }
  const content = fromOpenAIMessage(choice.message);
  const hasToolCalls = content.some((b) => b.type === "tool_use");
  const hasText = content.some((b) => b.type === "text" && b.text.trim().length > 0);
  return {
    content,
    stop_reason: mapFinishReason(choice.finish_reason, hasToolCalls, hasText),
    usage: {
      input_tokens: Number(data.usage?.prompt_tokens ?? 0) || 0,
      output_tokens: Number(data.usage?.completion_tokens ?? 0) || 0,
    },
  };
}

const RETRY_DELAY_MS = 1_500;
/** a second attempt with less time than this would only time out */
const MIN_ATTEMPT_MS = 10_000;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new LlmError("aborted", "richiesta annullata"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new LlmError("aborted", "richiesta annullata"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Runs one model turn on the role's preset.
 *
 * Transient failures (network, timeout, 5xx, a reply cut mid-way) get ONE
 * more attempt; everything else is reported as it is. Auth, credit and rate
 * limit errors on a BYOK key are never retried on the server's key.
 */
export async function runAgentTurn(req: TurnRequest, opts: TurnOptions = {}): Promise<TurnResult> {
  const role = opts.preset ?? "agent";
  const spec = PRESETS[role];
  const model = presetModel(role);
  const { key, who } = resolveKey(opts.keys);
  const timeoutMs = Math.max(1_000, Math.min(opts.timeoutMs ?? spec.timeoutMs, spec.timeoutMs));
  const body: Record<string, unknown> = {
    model,
    messages: toOpenAIMessages(req.system, req.messages),
    max_tokens: opts.maxTokens ?? spec.maxTokens,
    stream: false,
    ...(req.tools.length > 0 ? { tools: toOpenAITools(req.tools), tool_choice: "auto" } : {}),
  };

  // the timeout is the budget of the whole call, retry included: a caller
  // with a deadline must never be overrun by the second attempt
  const endAt = Date.now() + timeoutMs;
  let lastError: LlmError | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      if (endAt - Date.now() < RETRY_DELAY_MS + MIN_ATTEMPT_MS) break;
      await sleep(RETRY_DELAY_MS, opts.signal);
    }
    try {
      const data = await postChat(body, key, who, opts.signal, endAt - Date.now());
      return { ...parseCompletion(data, who), provider: `openrouter · ${model}${keySuffix(who)}` };
    } catch (err) {
      const e = err instanceof LlmError ? err : new LlmError("unavailable", String(err));
      if (!e.retryable || opts.signal?.aborted) throw e;
      lastError = e;
    }
  }
  throw lastError ?? new LlmError("unavailable", "Modello non disponibile");
}

// --------------------------------------------------------- history shaping

/** caps a text fed back to the model, saying how much was cut */
export function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[risultato troncato: mostrati ${max} di ${text.length} caratteri]`;
}

/**
 * Which tool calls make earlier ones stale: same key, only the last `keep`
 * stay in full. E.g. compile results (key "board", keep 2), reads and writes
 * of one file (key "file:main.tsx", keep 1).
 */
export type SupersessionOf = (
  name: string,
  input: Record<string, unknown>,
) => { key: string; keep: number } | null;

const PRUNE_MIN_CHARS = 400;

function omittedResult(content: string): string {
  let message = "";
  try {
    const parsed = JSON.parse(content) as { message?: unknown };
    if (typeof parsed?.message === "string") message = parsed.message.slice(0, 300);
  } catch {
    // not JSON: the length alone
  }
  return message
    ? `[risultato precedente omesso: ${content.length} caratteri; message: ${JSON.stringify(message)}]`
    : `[risultato precedente omesso: ${content.length} caratteri]`;
}

/**
 * Replaces the bulk of superseded tool calls with a short data note: the
 * history is re-sent whole at every step, and twenty old compile results or
 * five old copies of main.tsx are paid on every later turn. The note states
 * what was there, it does not tell the model what to do.
 *
 * Mutates `messages` in place; returns the characters saved.
 */
export function compactHistory(messages: MessageParam[], supersessionOf: SupersessionOf): number {
  interface Occurrence {
    use: ToolUseBlock;
    result: ToolResultBlock | null;
  }
  const results = new Map<string, ToolResultBlock>();
  for (const m of messages) {
    if (m.role !== "user" || typeof m.content === "string") continue;
    for (const b of m.content) if (b.type === "tool_result") results.set(b.tool_use_id, b);
  }
  const groups = new Map<string, { keep: number; items: Occurrence[] }>();
  for (const m of messages) {
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    for (const b of m.content) {
      if (b.type !== "tool_use") continue;
      const s = supersessionOf(b.name, b.input ?? {});
      if (!s) continue;
      const group = groups.get(s.key) ?? { keep: Math.max(1, s.keep), items: [] };
      group.items.push({ use: b, result: results.get(b.id) ?? null });
      groups.set(s.key, group);
    }
  }

  let saved = 0;
  for (const group of groups.values()) {
    for (const item of group.items.slice(0, -group.keep)) {
      if (item.result) {
        const text = toolResultText(item.result);
        if (text.length >= PRUNE_MIN_CHARS) {
          const note = omittedResult(text);
          saved += text.length - note.length;
          item.result.content = note;
        }
      }
      for (const [field, value] of Object.entries(item.use.input ?? {})) {
        if (typeof value === "string" && value.length >= PRUNE_MIN_CHARS) {
          const note = `[contenuto omesso: ${value.length} caratteri]`;
          saved += value.length - note.length;
          item.use.input[field] = note;
        }
      }
    }
  }
  return saved;
}
