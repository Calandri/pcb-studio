"use client";

import { useState } from "react";
import { estimateCost, type BoardReport, type Severity } from "@/lib/board-report";
import { BOARD_THICKNESS_MM } from "@/lib/enclosure-template";
import { downloadTextFile, meshesToStl } from "@/lib/stl-export";
import type { EnclosuresApi } from "@/lib/use-enclosures";
import type { BoardTab } from "./Chrome";

export interface ErcSummary {
  violations: Array<{ rule: string; severity: "warn" | "fail"; message: string }>;
  counts: Record<string, number>;
}

const ERC_ROWS: Array<{ rule: string; label: string; hint: string }> = [
  {
    rule: "unconnected_pin",
    label: "Pin non collegati",
    hint: "Piedini lasciati per aria: o vanno collegati o dichiarati come non collegati.",
  },
  {
    rule: "single_node_net",
    label: "Net a un solo nodo",
    hint: "Un filo che parte da un piedino e non arriva da nessuna parte.",
  },
  {
    rule: "conflicting_sources",
    label: "Sorgenti in conflitto",
    hint: "Due alimentazioni sulla stessa net: si guardano in faccia.",
  },
  {
    rule: "duplicate_designator",
    label: "Sigle duplicate",
    hint: "Due componenti con la stessa sigla: la distinta diventa ambigua.",
  },
  {
    rule: "do_not_connect",
    label: "«Non collegare» violati",
    hint: "Un piedino marcato non-collegare ha un filo attaccato.",
  },
];

const SEV_COLOR: Record<Severity, string> = {
  err: "#FF6B5A",
  warn: "#E8B23B",
  ok: "#3BE8B0",
};

export function RightRail({
  tab,
  report,
  erc,
  compiledAgo,
  onAsk,
  onShowOnBoard,
  onRecompile,
  recompiling,
  enclosures,
}: {
  tab: BoardTab;
  report: BoardReport;
  erc: ErcSummary | null;
  compiledAgo: string;
  onAsk: (prompt: string) => void;
  /** lights up on the board the view that shows that check */
  onShowOnBoard: (preset: string) => void;
  onRecompile: () => void;
  recompiling: boolean;
  /** enclosure designer (3D tab only) */
  enclosures: EnclosuresApi | null;
}) {
  // on the 3D tab DRC and costs are not needed: the mechanical checks are what count
  if (tab === "cad" && enclosures) {
    return <CadRail report={report} enclosures={enclosures} onAsk={onAsk} />;
  }
  return (
    <BoardRail
      report={report}
      erc={erc}
      compiledAgo={compiledAgo}
      tab={tab}
      onAsk={onAsk}
      onShowOnBoard={onShowOnBoard}
      onRecompile={onRecompile}
      recompiling={recompiling}
    />
  );
}

