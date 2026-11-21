import { describe, expect, it } from "vitest";
import { runDrcChecks } from "@/lib/drc";
import { runPrcChecks } from "@/lib/prc";

/*
 * The checks born from BIRDY_BAT_BS V1.2 (07/11/2026): copper that is on the board but does nothing (pieces of the
 * ground pour with no via of their own, islands sitting in a hole of the plane), vias too close together, vias in SMD
 * pads, silkscreen on pads and via rings. The same rules isole_rame.py applies to the Gerber files.
 */

type El = { type: string; [key: string]: unknown };

const rett = (x0: number, y0: number, x1: number, y1: number) => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];

const reti: El[] = [
  { type: "source_net", source_net_id: "source_net_0", name: "GND" },
  { type: "source_net", source_net_id: "source_net_1", name: "VCC" },
];

/** a ground pad of component c at x,y on top, its pcb port and source port */
const padGnd = (id: string, x: number, y: number, w = 0.5, h = 0.5): El[] => [
  { type: "source_port", source_port_id: `sp_${id}`, source_component_id: "c" },
  { type: "pcb_port", pcb_port_id: `pp_${id}`, source_port_id: `sp_${id}`, x, y, layers: ["top"] },
  { type: "pcb_smtpad", shape: "rect", pcb_smtpad_id: `pad_${id}`, pcb_port_id: `pp_${id}`, x, y, width: w, height: h, layer: "top", soldermask_margin: 0.05 },
];

const traccia = (ports: string[], net = "source_net_0", key = "gnd"): El => ({
  type: "source_trace",
  source_trace_id: `st_${key}`,
  subcircuit_connectivity_map_key: key,
  connected_source_port_ids: ports,
  connected_source_net_ids: [net],
});

const via = (x: number, y: number, key = "gnd", d = 0.5, h = 0.15): El => ({
  type: "pcb_via",
  pcb_via_id: `via_${x}_${y}`,
  x,
  y,
  outer_diameter: d,
  hole_diameter: h,
  layers: ["top", "bottom"],
  subcircuit_connectivity_map_key: key,
});

const colata = (id: string, esterno: Array<{ x: number; y: number }>, buchi: Array<Array<{ x: number; y: number }>> = [], net = "source_net_0"): El => ({
  type: "pcb_copper_pour",
  pcb_copper_pour_id: id,
  shape: "brep",
  layer: "top",
  source_net_id: net,
  brep_shape: { outer_ring: { vertices: esterno }, inner_rings: buchi.map((v) => ({ vertices: v })) },
});

const scheda: El = { type: "pcb_board", center: { x: 0, y: 0 }, width: 40, height: 40, num_layers: 4 };

describe("pour_unstitched: a piece of the ground pour with no via of its own", () => {
  // the plane on the left has its via; the piece on the right holds a ground pad and nothing else
  const base: El[] = [
    scheda,
    ...reti,
    ...padGnd("a", 12, 0),
    traccia(["sp_a"]),
    colata("piano", rett(-10, -5, 5, 5)),
    via(0, 0),
    colata("pezzo", rett(10, -2, 14, 2)),
  ];

  it("is reported, with the pad that holds it", () => {
    const v = runPrcChecks(base).filter((x) => x.rule === "pour_unstitched");
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain("1 pad");
    expect(v[0].x).toBeCloseTo(12, 5);
  });

  it("is not reported once a ground via stands on it", () => {
    expect(runPrcChecks([...base, via(13, 1)]).some((x) => x.rule === "pour_unstitched")).toBe(false);
  });

  it("is not reported when the pour flows through a pad into a stitched piece", () => {
    // a pad straddling the edge between the plane and a second piece joins them
    const ponte: El[] = [
      scheda,
      ...reti,
      ...padGnd("b", 5, 0, 1, 1),
      traccia(["sp_b"]),
      colata("piano", rett(-10, -5, 5, 5)),
      via(0, 0),
      colata("lembo", rett(5, -1, 8, 1)),
    ];
    expect(runPrcChecks(ponte).some((x) => x.rule === "pour_unstitched")).toBe(false);
  });

  it("leaves alone a scrap too small to take a via", () => {
    const briciola: El[] = [...base.filter((e) => e.pcb_copper_pour_id !== "pezzo"), colata("pezzo", rett(11.8, -0.2, 12.4, 0.2))];
    expect(runPrcChecks(briciola).some((x) => x.rule === "pour_unstitched")).toBe(false);
  });
});

