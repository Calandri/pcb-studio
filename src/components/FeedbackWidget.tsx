"use client";

import { useState } from "react";
import { AreaSelector, type SelectorResult } from "./feedback/selector";
import { captureScreenshot, viewportRect } from "./feedback/capture";

/**
 * The feedback widget: a floating button that opens a small form. What people
 * write becomes a GitHub issue on the project repo (labelled widget + kind),
 * with a set of robustness features: point at the
 * broken element with the selector, attach a real screenshot of the page,
 * and the issue carries the component's xpath plus page context.
 */

type Kind = "bug" | "idea" | "feedback";

const KINDS: Array<{ id: Kind; label: string; hint: string }> = [
  { id: "bug", label: "Bug", hint: "qualcosa non funziona" },
  { id: "idea", label: "Idea", hint: "una funzione che vorresti" },
  { id: "feedback", label: "Feedback", hint: "cosa ne pensi" },
];

export function FeedbackWidget() {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind>("feedback");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [website, setWebsite] = useState(""); // honeypot
  const [selection, setSelection] = useState<SelectorResult | null>(null);
  const [attachShot, setAttachShot] = useState(true);
  const [busy, setBusy] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ number: number; url: string } | null>(null);

  const startSelector = () => {
    const selector = new AreaSelector(
      (result) => setSelection(result.rect || result.component ? result : null),
      () => {},
    );
    selector.start();
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      let screenshotBase64: string | undefined;
      if (attachShot) {
        // il widget esce dall'inquadratura mentre snapdom lavora
        setCapturing(true);
        await new Promise((r) => setTimeout(r, 60));
        try {
          screenshotBase64 = await captureScreenshot(selection?.rect ?? viewportRect(), {
            maxWidth: 1600,
            quality: 0.8,
          });
        } catch {
          screenshotBase64 = undefined; // la segnalazione vale anche senza
        } finally {
          setCapturing(false);
        }
      }
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind,
          title,
          body,
          page: window.location.pathname + window.location.search,
          pageTitle: document.title,
          userAgent: navigator.userAgent,
          viewport: { width: window.innerWidth, height: window.innerHeight },
          screenshotBase64,
          component: selection?.component ?? undefined,
          website,
        }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
      setDone({ number: d.number, url: d.url });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setCapturing(false);
    }
  };

  const reset = () => {
    setDone(null);
    setTitle("");
    setBody("");
    setSelection(null);
    setOpen(false);
  };

  if (capturing) {
    // placeholder invisibile: il capture stacca gli elementi con questo attributo
    return <div data-feedback-widget />;
  }

  return (
    <div data-feedback-widget>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Lascia un feedback, un bug o una richiesta"
        className="fixed bottom-4 left-4 z-40 rounded-full border border-[#2C4C42] bg-[rgba(9,20,17,0.94)] px-3.5 py-2 text-[12px] font-semibold text-brand shadow-[0_10px_30px_-10px_rgba(0,0,0,0.7)] backdrop-blur transition-colors hover:border-brand"
      >
        💬 Feedback
      </button>

      {open && (
        <div className="fixed bottom-16 left-4 z-40 w-[320px] rounded-[14px] border border-[#2C4C42] bg-[rgba(9,14,13,0.97)] p-3.5 shadow-[0_20px_50px_-20px_rgba(0,0,0,0.8)] backdrop-blur">
          {done ? (
            <div className="flex flex-col gap-2.5 py-2 text-center">
              <p className="text-[13px] font-semibold text-brand">Grazie!</p>
              <p className="text-[12px] leading-relaxed text-muted">
                {done.number > 0 ? (
                  <>
                    Il tuo messaggio e&apos; la issue{" "}
                    <a
                      href={done.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="font-semibold text-brand underline-offset-2 hover:underline"
                    >
                      #{done.number}
                    </a>{" "}
                    sulla board del progetto.
                  </>
                ) : (
                  "Messaggio ricevuto."
                )}
              </p>
              <button
                type="button"
                onClick={reset}
                className="mx-auto rounded-lg border border-line-strong px-3 py-1.5 text-[12px] text-muted transition-colors hover:text-text"
              >
                Chiudi
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-2.5">
              <div className="flex items-baseline justify-between">
                <span className="text-[13px] font-semibold text-[#E7EFEC]">Di&apos; la tua</span>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  title="Chiudi"
                  className="text-faint transition-colors hover:text-text"
                >
                  ✕
                </button>
              </div>

              <div className="flex gap-1.5">
                {KINDS.map((k) => (
                  <button
                    key={k.id}
                    type="button"
                    onClick={() => setKind(k.id)}
                    title={k.hint}
                    className={`flex-1 rounded-lg border px-2 py-1.5 text-[11.5px] font-semibold transition-colors ${
                      kind === k.id
                        ? "border-brand/50 bg-brand-wash text-brand"
                        : "border-line text-faint hover:text-muted"
                    }`}
                  >
                    {k.label}
                  </button>
                ))}
              </div>

              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Titolo in poche parole"
                maxLength={200}
                className="rounded-lg border border-line bg-[#0E1513] px-2.5 py-2 text-[12.5px] text-text outline-none placeholder:text-faint focus:border-brand"
              />
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder={
                  kind === "bug"
                    ? "Cosa e' successo, e cosa ti aspettavi?"
                    : kind === "idea"
                      ? "Cosa vorresti poter fare?"
                      : "Scrivi qui…"
                }
                rows={4}
                maxLength={4000}
                className="resize-none rounded-lg border border-line bg-[#0E1513] px-2.5 py-2 text-[12.5px] text-text outline-none placeholder:text-faint focus:border-brand"
              />

              {/* selettore elemento + screenshot, la parte robusta */}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={startSelector}
                  title="Disegna attorno al problema o clicca l'elemento rotto"
                  className={`flex-1 rounded-lg border px-2 py-1.5 text-[11.5px] font-semibold transition-colors ${
                    selection
                      ? "border-brand/50 bg-brand-wash text-brand"
                      : "border-line-strong text-muted hover:text-text"
                  }`}
                >
                  {selection?.component
                    ? `🎯 ${selection.component.tag}${selection.component.id ? `#${selection.component.id}` : ""}`
                    : selection?.rect
                      ? "🎯 area selezionata"
                      : "🎯 Seleziona elemento"}
                </button>
                {selection && (
                  <button
                    type="button"
                    onClick={() => setSelection(null)}
                    title="Togli la selezione"
                    className="text-faint transition-colors hover:text-text"
                  >
                    ✕
                  </button>
                )}
              </div>
              <label className="flex cursor-pointer items-center gap-2 text-[11.5px] text-muted">
                <input
                  type="checkbox"
                  checked={attachShot}
                  onChange={(e) => setAttachShot(e.target.checked)}
                  className="accent-[#3BE8B0]"
                />
                allega screenshot{selection?.rect ? " dell'area" : " della pagina"}
              </label>

              {/* honeypot: invisibile agli umani, i bot lo compilano */}
              <input
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
                type="text"
                tabIndex={-1}
                autoComplete="off"
                aria-hidden="true"
                className="pointer-events-none absolute -left-[9999px] h-0 w-0 opacity-0"
              />

              {error && <p className="text-[11.5px] text-danger">{error}</p>}

              <button
                type="button"
                onClick={() => void submit()}
                disabled={busy || title.trim().length < 3 || body.trim().length < 5}
                className="rounded-lg bg-brand px-3 py-2 text-[12.5px] font-semibold text-[#06110D] transition-opacity hover:opacity-90 disabled:opacity-40"
              >
                {busy ? (capturing ? "Faccio lo screenshot…" : "Invio…") : "Invia alla board"}
              </button>
              <p className="text-center text-[10px] text-faint">
                diventa una GitHub issue pubblica: non scrivere dati privati
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
