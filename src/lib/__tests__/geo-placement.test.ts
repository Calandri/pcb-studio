import { describe, expect, it } from "vitest";
import { placeComponents, rotateExtentsCcw } from "@/lib/placement";
import { analyzePlacement } from "@/lib/placement-quality";

type El = Record<string, unknown>;

describe("rotateExtentsCcw", () => {
  it("turns the extents the same way the pads turn, (x, y) -> (-y, x)", () => {
    // pads of a part that sticks out only to the right and up
    const pads = [
      { x: 3, y: 0 },
      { x: 0, y: 1 },
      { x: -0.5, y: -0.2 },
    ];
    const ext = (ps: Array<{ x: number; y: number }>) => ({
      left: Math.max(...ps.map((p) => -p.x)),
      right: Math.max(...ps.map((p) => p.x)),
      bottom: Math.max(...ps.map((p) => -p.y)),
      top: Math.max(...ps.map((p) => p.y)),
    });
    const turned = pads.map((p) => ({ x: -p.y, y: p.x }));
    expect(rotateExtentsCcw(ext(pads))).toEqual(ext(turned));
    // four quarter turns are the identity
    let e = ext(pads);
    for (let i = 0; i < 4; i++) e = rotateExtentsCcw(e);
    expect(e).toEqual(ext(pads));
  });
});

/** a pad of a 2-pad passive or a chip, absolute coordinates */
const pad = (id: string, comp: string, port: string, x: number, y: number, w = 0.5, h = 0.6): El => ({
  type: "pcb_smtpad",
  shape: "rect",
  pcb_smtpad_id: id,
  pcb_component_id: comp,
  pcb_port_id: port,
  layer: "top",
  x,
  y,
  width: w,
  height: h,
});

/**
 * U1 (a chip) starts ON TOP of J1, a connector that never moves, so the
 * placer has to move U1. C1 is wired to U1's VDD pin and must end up next to
 * that pin where U1 ends up, not where U1 was.
 */
function decouplingBoard(): El[] {
  const els: El[] = [
    { type: "pcb_board", pcb_board_id: "b", center: { x: 0, y: 0 }, width: 40, height: 30 },
    { type: "source_net", source_net_id: "n_vdd", name: "VDD" },
    { type: "source_component", source_component_id: "s_u1", name: "U1", ftype: "simple_chip" },
    { type: "source_component", source_component_id: "s_c1", name: "C1", ftype: "simple_capacitor" },
    { type: "source_component", source_component_id: "s_j1", name: "J1", ftype: "simple_connector" },
    { type: "pcb_component", pcb_component_id: "u1", source_component_id: "s_u1", center: { x: 0, y: 0 }, rotation: 0, width: 4, height: 4, layer: "top" },
    { type: "pcb_component", pcb_component_id: "c1", source_component_id: "s_c1", center: { x: 12, y: 10 }, rotation: 0, width: 1.6, height: 0.8, layer: "top" },
    { type: "pcb_component", pcb_component_id: "j1", source_component_id: "s_j1", center: { x: 0, y: 0 }, rotation: 0, width: 6, height: 3, layer: "top" },
  ];
  const ports: Array<[string, string, string, number, number]> = [];
  // U1: 8 pins around a 4x4 body; pin "VDD" on the right side
  const u1Pins: Array<[string, number, number]> = [
    ["VDD", 2, 0.75],
    ["P2", 2, -0.75],
    ["P3", -2, 0.75],
    ["P4", -2, -0.75],
    ["P5", 0.75, 2],
    ["P6", -0.75, 2],
    ["P7", 0.75, -2],
    ["P8", -0.75, -2],
  ];
  for (const [n, x, y] of u1Pins) ports.push([`u1_${n}`, "u1", "s_u1", x, y]);
  ports.push(["c1_1", "c1", "s_c1", 11.5, 10], ["c1_2", "c1", "s_c1", 12.5, 10]);
  ports.push(["j1_1", "j1", "s_j1", -2, 0], ["j1_2", "j1", "s_j1", 2, 0]);
  for (const [id, comp, src, x, y] of ports) {
    els.push({ type: "source_port", source_port_id: `s_${id}`, source_component_id: src, name: id.split("_").pop() });
    els.push({ type: "pcb_port", pcb_port_id: id, source_port_id: `s_${id}`, pcb_component_id: comp, x, y });
    els.push(pad(`pad_${id}`, comp, id, x, y));
  }
  // C1.pin1 wired to U1.VDD, and both on the VDD net
  els.push({
    type: "source_trace",
    source_trace_id: "t1",
    connected_source_port_ids: ["s_c1_1", "s_u1_VDD"],
    connected_source_net_ids: ["n_vdd"],
  });
  return els;
}

