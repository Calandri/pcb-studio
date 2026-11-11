import { describe, expect, it } from "vitest";
import { summarizeCircuit } from "@/lib/compile";
import { DESIGN_RULES_PATH, distanzaDellaSerigrafia, resolveDesignRules, SERIGRAFIA_DISTANZA_MM } from "@/lib/design-rules";
import { CHECKS_ENGINE_VERSION, motoreDaSalvare } from "@/lib/engine-version";
import { conflittiDiSerigrafia, serigrafiaInConflitto, type ConflittoSerigrafia } from "@/lib/silkscreen-clearance";
import { buildBoardReport } from "@/lib/board-report";

/*
 * tm-4l-q1, 2026-11-11: the outlines of two parts side by side overlapped and
 * the designators ran over other outlines and over vias, with every check
 * green. Nothing measured the silkscreen. These boards are drawn by hand in
 * millimetres: a stroke's pen is 0.15 mm unless said, so two strokes whose
 * lines are 0.29 mm apart are 0.14 mm apart as printed.
 */
type El = Record<string, unknown>;
type Xy = [number, number];

const parte = (id: string, name: string, layer = "top"): El[] => [
  { type: "source_component", source_component_id: `s_${id}`, name },
  { type: "pcb_component", pcb_component_id: id, source_component_id: `s_${id}`, center: { x: 0, y: 0 }, layer },
];
let n = 0;
const tratto = (pts: Xy[], o: { parte?: string; layer?: string; w?: number } = {}): El => ({
  type: "pcb_silkscreen_path",
  pcb_silkscreen_path_id: `p${n++}`,
  layer: o.layer ?? "top",
  route: pts.map(([x, y]) => ({ x, y })),
  stroke_width: o.w ?? 0.15,
  ...(o.parte ? { pcb_component_id: o.parte } : {}),
});
const rettangolo = (x0: number, y0: number, x1: number, y1: number, o: { parte?: string; layer?: string } = {}): El =>
  tratto([[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]], o);
const testo = (text: string, x: number, y: number, o: { parte?: string; layer?: string; size?: number } = {}): El => ({
  type: "pcb_silkscreen_text",
  pcb_silkscreen_text_id: `t${n++}`,
  text,
  font: "tscircuit2024",
  font_size: o.size ?? 1,
  anchor_position: { x, y },
  anchor_alignment: "center",
  layer: o.layer ?? "top",
  ccw_rotation: 0,
  pcb_component_id: o.parte ?? null,
});
/** a pad of a part, on a pin with a net */
const piazzola = (parteId: string, pin: string, rete: string, x: number, y: number, o: { w?: number; h?: number; layer?: string; margine?: number } = {}): El[] => [
  { type: "source_port", source_port_id: `sp_${parteId}_${pin}`, name: pin, source_component_id: `s_${parteId}`, subcircuit_connectivity_map_key: `k_${rete}` },
  { type: "pcb_port", pcb_port_id: `pp_${parteId}_${pin}`, source_port_id: `sp_${parteId}_${pin}` },
  { type: "source_net", source_net_id: `n_${rete}`, name: rete, subcircuit_connectivity_map_key: `k_${rete}` },
  {
    type: "pcb_smtpad",
    pcb_smtpad_id: `pad_${parteId}_${pin}`,
    pcb_port_id: `pp_${parteId}_${pin}`,
    pcb_component_id: parteId,
    shape: "rect",
    x,
    y,
    width: o.w ?? 1,
    height: o.h ?? 1,
    layer: o.layer ?? "top",
    ...(o.margine !== undefined ? { soldermask_margin: o.margine } : {}),
  },
];
const via = (x: number, y: number, o: { rete?: string; aperta?: boolean } = {}): El[] => [
  ...(o.rete ? [{ type: "source_net", source_net_id: `n_${o.rete}`, name: o.rete, subcircuit_connectivity_map_key: `k_${o.rete}` }] : []),
  {
    type: "pcb_via",
    pcb_via_id: `v${n++}`,
    x,
    y,
    outer_diameter: 0.6,
    hole_diameter: 0.3,
    layers: ["top", "bottom"],
    ...(o.rete ? { subcircuit_connectivity_map_key: `k_${o.rete}` } : {}),
    ...(o.aperta ? { is_tented: false } : {}),
  },
];
/** a circle drawn as a path, as the footprints of these boards do */
const cerchio = (cx: number, cy: number, r: number, o: { parte?: string } = {}): El =>
  tratto(
    Array.from({ length: 13 }, (_, i) => [cx + r * Math.cos((i * Math.PI) / 6), cy + r * Math.sin((i * Math.PI) / 6)] as Xy),
    o,
  );

