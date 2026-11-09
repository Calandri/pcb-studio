import { existsSync, readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { buildSchematicModel, type SchematicModel } from "@/lib/schematic-model";
import {
  HIGHLIGHT_COLOR,
  HIGHLIGHT_FADE,
  MAX_QUERY,
  buildIndex,
  cleanSel,
  componentOfKey,
  describeTarget,
  highlightFor,
  hitTest,
  isRail,
  labelKey,
  pathSegments,
  resolveKey,
  searchSchematic,
  sectionList,
  targetBox,
  targetKey,
  viewForBox,
  wireKey,
} from "@/lib/schematic-interaction";
import { SchematicSheet, fitView, sheetFrame } from "@/components/schematic/SchematicSheet";
import { SearchBox, SelectionCard } from "@/components/schematic/SchematicOverlay";

/*
 * A small sheet in the shape tscircuit emits (y up): U1 with a signal SIG to
 * R1 and to U2 far away, every part on GND, GND with more pins than a signal
 * may have (a rail), one wire per net, a GND label on a pin of U1.
 */
function circuit(): unknown[] {
  const out: unknown[] = [
    { type: "source_net", source_net_id: "sn_gnd", name: "GND", is_ground: true, subcircuit_connectivity_map_key: "k_gnd" },
    { type: "source_net", source_net_id: "sn_sig", name: "SIG", subcircuit_connectivity_map_key: "k_sig" },
  ];
  const comp = (id: string, name: string, x: number, y: number, extra: Record<string, unknown> = {}) => {
    out.push(
      { type: "source_component", source_component_id: `sc_${id}`, ftype: "simple_chip", name, ...extra },
      { type: "schematic_component", schematic_component_id: id, source_component_id: `sc_${id}`, center: { x, y }, size: { width: 1, height: 0.6 } },
    );
  };
  const port = (id: string, compId: string, x: number, y: number, pin: number, side: string, label: string, key: string | null) => {
    out.push({
      type: "schematic_port",
      schematic_port_id: id,
      schematic_component_id: compId,
      source_port_id: `s_${id}`,
      center: { x, y },
      pin_number: pin,
      side_of_component: side,
      display_pin_label: label,
    });
    if (key) out.push({ type: "source_trace", source_trace_id: `st_${id}`, connected_source_port_ids: [`s_${id}`], subcircuit_connectivity_map_key: key, display_name: `.${compId} > .${label} to net` });
  };
  comp("u1", "U1", 0, 0, { manufacturer_part_number: "ADS1232IPWR" });
  comp("u2", "U2", 20, 0, { manufacturer_part_number: "LP5907" });
  out.push(
    { type: "source_component", source_component_id: "sc_r1", ftype: "simple_resistor", name: "R1", display_resistance: "10kΩ" },
    { type: "schematic_component", schematic_component_id: "r1", source_component_id: "sc_r1", center: { x: 3, y: 0 }, size: { width: 0.6, height: 0.3 }, symbol_name: "boxresistor_right" },
  );
  port("u1p1", "u1", -0.8, 0.1, 1, "left", "VIN", null);
  port("u1p2", "u1", -0.8, -0.1, 2, "left", "GND", "k_gnd");
  port("u1p3", "u1", 0.8, 0.1, 3, "right", "OUT", "k_sig");
  port("u2p1", "u2", 19.2, 0.1, 1, "left", "IN", "k_sig");
  port("u2p2", "u2", 19.2, -0.1, 2, "left", "GND", "k_gnd");
  port("r1p1", "r1", 2.7, 0, 1, "left", "pin1", "k_sig");
  port("r1p2", "r1", 3.3, 0, 2, "right", "pin2", "k_gnd");
  // eleven more GND pins on test points: GND becomes a rail (more than 12 pins)
  for (let i = 0; i < 11; i++) {
    comp(`tp${i}`, `TP${i + 1}`, -10 + i, 10);
    port(`tp${i}p`, `tp${i}`, -10.5 + i, 10, 1, "left", "1", "k_gnd");
  }
  out.push(
    {
      type: "schematic_trace",
      schematic_trace_id: "w_sig",
      source_trace_id: "st_u1p3",
      subcircuit_connectivity_map_key: "k_sig",
      edges: [
        { from: { x: 0.8, y: 0.1 }, to: { x: 2.7, y: 0.1 } },
        { from: { x: 2.7, y: 0.1 }, to: { x: 2.7, y: 0 } },
      ],
    },
    {
      // U1's GND pin wired to TP1: on a rail, the part at the other end
      type: "schematic_trace",
      schematic_trace_id: "w_gnd_tp1",
      source_trace_id: "st_tp0p",
      subcircuit_connectivity_map_key: "k_gnd",
      edges: [
        { from: { x: -0.8, y: -0.1 }, to: { x: -10.5, y: -0.1 } },
        { from: { x: -10.5, y: -0.1 }, to: { x: -10.5, y: 10 } },
      ],
    },
    {
      type: "schematic_trace",
      schematic_trace_id: "w_gnd_far",
      source_trace_id: "st_u2p2",
      subcircuit_connectivity_map_key: "k_gnd",
      edges: [{ from: { x: 19.2, y: -0.1 }, to: { x: 18, y: -0.1 } }],
    },
    { type: "schematic_net_label", schematic_net_label_id: "nl_gnd", source_net_id: "sn_gnd", text: "GND", anchor_position: { x: -0.8, y: -0.1 }, center: { x: -0.8, y: -0.25 }, anchor_side: "top", symbol_name: "rail_down" },
    { type: "schematic_net_label", schematic_net_label_id: "nl_gnd2", source_net_id: "sn_gnd", text: "GND", anchor_position: { x: 3.3, y: 0 }, center: { x: 3.3, y: -0.15 }, anchor_side: "top", symbol_name: "rail_down" },
  );
  return out;
}

const cj = circuit();
const model = buildSchematicModel(cj);
const idx = buildIndex(model, cj);
const id = (name: string) => model.nodes.find((n) => n.name === name)!.id;

describe("wire paths", () => {
  it("reads absolute and relative segments", () => {
    expect(pathSegments("M0 0L1 0M1 0L1 2")).toEqual([
      [{ x: 0, y: 0 }, { x: 1, y: 0 }],
      [{ x: 1, y: 0 }, { x: 1, y: 2 }],
    ]);
    expect(pathSegments("M1 1h2v-1l1 1")).toEqual([
      [{ x: 1, y: 1 }, { x: 3, y: 1 }],
      [{ x: 3, y: 1 }, { x: 3, y: 0 }],
      [{ x: 3, y: 0 }, { x: 4, y: 1 }],
    ]);
    expect(pathSegments("M-1.5 2e-1 L .5 -3")).toEqual([[{ x: -1.5, y: 0.2 }, { x: 0.5, y: -3 }]]);
  });
});

describe("selection -> what is lit", () => {
  it("a GND with more than a dozen pins is a rail, a two-part signal is not", () => {
    expect(isRail(idx, "GND")).toBe(true);
    expect(isRail(idx, "SIG")).toBe(false);
  });

  it("a part lights its signal nets everywhere, far pins included, and its rails only next to it", () => {
    const h = highlightFor(model, idx, { kind: "node", id: id("U1") })!;
    expect([...h.focus.keys()]).toEqual([id("U1")]);
    // the outline wraps the designator too, which sits outside the frame
    expect(h.focus.get(id("U1"))!.minY).toBeLessThan(model.nodes.find((n) => n.name === "U1")!.bbox.minY);
    expect(h.nets.has("SIG")).toBe(true);
    expect(h.nets.has("GND")).toBe(false);
    // U2's pin on SIG is far away on the sheet: it is ringed and U2 stays readable
    expect(h.ports.has(".U2 > .IN")).toBe(true);
    expect(h.nodes.has(id("U2"))).toBe(true);
    // GND: the symbol on U1's own pin is lit, the far GND wire of U2 is not
    const own = model.netLabels.findIndex((l) => Math.abs(l.attach.x + 0.8) < 1e-6);
    expect(h.keys.has(labelKey(own))).toBe(true);
    expect(h.keys.has(wireKey("w_gnd_far"))).toBe(false);
    // GND wire from U1's pin: lit, and TP1 at its other end stays readable,
    // while the test points only on the GND net fade
    expect(h.keys.has(wireKey("w_gnd_tp1"))).toBe(true);
    expect(h.nodes.has(id("TP1"))).toBe(true);
    expect(h.nodes.has(id("TP2"))).toBe(false);
  });

  it("a pin lights its whole net, a rail too", () => {
    const h = highlightFor(model, idx, { kind: "port", nodeId: id("U2"), selector: ".U2 > .GND" })!;
    expect(h.nets).toEqual(new Set(["GND"]));
    expect(h.nodes.has(id("TP11"))).toBe(true);
    expect(h.ports.size).toBe(idx.portsByNet.get("GND")!.length);
  });

  it("a net lights every pin on it and the parts they belong to", () => {
    const h = highlightFor(model, idx, { kind: "net", net: "SIG" })!;
    expect([...h.ports].sort()).toEqual([".R1 > .pin1", ".U1 > .OUT", ".U2 > .IN"]);
    expect(h.nodes).toEqual(new Set([id("U1"), id("U2"), id("R1")]));
    expect(highlightFor(model, idx, { kind: "net", net: "NOPE" })).toBeNull();
  });
});

describe("hit test", () => {
  const k = 100;
  it("inside an IC body it is the IC", () => {
    expect(hitTest(model, idx, { x: 0, y: 0 }, k)).toEqual({ kind: "node", id: id("U1") });
  });
  it("next to a pin it is the pin, within a few pixels", () => {
    expect(hitTest(model, idx, { x: 0.82, y: -0.1 }, k)).toEqual({ kind: "port", nodeId: id("U1"), selector: ".U1 > .OUT" });
  });
  it("on a wire it is its net", () => {
    expect(hitTest(model, idx, { x: 1.6, y: -0.12 }, k)).toEqual({ kind: "net", net: "SIG" });
  });
  it("in the void it is nothing", () => {
    expect(hitTest(model, idx, { x: 10, y: -5 }, k)).toBeNull();
  });
  it("a part dragged elsewhere is found where it is drawn", () => {
    const off = { [id("U1")]: { dx: 5, dy: 5 } };
    expect(hitTest(model, idx, { x: 5, y: 5 }, k, off)).toEqual({ kind: "node", id: id("U1") });
  });
});

describe("cards", () => {
  it("a part: designator, part number, comment if any, pins and nets", () => {
    const info = describeTarget(model, idx, { kind: "node", id: id("U1") })!;
    expect(info.title).toBe("U1");
    expect(info.lines).toContain("ADS1232IPWR");
    expect(info.lines.some((l) => /3 piedini · 2 reti/.test(l))).toBe(true);
    expect(info.nets.map((n) => n.name)).toEqual(["SIG", "GND"]); // signals first
    const withComment = { ...model, nodes: model.nodes.map((n) => (n.name === "U1" ? { ...n, comment: "ADC della cella di carico" } : n)) };
    const i2 = buildIndex(withComment, cj);
    expect(describeTarget(withComment, i2, { kind: "node", id: id("U1") })!.lines).toContain("ADC della cella di carico");
  });
  it("a pin: number, name, net with its pin count", () => {
    const info = describeTarget(model, idx, { kind: "port", nodeId: id("U1"), selector: ".U1 > .OUT" })!;
    expect(info.title).toBe("U1 · piedino 3");
    expect(info.lines).toEqual(["nome OUT", "rete SIG · 3 piedini"]);
  });
  it("a net: how many pins and parts it ties", () => {
    const info = describeTarget(model, idx, { kind: "net", net: "SIG" })!;
    expect(info.lines[0]).toBe("3 piedini collegati su 3 pezzi");
    expect(info.parts).toEqual(["R1", "U1", "U2"]);
  });
});

describe("search", () => {
  it("designator first, exact before partial, in natural order", () => {
    const r = searchSchematic(model, idx, "tp1");
    expect(r[0].label).toBe("TP1");
    expect(r.slice(1, 3).map((x) => x.label)).toEqual(["TP10", "TP11"]);
  });
  it("finds by value, part number and net", () => {
    expect(searchSchematic(model, idx, "10k").map((r) => r.label)).toEqual(["R1"]);
    expect(searchSchematic(model, idx, "lp5907")[0].label).toBe("U2");
    const net = searchSchematic(model, idx, "sig")[0];
    expect(net).toMatchObject({ kind: "rete", label: "SIG" });
    expect(net.box.maxX).toBeGreaterThan(19); // the zoom frames the far pin too
  });
  it("what is typed stays text: no regular expression, no markup", () => {
    expect(() => searchSchematic(model, idx, "(.*[")).not.toThrow();
    expect(searchSchematic(model, idx, ".*")).toEqual([]);
    expect(searchSchematic(model, idx, "<script>alert(1)</script>")).toEqual([]);
    expect(searchSchematic(model, idx, "u".repeat(MAX_QUERY * 4))).toEqual([]);
    expect(searchSchematic(model, idx, "   ")).toEqual([]);
  });
});

describe("zoom", () => {
  it("frames a box in the middle, without zooming a tiny part to the moon", () => {
    const v = viewForBox({ minX: 0, minY: 0, maxX: 0.1, maxY: 0.1 }, { w: 1000, h: 800 }, { pad: 0, maxK: 140 });
    expect(v.k).toBe(140);
    expect(v.x + 0.05 * v.k).toBeCloseTo(500);
    expect(v.y + 0.05 * v.k).toBeCloseTo(400);
    const wide = viewForBox({ minX: -40, minY: 0, maxX: 40, maxY: 70 }, { w: 1000, h: 800 }, { pad: 0, margin: 0 });
    expect(wide.k).toBeCloseTo(800 / 70); // the height decides
  });
  it("a net is framed with all its pins", () => {
    const b = targetBox(model, idx, { kind: "net", net: "SIG" })!;
    expect(b.minX).toBeLessThan(1);
    expect(b.maxX).toBeGreaterThan(19);
  });
});

describe("sections", () => {
  it("listed top to bottom, left to right, with a name even without a title", () => {
    const m: SchematicModel = {
      ...model,
      sectionFrames: [
        { x: 10, y: 0, w: 5, h: 5, title: "MCU" },
        { x: 0, y: 10, w: 5, h: 5, title: null },
        { x: 0, y: 0, w: 5, h: 5, title: "Alimentazione" },
      ],
      sectionTitles: [],
    };
    expect(sectionList(m).map((s) => s.title)).toEqual(["Alimentazione", "MCU", "Sezione 2"]);
  });
});

describe("selection in the URL", () => {
  it("part, pin and net go and come back", () => {
    for (const t of [
      { kind: "node" as const, id: id("U1") },
      { kind: "port" as const, nodeId: id("U1"), selector: ".U1 > .OUT" },
      { kind: "net" as const, net: "SIG" },
    ]) {
      const key = targetKey(idx, t)!;
      expect(resolveKey(idx, key)).toEqual(t);
    }
    expect(targetKey(idx, { kind: "port", nodeId: id("U1"), selector: ".U1 > .OUT" })).toBe("U1.OUT");
  });
  it("a name that is not on the sheet is ignored, markup and odd characters are refused", () => {
    expect(resolveKey(idx, "U999")).toBeNull();
    expect(resolveKey(idx, "U1.NOPE")).toBeNull();
    expect(cleanSel("<img src=x onerror=alert(1)>")).toBeNull();
    expect(cleanSel("U1\"><script>")).toBeNull();
    expect(cleanSel("a".repeat(200))).toBeNull();
    expect(cleanSel(["U1"])).toBeNull();
    expect(cleanSel(" U1 ")).toBe("U1");
    expect(resolveKey(idx, "javascript:alert")).toBeNull();
  });
  it("the board view gets the part of a key, never a net", () => {
    const names = new Set(["U1", "R1"]);
    expect(componentOfKey("U1", names)).toBe("U1");
    expect(componentOfKey("U1.OUT", names)).toBe("U1");
    expect(componentOfKey("SIG", names)).toBeNull();
    expect(componentOfKey(null, names)).toBeNull();
  });
});

describe("drawing the highlight", () => {
  const sheet = sheetFrame(model);
  const size = { w: 800, h: 500 };
  const view = fitView(sheet, size);
  const draw = (target: Parameters<typeof highlightFor>[2]) =>
    renderToStaticMarkup(
      createElement(SchematicSheet, { model, sheet, view, size, projectId: "t", highlight: highlightFor(model, idx, target) }),
    );

  it("the selected net is drawn in the highlight color and the rest fades", () => {
    const svg = draw({ kind: "net", net: "SIG" });
    expect(svg).toContain(`stroke="${HIGHLIGHT_COLOR}"`);
    expect(svg).toContain(`opacity="${HIGHLIGHT_FADE}"`);
  });
  it("without a selection nothing fades", () => {
    const svg = draw(null);
    expect(svg).not.toContain(HIGHLIGHT_COLOR);
    expect(svg).not.toContain(`opacity="${HIGHLIGHT_FADE}"`);
  });
});

describe("the panels keep text as text", () => {
  const evil = '<img src=x onerror="alert(1)">';
  it("the search box escapes the query", () => {
    const html = renderToStaticMarkup(
      createElement(SearchBox, {
        query: evil,
        onQuery: () => {},
        results: [],
        cursor: -1,
        onGo: () => {},
        onStep: () => {},
        onClose: () => {},
        maxQuery: MAX_QUERY,
        limit: 50,
      }),
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
  it("the selection card escapes names from the circuit", () => {
    const html = renderToStaticMarkup(
      createElement(SelectionCard, {
        info: { kind: "pezzo", title: evil, lines: [evil], nets: [{ name: evil, pins: 2, rail: false }], net: null, parts: [evil] },
        onNet: () => {},
        onPart: () => {},
        onFrame: () => {},
        onClear: () => {},
        onCopyLink: () => {},
        copied: false,
      }),
    );
    expect(html).not.toContain("<img");
  });
});

/*
 * The real board, when its Circuit JSON is on this machine (it is not in the
 * repository): the checks a person would do by eye on the HTL-401.
 */
const HTL = "/tmp/ht_prova/giri/s_circuit.json";
describe.skipIf(!existsSync(HTL))("HTL-401", () => {
  // read in beforeAll, not in the describe body: a skipped describe still runs
  // its body to collect the tests, and on CI the file is not there
  let big: unknown[] = [];
  let m: SchematicModel = model;
  let ix = idx;
  beforeAll(() => {
    big = JSON.parse(readFileSync(HTL, "utf8")) as unknown[];
    m = buildSchematicModel(big);
    ix = buildIndex(m, big);
  });

  it("VREF lights all its pins, U3 included", () => {
    const h = highlightFor(m, ix, resolveKey(ix, "VREF"))!;
    expect(h.ports.size).toBe(ix.portsByNet.get("VREF")!.length);
    expect(h.ports.has(".U3 > .REFP")).toBe(true);
  });
  it("U3 lights VREF and its signals, GND and P3V3 only next to it", () => {
    const h = highlightFor(m, ix, resolveKey(ix, "U3"))!;
    expect(h.nets.has("VREF")).toBe(true);
    expect(h.nets.has("ADS1_DOUT")).toBe(true);
    expect(h.nets.has("GND")).toBe(false);
    expect(h.nets.has("P3V3")).toBe(false);
    expect(h.keys.size).toBeGreaterThan(0);
  });
  it("pin numbers come from the Circuit JSON", () => {
    const u3 = m.nodes.find((n) => n.name === "U3")!;
    const info = describeTarget(m, ix, { kind: "port", nodeId: u3.id, selector: ".U3 > .REFP" })!;
    expect(info.title).toMatch(/^U3 · piedino \d+$/);
  });
  it("search and hit test stay fast on 183 parts", () => {
    const t0 = performance.now();
    for (let i = 0; i < 50; i++) hitTest(m, ix, { x: i - 25, y: 30 }, 10);
    searchSchematic(m, ix, "c");
    expect(performance.now() - t0).toBeLessThan(500);
    expect(searchSchematic(m, ix, "U3")[0].label).toBe("U3");
  });
});