describe("placeComponents: decoupling capacitors follow their chip", () => {
  it("seats the capacitor at the pin where the chip ENDS UP", () => {
    const cj = decouplingBoard();
    const { placements } = placeComponents(cj, {
      blocks: new Map([
        ["U1", "mcu"],
        ["C1", "mcu"],
      ]),
      attempts: 2,
      budgetMs: 4000,
      zoneRounds: 0,
    });
    const u1 = placements.find((p) => p.name === "U1");
    const c1 = placements.find((p) => p.name === "C1");
    expect(u1).toBeDefined();
    expect(c1).toBeDefined();
    // U1 had to leave J1; its VDD pin is at (+2, +0.75) from its centre
    expect(Math.hypot(u1!.center.x, u1!.center.y)).toBeGreaterThan(1);
    const vdd = { x: u1!.center.x + 2, y: u1!.center.y + 0.75 };
    const d = Math.hypot(c1!.center.x - vdd.x, c1!.center.y - vdd.y);
    /*
     * C1 is seated while U1 still sits on J1 (it slides 3.5mm along the
     * flank to clear J1), then the solver moves U1 off J1. Riding its chip,
     * C1 ends ~4mm from the pin; left behind, as it was, ~7mm.
     */
    expect(d).toBeLessThan(5);
  });
});

describe("analyzePlacement", () => {
  /** many touching courtyards with copper well apart (warnings), one real copper clash */
  function crowded(): El[] {
    const els: El[] = [{ type: "pcb_board", center: { x: 0, y: 0 }, width: 200, height: 200 }];
    const part = (name: string, x: number, y: number, padGap: number) => {
      const id = `pc_${name}`;
      els.push({ type: "source_component", source_component_id: `s_${name}`, name, ftype: "simple_resistor" });
      els.push({ type: "pcb_component", pcb_component_id: id, source_component_id: `s_${name}`, center: { x, y }, layer: "top" });
      els.push({ type: "pcb_courtyard_rect", pcb_component_id: id, center: { x, y }, width: 2, height: 1 });
      els.push(pad(`${name}_a`, id, `${name}_a`, x - padGap, y, 0.3, 0.3));
      els.push(pad(`${name}_b`, id, `${name}_b`, x + padGap, y, 0.3, 0.3));
    };
    // 70 pairs whose courtyards overlap by 0.1mm while the copper keeps 1.3mm
    for (let i = 0; i < 70; i++) {
      part(`A${i}`, -90 + (i % 10) * 15, -90 + Math.floor(i / 10) * 10, 0.3);
      part(`B${i}`, -90 + (i % 10) * 15 + 1.9, -90 + Math.floor(i / 10) * 10, 0.3);
    }
    // the real defect, written LAST: copper on copper
    part("X1", 80, 80, 0.3);
    part("X2", 80.5, 80, 0.3);
    // a courtyard with no centre: ignored, not read as (0,0)
    els.push({ type: "pcb_courtyard_rect", pcb_component_id: "pc_X1", width: 300, height: 300 });
    return els;
  }

  it("is not routable when a failure sits beyond the capped list", () => {
    const q = analyzePlacement(crowded());
    expect(q.issues.length).toBeLessThanOrEqual(100);
    expect(q.fails).toBeGreaterThan(0);
    expect(q.routable).toBe(false);
  });

  it("measures polygon and round pads by their real size", () => {
    const els: El[] = [
      { type: "pcb_board", center: { x: 0, y: 0 }, width: 50, height: 50 },
      { type: "source_component", source_component_id: "s1", name: "U1" },
      { type: "source_component", source_component_id: "s2", name: "TP1" },
      { type: "pcb_component", pcb_component_id: "c1", source_component_id: "s1", center: { x: 0, y: 0 }, layer: "top" },
      { type: "pcb_component", pcb_component_id: "c2", source_component_id: "s2", center: { x: 1.4, y: 0 }, layer: "top" },
      { type: "pcb_smtpad", shape: "polygon", pcb_component_id: "c1", layer: "top", points: [{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }] },
      { type: "pcb_smtpad", shape: "circle", pcb_component_id: "c2", layer: "top", x: 1.4, y: 0, radius: 0.5 },
    ];
    const q = analyzePlacement(els);
    // 1.4 - 1 - 0.5 < 0: they overlap, which a 0.5mm default square would hide
    expect(q.routable).toBe(false);
    expect(q.issues[0].components.sort()).toEqual(["TP1", "U1"]);
  });
});
