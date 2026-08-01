"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ActivityEvent } from "@/lib/activity-store";
import type { InspectComponent } from "@/lib/inspect";
import type { BoardZone, SelectMode } from "../board/BoardCanvas";

/**
 * "Work with Claude": you pick the job, copy the command, and from here you
 * watch Claude work.
 *
 * WHY COPY A COMMAND INSTEAD OF PRESSING RUN. The model doing the work is
 * the user's own, in their session, with their context and their limits:
 * the app neither hosts it nor pays for it. What the app can do, and does
 * here, is prepare a job that cannot be gotten wrong (scope, starting
 * state, criteria) and then NARRATE what happens as it happens.
 *
 * WHY THE BUTTONS ARE NOT FUNCTIONS. None of these buttons runs a
 * procedure: they produce text. Which tools to call, in what order, and
 * when to stop is decided by the model, which has them all. It's the house
 * LLM-first rule and it has a practical
 * effect: the `reroute_zone` tool added today gets used by yesterday's
 * commands without touching a single line of this file.
 */

type Kind = "place" | "route";
type Scope = "all" | "selection";

interface Job {
  kind: Kind;
  scope: Scope;
}

const KEY = (j: Job) => `${j.kind}-${j.scope}`;

export function ClaudeWork({
  projectId,
  onClose,
  parts,
  selectMode,
  onSelectMode,
  selectedIds,
  onSelectedIds,
  zone,
  onZone,
}: {
  projectId: string;
  onClose: () => void;
  parts: InspectComponent[];
  selectMode: SelectMode;
  onSelectMode: (mode: SelectMode) => void;
  selectedIds: string[];
  onSelectedIds: (ids: string[]) => void;
  zone: BoardZone | null;
  onZone: (zone: BoardZone | null) => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const events = useActivity(projectId);

  const nameOf = useCallback(
    (id: string) => parts.find((p) => p.id === id)?.name ?? id,
    [parts],
  );

  const copy = useCallback(
    async (job: Job) => {
      const key = KEY(job);
      setBusy(key);
      setError(null);
      try {
        const params = new URLSearchParams({
          projectId,
          kind: job.kind,
          scope: job.scope,
        });
        if (job.scope === "selection" && job.kind === "place") {
          params.set("components", selectedIds.map(nameOf).join(","));
        }
        if (job.scope === "selection" && job.kind === "route" && zone) {
          params.set("zone", `${zone.minX},${zone.minY},${zone.maxX},${zone.maxY}`);
        }
        const res = await fetch(`/api/claude-command?${params}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await navigator.clipboard.writeText(await res.text());
        setCopied(key);
        setTimeout(() => setCopied((c) => (c === key ? null : c)), 3000);
      } catch (err) {
        setError(err instanceof Error ? err.message : "non riuscito");
      } finally {
        setBusy(null);
      }
    },
    [projectId, selectedIds, zone, nameOf],
  );

  // leaving the panel, the mouse must go back to doing what it did before
  useEffect(() => () => onSelectMode("off"), [onSelectMode]);

  const state = (job: Job) =>
    busy === KEY(job) ? "preparo" : copied === KEY(job) ? "copiato" : "idle";

  return (
    <aside className="absolute left-[18px] top-[18px] bottom-[18px] z-30 flex w-[330px] flex-col overflow-hidden rounded-[14px] border border-[#2C4C42] bg-[rgba(9,14,13,0.94)] backdrop-blur">
      <header className="flex flex-none items-center gap-2 border-b border-[#1F2C29] px-3.5 py-3">
        <span className="grid h-6 w-6 place-items-center rounded-md border border-[#2C4C42] bg-brand-wash text-[11px] text-brand">
          ✦
        </span>
        <span className="flex-1 text-[13px] font-semibold text-[#E7EFEC]">
          Lavora con Claude
        </span>
        <button
          type="button"
          onClick={onClose}
          title="Chiudi"
          className="text-faint transition-colors hover:text-text"
        >
          <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3">
        <Group title="Tutta la scheda">
          <Command
            label="Ridisponi i componenti"
            hint="Claude rifa' il piazzamento di tutta la scheda e ricompila finche' i numeri smettono di migliorare."
            state={state({ kind: "place", scope: "all" })}
            onClick={() => void copy({ kind: "place", scope: "all" })}
          />
          <Command
            label="Re-instrada"
            hint="Claude rifa' lo sbroglio: prima le zone peggiori, poi la scheda intera se serve spostare i pezzi."
            state={state({ kind: "route", scope: "all" })}
            onClick={() => void copy({ kind: "route", scope: "all" })}
          />
        </Group>

        <Group title="Solo una parte">
          <Picker
            active={selectMode === "components"}
            onToggle={() => onSelectMode(selectMode === "components" ? "off" : "components")}
            label="Scegli i componenti"
            /* the gesture is explained, because without instructions nobody
               tries dragging a rectangle over a drawing */
            hint="Trascina un riquadro sulla scheda, o clicca i componenti uno a uno. Shift somma al riquadro precedente, Alt sposta la vista."
            summary={
              selectedIds.length
                ? `${selectedIds.length} scelti: ${selectedIds.slice(0, 4).map(nameOf).join(", ")}${selectedIds.length > 4 ? "…" : ""}`
                : null
            }
            onClear={() => onSelectedIds([])}
          />
          <Command
            label="Ridisponi i selezionati"
            hint={
              selectedIds.length
                ? "Il comando dice a Claude di spostare SOLO questi e di lasciare fermo tutto il resto."
                : "Scegli prima almeno un componente."
            }
            disabled={selectedIds.length === 0}
            state={state({ kind: "place", scope: "selection" })}
            onClick={() => void copy({ kind: "place", scope: "selection" })}
          />

          <div className="h-2" />

          <Picker
            active={selectMode === "zone"}
            onToggle={() => onSelectMode(selectMode === "zone" ? "off" : "zone")}
            label="Scegli la zona di rame"
            hint="Trascina il rettangolo sull'area da rifare. Si strappano solo le piste tutte intere li' dentro, quindi lascia un po' di margine."
            summary={
              zone
                ? `da ${zone.minX} , ${zone.minY} a ${zone.maxX} , ${zone.maxY} mm (${round(zone.maxX - zone.minX)} x ${round(zone.maxY - zone.minY)})`
                : null
            }
            onClear={() => onZone(null)}
          />
          <Command
            label="Re-instrada la zona"
            hint={
              zone
                ? "Claude rifa' il rame solo li' dentro: secondi invece di minuti, e il resto della scheda non si tocca."
                : "Traccia prima il rettangolo sulla scheda."
            }
            disabled={!zone}
            state={state({ kind: "route", scope: "selection" })}
            onClick={() => void copy({ kind: "route", scope: "selection" })}
          />
        </Group>

        {error && (
          <p className="mt-2 text-[11px] leading-[1.4] text-[#FFB4AB]">
            Non sono riuscito a preparare il comando: {error}
          </p>
        )}

        <Group title="Cosa sta facendo">
          <Feed events={events} />
        </Group>
      </div>
    </aside>
  );
}

/**
 * The stream of what happens to the project.
 *
 * It reconnects by itself, resuming from the last seen id: a work session
 * outlives a single connection, and starting from scratch would reprint
 * everything from the beginning.
 */
function useActivity(projectId: string): ActivityEvent[] {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const cursor = useRef(0);

  useEffect(() => {
    let stopped = false;
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (stopped) return;
      source = new EventSource(
        `/api/activity?projectId=${encodeURIComponent(projectId)}&since=${cursor.current}`,
      );
      source.addEventListener("attivita", (e) => {
        try {
          const data = JSON.parse((e as MessageEvent).data) as {
            events: ActivityEvent[];
            cursor: number;
          };
          cursor.current = data.cursor;
          // keep a short queue: the viewer wants the latest moves, and a
          // list that grows forever ends up making the page stutter
          setEvents((prev) => [...prev, ...data.events].slice(-120));
        } catch {
          // a malformed event must not break the stream
        }
      });
      source.addEventListener("battito", (e) => {
        try {
          cursor.current = (JSON.parse((e as MessageEvent).data) as { cursor: number }).cursor;
        } catch {
          // nothing to do
        }
      });
      source.onerror = () => {
        source?.close();
        // the stream has a limited life by construction: its end is not a
        // failure, just reopen it and resume from the id you had
        if (!stopped) retry = setTimeout(connect, 1200);
      };
    };
    connect();

    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      source?.close();
    };
  }, [projectId]);

  return events;
}

function Feed({ events }: { events: ActivityEvent[] }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [events.length]);

  if (events.length === 0) {
    return (
      <p className="text-[11px] leading-[1.5] text-[#5F726C]">
        Ancora niente. Incolla uno dei comandi qui sopra in Claude: da questo momento ogni
        cosa che fa compare qui, e la scheda si aggiorna da sola mentre lavora.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {events.map((e) => (
        <div key={`${e.id}`} className="flex items-start gap-2">
          <span
            className="mt-[6px] h-1.5 w-1.5 flex-none rounded-full"
            style={{
              background:
                e.phase === "errore" ? "#FF6B5A" : e.phase === "fine" ? "#3BE8B0" : "#E8B23B",
            }}
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-1.5">
              <span className="font-mono text-[10px] text-[#5F726C]">{e.tool}</span>
              {e.ms !== undefined && (
                <span className="font-mono text-[10px] text-[#3E5049]">
                  {e.ms >= 1000 ? `${Math.round(e.ms / 1000)}s` : `${e.ms}ms`}
                </span>
              )}
            </div>
            <div
              className="text-[11px] leading-[1.45] break-words"
              style={{ color: e.phase === "errore" ? "#FFB4AB" : "#8A9C96" }}
            >
              {e.detail}
            </div>
          </div>
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-4 last:mb-0">
      <h3 className="mb-2 font-mono text-[10px] tracking-[0.05em] text-[#5F726C]">
        {title.toUpperCase()}
      </h3>
      {children}
    </section>
  );
}

function Command({
  label,
  hint,
  onClick,
  state,
  disabled = false,
}: {
  label: string;
  hint: string;
  onClick: () => void;
  state: "idle" | "preparo" | "copiato";
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || state === "preparo"}
      className={`mb-1.5 block w-full rounded-[10px] border px-3 py-2 text-left transition-colors last:mb-0 ${
        state === "copiato"
          ? "border-[#2C4C42] bg-brand-wash"
          : "border-line hover:border-[#3A5A50]"
      } disabled:cursor-not-allowed disabled:opacity-45`}
    >
      <span className="flex items-center gap-1.5">
        <span
          className={`text-[12px] font-semibold ${state === "copiato" ? "text-brand" : "text-[#E7EFEC]"}`}
        >
          {label}
        </span>
        <span className="flex-1" />
        <span className="font-mono text-[10px] text-[#5F726C]">
          {state === "preparo" ? "preparo…" : state === "copiato" ? "copiato" : "copia"}
        </span>
      </span>
      <span className="mt-0.5 block text-[11px] leading-[1.45] text-[#8A9C96]">
        {state === "copiato" ? "Incollalo in Claude: da qui in poi lo guardi lavorare." : hint}
      </span>
    </button>
  );
}

function Picker({
  active,
  onToggle,
  label,
  hint,
  summary,
  onClear,
}: {
  active: boolean;
  onToggle: () => void;
  label: string;
  hint: string;
  summary: string | null;
  onClear: () => void;
}) {
  return (
    <div
      className={`mb-1.5 rounded-[10px] border px-3 py-2 ${
        active ? "border-[#4A3A16] bg-[rgba(32,24,8,0.55)]" : "border-line"
      }`}
    >
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={onToggle}
          className={`flex-1 text-left text-[12px] font-semibold transition-colors ${
            active ? "text-[#E8C97A]" : "text-[#E7EFEC] hover:text-brand"
          }`}
        >
          {label}
        </button>
        {summary && (
          <button
            type="button"
            onClick={onClear}
            title="Svuota la selezione"
            className="font-mono text-[10px] text-[#5F726C] transition-colors hover:text-[#FFB4AB]"
          >
            svuota
          </button>
        )}
        <span className="font-mono text-[10px] text-[#5F726C]">
          {active ? "attivo" : "scegli"}
        </span>
      </div>
      {active && (
        <p className="mt-0.5 text-[11px] leading-[1.45] text-[#8A9C96]">{hint}</p>
      )}
      {summary && (
        <p className="mt-1 font-mono text-[10px] leading-[1.4] break-words text-[#E8C97A]">
          {summary}
        </p>
      )}
    </div>
  );
}

const round = (v: number) => Math.round(v * 10) / 10;
