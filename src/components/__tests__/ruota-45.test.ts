import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BoardCanvas, rotazioneDaTasto } from "../board/BoardCanvas";
import { boardPartsByName, patchesFromEvents } from "../workspace/placement-patches";
import { VIEW_PRESETS } from "../ViewPresets";
import { injectManualEdits, type EditEvent } from "@/lib/manual-edits";

/*
 * "se voglio ruotare di 45 gradi e non 90 si puo'?" (Niccolo', 2026-11-12).
 * In Sposta R turns by 90 degrees and Shift+R the other way; Alt+R turns by
 * 45 and Alt+Shift+R by 45 the other way. On a Mac Option+R arrives as "®":
 * the physical key is what counts with Alt.
 */
const tasto = (key: string, o: { shift?: boolean; alt?: boolean; code?: string } = {}) => ({
  key,
  code: o.code ?? (key.length === 1 && /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : ""),
  shiftKey: o.shift ?? false,
  altKey: o.alt ?? false,
});

describe("Alt+R turns by 45 degrees", () => {
  it("R 90, Shift+R -90, Alt+R 45, Alt+Shift+R -45, whatever character the Mac writes", () => {
    expect(rotazioneDaTasto(tasto("r"))).toBe(90);
    expect(rotazioneDaTasto(tasto("R", { shift: true }))).toBe(-90);
    expect(rotazioneDaTasto(tasto("®", { alt: true, code: "KeyR" }))).toBe(45);
    expect(rotazioneDaTasto(tasto("‰", { alt: true, shift: true, code: "KeyR" }))).toBe(-45);
    // Alt+R on a keyboard that does write the letter
    expect(rotazioneDaTasto(tasto("r", { alt: true }))).toBe(45);
    // not a turn: another key, and the physical R without Alt (another layout writes another letter there)
    expect(rotazioneDaTasto(tasto("f"))).toBeNull();
    expect(rotazioneDaTasto(tasto("p", { code: "KeyR" }))).toBeNull();
  });

  const CIRCUIT = [
    { type: "pcb_board", width: 20, height: 20, center: { x: 0, y: 0 }, num_layers: 2 },
    { type: "source_component", source_component_id: "s1", name: "C3", ftype: "simple_capacitor" },
    { type: "pcb_component", pcb_component_id: "pc1", source_component_id: "s1", center: { x: 2, y: 1 }, display_offset_x: 2, display_offset_y: 1, width: 1.5, height: 0.6, rotation: 0, layer: "top" },
    { type: "pcb_smtpad", pcb_smtpad_id: "p1", pcb_component_id: "pc1", shape: "rect", x: 1.5, y: 1, width: 0.6, height: 0.5, layer: "top" },
    { type: "pcb_smtpad", pcb_smtpad_id: "p2", pcb_component_id: "pc1", shape: "rect", x: 2.5, y: 1, width: 0.6, height: 0.5, layer: "top" },
  ];
  const flags = VIEW_PRESETS.find((p) => p.key === "interference")!.flags;

  it("a part held at 45, 135, 225 and 315 degrees: pads and footprint turned with it, around its origin", () => {
    for (const r of [45, 135, 225, 315]) {
      const svg = renderToStaticMarkup(
        createElement(BoardCanvas, { circuitJson: CIRCUIT, flags, layer: "top", mode: "move", moveOverrides: { pc1: { x: 2, y: 1, rotation: r } } } as never),
      );
      const giro = `rotate(${r} 2 1)`;
      // the footprint follows the part, by the same turn as its pads
      expect(svg).toMatch(new RegExp(`data-ingombro="ingombro-pc1" transform="translate\\(0 0\\) ${giro.replace(/[()]/g, "\\$&")}"`));
      expect(svg.split(giro).length - 1).toBeGreaterThanOrEqual(3);
    }
  });

  it("the place written by hand carries the angle, into the code as pcbRotation", () => {
    const evento = {
      edit_event_type: "edit_pcb_component_location",
      component_name: "C3",
      original_center: { x: 2, y: 1 },
      new_center: { x: 2, y: 1 },
      new_rotation: 45,
    } as EditEvent;
    const { placements } = patchesFromEvents([evento], boardPartsByName(CIRCUIT));
    expect(placements).toEqual([expect.objectContaining({ name: "C3", rotation: 45 })]);
    const main = `export default () => (<board width="20mm" height="20mm"><capacitor name="C3" capacitance="1uF" footprint="0402" pcbX={2} pcbY={1} /></board>)`;
    const scritto = injectManualEdits(main, {
      pcb_placements: [{ selector: "C3", center: { x: 2, y: 1 }, relative_to: "group_center", rotation: 45 }],
      schematic_placements: [],
      manual_trace_hints: [],
    } as never);
    expect(scritto).toContain("pcbRotation={45}");
  });
});
