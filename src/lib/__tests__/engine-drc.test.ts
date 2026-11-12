import { describe, expect, it } from "vitest";
import { DEFAULT_DESIGN_RULES } from "@/lib/design-rules";
import { foroDi, rameDelForo, runDrcChecks, type MisureDrc } from "@/lib/drc";

type El = { type: string; [key: string]: unknown };

const board = (extra: Record<string, unknown> = {}): El => ({
  type: "pcb_board",
  center: { x: 0, y: 0 },
  width: 20,
  height: 20,
  num_layers: 2,
  ...extra,
});

/** a net with one source trace joining the given source ports */
const net = (key: string, ports: string[]): El => ({
  type: "source_trace",
  source_trace_id: `st_${key}`,
  subcircuit_connectivity_map_key: key,
  connected_source_port_ids: ports,
  connected_source_net_ids: [],
});

const port = (id: string, x: number, y: number): El => ({
  type: "pcb_port",
  pcb_port_id: `pp_${id}`,
  source_port_id: `sp_${id}`,
  x,
  y,
  layers: ["top"],
});

const pad = (id: string, x: number, y: number, w = 0.2, h = 0.2, extra: Record<string, unknown> = {}): El => ({
  type: "pcb_smtpad",
  shape: "rect",
  pcb_smtpad_id: `pad_${id}`,
  pcb_port_id: `pp_${id}`,
  x,
  y,
  width: w,
  height: h,
  layer: "top",
  ...extra,
});

const rules = (list: ReturnType<typeof runDrcChecks>) => list.map((v) => v.rule);

describe("plated holes are measured by their own shape", () => {
  it("reads the copper of a pill and of a square pad", () => {
    expect(
      rameDelForo({ type: "pcb_plated_hole", shape: "pill", x: 0, y: 0, outer_width: 1, outer_height: 2, hole_width: 0.6, hole_height: 1.6, ccw_rotation: 0 }),
    ).toMatchObject({ tipo: "capsula", capsula: { r: 0.5 } });
    expect(
      rameDelForo({ type: "pcb_plated_hole", shape: "circular_hole_with_rect_pad", x: 0, y: 0, rect_pad_width: 2, rect_pad_height: 1.5, hole_diameter: 0.8 }),
    ).toMatchObject({ tipo: "rettangolo", w: 2, h: 1.5 });
    // the drill of a rect-pad hole follows its offset
    expect(
      foroDi({ type: "pcb_plated_hole", shape: "circular_hole_with_rect_pad", x: 1, y: 1, hole_offset_x: 0.2, hole_offset_y: 0, hole_diameter: 0.8 }),
    ).toMatchObject({ ax: 1.2, ay: 1, r: 0.4 });
  });

  it("sees a pill shell tab next to another net's pad (it used to be skipped)", () => {
    const tab: El = {
      type: "pcb_plated_hole",
      shape: "pill",
      pcb_plated_hole_id: "tab",
      pcb_port_id: "pp_a",
      x: 0,
      y: 0,
      outer_width: 1,
      outer_height: 2,
      hole_width: 0.6,
      hole_height: 1.6,
      ccw_rotation: 0,
      layers: ["top", "bottom"],
    };
    const circuit = [board(), net("A", ["sp_a"]), net("B", ["sp_b"]), port("a", 0, 0), port("b", 0, 1.2), tab, pad("b", 0, 1.2)];
    // the stadium reaches y=1, the pad starts at 1.1: 0.1mm < 0.127
    expect(rules(runDrcChecks(circuit))).toContain("pad_clearance");
    // turned by 90 degrees the tab lies along x and the pad is far
    const turned = circuit.map((el) => (el === tab ? { ...tab, ccw_rotation: 90 } : el));
    expect(rules(runDrcChecks(turned))).not.toContain("pad_clearance");
  });

  it("measures a square pad as the pad, not as its drill", () => {
    const thp: El = {
      type: "pcb_plated_hole",
      shape: "circular_hole_with_rect_pad",
      pcb_plated_hole_id: "thp",
      pcb_port_id: "pp_a",
      x: 0,
      y: 0,
      hole_shape: "circle",
      pad_shape: "rect",
      hole_diameter: 0.8,
      rect_pad_width: 2,
      rect_pad_height: 2,
      layers: ["top", "bottom"],
    };
    const circuit = [board(), net("A", ["sp_a"]), net("B", ["sp_b"]), port("a", 0, 0), port("b", 1.2, 0), thp, pad("b", 1.2, 0)];
    expect(rules(runDrcChecks(circuit))).toContain("pad_clearance");
  });
});

