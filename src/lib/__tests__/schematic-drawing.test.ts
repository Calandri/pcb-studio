import { describe, expect, it } from "vitest";
import { buildSchematicModel } from "@/lib/schematic-model";
import {
  chipArt,
  netLabelArt,
  overlaps,
  pinCaption,
  textBox,
  type ChipPin,
} from "@/lib/schematic-shapes";
import { renderSchematicSvg } from "@/components/schematic/render-svg";

/*
 * A small Circuit JSON written by hand, in the shape tscircuit emits (y up):
 * an IC with pinLabels, a resistor with its symbol, a test point that arrives
 * as a one-pin <chip> (the HTL-401 case), a GND label with its rail symbol
 * and a signal label on a pin.
 */
function circuit(opts: { pinName?: string; chipName?: string } = {}): unknown[] {
  const chipName = opts.chipName ?? "U1";
  const out: unknown[] = [
    { type: "source_net", source_net_id: "sn_gnd", name: "GND", is_ground: true, subcircuit_connectivity_map_key: "k_gnd" },
    { type: "source_component", source_component_id: "sc_u1", ftype: "simple_chip", name: chipName, manufacturer_part_number: "LP5907MFX" },
    { type: "schematic_component", schematic_component_id: "u1", source_component_id: "sc_u1", center: { x: 0, y: 0 }, size: { width: 1.2, height: 0.6 } },
    { type: "source_component", source_component_id: "sc_r1", ftype: "simple_resistor", name: "R1", display_resistance: "10kΩ" },
    { type: "schematic_component", schematic_component_id: "r1", source_component_id: "sc_r1", center: { x: 3, y: 0 }, size: { width: 0.6, height: 0.65 }, symbol_name: "boxresistor_right" },
    { type: "source_component", source_component_id: "sc_tp", ftype: "simple_chip", name: "TP_USB_DP" },
    { type: "schematic_component", schematic_component_id: "tp", source_component_id: "sc_tp", center: { x: 0, y: -3 }, size: { width: 1.2, height: 0.4 } },
  ];
  const port = (id: string, comp: string, x: number, y: number, pin: number, side: string, label?: string) => {
    out.push({
      type: "schematic_port",
      schematic_port_id: id,
      schematic_component_id: comp,
      source_port_id: `s_${id}`,
      center: { x, y },
      pin_number: pin,
      side_of_component: side,
      ...(label ? { display_pin_label: label } : {}),
    });
  };
  port("u1p1", "u1", -1, 0.1, 1, "left", opts.pinName ?? "VIN");
  port("u1p2", "u1", -1, -0.1, 2, "left", "GND");
  port("u1p3", "u1", 1, 0.1, 3, "right", "VOUT");
  port("u1p4", "u1", 1, -0.1, 4, "right", "4");
  port("r1p1", "r1", 2.7, 0, 1, "left");
  port("r1p2", "r1", 3.3, 0, 2, "right");
  port("tpp1", "tp", -1, -3, 1, "left");
  out.push(
    { type: "source_trace", source_trace_id: "st1", connected_source_port_ids: ["s_u1p2"], subcircuit_connectivity_map_key: "k_gnd", display_name: ".U1 > .GND to net.GND" },
    { type: "schematic_net_label", schematic_net_label_id: "nl_gnd", source_net_id: "sn_gnd", text: "GND", anchor_position: { x: -1, y: -0.1 }, center: { x: -1, y: -0.19 }, anchor_side: "top", symbol_name: "rail_down" },
    { type: "schematic_net_label", schematic_net_label_id: "nl_sig", source_net_id: "k_sig", text: "U1_VOUT", anchor_position: { x: 1, y: 0.1 }, center: { x: 1.4, y: 0.1 }, anchor_side: "left" },
  );
  return out;
}

