import { convertSoupToGerberCommands, stringifyGerberCommandLayers } from "circuit-json-to-gerber";
import { describe, expect, it } from "vitest";
import { DEFAULT_DESIGN_RULES, type DesignRules } from "@/lib/design-rules";
import { distanzaPuntoForma, pointSegDistance, rameDelPad, runDrcChecks } from "@/lib/drc";
import { cuciLaMassa, frequenzaCoperta, leggiOpzioniCucitura, sceltaDellaRete, type EsitoCucitura, type OpzioniCucitura } from "@/lib/ground-stitching";
import { FILE_CUCITURA, fileDellaCucitura, mainLaUsa, vieComeElementi, vieDelFile } from "@/lib/ground-stitching-file";
import { eseguiCucitura } from "@/lib/ground-stitching-tool";
import { conflittiDiSerigrafia } from "@/lib/silkscreen-clearance";
import { viePassantiSuOgniStrato } from "@/lib/via-layers";

/*
 * La cucitura della massa su schede costruite a mano: ogni regola con cui una
 * via viene accettata o scartata, una alla volta, piu' i conti che la
 * chiamata restituisce e il file che scrive.
 */

type El = { type: string; [key: string]: unknown };
type P = { x: number; y: number };

const REGOLE: DesignRules = {
  ...DEFAULT_DESIGN_RULES,
  minClearanceMm: 0.152,
  minTraceWidthMm: 0.127,
  minViaHoleMm: 0.15,
  minViaDiameterMm: 0.45,
  pourClearanceMm: 0.2,
  minHoleToHoleMm: 0.25,
  minBoardEdgeClearanceMm: 0.3,
};
const STRATI = ["top", "inner1", "inner2", "bottom"];
const rett = (x0: number, y0: number, x1: number, y1: number): P[] => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];

let n = 0;
function scheda(w = 20, h = 20): El[] {
  return [
    { type: "pcb_board", pcb_board_id: "b", width: w, height: h, center: { x: 0, y: 0 }, num_layers: 4 },
    { type: "source_net", source_net_id: "source_net_0", name: "GND", subcircuit_connectivity_map_key: "k_gnd", subcircuit_id: "s" },
    { type: "source_net", source_net_id: "source_net_1", name: "SIG", subcircuit_connectivity_map_key: "k_sig", subcircuit_id: "s" },
  ];
}
function colata(layer: string, punti: P[], net = "source_net_0", buchi: P[][] = []): El {
  return {
    type: "pcb_copper_pour",
    pcb_copper_pour_id: `colata_${n++}`,
    layer,
    source_net_id: net,
    shape: "brep",
    brep_shape: { outer_ring: { vertices: punti }, inner_rings: buchi.map((v) => ({ vertices: v })) },
  };
}
/** ground poured on these layers over the whole board, 0.3 from the edge */
const massaPiena = (strati = STRATI, w = 20, h = 20, buchi: P[][] = []): El[] =>
  strati.map((s) => colata(s, rett(-w / 2 + 0.3, -h / 2 + 0.3, w / 2 - 0.3, h / 2 - 0.3), "source_net_0", buchi));
function pad(id: string, x: number, y: number, w: number, h: number, layer: string, rete: "k_gnd" | "k_sig", componente?: string): El[] {
  return [
    { type: "source_port", source_port_id: `sp_${id}`, subcircuit_connectivity_map_key: rete },
    { type: "pcb_port", pcb_port_id: `pp_${id}`, source_port_id: `sp_${id}`, x, y, layers: [layer] },
    { type: "pcb_smtpad", pcb_smtpad_id: id, shape: "rect", x, y, width: w, height: h, layer, pcb_port_id: `pp_${id}`, ...(componente ? { pcb_component_id: componente } : {}) },
  ];
}
function pista(id: string, punti: P[], layer: string, larghezza: number, rete: "k_gnd" | "k_sig"): El[] {
  return [
    { type: "source_trace", source_trace_id: `st_${id}`, subcircuit_connectivity_map_key: rete, connected_source_port_ids: [], connected_source_net_ids: [] },
    { type: "pcb_trace", pcb_trace_id: id, source_trace_id: `st_${id}`, route: punti.map((p) => ({ route_type: "wire", x: p.x, y: p.y, width: larghezza, layer })) },
  ];
}
const viaEsistente = (x: number, y: number, rete: "k_gnd" | "k_sig"): El => ({
  type: "pcb_via", pcb_via_id: `via_${n++}`, x, y, outer_diameter: 0.45, hole_diameter: 0.2, layers: STRATI, subcircuit_connectivity_map_key: rete,
});
function pezzo(id: string, x: number, y: number, w: number, h: number, faccia: "top" | "bottom"): El[] {
  return [
    { type: "source_component", source_component_id: `sc_${id}`, name: id, ftype: "simple_chip" },
    { type: "pcb_component", pcb_component_id: id, source_component_id: `sc_${id}`, center: { x, y }, width: w, height: h, layer: faccia, rotation: 0 },
    { type: "pcb_courtyard_rect", pcb_courtyard_rect_id: `cy_${id}`, pcb_component_id: id, center: { x, y }, width: w, height: h, layer: faccia },
  ];
}

