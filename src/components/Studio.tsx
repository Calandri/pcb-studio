"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { Chat, type AgentStatus, type ChatItem } from "./Chat";
import { Sidebar, type LibraryItem, type SectionKey } from "./Sidebar";

const RunFrame = dynamic(
  () => import("@tscircuit/runframe/runner").then((m) => m.RunFrame),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full w-full items-center justify-center">
        <div className="flex items-center gap-2 text-sm text-faint">
          <span className="dot dot-busy" />
          Avvio dell&apos;ambiente di progettazione
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
  const [section, setSection] = useState<SectionKey>("projects");
  const [uploading, setUploading] = useState(false);
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
              { kind: "tool", name: toolLabel(data.name), detail: toolDetail(data.name, data.args) },
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
                  if (
                    item.kind === "tool" &&
                    item.name === toolLabel("compile") &&
                    item.ok === undefined
                  ) {
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
            }
          } else if (event === "file_changed") {
            setFsMap((m) => ({ ...(m ?? {}), [data.path]: data.content }));
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
    <div className="flex h-dvh overflow-hidden bg-canvas">
      <Sidebar
        section={section}
        onSection={setSection}
        projectId={projectId}
        user={user}
        library={library}
        uploading={uploading}
        onUploadDatasheet={uploadDatasheet}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <Header projectId={projectId} status={status} />
        <div className="flex min-h-0 flex-1">
          <Chat
            items={chat}
            status={status}
            input={input}
            onInput={setInput}
            onSend={() => void send()}
            disabled={status !== "idle"}
          />
          <main className="min-w-0 flex-1 py-5 pr-5 pl-1">
            <div className="card h-full overflow-hidden">
              {fsMap ? (
                <RunFrame
                  fsMap={fsMap}
                  mainComponentPath="main.tsx"
                  showRunButton={false}
                  availableTabs={["schematic", "pcb", "cad", "bom"]}
                  defaultActiveTab="schematic"
                />
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-faint">
                  Caricamento del progetto...
                </div>
              )}
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}

function Header({ projectId, status }: { projectId: string; status: AgentStatus }) {
  const dot = status === "idle" ? "dot-idle" : status === "tool" ? "dot-live" : "dot-busy";
  const label =
    status === "idle" ? "Pronto" : status === "tool" ? "Strumento in corso" : "Sto ragionando";

  return (
    <header className="rise flex h-16 flex-none items-center gap-4 px-5">
      <div className="min-w-0">
        <h1 className="truncate text-[15px] font-bold tracking-tight text-text">{projectId}</h1>
        <div className="mt-0.5 flex items-center gap-1.5">
          <span className={`dot ${dot}`} />
          <span className="text-xs text-faint">{label}</span>
        </div>
      </div>

      <div className="ml-auto flex items-center gap-2">
        <span className="section-label mr-1">Scarica</span>
        {(
          [
            ["gerber", "Gerber"],
            ["bom", "Distinta"],
            ["pnp", "Pick & place"],
          ] as const
        ).map(([kind, label]) => (
          <a
            key={kind}
            href={`/api/export?projectId=${projectId}&kind=${kind}`}
            download
            className="rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-medium text-muted shadow-sm transition-all hover:-translate-y-px hover:border-line-strong hover:text-text"
          >
            {label}
          </a>
        ))}
      </div>
    </header>
  );
}

function toolLabel(name: string): string {
  const labels: Record<string, string> = {
    write_file: "Scrittura progetto",
    read_file: "Lettura file",
    list_files: "Elenco file",
    compile: "Compilazione",
    search_parts: "Ricerca componenti",
    import_component_from_lcsc: "Import componente",
    library_save: "Salvataggio in libreria",
    library_read: "Lettura libreria",
    library_list: "Elenco libreria",
    read_datasheet: "Lettura datasheet",
    fetch_datasheet_url: "Scarico datasheet",
    list_datasheets: "Elenco datasheet",
    simulate: "Simulazione SPICE",
  };
  return labels[name] ?? name;
}

function toolDetail(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "write_file":
      return `${args.path}`;
    case "read_file":
      return String(args.path ?? "");
    case "compile":
      return "in corso...";
    case "import_component_from_lcsc":
      return String(args.lcsc ?? "");
    case "library_save":
    case "library_read":
      return String(args.name ?? "");
    case "read_datasheet":
      return `#${args.id}${args.search ? ` · "${args.search}"` : ""}`;
    case "fetch_datasheet_url":
      return String(args.url ?? "").slice(0, 46);
    case "search_parts":
      return String(args.query ?? "");
    default:
      return "";
  }
}
