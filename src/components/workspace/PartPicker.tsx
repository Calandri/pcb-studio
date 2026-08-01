"use client";

import { useMemo, useState } from "react";
import type { InspectComponent } from "@/lib/inspect";

/**
 * Component search above the board. The tscircuit viewer doesn't expose
 * hover or selection events on the canvas, so the component is picked from
 * here instead of by hovering over it with the mouse: the card that opens
 * is the same.
 */
export function PartPicker({
  parts,
  selected,
  onSelect,
}: {
  parts: InspectComponent[];
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? parts.filter(
          (p) =>
            p.name.toLowerCase().includes(q) ||
            (p.value ?? "").toLowerCase().includes(q) ||
            (p.supplier ?? "").toLowerCase().includes(q) ||
            (p.footprint ?? "").toLowerCase().includes(q),
        )
      : parts;
    return list.slice(0, 60);
  }, [parts, query]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="absolute top-[18px] right-[18px] flex items-center gap-2 rounded-[10px] border border-[#1F2C29] bg-[rgba(11,17,16,0.9)] px-3 py-2 text-[11px] text-[#B9CAC5] backdrop-blur transition-colors hover:border-[#3A5A50]"
      >
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none">
          <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.4" />
          <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
        Cerca componente
      </button>
    );
  }

  return (
    <div className="absolute top-[18px] right-[18px] flex max-h-[60%] w-[268px] flex-col overflow-hidden rounded-[12px] border border-[#1F2C29] bg-[rgba(9,14,13,0.95)] backdrop-blur">
      <div className="flex flex-none items-center gap-2 border-b border-line px-3 py-2">
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Sigla, valore, codice..."
          className="min-w-0 flex-1 bg-transparent text-[12px] text-text outline-none placeholder:text-faint"
        />
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setQuery("");
          }}
          title="Chiudi la ricerca"
          className="text-faint transition-colors hover:text-text"
        >
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto py-1">
        {results.length === 0 && (
          <p className="px-3 py-3 text-[11px] text-faint">Nessun componente trovato.</p>
        )}
        {results.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onSelect(p.id === selected ? null : p.id)}
            className={`flex w-full items-baseline gap-2 px-3 py-1.5 text-left transition-colors hover:bg-[#141E1B] ${
              p.id === selected ? "bg-brand-wash" : ""
            }`}
          >
            <span
              className={`font-mono text-[12px] ${p.id === selected ? "text-brand" : "text-text"}`}
            >
              {p.name}
            </span>
            <span className="min-w-0 flex-1 truncate text-[11px] text-faint">
              {[p.value, p.footprint].filter(Boolean).join(" · ")}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