describe("pour_island: an island in a hole of the plane is dead copper", () => {
  it("reports a piece sitting in a hole of the ground plane, which the outer ring used to hide", () => {
    // the plane has a 6 x 6 hole (the chip); a 2 x 2 scrap of ground sits in the middle of it, touching nothing
    const circuito: El[] = [
      scheda,
      ...reti,
      traccia([]),
      colata("piano", rett(-15, -15, 15, 15), [rett(-3, -3, 3, 3)]),
      via(10, 10),
      colata("isola", rett(-1, -1, 1, 1)),
    ];
    const isole = runPrcChecks(circuito).filter((x) => x.rule === "pour_island");
    expect(isole).toHaveLength(1);
  });

  it("does not report the piece that fills the hole and touches its edge", () => {
    const circuito: El[] = [
      scheda,
      ...reti,
      traccia([]),
      colata("piano", rett(-15, -15, 15, 15), [rett(-3, -3, 3, 3)]),
      via(10, 10),
      colata("tappo", rett(-3, -3, 3, 3)),
    ];
    expect(runPrcChecks(circuito).some((x) => x.rule === "pour_island")).toBe(false);
  });
});

describe("via_spacing: vias too close together", () => {
  const base: El[] = [scheda, ...reti, traccia([]), traccia([], "source_net_1", "vcc")];

  it("reports two vias of the same net whose rings overlap", () => {
    const v = runDrcChecks([...base, via(0, 0), via(0.45, 0)]).filter((x) => x.rule === "via_spacing");
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain("sovrapposti");
  });

  it("reports rings of the same net closer than the copper spacing", () => {
    // 0.6 mm rings 0.7 mm apart: 0.1 mm of gap
    const v = runDrcChecks([...base, via(0, 0, "gnd", 0.6, 0.25), via(0.7, 0, "gnd", 0.6, 0.25)]);
    expect(v.some((x) => x.rule === "via_spacing" && x.message.includes("quasi a contatto"))).toBe(true);
  });

  it("is quiet for vias 1 mm apart", () => {
    expect(runDrcChecks([...base, via(0, 0), via(1, 0)]).some((x) => x.rule === "via_spacing")).toBe(false);
  });

  it("reports drills of different nets under the 0.35 mm of the strictest fab, which the project rule allows", () => {
    // 0.3 mm drills 0.6 mm apart: 0.30 mm between the holes, above the 0.25 of the project, below Eurocircuits
    const v = runDrcChecks([...base, via(0, 0, "gnd", 0.5, 0.3), via(0.6, 0, "vcc", 0.5, 0.3)]).filter(
      (x) => x.rule === "via_spacing",
    );
    expect(v.some((x) => x.message.includes("0.35"))).toBe(true);
  });
});

describe("via_in_pad: open vias in SMD pads", () => {
  const base: El[] = [scheda, ...reti, ...padGnd("p", 0, 0, 0.6, 0.6), traccia(["sp_p"])];

  it("reports a via inside an SMD pad", () => {
    const v = runDrcChecks([...base, via(0.1, 0)]).filter((x) => x.rule === "via_in_pad");
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain("dentro");
  });

  it("reports a via at the edge of the pad with less than a mask bridge", () => {
    // pad edge at 0.3, opening at 0.35; hole edge at 0.4 - 0.075 = 0.325: no bridge at all
    expect(runDrcChecks([...base, via(0.4, 0)]).some((x) => x.rule === "via_in_pad")).toBe(true);
  });

  it("is quiet for a via clear of the pad", () => {
    expect(runDrcChecks([...base, via(1, 0)]).some((x) => x.rule === "via_in_pad")).toBe(false);
  });

  it("leaves alone the vias of a thermal pad", () => {
    const termico: El[] = [scheda, ...reti, ...padGnd("t", 0, 0, 2, 2), traccia(["sp_t"]), via(-0.5, -0.5), via(0.5, 0.5)];
    expect(runDrcChecks(termico).some((x) => x.rule === "via_in_pad")).toBe(false);
  });
});

