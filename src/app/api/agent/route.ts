import { z } from "zod";
import { executeTool, TOOL_DEFINITIONS } from "@/lib/agent-tools";
import { claimProject, currentViewer, projectAccess } from "@/lib/acl";
import { getAgentKeys } from "@/lib/llm-keys";
import { listUserOrganizations } from "@/lib/org-store";
import { appendChatMessage, getProject, saveRevision } from "@/lib/project-store";
import {
  capText,
  compactHistory,
  invalidToolArguments,
  LlmError,
  runAgentTurn,
  type MessageParam,
  type StopReason,
  type ToolResultBlock,
  type ToolUseBlock,
} from "@/lib/llm";
import { ActiveRunConflict, countRecentRuns, finishRun, startRun } from "@/lib/run-store";
import { SYSTEM_PROMPT } from "@/lib/system-prompt";

export const runtime = "nodejs";
// Vercel kills the function beyond this limit: long turns (large boards,
// many compiles) exceeded 300s and the user never saw the response.
export const maxDuration = 800;

/*
 * Resource caps only (billing/runaway protection), not flow logic: the loop's
 * sole termination condition is the model producing final text. Each cap that
 * trips is reported as its own stop reason, never as a normal end.
 */
const MAX_STEPS = 40;
/** no new model step starts after this (maxDuration is 800 s) */
const TIME_BUDGET_MS = 700_000;
/** everything in flight must be over by this: provider timeouts and the compile budget are sized on it */
const HARD_DEADLINE_MS = 780_000;
/** tokens (in + out) one run may spend; override with AGENT_MAX_RUN_TOKENS */
const DEFAULT_TOKEN_BUDGET = 3_000_000;
/** a model call started with less than this left would be cut mid-way */
const MIN_STEP_MS = 20_000;

const MAX_RUNS_PER_USER_PER_HOUR = 30;
const MAX_RUNS_PER_IP_PER_HOUR = 60;
const HEARTBEAT_MS = 15_000;

/*
 * Tools that do not write any state. Only a turn in which ALL the requested
 * tools are in this set runs in parallel; a batch with anything else stays
 * serial, in the order the model asked. `compile` is NOT here: it writes the
 * compile cache and the route variants, and two compiles (or a compile and a
 * pick_variant) racing on them leave a board that matches neither.
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
  "review_layout",
  "enclosure_list",
]);

/*
 * What is fed back to the model is capped: one oversized result re-sent at
 * every later step is what blows a run's token budget. File reads get a cap
 * above the largest file write_file accepts, because write_file needs the
 * whole content and a truncated read would be written back truncated.
 */
const TOOL_RESULT_CAP = 30_000;
const FILE_RESULT_CAP = 210_000;
const FULL_FILE_TOOLS = new Set(["read_file", "library_read"]);

/*
 * Superseded results are compacted: only the latest two board states
 * (compile, review_layout, reroute_zone, pick_variant) and the latest copy of
 * each file (read or written) stay in full.
 */
const BOARD_TOOLS = new Set(["compile", "review_layout", "reroute_zone", "pick_variant"]);
function supersessionOf(name: string, input: Record<string, unknown>) {
  if (BOARD_TOOLS.has(name)) return { key: "board", keep: 2 };
  if (name === "read_file" || name === "write_file") {
    return { key: `file:${String(input.path ?? "")}`, keep: 1 };
  }
  if (name === "library_read" || name === "library_save") {
    return { key: `lib:${String(input.name ?? "")}`, keep: 1 };
  }
  if (name === "enclosure_save") return { key: `enclosure:${String(input.name ?? "")}`, keep: 1 };
  return null;
}

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

type HistoryTurn = { role: "user" | "assistant"; content: string };

/**
 * The last 40 turns, empty ones dropped, starting from a user message: a
 * window that opens on an assistant turn is a conversation the model did not
 * start, and some backends reject it.
 */
function normalizeHistory(history: HistoryTurn[]): HistoryTurn[] {
  const window = history.filter((t) => t.content.trim()).slice(-40);
  const firstUser = window.findIndex((t) => t.role === "user");
  return firstUser === -1 ? [] : window.slice(firstUser);
}

function tokenBudget(): number {
  const raw = Number(process.env.AGENT_MAX_RUN_TOKENS);
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : DEFAULT_TOKEN_BUDGET;
}

const encoder = new TextEncoder();

