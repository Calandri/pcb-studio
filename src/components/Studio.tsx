"use client";

import { avvisoDelProgetto } from "@/lib/progetti-con-difetti";
import { isTypingTarget } from "./keyboard";
import { layerForKey, type LayerId } from "./board/render";
import { stratoDiRame } from "./board/strati-visibili";
import { descriviPezzo } from "@/lib/part-description";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildBoardReport, schematicMissing, type BoardReport } from "@/lib/board-report";
import { didascaliaDelloStrato } from "@/lib/strati-rame";
import { motivoSenzaSchematico, type CompileRun } from "@/lib/compile-run";
import type { ConflittoSerigrafia } from "@/lib/silkscreen-clearance";
import type { IngombriDeiPezzi } from "@/lib/component-clearance";
import { distanzaDeiCorpi } from "@/lib/ingombro";
import { DESIGN_RULES_PATH, eccedenzaDellIngombro, resolveDesignRules, resolveStackup } from "@/lib/design-rules";
import { BoardNotCompiled } from "./workspace/BoardNotCompiled";
import { Chat, type AgentStatus, type ChatItem } from "./Chat";
import { HandoffButton } from "./HandoffButton";
import { BoardCanvas, type BoardZone, type SelectMode } from "./board/BoardCanvas";
import { RouteCanvas } from "./board/RouteCanvas";
import { SchematicView } from "./SchematicView";
import { SCHEMATIC_NOTES_PATH } from "@/lib/schematic-notes";
import { DesignRulesDialog } from "./workspace/DesignRulesDialog";
import { EditorBar } from "./workspace/EditorBar";
import { useManualEditor } from "./workspace/useManualEditor";
import { boardPartsByName, patchesFromEvents, placementOnBoard } from "./workspace/placement-patches";
import { Sidebar, type LibraryItem, type SectionKey } from "./Sidebar";
import { VIEW_PRESETS, type ViewFlags, type ViewPreset } from "./ViewPresets";
import { Footer, Header, type BoardTab } from "./workspace/Chrome";
import { LeftRail, type SchematicSummary, type SheetNet } from "./workspace/LeftRail";
import { extractComponents } from "@/lib/inspect";
import type { EditEvent } from "@/lib/manual-edits";
import { BomView } from "./workspace/BomView";
import { StatusView } from "./workspace/StatusView";
import { PartCard } from "./workspace/PartCard";
import { PartPicker } from "./workspace/PartPicker";
import { ClaudeWork } from "./workspace/ClaudeWork";
import { RightRail, type ErcSummary } from "./workspace/RightRail";
import { MassEdit, type MassAction } from "./workspace/MassEdit";
import { CuciMassa, type AnteprimaCucitura } from "./workspace/CuciMassa";
import { useEnclosures } from "@/lib/use-enclosures";
import { useSharedSelection } from "./workspace/useSharedSelection";
import { readSseStream } from "./sse-stream";
import { ViewerBoundary } from "./ViewerBoundary";

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
  /*
   * The circuit on screen is the compile SAVED on the server, not the preview
   * of one running: only that one has checks behind it, and only that one can
   * say "ready for the factory".
   */
  const [circuitSaved, setCircuitSaved] = useState(false);
  const [circuitStale, setCircuitStale] = useState(false);
  /** a compile running (or cut off) anywhere, from the project's log */
  const [compileRun, setCompileRun] = useState<CompileRun | null>(null);
  /** why the last compile from this page ended without a board, if it did */
  const [compileProblem, setCompileProblem] = useState<string | null>(null);
  // the checks are newer than the cached verification: needs re-checking
  const [checksStale, setChecksStale] = useState(false);
  /*
   * The last compile was NOT saved (no board at all: a syntax error, an
   * exception): what is on screen is the previous board, and it is said in
   * red, with the time of the board shown and why the new one does not compile.
   * Never the old board in silence (sbb-dl-frontale, 2026-11-09).
   */
  const [nonSalvata, setNonSalvata] = useState<{ ora: string; motivo: string; createdAt: string | null } | null>(null);
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
  /** "Sposta" shows the parts of both faces: only when asked for (LeftRail) */
  const [bothSides, setBothSides] = useState(false);

  /*
   * 1, 2, 3...: only that copper layer, in stackup order (1 = Top, the last
   * one = Bottom: 2 on a 2-layer board, 6 on a 6-layer one); 0: all of them.
   * The same as clicking the layer in "Sezione
   * della scheda", so in Sposta it also changes the face whose parts can be
   * grabbed. Only on the board tab (on the schematic 0 frames the sheet), never
   * while typing, never with a modifier (Cmd+1 belongs to the browser).
   * In Instrada the same keys also pick the layer being drawn on, as before.
   */
  const numLayers = useMemo(() => {
    const b = (circuitJson as Array<Record<string, unknown>> | null)?.find((e) => e.type === "pcb_board");
    return typeof b?.num_layers === "number" ? b.num_layers : 2;
  }, [circuitJson]);
  useEffect(() => {
    if (tab !== "pcb") return;
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      const next = layerForKey(e.key, numLayers);
      if (!next) return;
      setLayer(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tab, numLayers]);
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
  /** the board is saved and usable, the schematic is still being drawn (see runCompile) */
  const [schemaInCorso, setSchemaInCorso] = useState(false);
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

  /*
   * Every load of the circuit takes a number, and only the answer to the LAST
   * one asked lands on the board. Loads overlap all the time (the poll, the
   * end of a compile, an agent's tool result) and the network does not answer
   * in order: an older poll arriving after a fresh compile put yesterday's
   * board back on screen.
   */
  const circuitRequest = useRef(0);
  /**
   * Raised by the manual editor while a background save updates the board:
   * between its write and the board that follows, "files newer than the board"
   * is true for a second and means nothing, and it used to switch "Sposta" off.
   */
  const autoSyncRef = useRef(false);
  /** createdAt of the compilation on screen: the poll compares against it */
  const compiledAtRef = useRef<string | null>(null);
  /**
   * The board is behind the files only in hand positions (`editsOnly`): the
   * page brings it up to date by itself, with the fast update, instead of
   * switching "Sposta" off and asking for "Aggiorna" (a full compile, minutes
   * on a big board: sbb-dl-principale, 2026-11-10). `followRef` is that update,
   * set once the editor exists; `followFailedAtRef` is the board (its
   * createdAt) on which it could not be done, so it is tried once per board
   * and then said, not every five seconds.
   */
  const followRef = useRef<() => void>(() => {});
  /** `left`: how many more times the page tries by itself on that board; 0 = it is said, "Aggiorna" is the way */
  const followFailedAtRef = useRef<{ at: string | null; left: number } | null>(null);
  /** what the server says of the saved board, turned into "needs a compile" for the page */
  const staleFrom = useCallback((compile: { stale?: unknown; editsOnly?: unknown; createdAt?: unknown }): boolean => {
    if (!compile.stale) return false;
    if (!compile.editsOnly) return true;
    const at = compile.createdAt == null ? null : String(compile.createdAt);
    // only hand positions differ: follow them, unless that was tried on this very board and could not be done
    const failed = followFailedAtRef.current;
    if (failed && failed.at === at && failed.left <= 0) return true;
    if (!autoSyncRef.current) followRef.current();
    return false;
  }, []);
  /** the first load has answered: before that the poll has nothing to compare */
  const circuitLoadedRef = useRef(false);
  /** previewAt of the running-compile drawing on screen, if any */
  const previewAtRef = useRef<string | null>(null);

  /**
   * Reloads the server-validated circuit (the one the exports are also born
   * from). WARNING: ?circuit=1 is a separate endpoint that answers ONLY with
   * the compiled circuit, no files or messages: it must be asked separately.
   */
  const loadCircuit = useCallback(async () => {
    const request = ++circuitRequest.current;
    const d = await fetch(`/api/project?projectId=${projectId}&circuit=1`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    if (request !== circuitRequest.current) return;
    circuitLoadedRef.current = true;
    setCircuitChecked(true);
    if (!d?.compile?.circuitJson) return;
    // a newer board has been saved since the failed compile: the warning is over
    setNonSalvata((n) => (n && n.createdAt !== (d.compile.createdAt ?? null) ? null : n));
    compiledAtRef.current = d.compile.createdAt ?? null;
    setCircuitJson(d.compile.circuitJson as unknown[]);
    setCircuitSaved(true);
    setCompileProblem(null);
    setSummary(d.compile.summary ?? null);
    // between a save and the board that follows it "older than the files" is true and means nothing
    setCircuitStale(staleFrom(d.compile) && !autoSyncRef.current);
    setChecksStale(Boolean(d.compile.checksStale));
  }, [projectId, staleFrom]);

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
        // a board the recheck could not certify (a plane still over a via) stays out of the export: the notice stays too
        setChecksStale(Boolean(d.nonCertificata));
        setSummary(d.summary ?? null);
        const detail = d.summary?.message ?? "scheda rivalutata coi controlli correnti";
        setChat((c) => [
          ...c,
          {
            kind: "tool",
            name: "ricontrollo",
            detail: d.pianiRicolati ? `${detail} (colate rifatte attorno alle vie)` : detail,
            ok: Boolean(d.summary?.ok ?? true) && !d.nonCertificata,
          },
        ]);
        /*
         * The recheck can pour the planes again (a board from before every via
         * was a through hole): the board saved is then no longer the one on
         * screen, and until a reload the page went on showing the old planes
         * over the holes.
         */
        if (d.pianiRicolati) await loadCircuit();
      }
    } finally {
      setRechecking(false);
    }
  }, [projectId, loadCircuit]);

  /*
   * One job on the board at a time: a compile, a mass action, or the agent's
   * turn. Nothing stopped "Ricompila" from starting while a mass action or the
   * agent was already rewriting the same board, and the two results landed on
   * top of each other in whatever order they finished. Refs, not state: the
   * check must see a job started in this very frame.
   */
  const boardJobRef = useRef<string | null>(null);
  const agentTurnRef = useRef(false);
  const claimBoard = useCallback((what: string): boolean => {
    if (boardJobRef.current || agentTurnRef.current) {
      const who = boardJobRef.current
        ? `c'e' gia' un lavoro in corso sulla scheda (${boardJobRef.current})`
        : "il copilota sta lavorando sulla scheda";
      setChat((c) => [
        ...c,
        { kind: "tool", name: what, ok: false, detail: `${who}: riprova quando ha finito` },
      ]);
      return false;
    }
    boardJobRef.current = what;
    return true;
  }, []);

  /**
   * Recompiles and re-routes without going through a chat turn.
   *
   * The compilation arrives in pieces, not in one block: each step says what
   * it is doing and, when it has a new drawing, puts it on the board right
   * away. Before, you only saw a stopwatch climbing for eight minutes, and
   * there was no way to tell whether it was working or dead.
   *
   * Success needs the final "fine" event. A stream that just closes (the
   * function hit its maximum duration, the network dropped) used to count as
   * a finished compile, and nothing told the person it had stopped half-way.
   */
  const runCompile = useCallback(async () => {
    /*
     * The board is blocked only until it is SAVED: on a big board that is
     * seconds, and the schematic after it can take minutes (sbb-dl-principale:
     * 2:09 on "Disegno lo schematico" with Sposta locked, 2026-11-09). From the
     * "scheda" event on the panel goes away, the board on screen is the saved
     * one and the schematic goes on in the background, said in a corner.
     */
    let sbloccata = false;
    setRecompiling(true);
    setRecompileSec(0);
    setRecompileStep("Comincio");
    // a load still on its way must not land on top of the live drawing
    circuitRequest.current++;
    try {
      const res = await fetch("/api/compile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      if (!res.ok || !res.body) {
        const d = await res.json().catch(() => null);
        throw new Error(d?.error ?? `nessuna risposta dal compilatore (HTTP ${res.status})`);
      }

      let finished = false;
      let failed = false;
      await readSseStream(res.body, (event, raw) => {
        const data = raw as {
          step?: string;
          detail?: string;
          progress?: number;
          circuitJson?: unknown[];
          error?: string;
          summary?: Parameters<typeof buildBoardReport>[1];
        };
        if (event === "scheda") {
          sbloccata = true;
          setRecompiling(false);
          setSchemaInCorso(true);
          void loadCircuit();
        } else if (event === "passo") {
          setRecompileStep(data.detail ? `${data.step} — ${data.detail}` : (data.step ?? ""));
          setRecompileProgress(typeof data.progress === "number" ? data.progress : null);
          // the board updates while it works, until it is saved: after that the
          // board on screen is the person's, and a drawing of the schematic
          // phase must not put back parts they have just moved
          if (Array.isArray(data.circuitJson) && !sbloccata) {
            setCircuitJson(data.circuitJson);
            setCircuitSaved(false);
          }
        } else if (event === "errore") {
          failed = true;
          if (data.error) {
            setChat((c) => [...c, { kind: "error", text: String(data.error) }]);
            setCompileProblem(String(data.error).slice(0, 240));
          }
        } else if (event === "fine") {
          finished = true;
          if (data.summary) setSummary(data.summary);
          const fine = raw as { saved?: boolean; superseded?: boolean; summary?: { message?: string; errors?: Array<{ message?: string }> } };
          // superseded: the saved board is newer than this compile (moves made meanwhile): nothing to warn about
          if (fine.saved === false && !fine.superseded) {
            const quando = compiledAtRef.current;
            setNonSalvata({
              ora: quando ? new Date(quando).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" }) : "?",
              motivo: String(fine.summary?.errors?.[0]?.message ?? fine.summary?.message ?? "motivo sconosciuto").slice(0, 240),
              createdAt: quando,
            });
          } else {
            setNonSalvata(null);
          }
        }
      });
      if (!finished && !failed) {
        setChat((c) => [
          ...c,
          {
            kind: "error",
            text: "La compilazione è stata interrotta prima della fine (durata massima o rete). Quello che era già salvato resta: premi di nuovo «Ricompila» per riprendere.",
          },
        ]);
        setCompileProblem("la compilazione è stata interrotta prima della fine (durata massima o rete)");
      }
      await loadCircuit();
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      setChat((c) => [...c, { kind: "error", text }]);
      setCompileProblem(text.slice(0, 240));
    } finally {
      setRecompiling(false);
      setSchemaInCorso(false);
      setRecompileStep("");
      setRecompileProgress(null);
    }
  }, [projectId, loadCircuit]);

  const recompile = useCallback(async () => {
    if (!claimBoard("ricompila")) return;
    try {
      await runCompile();
    } finally {
      boardJobRef.current = null;
    }
  }, [claimBoard, runCompile]);

  /** "Cuci la massa": open, and the vias it proposes drawn on the board */
  const [cuciAperta, setCuciAperta] = useState(false);
  const [anteprimaCucitura, setAnteprimaCucitura] = useState<AnteprimaCucitura | null>(null);

  /** what the mass edit is doing, and for how long */
  const [massBusy, setMassBusy] = useState("");
  const [massSeconds, setMassSeconds] = useState(0);

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
   * We look at createdAt and not the content: the poll asks ?meta=1, one line
   * of response, and the few megabytes of Circuit JSON are downloaded only
   * when createdAt really changed. It used to ask ?circuit=1, i.e. the whole
   * board every five seconds for as long as the tab stayed open. A hidden tab
   * does not poll at all, and checks again the moment it comes back.
   */
  useEffect(() => {
    if (recompiling) return;
    let alive = true;
    let reloading = false;
    const check = async () => {
      if (document.hidden || reloading) return;
      try {
        const res = await fetch(`/api/project?projectId=${projectId}&meta=1`);
        if (!res.ok) return;
        const d = await res.json();
        const at = d?.compile?.createdAt ?? null;
        const previewAt: string | null = d?.previewAt ?? null;
        if (!alive) return;
        setCompileRun((d?.running as CompileRun | null | undefined) ?? null);
        // the files can change without a compile (write_file from Claude): the score must know
        if (d?.compile && !autoSyncRef.current) setCircuitStale(staleFrom(d.compile));
        if (!circuitLoadedRef.current) return;
        if (at && compiledAtRef.current !== at) {
          reloading = true;
          try {
            previewAtRef.current = null;
            await loadCircuit();
          } finally {
            reloading = false;
          }
          return;
        }
        // a compile running elsewhere (the agent, Claude via MCP, another
        // tab) has drawn something newer: show it while it works, the final
        // board replaces it when it is saved
        if (previewAt && previewAtRef.current !== previewAt) {
          reloading = true;
          try {
            const request = ++circuitRequest.current;
            const p = await fetch(`/api/project?projectId=${projectId}&preview=1`)
              .then((r) => (r.ok ? r.json() : null))
              .catch(() => null);
            if (!alive || request !== circuitRequest.current) return;
            if (p?.preview?.circuitJson) {
              previewAtRef.current = previewAt;
              setCircuitJson(p.preview.circuitJson as unknown[]);
              setCircuitSaved(false);
            }
          } finally {
            reloading = false;
          }
        }
      } catch {
        // flaky network: try again on the next round
      }
    };
    void check();
    const id = setInterval(check, 5000);
    const onVisible = () => {
      if (!document.hidden) void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [projectId, recompiling, loadCircuit, staleFrom]);

  /*
   * Manual editor. Applying an edit means writing it to manual-edits.json
   * and updating the board: moving a component changes the copper, and the
   * traces must follow it, otherwise you would be looking at a routing that
   * no longer matches the board.
   */
  /*
   * After a manual edit: the fast path moves the parts on the cached board and
   * lays the hand-drawn traces on top, in seconds. No copper is redone: the
   * traces of a moved part stay where they were and are redrawn by hand. The
   * full compilation does NOT start by itself: it stays an explicit gesture.
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
  const onManualEditApplied = useCallback(
    async (opts?: { structural?: boolean; background?: boolean }) => {
    /*
     * `retry`: another update or a compile saved a board while this one was
     * working, and the server did not write over it. Nothing went wrong: the
     * same question again, on that board. A few times, then it is said.
     */
    let r: { ok?: boolean; reason?: string; retry?: boolean; needsCompile?: boolean } | null = null;
    for (let giro = 0; giro < 4; giro++) {
      r = await fetch("/api/reroute-local", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId }),
      })
        .then((res) => res.json())
        .catch(() => null);
      if (!r?.retry) break;
      await new Promise((done) => setTimeout(done, 250 * (giro + 1)));
    }
    await loadCircuit();
    /*
     * Tried on this board. What only a compile can do (`needsCompile`) is said
     * at once and "Sposta" waits for "Aggiorna", as before. A failure of the
     * moment (the network, a board saved four times in a row under it) is
     * tried again by the poll, twice more on the same board, then said too:
     * never every five seconds for ever.
     */
    const needsCompile = Boolean(r?.needsCompile);
    if (r?.ok) {
      followFailedAtRef.current = null;
    } else {
      const at = compiledAtRef.current;
      const prima = followFailedAtRef.current;
      const left = needsCompile ? 0 : prima && prima.at === at ? prima.left - 1 : 2;
      followFailedAtRef.current = { at, left };
      if (left <= 0) setCircuitStale(true);
    }
    // the background save says it in the editor bar, once: a chat line per dropped part would be noise
    if (opts?.background) {
      return r?.ok
        ? { ok: true }
        : { ok: false, reason: String(r?.reason ?? "il server non ha risposto"), needsCompile };
    }
    if (!r?.ok) {
      // no recompiling behind the user's back: we say what is missing and let them decide
      setChat((c) => [
        ...c,
        {
          kind: "tool",
          name: "applica",
          ok: false,
          detail: `modifiche salvate, ma la scheda non si e' potuta aggiornare qui (${
            r?.reason ?? "motivo sconosciuto"
          }). Premi "Aggiorna" per rileggere i file: il rame resta quello che c'e'.`,
        },
      ]);
    }
    return { ok: Boolean(r?.ok) };
    },
    [projectId, loadCircuit],
  );

  /*
   * The parts of the board ON SCREEN, by name: a dropped part is saved as the
   * origin this board shows plus the drag (see placement-patches.ts). Read
   * through a ref because the save runs later than the render that dropped it.
   */
  const boardParts = useMemo(() => boardPartsByName(circuitJson), [circuitJson]);
  const boardPartsRef = useRef(boardParts);
  useEffect(() => {
    boardPartsRef.current = boardParts;
  }, [boardParts]);
  const placementsOf = useCallback(
    (events: EditEvent[]) => patchesFromEvents(events, boardPartsRef.current),
    [],
  );

  const editor = useManualEditor({
    projectId,
    onApplied: onManualEditApplied,
    syncingRef: autoSyncRef,
    placementsOf,
    // a detached trace put back by Cmd+Z is on the saved board: it only has to be read again
    reloadBoard: loadCircuit,
  });
  // the fast update, for the poll that finds the board behind the hand positions (see followRef)
  useEffect(() => {
    followRef.current = editor.followBoard;
  }, [editor.followBoard]);

  /*
   * The board changed under edits not applied yet: a compile from elsewhere,
   * the agent, a recompile. The pending moves were drawn on the PREVIOUS board,
   * and the server applies them as displacements on whatever it holds now, so
   * a part the agent has moved in the meantime lands somewhere else than where
   * it was dropped. Not fixable silently: it is said, before "Applica".
   * Our own apply reloads the board while busy, and does not count.
   * Fixed during render, not in an effect, like the other derived resets here.
   *
   * Moves of parts no longer count: they are saved as the absolute place the
   * person let go of the part, read on the board on screen (placement-patches),
   * so a board changing under them does not move them. Links and traces do.
   */
  const [seenCircuit, setSeenCircuit] = useState<unknown[] | null>(null);
  const [swappedUnderEdits, setSwappedUnderEdits] = useState(false);
  const linksOrTraces = editor.links.length + editor.unlinks.length + editor.routes.length;
  if (seenCircuit !== circuitJson) {
    setSeenCircuit(circuitJson);
    // our own background save reloads the board too, with the moves in it: not a swap under the edits
    if (seenCircuit && circuitJson && linksOrTraces > 0 && !editor.busy && !editor.saving && !editor.syncing) {
      setSwappedUnderEdits(true);
    }
    /*
     * A board arrived (our own sync, a recompile, a compile from elsewhere):
     * the overrides it already shows go, the others stay. An older board must
     * not put a part back where it was while the person has moved it since.
     */
    if (seenCircuit && circuitJson) editor.dropAgreed((name) => placementOnBoard(boardParts, name));
  }
  if (swappedUnderEdits && editor.dirty === 0) setSwappedUnderEdits(false);

  /*
   * Moves, links and traces not applied live only in this tab: closing it,
   * reloading or navigating away threw them away without a word. While there
   * is something pending, the browser asks first.
   */
  const leavingRef = useRef(false);
  useEffect(() => {
    // a move being written in the background is not safe yet either
    if (editor.dirty === 0 && !editor.saving) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (leavingRef.current) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [editor.dirty, editor.saving]);

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
        ricompila: "Ricompilo la scheda",
        fissa: "Fisso le posizioni",
        sblocca: "Sblocco le posizioni",
      };
      if (!claimBoard(nomi[action].toLowerCase())) return;
      setMassBusy(nomi[action]);
      setMassSeconds(0);
      try {
        if (action === "ricompila") {
          await runCompile();
          return;
        }
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
      } catch (err) {
        setChat((c) => [
          ...c,
          { kind: "error", text: err instanceof Error ? err.message : String(err) },
        ]);
      } finally {
        setMassBusy("");
        boardJobRef.current = null;
      }
    },
    [projectId, selectedNames, claimBoard, runCompile, loadCircuit],
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
  /*
   * The NAME of every part on the board on screen, and back. Moves travel with
   * the name: the ids are those of THIS compile, and a recompile from elsewhere
   * before the save gave them to other parts (2026-11-09, HTL-401).
   */
  const partNames = useMemo(() => {
    const byPcbId = new Map<string, string>();
    const bySchId = new Map<string, string>();
    const pcbIdOf = new Map<string, string>();
    if (!circuitJson) return { byPcbId, bySchId, pcbIdOf };
    const nomeDi = new Map<string, string>();
    for (const e of circuitJson as Array<Record<string, unknown>>) {
      if (e?.type === "source_component" && typeof e.name === "string" && e.name) {
        nomeDi.set(String(e.source_component_id), e.name);
      }
    }
    for (const e of circuitJson as Array<Record<string, unknown>>) {
      const nome = nomeDi.get(String(e?.source_component_id ?? ""));
      if (!nome) continue;
      if (e.type === "pcb_component" && typeof e.pcb_component_id === "string") {
        byPcbId.set(e.pcb_component_id, nome);
        if (!pcbIdOf.has(nome)) pcbIdOf.set(nome, e.pcb_component_id);
      } else if (e.type === "schematic_component" && typeof e.schematic_component_id === "string") {
        bySchId.set(e.schematic_component_id, nome);
      }
    }
    return { byPcbId, bySchId, pcbIdOf };
  }, [circuitJson]);

  /** a schematic move, with the name of the part as it is on the schematic on screen */
  const pushSchematicEdit = useCallback(
    (event: EditEvent) => {
      const nome =
        event.schematic_component_id !== undefined
          ? partNames.bySchId.get(event.schematic_component_id)
          : undefined;
      editor.pushPending(nome ? { ...event, component_name: nome } : event);
    },
    [editor, partNames],
  );

  const moveComponent = useCallback(
    (
      id: string,
      from: { x: number; y: number },
      to: { x: number; y: number },
      rotation?: number,
      layer?: "top" | "bottom",
      gruppo?: string,
    ) => {
      const nome = partNames.byPcbId.get(id);
      // how the part was on screen when the gesture started: Cmd+Z puts it back exactly so
      const prima = overridesRef.current[id];
      const sullaScheda = nome ? boardPartsRef.current.get(nome) : undefined;
      editor.pushPending({
        edit_event_type: "edit_pcb_component_location",
        pcb_component_id: id,
        ...(nome ? { component_name: nome } : {}),
        original_center: from,
        original_rotation: prima?.rotation ?? sullaScheda?.rotation ?? 0,
        original_layer: prima?.layer ?? sullaScheda?.layer ?? "top",
        new_center: to,
        ...(rotation !== undefined ? { new_rotation: rotation } : {}),
        // "Gira lato": the other face travels with the event, like the rotation
        ...(layer !== undefined ? { new_layer: layer } : {}),
        // one gesture on many parts: undone together
        ...(gruppo ? { gruppo } : {}),
      });
    },
    [editor, partNames],
  );
  const pcbMoveOverrides = useMemo(() => {
    const out: Record<string, { x: number; y: number; rotation?: number; layer?: "top" | "bottom" }> = {};
    for (const ev of editor.pending) {
      // by name: after a recompile the same part has another id, and its old id
      // may belong to another part (a part no longer on the board shows nothing)
      const id = ev.component_name ? partNames.pcbIdOf.get(ev.component_name) : ev.pcb_component_id;
      if (ev.edit_event_type === "edit_pcb_component_location" && id && ev.new_center) {
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
        const prima = out[id];
        const rotazione =
          ev.new_rotation !== undefined ? ev.new_rotation : prima?.rotation;
        // the face, like the rotation: a later move does not turn it back
        const lato = ev.new_layer !== undefined ? ev.new_layer : prima?.layer;
        out[id] = {
          x: ev.new_center.x,
          y: ev.new_center.y,
          ...(rotazione !== undefined ? { rotation: rotazione } : {}),
          ...(lato !== undefined ? { layer: lato } : {}),
        };
      }
    }
    return out;
  }, [editor.pending, partNames]);
  const overridesRef = useRef(pcbMoveOverrides);
  useEffect(() => {
    overridesRef.current = pcbMoveOverrides;
  }, [pcbMoveOverrides]);

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

  /** design-rules.json as it is written: the report reads the stackup from it, and is redone only when this file changes */
  const fileDelleRegole = fsMap?.[DESIGN_RULES_PATH];
  /*
   * Computed here, above every boundary: a throw on an odd Circuit JSON would
   * take the whole studio down, so it degrades to the empty report instead.
   */
  const report = useMemo<BoardReport>(() => {
    try {
      return buildBoardReport(
        circuitJson,
        summary,
        {
          saved: circuitSaved,
          stale: circuitStale,
          checksStale,
        },
        // the stackup the project declares: the depths of the "Sezione della scheda" panel
        resolveStackup(fileDelleRegole ? { [DESIGN_RULES_PATH]: fileDelleRegole } : {}),
      );
    } catch (err) {
      console.error("resoconto della scheda non calcolato:", err);
      return buildBoardReport(null, null);
    }
  }, [circuitJson, summary, circuitSaved, circuitStale, checksStale, fileDelleRegole]);

  // enclosure designer: record from the server + compiled meshes for the 3D canvas
  const enclosures = useEnclosures(projectId, report.widthMm, report.heightMm);

  const drcMarkers = useMemo(() => {
    const violations =
      (summary as { drcViolations?: Array<{ rule: string; message: string; points?: Array<{ x: number; y: number; layer?: string }> }> } | null)
        ?.drcViolations ?? [];
    const out: Array<{ id: string; x: number; y: number; message: string; severity: "err" | "warn"; layer?: LayerId }> = [];
    for (const v of violations) {
      for (const point of v.points ?? []) {
        out.push({
          id: `${v.rule}-${out.length}`,
          x: point.x,
          y: point.y,
          message: v.message,
          severity: /via|escape/.test(v.rule) ? "warn" : "err",
          /*
           * The layer the checker found the problem on (drc.ts, PuntoDrc): the
           * dot follows it like the copper it is about. No layer = through the
           * board, or a board checked before the checker said it: on every face.
           */
          layer: stratoDiRame(point.layer),
        });
      }
    }
    // the silkscreen clashes, kept apart from the DRC: a warning, in amber (see silkscreen-clearance.ts)
    const serigrafia =
      (summary as { silkscreen?: { conflitti?: ConflittoSerigrafia[] } } | null)?.silkscreen?.conflitti ?? [];
    for (const c of serigrafia) {
      out.push({
        id: `${c.tipo}-${out.length}`,
        x: c.x,
        y: c.y,
        message:
          `serigrafia (${c.faccia}): ${c.a} <-> ${c.b}, ${c.distanzaMm.toFixed(3)}mm` +
          (c.minimoMm > 0 ? ` < ${c.minimoMm}mm` : ", tocca il foro"),
        severity: "warn",
        layer: c.faccia,
      });
    }
    /*
     * The footprints (see component-clearance.ts), each on its face: two parts
     * that hit each other in red like the errors, the warnings in amber.
     */
    const ingombri = (summary as { courtyards?: IngombriDeiPezzi } | null)?.courtyards;
    for (const c of ingombri?.scontri ?? []) {
      out.push({
        id: `scontro-${out.length}`,
        x: c.x,
        y: c.y,
        message:
          `ingombri (${c.faccia}): ${c.a} e ${c.b} si scontrano in montaggio, ingombri sovrapposti di ${c.sovrapposizioneMm.toFixed(3)}mm, ` +
          `${distanzaDeiCorpi(c)} (${c.fonteA} / ${c.fonteB})`,
        severity: "err",
        layer: c.faccia,
      });
    }
    for (const c of ingombri?.nelloSpazioDiInnesto?.pezzi ?? []) {
      out.push({
        id: `innesto-${out.length}`,
        x: c.x,
        y: c.y,
        message: `${c.pezzo} sta dove si infila ${c.descrizione ?? "la spina"} di ${c.connettore}`,
        severity: "warn",
        layer: c.faccia,
      });
    }
    for (const c of ingombri?.senzaIngombroVero.pezzi ?? []) {
      out.push({
        id: `senza-ingombro-${out.length}`,
        x: c.x,
        y: c.y,
        message: `${c.pezzo}: ingombro ricavato dalle sole piazzole, metti nel footprint il corpo vero (cortile)`,
        severity: "warn",
        layer: c.faccia,
      });
    }
    for (const c of ingombri?.ingombroNonNoto?.pezzi ?? []) {
      out.push({
        id: `ingombro-non-noto-${out.length}`,
        x: c.x,
        y: c.y,
        message: `${c.pezzo}: ingombro non noto (niente piazzole, cortile o corpo da cui leggerlo), il controllo non lo misura`,
        severity: "warn",
        layer: c.faccia,
      });
    }
    for (const c of ingombri?.disegniDiScheda.pezzi ?? []) {
      out.push({
        id: `disegno-di-scheda-${out.length}`,
        x: c.x,
        y: c.y,
        message:
          c.tipo === "contorno e sigla"
            ? `il contorno e la sigla di ${c.pezzo} sono disegni di scheda: non seguono il pezzo quando lo sposti`
            : `${c.tipo === "contorno" ? "il contorno" : "la sigla"} di ${c.pezzo} e' un disegno di scheda: non segue il pezzo quando lo sposti`,
        severity: "warn",
        layer: c.faccia,
      });
    }
    return out;
  }, [summary]);

  /** the excess around a part the project asks (design-rules.json), for the footprints the viewer draws */
  const eccedenzaIngombro = useMemo(() => eccedenzaDellIngombro(resolveDesignRules(fsMap ?? {}).rules), [fsMap]);

  /** ruleset this board was routed and checked with */
  const activeRules =
    (summary as { designRules?: { label?: string } } | null)?.designRules?.label ?? null;

  const parts = useMemo(() => {
    // the sources are needed: description/tags/domain live only in the code,
    // tscircuit accepts them but does not carry them into the Circuit JSON
    let base: ReturnType<typeof extractComponents>;
    try {
      base = extractComponents(circuitJson, fsMap ?? {});
    } catch (err) {
      // same reason as the report: above the boundaries, an empty list beats a blank page
      console.error("componenti non letti dal circuito:", err);
      base = [];
    }
    // the model's descriptions go next to the others, never over them: what is
    // written in the sources wins (part-description.ts)
    for (const p of base) p.generated = partDesc[p.name] ?? null;
    return base;
  }, [circuitJson, partDesc, fsMap]);
  // the part picked on the board and the selection on the schematic are one
  // thing, and it travels in the URL (?sel=U3): a link opens on that part
  const { selection, pickPart, selectFromSchematic } = useSharedSelection({
    parts,
    tab,
    setTab,
    partId,
    setPartId,
  });
  /** what each part is, for the card next to it in "Sposta" (part-description.ts) */
  const partInfo = useMemo(
    () => Object.fromEntries(parts.map((p) => [p.id, { name: p.name, ...descriviPezzo(p) }])),
    [parts],
  );
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
  /*
   * The card of the part that was CLICKED, in the right column: never over the
   * board. Hovering only fills the bar under the board (BoardCanvas).
   */
  const part = useMemo(() => parts.find((p) => p.id === partId) ?? null, [parts, partId]);

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

  /*
   * Le famiglie di via, contate: la stessa cosa che il piede mostra gia' per le
   * piste. Stavano solo dentro il pannello delle regole, dietro una matita, e
   * "dove le vedo?" era la domanda giusta: le misure che una scheda usa sono la
   * prima cosa da vedere, non l'ultima.
   */
  const viaSizes = useMemo(() => {
    if (!circuitJson) return [] as Array<{ pad: number; foro: number; quante: number }>;
    const fam = new Map<string, { pad: number; foro: number; quante: number }>();
    for (const el of circuitJson as Array<Record<string, unknown>>) {
      if (el?.type !== "pcb_via") continue;
      const pad = Math.round(Number(el.outer_diameter ?? 0) * 1000) / 1000;
      const foro = Math.round(Number(el.hole_diameter ?? 0) * 1000) / 1000;
      if (!(pad > 0) || !(foro > 0)) continue;
      const k = `${pad}/${foro}`;
      const c = fam.get(k) ?? { pad, foro, quante: 0 };
      c.quante++;
      fam.set(k, c);
    }
    return [...fam.values()].sort((a, b) => a.foro - b.foro);
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
          // open the imported project, unless that throws away work not applied
          if (
            editor.dirty > 0 &&
            !window.confirm(
              `Hai ${editor.dirty} modifiche non applicate su questa scheda: aprendo il progetto importato andranno perse. Lo apro lo stesso?`,
            )
          ) {
            setChat((c) => [
              ...c,
              {
                kind: "tool",
                name: altium ? "altium" : "kicad",
                ok: true,
                detail: `progetto ${d.project.id} pronto: aprilo dai progetti quando hai applicato o scartato le modifiche`,
              },
            ]);
            return;
          }
          leavingRef.current = true;
          const url = new URL(window.location.href);
          url.searchParams.set("project", d.project.id);
          // the selection belongs to the project being left
          url.searchParams.delete("sel");
          url.searchParams.delete("tab");
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
    [refreshLibrary, editor.dirty],
  );

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || status !== "idle") return;
    setInput("");
    setChat((c) => [...c, { kind: "user", text }]);
    const historyBefore = historyRef.current.length;
    historyRef.current.push({ role: "user", content: text });
    setStatus("thinking");
    agentTurnRef.current = true;

    let assistantText = "";
    /** the server accepted the turn and the stream opened */
    let started = false;
    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, history: historyRef.current }),
      });
      if (!res.ok || !res.body) {
        // the server says why (a run already active on the project, the hourly
        // limit, a key that does not decrypt): the bare status said nothing
        const d = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(d?.error ?? `HTTP ${res.status}`);
      }
      started = true;

      let completed = false;
      await readSseStream(res.body, (event, raw) => {
        const data = raw as {
          provider?: unknown;
          text?: string;
          name?: string;
          args?: Record<string, unknown>;
          result?: { ok?: boolean; message?: string };
          path?: string;
          content?: string;
          message?: string;
        };

        if (event === "provider") {
          // knowing WHO answered matters: the models do not behave the same
          // and one may have taken over because the first was out of service
          setChat((c) => [
            ...c,
            { kind: "tool", name: "modello", detail: String(data.provider), ok: true },
          ]);
        } else if (event === "assistant_text") {
          const piece = String(data.text ?? "");
          assistantText += (assistantText ? "\n\n" : "") + piece;
          setChat((c) => [...c, { kind: "assistant", text: piece }]);
          setStatus("thinking");
        } else if (event === "tool_call") {
          const name = String(data.name ?? "");
          setStatus("tool");
          setChat((c) => [
            ...c,
            { kind: "tool", name: toolLabel(name), detail: toolDetail(name, data.args ?? {}) },
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
            if (data.result?.ok) void loadCircuit();
          }
          if (data.name === "enclosure_save" && data.result?.ok) {
            void enclosures.reload();
          }
        } else if (event === "file_changed") {
          if (typeof data.path === "string" && typeof data.content === "string") {
            const { path, content } = data;
            setFsMap((m) => ({ ...(m ?? {}), [path]: content }));
          }
          // the drawing's notes are not a source: the board needs no compile
          if (data.path !== SCHEMATIC_NOTES_PATH) setCircuitStale(true);
        } else if (event === "done") {
          completed = true;
        } else if (event === "error") {
          setChat((c) => [...c, { kind: "error", text: String(data.message ?? "errore") }]);
        }
      });
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
      agentTurnRef.current = false;
      /*
       * The history must alternate user / assistant. A failed turn used to
       * leave its user message behind, and the next one sent two in a row.
       * Never started (refused, offline): the request is taken back and its
       * text goes back in the box. Started but cut before any text: the
       * model's turn is recorded as interrupted, so that "continua" still
       * knows what it is continuing.
       */
      if (assistantText) {
        historyRef.current.push({ role: "assistant", content: assistantText });
      } else if (!started) {
        historyRef.current.splice(historyBefore);
        setInput((current) => current || text);
      } else {
        historyRef.current.push({
          role: "assistant",
          content: "(turno interrotto prima di una risposta: le modifiche gia' applicate sono salvate)",
        });
      }
      setStatus("idle");
    }
  }, [input, status, projectId, refreshLibrary, loadCircuit, enclosures]);

  const activePreset =
    VIEW_PRESETS.find((p) => p.key === preset) ?? null;

  /** something is already working on the board: the triggers of another job are off */
  const boardBusy = recompiling || massBusy !== "" || status !== "idle";
  /** the saved board has no schematic yet: see CompileOptions.onBoard */
  const schematicPending = useMemo(
    () => Boolean((summary as { schematicPending?: string } | null)?.schematicPending) || schematicMissing(circuitJson),
    [summary, circuitJson],
  );
  /** the compile closed without the schematic, it would not have ended in time: its reason (see stimaDelloSchematico) */
  const schematicoNonPartito = motivoSenzaSchematico((summary as { schematicPending?: unknown } | null)?.schematicPending);

  return (
    <div className="grid h-dvh grid-rows-[64px_minmax(0,1fr)_60px] overflow-hidden bg-canvas text-text">
      <Header
        projectId={projectId}
        report={report}
        tab={tab}
        onTab={setTab}
        busy={status !== "idle" || recompiling}
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
          bothSides={bothSides}
          onBothSides={setBothSides}
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

          {avvisoDelProgetto(projectId) && (
            <div className="absolute left-1/2 top-[110px] z-20 flex max-w-[min(640px,92%)] -translate-x-1/2 items-start gap-2.5 rounded-[10px] border border-[#5A2420] bg-[rgba(40,12,10,0.95)] px-3 py-2">
              <span className="mt-1 h-1.5 w-1.5 flex-none rounded-full bg-danger" />
              <span className="text-[11.5px] font-semibold leading-snug text-[#FFB4AB]">
                {projectId}: {avvisoDelProgetto(projectId)}
              </span>
            </div>
          )}

          {nonSalvata && circuitJson && (
            <div className="absolute left-1/2 top-[70px] z-20 flex max-w-[min(640px,92%)] -translate-x-1/2 items-start gap-2.5 rounded-[10px] border border-[#5A2420] bg-[rgba(40,12,10,0.95)] px-3 py-2 backdrop-blur">
              <span className="mt-1 h-1.5 w-1.5 flex-none rounded-full bg-danger" />
              <span className="text-[11.5px] leading-snug text-[#FFB4AB]">
                A schermo c&apos;e&apos; la versione delle {nonSalvata.ora}: la nuova non compila per: {nonSalvata.motivo}
              </span>
            </div>
          )}

          {/* the board was saved before its schematic (big boards: see
              CompileOptions.onBoard): the sheet says why it is empty */}
          {tab === "schematic" && circuitJson && schematicPending && (
            <div className="absolute left-1/2 top-[70px] z-20 flex max-w-[min(640px,92%)] -translate-x-1/2 items-start gap-2.5 rounded-[10px] border border-[#4A3A16] bg-[rgba(32,24,8,0.95)] px-3 py-2 backdrop-blur">
              <span className="mt-1 h-1.5 w-1.5 flex-none rounded-full bg-[#E8B23B]" />
              <span className="text-[11.5px] leading-snug text-[#E8C97A]">
                {recompiling || compileRun?.state === "running"
                  ? "Schematico in calcolo: la scheda e' gia' salvata, lo schematico compare quando la compilazione finisce."
                  : schematicoNonPartito
                    ? // the compile chose not to start it, and says why: "Ricompila" would choose the same
                      `Lo schematico di questa scheda non e' stato calcolato: ${schematicoNonPartito}.`
                    : "Lo schematico di questa scheda non e' stato calcolato: l'ultima compilazione si e' fermata dopo aver salvato la scheda. Premi Ricompila per riprovare."}
              </span>
            </div>
          )}

          {schemaInCorso && (
            <div className="pointer-events-none absolute bottom-[76px] right-[18px] z-20 flex items-center gap-2 rounded-[9px] border border-[#2C4C42] bg-[rgba(9,20,17,0.9)] px-2.5 py-1.5 text-[11px] text-[#9DB8AC]">
              <span className="dot dot-live" />
              Schematico in aggiornamento: la scheda si usa gia&apos;
            </div>
          )}

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
            {/* one boundary for whichever view is on: a view that cannot draw
                this circuit goes alone, with retry and recompile */}
            <ViewerBoundary
              label={VIEW_LABELS[circuitJson ? tab : "fallback"]}
              resetKeys={[circuitJson, tab, editor.mode]}
              onRecompile={() => void recompile()}
            >
              {circuitJson ? (
                tab === "pcb" ? (
                  editor.mode === "view" ? (
                    // in read-only we use our own viewer: hover on components,
                    // solder paste, markers at the right spot. For moving and
                    // routing by hand, tscircuit's stays, which already knows
                    // everything about those edits.
                    <BoardCanvas
                      vistaKey={projectId}
                      circuitJson={circuitJson}
                      flags={flags}
                      layer={layer}
                      xray={xray}
                      markers={drcMarkers}
                      anteprimaVie={anteprimaCucitura}
                      eccedenzaIngombroMm={eccedenzaIngombro}
                      hoveredComponentId={hoverPartId}
                      onHoverComponent={setHoverPartId}
                      onPickComponent={pickPart}
                      partInfo={partInfo}
                      // the part picked here or on the schematic: outlined.
                      // Not while Claude's panel is picking parts: there the
                      // outline means "in the selection", and it would lie
                      pickedId={selectMode === "off" ? partId : null}
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
                      onDetached={editor.recordDetached}
                      // the rail's layer and x-ray: one choice for the three modes
                      layer={layer}
                      onLayer={setLayer}
                      xray={xray}
                    />
                  ) : (
                    // hand moving on our canvas: drag, arrows, rotation — with
                    // grid snap. Before it was tscircuit's viewer: a canvas with
                    // no events, the move would not stick.
                    <BoardCanvas
                      vistaKey={projectId}
                      circuitJson={circuitJson}
                      flags={flags}
                      layer={layer}
                      xray={xray}
                      markers={drcMarkers}
                      anteprimaVie={anteprimaCucitura}
                      eccedenzaIngombroMm={eccedenzaIngombro}
                      hoveredComponentId={hoverPartId}
                      onHoverComponent={setHoverPartId}
                      onPickComponent={pickPart}
                      selectMode={selectMode}
                      selectedIds={selectedIds}
                      onSelectionChange={setSelectedIds}
                      zone={zone}
                      onZoneChange={setZone}
                      mode="move"
                      bothSides={bothSides}
                      partInfo={partInfo}
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
                    onEditEvent={pushSchematicEdit}
                    pendingEvents={editor.pending}
                    resetKey={editor.viewerKey}
                    pendingLinks={editor.links}
                    onLink={editor.addLink}
                    onUnlink={editor.addUnlink}
                    selection={selection}
                    onSelectionChange={selectFromSchematic}
                    notes={fsMap?.[SCHEMATIC_NOTES_PATH]}
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
              ) : circuitChecked ? (
                /*
                 * NO BOARD ON THE SERVER: it is said, with the button. There
                 * used to be tscircuit's RunFrame here, compiling the board in
                 * the browser: on fototrappola-frontale (219 parts, a 264-ball
                 * BGA) it never got to draw, the frame stayed empty with its
                 * "customize the autorouter" tip, and a browser compile is one
                 * more place that could route on its own. The board is only the
                 * one the server compiled and saved.
                 */
                <BoardNotCompiled
                  run={compileRun}
                  recompiling={recompiling}
                  step={recompileStep}
                  seconds={recompileSec}
                  problem={compileProblem}
                  busy={boardBusy}
                  onRecompile={() => void recompile()}
                />
              ) : (
                <div className="flex h-full items-center justify-center gap-2 text-sm text-faint">
                  <span className="dot dot-busy" /> Caricamento del progetto...
                </div>
              )}
            </ViewerBoundary>
          </div>

          {/* while "Applica" (or undo) is writing, links and traces wait: they
              speak in pad ids of the board being replaced. Parts can still be
              moved: a move travels by name and is saved after */}
          {editor.busy && (editor.mode === "route" || editor.mode === "link") && (tab === "pcb" || tab === "schematic") && (
            <div
              aria-hidden
              title="Applico le modifiche: un attimo"
              className="absolute inset-0 z-[15] cursor-wait"
            />
          )}

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
                Il rame e le piste non si toccano: non è un instradamento. La scheda si salva
                appena letta, in pochi secondi; lo schematico arriva dopo, e su una scheda
                grande può richiedere qualche minuto.
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
              busy={
                massBusy ||
                (recompiling
                  ? recompileStep || "Ricompilo"
                  : status !== "idle"
                    ? "Il copilota sta lavorando sulla scheda"
                    : "")
              }
              progress={massBusy ? null : recompileProgress}
              seconds={massBusy ? massSeconds : recompileSec}
              onRun={(a, sc) => void runMass(a, sc)}
              onAsk={askMass}
              onRefresh={() => void refreshGeometryFromFiles()}
              onAccept={() => void acceptBoardAsIs()}
              onCuciMassa={() => setCuciAperta(true)}
            />
          )}
          {tab === "pcb" && circuitJson && cuciAperta && (
            <CuciMassa
              projectId={projectId}
              onAnteprima={setAnteprimaCucitura}
              // written, not compiled: the files have it, the board on screen is older
              onScritto={(path, content) => {
                setFsMap((m) => ({ ...(m ?? {}), [path]: content }));
                setCircuitStale(true);
              }}
              onChiudi={() => {
                setCuciAperta(false);
                setAnteprimaCucitura(null);
              }}
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
              recompileBusy={boardBusy}
              compilingElsewhere={!recompiling && compileRun?.state === "running" ? compileRun.step : null}
              warning={
                swappedUnderEdits
                  ? "La scheda e' cambiata mentre avevi modifiche non applicate: le hai disegnate sulla versione precedente. Controlla che i pezzi siano dove li vuoi prima di applicare, o scartale."
                  : null
              }
            />
          )}

          {/* what is being looked at, always readable above the canvas (not
              on the BOM, where it would cover the table rows) */}
          {tab !== "bom" && viewNote && editor.mode === "view" && (
          <div className="pointer-events-none absolute bottom-[76px] left-[34px] w-[328px] max-w-[calc(100%-68px)] rounded-[14px] border border-[#1F2C29] bg-[rgba(9,14,13,0.88)] px-3.5 py-[13px] backdrop-blur">
            <div className="flex items-center gap-2">
              <span className="h-1.5 w-1.5 rounded-full bg-brand" />
              <span className="text-[12px] font-bold text-[#E7EFEC]">
                {tab === "pcb"
                  ? (activePreset?.label ?? "Livelli scelti a mano")
                  : TAB_TITLES[tab]}
              </span>
              <span className="flex-1" />
              <span className="font-mono text-[10px] text-[#4E625C]">
                {tab === "pcb" ? didascaliaDelloStrato(layer) : TAB_CAPTIONS[tab]}
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
            <PartPicker parts={parts} selected={partId} onSelect={pickPart} />
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
          blocked={boardBusy}
          enclosures={enclosures}
          top={
            (tab === "pcb" || tab === "cad") && part && editor.mode === "view" ? (
              <PartCard
                docked
                part={part}
                onClose={() => pickPart(null)}
                onAsk={ask}
                onDescribe={() => describePart(part.name)}
                describing={describingPart === part.name}
                described={Boolean(partDesc[part.name])}
              />
            ) : null
          }
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
        viaSizes={tab === "pcb" ? viaSizes : []}
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

/** what a broken view is called in its error card */
const VIEW_LABELS: Record<BoardTab | "fallback", string> = {
  schematic: "lo schematico",
  pcb: "lo sbroglio",
  cad: "la vista 3D",
  bom: "la distinta base",
  stato: "lo stato dei componenti",
  fallback: "l'anteprima della scheda",
};

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
