import { convertCircuitJsonToPcbSvg } from "circuit-to-svg";
import { Resvg } from "@resvg/resvg-js";

/**
 * Post-routing visual review (Fase 3.i): render the routed PCB to a PNG and
 * have a vision model critique it. Numeric metrics (DRC, PRC, ratsnest) catch
 * rule violations; the visual pass catches what numbers miss — ugly routing,
 * trapped areas, bad housekeeping. Same idea as OmniLayout's
 * layout-visualization tool, the biggest improvement vector in their agentic
 * evaluation.
 *
 * Provider-agnostic: tries Gemini (user-confirmed 2026-07-26, default),
 * OpenAI (gpt-5.6-luna, policy model), z.ai GLM — first configured key wins.
 * Fails cleanly when no valid key is available.
 */

interface El {
  type: string;
  [key: string]: unknown;
}

export interface VisualIssue {
  area: string;
  severity: "info" | "warn" | "fail";
  message: string;
  x?: number;
  y?: number;
}

export interface VisualReview {
  ok: boolean;
  provider?: string;
  error?: string;
  issues: VisualIssue[];
  summary: string;
}

export function renderPcbPng(circuitJson: El[]): Buffer {
  const svg = convertCircuitJsonToPcbSvg(circuitJson as never, {
    width: 1024,
    height: 768,
  } as never);
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: 1024 },
    background: "white",
  });
  return resvg.render().asPng();
}

const REVIEW_PROMPT = `You are reviewing a routed PCB image (top copper red, bottom copper blue, pads/vias visible) for an electronics engineer. Board coordinates: center is (0,0), units mm.
List ONLY actionable design issues you can SEE, as JSON: {"issues": [{"area": "short label", "severity": "info|warn|fail", "message": "what and where (estimate x,y mm)", "x": 0, "y": 0}], "summary": "one sentence"}.
Look for: components crammed or poorly oriented vs their connections, traces making long detours, via clusters/congestion, traces nearly touching pads of other nets, unused board areas that would allow spreading, components hanging off the board edge, unruly silkscreen. Do NOT invent electrical issues (nets are not labeled in the image). If it looks fine, return an empty issues list.`;

interface Provider {
  name: string;
  call: (pngB64: string) => Promise<VisualReview>;
}

function parseReviewJson(text: string, provider: string): VisualReview {
  // models sometimes wrap JSON in markdown fences
  const cleaned = text.replace(/^```(?:json)?\s*/m, "").replace(/```\s*$/m, "").trim();
  const parsed = JSON.parse(cleaned) as { issues?: VisualIssue[]; summary?: string };
  return {
    ok: true,
    provider,
    issues: (parsed.issues ?? []).slice(0, 10),
    summary: String(parsed.summary ?? ""),
  };
}

function err(provider: string, message: string): VisualReview {
  return { ok: false, provider, error: message, issues: [], summary: "" };
}

const PROVIDERS: Provider[] = [
  {
    name: "gemini",
    call: async (pngB64) => {
      const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
      if (!apiKey) return err("gemini", "no key");
      // policy del workspace: solo i 5 modelli consentiti, come in llm.ts
      const model = process.env.GEMINI_VISION_MODEL ?? "gemini-3.5-flash";
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify({
            contents: [
              {
                role: "user",
                parts: [
                  { text: REVIEW_PROMPT },
                  { inline_data: { mime_type: "image/png", data: pngB64 } },
                ],
              },
            ],
            generationConfig: { response_mime_type: "application/json", max_output_tokens: 2048 },
          }),
          signal: AbortSignal.timeout(60_000),
        },
      );
      if (!res.ok) return err("gemini", `HTTP ${res.status}: ${(await res.text()).slice(0, 150)}`);
      const data = (await res.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      return parseReviewJson(data.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}", "gemini");
    },
  },
  {
    name: "openai",
    call: async (pngB64) => {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) return err("openai", "no key");
      const model = process.env.OPENAI_VISION_MODEL ?? "gpt-5.6-luna";
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          max_completion_tokens: 2048,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: REVIEW_PROMPT },
                { type: "image_url", image_url: { url: `data:image/png;base64,${pngB64}` } },
              ],
            },
          ],
        }),
        signal: AbortSignal.timeout(90_000),
      });
      if (!res.ok) return err("openai", `HTTP ${res.status}: ${(await res.text()).slice(0, 150)}`);
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      return parseReviewJson(data.choices?.[0]?.message?.content ?? "{}", "openai");
    },
  },
  {
    name: "glm",
    call: async (pngB64) => {
      const apiKey = process.env.GLM_API_KEY;
      if (!apiKey) return err("glm", "no key");
      const base = process.env.GLM_BASE_URL ?? "https://api.z.ai/api/anthropic";
      const model = process.env.GLM_VISION_MODEL ?? process.env.GLM_MODEL ?? "glm-5.2";
      const res = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 2048,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  source: { type: "base64", media_type: "image/png", data: pngB64 },
                },
                { type: "text", text: REVIEW_PROMPT },
              ],
            },
          ],
        }),
        signal: AbortSignal.timeout(90_000),
      });
      if (!res.ok) return err("glm", `HTTP ${res.status}: ${(await res.text()).slice(0, 150)}`);
      const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
      const text = data.content?.find((b) => b.type === "text")?.text ?? "{}";
      return parseReviewJson(text, "glm");
    },
  },
];

/** first provider that works wins; the review is best-effort visual feedback */
export async function reviewLayout(png: Buffer): Promise<VisualReview> {
  const b64 = png.toString("base64");
  const errors: string[] = [];
  for (const provider of PROVIDERS) {
    try {
      const review = await provider.call(b64);
      if (review.ok) return review;
      errors.push(`${provider.name}: ${review.error}`);
    } catch (e) {
      errors.push(`${provider.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return {
    ok: false,
    error: `no vision provider available (${errors.join(" | ")})`,
    issues: [],
    summary: "",
  };
}
