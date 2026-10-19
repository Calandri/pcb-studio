import type { EditEvent } from "@/lib/manual-edits";
import { toSchematicY } from "@/lib/schematic-model";

/**
 * Where each symbol is drawn while its moves are still pending, as an offset
 * from where the compiled sheet puts it.
 *
 * The offsets are DERIVED from the pending list instead of being kept as a
 * second copy inside the canvas. With a copy, undoing one move had to reset
 * every offset (the canvas could not tell which one the undo removed), so all
 * the other symbols jumped back on screen while their moves were still
 * pending and still got applied. The event carries an absolute position, so
 * the last one per symbol is the whole truth; y goes back to pointing down.
 */
export function schematicOffsetsFromPending(
  nodes: ReadonlyArray<{ id: string; center: { x: number; y: number } }>,
  events: readonly EditEvent[],
): Record<string, { dx: number; dy: number }> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: Record<string, { dx: number; dy: number }> = {};
  for (const ev of events) {
    if (ev.edit_event_type !== "edit_schematic_component_location") continue;
    const node = ev.schematic_component_id ? byId.get(ev.schematic_component_id) : undefined;
    if (!node || !ev.new_center) continue;
    // toSchematicY is a sign flip: it is its own inverse
    out[node.id] = {
      dx: ev.new_center.x - node.center.x,
      dy: toSchematicY(ev.new_center.y) - node.center.y,
    };
  }
  return out;
}
