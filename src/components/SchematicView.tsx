"use client";

import dynamic from "next/dynamic";
import type { EditEvent } from "@/lib/manual-edits";

/**
 * Vista schematica editabile. Si usa il viewer dedicato invece di
 * CircuitJsonPreview perche' e' l'unico che espone il trascinamento dei
 * simboli: la preview generica disegna e basta.
 */
const SchematicViewer = dynamic(
  () => import("@tscircuit/schematic-viewer").then((m) => m.SchematicViewer),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center text-sm text-faint">
        <span className="dot dot-busy mr-2" /> Caricamento schematico...
      </div>
    ),
  },
);

export function SchematicView({
  circuitJson,
  editing,
  editEvents,
  onEditEvent,
  viewerKey,
}: {
  circuitJson: unknown[];
  editing: boolean;
  editEvents: EditEvent[];
  onEditEvent: (event: EditEvent) => void;
  viewerKey: number;
}) {
  return (
    <div className="h-full w-full">
      <SchematicViewer
        // il viewer accumula lo stato dei trascinamenti al suo interno:
        // annullare una modifica significa rimontarlo con l'elenco ridotto
        key={`${viewerKey}-${editing ? "edit" : "view"}`}
        circuitJson={circuitJson as never}
        editingEnabled={editing}
        defaultEditMode={editing}
        editEvents={editEvents as never}
        onEditEvent={onEditEvent as never}
        clickToInteractEnabled={false}
        containerStyle={{ width: "100%", height: "100%" }}
      />
    </div>
  );
}
