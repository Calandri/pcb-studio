import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withSseKeepalive } from "@/lib/sse-keepalive";

/*
 * On Vercel the answer of a long compile never reached the MCP client: the
 * event stream stayed silent for minutes and not even the headers arrived
 * (test project zz-agente-prova-mcp-lungo, 09/11/2026). The stream now opens
 * with an SSE comment and repeats one while the tool is silent.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

function slowSse(delayMs: number, payload: string): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      setTimeout(() => {
        controller.enqueue(enc.encode(payload));
        controller.close();
      }, delayMs);
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function readTimed(res: Response) {
  const reader = res.body!.getReader();
  const t0 = Date.now();
  const chunks: Array<{ at: number; text: string }> = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push({ at: Date.now() - t0, text: dec.decode(value) });
  }
  return chunks;
}

describe("risposta MCP che non resta muta", () => {
  it("manda subito un commento e poi uno ogni intervallo, e il messaggio arriva intatto", async () => {
    const event = 'event: message\ndata: {"jsonrpc":"2.0","id":3,"result":{"content":[]}}\n\n';
    const chunks = await readTimed(withSseKeepalive(slowSse(220, event), 40));
    // the first byte leaves at once: it is what sends the headers
    expect(chunks[0].at).toBeLessThan(30);
    expect(chunks[0].text.startsWith(":")).toBe(true);
    const comments = chunks.filter((c) => c.text.startsWith(":"));
    expect(comments.length).toBeGreaterThanOrEqual(3);
    // the client sees the same messages: comments are not SSE events
    const data = chunks.filter((c) => !c.text.startsWith(":")).map((c) => c.text).join("");
    expect(data).toBe(event);
    expect(chunks[chunks.length - 1].text).toBe(event);
  });

  it("le risposte che non sono un flusso di eventi restano come sono", async () => {
    const json = new Response('{"ok":true}', { headers: { "content-type": "application/json" } });
    expect(withSseKeepalive(json)).toBe(json);
  });

  it("se il client chiude, smette di scrivere e chiude anche lo strumento", async () => {
    let cancelled = false;
    const upstream = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
    const res = withSseKeepalive(upstream, 10);
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel("client andato");
    expect(cancelled).toBe(true);
  });

  it("il server MCP passa le risposte da qui", () => {
    const route = readFileSync(path.join(__dirname, "..", "..", "app", "api", "mcp", "[transport]", "route.ts"), "utf8");
    expect(route).toMatch(/withSseKeepalive\(await buildHandler\(identity\)\(req\)\)/);
  });
});
