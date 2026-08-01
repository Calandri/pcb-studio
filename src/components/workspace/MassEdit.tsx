"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Mass edit: a single place for everything that changes the board.
 *
 * Before, the commands were four buttons scattered at the bottom of the canvas
 * plus a "Ricompila ora" banner covering the drawing. The problem was not
 * the graphics: it was that each button carried its own scope inside its
 * name ("ristrada TUTTO"), so there was no way to act on a few parts, and
 * by mistake you pressed the one that redid the whole board.
 *
 * Here the scope is ONE choice at the top - the selected or the whole
 * board - and from there down every verb inherits it. Each verb has two
 * executors on the same row: "Fai" runs it with the program's rules,
 * "Chiedi" hands it to the agent, which decides how to do it by reasoning
 * about what each part does. They are the same action with two modes,
 * not two different features.
 *
 * Closed, it is a pill: the board is the thing to look at, not the commands.
 */

export type MassAction =
  | "sposta"
  | "sezioni"
  | "instrada"
  | "mancanti"
  | "massa"
  | "ricompila"
  | "fissa"
  | "sblocca";

export interface MassEditProps {
  /** the components chosen on the board, by name */
  selected: string[];
  /** how many parts the board has in total */
  total: number;
  /** how many are pinned by hand: without knowing, you cannot tell why an action does nothing */
  pinned: number;
  /** the board being shown is older than the files */
  stale: boolean;
  /** what it is doing right now, if anything */
  busy: string;
  /** how much is left, 0..1 */
  progress: number | null;
  /** seconds elapsed */
  seconds: number;
  onRun: (action: MassAction, scope: "selezionati" | "tutto") => void;
  onAsk: (action: MassAction, scope: "selezionati" | "tutto") => void;
  /** refresh geometry from the files WITHOUT touching the copper */
  onRefresh?: () => void;
  /** declare the shown board current as it is, with no refresh at all */
  onAccept?: () => void;
}

interface Verbo {
  id: MassAction;
  /** what it is called when acting on a few parts / on the whole board */
  nome: [string, string];
  spiega: [string, string];
  /** destroys hand-done work: it is declared before being pressed */
  pericoloso?: boolean;
  /** actions that cannot go wrong: soft green */
  tenue?: boolean;
  /** no point handing it to the agent */
  senzaAgente?: boolean;
  /** appears only on one scope */
  soloAmbito?: "selezionati" | "tutto";
}

const VERBI: Verbo[] = [
  {
    id: "sposta",
    nome: ["Sposta", "Sposta tutto"],
    spiega: [
      "li dispone senza toccare il rame",
      "rifà la disposizione da zero: quella fatta a mano va persa",
    ],
    pericoloso: true,
  },
  {
    id: "sezioni",
    nome: ["Dividi in sezioni", "Dividi in sezioni"],
    spiega: [
      "il modello decide la pianta, poi i pezzi si sistemano dentro",
      "il modello divide la scheda per blocchi logici e ogni pezzo va nella sua sezione: la disposizione a mano resta ferma",
    ],
    soloAmbito: "tutto",
  },
  {
    id: "instrada",
    nome: ["Instrada", "Instrada tutto"],
    spiega: ["rifà solo le loro piste", "butta il rame e lo rifà: i pezzi non si muovono"],
  },
  {
    id: "mancanti",
    nome: ["Chiudi i mancanti", "Chiudi i mancanti"],
    spiega: ["solo i collegamenti aperti", "solo i collegamenti aperti"],
    tenue: true,
  },
  {
    id: "massa",
    nome: ["Ricalcola la massa", "Ricalcola la massa"],
    spiega: ["rifà le via al piano", "rifà le via al piano"],
    tenue: true,
  },
  {
    id: "ricompila",
    nome: ["Ricompila", "Ricompila"],
    spiega: [
      "rilegge i file e mostra la scheda vera: il rame non si tocca",
      "rilegge i file e mostra la scheda vera: il rame resta quello che c'è, le piste si rifanno solo se glielo chiedi",
    ],
    tenue: true,
    soloAmbito: "tutto",
  },
  {
    id: "fissa",
    nome: ["Fissa dove sono", "Fissa tutto dov'è"],
    spiega: [
      "così nessuna azione li muove più",
      "così nessuna azione muove più niente",
    ],
    tenue: true,
    senzaAgente: true,
  },
  {
    id: "sblocca",
    nome: ["Sblocca", "Sblocca tutto"],
    spiega: ["tornano al posizionamento automatico", "tornano al posizionamento automatico"],
    tenue: true,
    senzaAgente: true,
  },
];

