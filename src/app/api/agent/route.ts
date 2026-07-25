import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { executeTool, TOOL_DEFINITIONS } from "@/lib/agent-tools";
import {
  appendChatMessage,
  countRecentRunsByIp,
  getProject,
  recordAgentRun,
  saveRevision,
} from "@/lib/project-store";
import { GLM_MAX_TOKENS, GLM_MODEL, GLM_THINKING_BUDGET, glmClient } from "@/lib/glm";
import { SYSTEM_PROMPT } from "@/lib/system-prompt";

export const runtime = "nodejs";
export const maxDuration = 300;

// Resource cap only (billing/runaway protection), not flow logic: the loop's
// sole termination condition is the model producing final text.
const MAX_STEPS = 40;
const MAX_RUNS_PER_IP_PER_HOUR = 30;

const AgentRequestSchema = z.object({
  projectId: z
    .string()
    .regex(/^[\w-]{1,64}$/)
    .default("default"),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().max(20_000),
      }),
    )
    .min(1)
    .max(200),
});

function sseEncode(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
  );
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function POST(req: Request): Promise<Response> {
  const parsed = AgentRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError("invalid request body", 400);
  const { projectId } = parsed.data;
  const history = parsed.data.history.slice(-40);
  if (history[history.length - 1].role !== "user") {
    return jsonError("history must end with a user message", 400);
  }

  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  if ((await countRecentRunsByIp(ip).catch(() => 0)) >= MAX_RUNS_PER_IP_PER_HOUR) {
    return jsonError("rate limit exceeded, retry later", 429);
  }

  const client = glmClient();
  const messages: Anthropic.MessageParam[] = history.map((t) => ({
    role: t.role,
    content: t.content,
  }));

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: string, data: unknown) =>
        controller.enqueue(sseEncode(event, data));

      const startedAt = Date.now();
      let assistantTranscript = "";
      let steps = 0;
      let tokensIn = 0;
      let tokensOut = 0;
      let stopReason = "unknown";
      let filesChanged = false;
      let lastCompileSummary: unknown = null;

      try {
        await appendChatMessage(projectId, "user", history[history.length - 1].content);
        for (let step = 0; step < MAX_STEPS; step++) {
          const response = await client.messages
            .stream({
              model: GLM_MODEL,
              max_tokens: GLM_MAX_TOKENS,
              thinking: { type: "enabled", budget_tokens: GLM_THINKING_BUDGET },
              system: SYSTEM_PROMPT,
              tools: TOOL_DEFINITIONS,
              messages,
            })
            .finalMessage();

          steps += 1;
          tokensIn += response.usage?.input_tokens ?? 0;
          tokensOut += response.usage?.output_tokens ?? 0;

          for (const block of response.content) {
            if (block.type === "text" && block.text.trim()) {
              assistantTranscript += (assistantTranscript ? "\n\n" : "") + block.text;
              emit("assistant_text", { text: block.text });
            }
          }

          const toolUses = response.content.filter(
            (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
          );

          if (toolUses.length === 0 || response.stop_reason !== "tool_use") {
            stopReason = response.stop_reason ?? "end_turn";
            emit("done", { stop_reason: stopReason });
            break;
          }

          // preserve the full content (incl. thinking blocks) in the history
          messages.push({ role: "assistant", content: response.content });

          const toolResults: Anthropic.ToolResultBlockParam[] = [];
          for (const toolUse of toolUses) {
            const args = (toolUse.input ?? {}) as Record<string, unknown>;
            emit("tool_call", { name: toolUse.name, args: summarizeArgs(toolUse.name, args) });

            const { result, fileChanged } = await executeTool(projectId, toolUse.name, args);
            if (fileChanged) {
              filesChanged = true;
              emit("file_changed", fileChanged);
            }
            if (toolUse.name === "compile") lastCompileSummary = result;
            emit("tool_result", {
              name: toolUse.name,
              result: toolUse.name === "read_file" ? { truncated: true } : result,
            });

            toolResults.push({
              type: "tool_result",
              tool_use_id: toolUse.id,
              content: JSON.stringify(result),
            });
          }
          messages.push({ role: "user", content: toolResults });

          if (step === MAX_STEPS - 1) {
            stopReason = "step_cap";
            emit("error", { message: "Step cap reached: stopping this run." });
            emit("done", { stop_reason: stopReason });
          }
        }
      } catch (err) {
        stopReason = "error";
        emit("error", { message: err instanceof Error ? err.message : String(err) });
        emit("done", { stop_reason: stopReason });
      } finally {
        if (assistantTranscript) {
          await appendChatMessage(projectId, "assistant", assistantTranscript).catch(() => {});
        }
        if (filesChanged) {
          // una revisione per turno agente che ha modificato file: rollback/audit
          const files = await getProject(projectId).catch(() => null);
          if (files) await saveRevision(projectId, files, lastCompileSummary).catch(() => {});
        }
        await recordAgentRun({
          projectId,
          ip,
          steps,
          tokensIn,
          tokensOut,
          stopReason,
          durationMs: Date.now() - startedAt,
        }).catch(() => {});
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}

/** compact args for the chat UI chips (never ship whole file contents twice) */
function summarizeArgs(name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (name === "write_file") {
    return { path: args.path, chars: String(args.content ?? "").length };
  }
  return args;
}