describe("the cap is per rule and the count is the true one", () => {
  it("keeps reporting later rules after hundreds of earlier violations", () => {
    const crooked: El[] = Array.from({ length: 600 }, (_, i) => ({
      type: "pcb_trace",
      pcb_trace_id: `crooked_${i}`,
      route: [
        { route_type: "wire", x: -5, y: -5, width: 0.2, layer: "bottom" },
        { route_type: "wire", x: -4, y: -4.7, width: 0.2, layer: "bottom" },
      ],
    }));
    const over: El = {
      type: "pcb_trace",
      pcb_trace_id: "over",
      source_trace_id: "st_A",
      route: [
        { route_type: "wire", x: 3, y: 2, width: 0.2, layer: "top" },
        { route_type: "wire", x: 3, y: 4, width: 0.2, layer: "top" },
      ],
    };
    const circuit = [
      board(),
      net("A", ["sp_a"]),
      net("B", ["sp_b"]),
      port("a", 3, 2),
      port("b", 3, 3),
      pad("a", 3, 2),
      pad("b", 3, 3, 0.4, 0.4),
      ...crooked,
      over,
    ];
    const out = runDrcChecks(circuit);
    const angle = out.find((v) => v.rule === "trace_angle");
    expect(angle?.count).toBe(600);
    expect(angle?.points?.length).toBeLessThan(600);
    expect(rules(out)).toContain("trace_pad_clearance");
  });
});

