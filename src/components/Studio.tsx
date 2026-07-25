"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";

const RunFrame = dynamic(
  () => import("@tscircuit/runframe/runner").then((m) => m.RunFrame),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full w-full items-center justify-center text-sm text-neutral-500">
        Caricamento runtime tscircuit...
      </div>
    ),
  },
);

type ChatItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; name: string; detail: string; ok?: boolean }
  | { kind: "error"; text: string };

type AgentStatus = "idle" | "thinking" | "tool";

const PROJECT_ID = "default";

export function Studio() {
  const [fsMap, setFsMap] = useState<Record<string, string> | null>(null);
  const [chat, setChat] = useState<ChatItem[]>([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<AgentStatus>("idle");
  const chatEndRef = useRef<HTMLDivElement>(null);
  // user/assistant turns only; tool traffic stays server-side per request
  const historyRef = useRef<Array<{ role: "user" | "assistant"; content: string }>>([]);

  useEffect(() => {
    fetch(`/api/project?projectId=${PROJECT_ID}`)
      .then((r) => r.json())
      .then((d) => setFsMap(d.fsMap))
      .catch(() => setChat((c) => [...c, { kind: "error", text: "Impossibile caricare il progetto" }]));
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chat, status]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || status !== "idle") return;
    setInput("");
    setChat((c) => [...c, { kind: "user", text }]);
    historyRef.current.push({ role: "user", content: text });
    setStatus("thinking");

    let assistantText = "";
    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: PROJECT_ID, history: historyRef.current }),
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) >= 0) {
          const raw = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const event = /^event: (.+)$/m.exec(raw)?.[1];
          const dataLine = /^data: (.+)$/m.exec(raw)?.[1];
          if (!event || !dataLine) continue;
          const data = JSON.parse(dataLine);

          if (event === "assistant_text") {
            assistantText += (assistantText ? "\n\n" : "") + data.text;
            setChat((c) => [...c, { kind: "assistant", text: data.text }]);
            setStatus("thinking");
          } else if (event === "tool_call") {
            setStatus("tool");
            setChat((c) => [...c, { kind: "tool", name: data.name, detail: toolDetail(data.name, data.args) }]);
          } else if (event === "tool_result") {
            setStatus("thinking");
            if (data.name === "compile") {
              setChat((c) => {
                const copy = [...c];
                for (let i = copy.length - 1; i >= 0; i--) {
                  const item = copy[i];
                  if (item.kind === "tool" && item.name === "compile" && item.ok === undefined) {
                    copy[i] = { ...item, ok: data.result?.ok, detail: data.result?.message ?? item.detail };
                    break;
                  }
                }
                return copy;
              });
            }
          } else if (event === "file_changed") {
            setFsMap((m) => ({ ...(m ?? {}), [data.path]: data.content }));
          } else if (event === "error") {
            setChat((c) => [...c, { kind: "error", text: data.message }]);
          }
        }
      }
    } catch (err) {
      setChat((c) => [...c, { kind: "error", text: err instanceof Error ? err.message : String(err) }]);
    } finally {
      if (assistantText) historyRef.current.push({ role: "assistant", content: assistantText });
      setStatus("idle");
    }
  }, [input, status]);

  return (
    <div className="flex h-dvh flex-col bg-neutral-950 text-neutral-200">
      <header className="flex items-center gap-3 border-b border-neutral-800 px-4 py-2">
        <span className="text-sm font-semibold tracking-wide text-neutral-100">PCB Studio</span>
        <span className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-400">{PROJECT_ID}</span>
        <nav className="ml-4 flex gap-2">
          {(["gerber", "bom", "pnp"] as const).map((kind) => (
            <a
              key={kind}
              href={`/api/export?projectId=${PROJECT_ID}&kind=${kind}`}
              download
              className="rounded border border-neutral-700 px-2 py-0.5 text-xs text-neutral-300 hover:border-emerald-600 hover:text-emerald-400"
            >
              ⬇ {kind === "gerber" ? "gerber.zip" : `${kind}.csv`}
            </a>
          ))}
        </nav>
        <StatusBadge status={status} />
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[380px] shrink-0 flex-col border-r border-neutral-800">
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
            {chat.length === 0 && (
              <p className="pt-8 text-center text-sm text-neutral-500">
                Descrivi il circuito che vuoi costruire.
                <br />
                <span className="text-neutral-600">es. &quot;un LED blinker col 555 a 9V&quot;</span>
              </p>
            )}
            {chat.map((item, i) => (
              <ChatBubble key={i} item={item} />
            ))}
            {status !== "idle" && (
              <div className="px-2 text-xs text-amber-400/80">
                {status === "thinking" ? "L'agente sta ragionando..." : "Esecuzione tool..."}
              </div>
            )}
            <div ref={chatEndRef} />
          </div>
          <form
            className="flex gap-2 border-t border-neutral-800 p-3"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Descrivi il circuito..."
              className="min-w-0 flex-1 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none placeholder:text-neutral-600 focus:border-emerald-600"
            />
            <button
              type="submit"
              disabled={status !== "idle" || !input.trim()}
              className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
            >
              Invia
            </button>
          </form>
        </aside>

        <main className="min-w-0 flex-1 bg-white">
          {fsMap ? (
            <RunFrame
              fsMap={fsMap}
              mainComponentPath="main.tsx"
              showRunButton={false}
              availableTabs={["schematic", "pcb", "cad", "bom"]}
              defaultActiveTab="schematic"
            />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-neutral-400">
              Caricamento progetto...
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: AgentStatus }) {
  const styles: Record<AgentStatus, string> = {
    idle: "bg-neutral-800 text-neutral-400",
    thinking: "bg-amber-950 text-amber-400",
    tool: "bg-emerald-950 text-emerald-400",
  };
  const labels: Record<AgentStatus, string> = {
    idle: "idle",
    thinking: "thinking",
    tool: "running tool",
  };
  return (
    <span className={`ml-auto rounded-full px-2.5 py-0.5 text-xs ${styles[status]}`}>
      ● {labels[status]}
    </span>
  );
}

function ChatBubble({ item }: { item: ChatItem }) {
  if (item.kind === "user") {
    return (
      <div className="ml-8 rounded-lg bg-emerald-900/40 px-3 py-2 text-sm whitespace-pre-wrap">
        {item.text}
      </div>
    );
  }
  if (item.kind === "assistant") {
    return (
      <div className="mr-4 rounded-lg bg-neutral-900 px-3 py-2 text-sm whitespace-pre-wrap">
        {item.text}
      </div>
    );
  }
  if (item.kind === "error") {
    return (
      <div className="rounded-lg border border-red-900 bg-red-950/50 px-3 py-2 text-xs text-red-300">
        {item.text}
      </div>
    );
  }
  const okMark = item.ok === undefined ? "" : item.ok ? " ✓" : " ✗";
  return (
    <div className="mr-8 rounded border border-neutral-800 bg-neutral-900/60 px-2.5 py-1.5 font-mono text-xs text-neutral-400">
      <span className={item.ok === false ? "text-red-400" : "text-emerald-500"}>
        {item.name}
        {okMark}
      </span>{" "}
      {item.detail}
    </div>
  );
}

function toolDetail(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "write_file":
      return `${args.path} (${args.chars} chars)`;
    case "read_file":
      return String(args.path ?? "");
    case "compile":
      return "compilazione...";
    default:
      return "";
  }
}