export function MassEdit({
  selected,
  total,
  pinned,
  stale,
  busy,
  progress,
  seconds,
  onRun,
  onAsk,
  onRefresh,
  onAccept,
}: MassEditProps) {
  const [aperto, setAperto] = useState(false);
  /*
   * The scope can be changed, but the starting value is decided by the
   * selection: if parts are chosen you work on those, otherwise on the whole
   * board. Keeping it as an explicit preference and deriving it when absent
   * avoids recomputing it inside an effect - and above all avoids the scope
   * staying "selezionati" when the selection has been emptied.
   */
  const [ambitoScelto, setAmbitoScelto] = useState<"selezionati" | "tutto" | null>(null);
  const ambito: "selezionati" | "tutto" =
    selected.length === 0
      ? "tutto"
      : (ambitoScelto ?? "selezionati");
  const setAmbito = setAmbitoScelto;

  useEffect(() => {
    if (!aperto) return;
    const chiudi = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAperto(false);
    };
    window.addEventListener("keydown", chiudi);
    return () => window.removeEventListener("keydown", chiudi);
  }, [aperto]);

  const i = ambito === "selezionati" ? 0 : 1;
  const lavora = busy !== "";
  const chiudi = useCallback(() => setAperto(false), []);

  if (!aperto) {
    return (
      <button
        type="button"
        onClick={() => setAperto(true)}
        title="Sposta, instrada, ricompila — su tutta la scheda o sui pezzi scelti"
        className="pointer-events-auto absolute bottom-[18px] left-[18px] z-20 flex items-center gap-2 rounded-[11px] border border-[#22302C] bg-[rgba(12,18,17,0.94)] px-3 py-2 text-[12.5px] font-semibold text-muted backdrop-blur transition-colors hover:border-[#2C4C42] hover:text-brand"
      >
        <Quadrati />
        Modifica massiva
        {selected.length > 0 && (
          <span className="rounded-md bg-brand-wash px-1.5 py-0.5 font-mono text-[11px] text-brand">
            {selected.length}
          </span>
        )}
        {lavora ? (
          <span className="dot dot-live" />
        ) : (
          stale && <span className="h-[7px] w-[7px] flex-none rounded-full bg-[#E8B23B]" />
        )}
      </button>
    );
  }

  return (
    <>
      {/* the veil dims the board but leaves it visible: that is what is being acted on */}
      <div
        className="pointer-events-auto absolute inset-0 z-20 bg-[rgba(4,7,6,0.55)]"
        onClick={chiudi}
      />
      <div className="pointer-events-auto absolute bottom-0 left-0 top-0 z-30 flex w-[380px] flex-col border-r border-[#22302C] bg-surface shadow-[0_12px_30px_rgba(0,0,0,0.6)]">
        <div className="flex items-center gap-2.5 border-b border-line px-3.5 py-3">
          <Quadrati acceso />
          <h3 className="text-[14px] font-semibold">Modifica massiva</h3>
          <button
            type="button"
            onClick={chiudi}
            className="ml-auto grid h-[26px] w-[26px] place-items-center rounded-[7px] border border-[#22302C] text-faint transition-colors hover:text-[#E7EFEC]"
          >
            ×
          </button>
        </div>

        <div className="flex gap-1.5 px-3.5 pb-1.5 pt-3">
          <Ambito
            attivo={ambito === "selezionati"}
            disabilitato={selected.length === 0}
            onClick={() => setAmbito("selezionati")}
            titolo="Selezionati"
            sotto={
              selected.length === 0
                ? "nessuno"
                : `${selected.length} pezz${selected.length === 1 ? "o" : "i"}: ${selected
                    .slice(0, 3)
                    .join(", ")}${selected.length > 3 ? "…" : ""}`
            }
          />
          <Ambito
            attivo={ambito === "tutto"}
            onClick={() => setAmbito("tutto")}
            titolo="Tutta la scheda"
            sotto={`${total} pezzi`}
          />
        </div>

        <div className="grid gap-1 overflow-y-auto px-3.5 pb-3.5 pt-2">
          {VERBI.filter((v) => !v.soloAmbito || v.soloAmbito === ambito).map((v) => {
            const inutile =
              (v.id === "sblocca" && pinned === 0) ||
              (v.id === "sposta" && ambito === "tutto" && pinned >= total);
            return (
              <div
                key={v.id}
                className={`grid grid-cols-[1fr_auto_auto] items-center gap-1.5 rounded-[10px] border border-transparent py-2 pl-2.5 pr-2 transition-colors ${
                  lavora || inutile ? "opacity-40" : "hover:border-[#22302C] hover:bg-white/[0.02]"
                }`}
              >
                <div className="text-[13px]">
                  {v.nome[i]}
                  <em className="mt-0.5 block text-[11.5px] not-italic text-faint">
                    {v.id === "sblocca" && pinned > 0
                      ? `${pinned} pezz${pinned === 1 ? "o" : "i"} fissat${pinned === 1 ? "o" : "i"} a mano`
                      : v.spiega[i]}
                  </em>
                </div>
                <button
                  type="button"
                  disabled={lavora || inutile}
                  onClick={() => onRun(v.id, ambito)}
                  className={`whitespace-nowrap rounded-lg border px-2.5 py-1.5 text-[12px] font-semibold transition-opacity hover:opacity-90 disabled:cursor-not-allowed ${
                    v.pericoloso && ambito === "tutto"
                      ? "border-[#E8B23B] bg-[#E8B23B] text-[#1A1206]"
                      : v.tenue
                        ? "border-[#22302C] bg-transparent text-brand"
                        : "border-brand bg-brand text-ink"
                  }`}
                >
                  Fai
                </button>
                {v.senzaAgente ? (
                  <span className="w-[62px]" />
                ) : (
                  <button
                    type="button"
                    disabled={lavora || inutile}
                    onClick={() => onAsk(v.id, ambito)}
                    title="Lo affida all'agente, che decide come farlo"
                    className="w-[62px] whitespace-nowrap rounded-lg border border-[#24384F] bg-transparent px-2.5 py-1.5 text-[12px] font-semibold text-[#7FB4FF] transition-opacity hover:opacity-90 disabled:cursor-not-allowed"
                  >
                    Chiedi
                  </button>
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-auto flex items-center gap-2 border-t border-line px-3.5 py-2.5 text-[12px] text-muted">
          {lavora ? (
            <>
              <span className="dot dot-live" />
              <span className="text-[#E8B23B]">{busy}</span>
              <span className="font-mono">
                {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
              </span>
            </>
          ) : stale ? (
            <>
              <span className="h-[7px] w-[7px] flex-none rounded-full bg-[#E8B23B]" />
              La scheda è più vecchia dei file
              {onRefresh && (
                <button
                  type="button"
                  onClick={onRefresh}
                  title="Rilegge i file e mostra componenti e collegamenti nuovi SENZA rifare il rame: quello lo decidi tu dopo"
                  className="font-semibold text-brand underline underline-offset-2"
                >
                  aggiorna, rame intatto
                </button>
              )}
              {onAccept && (
                <button
                  type="button"
                  onClick={onAccept}
                  title="Tiene la scheda che vedi così com'è e ci lavori sopra, senza rileggere i file"
                  className="text-muted underline underline-offset-2 transition-colors hover:text-text"
                >
                  lavora su questa
                </button>
              )}
              <button
                type="button"
                onClick={() => onRun("ricompila", "tutto")}
                title="Ricompila tutto: rilegge i file e rifà anche il rame (i componenti non si muovono)"
                className="text-muted underline underline-offset-2 transition-colors hover:text-text"
              >
                ricompila
              </button>
            </>
          ) : (
            <>
              <span className="h-[7px] w-[7px] flex-none rounded-full bg-brand" />
              La scheda corrisponde ai file
            </>
          )}
        </div>
        {lavora && (
          <div className="h-[3px] w-full bg-[#122620]">
            <div
              className="h-full bg-brand transition-[width] duration-500"
              style={{ width: `${Math.round((progress ?? 0.04) * 100)}%` }}
            />
          </div>
        )}
      </div>
    </>
  );
}

function Ambito({
  attivo,
  disabilitato,
  onClick,
  titolo,
  sotto,
}: {
  attivo: boolean;
  disabilitato?: boolean;
  onClick: () => void;
  titolo: string;
  sotto: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={attivo}
      disabled={disabilitato}
      onClick={onClick}
      className={`flex-1 rounded-[9px] border px-2.5 py-2 text-left text-[12.5px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        attivo
          ? "border-[#2C4C42] bg-brand-wash text-brand"
          : "border-[#22302C] bg-transparent text-muted"
      }`}
    >
      {titolo}
      <span
        className={`mt-1 block truncate text-[11px] font-normal ${attivo ? "text-[#6FBFA2]" : "text-faint"}`}
      >
        {sotto}
      </span>
    </button>
  );
}

/** four squares: the idea of acting on many things together */
function Quadrati({ acceso }: { acceso?: boolean }) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 15 15"
      fill="none"
      stroke={acceso ? "var(--brand)" : "currentColor"}
      strokeWidth="1.3"
      className="flex-none"
    >
      <rect x="1.5" y="1.5" width="5" height="5" rx="1" />
      <rect x="8.5" y="1.5" width="5" height="5" rx="1" />
      <rect x="1.5" y="8.5" width="5" height="5" rx="1" />
      <rect x="8.5" y="8.5" width="5" height="5" rx="1" />
    </svg>
  );
}