describe("coverage: tie stubs, bare holes, the real edge", () => {
  it("measures a tie stub with no source trace against other nets' pads", () => {
    const stub: El = {
      type: "pcb_trace",
      pcb_trace_id: "pcb_trace_plane_1",
      // the key stitchToPlanes writes: the pad's source port
      subcircuit_connectivity_map_key: "sp_a",
      route: [
        { route_type: "wire", x: 0, y: 0, width: 0.25, layer: "top" },
        { route_type: "wire", x: 2, y: 0, width: 0.25, layer: "top" },
      ],
    };
    const circuit = [board(), net("A", ["sp_a"]), net("B", ["sp_b"]), port("a", 0, 0), port("b", 1, 0), pad("a", 0, 0), pad("b", 1, 0.3)];
    expect(rules(runDrcChecks([...circuit, stub]))).toContain("trace_pad_clearance");
    // with no key at all, the pad it starts from names it
    const { subcircuit_connectivity_map_key: _k, ...senzaChiave } = stub;
    void _k;
    expect(rules(runDrcChecks([...circuit, senzaChiave as El]))).toContain("trace_pad_clearance");
  });

  it("names a stub with no key by the pad under its end on its own layer, not by the one over it", () => {
    // the top pad of net B lies over the bottom pad of net A, and comes first in the file
    const stub: El = {
      type: "pcb_trace",
      pcb_trace_id: "pcb_trace_plane_2",
      route: [
        { route_type: "wire", x: 0, y: 0, width: 0.25, layer: "bottom" },
        { route_type: "wire", x: 2, y: 0, width: 0.25, layer: "bottom" },
      ],
    };
    const circuit = [
      board(),
      net("A", ["sp_a"]),
      net("B", ["sp_b"]),
      port("a", 0, 0),
      port("b", 0, 0),
      pad("b", 0, 0, 0.4, 0.4),
      pad("a", 0, 0, 0.4, 0.4, { layer: "bottom" }),
      stub,
    ];
    // taken for net B, the stub was reported over its own pad
    expect(rules(runDrcChecks(circuit))).not.toContain("trace_pad_clearance");
  });

  it("exempts a net tie only toward the nets of the pads it lands on, on its own layer", () => {
    // the bridge joins A and B on the top; a pad of C on the bottom lies under its end
    const ponte: El = {
      type: "pcb_trace",
      pcb_trace_id: "nt",
      netTie: true,
      route: [
        { route_type: "wire", x: 0, y: 0, width: 0.2, layer: "top" },
        { route_type: "wire", x: 0.6, y: 0, width: 0.2, layer: "top" },
      ],
    };
    const circuit = [
      board(),
      net("A", ["sp_a"]),
      net("B", ["sp_b"]),
      net("C", ["sp_c", "sp_c2"]),
      port("a", 0, 0),
      port("b", 0.6, 0),
      port("c", 0.6, 0),
      port("c2", 0.3, 0.25),
      pad("a", 0, 0),
      pad("b", 0.6, 0),
      pad("c", 0.6, 0, 0.2, 0.2, { layer: "bottom" }),
      // a pad of C on the top, 0.05mm from the bridge
      pad("c2", 0.3, 0.25, 0.1, 0.2),
      ponte,
    ];
    const vicini = runDrcChecks(circuit).filter((v) => v.rule === "trace_pad_clearance");
    // C taken for one of the bridged nets exempted the bridge from it on the top as well
    expect(vicini.map((v) => v.message).join("\n")).toContain("nt over pad_c2");
  });

  it("checks bare holes against the edge and against other drills", () => {
    const hole = (id: string, x: number, y: number): El => ({
      type: "pcb_hole",
      pcb_hole_id: id,
      hole_shape: "circle",
      hole_diameter: 1,
      x,
      y,
    });
    expect(rules(runDrcChecks([board(), hole("h1", 9.3, 0)]))).toContain("board_edge_clearance");
    const via: El = { type: "pcb_via", pcb_via_id: "v1", x: 0.85, y: 5, outer_diameter: 0.6, hole_diameter: 0.3, layers: ["top", "bottom"] };
    expect(rules(runDrcChecks([board(), hole("h2", 0, 5), via]))).toContain("hole_to_hole");
  });

  it("uses the turned extents of a pad, not its straight box", () => {
    // a 2 x 0.2 pad turned by 90 degrees reaches 0.1mm toward the edge, not 1mm
    const circuit = [board(), net("A", ["sp_a"]), port("a", 9.4, 0), pad("a", 9.4, 0, 2, 0.2, { shape: "rotated_rect", ccw_rotation: 90 })];
    expect(rules(runDrcChecks(circuit))).not.toContain("board_edge_clearance");
    const straight = [board(), net("A", ["sp_a"]), port("a", 9.4, 0), pad("a", 9.4, 0, 2, 0.2)];
    expect(rules(runDrcChecks(straight))).toContain("board_edge_clearance");
  });

  it("checks traces against the edge, and follows a notched outline", () => {
    const trace: El = {
      type: "pcb_trace",
      pcb_trace_id: "edge",
      source_trace_id: "st_A",
      route: [
        { route_type: "wire", x: 9.8, y: -5, width: 0.2, layer: "top" },
        { route_type: "wire", x: 9.8, y: 5, width: 0.2, layer: "top" },
      ],
    };
    expect(rules(runDrcChecks([board(), net("A", ["sp_a"]), trace]))).toContain("board_edge_clearance");
    // an L-shaped board: the pad sits in the missing corner, inside the box
    const L = board({
      outline: [
        { x: -10, y: -10 },
        { x: 10, y: -10 },
        { x: 10, y: 0 },
        { x: 0, y: 0 },
        { x: 0, y: 10 },
        { x: -10, y: 10 },
      ],
    });
    const corner = [L, net("A", ["sp_a"]), port("a", 5, 5), pad("a", 5, 5)];
    expect(rules(runDrcChecks(corner))).toContain("board_edge_clearance");
    const inside = [L, net("A", ["sp_a"]), port("a", -5, -5), pad("a", -5, -5)];
    expect(rules(runDrcChecks(inside))).not.toContain("board_edge_clearance");
  });
});

