import { requireProjectAccess } from "@/lib/acl";
import { getRouteVariants } from "@/lib/project-store";

export const runtime = "nodejs";

/** list the stored per-section routing variants (Fase 3.d) for the FE panel */
export async function GET(req: Request): Promise<Response> {
  const projectId = new URL(req.url).searchParams.get("projectId") ?? "default";
  const { ok } = await requireProjectAccess(projectId, "view");
  if (!ok) return Response.json({ error: "forbidden" }, { status: 403 });

  const { filesHash, sections } = await getRouteVariants(projectId);
  return Response.json({
    projectId,
    filesHash,
    sections: sections.map((s) => ({
      section: s.sectionKey,
      picked: s.pickedLabel,
      candidates: s.candidates.map((c) => ({
        label: c.label,
        traces: c.stats.traces,
        vias: c.stats.vias,
        lengthMm: c.stats.lengthMm,
        drc: c.drc,
      })),
    })),
  });
}
