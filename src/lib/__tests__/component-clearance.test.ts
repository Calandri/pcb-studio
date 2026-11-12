import { describe, expect, it } from "vitest";
import { convertSoupToGerberCommands, stringifyGerberCommandLayers } from "circuit-json-to-gerber";
import { buildBoardReport } from "@/lib/board-report";
import { summarizeCircuit } from "@/lib/compile";
import { cortileAssorbito, ingombriDeiPezzi, misuraIngombri, testoIngombri } from "@/lib/component-clearance";
import { DESIGN_RULES_PATH, eccedenzaDellIngombro, INGOMBRO_ECCEDENZA_MM, resolveDesignRules } from "@/lib/design-rules";
import { CHECKS_ENGINE_VERSION, motoreDaSalvare } from "@/lib/engine-version";
import { footprintBoxes, footprintParts } from "@/lib/footprint-bounds";
import { distanzaDeiCorpi, leggiIngombri, misuraFra, scontri, TOLLERANZA_INGOMBRI_MM, type Forma } from "@/lib/ingombro";
import { buildScene } from "@/components/board/render";

/*
 * Niccolo', 11/11/2026: "ogni pezzo ha il suo INGOMBRO ... e non si salda
 * nulla", and "l'ingombro per ogni componente DEVE essere come da datasheet
 * ESATTO + 0,15 (facciamo anche 0,2)". On sbb-dl-principale 26 pairs of parts
 * had pads under 0,30 mm with every check green. The footprint: the declared
 * courtyard as it is, or the rectangle around body and pads grown by the
 * excess; two footprints that overlap on one face hit each other in assembly.
 */
type El = Record<string, unknown>;
let n = 0;

const parte = (id: string, o: { nome?: string; ftype?: string; layer?: "top" | "bottom"; rotation?: number; x?: number; y?: number } = {}): El[] => [
  { type: "source_component", source_component_id: `s_${id}`, name: o.nome ?? id, ftype: o.ftype ?? "simple_chip" },
  {
    type: "pcb_component",
    pcb_component_id: id,
    source_component_id: `s_${id}`,
    center: { x: o.x ?? 0, y: o.y ?? 0 },
    layer: o.layer ?? "top",
    rotation: o.rotation ?? 0,
    width: 1,
    height: 1,
  },
];
const pad = (id: string, x: number, y: number, w: number, h: number, o: { layer?: string; rot?: number } = {}): El => ({
  type: "pcb_smtpad",
  pcb_smtpad_id: `pad${n++}`,
  pcb_component_id: id,
  shape: o.rot ? "rotated_rect" : "rect",
  x,
  y,
  width: w,
  height: h,
  layer: o.layer ?? "top",
  ...(o.rot ? { ccw_rotation: o.rot } : {}),
});
const corpo = (id: string, x: number, y: number, w: number, h: number, o: { layer?: string; rot?: number } = {}): El => ({
  type: "cad_component",
  cad_component_id: `cad_${id}`,
  pcb_component_id: id,
  source_component_id: `s_${id}`,
  position: { x, y, z: 0 },
  rotation: { x: 0, y: o.layer === "bottom" ? 180 : 0, z: o.rot ?? 0 },
  model_jscad: { type: "colorize", color: [0, 0, 0], shape: { type: "cuboid", size: [w, h, 1], center: [0, 0, 0.5] } },
});
/** a part whose exact envelope is its body: w x h at (x, y), its two pads inside it */
const blocco = (id: string, x: number, y: number, w: number, h: number, o: { layer?: "top" | "bottom" } = {}): El[] => [
  ...parte(id, { x, y, layer: o.layer }),
  pad(id, x - w / 4, y, w / 4, h / 2, { layer: o.layer }),
  pad(id, x + w / 4, y, w / 4, h / 2, { layer: o.layer }),
  corpo(id, x, y, w, h, { layer: o.layer }),
];
const cortileRect = (id: string, x: number, y: number, w: number, h: number, layer = "top"): El => ({
  type: "pcb_courtyard_rect",
  pcb_courtyard_rect_id: `cy${n++}`,
  pcb_component_id: id,
  center: { x, y },
  width: w,
  height: h,
  layer,
});
const contorno = (id: string, punti: Array<[number, number]>, layer = "top"): El => ({
  type: "pcb_courtyard_outline",
  pcb_courtyard_outline_id: `cyo${n++}`,
  pcb_component_id: id,
  layer,
  outline: punti.map(([x, y]) => ({ x, y })),
});
const tratto = (pts: Array<[number, number]>, o: { parte?: string; layer?: string } = {}): El => ({
  type: "pcb_silkscreen_path",
  pcb_silkscreen_path_id: `p${n++}`,
  layer: o.layer ?? "top",
  route: pts.map(([x, y]) => ({ x, y })),
  stroke_width: 0.15,
  ...(o.parte ? { pcb_component_id: o.parte } : {}),
});
const punti = (f: Forma) => f.punti.map((p) => [Math.round(p.x * 1000) / 1000, Math.round(p.y * 1000) / 1000]);
const box = (f: Forma) => [f.box.minX, f.box.minY, f.box.maxX, f.box.maxY].map((v) => Math.round(v * 1000) / 1000);