const cuci = (cj: El[], o: OpzioniCucitura = {}): EsitoCucitura => {
  const e = cuciLaMassa(cj, REGOLE, o);
  if (!e.ok) throw new Error(e.errore);
  return e;
};
const R = 0.25;
const dentro = (x: number, y: number, a: P[]) => {
  let d = false;
  for (let i = 0, j = a.length - 1; i < a.length; j = i++) if (a[i].y > y !== a[j].y > y && x < ((a[j].x - a[i].x) * (y - a[i].y)) / (a[j].y - a[i].y) + a[i].x) d = !d;
  return d;
};

describe("dove una via puo' stare", () => {
  it("solo dove la massa copre tutta la corona su almeno due strati", () => {
    // top everywhere, bottom only on the left half: the right half has one layer of ground
    const cj = [...scheda(), ...massaPiena(["top"]), colata("bottom", rett(-9.7, -9.7, -1, 9.7))];
    const e = cuci(cj, { bordo: false });
    expect(e.vie.length).toBeGreaterThan(5);
    for (const v of e.vie) expect(v.x + R).toBeLessThanOrEqual(-1 + 1e-9);
    expect(e.scarti.massa_su_meno_di_due_strati).toBeGreaterThan(0);
  });

  it("non dove uno strato esterno con colate di massa non ha la massa (zone senza rame)", () => {
    // three layers everywhere, the bottom only on the left: the right half is a copper-free window on the bottom
    const cj = [...scheda(), ...massaPiena(["top", "inner1", "inner2"]), colata("bottom", rett(-9.7, -9.7, -1, 9.7))];
    const e = cuci(cj, { bordo: false });
    for (const v of e.vie) expect(v.x + R).toBeLessThanOrEqual(-1 + 1e-9);
    expect(e.scarti.manca_massa_esterna).toBeGreaterThan(0);
  });

  it("non nel vuoto di un piano interno, con la massa sopra e sotto: una zona senza rame resta tale su ogni strato", () => {
    // top and bottom whole; inner1 and inner2 with a 6 x 6 window in the middle (antenna, crystal)
    const vuoto = rett(-3, -3, 3, 3);
    const cj = [...scheda(), ...massaPiena(["top", "bottom"]), ...massaPiena(["inner1", "inner2"], 20, 20, [vuoto])];
    const e = cuci(cj, { bordo: false, passoMm: 1 });
    expect(e.vie.length).toBeGreaterThan(100);
    for (const v of e.vie) expect(dentro(v.x, v.y, rett(-3 - R, -3 - R, 3 + R, 3 + R))).toBe(false);
    expect(e.scarti.manca_massa_interna).toBeGreaterThan(10);
    // one inner layer is enough: the window only on inner2
    const uno = cuci([...scheda(), ...massaPiena(["top", "inner1", "bottom"]), ...massaPiena(["inner2"], 20, 20, [vuoto])], { bordo: false, passoMm: 1 });
    expect(uno.vie.length).toBeGreaterThan(100);
    for (const v of uno.vie) expect(dentro(v.x, v.y, rett(-3 - R, -3 - R, 3 + R, 3 + R))).toBe(false);
    // and a gap between two pours of the inner plane is a void as much as a window in one
    const fessura = cuci([...scheda(), ...massaPiena(["top", "bottom"]), colata("inner1", rett(-9.7, -9.7, -1, 9.7)), colata("inner1", rett(1, -9.7, 9.7, 9.7))], { bordo: false, passoMm: 1 });
    expect(fessura.vie.length).toBeGreaterThan(100);
    for (const v of fessura.vie) expect(Math.abs(v.x) - R).toBeGreaterThanOrEqual(1 - 1e-9);
    // an inner layer with no ground pour at all asks nothing
    expect(cuci([...scheda(), ...massaPiena(["top", "bottom"])], { bordo: false, passoMm: 1 }).vie.some((v) => dentro(v.x, v.y, vuoto))).toBe(true);
  });

  it("mai in una piazzola, nemmeno di massa, e lontana dalle piazzole delle altre reti", () => {
    const cj = [...scheda(), ...massaPiena(), ...pad("P1", 0, 0, 3, 3, "top", "k_gnd"), ...pad("P2", 5, 5, 2, 1, "bottom", "k_sig")];
    const e = cuci(cj, { bordo: false, passoMm: 1 });
    const p1 = rameDelPad(cj.find((x) => x.pcb_smtpad_id === "P1")!)!;
    const p2 = rameDelPad(cj.find((x) => x.pcb_smtpad_id === "P2")!)!;
    for (const v of e.vie) {
      expect(distanzaPuntoForma(p1, v.x, v.y) - R).toBeGreaterThanOrEqual(REGOLE.minClearanceMm - 1e-9);
      expect(distanzaPuntoForma(p2, v.x, v.y) - R).toBeGreaterThanOrEqual(REGOLE.pourClearanceMm! - 1e-9);
    }
    expect(e.scarti.piazzola).toBeGreaterThan(0);
  });

  it("fuori dall'ingombro dei pezzi su tutte e due le facce", () => {
    const cj = [...scheda(), ...massaPiena(), ...pezzo("U1", -4, 0, 5, 5, "top"), ...pezzo("U2", 4, 0, 5, 5, "bottom")];
    const e = cuci(cj, { bordo: false, passoMm: 1 });
    for (const v of e.vie) {
      for (const c of [rett(-6.5, -2.5, -1.5, 2.5), rett(1.5, -2.5, 6.5, 2.5)]) {
        const d = dentro(v.x, v.y, c) ? 0 : Math.min(...c.map((a, i) => pointSegDistance(v.x, v.y, a.x, a.y, c[(i + 1) % 4].x, c[(i + 1) % 4].y)));
        expect(d).toBeGreaterThan(R);
      }
    }
    expect(e.scarti.ingombro).toBeGreaterThan(0);
  });

  it("fuori dallo spazio di innesto di un connettore", () => {
    const cj = [
      ...scheda(),
      ...massaPiena(),
      ...pezzo("J1", 0, -7, 3, 2, "top"),
      { type: "pcb_note_path", pcb_note_path_id: "np", pcb_component_id: "J1", route: rett(-2, -6, 2, 2) },
      { type: "pcb_note_text", pcb_note_text_id: "nt", pcb_component_id: "J1", text: "innesto: spina", anchor_position: { x: 0, y: -2 } },
    ];
    const e = cuci(cj, { bordo: false, passoMm: 1 });
    for (const v of e.vie) expect(dentro(v.x, v.y, rett(-2 - R, -6 - R, 2 + R, 2 + R))).toBe(false);
    expect(e.scarti.innesto).toBeGreaterThan(0);
  });

  it("lontana dai fori: fra i fori minHoleToHoleMm, la corona da un foro nudo quanto dal bordo", () => {
    const cj = [...scheda(), ...massaPiena(), { type: "pcb_hole", pcb_hole_id: "h", hole_shape: "circle", hole_diameter: 2, x: 0, y: 0 }];
    const e = cuci(cj, { bordo: false, passoMm: 1 });
    for (const v of e.vie) {
      const d = Math.hypot(v.x, v.y);
      expect(d - 1 - 0.1).toBeGreaterThanOrEqual(REGOLE.minHoleToHoleMm - 1e-9);
      expect(d - 1 - R).toBeGreaterThanOrEqual(REGOLE.minBoardEdgeClearanceMm - 1e-9);
    }
    expect(e.scarti.foro).toBeGreaterThan(0);
  });

  it("mai sul bordo: la corona sta a minBoardEdgeClearanceMm dal contorno, anche la fila sul bordo", () => {
    const cj = [...scheda(), ...colataFinoAlBordo()];
    const e = cuci(cj, { passoMm: 2 });
    expect(e.conteggio.bordo).toBeGreaterThan(0);
    for (const v of e.vie) {
      const dalBordo = Math.min(10 - Math.abs(v.x), 10 - Math.abs(v.y));
      expect(dalBordo - R).toBeGreaterThanOrEqual(REGOLE.minBoardEdgeClearanceMm - 1e-9);
    }
    expect(e.scarti.bordo).toBeGreaterThan(0);
  });

  it("lontana dalle piste di altre reti su ogni strato, anche dove quello strato non ha massa", () => {
    // ground on top, inner1 and bottom; a signal trace on inner2, where there is no ground
    const cj = [...scheda(), ...massaPiena(["top", "inner1", "bottom"]), ...pista("t", [{ x: -9, y: 0 }, { x: 9, y: 0 }], "inner2", 0.2, "k_sig")];
    const e = cuci(cj, { bordo: false, passoMm: 1 });
    for (const v of e.vie) expect(Math.abs(v.y) - 0.1 - R).toBeGreaterThanOrEqual(REGOLE.pourClearanceMm! - 1e-9);
    expect(e.scarti.pista_altra_rete).toBeGreaterThan(0);
    // and farther when asked: from the traces, and from a net named in retiLontane
    const piu = cuci(cj, { bordo: false, passoMm: 1, distanzaPisteMm: 1 });
    for (const v of piu.vie) expect(Math.abs(v.y) - 0.1 - R).toBeGreaterThanOrEqual(1 - 1e-9);
    const radio = cuci(cj, { bordo: false, passoMm: 1, retiLontane: [{ rete: "SIG", distanzaMm: 2 }] });
    for (const v of radio.vie) expect(Math.abs(v.y) - 0.1 - R).toBeGreaterThanOrEqual(2 - 1e-9);
    expect(radio.scarti.rete_lontana).toBeGreaterThan(0);
  });

  it("dalle vie esistenti: le corone e i fori a distanza, e niente via dove una di massa cuce gia'", () => {
    const cj = [...scheda(), ...massaPiena(), viaEsistente(0.4, 0.2, "k_sig"), viaEsistente(5.2, 5.1, "k_gnd")];
    const e = cuci(cj, { bordo: false, passoMm: 2 });
    for (const v of e.vie) {
      expect(Math.hypot(v.x - 0.4, v.y - 0.2) - 0.225 - R).toBeGreaterThanOrEqual(REGOLE.pourClearanceMm! - 1e-9);
      expect(Math.hypot(v.x - 5.2, v.y - 5.1)).toBeGreaterThanOrEqual(1 - 1e-6);
    }
    expect((e.scarti.via_esistente ?? 0) + (e.scarti.gia_cucita ?? 0)).toBeGreaterThan(0);
  });

  it("fuori dalle zone vietate della scheda e da quelle della chiamata", () => {
    const cj = [...scheda(), ...massaPiena(), { type: "pcb_keepout", pcb_keepout_id: "k", shape: "circle", center: { x: -4, y: 0 }, radius: 2, layers: ["bottom"] }];
    const e = cuci(cj, { bordo: false, passoMm: 1, zoneEscluse: [{ x: 4, y: 0, w: 3, h: 3 }, { punti: [{ x: 0, y: 5 }, { x: 3, y: 8 }, { x: -3, y: 8 }] }] });
    for (const v of e.vie) {
      expect(Math.hypot(v.x + 4, v.y) - 2).toBeGreaterThanOrEqual(R - 1e-9);
      expect(dentro(v.x, v.y, rett(2.5 - R, -1.5 - R, 5.5 + R, 1.5 + R))).toBe(false);
      expect(dentro(v.x, v.y, [{ x: 0, y: 5 }, { x: 3, y: 8 }, { x: -3, y: 8 }])).toBe(false);
    }
    expect(e.scarti.zona_vietata).toBeGreaterThan(0);
    expect(e.scarti.zona_esclusa).toBeGreaterThan(0);
  });

  it("mai col foro sotto la serigrafia: tratti e testi delle due facce, a minSilkscreenClearanceMm", () => {
    const riga: El = { type: "pcb_silkscreen_path", pcb_silkscreen_path_id: "s1", layer: "top", stroke_width: 0.15, route: [{ x: -9, y: 0.9 }, { x: 9, y: 0.9 }] };
    const testo: El = { type: "pcb_silkscreen_text", pcb_silkscreen_text_id: "t1", layer: "bottom", text: "MASSA", font_size: 1.5, anchor_position: { x: 0, y: -5 }, anchor_alignment: "center" };
    const base = [...scheda(), ...massaPiena()];
    const cj = [...base, riga, testo];
    const senzaRegola = cuci(base, { bordo: false, passoMm: 1 });
    const e = cuci(cj, { bordo: false, passoMm: 1 });
    expect(e.vie.length).toBeGreaterThan(50);
    expect(e.vie.length).toBeLessThan(senzaRegola.vie.length);
    expect(e.scarti.serigrafia).toBeGreaterThan(0);
    // the stroke as it prints is 0.15 wide: the hole (0.2) keeps 0.15 from its edge
    for (const v of e.vie) expect(Math.abs(v.y - 0.9) - 0.075 - 0.1).toBeGreaterThanOrEqual(0.15 - 1e-9);
    // the compile's own check: no hole under the ink, on either face; the same vias placed without looking at it have some
    const sottoInchiostro = (vie: EsitoCucitura) =>
      conflittiDiSerigrafia([...cj, ...vieComeElementi(vie, cj)], 0.15).filter((c) => c.tipo === "serigrafia_foro");
    expect(sottoInchiostro(e)).toEqual([]);
    const prima = sottoInchiostro(senzaRegola);
    expect(prima.some((c) => c.faccia === "top")).toBe(true);
    expect(prima.some((c) => c.faccia === "bottom")).toBe(true);
  });

  it("una serigrafia piu' larga per regola del progetto tiene il foro piu' lontano", () => {
    const riga: El = { type: "pcb_silkscreen_path", pcb_silkscreen_path_id: "s1", layer: "bottom", stroke_width: 0.15, route: [{ x: -9, y: 0.6 }, { x: 9, y: 0.6 }] };
    const cj = [...scheda(), ...massaPiena(), riga];
    const e = cuciLaMassa(cj, { ...REGOLE, minSilkscreenClearanceMm: 0.5 }, { bordo: false, passoMm: 1 }) as EsitoCucitura;
    expect(e.vie.length).toBeGreaterThan(50);
    for (const v of e.vie) expect(Math.abs(v.y - 0.6) - 0.075 - 0.1).toBeGreaterThanOrEqual(0.5 - 1e-9);
  });
});

