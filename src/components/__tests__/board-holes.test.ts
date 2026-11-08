import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BoardCanvas } from "../board/BoardCanvas";
import { HOLE_COPPER, buildScene, holeCopper } from "../board/render";
import { VIEW_PRESETS } from "../ViewPresets";

/*
 * I due fori di montaggio non metallizzati di htl-401-scheda-unica (2.1mm, in
 * 34.05,8.2 e -59.15,5.2) accanto a un foro metallizzato tondo e a uno con il
 * pad quadrato. Il pcb_hole porta anche un outer_diameter: non e' rame lo stesso.
 */
const CIRCUIT = [
  { type: "pcb_board", width: 130, height: 40, center: { x: 0, y: 0 }, num_layers: 2 },
  { type: "pcb_hole", pcb_hole_id: "pcb_hole_0", hole_shape: "circle", hole_diameter: 2.1, x: 34.05, y: 8.2 },
  { type: "pcb_hole", pcb_hole_id: "pcb_hole_1", hole_shape: "circle", hole_diameter: 2.1, outer_diameter: 3.4, x: -59.15, y: 5.2 },
  { type: "pcb_plated_hole", pcb_plated_hole_id: "pcb_plated_hole_0", shape: "circle", hole_diameter: 1, outer_diameter: 1.8, x: 0, y: 0, layers: ["top", "bottom"] },
  { type: "pcb_plated_hole", pcb_plated_hole_id: "pcb_plated_hole_1", shape: "circular_hole_with_rect_pad", hole_diameter: 1, rect_pad_width: 1.7, rect_pad_height: 1.7, x: 5, y: 0, layers: ["top", "bottom"] },
];

describe("un foro non metallizzato non ha rame intorno", () => {
  const scene = buildScene(CIRCUIT)!;
  const foro = (id: string) => scene.holes.find((h) => h.id === id)!;

  it("il pcb_hole e' il foro nudo: niente anello, nemmeno se porta un outer_diameter", () => {
    for (const id of ["pcb_hole_0", "pcb_hole_1"]) {
      const h = foro(id);
      expect(h.plated).toBe(false);
      expect(h.hole).toBe(2.1);
      expect(h.outer).toBe(2.1);
      expect(holeCopper(h)).toBeNull();
    }
  });

  it("i fori metallizzati restano come prima: anello tondo o pad quadrato", () => {
    expect(foro("pcb_plated_hole_0").plated).toBe(true);
    expect(holeCopper(foro("pcb_plated_hole_0"))).toEqual({ kind: "circle", r: 0.9 });
    expect(holeCopper(foro("pcb_plated_hole_1"))).toEqual({ kind: "rect", x: 4.15, y: -0.85, w: 1.7, h: 1.7 });
  });

  it("sulla tela il rame c'e' solo intorno ai fori metallizzati, e il foro nudo si distingue", () => {
    const svg = renderToStaticMarkup(
      createElement(BoardCanvas, { circuitJson: CIRCUIT, flags: VIEW_PRESETS[0].flags, layer: "top" }),
    );
    const rame = svg.match(new RegExp(`<(circle|rect)[^>]*fill="${HOLE_COPPER}"[^>]*>`, "g")) ?? [];
    expect(rame).toHaveLength(2);
    // nessuna forma color rame centrata sui fori di montaggio
    expect(rame.some((t) => t.includes('cx="34.05"') || t.includes('cx="-59.15"'))).toBe(false);
    // il foro nudo ha il suo bordo, il foro metallizzato no
    const forato = (cx: string) => svg.match(new RegExp(`<circle cx="${cx}"[^>]*fill="#06100D"[^>]*>`))?.[0] ?? "";
    expect(forato("34.05")).toMatch(/stroke="#9AA8A2"/);
    expect(forato("-59.15")).toMatch(/r="1.05"/);
    expect(forato("0")).not.toMatch(/stroke=/);
  });
});
