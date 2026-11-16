import { describe, expect, it } from "vitest";
import {
  campiDelleRegole,
  DEFAULT_DESIGN_RULES,
  DESIGN_RULES_PATH,
  resolveDesignRules,
  validaFileDelleRegole,
  VIA_APERTURA_DISTANZA_MM,
  type DesignRules,
} from "@/lib/design-rules";
import { runDrcChecks, type DrcViolation } from "@/lib/drc";

/*
 * "Ho bisogno che mi segnali il problema con un cerchio rosso, altrimenti me lo
 * sogno" (Niccolo', 2026-11-16). On sbb-dl-principale the ground via at
 * (3,96; 7,92) has its ring 0,026 mm from the mask opening of the ball E5 of the
 * PSRAM IC6, and every check was green: the pair rules measure copper against
 * copper, and the copper of the two is 0,076 mm apart, on the same net.
 *
 * The scene: a part U1 whose pads are all on GND (k1), and vias of 0,45 mm
 * (ring radius 0,225) on GND or on SIG (k2). Every distance below is from the
 * edge of the ring to the edge of the opening.
 */
const REGOLA = "pad_opening_clearance";
const R_VIA = 0.225;

type El = Record<string, unknown> & { type: string };

const BASE: El[] = [
  { type: "source_net", source_net_id: "n1", name: "GND", subcircuit_connectivity_map_key: "k1" },
  { type: "source_net", source_net_id: "n2", name: "SIG", subcircuit_connectivity_map_key: "k2" },
  { type: "source_component", source_component_id: "sc1", name: "U1" },
  { type: "pcb_component", pcb_component_id: "pc1", source_component_id: "sc1", center: { x: 0, y: 0 }, layer: "top", rotation: 0, width: 1, height: 1 },
];

/** a pad of U1 on GND, with its port: the shape and the rest of the pad in `forma` */
function piazzola(pin: string, forma: Record<string, unknown>): El[] {
  return [
    { type: "source_port", source_port_id: `sp_${pin}`, name: pin, source_component_id: "sc1", subcircuit_connectivity_map_key: "k1" },
    { type: "pcb_port", pcb_port_id: `pp_${pin}`, source_port_id: `sp_${pin}`, pcb_component_id: "pc1", x: 0, y: 0, layers: [forma.layer ?? "top"] },
    {
      type: "pcb_smtpad",
      pcb_smtpad_id: `pad_${pin}`,
      pcb_component_id: "pc1",
      pcb_port_id: `pp_${pin}`,
      layer: "top",
      is_covered_with_solder_mask: false,
      ...forma,
    },
  ];
}

const via = (id: string, x: number, y: number, rete: "k1" | "k2" = "k2"): El => ({
  type: "pcb_via",
  pcb_via_id: id,
  x,
  y,
  outer_diameter: 2 * R_VIA,
  hole_diameter: 0.15,
  layers: ["top", "inner1", "inner2", "bottom"],
  subcircuit_connectivity_map_key: rete,
});

/** the pads of the scene on GND: the source trace that puts their ports on the net */
function scena(...els: El[][]): El[] {
  const tutti = els.flat();
  const porte = tutti.filter((e) => e.type === "source_port").map((e) => e.source_port_id);
  return [
    ...BASE,
    { type: "source_trace", source_trace_id: "st1", subcircuit_connectivity_map_key: "k1", connected_source_port_ids: porte, connected_source_net_ids: ["n1"] },
    ...tutti,
  ];
}

const controlla = (els: El[], rules: DesignRules = DEFAULT_DESIGN_RULES) => runDrcChecks(els as never, rules);
/** the occurrences of the rule, one per pair (the scenes keep them at three or fewer: no aggregation) */
const aperture = (els: El[], rules?: DesignRules): DrcViolation[] => controlla(els, rules).filter((v) => v.rule === REGOLA);

/** the ball E5 of IC6: a circle of 0,15 with 0,05 of mask, so an opening of radius 0,20 */
const PALLA = piazzola("E5", { shape: "circle", radius: 0.15, soldermask_margin: 0.05, x: 0, y: 0 });

