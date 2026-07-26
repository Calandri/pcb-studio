"use client";

import type { BoardReport } from "@/lib/board-report";
import type { InspectComponent } from "@/lib/inspect";
import { VIEW_PRESETS, type ViewPreset } from "../ViewPresets";
import type { BoardTab } from "./Chrome";

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

/** quel che serve del riepilogo di compilazione per lo schema */
export interface SchematicSummary {
  symbols: number;
  symbolOverlapCount: number;
  labelOverlapCount: number;
  traceCrossings: number;
  crossingsEstimated: boolean;
  sheet: { widthSu: number; heightSu: number; density: number; fitsA4: boolean };
  sections: string[];
  sectionsWithFrames: string[];
}

/**
 * Colonna di sinistra: risponde sempre alla domanda "cosa sto guardando", ma
 * il contenuto cambia col tab. I livelli di rame e la radiografia esistono solo
 * per lo sbroglio: sullo schema e sul 3D non vogliono dire niente, quindi
 * lasciano il posto a quello che conta li'.
 */
export function LeftRail({
  tab,
  report,
  schematic,
  parts,
  preset,
  onPreset,
  layer,
  onLayer,
  xray,
  onXray,
  onAskCopilot,
}: {
  tab: BoardTab;
  report: BoardReport;
  schematic: SchematicSummary | null;
  parts: InspectComponent[];
  preset: string;
  onPreset: (p: ViewPreset) => void;
  layer: string;
  onLayer: (l: string) => void;
  xray: number;
  onXray: (v: number) => void;
  onAskCopilot: () => void;
}) {
  const hint =
    tab === "pcb"
      ? "«perché questa via è segnalata?»"
      : tab === "schematic"
        ? "«questo schema si legge bene?»"
        : tab === "cad"
          ? "«questi componenti ci stanno?»"
          : "«quanto costano i componenti?»";

  return (
    <aside className="flex min-h-0 flex-col border-r border-line bg-sunken">
      {/* le sezioni scorrono, il copilota resta sempre raggiungibile in fondo */}
      <div className="flex min-h-0 flex-1 flex-col gap-[22px] overflow-auto px-4 py-[18px]">
        {tab === "pcb" && (
          <PcbSections
            report={report}
            preset={preset}
            onPreset={onPreset}
            layer={layer}
            onLayer={onLayer}
            xray={xray}
            onXray={onXray}
          />
        )}
        {tab === "schematic" && <SchematicSections schematic={schematic} />}
        {tab === "cad" && <ThreeDSections report={report} parts={parts} />}
        {tab === "bom" && <BomSections report={report} parts={parts} />}
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
          Chiedi al copilota: <span className="text-brand">{hint}</span>
        </span>
      </button>
    </aside>
  );
}

// ---------------------------------------------------------------- sbroglio

function PcbSections({
  report,
  preset,
  onPreset,
  layer,
  onLayer,
  xray,
  onXray,
}: {
  report: BoardReport;
  preset: string;
  onPreset: (p: ViewPreset) => void;
  layer: string;
  onLayer: (l: string) => void;
  xray: number;
  onXray: (v: number) => void;
}) {
  return (
    <>
      <section className="flex flex-col gap-2.5">
        <SectionHead title="COSA STAI GUARDANDO" aside={`1-${VIEW_PRESETS.length}`} />
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
        <SectionHead title="SEZIONE DELLA SCHEDA" />
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
        <SectionHead title="RADIOGRAFIA" aside={`${xray}%`} asideBrand />
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
    </>
  );
}

// -------------------------------------------------------------- schematico

