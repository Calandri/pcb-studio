"use client";

import { useState } from "react";
import {
  BOARD_LAYERS,
  LAYER_LABELS,
  VIEW_PRESETS,
  type ViewFlags,
  type ViewPreset,
} from "./ViewPresets";

/**
 * Controlli di visualizzazione in stile "livelli di una mappa": si sceglie
 * cosa si sta guardando in base al COMPITO (montaggio, interferenze, rame...),
 * e solo chi vuole entra nel dettaglio dei singoli livelli.
 */
export function ViewControls({
  preset,
  flags,
  layer,
  onPreset,
  onFlag,
  onLayer,
}: {
  preset: string;
  flags: ViewFlags;
  layer: string;
  onPreset: (p: ViewPreset) => void;
  onFlag: (key: keyof ViewFlags, value: boolean) => void;
  onLayer: (layer: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [details, setDetails] = useState(false);
  const current = VIEW_PRESETS.find((p) => p.key === preset);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          background: "rgba(28, 34, 43, 0.92)",
          border: "1px solid rgba(255,255,255,0.14)",
          color: "#e8edf2",
        }}
        className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-[11px] font-semibold shadow-sm transition-transform hover:-translate-y-px"
        title="Scegli cosa vedere della scheda"
      >
        <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5">
          <path
            d="M8 2 14 5 8 8 2 5 8 2ZM2 8l6 3 6-3M2 11l6 3 6-3"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinejoin="round"
          />
        </svg>
        {current?.label ?? "Viste"}
        <svg viewBox="0 0 12 12" fill="none" className="h-2.5 w-2.5 opacity-70">
          <path d="M2.5 4.5 6 8l3.5-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full left-0 z-30 mb-2 max-h-[68vh] w-[268px] overflow-y-auto rounded-xl border border-line bg-surface shadow-[0_16px_40px_-12px_rgba(16,24,40,0.35)]">
            <div className="border-b border-line px-3 py-2.5">
              <p className="text-[11px] font-bold uppercase tracking-wider text-faint">
                Cosa stai guardando
              </p>
            </div>

            <div className="grid grid-cols-2 gap-1.5 p-2">
              {VIEW_PRESETS.map((p) => {
                const active = p.key === preset;
                return (
                  <button
                    key={p.key}
                    type="button"
                    onClick={() => onPreset(p)}
                    className={`rounded-lg border px-2.5 py-2 text-left transition-all ${
                      active
                        ? "border-brand bg-brand-wash"
                        : "border-line hover:border-line-strong hover:bg-sunken"
                    }`}
                  >
                    <PresetThumb preset={p.key} active={active} />
                    <p
                      className={`mt-1.5 text-xs font-semibold ${
                        active ? "text-brand-strong" : "text-text"
                      }`}
                    >
                      {p.label}
                    </p>
                  </button>
                );
              })}
            </div>

            {current && (
              <p className="border-t border-line bg-sunken px-3 py-2.5 text-[11px] leading-relaxed text-muted">
                {current.description}
              </p>
            )}

            <div className="border-t border-line px-3 py-2.5">
              <p className="mb-2 text-[11px] font-bold uppercase tracking-wider text-faint">
                Lato della scheda
              </p>
              <div className="flex gap-1">
                {BOARD_LAYERS.map((l) => (
                  <button
                    key={l.key}
                    type="button"
                    onClick={() => onLayer(l.key)}
                    className={`flex-1 rounded-md px-2 py-1.5 text-[11px] font-medium transition-colors ${
                      layer === l.key
                        ? "bg-brand text-white"
                        : "bg-sunken text-muted hover:text-text"
                    }`}
                  >
                    {l.label}
                  </button>
                ))}
              </div>
            </div>

            <button
              type="button"
              onClick={() => setDetails((v) => !v)}
              className="flex w-full items-center justify-between border-t border-line px-3 py-2.5 text-[11px] font-medium text-muted transition-colors hover:bg-sunken"
            >
              Livelli singoli
              <span className="text-faint">{details ? "nascondi" : "mostra"}</span>
            </button>

            {details && (
              <ul className="max-h-64 space-y-0.5 overflow-y-auto border-t border-line p-2">
                {LAYER_LABELS.map((l) => (
                  <li key={l.key}>
                    <label className="flex cursor-pointer items-start gap-2.5 rounded-lg px-2 py-1.5 hover:bg-sunken">
                      <Switch
                        checked={flags[l.key]}
                        onChange={(v) => onFlag(l.key, v)}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-xs font-medium text-text">{l.label}</span>
                        <span className="block text-[11px] leading-relaxed text-faint">
                          {l.hint}
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
                <li className="px-2 pt-1">
                  <p className="rounded-lg bg-accent-wash px-2.5 py-2 text-[11px] leading-relaxed text-accent">
                    La <strong>paste mask</strong> (le aperture per la pasta salda) non è
                    disegnabile da questo viewer, ma è presente nei file di produzione:
                    la trovi come <code className="font-mono">F_Paste.gbr</code> dentro
                    gerber.zip.
                  </p>
                </li>
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Switch({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`mt-0.5 h-4 w-7 flex-none rounded-full p-0.5 transition-colors ${
        checked ? "bg-brand" : "bg-line-strong"
      }`}
    >
      <span
        className={`block h-3 w-3 rounded-full bg-white shadow-sm transition-transform ${
          checked ? "translate-x-3" : ""
        }`}
      />
    </button>
  );
}

/** miniatura schematica del preset: si capisce a colpo d'occhio cosa cambia */
function PresetThumb({ preset, active }: { preset: string; active: boolean }) {
  const stroke = active ? "#0b7d5e" : "#9aa3b5";
  const fill = active ? "#e8f7f2" : "#f4f6f8";
  return (
    <svg viewBox="0 0 60 30" className="h-7 w-full rounded" style={{ background: fill }}>
      {preset === "assembly" && (
        <>
          <rect x="8" y="9" width="14" height="12" rx="1" fill="none" stroke={stroke} strokeWidth="1.2" />
          <rect x="34" y="9" width="10" height="12" rx="1" fill="none" stroke={stroke} strokeWidth="1.2" />
          <path d="M10 6h8M36 6h6" stroke={stroke} strokeWidth="1.2" strokeLinecap="round" />
        </>
      )}
      {preset === "copper" && (
        <>
          <path d="M6 15h14l6-7h12l6 7h10" stroke={stroke} strokeWidth="2" fill="none" strokeLinecap="round" />
          <path d="M6 22h20l5 4h23" stroke={stroke} strokeWidth="1.4" fill="none" strokeLinecap="round" />
        </>
      )}
      {preset === "interference" && (
        <>
          <rect x="10" y="8" width="18" height="14" rx="1" fill="none" stroke={stroke} strokeWidth="1.2" strokeDasharray="2 2" />
          <rect x="24" y="12" width="18" height="14" rx="1" fill="none" stroke="#d94a4a" strokeWidth="1.4" strokeDasharray="2 2" />
        </>
      )}
      {preset === "connections" && (
        <>
          <circle cx="12" cy="10" r="2" fill={stroke} />
          <circle cx="46" cy="20" r="2" fill={stroke} />
          <circle cx="30" cy="8" r="2" fill={stroke} />
          <path d="M12 10 46 20M30 8 46 20" stroke={stroke} strokeWidth="1" strokeDasharray="3 2" />
        </>
      )}
      {preset === "fabrication" && (
        <>
          <rect x="8" y="7" width="44" height="16" rx="1" fill="none" stroke={stroke} strokeWidth="1.2" />
          <path d="M8 27h44M8 25v4M52 25v4" stroke={stroke} strokeWidth="1" strokeLinecap="round" />
        </>
      )}
      {preset === "everything" && (
        <>
          <rect x="8" y="8" width="16" height="12" rx="1" fill="none" stroke={stroke} strokeWidth="1.2" />
          <path d="M24 14h12l4-5h12" stroke={stroke} strokeWidth="1.4" fill="none" />
          <circle cx="46" cy="20" r="2" fill="#d94a4a" />
          <path d="M8 24h44" stroke={stroke} strokeWidth="0.8" strokeDasharray="2 2" />
        </>
      )}
    </svg>
  );
}
