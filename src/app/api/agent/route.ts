import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { executeTool, TOOL_DEFINITIONS } from "@/lib/agent-tools";
import { claimProject, currentViewer, projectAccess } from "@/lib/acl";
import { getAgentKeys } from "@/lib/llm-keys";
import { listUserOrganizations } from "@/lib/org-store";
import {
  appendChatMessage,
  countRecentRunsByIp,
  getProject,
  recordAgentRun,
  saveRevision,
} from "@/lib/project-store";
import { runAgentTurn } from "@/lib/llm";
import { SYSTEM_PROMPT } from "@/lib/system-prompt";

export const runtime = "nodejs";
// Vercel kills the function beyond this limit: long turns (large boards,
// many compiles) exceeded 300s and the user never saw the response.
export const maxDuration = 800;

// Resource cap only (billing/runaway protection), not flow logic: the loop's
// sole termination condition is the model producing final text.
const MAX_STEPS = 40;
const MAX_RUNS_PER_IP_PER_HOUR = 30;

/*
 * Tools that do not touch the project state. Only a turn in which ALL the
 * requested tools are in this set is executed in parallel: a batch that also
 * contains a write stays serial, otherwise a write_file and a compile issued
 * together would race against each other.
 */
const READ_ONLY_TOOLS = new Set([
  "list_files",
  "read_file",
  "search_parts",
  "library_list",
  "library_read",
  "list_datasheets",
  "read_datasheet",
  "simulate",
  "compile",
  "review_layout",
]);

/*
 * Compile results are the largest object in circulation (for a real board they
 * are tens of thousands of characters: unroutedDetail, ratsnest,
 * schematicQuality...) and the history is re-sent WHOLE at every step. After
 * twenty compiles the first nineteen are dead history you pay for on every
 * turn, so only the most recent ones are kept in full.
 */