describe("the ring of a via against the mask opening of an SMD pad", () => {
  it("the default is 0,05 mm", () => {
    expect(VIA_APERTURA_DISTANZA_MM).toBe(0.05);
  });

  it("a via of ANOTHER net with its ring 0,026 mm from the opening: an error, with via, part and pin, distance and threshold", () => {
    const x = 0.2 + R_VIA + 0.026;
    const [v, ...resto] = aperture(scena(PALLA, [via("pcb_via_98", x, 0)]));
    expect(resto).toEqual([]);
    expect(v.message).toContain("pcb_via_98");
    expect(v.message).toContain("SIG");
    expect(v.message).toContain("U1.E5");
    expect(v.message).toContain("0.026mm");
    expect(v.message).toContain("min 0.05mm");
    // on the point between the opening and the ring, on the face of the pad
    expect(v.points).toHaveLength(1);
    expect(v.points![0].x).toBeCloseTo(0.2 + 0.013, 6);
    expect(v.points![0].y).toBeCloseTo(0, 9);
    expect(v.points![0].layer).toBe("top");
  });

  it("a via of the SAME net as the pad, just as near: an error too (the copper rules do not see it)", () => {
    const x = 0.2 + R_VIA + 0.026;
    const tutto = controlla(scena(PALLA, [via("v_gnd", x, 0, "k1")]));
    // copper against copper on one net: nothing to say
    expect(tutto.filter((v) => v.rule === "pad_clearance")).toEqual([]);
    const [v] = tutto.filter((t) => t.rule === REGOLA);
    expect(v.message).toContain("v_gnd");
    expect(v.message).toContain("GND");
    expect(v.message).toContain("U1.E5");
    expect(v.message).toContain("0.026mm");
  });

  it("the case of sbb-dl-principale as it stands: via in (3,96; 7,92), ball E5 of IC6 in (4,125; 7,5) on the bottom", () => {
    const e5 = piazzola("E5", { shape: "circle", radius: 0.15, soldermask_margin: 0.05, x: 4.125, y: 7.5, layer: "bottom" });
    const [v] = aperture(scena(e5, [via("pcb_via_98", 3.96, 7.92, "k1")]));
    expect(v.message).toMatch(/0\.026mm/);
    expect(v.points![0].layer).toBe("bottom");
    // the dot is between the two, on the line from the centre of the via to the centre of the ball
    const { x, y } = v.points![0];
    const t = (x - 3.96) / (4.125 - 3.96);
    expect(y).toBeCloseTo(7.92 + t * (7.5 - 7.92), 6);
    // the gap is 0,02625: the dot halfway, 0,013125 out of the opening
    const gap = Math.hypot(4.125 - 3.96, 7.92 - 7.5) - R_VIA - 0.2;
    expect(gap).toBeCloseTo(0.02625, 4);
    expect(Math.hypot(x - 4.125, y - 7.5)).toBeCloseTo(0.2 + gap / 2, 6);
  });

  it("a via whose ring ENTERS the opening: an error, with the distance below zero", () => {
    const x = 0.2 + R_VIA - 0.025;
    const [v] = aperture(scena(PALLA, [via("dentro", x, 0, "k1")]));
    expect(v.message).toContain("-0.025mm");
    expect(v.message).toMatch(/entra nell'apertura/);
  });

  it("a ring that just touches the opening: an error even with a threshold of zero", () => {
    const x = 0.2 + R_VIA;
    const zero = { ...DEFAULT_DESIGN_RULES, minViaToPadOpeningMm: 0 };
    expect(aperture(scena(PALLA, [via("tocca", x, 0, "k1")]), zero)).toHaveLength(1);
    // a hair away, with a threshold of zero: nothing
    expect(aperture(scena(PALLA, [via("staccata", x + 0.01, 0, "k1")]), zero)).toEqual([]);
  });

  it("at the threshold exactly: nothing; two microns nearer: an error", () => {
    const x = 0.2 + R_VIA + 0.05;
    expect(aperture(scena(PALLA, [via("soglia", x, 0, "k1")]))).toEqual([]);
    expect(aperture(scena(PALLA, [via("sotto", x - 0.002, 0, "k1")]))).toHaveLength(1);
  });

  it("a via far enough: nothing", () => {
    expect(aperture(scena(PALLA, [via("lontana", 0.2 + R_VIA + 0.06, 0)]))).toEqual([]);
    expect(aperture(scena(PALLA, [via("lontanissima", 3, 3)]))).toEqual([]);
  });

  it("a via IN the pad, of its net (via-in-pad): it does not count", () => {
    expect(aperture(scena(PALLA, [via("nel_pad", 0.05, 0, "k1")]))).toEqual([]);
  });

  it("a via of another net with its centre in the pad is not a via-in-pad: it is said", () => {
    expect(aperture(scena(PALLA, [via("corto", 0.05, 0, "k2")]))).toHaveLength(1);
  });

  it("a via in a pad still counts against the pad next to it", () => {
    const d5 = piazzola("D5", { shape: "circle", radius: 0.15, soldermask_margin: 0.05, x: 0.05 + R_VIA + 0.2 + 0.03, y: 0 });
    // in E5, its ring 0,03 from the opening of D5
    const [v, ...resto] = aperture(scena(PALLA, d5, [via("nel_pad", 0.05, 0, "k1")]));
    expect(resto).toEqual([]);
    expect(v.message).toContain("U1.D5");
    expect(v.message).toContain("0.030mm");
  });

  it("a pad under the mask has no opening: nothing", () => {
    const coperta = piazzola("E5", { shape: "circle", radius: 0.15, soldermask_margin: 0.05, x: 0, y: 0, is_covered_with_solder_mask: true });
    expect(aperture(scena(coperta, [via("v", 0.2 + R_VIA + 0.01, 0)]))).toEqual([]);
  });

  it("a negative mask margin shrinks the opening (a pad defined by the mask)", () => {
    // 0,15 - 0,07 = an opening of radius 0,08: a via 0,03 from it is an error, 0,08 from it is not
    const stretta = piazzola("E5", { shape: "circle", radius: 0.15, soldermask_margin: -0.07, x: 0, y: 0 });
    expect(aperture(scena(stretta, [via("v", 0.08 + R_VIA + 0.03, 0, "k1")]))).toHaveLength(1);
    expect(aperture(scena(stretta, [via("v", 0.08 + R_VIA + 0.08, 0, "k1")]))).toEqual([]);
  });

  it("no margin written: the opening is the pad", () => {
    const nuda = piazzola("E5", { shape: "circle", radius: 0.15, x: 0, y: 0 });
    expect(aperture(scena(nuda, [via("v", 0.15 + R_VIA + 0.04, 0, "k1")]))).toHaveLength(1);
    expect(aperture(scena(nuda, [via("v", 0.15 + R_VIA + 0.06, 0, "k1")]))).toEqual([]);
  });
});

describe("every shape of pad, measured on its own outline", () => {
  it("rect: grown by the margin on every side, with square corners as the Gerber opens it", () => {
    // 0,6 x 0,4 with 0,05: an opening of 0,7 x 0,5, its corner in (0,35; 0,25)
    const p = piazzola("1", { shape: "rect", width: 0.6, height: 0.4, soldermask_margin: 0.05, x: 0, y: 0 });
    expect(aperture(scena(p, [via("lato", 0.35 + R_VIA + 0.03, 0)]))).toHaveLength(1);
    expect(aperture(scena(p, [via("lato_lontano", 0.35 + R_VIA + 0.07, 0)]))).toEqual([]);
    const k = (R_VIA + 0.03) / Math.SQRT2;
    const [angolo] = aperture(scena(p, [via("angolo", 0.35 + k, 0.25 + k)]));
    expect(angolo.message).toContain("0.030mm");
    expect(angolo.points![0].x).toBeCloseTo(0.35 + 0.015 / Math.SQRT2, 6);
    expect(angolo.points![0].y).toBeCloseTo(0.25 + 0.015 / Math.SQRT2, 6);
  });

  it("rotated_rect: measured in its own frame", () => {
    // 0,6 x 0,4 turned by 45 degrees, no margin: along its long axis the edge is 0,3 from the centre
    const p = piazzola("1", { shape: "rotated_rect", width: 0.6, height: 0.4, ccw_rotation: 45, x: 0, y: 0 });
    const lungo = (d: number) => [(0.3 + R_VIA + d) * Math.SQRT1_2, (0.3 + R_VIA + d) * Math.SQRT1_2] as const;
    const [v] = aperture(scena(p, [via("asse_lungo", ...lungo(0.03))]));
    expect(v.message).toContain("0.030mm");
    expect(aperture(scena(p, [via("asse_lungo", ...lungo(0.07))]))).toEqual([]);
    // along its short axis (at 135 degrees) the edge is 0,2 from the centre
    const corto = (d: number) => [-(0.2 + R_VIA + d) * Math.SQRT1_2, (0.2 + R_VIA + d) * Math.SQRT1_2] as const;
    expect(aperture(scena(p, [via("asse_corto", ...corto(0.03))]))).toHaveLength(1);
    expect(aperture(scena(p, [via("asse_corto", ...corto(0.07))]))).toEqual([]);
  });

  it("pill: a stadium grown by the margin", () => {
    // 0,8 x 0,3 with 0,05: the core from -0,25 to 0,25, radius 0,20
    const p = piazzola("1", { shape: "pill", width: 0.8, height: 0.3, radius: 0.15, soldermask_margin: 0.05, x: 0, y: 0 });
    expect(aperture(scena(p, [via("punta", 0.25 + 0.2 + R_VIA + 0.03, 0)]))).toHaveLength(1);
    expect(aperture(scena(p, [via("fianco", 0, 0.2 + R_VIA + 0.03)]))).toHaveLength(1);
    expect(aperture(scena(p, [via("fianco", 0, 0.2 + R_VIA + 0.07)]))).toEqual([]);
    // diagonal from the end of the core: round, not the corner of a box
    const k = (0.2 + R_VIA + 0.07) / Math.SQRT2;
    expect(aperture(scena(p, [via("tonda", 0.25 + k, k)]))).toEqual([]);
  });

  it("rotated_pill: the stadium turned", () => {
    // 0,8 x 0,3 turned by 90 degrees: the core along y
    const p = piazzola("1", { shape: "rotated_pill", width: 0.8, height: 0.3, radius: 0.15, ccw_rotation: 90, x: 0, y: 0 });
    expect(aperture(scena(p, [via("punta", 0, 0.25 + 0.15 + R_VIA + 0.03)]))).toHaveLength(1);
    expect(aperture(scena(p, [via("fianco", 0.15 + R_VIA + 0.07, 0)]))).toEqual([]);
    expect(aperture(scena(p, [via("fianco", 0.15 + R_VIA + 0.03, 0)]))).toHaveLength(1);
  });

  it("polygon: measured on its outline, not on its box", () => {
    // a diamond of half-diagonal 0,4, no margin
    const p = piazzola("1", {
      shape: "polygon",
      points: [
        { x: 0.4, y: 0 },
        { x: 0, y: 0.4 },
        { x: -0.4, y: 0 },
        { x: 0, y: -0.4 },
      ],
    });
    expect(aperture(scena(p, [via("punta", 0.4 + R_VIA + 0.03, 0)]))).toHaveLength(1);
    // past the corner of its box but far from its sides: x + y = 1, the side is x + y = 0,4
    expect(aperture(scena(p, [via("oltre_la_scatola", 0.5, 0.5)]))).toEqual([]);
    // in front of a side, 0,03 away
    const k = (R_VIA + 0.03) / Math.SQRT2;
    const [v] = aperture(scena(p, [via("lato", 0.2 + k, 0.2 + k)]));
    expect(v.message).toContain("0.030mm");
  });

  it("polygon with a positive margin: the outline grown by it", () => {
    const p = piazzola("1", {
      shape: "polygon",
      soldermask_margin: 0.05,
      points: [
        { x: 0.4, y: 0 },
        { x: 0, y: 0.4 },
        { x: -0.4, y: 0 },
        { x: 0, y: -0.4 },
      ],
    });
    const k = (R_VIA + 0.05 + 0.03) / Math.SQRT2;
    const [v] = aperture(scena(p, [via("lato", 0.2 + k, 0.2 + k)]));
    expect(v.message).toContain("0.030mm");
  });
});

describe("a paste opening larger than the mask's is the opening", () => {
  // a rect 0,6 x 0,4 with no margin: the mask opens the pad, its edge at x = 0,3
  const pad = piazzola("1", { shape: "rect", width: 0.6, height: 0.4, x: 0, y: 0 });

  it("the paste of the pad, 0,1 wider on each end: measured from it, and said", () => {
    const pasta: El = { type: "pcb_solder_paste", pcb_solder_paste_id: "sp_1", pcb_smtpad_id: "pad_1", pcb_component_id: "pc1", layer: "top", shape: "rect", width: 0.8, height: 0.4, x: 0, y: 0 };
    const x = 0.4 + R_VIA + 0.03;
    // against the mask alone it is 0,13 away
    expect(aperture(scena(pad, [via("v", x, 0)]))).toEqual([]);
    const [v] = aperture(scena(pad, [pasta, via("v", x, 0)]));
    expect(v.message).toContain("0.030mm");
    expect(v.message).toMatch(/pasta/);
    expect(v.message).toContain("U1.1");
  });

  it("a paste smaller than the mask opening changes nothing", () => {
    const pasta: El = { type: "pcb_solder_paste", pcb_solder_paste_id: "sp_1", pcb_smtpad_id: "pad_1", pcb_component_id: "pc1", layer: "top", shape: "rect", width: 0.4, height: 0.3, x: 0, y: 0 };
    const [v] = aperture(scena(pad, [pasta], [via("v", 0.3 + R_VIA + 0.03, 0)]));
    expect(v.message).toContain("0.030mm");
    expect(v.message).not.toMatch(/pasta/);
  });

  it("an opening the part draws for itself (stencil.json), on its pad: it counts for that pad", () => {
    const pasta: El = { type: "pcb_solder_paste", pcb_solder_paste_id: "pcb_solder_paste_stencil_U1_0", pcb_component_id: "pc1", layer: "top", shape: "rect", width: 0.3, height: 0.3, x: 0.3, y: 0 };
    const [v] = aperture(scena(pad, [pasta], [via("v", 0.45 + R_VIA + 0.03, 0)]));
    expect(v.message).toContain("0.030mm");
    expect(v.message).toContain("U1.1");
    expect(v.message).toMatch(/pasta/);
  });

  it("an opening of the part that lies on none of its pads: not a pad's opening, not measured", () => {
    const pasta: El = { type: "pcb_solder_paste", pcb_solder_paste_id: "pcb_solder_paste_stencil_U1_1", pcb_component_id: "pc1", layer: "top", shape: "circle", radius: 0.1, x: 5, y: 5 };
    expect(aperture(scena(pad, [pasta], [via("v", 5 + 0.1 + R_VIA + 0.03, 5)]))).toEqual([]);
  });
});

describe("the threshold is a rule of the project (design-rules.json)", () => {
  const regole = (rules: Record<string, unknown>) =>
    resolveDesignRules({ [DESIGN_RULES_PATH]: JSON.stringify({ preset: "custom", rules }) });
  const x = 0.2 + R_VIA + 0.026;

  it("missing: 0,05", () => {
    expect(aperture(scena(PALLA, [via("v", x, 0, "k1")]), regole({}).rules)[0].message).toContain("min 0.05mm");
  });

  it("written: the project's number, both ways", () => {
    expect(aperture(scena(PALLA, [via("v", x, 0, "k1")]), regole({ minViaToPadOpeningMm: 0.02 }).rules)).toEqual([]);
    const [v] = aperture(scena(PALLA, [via("v", x, 0, "k1")]), regole({ minViaToPadOpeningMm: 0.1 }).rules);
    expect(v.message).toContain("min 0.1mm");
  });

  it("out of its limits: brought back and said", () => {
    const r = regole({ minViaToPadOpeningMm: 5 });
    expect(r.rules.minViaToPadOpeningMm).toBe(1);
    expect(r.warnings?.join(" ")).toMatch(/minViaToPadOpeningMm: 5 e' fuori dai limiti 0-1/);
  });

  it("a file a tool writes: accepted within the limits, refused out of them", () => {
    const ok = validaFileDelleRegole(JSON.stringify({ preset: "custom", rules: { minViaToPadOpeningMm: 0.08 } }));
    expect("regole" in ok && ok.regole.rules.minViaToPadOpeningMm).toBe(0.08);
    const no = validaFileDelleRegole(JSON.stringify({ preset: "custom", rules: { minViaToPadOpeningMm: -0.1 } }));
    expect("errori" in no && no.errori.join(" ")).toMatch(/minViaToPadOpeningMm: -0\.1 fuori dai limiti 0\.\.1/);
  });

  it("the tools that write the file are told the field and its limits", () => {
    expect(campiDelleRegole()).toContain("minViaToPadOpeningMm 0..1");
  });

  it("a factory preset: the default", () => {
    const r = resolveDesignRules({ [DESIGN_RULES_PATH]: JSON.stringify({ preset: "jlcpcb_standard" }) });
    expect(aperture(scena(PALLA, [via("v", x, 0, "k1")]), r.rules)[0].message).toContain("min 0.05mm");
  });
});

describe("many of them", () => {
  it("aggregated like every rule, the nearest first, every dot kept", () => {
    const pads = [0, 1, 2, 3].map((i) => piazzola(`P${i}`, { shape: "circle", radius: 0.15, soldermask_margin: 0.05, x: i * 2, y: 0 }));
    // the third is the nearest
    const gap = [0.04, 0.03, 0.01, 0.02];
    const vie = gap.map((g, i) => via(`v${i}`, i * 2 + 0.2 + R_VIA + g, 0));
    const [v, ...resto] = aperture(scena(...pads, vie));
    expect(resto).toEqual([]);
    expect(v.count).toBe(4);
    expect(v.points).toHaveLength(4);
    expect(v.message).toMatch(/^4x pad_opening_clearance: via v2 /);
    expect(v.message).toContain("U1.P2");
  });
});
