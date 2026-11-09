import { describe, expect, it } from "vitest";
import { compileProject } from "@/lib/compile";
import { applyEditEvents, injectManualEdits, parseManualEdits, serializeManualEdits, emptyManualEdits } from "@/lib/manual-edits";
import { rerouteLocal } from "@/lib/reroute-local";
import { mirrorMatrix } from "@/components/board/BoardCanvas";

/*
 * "Gira lato" (F in Sposta, 2026-11-09): un pezzo passa all'altra faccia nello
 * stesso punto. Si salva in manual-edits.json come `layer` del suo
 * pcb_placement, entra nel .tsx come prop `layer` e la compilazione specchia
 * l'impronta come fa tscircuit per ogni pezzo su quella faccia.
 */
type El = Record<string, unknown>;
const MAIN = `export default () => (
  <board width="20mm" height="10mm">
    <resistor name="R35" resistance="1M" footprint="0402" pcbX={-4} pcbY={0} pcbRotation={90} layer="top" />
    <transistor name="Q3" type="npn" footprint="sot23" pcbX={4} pcbY={0} pcbRotation={180} layer="top" />
  </board>
)
`;
const edits = (layer: "top" | "bottom") =>
  JSON.stringify({
    pcb_placements: [
      { selector: "R35", center: { x: -4, y: 0 }, rotation: 90, layer },
      { selector: "Q3", center: { x: 4, y: 0 }, rotation: 180, layer },
    ],
  });
const pezzo = (cj: El[], name: string) => {
  const src = cj.find((e) => e.type === "source_component" && e.name === name)!;
  const pc = cj.find((e) => e.type === "pcb_component" && e.source_component_id === src.source_component_id)!;
  const pads = cj
    .filter((e) => e.type === "pcb_smtpad" && e.pcb_component_id === pc.pcb_component_id)
    .map((p) => ({ x: Math.round(Number(p.x) * 1000) / 1000, y: Math.round(Number(p.y) * 1000) / 1000, layer: p.layer, port: (p.port_hints as string[] | undefined)?.[0] }));
  return { pc, pads };
};

describe("gira lato: il file e gli eventi", () => {
  it("il lato si legge, si scrive e un evento lo porta", () => {
    const e = parseManualEdits(edits("bottom"));
    expect(e.pcb_placements.map((p) => p.layer)).toEqual(["bottom", "bottom"]);
    expect(serializeManualEdits(e)).toContain('"layer": "bottom"');
    expect(parseManualEdits(JSON.stringify({ pcb_placements: [{ selector: "R1", center: { x: 0, y: 0 }, layer: "inner1" }] })).pcb_placements[0].layer).toBeUndefined();
  });

  it("uno spostamento dopo il giro non riporta il pezzo sopra", () => {
    const cj = [
      { type: "source_component", source_component_id: "s1", name: "R35" },
      { type: "pcb_component", pcb_component_id: "p1", source_component_id: "s1", center: { x: 0, y: 0 }, display_offset_x: 0, display_offset_y: 0, layer: "top" },
    ];
    const gira = applyEditEvents({
      circuitJson: cj, main: "", edits: emptyManualEdits(),
      events: [{ edit_event_type: "edit_pcb_component_location", pcb_component_id: "p1", original_center: { x: 0, y: 0 }, new_center: { x: 0, y: 0 }, new_layer: "bottom" }],
    });
    expect(gira.pcb_placements[0]).toMatchObject({ selector: "R35", center: { x: 0, y: 0 }, layer: "bottom" });
    const sposta = applyEditEvents({
      circuitJson: cj, main: "", edits: gira,
      events: [{ edit_event_type: "edit_pcb_component_location", pcb_component_id: "p1", original_center: { x: 0, y: 0 }, new_center: { x: 1, y: 0 } }],
    });
    expect(sposta.pcb_placements[0]).toMatchObject({ center: { x: 1, y: 0 }, layer: "bottom" });
  });

  it("entra nel sorgente come prop layer", () => {
    const out = injectManualEdits(MAIN, parseManualEdits(edits("bottom")));
    expect(out).toMatch(/name="R35"[^>]*layer="bottom"/);
    expect(out).not.toMatch(/name="R35"[^>]*layer="top"/);
  });

  it("sulla scheda in cache non si specchia: lo dice e chiede Aggiorna", () => {
    const cj = [
      { type: "pcb_board", center: { x: 0, y: 0 }, width: 20, height: 10 },
      { type: "source_component", source_component_id: "s1", name: "R35" },
      { type: "pcb_component", pcb_component_id: "p1", source_component_id: "s1", center: { x: -4, y: 0 }, display_offset_x: -4, display_offset_y: 0, rotation: 90, layer: "top" },
    ];
    const r = rerouteLocal(cj, {}, JSON.stringify({ pcb_placements: [{ selector: "R35", center: { x: -4, y: 0 }, rotation: 90, layer: "bottom" }] }));
    expect(r.result.ok).toBe(false);
    expect(r.result.reason).toMatch(/Aggiorna/);
  });
});

describe("gira lato: la scheda compilata", () => {
  it("0402 e SOT-23 passano sotto specchiati nello stesso punto, e tornano sopra uguali a prima", async () => {
    const sopra = (await compileProject({ "main.tsx": MAIN })).circuitJson as El[];
    const sotto = (await compileProject({ "main.tsx": MAIN, "manual-edits.json": edits("bottom") })).circuitJson as El[];
    const ancora = (await compileProject({ "main.tsx": MAIN, "manual-edits.json": edits("top") })).circuitJson as El[];
    for (const n of ["R35", "Q3"]) {
      const a = pezzo(sopra, n);
      const b = pezzo(sotto, n);
      expect(a.pc.layer).toBe("top");
      expect(b.pc.layer).toBe("bottom");
      expect(b.pads.every((p) => p.layer === "bottom")).toBe(true);
      // same place and rotation
      expect([b.pc.display_offset_x, b.pc.display_offset_y, b.pc.rotation]).toEqual([a.pc.display_offset_x, a.pc.display_offset_y, a.pc.rotation]);
      // mirrored on the part's own Y axis: rotated by r, the axis is at r + 90 degrees
      const ox = Number(a.pc.display_offset_x), oy = Number(a.pc.display_offset_y), r = ((Number(a.pc.rotation) + 90) * Math.PI) / 180;
      const c2 = Math.cos(2 * r), s2 = Math.sin(2 * r);
      for (const p of a.pads) {
        const mx = ox + c2 * (p.x - ox) + s2 * (p.y - oy);
        const my = oy + s2 * (p.x - ox) - c2 * (p.y - oy);
        const q = b.pads.find((x) => x.port === p.port)!;
        expect(q.x).toBeCloseTo(mx, 2);
        expect(q.y).toBeCloseTo(my, 2);
      }
      expect(pezzo(ancora, n).pads).toEqual(a.pads);
      // and the canvas preview mirrors exactly like the compiler
      const m = mirrorMatrix(ox, oy, Number(a.pc.rotation));
      for (const p of a.pads) {
        const q = b.pads.find((x) => x.port === p.port)!;
        expect(m.a * p.x + m.c * p.y + m.e).toBeCloseTo(q.x, 2);
        expect(m.b * p.x + m.d * p.y + m.f).toBeCloseTo(q.y, 2);
      }
    }
  }, 300_000);
});
