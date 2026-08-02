"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * HOW FAR ALONG EVERY PART IS.
 *
 * One row per component, five checks each: the footprint compared with the
 * datasheet, the datasheet attached, the errata read, a sentence saying what
 * the part does HERE, the pins connected. Until they are all green what is
 * missing is on the screen, which is the whole point: on a board of a hundred
 * parts nobody can hold in their head which ones have been looked at.
 *
 * It is deliberately not a column in the bill of materials: that one groups by
 * identical part (thirty-five rows for ninety-eight components) because it is a
 * shopping list. This is a list of PIECES, and each piece has its own state.
 */

type Stato = "verde" | "giallo" | "rosso" | "non-applicabile";
type Voce = "footprint" | "datasheet" | "errata" | "uso" | "collegamento";

const VOCI: Voce[] = ["footprint", "datasheet", "errata", "uso", "collegamento"];
const TITOLO: Record<Voce, string> = {
  footprint: "footprint",
  datasheet: "datasheet",
  errata: "errata",
  uso: "uso qui",
  collegamento: "collegamenti",
};

interface StatoVoce {
  stato: Stato;
  dettaglio: string;
  prova?: string;
}

interface Riga {
  nome: string;
  sezione: string | null;
  ftype: string | null;
  mpn: string | null;
  package: string | null;
  pin: number;
  voci: Record<Voce, StatoVoce>;
  completo: boolean;
}

interface Quadro {
  righe: Riga[];
  completi: number;
  totale: number;
  perVoce: Record<Voce, Record<Stato, number>>;
  nota?: string;
}

/*
 * The colours already in use elsewhere: green is the app's brand, yellow the
 * warning wash, red the danger one. A dot and not a tick, so a row reads as a
 * row of states and not as a form.
 */
const COLORE: Record<Stato, string> = {
  verde: "bg-[#3BE8B0]",
  giallo: "bg-[#E8B23B]",
  rosso: "bg-[#FF6B5A]",
  "non-applicabile": "bg-[#2A3733]",
};

const ETICHETTA: Record<Stato, string> = {
  verde: "fatto",
  giallo: "da confermare",
  rosso: "da fare",
  "non-applicabile": "non serve",
};