const misura = (cj: El[], tol = 0.15) => conflittiDiSerigrafia(cj, tol);
const di = (c: ConflittoSerigrafia[], tipo: ConflittoSerigrafia["tipo"]) => c.filter((x) => x.tipo === tipo);

describe("serigrafia contro serigrafia", () => {
  it("two drawings 0.14 mm apart as printed clash, 0.16 mm apart they do not", () => {
    const base = [...parte("a", "R1"), ...parte("b", "R2"), tratto([[0, 0], [2, 0]], { parte: "a" })];
    const vicino = misura([...base, tratto([[0, 0.29], [2, 0.29]], { parte: "b" })]);
    expect(vicino).toHaveLength(1);
    expect(vicino[0]).toMatchObject({ tipo: "serigrafia_serigrafia", faccia: "top", distanzaMm: 0.14, minimoMm: 0.15 });
    expect([vicino[0].a, vicino[0].b].sort()).toEqual(["serigrafia di R1", "serigrafia di R2"]);
    expect(vicino[0].y).toBeGreaterThanOrEqual(0);
    expect(vicino[0].y).toBeLessThanOrEqual(0.29);
    expect(misura([...base, tratto([[0, 0.31], [2, 0.31]], { parte: "b" })])).toEqual([]);
  });

  it("the pieces of one outline that meet at a corner, a segment drawn twice, a T: one drawing", () => {
    // a board outline drawn in four separate strokes, one of them twice, and a tick ending on a side
    const scheda = [
      tratto([[0, 0], [3, 0]]),
      tratto([[3, 0], [3, 2]]),
      tratto([[3, 2], [0, 2]]),
      tratto([[0, 2], [0, 0]]),
      tratto([[0, 2], [0, 0]]),
      tratto([[1.5, 0], [1.5, 0.3]]),
    ];
    expect(misura(scheda)).toEqual([]);
    // the same inside a part
    expect(misura([...parte("a", "U1"), ...scheda.map((t) => ({ ...t, pcb_component_id: "a" }))])).toEqual([]);
  });

  it("the letters of a word written as strokes are one drawing: an X that crosses, the bar of an A, letters 0.13 mm apart", () => {
    // "AXT" in the font of the TM board: 0.8 tall, 0.68 apart, the A's bar ending on its legs
    const parola = [
      tratto([[0, 0], [0, 0.6], [0.2, 0.8], [0.4, 0.6], [0.4, 0]]),
      tratto([[0, 0.3], [0.4, 0.3]]),
      tratto([[0.68, 0], [1.08, 0.8]]),
      tratto([[0.68, 0.8], [1.08, 0]]),
      tratto([[1.36, 0.8], [1.76, 0.8]]),
      tratto([[1.56, 0.8], [1.56, 0]]),
    ];
    expect(misura(parola)).toEqual([]);
    // and the word is still a drawing of its own against a board line it runs into
    const contro = misura([...parola, tratto([[-1, 0.4], [-0.05, 0.4]]), tratto([[-1, 0.4], [-1, 3]])]);
    expect(contro).toHaveLength(1);
    expect(contro[0]).toMatchObject({ a: expect.stringMatching(/scritta di scheda|disegno di scheda/), distanzaMm: 0 });
  });

  it("two outlines of parts side by side that overlap: one clash, at no distance", () => {
    const c = misura([...parte("a", "C30"), ...parte("b", "R26"), rettangolo(-1, -0.5, 0.05, 0.5, { parte: "a" }), rettangolo(0, -0.5, 1, 0.5, { parte: "b" })]);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ tipo: "serigrafia_serigrafia", a: expect.stringMatching(/serigrafia di (C30|R26)/), b: expect.stringMatching(/serigrafia di (C30|R26)/), distanzaMm: 0 });
  });

  it("a designator over another part's outline and over its own, as a text and as strokes", () => {
    // the text of R1 runs over the outline of R2 and over its own
    const altrui = misura([...parte("a", "R1"), ...parte("b", "R2"), rettangolo(-0.5, -0.4, 0.5, 0.4, { parte: "b" }), testo("R1", 0, 0.4, { parte: "a" })]);
    expect(altrui.map((x) => [x.a, x.b].sort().join(" + "))).toEqual(['serigrafia di R2 + testo "R1" di R1']);
    const propria = misura([...parte("a", "R1"), rettangolo(-0.5, -0.4, 0.5, 0.4, { parte: "a" }), testo("R1", 0, 0.4, { parte: "a" })]);
    expect(propria.map((x) => [x.a, x.b].sort().join(" + "))).toEqual(['serigrafia di R1 + testo "R1" di R1']);

    // "C1" drawn as strokes inside the footprint of C1 (the TM board), over its own outline;
    // the two rings of its pin-1 dot 0.1 mm from the outline are the footprint as drawn
    const c1 = [
      ...parte("c", "C1"),
      rettangolo(-1.5, -0.75, 1.5, 0.75, { parte: "c" }),
      tratto([[0.4, 1.1], [0.3, 1.2], [0.1, 1.2], [0, 1.1], [0, 0.5], [0.1, 0.4], [0.3, 0.4], [0.4, 0.5]], { parte: "c" }),
      tratto([[0.68, 1.0], [0.88, 1.2], [0.88, 0.4]], { parte: "c" }),
      cerchio(-1.13, -1.13, 0.13, { parte: "c" }),
      cerchio(-1.13, -1.13, 0.05, { parte: "c" }),
    ];
    const sigla = misura(c1);
    expect(sigla).toHaveLength(1);
    expect([sigla[0].a, sigla[0].b].sort()).toEqual(["serigrafia di C1", "sigla di C1"]);
    expect(sigla[0].distanzaMm).toBe(0);
  });

  it("a text is measured on the strokes of its glyphs, not on its box", () => {
    // the dash of "-" sits low in its box: a line inside the box, 0.23 mm from the dash as printed, is clear
    const meno = testo("-", 0, 0);
    expect(misura([...parte("a", "J1"), meno, tratto([[-0.3, 0.25], [0.3, 0.25]], { parte: "a" })])).toEqual([]);
    expect(di(misura([...parte("a", "J1"), meno, tratto([[-0.3, -0.13], [0.3, -0.13]], { parte: "a" })]), "serigrafia_serigrafia")).toHaveLength(1);
  });

  it("circles and rectangles of the silkscreen are measured as they print", () => {
    const c = misura([
      ...parte("a", "J1"),
      ...parte("b", "J2"),
      { type: "pcb_silkscreen_circle", pcb_silkscreen_circle_id: "c1", pcb_component_id: "a", center: { x: 0, y: 0 }, radius: 1, layer: "top", stroke_width: 0.1 },
      { type: "pcb_silkscreen_rect", pcb_silkscreen_rect_id: "r1", pcb_component_id: "b", center: { x: 1.6, y: 0 }, width: 1, height: 1, layer: "top", stroke_width: 0.1 },
    ]);
    // the circle's edge at x 1, the rectangle's at 1.1: 0.1 between the lines, both pens widened to 0.15
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ tipo: "serigrafia_serigrafia", distanzaMm: 0 });
  });
});

