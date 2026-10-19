import { requireProjectAccess } from "@/lib/acl";
import {
  addConnection,
  parseDeclaredTrace,
  removeConnection,
  type ConnectResult,
} from "@/lib/schematic-connect";
import { getCompileCache, updateProjectFile } from "@/lib/project-store";

export const runtime = "nodejs";

/**
 * Manually connecting two pins. Unlike moving, which is geometry and ends
 * up in manual-edits.json, a connection is electrical design and must be
 * written to main.tsx: it is the only way for the agent, the BOM and the
 * routing to see the same circuit the user sees.
 *
 * It does not rebuild: you can draw five wires and pay for a single build.
 *
 * main.tsx is also the file the agent rewrites: the change is applied on the
 * file as it is at write time (updateProjectFile), so a wire drawn while the
 * agent saves does not erase the agent's turn, nor the other way round.
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

  let op: (main: string) => ConnectResult;
  // to remove, start from the name the compiler gives to the connection
  if (typeof body.declared === "string") {
    const pair = body.declared.length <= 400 ? parseDeclaredTrace(body.declared) : null;
    if (!pair) {
      return Response.json({ error: "collegamento non riconosciuto" }, { status: 400 });
    }
    op = (main) => removeConnection(main, pair.from, pair.to);
  } else {
    const from = typeof body.from === "string" && body.from.length <= 200 ? body.from : "";
    const to = typeof body.to === "string" && body.to.length <= 200 ? body.to : "";
    if (!from || !to) {
      return Response.json({ error: "servono due punti" }, { status: 400 });
    }
    if (body.action === "remove") {
      op = (main) => removeConnection(main, from, to);
    } else {
      // the pins are checked against the compiled board, when there is one
      const cache = await getCompileCache(projectId).catch(() => null);
      op = (main) => addConnection(main, from, to, cache?.circuitJson ?? null);
    }
  }

  let result: ConnectResult | null = null;
  try {
    await updateProjectFile(projectId, "main.tsx", (current) => {
      if (typeof current !== "string") {
        result = null;
        return null;
      }
      result = op(current);
      return result.ok ? result.main : null;
    });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 409 });
  }
  const done = result as ConnectResult | null;
  if (!done) return Response.json({ error: "il progetto non ha main.tsx" }, { status: 404 });
  if (!done.ok) return Response.json({ error: done.error }, { status: 409 });
  return Response.json(
    typeof body.declared === "string" ? { ok: true, removed: done.trace } : { ok: true, trace: done.trace },
  );
}
