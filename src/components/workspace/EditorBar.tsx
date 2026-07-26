"use client";

import { useEffect } from "react";
import type { ManualEditor } from "./useManualEditor";

/**
 * Comandi dell'editor manuale, sopra il canvas.
 *
 * Sta sopra la scheda e non in una colonna laterale perche' e' una barra
 * modale: cambia cosa fa il mouse. Mentre e' in "sposta" o "instrada" resta
 * accesa e visibile, cosi' non si trascina un componente credendo di
 * spostare la vista.
 */
export function EditorBar({
  editor,
  scope,
}: {
  editor: ManualEditor;
  /** sullo schematico si sposta e basta: le piste sono un fatto del rame */
  scope: "schematic" | "pcb";
}) {
  const { mode, setMode, counts, busy, canUndo, canRedo, error, dirty, links, unlinks } =
    editor;

  // scorciatoie da tastiera: senza queste "annulla" non e' annulla
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
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
      if (e.key.toLowerCase() === "r" && !meta && scope === "pcb") {
        setMode(mode === "route" ? "view" : "route");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editor, mode, setMode, scope]);

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
          title={
            scope === "schematic"
              ? "Trascina i simboli dove li vuoi (M)"
              : "Trascina i componenti sul rame (M)"
          }
          label="Sposta"
        />
        {scope === "schematic" && (
          <Segment
            active={mode === "link"}
            onClick={() => setMode("link")}
            title="Clicca due piedini per collegarli, clicca un filo per toglierlo (C)"
            label="Collega"
          />
        )}
        {scope === "pcb" && (
          <Segment
            active={mode === "route"}
            onClick={() => setMode("route")}
            title="Parti da un pad e disegna il percorso della pista (R)"
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

      {(counts.total > 0 || error || mode !== "view") && (
        <div className="flex items-center gap-2 rounded-[10px] border border-[#1F2C29] bg-[rgba(9,14,13,0.9)] px-3 py-1.5 backdrop-blur">
          {error ? (
            <span className="text-[11px] text-danger">{error}</span>
          ) : (
            <>
              {mode !== "view" && (
                <span className="text-[11px] text-brand">
                  {mode === "move"
                    ? "Trascina un componente per spostarlo"
                    : mode === "link"
                      ? "Clicca due piedini per collegarli"
                      : "Clicca un pad, poi clicca dove far passare la pista"}
                </span>
              )}
              {(links.length > 0 || unlinks.length > 0) && (
                <span className="font-mono text-[10px] text-[#5F726C]">
                  {links.length > 0 ? `+${links.length} collegamenti` : ""}
                  {links.length > 0 && unlinks.length > 0 ? " · " : ""}
                  {unlinks.length > 0 ? `-${unlinks.length} tolti` : ""}
                </span>
              )}
              {counts.total > 0 && (
                <span className="font-mono text-[10px] text-[#5F726C]">
                  {describe(counts)}
                </span>
              )}
              {counts.total > 0 && (
                <button
                  type="button"
                  onClick={() => void editor.release("all", null)}
                  disabled={busy}
                  title="Tutti i componenti tornano al posizionamento automatico"
                  className="text-[11px] text-muted underline decoration-dotted underline-offset-2 transition-colors hover:text-text"
                >
                  sblocca tutto
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
  return `fissati: ${parts.join(" · ")}`;
}

function Segment({
  active,
  onClick,
  title,
  label,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`rounded-[8px] px-3 py-[7px] text-[12px] transition-colors ${
        active
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