function sseEncode(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** the visible explanation of every stop that is not a normal end */
const STOP_MESSAGES: Partial<Record<string, string>> = {
  max_tokens:
    "Risposta troncata: il modello ha esaurito i token di uscita di questo passo. Chiedi all'agente di continuare.",
  content_filter: "Il modello ha interrotto la risposta per il filtro dei contenuti.",
  empty_response: "Il modello ha chiuso il passo senza testo e senza azioni.",
  unknown_finish: "Il modello si e' fermato per un motivo non riconosciuto.",
  step_cap: `Raggiunto il limite di ${MAX_STEPS} passi per turno: mi fermo qui. Le modifiche fatte sono salvate, scrivi «continua» per riprendere.`,
  time_budget:
    "Raggiunto il limite di tempo del turno: mi fermo qui. Le modifiche fatte sono salvate, scrivi «continua» per riprendere.",
  token_budget:
    "Raggiunto il budget di token del turno: mi fermo qui. Le modifiche fatte sono salvate, scrivi «continua» per riprendere.",
};

export async function POST(req: Request): Promise<Response> {
  const parsed = AgentRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError("invalid request body", 400);
  const { projectId } = parsed.data;
  const history = normalizeHistory(parsed.data.history);
  if (history.length === 0 || history[history.length - 1].role !== "user") {
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
  // the chat and the files are written against the project row: it must exist
  // (with its owner) before the loop starts
  try {
    await claimProject(projectId, viewer, orgs[0]?.id ?? null);
  } catch {
    return jsonError("Impossibile preparare il progetto: riprova fra poco.", 503);
  }

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
  const recent = await countRecentRuns({
    userId: viewer.userId,
    ip,
    kind: "agent",
    windowMinutes: 60,
  }).catch(() => ({ byUser: 0, byIp: 0 }));
  if (recent.byUser >= MAX_RUNS_PER_USER_PER_HOUR || recent.byIp >= MAX_RUNS_PER_IP_PER_HOUR) {
    return jsonError(
      "Hai raggiunto il limite di turni dell'agente per l'ultima ora: riprova piu' tardi.",
      429,
    );
  }

  // BYOK: the turn is paid for with the user's or their organization's key,
  // if any; otherwise with the server's. A failed lookup is NOT "no key".
  let agentKeys: Awaited<ReturnType<typeof getAgentKeys>>;
  try {
    agentKeys = await getAgentKeys(
      viewer.userId,
      orgs.map((o) => o.id),
    );
  } catch {
    return jsonError("Impossibile leggere le chiavi API: riprova fra poco.", 503);
  }

  let runId: number;
  try {
    runId = await startRun({
      projectId,
      userId: viewer.userId,
      ip,
      kind: "agent",
      exclusive: true,
    });
  } catch (err) {
    if (err instanceof ActiveRunConflict) {
      return jsonError(
        "C'e' gia' un turno dell'agente in corso su questo progetto: aspetta che finisca prima di mandarne un altro.",
        409,
      );
    }
    return jsonError("Impossibile avviare il turno: riprova fra poco.", 503);
  }

  const messages: MessageParam[] = history.map((t) => ({ role: t.role, content: t.content }));
  const userText = history[history.length - 1].content;
  const startedAt = Date.now();
  const deadline = startedAt + HARD_DEADLINE_MS;
  const budget = tokenBudget();
  /*
   * The run's limits are CONTEXT for the model, so it can plan within them;
   * the code only enforces them.
   */
  const system =
    `${SYSTEM_PROMPT}\n\n## Run limits\n` +
    `- This run ends after at most ${MAX_STEPS} model steps or about ${Math.round(TIME_BUDGET_MS / 60_000)} minutes, whichever comes first. The user can continue the work in a new message.`;

  /*
   * ONE abort for the whole run: the client going away (request signal or
   * stream cancel) stops the provider calls and the long tools, and no event
   * is written to a closed stream.
   */
  const abort = new AbortController();
  const onClientGone = () => abort.abort(new Error("client disconnected"));
  if (req.signal.aborted) onClientGone();
  else req.signal.addEventListener("abort", onClientGone, { once: true });

  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const write = (chunk: Uint8Array): boolean => {
        if (closed || abort.signal.aborted) return false;
        try {
          controller.enqueue(chunk);
          return true;
        } catch {
          // the consumer is gone: from here on nothing is written
          closed = true;
          return false;
        }
      };
      /** never throws: a dead stream must not turn into a crashed run */
      const emit = (event: string, data: unknown): void => {
        write(sseEncode(event, data));
      };
      // a comment line: keeps proxies from closing a stream that is waiting
      // on a minutes-long compile or model call
      heartbeat = setInterval(() => write(encoder.encode(": ping\n\n")), HEARTBEAT_MS);

      void runLoop(emit).finally(() => {
        if (heartbeat) clearInterval(heartbeat);
        req.signal.removeEventListener("abort", onClientGone);
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            // already closed by the consumer
          }
        }
      });
    },
    cancel() {
      onClientGone();
    },
  });

  async function runLoop(emit: (event: string, data: unknown) => void): Promise<void> {
    let steps = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    let stopReason = "unknown";
    let filesChanged = false;
    let lastCompileSummary: unknown = null;
    let lastProvider = "";
    /** assistant text not yet in the DB (a failed insert is retried at the end) */
    const unpersisted: string[] = [];

    const persistAssistant = async (text: string): Promise<void> => {
      try {
        await appendChatMessage(projectId, "assistant", text);
      } catch {
        unpersisted.push(text);
      }
    };

    const stop = (reason: string): void => {
      stopReason = reason;
      const message = STOP_MESSAGES[reason];
      if (message) emit("error", { message });
    };

    try {
      // awaited in order: the chat on reload must read as it happened
      await appendChatMessage(projectId, "user", userText);

      for (;;) {
        if (abort.signal.aborted) {
          stopReason = "client_disconnected";
          break;
        }
        if (steps >= MAX_STEPS) {
          stop("step_cap");
          break;
        }
        const elapsed = Date.now() - startedAt;
        if (elapsed >= TIME_BUDGET_MS || deadline - Date.now() < MIN_STEP_MS) {
          stop("time_budget");
          break;
        }
        if (tokensIn + tokensOut >= budget) {
          stop("token_budget");
          break;
        }

        const response = await runAgentTurn(
          { system, tools: TOOL_DEFINITIONS, messages },
          { keys: agentKeys, signal: abort.signal, timeoutMs: deadline - Date.now() },
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
            emit("assistant_text", { text: block.text });
            // immediate, ordered persistence: if the turn is cut short
            // mid-way, on reload the user still finds what the agent said
            await persistAssistant(block.text);
          }
        }

        const toolUses = response.content.filter(
          (b): b is ToolUseBlock => b.type === "tool_use",
        );
        const reason: StopReason = response.stop_reason;
        if (reason !== "tool_use" || toolUses.length === 0) {
          // a turn cut short mid-way used to exit with the same "done" as a
          // finished one: every non-normal end now says why
          if (reason === "end_turn") stopReason = reason;
          else stop(reason === "tool_use" ? "empty_response" : reason);
          break;
        }

        // preserve the full content (incl. reasoning) in the history
        messages.push({ role: "assistant", content: response.content });

        const runOne = async (toolUse: ToolUseBlock): Promise<ToolResultBlock> => {
          const args = toolUse.input ?? {};
          emit("tool_call", { name: toolUse.name, args: summarizeArgs(toolUse.name, args) });

          const invalid = invalidToolArguments(args);
          if (invalid) {
            const result = {
              error: `The arguments of this ${toolUse.name} call are not a valid JSON object (${invalid.error}); the tool was not run.`,
              received: invalid.raw.slice(0, 500),
            };
            emit("tool_result", { name: toolUse.name, result });
            return {
              type: "tool_result",
              tool_use_id: toolUse.id,
              content: JSON.stringify(result),
              is_error: true,
            };
          }

          const { result, fileChanged } = await executeTool(
            projectId,
            toolUse.name,
            args,
            // progress of slow tools: without it, a minutes-long compile is
            // a black hole in the middle of the conversation
            (p) => emit("tool_progress", { name: toolUse.name, ...p }),
            { keys: agentKeys, signal: abort.signal, deadline },
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
          const failed = typeof result === "object" && result !== null && "error" in result;
          const cap = FULL_FILE_TOOLS.has(toolUse.name) ? FILE_RESULT_CAP : TOOL_RESULT_CAP;
          return {
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: capText(JSON.stringify(result) ?? "null", cap),
            ...(failed ? { is_error: true } : {}),
          };
        };

        const allReadOnly = toolUses.every((t) => READ_ONLY_TOOLS.has(t.name));
        const toolResults: ToolResultBlock[] = [];
        if (allReadOnly) {
          toolResults.push(...(await Promise.all(toolUses.map(runOne))));
        } else {
          for (const toolUse of toolUses) {
            if (abort.signal.aborted) break;
            toolResults.push(await runOne(toolUse));
          }
        }
        if (abort.signal.aborted) {
          stopReason = "client_disconnected";
          break;
        }

        messages.push({ role: "user", content: toolResults });
        compactHistory(messages, supersessionOf);
      }
    } catch (err) {
      if (abort.signal.aborted || (err instanceof LlmError && err.kind === "aborted")) {
        stopReason = "client_disconnected";
      } else {
        stopReason = err instanceof LlmError ? `provider_${err.kind}` : "error";
        const message = err instanceof Error ? err.message : String(err);
        emit("error", { message: message.slice(0, 600) });
      }
    } finally {
      emit("done", { stop_reason: stopReason });
      if (unpersisted.length > 0) {
        await appendChatMessage(projectId, "assistant", unpersisted.join("\n\n")).catch(() => {});
      }
      if (filesChanged) {
        // one revision per agent turn that modified files: rollback/audit
        const files = await getProject(projectId).catch(() => null);
        if (files) await saveRevision(projectId, files, lastCompileSummary).catch(() => {});
      }
      await finishRun(runId, {
        steps,
        tokensIn,
        tokensOut,
        stopReason,
        durationMs: Date.now() - startedAt,
      }).catch(() => {});
    }
  }

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
  if (name === "library_save" || name === "enclosure_save") {
    return { name: args.name, chars: String(args.code ?? "").length };
  }
  return args;
}
