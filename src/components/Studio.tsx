"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildBoardReport, type BoardReport } from "@/lib/board-report";
import { Chat, type AgentStatus, type ChatItem } from "./Chat";
import { HandoffButton } from "./HandoffButton";
import { PcbView } from "./PcbView";
import { SchematicView } from "./SchematicView";
import { EditorBar } from "./workspace/EditorBar";
import { useManualEditor } from "./workspace/useManualEditor";
import { Sidebar, type LibraryItem, type SectionKey } from "./Sidebar";
import { VIEW_PRESETS, type ViewFlags, type ViewPreset } from "./ViewPresets";
import { Footer, Header, type BoardTab } from "./workspace/Chrome";
import { LeftRail, type SchematicSummary, type SheetNet } from "./workspace/LeftRail";
import { extractComponents } from "@/lib/inspect";
import { applyManualEditsToFsMap } from "@/lib/manual-edits";
import { BomView } from "./workspace/BomView";
import { PartCard } from "./workspace/PartCard";
import { PartPicker } from "./workspace/PartPicker";
import { RightRail, type ErcSummary } from "./workspace/RightRail";

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

const CircuitJsonPreview = dynamic(
  () => import("@tscircuit/runframe/runner").then((m) => m.CircuitJsonPreview),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-faint">
        <span className="dot dot-busy" /> Caricamento vista...
      </div>
    ),
  },
);

