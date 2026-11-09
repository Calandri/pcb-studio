import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  EARLY_REPLY_MIN_COMPONENTS,
  answerAtEarlyBoard,
  repliesEarly,
} from "@/lib/compile-early-reply";

/*
 * On Vercel the answer of the compile of a 243-part board never arrived: the
 * schematic holds the process for minutes and a silent response is dropped
 * (zz-agente-prova-mcp-lungo, 09/11/2026). A big board answers at the early
 * save and finishes in the background; a small one as before.
 */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const parts = (n: number) => Array.from({ length: n }, (_, i) => ({ type: "source_component", name: `R${i}` }));

describe("risposta del compile al salvataggio anticipato", () => {
  it("risponde in anticipo solo da 40 componenti in su", () => {
    expect(repliesEarly(parts(EARLY_REPLY_MIN_COMPONENTS - 1))).toBe(false);
    expect(repliesEarly(parts(EARLY_REPLY_MIN_COMPONENTS))).toBe(true);
    expect(repliesEarly([{ type: "pcb_board" }])).toBe(false);
  });

  it("scheda grande: risponde subito con la scheda salvata e finisce lo schematico in background", async () => {
    let schematicDone = false;
    const kept: Array<Promise<unknown>> = [];
    const t0 = Date.now();
    const answer = await answerAtEarlyBoard<string, string>(
      async (answerEarly) => {
        await wait(10); // the board without schematic
        await answerEarly("scheda salvata, schematico in corso");
        await wait(200); // the schematic
        schematicDone = true;
        return "scheda completa";
      },
      (rest) => kept.push(rest),
      20,
    );
    expect(answer).toEqual({ kind: "early", value: "scheda salvata, schematico in corso" });
    expect(Date.now() - t0).toBeLessThan(150);
    expect(schematicDone).toBe(false);
    // the rest is handed over to whoever keeps the function alive, and it ends
    expect(kept).toHaveLength(1);
    await expect(kept[0]).resolves.toBe("scheda completa");
    expect(schematicDone).toBe(true);
  });

  it("scheda piccola: nessuna risposta anticipata, risponde a fine compilazione come oggi", async () => {
    const kept: Array<Promise<unknown>> = [];
    const answer = await answerAtEarlyBoard<string, string>(
      async () => {
        await wait(10);
        return "riepilogo completo";
      },
      (rest) => kept.push(rest),
      20,
    );
    expect(answer).toEqual({ kind: "final", value: "riepilogo completo" });
    expect(kept).toHaveLength(0);
  });

  it("un errore prima della risposta anticipata arriva al chiamante, dopo arriva a chi tiene viva la funzione", async () => {
    await expect(
      answerAtEarlyBoard<string, string>(async () => {
        throw new Error("sorgenti rotti");
      }, () => {}, 5),
    ).rejects.toThrow("sorgenti rotti");

    const kept: Array<Promise<unknown>> = [];
    const answer = await answerAtEarlyBoard<string, string>(
      async (answerEarly) => {
        await answerEarly("scheda salvata");
        throw new Error("schematico fallito");
      },
      (rest) => kept.push(rest),
      5,
    );
    expect(answer.kind).toBe("early");
    await expect(kept[0]).rejects.toThrow("schematico fallito");
  });

  it("lo strumento compile del server MCP risponde cosi', e lo dice nella descrizione", () => {
    const route = readFileSync(path.join(__dirname, "..", "..", "app", "api", "mcp", "[transport]", "route.ts"), "utf8");
    expect(route).toMatch(/answerAtEarlyBoard</);
    expect(route).toMatch(/repliesEarly\(early\.circuitJson\)/);
    expect(route).toMatch(/after\(finish\)/);
    expect(route).toMatch(/Su una scheda grande/);
  });
});