describe("serigrafia contro rame scoperto e fori", () => {
  it("silkscreen 0.10 mm from a pad clashes, by the pad's pin and net; 0.20 mm does not", () => {
    // the pad's edge at x 0.5: a 0.15 stroke whose line is at 0.675 is 0.10 from it
    const base = [...parte("u", "U2"), ...parte("r", "R5"), ...piazzola("u", "12", "VBAT", 0, 0)];
    const c = misura([...base, tratto([[0.675, -1], [0.675, 1]], { parte: "r" })]);
    expect(c).toEqual([
      { tipo: "serigrafia_rame", faccia: "top", a: "serigrafia di R5", b: "piazzola U2.12 (VBAT)", x: 0.675, y: expect.any(Number), distanzaMm: 0.1, minimoMm: 0.15 },
    ]);
    expect(misura([...base, tratto([[0.775, -1], [0.775, 1]], { parte: "r" })])).toEqual([]);
    // measured from the mask opening, the pad grown by its margin: 0.20 from the copper is 0.12 from the opening
    const conMargine = misura([...parte("u", "U2"), ...parte("r", "R5"), ...piazzola("u", "12", "VBAT", 0, 0, { margine: 0.08 }), tratto([[0.775, -1], [0.775, 1]], { parte: "r" })]);
    expect(conMargine).toMatchObject([{ tipo: "serigrafia_rame", distanzaMm: 0.12 }]);
  });

  it("a part's own outline on its own pad is said apart", () => {
    const c = misura([...parte("u", "C2"), ...piazzola("u", "1", "GND", 0, 0), tratto([[0.6, -1], [0.6, 1]], { parte: "u" })]);
    expect(c).toMatchObject([{ tipo: "serigrafia_rame", a: "serigrafia di C2", b: "piazzola C2.1 (GND)", propria: true }]);
  });

  it("a stroke over the hole of a via clashes; over its tented ring it does not; an untented via is bare copper", () => {
    const sopra = misura([...parte("a", "R14"), ...via(0, 0, { rete: "GND" }), tratto([[-1, 0], [1, 0]], { parte: "a" })]);
    expect(sopra).toEqual([{ tipo: "serigrafia_foro", faccia: "top", a: "serigrafia di R14", b: "foro della via (GND)", x: 0, y: 0, distanzaMm: 0, minimoMm: 0 }]);
    // the hole's edge at 0.15: a stroke whose ink ends at 0.18 is on the tented ring, not on the hole
    expect(misura([...parte("a", "R14"), ...via(0, 0, { rete: "GND" }), tratto([[-1, 0.255], [1, 0.255]], { parte: "a" })])).toEqual([]);
    expect(misura([...parte("a", "R14"), ...via(0, 0, { rete: "GND", aperta: true }), tratto([[-1, 0.255], [1, 0.255]], { parte: "a" })])).toMatchObject([
      { tipo: "serigrafia_rame", b: "via scoperta (GND)" },
    ]);
    // and a bare hole
    expect(misura([{ type: "pcb_hole", pcb_hole_id: "h1", x: 5, y: 5, hole_diameter: 3.2, hole_shape: "circle" }, tratto([[3, 6.6], [7, 6.6]])])).toMatchObject([
      { tipo: "serigrafia_foro", a: "disegno di scheda", b: "foro non metallizzato da 3.2mm", distanzaMm: 0 },
    ]);
  });

  it("a filled silkscreen shape over a pad clashes even with its outline far from it", () => {
    const c = misura([
      ...parte("u", "U1"),
      ...piazzola("u", "1", "VCC", 0, 0, { w: 0.4, h: 0.4 }),
      { type: "pcb_silkscreen_rect", pcb_silkscreen_rect_id: "r1", center: { x: 0, y: 0 }, width: 4, height: 4, layer: "top", stroke_width: 0.1, is_filled: true },
    ]);
    expect(c).toMatchObject([{ tipo: "serigrafia_rame", a: "disegno di scheda", b: "piazzola U1.1 (VCC)", distanzaMm: 0 }]);
  });
});