/** a ground pour that reaches the board edge as the band leaves it (0.3), on every layer */
function colataFinoAlBordo(): El[] {
  return massaPiena();
}

describe("la griglia", () => {
  // the planes tied by one ground via in a corner, as on a real board: otherwise each layer is an island of its own
  const cj = () => [...scheda(30, 30), ...massaPiena(STRATI, 30, 30), viaEsistente(-14, -14, "k_gnd")];

  it("e' deterministica: stessa scheda, stesse vie nello stesso ordine", () => {
    const a = cuci(cj());
    const b = cuci(cj());
    expect(b.vie).toEqual(a.vie);
    expect(b.scarti).toEqual(a.scarti);
  });

  it("sfalsata: righe a passo per radice di 3 mezzi, una si' e una no spostata di mezzo passo, sei vicine a un passo", () => {
    const e = cuci(cj(), { bordo: false, passoMm: 2.5 });
    const righe = [...new Set(e.vie.map((v) => v.y))].sort((a, b) => a - b);
    const passoRiga = (2.5 * Math.sqrt(3)) / 2;
    for (let i = 1; i < righe.length; i++) expect(righe[i] - righe[i - 1]).toBeCloseTo(passoRiga, 2);
    const dellaRiga = (y: number) => e.vie.filter((v) => v.y === y).map((v) => v.x).sort((a, b) => a - b);
    const r0 = dellaRiga(righe[0]);
    const r1 = dellaRiga(righe[1]);
    const scarto = Math.abs(((r1[0] - r0[0]) % 2.5) + 2.5) % 2.5;
    expect(scarto).toBeCloseTo(1.25, 2);
    // the nearest neighbour of every via is one pitch away
    for (const v of e.vie.slice(0, 40)) {
      const vicina = Math.min(...e.vie.filter((w) => w !== v).map((w) => Math.hypot(w.x - v.x, w.y - v.y)));
      expect(vicina).toBeCloseTo(2.5, 2);
    }
  });

  it("regolare: quadrata", () => {
    const e = cuci(cj(), { bordo: false, passoMm: 2, sfalsata: false });
    for (const v of e.vie) {
      expect(Math.abs(v.x / 2 - Math.round(v.x / 2))).toBeLessThan(1e-6);
      expect(Math.abs(v.y / 2 - Math.round(v.y / 2))).toBeLessThan(1e-6);
    }
  });

  it("il tetto: non piu' di maxVie, detto, e le vie messe sparse su tutta la scheda", () => {
    const e = cuci(cj(), { bordo: false, passoMm: 1, maxVie: 9 });
    expect(e.vie).toHaveLength(9);
    expect(e.tetto.raggiunto).toBe(true);
    expect(e.scarti.tetto).toBeGreaterThan(0);
    expect(e.avvisi.join(" ")).toMatch(/tetto di 9 vie/);
    // the sparsest lattice first: the nine are spread, never two at less than four pitches
    for (const v of e.vie) {
      const vicina = Math.min(...e.vie.filter((w) => w !== v).map((w) => Math.hypot(w.x - v.x, w.y - v.y)));
      expect(vicina).toBeGreaterThanOrEqual(4 - 1e-6);
    }
  });

  it("niente grumi fra la fila sul bordo e la griglia", () => {
    const e = cuci(cj(), { passoMm: 2.5 });
    for (const v of e.vie) {
      const vicina = Math.min(...e.vie.filter((w) => w !== v).map((w) => Math.hypot(w.x - v.x, w.y - v.y)));
      expect(vicina).toBeGreaterThanOrEqual(1.25 - 1e-6);
    }
  });
});

