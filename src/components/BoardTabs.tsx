"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { PcbView } from "./PcbView";

const CircuitJsonPreview = dynamic(
  () => import("@tscircuit/runframe/runner").then((m) => m.CircuitJsonPreview),
  { ssr: false, loading: () => <Loading /> },
);

function Loading() {
  return (
    <div className="flex h-full items-center justify-center text-sm text-faint">
      <span className="dot dot-busy mr-2" /> Caricamento vista...
    </div>
  );
}

type Tab = "schematic" | "pcb" | "cad" | "bom";

const TABS: Array<{ key: Tab; label: string }> = [
  { key: "schematic", label: "Schematico" },
  { key: "pcb", label: "PCB" },
  { key: "cad", label: "3D" },
  { key: "bom", label: "Distinta" },
];

/**
 * Tab della scheda. Il PCB usa il viewer diretto per poter controllare i
 * livelli (vedi PcbView); le altre viste restano quelle di runframe.
 */
export function BoardTabs({
  circuitJson,
  fallback,
  actions,
}: {
  circuitJson: unknown[] | null;
  /** mostrato quando non c'e' ancora una compilazione validata */
  fallback: React.ReactNode;
  /** download ed azioni, allineate a destra nella barra */
  actions?: React.ReactNode;
}) {
  const [tab, setTab] = useState<Tab>("schematic");

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-none items-center gap-1 border-b border-line px-3 py-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
              tab === t.key
                ? "bg-brand-wash text-brand-strong"
                : "text-muted hover:bg-sunken hover:text-text"
            }`}
          >
            {t.label}
          </button>
        ))}
        {actions && <div className="ml-auto flex items-center gap-1.5">{actions}</div>}
      </div>

      <div className="min-h-0 flex-1">
        {!circuitJson ? (
          fallback
        ) : tab === "pcb" ? (
          <PcbView circuitJson={circuitJson} />
        ) : (
          <CircuitJsonPreview
            key={tab}
            circuitJson={circuitJson as never}
            defaultActiveTab={tab as never}
            availableTabs={[tab] as never}
            showToggleFullScreen={false}
          />
        )}
      </div>
    </div>
  );
}
