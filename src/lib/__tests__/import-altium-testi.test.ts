import { describe, expect, it } from "vitest";
import { leggiStrati, serigrafiaNativa } from "@/lib/altium-layers";

/*
 * TM_4L, 2026-11-09: i 87 commenti nascosti (COMMENTON=FALSE: "0R 1/16W",
 * "A7672E", "FIDUCIAL") e i designator nascosti finivano in serigrafia, e gli
 * strati meccanici "Top/Bottom Designator" del disegno di montaggio pure: ogni
 * designator due volte (273 testi invece di 95).
 */
type El = Record<string, unknown>;

describe("i testi nascosti e il disegno di montaggio non finiscono in serigrafia", () => {
  const pcb: El = {
    layers: [{ name: "Top Layer", legacyLayerId: 1 }, { name: "Bottom Layer", legacyLayerId: 32 }],
    primitiveLayers: [
      { layerId: 33, name: "Top Overlay" },
      { layerId: 64, name: "Top Designator" },
      { layerId: 65, name: "Bottom Designator" },
    ],
    texts: [
      { text: "R24", layerId: 33, ownerIndex: 0, x: 100, y: 100, height: 30, isDesignator: true, visible: true },
      { text: "0R 1/16W", layerId: 33, ownerIndex: 0, x: 100, y: 150, height: 30, isComment: true, visible: false },
      { text: "R25", layerId: 33, ownerIndex: 1, x: 200, y: 100, height: 30, isDesignator: true, visible: false },
      { text: ".Designator", layerId: 64, ownerIndex: 0, x: 100, y: 100, height: 30, visible: true },
    ],
  };
  it("solo il designator visibile sullo strato Overlay", () => {
    const strati = leggiStrati(pcb);
    expect(strati.get(64)?.genere).toBe("montaggio");
    expect(strati.get(65)?.genere).toBe("montaggio");
    const t = (x: number, y: number) => ({ x: x * 0.0254, y: y * 0.0254 });
    const silk = serigrafiaNativa(pcb, strati, t, (i) => ["R24", "R25"][i], () => "0R 1/16W");
    expect(silk.filter((s) => s.type === "pcb_silkscreen_text").map((s) => (s as { text?: string }).text)).toEqual(["R24"]);
  });
});

