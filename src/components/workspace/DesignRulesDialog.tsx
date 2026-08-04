"use client";

import { useEffect, useState } from "react";
import type { ClassiRame } from "@/lib/classi-rame";
import { COPPIE, type ChiaveCoppia, type DesignRules } from "@/lib/design-rules";

/**
 * Board fabrication rules.
 *
 * They used to be one constant shared by every project: routing and checks
 * always ran against the standard JLCPCB minimums, even when ordering
 * elsewhere. Here you pick the supplier (or write your own minimums) and the
 * choice lives in the project.
 *
 * Changing the rules changes the COPPER, not just the check: the router plans
 * traces and vias against those minimums. That is why the panel states clearly
 * that a recompile is needed, instead of making it look like a display
 * preference.
 */

interface Preset {
  key: string;
  label: string;
  costTier: number;
  rules: DesignRules;
}

interface Current {
  preset: string;
  label: string;
  isCustom: boolean;
  rules: DesignRules;
}

type CampoNumerico = Exclude<keyof DesignRules, "clearanceByPairMm">;

const FIELDS: Array<{
  key: CampoNumerico;
  label: string;
  hint: string;
  /** vuoto = vale la distanza minima generale */
  puoEsserVuoto?: boolean;
}> = [
  { key: "minTraceWidthMm", label: "Pista minima", hint: "la pista piu' sottile che il fornitore incide" },
  { key: "minClearanceMm", label: "Distanza minima", hint: "rame-rame fra net diverse" },
  { key: "minBoardEdgeClearanceMm", label: "Margine dal bordo", hint: "quanto il rame sta lontano dal taglio" },
  { key: "minViaHoleMm", label: "Foro via minimo", hint: "diametro della punta piu' piccola" },
  { key: "minViaDiameterMm", label: "Pad via minimo", hint: "corona attorno al foro" },
  { key: "minHoleToHoleMm", label: "Foro-foro", hint: "fra due punte, che e' quello che rompe la scheda" },
  {
    key: "pourClearanceMm",
    label: "Distanza della colata",
    hint: "quanto il piano sta lontano dalle altre net: si tiene piu' largo di una pista",
    puoEsserVuoto: true,
  },
];

/*
 * MILLIMETRI O MILS.
 *
 * Le regole si salvano SEMPRE in millimetri: il pollice sta nella casella, non
 * nel file, altrimenti un progetto aperto con l'unita' sbagliata cambierebbe
 * scheda da solo. Un mil e' un millesimo di pollice, cioe' 0.0254mm, ed e'
 * l'unita' in cui i fornitori quotano e in cui questa scheda e' disegnata: 6
 * mil di distanza, 10 mil di colata, numeri tondi che in millimetri sono
 * 0.1524 e 0.254.
 */
const MIL = 0.0254;
const inUnita = (mm: number | undefined, unita: "mm" | "mil"): string => {
  if (mm === undefined || !Number.isFinite(mm)) return "";
  const v = unita === "mm" ? mm : mm / MIL;
  return String(Number(v.toFixed(unita === "mm" ? 4 : 2)));
};
const inMm = (testo: string, unita: "mm" | "mil"): number =>
  unita === "mm" ? Number(testo) : Number(testo) * MIL;

