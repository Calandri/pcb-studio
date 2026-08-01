import { requireProjectAccess } from "@/lib/acl";
import { readActivity } from "@/lib/activity-store";

export const runtime = "nodejs";
// a Claude work session lasts minutes: the stream must sustain them without
// restarting the client in the middle of a compilation
export const maxDuration = 300;

/**
 * The live stream of what is happening to the project.
 *
 * It is an event stream rather than a one-shot read because the use case is
 * exactly that: you paste a command into Claude, Claude works for minutes
 * somewhere else, and this page must narrate it as it happens. Asking "and
 * now?" every two seconds would work too, but the stream costs one connection
 * instead of a hundred and fifty requests and arrives sooner.
 *
 * The stream does NOT hold state: it reads the log and sends what has
 * appeared after the last seen id. If it drops, the client resumes from the
 * id it had and loses nothing. This is the reason the log lives in a table
 * and not in memory: Claude's work arrives on a different lambda than the one
 * serving the page, and two processes do not share a variable.
 */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const projectId = url.searchParams.get("projectId") ?? "default";
  const since = Number(url.searchParams.get("since") ?? 0);

  const { ok } = await requireProjectAccess(projectId, "view");
  if (!ok) return Response.json({ error: "forbidden" }, { status: 403 });

  const encoder = new TextEncoder();
  let cursor = Number.isFinite(since) && since > 0 ? since : 0;
  // on first open the recent backlog is shown, so someone arriving mid-way
  // understands what is happening instead of seeing an empty panel
  let first = cursor === 0;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          closed = true;
        }
      };

      const stop = () => {
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed by the client
        }
      };
      req.signal.addEventListener("abort", stop);

      const startedAt = Date.now();
      while (!closed && Date.now() - startedAt < 270_000) {
        const events = await readActivity(projectId, cursor, first ? 25 : 60);
        first = false;
        if (events.length) {
          cursor = events[events.length - 1].id;
          send("attivita", { events, cursor });
        } else {
          // heartbeat: without it, a proxy closes a silent connection and the
          // client keeps restarting
          send("battito", { cursor });
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
      stop();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
