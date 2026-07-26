"use client";

import { useState } from "react";
import { estimateCost, type BoardReport, type Severity } from "@/lib/board-report";

const SEV_COLOR: Record<Severity, string> = {
  err: "#FF6B5A",
  warn: "#E8B23B",
  ok: "#3BE8B0",
};

export function RightRail({
  report,
  compiledAgo,
  onAsk,
  onShowOnBoard,
  onRecompile,
  recompiling,
}: {
  report: BoardReport;
  compiledAgo: string;
  onAsk: (prompt: string) => void;
  /** accende sulla scheda la vista che mostra quella verifica */
  onShowOnBoard: (preset: string) => void;
  onRecompile: () => void;
  recompiling: boolean;
}) {
  const cost = estimateCost(report);
  const [open, setOpen] = useState<string | null>(null);
  const [ignored, setIgnored] = useState<string[]>([]);
  const allPartsSourced =
    report.componentCount > 0 && report.partsWithSupplier === report.componentCount;

  return (
    <aside className="flex flex-col gap-[18px] overflow-auto border-l border-line bg-sunken px-3.5 py-4">
      <section className="flex flex-col gap-2.5">
        <div className="flex items-center justify-between">
          <div className="text-[10px] font-bold tracking-[0.11em] whitespace-nowrap text-faint">
            CONTROLLO AUTOMATICO
          </div>
          <button
            type="button"
            onClick={onRecompile}
            disabled={recompiling}
            title="Ricompila e risbroglia la scheda"
            className="flex min-w-0 items-center gap-1.5 font-mono text-[10px] whitespace-nowrap text-[#42544F] transition-colors hover:text-brand disabled:text-[#42544F]"
          >
            {recompiling ? (
              <>
                <span className="dot dot-busy" /> ricompilo...
              </>
            ) : (
              <>
                <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none">
                  <path
                    d="M13 8a5 5 0 1 1-1.46-3.54M13 2v3h-3"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span className="truncate">{compiledAgo}</span>
              </>
            )}
          </button>
        </div>
        <div className="flex gap-[7px]">
          <Counter value={report.errors} label="DA CORREGGERE" tone="err" />
          <Counter value={report.warnings} label="DA GUARDARE" tone="warn" />
          <Counter value={report.passed} label="OK" tone="ok" />
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <div className="text-[10px] font-bold tracking-[0.11em] text-faint">VERIFICHE</div>
          <div className="text-[10px] text-[#42544F]">passa sopra per vederle sulla scheda</div>
        </div>
        <div className="flex flex-col gap-1.5">
          {report.checks
            .filter((c) => !ignored.includes(c.id))
            .map((c) => {
              const expanded = open === c.id && c.severity !== "ok";
              return (
                <div
                  key={c.id}
                  onMouseEnter={() => onShowOnBoard(c.preset)}
                  className="flex flex-col gap-[5px] rounded-xl border px-3 py-[11px] transition-colors hover:border-[#3A5A50]"
                  style={{
                    background:
                      c.severity === "err"
                        ? "#160F0F"
                        : c.severity === "warn"
                          ? "#16130C"
                          : "#0D1614",
                    borderColor:
                      c.severity === "err"
                        ? "#3E1F1D"
                        : c.severity === "warn"
                          ? "#40331A"
                          : "#23423A",
                  }}
                >
                  <button
                    type="button"
                    onClick={() => setOpen(expanded ? null : c.id)}
                    className="flex flex-col gap-[5px] text-left"
                  >
                    <span className="flex items-center gap-[9px]">
                      <span
                        className="h-[7px] w-[7px] flex-none rounded-full"
                        style={{ background: SEV_COLOR[c.severity] }}
                      />
                      <span className="flex-1 text-[12.5px] font-semibold text-[#DCE7E3]">
                        {c.name}
                      </span>
                      <span
                        className="font-mono text-[10px] whitespace-nowrap"
                        style={{ color: SEV_COLOR[c.severity] }}
                      >
                        {c.count}
                      </span>
                    </span>
                    <span className="pl-4 text-[11px] leading-[1.4] break-words text-faint">
                      {c.detail}
                    </span>
                  </button>

                  {expanded && (
                    <div className="flex gap-1.5 pt-1 pl-4">
                      <button
                        type="button"
                        onClick={() =>
                          onAsk(`Risolvi il problema "${c.name}": ${c.detail}`)
                        }
                        className="rounded-lg border border-[#2C4C42] bg-brand-wash px-2.5 py-1.5 text-[11px] font-semibold text-brand transition-colors hover:bg-[#1D3229]"
                      >
                        Correggi in automatico
                      </button>
                      <button
                        type="button"
                        onClick={() => setIgnored((l) => [...l, c.id])}
                        title="Nascondi questa verifica fino alla prossima compilazione"
                        className="rounded-lg border border-line-strong px-2.5 py-1.5 text-[11px] text-muted transition-colors hover:text-text"
                      >
                        Ignora
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <div className="text-[10px] font-bold tracking-[0.11em] text-faint">
          PRIMA DI ORDINARE
        </div>
        <div className="flex flex-col gap-1.5">
          <PreflightRow
            ok={allPartsSourced}
            label="Componenti con codice fornitore"
            value={`${report.partsWithSupplier}/${report.componentCount}`}
          />
          <PreflightRow
            ok
            label="Struttura confermata"
            value={`${report.layerCount} strati · 1,6 mm`}
          />
          <PreflightRow
            ok={report.unrouted === 0}
            label={report.unrouted === 0 ? "Collegamenti completi" : "Collegamenti aperti"}
            value={report.unrouted === 0 ? `${report.traceCount} piste` : `${report.unrouted}`}
          />
        </div>
      </section>

      <div className="mt-auto flex flex-col gap-2.5 rounded-[13px] border border-[#23332E] bg-gradient-to-br from-[#101A17] to-[#0B1211] p-3.5">
        <div className="text-[11px] leading-[1.45] text-muted">
          Stima di massima su {report.layerCount} strati, 50 pezzi, finitura HASL senza
          piombo. Non è un preventivo.
        </div>
        <div className="flex items-baseline gap-1.5">
          <div className="font-mono text-[22px] font-semibold text-text">€ {cost.eur}</div>
          <div className="text-[11px] text-faint">· {cost.days} giorni lavorativi</div>
        </div>
      </div>
    </aside>
  );
}

function Counter({
  value,
  label,
  tone,
}: {
  value: number;
  label: string;
  tone: Severity;
}) {
  const bg = tone === "err" ? "#160F0F" : tone === "warn" ? "#16130C" : "#0D1614";
  const border = tone === "err" ? "#3E1F1D" : tone === "warn" ? "#40331A" : "#23423A";
  const sub = tone === "err" ? "#B98C85" : tone === "warn" ? "#B7A277" : "#7BA79A";
  return (
    <div
      className="flex-1 rounded-xl px-[11px] py-2.5"
      style={{ background: bg, border: `1px solid ${border}` }}
    >
      <div
        className="font-mono text-[19px] font-semibold"
        style={{ color: SEV_COLOR[tone] }}
      >
        {value}
      </div>
      <div className="text-[10px] tracking-[0.04em]" style={{ color: sub }}>
        {label}
      </div>
    </div>
  );
}

function PreflightRow({
  ok,
  label,
  value,
}: {
  ok: boolean;
  label: string;
  value: string;
}) {
  return (
    <div
      className="flex items-center gap-2.5 rounded-[11px] px-3 py-2.5"
      style={{
        background: ok ? "#0D1413" : "#120E0E",
        border: `1px solid ${ok ? "#1B2523" : "#33201E"}`,
      }}
    >
      <span
        className="grid h-4 w-4 place-items-center rounded-[5px] text-[9px]"
        style={{
          background: ok ? "#17241F" : "#241413",
          border: `1px solid ${ok ? "#2C4C42" : "#4A2622"}`,
          color: ok ? "#3BE8B0" : "#FF6B5A",
        }}
      >
        {ok ? "✓" : "!"}
      </span>
      <span
        className="flex-1 text-[12px]"
        style={{ color: ok ? "#A8B9B4" : "#D7B4AF" }}
      >
        {label}
      </span>
      <span
        className="font-mono text-[10px]"
        style={{ color: ok ? "#4E625C" : "#FF6B5A" }}
      >
        {value}
      </span>
    </div>
  );
}
