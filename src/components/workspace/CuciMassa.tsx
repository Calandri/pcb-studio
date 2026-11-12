"use client";

import { useEffect, useRef, useState } from "react";
import { postJson } from "../post-json";

/**
 * "Cuci la massa" in the viewer: the stitch_ground tool with a pitch, its
 * proposal drawn on the board as dots, and a confirmation that writes
 * cucitura-massa.tsx (ground-stitching-tool.ts). An explicit action and
 * nothing else: it never compiles, the page only marks the board as older
 * than the files, and main.tsx is not touched (the two lines to add are
 * shown when it does not use the file yet).
 */

export type TipoViaCucitura = "isola" | "bordo" | "griglia";

/** what the board draws while the proposal is open (BoardCanvas anteprimaVie) */
export interface AnteprimaCucitura {
  punti: Array<{ x: number; y: number; colore: string }>;
  /** the ring of the vias, to draw them at their size */
  diametroMm: number;
}

/** the answer of the tool, as far as this panel reads it */
interface Risposta {
  error?: string;
  vie?: number;
  via?: { foroMm: number; coronaMm: number };
  passoMm?: number;
  copreFinoGHz?: number;
  conteggio?: Record<TipoViaCucitura, number>;
  coordinate?: Record<TipoViaCucitura, Array<[number, number]>>;
  scarti?: Record<string, number>;
  perche?: Record<string, string>;
  isole?: { trovate: number; collegate: number; senzaPosto: number };
  /** the keepouts of the board: how many positions they excluded, and how many of those had a place otherwise */
  keepout?: { modo: ModoKeepout; posizioni: number; conPosto: number; zone: number };
  avvisi?: string[];
  main?: { usaIlFile: boolean; righeDaAggiungere?: string[] };
  /** false: the file cannot be written as things stand, and why (a board older than the files, a file that is not the tool's) */
  scrivibile?: boolean;
  nonScrivibile?: string[];
  /** the fingerprint of the file this proposal would write: the write carries it back, and writes nothing else */
  impronta?: string;
  scritto?: boolean;
  fileChanged?: { path: string; content: string };
}

const PASSO_DI_SERIE = 2.5;

type ModoKeepout = "tutti" | "solo_rame";
/** what a proposal was asked with: the write asks the same */
interface Chiesto {
  passoMm: number;
  keepout: ModoKeepout;
}

/** the colours of the dots, by kind of via */
const COLORI: Record<TipoViaCucitura, string> = {
  isola: "#FFB020",
  bordo: "#4FC3F7",
  griglia: "#3DDC97",
};