describe("A. two parts whose footprints overlap hit each other in assembly", () => {
  it("exact envelopes 0,29 mm apart with 0,15 of excess hit; 0,31 do not", () => {
    // A ends at x = 1, B starts at 1,29: 0,29 between the bodies, 0,30 asked by two footprints of 0,15
    const vicini = misuraIngombri([...blocco("A", 0, 0, 2, 1), ...blocco("B", 2.29, 0, 2, 1)], 0.15);
    expect(vicini.scontri).toHaveLength(1);
    expect(vicini.scontri[0]).toMatchObject({ a: "A", b: "B", faccia: "top", distanzaInvolucriMm: 0.29, eccedenzaMm: 0.15, fonteA: "piazzole e corpo", fonteB: "piazzole e corpo" });
    expect(vicini.scontri[0].sovrapposizioneMm).toBeCloseTo(0.01, 6);
    expect(vicini.scontri[0].x).toBeCloseTo(1.145, 6);
    expect(misuraIngombri([...blocco("A", 0, 0, 2, 1), ...blocco("B", 2.31, 0, 2, 1)], 0.15).scontri).toEqual([]);
  });

  it("the project's excess is 0,20 unless it says otherwise: 0,39 hit, 0,41 do not, and the summary says it", () => {
    expect(INGOMBRO_ECCEDENZA_MM).toBe(0.2);
    expect(eccedenzaDellIngombro(resolveDesignRules({}).rules)).toBe(0.2);
    const s = summarizeCircuit([...blocco("A", 0, 0, 2, 1), ...blocco("B", 2.39, 0, 2, 1)]);
    expect(s.courtyards).toMatchObject({ count: 1, eccedenzaMm: 0.2, severity: "error" });
    expect(s.targets.courtyardCollisions).toBe(1);
    expect(s.targets.allGreen).toBe(false);
    expect(s.message).toMatch(/ERRORE ingombri dei pezzi \(la scheda non e' pronta, l'export resta possibile\): 1 coppia di pezzi si scontra in assemblaggio, la peggiore A e B su top/);
    const lontani = summarizeCircuit([...blocco("A", 0, 0, 2, 1), ...blocco("B", 2.41, 0, 2, 1)]);
    expect(lontani.courtyards).toBeUndefined();
    expect(lontani.targets.courtyardCollisions).toBe(0);
  });

  it("a project with its own excess is measured with it", () => {
    const regole = (v: number) => ({ [DESIGN_RULES_PATH]: JSON.stringify({ preset: "custom", rules: { componentCourtyardExcessMm: v } }) });
    expect(summarizeCircuit([...blocco("A", 0, 0, 2, 1), ...blocco("B", 2.29, 0, 2, 1)], regole(0.1)).courtyards).toBeUndefined();
    const larga = summarizeCircuit([...blocco("A", 0, 0, 2, 1), ...blocco("B", 2.41, 0, 2, 1)], regole(0.25));
    expect(larga.courtyards?.count).toBe(1);
    expect(larga.courtyards?.scontri[0].sovrapposizioneMm).toBeCloseTo(0.09, 6);
    // an excess out of its limits is said and clamped
    expect(resolveDesignRules(regole(3)).rules.componentCourtyardExcessMm).toBe(1);
  });

  it("two parts on top of each other: the overlap, and the bodies at zero", () => {
    const m = misuraIngombri([...blocco("A", 0, 0, 2, 1), ...blocco("B", 1.5, 0, 2, 1)], 0.2);
    expect(m.scontri).toHaveLength(1);
    // 0,5 of bodies plus the two excesses
    expect(m.scontri[0].sovrapposizioneMm).toBeCloseTo(0.9, 6);
    expect(m.scontri[0].distanzaInvolucriMm).toBe(0);
  });

  it("two parts on opposite faces never hit: a module over its capacitors on the other face", () => {
    expect(misuraIngombri([...blocco("U1", 0, 0, 10, 10), ...blocco("C1", 0, 0, 1, 0.5, { layer: "bottom" })], 0.2).scontri).toEqual([]);
  });

  it("a through-hole part meets the other face with its holes and rings, not with its body", () => {
    const j1: El[] = [
      ...parte("J1", { x: 1.27, y: 0 }),
      { type: "pcb_plated_hole", pcb_plated_hole_id: "h1", pcb_component_id: "J1", shape: "circle", x: 0, y: 0, outer_diameter: 1.6, hole_diameter: 1, layers: ["top", "bottom"] },
      { type: "pcb_plated_hole", pcb_plated_hole_id: "h2", pcb_component_id: "J1", shape: "circle", x: 2.54, y: 0, outer_diameter: 1.6, hole_diameter: 1, layers: ["top", "bottom"] },
      cortileRect("J1", 1.27, 1.5, 6, 6),
    ];
    // under the ring of pin 1 on the bottom: the ring (0,8 + 0,2) reaches x = 1,0, the part's footprint starts at 0,82
    const sotto = misuraIngombri([...j1, ...blocco("R1", 1.27, 0, 0.5, 0.3, { layer: "bottom" })], 0.2);
    expect(sotto.scontri).toHaveLength(1);
    expect(sotto.scontri[0]).toMatchObject({ a: "J1", b: "R1", faccia: "bottom", fonteA: "fori di un pezzo passante" });
    // under the connector's body, away from its pins: the body is on the top
    expect(misuraIngombri([...j1, ...blocco("R1", 1.27, 3, 0.5, 0.3, { layer: "bottom" })], 0.2).scontri).toEqual([]);
  });

  /** tscircuit's courtyard error on two parts */
  const errore = (a: string, b: string) => ({
    type: "pcb_courtyard_overlap_error",
    pcb_courtyard_overlap_error_id: `e_${a}_${b}`,
    error_type: "pcb_courtyard_overlap_error",
    message: `Courtyard of ${a} overlaps with courtyard of ${b}`,
    pcb_component_ids: [a, b],
  });
  /** a part with one pad and a declared courtyard w x h at (x, 0) */
  const conCortile = (id: string, x: number, w: number, h: number, layer: "top" | "bottom" = "top"): El[] => [
    ...parte(id, { x, layer }),
    pad(id, x, 0, 0.5, 0.5, { layer }),
    cortileRect(id, x, 0, w, h, layer),
  ];
  /** what the viewer colours red: scontri on the scene's footprints, as BoardCanvas does */
  const rossi = (cj: El[]) =>
    scontri(
      buildScene([{ type: "pcb_board", pcb_board_id: "b", center: { x: 0, y: 0 }, width: 60, height: 20, num_layers: 2 }, ...cj] as never)!.ingombri.map((g) => ({
        faccia: g.layer,
        forme: g.forme,
        fori: g.fori,
      })),
    ).length;

  it("one report per pair: tscircuit's courtyard error of a pair the check reports is not counted again", () => {
    const cj = [...conCortile("J2", 0, 3, 3), ...conCortile("C66", 2.4, 2, 1), errore("J2", "C66")];
    const m = misuraIngombri(cj, 0.2);
    expect(m.scontri.map((s) => [s.a, s.b])).toEqual([["J2", "C66"]]);
    expect(m.scontri[0]).toMatchObject({ fonteA: "cortile", fonteB: "cortile" });
    // the declared courtyards as they are: 1,5 + 1 - 2,4 of overlap, no excess on them
    expect(m.scontri[0].sovrapposizioneMm).toBeCloseTo(0.1, 6);
    expect(cortileAssorbito(errore("C66", "J2"), m.cortiliAssorbiti)).toBe(true);
    const s = summarizeCircuit(cj);
    expect(s.errors).toEqual([]);
    expect(s.courtyards?.count).toBe(1);
  });

  it("two footprints that only touch do not hit: tscircuit's error on them is absorbed, no error, no red", () => {
    expect(TOLLERANZA_INGOMBRI_MM).toBe(0.001);
    // courtyards 2 wide at 0 and 2: they share the side x = 1
    const contatto = [...conCortile("K1", 0, 2, 2), ...conCortile("K2", 2, 2, 2), errore("K1", "K2")];
    const m = misuraIngombri(contatto, 0.2);
    expect(m.scontri).toEqual([]);
    expect(m.cortiliAssorbiti).toEqual(["K1|K2"]);
    const s = summarizeCircuit(contatto);
    expect(s.errors).toEqual([]);
    expect(s.courtyards).toBeUndefined();
    expect(s.targets).toMatchObject({ errors: 0, courtyardCollisions: 0 });
    expect(buildBoardReport([{ type: "pcb_board", width: 10, height: 10 }], s).checks.find((c) => c.id === "place")).toMatchObject({ severity: "ok" });
    expect(rossi(contatto)).toBe(0);
    // within the tolerance it is still a contact
    expect(misuraIngombri([...conCortile("K1", 0, 2, 2), ...conCortile("K2", 1.9995, 2, 2)], 0.2).scontri).toEqual([]);
  });

  it("a board whose only errors are absorbed courtyards, with a pair that hits, is not ok: same rule as every error in allGreen", () => {
    const s = summarizeCircuit([...conCortile("K1", 0, 2, 2), ...conCortile("K2", 1.99, 2, 2), errore("K1", "K2")]);
    expect(s.errors).toEqual([]);
    expect(s.ok).toBe(false);
    expect(s.targets).toMatchObject({ errors: 0, courtyardCollisions: 1, allGreen: false });
    expect(s.message).toMatch(/^Compile finished with 1 pair\(s\) of parts hitting each other in assembly \(courtyards\)\./);
    expect(s.message).not.toMatch(/Compile OK/);
    // with errors of its own too, both are said
    const tutti = summarizeCircuit([...conCortile("K1", 0, 2, 2), ...conCortile("K2", 1.99, 2, 2), { type: "pcb_trace_error", message: "una pista" }]);
    expect(tutti.message).toMatch(/^Compile finished with 1 error\(s\) and 1 pair\(s\) of parts hitting each other/);
    // touching only: ok
    expect(summarizeCircuit([...conCortile("K1", 0, 2, 2), ...conCortile("K2", 2, 2, 2), errore("K1", "K2")]).ok).toBe(true);
  });

  it("an overlap of 0,01 hits: an error, red in the viewer", () => {
    const sovrapposti = [...conCortile("K1", 0, 2, 2), ...conCortile("K2", 1.99, 2, 2), errore("K1", "K2")];
    const m = misuraIngombri(sovrapposti, 0.2);
    expect(m.scontri).toHaveLength(1);
    expect(m.scontri[0].sovrapposizioneMm).toBeCloseTo(0.01, 6);
    const s = summarizeCircuit(sovrapposti);
    // one report: ours, not tscircuit's too
    expect(s.errors).toEqual([]);
    expect(s.targets.courtyardCollisions).toBe(1);
    expect(rossi(sovrapposti)).toBe(1);
  });

  it("tscircuit's error stays for a pair the check could not measure, and for every pair when the check stopped", () => {
    // two faces: measured, and clear (the parts are on opposite faces), so absorbed
    const dueFacce = [...conCortile("X1", 20, 3, 3), ...conCortile("X2", 20, 3, 3, "bottom"), errore("X1", "X2")];
    expect(summarizeCircuit(dueFacce).errors).toEqual([]);
    // M1 has no footprint the check can read (no pad, no courtyard, no body): not measured
    const nonMisurato = [
      ...conCortile("J2", 0, 3, 3),
      { type: "source_component", source_component_id: "s_M1", name: "M1", ftype: "simple_chip" },
      { type: "pcb_component", pcb_component_id: "M1", source_component_id: "s_M1", center: { x: 0, y: 0 }, layer: "top", rotation: 0, width: 1, height: 1 },
      errore("J2", "M1"),
    ];
    expect(misuraIngombri(nonMisurato, 0.2).cortiliAssorbiti).toEqual([]);
    expect(summarizeCircuit(nonMisurato).errors.map((e) => e.message)).toEqual(["Courtyard of J2 overlaps with courtyard of M1"]);
  });

  it("a part whose body is only in its courtyard: no distance 'from body and pads', the overlap counts", () => {
    // J3 of n59: a connector with two pads at the ends and its body drawn only in its courtyard; C41 under that body
    const cj = [
      ...parte("J3"),
      pad("J3", -3, 0, 1, 1),
      pad("J3", 3, 0, 1, 1),
      cortileRect("J3", 0, 0, 8, 4),
      ...parte("C41", { ftype: "simple_capacitor", x: 0, y: 1 }),
      pad("C41", -0.5, 1, 0.6, 0.5),
      pad("C41", 0.5, 1, 0.6, 0.5),
    ];
    const [s] = misuraIngombri(cj, 0.2).scontri;
    expect(s).toMatchObject({ a: "J3", b: "C41", fonteA: "cortile", distanzaInvolucriMm: null, corpoNonNoto: ["J3"] });
    expect(s.sovrapposizioneMm).toBeCloseTo(0.9, 6);
    const r = ingombriDeiPezzi(cj, 0.2).riepilogo!;
    expect(r.detail).not.toMatch(/corpo e piazzole a|involucri a \d/);
    expect(r.detail).toContain("corpo di J3 non noto");
    expect(distanzaDeiCorpi(s)).toBe("corpo di J3 non noto (conta l'ingombro)");
    // two known bodies keep their distance
    const noti = misuraIngombri([...blocco("A", 0, 0, 2, 1), ...blocco("B", 2.29, 0, 2, 1)], 0.15).scontri[0];
    expect(distanzaDeiCorpi(noti)).toBe("corpo e piazzole a 0.290mm");
    expect(noti.corpoNonNoto).toBeUndefined();
  });

  it("a board with parts that hit is filed under today's engine all the same", () => {
    expect(CHECKS_ENGINE_VERSION).toBe(11);
    expect(motoreDaSalvare({ courtyards: { count: 24, detail: "24 coppie" } }, 10)).toBe(11);
  });
});

