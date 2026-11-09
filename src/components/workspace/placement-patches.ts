import { faceOf, normalizeRotation, type EditEvent, type PlacementPatch } from "@/lib/manual-edits";
import { parseLength } from "@/lib/pcb-route-model";
import type { BoardPlacement } from "./useManualEditor";

/** a part of the board on screen: where its copper is and where its origin is */
export interface BoardPart {
  cx: number;
  cy: number;
  /** the requested origin (display_offset), parent-relative; null when the board does not say */
  ox: number | null;
  oy: number | null;
  rotation: number;
  layer: "top" | "bottom";
}

/** the parts of a board, by NAME */
export function boardPartsByName(circuitJson: unknown[] | null | undefined): Map<string, BoardPart> {
  const out = new Map<string, BoardPart>();
  if (!Array.isArray(circuitJson)) return out;
  const nameOf = new Map<string, string>();
  for (const e of circuitJson as Array<Record<string, unknown>>) {
    if (e?.type === "source_component" && typeof e.name === "string" && e.name) {
      nameOf.set(String(e.source_component_id), e.name);
    }
  }
  for (const e of circuitJson as Array<Record<string, unknown>>) {
    if (e?.type !== "pcb_component") continue;
    const name = nameOf.get(String(e.source_component_id ?? ""));
    const c = e.center as { x?: unknown; y?: unknown } | undefined;
    const cx = parseLength(c?.x);
    const cy = parseLength(c?.y);
    if (!name || cx === null || cy === null || out.has(name)) continue;
    out.set(name, {
      cx,
      cy,
      ox: parseLength(e.display_offset_x),
      oy: parseLength(e.display_offset_y),
      rotation: normalizeRotation(e.rotation) ?? 0,
      layer: e.layer === "bottom" ? "bottom" : "top",
    });
  }
  return out;
}

/** where a board has a part, for dropAgreed: its origin (when the board says it) and its centre */
export function placementOnBoard(parts: Map<string, BoardPart>, name: string): BoardPlacement | null {
  const p = parts.get(name);
  if (!p) return null;
  return { x: p.ox, y: p.oy, cx: p.cx, cy: p.cy, rotation: p.rotation, layer: p.layer };
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * The moves of one save turned into absolute positions, read on the board on
 * screen. The canvas draws a moved part translated by (new centre - centre)
 * and turned around its ORIGIN, so the origin it shows is the board's origin
 * plus that translation, whatever the turn: that is what gets written, and it
 * is where the person let go of the part, even if the board on screen is
 * older than the file. The moves of a part merge like the overrides do: the
 * last position, the last turn and face declared.
 *
 * What cannot be read this way (a part with no origin on this board, a part
 * not on it, a schematic move) stays an event, for the server to translate.
 */
export function patchesFromEvents(
  events: readonly EditEvent[],
  parts: Map<string, BoardPart>,
): { placements: PlacementPatch[]; rest: EditEvent[] } {
  const merged = new Map<string, { x: number; y: number; rotation?: number; layer?: "top" | "bottom" }>();
  const rest: EditEvent[] = [];
  for (const e of events) {
    const name = e.component_name;
    const part = name ? parts.get(name) : undefined;
    const ok =
      e.edit_event_type === "edit_pcb_component_location" &&
      name &&
      part &&
      part.ox !== null &&
      part.oy !== null &&
      e.new_center &&
      Number.isFinite(e.new_center.x) &&
      Number.isFinite(e.new_center.y);
    if (!ok) {
      rest.push(e);
      continue;
    }
    const prev = merged.get(name);
    const rotation = e.new_rotation !== undefined ? normalizeRotation(e.new_rotation) ?? undefined : prev?.rotation;
    const layer = e.new_layer !== undefined ? faceOf(e.new_layer) ?? undefined : prev?.layer;
    merged.delete(name);
    merged.set(name, {
      x: e.new_center!.x,
      y: e.new_center!.y,
      ...(rotation !== undefined ? { rotation } : {}),
      ...(layer !== undefined ? { layer } : {}),
    });
  }
  const placements: PlacementPatch[] = [];
  for (const [name, o] of merged) {
    const part = parts.get(name)!;
    placements.push({
      name,
      x: round3((part.ox as number) + (o.x - part.cx)),
      y: round3((part.oy as number) + (o.y - part.cy)),
      ...(o.rotation !== undefined ? { rotation: o.rotation } : {}),
      ...(o.layer !== undefined ? { layer: o.layer } : {}),
    });
  }
  return { placements, rest };
}
