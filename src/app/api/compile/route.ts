import { boardBaseOf } from "@/lib/board-base";
import { accessoDaRichiesta } from "@/lib/acl";
import { COMPILE_START, logActivity } from "@/lib/activity-store";
import { withLibrary } from "@/lib/agent-tools";
import { compileProject, type CompileProgress } from "@/lib/compile";
import { compileBudgetMs, rigaDiFine } from "@/lib/compile-run";
import {
  filesHash,
  getCompileCache,
  getProject,
  saveRouteVariants,
} from "@/lib/project-store";
import { motivoErrore } from "@/lib/error-cause";
import { earlyBoardSaver, saveFinishedCompile } from "@/lib/compile-save";

export const runtime = "nodejs";
// a large board takes minutes just to be read again (190 parts: ~2 minutes)
export const maxDuration = 800;

/**
 * Recompiles the project and refreshes the cache. It is the same compilation
 * the agent's `compile` tool uses: it lets you recompile without spending a
 * chat turn (after a code change, or to retry the routing).
 *
 * The response is a stream of events, not a single result. A compilation
 * takes minutes: whoever is watching must see where it is and how the board
 * changes as it works — first the geometry, then the placed parts, then the
 * copper pass after pass. A request that stays silent for eight minutes and
 * then replies is indistinguishable from a crashed one.
 */