const pins = (spec: Array<[string, ChipPin["side"], number, string | null]>): ChipPin[] =>
  spec.map(([number, side, along, name]) => {
    const box = { x: -0.6, y: -0.5, w: 1.2, h: 1 };
    const pos =
      side === "left" ? { x: box.x - 0.4, y: along }
      : side === "right" ? { x: box.x + box.w + 0.4, y: along }
      : side === "top" ? { x: along, y: box.y - 0.4 }
      : { x: along, y: box.y + box.h + 0.4 };
    return { ...pos, side, number, name };
  });

describe("chip drawing", () => {
  const box = { x: -0.6, y: -0.5, w: 1.2, h: 1 };

  it("a pin name that only repeats the number is not written", () => {
    expect(pinCaption("1", "1")).toBeNull();
    expect(pinCaption("pin7", "7")).toBeNull();
    expect(pinCaption(null, "3")).toBeNull();
    expect(pinCaption("VCC", "8")).toBe("VCC");
  });

  it("every pin gets a line from the body, its number outside and its name inside", () => {
    const art = chipArt(box, pins([["1", "left", -0.1, "VIN"], ["2", "right", 0.1, "VOUT"]]), { name: "U2", subtitle: "LP5907" });
    expect(art.stubs).toHaveLength(2);
    const numbers = art.labels.filter((l) => l.tone === "number");
    expect(numbers.map((l) => l.text).sort()).toEqual(["1", "2"]);
    for (const n of numbers) expect(n.x < box.x || n.x > box.x + box.w).toBe(true);
    const names = art.labels.filter((l) => l.tone === "pin");
    expect(names.map((l) => l.text).sort()).toEqual(["VIN", "VOUT"]);
    for (const n of names) {
      const b = textBox(n);
      expect(b.minX).toBeGreaterThanOrEqual(box.x);
      expect(b.maxX).toBeLessThanOrEqual(box.x + box.w);
    }
  });

  it("designator above and part number below, outside the body", () => {
    const art = chipArt(box, pins([["1", "left", 0, "A"]]), { name: "U2", subtitle: "LP5907" });
    const name = art.labels.find((l) => l.tone === "name")!;
    const part = art.labels.find((l) => l.tone === "value")!;
    expect(textBox(name).maxY).toBeLessThanOrEqual(box.y);
    expect(textBox(part).minY).toBeGreaterThanOrEqual(box.y + box.h);
  });

  it("with pins below, designator and part number both go above", () => {
    const art = chipArt(box, pins([["1", "left", 0, "A"], ["2", "bottom", 0, "GND"]]), { name: "U2", subtitle: "LP5907" });
    for (const l of art.labels.filter((l) => l.tone === "name" || l.tone === "value")) {
      expect(textBox(l).maxY).toBeLessThanOrEqual(box.y);
    }
  });

  it("with pins all around, the designator goes in the middle of the body", () => {
    const big = { x: -1, y: -2, w: 2, h: 4 };
    const p: ChipPin[] = [
      { x: -1.4, y: 0, side: "left", number: "1", name: null },
      { x: 1.4, y: 0, side: "right", number: "2", name: null },
      { x: 0, y: -2.4, side: "top", number: "3", name: null },
      { x: 0, y: 2.4, side: "bottom", number: "4", name: null },
    ];
    const art = chipArt(big, p, { name: "U1", subtitle: "PIC18F47J53-I_PT" });
    for (const l of art.labels.filter((l) => l.tone === "name" || l.tone === "value")) {
      const b = textBox(l);
      expect(b.minX).toBeGreaterThanOrEqual(big.x);
      expect(b.maxX).toBeLessThanOrEqual(big.x + big.w);
      expect(l.fixed).toBe(true);
    }
  });

  it("facing pin names never overlap, even when they are too long for the body", () => {
    const art = chipArt(
      box,
      pins([["1", "left", 0, "VERY_LONG_LEFT_NAME"], ["2", "right", 0, "VERY_LONG_RIGHT_NAME"]]),
      { name: "U9", subtitle: null },
    );
    const [a, b] = art.labels.filter((l) => l.tone === "pin").map(textBox);
    expect(overlaps(a, b)).toBe(false);
  });

  it("a connector gets a contact mark on every pin", () => {
    const art = chipArt(box, pins([["1", "right", -0.1, "VBAT"], ["2", "right", 0.1, "GND"]]), { name: "J1", subtitle: null, connector: true });
    expect(art.marks).toHaveLength(2);
  });
});