describe("the footprint: one clean rectangle, the same drawn and measured", () => {
  it("pads wider than the body (a capacitor's): the rectangle around both, not a bone", () => {
    // C66 of sbb-dl-principale: body 1,6 x 0,8, pads 0,8 x 0,95 at +-0,825
    const [c] = leggiIngombri([...parte("C1"), pad("C1", -0.825, 0, 0.8, 0.95), pad("C1", 0.825, 0, 0.8, 0.95), corpo("C1", 0, 0, 1.6, 0.8)], 0.2);
    expect(c.fonte).toBe("piazzole e corpo");
    expect(c.forme).toHaveLength(1);
    expect(c.forme[0].punti).toHaveLength(4);
    expect(c.forme[0].r).toBe(0);
    expect(box(c.forme[0])).toEqual([-1.425, -0.675, 1.425, 0.675]);
    expect(box(c.involucro)).toEqual([-1.225, -0.475, 1.225, 0.475]);
  });

  it("a part at 45 degrees: the rectangle turned with it, not the upright box around it", () => {
    const c45 = Math.SQRT1_2;
    const giro = (x: number, y: number): [number, number] => [x * c45 - y * c45, x * c45 + y * c45];
    const [p1x, p1y] = giro(-0.825, 0), [p2x, p2y] = giro(0.825, 0);
    const cj = [
      ...parte("C3", { rotation: 45 }),
      pad("C3", p1x, p1y, 0.8, 0.95, { rot: 45 }),
      pad("C3", p2x, p2y, 0.8, 0.95, { rot: 45 }),
      corpo("C3", 0, 0, 1.6, 0.8, { rot: 45 }),
    ];
    const [c] = leggiIngombri(cj, 0.2);
    const atteso = [giro(-1.425, -0.675), giro(1.425, -0.675), giro(1.425, 0.675), giro(-1.425, 0.675)].map(([x, y]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000]);
    expect(punti(c.forme[0])).toEqual(atteso);
    // a part in the corner of the upright box, clear of the turned rectangle, does not hit
    const angolo = misuraIngombri([...cj, ...blocco("R9", 1.25, -1.25, 0.4, 0.4)], 0.2);
    expect(angolo.scontri).toEqual([]);
    const upright = footprintBoxes(cj).get("C3")!;
    expect(upright.maxX).toBeGreaterThan(1.1);
  });

  it("a part on the bottom: its footprint on the bottom face", () => {
    const [c] = leggiIngombri([...blocco("R2", 3, 1, 1, 0.5, { layer: "bottom" })], 0.2);
    expect(c.faccia).toBe("bottom");
    expect(box(c.forme[0])).toEqual([2.3, 0.55, 3.7, 1.45]);
  });

  it("a declared courtyard is the footprint as it is: a rectangle, a circle", () => {
    const [r] = leggiIngombri([...parte("C66"), pad("C66", -0.825, 0, 0.8, 0.95), pad("C66", 0.825, 0, 0.8, 0.95), cortileRect("C66", 0, 0, 2.96, 1.46)], 0.2);
    expect(r.fonte).toBe("cortile");
    expect(r.forme).toHaveLength(1);
    expect(box(r.forme[0])).toEqual([-1.48, -0.73, 1.48, 0.73]);
    const [t] = leggiIngombri(
      [...parte("BZ1"), pad("BZ1", -4, 0, 1, 1), pad("BZ1", 4, 0, 1, 1), { type: "pcb_courtyard_circle", pcb_courtyard_circle_id: "cc", pcb_component_id: "BZ1", center: { x: 0, y: 0 }, radius: 5, layer: "top" }],
      0.2,
    );
    expect(t.forme).toHaveLength(1);
    expect(t.forme[0]).toMatchObject({ punti: [{ x: 0, y: 0 }], r: 5 });
  });

  it("a declared outline drawn round pads and body (a bone) is its rectangle; an L stays an L", () => {
    const osso: Array<[number, number]> = [
      [-1.5, -0.7], [-0.6, -0.7], [-0.6, -0.6], [0.6, -0.6], [0.6, -0.7], [1.5, -0.7],
      [1.5, 0.7], [0.6, 0.7], [0.6, 0.6], [-0.6, 0.6], [-0.6, 0.7], [-1.5, 0.7], [-1.5, -0.7],
    ];
    const [o] = leggiIngombri([...parte("C7"), pad("C7", -0.9, 0, 0.8, 0.95), pad("C7", 0.9, 0, 0.8, 0.95), contorno("C7", osso)], 0.2);
    expect(o.forme[0].punti).toHaveLength(4);
    expect(box(o.forme[0])).toEqual([-1.5, -0.7, 1.5, 0.7]);
    const elle: Array<[number, number]> = [[0, 0], [6, 0], [6, 2], [2, 2], [2, 5], [0, 5], [0, 0]];
    const [l] = leggiIngombri([...parte("J9"), pad("J9", 1, 1, 1, 1), contorno("J9", elle)], 0.2);
    expect(l.forme[0].punti).toHaveLength(6);
    // the room in the L is free: a part there does not hit
    expect(misuraIngombri([...parte("J9"), pad("J9", 1, 1, 1, 1), contorno("J9", elle), ...blocco("C8", 4.5, 4, 1, 0.5)], 0.2).scontri).toEqual([]);
  });

  it("the viewer and the placement check still read the size alone: the model's box is read when asked", () => {
    const cj = [...parte("BZ1"), pad("BZ1", -4.35, 0, 1.3, 3.4), pad("BZ1", 4.35, 0, 1.3, 3.4), corpo("BZ1", 0, 0, 9, 9)];
    expect(footprintBoxes(cj).get("BZ1")).toMatchObject({ source: "piazzole", minY: -1.7, maxY: 1.7 });
    expect(footprintParts(cj, { corpiDaiModelli: true }).get("BZ1")?.box).toMatchObject({ source: "piazzole e corpo", minY: -4.5, maxY: 4.5 });
  });
});

