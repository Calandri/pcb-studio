import { z } from "zod";
import { currentViewer, projectAccess } from "@/lib/acl";
import { describeComponent, listDescriptions } from "@/lib/component-descriptions";
import { LlmError } from "@/lib/llm";
import { getAgentKeys } from "@/lib/llm-keys";
import { listUserOrganizations } from "@/lib/org-store";
import { countRecentRuns, finishRun, startRun } from "@/lib/run-store";

export const runtime = "nodejs";
export const maxDuration = 120;

/*
 * Ogni POST brucia un turno di modello: ogni chiamata scrive la sua riga in
 * agent_runs (kind 'describe') PRIMA di partire, e il freno conta quelle
 * righe, per utente e in seconda battuta per IP, in volo comprese. Prima il
 * freno contava agent_runs ma questa rotta non ci scriveva mai: non scattava.
 */
const MAX_DESCRIPTIONS_PER_USER_PER_HOUR = 30;
const MAX_DESCRIPTIONS_PER_IP_PER_HOUR = 60;

/**
 * Descrizioni dei componenti scritte dal modello (datasheet + connessioni).
 *
 * GET  ?projectId=...        le descrizioni gia' generate, le vedono tutti
 *                            quelli che possono vedere il progetto.
 * POST {projectId, component} genera (o rigenera) la descrizione di un
 *                            componente: costa un turno di modello, quindi
 *                            come per l'agente serve accesso in modifica e
 *                            si paga con le chiavi BYOK se ci sono.
 */

const PostSchema = z.object({
  projectId: z.string().regex(/^[\w-]{1,64}$/),
  component: z.string().min(1).max(60),
});

export async function GET(req: Request): Promise<Response> {
  const projectId = new URL(req.url).searchParams.get("projectId") ?? "";
  if (!/^[\w-]{1,64}$/.test(projectId)) {
    return Response.json({ error: "projectId non valido" }, { status: 400 });
  }
  const viewer = await currentViewer();
  if ((await projectAccess(projectId, viewer)) === "none") {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  return Response.json({ descriptions: await listDescriptions(projectId) });
}

export async function POST(req: Request): Promise<Response> {
  const parsed = PostSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "richiesta non valida" }, { status: 400 });
  }
  const { projectId, component } = parsed.data;

  const viewer = await currentViewer();
  if (!viewer) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if ((await projectAccess(projectId, viewer)) !== "edit") {
    return Response.json({ error: "forbidden: serve accesso in modifica" }, { status: 403 });
  }

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
  const recent = await countRecentRuns({
    userId: viewer.userId,
    ip,
    kind: "describe",
    windowMinutes: 60,
  }).catch(() => ({ byUser: 0, byIp: 0 }));
  if (
    recent.byUser >= MAX_DESCRIPTIONS_PER_USER_PER_HOUR ||
    recent.byIp >= MAX_DESCRIPTIONS_PER_IP_PER_HOUR
  ) {
    return Response.json(
      { error: "rate limit superato: troppe descrizioni generate nell'ultima ora, riprova piu' tardi" },
      { status: 429 },
    );
  }

  // a failed lookup is not "no key": it must not silently bill the server
  const orgs = await listUserOrganizations(viewer.userId).catch(() => []);
  let keys: Awaited<ReturnType<typeof getAgentKeys>>;
  try {
    keys = await getAgentKeys(
      viewer.userId,
      orgs.map((o) => o.id),
    );
  } catch {
    return Response.json({ error: "impossibile leggere le chiavi API, riprova fra poco" }, { status: 503 });
  }

  let runId: number;
  try {
    runId = await startRun({ projectId, userId: viewer.userId, ip, kind: "describe" });
  } catch {
    return Response.json({ error: "impossibile registrare la richiesta, riprova fra poco" }, { status: 503 });
  }

  const startedAt = Date.now();
  let stopReason = "error";
  let usage = { input_tokens: 0, output_tokens: 0 };
  try {
    const result = await describeComponent(projectId, component, keys, { signal: req.signal });
    if (!result) {
      stopReason = "not_found";
      return Response.json(
        { error: `componente ${component} non trovato nella scheda compilata` },
        { status: 404 },
      );
    }
    stopReason = "end_turn";
    usage = result.usage;
    return Response.json({ role: result.role, why: result.why });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof LlmError) {
      stopReason = `provider_${err.kind}`;
      return Response.json(
        { error: message.slice(0, 300) },
        { status: err.kind === "rate_limit" ? 429 : 502 },
      );
    }
    return Response.json({ error: message.slice(0, 300) }, { status: 500 });
  } finally {
    await finishRun(runId, {
      steps: 1,
      tokensIn: usage.input_tokens,
      tokensOut: usage.output_tokens,
      stopReason,
      durationMs: Date.now() - startedAt,
    }).catch(() => {});
  }
}
