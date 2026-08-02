import { requireProjectAccess } from "@/lib/acl";
import { withLibrary } from "@/lib/agent-tools";
import { controlliDelProgetto, salvaControllo, togliControllo } from "@/lib/component-checks";
import { quadroDeiComponenti, VOCI, type Voce } from "@/lib/component-status";
import { listDescriptions } from "@/lib/component-descriptions";
import { datasheetMpns } from "@/lib/library-store";
import { getCompileCache, getProject } from "@/lib/project-store";

export const runtime = "nodejs";

/**
 * HOW FAR ALONG EVERY PART IS: five checks each, and what is missing.
 *
 * GET builds the board from the compiled circuit already in cache — no
 * recompiling, because this is something you look at while you work. POST
 * records a check (or takes one back), which is what makes a green mean
 * somebody did the work rather than a file existing.
 */

async function quadro(projectId: string) {
  const files = await withLibrary(await getProject(projectId));
  const cache = await getCompileCache(projectId);
  const [descrizioni, mpn, controlli] = await Promise.all([
    listDescriptions(projectId).catch(() => []),
    datasheetMpns(projectId).catch(() => new Set<string>()),
    controlliDelProgetto(projectId).catch(() => []),
  ]);
  return quadroDeiComponenti({
    circuitJson: (cache?.circuitJson ?? []) as Array<{ type: string }>,
    files,
    datasheetPerMpn: mpn,
    descrizioni: new Map(descrizioni.map((d) => [d.component, { role: d.role, why: d.why }])),
    controlli,
  });
}

export async function GET(req: Request): Promise<Response> {
  const projectId = new URL(req.url).searchParams.get("projectId") ?? "default";
  const { ok } = await requireProjectAccess(projectId, "view");
  if (!ok) return Response.json({ error: "forbidden" }, { status: 403 });
  const cache = await getCompileCache(projectId);
  if (!cache) {
    return Response.json({
      righe: [],
      completi: 0,
      totale: 0,
      perVoce: {},
      nota: "nessuna compilazione in cache: compila il progetto per vedere lo stato dei componenti",
    });
  }
  return Response.json(await quadro(projectId));
}

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const projectId = typeof body.projectId === "string" ? body.projectId : "default";
  const { ok, viewer } = await requireProjectAccess(projectId, "edit");
  if (!ok) return Response.json({ error: "forbidden" }, { status: 403 });

  const componente = String(body.componente ?? "").trim();
  const voce = String(body.voce ?? "") as Voce;
  if (!componente || !VOCI.includes(voce)) {
    return Response.json({ error: "componente o voce mancante" }, { status: 400 });
  }

  if (body.stato === "da-fare") {
    await togliControllo(projectId, componente, voce);
    return Response.json(await quadro(projectId));
  }

  await salvaControllo({
    projectId,
    componente,
    voce,
    stato: body.stato === "non-applicabile" ? "non-applicabile" : "fatto",
    nota: String(body.nota ?? "").slice(0, 600),
    fonte: body.fonte ? String(body.fonte).slice(0, 400) : undefined,
    impronta: body.impronta ? String(body.impronta).slice(0, 80) : undefined,
    /*
     * Who said it. An empty name would make the log say that the check exists
     * and not who stands behind it, which is half of what a log is for.
     */
    chi: String(body.chi ?? viewer?.email ?? "").slice(0, 120) || "sconosciuto",
  });
  return Response.json(await quadro(projectId));
}