describe("B. parts with no real footprint", () => {
  it("a big part with pads only is listed; a standard passive, a fiducial are not", () => {
    const cj = [
      ...parte("U3", { x: 10 }),
      ...[0, 1, 2, 3].flatMap((i) => [pad("U3", 8.5 + i, -2, 0.3, 1), pad("U3", 8.5 + i, 2, 0.3, 1)]),
      ...parte("R1", { ftype: "simple_resistor" }),
      pad("R1", -0.5, 0, 0.6, 0.5),
      pad("R1", 0.5, 0, 0.6, 0.5),
      // Altium marks every part simple_chip: a resistor by its designator
      ...parte("R5", { x: 5 }),
      pad("R5", 4.5, 0, 0.6, 0.5),
      pad("R5", 5.5, 0, 0.6, 0.5),
      ...parte("L1", { x: -5, ftype: "simple_inductor" }),
      pad("L1", -5.5, 0, 0.6, 0.5),
      pad("L1", -4.5, 0, 0.6, 0.5),
      ...parte("FID1", { x: 0, y: 8 }),
      { type: "pcb_smtpad", pcb_smtpad_id: "fid", pcb_component_id: "FID1", shape: "circle", x: 0, y: 8, radius: 0.5, layer: "top" },
    ];
    const m = misuraIngombri(cj, 0.2);
    expect(m.senzaIngombroVero.map((p) => p.pezzo)).toEqual(["L1", "U3"]);
    expect(m.dedottiDalFormato).toBe(2);
    const pezzi = leggiIngombri(cj, 0.2);
    expect(pezzi.find((p) => p.nome === "R1")).toMatchObject({ fonte: "piazzole e corpo dal formato", formato: "0402" });
    expect(pezzi.find((p) => p.nome === "R5")).toMatchObject({ formato: "0402" });
    const s = ingombriDeiPezzi(cj, 0.2).riepilogo!;
    expect(s.count).toBe(0);
    expect(s.senzaIngombroVero.detail).toBe("2 pezzi senza ingombro vero (L1, U3): ingombro ricavato dalle sole piazzole, metti nel footprint il corpo vero (cortile)");
    expect(testoIngombri(s)).toContain("AVVISO ingombri: 2 pezzi senza ingombro vero");
  });
});

