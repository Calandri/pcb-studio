"use client";

import type { BoardReport } from "@/lib/board-report";
import { VIEW_PRESETS, type ViewPreset } from "../ViewPresets";

const GLYPHS: Record<string, string> = {
  overview: "◎",
  assembly: "M",
  copper: "Cu",
  interference: "≈",
  connections: "⋈",
  fabrication: "⌗",
  everything: "∗",
};

const SHORT_HINTS: Record<string, string> = {
  overview: "Piste, piani e sigle",
  assembly: "Come si presenta la scheda finita",
  copper: "Piste, piani e larghezze",
  interference: "Distanze critiche e ingombri",
  connections: "Cosa è connesso a cosa",
  fabrication: "Vincoli di fabbrica",
  everything: "Tutti i livelli insieme",
};

export function LeftRail({
  report,
  preset,
  onPreset,
  layer,
  onLayer,
  xray,
  onXray,
  onAskCopilot,
}: {
  report: BoardReport;
  preset: string;
  onPreset: (p: ViewPreset) => void;
  layer: string;
  onLayer: (l: string) => void;
  xray: number;
  onXray: (v: number) => void;
  onAskCopilot: () => void;
}) {
  return (
    <aside className="flex min-h-0 flex-col border-r border-line bg-sunken">
      {/* le sezioni scorrono, il copilota resta sempre raggiungibile in fondo */}
      <div className="flex min-h-0 flex-1 flex-col gap-[22px] overflow-auto px-4 py-[18px]">
      <section className="flex flex-col gap-2.5">
        <div className="flex items-baseline justify-between">
          <div className="text-[10px] font-bold tracking-[0.12em] text-faint">
            COSA STAI GUARDANDO
          </div>
          <div className="font-mono text-[10px] text-[#42544F]">
            1-{VIEW_PRESETS.length}
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          {VIEW_PRESETS.map((v) => {
            const active = v.key === preset;
            return (
              <button
                key={v.key}
                type="button"
                onClick={() => onPreset(v)}
                className={`grid grid-cols-[34px_1fr] items-center gap-3 rounded-xl border px-3 py-[11px] text-left transition-colors ${
                  active
                    ? "border-[#2C4C42] bg-brand-wash"
                    : "border-line bg-transparent hover:border-[#3A5A50]"
                }`}
              >
                <span
                  className={`grid h-[34px] w-[34px] place-items-center rounded-[9px] border bg-raised font-mono text-[13px] font-semibold ${
                    active ? "border-[#2C4C42] text-brand" : "border-line text-muted"
                  }`}
                >
                  {GLYPHS[v.key] ?? "•"}
                </span>
                <span className="min-w-0">
                  <span
                    className={`block text-[13px] font-semibold ${active ? "text-brand" : "text-text"}`}
                  >
                    {v.label}
                  </span>
                  <span className="block text-[11px] leading-[1.35] text-faint">
                    {SHORT_HINTS[v.key] ?? ""}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <div className="text-[10px] font-bold tracking-[0.12em] text-faint">
          SEZIONE DELLA SCHEDA
        </div>
        <div className="flex flex-col gap-[7px] rounded-2xl border border-line bg-gradient-to-b from-[#0E1514] to-[#0A0F0E] px-3 py-3.5">
          {report.layers.map((l) => {
            const active = l.id === layer;
            return (
              <button
                key={l.id}
                type="button"
                onClick={() => onLayer(l.id)}
                className={`grid grid-cols-[1fr_46px] items-center gap-2.5 rounded-[9px] px-1 py-[5px] text-left transition-colors ${
                  active ? "bg-[#141E1B]" : "hover:bg-[#141E1B]"
                }`}
              >
                <span className="flex flex-col gap-[5px]">
                  <span className="flex items-center gap-2">
                    <span
                      className="h-[7px] w-[7px] rounded-[2px]"
                      style={{ background: l.color }}
                    />
                    <span
                      className={`text-[12px] font-semibold ${active ? "text-brand" : "text-text"}`}
                    >
                      {l.name}
                    </span>
                    <span className="font-mono text-[9px] text-[#4E625C]">{l.depthMm}</span>
                  </span>
                  <span
                    className="rounded-[2px]"
                    style={{
                      height: l.id === "top" || l.id === "bottom" ? 7 : 5,
                      width: `${Math.max(6, l.coverage)}%`,
                      background: `linear-gradient(90deg, ${l.color}, ${l.color}55)`,
                      boxShadow: active ? `0 0 10px ${l.color}55` : "none",
                    }}
                  />
                </span>
                <span className="text-right font-mono text-[10px] text-faint">
                  {l.coverage}%
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="flex flex-col gap-2.5">
        <div className="flex items-center justify-between">
          <div className="text-[10px] font-bold tracking-[0.12em] text-faint">
            RADIOGRAFIA
          </div>
          <div className="font-mono text-[10px] text-brand">{xray}%</div>
        </div>
        <input
          type="range"
          min={0}
          max={100}
          value={xray}
          onChange={(e) => onXray(Number(e.target.value))}
          className="h-1 w-full rounded-[3px] bg-line accent-[#3BE8B0]"
        />
        <p className="text-[11px] leading-[1.4] text-[#5F726C]">
          Alza per schiarire la vista e far emergere il rame degli strati sotto.
        </p>
      </section>
      </div>

      <button
        type="button"
        onClick={onAskCopilot}
        className="m-3 mt-0 flex flex-none items-center gap-2 rounded-xl border border-line bg-raised px-3 py-[11px] text-left transition-colors hover:border-[#3A5A50]"
      >
        <span className="grid h-[26px] w-[26px] flex-none place-items-center rounded-[7px] border border-[#2C4C42] bg-brand-wash text-[12px] text-brand">
          ✦
        </span>
        <span className="text-[11px] leading-[1.35] text-muted">
          Chiedi al copilota:{" "}
          <span className="text-brand">«perché questa via è segnalata?»</span>
        </span>
      </button>
    </aside>
  );
}
