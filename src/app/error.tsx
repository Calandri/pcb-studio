"use client";

import Link from "next/link";
import { useEffect } from "react";

/**
 * Last line for a page that threw while rendering. Without it Next showed its
 * own blank error screen, in English, with no way back but the reload button
 * of the browser. The canvases have their own boundary (ViewerBoundary): this
 * one is for what is left.
 */
export default function ErrorPage({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-canvas p-6 text-text">
      <div className="w-[min(460px,100%)] rounded-[14px] border border-line bg-surface px-5 py-5">
        <h2 className="text-[15px] font-semibold">Qualcosa si è rotto in questa pagina</h2>
        <p className="mt-2 text-[12.5px] leading-relaxed text-muted">
          Il progetto salvato non è stato toccato. Riprova: se il problema torna, segnalalo con
          il pulsante Feedback in basso a sinistra.
        </p>
        {error.digest && (
          <p className="mt-2 font-mono text-[10.5px] text-faint">codice {error.digest}</p>
        )}
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={() => unstable_retry()}
            className="rounded-lg bg-brand px-3.5 py-2 text-[12.5px] font-semibold text-ink transition-colors hover:bg-brand-strong"
          >
            Riprova
          </button>
          <Link
            href="/projects"
            className="rounded-lg border border-line-strong px-3.5 py-2 text-[12.5px] text-muted transition-colors hover:text-text"
          >
            Torna ai progetti
          </Link>
        </div>
      </div>
    </div>
  );
}
