import { describe, expect, it } from "vitest";
import { prcTotal, runPrcChecks } from "@/lib/prc";
import { analyzePlacement } from "@/lib/placement-quality";
import { conContorniDichiarati, contorniDichiarati } from "@/lib/pours-recompute";
import { compileGeometryOnly, danglingTraces, summarizeCircuit } from "@/lib/compile";
import { DESIGN_RULES_PATH } from "@/lib/design-rules";

/*
 * The false alarms found on the sonda del suolo V1.3 (01/11/2026): a board
 * with no real defect that PCB Studio could never show as green.
 */

type El = { type: string; [key: string]: unknown };

/** a P3V3 supply: one net, one connectivity group, one source trace per pcb trace */
function supply(): El[] {
  return [
    { type: "source_net", source_net_id: "n_p3v3", name: "P3V3" },
    { type: "source_trace", source_trace_id: "st", subcircuit_connectivity_map_key: "k_p3v3", connected_source_net_ids: ["n_p3v3"], connected_source_port_ids: [] },
  ];
}
const trace = (id: string, points: Array<[number, number]>, width: number): El => ({
  type: "pcb_trace",
  pcb_trace_id: id,
  source_trace_id: "st",
  route: points.map(([x, y]) => ({ route_type: "wire", x, y, width, layer: "top" })),
});
/** a QFN pin: 0.25 wide, 0.8 long, centred on x,y, long along y */
const pin = (id: string, x: number, y: number, w = 0.25): El => ({
  type: "pcb_smtpad", shape: "rect", pcb_smtpad_id: id, x, y, width: w, height: 0.8, layer: "top",
});

describe("power_trace_width: a neck into a fine-pitch pin is not a thin supply", () => {
  it("accepts 0.25mm from a 0.25mm pin for 0.35mm past its edge, then 0.4mm", () => {
    const c = [...supply(), pin("p1", 0, 0), trace("neck", [[0, 0], [0, -0.75]], 0.25), trace("body", [[0, -0.75], [0, -3]], 0.4)];
    expect(runPrcChecks(c).filter((v) => v.rule === "power_trace_width")).toEqual([]);
  });

  it("still flags a narrow supply that starts on a pad wide enough for 0.4mm", () => {
    const c = [...supply(), pin("p1", 0, 0, 0.6), trace("thin", [[0, 0], [0, -0.75]], 0.25)];
    expect(runPrcChecks(c).map((v) => v.rule)).toContain("power_trace_width");
  });

  it("still flags a neck that runs on for more than 0.6mm past the pin", () => {
    const c = [...supply(), pin("p1", 0, 0), trace("long", [[0, 0], [0, -2]], 0.25)];
    expect(runPrcChecks(c).map((v) => v.rule)).toContain("power_trace_width");
  });

  it("still flags a neck wider than the pin it enters", () => {
    const c = [...supply(), pin("p1", 0, 0, 0.25), trace("wide", [[0, 0], [0, -0.75]], 0.3)];
    expect(runPrcChecks(c).map((v) => v.rule)).toContain("power_trace_width");
  });
});

describe("prc: the list is capped, the count is not", () => {
  it("lists 15 narrow supplies out of 20 and says there are 20", () => {
    const c = [...supply()];
    for (let i = 0; i < 20; i++) c.push(trace(`t${i}`, [[i * 2, 5], [i * 2, 8]], 0.2));
    const v = runPrcChecks(c).filter((x) => x.rule === "power_trace_width");
    expect(v.length).toBe(15);
    expect(prcTotal(v)).toBe(20);
    expect(v.some((x) => /5 more/.test(x.message))).toBe(true);
  });
});

describe("placement: copper of the same net may touch", () => {
  const part = (name: string, x: number, net: string): El[] => [
    { type: "source_component", source_component_id: `s_${name}`, name },
    { type: "pcb_component", pcb_component_id: `c_${name}`, source_component_id: `s_${name}`, center: { x, y: 0 }, layer: "top" },
    { type: "source_port", source_port_id: `sp_${name}`, source_component_id: `s_${name}`, subcircuit_connectivity_map_key: net },
    { type: "pcb_port", pcb_port_id: `pp_${name}`, pcb_component_id: `c_${name}`, source_port_id: `sp_${name}`, x, y: 0 },
    { type: "pcb_smtpad", shape: "rect", pcb_component_id: `c_${name}`, pcb_port_id: `pp_${name}`, layer: "top", x, y: 0, width: 0.5, height: 0.5 },
  ];
  const board: El = { type: "pcb_board", center: { x: 0, y: 0 }, width: 20, height: 20 };

  it("a capacitor 0.06mm from the pin it feeds is not a failure", () => {
    const q = analyzePlacement([board, ...part("C1", 0, "vdd"), ...part("U1", 0.56, "vdd")]);
    expect(q.fails).toBe(0);
    expect(q.routable).toBe(true);
  });

  it("two nets 0.06mm apart still are", () => {
    const q = analyzePlacement([board, ...part("C1", 0, "vdd"), ...part("U1", 0.56, "gnd")]);
    expect(q.fails).toBeGreaterThan(0);
    expect(q.routable).toBe(false);
  });
});

