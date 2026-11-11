import { requireProjectAccess } from "@/lib/acl";
import { conIlPerche, summarizeCircuit } from "@/lib/compile";
import { resolveDesignRules } from "@/lib/design-rules";
import { leggiStencil, pastaDaiPad } from "@/lib/solder-paste";
import { colateSenzaColli } from "@/lib/pour-necks";
import { ricolaSeLeVieEranoParziali } from "@/lib/pours-recompute";
import { vieSemprePassanti } from "@/lib/via-layers";
import { CHECKS_ENGINE_VERSION, motoreDaSalvare, nonCertificata } from "@/lib/engine-version";
import { withLibrary } from "@/lib/agent-tools";
import { getCompileCache, getProject, hasBoard, saveCompileCache } from "@/lib/project-store";

export const runtime = "nodejs";
// it can pour the planes again (see ricolaSeLeVieEranoParziali): 15 s here on sbb-dl-principale, several times that deployed
export const maxDuration = 300;

/**
 * Recheck WITHOUT re-routing: re-evaluates the cached compiled circuit with
 * the CURRENT checks (DRC, PRC, fabClass, schematic quality) and updates the
 * summary + engine version in cache. The traces are not touched: if the
 * checks changed since the board was routed, the response says where the
 * problem stands today, without moving any copper.
 */
export async function POST(req: Request): Promise<Response> {
  let projectId = "default";
  try {
    const body = (await req.json()) as { projectId?: unknown };
    if (typeof body.projectId === "string" && body.projectId.length <= 120) {
      projectId = body.projectId;
    }
  } catch {
    // no body: default project
  }

  const { ok } = await requireProjectAccess(projectId, "edit");
  if (!ok) return Response.json({ error: "forbidden" }, { status: 403 });

  const cache = await getCompileCache(projectId);
  if (!cache) {
    return Response.json(
      { error: "nessuna compilazione in cache: compila prima il progetto" },
      { status: 404 },
    );
  }

  /*
   * A cache with no board is a failed compile, not a board: re-evaluated it
   * came out with zero violations of every kind — all green on nothing.
   */
  if (!hasBoard(cache.circuitJson)) {
    return Response.json(
      { error: "la compilazione in cache non contiene una scheda: ricompila il progetto" },
      { status: 409 },
    );
  }

  try {
    /*
     * WITH THE SOURCES. summarizeCircuit reads the footprint of each component
     * from the project code — the string never reaches the Circuit JSON — so
     * calling it without them wiped the footprint provenance of every component
     * at each recheck: 98 records became zero, and the board looked like nobody
     * knew where its footprints came from.
     */
    const progetto = await withLibrary(await getProject(projectId));
    /*
     * A board compiled before the paste rule carries tscircuit's 70% openings:
     * re-evaluating it with the new checks must not certify those for export.
     */
    /*
     * And a board poured before the neck rule carries slivers a fab cannot
     * etch: they are cut out here too (see pour-necks.ts).
     */
    /*
     * And a board from before every via was a through hole: its vias are
     * completed (see vieSemprePassanti), and if one of them was written on part
     * of the stack the planes are poured again, because the old engine poured
     * them without seeing that hole (see ricolaSeLeVieEranoParziali). A board
     * with no such via keeps its planes as they are.
     */
    const regole = resolveDesignRules(progetto).rules;
    const ricolata = await ricolaSeLeVieEranoParziali({
      circuitJson: vieSemprePassanti(cache.circuitJson as Array<Record<string, unknown> & { type: string }>),
      engineVersion: cache.engineVersion,
      clearanceMm: regole.pourClearanceMm ?? regole.minClearanceMm,
      bordoMm: regole.minBoardEdgeClearanceMm,
      larghezzaMinimaMm: regole.minTraceWidthMm,
    });
    const senzaColli = await colateSenzaColli(
      ricolata.circuitJson as Array<Record<string, unknown> & { type: string }>,
      regole.minTraceWidthMm,
    );
    const circuitJson = pastaDaiPad(
      senzaColli,
      resolveDesignRules(progetto).rules.pasteExpansionMm ?? 0,
      {
        stencil: leggiStencil(progetto).stencil,
        pasteOnPlatedHoles: resolveDesignRules(progetto).rules.pasteOnPlatedHoles,
      },
    );
    const summary = summarizeCircuit(circuitJson as typeof cache.circuitJson, progetto);
    // a board saved before its schematic stays one: re-evaluating it draws no schematic
    const pending = (cache.summary as { schematicPending?: unknown } | null)?.schematicPending;
    if (typeof pending === "string") summary.schematicPending = pending;
    /*
     * Today's engine is what lets the board be exported, so it is not given to
     * a board that still has a plane over a via of another net: the planes that
     * were poured again above can come back as they were (a pour whose solver
     * fails keeps its old shape), and a board that was not poured again can
     * carry one all the same. That board keeps the engine it had, the export
     * goes on refusing it, and the answer says why (see motoreDaSalvare).
     */
    const motore = motoreDaSalvare(summary, cache.engineVersion);
    const perche = nonCertificata(summary);
    conIlPerche(summary);
    /*
     * Only over the row that was read: a compile that finished while this
     * recheck ran has saved a newer board, and the old one re-evaluated must
     * not take its place.
     */
    const salvataggio = await saveCompileCache(
      projectId,
      cache.filesHash,
      circuitJson,
      summary,
      motore,
      // the same board, re-evaluated: what it was made from does not change
      { ifUnchangedSince: { filesHash: cache.filesHash, createdAt: cache.createdAt }, base: cache.base ?? null },
    ).catch(() => ({ saved: false, reason: "salvataggio fallito" }));
    return Response.json({
      ok: true,
      saved: salvataggio.saved,
      ...(!salvataggio.saved && "reason" in salvataggio ? { reason: salvataggio.reason } : {}),
      // the engine the board is filed under: older than today's when it is not certified
      engineVersion: motore,
      currentEngineVersion: CHECKS_ENGINE_VERSION,
      previousEngineVersion: cache.engineVersion,
      ...(perche ? { nonCertificata: perche } : {}),
      ...(ricolata.ricolata ? { pianiRicolati: true, vieParziali: ricolata.vieParziali } : {}),
      summary,
    });
  } catch (err) {
    return Response.json(
      { error: `recheck failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }
}