describe("pin_escape on a rotated pad", () => {
  // one LQFP pad turned by 135 degrees, as on BIRDY_BAT's STM32
  const pad: El = { type: "pcb_smtpad", shape: "rotated_rect", pcb_smtpad_id: "p", x: 0, y: 0, width: 1.194, height: 0.305, ccw_rotation: 135, layer: "top" };
  const trace = (tx: number, ty: number): El => ({
    type: "pcb_trace",
    pcb_trace_id: "t",
    route: [
      { route_type: "wire", x: 0, y: 0, width: 0.15, layer: "top" },
      { route_type: "wire", x: tx, y: ty, width: 0.15, layer: "top" },
    ],
  });
  const escapes = (c: El[]) => runDrcChecks(c).filter((v) => v.rule === "pin_escape");

  it("leaving along the pad's own axis is straight, even at 45 degrees on the board", () => {
    expect(escapes([board(), pad, trace(-1, 1)])).toHaveLength(0);
  });

  it("leaving horizontally from that pad is the crooked one", () => {
    expect(escapes([board(), pad, trace(1.5, 0)])).toHaveLength(1);
  });
});

/*
 * sbb-dl-principale, 2026-11-11: OSPI_IO7 enters the ball IC6.E1 on the bottom,
 * straight. In plan view the top pad C4.2, turned by 135 degrees, lies over the
 * ball and comes first in the file: the check measured the entry against its
 * edges and reported 45 degrees.
 */
describe("pin_escape reads the pad on the layer of the trace", () => {
  // the two pads as they sit on that board, the ball moved to the origin
  const c4: El = { type: "pcb_smtpad", shape: "rotated_rect", pcb_smtpad_id: "c4_2", x: -0.2248, y: -0.0922, width: 0.6, height: 0.64, ccw_rotation: 135, layer: "top" };
  const ball: El = { type: "pcb_smtpad", shape: "circle", pcb_smtpad_id: "ic6_e1", x: 0, y: 0, radius: 0.185, layer: "bottom" };
  const trace = (layer: string, tx: number, ty: number): El => ({
    type: "pcb_trace",
    pcb_trace_id: `t_${layer}`,
    route: [
      { route_type: "wire", x: 0, y: 0, width: 0.2, layer },
      { route_type: "wire", x: tx, y: ty, width: 0.2, layer },
    ],
  });
  const escapes = (c: El[]) => runDrcChecks(c).filter((v) => v.rule === "pin_escape");

  it("a straight entry into a bottom pad is straight, whatever top pad lies over it", () => {
    expect(escapes([board(), c4, ball, trace("bottom", 0, -0.5)])).toEqual([]);
  });

  it("a crooked entry into that pad is still reported (measured on C4.2 it read as straight)", () => {
    const found = escapes([board(), c4, ball, trace("bottom", 0.4, -0.4)]);
    expect(found).toHaveLength(1);
    // the dot is on the layer of the trace that enters crooked: the bottom (engine 12, PuntoDrc)
    expect(found[0].points).toEqual([{ x: 0, y: 0, layer: "bottom" }]);
  });

  it("a through-hole pad is left from both faces, and judged from both", () => {
    const thp: El = { type: "pcb_plated_hole", shape: "circle", pcb_plated_hole_id: "j1", x: 0, y: 0, outer_diameter: 1.2, hole_diameter: 0.6, layers: ["top", "bottom"] };
    for (const layer of ["top", "bottom"]) {
      expect(escapes([board(), thp, trace(layer, 0, -2)])).toEqual([]);
      expect(escapes([board(), thp, trace(layer, 1.5, -1.5)])).toHaveLength(1);
    }
  });
});

/*
 * sbb-dl-principale, 2026-11-11: the inner1 ground plane closed over 20 vias of
 * other nets that listed only the two layers their trace joins, and the DRC
 * answered 0 errors. Nothing measured a poured plane against a via.
 */
