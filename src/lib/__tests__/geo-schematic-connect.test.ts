import { describe, expect, it } from "vitest";
import {
  addConnection,
  checkSelectorOnBoard,
  hasConnection,
  isValidSelector,
  parseDeclaredTrace,
  removeConnection,
} from "@/lib/schematic-connect";
import { analyzeFootprints } from "@/lib/footprint-provenance";

const MAIN = `export default () => (
  <board width="20mm" height="20mm">
    <chip name="U1" footprint="soic8" pinLabels={{ pin1: "~RST", pin2: "/CS" }} />
    <resistor name="R1" resistance="10k" footprint="0402" />
    {/* it's the pull-up: don't remove */}
    <trace to='.U1 > .~RST' from='.R1 > .pin1' />
    <trace
      from={".R1 > .pin2"}
      to={"net.VCC"}
      schDisplayLabel="VCC"
    />
  </board>
)
`;

describe("schematic connections", () => {
  it("accepts the pin names datasheets use", () => {
    expect(isValidSelector(".U1 > .~RST")).toBe(true);
    expect(isValidSelector(".U1 > ./CS")).toBe(true);
    expect(isValidSelector(".J-USB > .D+")).toBe(true);
    expect(isValidSelector("net.3V3")).toBe(true);
    expect(isValidSelector(".U1 > .a b")).toBe(false);
    expect(isValidSelector('.U1 > ."x"')).toBe(false);
  });

  it("finds traces written by the agent in any order and quoting", () => {
    expect(hasConnection(MAIN, ".U1 > .~RST", ".R1 > .pin1")).toBe(true);
    expect(hasConnection(MAIN, "net.VCC", ".R1 > .pin2")).toBe(true);
    expect(addConnection(MAIN, ".R1 > .pin1", ".U1 > .~RST").ok).toBe(false);
  });

  it("removes a multi-line trace and its line, leaving the rest untouched", () => {
    const r = removeConnection(MAIN, "net.VCC", ".R1 > .pin2");
    expect(r.ok).toBe(true);
    expect(r.main).not.toContain("schDisplayLabel");
    expect(r.main).toContain(`<trace to='.U1 > .~RST' from='.R1 > .pin1' />`);
    expect(r.main).toContain("{/* it's the pull-up: don't remove */}");
    expect(r.main.split("\n").filter((l) => l.trim() === "")).toHaveLength(1);
  });

  it("adds before the board's real closing tag", () => {
    const src = `// note: </board> in a comment\nexport default () => (\n  <board>\n    <chip name="U1" />\n  </board>\n)\n`;
    const r = addConnection(src, ".U1 > .pin1", "net.GND");
    expect(r.ok).toBe(true);
    expect(r.main).toContain(`    <trace from=".U1 > .pin1" to="net.GND" />\n  </board>`);
    expect(r.main.startsWith("// note: </board> in a comment")).toBe(true);
  });

  it("checks pins against the compiled board when there is one", () => {
    const cj = [
      { type: "source_component", source_component_id: "s1", name: "U1" },
      { type: "source_port", source_port_id: "p1", source_component_id: "s1", name: "pin1", port_hints: ["~RST", "pin1"] },
    ];
    expect(checkSelectorOnBoard(".U1 > .~RST", cj)).toBeNull();
    expect(checkSelectorOnBoard(".U1 > .pin9", cj)).toMatch(/pin9/);
    // a part the board does not know yet cannot be judged
    expect(checkSelectorOnBoard(".U7 > .pin1", cj)).toBeNull();
    expect(addConnection(MAIN, ".U1 > .pin9", "net.GND", cj).ok).toBe(false);
  });

  it("splits the compiler's name of a connection", () => {
    expect(parseDeclaredTrace(".J1 > .VBAT to .D1 > .cathode")).toEqual({ from: ".J1 > .VBAT", to: ".D1 > .cathode" });
  });
});

describe("analyzeFootprints sources", () => {
  it("reads footprints whatever the quoting, past a > inside a prop", () => {
    const sources = {
      "main.tsx": `<board>
  <trace from=".U1 > .VCC" to="net.VCC" />
  <chip name="U1" pinLabels={{ pin1: "A>B" }} footprint={"soic8"} supplierPartNumbers={{ jlcpcb: ['C12345'] }} />
  <chip name='U2' footprint='qfn16' />
  <chip footprint={<footprint name="CAP 0402_1005"><smtpad portHints={["1"]} /></footprint>} name="C9" />
</board>`,
    };
    const cj = [
      { type: "source_component", name: "U1", ftype: "simple_chip" },
      { type: "source_component", name: "U2", ftype: "simple_chip" },
      { type: "source_component", name: "C9", ftype: "simple_chip" },
    ];
    const r = analyzeFootprints(cj as never, sources);
    const by = new Map(r.records.map((x) => [x.component, x]));
    expect(by.get("U1")).toMatchObject({ footprint: "soic8", lcsc: "C12345", origin: "generic" });
    expect(by.get("U2")).toMatchObject({ footprint: "qfn16" });
    expect(by.get("C9")).toMatchObject({ footprint: "CAP 0402_1005", origin: "explicit" });
    expect(r.issues.find((i) => i.component === "U1")?.rule).toBe("lcsc_ignored");
  });
});