describe("le isole di massa", () => {
  // an island on top inside a hole of the top plane, ground below it on the other layers
  const isola = rett(-2, -2, 2, 2);
  const buco = rett(-2.3, -2.3, 2.3, 2.3);
  const base = () => [
    ...scheda(),
    colata("top", rett(-9.7, -9.7, 9.7, 9.7), "source_net_0", [buco]),
    colata("top", isola),
    ...massaPiena(["inner1", "inner2", "bottom"]),
    // the main plane is one: a ground via ties top to the rest
    viaEsistente(-6, -6, "k_gnd"),
  ];

  it("una via in ogni isola, prima della griglia", () => {
    const e = cuci(base());
    expect(e.isole.trovate).toBe(1);
    expect(e.isole.collegate).toHaveLength(1);
    expect(e.isole.collegate[0].strato).toBe("top");
    expect(e.isole.collegate[0].areaMm2).toBeCloseTo(16, 3);
    expect(e.vie[0].tipo).toBe("isola");
    expect(dentro(e.vie[0].x, e.vie[0].y, isola)).toBe(true);
    expect(e.conteggio.isola).toBe(1);
  });

  it("l'isola dove non ci sta nessuna via: elencata con area e motivo", () => {
    const cj = [...base(), { type: "pcb_keepout", pcb_keepout_id: "k", shape: "rect", center: { x: 0, y: 0 }, width: 5, height: 5, layers: ["top"] }];
    const e = cuci(cj);
    expect(e.isole.collegate).toHaveLength(0);
    expect(e.isole.senzaPosto).toEqual([expect.objectContaining({ strato: "top", areaMm2: 16, motivo: "zona_vietata" })]);
  });

  it("collegata da una via di massa o da una pista con una via, non e' un'isola", () => {
    const conVia = cuci([...base(), viaEsistente(0, 0, "k_gnd")]);
    expect(conVia.isole.trovate).toBe(0);
    const conPista = cuci([
      ...base(),
      ...pista("g", [{ x: 0, y: 0 }, { x: 0, y: 3 }], "top", 0.2, "k_gnd"),
      ...pista("g2", [{ x: 0, y: 3 }, { x: 5, y: 3 }], "top", 0.2, "k_gnd"),
    ]);
    expect(conPista.isole.trovate).toBe(0);
  });

  it("due colate dello stesso strato che si sovrappongono sono un rame solo", () => {
    // a strip on top that reaches over the hole's edge onto the plane: one copper with it, not an island
    const e = cuci([...base(), colata("top", rett(1.5, -0.5, 3, 0.5))]);
    expect(e.isole.trovate).toBe(0);
  });
});

