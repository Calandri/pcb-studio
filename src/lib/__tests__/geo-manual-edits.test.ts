import { describe, expect, it } from "vitest";
import {
  applyEditEvents,
  boardFreshness,
  emptyManualEdits,
  findOrphanEdits,
  injectManualEdits,
  mergeAutoPlacements,
  nextBoardBase,
  normalizeRotation,
  parseManualEdits,
  readAttr,
  readNumericProp,
  releaseManualEdits,
  scanJsxTags,
  serializeManualEdits,
  type ManualEdits,
} from "@/lib/manual-edits";

const names = (src: string) =>
  scanJsxTags(src)
    .filter((t) => !t.inAttribute)
    .map((t) => `${t.name}:${readAttr(src.slice(t.attrsStart, t.attrsEnd), "name") ?? ""}`);

describe("scanJsxTags", () => {
  it("is not fooled by an apostrophe in a comment", () => {
    const src = `export default () => (
  <board width="10mm">
    {/* the decoupling: it's close to U1 */}
    // a stray line comment with a quote: don't
    <resistor name="R1" footprint="0402" />
    <capacitor name="C1" footprint="0402" />
  </board>
)`;
    expect(names(src)).toEqual(["board:", "resistor:R1", "capacitor:C1"]);
  });

  it("ignores tags inside strings, templates and comments", () => {
    const src = `const s = "<resistor name='FAKE1' />";
const t = \`<chip name="FAKE2" />\`;
/* <chip name="FAKE3" /> */
// <chip name="FAKE4" />
export default () => <board><chip name="U1" /></board>`;
    expect(names(src)).toEqual(["board:", "chip:U1"]);
  });

  it("does not read comparisons and generics as tags", () => {
    const src = `function f<T>(x: T): T { return x }
const m = new Map<string, number>();
for (let i = 0; i<n; i++) {}
const ok = a < b && c > d;
const g = <T,>(x: T) => x;
export default () => <board><resistor name="R1" /></board>`;
    expect(names(src)).toEqual(["board:", "resistor:R1"]);
  });

  it("keeps a > inside strings and braces inside the tag", () => {
    const src = `<board>
  <trace from=".U1 > .VCC" to="net.VCC" />
  <chip name="U1" pinLabels={{ pin1: "A>B", pin2: '}' }} pcbX={2} />
</board>`;
    const tags = scanJsxTags(src);
    const chip = tags.find((t) => t.name === "chip")!;
    const attrs = src.slice(chip.attrsStart, chip.attrsEnd);
    expect(readAttr(attrs, "name")).toBe("U1");
    expect(readNumericProp(attrs, "pcbX")).toBe(2);
    expect(src.slice(chip.end - 2, chip.end)).toBe("/>");
  });

  it("marks tags nested in another tag's attribute and finds the right name", () => {
    const src = `<board><chip footprint={<footprint name="SOIC8"><smtpad portHints={["1"]} /></footprint>} name="U1" /></board>`;
    // by default the nested ones are not elements of the board
    expect(scanJsxTags(src).map((t) => t.name)).toEqual(["board", "chip"]);
    const tags = scanJsxTags(src, { includeNested: true });
    const chip = tags.find((t) => t.name === "chip")!;
    expect(chip.inAttribute).toBe(false);
    expect(tags.find((t) => t.name === "footprint")!.inAttribute).toBe(true);
    expect(tags.find((t) => t.name === "smtpad")!.inAttribute).toBe(true);
    expect(readAttr(src.slice(chip.attrsStart, chip.attrsEnd), "name")).toBe("U1");
  });

  it("records the closing tag of an element with children", () => {
    const src = `<board width="10mm">\n  <resistor name="R1" />\n</board>`;
    const board = scanJsxTags(src).find((t) => t.name === "board")!;
    expect(src.slice(board.closeStart!, board.closeEnd!)).toBe("</board>");
  });
});

describe("readAttr / readNumericProp", () => {
  it("reads every quoting the agent writes", () => {
    expect(readAttr(`name='R1'`, "name")).toBe("R1");
    expect(readAttr(`name={"R1"}`, "name")).toBe("R1");
    expect(readAttr(`data-name="x" name="R2"`, "name")).toBe("R2");
    expect(readAttr(`pinLabels={{ name: "x" }} name="R3"`, "name")).toBe("R3");
  });

  it("converts units and refuses expressions", () => {
    expect(readNumericProp(`pcbX="1cm"`, "pcbX")).toBe(10);
    expect(readNumericProp(`pcbX="0.5in"`, "pcbX")).toBeCloseTo(12.7, 9);
    expect(readNumericProp(`pcbX="20mil"`, "pcbX")).toBeCloseTo(0.508, 9);
    expect(readNumericProp(`pcbX={-4}`, "pcbX")).toBe(-4);
    expect(readNumericProp(`pcbX={"2mm"}`, "pcbX")).toBe(2);
    expect(readNumericProp(`pcbX={base + 2}`, "pcbX")).toBeNull();
  });
});