describe("pours: the re-pour starts from the outline the file declares", () => {
  const main = `<board>
    <copperpour layer="top" connectsTo="net.GND" outline={[{x:-5,y:-3},{x:5,y:-3},{x:5,y:3},{x:-5,y:3}]} />
    <copperpour layer="inner1" connectsTo="net.GND" />
    <copperpour layer="bottom" connectsTo="net.GND" outline={contorno} />
  </board>`;

  it("reads only the outlines written as a list of points", () => {
    expect(contorniDichiarati(main)).toEqual([
      { layer: "top", net: "GND", outline: [{ x: -5, y: -3 }, { x: 5, y: -3 }, { x: 5, y: 3 }, { x: -5, y: 3 }] },
    ]);
  });

  it("replaces the pieces tscircuit shrank inside it, and leaves the other pours alone", () => {
    const ring = (x0: number, y0: number, x1: number, y1: number) => ({
      outer_ring: { vertices: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }] },
      inner_rings: [],
    });
    const c: El[] = [
      { type: "source_net", source_net_id: "n_gnd", name: "GND" },
      { type: "pcb_copper_pour", pcb_copper_pour_id: "a", layer: "top", source_net_id: "n_gnd", shape: "brep", brep_shape: ring(-4.8, -2.8, -1, 2.8) },
      { type: "pcb_copper_pour", pcb_copper_pour_id: "b", layer: "top", source_net_id: "n_gnd", shape: "brep", brep_shape: ring(1, -2.8, 4.8, 2.8) },
      { type: "pcb_copper_pour", pcb_copper_pour_id: "plane", layer: "inner1", source_net_id: "n_gnd", shape: "brep", brep_shape: ring(-9, -9, 9, 9) },
    ];
    const out = conContorniDichiarati(c, main);
    const pours = out.filter((e) => e.type === "pcb_copper_pour");
    expect(pours.map((p) => p.pcb_copper_pour_id).sort()).toEqual(["pcb_copper_pour_dichiarata_0", "plane"]);
    const nuova = pours.find((p) => p.layer === "top") as El & { brep_shape: { outer_ring: { vertices: unknown[] } } };
    expect(nuova.brep_shape.outer_ring.vertices).toEqual(contorniDichiarati(main)[0].outline);
  });
});

describe("dangling traces: a hand-drawn trace may end on a via or on another trace", () => {
  const t = (id: string, pts: Array<[number, number]>, extra: Array<Record<string, unknown>> = []) => ({
    type: "pcb_trace",
    pcb_trace_id: id,
    route: [...pts.map(([x, y]) => ({ route_type: "wire", x, y, width: 0.2, layer: "top" })), ...extra],
  });
  const pad = { type: "pcb_smtpad", shape: "rect", x: 0, y: 0, width: 0.5, height: 0.5, layer: "top" };

  it("counts only the trace that ends in the air", () => {
    const c = [
      pad,
      { type: "pcb_via", x: 3, y: 0 },
      { ...pad, x: 1.5, y: 2 },
      t("to_via", [[0, 0], [3, 0]]),
      t("t_junction", [[1.5, 2], [1.5, 0]]),
      t("in_the_air", [[0, 0], [0, 4]]),
    ];
    expect(danglingTraces(c as never)).toBe(1);
  });
});

describe("a board that names no autorouter", () => {
  const MAIN = `export default () => (
    <board width="20mm" height="10mm">
      <resistor name="R1" resistance="1k" footprint="0402" pcbX={-4} pcbY={0} />
      <resistor name="R2" resistance="1k" footprint="0402" pcbX={4} pcbY={0} />
      <trace from=".R1 > .pin2" to=".R2 > .pin1" />
    </board>
  )`;

  it("is not routed by tscircuit's own router in the geometry-only compile", async () => {
    const c = (await compileGeometryOnly({ "main.tsx": MAIN })) as El[];
    expect(c.some((e) => e.type === "pcb_trace")).toBe(false);
    expect(c.some((e) => e.type === "pcb_autorouting_error")).toBe(false);
  }, 120_000);

  it("satisfies the fab class of its own rules when the DRC is clean", async () => {
    const c = await compileGeometryOnly({ "main.tsx": MAIN });
    const regole = JSON.stringify({ preset: "custom", rules: { minTraceWidthMm: 0.15, minClearanceMm: 0.15, minViaHoleMm: 0.15, minViaDiameterMm: 0.5 } });
    const s = summarizeCircuit(c, { "main.tsx": MAIN, [DESIGN_RULES_PATH]: regole });
    expect(s.drcViolations).toEqual([]);
    expect(s.fabClass).toBe("Regole personalizzate");
    expect(s.fabClasses[0]).toMatchObject({ key: "custom", ok: true });
  }, 120_000);
});
