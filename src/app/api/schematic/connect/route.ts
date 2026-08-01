import { requireProjectAccess } from "@/lib/acl";
import {
  addConnection,
  parseDeclaredTrace,
  removeConnection,
} from "@/lib/schematic-connect";
import { getProject, writeProjectFile } from "@/lib/project-store";

export const runtime = "nodejs";

/**
 * Manually connecting two pins. Unlike moving, which is geometry and ends
 * up in manual-edits.json, a connection is electrical design and must be
 * written to main.tsx: it is the only way for the agent, the BOM and the
 * routing to see the same circuit the user sees.
 *
 * It does not rebuild: you can draw five wires and pay for a single build.
 */
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

  const fsMap = await getProject(projectId);
  const main = fsMap["main.tsx"];
  if (typeof main !== "string") {
    return Response.json({ error: "il progetto non ha main.tsx" }, { status: 404 });
  }

  // to remove, start from the name the compiler gives to the connection
  if (typeof body.declared === "string") {
    const pair = parseDeclaredTrace(body.declared);
    if (!pair) {
      return Response.json({ error: "collegamento non riconosciuto" }, { status: 400 });
    }
    const result = removeConnection(main, pair.from, pair.to);
    if (!result.ok) return Response.json({ error: result.error }, { status: 409 });
    await writeProjectFile(projectId, "main.tsx", result.main);
    return Response.json({ ok: true, removed: result.trace });
  }

  const from = typeof body.from === "string" ? body.from : "";
  const to = typeof body.to === "string" ? body.to : "";
  if (!from || !to) {
    return Response.json({ error: "servono due punti" }, { status: 400 });
  }

  const result =
    body.action === "remove"
      ? removeConnection(main, from, to)
      : addConnection(main, from, to);
  if (!result.ok) return Response.json({ error: result.error }, { status: 409 });

  await writeProjectFile(projectId, "main.tsx", result.main);
  return Response.json({ ok: true, trace: result.trace });
}
