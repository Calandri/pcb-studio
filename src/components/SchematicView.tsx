"use client";

import { useMemo } from "react";
import { SchematicCanvas } from "./schematic/SchematicCanvas";
import type { EditEvent, ManualEdits } from "@/lib/manual-edits";
import type { PendingLink } from "./workspace/useManualEditor";

/**
 * Vista schematica. E' il nostro canvas, non quello di tscircuit: serviva
 * poterci trascinare i simboli e accendere una net al passaggio del mouse, e
 * quel viewer non lo permette.
 */
export function SchematicView({
  circuitJson,
  projectId,
  mode,
  saved,
  onEditEvent,
  resetKey,
  onSelect,
  pendingLinks,
  onLink,
  onUnlink,
}: {
  circuitJson: unknown[];
  projectId: string;
  mode: "view" | "move" | "route" | "link";
  saved: ManualEdits;
  onEditEvent: (event: EditEvent) => void;
  resetKey: number;
  onSelect?: (name: string | null) => void;
  pendingLinks: PendingLink[];
  onLink: (link: PendingLink) => void;
  onUnlink: (declared: string) => void;
}) {
  const pinnedNames = useMemo(
    () => new Set(saved.schematic_placements.map((p) => p.selector)),
    [saved],
  );

  return (
    <SchematicCanvas
      circuitJson={circuitJson}
      projectId={projectId}
      mode={mode}
      pinnedNames={pinnedNames}
      onEditEvent={onEditEvent}
      resetKey={resetKey}
      onSelect={onSelect}
      pendingLinks={pendingLinks}
      onLink={onLink}
      onUnlink={onUnlink}
    />
  );
}
