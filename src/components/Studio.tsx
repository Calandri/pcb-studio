"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildBoardReport, type BoardReport } from "@/lib/board-report";
import { Chat, type AgentStatus, type ChatItem } from "./Chat";
import { HandoffButton } from "./HandoffButton";
import { BoardCanvas, type BoardZone, type SelectMode } from "./board/BoardCanvas";
import { RouteCanvas } from "./board/RouteCanvas";
import { SchematicView } from "./SchematicView";
import { DesignRulesDialog } from "./workspace/DesignRulesDialog";
import { EditorBar } from "./workspace/EditorBar";
import { useManualEditor } from "./workspace/useManualEditor";
import { Sidebar, type LibraryItem, type SectionKey } from "./Sidebar";
import { VIEW_PRESETS, type ViewFlags, type ViewPreset } from "./ViewPresets";
import { Footer, Header, type BoardTab } from "./workspace/Chrome";
import { LeftRail, type SchematicSummary, type SheetNet } from "./workspace/LeftRail";
import { extractComponents } from "@/lib/inspect";
import { applyManualEditsToFsMap } from "@/lib/manual-edits";
import { BomView } from "./workspace/BomView";
import { StatusView } from "./workspace/StatusView";
import { PartCard } from "./workspace/PartCard";
import { PartPicker } from "./workspace/PartPicker";
import { ClaudeWork } from "./workspace/ClaudeWork";
import { RightRail, type ErcSummary } from "./workspace/RightRail";
import { MassEdit, type MassAction } from "./workspace/MassEdit";
import { useEnclosures } from "@/lib/use-enclosures";

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

