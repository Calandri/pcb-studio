"use client";

import { COMPILE_START, type CompileRun } from "@/lib/compile-run";

const WHO: Record<string, string> = {
  claude: "Claude",
  agente: "il copilota",
  app: "una pagina dello studio",
};

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });

/**
 * What the board area says when the server has no compiled board.
 *
 * There used to be a browser compile of the project here (tscircuit's
 * RunFrame): on a big board it never finished, the area stayed empty with a
 * tip about the autorouter, and nothing said that the board simply had never
 * been compiled. Now it is said, with the button, and with the compile that is
 * running somewhere (Claude, another tab) or that was cut off.
 */
export function BoardNotCompiled({
  run,
  recompiling,
  step,
  seconds,
  problem,
  busy,
  onRecompile,
}: {
  /** a compile running, or cut off, anywhere: from the project's log */
  run: CompileRun | null;
  /** this page is compiling */
  recompiling: boolean;
  step: string;
  seconds: number;
  /** why the last compile from this page ended without a board */
  problem: string | null;
  /** another job is on the board: the button waits */
  busy: boolean;
  onRecompile: () => void;
}) {
  const runningElsewhere = !recompiling && run?.state === "running";
  return (
    <div className="flex h-full w-full items-center justify-center p-6">
      <div className="w-[min(480px,100%)] rounded-[14px] border border-[#2C4C42] bg-[rgba(9,20,17,0.95)] px-5 py-4 shadow-[0_18px_60px_rgba(0,0,0,0.5)]">
        <div className="text-[14px] font-semibold text-brand">Scheda non ancora compilata</div>
        <p className="mt-1.5 text-[12px] leading-relaxed text-muted">
          Il server non ha una compilazione salvata di questo progetto, quindi non c&apos;e&apos;
          niente da disegnare. Premi Ricompila: legge i file e disegna la scheda, senza
          instradare e senza spostare pezzi.
        </p>

        {recompiling && (
          <p className="mt-2.5 flex items-center gap-2 text-[12px] text-[#9DB8AC]">
            <span className="dot dot-live" />
            <span className="truncate">
              Compilazione in corso da {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
              {step ? `: ${step}` : ""}
            </span>
          </p>
        )}
        {runningElsewhere && run && (
          <p className="mt-2.5 flex items-start gap-2 text-[12px] text-[#9DB8AC]">
            <span className="dot dot-live mt-1" />
            <span>
              Compilazione in corso, avviata da {WHO[run.actor] ?? run.actor} alle{" "}
              {clock(run.startedAt)}
              {run.step && run.step !== COMPILE_START ? `: ${run.step}` : ""}. La scheda
              compare qui da sola quando e&apos; salvata.
            </span>
          </p>
        )}
        {!recompiling && run?.state === "interrupted" && (
          <p className="mt-2.5 text-[12px] leading-snug text-[#E8C97A]">
            L&apos;ultima compilazione, avviata da {WHO[run.actor] ?? run.actor} alle{" "}
            {clock(run.startedAt)}, non e&apos; mai finita: e&apos; stata interrotta prima di
            salvare (durata massima della funzione o errore del server).
          </p>
        )}
        {!recompiling && problem && (
          <p className="mt-2.5 text-[12px] leading-snug text-[#FFB4AB]" title={problem}>
            Ultimo tentativo da questa pagina: {problem}
          </p>
        )}

        <button
          type="button"
          onClick={onRecompile}
          disabled={busy || runningElsewhere}
          className="mt-3.5 rounded-lg bg-brand px-3.5 py-1.5 text-[12px] font-semibold text-[#06110D] transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {recompiling ? "Compilo…" : runningElsewhere ? "Compilazione in corso…" : "Ricompila"}
        </button>
      </div>
    </div>
  );
}