function BoardRail({
  report,
  erc,
  compiledAgo,
  tab,
  onAsk,
  onShowOnBoard,
  onRecompile,
  recompiling,
}: {
  tab: BoardTab;
  report: BoardReport;
  erc: ErcSummary | null;
  compiledAgo: string;
  onAsk: (prompt: string) => void;
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
            className="flex min-w-0 items-center gap-1.5 rounded-md border border-line-strong px-2 py-1 font-mono text-[10px] whitespace-nowrap text-[#8A9C96] transition-colors hover:border-brand hover:text-brand disabled:text-[#42544F]"
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

      {tab === "schematic" && (
        <section className="flex flex-col gap-2">
          <div className="text-[10px] font-bold tracking-[0.11em] text-faint">
            REGOLE ELETTRICHE
          </div>
          <div className="flex flex-col gap-1.5">
            {ERC_ROWS.map((row) => {
              const count = erc?.counts?.[row.rule] ?? 0;
              const first = erc?.violations?.find((v) => v.rule === row.rule);
              const tone: Severity = count === 0 ? "ok" : first?.severity === "warn" ? "warn" : "err";
              return (
                <button
                  key={row.rule}
                  type="button"
                  onClick={() =>
                    onAsk(
                      count === 0
                        ? `Spiegami la regola elettrica "${row.label}".`
                        : `Risolvi "${row.label}" nello schema: ${first?.message ?? ""}`,
                    )
                  }
                  className="flex flex-col gap-[5px] rounded-xl border px-3 py-[11px] text-left transition-colors hover:border-[#3A5A50]"
                  style={{
                    background: tone === "err" ? "#160F0F" : tone === "warn" ? "#16130C" : "#0D1614",
                    borderColor: tone === "err" ? "#3E1F1D" : tone === "warn" ? "#40331A" : "#23423A",
                  }}
                >
                  <span className="flex items-center gap-[9px]">
                    <span
                      className="h-[7px] w-[7px] flex-none rounded-full"
                      style={{ background: SEV_COLOR[tone] }}
                    />
                    <span className="flex-1 text-[12.5px] font-semibold text-[#DCE7E3]">
                      {row.label}
                    </span>
                    <span
                      className="font-mono text-[10px] whitespace-nowrap"
                      style={{ color: SEV_COLOR[tone] }}
                    >
                      {count === 0 ? "ok" : count}
                    </span>
                  </span>
                  <span className="pl-4 text-[11px] leading-[1.4] break-words text-faint">
                    {count === 0 ? row.hint : (first?.message ?? row.hint)}
                  </span>
                </button>
              );
            })}
          </div>

          <button
            type="button"
            onClick={() =>
              onAsk(
                "Annota lo schema: assegna sigle e valori mancanti seguendo la distinta, senza cambiare i collegamenti.",
              )
            }
            className="flex flex-col gap-1 rounded-xl border border-[#2C4C42] bg-brand-wash px-3 py-[11px] text-left transition-colors hover:bg-[#1D3229]"
          >
            <span className="text-[12.5px] font-semibold text-brand">Annota con l&apos;IA</span>
            <span className="text-[11px] leading-[1.4] text-muted">
              Assegna sigle e valori mancanti seguendo la distinta preferita.
            </span>
          </button>

          <div className="mt-1 flex flex-col gap-2 rounded-xl border border-line bg-raised px-3 py-[11px]">
            <div className="text-[10px] font-bold tracking-[0.11em] text-faint">
              DALLO SCHEMA ALLA SCHEDA
            </div>
            <p className="text-[11px] leading-[1.4] text-muted">
              Cambiato lo schema, lo sbroglio va rifatto: la scheda che vedi resta
              quella di prima finché non ricompili.
            </p>
            <button
              type="button"
              onClick={onRecompile}
              disabled={recompiling}
              className="rounded-lg border border-line-strong px-2.5 py-1.5 text-[11px] font-semibold text-[#C7D6D1] transition-colors hover:border-[#3A5A50] disabled:text-faint"
            >
              {recompiling ? "Aggiorno..." : "Aggiorna lo sbroglio"}
            </button>
          </div>
        </section>
      )}

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

// --------------------------------------------------------------------- 3D

/**
 * Right rail of the 3D tab: mechanical checks of the enclosure and export.
 * DRC, ERC and costs stay on the other tabs, where they are needed.
 */
function CadRail({
  report,
  enclosures,
  onAsk,
}: {
  report: BoardReport;
  enclosures: EnclosuresApi;
  onAsk: (prompt: string) => void;
}) {
  const { params, meshes, errors } = enclosures;
  const boardW = report.widthMm;
  const boardH = report.heightMm;
  const outerW = boardW ? boardW + 2 * (params.clearanceMm + params.wallMm) : null;
  const outerH = boardH ? boardH + 2 * (params.clearanceMm + params.wallMm) : null;
  const totalH =
    params.bottomHeightMm + params.wallMm + BOARD_THICKNESS_MM + params.splitMm +
    params.topHeightMm + params.wallMm;

  const parametric = meshes.find((m) => m.kind === "parametric");
  const visible = meshes.filter((m) => m.visible);

  const exportStl = (target: typeof meshes, fileName: string) => {
    const all = target.flatMap((m) => m.meshes);
    if (all.length === 0) return;
    downloadTextFile(fileName, meshesToStl(all, "scocca"), "model/stl");
  };

  return (
    <aside className="flex flex-col gap-[18px] overflow-auto border-l border-line bg-sunken px-3.5 py-4">
      <section className="flex flex-col gap-2">
        <div className="text-[10px] font-bold tracking-[0.11em] text-faint">
          VERIFICHE MECCANICHE
        </div>
        <div className="flex flex-col gap-1.5">
          <PreflightRow
            ok={params.wallMm >= 1.2}
            label="Parete stampabile"
            value={`${params.wallMm} mm`}
          />
          <PreflightRow
            ok={params.bottomHeightMm >= 1.5}
            label="Spazio lato saldature"
            value={`${params.bottomHeightMm} mm`}
          />
          <PreflightRow
            ok={params.topHeightMm >= 5}
            label="Spazio sopra i componenti"
            value={`${params.topHeightMm} mm`}
          />
          <PreflightRow
            ok={outerW !== null}
            label="Ingombro esterno"
            value={
              outerW && outerH
                ? `${outerW.toFixed(0)}×${outerH.toFixed(0)}×${totalH.toFixed(0)} mm`
                : "senza dimensioni scheda"
            }
          />
          {errors.map((err) => (
            <PreflightRow key={err.name} ok={false} label={err.name} value="errore mesh" />
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <div className="text-[10px] font-bold tracking-[0.11em] text-faint">ESPORTA 3D</div>
        <div className="flex flex-col gap-1.5">
          <button
            type="button"
            disabled={!parametric}
            onClick={() => parametric && exportStl([parametric], "scocca.stl")}
            className="rounded-[10px] border border-line-strong bg-[#141C1A] px-[15px] py-[9px] text-[13px] font-medium text-[#C7D6D1] transition-colors hover:border-[#3A5A50] disabled:opacity-40"
          >
            Scocca parametrica (STL)
          </button>
          <button
            type="button"
            disabled={visible.length === 0}
            onClick={() => exportStl(visible, "assemblato-3d.stl")}
            className="rounded-[10px] border border-line-strong bg-[#141C1A] px-[15px] py-[9px] text-[13px] font-medium text-[#C7D6D1] transition-colors hover:border-[#3A5A50] disabled:opacity-40"
          >
            Tutto il visibile (STL)
          </button>
        </div>
        <p className="text-[11px] leading-[1.4] text-[#5F726C]">
          L&apos;STL è in millimetri, pronto per slicer e CAD meccanici.
        </p>
      </section>

      <div className="mt-auto flex flex-col gap-2.5 rounded-[13px] border border-[#23332E] bg-gradient-to-br from-[#101A17] to-[#0B1211] p-3.5">
        <div className="text-[11px] leading-[1.45] text-muted">
          Il copilota conosce le dimensioni della scheda: può progettare una
          scocca su misura, con fori, feritoie e sedi per i connettori.
        </div>
        <button
          type="button"
          onClick={() =>
            onAsk(
              "Progetta una scocca per questa scheda: due gusci a incastro, con le aperture per i connettori che vedi sul bordo. Salvala e mostramela.",
            )
          }
          className="rounded-[10px] bg-brand px-[15px] py-[9px] text-[13px] font-semibold text-[#06110D] transition-opacity hover:opacity-90"
        >
          Fai progettare la scocca al copilota
        </button>
      </div>
    </aside>
  );
}