describe("a plane keeps its distance from the vias of the other nets, on every layer", () => {
  const quadrato = (x0: number, y0: number, x1: number, y1: number) => ({
    vertices: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }],
  });
  const reti: El[] = [
    { type: "source_net", source_net_id: "n_gnd", name: "GND", subcircuit_connectivity_map_key: "k_gnd" },
    { type: "source_net", source_net_id: "n_sig", name: "VBUS", subcircuit_connectivity_map_key: "k_sig" },
  ];
  const piano = (layer: string, buchi: Array<ReturnType<typeof quadrato>> = []): El => ({
    type: "pcb_copper_pour",
    pcb_copper_pour_id: `p_${layer}`,
    layer,
    source_net_id: "n_gnd",
    shape: "brep",
    brep_shape: { outer_ring: quadrato(-8, -8, 8, 8), inner_rings: buchi },
  });
  const via = (id: string, chiave: string, x: number, y: number, layers: string[]): El => ({
    type: "pcb_via",
    pcb_via_id: id,
    x,
    y,
    outer_diameter: 0.5,
    hole_diameter: 0.2,
    layers,
    subcircuit_connectivity_map_key: chiave,
  });
  const regole = { minClearanceMm: 0.152, pourClearanceMm: 0.152, minViaHoleMm: 0.2, minViaDiameterMm: 0.5 };
  const drc = (els: El[], extra: Record<string, unknown> = {}) =>
    runDrcChecks([board({ num_layers: 4 }), ...reti, ...els], { ...DEFAULT_DESIGN_RULES, ...regole, ...extra }).filter(
      (v) => v.rule === "pour_clearance",
    );

  it("reports the plane that closes over a via, on a layer the via does not even list", () => {
    // from inner2 to bottom, as its trace goes: the hole still crosses the inner1 plane
    const found = drc([piano("inner1"), via("v_vbus", "k_sig", 2, 2, ["inner2", "bottom"])]);
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain("v_vbus <-> GND pour on inner1: 0.000mm < min 0.152mm");
    // the via goes through, the plane that did not open is on inner1: the dot is of inner1 (engine 12, PuntoDrc)
    expect(found[0].points).toEqual([{ x: 2, y: 2, layer: "inner1" }]);
    // the same with the list completed: what the via lists does not decide what the hole crosses
    expect(drc([piano("inner1"), via("v_vbus", "k_sig", 2, 2, ["top", "inner1", "inner2", "bottom"])])).toHaveLength(1);
  });

  it("is quiet when the plane opens around the pad by the pour clearance, and speaks when the opening is short", () => {
    // pad radius 0.25 + 0.152 of clearance: the opening has to reach 0.402 from the centre
    const aperto = quadrato(2 - 0.402, 2 - 0.402, 2 + 0.402, 2 + 0.402);
    expect(drc([piano("inner1", [aperto]), via("v", "k_sig", 2, 2, ["inner2", "bottom"])])).toEqual([]);
    const corto = quadrato(2 - 0.3, 2 - 0.3, 2 + 0.3, 2 + 0.3);
    const found = drc([piano("inner1", [corto]), via("v", "k_sig", 2, 2, ["inner2", "bottom"])]);
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain("0.050mm < min 0.152mm");
    // the hundredth of slack a poured circle needs (0.1476 measured on a real plane poured at 0.152)
    const quasi = quadrato(2 - 0.397, 2 - 0.397, 2 + 0.397, 2 + 0.397);
    expect(drc([piano("inner1", [quasi]), via("v", "k_sig", 2, 2, ["inner2", "bottom"])])).toEqual([]);
  });

  it("leaves alone the vias of the plane's own net, and the ones with no net", () => {
    expect(
      drc([
        piano("inner1"),
        via("v_gnd", "k_gnd", 1, 1, ["top", "bottom"]),
        // a stitching via says its net this way
        via("v_cucitura", "net:n_gnd", -1, 1, ["inner1", "bottom"]),
        { type: "pcb_via", pcb_via_id: "v_nessuna", x: 3, y: -3, outer_diameter: 0.5, hole_diameter: 0.2, layers: ["top", "bottom"] },
      ]),
    ).toEqual([]);
  });

  it("counts every plane and every via: two planes over one via, and a via outside the plane", () => {
    const found = drc([
      piano("inner1"),
      piano("top"),
      via("dentro", "k_sig", 2, 2, ["inner2", "bottom"]),
      via("fuori", "k_sig", 12, 0, ["inner2", "bottom"]),
    ]);
    expect(found.map((v) => v.message.split(":")[0])).toEqual(["dentro <-> GND pour on inner1", "dentro <-> GND pour on top"]);
  });

  it("uses the pour's own clearance when it is tighter than the general one, and the pair rule of the project", () => {
    const largo = quadrato(2 - 0.36, 2 - 0.36, 2 + 0.36, 2 + 0.36); // 0.11 from the pad
    const els = [piano("inner1", [largo]), via("v", "k_sig", 2, 2, ["inner2", "bottom"])];
    expect(drc(els)).toHaveLength(1);
    expect(drc(els, { pourClearanceMm: 0.1 })).toEqual([]);
    expect(drc(els, { clearanceByPairMm: { "via-via": 0.1 } })).toEqual([]);
  });
});