export function Studio({
  projectId,
  user,
}: {
  projectId: string;
  user: { email: string; name: string | null };
}) {
  const [fsMap, setFsMap] = useState<Record<string, string> | null>(null);
  const [chat, setChat] = useState<ChatItem[]>([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<AgentStatus>("idle");
  const [library, setLibrary] = useState<LibraryItem[]>([]);
  const [section, setSection] = useState<SectionKey>("inspect");
  const [drawer, setDrawer] = useState(false);
  const [copilot, setCopilot] = useState(false);
  const [uploading, setUploading] = useState(false);
  // server-validated routed circuit (truth); stale after any file change
  const [circuitJson, setCircuitJson] = useState<unknown[] | null>(null);
  const [circuitStale, setCircuitStale] = useState(false);
  // finche' non si sa se esiste una compilazione salvata non si monta il
  // fallback: altrimenti parte una compilazione nel browser (senza la libreria
  // condivisa, che vive sul server) che fallisce e sparisce un attimo dopo
  const [circuitChecked, setCircuitChecked] = useState(false);
  const [summary, setSummary] = useState<Parameters<typeof buildBoardReport>[1]>(null);
  // cosa si sta guardando: tab della scheda, vista scelta, livello, radiografia
  const [tab, setTab] = useState<BoardTab>("pcb");
  const [preset, setPreset] = useState("overview");
  const [flags, setFlags] = useState<ViewFlags>(
    () => VIEW_PRESETS.find((p) => p.key === "overview")!.flags,
  );
  const [layer, setLayer] = useState("top");
  const [xray, setXray] = useState(0);
  const [partId, setPartId] = useState<string | null>(null);
  /**
   * Il cartellino che spiega la vista serve la prima volta e poi copre la
   * scheda: si chiude con la X e non torna piu'. Parte chiuso e si apre dopo il
   * mount (leggere localStorage durante il render rompe l'hydration).
   */
  const [viewNote, setViewNote] = useState(false);
  const [recompiling, setRecompiling] = useState(false);
  // per-section routing variants (Fase 3.d), refreshed after compile/pick
  const [variantSections, setVariantSections] = useState<
    Array<{
      section: string;
      picked: string | null;
      candidates: Array<{ label: string; traces: number; vias: number; lengthMm: number; drc: number }>;
    }>
  >([]);
  const historyRef = useRef<Array<{ role: "user" | "assistant"; content: string }>>([]);

  useEffect(() => {
    try {
      setViewNote(localStorage.getItem("pcb-studio-view-note") !== "off");
    } catch {
      setViewNote(true);
    }
  }, []);

  const dismissViewNote = useCallback(() => {
    setViewNote(false);
    try {
      localStorage.setItem("pcb-studio-view-note", "off");
    } catch {
      // senza storage la scelta vale solo per questa sessione
    }
  }, []);

  const applyPreset = useCallback((p: ViewPreset) => {
    setPreset(p.key);
    setFlags(p.flags);
    setTab("pcb");
  }, []);

  /**
   * Accende sulla scheda la vista che rende visibile una verifica: passando
   * sopra "Distanze minime" si vedono ingombri ed errori, non si deve andare a
   * cercare il livello giusto a mano.
   */
  const showOnBoard = useCallback((key: string) => {
    const next = VIEW_PRESETS.find((p) => p.key === key);
    if (!next) return;
    setTab("pcb");
    setPreset(next.key);
    setFlags(next.flags);
  }, []);

  /** porta una domanda nel copilota, con il pannello gia' aperto */
  const ask = useCallback((prompt: string) => {
    setInput(prompt);
    setCopilot(true);
  }, []);

  /**
   * Ricarica il circuito validato dal server (quello da cui nascono anche gli
   * export). ATTENZIONE: ?circuit=1 e' un endpoint separato che risponde SOLO
   * col circuito compilato, niente file ne' messaggi: va chiesto a parte.
   */
  const loadCircuit = useCallback(async () => {
    const d = await fetch(`/api/project?projectId=${projectId}&circuit=1`)
      .then((r) => r.json())
      .catch(() => null);
    setCircuitChecked(true);
    if (!d?.compile?.circuitJson) return;
    setCircuitJson(d.compile.circuitJson as unknown[]);
    setSummary(d.compile.summary ?? null);
    setCircuitStale(Boolean(d.compile.stale));
  }, [projectId]);

  const loadVariants = useCallback(async () => {
    const d = await fetch(`/api/variants?projectId=${projectId}`)
      .then((r) => r.json())
      .catch(() => null);
    if (d?.sections) setVariantSections(d.sections);
  }, [projectId]);

  /** ricompila e risbroglia senza passare da un turno di chat */
  const recompile = useCallback(async () => {
    setRecompiling(true);
    try {
      const res = await fetch("/api/compile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      const d = await res.json();
      if (d.error) {
        setChat((c) => [...c, { kind: "error", text: String(d.error) }]);
      }
      await loadCircuit();
      await loadVariants();
    } catch (err) {
      setChat((c) => [
        ...c,
        { kind: "error", text: err instanceof Error ? err.message : String(err) },
      ]);
    } finally {
      setRecompiling(false);
    }
  }, [projectId, loadCircuit, loadVariants]);

  /*
   * Editor manuale. Applicare una modifica significa scriverla in
   * manual-edits.json e ricompilare: spostare un componente cambia il rame, e
   * le piste devono seguirlo, altrimenti si guarderebbe uno sbroglio che non
   * corrisponde piu' alla scheda.
   */
  const editor = useManualEditor({ projectId, onApplied: recompile });

  // "instrada" esiste solo sul rame: cambiando scheda la modalita' resterebbe
  // accesa senza fare nulla, e il mouse sembrerebbe rotto
  useEffect(() => {
    if (tab !== "pcb" && editor.mode === "route") editor.setMode("move");
    if (tab !== "pcb" && tab !== "schematic" && editor.mode !== "view") {
      editor.setMode("view");
    }
  }, [tab, editor]);

  useEffect(() => {
    void loadCircuit();

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
  }, [projectId, loadCircuit]);

  const report = useMemo<BoardReport>(
    () => buildBoardReport(circuitJson, summary),
    [circuitJson, summary],
  );

  /**
   * Le segnalazioni del DRC diventano elementi di errore dentro il Circuit
   * JSON dato al viewer: e' il viewer a disegnarle, nel suo sistema di
   * coordinate, con il fumetto al passaggio del mouse. Senza questo si sa cosa
   * non va ma non dove — che sulla scheda e' l'informazione che serve.
   */
  const circuitWithIssues = useMemo(() => {
    if (!circuitJson) return null;
    const violations =
      (summary as { drcViolations?: Array<{ rule: string; message: string; points?: Array<{ x: number; y: number }> }> } | null)
        ?.drcViolations ?? [];
    const markers: unknown[] = [];
    for (const v of violations) {
      for (const [i, point] of (v.points ?? []).entries()) {
        markers.push({
          type: "pcb_trace_error",
          pcb_trace_error_id: `drc_${v.rule}_${i}_${markers.length}`,
          error_type: "pcb_trace_error",
          message: v.message,
          center: point,
          pcb_trace_id: "",
          source_trace_id: "",
          pcb_component_ids: [],
          pcb_port_ids: [],
        });
      }
    }
    return markers.length > 0 ? [...circuitJson, ...markers] : circuitJson;
  }, [circuitJson, summary]);

  const parts = useMemo(() => extractComponents(circuitJson), [circuitJson]);
  const sheetNets = useMemo(
    () =>
      ((summary as { erc?: { nets?: SheetNet[] } } | null)?.erc?.nets ?? []) as SheetNet[],
    [summary],
  );
  const erc = useMemo(
    () => (summary as { erc?: ErcSummary } | null)?.erc ?? null,
    [summary],
  );

  const schematicSummary = useMemo(() => {
    const q = (summary as { schematicQuality?: SchematicSummary } | null)?.schematicQuality;
    return q ?? null;
  }, [summary]);
  const part = useMemo(() => parts.find((p) => p.id === partId) ?? null, [parts, partId]);

  // larghezze effettivamente usate sul rame: senza questo, guardando il canvas
  // non si capisce quale pista e' di potenza e quale di segnale
  const traceWidths = useMemo(() => {
    if (!circuitJson) return [] as number[];
    const widths = new Set<number>();
    for (const el of circuitJson as Array<Record<string, unknown>>) {
      if (el?.type !== "pcb_trace") continue;
      for (const point of (el.route as Array<{ width?: number }> | undefined) ?? []) {
        if (typeof point.width === "number") {
          widths.add(Math.round(point.width * 1000) / 1000);
        }
      }
    }
    return [...widths].sort((a, b) => a - b);
  }, [circuitJson]);

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

  const uploadKicad = useCallback(
    async (files: FileList) => {
      setUploading(true);
      try {
        const form = new FormData();
        for (const file of Array.from(files)) form.append("file", file);
        const res = await fetch("/api/import/kicad", { method: "POST", body: form });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
        for (const comp of d.components ?? []) {
          setChat((c) => [
            ...c,
            {
              kind: "tool",
              name: "kicad",
              detail: `footprint ${comp.name} in libreria (v${comp.version})`,
              ok: true,
            },
          ]);
        }
        void refreshLibrary();
        if (d.project) {
          setChat((c) => [
            ...c,
            {
              kind: "tool",
              name: "kicad",
              detail: `progetto ${d.project.id}: ${d.project.components} componenti, ${d.project.traces} connessioni`,
              ok: true,
            },
          ]);
          // apri il progetto importato
          const url = new URL(window.location.href);
          url.searchParams.set("project", d.project.id);
          window.location.href = url.toString();
        }
      } catch (err) {
        setChat((c) => [
          ...c,
          { kind: "error", text: err instanceof Error ? err.message : String(err) },
        ]);
      } finally {
        setUploading(false);
      }
    },
    [refreshLibrary],
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
      let completed = false;
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

          if (event === "provider") {
            // sapere CHI ha risposto conta: i modelli non si comportano uguale
            // e uno puo' essere subentrato perche' il primo era fuori uso
            setChat((c) => [
              ...c,
              { kind: "tool", name: "modello", detail: String(data.provider), ok: true },
            ]);
          } else if (event === "assistant_text") {
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
              // render the server-validated routing (same circuit json the
              // export endpoints will use), not a fresh browser re-route
              if (data.result?.ok) {
                void loadCircuit();
                void loadVariants();
              }
            }
            if (data.name === "pick_variant" && data.result?.ok) {
              void loadCircuit();
              void loadVariants();
            }
          } else if (event === "file_changed") {
            setFsMap((m) => ({ ...(m ?? {}), [data.path]: data.content }));
            setCircuitStale(true);
          } else if (event === "done") {
            completed = true;
          } else if (event === "error") {
            setChat((c) => [...c, { kind: "error", text: data.message }]);
          }
        }
      }
      if (!completed) {
        // lo stream si e' chiuso senza segnale di fine: la funzione e' stata
        // interrotta (di solito per durata massima). Il lavoro gia' fatto e' salvato.
        setChat((c) => [
          ...c,
          {
            kind: "error",
            text: "Il turno è stato interrotto prima della fine (durata massima). Le modifiche già applicate sono salvate: scrivi «continua» per riprendere.",
          },
        ]);
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
  }, [input, status, projectId, refreshLibrary, loadCircuit, loadVariants]);

  const activePreset =
    VIEW_PRESETS.find((p) => p.key === preset) ?? null;

  return (
    <div className="grid h-dvh grid-rows-[64px_minmax(0,1fr)_60px] overflow-hidden bg-canvas text-text">
      <Header
        projectId={projectId}
        report={report}
        tab={tab}
        onTab={setTab}
        busy={status !== "idle"}
        onOpenProjects={() => setDrawer(true)}
        actions={<HandoffButton projectId={projectId} variant="overlay" compact />}
      />

      {/* la scheda non scende mai sotto una larghezza lavorabile: se la
          finestra e' piccola si scorre, invece di schiacciare il canvas */}
      <main
        className={`grid min-h-0 overflow-x-auto ${
          copilot
            ? "grid-cols-[258px_minmax(330px,1fr)_286px_346px] 2xl:grid-cols-[290px_minmax(430px,1fr)_316px_400px]"
            : "grid-cols-[258px_minmax(330px,1fr)_286px] 2xl:grid-cols-[290px_minmax(430px,1fr)_316px]"
        }`}
      >
        <LeftRail
          tab={tab}
          projectId={projectId}
          report={report}
          nets={sheetNets}
          schematic={schematicSummary}
          parts={parts}
          preset={preset}
          onPreset={applyPreset}
          layer={layer}
          onLayer={setLayer}
          xray={xray}
          onXray={setXray}
          onAskCopilot={() => setCopilot(true)}
        />

        <section className="viewer-shell @container relative min-w-0 overflow-hidden bg-[radial-gradient(1100px_700px_at_52%_42%,#0D1614_0%,#070A09_72%)]">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{
              backgroundImage:
                "linear-gradient(to right,rgba(59,232,176,0.055) 1px,transparent 1px),linear-gradient(to bottom,rgba(59,232,176,0.055) 1px,transparent 1px)",
              backgroundSize: "28px 28px",
            }}
          />

          <div className="absolute inset-0">
            {circuitJson && !circuitStale ? (
              tab === "pcb" ? (
                <PcbView
                  circuitJson={circuitWithIssues ?? circuitJson}
                  flags={flags}
                  layer={layer}
                  xray={xray}
                  mode={editor.mode}
                  editEvents={editor.pending}
                  onEditEvents={editor.replacePending}
                  editorKey={editor.viewerKey}
                />
              ) : tab === "bom" ? (
                <BomView projectId={projectId} />
              ) : tab === "schematic" ? (
                <SchematicView
                  circuitJson={circuitJson}
                  editing={editor.mode !== "view"}
                  editEvents={editor.pending}
                  onEditEvent={editor.pushPending}
                  viewerKey={editor.viewerKey}
                />
              ) : (
                <CircuitJsonPreview
                  key={tab}
                  circuitJson={circuitJson as never}
                  defaultActiveTab={tab as never}
                  availableTabs={[tab] as never}
                  showToggleFullScreen={false}
                />
              )
            ) : fsMap && circuitChecked ? (
              <RunFrame
                // anche la compilazione di ripiego nel browser deve vedere le
                // posizioni fissate a mano, altrimenti il disegno salta
                // indietro ogni volta che manca la compilazione del server
                fsMap={applyManualEditsToFsMap(fsMap)}
                mainComponentPath="main.tsx"
                showRunButton={false}
                availableTabs={["schematic", "pcb", "cad", "bom"]}
                defaultActiveTab={tab}
              />
            ) : (
              <div className="flex h-full items-center justify-center gap-2 text-sm text-faint">
                <span className="dot dot-busy" /> Caricamento del progetto...
              </div>
            )}
          </div>

          {/* modifiche a mano: solo dove hanno senso, cioe' dove si vede la
              geometria. In 3D e sulla distinta non c'e' niente da spostare */}
          {(tab === "pcb" || tab === "schematic") && circuitJson && !circuitStale && (
            <EditorBar editor={editor} scope={tab === "pcb" ? "pcb" : "schematic"} />
          )}

          {/* cosa si sta guardando, sempre leggibile sopra il canvas (non
              sulla distinta, dove coprirebbe le righe della tabella) */}
          {tab !== "bom" && viewNote && (
          <div className="pointer-events-none absolute bottom-[18px] left-[34px] w-[328px] max-w-[calc(100%-68px)] rounded-[14px] border border-[#1F2C29] bg-[rgba(9,14,13,0.88)] px-3.5 py-[13px] backdrop-blur">
            <div className="flex items-center gap-2">
              <span className="h-1.5 w-1.5 rounded-full bg-brand" />
              <span className="text-[12px] font-bold text-[#E7EFEC]">
                {tab === "pcb"
                  ? (activePreset?.label ?? "Livelli scelti a mano")
                  : TAB_TITLES[tab]}
              </span>
              <span className="flex-1" />
              <span className="font-mono text-[10px] text-[#4E625C]">
                {tab === "pcb" ? layerCaption(layer) : TAB_CAPTIONS[tab]}
              </span>
              <button
                type="button"
                onClick={dismissViewNote}
                title="Non mostrare piu'"
                className="pointer-events-auto -mr-1 text-faint transition-colors hover:text-text"
              >
                <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none">
                  <path
                    d="M4 4l8 8M12 4l-8 8"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </div>
            <p className="mt-1.5 text-[12px] leading-[1.5] text-[#8A9C96]">
              {tab === "pcb"
                ? (activePreset?.description ??
                  "Hai acceso e spento i livelli a mano: scegli una vista qui a sinistra per tornare a una configurazione nota.")
                : TAB_BODIES[tab]}
            </p>
          </div>
          )}

          {(tab === "pcb" || tab === "cad") && parts.length > 0 && (
            <PartPicker parts={parts} selected={partId} onSelect={setPartId} />
          )}
          {(tab === "pcb" || tab === "cad") && part && (
            <PartCard part={part} onClose={() => setPartId(null)} onAsk={ask} />
          )}

          {/* larghezze reali delle piste: la piu' larga e' la potenza */}
          {tab === "pcb" && !part && traceWidths.length > 0 && (
            <div className="pointer-events-none absolute right-[18px] bottom-[18px] rounded-[14px] border border-[#2C4C42] bg-[rgba(9,14,13,0.92)] px-3.5 py-[13px] backdrop-blur @max-[760px]:hidden">
              <div className="font-mono text-[10px] tracking-[0.05em] text-[#5F726C]">
                LARGHEZZA PISTE
              </div>
              <div className="mt-1.5 font-mono text-[13px] text-[#E7EFEC]">
                {traceWidths.map((w, i) => (
                  <span
                    key={w}
                    className={
                      i === traceWidths.length - 1 && traceWidths.length > 1
                        ? "text-copper"
                        : undefined
                    }
                  >
                    {w}
                    {i < traceWidths.length - 1 ? " · " : " mm"}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* varianti di sbroglio per sezione: si scelgono chiedendole all'agente */}
          {tab === "pcb" && variantSections.length > 0 && (
            /* sotto la barra dell'editor, che occupa la fascia in alto */
            <div className="absolute inset-x-[34px] top-[86px] flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-[12px] border border-[#1F2C29] bg-[rgba(9,14,13,0.9)] px-3.5 py-2 backdrop-blur">
              {variantSections.map((sec) => (
                <div key={sec.section} className="flex items-center gap-1.5">
                  <span className="font-mono text-[10px] font-semibold tracking-[0.05em] text-[#5F726C]">
                    {sec.section}
                  </span>
                  {sec.candidates.map((cand) => {
                    const active = cand.label === sec.picked;
                    return (
                      <button
                        key={cand.label}
                        type="button"
                        title={`${cand.vias} via · ${cand.lengthMm}mm · ${cand.drc} violazioni`}
                        onClick={() =>
                          ask(`usa la variante ${cand.label} per la sezione ${sec.section}`)
                        }
                        className={`rounded-[7px] border px-2 py-1 font-mono text-[10px] transition-colors ${
                          active
                            ? "border-[#2C4C42] bg-brand-wash text-brand"
                            : "border-line text-muted hover:border-[#3A5A50] hover:text-text"
                        }`}
                      >
                        {cand.label}
                        {cand.drc > 0 ? ` ⚠${cand.drc}` : ""}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </section>

        <RightRail
          tab={tab}
          erc={erc}
          report={report}
          compiledAgo={circuitStale ? "da ricompilare" : "ricompila"}
          onAsk={ask}
          onShowOnBoard={showOnBoard}
          onRecompile={() => void recompile()}
          recompiling={recompiling}
        />
        {copilot && (
          <aside className="flex min-h-0 min-w-0 flex-col border-l border-line bg-surface">
            <header className="flex flex-none items-center gap-2 border-b border-line px-4 py-3">
              <span className="grid h-6 w-6 place-items-center rounded-md border border-[#2C4C42] bg-brand-wash text-[11px] text-brand">
                ✦
              </span>
              <span className="flex-1 text-[13px] font-semibold">Copilota</span>
              <button
                type="button"
                onClick={() => setCopilot(false)}
                title="Chiudi il copilota"
                className="text-faint transition-colors hover:text-text"
              >
                <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none">
                  <path
                    d="M4 4l8 8M12 4l-8 8"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </header>
            <div className="min-h-0 flex-1">
              <Chat
                projectId={projectId}
                items={chat}
                status={status}
                input={input}
                onInput={setInput}
                onSend={() => void send()}
                disabled={status !== "idle"}
              />
            </div>
          </aside>
        )}
      </main>

      <Footer report={report} layer={layer} />

      {/* progetti, libreria, datasheet, condivisione: fuori dal flusso di lavoro
          sulla scheda, si aprono dal nome del progetto in alto a sinistra */}
      {drawer && (
        <div className="fixed inset-0 z-40 flex">
          <div className="flex h-full">
            <Sidebar
              section={section}
              onSection={(s) => {
                // livelli: /org sopra i progetti, /team = settings di QUESTO
                // progetto, library/datasheets = materiali di lavoro full-screen
                const page =
                  s === "org"
                    ? "org"
                    : s === "team"
                      ? "team"
                      : s === "library"
                        ? "library"
                        : s === "datasheets"
                          ? "datasheets"
                          : null;
                if (page) window.location.href = `/${page}?project=${projectId}`;
                else setSection(s);
              }}
              projectId={projectId}
              user={user}
              library={library}
              uploading={uploading}
              onUploadDatasheet={uploadDatasheet}
              onImportKicad={uploadKicad}
              collapsed={false}
              onToggleCollapsed={() => setDrawer(false)}
              circuitJson={circuitJson}
              circuitStale={circuitStale}
              onAsk={(prompt) => {
                setDrawer(false);
                ask(prompt);
              }}
            />
          </div>
          <button
            type="button"
            aria-label="Chiudi il pannello"
            onClick={() => setDrawer(false)}
            className="flex-1 bg-[rgba(4,7,6,0.6)] backdrop-blur-[2px]"
          />
        </div>
      )}

    </div>
  );
}

const TAB_TITLES: Record<BoardTab, string> = {
  schematic: "Schematico",
  pcb: "Sbroglio",
  cad: "Vista 3D",
  bom: "Distinta base",
};

const TAB_CAPTIONS: Record<BoardTab, string> = {
  schematic: "schema elettrico",
  pcb: "",
  cad: "vista 3D",
  bom: "distinta base",
};

const TAB_BODIES: Record<BoardTab, string> = {
  schematic: "Il disegno elettrico: chi è collegato a chi, senza tenere conto di dove stanno i pezzi sulla scheda.",
  pcb: "",
  cad: "La scheda come sarà una volta montata, con gli ingombri veri dei componenti.",
  bom: "L'elenco dei componenti da comprare, con codice fornitore e quantità.",
};

function layerCaption(layer: string): string {
  if (layer === "top") return "lato componenti";
  if (layer === "bottom") return "lato saldature";
  return layer === "inner1" ? "piano interno 1" : "piano interno 2";
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
