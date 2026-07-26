"use client";

import dynamic from "next/dynamic";
import { useMemo } from "react";
import type { ViewFlags } from "./ViewPresets";

// Il viewer PCB usato direttamente (non via RunFrame): e' l'unico modo per
// controllare da fuori quali livelli sono accesi.
const PcbViewer = dynamic(
  () => import("@tscircuit/runframe/runner").then((m) => m.PcbViewer),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center text-sm text-faint">
        <span className="dot dot-busy mr-2" /> Caricamento vista PCB...
      </div>
    ),
  },
);

/**
 * Vista della scheda. Livelli e strato attivo arrivano dal workspace (colonna
 * di sinistra): il viewer non espone metodi per cambiare stato dopo il
 * montaggio, quindi si rimonta con una key derivata dai flag — e' istantaneo e
 * tiene il codice semplice.
 */
export function PcbView({
  circuitJson,
  flags,
  layer,
  xray = 0,
}: {
  circuitJson: unknown[];
  flags: ViewFlags;
  layer: string;
  /** 0-100: schiarisce la vista per far emergere il rame degli strati sotto */
  xray?: number;
}) {
  const viewerKey = useMemo(
    () => `${layer}-${Object.values(flags).map((v) => (v ? 1 : 0)).join("")}`,
    [layer, flags],
  );

  return (
    <div
      className="h-full"
      style={
        xray > 0
          ? { filter: `brightness(${1 + xray / 90}) contrast(${1 + xray / 400})` }
          : undefined
      }
    >
      <PcbViewer
        key={viewerKey}
        circuitJson={circuitJson as never}
        initialState={{ ...flags, selected_layer: layer } as never}
        clickToInteractEnabled={false}
      />
    </div>
  );
}
