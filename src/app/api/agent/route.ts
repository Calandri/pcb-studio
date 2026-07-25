import type Anthropic from "@anthropic-ai/sdk";
import { executeTool, TOOL_DEFINITIONS } from "@/lib/agent-tools";
import { appendChatMessage } from "@/lib/project-store";
import { GLM_MAX_TOKENS, GLM_MODEL, GLM_THINKING_BUDGET, glmClient } from "@/lib/glm";
import { SYSTEM_PROMPT } from "@/lib/system-prompt";

export const runtime = "nodejs";
export const maxDuration = 300;

// Resource cap only (billing/runaway protection), not flow logic: the loop's
// sole termination condition is the model producing final text.
const MAX_STEPS = 40;

interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

interface AgentRequest {
  projectId?: string;
  history: ChatTurn[];
}

function sseEncode(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
  );
}

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json()) as AgentRequest;
  const projectId = body.projectId ?? "default";
  const history = Array.isArray(body.history) ? body.history.slice(-40) : [];
  if (history.length === 0 || history[history.length - 1].role !== "user") {
    return new Response(JSON.stringify({ error: "history must end with a user message" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
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

      let assistantTranscript = "";
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
            emit("done", { stop_reason: response.stop_reason });
            break;
          }

          // preserve the full content (incl. thinking blocks) in the history
          messages.push({ role: "assistant", content: response.content });

          const toolResults: Anthropic.ToolResultBlockParam[] = [];
          for (const toolUse of toolUses) {
            const args = (toolUse.input ?? {}) as Record<string, unknown>;
            emit("tool_call", { name: toolUse.name, args: summarizeArgs(toolUse.name, args) });

            const { result, fileChanged } = await executeTool(projectId, toolUse.name, args);
            if (fileChanged) emit("file_changed", fileChanged);
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
            emit("error", { message: "Step cap reached: stopping this run." });
            emit("done", { stop_reason: "step_cap" });
          }
        }
      } catch (err) {
        emit("error", { message: err instanceof Error ? err.message : String(err) });
        emit("done", { stop_reason: "error" });
      } finally {
        if (assistantTranscript) {
          await appendChatMessage(projectId, "assistant", assistantTranscript).catch(() => {});
        }
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
