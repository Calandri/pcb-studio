import { describe, expect, it } from "vitest";
import { applyPlacementsToCircuit, rerouteLocal } from "@/lib/reroute-local";

type El = Record<string, unknown>;

/** a USB-C-like part: a pill shell hole with an offset drill, silkscreen, courtyard, a fab note */
function usbBoard(extra: El[] = []): El[] {
  return [
    { type: "pcb_board", pcb_board_id: "b", center: { x: 0, y: 0 }, width: 40, height: 30 },
    { type: "source_component", source_component_id: "sc1", name: "J1" },
    {
      type: "pcb_component",
      pcb_component_id: "pc1",
      source_component_id: "sc1",
      center: { x: 0, y: 0 },
      display_offset_x: 0,
      display_offset_y: 0,
      rotation: 0,
      width: 9,
      height: 7,
    },
    {
      type: "pcb_plated_hole",
      shape: "pill",
      pcb_plated_hole_id: "shell",
      pcb_component_id: "pc1",
      x: 4,
      y: 0,
      outer_width: 1,
      outer_height: 2,
      hole_width: 0.6,
      hole_height: 1.6,
      ccw_rotation: 0,
      layers: ["top", "bottom"],
    },
    {
      type: "pcb_plated_hole",
      shape: "circular_hole_with_rect_pad",
      pcb_plated_hole_id: "tab",
      pcb_component_id: "pc1",
      x: -4,
      y: 0,
      hole_diameter: 0.5,
      rect_pad_width: 1.5,
      rect_pad_height: 1,
      hole_offset_x: 0.2,
      hole_offset_y: 0,
      layers: ["top", "bottom"],
    },
    { type: "pcb_hole", pcb_hole_id: "slot", pcb_component_id: "pc1", hole_shape: "pill", x: 0, y: 3, hole_width: 0.6, hole_height: 1.2 },
    { type: "pcb_silkscreen_line", pcb_silkscreen_line_id: "l1", pcb_component_id: "pc1", x1: -4, y1: 3, x2: 4, y2: 3, stroke_width: 0.1, layer: "top" },
    { type: "pcb_silkscreen_rect", pcb_silkscreen_rect_id: "r1", pcb_component_id: "pc1", center: { x: 1, y: 0 }, width: 4, height: 2, stroke_width: 0.1, layer: "top" },
    { type: "pcb_courtyard_outline", pcb_courtyard_outline_id: "co", pcb_component_id: "pc1", layer: "top", outline: [{ x: -5, y: -4 }, { x: 5, y: -4 }, { x: 5, y: 4 }, { x: -5, y: 4 }] },
    { type: "pcb_fabrication_note_text", pcb_fabrication_note_text_id: "f1", pcb_component_id: "pc1", text: "J1", anchor_position: { x: 0, y: -3 }, ccw_rotation: 0, font: "tscircuit2024", font_size: 1, layer: "top", anchor_alignment: "center" },
    ...extra,
  ];
}

const edits = (placements: Array<Record<string, unknown>>, routes: unknown[] = []) =>
  JSON.stringify({ pcb_placements: placements, pcb_routes: routes });

const byId = (cj: unknown[], key: string, id: string) => (cj as El[]).find((e) => e[key] === id)!;

