"use client";

import { useCallback, useState } from "react";

type State = "idle" | "loading" | "done" | "error";

/**
 * "Completa con Claude": copies the full project briefing to the clipboard
 * (instructions, compilation status, issues, positions and code), ready
 * to paste into a more capable external agent.
 */
export function HandoffButton({
  projectId,
  variant = "solid",
  compact = false,
}: {
  projectId: string;
  variant?: "solid" | "overlay";
  /** space is tight in the viewer bar: icon only, text in the tooltip */
  compact?: boolean;
}) {
  const [state, setState] = useState<State>("idle");

  const copy = useCallback(async () => {
    setState("loading");
    try {
      const res = await fetch(`/api/handoff?projectId=${projectId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const briefing = await res.text();
      await navigator.clipboard.writeText(briefing);
      setState("done");
      setTimeout(() => setState("idle"), 2600);
    } catch {
      setState("error");
      setTimeout(() => setState("idle"), 2600);
    }
  }, [projectId]);

  const label =
    state === "loading"
      ? "Preparo..."
      : state === "done"
        ? "Copiato! Incollalo in Claude"
        : state === "error"
          ? "Non riuscito"
          : "Completa con Claude";

  const base =
    "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-semibold transition-all disabled:opacity-60";
  const skins = {
    solid:
      "bg-brand text-ink shadow-sm hover:bg-brand-strong hover:-translate-y-px",
    overlay: "shadow-sm hover:-translate-y-px",
  } as const;

  return (
    <button
      type="button"
      onClick={copy}
      disabled={state === "loading"}
      title="Copia progetto, problemi e istruzioni: incollali in Claude per farti aiutare"
      className={`${base} ${skins[variant]} ${compact ? "px-2" : ""}`}
      style={
        variant === "overlay"
          ? {
              background: state === "done" ? "#0f9d76" : "rgba(28, 34, 43, 0.92)",
              border: "1px solid rgba(255,255,255,0.14)",
              color: "#e8edf2",
            }
          : undefined
      }
    >
      <Robot done={state === "done"} />
      {compact ? (state === "done" ? "Copiato" : "") : label}
    </button>
  );
}

function Robot({ done }: { done: boolean }) {
  if (done) {
    return (
      <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5">
        <path
          d="M3.5 8.5 6.5 11.5 12.5 5"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5">
      <rect x="2.8" y="5.4" width="10.4" height="7.4" rx="2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 5.4V3.2M8 2.6a.7.7 0 1 0 0 .1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="6" cy="8.6" r="0.9" fill="currentColor" />
      <circle cx="10" cy="8.6" r="0.9" fill="currentColor" />
      <path d="M6.2 11h3.6M1.4 8.4v1.8M14.6 8.4v1.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