describe("la rete", () => {
  it("GND quando e' anche quella con le colate piu' grandi; ambigua lo dice, con le candidate", () => {
    const cj = [...scheda(), ...massaPiena()];
    expect(sceltaDellaRete(cj)).toEqual({ id: "source_net_0", nome: "GND" });
    const ambigua = sceltaDellaRete([...cj, ...STRATI.map((s) => colata(s, rett(-9.9, -9.9, 9.9, 9.9), "source_net_1")), ...STRATI.map((s) => colata(s, rett(-9.9, -9.9, 9.9, 9.9), "source_net_1"))]);
    expect(ambigua).toMatchObject({ ok: false, errore: expect.stringMatching(/ambigua/) });
    expect((ambigua as { candidate: unknown[] }).candidate.length).toBeGreaterThan(1);
    expect(sceltaDellaRete(cj, "NOPE")).toMatchObject({ ok: false });
  });

  it("foro e corona mai sotto i minimi del progetto, e detto", () => {
    const e = cuciLaMassa([...scheda(), ...massaPiena()], { ...REGOLE, minViaHoleMm: 0.3, minViaDiameterMm: 0.6 }, { bordo: false }) as EsitoCucitura;
    expect(e.via).toEqual({ foroMm: 0.3, coronaMm: 0.6 });
    expect(e.avvisi.join(" ")).toMatch(/minViaHoleMm/);
  });

  it("lambda/20 nel FR4: 2,5 mm copre fino a circa 2,9 GHz, 2,7 mm a 2,7 GHz, 4,6 mm a 1,575 GHz", () => {
    expect(frequenzaCoperta(2.5)).toBeCloseTo(2.89, 2);
    expect(frequenzaCoperta(2.68)).toBeCloseTo(2.7, 1);
    expect(frequenzaCoperta(4.59)).toBeCloseTo(1.575, 2);
  });
});

