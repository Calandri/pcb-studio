import { requireProjectAccess } from "@/lib/acl";
import { withLibrary } from "@/lib/agent-tools";
import { summarizeCircuit } from "@/lib/compile";
import { resolveDesignRules } from "@/lib/design-rules";
import { CHECKS_ENGINE_VERSION } from "@/lib/engine-version";
import { stitchToPlanes } from "@/lib/house-rules";
import {
  boardFreshness,
  MANUAL_EDITS_PATH,
  parseManualEdits,
  withoutManualEdits,
} from "@/lib/manual-edits";
import {
  filesHash,
  getCompileCache,
  getProject,
  saveCompileCache,
} from "@/lib/project-store";

export const runtime = "nodejs";
export const maxDuration = 60;

/** createdAt may come back as a Date or as a string, depending on the driver */
const stamp = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

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
  /*
   * Only on the board of these sources. The result keeps the cache's own
   * hash, so it would not be shown as current anyway — but vias stitched on
   * a board the files no longer describe are work nobody can use.
   */
  const full = await withLibrary(files);
  const fresh = boardFreshness({
    cacheFilesHash: cached.filesHash,
    filesHash: filesHash(full),
    sourcesHash: filesHash(withoutManualEdits(full)),
    edits: parseManualEdits(files[MANUAL_EDITS_PATH]),
  });
  if (!fresh) {
    return Response.json(
      {
        error:
          "la scheda compilata non e' quella dei file attuali: ricompila prima di rifare la massa",
      },
      { status: 409 },
    );
  }
  const rules = resolveDesignRules(files).rules;
  const before = (cached.circuitJson as Array<{ type?: string }>).filter(
    (el) => el?.type === "pcb_via",
  ).length;
  const circuitJson = stitchToPlanes(cached.circuitJson as never, rules) as unknown[];
  const after = (circuitJson as Array<{ type?: string }>).filter(
    (el) => el?.type === "pcb_via",
  ).length;

  const summary = summarizeCircuit(circuitJson, files);
  // a compile that finished meanwhile is newer than this: it is not overwritten
  const latest = await getCompileCache(projectId).catch(() => null);
  if (
    !latest ||
    latest.filesHash !== cached.filesHash ||
    stamp(latest.createdAt) !== stamp(cached.createdAt)
  ) {
    return Response.json(
      { error: "la scheda e' cambiata mentre rifacevo la massa: non salvo, riprova" },
      { status: 409 },
    );
  }
  await saveCompileCache(
    projectId,
    cached.filesHash,
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