describe("C. board drawings that belong to a part", () => {
  it("an outline drawn at board level around one part is its; a logo and a drawing between two parts are not", () => {
    const cj = [
      ...blocco("U1", 0, 0, 4, 3),
      // its outline, 0,3 mm out of its body, written as a drawing of the board
      tratto([[-2.3, -1.8], [2.3, -1.8], [2.3, 1.8], [-2.3, 1.8], [-2.3, -1.8]]),
      // a logo, 10 mm wide, far from everything
      tratto([[20, 20], [30, 20], [30, 28], [20, 28], [20, 20]]),
      tratto([[21, 21], [29, 27]]),
      // two parts and a line between them
      ...blocco("C1", 10, 0, 1, 0.5),
      ...blocco("C2", 12, 0, 1, 0.5),
      tratto([[11, -0.3], [11, 0.3]]),
      // a part's own outline moves with it: not a board drawing
      ...blocco("C9", 0, 10, 1, 0.5),
      tratto([[-0.7, 9.6], [0.7, 9.6], [0.7, 10.4], [-0.7, 10.4], [-0.7, 9.6]], { parte: "C9" }),
    ];
    const m = misuraIngombri(cj, 0.2);
    expect(m.disegniDiScheda).toEqual([expect.objectContaining({ pezzo: "U1", faccia: "top", tipo: "contorno", disegni: 1 })]);
    expect(m.elementiDiScheda).toBe(4);
    expect(m.elementiDiSilkscreen).toBe(5);
    expect(ingombriDeiPezzi(cj, 0.2).riepilogo?.disegniDiScheda.detail).toBe(
      "1 pezzo ha il contorno o la sigla scritti come disegno di scheda (U1): non seguono il pezzo quando lo sposti (4 elementi di silkscreen su 5 sono disegni di scheda)",
    );
  });

  it("a designator written at board level next to one part only is its", () => {
    const cj = [
      ...blocco("R7", 0, 0, 1, 0.5),
      ...blocco("R8", 10, 0, 1, 0.5),
      { type: "pcb_silkscreen_text", pcb_silkscreen_text_id: "t1", text: "R7", font: "tscircuit2024", font_size: 0.6, anchor_position: { x: 0, y: 0.9 }, anchor_alignment: "center", layer: "top", ccw_rotation: 0 },
    ];
    expect(misuraIngombri(cj, 0.2).disegniDiScheda).toEqual([expect.objectContaining({ pezzo: "R7", tipo: "sigla" })]);
  });
});