describe("i controlli esistenti sulla scheda con le vie", () => {
  it("nessuna violazione nuova del DRC con le vie aggiunte in memoria", () => {
    const cj = [
      ...scheda(),
      ...massaPiena(["top", "inner1", "bottom"]),
      ...pista("t", [{ x: -9, y: 0 }, { x: 9, y: 0 }], "inner2", 0.2, "k_sig"),
      ...pad("P1", 3, 3, 1, 1, "top", "k_gnd"),
      ...pad("P2", -3, 3, 1, 1, "top", "k_sig"),
      viaEsistente(5, -5, "k_sig"),
    ];
    const e = cuci(cj, { passoMm: 1.5 });
    expect(e.vie.length).toBeGreaterThan(20);
    const prima = runDrcChecks(cj, REGOLE).map((v) => `${v.rule}:${v.count ?? 1}`).sort();
    const dopo = runDrcChecks([...cj, ...vieComeElementi(e, cj)], REGOLE).map((v) => `${v.rule}:${v.count ?? 1}`).sort();
    expect(dopo).toEqual(prima);
  });

  it("i Gerber di una scheda senza cucitura non cambiano, e la scheda in ingresso resta com'era", () => {
    const cj = [...scheda(), ...massaPiena(), ...pad("P1", 3, 3, 1, 1, "top", "k_gnd")];
    const json = JSON.stringify(cj);
    // the Gerber writes the moment it was made: that is not the board
    const gerber = () =>
      JSON.stringify(stringifyGerberCommandLayers(convertSoupToGerberCommands(viePassantiSuOgniStrato(cj as never[]) as never))).replace(
        /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g,
        "<data>",
      );
    const prima = gerber();
    cuci(cj);
    expect(JSON.stringify(cj)).toBe(json);
    expect(gerber()).toEqual(prima);
  });
});

