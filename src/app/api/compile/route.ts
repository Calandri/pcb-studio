import { accessoDaRichiesta } from "@/lib/acl";
import { withLibrary } from "@/lib/agent-tools";
import { compileProject, type CompileProgress } from "@/lib/compile";
import { CHECKS_ENGINE_VERSION } from "@/lib/engine-version";
import {
  filesHash,
  getCompileCache,
  getProject,
  saveCompileCache,
  saveRouteVariants,
} from "@/lib/project-store";

export const runtime = "nodejs";
// increasing-effort routing is the slow part: it gets the same time window
// as the agentic loop, otherwise a dense board gets cut off halfway
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
  let projectId = "default";
  /*
   * Whether to lay copper. Default NO: "recompile" means showing the real
   * board, and it takes seconds. Routing is another gesture, and it is asked
   * for — the agent's compile tool asks for it, the button does not.
   */
  let route = false;
  try {
    const body = (await req.json()) as { projectId?: unknown; route?: unknown };
    if (typeof body.projectId === "string" && body.projectId.length <= 120) {
      projectId = body.projectId;
    }
    if (body.route === true) route = true;
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

      try {
        /*
         * The stream opens BEFORE loading the project: these steps can take
         * seconds on a cold function, and a panel that says "Comincio" for two
         * minutes looks dead. Every slow stage announces itself.
         */
        send("passo", { step: "Carico il progetto", progress: 0.02 });
        let t = Date.now();
        const fsMap = await withLibrary(await getProject(projectId));
        mark("getProject+withLibrary", t);
        if (Object.keys(fsMap).length === 0) {
          send("errore", { error: "progetto vuoto" });
          return;
        }

        // the copper already on the board, to carry over when not routing
        send("passo", { step: "Recupero il rame esistente", progress: 0.04 });
        t = Date.now();
        const inCache = route ? null : await getCompileCache(projectId).catch(() => null);
        mark("getCompileCache", t);

        const { summary, circuitJson, variants } = await compileProject(fsMap, {
          route,
          keepCopperFrom: (inCache?.circuitJson as unknown[] | undefined) ?? undefined,
          onProgress: (event: CompileProgress) =>
            send("passo", {
              step: event.step,
              detail: event.detail,
              progress: event.progress,
              // the drawing only travels when it really exists: it's megabytes
              circuitJson: event.circuitJson ?? undefined,
            }),
        });
        mark("compileProject", t0);
        const hash = filesHash(fsMap);
        await saveCompileCache(
          projectId,
          hash,
          circuitJson,
          summary,
          CHECKS_ENGINE_VERSION,
        ).catch(() => {});
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
        send("fine", { ok: summary.ok, summary });
      } catch (err) {
        send("errore", { error: err instanceof Error ? err.message : String(err) });
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
