"use client";

import { useEffect, useRef } from "react";
import { Markdown } from "./Markdown";

export type ChatItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; name: string; detail: string; ok?: boolean }
  | { kind: "error"; text: string };

export type AgentStatus = "idle" | "thinking" | "tool";

const SUGGESTIONS = [
  "Un LED blinker col 555 a 9V",
  "Alimentatore 5V→3.3V con LDO reale",
  "Importa il componente LCSC C7593",
];

export function Chat({
  items,
  status,
  input,
  onInput,
  onSend,
  disabled,
}: {
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

  return (
    <section className="flex w-[380px] flex-none flex-col border-r border-edge bg-panel">
      <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3 py-4">
        {items.length === 0 && (
          <div className="power-on space-y-4 px-1 pt-6">
            <p className="text-sm leading-relaxed text-dim">
              Descrivi il circuito che vuoi costruire.
              <br />
              <span className="text-faint">
                L&apos;agente scrive il progetto, lo compila e lo verifica.
              </span>
            </p>
            <div className="space-y-1.5">
              {SUGGESTIONS.map((s, i) => (
                <button
                  key={s}
                  type="button"
                  style={{ animationDelay: `${120 + i * 70}ms` }}
                  onClick={() => onInput(s)}
                  className="power-on block w-full rounded-md border border-edge px-3 py-2 text-left text-xs text-dim transition-colors hover:border-solder-dim/60 hover:bg-raised hover:text-ink"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {items.map((item, i) => (
          <Bubble key={i} item={item} />
        ))}

        {status !== "idle" && (
          <div className="flex items-center gap-2 px-1 py-1">
            <span className={`led ${status === "tool" ? "led-live" : "led-busy"}`} />
            <span className="font-mono text-[11px] text-dim">
              {status === "thinking" ? "ragionamento in corso" : "esecuzione strumento"}
            </span>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <form
        className="border-t border-edge p-3"
        onSubmit={(e) => {
          e.preventDefault();
          onSend();
        }}
      >
        <div className="flex items-end gap-2 rounded-lg border border-edge bg-substrate p-1.5 transition-colors focus-within:border-solder-dim/60">
          <textarea
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
            className="max-h-32 min-h-[32px] flex-1 resize-none bg-transparent px-2 py-1.5 text-sm text-ink outline-none placeholder:text-faint"
          />
          <button
            type="submit"
            disabled={disabled || !input.trim()}
            className="flex h-8 w-8 flex-none items-center justify-center rounded-md bg-solder-dim text-substrate transition-colors hover:bg-solder disabled:bg-edge disabled:text-faint"
            title="Invia"
          >
            <svg viewBox="0 0 16 16" fill="none" className="h-4 w-4">
              <path
                d="M8 13V3M8 3L4 7M8 3l4 4"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      </form>
    </section>
  );
}

function Bubble({ item }: { item: ChatItem }) {
  if (item.kind === "user") {
    return (
      <div className="ml-6 rounded-lg rounded-br-sm border border-solder-dim/30 bg-solder-dim/10 px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap text-ink">
        {item.text}
      </div>
    );
  }
  if (item.kind === "assistant") {
    return (
      <div className="mr-2 rounded-lg rounded-bl-sm border border-edge bg-raised px-3 py-2.5 text-[13px] text-ink/90">
        <Markdown text={item.text} />
      </div>
    );
  }
  if (item.kind === "error") {
    return (
      <div className="rounded-md border border-alert/40 bg-alert/10 px-3 py-2 font-mono text-[11px] text-alert">
        {item.text}
      </div>
    );
  }
  const dot =
    item.ok === undefined ? "bg-faint" : item.ok ? "bg-solder" : "bg-alert";
  return (
    <div className="mr-6 flex items-start gap-2 px-1 py-0.5">
      <span className={`mt-1.5 h-1.5 w-1.5 flex-none rounded-full ${dot}`} />
      <div className="min-w-0 font-mono text-[11px] leading-relaxed">
        <span className={item.ok === false ? "text-alert" : "text-copper"}>{item.name}</span>{" "}
        <span className="text-faint">{item.detail}</span>
      </div>
    </div>
  );
}
