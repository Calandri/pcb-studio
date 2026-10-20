import { describe, expect, it } from "vitest";
import { pastaDaiPad } from "@/lib/solder-paste";

type El = Record<string, unknown> & { type: string };

const pad = (over: Record<string, unknown>) => ({ type: "pcb_smtpad", pcb_smtpad_id: "p1", layer: "top", x: 1, y: 2, ...over });
const pasta = (over: Record<string, unknown> = {}) => ({
  type: "pcb_solder_paste", pcb_solder_paste_id: "s1", pcb_smtpad_id: "p1", layer: "top", x: 1, y: 2, ...over,
});

describe("the paste of each pad is the pad", () => {
  it("a rect pad gets an opening as large as itself, not tscircuit's 70%", () => {
    const out = pastaDaiPad([pad({ shape: "rect", width: 0.6, height: 0.5 }), pasta({ shape: "rect", width: 0.42, height: 0.35 })] as El[]);
    expect(out[1]).toMatchObject({ shape: "rect", width: 0.6, height: 0.5, x: 1, y: 2 });
  });
  it("the project expansion grows or shrinks every side", () => {
    const out = pastaDaiPad([pad({ shape: "rect", width: 0.6, height: 0.5 }), pasta({ shape: "rect", width: 0.42, height: 0.35 })] as El[], -0.05);
    expect(Number(out[1].width)).toBeCloseTo(0.5);
    expect(Number(out[1].height)).toBeCloseTo(0.4);
  });
  it("a circle pad keeps its shape and takes the expansion on the radius", () => {
    const out = pastaDaiPad([pad({ shape: "circle", radius: 0.3 }), pasta({ shape: "circle", radius: 0.21 })] as El[], 0.02);
    expect(out[1]).toMatchObject({ shape: "circle" });
    expect(Number(out[1].radius)).toBeCloseTo(0.32);
  });
  it("a rotated pad keeps its rotation", () => {
    const out = pastaDaiPad([pad({ shape: "rotated_rect", width: 1, height: 0.3, ccw_rotation: 45 }), pasta({ shape: "rotated_rect", width: 0.7, height: 0.21, ccw_rotation: 45 })] as El[]);
    expect(out[1]).toMatchObject({ shape: "rotated_rect", width: 1, height: 0.3, ccw_rotation: 45 });
  });
  it("an opening drawn by the footprint itself, tied to no pad, is left alone", () => {
    const libera = { type: "pcb_solder_paste", pcb_solder_paste_id: "s9", layer: "top", shape: "circle", x: 0, y: 0, radius: 0.12 };
    const out = pastaDaiPad([libera] as El[]);
    expect(out[0]).toEqual(libera);
  });
  it("a pad under solder mask prints nothing", () => {
    const out = pastaDaiPad([pad({ shape: "rect", width: 0.6, height: 0.5, is_covered_with_solder_mask: true }), pasta({ shape: "rect", width: 0.42, height: 0.35 })] as El[]);
    expect(out.filter((e) => e.type === "pcb_solder_paste")).toHaveLength(0);
  });
  it("an expansion that eats the pad drops the opening instead of printing a pinhole", () => {
    const out = pastaDaiPad([pad({ shape: "rect", width: 0.1, height: 0.1 }), pasta({ shape: "rect", width: 0.07, height: 0.07 })] as El[], -0.1);
    expect(out.filter((e) => e.type === "pcb_solder_paste")).toHaveLength(0);
  });
  it("everything else passes through untouched and in order", () => {
    const via = { type: "pcb_via", x: 0, y: 0 };
    const out = pastaDaiPad([via, pad({ shape: "rect", width: 1, height: 1 }), pasta({ shape: "rect", width: 0.7, height: 0.7 })] as El[]);
    expect(out[0]).toBe(via);
    expect(out).toHaveLength(3);
  });
});

describe("the rule", () => {
  it("is read from the project and clamped", async () => {
    const { resolveDesignRules } = await import("@/lib/design-rules");
    const r = resolveDesignRules({ "design-rules.json": JSON.stringify({ preset: "custom", rules: { pasteExpansionMm: -0.5 } }) });
    expect(r.rules.pasteExpansionMm).toBe(-0.1);
    expect(r.warnings?.join(" ")).toMatch(/pasteExpansionMm/);
    const nulla = resolveDesignRules({ "design-rules.json": JSON.stringify({ preset: "custom", rules: {} }) });
    expect(nulla.rules.pasteExpansionMm).toBeUndefined();
  });
});

describe("autoPlaneVias", () => {
  it("is kept when the project says false, absent otherwise", async () => {
    const { resolveDesignRules } = await import("@/lib/design-rules");
    const off = resolveDesignRules({ "design-rules.json": JSON.stringify({ preset: "custom", rules: { autoPlaneVias: false } }) });
    expect(off.rules.autoPlaneVias).toBe(false);
    const on = resolveDesignRules({ "design-rules.json": JSON.stringify({ preset: "custom", rules: {} }) });
    expect(on.rules.autoPlaneVias).toBeUndefined();
    const sbagliato = resolveDesignRules({ "design-rules.json": JSON.stringify({ preset: "custom", rules: { autoPlaneVias: "no" } }) });
    expect(sbagliato.rules.autoPlaneVias).toBeUndefined();
  });
});