export async function POST(req: Request): Promise<Response> {
  // the function's clock starts here: the compile is told how much of it is left (see compileBudgetMs)
  const requestStartedAt = Date.now();
  let projectId = "default";
  /** draw the schematic even when it would not end in time (see CompileOptions.forceSchematic): the page never sends it */
  let forceSchematic = false;
  /*
   * It never lays copper: "recompile" means showing the real board with the
   * copper already on it. There is no automatic routing any more (2026-11-09),
   * a `route` field in the body is ignored.
   */
  try {
    const body = (await req.json()) as { projectId?: unknown; forceSchematic?: unknown };
    if (typeof body.projectId === "string" && body.projectId.length <= 120) {
      projectId = body.projectId;
    }
    forceSchematic = body.forceSchematic === true;
  } catch {
    // no body: recompile the default project
  }

  if (!(await accessoDaRichiesta(req, projectId, "edit"))) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const t0 = Date.now();
      const mark = (what: string, since: number) =>
        console.log(`[compile ${projectId}] ${what}: ${((Date.now() - since) / 1000).toFixed(1)}s (tot ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          // the client disconnected: compilation keeps going anyway and the
          // cache is saved regardless, so the work is not thrown away
          closed = true;
        }
      };

      /*
       * In the project's log, like a compile from Claude: whoever has the page
       * open elsewhere (or reloads it mid-way) sees that a compile is running
       * and where it is, instead of an empty board (see readCompileRun).
       */
      const activity = (phase: "avvio" | "fine" | "errore", detail: string, ms?: number) =>
        logActivity(projectId, { actor: "app", tool: "compile", phase, detail, ms });
      let lastStep = "";
      await activity("avvio", COMPILE_START);

      try {
        /*
         * The stream opens BEFORE loading the project: these steps can take
         * seconds on a cold function, and a panel that says "Comincio" for two
         * minutes looks dead. Every slow stage announces itself.
         */
        send("passo", { step: "Carico il progetto", progress: 0.02 });
        let t = Date.now();
        // the files are read now: a board saved after this moment may be of newer ones (see compile-save)
        const fresh = { startedAt: t, filesNow: async () => withLibrary(await getProject(projectId)) };
        const fsMap = await withLibrary(await getProject(projectId));
        mark("getProject+withLibrary", t);
        if (Object.keys(fsMap).length === 0) {
          await activity("errore", "progetto vuoto", Date.now() - t0);
          send("errore", { error: "progetto vuoto" });
          return;
        }

        // the copper already on the board, carried over as it is
        send("passo", { step: "Recupero il rame esistente", progress: 0.04 });
        t = Date.now();
        const inCache = await getCompileCache(projectId).catch(() => null);
        mark("getCompileCache", t);

        const hash = filesHash(fsMap);
        // what this board is made from, apart from the hand positions: saved with it (see board-base.ts)
        const base = boardBaseOf(fsMap);
        const saveEarly = earlyBoardSaver(projectId, hash, inCache, fresh, base);
        /** the board is saved and the page has been told: the drawings of the schematic phase stay here */
        let schedaInviata = false;
        const { summary, circuitJson, variants } = await compileProject(fsMap, {
          keepCopperFrom: (inCache?.circuitJson as unknown[] | undefined) ?? undefined,
          // what is left of the function: the schematic does not start if it cannot end (see stimaDelloSchematico)
          budgetMs: compileBudgetMs(requestStartedAt),
          forceSchematic,
          // the schematic of the last board, reused when only PCB positions changed
          schematicFrom: inCache ? { circuitJson: inCache.circuitJson as unknown[], summary: inCache.summary } : null,
          // the board is saved as soon as it exists, before the schematic: see compile-save.ts
          onBoard: async (early) => {
            const r = await saveEarly(early);
            if (r.saved) {
              mark("scheda salvata senza schematico", t0);
              await activity("avvio", "Scheda salvata - ora lo schematico");
            }
            /*
             * The page unblocks the board here: the schematic goes on in the
             * background. Also when nothing was saved because the saved board
             * is already the complete one of these files, or a newer one: the
             * board on screen is right, and the panel stayed for the whole
             * schematic (prova-principale, 2026-11-09: 142 s instead of 32).
             */
            if (r.saved || r.keptPrevious) {
              send("scheda", { saved: r.saved });
              schedaInviata = true;
            }
          },
          onProgress: (event: CompileProgress) => {
            send("passo", {
              step: event.step,
              detail: event.detail,
              progress: event.progress,
              // the drawing only travels when it really exists: it's megabytes. Not
              // after the board is saved: the page has it, and megabytes queued on
              // the stream would hold back every event behind them
              circuitJson: schedaInviata ? undefined : (event.circuitJson ?? undefined),
            });
            // only step CHANGES go to the log, not every heartbeat
            if (event.step && event.step !== lastStep) {
              lastStep = event.step;
              void activity("avvio", event.detail ? `${event.step} - ${event.detail}` : event.step);
            }
          },
        });
        mark("compileProject", t0);
        /*
         * A compile that produced no board is NOT saved over the last good one
         * (see saveCompileCache): it is said, so whoever is watching knows the
         * board on screen is the previous one and why.
         */
        const salvataggio = await saveFinishedCompile(projectId, hash, circuitJson as unknown[], summary, fresh, base).catch((err) => ({
          saved: false,
          reason: `salvataggio fallito: ${motivoErrore(err)}`,
        }));
        if (!salvataggio.saved && "reason" in salvataggio && salvataggio.reason) {
          summary.message += ` (${salvataggio.reason})`;
        }
        if (variants) {
          await saveRouteVariants(
            projectId,
            hash,
            variants.map((sv) => ({
              sectionKey: sv.section.key,
              candidates: sv.candidates.map((c) => ({
                label: c.label,
                traces: c.traces,
                stats: c.stats,
                drc: c.drc,
              })),
              pickedLabel: sv.candidates[sv.picked]?.label ?? "",
            })),
          ).catch(() => {});
        }
        await activity(
          "fine",
          salvataggio.saved ? rigaDiFine(summary) : `non salvata: ${rigaDiFine(summary, 260)}`,
          Date.now() - t0,
        );
        // superseded: a newer board is saved (moves made meanwhile), not a failure to show
        send("fine", {
          ok: summary.ok,
          summary,
          saved: salvataggio.saved,
          superseded: "superseded" in salvataggio && salvataggio.superseded === true,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await activity("errore", message, Date.now() - t0);
        send("errore", { error: message });
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed by the client
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // without this a proxy buffers the stream and delivers it all at once
      // at the end: the events would arrive when they are no longer useful
      "x-accel-buffering": "no",
    },
  });
}
