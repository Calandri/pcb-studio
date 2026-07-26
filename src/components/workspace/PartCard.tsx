"use client";

import type { InspectComponent } from "@/lib/inspect";

/**
 * Scheda del componente scelto, in basso a destra sopra la scheda: sigla,
 * contenitore, a cosa serve, quanti piedini e quante reti tocca, piu' il link
 * alla scheda tecnica del fornitore.
 */
export function PartCard({
  part,
  onClose,
  onAsk,
}: {
  part: InspectComponent;
  onClose: () => void;
  onAsk: (prompt: string) => void;
}) {
  return (
    <div className="absolute right-[18px] bottom-[18px] w-[248px] rounded-[14px] border border-[#2C4C42] bg-[rgba(9,14,13,0.92)] px-3.5 py-[13px] shadow-[0_20px_50px_-20px_rgba(0,0,0,0.8)] backdrop-blur">
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[15px] font-semibold text-brand">{part.name}</span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-[#6E827C]">
          {part.footprint ??
            (part.widthMm && part.heightMm
              ? `${part.widthMm} × ${part.heightMm} mm`
              : "ingombro non noto")}
        </span>
        <button
          type="button"
          onClick={onClose}
          title="Chiudi"
          className="text-faint transition-colors hover:text-text"
        >
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <p className="mt-2 text-[11.5px] leading-[1.4] text-[#A8B9B4]">
        {[part.ftype, part.value].filter(Boolean).join(" · ") || "Componente della scheda"}
        {part.layer ? ` · ${part.layer === "top" ? "lato componenti" : "lato saldature"}` : ""}
      </p>

      <div className="mt-2.5 flex gap-1.5">
        <Stat value={part.pins} label="PIEDINI" />
        <Stat value={part.nets.length} label="NET" />
      </div>

      {part.supplier && (
        <div className="mt-2.5 flex items-center gap-2">
          <span className="font-mono text-[11px] text-muted">{part.supplier}</span>
          {part.datasheetUrl && (
            <a
              href={part.datasheetUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="text-[11px] font-semibold text-brand underline-offset-2 hover:underline"
            >
              scheda tecnica
            </a>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={() => onAsk(`Parlami di ${part.name}: cosa fa nel circuito e come è collegato.`)}
        className="mt-2.5 w-full rounded-lg border border-line-strong px-2.5 py-1.5 text-[11px] text-muted transition-colors hover:border-[#3A5A50] hover:text-text"
      >
        Chiedi al copilota
      </button>
    </div>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="flex-1 rounded-[9px] border border-line bg-[#0E1615] px-2 py-[7px]">
      <div className="font-mono text-[12px] text-[#E7EFEC]">{value}</div>
      <div className="text-[9px] tracking-[0.05em] text-[#5F726C]">{label}</div>
    </div>
  );
}