export function CuciMassa({
  projectId,
  onAnteprima,
  onScritto,
  onChiudi,
}: {
  projectId: string;
  onAnteprima: (a: AnteprimaCucitura | null) => void;
  /** the file was written: the page takes it into its files and marks the board as older */
  onScritto: (path: string, content: string) => void;
  onChiudi: () => void;
}) {
  const [passo, setPasso] = useState(String(PASSO_DI_SERIE));
  /*
   * The keepouts of the board all count unless the person says otherwise: a
   * height zone with ground poured under it is a keepout too, and whether vias
   * may stand there is theirs to decide (off by default).
   */
  const [soloRame, setSoloRame] = useState(false);
  const [risposta, setRisposta] = useState<Risposta | null>(null);
  /** what the proposal on screen was asked with: what is written */
  const [visto, setVisto] = useState<Chiesto | null>(null);
  const [lavora, setLavora] = useState<"" | "anteprima" | "scrivo">("");
  const [errore, setErrore] = useState<string | null>(null);
  const [scritto, setScritto] = useState<Risposta | null>(null);
  /*
   * The dots go with the panel: leaving the board's tab unmounts it, and dots
   * left on the board with no panel to explain them would look like vias.
   */
  const togliAnteprima = useRef(onAnteprima);
  useEffect(() => {
    togliAnteprima.current = onAnteprima;
  }, [onAnteprima]);
  useEffect(() => () => togliAnteprima.current(null), []);

  const numero = Number(passo.replace(",", "."));
  const passoValido = Number.isFinite(numero) && numero >= 1 && numero <= 10;

  /** a look, or with `impronta` the write of what a look showed */
  const chiedi = async (chiesto: Chiesto, impronta?: string): Promise<Risposta | null> => {
    const { data, error } = await postJson("/api/stitch-ground", {
      projectId,
      passoMm: chiesto.passoMm,
      ...(chiesto.keepout === "solo_rame" ? { keepout: chiesto.keepout } : {}),
      ...(impronta ? { apply: true, impronta } : {}),
    });
    if (error || !data) {
      setErrore(error ?? "risposta vuota");
      return null;
    }
    return data as Risposta;
  };

  const anteprima = async () => {
    if (!passoValido) return;
    setLavora("anteprima");
    setErrore(null);
    setScritto(null);
    try {
      const chiesto: Chiesto = { passoMm: numero, keepout: soloRame ? "solo_rame" : "tutti" };
      const r = await chiedi(chiesto);
      setRisposta(r);
      setVisto(r ? chiesto : null);
      onAnteprima(
        r?.coordinate && r.via
          ? {
              diametroMm: r.via.coronaMm,
              punti: (Object.keys(r.coordinate) as TipoViaCucitura[]).flatMap((tipo) =>
                r.coordinate![tipo].map(([x, y]) => ({ x, y, colore: COLORI[tipo] })),
              ),
            }
          : null,
      );
    } finally {
      setLavora("");
    }
  };

  const scrivi = async () => {
    if (visto === null || !risposta?.impronta) return;
    setLavora("scrivo");
    setErrore(null);
    try {
      /*
       * The server computes the vias again and writes only if they are the
       * ones on screen (the fingerprint): the board compiled in between, or a
       * file changed, and it answers "rifai l'anteprima" instead of writing
       * other vias than the ones shown.
       */
      const r = await chiedi(visto, risposta.impronta);
      if (r?.fileChanged) {
        onScritto(r.fileChanged.path, r.fileChanged.content);
        setScritto(r);
      } else if (r) {
        setErrore("nessun file scritto: nessuna via da scrivere");
      } else {
        // refused: the dots on the board are not what would be written any more, the reason stays on the panel
        setRisposta(null);
        setVisto(null);
        onAnteprima(null);
      }
    } finally {
      setLavora("");
    }
  };

  const chiudi = () => {
    onAnteprima(null);
    onChiudi();
  };

  /** the dots on the board are of what was asked before: gone until the next preview */
  const cambiato = () => {
    if (!risposta) return;
    setRisposta(null);
    setVisto(null);
    onAnteprima(null);
  };

  const scarti = Object.entries(risposta?.scarti ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4);

  return (
    <div className="pointer-events-auto absolute bottom-[76px] left-[18px] z-30 w-[360px] rounded-[14px] border border-[#22302C] bg-surface shadow-[0_12px_30px_rgba(0,0,0,0.6)]">
      <div className="flex items-center gap-2.5 border-b border-line px-3.5 py-3">
        <span className="h-2 w-2 flex-none rounded-full bg-[#3DDC97]" />
        <h3 className="text-[14px] font-semibold">Cuci la massa</h3>
        <button
          type="button"
          onClick={chiudi}
          className="ml-auto grid h-[26px] w-[26px] place-items-center rounded-[7px] border border-[#22302C] text-faint transition-colors hover:text-[#E7EFEC]"
        >
          ×
        </button>
      </div>
      <div className="grid gap-2.5 px-3.5 py-3 text-[12px] text-muted">
        <p className="leading-snug">
          Vie di massa a passo regolare, solo dove la massa copre la corona su due strati, fuori da piazzole, ingombri,
          serigrafia e zone senza rame di ogni strato. Passo massimo lambda/20: 2,5 mm copre fino a circa 2,9 GHz in FR4. Prima
          l&apos;anteprima, poi si scrivono le vie viste in <code className="font-mono text-[11px]">cucitura-massa.tsx</code>. Non
          compila.
        </p>
        <label className="flex items-center gap-2">
          Passo
          <input
            type="number"
            min={1}
            max={10}
            step={0.5}
            value={passo}
            onChange={(e) => {
              setPasso(e.target.value);
              cambiato();
            }}
            className="w-[72px] rounded-md border border-[#22302C] bg-transparent px-2 py-1 font-mono text-[12px] text-text"
          />
          mm
          <button
            type="button"
            onClick={() => void anteprima()}
            disabled={!passoValido || lavora !== ""}
            className="ml-auto rounded-lg border border-[#22302C] px-2.5 py-1.5 text-[12px] font-semibold text-brand transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {lavora === "anteprima" ? "Calcolo…" : "Anteprima"}
          </button>
        </label>
        {!passoValido && <span className="text-[#E8B23B]">il passo va da 1 a 10 mm</span>}
        <label className="flex items-start gap-2 leading-snug">
          <input
            type="checkbox"
            checked={soloRame}
            onChange={(e) => {
              setSoloRame(e.target.checked);
              cambiato();
            }}
            className="mt-0.5"
          />
          <span>
            {risposta?.keepout
              ? `Zone vietate (keepout): ${risposta.keepout.posizioni} posizioni escluse, ${risposta.keepout.conPosto} avevano posto. `
              : "Zone vietate (keepout): contano tutte. "}
            Ignora quelle con la massa colata sotto su tutti i loro strati (zone d&apos;altezza).
          </span>
        </label>
        {errore && <span className="text-[#FF6B5A]">{errore}</span>}

        {risposta && risposta.vie !== undefined && (
          <div className="grid gap-1.5 rounded-[10px] border border-[#1F2C29] px-2.5 py-2">
            <div className="text-[13px] text-text">
              {risposta.vie} vie proposte
              {risposta.conteggio && (
                <span className="text-faint">
                  {" "}
                  (isole {risposta.conteggio.isola}, bordo {risposta.conteggio.bordo}, griglia {risposta.conteggio.griglia})
                </span>
              )}
            </div>
            <div className="flex gap-3 text-[11px]">
              <Legenda colore={COLORI.isola} testo="isola" />
              <Legenda colore={COLORI.bordo} testo="bordo" />
              <Legenda colore={COLORI.griglia} testo="griglia" />
            </div>
            {risposta.isole && risposta.isole.trovate > 0 && (
              <div>
                Isole di massa staccate: {risposta.isole.trovate}, collegate {risposta.isole.collegate}, senza posto{" "}
                {risposta.isole.senzaPosto}
              </div>
            )}
            {scarti.length > 0 && (
              <ul className="grid gap-0.5 text-[11px] text-faint">
                {scarti.map(([motivo, quante]) => (
                  <li key={motivo}>
                    {quante} scartate: {risposta.perche?.[motivo] ?? motivo}
                  </li>
                ))}
              </ul>
            )}
            {/* why it cannot be written: the button below is off for these */}
            {(risposta.nonScrivibile ?? []).map((m) => (
              <span key={m} className="text-[#FF6B5A]">
                Non si puo&apos; scrivere: {m}.
              </span>
            ))}
            {(risposta.avvisi ?? []).map((a) => (
              <span key={a} className="text-[#E8B23B]">
                {a}
              </span>
            ))}
          </div>
        )}

        {scritto ? (
          <div className="grid gap-1.5 rounded-[10px] border border-[#2C4C42] bg-brand-wash px-2.5 py-2 text-[#9DB8AC]">
            <span>Scritto cucitura-massa.tsx: la scheda e&apos; da aggiornare (ricompila quando vuoi).</span>
            {scritto.main && !scritto.main.usaIlFile && (
              <>
                <span>main.tsx non lo usa ancora: aggiungi tu queste righe (main.tsx non si tocca da solo).</span>
                {(scritto.main.righeDaAggiungere ?? []).map((r) => (
                  <code key={r} className="block select-all rounded bg-[rgba(0,0,0,0.3)] px-1.5 py-1 font-mono text-[11px] text-text">
                    {r}
                  </code>
                ))}
              </>
            )}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => void scrivi()}
            disabled={visto === null || !risposta?.vie || !risposta.impronta || risposta.scrivibile === false || lavora !== ""}
            title={risposta?.scrivibile === false ? (risposta.nonScrivibile ?? []).join(" ") : undefined}
            className="rounded-lg border border-brand bg-brand px-2.5 py-1.5 text-[12px] font-semibold text-ink transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {lavora === "scrivo" ? "Scrivo…" : `Scrivi ${risposta?.vie ?? 0} vie in cucitura-massa.tsx`}
          </button>
        )}
      </div>
    </div>
  );
}

function Legenda({ colore, testo }: { colore: string; testo: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className="h-2 w-2 rounded-full" style={{ background: colore }} />
      {testo}
    </span>
  );
}
