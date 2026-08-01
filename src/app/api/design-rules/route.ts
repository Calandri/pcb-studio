import { requireProjectAccess } from "@/lib/acl";
import {
  buildProjectRules,
  DESIGN_RULES_PATH,
  FAB_RULESETS,
  resolveDesignRules,
  serializeDesignRules,
  type DesignRules,
} from "@/lib/design-rules";
import { getProject, writeProjectFile } from "@/lib/project-store";

export const runtime = "nodejs";

/**
 * Project fabrication rules. They live in design-rules.json alongside the
 * other files, so they are part of the hash that invalidates the cache:
 * switching supplier triggers a rebuild, which is exactly what must happen
 * (with different minimums the router plans a different copper layout).
 *
 * It does not rebuild by itself: the caller asks for the rebuild, so you can
 * change a rule and fix other things before paying for the routing.
 */

const presets = () =>
  FAB_RULESETS.map((r) => ({
    key: r.key,
    label: r.label,
    costTier: r.costTier,
    rules: r.rules,
  }));

export async function GET(req: Request): Promise<Response> {
  const projectId = new URL(req.url).searchParams.get("projectId") ?? "default";
  const { ok } = await requireProjectAccess(projectId, "view");
  if (!ok) return Response.json({ error: "forbidden" }, { status: 403 });
  const fsMap = await getProject(projectId);
  return Response.json({ ok: true, current: resolveDesignRules(fsMap), presets: presets() });
}

export async function POST(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "corpo non valido" }, { status: 400 });
  }

  const projectId =
    typeof body.projectId === "string" && body.projectId.length <= 120
      ? body.projectId
      : "default";
  const { ok } = await requireProjectAccess(projectId, "edit");
  if (!ok) return Response.json({ error: "forbidden" }, { status: 403 });

  const preset = typeof body.preset === "string" ? body.preset : "";
  if (!preset) return Response.json({ error: "serve un preset" }, { status: 400 });

  const next = buildProjectRules(preset, body.rules as Partial<DesignRules> | undefined);
  await writeProjectFile(projectId, DESIGN_RULES_PATH, serializeDesignRules(next));
  return Response.json({ ok: true, current: next, presets: presets() });
}
