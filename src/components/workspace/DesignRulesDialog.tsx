"use client";

import { useEffect, useState } from "react";
import type { DesignRules } from "@/lib/design-rules";

/**
 * Board fabrication rules.
 *
 * They used to be one constant shared by every project: routing and checks
 * always ran against the standard JLCPCB minimums, even when ordering
 * elsewhere. Here you pick the supplier (or write your own minimums) and the
 * choice lives in the project.
 *
 * Changing the rules changes the COPPER, not just the check: the router plans
 * traces and vias against those minimums. That is why the panel states clearly
 * that a recompile is needed, instead of making it look like a display
 * preference.
 */

interface Preset {
  key: string;
  label: string;
  costTier: number;
  rules: DesignRules;
}

interface Current {
  preset: string;
  label: string;
  isCustom: boolean;
  rules: DesignRules;
}

const FIELDS: Array<{ key: keyof DesignRules; label: string; hint: string }> = [
  { key: "minTraceWidthMm", label: "Pista minima", hint: "la pista piu' sottile che il fornitore incide" },
  { key: "minClearanceMm", label: "Distanza minima", hint: "rame-rame fra net diverse" },
  { key: "minBoardEdgeClearanceMm", label: "Margine dal bordo", hint: "quanto il rame sta lontano dal taglio" },
  { key: "minViaHoleMm", label: "Foro via minimo", hint: "diametro della punta piu' piccola" },
  { key: "minViaDiameterMm", label: "Pad via minimo", hint: "corona attorno al foro" },
];

export function DesignRulesDialog({
  projectId,
  onClose,
  onSaved,
}: {
  projectId: string;
  onClose: () => void;
  /** called after saving: it is up to the caller to decide whether to recompile */
  onSaved: () => void;
}) {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [current, setCurrent] = useState<Current | null>(null);
  const [choice, setChoice] = useState<string>("");
  const [custom, setCustom] = useState<DesignRules | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/design-rules?projectId=${encodeURIComponent(projectId)}`)
      .then((r) => r.json())
      .then((d) => {
        if (!d?.current) return;
        setPresets(d.presets ?? []);
        setCurrent(d.current);
        setChoice(d.current.preset);
        setCustom(d.current.rules);
      })
      .catch(() => setError("non riesco a leggere le regole del progetto"));
  }, [projectId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/design-rules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId,
          preset: choice,
          ...(choice === "custom" ? { rules: custom } : {}),
        }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const changed =
    current !== null &&
    (choice !== current.preset ||
      (choice === "custom" &&
        JSON.stringify(custom) !== JSON.stringify(current.rules)));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(4,7,6,0.7)] backdrop-blur-[2px]">
      <div className="card w-[520px] max-w-[92vw] p-5">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-bold text-text">Regole di fabbricazione</h2>
            <p className="mt-1 text-[12px] leading-relaxed text-muted">
              Valgono per questa scheda. Non sono solo un controllo: il router pianifica
              piste e via su questi minimi, quindi cambiarle cambia il rame.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            title="Chiudi"
            className="flex-none text-faint transition-colors hover:text-text"
          >
            <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="mt-4 space-y-1.5">
          {presets.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => {
                setChoice(p.key);
                setCustom(p.rules);
              }}
              className={`flex w-full items-center gap-3 rounded-[10px] border px-3.5 py-2.5 text-left transition-colors ${
                choice === p.key
                  ? "border-brand bg-brand-wash"
                  : "border-line hover:border-[#3A5A50]"
              }`}
            >
              <span className="flex-1 text-[13px] font-semibold text-text">{p.label}</span>
              <span className="font-mono text-[10px] text-faint">
                pista {p.rules.minTraceWidthMm} · via {p.rules.minViaHoleMm}
              </span>
              <span className="font-mono text-[10px] text-[#5F726C]">
                {"€".repeat(p.costTier)}
              </span>
            </button>
          ))}
          <button
            type="button"
            onClick={() => setChoice("custom")}
            className={`flex w-full items-center rounded-[10px] border px-3.5 py-2.5 text-left transition-colors ${
              choice === "custom" ? "border-brand bg-brand-wash" : "border-line hover:border-[#3A5A50]"
            }`}
          >
            <span className="flex-1 text-[13px] font-semibold text-text">
              Minimi del mio fornitore
            </span>
            <span className="text-[11px] text-faint">valori a mano</span>
          </button>
        </div>

        {choice === "custom" && custom && (
          <div className="mt-3 space-y-2 rounded-[10px] border border-line p-3">
            {FIELDS.map((f) => (
              <label key={f.key} className="flex items-center gap-3">
                <span className="min-w-0 flex-1">
                  <span className="block text-[12px] text-text">{f.label}</span>
                  <span className="block text-[10px] text-faint">{f.hint}</span>
                </span>
                <input
                  type="number"
                  step="0.001"
                  min="0.05"
                  value={custom[f.key]}
                  onChange={(e) =>
                    setCustom({ ...custom, [f.key]: Number(e.target.value) })
                  }
                  className="w-[86px] rounded-[7px] border border-line bg-sunken px-2 py-1 text-right font-mono text-[12px] text-text outline-none focus:border-brand"
                />
                <span className="w-5 font-mono text-[10px] text-faint">mm</span>
              </label>
            ))}
          </div>
        )}

        {error && <p className="mt-3 text-[11px] text-danger">{error}</p>}

        <div className="mt-4 flex items-center gap-2">
          <span className="flex-1 text-[11px] text-faint">
            {changed
              ? "Dopo il salvataggio serve ricompilare per rifare il rame."
              : "Nessuna modifica."}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-[8px] px-3 py-[7px] text-[12px] text-muted transition-colors hover:text-text"
          >
            Annulla
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={!changed || busy}
            className={`rounded-[8px] px-3.5 py-[7px] text-[12px] font-semibold transition-colors ${
              changed && !busy ? "bg-brand text-ink hover:bg-brand-strong" : "bg-sunken text-faint"
            }`}
          >
            {busy ? "Salvo..." : "Salva"}
          </button>
        </div>
      </div>
    </div>
  );
}