describe("net labels", () => {
  it("a flag starts with its point on the pin and grows away from it", () => {
    const art = netLabelArt({ x: 1, y: 0 }, "left", "flag", "SDA");
    expect(art.outline.startsWith("M1 0")).toBe(true);
    expect(art.box.minX).toBeCloseTo(1);
    expect(art.box.maxX).toBeGreaterThan(1.2);
    expect(art.closed).toBe(true);
  });

  it("ground hangs below the pin with its name under the bars", () => {
    const art = netLabelArt({ x: 0, y: 0 }, "top", "ground", "GND");
    expect(art.box.minY).toBeCloseTo(0);
    expect(art.text.y).toBeGreaterThan(0.19);
    expect(art.closed).toBe(false);
  });
});

describe("schematic model", () => {
  it("draws the IC with pin lines, the resistor with its symbol, a one-pin chip as a test point", () => {
    const model = buildSchematicModel(circuit());
    const u1 = model.nodes.find((n) => n.name === "U1")!;
    expect(u1.kind).toBe("box");
    expect(u1.paths).toHaveLength(4);
    const captions = u1.labels.filter((l) => l.tone === "pin").map((l) => l.text);
    // the pin named "4" says nothing more than its number
    expect(captions.sort()).toEqual(["GND", "VIN", "VOUT"]);
    expect(u1.labels.find((l) => l.tone === "value")?.text).toBe("LP5907MFX");

    const r1 = model.nodes.find((n) => n.name === "R1")!;
    expect(r1.kind).toBe("symbol");
    expect(r1.labels.map((l) => l.text).sort()).toEqual(["10kΩ", "R1"]);

    const tp = model.nodes.find((n) => n.name === "TP_USB_DP")!;
    expect(tp.kind).toBe("symbol");
    expect(tp.labels.some((l) => l.text === "1")).toBe(false);
    expect(tp.labels.find((l) => l.tone === "name")?.text).toBe("TP_USB_DP");
  });

  it("net labels stay on their pin: ground with its symbol, signals as flags", () => {
    const model = buildSchematicModel(circuit());
    const gnd = model.netLabels.find((l) => l.text === "GND")!;
    expect(gnd.shape).toBe("ground");
    expect(gnd.attach).toEqual({ x: -1, y: 0.1 });
    expect(gnd.port).toBeUndefined();
    // the declared trace through that pin, so Connect mode can remove it
    expect(gnd.declaredAs).toEqual([".U1 > .GND to net.GND"]);
    const sig = model.netLabels.find((l) => l.text === "U1_VOUT")!;
    expect(sig.shape).toBe("flag");
    expect(sig.attach).toEqual({ x: 1, y: -0.1 });
  });

  it("texts that can move do not end up on top of each other", () => {
    const model = buildSchematicModel(circuit());
    const movable = model.nodes.flatMap((n) => n.labels.filter((l) => !l.fixed && (l.tone === "name" || l.tone === "value")));
    const boxes = [...movable.map(textBox), ...model.netLabels.map((l) => l.box)];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) expect(overlaps(boxes[i], boxes[j], 0.005)).toBe(false);
    }
  });
});

describe("sheet SVG", () => {
  it("pin and component names are drawn as text, never as markup", () => {
    const svg = renderSchematicSvg(
      circuit({ pinName: "<script>alert(1)</script>", chipName: '"><img src=x onerror=alert(1)>' }),
      { width: 800, height: 500 },
    );
    expect(svg).not.toContain("<script");
    expect(svg).not.toContain("<img");
    expect(svg).toContain("&lt;script&gt;");
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
  });

  it("an empty circuit still renders a sheet", () => {
    expect(renderSchematicSvg([], { width: 200, height: 100 })).toContain("<svg");
  });
});
