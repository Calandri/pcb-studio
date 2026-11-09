"use client";

import { useMemo } from "react";
import { SchematicCanvas } from "./schematic/SchematicCanvas";
import { withSchematicNotes } from "@/lib/schematic-notes";
import type { EditEvent, ManualEdits } from "@/lib/manual-edits";
import type { PendingLink } from "./workspace/useManualEditor";

/**
 * Schematic view. This is our own canvas, not tscircuit's: we needed to be
 * able to drag symbols around and highlight a net on mouse hover, and that
 * viewer does not allow it.
 */
export function SchematicView({
  circuitJson,
  projectId,
  mode,
  saved,
  onEditEvent,
  pendingEvents,
  resetKey,
  onSelect,
  pendingLinks,
  onLink,
  onUnlink,
  selection,
  onSelectionChange,
  notes,
}: {
  circuitJson: unknown[];
  projectId: string;
  mode: "view" | "move" | "route" | "link";
  saved: ManualEdits;
  onEditEvent: (event: EditEvent) => void;
  /** the moves not yet applied, drawn where they put the symbols */
  pendingEvents: EditEvent[];
  resetKey: number;
  onSelect?: (name: string | null) => void;
  pendingLinks: PendingLink[];
  onLink: (link: PendingLink) => void;
  onUnlink: (declared: string) => void;
  /** selection shared with the board view and the URL ("U3", "VREF") */
  selection?: string | null;
  onSelectionChange?: (key: string | null, component: string | null) => void;
  /** the project's schematico.json: sections, comments and net names for the drawing */
  notes?: string;
}) {
  const pinnedNames = useMemo(
    () => new Set(saved.schematic_placements.map((p) => p.selector)),
    [saved],
  );

  // drawing only: the notes ride along with the circuit, nothing is saved
  const drawn = useMemo(() => withSchematicNotes(circuitJson, notes), [circuitJson, notes]);

  return (
    <SchematicCanvas
      circuitJson={drawn}
      projectId={projectId}
      mode={mode}
      pinnedNames={pinnedNames}
      onEditEvent={onEditEvent}
      pendingEvents={pendingEvents}
      resetKey={resetKey}
      onSelect={onSelect}
      pendingLinks={pendingLinks}
      onLink={onLink}
      onUnlink={onUnlink}
      selection={selection}
      onSelectionChange={onSelectionChange}
    />
  );
}