describe("i parametri", () => {
  it("limiti e campi sconosciuti rifiutati con il motivo, senza ripetere il testo mandato", () => {
    const r = leggiOpzioniCucitura({ passoMm: 0.5, maxVie: 5000, foroMm: "0.2", boh: 1, rete: "GND; drop table" });
    expect("errori" in r).toBe(true);
    const testo = (r as { errori: string[] }).errori.join(" | ");
    expect(testo).toMatch(/passoMm: 0.5 fuori dai limiti 1..10/);
    expect(testo).toMatch(/maxVie: 5000 fuori dai limiti 1..3000/);
    expect(testo).toMatch(/foroMm: deve essere un numero/);
    expect(testo).toMatch(/boh: campo sconosciuto/);
    expect(testo).not.toMatch(/drop table/);
    expect(leggiOpzioniCucitura({ dryRun: true, apply: true })).toMatchObject({ errori: [expect.stringMatching(/dryRun e apply/)] });
    expect(leggiOpzioniCucitura({ passoMm: 2.5, apply: true })).toEqual({ opzioni: { passoMm: 2.5 }, apply: true });
  });
});

describe("il file cucitura-massa.tsx", () => {
  const cj = () => [...scheda(), ...massaPiena(), ...pad("P1", 3, 3, 1, 1, "top", "k_gnd"), viaEsistente(-6, -6, "k_gnd")];
  const regole = { "design-rules.json": JSON.stringify({ preset: "custom", rules: { minViaHoleMm: 0.15, minViaDiameterMm: 0.45, minClearanceMm: 0.152, pourClearanceMm: 0.2 } }) };
  const scritti: Record<string, string> = {};
  const scrivi = async (path: string, content: string) => {
    scritti[path] = content;
  };

  it("dryRun non scrive niente; apply scrive le via con rete, foro e corona espliciti, e dice la riga per main.tsx", async () => {
    const guarda = await eseguiCucitura({ files: { ...regole, "main.tsx": "export default () => <board />" }, args: {}, cache: { circuitJson: cj() }, schedaVecchia: false, scrivi });
    expect(guarda.fileChanged).toBeUndefined();
    expect(scritti[FILE_CUCITURA]).toBeUndefined();
    expect(guarda.result).toMatchObject({ ok: true, scritto: false, main: { usaIlFile: false } });
    const scrive = await eseguiCucitura({ files: { ...regole, "main.tsx": "export default () => <board />" }, args: { apply: true }, cache: { circuitJson: cj() }, schedaVecchia: false, scrivi });
    const testo = scritti[FILE_CUCITURA];
    expect(scrive.result).toMatchObject({ ok: true, scritto: true });
    expect(scrive.fileChanged?.content).toBe(testo);
    expect(testo).toMatch(/^export const CucituraMassa = \(\) => \($/m);
    expect(testo).toMatch(/<via name="VCM1" pcbX=\{-?[\d.]+\} pcbY=\{-?[\d.]+\} connectsTo="net.GND" fromLayer="top" toLayer="bottom" holeDiameter=\{0.2\} outerDiameter=\{0.5\} \/>/);
    expect(vieDelFile(testo)).toHaveLength((scrive.result.vie as number));
    expect((scrive.result.main as { righeDaAggiungere: string[] }).righeDaAggiungere[0]).toBe('import { CucituraMassa } from "./cucitura-massa"');
  });

  it("rilanciato riscrive lo stesso file, sulla scheda compilata con le vie o su quella di prima", async () => {
    const files = { ...regole, "main.tsx": 'import { CucituraMassa } from "./cucitura-massa"\nexport default () => <board><CucituraMassa /></board>' };
    const uno = await eseguiCucitura({ files, args: { apply: true }, cache: { circuitJson: cj() }, schedaVecchia: false, scrivi });
    const primo = uno.fileChanged!.content;
    expect(uno.result.main).toEqual({ usaIlFile: true });
    // the board compiled with the file: its vias are on it now, where the file puts them
    const scritte = { rete: { id: "source_net_0", nome: "GND" }, via: uno.result.via, vie: vieDelFile(primo).map((p) => ({ ...p, tipo: "griglia" })) } as EsitoCucitura;
    expect(scritte.vie.length).toBeGreaterThan(10);
    const compilata = [...cj(), ...vieComeElementi(scritte, cj())];
    const due = await eseguiCucitura({ files: { ...files, [FILE_CUCITURA]: primo }, args: { apply: true }, cache: { circuitJson: compilata }, schedaVecchia: false, scrivi });
    expect(due.fileChanged!.content).toBe(primo);
    const tre = await eseguiCucitura({ files: { ...files, [FILE_CUCITURA]: primo }, args: { apply: true }, cache: { circuitJson: cj() }, schedaVecchia: true, scrivi });
    expect(tre.fileChanged!.content).toBe(primo);
    expect(tre.result.schedaPiuVecchiaDeiFile).toBe(true);
  });

  it("main.tsx che lo usa davvero, non in un commento", () => {
    expect(mainLaUsa('// import { CucituraMassa } from "./cucitura-massa"\nexport default () => <board />')).toBe(false);
    expect(mainLaUsa('import { CucituraMassa } from "./cucitura-massa"\nexport default () => <board><CucituraMassa /></board>')).toBe(true);
  });

  it("una rete che net.<nome> non sa scrivere non si scrive", () => {
    const e = cuci([...scheda(), ...massaPiena()]);
    expect(fileDellaCucitura({ ...e, rete: { id: "x", nome: "GND-1" } })).toMatchObject({ errore: expect.any(String) });
  });

  it("senza scheda salvata lo dice", async () => {
    const r = await eseguiCucitura({ files: {}, args: {}, cache: null, schedaVecchia: null, scrivi });
    expect(r.result.error).toMatch(/compila prima/);
  });
});
