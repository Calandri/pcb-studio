import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { executeTool, TOOL_DEFINITIONS } from "@/lib/agent-tools";
import { claimProject, currentViewer, projectAccess } from "@/lib/acl";
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
// Vercel uccide la funzione oltre questo limite: i turni lunghi (schede grandi,
// molte compile) sforavano i 300s e l'utente non vedeva mai la risposta.
export const maxDuration = 800;

// Resource cap only (billing/runaway protection), not flow logic: the loop's
// sole termination condition is the model producing final text.
const MAX_STEPS = 40;
const MAX_RUNS_PER_IP_PER_HOUR = 30;

/*
 * Tool che non toccano lo stato del progetto. Solo un turno in cui TUTTI i tool
 * chiesti sono qui dentro viene eseguito in parallelo: un batch che contiene
 * anche una scrittura resta seriale, altrimenti un write_file e una compile
 * emessi insieme correrebbero uno contro l'altro.
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
 * I risultati di compile sono l'oggetto piu' grosso che circola (per una scheda
 * vera sono decine di migliaia di caratteri: unroutedDetail, ratsnest,
 * schematicQuality...) e la history viene rimandata INTERA a ogni passo. Dopo
 * venti compile i primi diciannove sono storia morta che si paga a ogni turno,
 * quindi si tengono per intero solo gli ultimi.
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

  // solo utenti autenticati con accesso in modifica al progetto: l'agente
  // consuma token e riscrive i file
  const viewer = await currentViewer();
  if (!viewer) return jsonError("unauthenticated", 401);
  if ((await projectAccess(projectId, viewer)) !== "edit") {
    return jsonError("forbidden: no edit access to this project", 403);
  }
  const orgs = await listUserOrganizations(viewer.userId).catch(() => []);
  await claimProject(projectId, viewer, orgs[0]?.id ?? null).catch(() => {});

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
          const response = await runAgentTurn({
            system: SYSTEM_PROMPT,
            tools: TOOL_DEFINITIONS,
            messages,
          });
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
              // persistenza immediata: se il turno viene troncato a meta',
              // al reload l'utente ritrova comunque quello che l'agente ha detto
              void appendChatMessage(projectId, "assistant", block.text).catch(() => {});
              persistedText = true;
            }
          }

          const toolUses = response.content.filter(
            (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
          );

          if (toolUses.length === 0 || response.stop_reason !== "tool_use") {
            stopReason = response.stop_reason;
            // un turno tagliato a meta' usciva con lo stesso "done" di uno
            // finito: l'utente vedeva la risposta interrompersi senza motivo
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

            // errore dichiarato come tale: annegato nel JSON il modello lo
            // legge lo stesso, ma perde il segnale esplicito di fallimento
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

interface PrunableRef {
  /** indice del messaggio user che contiene i tool_result */
  message: number;
  /** indice del blocco tool_result dentro quel messaggio */
  block: number;
}

/**
 * Sostituisce il corpo dei risultati compile/review_layout vecchi con una riga
 * che dice cosa c'era. Il modello mantiene la traccia di aver compilato (e
 * l'esito sintetico), senza ripagare l'intero summary a ogni passo successivo.
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

/** la sola riga di sintesi vale la pena tenerla: dice com'e' andata */
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