describe("injectManualEdits", () => {
  it("writes into the component, never into a footprint nested in its props", () => {
    const main = `<board><chip name="U1" footprint={<footprint name="U1" />} pcbX={0} /></board>`;
    const edits: ManualEdits = {
      ...emptyManualEdits(),
      pcb_placements: [{ selector: "U1", center: { x: 3, y: 4 } }],
    };
    const out = injectManualEdits(main, edits);
    expect(out).toContain(`<footprint name="U1" />`);
    expect(out).toContain("pcbX={3}");
    expect(out).toContain("pcbY={4}");
    // still parses into the same tags
    expect(names(out)).toEqual(["board:", "chip:U1"]);
  });
});

describe("parseManualEdits", () => {
  it("normalizes rotations", () => {
    const e = parseManualEdits(
      JSON.stringify({ pcb_placements: [{ selector: "R1", center: { x: 0, y: 0 }, rotation: -90 }] }),
    );
    expect(e.pcb_placements[0].rotation).toBe(270);
    expect(normalizeRotation(450)).toBe(90);
    expect(normalizeRotation(359.9999999999)).toBe(0);
    expect(normalizeRotation(Number.NaN)).toBeNull();
  });

  it("serializes in a stable order", () => {
    const a = serializeManualEdits(parseManualEdits(JSON.stringify({ pcb_routes: [], pcb_placements: [] })));
    const b = serializeManualEdits(parseManualEdits(JSON.stringify({ pcb_placements: [], pcb_routes: [] })));
    expect(a).toBe(b);
  });
});

/** a part with no position of its own inside <group pcbX={10} pcbY={5}> */
function groupedBoard(): unknown[] {
  return [
    { type: "source_component", source_component_id: "sc1", name: "R1" },
    { type: "pcb_group", pcb_group_id: "g1", anchor_position: { x: 10, y: 5 }, display_offset_x: 10, display_offset_y: 5 },
    { type: "pcb_component", pcb_component_id: "pc1", source_component_id: "sc1", center: { x: 10, y: 5 }, pcb_group_id: "g1", rotation: 0 },
  ];
}

describe("applyEditEvents", () => {
  const move = (dx: number, extra: Record<string, unknown> = {}) => ({
    edit_event_type: "edit_pcb_component_location",
    pcb_component_id: "pc1",
    original_center: { x: 10, y: 5 },
    new_center: { x: 10 + dx, y: 5 },
    ...extra,
  });

  it("writes a grouped part relative to its group, not in board coordinates", () => {
    const out = applyEditEvents({ circuitJson: groupedBoard(), main: "", edits: emptyManualEdits(), events: [move(2)] });
    expect(out.pcb_placements).toEqual([{ selector: "R1", center: { x: 2, y: 0 } }]);
  });

  it("skips null entries, non-finite coordinates and rotations", () => {
    const out = applyEditEvents({
      circuitJson: groupedBoard(),
      main: "",
      edits: emptyManualEdits(),
      events: [
        null as never,
        move(Number.NaN),
        move(1, { new_rotation: Number.POSITIVE_INFINITY }),
        { ...move(0), new_center: { x: 1e9, y: 0 } },
      ],
    });
    expect(out.pcb_placements).toEqual([]);
  });

  it("normalizes the rotation of a valid event", () => {
    const out = applyEditEvents({ circuitJson: groupedBoard(), main: "", edits: emptyManualEdits(), events: [move(1, { new_rotation: -90 })] });
    expect(out.pcb_placements[0].rotation).toBe(270);
  });
});

describe("releaseManualEdits", () => {
  it("releases the routes that start or end on the part", () => {
    const edits: ManualEdits = {
      ...emptyManualEdits(),
      pcb_routes: [
        { connection: ".U1 > .GND to net.GND", from: ".C1 > .pin2", to: ".U1 > .GND", width: 0.2, points: [] },
        { connection: ".U2 > .GND to net.GND", width: 0.2, points: [] },
      ],
    };
    expect(releaseManualEdits(edits, "traces", "C1").pcb_routes).toHaveLength(1);
  });
});

