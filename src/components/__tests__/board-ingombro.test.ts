import { describe, expect, it } from "vitest";
import { buildScene } from "@/components/board/render";
import { footprintBoxes } from "@/lib/footprint-bounds";
import { analyzePlacement } from "@/lib/placement-quality";

/*
 * Niccolo' on st-camera (11/11/2026): "molti componenti non hanno il vero
 * ingombro, e' fondamentale". The box lit on hover, selection and in Sposta was
 * tscircuit's pcb_component width/height, pads and holes only: 98 parts out of
 * 243 looked smaller than their body (J7 by 3,8 mm). And the viewer drew only
 * rect courtyards, while imported boards carry outlines.
 */

const board = { type: "pcb_board", pcb_board_id: "b", center: { x: 0, y: 0 }, width: 40, height: 30, num_layers: 2 };

/** a two-pad part: copper 2,2 x 0,6 mm around (cx, cy), as tscircuit stores it */
function part(id: string, cx: number, cy: number, extra: Array<Record<string, unknown>> = []) {
  return [
    { type: "source_component", source_component_id: `s_${id}`, name: id, ftype: "simple_chip" },
    {
      type: "pcb_component",
      pcb_component_id: id,
      source_component_id: `s_${id}`,
      center: { x: cx, y: cy },
      // getBoundsOfPcbComponents: pads only
      width: 2.2,
      height: 0.6,
      layer: "top",
      rotation: 0,
    },
    { type: "pcb_smtpad", pcb_smtpad_id: `${id}_1`, pcb_component_id: id, shape: "rect", x: cx - 0.8, y: cy, width: 0.6, height: 0.6, layer: "top" },
    { type: "pcb_smtpad", pcb_smtpad_id: `${id}_2`, pcb_component_id: id, shape: "rect", x: cx + 0.8, y: cy, width: 0.6, height: 0.6, layer: "top" },
    ...extra,
  ];
}

/** a courtyard outline 6 x 4 mm, off-centre by +1 mm in x, like a connector's */
const outline = (id: string, cx: number, cy: number) => ({
  type: "pcb_courtyard_outline",
  pcb_courtyard_outline_id: `cy_${id}`,
  pcb_component_id: id,
  layer: "top",
  outline: [
    { x: cx - 2, y: cy - 2 },
    { x: cx + 4, y: cy - 2 },
    { x: cx + 4, y: cy + 2 },
    { x: cx - 2, y: cy + 2 },
    { x: cx - 2, y: cy - 2 },
  ],
});

describe("il vero ingombro dei pezzi", () => {
  it("il riquadro del pezzo nel visualizzatore e' il cortile, non le sole piazzole", () => {
    const scene = buildScene([board, ...part("J7", 0, 0, [outline("J7", 0, 0)])])!;
    const j7 = scene.components.find((c) => c.name === "J7")!;
    expect(j7.w).toBeCloseTo(6, 6);
    expect(j7.h).toBeCloseTo(4, 6);
    // the courtyard is off-centre: the box is drawn where it is
    expect(j7.dx).toBeCloseTo(1, 6);
    expect(j7.dy).toBeCloseTo(0, 6);
  });

  it("il visualizzatore disegna tutti i tipi di cortile", () => {
    const scene = buildScene([
      board,
      ...part("J7", 0, 0, [outline("J7", 0, 0)]),
      ...part("PIR1", 10, 0, [
        { type: "pcb_courtyard_circle", pcb_courtyard_circle_id: "c1", pcb_component_id: "PIR1", center: { x: 10, y: 0 }, radius: 5, layer: "top" },
      ]),
      ...part("U1", -10, 0, [
        { type: "pcb_courtyard_rect", pcb_courtyard_rect_id: "r1", pcb_component_id: "U1", center: { x: -10, y: 0 }, width: 4, height: 2, layer: "top", ccw_rotation: 90 },
      ]),
    ])!;
    expect(scene.courtyards.map((c) => c.shape.kind).sort()).toEqual(["circle", "poly", "rect"]);
    const pir = scene.components.find((c) => c.name === "PIR1")!;
    expect([pir.w, pir.h]).toEqual([10, 10]);
    // a rect turned a quarter: 2 wide and 4 tall on the board
    const u1 = scene.components.find((c) => c.name === "U1")!;
    expect(u1.w).toBeCloseTo(2.2, 6); // the pads stick out of the turned courtyard
    expect(u1.h).toBeCloseTo(4, 6);
  });

  it("senza cortile conta il corpo, se noto, e solo all'ultimo le piazzole", () => {
    const body = { type: "cad_component", cad_component_id: "cad", pcb_component_id: "Q1", position: { x: 0, y: 0, z: 0 }, size: { x: 3, y: 5, z: 1 }, rotation: { x: 0, y: 0, z: 0 } };
    const withBody = footprintBoxes([...part("Q1", 0, 0, [body])]).get("Q1")!;
    expect(withBody.source).toBe("piazzole e corpo");
    expect([withBody.maxX - withBody.minX, withBody.maxY - withBody.minY]).toEqual([3, 5]);
    const onlyPads = footprintBoxes(part("R1", 0, 0)).get("R1")!;
    expect(onlyPads.source).toBe("piazzole");
    expect(onlyPads.maxX - onlyPads.minX).toBeCloseTo(2.2, 6);
  });

  it("i controlli di sovrapposizione usano lo stesso ingombro del visualizzatore", () => {
    // pads 3,8 mm apart, bodies 3 x 5 mm that overlap by 0,2 mm: no courtyard, only the body says so
    const body = (id: string, x: number) => ({ type: "cad_component", cad_component_id: `cad_${id}`, pcb_component_id: id, position: { x, y: 0, z: 0 }, size: { x: 3, y: 5, z: 1 }, rotation: { x: 0, y: 0, z: 0 } });
    const cj = [board, ...part("A", 0, 0, [body("A", 0)]), ...part("B", 2.8, 0, [body("B", 2.8)])];
    const q = analyzePlacement(cj);
    const overlap = q.issues.find((i) => i.rule === "overlap");
    expect(overlap?.components.sort()).toEqual(["A", "B"]);
    const scene = buildScene(cj)!;
    const boxes = footprintBoxes(cj);
    for (const c of scene.components) {
      const b = boxes.get(c.id)!;
      expect(c.w).toBeCloseTo(b.maxX - b.minX, 9);
      expect(c.h).toBeCloseTo(b.maxY - b.minY, 9);
    }
  });
});
