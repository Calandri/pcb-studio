/**
 * Keeps an MCP answer alive while a tool works for minutes.
 *
 * WHY. The MCP tools answer on an event stream (text/event-stream) that stays
 * silent until the tool returns. On Vercel a compile of a 243-part board lasts
 * six minutes, and its answer never reached the client: not a byte, not even
 * the headers, although the function had finished and saved the board (test
 * project zz-agente-prova-mcp-lungo, 09/11/2026: saved after ~400 s, the
 * client still empty three minutes later). A compile of a small board, done in
 * a second and a half, arrived whole. A silent response is not delivered.
 *
 * HOW. An SSE comment (a line starting with ":") right away, which sends the
 * headers, and another one every few seconds while the tool is silent. SSE
 * parsers skip comments, so the client sees exactly the same messages: the
 * tool contract does not change, only the silence does.
 */

const COMMENT = new TextEncoder().encode(": attendo il risultato\n\n");

export function withSseKeepalive(response: Response, intervalMs = 15_000): Response {
  const type = response.headers.get("content-type") ?? "";
  if (!response.body || !type.includes("text/event-stream")) return response;

  const upstream = response.body.getReader();
  let timer: ReturnType<typeof setInterval> | null = null;
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let lastWrite = Date.now();
      const write = (chunk: Uint8Array) => {
        lastWrite = Date.now();
        controller.enqueue(chunk);
      };
      write(COMMENT);
      timer = setInterval(() => {
        if (Date.now() - lastWrite < intervalMs) return;
        try {
          write(COMMENT);
        } catch {
          stop();
        }
      }, Math.max(1, Math.floor(intervalMs / 3)));
      void (async () => {
        try {
          for (;;) {
            const { done, value } = await upstream.read();
            if (done) break;
            if (value) write(value);
          }
          stop();
          controller.close();
        } catch (err) {
          stop();
          controller.error(err);
        }
      })();
    },
    cancel(reason) {
      stop();
      return upstream.cancel(reason);
    },
  });

  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
