import { describe, expect, it } from "vitest";
import { prcTotal, runPrcChecks } from "@/lib/prc";
import { runDrcChecks } from "@/lib/drc";
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

  it("an end on the bottom under a top pad ends on nothing, a through hole is reached from both faces", () => {
    const sotto = {
      type: "pcb_trace",
      pcb_trace_id: "sotto",
      route: [
        { route_type: "wire", x: 0, y: 0.1, width: 0.2, layer: "bottom" },
        { route_type: "wire", x: 0, y: 4, width: 0.2, layer: "bottom" },
      ],
    };
    const fondo = { ...pad, x: 0, y: 4, layer: "bottom" };
    // the centre of the top pad is 0.1 mm away: by position alone the trace had landed
    expect(danglingTraces([pad, fondo, sotto] as never)).toBe(1);
    const foro = { type: "pcb_plated_hole", shape: "circle", x: 0, y: 0, outer_diameter: 0.6, hole_diameter: 0.3 };
    expect(danglingTraces([foro, fondo, sotto] as never)).toBe(0);
  });
});

describe("power_trace_width: a spliced trace takes its net from a pad on its own layer", () => {
  const c: El[] = [
    { type: "source_net", source_net_id: "n_p3v3", name: "P3V3" },
    { type: "source_trace", source_trace_id: "st", subcircuit_connectivity_map_key: "k_p3v3", connected_source_net_ids: ["n_p3v3"], connected_source_port_ids: ["sp1"] },
    { type: "pcb_port", pcb_port_id: "pp1", source_port_id: "sp1" },
    { ...pin("p1", 0, 0, 0.6), pcb_port_id: "pp1" },
  ];
  // no source trace: the variant engine's splice, whose net is read from the pad it touches
  const giunta = (layer: string): El => ({
    type: "pcb_trace",
    pcb_trace_id: "giunta",
    route: [
      { route_type: "wire", x: 0, y: 0, width: 0.25, layer },
      { route_type: "wire", x: 0, y: -3, width: 0.25, layer },
    ],
  });

  it("is the thin supply on the pad's face, and not P3V3 on the other one", () => {
    expect(runPrcChecks([...c, giunta("top")]).map((v) => v.rule)).toContain("power_trace_width");
    expect(runPrcChecks([...c, giunta("bottom")]).map((v) => v.rule)).not.toContain("power_trace_width");
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

/*
 * The false alarms found on the SBB dongle V1.1 (01/11/2026).
 */
describe("power_trace_width: a short bridge from pad to pad is not a thin supply", () => {
  /** an 0402 pad, 0.64 x 0.6, centred on x,y: too wide to call its entry a neck */
  const pad = (id: string, x: number, y: number): El => ({
    type: "pcb_smtpad", shape: "rect", pcb_smtpad_id: id, x, y, width: 0.64, height: 0.6, layer: "top",
  });
  it("accepts 0.2mm between two pads 0.21mm apart", () => {
    const c = [...supply(), pad("a", 0, 0), pad("b", 0.85, 0), trace("ponte", [[0, 0], [0.85, 0]], 0.2)];
    expect(runPrcChecks(c).filter((v) => v.rule === "power_trace_width")).toEqual([]);
  });
  it("still flags a narrow run of 2mm between two pads", () => {
    const c = [...supply(), pad("a", 0, 0), pad("b", 2.64, 0), trace("lunga", [[0, 0], [2.64, 0]], 0.2)];
    expect(runPrcChecks(c).map((v) => v.rule)).toContain("power_trace_width");
  });
  it("still flags a narrow stretch that ends in the air", () => {
    const c = [...supply(), pad("a", 0, 0), trace("aria", [[0, 0], [0.6, 0]], 0.2)];
    expect(runPrcChecks(c).map((v) => v.rule)).toContain("power_trace_width");
  });
});

describe("drc: a polygonal pad is measured on its outline, not on its straight extent", () => {
  /** the LP5907 X2SON of the SBB dongle: four chamfered corner pins and the thermal pad turned by 45 degrees */
  const poli = (id: string, punti: Array<[number, number]>, dx = 0): El => ({
    type: "pcb_smtpad", shape: "polygon", pcb_smtpad_id: id, layer: "top", points: punti.map(([x, y]) => ({ x: x + dx, y })),
  });
  const x2son = (dxTermico = 0): El[] => [
    poli("p1", [[2.913, 4.825], [3.213, 4.825], [3.213, 5.225], [2.913, 4.925]]),
    poli("p2", [[2.287, 5.175], [2.287, 4.825], [2.587, 4.825], [2.587, 4.925], [2.337, 5.175]]),
    poli("p3", [[2.587, 5.875], [2.287, 5.875], [2.287, 5.525], [2.337, 5.525], [2.587, 5.775]]),
    poli("p4", [[3.213, 5.525], [3.213, 5.875], [2.913, 5.875], [2.913, 5.775], [3.163, 5.525]]),
    poli("termico", [[3.104, 5.35], [2.75, 5.704], [2.397, 5.35], [2.75, 4.997]], dxTermico),
  ];
  const vicinanze = (c: El[]) => runDrcChecks(c as never).filter((v) => v.rule === "vicinanza_pad_senza_rete" || v.rule === "pad_clearance");
  it("finds nothing too close around the X2SON as drawn", () => {
    expect(vicinanze(x2son())).toEqual([]);
  });
  it("still finds the thermal pad when it really comes within 0.15mm of a pin", () => {
    expect(vicinanze(x2son(0.12)).length).toBeGreaterThan(0);
  });
});
