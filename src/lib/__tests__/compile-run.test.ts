import { describe, expect, it } from "vitest";
import { COMPILE_MAX_MS, COMPILE_START, FUNCTION_MAX_MS, compileBudgetMs, compileRunFrom, rigaDiFine } from "@/lib/compile-run";

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

/*
 * sbb-dl-principale, 11/11/2026: the compile believed it had 9 minutes whatever
 * the function had left, started the schematic at ~300 s and was killed at 800
 * with no outcome. It is told what is left, and when it ends without the
 * schematic the closing line of the log says so first.
 */
describe("il tempo che resta alla funzione e la riga di fine", () => {
  it("una compilazione puo' spendere la vita della funzione meno il gia' passato e il margine del salvataggio", () => {
    expect(compileBudgetMs(1_000_000, 1_010_000)).toBe(FUNCTION_MAX_MS - 10_000 - 30_000);
  });

  it("una scheda senza schematico lo dice per prima cosa, anche quando il messaggio e' lungo", () => {
    const lungo = `Compile OK: ${"x".repeat(400)}`;
    expect(rigaDiFine({ message: lungo })).toBe(lungo.slice(0, 300));
    const riga = rigaDiFine({ message: lungo, schematicPending: "lo schematico non e' partito: restavano 120 s" });
    expect(riga).toMatch(/^senza schematico: lo schematico non e' partito: restavano 120 s\. Compile OK/);
    expect(riga.length).toBe(300);
  });

  it("si taglia il messaggio, mai il motivo; e una scheda completa dice cosa e' successo prima del messaggio", () => {
    const motivo = `lo schematico non e' partito: ${"m".repeat(240)}`;
    const riga = rigaDiFine({ message: `Compile OK ${"x".repeat(400)}`, schematicPending: motivo }, 300);
    expect(riga.startsWith(`senza schematico: ${motivo}. Compile`)).toBe(true);
    expect(riga.length).toBe(300);
    expect(rigaDiFine({ message: "Compile OK" }, 300, "schematico salvato: ")).toBe("schematico salvato: Compile OK");
    expect(rigaDiFine({ message: "Compile OK", schematicPending: "x" }, 300, "schematico salvato: ")).toBe("senza schematico: x. Compile OK");
  });
});
