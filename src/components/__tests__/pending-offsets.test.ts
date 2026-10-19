import { describe, expect, it } from "vitest";
import { schematicOffsetsFromPending } from "@/components/schematic/pending-offsets";

const nodes = [
  { id: "sc_R1", center: { x: 1, y: -2 } },
  { id: "sc_C1", center: { x: 4, y: 0 } },
];

const move = (id: string, x: number, y: number) => ({
  edit_event_type: "edit_schematic_component_location",
  schematic_component_id: id,
  new_center: { x, y },
});

describe("schematicOffsetsFromPending", () => {
  it("draws each symbol where its last pending move puts it", () => {
    // event y points up, drawing y points down: R1 drawn at y=-2 sits at +2
    const out = schematicOffsetsFromPending(nodes, [move("sc_R1", 2, 2), move("sc_R1", 3, 1)]);
    expect(out).toEqual({ sc_R1: { dx: 2, dy: 1 } });
  });

  it("undoing one move leaves the others where they are", () => {
    const both = [move("sc_R1", 2, 2), move("sc_C1", 5, 0)];
    const afterUndo = both.slice(0, -1);
    expect(schematicOffsetsFromPending(nodes, afterUndo)).toEqual({ sc_R1: { dx: 1, dy: 0 } });
  });

  it("ignores pcb moves and symbols not on this sheet", () => {
    const out = schematicOffsetsFromPending(nodes, [
      { edit_event_type: "edit_pcb_component_location", pcb_component_id: "pc1", new_center: { x: 1, y: 1 } },
      move("sc_gone", 1, 1),
    ]);
    expect(out).toEqual({});
  });
});