export function StatusView({ projectId }: { projectId: string }) {
  const [quadro, setQuadro] = useState<Quadro | null>(null);
  const [errore, setErrore] = useState<string | null>(null);
  const [aperto, setAperto] = useState<string | null>(null);
  const [filtro, setFiltro] = useState<Voce | "tutti" | "mancanti">("tutti");
  const [inCorso, setInCorso] = useState<string | null>(null);

  const carica = useCallback(async () => {
    try {
      const r = await fetch(`/api/component-status?projectId=${encodeURIComponent(projectId)}`);
      const d = (await r.json()) as Quadro & { error?: string };
      if (d.error) throw new Error(d.error);
      setQuadro(d);
    } catch (e) {
      setErrore(e instanceof Error ? e.message : String(e));
    }
  }, [projectId]);

  useEffect(() => {
    // the state is set inside the promise, after the answer comes back and not
    // while the effect runs: the rule cannot tell the two apart
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void carica();
  }, [carica]);

  /*
   * The two checks the agent can do on its own: find and read the errata, and
   * write what the part does here. The others are a person's judgement — a
   * footprint is compared by somebody who looks at both drawings — so they are
   * confirmed, not delegated.
   */
  const fallo = useCallback(
    async (componente: string, voce: Voce) => {
      setInCorso(`${componente}|${voce}`);
      try {
        const url = voce === "errata" ? "/api/errata" : "/api/describe-component";
        const body =
          voce === "errata"
            ? { projectId, componente }
            : { projectId, component: componente };
        const r = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const d = (await r.json()) as { error?: string };
        if (d.error) setErrore(d.error);
        await carica();
      } catch (e) {
        setErrore(e instanceof Error ? e.message : String(e));
      } finally {
        setInCorso(null);
      }
    },
    [projectId, carica],
  );

  /** a check confirmed by hand: it is the person saying "I looked at this" */
  const conferma = useCallback(
    async (componente: string, voce: Voce, stato: "fatto" | "non-applicabile" | "da-fare") => {
      setInCorso(`${componente}|${voce}`);
      try {
        const r = await fetch("/api/component-status", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            projectId,
            componente,
            voce,
            stato,
            nota:
              stato === "non-applicabile"
                ? "segnato come non applicabile a mano"
                : "controllato a mano",
          }),
        });
        const d = (await r.json()) as Quadro & { error?: string };
        if (!d.error) setQuadro(d);
      } finally {
        setInCorso(null);
      }
    },
    [projectId],
  );

  if (errore) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <p className="max-w-md text-center text-sm leading-relaxed text-danger">{errore}</p>
      </div>
    );
  }
  if (!quadro) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-faint">
        <span className="dot dot-busy" /> Leggo lo stato dei componenti...
      </div>
    );
  }
  if (quadro.nota) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm text-faint">
        {quadro.nota}
      </div>
    );
  }

  const righe = quadro.righe.filter((r) => {
    if (filtro === "tutti") return true;
    if (filtro === "mancanti") return !r.completo;
    return r.voci[filtro].stato === "rosso" || r.voci[filtro].stato === "giallo";
  });

  return (
    <div className="h-full overflow-auto p-5">
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-[10px] border border-line bg-[#0E1513] px-3.5 py-2.5">
        <span className="text-[11px] font-semibold tracking-[0.06em] text-faint uppercase">
          Avanzamento
        </span>
        <span className="text-[12px] font-semibold text-[#C7D6D1]">
          {quadro.completi}/{quadro.totale}
          <span className="ml-1 font-normal text-faint">componenti completi</span>
        </span>
        {VOCI.map((v) => {
          const c = quadro.perVoce[v];
          const fatti = (c?.verde ?? 0) + (c?.["non-applicabile"] ?? 0);
          return (
            <button
              key={v}
              onClick={() => setFiltro(filtro === v ? "tutti" : v)}
              className={`rounded-md border px-2 py-1 text-[11px] transition-colors ${
                filtro === v
                  ? "border-[#3BE8B0] text-[#C7D6D1]"
                  : "border-line-strong text-faint hover:border-[#3BE8B0]"
              }`}
              title={`${TITOLO[v]}: ${c?.verde ?? 0} fatti, ${c?.giallo ?? 0} da confermare, ${c?.rosso ?? 0} da fare`}
            >
              {TITOLO[v]} <span className="font-semibold text-[#C7D6D1]">{fatti}</span>
              <span className="text-faint">/{quadro.totale}</span>
            </button>
          );
        })}
        <span className="flex-1" />
        <button
          onClick={() => setFiltro(filtro === "mancanti" ? "tutti" : "mancanti")}
          className={`rounded-md border px-2.5 py-1 text-[11px] font-semibold transition-colors ${
            filtro === "mancanti"
              ? "border-[#3BE8B0] text-[#C7D6D1]"
              : "border-line-strong text-[#C7D6D1] hover:border-[#3BE8B0]"
          }`}
        >
          solo quelli che mancano
        </button>
      </div>

      <table className="w-full table-fixed border-collapse text-left">
        <thead className="sticky top-0 bg-canvas">
          <tr>
            <Th width="w-[150px]">componente</Th>
            <Th width="w-[110px]">sezione</Th>
            {VOCI.map((v) => (
              <Th key={v} width="w-[92px]">
                {TITOLO[v]}
              </Th>
            ))}
            <Th>cosa manca</Th>
          </tr>
        </thead>
        <tbody>
          {righe.map((r) => {
            const primo = VOCI.map((v) => r.voci[v]).find(
              (x) => x.stato === "rosso" || x.stato === "giallo",
            );
            return (
              <tr
                key={r.nome}
                className="align-top transition-colors hover:bg-[#101A17]"
                onClick={() => setAperto(aperto === r.nome ? null : r.nome)}
              >
                <td className="cursor-pointer border-b border-line px-3 py-2 text-[12px]">
                  <div className="font-medium text-[#C7D6D1]">{r.nome}</div>
                  <div className="mt-0.5 text-[10.5px] text-faint">
                    {r.mpn ?? r.package ?? r.ftype ?? "—"}
                  </div>
                </td>
                <td className="border-b border-line px-3 py-2 text-[11px] text-faint">
                  {r.sezione ?? "—"}
                </td>
                {VOCI.map((v) => (
                  <td key={v} className="border-b border-line px-3 py-2">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        const s = r.voci[v].stato;
                        void conferma(r.nome, v, s === "verde" ? "da-fare" : "fatto");
                      }}
                      disabled={inCorso === `${r.nome}|${v}`}
                      title={`${r.voci[v].dettaglio}${r.voci[v].prova ? ` — ${r.voci[v].prova}` : ""}\n(clic: segna come ${r.voci[v].stato === "verde" ? "da fare" : "fatto"})`}
                      className="flex items-center gap-1.5 text-[10.5px] text-faint transition-opacity hover:opacity-70"
                    >
                      <span className={`h-2.5 w-2.5 rounded-full ${COLORE[r.voci[v].stato]}`} />
                      {ETICHETTA[r.voci[v].stato]}
                    </button>
                  </td>
                ))}
                <td className="border-b border-line px-3 py-2 text-[11px] leading-[1.4] text-muted">
                  {r.completo ? (
                    <span className="text-faint">niente, e&apos; completo</span>
                  ) : (
                    (primo?.dettaglio ?? "")
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {aperto && (
        <Dettaglio
          riga={quadro.righe.find((r) => r.nome === aperto)!}
          onChiudi={() => setAperto(null)}
          onSegna={(v, s) => void conferma(aperto, v, s)}
          onFallo={(v) => void fallo(aperto, v)}
        />
      )}
    </div>
  );
}

/** the five checks of one component, with the evidence behind each one */
function Dettaglio({
  riga,
  onChiudi,
  onSegna,
  onFallo,
}: {
  riga: Riga;
  onChiudi: () => void;
  onSegna: (voce: Voce, stato: "fatto" | "non-applicabile" | "da-fare") => void;
  onFallo: (voce: Voce) => void;
}) {
  return (
    <div className="mt-4 rounded-[10px] border border-line bg-[#0E1513] p-4">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[13px] font-semibold text-[#C7D6D1]">{riga.nome}</span>
        <span className="text-[11px] text-faint">
          {[riga.mpn, riga.package, `${riga.pin} piedini`].filter(Boolean).join(" · ")}
        </span>
        <span className="flex-1" />
        <button onClick={onChiudi} className="text-[11px] text-faint hover:text-[#C7D6D1]">
          chiudi
        </button>
      </div>
      <div className="flex flex-col gap-2">
        {VOCI.map((v) => (
          <div key={v} className="flex items-start gap-2.5">
            <span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${COLORE[riga.voci[v].stato]}`} />
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-semibold text-[#C7D6D1]">{TITOLO[v]}</div>
              <div className="text-[11px] leading-[1.45] text-muted">{riga.voci[v].dettaglio}</div>
              {riga.voci[v].prova && (
                <div className="mt-0.5 text-[10.5px] text-faint">{riga.voci[v].prova}</div>
              )}
            </div>
            <div className="flex shrink-0 gap-1">
              {(v === "errata" || v === "uso") && riga.voci[v].stato !== "verde" && (
                <button
                  onClick={() => onFallo(v)}
                  className="rounded border border-[#3BE8B0] px-2 py-0.5 text-[10.5px] font-semibold text-[#C7D6D1] hover:bg-[#0F1F1B]"
                >
                  fallo fare
                </button>
              )}
              <button
                onClick={() => onSegna(v, "fatto")}
                className="rounded border border-line-strong px-2 py-0.5 text-[10.5px] text-faint hover:border-[#3BE8B0] hover:text-[#C7D6D1]"
              >
                fatto
              </button>
              <button
                onClick={() => onSegna(v, "non-applicabile")}
                className="rounded border border-line-strong px-2 py-0.5 text-[10.5px] text-faint hover:border-[#3BE8B0] hover:text-[#C7D6D1]"
              >
                non serve
              </button>
              <button
                onClick={() => onSegna(v, "da-fare")}
                className="rounded border border-line-strong px-2 py-0.5 text-[10.5px] text-faint hover:border-[#FF6B5A] hover:text-[#C7D6D1]"
              >
                da fare
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Th({ children, width }: { children: React.ReactNode; width?: string }) {
  return (
    <th
      className={`border-b border-line-strong px-3 py-2 font-mono text-[10px] font-semibold tracking-[0.06em] whitespace-nowrap text-faint uppercase ${width ?? ""}`}
    >
      {children}
    </th>
  );
}