describe("D. a connector's mating space", () => {
  /** J2 with the room its plug takes declared in the footprint: a closed note path and an "innesto" note inside it */
  const j2 = (descrizione = "innesto: spina USB-C"): El[] => [
    ...parte("J2"),
    pad("J2", -1, 0, 0.6, 1),
    pad("J2", 1, 0, 0.6, 1),
    cortileRect("J2", 0, 0, 4, 2),
    { type: "pcb_note_path", pcb_note_path_id: "np", pcb_component_id: "J2", layer: "top", stroke_width: 0.05, route: [{ x: -2, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 9 }, { x: -2, y: 9 }, { x: -2, y: 1 }] },
    { type: "pcb_note_text", pcb_note_text_id: "nt", pcb_component_id: "J2", layer: "top", font: "tscircuit2024", font_size: 0.6, text: descrizione, anchor_position: { x: 0, y: 5 }, anchor_alignment: "center" },
  ];

  it("a part where the plug goes in is said; the room does not grow the connector's footprint", () => {
    const cj = [...j2(), ...blocco("C9", 0, 5, 1, 0.5), ...blocco("C10", 0, 5, 1, 0.5, { layer: "bottom" })];
    const m = misuraIngombri(cj, 0.2);
    expect(m.scontri).toEqual([]);
    expect(m.nelloSpazioDiInnesto).toEqual([expect.objectContaining({ pezzo: "C9", connettore: "J2", faccia: "top", descrizione: "spina USB-C" })]);
    const [conn] = leggiIngombri(j2(), 0.2);
    expect(conn.forme).toHaveLength(1);
    expect(conn.innesti).toHaveLength(1);
    const r = ingombriDeiPezzi(cj, 0.2).riepilogo!;
    expect(r.nelloSpazioDiInnesto?.detail).toBe("1 pezzo sta dove si infila la parte che entra in un connettore: C9 sta dove si infila spina USB-C di J2");
  });

  it("a note that is not marked 'innesto' stays a note", () => {
    expect(leggiIngombri(j2("pin 1 qui"), 0.2)[0].innesti).toEqual([]);
    expect(leggiIngombri(j2("innesto"), 0.2)[0].innesti[0].descrizione).toBeNull();
  });
});

