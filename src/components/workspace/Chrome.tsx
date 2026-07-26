"use client";

import type { BoardReport } from "@/lib/board-report";
import { LogoMark } from "../Logo";

export type BoardTab = "schematic" | "pcb" | "cad" | "bom";

const TABS: Array<{ key: BoardTab; label: string }> = [
  { key: "schematic", label: "Schematico" },
  { key: "pcb", label: "Sbroglio" },
  { key: "cad", label: "3D" },
  { key: "bom", label: "Distinta" },
];

export function Header({
  projectId,
  report,
  tab,
  onTab,
  busy,
  onOpenProjects,
  actions,
}: {
  projectId: string;
  report: BoardReport;
  tab: BoardTab;
  onTab: (t: BoardTab) => void;
  busy: boolean;
  /** apre progetti, libreria, datasheet e condivisione */
  onOpenProjects: () => void;
  actions?: React.ReactNode;
}) {
  const size =
    report.widthMm && report.heightMm
      ? `${report.widthMm} × ${report.heightMm} mm`
      : "dimensioni da compilare";

  return (
    <header className="flex min-w-0 items-center gap-[18px] overflow-hidden border-b border-line bg-surface px-[18px]">
      <button
        type="button"
        onClick={onOpenProjects}
        title="Progetti, libreria e condivisione"
        className="group flex h-full flex-none items-center gap-[11px] border-r border-line pr-[18px] text-left"
      >
        <LogoMark size={30} className="flex-none transition-transform group-hover:scale-105" />
        <span className="flex flex-col gap-0.5 whitespace-nowrap">
          <span className="text-sm font-semibold tracking-[-0.01em]">{projectId}</span>
          <span className="font-mono text-[10px] tracking-[0.03em] text-faint">
            {report.layerCount} strati · {size}
          </span>
        </span>
      </button>

      <nav className="flex flex-none gap-0.5 rounded-[10px] border border-line bg-[#0F1716] p-[3px]">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => onTab(t.key)}
            className={`whitespace-nowrap rounded-[7px] px-[13px] py-[7px] text-[13px] transition-colors ${
              tab === t.key
                ? "bg-brand-wash font-semibold text-brand shadow-[inset_0_0_0_1px_#2C4C42]"
                : "text-[#7D8F8A] hover:text-text"
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div className="min-w-0 flex-1" />

      <div className="flex flex-none items-center gap-3 rounded-[10px] border border-line bg-[#0F1716] px-3.5 py-[7px]">
        <div className="flex flex-col gap-[5px]">
          <div className="text-[10px] font-semibold tracking-[0.08em] text-faint">
            {busy ? "CONTROLLO IN CORSO" : "PRONTA PER LA FABBRICA"}
          </div>
          <div className="h-[5px] w-[150px] overflow-hidden rounded-[3px] bg-line">
            <div
              className="h-full rounded-[3px] transition-[width] duration-500"
              style={{
                width: `${report.readiness}%`,
                background: "linear-gradient(90deg,#2C9C77,#3BE8B0)",
              }}
            />
          </div>
        </div>
        <div className="font-mono text-[18px] font-semibold text-brand">
          {report.readiness}
          <span className="text-[11px] text-faint">%</span>
        </div>
      </div>

      <div className="flex flex-none items-center gap-2">
        <a
          href={`/api/export?projectId=${projectId}&kind=gerber`}
          download
          className="rounded-[10px] border border-line-strong bg-[#141C1A] px-[15px] py-[9px] text-[13px] font-medium text-[#C7D6D1] transition-colors hover:border-[#3A5A50]"
        >
          Gerber
        </a>
        <a
          href={`/api/export?projectId=${projectId}&kind=bom`}
          download
          className="rounded-[10px] border border-line-strong bg-[#141C1A] px-[15px] py-[9px] text-[13px] font-medium text-[#C7D6D1] transition-colors hover:border-[#3A5A50]"
        >
          Distinta
        </a>
        <a
          href={`/api/export?projectId=${projectId}&kind=pnp`}
          download
          className="rounded-[10px] bg-brand px-[15px] py-[9px] text-[13px] font-semibold text-[#06110D] transition-opacity hover:opacity-90"
        >
          Manda in produzione
        </a>
        {actions}
      </div>
    </header>
  );
}

export function Footer({
  report,
  layer,
}: {
  report: BoardReport;
  layer: string;
}) {
  const sideCaption =
    layer === "top"
      ? "lato componenti"
      : layer === "bottom"
        ? "lato saldature"
        : layer === "inner1"
          ? "piano interno 1"
          : "piano interno 2";

  return (
    <footer className="flex items-center gap-4 border-t border-line bg-surface px-[18px]">
      <div className="flex items-center gap-4">
        <LegendItem label="Rame">
          <span className="h-[5px] w-3.5 rounded-[2px] bg-gradient-to-r from-[#F2C078] to-[#D9932F]" />
        </LegendItem>
        <LegendItem label="Fori passanti">
          <span className="h-[9px] w-[9px] rounded-full border-2 border-[#6FE3C0] bg-[#0A100E]" />
        </LegendItem>
        <LegendItem label="Serigrafia">
          <span className="h-2 w-[11px] rounded-[2px] border border-[rgba(214,232,226,0.5)]" />
        </LegendItem>
        <LegendItem label="Segnalazioni">
          <span className="h-[9px] w-[9px] rounded-full border-[1.5px] border-[#FF6B5A]" />
        </LegendItem>
      </div>

      <div className="flex-1" />

      <div className="flex items-center gap-3.5 font-mono text-[11px] text-[#5F726C]">
        <span>{report.componentCount} componenti</span>
        <Divider />
        <span>{report.traceCount} piste · {report.viaCount} via</span>
        <Divider />
        <span className="text-brand">{sideCaption}</span>
      </div>
    </footer>
  );
}

function LegendItem({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <span className="flex items-center gap-[7px]">
      {children}
      <span className="text-[11px] text-muted">{label}</span>
    </span>
  );
}

function Divider() {
  return <span className="h-4 w-px bg-line" />;
}
