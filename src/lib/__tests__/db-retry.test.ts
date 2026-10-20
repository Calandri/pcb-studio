import { describe, expect, it } from "vitest";
import { conRiprova, erroreDiRete } from "@/lib/db-retry";

const socketChiuso = () =>
  Object.assign(new Error("Error connecting to database: TypeError: fetch failed"), {
    sourceError: new TypeError("fetch failed", {
      cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
    }),
  });

describe("riprova sugli errori di rete", () => {
  it("riconosce i guasti di rete visti in produzione e non gli errori del database", () => {
    expect(erroreDiRete(socketChiuso())).toBe(true);
    expect(erroreDiRete(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }))).toBe(true);
    expect(erroreDiRete(new Error('duplicate key value violates unique constraint "x"'))).toBe(false);
  });
  it("ritenta un socket chiuso e riesce al secondo colpo", async () => {
    let n = 0;
    const r = await conRiprova(async () => {
      n++;
      if (n === 1) throw socketChiuso();
      return "salvato";
    }, { attesaMs: 1 });
    expect(r).toBe("salvato");
    expect(n).toBe(2);
  });
  it("non ritenta un errore del database e si arrende dopo i tentativi previsti", async () => {
    let n = 0;
    await expect(conRiprova(async () => { n++; throw new Error("syntax error at or near"); }, { attesaMs: 1 })).rejects.toThrow("syntax");
    expect(n).toBe(1);
    let m = 0;
    await expect(conRiprova(async () => { m++; throw socketChiuso(); }, { tentativi: 3, attesaMs: 1 })).rejects.toThrow("fetch failed");
    expect(m).toBe(3);
  });
});