const FULL_COMPILE_RESULTS_KEPT = 2;
const PRUNABLE_TOOLS = new Set(["compile", "review_layout"]);

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

  // only authenticated users with edit access to the project: the agent
  // consumes tokens and rewrites the files
  const viewer = await currentViewer();
  if (!viewer) return jsonError("unauthenticated", 401);
  if ((await projectAccess(projectId, viewer)) !== "edit") {
    return jsonError("forbidden: no edit access to this project", 403);
  }
  const orgs = await listUserOrganizations(viewer.userId).catch(() => []);
  await claimProject(projectId, viewer, orgs[0]?.id ?? null).catch(() => {});
  // BYOK: the turn is paid for with the user's or their organization's keys,
  // if any; otherwise with the server's keys
  const agentKeys = await getAgentKeys(
    viewer.userId,
    orgs.map((o) => o.id),
  ).catch(() => ({}));

  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  if ((await countRecentRunsByIp(ip).catch(() => 0)) >= MAX_RUNS_PER_IP_PER_HOUR) {
    return jsonError("rate limit exceeded, retry later", 429);
  }

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
      let persistedText = false;
      let steps = 0;
      let tokensIn = 0;
      let tokensOut = 0;
      let stopReason = "unknown";
      let filesChanged = false;
      let lastCompileSummary: unknown = null;
      let lastProvider = "";
      const prunable: PrunableRef[] = [];

      try {
        await appendChatMessage(projectId, "user", history[history.length - 1].content);
        for (let step = 0; step < MAX_STEPS; step++) {
          const response = await runAgentTurn(
            {
              system: SYSTEM_PROMPT,
              tools: TOOL_DEFINITIONS,
              messages,
            },
            { keys: agentKeys },
          );
          if (response.provider !== lastProvider) {
            lastProvider = response.provider;
            emit("provider", { provider: response.provider });
          }

          steps += 1;
          tokensIn += response.usage.input_tokens;
          tokensOut += response.usage.output_tokens;

          for (const block of response.content) {
            if (block.type === "text" && block.text.trim()) {
              assistantTranscript += (assistantTranscript ? "\n\n" : "") + block.text;
              emit("assistant_text", { text: block.text });
              // immediate persistence: if the turn is cut short mid-way, on
              // reload the user still finds what the agent said
              void appendChatMessage(projectId, "assistant", block.text).catch(() => {});
              persistedText = true;
            }
          }

          const toolUses = response.content.filter(
            (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
          );

          if (toolUses.length === 0 || response.stop_reason !== "tool_use") {
            stopReason = response.stop_reason;
            // a turn cut short mid-way used to exit with the same "done" as a
            // finished one: the user saw the response stop for no reason
            if (stopReason === "max_tokens") {
              emit("error", {
                message:
                  "Risposta troncata: il turno ha esaurito il budget di token. Chiedi all'agente di continuare.",
              });
            }
            emit("done", { stop_reason: stopReason });
            break;
          }

          // preserve the full content (incl. thinking blocks) in the history
          messages.push({ role: "assistant", content: response.content });

          const runOne = async (
            toolUse: Anthropic.ToolUseBlock,
          ): Promise<Anthropic.ToolResultBlockParam> => {
            const args = (toolUse.input ?? {}) as Record<string, unknown>;
            emit("tool_call", { name: toolUse.name, args: summarizeArgs(toolUse.name, args) });

            const { result, fileChanged } = await executeTool(
              projectId,
              toolUse.name,
              args,
              // progress of slow tools: without it, a minutes-long compile is
              // a black hole in the middle of the conversation
              (p) => emit("tool_progress", { name: toolUse.name, ...p }),
            );
            if (fileChanged) {
              filesChanged = true;
              emit("file_changed", fileChanged);
            }
            if (toolUse.name === "compile") lastCompileSummary = result;
            emit("tool_result", {
              name: toolUse.name,
              result: toolUse.name === "read_file" ? { truncated: true } : result,
            });

            // error declared as such: drowned in the JSON the model reads it
            // anyway, but loses the explicit failure signal
            const failed =
              typeof result === "object" && result !== null && "error" in result;
            return {
              type: "tool_result",
              tool_use_id: toolUse.id,
              content: JSON.stringify(result),
              ...(failed ? { is_error: true } : {}),
            };
          };

          const allReadOnly = toolUses.every((t) => READ_ONLY_TOOLS.has(t.name));
          const toolResults = allReadOnly
            ? await Promise.all(toolUses.map(runOne))
            : await toolUses.reduce<Promise<Anthropic.ToolResultBlockParam[]>>(
                async (acc, toolUse) => [...(await acc), await runOne(toolUse)],
                Promise.resolve([]),
              );

          messages.push({ role: "user", content: toolResults });

          for (const [i, toolUse] of toolUses.entries()) {
            if (PRUNABLE_TOOLS.has(toolUse.name)) {
              prunable.push({ message: messages.length - 1, block: i });
            }
          }
          pruneOldToolResults(messages, prunable);

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
        if (assistantTranscript && !persistedText) {
          await appendChatMessage(projectId, "assistant", assistantTranscript).catch(() => {});
        }
        if (filesChanged) {
          // one revision per agent turn that modified files: rollback/audit
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

interface PrunableRef {
  /** index of the user message containing the tool_result blocks */
  message: number;
  /** index of the tool_result block inside that message */
  block: number;
}

/**
 * Replaces the body of old compile/review_layout results with a line saying
 * what was there. The model keeps track of having compiled (and the summary
 * outcome), without paying for the entire summary again at every later step.
 */
function pruneOldToolResults(
  messages: Anthropic.MessageParam[],
  prunable: PrunableRef[],
): void {
  for (const ref of prunable.slice(0, -FULL_COMPILE_RESULTS_KEPT)) {
    const message = messages[ref.message];
    if (!message || !Array.isArray(message.content)) continue;
    const block = message.content[ref.block];
    if (!block || block.type !== "tool_result") continue;
    if (typeof block.content !== "string" || block.content.startsWith("{\"pruned\"")) continue;
    block.content = JSON.stringify({
      pruned: true,
      note: "risultato superato da una compile successiva; richiama compile se ti serve lo stato attuale",
      message: extractMessage(block.content),
    });
  }
}

/** the summary line alone is worth keeping: it says how it went */
function extractMessage(json: string): string {
  try {
    const parsed = JSON.parse(json) as { message?: unknown };
    return typeof parsed.message === "string" ? parsed.message.slice(0, 300) : "";
  } catch {
    return "";
  }
}

/** compact args for the chat UI chips (never ship whole file contents twice) */
function summarizeArgs(name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (name === "write_file") {
    return { path: args.path, chars: String(args.content ?? "").length };
  }
  return args;
}
