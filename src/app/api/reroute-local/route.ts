import { requireProjectAccess } from "@/lib/acl";
import { withLibrary } from "@/lib/agent-tools";
import { summarizeCircuit } from "@/lib/compile";
import { CHECKS_ENGINE_VERSION } from "@/lib/engine-version";
import { planFastUpdate } from "@/lib/fast-update";
import { getCompileCache, getProject, saveCompileCache } from "@/lib/project-store";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Applies manual moves WITHOUT recompiling everything: updates the positions
 * in the cached board and lays the hand-drawn traces on top. It never routes:
 * the copper of a moved part stays where it was and is redrawn by hand (see
 * lib/reroute-local.ts). Seconds instead of minutes. If something cannot be
 * done locally it answers ok:false and the user recompiles — an explicit
 * gesture, not an automatism.
 *
 * Two guards, because the result is saved as THE board of the current files:
 *   - the cached board must be the one of these sources, with only hand
 *     positions and hand traces changed since (see lib/board-base.ts). If the
 *     agent rewrote main.tsx after the last compile, applying the moves to the
 *     old board and filing it under the new hash showed a stale board as
 *     current;
 *   - the row must still be the one that was read when the work is saved:
 *     a compile that finished in the meantime is newer, and is not overwritten.
 *
 * `needsCompile` in the answer means exactly that: nothing the page can do by
 * asking again, only "Aggiorna" brings the board of these files. `retry` means
 * the opposite: ask again.
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

  const cached = await getCompileCache(projectId).catch(() => null);
  if (!cached?.circuitJson) {
    return Response.json({ ok: false, reason: "nessuna scheda compilata", needsCompile: true });
  }

  const fsMap = await getProject(projectId);
  const full = await withLibrary(fsMap);
  const t0 = Date.now();
  try {
    const plan = planFastUpdate(cached, fsMap, full);
    if (plan.kind === "compile") {
      return Response.json({
        ...(plan.result ?? {}),
        ok: false,
        needsCompile: true,
        reason: plan.reason,
        ms: Date.now() - t0,
      });
    }
    if (plan.kind === "unchanged") {
      return Response.json({ ...plan.result, unchanged: true, ms: Date.now() - t0 });
    }
    const summary = summarizeCircuit(plan.board as unknown[], fsMap);
    /*
     * The schematic on this board is the one of the board it was moved from:
     * moving parts does not touch it. Its key travels with it, so that the next
     * "Aggiorna" reuses it instead of drawing it again (see schematicKeyOf),
     * and so does the note that it is still being drawn.
     */
    const prima = (cached.summary ?? {}) as { schematicKey?: unknown; schematicPending?: unknown };
    if (typeof prima.schematicKey === "string") summary.schematicKey = prima.schematicKey;
    if (typeof prima.schematicPending === "string") summary.schematicPending = prima.schematicPending;
    /*
     * Saved only over the row that was read: a compile that finished in the
     * meantime is newer and is not overwritten. The check and the write are one
     * statement (ifUnchangedSince); they used to be a read and then a write,
     * and a board saved between the two was lost.
     */
    const salvata = await saveCompileCache(projectId, plan.hash, plan.board, summary, CHECKS_ENGINE_VERSION, {
      ifUnchangedSince: { filesHash: cached.filesHash, createdAt: cached.createdAt },
      base: plan.base,
    });
    if (!salvata.saved) {
      /*
       * Another update or a compile saved a board while this one worked. Not a
       * failure to show: that board is newer, and the page asks again (see
       * `retry`), on that board.
       */
      return Response.json({
        ...plan.result,
        ok: false,
        retry: true,
        reason: "la scheda e' stata salvata di nuovo mentre la aggiornavo: riprovo su quella",
        ms: Date.now() - t0,
      });
    }
    return Response.json({
      ...plan.result,
      ok: true,
      ...(plan.unchanged ? { unchanged: true } : {}),
      ms: Date.now() - t0,
      summary,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ ok: false, reason: message.slice(0, 200) });
  }
}
