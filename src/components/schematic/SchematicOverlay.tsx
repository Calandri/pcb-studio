"use client";

import { forwardRef, useState } from "react";
import type { SearchResult, SectionEntry, TargetInfo } from "@/lib/schematic-interaction";
import { HIGHLIGHT_COLOR } from "@/lib/schematic-interaction";

/**
 * The commands floating over the schematic: search, selection card, zoom and
 * sections. Only presentation: the state lives in SchematicCanvas.
 *
 * Colors come from the theme variables (bg-surface, text-text, border-line),
 * not from fixed hex values, so the panels follow the app's theme. Every text
 * from the circuit or typed by the user is a React text child: escaped.
 */

const PANEL =
  "rounded-[10px] border border-line-strong bg-surface/95 text-text shadow-[var(--shadow-float)] backdrop-blur";
const BUTTON =
  "inline-flex h-7 min-w-7 items-center justify-center rounded-[7px] border border-line-strong bg-surface/95 px-2 text-[11.5px] text-muted transition-colors hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand";
const KBD = "rounded border border-line px-1 font-mono text-[10px] text-faint";

export const SearchBox = forwardRef<
  HTMLInputElement,
  {
    query: string;
    onQuery: (q: string) => void;
    results: SearchResult[];
    /** index of the result on screen, -1 before the first Enter */
    cursor: number;
    onGo: (i: number) => void;
    onStep: (delta: 1 | -1) => void;
    onClose: () => void;
    maxQuery: number;
    limit: number;
  }
>(function SearchBox({ query, onQuery, results, cursor, onGo, onStep, onClose, maxQuery, limit }, ref) {
  const [focused, setFocused] = useState(false);
  const has = query.trim().length > 0;
  return (
    <div className={`${PANEL} w-[300px] max-w-[calc(100vw-48px)]`}>
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 flex-none text-faint" fill="none" aria-hidden>
          <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
          <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <input
          ref={ref}
          value={query}
          maxLength={maxQuery}
          onChange={(e) => onQuery(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              onStep(e.key === "ArrowUp" || (e.key === "Enter" && e.shiftKey) ? -1 : 1);
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              if (query) onQuery("");
              else onClose();
            }
          }}
          placeholder="Cerca pezzo, rete o valore"
          aria-label="Cerca nello schematico per designatore, rete o valore"
          spellCheck={false}
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-text outline-none placeholder:font-sans placeholder:text-faint"
        />
        {has ? (
          <span className="flex-none font-mono text-[10.5px] text-faint">
            {results.length === 0
              ? "0"
              : `${cursor >= 0 ? cursor + 1 : "–"}/${results.length}${results.length >= limit ? "+" : ""}`}
          </span>
        ) : (
          <span className={KBD}>/</span>
        )}
      </div>
      {has && focused && (
        <div className="max-h-[min(320px,45vh)] overflow-y-auto border-t border-line py-1" role="listbox">
          {results.length === 0 ? (
            <div className="px-3 py-2 text-[11.5px] text-faint">Niente con questo nome sul foglio.</div>
          ) : (
            results.map((r, i) => (
              <button
                key={`${r.kind}-${r.label}-${i}`}
                type="button"
                role="option"
                aria-selected={i === cursor}
                // mousedown, not click: the input must not lose focus first
                onMouseDown={(e) => {
                  e.preventDefault();
                  onGo(i);
                }}
                className={`flex w-full items-baseline gap-2 px-3 py-1 text-left transition-colors hover:bg-raised ${
                  i === cursor ? "bg-raised" : ""
                }`}
              >
                <span className="w-9 flex-none text-[9.5px] uppercase tracking-wide text-faint">{r.kind}</span>
                <span className="flex-none font-mono text-[12px] text-brand">{r.label}</span>
                <span className="min-w-0 truncate text-[11px] text-muted">{r.detail}</span>
              </button>
            ))
          )}
          {results.length > 0 && (
            <div className="px-3 pb-1 pt-1.5 text-[10.5px] text-faint">
              <span className={KBD}>Invio</span> il successivo · <span className={KBD}>⇧ Invio</span> il
              precedente · <span className={KBD}>Esc</span> chiude
            </div>
          )}
        </div>
      )}
    </div>
  );
});

