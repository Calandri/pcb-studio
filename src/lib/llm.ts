import type Anthropic from "@anthropic-ai/sdk";
import { GLM_MAX_TOKENS, GLM_MODEL, GLM_THINKING_BUDGET, glmClient } from "./glm";

/**
 * Un turno dell'agente, indipendente da chi lo esegue.
 *
 * Il formato canonico resta quello Anthropic (blocchi text / tool_use /
 * tool_result): e' il piu' ricco dei due e il loop e' scritto su quello. Gemini
 * parla un'altra lingua, quindi il suo backend traduce in entrambe le
 * direzioni. Cosi' si puo' cambiare modello a meta' conversazione senza
 * riscrivere la cronologia.
 */
export interface TurnResult {
  content: Anthropic.ContentBlock[];
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
  /** chi ha risposto davvero, che puo' non essere il primo della lista */
  provider: string;
}

export interface TurnRequest {
  system: string;
  tools: Anthropic.Tool[];
  messages: Anthropic.MessageParam[];
}

/**
 * Un errore per cui ha senso passare al modello successivo: quota finita,
 * piano scaduto, sovraccarico, chiave assente. Un errore di richiesta mal
 * formata NON entra qui: cambiare modello lo ripeterebbe soltanto.
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

const glmProvider: Provider = {
  name: `glm (${GLM_MODEL})`,
  configured: () => Boolean(process.env.GLM_API_KEY),
  run: async ({ system, tools, messages }) => {
    const response = await glmClient()
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

// ------------------------------------------------------------------ gemini

export const GEMINI_AGENT_MODEL = process.env.GEMINI_AGENT_MODEL ?? "gemini-3.6-flash";

/**
 * Gemini 3.x rifiuta uno schema con chiavi che non conosce. Si tiene solo il
 * sottoinsieme che accetta, ricorsivamente.
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
    // un oggetto con properties vuoto fa 400: meglio non dichiararlo affatto
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
   * Gemini 3.x firma le sue chiamate a tool e PRETENDE la firma indietro nel
   * turno successivo ("Function call is missing a thought_signature"). Non c'e'
   * posto per una firma nel formato Anthropic, quindi si tiene a parte,
   * indicizzata sull'oggetto del blocco: la WeakMap si svuota da sola quando la
   * conversazione viene raccolta.
   */
  thoughtSignature?: string;
}

const thoughtSignatures = new WeakMap<object, string>();

/**
 * Cronologia Anthropic -> contenuti Gemini. I blocchi `thinking` non si
 * inoltrano: sono il ragionamento di un altro modello, e Gemini ha il suo.
 * I risultati dei tool si legano per NOME (Gemini non usa gli id), quindi
 * serve ricordare quale nome aveva ogni tool_use_id.
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

/** Gemini vuole un oggetto in `functionResponse.response`: una stringa fa 400. */
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

const geminiProvider: Provider = {
  name: `gemini (${GEMINI_AGENT_MODEL})`,
  configured: () =>
    Boolean(process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY),
  run: async ({ system, tools, messages }) => {
    const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
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
          // il thinking a budget ZERO fa 400 quando ci sono i tool: serve un
          // budget positivo. La scelta dei tool resta AUTO (il default): in
          // modo ANY Gemini rifiuta un set di tool ampio.
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
          // Gemini non emette id: se ne conia uno stabile per il turno
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

const PROVIDERS: Record<string, Provider> = {
  glm: glmProvider,
  gemini: geminiProvider,
};

/** ordine di preferenza, sovrascrivibile con AGENT_MODELS="gemini,glm" */
function providerChain(): Provider[] {
  const order = (process.env.AGENT_MODELS ?? "glm,gemini")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const chain = order.map((key) => PROVIDERS[key]).filter(Boolean);
  return chain.length > 0 ? chain : [glmProvider];
}

/**
 * Esegue un turno col primo modello disponibile. Se quello scelto e' fuori uso
 * (quota finita, piano scaduto, sovraccarico) si passa al successivo invece di
 * far fallire il turno: il prodotto non deve fermarsi perche' e' scaduto un
 * abbonamento.
 */
export async function runAgentTurn(req: TurnRequest): Promise<TurnResult> {
  const chain = providerChain();
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
