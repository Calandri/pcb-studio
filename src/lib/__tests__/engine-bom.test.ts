import { describe, expect, it } from "vitest";
import { bomToCsv, csvCell, normalizeRotation, pnpToCsv } from "@/lib/bom";

describe("CSV cells are data, never formulas", () => {
  it("prefixes what a spreadsheet would run", () => {
    expect(csvCell("=HYPERLINK(\"x\")")).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell("+1")).toBe(`"'+1"`);
    expect(csvCell("-5V")).toBe(`"'-5V"`);
    expect(csvCell("@SUM(A1)")).toBe(`"'@SUM(A1)"`);
    expect(csvCell("100nF")).toBe(`"100nF"`);
    expect(csvCell(3)).toBe(`"3"`);
  });

  it("the BOM file carries the escaped cell", () => {
    const csv = bomToCsv([
      {
        designators: "C1",
        quantity: 1,
        value: "=cmd|'/c calc'!A0",
        package: "0402",
        manufacturerPartNumber: "",
        lcsc: "C1525",
        alternatives: "",
        lcscUrl: "",
        jlcpcbUrl: "",
        note: "",
      },
    ]);
    expect(csv.split("\n")[1].startsWith(`"'=cmd`)).toBe(true);
  });
});

describe("pick and place", () => {
  it("brings rotations into [0, 360)", () => {
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(450)).toBe(90);
    expect(normalizeRotation(360)).toBe(0);
    expect(normalizeRotation(359.99999)).toBe(0);
    expect(normalizeRotation(undefined)).toBe(0);
  });

  it("escapes designators but writes coordinates as numbers", () => {
    const csv = pnpToCsv([
      { designator: "=R1", mid_x: -1.5, mid_y: 2, layer: "top", rotation: -90 },
      { designator: "U1", mid_x: 0, mid_y: -3.25, layer: { name: "bottom" }, rotation: 0 },
    ]);
    const [header, r1, u1] = csv.split("\r\n");
    expect(header).toBe("Designator,Mid X,Mid Y,Layer,Rotation");
    expect(r1).toBe(`"'=R1",-1.500,2.000,"top",270`);
    expect(u1).toBe(`"U1",0.000,-3.250,"bottom",0`);
  });
});