export function DesignRulesDialog({
  projectId,
  onClose,
  onSaved,
}: {
  projectId: string;
  onClose: () => void;
  /** called after saving: it is up to the caller to decide whether to recompile */
  onSaved: () => void;
}) {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [current, setCurrent] = useState<Current | null>(null);
  const [choice, setChoice] = useState<string>("");
  const [custom, setCustom] = useState<DesignRules | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unita, setUnita] = useState<"mm" | "mil">("mm");
  /*
   * LE CLASSI DEL RAME: le misure che questa scheda usa davvero, contate. Una
   * regola di fabbricazione dice cosa il fornitore riesce a fare e non tocca il
   * rame; una classe E' il rame, e cambiarla lo riscrive. Sono due cose diverse
   * e stanno in due riquadri diversi, con due bottoni diversi.
   */
  const [classi, setClassi] = useState<ClassiRame | null>(null);
  const [nuove, setNuove] = useState<ClassiRame | null>(null);
  const [applico, setApplico] = useState(false);
  const [esito, setEsito] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/design-rules?projectId=${encodeURIComponent(projectId)}`)
      .then((r) => r.json())
      .then((d) => {
        if (!d?.current) return;
        setPresets(d.presets ?? []);
        setCurrent(d.current);
        setChoice(d.current.preset);
        setCustom(d.current.rules);
      })
      .catch(() => setError("non riesco a leggere le regole del progetto"));
    fetch(`/api/copper-classes?projectId=${encodeURIComponent(projectId)}`)
      .then((r) => r.json())
      .then((d) => {
        if (!d?.classi) return;
        setClassi(d.classi);
        setNuove(structuredClone(d.classi));
      })
      .catch(() => undefined);
  }, [projectId]);

  /** quanti pezzi sposterebbe l'applicazione, per dirlo prima di farla */
  const daSpostare = (() => {
    if (!classi || !nuove) return { via: 0, piste: 0 };
    let via = 0;
    let piste = 0;
    classi.via.forEach((c, i) => {
      const n = nuove.via[i];
      if (n && (n.foroMm !== c.foroMm || n.padMm !== c.padMm)) via += c.quante;
    });
    classi.piste.forEach((c, i) => {
      const n = nuove.piste[i];
      if (n && n.larghezzaMm !== c.larghezzaMm) piste += c.quanti;
    });
    return { via, piste };
  })();

  const applica = async () => {
    if (!classi || !nuove) return;
    setApplico(true);
    setError(null);
    try {
      const res = await fetch("/api/copper-classes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId,
          via: classi.via
            .map((c, i) => ({ da: { padMm: c.padMm, foroMm: c.foroMm }, a: nuove.via[i] }))
            .filter((x) => x.a && (x.a.padMm !== x.da.padMm || x.a.foroMm !== x.da.foroMm))
            .map((x) => ({ da: x.da, a: { padMm: x.a.padMm, foroMm: x.a.foroMm } })),
          piste: classi.piste
            .map((c, i) => ({ daMm: c.larghezzaMm, aMm: nuove.piste[i]?.larghezzaMm }))
            .filter((x) => x.aMm !== undefined && x.aMm !== x.daMm),
        }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
      setClassi(d.classi);
      setNuove(structuredClone(d.classi));
      setEsito(`${d.viaCambiate} via e ${d.pisteCambiate} piste aggiornate, ricompilo`);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setApplico(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/design-rules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId,
          preset: choice,
          ...(choice === "custom" ? { rules: custom } : {}),
        }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const changed =
    current !== null &&
    (choice !== current.preset ||
      (choice === "custom" &&
        JSON.stringify(custom) !== JSON.stringify(current.rules)));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(4,7,6,0.7)] backdrop-blur-[2px]">
      <div className="card flex max-h-[88vh] w-[680px] max-w-[94vw] flex-col p-5">
        <div className="flex flex-none items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-bold text-text">Regole di fabbricazione</h2>
            <p className="mt-1 text-[12px] leading-relaxed text-muted">
              Valgono per questa scheda. Non sono solo un controllo: il router pianifica
              piste e via su questi minimi, quindi cambiarle cambia il rame.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            title="Chiudi"
            className="flex-none text-faint transition-colors hover:text-text"
          >
            <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* la parte che scorre: i preset e i campi. Titolo e bottoni restano
            fermi, perche' un pannello che cresce fino a uscire dallo schermo
            porta il bottone Salva fuori dalla finestra */}
        <div className="-mr-2 mt-4 min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-2">
          {presets.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => {
                setChoice(p.key);
                setCustom(p.rules);
              }}
              className={`flex w-full items-center gap-3 rounded-[10px] border px-3.5 py-2.5 text-left transition-colors ${
                choice === p.key
                  ? "border-brand bg-brand-wash"
                  : "border-line hover:border-[#3A5A50]"
              }`}
            >
              <span className="flex-1 text-[13px] font-semibold text-text">{p.label}</span>
              <span className="font-mono text-[10px] text-faint">
                pista {p.rules.minTraceWidthMm} · via {p.rules.minViaHoleMm}
              </span>
              <span className="font-mono text-[10px] text-[#5F726C]">
                {"€".repeat(p.costTier)}
              </span>
            </button>
          ))}
          <button
            type="button"
            onClick={() => setChoice("custom")}
            className={`flex w-full items-center rounded-[10px] border px-3.5 py-2.5 text-left transition-colors ${
              choice === "custom" ? "border-brand bg-brand-wash" : "border-line hover:border-[#3A5A50]"
            }`}
          >
            <span className="flex-1 text-[13px] font-semibold text-text">
              Minimi del mio fornitore
            </span>
            <span className="text-[11px] text-faint">valori a mano</span>
          </button>

        {choice === "custom" && custom && (
          <div className="mt-3 space-y-2 rounded-[10px] border border-line p-3">
            {/* millimetri o mils: cambia solo quello che si legge e si scrive,
                il progetto resta sempre in millimetri */}
            <div className="mb-1 flex items-center gap-2">
              <span className="flex-1 text-[11px] text-faint">
                Unita&apos; con cui scrivere questi numeri
              </span>
              <div className="flex overflow-hidden rounded-[7px] border border-line">
                {(["mm", "mil"] as const).map((u) => (
                  <button
                    key={u}
                    type="button"
                    onClick={() => setUnita(u)}
                    className={`px-2.5 py-1 font-mono text-[11px] transition-colors ${
                      unita === u ? "bg-brand text-ink" : "text-muted hover:text-text"
                    }`}
                  >
                    {u}
                  </button>
                ))}
              </div>
            </div>
            {FIELDS.map((f) => (
              <label key={f.key} className="flex items-center gap-3">
                <span className="min-w-0 flex-1">
                  <span className="block text-[12px] text-text">{f.label}</span>
                  <span className="block text-[10px] text-faint">{f.hint}</span>
                </span>
                <input
                  type="number"
                  step={unita === "mm" ? "0.001" : "0.1"}
                  min={unita === "mm" ? "0.05" : "2"}
                  /* la distanza della colata puo' restare vuota: vale la generale */
                  placeholder={f.puoEsserVuoto ? inUnita(custom.minClearanceMm, unita) : undefined}
                  value={inUnita(custom[f.key], unita)}
                  onChange={(e) => {
                    const v = e.target.value.trim();
                    setCustom({
                      ...custom,
                      [f.key]: v === "" ? undefined : inMm(v, unita),
                    });
                  }}
                  className="w-[92px] rounded-[7px] border border-line bg-sunken px-2 py-1 text-right font-mono text-[12px] text-text outline-none placeholder:text-faint focus:border-brand"
                />
                <span className="w-6 font-mono text-[10px] text-faint">{unita}</span>
              </label>
            ))}

            {/*
              The distance for ONE PAIR of things. A single copper-to-copper
              number is what a fab quotes, not what a board is drawn to: an
              imported board can say "a via may come within a hundredth of a
              millimetre of a pad", and under a BGA it does. Empty means the
              general minimum above applies, which is the common case.
            */}
            <div className="mt-3 border-t border-line pt-3">
              <p className="text-[12px] text-text">Distanze per coppia</p>
              <p className="mt-0.5 text-[10px] leading-relaxed text-faint">
                Vuoto = vale la distanza minima qui sopra. Si riempiono da sole quando
                si importa una scheda che le dichiara.
              </p>
              <div className="mt-2 space-y-1.5">
                {COPPIE.map((c) => (
                  <label key={c.chiave} className="flex items-center gap-3">
                    <span className="min-w-0 flex-1 text-[12px] text-muted">{c.label}</span>
                    <input
                      type="number"
                      step={unita === "mm" ? "0.001" : "0.1"}
                      min={unita === "mm" ? "0.01" : "0.4"}
                      placeholder={inUnita(custom.minClearanceMm, unita)}
                      value={inUnita(custom.clearanceByPairMm?.[c.chiave], unita)}
                      onChange={(e) => {
                        const v = e.target.value.trim();
                        const resto: Partial<Record<ChiaveCoppia, number>> = {
                          ...(custom.clearanceByPairMm ?? {}),
                        };
                        if (v === "") delete resto[c.chiave];
                        else resto[c.chiave] = inMm(v, unita);
                        setCustom({
                          ...custom,
                          ...(Object.keys(resto).length
                            ? { clearanceByPairMm: resto }
                            : { clearanceByPairMm: undefined }),
                        });
                      }}
                      className="w-[92px] rounded-[7px] border border-line bg-sunken px-2 py-1 text-right font-mono text-[12px] text-text outline-none placeholder:text-faint focus:border-brand"
                    />
                    <span className="w-6 font-mono text-[10px] text-faint">{unita}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
        )}

          {/*
            Le classi stanno qui sotto, con il loro bottone: il primo salva i
            MINIMI e non tocca niente, questo riscrive il rame. Dice quanti
            pezzi sposta prima di spostarli, perche' una modifica di massa che
            non si sa quanto pesa non e' una modifica, e' una sorpresa.
          */}
          {classi && nuove && (classi.via.length > 0 || classi.piste.length > 0) && (
            <div className="mt-3 rounded-[10px] border border-line p-3">
              <p className="text-[13px] font-semibold text-text">Le misure di questa scheda</p>
              <p className="mt-0.5 text-[10px] leading-relaxed text-faint">
                Non sono minimi: sono le famiglie di via e di piste che il rame usa
                davvero, contate. Cambiarne una le sposta tutte insieme. Toccando il
                foro, il pad segue per tenere la stessa corona.
              </p>

              {classi.via.length > 0 && (
                <div className="mt-2.5">
                  <p className="text-[11px] text-muted">Via</p>
                  {classi.via.map((c, i) => (
                    <div key={`${c.padMm}/${c.foroMm}`} className="mt-1.5 flex items-center gap-2">
                      <span className="w-[92px] flex-none text-[11px] text-muted">
                        {c.quante} via
                      </span>
                      <span className="text-[10px] text-faint">foro</span>
                      <input
                        type="number"
                        step={unita === "mm" ? "0.001" : "0.1"}
                        value={inUnita(nuove.via[i]?.foroMm, unita)}
                        onChange={(e) => {
                          const foro = inMm(e.target.value.trim(), unita);
                          const copia = structuredClone(nuove);
                          copia.via[i].foroMm = foro;
                          // il pad segue: la corona e' la misura che rompe
                          copia.via[i].padMm = Number((foro + 2 * c.coronaMm).toFixed(4));
                          setNuove(copia);
                        }}
                        className="w-[80px] rounded-[7px] border border-line bg-sunken px-2 py-1 text-right font-mono text-[12px] text-text outline-none focus:border-brand"
                      />
                      <span className="text-[10px] text-faint">pad</span>
                      <input
                        type="number"
                        step={unita === "mm" ? "0.001" : "0.1"}
                        value={inUnita(nuove.via[i]?.padMm, unita)}
                        onChange={(e) => {
                          const copia = structuredClone(nuove);
                          copia.via[i].padMm = inMm(e.target.value.trim(), unita);
                          setNuove(copia);
                        }}
                        className="w-[80px] rounded-[7px] border border-line bg-sunken px-2 py-1 text-right font-mono text-[12px] text-text outline-none focus:border-brand"
                      />
                      <span className="w-6 font-mono text-[10px] text-faint">{unita}</span>
                      <span className="flex-1 text-right font-mono text-[10px] text-faint">
                        corona{" "}
                        {inUnita(
                          Math.max(0, ((nuove.via[i]?.padMm ?? 0) - (nuove.via[i]?.foroMm ?? 0)) / 2),
                          unita,
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {classi.piste.length > 0 && (
                <div className="mt-3">
                  <p className="text-[11px] text-muted">Piste</p>
                  {classi.piste.map((c, i) => (
                    <div key={c.larghezzaMm} className="mt-1.5 flex items-center gap-2">
                      <span className="w-[92px] flex-none text-[11px] text-muted">
                        {c.quanti} tratte
                      </span>
                      <span className="flex-1 text-[10px] text-faint">
                        {c.lunghezzaMm.toFixed(0)}mm di rame
                      </span>
                      <input
                        type="number"
                        step={unita === "mm" ? "0.001" : "0.1"}
                        value={inUnita(nuove.piste[i]?.larghezzaMm, unita)}
                        onChange={(e) => {
                          const copia = structuredClone(nuove);
                          copia.piste[i].larghezzaMm = inMm(e.target.value.trim(), unita);
                          setNuove(copia);
                        }}
                        className="w-[80px] rounded-[7px] border border-line bg-sunken px-2 py-1 text-right font-mono text-[12px] text-text outline-none focus:border-brand"
                      />
                      <span className="w-6 font-mono text-[10px] text-faint">{unita}</span>
                    </div>
                  ))}
                </div>
              )}

              <div className="mt-3 flex items-center gap-2">
                <span className="flex-1 text-[10px] leading-relaxed text-faint">
                  {esito ??
                    (daSpostare.via + daSpostare.piste > 0
                      ? `Sposta ${daSpostare.via} via e ${daSpostare.piste} tratte di pista, e ricompila.`
                      : "Nessuna misura cambiata.")}
                </span>
                <button
                  type="button"
                  onClick={() => void applica()}
                  disabled={applico || daSpostare.via + daSpostare.piste === 0}
                  className={`rounded-[8px] px-3 py-[6px] text-[12px] font-semibold transition-colors ${
                    !applico && daSpostare.via + daSpostare.piste > 0
                      ? "bg-brand text-ink hover:bg-brand-strong"
                      : "bg-sunken text-faint"
                  }`}
                >
                  {applico ? "Applico..." : "Applica al rame"}
                </button>
              </div>
            </div>
          )}
        </div>

        {error && <p className="mt-3 flex-none text-[11px] text-danger">{error}</p>}

        <div className="mt-4 flex flex-none items-center gap-2">
          <span className="flex-1 text-[11px] text-faint">
            {changed
              ? "Salvando, la scheda si ricompila da sola: le colate si rifanno coi numeri nuovi e i controlli ripartono. Il rame gia' disegnato o importato non si tocca."
              : "Nessuna modifica."}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-[8px] px-3 py-[7px] text-[12px] text-muted transition-colors hover:text-text"
          >
            Annulla
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={!changed || busy}
            className={`rounded-[8px] px-3.5 py-[7px] text-[12px] font-semibold transition-colors ${
              changed && !busy ? "bg-brand text-ink hover:bg-brand-strong" : "bg-sunken text-faint"
            }`}
          >
            {busy ? "Salvo..." : "Salva"}
          </button>
        </div>
      </div>
    </div>
  );
}
