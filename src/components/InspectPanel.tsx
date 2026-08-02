"use client";

import { useMemo, useState } from "react";
import {
  distanceMm,
  extractComponents,
  extractIssues,
  type InspectComponent,
} from "@/lib/inspect";
import { HandoffButton } from "./HandoffButton";
import { Btn, Chip, EmptyState, SectionLabel } from "./ui";

type Tab = "issues" | "parts" | "measure";

const TABS: Array<{ key: Tab; label: string }> = [
  { key: "issues", label: "Problemi" },
  { key: "parts", label: "Componenti" },
  { key: "measure", label: "Misura" },
];

export function InspectPanel({
  circuitJson,
  fsMap,
  stale,
  projectId,
  onAsk,
}: {
  circuitJson: unknown[] | null;
  /**
   * The project code. Without it every component comes back with no
   * description, no tags and no domain: those props never reach the Circuit
   * JSON, they live in the sources and nowhere else.
   */
  fsMap?: Record<string, string> | null;
  stale: boolean;
  projectId: string;
  /** sends a request to the agent: the agent is the one that modifies the board */
  onAsk: (prompt: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("issues");
  const [query, setQuery] = useState("");
  const [pair, setPair] = useState<[string | null, string | null]>([null, null]);

  const issues = useMemo(() => extractIssues(circuitJson), [circuitJson]);
  const parts = useMemo(
    () => extractComponents(circuitJson, fsMap ?? {}),
    [circuitJson, fsMap],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return parts;
    return parts.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.value ?? "").toLowerCase().includes(q) ||
        (p.footprint ?? "").toLowerCase().includes(q) ||
        p.nets.some((n) => n.toLowerCase().includes(q)),
    );
  }, [parts, query]);

  const byId = useMemo(() => new Map(parts.map((p) => [p.id, p])), [parts]);
  const [aId, bId] = pair;
  const a = aId ? byId.get(aId) : undefined;
  const b = bId ? byId.get(bId) : undefined;
  const distance = a && b ? distanceMm(a, b) : null;

  if (!circuitJson) {
    return (
      <div className="slide-in space-y-3">
        <SectionLabel>Ispeziona la scheda</SectionLabel>
        <EmptyState
          title="Nessuna scheda compilata"
          hint="Chiedi all'agente di compilare il progetto: qui compaiono problemi, componenti e misure."
        />
      </div>
    );
  }

  return (
    <div className="slide-in space-y-3">
      {stale && (
        <p className="rounded-lg bg-accent-wash px-3 py-2 text-[11px] leading-relaxed text-accent">
          Il progetto è cambiato dopo l&apos;ultima compilazione: questi dati potrebbero
          non essere aggiornati.
        </p>
      )}

      <div className="flex gap-1 rounded-lg bg-sunken p-1">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`flex flex-1 items-center justify-center gap-1 rounded-md px-1 py-1.5 text-[10.5px] font-semibold transition-colors ${
              tab === t.key
                ? "bg-surface text-text shadow-sm"
                : "text-faint hover:text-muted"
            }`}
          >
            <span className="truncate">{t.label}</span>
            {t.key === "issues" && issues.length > 0 && (
              <span className="rounded bg-danger-wash px-1 font-mono text-[9px] text-danger">
                {issues.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {tab === "issues" && (
        <div className="space-y-2">
          {issues.length === 0 ? (
            <EmptyState title="Nessun problema" hint="La scheda compila pulita." />
          ) : (
            <>
              <div className="flex justify-center">
                <HandoffButton projectId={projectId} />
              </div>
              <Btn
                size="sm"
                variant="primary"
                className="w-full"
                onClick={() =>
                  onAsk(
                    `Ci sono ${issues.length} problemi sulla scheda. I primi sono:\n` +
                      issues
                        .slice(0, 6)
                        .map(
                          (i) =>
                            `- ${i.message}${i.x !== null ? ` (a x=${i.x}, y=${i.y})` : ""}`,
                        )
                        .join("\n") +
                      "\nRisolvili e ricompila.",
                  )
                }
              >
                Chiedi all&apos;agente di risolverli
              </Btn>
              <ul className="space-y-1.5">
                {issues.slice(0, 40).map((issue) => (
                  <li
                    key={issue.id}
                    className="rounded-lg border border-line px-3 py-2"
                  >
                    <div className="flex items-start gap-2">
                      <span
                        className={`mt-1 h-1.5 w-1.5 flex-none rounded-full ${
                          issue.kind === "error" ? "bg-danger" : "bg-accent"
                        }`}
                      />
                      <p className="min-w-0 flex-1 text-[11px] leading-relaxed text-muted">
                        {issue.message}
                      </p>
                    </div>
                    {issue.x !== null && (
                      <p className="mt-1 pl-3.5 font-mono text-[10px] text-faint">
                        x {issue.x} · y {issue.y} mm
                      </p>
                    )}
                  </li>
                ))}
              </ul>
              {issues.length > 40 && (
                <p className="text-center text-[11px] text-faint">
                  e altri {issues.length - 40}
                </p>
              )}
            </>
          )}
        </div>
      )}

      {tab === "parts" && (
        <div className="space-y-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Cerca U7, 10k, GND..."
            className="w-full rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm outline-none placeholder:text-faint focus:border-brand focus:ring-2 focus:ring-brand/15"
          />
          <ul className="space-y-1.5">
            {filtered.map((p) => (
              <li key={p.id} className="rounded-lg border border-line px-3 py-2">
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-xs font-semibold text-text">
                    {p.name}
                  </span>
                  {p.value && <span className="text-[11px] text-muted">{p.value}</span>}
                  {p.footprint && <Chip>{p.footprint}</Chip>}
                </div>
                {p.x !== null && (
                  <p className="mt-1 font-mono text-[10px] text-faint">
                    x {p.x} · y {p.y} mm{p.layer ? ` · ${p.layer}` : ""}
                  </p>
                )}
                {p.nets.length > 0 && (
                  <p className="mt-1 truncate text-[10px] text-faint" title={p.nets.join(", ")}>
                    reti: {p.nets.join(", ")}
                  </p>
                )}
                <div className="mt-1.5 flex gap-1">
                  <Btn
                    size="sm"
                    onClick={() =>
                      onAsk(`Descrivimi il componente ${p.name}: a cosa serve nel circuito e come è collegato.`)
                    }
                  >
                    Spiega
                  </Btn>
                  <Btn
                    size="sm"
                    onClick={() => setPair(([first]) => (first && first !== p.id ? [first, p.id] : [p.id, null]))}
                  >
                    Misura
                  </Btn>
                </div>
              </li>
            ))}
            {filtered.length === 0 && <EmptyState title="Nessun componente trovato" />}
          </ul>
        </div>
      )}

      {tab === "measure" && (
        <div className="space-y-3">
          <SectionLabel>Distanza fra due componenti</SectionLabel>
          <p className="text-[11px] leading-relaxed text-faint">
            Scegli due componenti dalla scheda Componenti con il pulsante Misura.
          </p>
          <div className="space-y-1.5">
            {[a, b].map((sel, i) => (
              <div
                key={i}
                className="flex items-center gap-2 rounded-lg border border-line px-3 py-2"
              >
                <span className="text-[10px] font-semibold text-faint">
                  {i === 0 ? "DA" : "A"}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-text">
                  {sel ? sel.name : "—"}
                </span>
                {sel?.x !== null && sel !== undefined && (
                  <span className="font-mono text-[10px] text-faint">
                    {sel.x}, {sel.y}
                  </span>
                )}
              </div>
            ))}
          </div>
          {distance !== null && a && b && (
            <div className="rounded-xl bg-brand-wash px-4 py-3 text-center">
              <p className="font-mono text-xl font-bold text-brand-strong">{distance} mm</p>
              <p className="mt-0.5 text-[11px] text-muted">
                da {a.name} a {b.name}, centro a centro
              </p>
            </div>
          )}
          {(a || b) && (
            <Btn size="sm" className="w-full" onClick={() => setPair([null, null])}>
              Azzera
            </Btn>
          )}
        </div>
      )}
    </div>
  );
}
