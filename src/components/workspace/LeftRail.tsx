"use client";

import { useRef } from "react";
import type { BoardReport } from "@/lib/board-report";
import type { InspectComponent } from "@/lib/inspect";
import type { EnclosuresApi } from "@/lib/use-enclosures";
import { CAD_IMPORT_EXTENSIONS } from "@/lib/cad-import";
import { BOARD_THICKNESS_MM } from "@/lib/enclosure-template";
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

export interface SheetNet {
  name: string;
  role: "potenza" | "massa" | "segnale";
  nodes: number;
  widthMm: number | null;
  onPlane: string | null;
}

/** what is needed from the compile summary for the schematic */
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
 * Left column: it always answers the question "what am I looking at", but
 * the content changes with the tab. The copper layers and the x-ray exist
 * only for the routing: on the schematic and the 3D they mean nothing, so
 * they make room for what matters there.
 */
export function LeftRail({
  tab,
  projectId,
  report,
  schematic,
  nets,
  parts,
  preset,
  onPreset,
  layer,
  onLayer,
  xray,
  onXray,
  onAskCopilot,
  enclosures,
  scene,
}: {
  tab: BoardTab;
  projectId: string;
  report: BoardReport;
  schematic: SchematicSummary | null;
  nets: SheetNet[];
  parts: InspectComponent[];
  preset: string;
  onPreset: (p: ViewPreset) => void;
  layer: string;
  onLayer: (l: string) => void;
  xray: number;
  onXray: (v: number) => void;
  onAskCopilot: () => void;
  /** enclosure designer: state and actions (3D tab only) */
  enclosures: EnclosuresApi | null;
  scene: {
    showEnclosures: boolean;
    onShowEnclosures: (v: boolean) => void;
    opacity: number;
    onOpacity: (v: number) => void;
    explodedMm: number;
    onExplodedMm: (v: number) => void;
  } | null;
}) {
  const hint =
    tab === "pcb"
      ? "«perché questa via è segnalata?»"
      : tab === "schematic"
        ? "«questo schema si legge bene?»"
        : tab === "cad"
          ? "«progettami la scocca»"
          : "«quanto costano i componenti?»";

  return (
    <aside className="flex min-h-0 flex-col border-r border-line bg-sunken">
      {/* the sections scroll, the copilot stays always reachable at the bottom */}
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
        {tab === "schematic" && (
          <SchematicSections schematic={schematic} nets={nets} projectId={projectId} />
        )}
        {tab === "cad" && enclosures && scene && (
          <EnclosureSections
            report={report}
            parts={parts}
            enclosures={enclosures}
            scene={scene}
          />
        )}
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

// ---------------------------------------------------------------- routing

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

// -------------------------------------------------------------- schematic

function SchematicSections({
  schematic,
  nets,
  projectId,
}: {
  schematic: SchematicSummary | null;
  nets: SheetNet[];
  projectId: string;
}) {
  if (!schematic) {
    return (
      <p className="text-[11px] leading-[1.5] text-faint">
        La qualità dello schema si misura alla compilazione: premi «ricompila» per
        vederla qui.
      </p>
    );
  }

  const { sheet } = schematic;
  const sections = schematic.sections;

  return (
    <>
      <section className="flex flex-col gap-2.5">
        <SectionHead title="GERARCHIA FOGLI" aside={sections.length ? `${sections.length}` : undefined} />
        <div className="flex flex-col gap-2 rounded-2xl border border-line bg-gradient-to-b from-[#0E1514] to-[#0A0F0E] px-3 py-3.5">
          <div className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-text">
              {projectId}
            </span>
            <span className="font-mono text-[10px] text-[#4E625C]">foglio unico</span>
          </div>
          <Row label="Dimensioni" value={`${sheet.widthSu} × ${sheet.heightSu}`} />
          <Row label="Sta in un A4" value={sheet.fitsA4 ? "sì" : "no"} tone={sheet.fitsA4 ? "ok" : "warn"} />
          <Row label="Riempimento" value={`${Math.round(sheet.density * 100)}%`} />
        </div>
        {sections.length > 0 ? (
          <div className="flex flex-col gap-1">
            {sections.map((name) => {
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
                  <span className="min-w-0 flex-1 truncate text-[12px] text-text">{name}</span>
                  {!framed && (
                    <span className="font-mono text-[9px] text-[#4E625C]">senza cornice</span>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-[11px] leading-[1.4] text-[#5F726C]">
            Nessuna sezione dichiarata: chiedi al copilota di dividere lo schema in
            blocchi funzionali, si legge molto meglio.
          </p>
        )}
      </section>

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

      {nets.length > 0 && (
        <section className="flex flex-col gap-2.5">
          <SectionHead title="NET DEL FOGLIO" aside={`${nets.length}`} />
          <div className="flex flex-col gap-1">
            {nets.slice(0, 24).map((net) => (
              <div
                key={net.name}
                className="flex items-baseline gap-2 rounded-[9px] border border-line px-3 py-2"
              >
                <span
                  className="h-[7px] w-[7px] flex-none rounded-[2px]"
                  style={{ background: NET_COLOR[net.role] }}
                />
                <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-text">
                  {net.name}
                </span>
                <span className="font-mono text-[10px] whitespace-nowrap text-[#4E625C]">
                  {net.onPlane
                    ? `piano · ${net.onPlane}`
                    : net.widthMm
                      ? `${net.role} · ${net.widthMm.toFixed(2).replace(".", ",")} mm`
                      : `${net.role} · ${net.nodes} nodi`}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

const NET_COLOR: Record<SheetNet["role"], string> = {
  potenza: "#E8B23B",
  massa: "#3BE8B0",
  segnale: "#7FB4FF",
};

// ---------------------------------------------------------------------- 3D

function EnclosureSections({
  report,
  parts,
  enclosures,
  scene,
}: {
  report: BoardReport;
  parts: InspectComponent[];
  enclosures: EnclosuresApi;
  scene: {
    showEnclosures: boolean;
    onShowEnclosures: (v: boolean) => void;
    opacity: number;
    onOpacity: (v: number) => void;
    explodedMm: number;
    onExplodedMm: (v: number) => void;
  };
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const { params, setParams, records, errors, dismissError, busy, patchRecord, remove } =
    enclosures;
  const boardW = report.widthMm;
  const boardH = report.heightMm;
  const outerW = boardW ? boardW + 2 * (params.clearanceMm + params.wallMm) : null;
  const outerH = boardH ? boardH + 2 * (params.clearanceMm + params.wallMm) : null;
  const totalH =
    params.bottomHeightMm + params.wallMm + BOARD_THICKNESS_MM + params.splitMm +
    params.topHeightMm + params.wallMm;
  const top = parts.filter((p) => p.layer !== "bottom").length;
  const bottom = parts.length - top;
  const modules = records.filter((r) => r.kind !== "parametric");

  return (
    <>
      <section className="flex flex-col gap-2.5">
        <SectionHead title="SCENA" />
        <div className="flex flex-col gap-3 rounded-2xl border border-line bg-gradient-to-b from-[#0E1514] to-[#0A0F0E] px-3 py-3.5">
          <ToggleRow
            label="Scocche e moduli"
            checked={scene.showEnclosures}
            onChange={scene.onShowEnclosures}
          />
          <SliderRow
            label="Scocca trasparente"
            value={Math.round((1 - scene.opacity) * 100)}
            min={0}
            max={80}
            unit="%"
            onChange={(v) => scene.onOpacity(1 - v / 100)}
          />
          <SliderRow
            label="Vista esplosa"
            value={scene.explodedMm}
            min={0}
            max={40}
            unit=" mm"
            onChange={scene.onExplodedMm}
          />
        </div>
      </section>

      <section className="flex flex-col gap-2.5">
        <SectionHead
          title="SCOCCA PARAMETRICA"
          aside={outerW && outerH ? `${outerW.toFixed(0)}×${outerH.toFixed(0)}×${totalH.toFixed(0)}` : undefined}
        />
        <div className="flex flex-col gap-3 rounded-2xl border border-line bg-gradient-to-b from-[#0E1514] to-[#0A0F0E] px-3 py-3.5">
          <SliderRow label="Margine laterale" value={params.clearanceMm} min={0.5} max={10} step={0.5} unit=" mm" onChange={(v) => setParams({ clearanceMm: v })} />
          <SliderRow label="Spessore parete" value={params.wallMm} min={0.8} max={4} step={0.1} unit=" mm" onChange={(v) => setParams({ wallMm: v })} />
          <SliderRow label="Spazio sopra" value={params.topHeightMm} min={3} max={40} step={1} unit=" mm" onChange={(v) => setParams({ topHeightMm: v })} />
          <SliderRow label="Spazio sotto" value={params.bottomHeightMm} min={0} max={15} step={0.5} unit=" mm" onChange={(v) => setParams({ bottomHeightMm: v })} />
          <SliderRow label="Divisione gusci" value={params.splitMm} min={-1} max={20} step={0.5} unit=" mm" onChange={(v) => setParams({ splitMm: v })} />
          <SliderRow label="Raggio spigoli" value={params.cornerRadiusMm} min={0} max={10} step={0.5} unit=" mm" onChange={(v) => setParams({ cornerRadiusMm: v })} />
          <ToggleRow
            label="Colonnine di fissaggio"
            checked={params.posts}
            onChange={(v) => setParams({ posts: v })}
          />
          <div className="flex items-center gap-2.5">
            <span className="flex-1 text-[12px] text-muted">Colore</span>
            <input
              type="color"
              value={params.color}
              onChange={(e) => setParams({ color: e.target.value })}
              className="h-6 w-10 cursor-pointer rounded-md border border-line bg-transparent"
            />
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-2.5">
        <SectionHead title="MODULI 3D" aside={modules.length ? `${modules.length}` : undefined} />
        <input
          ref={fileInput}
          type="file"
          accept={CAD_IMPORT_EXTENSIONS.join(",")}
          multiple
          className="hidden"
          onChange={(e) => {
            for (const file of Array.from(e.target.files ?? [])) {
              void enclosures.importFile(file);
            }
            e.target.value = "";
          }}
        />
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          disabled={busy !== null}
          className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-[#2C4C42] px-3 py-[11px] text-[12px] font-semibold text-brand transition-colors hover:bg-brand-wash disabled:opacity-50"
        >
          {busy ? (
            <>
              <span className="dot dot-busy" /> Apro {busy}...
            </>
          ) : (
            <>Importa CAD (STEP, STL, OBJ, GLB)</>
          )}
        </button>

        {modules.length > 0 && (
          <div className="flex flex-col gap-1">
            {modules.map((record) => (
              <ModuleRow
                key={record.name}
                record={record}
                onToggle={(v) => void patchRecord(record.name, { visible: v })}
                onRemove={() => void remove(record.name)}
              />
            ))}
          </div>
        )}

        {errors.length > 0 && (
          <div className="flex flex-col gap-1">
            {errors.map((err) => (
              <div
                key={err.name}
                className="flex items-start gap-2 rounded-[9px] border border-[#3E1F1D] bg-[#160F0F] px-3 py-2"
              >
                <span className="min-w-0 flex-1 text-[11px] leading-[1.4] break-words text-[#D7B4AF]">
                  {err.name}: {err.message}
                </span>
                <button
                  type="button"
                  onClick={() => dismissError(err.name)}
                  className="text-[#B98C85] hover:text-text"
                  title="Chiudi"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-2.5">
        <SectionHead title="COME SARÀ MONTATA" />
        <div className="flex flex-col gap-2 rounded-2xl border border-line bg-gradient-to-b from-[#0E1514] to-[#0A0F0E] px-3 py-3.5">
          <Row label="Lato componenti" value={`${top} pezzi`} />
          <Row label="Lato saldature" value={`${bottom} pezzi`} />
          <Row
            label="Scheda"
            value={boardW && boardH ? `${boardW} × ${boardH} mm` : "—"}
          />
          <Row label="Spessore" value={`${BOARD_THICKNESS_MM} mm`} />
          <Row label="Strati di rame" value={`${report.layerCount}`} />
        </div>
        <p className="text-[11px] leading-[1.4] text-[#5F726C]">
          Trascina per girare il modello, rotella per avvicinarti.
        </p>
      </section>

      <BiggestParts parts={parts} />
    </>
  );
}

function ModuleRow({
  record,
  onToggle,
  onRemove,
}: {
  record: EnclosuresApi["records"][number];
  onToggle: (visible: boolean) => void;
  onRemove: () => void;
}) {
  const kindLabel =
    record.kind === "jscad" ? "AI" : (record.fileName?.split(".").pop() ?? "CAD").toUpperCase();
  return (
    <div className="flex items-center gap-2 rounded-[9px] border border-line px-3 py-2">
      <button
        type="button"
        onClick={() => onToggle(!record.visible)}
        title={record.visible ? "Nascondi" : "Mostra"}
        className={`h-[7px] w-[7px] flex-none rounded-full transition-colors ${
          record.visible ? "bg-brand" : "bg-[#42544F]"
        }`}
      />
      <span className="min-w-0 flex-1 truncate text-[12px] text-text">{record.name}</span>
      <span className="font-mono text-[9px] tracking-[0.05em] text-[#4E625C]">{kindLabel}</span>
      <button
        type="button"
        onClick={onRemove}
        title="Elimina dal progetto"
        className="text-faint transition-colors hover:text-[#FF6B5A]"
      >
        <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none">
          <path
            d="M4 4l8 8M12 4l-8 8"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </div>
  );
}

function SliderRow({
  label,
  value,
  min,
  max,
  step = 1,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit: string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex flex-col gap-[5px]">
      <span className="flex items-baseline gap-2">
        <span className="flex-1 text-[12px] text-muted">{label}</span>
        <span className="font-mono text-[11px] text-[#E7EFEC]">
          {value}
          {unit}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1 w-full rounded-[3px] bg-line accent-[#3BE8B0]"
      />
    </label>
  );
}

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="flex items-center gap-2.5 text-left"
    >
      <span className="flex-1 text-[12px] text-muted">{label}</span>
      <span
        className={`flex h-[18px] w-[32px] items-center rounded-full px-[3px] transition-colors ${
          checked ? "justify-end bg-[#2C4C42]" : "justify-start bg-line"
        }`}
      >
        <span
          className={`h-3 w-3 rounded-full transition-colors ${
            checked ? "bg-brand" : "bg-[#5F726C]"
          }`}
        />
      </span>
    </button>
  );
}

function BiggestParts({ parts }: { parts: InspectComponent[] }) {
  const biggest = [...parts]
    .filter((p) => p.widthMm && p.heightMm)
    .sort((a, b) => b.widthMm! * b.heightMm! - a.widthMm! * a.heightMm!)
    .slice(0, 5);
  if (biggest.length === 0) return null;
  return (
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
  );
}

// ---------------------------------------------------------------- bom

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

// ------------------------------------------------------------------ parts

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