function SchematicSections({ schematic }: { schematic: SchematicSummary | null }) {
  if (!schematic) {
    return (
      <p className="text-[11px] leading-[1.5] text-faint">
        La qualità dello schema si misura alla compilazione: chiedi al copilota di
        ricompilare per vederla qui.
      </p>
    );
  }

  const { sheet } = schematic;
  return (
    <>
      <section className="flex flex-col gap-2.5">
        <SectionHead title="LEGGIBILITÀ DELLO SCHEMA" />
        <div className="flex flex-col gap-1.5">
          <Metric
            label="Simboli disegnati"
            value={schematic.symbols}
            tone="ok"
            hint="Quanti componenti compaiono nel disegno."
          />
          <Metric
            label="Simboli sovrapposti"
            value={schematic.symbolOverlapCount}
            tone={schematic.symbolOverlapCount > 0 ? "err" : "ok"}
            hint="Due pezzi disegnati uno sopra l'altro: lo schema diventa illeggibile."
          />
          <Metric
            label="Etichette sui simboli"
            value={schematic.labelOverlapCount}
            tone={schematic.labelOverlapCount > 0 ? "warn" : "ok"}
            hint="Nomi di rete finiti sopra un componente."
          />
          <Metric
            label="Incroci fra fili"
            value={schematic.traceCrossings}
            tone={schematic.traceCrossings > 12 ? "warn" : "ok"}
            hint={
              schematic.crossingsEstimated
                ? "Stimati dal disegno: pochi incroci si leggono meglio."
                : "Pochi incroci si leggono meglio."
            }
          />
        </div>
      </section>

      <section className="flex flex-col gap-2.5">
        <SectionHead title="IL FOGLIO" />
        <div className="flex flex-col gap-2 rounded-2xl border border-line bg-gradient-to-b from-[#0E1514] to-[#0A0F0E] px-3 py-3.5">
          <Row label="Dimensioni" value={`${sheet.widthSu} × ${sheet.heightSu}`} />
          <Row label="Riempimento" value={`${Math.round(sheet.density * 100)}%`} />
          <Row
            label="Sta in un A4"
            value={sheet.fitsA4 ? "sì" : "no"}
            tone={sheet.fitsA4 ? "ok" : "warn"}
          />
        </div>
      </section>

      {schematic.sections.length > 0 && (
        <section className="flex flex-col gap-2.5">
          <SectionHead
            title="SEZIONI DEL CIRCUITO"
            aside={`${schematic.sections.length}`}
          />
          <div className="flex flex-col gap-1">
            {schematic.sections.map((name) => {
              const framed = schematic.sectionsWithFrames.includes(name);
              return (
                <div
                  key={name}
                  className="flex items-center gap-2 rounded-[9px] border border-line px-3 py-2"
                >
                  <span
                    className="h-[7px] w-[7px] flex-none rounded-[2px]"
                    style={{ background: framed ? "#3BE8B0" : "#42544F" }}
                  />
                  <span className="min-w-0 flex-1 truncate text-[12px] text-text">
                    {name}
                  </span>
                  {!framed && (
                    <span className="font-mono text-[9px] text-[#4E625C]">senza cornice</span>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}
    </>
  );
}

// ---------------------------------------------------------------------- 3D

function ThreeDSections({
  report,
  parts,
}: {
  report: BoardReport;
  parts: InspectComponent[];
}) {
  const top = parts.filter((p) => p.layer !== "bottom").length;
  const bottom = parts.length - top;
  const biggest = [...parts]
    .filter((p) => p.widthMm && p.heightMm)
    .sort((a, b) => b.widthMm! * b.heightMm! - a.widthMm! * a.heightMm!)
    .slice(0, 5);

  return (
    <>
      <section className="flex flex-col gap-2.5">
        <SectionHead title="COME SARÀ MONTATA" />
        <div className="flex flex-col gap-2 rounded-2xl border border-line bg-gradient-to-b from-[#0E1514] to-[#0A0F0E] px-3 py-3.5">
          <Row label="Lato componenti" value={`${top} pezzi`} />
          <Row label="Lato saldature" value={`${bottom} pezzi`} />
          <Row
            label="Scheda"
            value={
              report.widthMm && report.heightMm
                ? `${report.widthMm} × ${report.heightMm} mm`
                : "—"
            }
          />
          <Row label="Spessore" value="1,6 mm" />
          <Row label="Strati di rame" value={`${report.layerCount}`} />
        </div>
        <p className="text-[11px] leading-[1.4] text-[#5F726C]">
          Trascina per girare la scheda, rotella per avvicinarti.
        </p>
      </section>

      {biggest.length > 0 && (
        <section className="flex flex-col gap-2.5">
          <SectionHead title="I PEZZI PIÙ INGOMBRANTI" />
          <div className="flex flex-col gap-1">
            {biggest.map((p) => (
              <div
                key={p.id}
                className="flex items-baseline gap-2 rounded-[9px] border border-line px-3 py-2"
              >
                <span className="font-mono text-[12px] text-text">{p.name}</span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-faint">
                  {p.ftype ?? ""}
                </span>
                <span className="font-mono text-[10px] whitespace-nowrap text-[#4E625C]">
                  {p.widthMm} × {p.heightMm}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

// ---------------------------------------------------------------- distinta

function BomSections({
  report,
  parts,
}: {
  report: BoardReport;
  parts: InspectComponent[];
}) {
  const byType = new Map<string, number>();
  for (const p of parts) {
    const key = p.ftype ?? "altro";
    byType.set(key, (byType.get(key) ?? 0) + 1);
  }
  const types = [...byType.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  const missing = report.componentCount - report.partsWithSupplier;

  return (
    <>
      <section className="flex flex-col gap-2.5">
        <SectionHead title="COSA C'È NELLA DISTINTA" />
        <div className="flex flex-col gap-2 rounded-2xl border border-line bg-gradient-to-b from-[#0E1514] to-[#0A0F0E] px-3 py-3.5">
          <Row label="Componenti" value={`${report.componentCount}`} />
          <Row
            label="Con codice fornitore"
            value={`${report.partsWithSupplier}`}
            tone={missing === 0 ? "ok" : "warn"}
          />
          <Row
            label="Da trovare"
            value={`${missing}`}
            tone={missing === 0 ? "ok" : "err"}
          />
        </div>
      </section>

      {types.length > 0 && (
        <section className="flex flex-col gap-2.5">
          <SectionHead title="PER TIPO" />
          <div className="flex flex-col gap-1">
            {types.map(([type, count]) => (
              <div
                key={type}
                className="flex items-center gap-2 rounded-[9px] border border-line px-3 py-2"
              >
                <span className="min-w-0 flex-1 truncate text-[12px] text-text">{type}</span>
                <span className="font-mono text-[11px] text-faint">{count}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

// ------------------------------------------------------------------ pezzi

function SectionHead({
  title,
  aside,
  asideBrand = false,
}: {
  title: string;
  aside?: string;
  asideBrand?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <div className="text-[10px] font-bold tracking-[0.12em] text-faint">{title}</div>
      {aside && (
        <div
          className={`font-mono text-[10px] ${asideBrand ? "text-brand" : "text-[#42544F]"}`}
        >
          {aside}
        </div>
      )}
    </div>
  );
}

const TONE_COLOR = { ok: "#3BE8B0", warn: "#E8B23B", err: "#FF6B5A" } as const;

function Metric({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: number;
  tone: keyof typeof TONE_COLOR;
  hint: string;
}) {
  return (
    <div className="flex flex-col gap-[5px] rounded-xl border border-line px-3 py-[11px]">
      <span className="flex items-center gap-[9px]">
        <span
          className="h-[7px] w-[7px] flex-none rounded-full"
          style={{ background: TONE_COLOR[tone] }}
        />
        <span className="flex-1 text-[12.5px] font-semibold text-[#DCE7E3]">{label}</span>
        <span className="font-mono text-[12px]" style={{ color: TONE_COLOR[tone] }}>
          {value}
        </span>
      </span>
      <span className="pl-4 text-[11px] leading-[1.4] text-faint">{hint}</span>
    </div>
  );
}

function Row({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: keyof typeof TONE_COLOR;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="min-w-0 flex-1 truncate text-[12px] text-muted">{label}</span>
      <span
        className="font-mono text-[11px]"
        style={{ color: tone ? TONE_COLOR[tone] : "#E7EFEC" }}
      >
        {value}
      </span>
    </div>
  );
}
