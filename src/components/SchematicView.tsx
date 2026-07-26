"use client";

import { useMemo } from "react";
import { SchematicCanvas } from "./schematic/SchematicCanvas";
import type { EditEvent, ManualEdits } from "@/lib/manual-edits";

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
}: {
  circuitJson: unknown[];
  projectId: string;
  mode: "view" | "move" | "route";
  saved: ManualEdits;
  onEditEvent: (event: EditEvent) => void;
  resetKey: number;
  onSelect?: (name: string | null) => void;
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
    />
  );
}