describe("silk_over_copper: silkscreen on pads and via rings", () => {
  const seta = (punti: Array<{ x: number; y: number }>): El => ({
    type: "pcb_silkscreen_path",
    pcb_silkscreen_path_id: `seta_${punti[0].x}`,
    layer: "top",
    route: punti,
    stroke_width: 0.15,
  });
  const base: El[] = [scheda, ...reti, ...padGnd("s", 0, 0, 0.6, 0.6), traccia(["sp_s"]), via(3, 0)];

  it("reports silkscreen across a pad", () => {
    const v = runDrcChecks([...base, seta([{ x: -1, y: 0.2 }, { x: 1, y: 0.2 }])]).filter((x) => x.rule === "silk_over_copper");
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain("piazzola");
  });

  it("reports silkscreen across the ring of a via", () => {
    const v = runDrcChecks([...base, seta([{ x: 3, y: -1 }, { x: 3, y: 1 }])]).filter((x) => x.rule === "silk_over_copper");
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain("via");
  });

  it("is quiet for silkscreen clear of both", () => {
    expect(runDrcChecks([...base, seta([{ x: -1, y: 1.5 }, { x: 4, y: 1.5 }])]).some((x) => x.rule === "silk_over_copper")).toBe(false);
  });
});

describe("screw_head_keepout: nothing under the head of a mounting screw", () => {
  // a 2.4 mm hole not plated at the origin: the head of the screw covers a circle of 2.5 mm
  const foro: El = { type: "pcb_hole", pcb_hole_id: "h", hole_shape: "circle", hole_diameter: 2.4, x: 0, y: 0 };
  const cerchio = (r: number, n = 48) => Array.from({ length: n }, (_, k) => ({ x: r * Math.cos((2 * Math.PI * k) / n), y: r * Math.sin((2 * Math.PI * k) / n) }));
  const keepout = (els: El[]) => runDrcChecks([scheda, ...reti, foro, ...els]).filter((x) => x.rule === "screw_head_keepout");

  it("reports the ground pour that comes to 0.25 mm from the drill, as on BIRDY_BAT_BS V1.2", () => {
    const v = keepout([colata("piano", rett(-10, -10, 10, 10), [cerchio(1.45)])]);
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain("colata top");
  });

  it("is quiet when the pour goes round the head with its margin", () => {
    expect(keepout([colata("piano", rett(-10, -10, 10, 10), [cerchio(2.6)])])).toHaveLength(0);
  });

  it("reports a ground via under the head and silkscreen on it", () => {
    const seta: El = { type: "pcb_silkscreen_path", layer: "top", stroke_width: 0.15, route: [{ x: -1, y: 2 }, { x: 1, y: 2 }] };
    const v = keepout([via(1.99, 0), seta]);
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain("via (1.990, 0.000)");
    expect(v[0].message).toContain("serigrafia");
  });

  it("on a plated ground hole accepts ground copper and ground vias, and reports a trace of another net", () => {
    const piazzola: El[] = [
      { type: "source_port", source_port_id: "sp_h2", source_component_id: "h2" },
      { type: "pcb_port", pcb_port_id: "pp_h2", source_port_id: "sp_h2", x: 0, y: 0, layers: ["top", "bottom"] },
      { type: "pcb_plated_hole", pcb_plated_hole_id: "ph", pcb_port_id: "pp_h2", shape: "circle", hole_diameter: 2.2, outer_diameter: 2.8, x: 0, y: 0, layers: ["top", "bottom"] },
      traccia(["sp_h2"]),
    ];
    const base: El[] = [scheda, ...reti, ...piazzola, colata("piano", rett(-10, -10, 10, 10), [cerchio(1.45)]), via(2.1, 0)];
    expect(runDrcChecks(base).filter((x) => x.rule === "screw_head_keepout")).toHaveLength(0);
    const pista: El = {
      type: "pcb_trace", pcb_trace_id: "t_vcc", source_trace_id: "st_vcc", width: 0.2,
      route: [{ x: -3, y: 2, layer: "top", route_type: "wire" }, { x: 3, y: 2, layer: "top", route_type: "wire" }],
    };
    const vcc: El = { ...traccia([], "source_net_1", "vcc") };
    const v = runDrcChecks([...base, vcc, pista]).filter((x) => x.rule === "screw_head_keepout");
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain("pista (top)");
  });
});
