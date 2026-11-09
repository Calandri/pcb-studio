import { describe, expect, it } from "vitest";
import { COMPILE_MAX_MS, COMPILE_START, compileRunFrom } from "@/lib/compile-run";

/*
 * The empty "Sbroglio" tab of fototrappola-frontale: no saved board, and
 * nothing said whether a compile was running somewhere or had been cut off.
 * The log knows: these are its newest compile lines, newest first.
 */

const now = Date.parse("2026-11-09T21:00:00Z");
const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
const ev = (minutesAgo: number, phase: "avvio" | "fine" | "errore", detail: string, actor = "claude") => ({
  at: at(minutesAgo),
  actor,
  phase,
  detail,
});

describe("compilazione in corso dal registro", () => {
  it("nessuna compilazione: niente da dire", () => {
    expect(compileRunFrom([], now)).toBeNull();
  });

  it("l'ultima compilazione e' finita: niente in corso", () => {
    expect(compileRunFrom([ev(1, "fine", "tutto a posto"), ev(4, "avvio", COMPILE_START)], now)).toBeNull();
  });

  it("una compilazione avviata e non finita e' in corso, con chi l'ha avviata e il passo", () => {
    const run = compileRunFrom(
      [ev(1, "avvio", "Leggo la scheda - componenti"), ev(2, "avvio", COMPILE_START, "app"), ev(30, "fine", "ok")],
      now,
    );
    expect(run).toEqual({ state: "running", startedAt: at(2), actor: "app", step: "Leggo la scheda - componenti" });
  });

  it("oltre la durata massima di una funzione e' stata interrotta", () => {
    const run = compileRunFrom([ev(COMPILE_MAX_MS / 60_000 + 2, "avvio", COMPILE_START)], now);
    expect(run?.state).toBe("interrupted");
  });

  it("una nuova compilazione dopo una interrotta conta dal suo inizio", () => {
    const run = compileRunFrom(
      [
        ev(1, "avvio", "Leggo la scheda"),
        ev(2, "avvio", COMPILE_START, "app"),
        ev(3, "avvio", "Leggo la scheda"),
        ev(16, "avvio", COMPILE_START),
      ],
      now,
    );
    expect(run?.state).toBe("running");
    expect(run?.startedAt).toBe(at(2));
  });
});
