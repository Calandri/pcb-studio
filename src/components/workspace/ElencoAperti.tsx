"use client";

import { useState } from "react";
import { millimetri } from "@/lib/board-report";
import type { CollegamentoAperto } from "@/lib/open-connections";
import { nomeDelloStrato } from "@/lib/strati-rame";
import { COLORE_APERTO, type StatoAperti } from "../board/CollegamentiAperti";

/** the open connections of one net, as the list shows them */
export interface VoceDiRete {
  rete: string;
  /** the net's name, or its two pins when it has none */
  titolo: string;
  tratti: CollegamentoAperto[];
}

/**
 * The list, net by net: the nets with one missing segment first, the ones
 * with many (a ground with no plane yet) last, each in the order its tree was
 * built. The few are the ones somebody forgot; the many are a job of its own.
 */
export function vociPerRete(collegamenti: CollegamentoAperto[]): VoceDiRete[] {
  const perRete = new Map<string, VoceDiRete>();
  for (const c of collegamenti) {
    const voce = perRete.get(c.rete);
    if (voce) voce.tratti.push(c);
    else {
      perRete.set(c.rete, {
        rete: c.rete,
        titolo: c.nome || `${c.da.piedino} > ${c.a.piedino}`,
        tratti: [c],
      });
    }
  }
  return [...perRete.values()].sort((a, b) => a.tratti.length - b.tratti.length || a.titolo.localeCompare(b.titolo));
}

/** the face of one end, as a person reads it; a through hole is on every face */
const faccia = (strato: string | null) => (strato === null ? "passante" : nomeDelloStrato(strato));

/** "Top", or "Top → Bottom" when the two ends are on two faces */
export function facceDelTratto(c: Pick<CollegamentoAperto, "da" | "a">): string {
  return c.da.strato === c.a.strato ? faccia(c.da.strato) : `${faccia(c.da.strato)} → ${faccia(c.a.strato)}`;
}

/**
 * What the panel says about them. The first line is how many, in how many
 * nets ("87 in 5 reti"), under the words "Collegamenti aperti". The check
 * counts the same nets from the same segments (route-score.ts): when its saved
 * number is another, the saved check is not of this board or was made before
 * the pours were measured, and a second line says so.
 */
export function riassuntoAperti(collegamenti: CollegamentoAperto[], dichiarati: number): string[] {
  const voci = vociPerRete(collegamenti);
  const n = collegamenti.length;
  const righe = [n === 1 ? "1" : `${n} in ${voci.length} ${voci.length === 1 ? "rete" : "reti"}`];
  if (dichiarati !== voci.length) {
    righe.push(`Il controllo salvato conta ${dichiarati} ${dichiarati === 1 ? "rete aperta" : "reti aperte"}: ricontrolla la scheda`);
  }
  return righe;
}

/**
 * "Collegamenti aperti" in the panel: the counter is a switch that puts them on
 * the board in every view, and under it the list (net, the two pins); a click
 * on one brings the board there and lights it.
 */
export function ElencoAperti({ aperti, dichiarati }: { aperti: StatoAperti; dichiarati: number }) {
  const { elenco, accesi, setAccesi, scelto, scegli } = aperti;
  const [aperta, setAperta] = useState<string | null>(null);
  const voci = vociPerRete(elenco.collegamenti);
  const [quanti, ...note] = riassuntoAperti(elenco.collegamenti, dichiarati);

  const riga = (c: CollegamentoAperto, conNome: boolean) => {
    const evidente = scelto?.id === c.id;
    return (
      <button
        key={c.id}
        type="button"
        onClick={() => scegli(c.id)}
        title="Porta la scheda su questo collegamento e lo evidenzia"
        className="flex flex-col gap-0.5 rounded-lg border px-2.5 py-1.5 text-left transition-colors hover:border-[#5A3A55]"
        style={{
          background: evidente ? "rgba(255,79,224,0.10)" : "#0F0D10",
          borderColor: evidente ? COLORE_APERTO : "#2A2029",
        }}
      >
        {conNome && (
          <span className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-[11.5px] font-semibold text-[#E6D7E4]">{c.nome || "senza nome"}</span>
            <span className="flex-none font-mono text-[10px] text-faint">{millimetri(c.lunghezzaMm, 1)} mm</span>
          </span>
        )}
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-[#C7B6C5]">
            {c.da.piedino} → {c.a.piedino}
          </span>
          <span className="flex-none text-[10px] text-faint">
            {facceDelTratto(c)}
            {!conNome && ` · ${millimetri(c.lunghezzaMm, 1)} mm`}
          </span>
        </span>
      </button>
    );
  };

  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        aria-pressed={accesi}
        onClick={() => setAccesi(!accesi)}
        title={
          accesi
            ? "Toglie i collegamenti aperti dalla scheda (restano nella vista Collegamenti mancanti)"
            : "Mostra sulla scheda i collegamenti aperti, in ogni vista, e il loro elenco"
        }
        className="flex items-center gap-2.5 rounded-[11px] px-3 py-2.5 text-left transition-colors"
        style={{ background: "#120E0E", border: `1px solid ${accesi ? COLORE_APERTO : "#33201E"}` }}
      >
        <span
          className="grid h-4 w-4 place-items-center rounded-[5px] text-[9px]"
          style={{ background: "#241413", border: "1px solid #4A2622", color: "#FF6B5A" }}
        >
          !
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-[12px] text-[#D7B4AF]">Collegamenti aperti</span>
          <span className="font-mono text-[10px] text-[#FF6B5A]">{quanti}</span>
        </span>
        {/* the switch: on = drawn on the board */}
        <span
          aria-hidden
          className="relative h-[12px] w-[22px] flex-none rounded-full transition-colors"
          style={{ background: accesi ? COLORE_APERTO : "#3A2C2A" }}
        >
          <span
            className="absolute top-[2px] h-[8px] w-[8px] rounded-full bg-[#0B1110] transition-all"
            style={{ left: accesi ? 12 : 2 }}
          />
        </span>
      </button>

      {accesi && (
        <div className="flex flex-col gap-1.5 pl-1">
          {note.map((testo) => (
            <span key={testo} className="text-[10.5px] leading-[1.35] text-faint">
              {testo}
            </span>
          ))}
          {voci.map((v) =>
            v.tratti.length === 1 ? (
              riga(v.tratti[0], true)
            ) : (
              <div key={v.rete} className="flex flex-col gap-1">
                <button
                  type="button"
                  aria-expanded={aperta === v.rete}
                  onClick={() => setAperta(aperta === v.rete ? null : v.rete)}
                  title={`I ${v.tratti.length} collegamenti aperti di questa rete`}
                  className="flex items-baseline gap-2 rounded-lg border border-[#2A2029] bg-[#0F0D10] px-2.5 py-1.5 text-left transition-colors hover:border-[#5A3A55]"
                >
                  <span className="min-w-0 flex-1 truncate text-[11.5px] font-semibold text-[#E6D7E4]">{v.titolo}</span>
                  <span className="flex-none font-mono text-[10px] text-faint">
                    {v.tratti.length} {aperta === v.rete ? "▾" : "▸"}
                  </span>
                </button>
                {aperta === v.rete && (
                  <div className="flex max-h-[260px] flex-col gap-1 overflow-auto pl-2">{v.tratti.map((c) => riga(c, false))}</div>
                )}
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}
