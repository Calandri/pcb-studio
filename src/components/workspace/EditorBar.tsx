"use client";

import { useEffect, useState } from "react";
import type { ManualEditor } from "./useManualEditor";

/**
 * Manual editor commands, above the canvas.
 *
 * It sits above the board and not in a side column because it is a modal
 * bar: it changes what the mouse does. While it is in "move" or "route"
 * it stays lit and visible, so you don't drag a component believing you
 * are moving the view.
 */
export function EditorBar({
  editor,
  scope,
  stale = false,
  onRecompile,
}: {
  editor: ManualEditor;
  /** on the schematic you only move things: traces are a copper affair */
  scope: "schematic" | "pcb";
  /**
   * The board being shown is older than the files. Hand editing cannot work
   * here: the viewer speaks in coordinates of a circuit that no longer matches
   * the sources, and saving them would write positions referring to a board
   * that no longer exists (the server refuses them, rightly). So the commands
   * are switched off and the reason is said out loud, with the way out.
   */
  stale?: boolean;
  onRecompile?: () => void;
}) {
  const { mode, setMode, counts, busy, canUndo, canRedo, error, dirty, links, unlinks } =
    editor;
  /** two-step "release all": the first click asks, the second executes */
  const [confirmRelease, setConfirmRelease] = useState(false);

  // keyboard shortcuts: without these "undo" is not undo
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
      if (stale) return;
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) void editor.redo();
        else void editor.undo();
        return;
      }
      if (meta && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void editor.apply();
        return;
      }
      if (e.key === "Escape" && mode !== "view") {
        e.preventDefault();
        setMode("view");
        return;
      }
      if (e.key.toLowerCase() === "m" && !meta) setMode(mode === "move" ? "view" : "move");
      if (e.key.toLowerCase() === "c" && !meta && scope === "schematic") {
        setMode(mode === "link" ? "view" : "link");
      }
      /*
       * Routing is on I, not on R.
       *
       * R had taken the most natural key on a board editor - the one everyone
       * presses to turn a part - and rotation had to hide behind cmd+R, which
       * is also the browser reload. You pressed to rotate and you changed
       * mode; you pressed harder and you reloaded the page. Now R turns
       * (canvas) and I routes (here): two letters, two jobs, no overlap.
       */
      if (e.key.toLowerCase() === "i" && !meta && scope === "pcb") {
        setMode(mode === "route" ? "view" : "route");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editor, mode, setMode, scope, stale]);

  return (
    <div className="pointer-events-auto absolute left-1/2 top-[18px] z-20 flex -translate-x-1/2 flex-col items-center gap-1.5">
      <div className="flex items-center gap-1 rounded-[12px] border border-[#1F2C29] bg-[rgba(9,14,13,0.92)] p-[5px] backdrop-blur">
        <Segment
          active={mode === "view"}
          onClick={() => setMode("view")}
          title="Solo lettura: il mouse muove la vista (Esc)"
          label="Guarda"
        />
        <Segment
          active={mode === "move"}
          onClick={() => setMode("move")}
          disabled={stale}
          title={
            stale
              ? "La scheda a schermo e' piu' vecchia dei file: ricompila e poi la sposti"
              : scope === "schematic"
                ? "Trascina i simboli dove li vuoi (M)"
                : "Trascina i componenti sul rame (M)"
          }
          label="Sposta"
        />
        {scope === "schematic" && (
          <Segment
            active={mode === "link"}
            onClick={() => setMode("link")}
            disabled={stale}
            title={
              stale
                ? "La scheda a schermo e' piu' vecchia dei file: ricompila e poi colleghi"
                : "Clicca due piedini per collegarli, clicca un filo per toglierlo (C)"
            }
            label="Collega"
          />
        )}
        {scope === "pcb" && (
          <Segment
            active={mode === "route"}
            onClick={() => setMode("route")}
            disabled={stale}
            title={
              stale
                ? "La scheda a schermo e' piu' vecchia dei file: ricompila e poi ci disegni sopra"
                : "Parti da un pad e disegna il percorso della pista (I)"
            }
            label="Instrada"
          />
        )}

        <span className="mx-1 h-5 w-px bg-line" />

        <Icon
          onClick={() => void editor.undo()}
          disabled={!canUndo || busy}
          title="Annulla (Cmd+Z)"
        >
          <path
            d="M4 8h6.5a3 3 0 110 6H8M4 8l3-3M4 8l3 3"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </Icon>
        <Icon
          onClick={() => void editor.redo()}
          disabled={!canRedo || busy}
          title="Ripristina (Cmd+Shift+Z)"
        >
          <path
            d="M16 8H9.5a3 3 0 100 6H12M16 8l-3-3M16 8l-3 3"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </Icon>

        <span className="mx-1 h-5 w-px bg-line" />

        <button
          type="button"
          onClick={() => void editor.apply()}
          disabled={dirty === 0 || busy}
          title="Scrive le modifiche nel progetto e ricompila (Cmd+S)"
          className={`rounded-[8px] px-3 py-[7px] text-[12px] font-semibold transition-colors ${
            dirty > 0 && !busy
              ? "bg-brand text-ink hover:bg-brand-strong"
              : "bg-sunken text-faint"
          }`}
        >
          {busy ? "Applico..." : dirty > 0 ? `Applica ${dirty}` : "Applica"}
        </button>
        {dirty > 0 && !busy && (
          <button
            type="button"
            onClick={editor.discard}
            title="Butta via le modifiche non ancora applicate"
            className="rounded-[8px] px-2.5 py-[7px] text-[12px] text-muted transition-colors hover:text-text"
          >
            Scarta
          </button>
        )}
      </div>

      {stale && (
        <div className="flex items-center gap-2 rounded-[10px] border border-[#4A3A1F] bg-[rgba(24,18,8,0.92)] px-3 py-1.5 backdrop-blur">
          <span className="text-[11px] text-[#E3B341]">
            La scheda a schermo e&apos; piu&apos; vecchia dei file: 1–2 minuti per
            aggiornarla, e il rame non si tocca.
          </span>
          {onRecompile && (
            <button
              type="button"
              onClick={onRecompile}
              title="Rilegge i file e mostra la scheda attuale: le piste restano le tue"
              className="rounded-[7px] bg-[#E3B341] px-2.5 py-[5px] text-[11px] font-semibold text-ink transition-colors hover:bg-[#F0C24E]"
            >
              Aggiorna
            </button>
          )}
        </div>
      )}

      {!stale &&
        (counts.pcb + counts.schematic + counts.traceHints + counts.routes > 0 ||
          error ||
          mode !== "view") && (
        // one line, never wrapping: it sits over the board and every extra row
        // covers copper. What does not fit goes into the tooltip.
        <div className="flex max-w-[92vw] items-center gap-2 overflow-hidden whitespace-nowrap rounded-[10px] border border-[#1F2C29] bg-[rgba(9,14,13,0.9)] px-2.5 py-1 backdrop-blur">
          {error ? (
            <span className="text-[11px] text-danger">{error}</span>
          ) : (
            <>
              {mode !== "view" && (
                <span
                  className="text-[11px] text-brand"
                  title={
                    mode === "move"
                      ? "Trascina un componente per spostarlo. R lo ruota, le frecce lo muovono di un passo"
                      : mode === "link"
                        ? "Clicca due piedini per collegarli, clicca un filo per toglierlo"
                        : "Clicca un pad, poi clicca dove far passare la pista"
                  }
                >
                  {mode === "move" ? "trascina" : mode === "link" ? "collega" : "instrada"}
                </span>
              )}
              {(links.length > 0 || unlinks.length > 0) && (
                <span
                  className="font-mono text-[10px] text-[#5F726C]"
                  title="collegamenti aggiunti e togli a mano, non ancora applicati"
                >
                  {links.length > 0 ? `+${links.length}` : ""}
                  {links.length > 0 && unlinks.length > 0 ? " " : ""}
                  {unlinks.length > 0 ? `-${unlinks.length}` : ""}
                </span>
              )}
              {/*
                What this row says, in words: how many pieces YOU are holding
                still. A held piece is a piece no automatic action may move —
                not the placer, not a rearrange, not a recompile. It used to say
                "fissati: 2 sul rame", which explains nothing, and when it went
                to zero the whole row vanished, so the concept never got learned.
              */}
              {mode === "move" && (
                <span
                  className="text-[11px] text-muted"
                  title={
                    counts.pcb > 0
                      ? `${counts.pcb} pezzi tenuti fermi da te (segnati con una × sulla scheda): nessuna azione automatica li muove. Clicca la × per lasciarne andare uno.${counts.pcbAuto > 0 ? ` Altri ${counts.pcbAuto} sono stati messi dal programma e possono essere rimossi.` : ""}`
                      : "nessun pezzo tenuto fermo: una disposizione automatica puo' muovere tutto"
                  }
                >
                  {counts.pcb > 0 ? `${counts.pcb} fermi` : "niente fermo"}
                  {counts.pcbAuto > 0 ? ` · ${counts.pcbAuto} auto` : ""}
                </span>
              )}
              {counts.pcb + counts.schematic + counts.traceHints > 0 && mode !== "move" && (
                <span className="font-mono text-[10px] text-[#5F726C]">
                  {describe(counts)}
                </span>
              )}
              {counts.pcb + counts.schematic + counts.traceHints > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    // two steps for something that throws away the work of all the pinned parts
                    if (!confirmRelease) {
                      setConfirmRelease(true);
                      setTimeout(() => setConfirmRelease(false), 3000);
                      return;
                    }
                    setConfirmRelease(false);
                    void editor.release("all", null);
                  }}
                  disabled={busy}
                  title="Lascia andare tutto: le posizioni tenute a mano vengono buttate e alla prossima disposizione automatica i pezzi si muovono"
                  className={`text-[11px] underline decoration-dotted underline-offset-2 transition-colors ${
                    confirmRelease ? "text-danger" : "text-muted hover:text-text"
                  }`}
                >
                  {confirmRelease ? "sicuro?" : "libera"}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function describe(counts: {
  schematic: number;
  pcb: number;
  traceHints: number;
}): string {
  const parts: string[] = [];
  if (counts.schematic) parts.push(`${counts.schematic} sullo schema`);
  if (counts.pcb) parts.push(`${counts.pcb} sul rame`);
  if (counts.traceHints) parts.push(`${counts.traceHints} piste a mano`);
  return parts.length > 0 ? `tenuti fermi a mano: ${parts.join(" \u00b7 ")}` : "";
}

function Segment({
  active,
  onClick,
  title,
  label,
  disabled = false,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={`rounded-[8px] px-3 py-[7px] text-[12px] transition-colors ${
        disabled
          ? "cursor-not-allowed text-[#4A5A56]"
          : active
            ? "bg-brand-wash font-semibold text-brand shadow-[inset_0_0_0_1px_#2C4C42]"
            : "text-[#7D8F8A] hover:text-text"
      }`}
    >
      {label}
    </button>
  );
}

function Icon({
  onClick,
  disabled,
  title,
  children,
}: {
  onClick: () => void;
  disabled: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="grid h-[30px] w-[30px] place-items-center rounded-[8px] text-[#7D8F8A] transition-colors hover:text-text disabled:text-[#33403C]"
    >
      <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4">
        {children}
      </svg>
    </button>
  );
}