describe("applyPlacementsToCircuit", () => {
  it("moves and turns every element of the part, swapping shell dims on a quarter turn", () => {
    const r = applyPlacementsToCircuit(usbBoard(), edits([{ selector: "J1", center: { x: 10, y: 0 }, rotation: 90 }]))!;
    expect(r.error).toBeUndefined();
    expect(r.moved).toHaveLength(1);
    const shell = byId(r.circuitJson, "pcb_plated_hole_id", "shell");
    // (4,0) turned 90° around the origin -> (0,4), then +10 in x
    expect(shell.x).toBeCloseTo(10, 9);
    expect(shell.y).toBeCloseTo(4, 9);
    expect(shell.outer_width).toBe(2);
    expect(shell.outer_height).toBe(1);
    expect(shell.hole_width).toBe(1.6);
    // the shape's own rotation is left alone: the dims carry the turn
    expect(shell.ccw_rotation).toBe(0);
    const tab = byId(r.circuitJson, "pcb_plated_hole_id", "tab");
    expect(tab.rect_pad_width).toBe(1);
    expect(tab.hole_offset_x as number).toBeCloseTo(0, 9);
    expect(tab.hole_offset_y as number).toBeCloseTo(0.2, 9);
    const slot = byId(r.circuitJson, "pcb_hole_id", "slot");
    expect(slot.x as number).toBeCloseTo(7, 9);
    expect(slot.y as number).toBeCloseTo(0, 9);
    expect(slot.hole_width).toBe(1.2);
    const line = byId(r.circuitJson, "pcb_silkscreen_line_id", "l1");
    expect(line.x1 as number).toBeCloseTo(7, 9);
    expect(line.y1 as number).toBeCloseTo(-4, 9);
    const rect = byId(r.circuitJson, "pcb_silkscreen_rect_id", "r1");
    expect((rect.center as { y: number }).y).toBeCloseTo(1, 9);
    expect(rect.width).toBe(2);
    const court = byId(r.circuitJson, "pcb_courtyard_outline_id", "co");
    expect((court.outline as Array<{ x: number }>)[0].x).toBeCloseTo(14, 9);
    const note = byId(r.circuitJson, "pcb_fabrication_note_text_id", "f1");
    expect((note.anchor_position as { x: number }).x).toBeCloseTo(13, 9);
    expect(note.ccw_rotation).toBe(90);
  });

  it("accepts a quarter turn that is a hair off, refuses a real odd angle", () => {
    const ok = applyPlacementsToCircuit(usbBoard(), edits([{ selector: "J1", center: { x: 0, y: 0 }, rotation: 90.00000001 }]))!;
    expect(ok.error).toBeUndefined();
    expect(ok.moved[0].dRot).toBe(90);
    const odd = applyPlacementsToCircuit(usbBoard(), edits([{ selector: "J1", center: { x: 0, y: 0 }, rotation: 30 }]))!;
    expect(odd.error).toMatch(/quarti di giro/);
  });

  it("skips a placement of a part that is not on the board and applies the others", () => {
    const r = applyPlacementsToCircuit(
      usbBoard(),
      edits([
        { selector: "R99", center: { x: 1, y: 1 } },
        { selector: "J1", center: { x: 2, y: 0 } },
      ]),
    )!;
    expect(r.orphans).toEqual(["R99"]);
    expect(r.moved.map((m) => m.name)).toEqual(["J1"]);
  });

  it("turns a grouped part around its absolute origin", () => {
    const board: El[] = [
      { type: "pcb_board", pcb_board_id: "b", center: { x: 0, y: 0 }, width: 40, height: 30 },
      { type: "source_component", source_component_id: "sc1", name: "R1" },
      { type: "pcb_group", pcb_group_id: "g1", anchor_position: { x: 10, y: 5 } },
      {
        type: "pcb_component",
        pcb_component_id: "pc1",
        source_component_id: "sc1",
        center: { x: 12, y: 5 },
        display_offset_x: 2,
        display_offset_y: 0,
        positioned_relative_to_pcb_group_id: "g1",
        rotation: 0,
        width: 1,
        height: 0.5,
      },
      { type: "pcb_smtpad", shape: "rect", pcb_smtpad_id: "p1", pcb_component_id: "pc1", x: 12.5, y: 5, width: 0.4, height: 0.5, layer: "top" },
    ];
    const r = applyPlacementsToCircuit(board, edits([{ selector: "R1", center: { x: 2, y: 0 }, rotation: 90 }]))!;
    const pad = byId(r.circuitJson, "pcb_smtpad_id", "p1");
    // around (12,5), not around (2,0)
    expect(pad.x as number).toBeCloseTo(12, 9);
    expect(pad.y as number).toBeCloseTo(5.5, 9);
  });
});

describe("rerouteLocal", () => {
  it("answers ok:false with the reason instead of ok with zero moves", () => {
    const routes = [{ connection: "x", points: [{ x: 0, y: 0 }, { x: 1, y: 0 }] }];
    const r = rerouteLocal(usbBoard(), {}, edits([{ selector: "J1", center: { x: 0, y: 0 }, rotation: 45 }], routes));
    expect(r.result.ok).toBe(false);
    expect(r.circuitJson).toBeNull();
    expect(r.result.reason).toMatch(/J1/);
  });

  it("reports orphan placements when nothing else can be applied", () => {
    const r = rerouteLocal(usbBoard(), {}, edits([{ selector: "R99", center: { x: 0, y: 0 } }]));
    expect(r.result.ok).toBe(false);
    expect(r.result.orphans.pcb_placements).toEqual(["R99"]);
  });
});