describe("le due facce", () => {
  it("top and bottom are measured each on its own; a hole goes through both", () => {
    const c = misura([
      ...parte("a", "C5"),
      ...parte("b", "C6", "bottom"),
      ...parte("d", "R9", "bottom"),
      // two outlines that would overlap if they were on one face
      rettangolo(-1, -0.5, 0.05, 0.5, { parte: "a" }),
      rettangolo(0, -0.5, 1, 0.5, { parte: "b", layer: "bottom" }),
      // a bottom pad right under the top outline of C5
      ...piazzola("d", "1", "VBAT", -0.5, 0.5, { layer: "bottom", w: 0.5, h: 0.5 }),
    ]);
    expect(c).toEqual([]);
    const foro = misura([...parte("b", "C6", "bottom"), ...via(3, 0, { rete: "GND" }), tratto([[2, 0], [4, 0]], { parte: "b", layer: "bottom" })]);
    expect(foro).toMatchObject([{ tipo: "serigrafia_foro", faccia: "bottom" }]);
  });
});

describe("la regola del progetto e il riepilogo", () => {
  it("minSilkscreenClearanceMm is read from design-rules.json, 0.15 when missing, held within its limits", () => {
    expect(SERIGRAFIA_DISTANZA_MM).toBe(0.15);
    expect(distanzaDellaSerigrafia(resolveDesignRules({}).rules)).toBe(0.15);
    const regole = (v: unknown) => ({ [DESIGN_RULES_PATH]: JSON.stringify({ preset: "custom", rules: { minSilkscreenClearanceMm: v } }) });
    expect(distanzaDellaSerigrafia(resolveDesignRules(regole(0.3)).rules)).toBe(0.3);
    const troppo = resolveDesignRules(regole(5));
    expect(distanzaDellaSerigrafia(troppo.rules)).toBe(1);
    expect(troppo.warnings?.join(" ")).toMatch(/minSilkscreenClearanceMm: 5 e' fuori dai limiti 0-1/);
  });

  it("the compile summary carries it under the project's rule, as a warning that leaves the DRC and the fab class alone", () => {
    const cj = [
      { type: "pcb_board", pcb_board_id: "b", center: { x: 0, y: 0 }, width: 20, height: 20, num_layers: 2 },
      ...parte("a", "R1"),
      ...parte("b", "R2"),
      tratto([[0, 0], [2, 0]], { parte: "a" }),
      tratto([[0, 0.35], [2, 0.35]], { parte: "b" }),
    ];
    const conRegola = summarizeCircuit(cj, { [DESIGN_RULES_PATH]: JSON.stringify({ preset: "custom", rules: { minSilkscreenClearanceMm: 0.3 } }) });
    expect(conRegola.silkscreen).toMatchObject({ count: 1, toleranceMm: 0.3, severity: "warn", perTipo: { serigrafia_serigrafia: 1, serigrafia_rame: 0, serigrafia_foro: 0 } });
    expect(conRegola.silkscreen!.conflitti[0]).toMatchObject({ distanzaMm: 0.2, minimoMm: 0.3 });
    expect(conRegola.message).toMatch(/AVVISO serigrafia \(non ferma l'export\): 1 conflitto di serigrafia \(1 fra disegni; tolleranza 0.3mm\): serigrafia di R\d e serigrafia di R\d su top, 0.200mm/);
    // 0.2 apart is clear under the default 0.15
    const diSerie = summarizeCircuit(cj, {});
    expect(diSerie.silkscreen).toBeUndefined();
    expect(diSerie.message).not.toMatch(/serigrafia/);
    // nothing else moves: the DRC, the fab class, the targets
    expect(conRegola.drcViolations).toEqual(diSerie.drcViolations);
    expect(conRegola.targets.drcViolations).toBe(diSerie.targets.drcViolations);
    // and the board panel says it in its own row, in amber
    const riga = buildBoardReport(cj, conRegola).checks.find((c) => c.id === "serigrafia")!;
    expect(riga).toMatchObject({ severity: "warn", count: "1 segnalazione" });
    expect(buildBoardReport(cj, diSerie).checks.find((c) => c.id === "serigrafia")).toMatchObject({ severity: "ok", count: "ok" });
  });

  it("the summary lists the nearest of each family and counts them all", () => {
    const molti: El[] = [...parte("a", "R1")];
    for (let i = 0; i < 130; i++) molti.push(...via(i * 2, 0), tratto([[i * 2 - 0.5, 0], [i * 2 + 0.5, 0]], { parte: "a" }));
    const s = serigrafiaInConflitto(molti, 0.15)!;
    expect(s.count).toBe(130);
    expect(s.perTipo.serigrafia_foro).toBe(130);
    expect(s.conflitti).toHaveLength(100);
    expect(s.detail).toMatch(/^130 conflitti di serigrafia \(130 sopra fori; tolleranza 0.15mm\)/);
  });

  it("a board with silkscreen clashes is filed under today's engine all the same", () => {
    expect(CHECKS_ENGINE_VERSION).toBe(10);
    expect(motoreDaSalvare({ silkscreen: { count: 40, detail: "40 conflitti di serigrafia" } }, 9)).toBe(10);
  });
});

describe("the check that stops", () => {
  it("is said in the summary and does not throw: the compile goes on", () => {
    const rotto = [
      {
        type: "pcb_silkscreen_path",
        layer: "top",
        stroke_width: 0.15,
        get route(): never {
          throw new Error("boom");
        },
      },
    ];
    expect(() => conflittiDiSerigrafia(rotto as never, 0.15)).toThrow("boom");
    const esito = serigrafiaInConflitto(rotto as never, 0.15);
    expect(esito?.nonMisurata).toBe("boom");
    expect(esito?.count).toBe(0);
    expect(esito?.detail).toContain("NON e' stata misurata");
  });
});
