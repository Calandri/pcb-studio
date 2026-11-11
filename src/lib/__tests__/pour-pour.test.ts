import { describe, expect, it } from "vitest";
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
