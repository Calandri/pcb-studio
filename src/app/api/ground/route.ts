import { requireProjectAccess } from "@/lib/acl";
import { summarizeCircuit } from "@/lib/compile";
import { resolveDesignRules } from "@/lib/design-rules";
import { CHECKS_ENGINE_VERSION } from "@/lib/engine-version";
import { stitchToPlanes } from "@/lib/house-rules";
import {
  filesHash,
  getCompileCache,
  getProject,
  saveCompileCache,
} from "@/lib/project-store";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Rebuilds the ground, and only that.
 *
 * This is needed because ground is the only thing that breaks on its own:
 * just move a component by hand or redraw a trace, and the vias that carried
 * the pads to the plane stay where they were — i.e. in the wrong place.
 * Redoing the entire compilation for this would be three minutes of waiting
 * for a job that takes one second: the plane vias are thrown away and rebuilt
 * on the current geometry, the island check tells whether anyone was left
 * out, and the board is back in shape.
 */
export async function POST(req: Request): Promise<Response> {
  let projectId = "default";
  try {
    const body = (await req.json()) as { projectId?: unknown };
    if (typeof body.projectId === "string" && body.projectId.length <= 120) {
      projectId = body.projectId;
    }
  } catch {
    // missing body: the default project applies
  }

  const { ok } = await requireProjectAccess(projectId, "edit");
  if (!ok) return Response.json({ error: "forbidden" }, { status: 403 });

  const cached = await getCompileCache(projectId);
  if (!cached?.circuitJson) {
    return Response.json(
      { error: "non c'e' ancora una scheda compilata da cucire al piano" },
      { status: 404 },
    );
  }

  const files = await getProject(projectId);
  const rules = resolveDesignRules(files).rules;
  const before = (cached.circuitJson as Array<{ type?: string }>).filter(
    (el) => el?.type === "pcb_via",
  ).length;
  const circuitJson = stitchToPlanes(cached.circuitJson as never, rules) as unknown[];
  const after = (circuitJson as Array<{ type?: string }>).filter(
    (el) => el?.type === "pcb_via",
  ).length;

  const summary = summarizeCircuit(circuitJson, files);
  await saveCompileCache(
    projectId,
    cached.filesHash ?? filesHash(files),
    circuitJson,
    summary,
    CHECKS_ENGINE_VERSION,
  ).catch(() => {});

  const isolated = summary.drcViolations
    .filter((v) => v.rule === "plane_stitch_missing")
    .reduce((n, v) => n + Math.max(1, v.points?.length ?? 1), 0);

  return Response.json({
    ok: true,
    viasBefore: before,
    viasAfter: after,
    isolated,
    summary,
  });
}