describe("the check never takes the compile down, and nothing reaches the Gerber", () => {
  it("a footprint it cannot read: said, not measured, not clean", () => {
    const rotto = [
      { type: "source_component", source_component_id: "s1", name: "U1" },
      {
        type: "pcb_component",
        pcb_component_id: "U1",
        source_component_id: "s1",
        get rotation(): never {
          throw new Error("boom");
        },
      },
      pad("U1", 0, 0, 1, 1),
    ];
    expect(() => misuraIngombri(rotto, 0.2)).toThrow("boom");
    const e = ingombriDeiPezzi(rotto, 0.2);
    expect(e.riepilogo).toMatchObject({ count: 0, nonMisurati: "boom" });
    expect(e.cortiliAssorbiti).toEqual([]);
    expect(testoIngombri(e.riepilogo)).toBe(" ATTENZIONE: gli ingombri dei pezzi NON sono stati misurati: il controllo si e' fermato (boom).");
  });

  it("courtyards and mating spaces do not change a single Gerber layer", () => {
    const base = [
      { type: "pcb_board", pcb_board_id: "b", center: { x: 0, y: 0 }, width: 20, height: 20, num_layers: 2 },
      ...blocco("U1", 0, 0, 4, 3),
      tratto([[-2.3, -1.8], [2.3, -1.8]], { parte: "U1" }),
    ];
    const con = [
      ...base,
      cortileRect("U1", 0, 0, 5, 4),
      { type: "pcb_note_path", pcb_note_path_id: "np", pcb_component_id: "U1", layer: "top", stroke_width: 0.05, route: [{ x: -2, y: 2 }, { x: 2, y: 2 }, { x: 2, y: 6 }, { x: -2, y: 6 }] },
      { type: "pcb_note_text", pcb_note_text_id: "nt", pcb_component_id: "U1", layer: "top", font: "tscircuit2024", font_size: 0.6, text: "innesto", anchor_position: { x: 0, y: 4 }, anchor_alignment: "center" },
    ];
    // every layer, without the moment it was written
    const gerber = (cj: unknown[]) =>
      Object.fromEntries(
        Object.entries(stringifyGerberCommandLayers(convertSoupToGerberCommands(cj as never))).map(([k, v]) => [
          k,
          String(v).replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "<data>"),
        ]),
      );
    expect(gerber(con)).toEqual(gerber(base));
  });
});