describe("stencil.json and through-hole pads", () => {
  it("a component with its own stencil loses its pads' paste and gets its openings", () => {
    const cj = [
      { type: "source_component", source_component_id: "s1", name: "MIC1" },
      { type: "pcb_component", pcb_component_id: "c1", source_component_id: "s1", layer: "top", rotation: 90, display_offset_x: 10, display_offset_y: 5 },
      pad({ shape: "rect", width: 0.75, height: 0.45, pcb_component_id: "c1" }),
      pasta({ shape: "rect", width: 0.52, height: 0.31 }),
    ] as El[];
    const out = pastaDaiPad(cj, 0, { stencil: { componenti: { MIC1: { aperture: [
      { forma: "cerchio", x: 1, y: 0, r: 0.15 },
      { forma: "rettangolo", x: 0, y: 1, w: 0.65, h: 0.4 },
    ] } } } });
    const paste = out.filter((e) => e.type === "pcb_solder_paste");
    expect(paste).toHaveLength(2);
    // ruotato di 90: (1,0) va in (0,1), (0,1) va in (-1,0); il rettangolo scambia i lati
    expect(paste[0]).toMatchObject({ shape: "circle", radius: 0.15 });
    expect(Number(paste[0].x)).toBeCloseTo(10);
    expect(Number(paste[0].y)).toBeCloseTo(6);
    expect(paste[1]).toMatchObject({ shape: "rect", width: 0.4, height: 0.65 });
    expect(Number(paste[1].x)).toBeCloseTo(9);
    expect(Number(paste[1].y)).toBeCloseTo(5);
  });
  it("through-hole pads print no paste unless the project asks for pin-in-paste", () => {
    const cj = [
      { type: "pcb_plated_hole", x: 3, y: 4, outer_diameter: 1.4, hole_diameter: 0.9 },
      { type: "pcb_solder_paste", pcb_solder_paste_id: "s7", layer: "top", shape: "circle", x: 3, y: 4, radius: 0.7 },
      { type: "pcb_solder_paste", pcb_solder_paste_id: "s8", layer: "bottom", shape: "circle", x: 3, y: 4, radius: 0.7 },
    ] as El[];
    expect(pastaDaiPad(cj).filter((e) => e.type === "pcb_solder_paste")).toHaveLength(0);
    expect(pastaDaiPad(cj, 0, { pasteOnPlatedHoles: true }).filter((e) => e.type === "pcb_solder_paste")).toHaveLength(2);
  });
  it("a broken stencil entry is reported and skipped", async () => {
    const { leggiStencil } = await import("@/lib/solder-paste");
    const r = leggiStencil({ "stencil.json": JSON.stringify({ componenti: { U1: { aperture: [{ forma: "cerchio", x: 0, y: 0, r: -1 }, { forma: "rettangolo", x: 0, y: 0, w: 0.5, h: 0.5 }] } } }) });
    expect(r.stencil.componenti.U1.aperture).toHaveLength(1);
    expect(r.avvisi.join(" ")).toMatch(/non valida/);
    expect(leggiStencil({ "stencil.json": "{" }).avvisi[0]).toMatch(/JSON/);
  });
  it("an opening lands on its pad on a real board, turned and on the bottom side", async () => {
    const { runTscircuitCode } = await import("@tscircuit/eval");
    const code = `export default () => (<board width="20mm" height="20mm">
      <chip name="A" pcbX={3} pcbY={-2} pcbRotation={30} layer="bottom" footprint={<footprint>
        <smtpad portHints={["1"]} shape="rect" width={0.6} height={0.4} pcbX={1.2} pcbY={0.7} layer="top" />
        <smtpad portHints={["2"]} shape="rect" width={0.6} height={0.4} pcbX={-0.9} pcbY={-0.3} layer="top" />
      </footprint>} />
      <chip name="B" pcbX={-4} pcbY={1} pcbRotation={270} footprint={<footprint>
        <smtpad portHints={["1"]} shape="rect" width={0.6} height={0.4} pcbX={1.1} pcbY={0.5} layer="top" />
        <smtpad portHints={["2"]} shape="rect" width={0.6} height={0.4} pcbX={-0.7} pcbY={-0.6} layer="top" />
      </footprint>} />
    </board>)`;
    const cj = (await runTscircuitCode({ "main.tsx": code }, { mainComponentPath: "main.tsx" })) as El[];
    const stencil = { componenti: {
      A: { aperture: [{ forma: "cerchio" as const, x: 1.2, y: 0.7, r: 0.1 }, { forma: "cerchio" as const, x: -0.9, y: -0.3, r: 0.1 }] },
      B: { aperture: [{ forma: "cerchio" as const, x: 1.1, y: 0.5, r: 0.1 }, { forma: "cerchio" as const, x: -0.7, y: -0.6, r: 0.1 }] },
    } };
    const out = pastaDaiPad(cj, 0, { stencil });
    const pads = cj.filter((e) => e.type === "pcb_smtpad");
    const aperture = out.filter((e) => e.type === "pcb_solder_paste");
    expect(aperture).toHaveLength(4);
    for (const a of aperture) {
      const vicino = Math.min(...pads.map((p) => Math.hypot(Number(p.x) - Number(a.x), Number(p.y) - Number(a.y))));
      expect(vicino).toBeLessThan(1e-6);
      const suo = pads.find((p) => Math.hypot(Number(p.x) - Number(a.x), Number(p.y) - Number(a.y)) < 1e-6)!;
      expect(a.layer).toBe(suo.layer);
    }
  }, 120000);
});
