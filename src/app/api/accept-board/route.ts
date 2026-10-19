import { requireProjectAccess } from "@/lib/acl";
import { withLibrary } from "@/lib/agent-tools";
import { CHECKS_ENGINE_VERSION } from "@/lib/engine-version";
import { filesHash, getCompileCache, getProject, saveCompileCache } from "@/lib/project-store";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * "Work on THIS board": declares the cached snapshot as current without
 * recompiling anything. The stale banner exists because re-placing and
 * re-routing cost minutes — but most of the time the file change that
 * triggered it did not touch the geometry (a pin, a note, an agent edit you
 * do not care about), and what you actually want is to keep the board you
 * see and keep editing it by hand.
 *
 * What this does, honestly: re-hashes the existing cache against the current
 * files, so the banner goes away and the editor unlocks. What it does NOT
 * do: reflect any structural change in the files — new components or links
 * added since the snapshot will simply not be there until a real compile.
 */
export async function POST(req: Request): Promise<Response> {
  let projectId = "default";
  try {
    const body = (await req.json()) as { projectId?: unknown };
    if (typeof body.projectId === "string" && body.projectId.length <= 120) {
      projectId = body.projectId;
    }
  } catch {
    // empty body: the default project
  }

  const { ok } = await requireProjectAccess(projectId, "edit");
  if (!ok) return Response.json({ error: "forbidden" }, { status: 403 });

  const cached = await getCompileCache(projectId).catch(() => null);
  if (!cached?.circuitJson) {
    return Response.json({ error: "non c'e' una scheda da prendere: compila prima" }, { status: 404 });
  }

  const fsMap = await withLibrary(await getProject(projectId));
  /*
   * "This board" is the one that was on screen: if a compile replaced it in
   * the meantime, re-hashing the OLD circuit over the new one would throw
   * the newer board away.
   */
  const latest = await getCompileCache(projectId).catch(() => null);
  const stamp = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
  if (!latest || latest.filesHash !== cached.filesHash || stamp(latest.createdAt) !== stamp(cached.createdAt)) {
    return Response.json(
      { error: "la scheda e' appena cambiata: guarda quella nuova prima di prenderla" },
      { status: 409 },
    );
  }
  await saveCompileCache(
    projectId,
    filesHash(fsMap),
    cached.circuitJson,
    cached.summary,
    CHECKS_ENGINE_VERSION,
  );
  return Response.json({ ok: true });
}
