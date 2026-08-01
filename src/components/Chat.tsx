"use client";

import { useEffect, useRef } from "react";
import { HandoffButton } from "./HandoffButton";
import { Markdown } from "./Markdown";

export type ChatItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; name: string; detail: string; ok?: boolean }
  | { kind: "error"; text: string };

export type AgentStatus = "idle" | "thinking" | "tool";

const SUGGESTIONS = [
  { title: "Un LED che lampeggia", text: "Fammi un LED blinker col 555 alimentato a 9V" },
  { title: "Alimentazione 3.3V", text: "Alimentatore da 5V a 3.3V con un LDO reale in stock" },
  { title: "Componente reale", text: "Importa in libreria il componente LCSC C7593 e usalo" },
];

export function Chat({
  projectId,
  items,
  status,
  input,
  onInput,
  onSend,
  disabled,
}: {
  projectId: string;
  items: ChatItem[];
  status: AgentStatus;
  input: string;
  onInput: (v: string) => void;
  onSend: () => void;
  disabled: boolean;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [items, status]);

  // The textarea starts at one row and did not grow: from the second row on the
  // text was cut in half and you could not re-read what you were typing.
  // The height is reset before reading scrollHeight again, otherwise deleting
  // text would leave it tall.
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);

  const dotClass =
    status === "idle" ? "dot-idle" : status === "tool" ? "dot-live" : "dot-busy";
  const statusLabel =
    status === "idle"
      ? "Pronto"
      : status === "tool"
        ? "Sto usando uno strumento"
        : "Sto ragionando";

  return (
    <section className="flex h-full w-full flex-col">
      <header className="flex items-center gap-2 px-4 pt-3 pb-1">
        <span className={`dot ${dotClass}`} />
        <span className="text-[11px] text-faint">{statusLabel}</span>
      </header>
      <div className="min-h-0 min-w-0 flex-1 space-y-3 overflow-y-auto px-4 pb-4 pt-1">
        {items.length === 0 && (
          <div className="rise space-y-4 pt-4">
            <div>
              <h2 className="text-base font-bold tracking-tight text-text">
                Cosa costruiamo oggi?
              </h2>
              <p className="mt-1 text-sm leading-relaxed text-muted">
                Descrivi il circuito: l&apos;agente scrive il progetto, lo compila e
                controlla le regole di produzione.
              </p>
            </div>
            <div className="space-y-2">
              {SUGGESTIONS.map((s, i) => (
                <button
                  key={s.title}
                  type="button"
                  style={{ animationDelay: `${100 + i * 70}ms` }}
                  onClick={() => onInput(s.text)}
                  className="rise card w-full px-3.5 py-3 text-left transition-all hover:-translate-y-px hover:border-brand hover:shadow-md"
                >
                  <p className="text-sm font-semibold text-text">{s.title}</p>
                  <p className="mt-0.5 text-xs leading-relaxed text-faint">{s.text}</p>
                </button>
              ))}
            </div>
          </div>
        )}

        {items.map((item, i) => (
          <Bubble key={i} item={item} />
        ))}

        {status !== "idle" && (
          <div className="flex items-center gap-2 px-1">
            <span className={`dot ${status === "tool" ? "dot-live" : "dot-busy"}`} />
            <span className="text-xs text-muted">un momento...</span>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <form
        className="px-4 pb-4"
        onSubmit={(e) => {
          e.preventDefault();
          onSend();
        }}
      >
        <div className="card flex items-end gap-2 p-2 transition-shadow focus-within:border-brand focus-within:shadow-md">
          <textarea
            ref={inputRef}
            value={input}
            rows={1}
            onChange={(e) => onInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSend();
              }
            }}
            placeholder="Descrivi il circuito..."
            className="max-h-40 min-h-[36px] flex-1 resize-none overflow-y-auto bg-transparent px-2 py-2 text-sm leading-relaxed text-text outline-none placeholder:text-faint"
          />
          <button
            type="submit"
            disabled={disabled || !input.trim()}
            title="Invia"
            className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-brand text-ink transition-colors hover:bg-brand-strong disabled:bg-sunken disabled:text-faint"
          >
            <svg viewBox="0 0 16 16" fill="none" className="h-4 w-4">
              <path
                d="M8 13V3M8 3L4 7M8 3l4 4"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="text-[11px] text-faint">Invio per mandare</span>
          <HandoffButton projectId={projectId} variant="solid" />
        </div>
      </form>
    </section>
  );
}

function Bubble({ item }: { item: ChatItem }) {
  if (item.kind === "user") {
    return (
      <div className="ml-8 overflow-hidden rounded-2xl rounded-br-md bg-brand px-4 py-2.5 text-sm leading-relaxed break-words whitespace-pre-wrap text-ink shadow-sm">
        {item.text}
      </div>
    );
  }
  if (item.kind === "assistant") {
    return (
      <div className="card mr-2 overflow-hidden px-4 py-3 text-[13px] break-words text-text">
        <Markdown text={item.text} />
      </div>
    );
  }
  if (item.kind === "error") {
    return (
      <div className="overflow-hidden rounded-xl bg-danger-wash px-3.5 py-2.5 text-xs leading-relaxed break-words text-danger">
        {item.text}
      </div>
    );
  }
  const tone =
    item.ok === undefined ? "bg-faint" : item.ok ? "bg-brand" : "bg-danger";
  return (
    <div className="flex items-start gap-2 px-1.5">
      <span className={`mt-[7px] h-1.5 w-1.5 flex-none rounded-full ${tone}`} />
      <p className="min-w-0 flex-1 text-xs leading-relaxed break-words text-faint">
        <span className="font-mono font-medium text-muted">{item.name}</span>{" "}
        {item.detail}
      </p>
    </div>
  );
}
