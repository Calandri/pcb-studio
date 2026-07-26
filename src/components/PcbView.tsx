"use client";

import dynamic from "next/dynamic";
import { useMemo } from "react";
import type { EditEvent } from "@/lib/manual-edits";
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
  mode = "view",
  editEvents,
  onEditEvents,
  editorKey = 0,
}: {
  circuitJson: unknown[];
  flags: ViewFlags;
  layer: string;
  /** 0-100: schiarisce la vista per far emergere il rame degli strati sotto */
  xray?: number;
  /** view = sola lettura, move = sposta componenti, route = disegna piste */
  mode?: "view" | "move" | "route";
  /** modifiche non ancora salvate, ridisegnate dal viewer (vista controllata) */
  editEvents?: EditEvent[];
  onEditEvents?: (events: EditEvent[]) => void;
  /** cambia per rimontare il viewer dopo un annulla */
  editorKey?: number;
}) {
  const viewerKey = useMemo(
    () =>
      `${layer}-${Object.values(flags).map((v) => (v ? 1 : 0)).join("")}-${mode}-${editorKey}`,
    [layer, flags, mode, editorKey],
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
        initialState={
          {
            ...flags,
            selected_layer: layer,
            // la modalita' arriva da fuori, dalla barra dell'editor: la
            // barra interna del viewer resta ma non e' piu' l'unico comando
            in_edit_mode: mode !== "view",
            in_move_footprint_mode: mode === "move",
            in_draw_trace_mode: mode === "route",
          } as never
        }
        allowEditing={mode !== "view"}
        editEvents={editEvents as never}
        onEditEventsChanged={onEditEvents as never}
        clickToInteractEnabled={false}
      />
    </div>
  );
}
