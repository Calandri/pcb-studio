import { describe, expect, it } from "vitest";
import { DEFAULT_DESIGN_RULES, type DesignRules } from "@/lib/design-rules";
import { runDrcChecks } from "@/lib/drc";
import { nonCertificata } from "@/lib/engine-version";
import { colateCheSiToccano, colateTroppoVicine } from "@/lib/pour-pour";
import { DISTANZA_PROPRIA } from "@/lib/pours";

/*
 * sbb-dl-principale, 17:00-17:37 of 2026-11-11: the bottom ground pour over the
 * strips of the USB shield, another net, and zero errors. Pour against pour.
 */
type P = { x: number; y: number };
const rett = (x0: number, y0: number, x1: number, y1: number): P[] => [
  { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 },
];
const reti = [
  { type: "source_net", source_net_id: "n_gnd", name: "GND", subcircuit_connectivity_map_key: "k_gnd" },
  { type: "source_net", source_net_id: "n_usb", name: "USB1_GUSCIO", subcircuit_connectivity_map_key: "k_usb" },
];
const colata = (id: string, net: string, esterno: P[], buchi: P[][] = [], extra: Record<string, unknown> = {}) => ({
  type: "pcb_copper_pour", pcb_copper_pour_id: id, source_net_id: net, layer: "bottom",
  brep_shape: { outer_ring: { vertices: esterno }, inner_rings: buchi.map((v) => ({ vertices: v })) }, ...extra,
});

