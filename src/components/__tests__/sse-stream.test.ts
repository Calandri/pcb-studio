import { describe, expect, it, vi } from "vitest";
import { readSseStream, splitSseEvents } from "@/components/sse-stream";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
      else controller.close();
    },
  });
}

describe("splitSseEvents", () => {
  it("keeps the half event for the next chunk", () => {
    const { events, rest } = splitSseEvents('event: passo\ndata: {"a":1}\n\nevent: fi');
    expect(events).toEqual([{ event: "passo", data: '{"a":1}' }]);
    expect(rest).toBe("event: fi");
  });

  it("skips blocks without an event name or data", () => {
    const { events } = splitSseEvents(": comment\n\nevent: x\n\ndata: {}\n\n");
    expect(events).toEqual([]);
  });
});

describe("readSseStream", () => {
  it("delivers events split across chunks and survives a malformed one", async () => {
    const seen: Array<[string, unknown]> = [];
    await readSseStream(
      streamOf([
        'event: passo\ndata: {"step":"uno"}\n\nevent: rotto\ndata: {non json\n\nevent: fi',
        'ne\ndata: {"ok":true}\n\n',
      ]),
      (event, data) => seen.push([event, data]),
    );
    expect(seen).toEqual([
      ["passo", { step: "uno" }],
      ["fine", { ok: true }],
    ]);
  });

  it("keeps going when a handler throws on one event", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const seen: string[] = [];
    await readSseStream(
      streamOf(['event: a\ndata: 1\n\nevent: b\ndata: 2\n\n']),
      (event) => {
        if (event === "a") throw new Error("forma inattesa");
        seen.push(event);
      },
    );
    expect(seen).toEqual(["b"]);
    warn.mockRestore();
  });

  it("delivers a last event closed without the blank line", async () => {
    const seen: string[] = [];
    await readSseStream(streamOf(['event: done\ndata: {}']), (event) => seen.push(event));
    expect(seen).toEqual(["done"]);
  });

  it("hands the events read so far, then rejects when the network fails", async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        if (pulls === 1) controller.enqueue(new TextEncoder().encode("event: a\ndata: 1\n\n"));
        else controller.error(new Error("rete giu'"));
      },
    });
    const seen: string[] = [];
    await expect(readSseStream(body, (event) => seen.push(event))).rejects.toThrow("rete giu'");
    expect(seen).toEqual(["a"]);
  });
});
