import { requireProjectAccess } from "@/lib/acl";
import { executeTool } from "@/lib/agent-tools";
import { projectExists } from "@/lib/project-store";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * "Cuci la massa" from the viewer: the stitch_ground tool, the same one the
 * agent and the MCP call (ground-stitching-tool.ts). A look (the default) asks
 * to see the project; `apply: true` writes cucitura-massa.tsx and asks what
 * write_file asks. Nothing is compiled: the page marks the board as older than
 * the files. And nothing is created: asking for the access to edit creates a
 * project that is not there yet (requireProjectAccess), so the project is
 * looked for first, with the access to see it, which creates nothing.
 */
export async function POST(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    const letto = (await req.json()) as unknown;
    body = typeof letto === "object" && letto !== null && !Array.isArray(letto) ? (letto as Record<string, unknown>) : {};
  } catch {
    return Response.json({ error: "corpo della richiesta non valido" }, { status: 400 });
  }
  const { projectId, ...args } = body;
  if (typeof projectId !== "string" || !projectId || projectId.length > 120) {
    return Response.json({ error: "projectId mancante" }, { status: 400 });
  }
  if (!(await requireProjectAccess(projectId, "view")).ok) return Response.json({ error: "forbidden" }, { status: 403 });
  if (!(await projectExists(projectId))) return Response.json({ error: "il progetto non esiste" }, { status: 404 });
  if (args.apply === true && !(await requireProjectAccess(projectId, "edit")).ok) return Response.json({ error: "forbidden" }, { status: 403 });
  const { result, fileChanged } = await executeTool(projectId, "stitch_ground", args);
  const errore = (result as { error?: unknown }).error;
  return Response.json(
    { ...(result as Record<string, unknown>), ...(fileChanged ? { fileChanged } : {}) },
    { status: typeof errore === "string" ? 422 : 200 },
  );
}