export function SelectionCard({
  info,
  onNet,
  onPart,
  onFrame,
  onClear,
  onCopyLink,
  copied,
}: {
  info: TargetInfo;
  onNet: (net: string) => void;
  onPart: (name: string) => void;
  onFrame: () => void;
  onClear: () => void;
  onCopyLink: () => void;
  copied: boolean;
}) {
  const [allParts, setAllParts] = useState(false);
  const parts = allParts ? info.parts : info.parts.slice(0, 18);
  return (
    <div className={`${PANEL} w-[300px] max-w-[calc(100vw-48px)] px-3 py-2.5`}>
      <div className="flex items-center gap-2">
        <span className="h-2 w-2 flex-none rounded-full" style={{ background: HIGHLIGHT_COLOR }} aria-hidden />
        <span className="text-[9.5px] uppercase tracking-wide text-faint">{info.kind}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[13px] font-semibold text-text">{info.title}</span>
        <button type="button" onClick={onClear} title="Togli la selezione (Esc)" className="-mr-1 text-faint hover:text-text">
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" aria-hidden>
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <span className="sr-only">Togli la selezione</span>
        </button>
      </div>
      <div className="mt-1 flex flex-col gap-0.5">
        {info.lines.map((l, i) => (
          <div key={i} className="text-[11.5px] leading-snug text-muted">
            {l}
          </div>
        ))}
      </div>
      {info.nets.length > 0 && (
        <div className="mt-2 flex max-h-[148px] flex-wrap gap-1 overflow-y-auto">
          {info.nets.map((n) => (
            <button
              key={n.name}
              type="button"
              onClick={() => onNet(n.name)}
              title={
                n.rail
                  ? `${n.name}: ${n.pins} piedini, e' un'alimentazione o la massa: accesa solo vicino al pezzo. Clicca per vederla tutta`
                  : `${n.name}: ${n.pins} piedini`
              }
              className={`rounded-[6px] border px-1.5 py-px font-mono text-[10.5px] transition-colors hover:text-text ${
                n.rail ? "border-line text-faint" : "border-line-strong text-muted"
              }`}
            >
              {n.name}
              <span className="ml-1 text-faint">{n.pins}</span>
            </button>
          ))}
        </div>
      )}
      {info.net && info.kind === "piedino" && (
        <button
          type="button"
          onClick={() => onNet(info.net!)}
          className="mt-2 rounded-[6px] border border-line-strong px-1.5 py-px font-mono text-[10.5px] text-muted hover:text-text"
        >
          tutta la rete {info.net}
        </button>
      )}
      {parts.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1">
          <span className="text-[10.5px] text-faint">pezzi</span>
          {parts.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => onPart(p)}
              className="rounded px-1 font-mono text-[10.5px] text-brand hover:bg-raised"
            >
              {p}
            </button>
          ))}
          {!allParts && info.parts.length > parts.length && (
            <button type="button" onClick={() => setAllParts(true)} className="px-1 text-[10.5px] text-faint hover:text-text">
              +{info.parts.length - parts.length}
            </button>
          )}
        </div>
      )}
      <div className="mt-2.5 flex items-center gap-1.5">
        <button type="button" onClick={onFrame} className={BUTTON}>
          Inquadra
        </button>
        <button type="button" onClick={onCopyLink} className={BUTTON} title="Il link apre lo schematico con questa selezione">
          {copied ? "Link copiato" : "Copia link"}
        </button>
        <span className="flex-1" />
        <span className="text-[10.5px] text-faint">
          <span className={KBD}>Esc</span> toglie
        </span>
      </div>
    </div>
  );
}

export function ViewControls({
  onZoomIn,
  onZoomOut,
  onFit,
  sections,
  onSection,
}: {
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  sections: SectionEntry[];
  onSection: (s: SectionEntry) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-1">
        <button type="button" onClick={onZoomOut} className={BUTTON} title="Allontana (-)" aria-label="Allontana">
          −
        </button>
        <button type="button" onClick={onZoomIn} className={BUTTON} title="Avvicina (+)" aria-label="Avvicina">
          +
        </button>
        <button type="button" onClick={onFit} className={BUTTON} title="Tutto il foglio (F)">
          Adatta <span className={`${KBD} ml-1.5`}>F</span>
        </button>
        {sections.length > 0 && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className={`${BUTTON} ${open ? "text-text" : ""}`}
          >
            Sezioni <span className="ml-1 font-mono text-faint">{sections.length}</span>
          </button>
        )}
      </div>
      {open && sections.length > 0 && (
        <div className={`${PANEL} max-h-[min(360px,55vh)] w-[230px] overflow-y-auto py-1`}>
          {sections.map((s, i) => (
            <button
              key={`${s.title}-${i}`}
              type="button"
              onClick={() => onSection(s)}
              className="flex w-full items-center gap-2 px-3 py-1 text-left text-[12px] text-muted transition-colors hover:bg-raised hover:text-text"
            >
              <span className="font-mono text-[10px] text-faint">{String(i + 1).padStart(2, "0")}</span>
              <span className="min-w-0 truncate">{s.title}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** the card under the pointer: what the thing is, without clicking */
export const HoverCard = forwardRef<HTMLDivElement, { info: TargetInfo | null }>(function HoverCard({ info }, ref) {
  return (
    <div
      ref={ref}
      className={`pointer-events-none absolute left-0 top-0 z-10 max-w-[280px] ${PANEL} px-2.5 py-1.5 ${info ? "" : "hidden"}`}
    >
      {info && (
        <>
          <div className="flex items-baseline gap-2">
            <span className="text-[9px] uppercase tracking-wide text-faint">{info.kind}</span>
            <span className="font-mono text-[12px] font-semibold text-text">{info.title}</span>
          </div>
          {info.lines.map((l, i) => (
            <div key={i} className="text-[11px] leading-snug text-muted">
              {l}
            </div>
          ))}
        </>
      )}
    </div>
  );
});