/*
 * The plane check used to walk every edge of a pour for every via near it
 * (review of 2026-11-11: 700 vias, 16 pours, 20 000 vertices took a DRC run
 * from 47 to 700 ms). The edges are now in a grid: the answer has to be the one
 * the plain walk gives, on every via, and it is measured once for all the
 * rulesets of a summary.
 */
describe("the plane check asks only the edges near the via, and answers the same", () => {
  type P = { x: number; y: number };
  /** a repeatable sequence in [0, 1) */
  const sequenza = (seme: number) => () => {
    seme = (seme + 0x6d2b79f5) | 0;
    let t = Math.imul(seme ^ (seme >>> 15), 1 | seme);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const cerchio = (x: number, y: number, r: number, n: number): P[] =>
    Array.from({ length: n }, (_, i) => ({ x: x + r * Math.cos((i * 2 * Math.PI) / n), y: y + r * Math.sin((i * 2 * Math.PI) / n) }));
  const STRATI = ["top", "inner1", "inner2", "bottom"];

  /** the plain walk: every edge of every ring, for the inside test and for the distance */
  const dentro = (x: number, y: number, a: P[]) => {
    let d = false;
    for (let i = 0, j = a.length - 1; i < a.length; j = i++) {
      if (a[i].y > y !== a[j].y > y && x < ((a[j].x - a[i].x) * (y - a[i].y)) / (a[j].y - a[i].y) + a[i].x) d = !d;
    }
    return d;
  };
  const dalSegmento = (px: number, py: number, a: P, b: P) => {
    const dx = b.x - a.x, dy = b.y - a.y, l = dx * dx + dy * dy;
    const t = l < 1e-12 ? 0 : Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / l));
    return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
  };
  /** four planes of two nets over the same area, each with its openings, and vias of three nets all over it */
  const scheda = (seme: number, storta = false) => {
    const r = sequenza(seme);
    const W = 40, H = 30;
    const vie = Array.from({ length: 160 }, (_, i) => ({ id: `v${i}`, x: (r() - 0.5) * (W + 4), y: (r() - 0.5) * (H + 4), net: Math.floor(r() * 3) }));
    const piani = STRATI.map((layer, c) => {
      const net = c % 2;
      // the outline: a rectangle walked in steps of a twentieth of a millimetre (a fine grid), or a long slanted
      // diamond (four edges that cross the whole grid, which is then made coarser)
      const lato = (n: number, f: (t: number) => P) => Array.from({ length: n }, (_, i) => f(i / n));
      const esterno: P[] = storta
        ? [{ x: -W / 2, y: 0 }, { x: 0, y: -H / 2 }, { x: W / 2, y: 0 }, { x: 0, y: H / 2 }]
        : [
            ...lato(W * 20, (t) => ({ x: -W / 2 + W * t, y: -H / 2 })),
            ...lato(H * 20, (t) => ({ x: W / 2, y: -H / 2 + H * t })),
            ...lato(W * 20, (t) => ({ x: W / 2 - W * t, y: H / 2 })),
            ...lato(H * 20, (t) => ({ x: -W / 2, y: H / 2 - H * t })),
          ];
      // an opening around most of the vias of the other nets that are in the plane: wide, short of the clearance,
      // and pushed off centre to any of the four sides, so that the nearest edge is not always on the same one
      const buchi = vie
        .filter((v) => v.net !== net && dentro(v.x, v.y, esterno) && r() > 0.15)
        .map((v) => {
          const [dx, dy] = [[0, 0], [0.2, 0], [-0.2, 0], [0, 0.2], [0, -0.2]][Math.floor(r() * 5)];
          return cerchio(v.x + dx, v.y + dy, 0.25 + [0.3, 0.2, 0.152, 0.12][Math.floor(r() * 4)], 24);
        });
      return { layer, net, esterno, buchi };
    });
    const cj: El[] = [
      board({ num_layers: 4, width: W + 10, height: H + 10 }),
      ...[0, 1, 2].map((n): El => ({ type: "source_net", source_net_id: `n${n}`, name: `N${n}`, subcircuit_connectivity_map_key: `k${n}` })),
      ...vie.map((v): El => ({ type: "pcb_via", pcb_via_id: v.id, x: v.x, y: v.y, outer_diameter: 0.5, hole_diameter: 0.2, layers: STRATI, subcircuit_connectivity_map_key: `k${v.net}` })),
      ...piani.map((p, i): El => ({
        type: "pcb_copper_pour",
        pcb_copper_pour_id: `p${i}`,
        layer: p.layer,
        source_net_id: `n${p.net}`,
        shape: "brep",
        brep_shape: { outer_ring: { vertices: p.esterno }, inner_rings: p.buchi.map((b) => ({ vertices: b })) },
      })),
    ];
    return { cj, vie, piani };
  };

  const attese = ({ vie, piani }: ReturnType<typeof scheda>, minimo: number): Array<{ testo: string; x: number; y: number; layer: string }> => {
    const out: Array<{ testo: string; x: number; y: number; layer: string }> = [];
    for (const v of vie) {
      for (const p of piani) {
        if (p.net === v.net) continue;
        let d: number;
        if (dentro(v.x, v.y, p.esterno) && !p.buchi.some((b) => dentro(v.x, v.y, b))) d = 0;
        else {
          let m = Infinity;
          for (const a of [p.esterno, ...p.buchi]) for (let i = 0, j = a.length - 1; i < a.length; j = i++) m = Math.min(m, dalSegmento(v.x, v.y, a[j], a[i]));
          d = Math.max(0, m - 0.25);
        }
        if (d < minimo - 0.01) out.push({ testo: `${v.id} <-> N${p.net} pour on ${p.layer}: ${d.toFixed(3)}mm`, x: v.x, y: v.y, layer: p.layer });
      }
    }
    return out;
  };
  const regole = (minimo: number) => ({ ...DEFAULT_DESIGN_RULES, minClearanceMm: minimo, pourClearanceMm: minimo, minViaHoleMm: 0.2, minViaDiameterMm: 0.5 });
  /** every occurrence of the rule with its distance: the report of a whole board lists 200, so one via and one plane at a time */
  const unaAllaVolta = (cj: El[], minimo: number): string[] => {
    const out: string[] = [];
    const resto = cj.filter((e) => e.type !== "pcb_via" && e.type !== "pcb_copper_pour");
    for (const v of cj.filter((e) => e.type === "pcb_via")) {
      for (const p of cj.filter((e) => e.type === "pcb_copper_pour")) {
        for (const viol of runDrcChecks([...resto, v, p], regole(minimo))) {
          if (viol.rule === "pour_clearance") out.push(viol.message.split(" < min")[0]);
        }
      }
    }
    return out;
  };

  it.each([[11, false], [29, false], [5, true]] as const)("board %i (slanted outline: %s): the same vias, the same planes, the same distances", (seme, storta) => {
    const s = scheda(seme, storta);
    const plain = attese(s, 0.152);
    // enough of each kind for the comparison to mean something
    expect(plain.length).toBeGreaterThan(100);
    expect(plain.some((m) => m.testo.endsWith(": 0.000mm"))).toBe(true);
    expect(plain.some((m) => !m.testo.endsWith(": 0.000mm"))).toBe(true);
    expect(unaAllaVolta(s.cj, 0.152)).toEqual(plain.map((m) => m.testo));
    // and the whole board in one run, where every via asks the same index: the true count, the first 200 in order
    const [tutte] = runDrcChecks(s.cj, regole(0.152)).filter((v) => v.rule === "pour_clearance");
    expect(tutte.count).toBe(plain.length);
    expect(tutte.message).toContain(plain[0].testo);
    // each dot at the via, on the layer of the plane that is too close to it
    expect(tutte.points).toEqual(plain.slice(0, 200).map((m) => ({ x: m.x, y: m.y, layer: m.layer })));
  });

  it("two openings that overlap: a via in both is in no copper, whatever was asked before it", () => {
    // not a shape the pour engine draws, but the plain walk had an answer for it and the answer stays
    const quadrato = (x0: number, y0: number, x1: number, y1: number): P[] => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
    const piano: El = {
      type: "pcb_copper_pour",
      pcb_copper_pour_id: "p",
      layer: "inner1",
      source_net_id: "n0",
      shape: "brep",
      brep_shape: { outer_ring: { vertices: quadrato(-10, -10, 10, 10) }, inner_rings: [{ vertices: quadrato(-3, -2, 1, 2) }, { vertices: quadrato(-1, -2, 3, 2) }] },
    };
    const via = (id: string, x: number): El => ({ type: "pcb_via", pcb_via_id: id, x, y: 0, outer_diameter: 0.5, hole_diameter: 0.2, layers: STRATI, subcircuit_connectivity_map_key: "k1" });
    const reti: El[] = [0, 1].map((n) => ({ type: "source_net", source_net_id: `n${n}`, name: `N${n}`, subcircuit_connectivity_map_key: `k${n}` }));
    // the first via is in one opening only, the second in both, the third in the copper
    const trovate = runDrcChecks([board({ num_layers: 4 }), ...reti, via("in_una", -2), via("in_due", 0), via("nel_rame", 6), piano], regole(0.152))
      .filter((v) => v.rule === "pour_clearance")
      .map((v) => v.message.split(":")[0]);
    expect(trovate).toEqual(["nel_rame <-> N0 pour on inner1"]);
  });

  it("measured once and read by the rulesets that follow, whatever their minimum", () => {
    const { cj } = scheda(11);
    const conta = (minimo: number, misure?: MisureDrc) =>
      runDrcChecks(cj, regole(minimo), misure).filter((v) => v.rule === "pour_clearance").map((v) => [v.count ?? 1, v.message]);
    const misure: MisureDrc = {};
    for (const minimo of [0.152, 0.089, 0.2, 0.127]) expect(conta(minimo, misure)).toEqual(conta(minimo));
    const prima = misure.viaPiani!;
    // a minimum beyond what was measured: measured again, further out, and kept for the next
    expect(conta(0.8, misure)).toEqual(conta(0.8));
    expect(misure.viaPiani!.portataMm).toBeGreaterThanOrEqual(0.8);
    expect(misure.viaPiani).not.toBe(prima);
    const larga = misure.viaPiani;
    expect(conta(0.152, misure)).toEqual(conta(0.152));
    expect(misure.viaPiani).toBe(larga);
    // what it holds: the vias a plane covers are the ones at distance zero
    expect(larga!.righe.filter((r) => r.distanzaMm === 0).length).toBeGreaterThan(0);
  });
});