const EnclosureCanvas = dynamic(
  () =>
    import("./workspace/EnclosureCanvas").then((m) => m.EnclosureCanvas),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-faint">
        <span className="dot dot-busy" /> Avvio del designer 3D...
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
  // the checks are newer than the cached verification: needs re-checking
  const [checksStale, setChecksStale] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  // until we know whether a saved compilation exists, the fallback is not
  // mounted: otherwise a compilation starts in the browser (without the
  // shared library, which lives on the server), fails, and vanishes a
  // moment later
  const [circuitChecked, setCircuitChecked] = useState(false);
  const [summary, setSummary] = useState<Parameters<typeof buildBoardReport>[1]>(null);
  // what is being looked at: board tab, chosen view, layer, x-ray
  const [tab, setTab] = useState<BoardTab>("pcb");
  const [preset, setPreset] = useState("overview");
  const [flags, setFlags] = useState<ViewFlags>(
    () => VIEW_PRESETS.find((p) => p.key === "overview")!.flags,
  );
  const [layer, setLayer] = useState("top");
  const [xray, setXray] = useState(0);
  const [partId, setPartId] = useState<string | null>(null);
  /** component descriptions written by the model (datasheet + connections) */
  const [partDesc, setPartDesc] = useState<Record<string, { role: string; why: string }>>({});
  /** component whose description the model is writing */
  const [describingPart, setDescribingPart] = useState<string | null>(null);
  // enclosure designer: 3D scene state (the meshes arrive from Phase 3/4)
  const [showEnclosures, setShowEnclosures] = useState(true);
  const [enclosureOpacity, setEnclosureOpacity] = useState(0.92);
  const [explodedMm, setExplodedMm] = useState(0);
  /** component under the mouse on the board: it commands the info card */
  const [hoverPartId, setHoverPartId] = useState<string | null>(null);
  /**
   * The card explaining the view is useful the first time and then it covers
   * the board: it closes with the X and never comes back. It starts closed
   * and opens after mount (reading localStorage during render breaks
   * hydration).
   */
  const [viewNote, setViewNote] = useState(false);
  const [recompiling, setRecompiling] = useState(false);
  /** elapsed seconds: a compilation takes minutes, and without a number that
      moves it looks dead */
  const [recompileSec, setRecompileSec] = useState(0);
  /** what the compiler is doing right now, in Italian */
  const [recompileStep, setRecompileStep] = useState("");
  /** how much is left, 0..1, when the phase can say */
  const [recompileProgress, setRecompileProgress] = useState<number | null>(null);
  const [rulesOpen, setRulesOpen] = useState(false);
  /*
   * "Lavora con Claude" panel: the task to copy, the selection, and the flow
   * of what Claude is doing. The selection state lives HERE and not in the
   * panel because what draws it is the canvas, which is a sibling and not a
   * child: two components that must see the same thing keep it in the
   * parent.
   */
  const [claudeOpen, setClaudeOpen] = useState(false);
  const [selectMode, setSelectMode] = useState<SelectMode>("off");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [zone, setZone] = useState<BoardZone | null>(null);
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
      // without storage the choice only holds for this session
    }
  }, []);

  const applyPreset = useCallback((p: ViewPreset) => {
    setPreset(p.key);
    setFlags(p.flags);
    setTab("pcb");
  }, []);

  /**
   * Switches the board to the view that makes a check visible: hovering over
   * "Distanze minime" shows footprints and errors, without having to go find
   * the right layer by hand.
   */
  const showOnBoard = useCallback((key: string) => {
    const next = VIEW_PRESETS.find((p) => p.key === key);
    if (!next) return;
    setTab("pcb");
    setPreset(next.key);
    setFlags(next.flags);
  }, []);

  /** brings a question into the copilot, with the panel already open */
  const ask = useCallback((prompt: string) => {
    setInput(prompt);
    setCopilot(true);
  }, []);

  /** descriptions already generated on the project: loaded only once */
  useEffect(() => {
    setPartDesc({});
    fetch(`/api/describe-component?projectId=${projectId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d?.descriptions) return;
        setPartDesc(
          Object.fromEntries(
            (d.descriptions as Array<{ component: string; role: string; why: string }>).map(
              (x) => [x.component, { role: x.role, why: x.why }],
            ),
          ),
        );
      })
      .catch(() => {});
  }, [projectId]);

  /** writes (and keeps on the project) the description from datasheet + connections */
  const describePart = useCallback(
    async (name: string) => {
      setDescribingPart(name);
      try {
        const res = await fetch("/api/describe-component", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectId, component: name }),
        });
        const d = await res.json().catch(() => null);
        if (res.ok && d?.role) {
          setPartDesc((prev) => ({ ...prev, [name]: { role: d.role, why: d.why } }));
        }
      } finally {
        setDescribingPart(null);
      }
    },
    [projectId],
  );

  /**
   * Reloads the server-validated circuit (the one the exports are also born
   * from). WARNING: ?circuit=1 is a separate endpoint that answers ONLY with
   * the compiled circuit, no files or messages: it must be asked separately.
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
    setChecksStale(Boolean(d.compile.checksStale));
  }, [projectId]);

  /** re-evaluates the board with the current checks WITHOUT re-routing */
  const recheck = useCallback(async () => {
    setRechecking(true);
    try {
      const res = await fetch("/api/recheck", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      const d = await res.json();
      if (d.error) {
        setChat((c) => [...c, { kind: "error", text: String(d.error) }]);
      } else {
        setChecksStale(false);
        setSummary(d.summary ?? null);
        setChat((c) => [
          ...c,
          {
            kind: "tool",
            name: "ricontrollo",
            detail: d.summary?.message ?? "scheda rivalutata coi controlli correnti",
            ok: Boolean(d.summary?.ok ?? true),
          },
        ]);
      }
    } finally {
      setRechecking(false);
    }
  }, [projectId]);

  const loadVariants = useCallback(async () => {
    const d = await fetch(`/api/variants?projectId=${projectId}`)
      .then((r) => r.json())
      .catch(() => null);
    if (d?.sections) setVariantSections(d.sections);
  }, [projectId]);

  /**
   * Recompiles and re-routes without going through a chat turn.
   *
   * The compilation arrives in pieces, not in one block: each step says what
   * it is doing and, when it has a new drawing, puts it on the board right
   * away. Before, you only saw a stopwatch climbing for eight minutes, and
   * there was no way to tell whether it was working or dead.
   */
  const recompile = useCallback(async () => {
    setRecompiling(true);
    setRecompileSec(0);
    setRecompileStep("Comincio");
    try {
      const res = await fetch("/api/compile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      if (!res.body) throw new Error("nessuna risposta dal compilatore");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // events are separated by a blank line: the last piece may be cut
        // in half and must be set aside for the next round
        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() ?? "";
        for (const chunk of chunks) {
          const event = /^event: (.+)$/m.exec(chunk)?.[1];
          const raw = chunk
            .split("\n")
            .filter((l) => l.startsWith("data: "))
            .map((l) => l.slice(6))
            .join("");
          if (!event || !raw) continue;
          let data: {
            step?: string;
            detail?: string;
            progress?: number;
            circuitJson?: unknown[];
            error?: string;
            summary?: Parameters<typeof buildBoardReport>[1];
          };
          try {
            data = JSON.parse(raw);
          } catch {
            continue;
          }
          if (event === "passo") {
            setRecompileStep(data.detail ? `${data.step} — ${data.detail}` : (data.step ?? ""));
            setRecompileProgress(typeof data.progress === "number" ? data.progress : null);
            // the board updates while it works: that is the whole point of this
            if (data.circuitJson) setCircuitJson(data.circuitJson);
          } else if (event === "errore" && data.error) {
            setChat((c) => [...c, { kind: "error", text: String(data.error) }]);
          } else if (event === "fine" && data.summary) {
            setSummary(data.summary);
          }
        }
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
      setRecompileStep("");
      setRecompileProgress(null);
    }
  }, [projectId, loadCircuit, loadVariants]);

  /**
   * Redoes only the ground. Moving a component or a trace by hand leaves the
   * plane vias where they were, i.e. in the wrong place: this throws them
   * away and redoes them on today's geometry, in a second instead of the
   * three minutes of a full compilation.
   */
  /*
   * "redoing the ground" is in flight: only the setter is read, the flag serves
   * to keep two runs from overlapping on the same planes.
   */
  const [, setRegenGround] = useState(false);
  /** what the mass edit is doing, and for how long */
  const [massBusy, setMassBusy] = useState("");
  const [massSeconds, setMassSeconds] = useState(0);

  const recomputeGround = useCallback(async () => {
    setRegenGround(true);
    try {
      const d = await fetch("/api/ground", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId }),
      }).then((r) => r.json());
      if (d.error) {
        setChat((c) => [...c, { kind: "error", text: String(d.error) }]);
      } else {
        setChat((c) => [
          ...c,
          {
            kind: "tool",
            name: "massa",
            ok: d.isolated === 0,
            detail: `${d.viasAfter} via al piano${
              d.isolated > 0 ? `, ${d.isolated} pad ancora isolati` : ", nessun pad isolato"
            }`,
          },
        ]);
      }
      await loadCircuit();
    } catch (err) {
      setChat((c) => [
        ...c,
        { kind: "error", text: err instanceof Error ? err.message : String(err) },
      ]);
    } finally {
      setRegenGround(false);
    }
  }, [projectId, loadCircuit]);

  useEffect(() => {
    if (!recompiling) return;
    const id = setInterval(() => setRecompileSec((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [recompiling]);

  useEffect(() => {
    if (!massBusy) return;
    const id = setInterval(() => setMassSeconds((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [massBusy]);

  /*
   * A compilation launched ELSEWHERE does not reach this page.
   *
   * The /api/compile stream updates the board live, but only for whoever
   * pressed the button: if the agent, another browser tab or a script is
   * doing the recompiling, here you keep seeing the previous drawing with
   * nothing saying so. Here we check every five seconds whether the
   * compiled circuit on the server has changed, and if so we reload it.
   *
   * We look at createdAt and not the content: it is one line of response
   * instead of a few megabytes of Circuit JSON, and it changes exactly when
   * needed.
   */
  const compiledAtRef = useRef<string | null>(null);
  useEffect(() => {
    if (recompiling) return;
    let alive = true;
    const check = async () => {
      try {
        const d = await fetch(`/api/project?projectId=${projectId}&circuit=1`)
          .then((r) => r.json());
        const at = d?.compile?.createdAt ?? null;
        if (!alive || !at) return;
        if (compiledAtRef.current && compiledAtRef.current !== at) {
          setCircuitJson(d.compile.circuitJson as unknown[]);
          setSummary(d.compile.summary ?? null);
          setCircuitStale(Boolean(d.compile.stale));
          void loadVariants();
        }
        compiledAtRef.current = at;
      } catch {
        // flaky network: try again on the next round
      }
    };
    void check();
    const id = setInterval(check, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [projectId, recompiling, loadVariants]);

  /*
   * Manual editor. Applying an edit means writing it to manual-edits.json
   * and updating the board: moving a component changes the copper, and the
   * traces must follow it, otherwise you would be looking at a routing that
   * no longer matches the board.
   */
  /*
   * After a manual edit: pure moves go through the fast path (cached
   * positions + the zone's copper redone, seconds), circuit changes go
   * through the full compilation — which otherwise does NOT start by
   * itself: compiling stays an explicit gesture ("Ricompila ora").
   */
  /*
   * "Applica" applies, and that is all: it takes the hand-made work and
   * updates the board where something changed. It does not route.
   *
   * Before, it fell back to the full compilation every time the edit was
   * structural, and the full compilation redoes placement and routing from
   * scratch: it moved the components just placed by hand and rewrote the
   * traces just drawn. Minutes of waiting to undo the work of whoever had
   * pressed the button. Rerouting is a separate gesture, and whoever
   * presses it knows what they are asking for.
   */
  const onManualEditApplied = useCallback(async () => {
    const r = await fetch("/api/reroute-local", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId }),
    })
      .then((res) => res.json())
      .catch(() => null);
    await loadCircuit();
    if (!r?.ok) {
      // no recompiling behind the user's back: we say what is missing and let them decide
      setChat((c) => [
        ...c,
        {
          kind: "tool",
          name: "applica",
          ok: false,
          detail: `modifiche salvate, ma il rame non si e' potuto aggiornare qui (${
            r?.reason ?? "motivo sconosciuto"
          }). Premi "Ristrada" quando vuoi rifare le piste.`,
        },
      ]);
    }
  }, [projectId, loadCircuit]);

  const editor = useManualEditor({ projectId, onApplied: onManualEditApplied });

  /*
   * The names of the parts chosen on the board. The selection arrives as
   * copper-component identifiers, but everything downstream — the actions,
   * the agent, the manual edits file — speaks by NAME, which is what is
   * written on the schematic.
   */
  const selectedNames = useMemo(() => {
    if (!circuitJson || selectedIds.length === 0) return [];
    const el = circuitJson as Array<Record<string, unknown>>;
    const nomeDi = new Map<string, string>();
    for (const e of el) {
      if (e.type === "source_component" && e.source_component_id) {
        nomeDi.set(String(e.source_component_id), String(e.name ?? ""));
      }
    }
    const scelti = new Set(selectedIds);
    const out: string[] = [];
    for (const e of el) {
      if (e.type !== "pcb_component") continue;
      if (!scelti.has(String(e.pcb_component_id ?? ""))) continue;
      const nome = nomeDi.get(String(e.source_component_id ?? ""));
      if (nome) out.push(nome);
    }
    return out;
  }, [circuitJson, selectedIds]);

  const totalComponents = useMemo(
    () =>
      circuitJson
        ? (circuitJson as Array<{ type?: string }>).filter((e) => e?.type === "pcb_component").length
        : 0,
    [circuitJson],
  );

  /**
   * Executes a mass action. Each verb knows on its own what to act on,
   * because the scope arrives with it: that is why a button per combination
   * is not needed.
   */
  /** "aggiorna, rame intatto": geometry from the files, copper untouched */
  /** "lavora su questa": the shown board becomes current, files unread */
  const acceptBoardAsIs = useCallback(async () => {
    await fetch("/api/accept-board", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId }),
    }).catch(() => null);
    await loadCircuit();
  }, [projectId, loadCircuit]);

  const runMass = useCallback(
    async (action: MassAction, scope: "selezionati" | "tutto") => {
      const soli = scope === "selezionati" ? selectedNames : [];
      const nomi: Record<MassAction, string> = {
        sposta: "Sistemo i componenti",
        sezioni: "Divido la scheda in sezioni",
        instrada: "Rifaccio le piste",
        mancanti: "Chiudo i collegamenti aperti",
        massa: "Rifaccio la massa",
        ricompila: "Ricompilo la scheda",
        fissa: "Fisso le posizioni",
        sblocca: "Sblocco le posizioni",
      };
      setMassBusy(nomi[action]);
      setMassSeconds(0);
      try {
        if (action === "ricompila") {
          await recompile();
          return;
        }
        if (action === "massa") {
          await recomputeGround();
          return;
        }
        if (action === "fissa" || action === "sblocca") {
          const d = await fetch("/api/manual-edits", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(
              action === "fissa"
                ? { projectId, action: "pin", names: soli }
                : scope === "selezionati"
                  ? // solo i selezionati: con 2+ names=null rilasciava TUTTI i fissati
                    { projectId, action: "release", scope: "pcb", names: soli }
                  : { projectId, action: "release", scope: "pcb", name: null },
            ),
          }).then((r) => r.json());
          setChat((c) => [
            ...c,
            d.error
              ? { kind: "error", text: String(d.error) }
              : {
                  kind: "tool",
                  name: action === "fissa" ? "fissa" : "sblocca",
                  ok: true,
                  detail:
                    action === "fissa"
                      ? `${d.fissati ?? 0} posizioni fissate: nessuna azione le muove piu'`
                      : "posizioni sbloccate",
                },
          ]);
          await loadCircuit();
          return;
        }
        const res = await fetch("/api/reroute", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            projectId,
            mode:
              action === "sposta"
                ? "posiziona"
                : action === "sezioni"
                  ? "sezioni"
                  : action === "instrada"
                    ? "tutto"
                    : "mancanti",
            only: soli,
          }),
        });
        if (!res.body) throw new Error("nessuna risposta dal server");

        // event stream: "passo" = avanzamento (la scheda si aggiorna da sola
        // via preview, qui si vede la fase), "fine" = risultato
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let d: Record<string, unknown> = {};
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const chunks = buffer.split("\n\n");
          buffer = chunks.pop() ?? "";
          for (const chunk of chunks) {
            const event = /^event: (.+)$/m.exec(chunk)?.[1];
            const raw = chunk
              .split("\n")
              .filter((l) => l.startsWith("data: "))
              .map((l) => l.slice(6))
              .join("");
            if (!event || !raw) continue;
            let data: Record<string, unknown>;
            try {
              data = JSON.parse(raw);
            } catch {
              continue;
            }
            if (event === "passo") {
              setMassBusy(`${nomi[action]}${data.detail ? ` — ${String(data.detail)}` : ""}`);
            } else if (event === "piano") {
              /*
               * The section plan is the model's REASONING, not a progress bar:
               * it goes into the chat, where it stays and can be read again. It
               * is the difference between "it moved my parts" and "it moved
               * them there, and here is why".
               */
              const sezioni = Array.isArray(data.sezioni) ? (data.sezioni as Array<Record<string, unknown>>) : [];
              setChat((c) => [
                ...c,
                {
                  kind: "assistant" as const,
                  text: [
                  `**Pianta della scheda** (${String(data.provider ?? "modello")}${Number(data.tentativi) > 1 ? `, ${Number(data.tentativi)} tentativi` : ""})`,
                  "",
                  String(data.ragionamento ?? ""),
                  "",
                  ...sezioni.map(
                    (s) =>
                      `- **${String(s.nome)}** — ${(Number(s.maxX) - Number(s.minX)).toFixed(1)}x${(Number(s.maxY) - Number(s.minY)).toFixed(1)}mm: ${String(s.perche ?? "")}`,
                  ),
                  ].join("\n"),
                },
              ]);
            } else if (event === "fine") {
              d = data;
            } else if (event === "errore") {
              d = { error: data.error ?? "errore sconosciuto" };
            }
          }
        }
        setChat((c) => [
          ...c,
          d.error
            ? { kind: "error", text: String(d.error) }
            : {
                kind: "tool",
                name: nomi[action].toLowerCase(),
                ok: !d.aperte,
                detail:
                  d.aperte !== undefined
                    ? `${d.rounds ?? 0} giri, ${d.aperte} collegamenti ancora aperti`
                    : "fatto",
              },
        ]);
        await loadCircuit();
      } catch (err) {
        setChat((c) => [
          ...c,
          { kind: "error", text: err instanceof Error ? err.message : String(err) },
        ]);
      } finally {
        setMassBusy("");
      }
    },
    [projectId, selectedNames, recompile, recomputeGround, loadCircuit],
  );

  /** "aggiorna, rame intatto": same gesture as "ricompila" — geometry fresh
      from the files, copper untouched (route defaults to false) */
  const refreshGeometryFromFiles = useCallback(async () => {
    await runMass("ricompila", "tutto");
  }, [runMass]);

  /** the same action, but performed by the agent: it is told what and on what */
  const askMass = useCallback(
    (action: MassAction, scope: "selezionati" | "tutto") => {
      const cosa: Record<MassAction, string> = {
        sposta: "sistema il posizionamento",
        sezioni: "dividi la scheda in sezioni logiche e disponi i pezzi dentro le sezioni",
        instrada: "rifai lo sbroglio",
        mancanti: "chiudi i collegamenti aperti",
        massa: "rifai la massa e la cucitura al piano",
        ricompila: "ricompila la scheda e dimmi cosa non va",
        fissa: "fissa le posizioni",
        sblocca: "sblocca le posizioni",
      };
      const su =
        scope === "selezionati" && selectedNames.length > 0
          ? ` di ${selectedNames.join(", ")}`
          : " di tutta la scheda";
      ask(`${cosa[action]}${su}.`);
    },
    [ask, selectedNames],
  );

  /*
   * Moves on the copper. Our canvas (BoardCanvas) emits events with the
   * absolute center: the server translates them into pcbX/pcbY/pcbRotation
   * props while the circuit that generated them is still in cache. While
   * pending, it sees them again right away as overrides, without waiting
   * for the recompilation.
   */
  const moveComponent = useCallback(
    (
      id: string,
      from: { x: number; y: number },
      to: { x: number; y: number },
      rotation?: number,
    ) => {
      editor.pushPending({
        edit_event_type: "edit_pcb_component_location",
        pcb_component_id: id,
        original_center: from,
        new_center: to,
        ...(rotation !== undefined ? { new_rotation: rotation } : {}),
      });
    },
    [editor],
  );
  const pcbMoveOverrides = useMemo(() => {
    const out: Record<string, { x: number; y: number; rotation?: number }> = {};
    for (const ev of editor.pending) {
      if (
        ev.edit_event_type === "edit_pcb_component_location" &&
        ev.pcb_component_id &&
        ev.new_center
      ) {
        /*
         * The events are MERGED, not replaced.
         *
         * Rotating and then moving un-rotated the part: two pending events on
         * the same component, and this loop kept only the last one — the move,
         * which carries no rotation. So the preview fell back to the compiled
         * rotation and the 90 degrees just asked for disappeared under your
         * eyes. Systematic, on every component. Now a rotation stays until
         * someone declares a different one.
         */
        const prima = out[ev.pcb_component_id];
        const rotazione =
          ev.new_rotation !== undefined ? ev.new_rotation : prima?.rotation;
        out[ev.pcb_component_id] = {
          x: ev.new_center.x,
          y: ev.new_center.y,
          ...(rotazione !== undefined ? { rotation: rotazione } : {}),
        };
      }
    }
    return out;
  }, [editor.pending]);

  // "instrada" only exists on the copper: switching tabs would leave the mode
  // on while doing nothing, and the mouse would look broken
  useEffect(() => {
    if (tab !== "pcb" && editor.mode === "route") editor.setMode("move");
    if (tab !== "pcb" && tab !== "schematic" && editor.mode !== "view") {
      editor.setMode("view");
    }
  }, [tab, editor]);

  /*
   * Claude's panel selects by DRAGGING on the board, and that gesture in
   * "sposta" mode drags a component and in "instrada" mode pulls a trace.
   * Opening the panel therefore returns to read-only: two commands fighting
   * over the same drag are a broken command.
   */
  useEffect(() => {
    if (claudeOpen && editor.mode !== "view") editor.setMode("view");
  }, [claudeOpen, editor]);

  // once the panel is closed, the selection must not stay drawn on the board
  useEffect(() => {
    if (claudeOpen) return;
    setSelectMode("off");
    setSelectedIds([]);
    setZone(null);
  }, [claudeOpen]);

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

  // enclosure designer: record from the server + compiled meshes for the 3D canvas
  const enclosures = useEnclosures(projectId, report.widthMm, report.heightMm);

  const drcMarkers = useMemo(() => {
    const violations =
      (summary as { drcViolations?: Array<{ rule: string; message: string; points?: Array<{ x: number; y: number }> }> } | null)
        ?.drcViolations ?? [];
    const out: Array<{ id: string; x: number; y: number; message: string; severity: "err" | "warn" }> = [];
    for (const v of violations) {
      for (const point of v.points ?? []) {
        out.push({
          id: `${v.rule}-${out.length}`,
          x: point.x,
          y: point.y,
          message: v.message,
          severity: /via|escape/.test(v.rule) ? "warn" : "err",
        });
      }
    }
    return out;
  }, [summary]);

  /** ruleset this board was routed and checked with */
  const activeRules =
    (summary as { designRules?: { label?: string } } | null)?.designRules?.label ?? null;

  const parts = useMemo(() => {
    // the sources are needed: description/tags/domain live only in the code,
    // tscircuit accepts them but does not carry them into the Circuit JSON
    const base = extractComponents(circuitJson, fsMap ?? {});
    // the model's descriptions (datasheet + connections) cover the heuristic
    for (const p of base) {
      const d = partDesc[p.name];
      if (d) {
        p.role = d.role;
        p.why = d.why;
      }
    }
    return base;
  }, [circuitJson, partDesc, fsMap]);
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
  const part = useMemo(
    () => parts.find((p) => p.id === (hoverPartId ?? partId)) ?? null,
    [parts, hoverPartId, partId],
  );

  // widths actually used on the copper: without this, looking at the canvas
  // you cannot tell which trace is power and which is signal
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
        /*
         * Which importer to call is decided by the FILE, not by the person: an
         * Altium extension goes to the Altium endpoint, everything else to
         * KiCad. Two buttons would only mean one more way to press the wrong one.
         */
        const altium = Array.from(files).some((f) =>
          /\.(pcbdoc|schdoc|pcblib|schlib|prjpcb|intlib|pcbdwf)$/i.test(f.name),
        );
        const form = new FormData();
        for (const file of Array.from(files)) {
          /*
           * Altium files go up GZIPPED. A request body stops at 4.5 MB on the
           * hosting and a real project is more — the twelve files of one board
           * are 5.8 MB and came back "Request Entity Too Large" — while the same
           * files compressed are 2.8, because an OLE container is half air. The
           * name says it (`<name>.gz`) and the endpoint knows what to do.
           */
          if (altium && typeof CompressionStream === "function") {
            const gz = new Response(
              file.stream().pipeThrough(new CompressionStream("gzip")),
            );
            form.append("file", new Blob([await gz.arrayBuffer()]), `${file.name}.gz`);
          } else {
            form.append("file", file);
          }
        }
        const res = await fetch(altium ? "/api/import/altium" : "/api/import/kicad", {
          method: "POST",
          body: form,
        });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
        for (const comp of d.components ?? []) {
          setChat((c) => [
            ...c,
            {
              kind: "tool",
              name: altium ? "altium" : "kicad",
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
              name: altium ? "altium" : "kicad",
              detail: [
                `progetto ${d.project.id}: ${d.project.components} componenti, ${d.project.traces} connessioni`,
                d.project.routes ? `${d.project.routes} segmenti di rame conservati` : "",
                d.project.footprints ? `${d.project.footprints} footprint in libreria` : "",
                d.project.datasheets?.scaricati
                  ? `${d.project.datasheets.scaricati} datasheet su ${d.project.datasheets.su} (${d.project.datasheets.pagine} pagine)`
                  : "",
              ]
                .filter(Boolean)
                .join(", "),
              ok: true,
            },
          ]);
          // open the imported project
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
            // knowing WHO answered matters: the models do not behave the same
            // and one may have taken over because the first was out of service
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
            if (data.name === "enclosure_save" && data.result?.ok) {
              void enclosures.reload();
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
        // the stream closed without an end signal: the function was
        // interrupted (usually for max duration). The work already done is saved.
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
  }, [input, status, projectId, refreshLibrary, loadCircuit, loadVariants, enclosures]);

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
        actions={
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setClaudeOpen((v) => !v)}
              title="Comandi pronti da passare a Claude, e cosa sta facendo in diretta"
              className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-semibold shadow-sm transition-all hover:-translate-y-px"
              style={{
                background: claudeOpen ? "#0f9d76" : "rgba(28, 34, 43, 0.92)",
                border: "1px solid rgba(255,255,255,0.14)",
                color: "#e8edf2",
              }}
            >
              ✦ Lavora con Claude
            </button>
            <HandoffButton projectId={projectId} variant="overlay" compact />
          </div>
        }
      />

      {/* the board never goes below a workable width: if the window is small
          you scroll, instead of squashing the canvas */}
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
          enclosures={enclosures}
          scene={{
            showEnclosures,
            onShowEnclosures: setShowEnclosures,
            opacity: enclosureOpacity,
            onOpacity: setEnclosureOpacity,
            explodedMm,
            onExplodedMm: setExplodedMm,
          }}
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

          {/* the checks are newer than the cached verification: re-check,
              without re-routing — the traces are not touched, only re-evaluated */}
          {checksStale && circuitJson && (
            <div className="absolute right-4 top-3 z-10 flex items-center gap-2.5 rounded-[10px] border border-[#4A3A16] bg-[rgba(32,24,8,0.92)] px-3 py-2 backdrop-blur">
              <span className="h-1.5 w-1.5 flex-none rounded-full bg-[#E8B23B]" />
              <span className="text-[11px] leading-tight text-[#E8C97A]">
                Controlli aggiornati: questa verifica e&apos; vecchia
              </span>
              <button
                type="button"
                onClick={() => void recheck()}
                disabled={rechecking}
                className="flex-none rounded-md bg-[#E8B23B] px-2.5 py-1 text-[11px] font-semibold text-[#1E1608] transition-colors hover:bg-[#F0C556] disabled:opacity-50"
              >
                {rechecking ? "Ricontrollo…" : "Ricontrolla"}
              </button>
            </div>
          )}

          {/* the saved board is shown ALWAYS, even when stale: it is the best
              one we have. Before, we fell back to the browser compiler, which
              without the shared library fails and leaves the frame empty — and
              it looked like the edit had not arrived. */}
          <div className="absolute inset-0">
            {circuitJson ? (
              tab === "pcb" ? (
                editor.mode === "view" ? (
                  // in read-only we use our own viewer: hover on components,
                  // solder paste, markers at the right spot. For moving and
                  // routing by hand, tscircuit's stays, which already knows
                  // everything about those edits.
                  <BoardCanvas
                    circuitJson={circuitJson}
                    flags={flags}
                    layer={layer}
                    xray={xray}
                    markers={drcMarkers}
                    hoveredComponentId={hoverPartId}
                    onHoverComponent={setHoverPartId}
                    onPickComponent={setPartId}
                    selectMode={selectMode}
                    selectedIds={selectedIds}
                    onSelectionChange={setSelectedIds}
                    zone={zone}
                    onZoneChange={setZone}
                  />
                ) : editor.mode === "route" ? (
                  // hand routing on our canvas: every click is a real corner,
                  // not a suggestion to the autorouter
                  <RouteCanvas
                    circuitJson={circuitJson}
                    width={0.25}
                    pendingRoutes={editor.routes}
                    onRoute={editor.addRoute}
                    resetKey={editor.viewerKey}
                    projectId={projectId}
                    onChanged={() => void loadCircuit()}
                  />
                ) : (
                  // hand moving on our canvas: drag, arrows, rotation — with
                  // grid snap. Before it was tscircuit's viewer: a canvas with
                  // no events, the move would not stick.
                  <BoardCanvas
                    circuitJson={circuitJson}
                    flags={flags}
                    layer={layer}
                    xray={xray}
                    markers={drcMarkers}
                    hoveredComponentId={hoverPartId}
                    onHoverComponent={setHoverPartId}
                    onPickComponent={setPartId}
                    selectMode={selectMode}
                    selectedIds={selectedIds}
                    onSelectionChange={setSelectedIds}
                    zone={zone}
                    onZoneChange={setZone}
                    mode="move"
                    pickedId={partId}
                    moveOverrides={pcbMoveOverrides}
                    onMoveComponent={moveComponent}
                    // only what a PERSON is holding: the placer's own saved
                    // positions are a starting point, not a constraint
                    pinnedNames={editor.saved.pcb_placements
                      .filter((p) => !p.auto)
                      .map((p) => p.selector)}
                    onRelease={(name) => void editor.release("pcb", name)}
                  />
                )
              ) : tab === "bom" ? (
                <BomView projectId={projectId} />
              ) : tab === "stato" ? (
                <StatusView projectId={projectId} />
              ) : tab === "schematic" ? (
                <SchematicView
                  circuitJson={circuitJson}
                  projectId={projectId}
                  mode={editor.mode}
                  saved={editor.saved}
                  onEditEvent={editor.pushPending}
                  resetKey={editor.viewerKey}
                  pendingLinks={editor.links}
                  onLink={editor.addLink}
                  onUnlink={editor.addUnlink}
                />
              ) : (
                // 3D tab: the enclosure designer (board in GLB from the
                // server, enclosures and modules imported as meshes in the
                // same scene)
                <EnclosureCanvas
                  projectId={projectId}
                  boardWidthMm={report.widthMm}
                  boardHeightMm={report.heightMm}
                  parts={parts}
                  meshes={enclosures.meshes}
                  showEnclosures={showEnclosures}
                  enclosureOpacity={enclosureOpacity}
                  explodedMm={explodedMm}
                />
              )
            ) : fsMap && circuitChecked ? (
              <RunFrame
                // the browser fallback compilation must also see the
                // hand-pinned positions, otherwise the drawing jumps back
                // every time the server compilation is missing
                fsMap={applyManualEditsToFsMap(fsMap)}
                mainComponentPath="main.tsx"
                showRunButton={false}
                availableTabs={["schematic", "pcb", "cad", "bom"]}
                // the fallback viewer knows nothing about our own views: on
                // those it opens on the board, which is the closest thing it has
                defaultActiveTab={tab === "stato" ? "pcb" : tab}
              />
            ) : (
              <div className="flex h-full items-center justify-center gap-2 text-sm text-faint">
                <span className="dot dot-busy" /> Caricamento del progetto...
              </div>
            )}
          </div>

          {/* hand edits: only where they make sense, i.e. where the geometry
              is visible. In 3D and on the BOM there is nothing to move */}
          {recompiling && (
            // z-20: without it the preview canvas paints OVER this card and
            // the user sees nothing while waiting. Big and explicit on
            // purpose: the update takes 1–2 minutes, so the panel must say
            // what is happening, how long it usually takes, and that copper
            // is safe.
            <div className="absolute left-1/2 top-1/2 z-20 w-[min(460px,calc(100%-48px))] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[14px] border border-[#2C4C42] bg-[rgba(9,20,17,0.97)] shadow-[0_18px_60px_rgba(0,0,0,0.6)] backdrop-blur">
              <div className="flex items-center gap-3 px-5 pt-4">
                <span className="dot dot-live" />
                <span className="flex-1 text-[14px] font-semibold text-brand">
                  Aggiorno la scheda
                </span>
                <span className="font-mono text-[13px] text-brand">
                  {Math.floor(recompileSec / 60)}:{String(recompileSec % 60).padStart(2, "0")}
                </span>
              </div>
              {/* the live step from the SSE stream: it is the only thing that
                  says whether it is working or fell behind */}
              <div className="truncate px-5 pt-1.5 text-[12.5px] text-[#9DB8AC]">
                {recompileStep || "Avvio della ricompilazione…"}
              </div>
              <div className="px-5 pb-4 pt-1 text-[11.5px] leading-snug text-faint">
                Il rame e le piste non si toccano: non è un instradamento. Il tempo serve a
                rileggere la scheda da zero: su una scheda così può metterci 1–2 minuti.
              </div>
              <div className="h-[4px] w-full bg-[#122620]">
                <div
                  className="h-full bg-brand transition-[width] duration-500"
                  style={{ width: `${Math.round((recompileProgress ?? 0.04) * 100)}%` }}
                />
              </div>
            </div>
          )}


          {/*
            Mass edit: everything that changes the board in one place.
            Before, there were four buttons scattered down here, each with
            its scope inside its name — and there was no way to act on just a
            few parts. Closed, it is a pill, because the thing to look at is
            the board, not the commands.
          */}
          {tab === "pcb" && circuitJson && (
            <MassEdit
              selected={selectedNames}
              total={totalComponents}
              // only what a PERSON pinned: the placer's saved positions are
              // not constraints, and counting them scared "sposta tutto" off
              pinned={editor.counts.pcb}
              stale={circuitStale}
              busy={massBusy || (recompiling ? recompileStep || "Ricompilo" : "")}
              progress={massBusy ? null : recompileProgress}
              seconds={massBusy ? massSeconds : recompileSec}
              onRun={(a, sc) => void runMass(a, sc)}
              onAsk={askMass}
              onRefresh={() => void refreshGeometryFromFiles()}
              onAccept={() => void acceptBoardAsIs()}
            />
          )}

          {(tab === "pcb" || tab === "schematic") && circuitJson && (
            /*
             * The bar stays even when the board on screen is older than the
             * files. Before it vanished, and the board became untouchable with
             * no explanation: no Move button, dragging did nothing, and no
             * reason anywhere. Hand editing really cannot work on a stale board
             * — the coordinates refer to a circuit that no longer matches the
             * sources — but that is something to SAY, with the button to fix it,
             * not something to hide.
             */
            <EditorBar
              editor={editor}
              scope={tab === "pcb" ? "pcb" : "schematic"}
              stale={circuitStale}
              onRecompile={() => void recompile()}
            />
          )}

          {/* what is being looked at, always readable above the canvas (not
              on the BOM, where it would cover the table rows) */}
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

          {/* Claude's panel sits ABOVE the canvas and not in a column:
              it is used to select on the board, and it must stay next to
              what is being selected */}
          {tab === "pcb" && claudeOpen && (
            <ClaudeWork
              projectId={projectId}
              onClose={() => setClaudeOpen(false)}
              parts={parts}
              selectMode={selectMode}
              onSelectMode={setSelectMode}
              selectedIds={selectedIds}
              onSelectedIds={setSelectedIds}
              zone={zone}
              onZone={setZone}
            />
          )}

          {(tab === "pcb" || tab === "cad") && parts.length > 0 && !claudeOpen && (
            <PartPicker parts={parts} selected={partId} onSelect={setPartId} />
          )}
          {/* the component card must not open while the component is being
              moved: it would cover the board right where one is working */}
          {(tab === "pcb" || tab === "cad") && part && editor.mode === "view" && (
            <PartCard
              part={part}
              onClose={() => setPartId(null)}
              onAsk={ask}
              onDescribe={() => describePart(part.name)}
              describing={describingPart === part.name}
              described={Boolean(partDesc[part.name])}
            />
          )}

          {/* per-section routing variants: chosen by asking the agent */}
          {tab === "pcb" && variantSections.length > 0 && (
            /* below the editor bar, which occupies the top strip */
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
          enclosures={enclosures}
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

      {rulesOpen && (
        <DesignRulesDialog
          projectId={projectId}
          onClose={() => setRulesOpen(false)}
          onSaved={() => void recompile()}
        />
      )}

      <Footer
        report={report}
        layer={layer}
        traceWidths={tab === "pcb" ? traceWidths : []}
        activeRules={activeRules}
        onEditRules={() => setRulesOpen(true)}
      />

      {/* projects, library, datasheets, sharing: outside the board workflow,
          they open from the project name at top left */}
      {drawer && (
        <div className="fixed inset-0 z-40 flex">
          <div className="flex h-full">
            <Sidebar
              section={section}
              onSection={(s) => {
                // levels: /org above the projects, /team = settings of THIS
                // project, library/datasheets = full-screen work materials
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
              fsMap={fsMap}
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
  stato: "Stato dei componenti",
};

const TAB_CAPTIONS: Record<BoardTab, string> = {
  schematic: "schema elettrico",
  pcb: "",
  cad: "vista 3D",
  bom: "distinta base",
  stato: "stato dei componenti",
};

const TAB_BODIES: Record<BoardTab, string> = {
  schematic: "Il disegno elettrico: chi è collegato a chi, senza tenere conto di dove stanno i pezzi sulla scheda.",
  pcb: "",
  cad: "La scheda come sarà una volta montata, con gli ingombri veri dei componenti.",
  bom: "L'elenco dei componenti da comprare, con codice fornitore e quantità.",
  stato: "A che punto è ogni componente: footprint controllato, datasheet, errata, a cosa serve qui, collegamenti.",
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
    enclosure_save: "Scocca 3D",
    enclosure_list: "Lettura scocche",
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
    case "enclosure_save":
      return String(args.name ?? "");
    default:
      return "";
  }
}
