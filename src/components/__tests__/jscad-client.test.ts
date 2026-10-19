import { describe, expect, it } from "vitest";
import { SupersededError, latestWins } from "@/lib/jscad-client";

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("latestWins", () => {
  it("runs one job at a time and only the last waiting one after it", async () => {
    const started: number[] = [];
    const gates = new Map<number, ReturnType<typeof deferred<string>>>();
    const run = latestWins((n: number) => {
      started.push(n);
      const d = deferred<string>();
      gates.set(n, d);
      return d.promise;
    });

    // handlers attached right away: the rejections happen synchronously
    const first = expect(run(1)).rejects.toBeInstanceOf(SupersededError);
    const second = expect(run(2)).rejects.toBeInstanceOf(SupersededError);
    const third = run(3);
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toEqual([1]);

    // 2 was overtaken while still waiting: it never runs
    await second;

    gates.get(1)!.resolve("uno");
    // 1 finished after a newer request: its result is stale and dropped
    await first;
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toEqual([1, 3]);

    gates.get(3)!.resolve("tre");
    await expect(third).resolves.toBe("tre");
  });

  it("passes the result through when nobody overtakes", async () => {
    const run = latestWins(async (n: number) => n * 2);
    await expect(run(21)).resolves.toBe(42);
  });

  it("does not stay stuck after a job that throws", async () => {
    const run = latestWins((n: number) => {
      if (n === 1) throw new Error("rotto");
      return Promise.resolve(n);
    });
    await expect(run(1)).rejects.toThrow("rotto");
    await expect(run(2)).resolves.toBe(2);
  });
});
