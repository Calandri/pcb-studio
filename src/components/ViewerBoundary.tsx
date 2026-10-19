"use client";

import type { ReactNode } from "react";
import { ErrorBoundary, type FallbackProps } from "react-error-boundary";

/**
 * A view that cannot draw the board must not take the studio down with it.
 *
 * The canvases build their whole model from the Circuit JSON while rendering
 * (buildScene, buildSchematicModel, the tscircuit viewers): an element shaped
 * in a way nobody expected — an imported board, an older compiler — throws,
 * and with no boundary anywhere React unmounted the entire page, chat and
 * pending edits included. Here only the view goes, with the way back: retry,
 * or recompile, which produces a new circuit and resets the boundary by itself.
 */
export function ViewerBoundary({
  label,
  resetKeys,
  onRecompile,
  children,
}: {
  /** what failed, in the person's words: "lo sbroglio", "lo schematico"... */
  label: string;
  /** when one of these changes (a new circuit) the view tries again by itself */
  resetKeys?: unknown[];
  onRecompile?: () => void;
  children: ReactNode;
}) {
  return (
    <ErrorBoundary
      resetKeys={resetKeys}
      onError={(error) => console.error(`vista non disegnata (${label}):`, error)}
      fallbackRender={(props) => (
        <ViewerFallback {...props} label={label} onRecompile={onRecompile} />
      )}
    >
      {children}
    </ErrorBoundary>
  );
}

function ViewerFallback({
  error,
  resetErrorBoundary,
  label,
  onRecompile,
}: FallbackProps & { label: string; onRecompile?: () => void }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="flex h-full w-full items-center justify-center p-6">
      <div className="w-[min(440px,100%)] rounded-[14px] border border-[#4A2A26] bg-[rgba(22,15,15,0.94)] px-5 py-4 shadow-[0_18px_60px_rgba(0,0,0,0.5)]">
        <div className="text-[13px] font-semibold text-danger">
          Non riesco a disegnare {label}
        </div>
        <p className="mt-1.5 text-[12px] leading-relaxed text-muted">
          La scheda salvata contiene qualcosa che questa vista non sa leggere. Il resto dello
          studio funziona e le modifiche non applicate sono ancora qui.
        </p>
        <p className="mt-2 truncate font-mono text-[10.5px] text-faint" title={message}>
          {message}
        </p>
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={resetErrorBoundary}
            className="rounded-lg border border-line-strong px-3 py-1.5 text-[12px] text-muted transition-colors hover:text-text"
          >
            Riprova
          </button>
          {onRecompile && (
            <button
              type="button"
              onClick={onRecompile}
              title="Rilegge i file e rifà la scheda: la vista riparte da sola quando arriva"
              className="rounded-lg bg-brand px-3 py-1.5 text-[12px] font-semibold text-ink transition-colors hover:bg-brand-strong"
            >
              Ricompila
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
