/**
 * Reading the event streams of /api/compile, /api/reroute and /api/agent.
 *
 * The three readers used to be three copies of the same loop, and they had
 * drifted: one parsed every event without a try/catch, so a single malformed
 * line killed the whole agent turn, and none of them ever cancelled the
 * reader, so a turn that failed half-way left the connection open behind it.
 * One reader, used by all three.
 */

export interface SseEvent {
  event: string;
  data: string;
}

/**
 * Splits the complete events off the front of the buffer. Events are separated
 * by a blank line; the last piece may be cut in half by the network and is
 * returned as `rest`, to be completed by the next chunk.
 */
export function splitSseEvents(buffer: string): { events: SseEvent[]; rest: string } {
  const chunks = buffer.split("\n\n");
  const rest = chunks.pop() ?? "";
  const events: SseEvent[] = [];
  for (const chunk of chunks) {
    const event = /^event: (.+)$/m.exec(chunk)?.[1];
    const data = chunk
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => l.slice(6))
      .join("\n");
    if (!event || !data) continue;
    events.push({ event, data });
  }
  return { events, rest };
}

/**
 * Reads a whole stream, handing each event to `onEvent` with its data already
 * parsed. A malformed event, or a handler that throws on an event shaped
 * differently than expected, is skipped and the stream goes on: one bad line
 * is not a reason to throw away a turn that is still working. The reader is
 * always cancelled at the end, however the loop ends.
 */
export async function readSseStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: string, data: unknown) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deliver = (events: SseEvent[]) => {
    for (const e of events) {
      let data: unknown;
      try {
        data = JSON.parse(e.data);
      } catch {
        continue;
      }
      try {
        onEvent(e.event, data);
      } catch (err) {
        console.warn(`evento "${e.event}" ignorato:`, err);
      }
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = splitSseEvents(buffer);
      buffer = rest;
      deliver(events);
    }
    // a last event the server closed without the trailing blank line
    buffer += decoder.decode();
    if (buffer.trim()) deliver(splitSseEvents(`${buffer}\n\n`).events);
  } finally {
    await reader.cancel().catch(() => {});
  }
}
