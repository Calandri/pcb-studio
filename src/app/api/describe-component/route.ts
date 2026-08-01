import { z } from "zod";
import { currentViewer, projectAccess } from "@/lib/acl";
import { describeComponent, listDescriptions } from "@/lib/component-descriptions";
import { getAgentKeys } from "@/lib/llm-keys";
import { listUserOrganizations } from "@/lib/org-store";
import { countRecentRunsByIp } from "@/lib/project-store";

export const runtime = "nodejs";
export const maxDuration = 120;

/*
 * Ogni POST brucia un turno di modello: stesso freno dell'agente, stessa
 * finestra (un'ora per IP), soglia dedicata. Senza, un utente autenticato
 * poteva rigenerare descrizioni in loop a spese delle chiavi del server.
 */
const MAX_DESCRIPTIONS_PER_IP_PER_HOUR = 30;

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

  const orgs = await listUserOrganizations(viewer.userId).catch(() => []);
  const keys = await getAgentKeys(
    viewer.userId,
    orgs.map((o) => o.id),
  ).catch(() => ({}));

  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  if ((await countRecentRunsByIp(ip).catch(() => 0)) >= MAX_DESCRIPTIONS_PER_IP_PER_HOUR) {
    return Response.json(
      { error: "rate limit superato: troppe descrizioni generate nell'ultima ora, riprova piu' tardi" },
      { status: 429 },
    );
  }

  try {
    const result = await describeComponent(projectId, component, keys);
    if (!result) {
      return Response.json(
        { error: `componente ${component} non trovato nella scheda compilata` },
        { status: 404 },
      );
    }
    return Response.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message.slice(0, 300) }, { status: 500 });
  }
}
