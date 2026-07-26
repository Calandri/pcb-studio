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
 * Regole di fabbricazione del progetto. Vivono in design-rules.json insieme
 * agli altri file, quindi entrano nell'hash che invalida la cache: cambiare
 * fornitore ricompila, che e' esattamente cio' che deve succedere (con minimi
 * diversi il router pianifica un rame diverso).
 *
 * Non ricompila da sola: la ricompilazione la chiede il chiamante, cosi' si
 * puo' cambiare regola e sistemare altro prima di pagare lo sbroglio.
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