describe("pours of different nets on one layer", () => {
  it("that overlap are a short, and the export is told why", () => {
    const cj = [...reti, colata("gnd", "n_gnd", rett(0, 0, 10, 10)), colata("usb", "n_usb", rett(9.5, 2, 12, 4))];
    const coppie = colateTroppoVicine(cj, 0.152);
    expect(coppie).toHaveLength(1);
    expect(coppie[0]).toMatchObject({ reteA: "GND", reteB: "USB1_GUSCIO", distanzaMm: 0, layer: "bottom" });
    const riassunto = colateCheSiToccano(cj, 0.152)!;
    expect(riassunto.detail).toMatch(/si toccano: corto/);
    expect(nonCertificata({ poursTooClose: riassunto })).toMatch(/NON e' certificata per l'export finche' due colate di reti diverse/);
  });

  it("that stand closer than the larger of their two clearances, and not when they keep it", () => {
    const vicine = (gap: number, propria?: number) =>
      colateTroppoVicine([...reti, colata("gnd", "n_gnd", rett(0, 0, 10, 10), [], propria ? { [DISTANZA_PROPRIA]: propria } : {}), colata("usb", "n_usb", rett(10 + gap, 2, 12, 4))], 0.152);
    expect(vicine(0.1)).toHaveLength(1);
    expect(vicine(0.16)).toHaveLength(0);
    // the ground declares 0.25: 0.2 is too close, 0.26 is not
    expect(vicine(0.2, 0.25)).toHaveLength(1);
    expect(vicine(0.2, 0.25)[0].minimoMm).toBe(0.25);
    expect(vicine(0.26, 0.25)).toHaveLength(0);
  });

  it("measure an island against the hole it sits in", () => {
    const piano = (buco: P[]) => colata("gnd", "n_gnd", rett(0, 0, 10, 10), [buco]);
    const isola = colata("usb", "n_usb", rett(4, 4, 6, 6));
    expect(colateTroppoVicine([...reti, piano(rett(3.8, 3.8, 6.2, 6.2)), isola], 0.152)).toHaveLength(0);
    expect(colateTroppoVicine([...reti, piano(rett(3.9, 3.9, 6.1, 6.1)), isola], 0.152)).toHaveLength(1);
  });

  it("where the near copper is a via of the pour's own net, the other pour's clearance is the minimum there", () => {
    // ground declares 0.25 and holds its via; the strip kept its 0.152 from the via
    const via = { type: "pcb_via", pcb_via_id: "v", x: 10.25, y: 3, outer_diameter: 0.5, hole_diameter: 0.25, layers: ["top", "bottom"], subcircuit_connectivity_map_key: "k_gnd" };
    const conVia = [...rett(0, 0, 10, 10).slice(0, 2), { x: 10, y: 2.75 }, { x: 10.5, y: 2.75 }, { x: 10.5, y: 3.25 }, { x: 10, y: 3.25 }, ...rett(0, 0, 10, 10).slice(2)];
    const cj = (x: number) => [...reti, via, colata("gnd", "n_gnd", conVia, [], { [DISTANZA_PROPRIA]: 0.25 }), colata("usb", "n_usb", rett(x, 2, 13, 4))];
    expect(colateTroppoVicine(cj(10.5 + 0.16), 0.152)).toHaveLength(0);
    expect(colateTroppoVicine(cj(10.5 + 0.1), 0.152)).toHaveLength(1);
  });
});

/*
 * sbb-dongle, 12/11/2026: U1 (UFQFPN48, passo 0,5, piazzole larghe 0,28). La
 * colata di massa del top abbraccia il piedino 35, una piazzola di rame P3V3
 * abbraccia il 36 accanto: i due contorni corrono lungo le due piazzole, a
 * 0,220 mm, e usciva "pour_pour_clearance 0.220mm < min 0.25mm" (due volte:
 * anche 47 e 48). E' la luce fra due piazzole del componente, che giudica la
 * regola delle piazzole, non quella delle colate.
 */
describe("two pours that each hold a pad of their net, side by side", () => {
  /** the rules of the dongle: pours 0.25 from the other nets, pads 0.15 from each other */
  const COLATE = 0.25;
  const REGOLE: DesignRules = { ...DEFAULT_DESIGN_RULES, minClearanceMm: 0.15, minTraceWidthMm: 0.15, pourClearanceMm: COLATE };
  const base = [
    { type: "pcb_board", pcb_board_id: "b", width: 10, height: 6, center: { x: 0, y: 0 }, num_layers: 2 },
    { type: "source_net", source_net_id: "n_gnd", name: "GND", subcircuit_connectivity_map_key: "k_gnd" },
    { type: "source_net", source_net_id: "n_p3v3", name: "P3V3", subcircuit_connectivity_map_key: "k_p3v3" },
  ];
  /** a pad 0.28 x 0.8 on top, on its net as the board writes it: the port, the trace that names the net, the pad */
  const piazzola = (id: string, rete: "gnd" | "p3v3", x: number) => [
    { type: "source_port", source_port_id: `sp_${id}`, name: id, subcircuit_connectivity_map_key: `k_${rete}` },
    { type: "source_trace", source_trace_id: `st_${id}`, connected_source_port_ids: [`sp_${id}`], connected_source_net_ids: [`n_${rete}`], subcircuit_connectivity_map_key: `k_${rete}` },
    { type: "pcb_port", pcb_port_id: `pp_${id}`, source_port_id: `sp_${id}`, x, y: 0, layers: ["top"] },
    { type: "pcb_smtpad", pcb_smtpad_id: id, shape: "rect", x, y: 0, width: 0.28, height: 0.8, layer: "top", pcb_port_id: `pp_${id}` },
  ];
  const sopra = (id: string, net: string, esterno: P[]) => ({ ...colata(id, net, esterno), layer: "top" });
  /**
   * Pin 35 (GND) on the left and pin 36 (P3V3) on the right, `luce` apart. The
   * ground pour comes from the left and holds its pin whole: its outline runs
   * along the pin, 0.39 past its own edge, which stays 0.25 and more from the
   * other pin. The P3V3 pad of copper does the same from the right. `lingua`:
   * each pour also reaches toward the other with a tongue of poured copper,
   * away from the pins, that far apart.
   */
  const scheda = (luce: number, lingua?: number) => {
    const bordo = luce / 2 + 0.14 + 0.25;
    const pin = luce / 2;
    const meta = (s: 1 | -1): P[] => [
      { x: s * 4, y: -2 }, { x: s * bordo, y: -2 }, { x: s * bordo, y: -0.4 }, { x: s * pin, y: -0.4 }, { x: s * pin, y: 0.4 }, { x: s * bordo, y: 0.4 },
      ...(lingua !== undefined ? [{ x: s * bordo, y: 1 }, { x: (s * lingua) / 2, y: 1 }, { x: (s * lingua) / 2, y: 1.5 }, { x: s * bordo, y: 1.5 }] : []),
      { x: s * bordo, y: 2 }, { x: s * 4, y: 2 },
    ];
    return [...base, ...piazzola("U1_35", "gnd", -(luce / 2 + 0.14)), ...piazzola("U1_36", "p3v3", luce / 2 + 0.14), sopra("gnd", "n_gnd", meta(-1)), sopra("p3v3", "n_p3v3", meta(1))];
  };

  it("are not too close: the gap is the one between the two pads, and the pour clearance asks nothing of it", () => {
    // 0.22 between the pads, under the 0.25 of the pours and over the 0.15 of the pads
    expect(colateTroppoVicine(scheda(0.22), COLATE)).toHaveLength(0);
    expect(colateCheSiToccano(scheda(0.22), COLATE)).toBeUndefined();
    expect(runDrcChecks(scheda(0.22) as never, REGOLE).filter((v) => v.rule === "pad_clearance")).toHaveLength(0);
  });

  it("are too close where their poured copper is, away from the pads", () => {
    const coppie = colateTroppoVicine(scheda(0.22, 0.22), COLATE);
    expect(coppie).toHaveLength(1);
    expect(coppie[0]).toMatchObject({ reteA: "GND", reteB: "P3V3", layer: "top", minimoMm: 0.25 });
    expect(coppie[0].distanzaMm).toBeCloseTo(0.22, 6);
    // on the tongues, not on the pins
    expect(coppie[0].y).toBeGreaterThanOrEqual(1);
    expect(coppie[0].y).toBeLessThanOrEqual(1.5);
    // and tongues that keep the clearance are no finding, the pins still 0.22 apart
    expect(colateTroppoVicine(scheda(0.22, 0.26), COLATE)).toHaveLength(0);
  });

  it("an edge that runs along the pad and on past it is poured copper where it goes on, and is measured there", () => {
    // each pour's edge is one straight line through its pin, 2 mm either way: 0.22 apart all along, pin against pin only in the middle
    const dritta = (s: 1 | -1): P[] => [{ x: s * 4, y: -2 }, { x: s * 0.11, y: -2 }, { x: s * 0.11, y: 2 }, { x: s * 4, y: 2 }];
    const cj = [...base, ...piazzola("U1_35", "gnd", -0.25), ...piazzola("U1_36", "p3v3", 0.25), sopra("gnd", "n_gnd", dritta(-1)), sopra("p3v3", "n_p3v3", dritta(1))];
    const coppie = colateTroppoVicine(cj, COLATE);
    expect(coppie).toHaveLength(1);
    expect(coppie[0].distanzaMm).toBeCloseTo(0.22, 6);
    expect(coppie[0].minimoMm).toBe(0.25);
    // past the end of the pins, 0.4 from their middle
    expect(Math.abs(coppie[0].y)).toBeGreaterThanOrEqual(0.4 - 0.001);
  });

  it("with the pads under their own rule: the error is the pads', it does not go away", () => {
    // 0.10 between the pads, under minClearanceMm
    const cj = scheda(0.1);
    expect(colateTroppoVicine(cj, COLATE)).toHaveLength(0);
    const piazzole = runDrcChecks(cj as never, REGOLE).filter((v) => v.rule === "pad_clearance");
    expect(piazzole).toHaveLength(1);
    expect(piazzole[0].message).toMatch(/U1_35 <-> U1_36: 0\.100mm < min 0\.15mm/);
  });

  it("touch: a short, whatever they hold", () => {
    const coppie = colateTroppoVicine(scheda(0), COLATE);
    expect(coppie).toHaveLength(1);
    expect(coppie[0].distanzaMm).toBe(0);
  });

  it("a pad of one against poured copper of the other is still measured, as it was", () => {
    // the P3V3 pour does not hold a pin here: its poured edge stands 0.22 from pin 35, which the ground holds
    const senzaPin = scheda(0.22).filter((el) => !String((el as { pcb_smtpad_id?: unknown }).pcb_smtpad_id ?? "").includes("U1_36"));
    const coppie = colateTroppoVicine(senzaPin, COLATE);
    expect(coppie).toHaveLength(1);
    expect(coppie[0].distanzaMm).toBeCloseTo(0.22, 6);
  });

  it("a pad of one against a via of the other, each held by its pour: the rule between pad and via judges it", () => {
    // sbb-dl-principale n92: J4.10 (SD_CD) 0.155 from a ground via, each in its pour, pours at 0.2 and pads at 0.152
    const via = { type: "pcb_via", pcb_via_id: "v", x: 0.36, y: 0, outer_diameter: 0.5, hole_diameter: 0.2, layers: ["top", "bottom"], subcircuit_connectivity_map_key: "k_p3v3" };
    // the left half of the ring, from its lowest point up to its highest
    const mezzoGiro = Array.from({ length: 33 }, (_, i) => ({ x: 0.36 + 0.25 * Math.cos(-Math.PI / 2 - (i * Math.PI) / 32), y: 0.25 * Math.sin(-Math.PI / 2 - (i * Math.PI) / 32) }));
    // the P3V3 pour from the right, holding the via whole: its outline runs around the ring
    const destra = [{ x: 4, y: -2 }, { x: 0.36, y: -2 }, ...mezzoGiro, { x: 0.36, y: 2 }, { x: 4, y: 2 }];
    const sinistra = [{ x: -4, y: -2 }, { x: -0.5, y: -2 }, { x: -0.5, y: -0.4 }, { x: -0.045, y: -0.4 }, { x: -0.045, y: 0.4 }, { x: -0.5, y: 0.4 }, { x: -0.5, y: 2 }, { x: -4, y: 2 }];
    const cj = [...base, ...piazzola("J4_10", "gnd", -0.185), via, sopra("gnd", "n_gnd", sinistra), sopra("p3v3", "n_p3v3", destra)];
    // the pad ends at -0.045, the ring starts at 0.11: 0.155 apart, under the 0.2 of the pours
    expect(colateTroppoVicine(cj, 0.2)).toHaveLength(0);
    expect(runDrcChecks(cj as never, { ...REGOLE, minClearanceMm: 0.152, pourClearanceMm: 0.2 }).filter((v) => v.rule === "pad_clearance")).toHaveLength(0);
  });
});
