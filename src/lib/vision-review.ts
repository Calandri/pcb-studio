import { convertCircuitJsonToPcbSvg } from "circuit-to-svg";
import { Resvg } from "@resvg/resvg-js";
import { runAgentTurn } from "./llm";
import type { AgentKeyMap } from "./llm-keys";

/**
 * Post-routing visual review (Fase 3.i): render the routed PCB to a PNG and
 * have a vision model critique it. Numeric metrics (DRC, PRC, ratsnest) catch
 * rule violations; the visual pass catches what numbers miss — ugly routing,
 * trapped areas, bad housekeeping. Same idea as OmniLayout's
 * layout-visualization tool, the biggest improvement vector in their agentic
 * evaluation.
 *
 * One backend, the OpenRouter preset for images (@preset/3bee-vision, 3Bee
 * model policy). It is paid with the key of whoever asked (BYOK) when there
 * is one, the server's otherwise. Fails cleanly, as a result, never a throw:
 * the review is a bonus check.
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

const SEVERITIES = new Set(["info", "warn", "fail"]);

/**
 * The model's JSON, read defensively: it is untrusted output (fences, prose
 * around it, wrong types), so only well-formed issues pass, strings capped.
 */
export function parseReviewJson(text: string, provider: string): VisualReview {
  const cleaned = text.replace(/^```(?:json)?\s*/m, "").replace(/```\s*$/m, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) return err(provider, "la risposta del modello non contiene JSON");
  let parsed: { issues?: unknown; summary?: unknown };
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1)) as typeof parsed;
  } catch {
    return err(provider, "JSON della revisione non valido");
  }
  const issues: VisualIssue[] = [];
  for (const raw of Array.isArray(parsed.issues) ? parsed.issues : []) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const message = typeof r.message === "string" ? r.message.trim().slice(0, 400) : "";
    if (!message) continue;
    const severity = typeof r.severity === "string" && SEVERITIES.has(r.severity) ? r.severity : "info";
    issues.push({
      area: typeof r.area === "string" ? r.area.slice(0, 80) : "",
      severity: severity as VisualIssue["severity"],
      message,
      ...(typeof r.x === "number" && Number.isFinite(r.x) ? { x: r.x } : {}),
      ...(typeof r.y === "number" && Number.isFinite(r.y) ? { y: r.y } : {}),
    });
    if (issues.length >= 10) break;
  }
  return {
    ok: true,
    provider,
    issues,
    summary: typeof parsed.summary === "string" ? parsed.summary.slice(0, 400) : "",
  };
}

function err(provider: string, message: string): VisualReview {
  return { ok: false, provider, error: message, issues: [], summary: "" };
}

/**
 * Asks the vision preset for a critique of the rendered board. `keys` are the
 * BYOK keys of the viewer who asked (absent: server key); `signal` cancels
 * the call when the run stops.
 */
export async function reviewLayout(
  png: Buffer,
  opts: { keys?: AgentKeyMap; signal?: AbortSignal } = {},
): Promise<VisualReview> {
  try {
    const turn = await runAgentTurn(
      {
        system: "",
        tools: [],
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: png.toString("base64") },
              },
              { type: "text", text: REVIEW_PROMPT },
            ],
          },
        ],
      },
      { keys: opts.keys, preset: "vision", signal: opts.signal },
    );
    if (turn.stop_reason !== "end_turn") {
      return err(turn.provider, `risposta incompleta del modello di visione (${turn.stop_reason})`);
    }
    const text = turn.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("\n");
    return parseReviewJson(text, turn.provider);
  } catch (e) {
    return {
      ok: false,
      error: `revisione visiva non disponibile: ${e instanceof Error ? e.message : String(e)}`,
      issues: [],
      summary: "",
    };
  }
}