describe("findOrphanEdits", () => {
  it("lists the edits that point at nothing", () => {
    const cj = [
      { type: "source_component", source_component_id: "sc1", name: "R1" },
      { type: "pcb_component", pcb_component_id: "pc1", source_component_id: "sc1" },
      { type: "source_port", source_port_id: "sp1", source_component_id: "sc1", name: "pin1" },
      { type: "source_trace", source_trace_id: "st1", display_name: ".R1 > .pin1 to net.GND" },
      { type: "source_net", source_net_id: "n1", name: "GND" },
    ];
    const edits: ManualEdits = {
      ...emptyManualEdits(),
      pcb_placements: [
        { selector: "R1", center: { x: 0, y: 0 } },
        { selector: "R10", center: { x: 0, y: 0 } },
      ],
      manual_trace_hints: [{ pcb_port_selector: ".R7 > .pin1", offsets: [{ x: 0, y: 0 }] }],
      pcb_routes: [
        { connection: ".R1 > .pin1 to net.GND", width: 0.2, points: [] },
        { connection: ".R1 > .pin1 to net.GND", from: ".R1 > .pin1", to: ".R2 > .pin1", width: 0.2, points: [] },
        { connection: "net.VBUS", net: "VBUS", width: 0.2, points: [] },
      ],
    };
    const o = findOrphanEdits(cj, edits);
    expect(o.pcb_placements).toEqual(["R10"]);
    expect(o.manual_trace_hints).toEqual([".R7 > .pin1"]);
    expect(o.pcb_routes).toHaveLength(2);
    expect(o.total).toBe(4);
  });
});

describe("boardFreshness / nextBoardBase", () => {
  it("trusts a cache with only manual edits made on it, not one of other sources", () => {
    const base = nextBoardBase({ cacheFilesHash: "H0", filesHashBefore: "H0", sourcesHash: "S", previous: undefined });
    expect(base).toEqual({ files_hash: "H0", sources_hash: "S" });
    const edits = { ...emptyManualEdits(), board_base: base };
    expect(boardFreshness({ cacheFilesHash: "H0", filesHash: "H1", sourcesHash: "S", edits })).toBe("edits");
    // the agent rewrote main.tsx: the sources hash moved
    expect(boardFreshness({ cacheFilesHash: "H0", filesHash: "H2", sourcesHash: "S2", edits })).toBe(false);
    expect(boardFreshness({ cacheFilesHash: "H1", filesHash: "H1", sourcesHash: "S", edits })).toBe("exact");
    // a second edit before the reroute keeps the base, a stale cache drops it
    expect(nextBoardBase({ cacheFilesHash: "H0", filesHashBefore: "H1", sourcesHash: "S", previous: base })).toEqual(base);
    expect(nextBoardBase({ cacheFilesHash: "H0", filesHashBefore: "H1", sourcesHash: "S2", previous: base })).toBeUndefined();
  });
});

describe("mergeAutoPlacements", () => {
  it("keeps what a person did while the placer was running", () => {
    // the file NOW: R1 pinned by hand meanwhile, a trace drawn meanwhile
    const now = serializeManualEdits({
      ...emptyManualEdits(),
      pcb_placements: [
        { selector: "R1", center: { x: 9, y: 9 } },
        { selector: "C1", center: { x: 1, y: 1 }, auto: true },
      ],
      pcb_routes: [{ connection: "c", width: 0.2, points: [{ x: 0, y: 0, layer: "top" }, { x: 1, y: 0, layer: "top" }] }],
    });
    const out = parseManualEdits(
      mergeAutoPlacements(now, [
        { selector: "R1", center: { x: 0, y: 0 } },
        { selector: "C1", center: { x: 2, y: 2 } },
        { selector: "U1", center: { x: 3, y: 3 }, rotation: 90 },
      ]),
    );
    const by = new Map(out.pcb_placements.map((p) => [p.selector, p]));
    expect(by.get("R1")).toEqual({ selector: "R1", center: { x: 9, y: 9 } });
    expect(by.get("C1")).toEqual({ selector: "C1", center: { x: 2, y: 2 }, auto: true });
    expect(by.get("U1")).toEqual({ selector: "U1", center: { x: 3, y: 3 }, rotation: 90, auto: true });
    expect(out.pcb_routes).toHaveLength(1);
  });
});
