"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { Chat, type AgentStatus, type ChatItem } from "./Chat";
import { Rail, type RailKey } from "./Rail";
import { SidePanel, type LibraryItem } from "./SidePanel";

const RunFrame = dynamic(
  () => import("@tscircuit/runframe/runner").then((m) => m.RunFrame),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full w-full items-center justify-center bg-substrate">
        <div className="flex items-center gap-2 font-mono text-xs text-faint">
          <span className="led led-busy" />
          avvio runtime tscircuit
        </div>
      </div>
    ),
  },
);

// Renders an ALREADY-COMPILED circuit json without re-routing: used after a
// server-side compile so the user sees exactly what the agent validated and
// what /api/export will turn into Gerbers (autorouters are not deterministic).
const CircuitJsonPreview = dynamic(
  () => import("@tscircuit/runframe/runner").then((m) => m.CircuitJsonPreview),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full w-full items-center justify-center bg-substrate">
        <div className="flex items-center gap-2 font-mono text-xs text-faint">
          <span className="led led-busy" />
          caricamento viewer
        </div>
      </div>
    ),
  },
);

function useProjectId(): string {
  if (typeof window === "undefined") return "default";
  return new URLSearchParams(window.location.search).get("project") ?? "default";
}

export function Studio({ user }: { user: { email: string; name: string | null } }) {
  const projectId = useProjectId();
  const [fsMap, setFsMap] = useState<Record<string, string> | null>(null);
  const [chat, setChat] = useState<ChatItem[]>([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<AgentStatus>("idle");
  const [library, setLibrary] = useState<LibraryItem[]>([]);
  const [panel, setPanel] = useState<RailKey>(null);
  const [uploading, setUploading] = useState(false);
  const [projectCount, setProjectCount] = useState<number | undefined>();
  // server-validated routed circuit (truth); stale after any file change
  const [circuitJson, setCircuitJson] = useState<unknown[] | null>(null);
  const [circuitStale, setCircuitStale] = useState(false);
  const historyRef = useRef<Array<{ role: "user" | "assistant"; content: string }>>([]);

  useEffect(() => {
    fetch(`/api/project?projectId=${projectId}`)
      .then((r) => r.json())
      .then((d) => {
        setFsMap(d.fsMap);
        setLibrary((d.library ?? []) as LibraryItem[]);
        const messages = (d.messages ?? []) as Array<{
          role: "user" | "assistant";
          content: string;
        }>;
        historyRef.current = messages.map((m) => ({ role: m.role, content: m.content }));
        setChat(
          messages.map((m) =>
            m.role === "user"
              ? ({ kind: "user", text: m.content } as ChatItem)
              : ({ kind: "assistant", text: m.content } as ChatItem),
          ),
        );
      })
      .catch(() =>
        setChat((c) => [...c, { kind: "error", text: "Impossibile caricare il progetto" }]),
      );
    fetch("/api/projects")
      .then((r) => r.json())
      .then((d) => setProjectCount(d.projects?.length))
      .catch(() => undefined);
  }, [projectId]);

  const refreshLibrary = useCallback(async () => {
    const d = await fetch(`/api/project?projectId=${projectId}`)
      .then((r) => r.json())
      .catch(() => null);
    if (d?.library) setLibrary(d.library as LibraryItem[]);
  }, [projectId]);

  const uploadDatasheet = useCallback(
    async (file: File) => {
      setUploading(true);
      try {
        const form = new FormData();
        form.append("file", file);
        const res = await fetch(`/api/datasheet?projectId=${projectId}`, {
          method: "POST",
          body: form,
        });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
        setChat((c) => [
          ...c,
          {
            kind: "tool",
            name: "datasheet",
            detail: `${d.title} · ${d.pages} pagine · id ${d.id}`,
            ok: true,
          },
        ]);
        setInput(
          `Ho caricato il datasheet "${d.title}" (id ${d.id}). Crea il componente di libreria corrispondente e usalo nel progetto.`,
        );
        setPanel(null);
      } catch (err) {
        setChat((c) => [
          ...c,
          { kind: "error", text: err instanceof Error ? err.message : String(err) },
        ]);
      } finally {
        setUploading(false);
      }
    },
    [projectId],
  );

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
        body: JSON.stringify({ projectId, history: historyRef.current }),
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
            setChat((c) => [
              ...c,
              { kind: "tool", name: data.name, detail: toolDetail(data.name, data.args) },
            ]);
          } else if (event === "tool_result") {
            if (data.name === "library_save" || data.name === "import_component_from_lcsc") {
              void refreshLibrary();
            }
            setStatus("thinking");
            if (data.name === "compile") {
              setChat((c) => {
                const copy = [...c];
                for (let i = copy.length - 1; i >= 0; i--) {
                  const item = copy[i];
                  if (item.kind === "tool" && item.name === "compile" && item.ok === undefined) {
                    copy[i] = {
                      ...item,
                      ok: data.result?.ok,
                      detail: data.result?.message ?? item.detail,
                    };
                    break;
                  }
                }
                return copy;
              });
              // render the server-validated routing (same circuit json the
              // export endpoints will use), not a fresh browser re-route
              if (data.result?.ok) {
                fetch(`/api/project?projectId=${projectId}&circuit=1`)
                  .then((r) => r.json())
                  .then((d) => {
                    if (d.compile?.circuitJson) {
                      setCircuitJson(d.compile.circuitJson as unknown[]);
                      setCircuitStale(false);
                    }
                  })
                  .catch(() => {});
              }
            }
          } else if (event === "file_changed") {
            setFsMap((m) => ({ ...(m ?? {}), [data.path]: data.content }));
            setCircuitStale(true);
          } else if (event === "error") {
            setChat((c) => [...c, { kind: "error", text: data.message }]);
          }
        }
      }
    } catch (err) {
      setChat((c) => [
        ...c,
        { kind: "error", text: err instanceof Error ? err.message : String(err) },
      ]);
    } finally {
      if (assistantText) historyRef.current.push({ role: "assistant", content: assistantText });
      setStatus("idle");
    }
  }, [input, status, projectId, refreshLibrary]);

  return (
    <div className="flex h-dvh overflow-hidden bg-substrate">
      <Rail
        active={panel}
        onSelect={setPanel}
        counts={{ library: library.length, projects: projectCount }}
      />

      {panel && (
        <SidePanel
          panel={panel}
          projectId={projectId}
          user={user}
          library={library}
          uploading={uploading}
          onClose={() => setPanel(null)}
          onUploadDatasheet={uploadDatasheet}
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar projectId={projectId} status={status} email={user.email} />
        <div className="flex min-h-0 flex-1">
          <Chat
            items={chat}
            status={status}
            input={input}
            onInput={setInput}
            onSend={() => void send()}
            disabled={status !== "idle"}
          />
          <main className="substrate-grid relative min-w-0 flex-1">
            {circuitJson && !circuitStale ? (
              <div className="viewer-frame absolute inset-3 overflow-hidden rounded-lg border border-edge shadow-[0_1px_0_rgba(255,255,255,0.04),0_20px_50px_-20px_rgba(0,0,0,0.9)]">
                <CircuitJsonPreview
                  circuitJson={circuitJson as never}
                  availableTabs={["schematic", "pcb", "cad", "bom"]}
                  defaultActiveTab="pcb"
                />
              </div>
            ) : fsMap ? (
              <div className="viewer-frame absolute inset-3 overflow-hidden rounded-lg border border-edge shadow-[0_1px_0_rgba(255,255,255,0.04),0_20px_50px_-20px_rgba(0,0,0,0.9)]">
                <RunFrame
                  fsMap={fsMap}
                  mainComponentPath="main.tsx"
                  showRunButton={false}
                  availableTabs={["schematic", "pcb", "cad", "bom"]}
                  defaultActiveTab="schematic"
                />
              </div>
            ) : (
              <div className="flex h-full items-center justify-center font-mono text-xs text-faint">
                caricamento progetto
              </div>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}

function TopBar({
  projectId,
  status,
  email,
}: {
  projectId: string;
  status: AgentStatus;
  email: string;
}) {
  const led =
    status === "idle" ? "led-idle" : status === "tool" ? "led-live" : "led-busy";
  const label = status === "idle" ? "pronto" : status === "tool" ? "strumento" : "pensa";

  return (
    <header className="power-on flex h-12 flex-none items-center gap-4 border-b border-edge bg-panel px-4">
      <div className="flex items-baseline gap-2.5">
        <span className="text-sm font-semibold tracking-tight text-ink">PCB Studio</span>
        <span className="text-faint">/</span>
        <span className="font-mono text-xs text-solder">{projectId}</span>
      </div>

      <div className="flex items-center gap-1.5 rounded-md border border-edge px-2 py-1">
        <span className={`led ${led}`} />
        <span className="font-mono text-[10px] uppercase tracking-wider text-faint">
          {label}
        </span>
      </div>

      <div className="ml-auto flex items-center gap-3">
        <div className="flex items-center gap-1">
          <span className="silk mr-1">export</span>
          {(
            [
              ["gerber", "gerber"],
              ["bom", "bom"],
              ["pnp", "pnp"],
            ] as const
          ).map(([kind, label]) => (
            <a
              key={kind}
              href={`/api/export?projectId=${projectId}&kind=${kind}`}
              download
              className="rounded-md border border-edge px-2 py-1 font-mono text-[10px] text-dim transition-colors hover:border-copper/50 hover:text-copper"
            >
              {label}
            </a>
          ))}
        </div>

        <div className="h-5 w-px bg-edge" />

        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] text-faint" title={email}>
            {email.split("@")[0]}
          </span>
          <a
            href="/api/auth/signout"
            className="rounded-md border border-edge px-2 py-1 text-[10px] text-dim transition-colors hover:border-alert/50 hover:text-alert"
          >
            esci
          </a>
        </div>
      </div>
    </header>
  );
}

function toolDetail(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "write_file":
      return `${args.path} · ${args.chars} char`;
    case "read_file":
      return String(args.path ?? "");
    case "compile":
      return "compilazione in corso";
    case "import_component_from_lcsc":
      return String(args.lcsc ?? "");
    case "library_save":
    case "library_read":
      return String(args.name ?? "");
    case "read_datasheet":
      return `#${args.id}${args.search ? ` "${args.search}"` : ""}`;
    case "fetch_datasheet_url":
      return String(args.url ?? "").slice(0, 50);
    case "search_parts":
      return String(args.query ?? "");
    case "simulate":
      return "spice";
    default:
      return "";
  }
}
