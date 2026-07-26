import { requireProjectAccess } from "@/lib/acl";
import { withLibrary } from "@/lib/agent-tools";
import { compileProject } from "@/lib/compile";
import {
  filesHash,
  getProject,
  saveCompileCache,
  saveRouteVariants,
} from "@/lib/project-store";

export const runtime = "nodejs";
// lo sbroglio a sforzo crescente e' la parte lenta: vale la stessa finestra
// del loop agentico, altrimenti una scheda densa viene tagliata a meta'
export const maxDuration = 800;

/**
 * Ricompila il progetto e aggiorna la cache. E' la stessa compilazione che usa
 * il tool `compile` dell'agente: serve a poter ricompilare senza spendere un
 * turno di chat (dopo un cambio di codice, o per ritentare lo sbroglio).
 */
export async function POST(req: Request): Promise<Response> {
  let projectId = "default";
  try {
    const body = (await req.json()) as { projectId?: unknown };
    if (typeof body.projectId === "string" && body.projectId.length <= 120) {
      projectId = body.projectId;
    }
  } catch {
    // corpo assente: si ricompila il progetto di default
  }

  const { ok } = await requireProjectAccess(projectId, "edit");
  if (!ok) return Response.json({ error: "forbidden" }, { status: 403 });

  const fsMap = await withLibrary(await getProject(projectId));
  if (Object.keys(fsMap).length === 0) {
    return Response.json({ error: "progetto vuoto" }, { status: 404 });
  }

  try {
    const { summary, circuitJson, variants } = await compileProject(fsMap);
    const hash = filesHash(fsMap);
    await saveCompileCache(projectId, hash, circuitJson, summary).catch(() => {});
    if (variants) {
      await saveRouteVariants(
        projectId,
        hash,
        variants.map((sv) => ({
          sectionKey: sv.section.key,
          candidates: sv.candidates.map((c) => ({
            label: c.label,
            traces: c.traces,
            stats: c.stats,
            drc: c.drc,
          })),
          pickedLabel: sv.candidates[sv.picked]?.label ?? "",
        })),
      ).catch(() => {});
    }
    return Response.json({ ok: summary.ok, summary });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