describe("D. where it shows: the report", () => {
  const board = [{ type: "pcb_board", width: 10, height: 10 }];
  it("parts that hit are a red row and the board is not ready; warnings alone are amber; not measured is never ok", () => {
    const rosso = buildBoardReport(board, { courtyards: { count: 2, detail: "2 coppie di pezzi si scontrano in assemblaggio" } });
    expect(rosso.checks.find((c) => c.id === "place")).toMatchObject({ name: "Ingombri dei pezzi", severity: "err", count: "2 segnalazioni" });
    expect(rosso.ready).toBe(false);
    expect(rosso.missing).toContain("Ingombri dei pezzi: 2 segnalazioni");
    const ambra = buildBoardReport(board, { courtyards: { count: 0, senzaIngombroVero: { count: 3, detail: "3 pezzi senza ingombro vero" } } });
    expect(ambra.checks.find((c) => c.id === "place")).toMatchObject({ severity: "warn", count: "3 avvisi", detail: "3 pezzi senza ingombro vero" });
    const fermo = buildBoardReport(board, { courtyards: { count: 0, nonMisurati: "boom", detail: "gli ingombri dei pezzi NON sono stati misurati" } });
    expect(fermo.checks.find((c) => c.id === "place")).toMatchObject({ severity: "warn", count: "non misurati" });
    // a check that stopped is a check missing: never ready, whatever else is green
    expect(fermo.ready).toBe(false);
    expect(fermo.missing).toEqual(["Ingombri dei pezzi: non misurati"]);
    expect(fermo.readiness).toBeLessThan(100);
    expect(buildBoardReport(board, {}).checks.find((c) => c.id === "place")).toMatchObject({ severity: "ok" });
  });

  it("the shapes measured are the shapes drawn: misuraFra on the viewer's footprints gives the check's overlap", () => {
    const cj = [...blocco("A", 0, 0, 2, 1), ...blocco("B", 2.39, 0, 2, 1)];
    const [a, b] = leggiIngombri(cj, 0.2);
    expect(misuraFra(a.forme, b.forme)?.sovrapposizione).toBeCloseTo(misuraIngombri(cj, 0.2).scontri[0].sovrapposizioneMm, 3);
  });
});
