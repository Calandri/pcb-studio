import { convertSoupToGerberCommands, stringifyGerberCommandLayers } from "circuit-json-to-gerber";
import { describe, expect, it } from "vitest";
import { schematicKeyOf, soloCioCheLeggeLoSchematico } from "@/lib/compile";
import { DEFAULT_DESIGN_RULES, type DesignRules } from "@/lib/design-rules";
import { distanzaPuntoForma, pointSegDistance, rameDelPad, runDrcChecks } from "@/lib/drc";
import { cuciLaMassa, frequenzaCoperta, leggiOpzioniCucitura, MAX_VIE_DI_SERIE, MAX_VIE_LIMITE, sceltaDellaRete, senzaLeVieAi, type EsitoCucitura, type OpzioniCucitura } from "@/lib/ground-stitching";
import { chiLaUsa, FILE_CUCITURA, fileDellaCucitura, leggiFileDellaCucitura, mainLaUsa, vieComeElementi, vieDelFile } from "@/lib/ground-stitching-file";
import { eseguiCucitura, improntaDelFile, statoDellaScheda } from "@/lib/ground-stitching-tool";
import { MAX_FILE_CHARS } from "@/lib/project-file-limits";
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
/** the write as every door does it: a look first, then apply with the fingerprint of what the look proposed */
const scriviVisto = async (p: Parameters<typeof eseguiCucitura>[0]) => {
  const guarda = { ...p.args };
  delete guarda.apply;
  const visto = await eseguiCucitura({ ...p, args: guarda, scrivi: async () => { throw new Error("un dryRun non scrive"); } });
  return eseguiCucitura({ ...p, args: { ...guarda, apply: true, impronta: visto.result.impronta } });
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
    expect(e.vie.length).toBeGreaterThan(20);
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
    expect(e.vie.length).toBeGreaterThan(100);
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
    expect(e.vie.length).toBeGreaterThan(100);
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
    expect(e.vie.length).toBeGreaterThan(100);
    for (const v of e.vie) expect(dentro(v.x, v.y, rett(-2 - R, -6 - R, 2 + R, 2 + R))).toBe(false);
    expect(e.scarti.innesto).toBeGreaterThan(0);
  });

  it("lontana dai fori: fra i fori minHoleToHoleMm, la corona da un foro nudo quanto dal bordo", () => {
    const cj = [...scheda(), ...massaPiena(), { type: "pcb_hole", pcb_hole_id: "h", hole_shape: "circle", hole_diameter: 2, x: 0, y: 0 }];
    const e = cuci(cj, { bordo: false, passoMm: 1 });
    expect(e.vie.length).toBeGreaterThan(100);
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

  it("fuori dai ritagli della scheda, anche quelli scritti come percorso (una fessura fresata lungo una linea)", () => {
    // the pours are whole: nothing but the cutout says the board is open there
    const fessura = [{ x: -6, y: -2 }, { x: 0, y: -2 }, { x: 4, y: 3 }];
    const cj = [
      ...scheda(),
      ...massaPiena(),
      { type: "pcb_cutout", pcb_cutout_id: "f", shape: "path", route: fessura, slot_width: 1 },
      { type: "pcb_cutout", pcb_cutout_id: "p", shape: "polygon", points: rett(5, -8, 8, -5) },
      { type: "pcb_cutout", pcb_cutout_id: "r", shape: "rect", center: { x: -6, y: 6 }, width: 3, height: 2 },
      { type: "pcb_cutout", pcb_cutout_id: "c", shape: "circle", center: { x: 6, y: 7 }, radius: 1 },
    ];
    const e = cuci(cj, { bordo: false, passoMm: 1 });
    expect(e.vie.length).toBeGreaterThan(100);
    const dallaFessura = (v: P) => Math.min(...fessura.slice(1).map((b, i) => pointSegDistance(v.x, v.y, fessura[i].x, fessura[i].y, b.x, b.y))) - 0.5;
    for (const v of e.vie) {
      // the ring as far from the milled edge as from the board's
      expect(dallaFessura(v) - R).toBeGreaterThanOrEqual(REGOLE.minBoardEdgeClearanceMm - 1e-9);
      expect(dentro(v.x, v.y, rett(5 - R - 0.3, -8 - R - 0.3, 8 + R + 0.3, -5 + R + 0.3))).toBe(false);
      expect(dentro(v.x, v.y, rett(-7.5 - R - 0.3, 5 - R - 0.3, -4.5 + R + 0.3, 7 + R + 0.3))).toBe(false);
      expect(Math.hypot(v.x - 6, v.y - 7) - 1 - R).toBeGreaterThanOrEqual(REGOLE.minBoardEdgeClearanceMm - 1e-9);
    }
    // without the slot the same grid has vias where it runs
    const senza = cuci(cj.filter((el) => el.pcb_cutout_id !== "f"), { bordo: false, passoMm: 1 });
    expect(senza.vie.filter((v) => dallaFessura(v) - R < REGOLE.minBoardEdgeClearanceMm).length).toBeGreaterThan(10);
    expect(e.vie.length).toBeLessThan(senza.vie.length);
  });

  it("lontana dalle piste di altre reti su ogni strato, anche dove quello strato non ha massa", () => {
    // ground on top, inner1 and bottom; a signal trace on inner2, where there is no ground
    const cj = [...scheda(), ...massaPiena(["top", "inner1", "bottom"]), ...pista("t", [{ x: -9, y: 0 }, { x: 9, y: 0 }], "inner2", 0.2, "k_sig")];
    const e = cuci(cj, { bordo: false, passoMm: 1 });
    expect(e.vie.length).toBeGreaterThan(100);
    for (const v of e.vie) expect(Math.abs(v.y) - 0.1 - R).toBeGreaterThanOrEqual(REGOLE.pourClearanceMm! - 1e-9);
    expect(e.scarti.pista_altra_rete).toBeGreaterThan(0);
    // and farther when asked: from the traces, and from a net named in retiLontane
    const piu = cuci(cj, { bordo: false, passoMm: 1, distanzaPisteMm: 1 });
    expect(piu.vie.length).toBeGreaterThan(50);
    for (const v of piu.vie) expect(Math.abs(v.y) - 0.1 - R).toBeGreaterThanOrEqual(1 - 1e-9);
    const radio = cuci(cj, { bordo: false, passoMm: 1, retiLontane: [{ rete: "SIG", distanzaMm: 2 }] });
    expect(radio.vie.length).toBeGreaterThan(50);
    for (const v of radio.vie) expect(Math.abs(v.y) - 0.1 - R).toBeGreaterThanOrEqual(2 - 1e-9);
    expect(radio.scarti.rete_lontana).toBeGreaterThan(0);
  });

  it("dalle vie esistenti: le corone e i fori a distanza, e niente via dove una di massa cuce gia'", () => {
    const cj = [...scheda(), ...massaPiena(), viaEsistente(0.4, 0.2, "k_sig"), viaEsistente(5.2, 5.1, "k_gnd")];
    const e = cuci(cj, { bordo: false, passoMm: 2 });
    expect(e.vie.length).toBeGreaterThan(20);
    for (const v of e.vie) {
      expect(Math.hypot(v.x - 0.4, v.y - 0.2) - 0.225 - R).toBeGreaterThanOrEqual(REGOLE.pourClearanceMm! - 1e-9);
      expect(Math.hypot(v.x - 5.2, v.y - 5.1)).toBeGreaterThanOrEqual(1 - 1e-6);
    }
    expect((e.scarti.via_esistente ?? 0) + (e.scarti.gia_cucita ?? 0)).toBeGreaterThan(0);
  });

  it("fuori dalle zone vietate della scheda e da quelle della chiamata", () => {
    const cj = [...scheda(), ...massaPiena(), { type: "pcb_keepout", pcb_keepout_id: "k", shape: "circle", center: { x: -4, y: 0 }, radius: 2, layers: ["bottom"] }];
    const e = cuci(cj, { bordo: false, passoMm: 1, zoneEscluse: [{ x: 4, y: 0, w: 3, h: 3 }, { punti: [{ x: 0, y: 5 }, { x: 3, y: 8 }, { x: -3, y: 8 }] }] });
    expect(e.vie.length).toBeGreaterThan(100);
    for (const v of e.vie) {
      expect(Math.hypot(v.x + 4, v.y) - 2).toBeGreaterThanOrEqual(R - 1e-9);
      expect(dentro(v.x, v.y, rett(2.5 - R, -1.5 - R, 5.5 + R, 1.5 + R))).toBe(false);
      expect(dentro(v.x, v.y, [{ x: 0, y: 5 }, { x: 3, y: 8 }, { x: -3, y: 8 }])).toBe(false);
    }
    expect(e.scarti.zona_vietata).toBeGreaterThan(0);
    expect(e.scarti.zona_esclusa).toBeGreaterThan(0);
  });

  describe("le zone vietate (keepout), strato per strato", () => {
    const zona = (id: string, x: number, y: number, w: number, h: number, layers: string[], extra: Record<string, unknown> = {}): El => ({
      type: "pcb_keepout", pcb_keepout_id: id, shape: "rect", center: { x, y }, width: w, height: h, layers, ...extra,
    });
    const nella = (v: P, x: number, y: number, w: number, h: number) => dentro(v.x, v.y, rett(x - w / 2 - R, y - h / 2 - R, x + w / 2 + R, y + h / 2 + R));
    /*
     * Three zones on a board with ground on every layer:
     *  - "altezza": top only, a part's height zone, the ground whole under it;
     *  - "antenna": every layer, and the copper taken out of every layer under it;
     *  - "finestra": top only, the top copper taken out under it, the other layers whole.
     */
    const buco = rett(3, -8, 8, -3);
    const finestra = rett(3, 3, 8, 8);
    const cj = [
      ...scheda(),
      colata("top", rett(-9.7, -9.7, 9.7, 9.7), "source_net_0", [buco, finestra]),
      ...massaPiena(["inner1", "inner2", "bottom"], 20, 20, [buco]),
      viaEsistente(9, 0, "k_gnd"),
      zona("altezza", -5, 0, 6, 8, ["top", "top"], { description: "TASTO H7,6 <b>alto</b>" }),
      zona("antenna", 5.5, -5.5, 5, 5, ["top", "inner1", "inner2", "bottom"]),
      zona("finestra", 5.5, 5.5, 5, 5, ["top"]),
    ];

    it("di serie contano tutte, e la risposta dice quali escludono posizioni, su quali strati, quante, e se sotto c'e' la massa", () => {
      const e = cuci(cj, { bordo: false, passoMm: 1 });
      expect(e.vie.length).toBeGreaterThan(100);
      for (const v of e.vie) {
        expect(nella(v, -5, 0, 6, 8)).toBe(false);
        expect(nella(v, 5.5, -5.5, 5, 5)).toBe(false);
        expect(nella(v, 5.5, 5.5, 5, 5)).toBe(false);
      }
      expect(e.keepout.modo).toBe("tutti");
      expect(e.keepout.posizioni).toBe(e.scarti.zona_vietata);
      const perId = Object.fromEntries(e.keepout.escludono.map((k) => [k.id, k]));
      expect(Object.keys(perId).sort()).toEqual(["altezza", "antenna", "finestra"]);
      // the height zone: ground under it, and most of its positions had a place
      expect(perId.altezza).toMatchObject({ descrizione: "TASTO H7,6 b alto /b", x: -5, y: 0, strati: ["top"], massaSotto: true, massaPerStrato: { top: 1 }, vie: 0 });
      expect(perId.altezza.posizioni).toBeGreaterThan(40);
      expect(perId.altezza.conPosto).toBeGreaterThan(40);
      // the two where the copper was taken out: no ground under them, and no position there had a place anyway
      expect(perId.antenna).toMatchObject({ descrizione: "rettangolo 5 x 5 mm", strati: ["top", "inner1", "inner2", "bottom"], massaSotto: false, massaPerStrato: { top: 0, inner1: 0, inner2: 0, bottom: 0 }, conPosto: 0 });
      expect(perId.finestra).toMatchObject({ strati: ["top"], massaSotto: false, massaPerStrato: { top: 0 }, conPosto: 0 });
      expect(e.keepout.conPosto).toBe(perId.altezza.conPosto);
      // the one that costs vias comes first
      expect(e.keepout.escludono[0].id).toBe("altezza");
    });

    it("solo_rame: non conta la zona con la massa colata sotto su tutti i suoi strati; quelle dove il rame e' stato tolto contano sempre", () => {
      const tutti = cuci(cj, { bordo: false, passoMm: 1 });
      const e = cuci(cj, { bordo: false, passoMm: 1, keepout: "solo_rame" });
      const nellAltezza = e.vie.filter((v) => dentro(v.x, v.y, rett(-8, -4, -2, 4)));
      expect(nellAltezza.length).toBeGreaterThan(40);
      expect(e.vie.length).toBe(tutti.vie.length + tutti.keepout.conPosto);
      for (const v of e.vie) {
        expect(nella(v, 5.5, -5.5, 5, 5)).toBe(false);
        expect(nella(v, 5.5, 5.5, 5, 5)).toBe(false);
      }
      const perId = Object.fromEntries(e.keepout.escludono.map((k) => [k.id, k]));
      expect(perId.altezza).toMatchObject({ massaSotto: true, posizioni: 0 });
      expect(perId.altezza.vie).toBeGreaterThanOrEqual(nellAltezza.length);
      expect(perId.antenna.posizioni).toBeGreaterThan(0);
      expect(e.avvisi.join(" ")).toMatch(/keepout "solo_rame": \d+ vie stanno dentro zone vietate/);
      // and the board is as clean as before
      const prima = runDrcChecks(cj, REGOLE).map((v) => `${v.rule}:${v.count ?? 1}`).sort();
      expect(runDrcChecks([...cj, ...vieComeElementi(e, cj)], REGOLE).map((v) => `${v.rule}:${v.count ?? 1}`).sort()).toEqual(prima);
    });

    it("solo_rame: una zona con la massa sotto meno di meta', o su uno solo dei suoi strati, conta", () => {
      // ground under a third of the zone only, on its one layer
      const poca = [...scheda(), colata("top", rett(-9.7, -9.7, 9.7, 9.7), "source_net_0", [rett(-4, -3, 3, 3)]), ...massaPiena(["inner1", "inner2", "bottom"]), viaEsistente(9, 0, "k_gnd"), zona("z", -1, 0, 9, 6, ["top"])];
      const a = cuci(poca, { bordo: false, passoMm: 1, keepout: "solo_rame" });
      expect(a.keepout.escludono[0]).toMatchObject({ id: "z", massaSotto: false });
      expect(a.keepout.escludono[0].massaPerStrato.top).toBeLessThan(0.5);
      for (const v of a.vie) expect(nella(v, -1, 0, 9, 6)).toBe(false);
      // top and bottom named, ground only under the top: the bottom was kept clear
      const unoSolo = [...scheda(), ...massaPiena(["top", "inner1", "inner2"]), colata("bottom", rett(-9.7, -9.7, 9.7, 9.7), "source_net_0", [rett(-4, -4, 4, 4)]), viaEsistente(9, 0, "k_gnd"), zona("z", 0, 0, 6, 6, ["top", "bottom"])];
      const b = cuci(unoSolo, { bordo: false, passoMm: 1, keepout: "solo_rame" });
      expect(b.keepout.escludono[0]).toMatchObject({ id: "z", massaSotto: false, massaPerStrato: { top: 1, bottom: 0 } });
      for (const v of b.vie) expect(nella(v, 0, 0, 6, 6)).toBe(false);
      expect(b.vie.length).toBeGreaterThan(100);
    });

    it("il parametro: tutti o solo_rame, nient'altro", () => {
      expect(leggiOpzioniCucitura({ keepout: "solo_rame" })).toEqual({ opzioni: { keepout: "solo_rame" }, apply: false });
      expect(leggiOpzioniCucitura({ keepout: "nessuno" })).toMatchObject({ errori: [expect.stringMatching(/keepout: uno fra tutti, solo_rame/)] });
      expect(leggiOpzioniCucitura({ keepout: true })).toMatchObject({ errori: [expect.stringMatching(/keepout/)] });
    });
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
    expect(e.vie.length).toBeGreaterThan(50);
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
    expect(e.vie.length).toBeGreaterThan(100);
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
    expect(e.vie.length).toBeGreaterThan(50);
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

  it("l'isola col centro occupato ha il suo posto a un capo: si guarda tutta l'isola, non solo il mezzo", () => {
    // a 16 x 3 strip on top in a window of the top plane; a part 13 mm long sits on its middle
    const striscia = rett(-8, -1.5, 8, 1.5);
    const cj = [
      ...scheda(),
      colata("top", rett(-9.7, -9.7, 9.7, 9.7), "source_net_0", [rett(-8.3, -1.8, 8.3, 1.8)]),
      colata("top", striscia),
      ...massaPiena(["inner1", "inner2", "bottom"]),
      viaEsistente(-6, -6, "k_gnd"),
      ...pezzo("U1", 0, 0, 13, 4, "top"),
    ];
    const e = cuci(cj, { bordo: false, passoMm: 10 });
    expect(e.isole.trovate).toBe(1);
    expect(e.isole.senzaPosto).toEqual([]);
    expect(e.isole.collegate).toHaveLength(1);
    expect(e.vie[0].tipo).toBe("isola");
    expect(dentro(e.vie[0].x, e.vie[0].y, striscia)).toBe(true);
    expect(Math.abs(e.vie[0].x)).toBeGreaterThan(6.5 + R);
  });

  it("le isole si ricontano dopo la griglia: quella che stava solo sopra un'altra isola ha la sua via quando l'altra e' sul piano", () => {
    /*
     * Two layers. On top a strip A (10 x 1) in a window of the top plane; on the
     * bottom a square B (3 x 3, smaller than A, so looked at after it) in a window
     * of the bottom plane, under the left end of A; under the rest of A the bottom
     * has no copper. A via in A reaches only B; B gets its own where the top plane
     * is over it; then A has its place.
     */
    const a = rett(-5, -0.5, 5, 0.5);
    const b = rett(-5.5, -1.5, -2.5, 1.5);
    const cj = [
      { type: "pcb_board", pcb_board_id: "b", width: 20, height: 20, center: { x: 0, y: 0 }, num_layers: 2 },
      { type: "source_net", source_net_id: "source_net_0", name: "GND", subcircuit_connectivity_map_key: "k_gnd", subcircuit_id: "s" },
      colata("top", rett(-9.7, -9.7, 9.7, 9.7), "source_net_0", [rett(-5.3, -0.8, 5.3, 0.8)]),
      colata("top", a),
      colata("bottom", rett(-9.7, -9.7, 9.7, 9.7), "source_net_0", [rett(-5.8, -1.8, 5.8, 1.8)]),
      colata("bottom", b),
      { type: "pcb_via", pcb_via_id: "v0", x: -8, y: -8, outer_diameter: 0.45, hole_diameter: 0.2, layers: ["top", "bottom"], subcircuit_connectivity_map_key: "k_gnd" },
    ];
    const e = cuci(cj, { bordo: false, passoMm: 3 });
    expect(e.isole.trovate).toBe(2);
    expect(e.isole.senzaPosto).toEqual([]);
    expect(e.isole.collegate).toHaveLength(2);
    const diIsola = e.vie.filter((v) => v.tipo === "isola");
    expect(diIsola).toHaveLength(2);
    expect(diIsola.some((v) => dentro(v.x, v.y, a) && dentro(v.x, v.y, b))).toBe(true);
    expect(diIsola.some((v) => dentro(v.x, v.y, b) && !dentro(v.x, v.y, rett(-5.3, -0.8, 5.3, 0.8)))).toBe(true);
  });

  it("un'isola legata da una via della griglia e' collegata, non senza posto", () => {
    /*
     * A 40 x 40 island: its own lattice is 0.283 mm wide (twenty thousand
     * positions of its box) and steps over the only free band, 0.18 mm wide
     * between two keepouts (lattice at 9.948 and 10.231, band 9.97..10.15). The
     * grid has a column at x = 10, in the band.
     */
    const isola = rett(-20, -20, 20, 20);
    const cj = [
      ...scheda(60, 60),
      colata("top", rett(-29.7, -29.7, 29.7, 29.7), "source_net_0", [rett(-20.3, -20.3, 20.3, 20.3)]),
      colata("top", isola),
      ...massaPiena(["inner1", "inner2", "bottom"], 60, 60),
      viaEsistente(-25, -25, "k_gnd"),
      { type: "pcb_keepout", pcb_keepout_id: "k1", shape: "rect", center: { x: -5.14, y: 0 }, width: 29.72, height: 41, layers: ["top"] },
      { type: "pcb_keepout", pcb_keepout_id: "k2", shape: "rect", center: { x: 15.2, y: 0 }, width: 9.6, height: 41, layers: ["top"] },
    ];
    const e = cuci(cj, { bordo: false, passoMm: 2.5, sfalsata: false });
    expect(e.isole.trovate).toBe(1);
    expect(e.conteggio.isola).toBe(0);
    expect(e.vie.filter((v) => dentro(v.x, v.y, isola)).map((v) => v.x)).toContain(10);
    expect(e.isole.senzaPosto).toEqual([]);
    expect(e.isole.collegate).toEqual([expect.objectContaining({ strato: "top", areaMm2: 1600 })]);
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

  it("solo la massa: una rete di alimentazione o di segnale con le sue colate non si cuce, nemmeno chiesta per nome", () => {
    const cj = [
      ...scheda(),
      { type: "source_net", source_net_id: "source_net_2", name: "VBAT", subcircuit_connectivity_map_key: "k_vbat", subcircuit_id: "s" },
      { type: "source_net", source_net_id: "source_net_3", name: "AGND", subcircuit_connectivity_map_key: "k_agnd", subcircuit_id: "s" },
      ...massaPiena(["top", "bottom"]),
      colata("inner1", rett(-9.7, -9.7, 9.7, 9.7), "source_net_2"),
      colata("inner2", rett(-9.7, -9.7, 0, 9.7), "source_net_1"),
      colata("inner2", rett(1, -9.7, 9.7, 9.7), "source_net_3"),
    ];
    for (const rete of ["VBAT", "SIG", "source_net_2"]) {
      const e = cuciLaMassa(cj, REGOLE, { rete });
      expect(e).toMatchObject({ ok: false, errore: expect.stringMatching(/non e' una rete di massa.*mai una rete di alimentazione o di segnale/) });
      // the nets offered instead are grounds only
      expect((e as { candidate: Array<{ nome: string }> }).candidate.map((c) => c.nome).sort()).toEqual(["AGND", "GND"]);
    }
    expect(sceltaDellaRete(cj, "AGND")).toEqual({ id: "source_net_3", nome: "AGND" });
    expect(sceltaDellaRete(cj, "GND")).toEqual({ id: "source_net_0", nome: "GND" });
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
    expect(testo).toMatch(/maxVie: 5000 fuori dai limiti 1..1200/);
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
    const guarda = await eseguiCucitura({ files: { ...regole, "main.tsx": "export default () => <board />" }, args: {}, cache: { circuitJson: cj() }, scheda: "aggiornata", scrivi });
    expect(guarda.fileChanged).toBeUndefined();
    expect(scritti[FILE_CUCITURA]).toBeUndefined();
    expect(guarda.result).toMatchObject({ ok: true, scritto: false, main: { usaIlFile: false } });
    const scrive = await scriviVisto({ files: { ...regole, "main.tsx": "export default () => <board />" }, args: { apply: true }, cache: { circuitJson: cj() }, scheda: "aggiornata", scrivi });
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
    const uno = await scriviVisto({ files, args: { apply: true }, cache: { circuitJson: cj() }, scheda: "aggiornata", scrivi });
    const primo = uno.fileChanged!.content;
    expect(uno.result.main).toEqual({ usaIlFile: true });
    // the board compiled with the file: its vias are on it now, where the file puts them
    const scritte = { rete: { id: "source_net_0", nome: "GND" }, via: uno.result.via, vie: vieDelFile(primo).map((p) => ({ ...p, tipo: "griglia" })) } as EsitoCucitura;
    expect(scritte.vie.length).toBeGreaterThan(10);
    const compilata = [...cj(), ...vieComeElementi(scritte, cj())];
    const due = await scriviVisto({ files: { ...files, [FILE_CUCITURA]: primo }, args: { apply: true }, cache: { circuitJson: compilata }, scheda: "aggiornata", scrivi });
    expect(due.fileChanged!.content).toBe(primo);
    // the board compiled before the file was there: the file alone is newer, and that does not make the board old
    const tre = await scriviVisto({ files: { ...files, [FILE_CUCITURA]: primo }, args: { apply: true }, cache: { circuitJson: cj() }, scheda: "senza_la_cucitura", scrivi });
    expect(tre.fileChanged!.content).toBe(primo);
    expect(tre.result).toMatchObject({ scheda: "senza_la_cucitura", scrivibile: true });
    expect(tre.result.schedaPiuVecchiaDeiFile).toBeUndefined();
  });

  describe("la scheda salvata piu' vecchia dei file", () => {
    const files = { ...regole, "main.tsx": "export default () => <board />" };
    const nonScrive = async () => {
      throw new Error("non deve scrivere");
    };

    it("apply rifiuta e non scrive: le vie sarebbero calcolate su pezzi e piste che possono essersi spostati", async () => {
      const r = await eseguiCucitura({ files, args: { apply: true }, cache: { circuitJson: cj() }, scheda: "vecchia", scrivi: nonScrive });
      expect(r.result.error).toMatch(/non ha scritto niente/);
      expect(r.result.error).toMatch(/la scheda salvata e' piu' vecchia dei file/);
      expect(r.result.error).toMatch(/Ricompila/);
      expect(r.fileChanged).toBeUndefined();
    });

    it("l'anteprima risponde lo stesso, e dice che non si puo' scrivere e perche'", async () => {
      const r = await eseguiCucitura({ files, args: {}, cache: { circuitJson: cj() }, scheda: "vecchia", scrivi: nonScrive });
      expect(r.result).toMatchObject({ ok: true, scritto: false, scheda: "vecchia", schedaPiuVecchiaDeiFile: true, scrivibile: false });
      expect(r.result.vie as number).toBeGreaterThan(10);
      expect((r.result.nonScrivibile as string[])[0]).toMatch(/piu' vecchia dei file/);
    });

    it("se il confronto non si e' potuto fare non si scrive", async () => {
      const r = await eseguiCucitura({ files, args: { apply: true }, cache: { circuitJson: cj() }, scheda: null, scrivi: nonScrive });
      expect(r.result.error).toMatch(/non si e' potuto confrontare/);
      const guarda = await eseguiCucitura({ files, args: {}, cache: { circuitJson: cj() }, scheda: null, scrivi: nonScrive });
      expect(guarda.result).toMatchObject({ ok: true, scheda: "non_confrontata", scrivibile: false });
    });

    it("il confronto lascia fuori cucitura-massa.tsx: scritto dopo l'ultima compilazione non rende vecchia la scheda", () => {
      // the hash of project-store, in small: every path and content, in order
      const hash = (f: Record<string, string>) => Object.keys(f).sort().map((k) => `${k}=${f[k]}`).join("|");
      const compilati = { "main.tsx": "A", "lib/Pezzo.tsx": "L" };
      const scheda = hash(compilati);
      expect(statoDellaScheda(scheda, compilati, hash)).toBe("aggiornata");
      // the tool wrote the file after the compile: before the fix every later look said "piu' vecchia"
      expect(statoDellaScheda(scheda, { ...compilati, [FILE_CUCITURA]: "vie" }, hash)).toBe("senza_la_cucitura");
      // a part moved in the files and not compiled: old, with or without the stitching file
      expect(statoDellaScheda(scheda, { ...compilati, "main.tsx": "B" }, hash)).toBe("vecchia");
      expect(statoDellaScheda(scheda, { ...compilati, "main.tsx": "B", [FILE_CUCITURA]: "vie" }, hash)).toBe("vecchia");
      expect(statoDellaScheda(scheda, { ...compilati, "lib/Pezzo.tsx": "L2" }, hash)).toBe("vecchia");
      expect(statoDellaScheda(scheda, { "main.tsx": "A" }, hash)).toBe("vecchia");
      // compiled with the stitching file: current with it, old once it is written again (its earlier vias are on the board)
      const conLeVie = hash({ ...compilati, [FILE_CUCITURA]: "vie" });
      expect(statoDellaScheda(conLeVie, { ...compilati, [FILE_CUCITURA]: "vie" }, hash)).toBe("aggiornata");
      expect(statoDellaScheda(conLeVie, { ...compilati, [FILE_CUCITURA]: "altre vie" }, hash)).toBe("vecchia");
      expect(statoDellaScheda(conLeVie, compilati, hash)).toBe("vecchia");
    });
  });

  describe("un cucitura-massa.tsx che lo strumento non ha scritto", () => {
    // someone's own file under the tool's name: a signal via and a trace
    const A_MANO = [
      "// le mie vie di segnale, scritte a mano",
      "export const CucituraMassa = () => (",
      "  <>",
      '    <via name="VS1" pcbX={2} pcbY={2} connectsTo="net.SIG" fromLayer="top" toLayer="bottom" />',
      '    <trace from=".R1 > .pin1" to="net.SIG" pcbPath={[{ x: 0, y: 0 }, { x: 2, y: 2 }]} />',
      "  </>",
      ")",
      "",
    ].join("\n");
    // the board compiled with it: the signal via is on it, at the point the file says
    const conLaViaDiSegnale = () => [...cj(), viaEsistente(2, 2, "k_sig")];
    const main = { ...regole, "main.tsx": 'import { CucituraMassa } from "./cucitura-massa"\nexport default () => <board><CucituraMassa /></board>' };

    it("non si sovrascrive: apply rifiuta dicendo perche', e il file resta com'era", async () => {
      const files: Record<string, string> = { ...main, [FILE_CUCITURA]: A_MANO };
      const scritti: string[] = [];
      const r = await eseguiCucitura({ files, args: { apply: true }, cache: { circuitJson: conLaViaDiSegnale() }, scheda: "aggiornata", scrivi: async (path) => void scritti.push(path) });
      expect(r.result.error).toMatch(/non e' stato scritto da questo strumento/);
      expect(r.result.error).toMatch(/non comincia con l'intestazione/);
      expect(r.fileChanged).toBeUndefined();
      expect(scritti).toEqual([]);
      expect(files[FILE_CUCITURA]).toBe(A_MANO);
    });

    it("le sue vie non si tolgono dal calcolo: nessuna via di massa finisce dov'e' la via di segnale", async () => {
      const guarda = await eseguiCucitura({ files: { ...main, [FILE_CUCITURA]: A_MANO }, args: { passoMm: 1, bordo: false }, cache: { circuitJson: conLaViaDiSegnale() }, scheda: "aggiornata", scrivi });
      expect(guarda.result).toMatchObject({ ok: true, scritto: false, fileEsistente: "non_dello_strumento", scrivibile: false });
      expect((guarda.result.nonScrivibile as string[])[0]).toMatch(/non si sovrascrive/);
      const griglia = (guarda.result.coordinate as { griglia: Array<[number, number]> }).griglia;
      expect(griglia.length).toBeGreaterThan(100);
      // the signal via (ring 0.45) keeps every ground via the pour's clearance away, as on any board
      for (const [x, y] of griglia) expect(Math.hypot(x - 2, y - 2) - 0.225 - R).toBeGreaterThanOrEqual(0.2 - 1e-9);
      expect((guarda.result.scarti as Record<string, number>).via_esistente).toBeGreaterThan(0);
      expect(vieDelFile(A_MANO)).toEqual([]);
    });

    it("il file dello strumento si riconosce riga per riga: una riga in piu' o cambiata e non e' piu' suo", async () => {
      const scrive = await scriviVisto({ files: { ...regole, "main.tsx": "export default () => <board />" }, args: { apply: true }, cache: { circuitJson: cj() }, scheda: "aggiornata", scrivi });
      const suo = scrive.fileChanged!.content;
      expect(leggiFileDellaCucitura(undefined)).toEqual({ stato: "manca" });
      // a file left empty is handed back to the tool: nothing in it to lose
      expect(leggiFileDellaCucitura("  \n")).toEqual({ stato: "manca" });
      const letto = leggiFileDellaCucitura(suo);
      expect(letto).toMatchObject({ stato: "dello_strumento", rete: "GND" });
      expect((letto as { vie: P[] }).vie).toHaveLength(scrive.result.vie as number);
      expect(leggiFileDellaCucitura(suo.replace(/\n/g, "\r\n"))).toMatchObject({ stato: "dello_strumento" });
      const righe = suo.split("\n");
      const conUnaPista = [...righe.slice(0, 6), '    <trace from=".R1 > .pin1" to="net.GND" />', ...righe.slice(6)].join("\n");
      const altri = [
        conUnaPista,
        // a via of another net among the tool's
        suo.replace('name="VCM2" ', 'name="VCM2" ').replace(/(name="VCM2"[^\n]*connectsTo="net\.)GND/, "$1SIG"),
        // a via renamed, a via with one prop more, something after the end
        suo.replace('name="VCM1"', 'name="V1"'),
        suo.replace(' />\n', ' netIsAssignable />\n'),
        `${suo}export const Altro = () => <via pcbX={1} pcbY={1} />\n`,
        suo.replace("// Cucitura della massa", "// cucitura"),
      ];
      for (const testo of altri) {
        expect(leggiFileDellaCucitura(testo).stato, testo.slice(0, 80)).toBe("non_dello_strumento");
        expect(vieDelFile(testo)).toEqual([]);
        const r = await eseguiCucitura({ files: { ...regole, "main.tsx": "export default () => <board />", [FILE_CUCITURA]: testo }, args: { apply: true }, cache: { circuitJson: cj() }, scheda: "aggiornata", scrivi: async () => { throw new Error("non deve scrivere"); } });
        expect(r.result.error).toMatch(/non si sovrascrive/);
      }
    });

    it("il file dello strumento per un'altra rete non si sovrascrive con questa", async () => {
      const diUnAltra = [
        "// Cucitura della massa (rete AGND): 1 vie passanti, foro 0.2 mm, corona 0.5 mm, passo 2.5 mm sfalsato.",
        "export const CucituraMassa = () => (",
        "  <>",
        '    <via name="VCM1" pcbX={2} pcbY={2} connectsTo="net.AGND" fromLayer="top" toLayer="bottom" holeDiameter={0.2} outerDiameter={0.5} />',
        "  </>",
        ")",
        "",
      ].join("\n");
      expect(leggiFileDellaCucitura(diUnAltra)).toEqual({ stato: "dello_strumento", rete: "AGND", vie: [{ x: 2, y: 2 }] });
      const r = await eseguiCucitura({ files: { ...regole, "main.tsx": "export default () => <board />", [FILE_CUCITURA]: diUnAltra }, args: { apply: true }, cache: { circuitJson: cj() }, scheda: "aggiornata", scrivi: async () => { throw new Error("non deve scrivere"); } });
      expect(r.result.error).toMatch(/tiene la cucitura della rete AGND e questa chiamata cuce GND/);
    });

    it("dalla scheda si tolgono solo le vie della rete cucita: una via di un'altra rete sullo stesso punto resta", () => {
      const scheda = [...cj(), viaEsistente(2, 2, "k_sig"), viaEsistente(4, 4, "k_gnd")];
      const senza = senzaLeVieAi(scheda, [{ x: 2, y: 2 }, { x: 4, y: 4 }], "source_net_0") as El[];
      expect(senza.filter((el) => el.type === "pcb_via").map((v) => [v.x, v.y])).toEqual([[-6, -6], [2, 2]]);
    });
  });

  describe("si scrive solo quello che l'anteprima ha mostrato", () => {
    const files = { ...regole, "main.tsx": "export default () => <board />" };
    const nonScrive = async () => {
      throw new Error("non deve scrivere");
    };

    it("l'anteprima da' l'impronta del file che scriverebbe, apply la riporta e scrive quel file", async () => {
      const visto = await eseguiCucitura({ files, args: { passoMm: 2 }, cache: { circuitJson: cj() }, scheda: "aggiornata", scrivi: nonScrive });
      expect(visto.result.impronta).toMatch(new RegExp(`^${visto.result.vie as number}-[0-9a-f]{16}$`));
      let scritto = "";
      const r = await eseguiCucitura({ files, args: { passoMm: 2, apply: true, impronta: visto.result.impronta }, cache: { circuitJson: cj() }, scheda: "aggiornata", scrivi: async (_p, c) => void (scritto = c) });
      expect(r.result).toMatchObject({ scritto: true, impronta: visto.result.impronta, vie: visto.result.vie });
      // what was written is what was shown: the same points, in the same order
      const mostrate = visto.result.coordinate as Record<string, Array<[number, number]>>;
      expect(vieDelFile(scritto).map((p) => [p.x, p.y])).toEqual([...mostrate.isola, ...mostrate.bordo, ...mostrate.griglia]);
      expect(improntaDelFile(vieDelFile(scritto).length, scritto)).toBe(visto.result.impronta);
    });

    it("la scheda cambiata fra l'anteprima e la scrittura: apply rifiuta e dice di rifare l'anteprima", async () => {
      const visto = await eseguiCucitura({ files, args: { passoMm: 2 }, cache: { circuitJson: cj() }, scheda: "aggiornata", scrivi: nonScrive });
      // compiled in between with a part where some of the vias shown were
      const cambiata = [...cj(), ...pezzo("U9", 0, 0, 6, 6, "top")];
      const r = await eseguiCucitura({ files, args: { passoMm: 2, apply: true, impronta: visto.result.impronta }, cache: { circuitJson: cambiata }, scheda: "aggiornata", scrivi: nonScrive });
      expect(r.result.error).toMatch(/la scheda o i parametri sono cambiati dall'anteprima.*rifai l'anteprima/);
      expect(r.result.error).toMatch(new RegExp(`proponeva ${visto.result.vie as number} vie`));
      expect(r.fileChanged).toBeUndefined();
      // the fingerprint of what it would write now does not come back with the refusal: it comes with a look
      expect(r.result.impronta).toBeUndefined();
      const rivisto = await eseguiCucitura({ files, args: { passoMm: 2 }, cache: { circuitJson: cambiata }, scheda: "aggiornata", scrivi: nonScrive });
      expect(rivisto.result.impronta).not.toBe(visto.result.impronta);
      expect(rivisto.result.vie as number).toBeLessThan(visto.result.vie as number);
    });

    it("altri parametri dall'anteprima, o le stesse vie in numero ma in altri punti: rifiutato", async () => {
      const visto = await eseguiCucitura({ files, args: { passoMm: 2 }, cache: { circuitJson: cj() }, scheda: "aggiornata", scrivi: nonScrive });
      const altroPasso = await eseguiCucitura({ files, args: { passoMm: 3, apply: true, impronta: visto.result.impronta }, cache: { circuitJson: cj() }, scheda: "aggiornata", scrivi: nonScrive });
      expect(altroPasso.result.error).toMatch(/rifai l'anteprima/);
      // the same count, hand-made: the number alone is not the fingerprint
      const finta = `${visto.result.vie as number}-0123456789abcdef`;
      const r = await eseguiCucitura({ files, args: { passoMm: 2, apply: true, impronta: finta }, cache: { circuitJson: cj() }, scheda: "aggiornata", scrivi: nonScrive });
      expect(r.result.error).toMatch(/rifai l'anteprima/);
    });

    it("apply senza impronta e' una scrittura che nessuno ha guardato: rifiutata", async () => {
      const r = await eseguiCucitura({ files, args: { apply: true }, cache: { circuitJson: cj() }, scheda: "aggiornata", scrivi: nonScrive });
      expect(r.result.error).toMatch(/apply chiede l'impronta dell'anteprima/);
      const storta = await eseguiCucitura({ files, args: { apply: true, impronta: "tutte" }, cache: { circuitJson: cj() }, scheda: "aggiornata", scrivi: nonScrive });
      expect(storta.result.error).toMatch(/impronta: quella restituita dal dryRun/);
    });
  });

  it("main.tsx che lo usa davvero, non in un commento; o un file di cui main.tsx e' fatto", () => {
    expect(mainLaUsa('// import { CucituraMassa } from "./cucitura-massa"\nexport default () => <board />')).toBe(false);
    const usa = 'import { CucituraMassa } from "./cucitura-massa"\nexport default () => <board><CucituraMassa /></board>';
    expect(mainLaUsa(usa)).toBe(true);
    expect(chiLaUsa({ "main.tsx": usa, "parti.tsx": usa })).toBe("main.tsx");
    expect(chiLaUsa({ "main.tsx": "export default () => <board />", [FILE_CUCITURA]: usa })).toBeNull();
    const parti = 'import { CucituraMassa } from "../cucitura-massa"\nexport const Parti = () => <><CucituraMassa /></>';
    expect(chiLaUsa({ "main.tsx": 'import { Parti } from "./pezzi/parti"\nexport default () => <board><Parti /></board>', "pezzi/parti.tsx": parti })).toBe("pezzi/parti.tsx");
  });

  describe("<CucituraMassa /> dentro un <group> spostato", () => {
    const usa = { ...regole, "main.tsx": 'import { CucituraMassa } from "./cucitura-massa"\nexport default () => <board><group pcbX={3} pcbY={2}><CucituraMassa /></group></board>' };
    /** the board compiled with the file: its vias where the file says, or all moved by the group's offset */
    const compilataCon = (testo: string, dx = 0, dy = 0) => {
      const scritte = { rete: { id: "source_net_0", nome: "GND" }, via: { foroMm: 0.2, coronaMm: 0.5 }, vie: vieDelFile(testo).map((p) => ({ x: p.x + dx, y: p.y + dy, tipo: "griglia" })) } as EsitoCucitura;
      return [...cj(), ...vieComeElementi(scritte, cj())];
    };

    it("le vie del file non sono sulla scheda alle loro coordinate: lo dice e apply rifiuta, invece di cucire attorno alle proprie vie spostate", async () => {
      const primo = (await scriviVisto({ files: { ...regole, "main.tsx": "export default () => <board />" }, args: { apply: true }, cache: { circuitJson: cj() }, scheda: "aggiornata", scrivi })).fileChanged!.content;
      const quante = vieDelFile(primo).length;
      expect(quante).toBeGreaterThan(10);
      const files = { ...usa, [FILE_CUCITURA]: primo };
      const spostata = compilataCon(primo, 3, 2);
      const guarda = await eseguiCucitura({ files, args: {}, cache: { circuitJson: spostata }, scheda: "aggiornata", scrivi });
      expect(guarda.result).toMatchObject({ ok: true, scrivibile: false, main: { usaIlFile: true, vieNonAlLoroPosto: expect.any(Number) } });
      expect((guarda.result.main as { vieNonAlLoroPosto: number }).vieNonAlLoroPosto).toBeGreaterThan(quante / 2);
      expect((guarda.result.nonScrivibile as string[]).join(" ")).toMatch(/non sono sulla scheda alle coordinate del file.*<group> spostato/);
      const scritti: string[] = [];
      const scrive = await eseguiCucitura({ files, args: { apply: true }, cache: { circuitJson: spostata }, scheda: "aggiornata", scrivi: async (path) => void scritti.push(path) });
      expect(scrive.result.error).toMatch(/<group> spostato/);
      expect(scritti).toEqual([]);
      // with the vias where the file says the same call is the idempotent one
      const dritta = await scriviVisto({ files, args: { apply: true }, cache: { circuitJson: compilataCon(primo) }, scheda: "aggiornata", scrivi });
      expect(dritta.fileChanged!.content).toBe(primo);
    });

    it("un progetto che lo usa in un modo che non si riconosce dai file: se la scheda compilata ha tutte le sue vie, sono le sue", async () => {
      const primo = (await scriviVisto({ files: { ...regole, "main.tsx": "export default () => <board />" }, args: { apply: true }, cache: { circuitJson: cj() }, scheda: "aggiornata", scrivi })).fileChanged!.content;
      // imported whole, placed through the namespace: neither an import { CucituraMassa } nor a <CucituraMassa />
      const files = { ...regole, "main.tsx": 'import * as C from "./cucitura-massa"\nexport default () => <board><C.CucituraMassa /></board>', [FILE_CUCITURA]: primo };
      expect(chiLaUsa(files)).toBeNull();
      const r = await scriviVisto({ files, args: { apply: true }, cache: { circuitJson: compilataCon(primo) }, scheda: "aggiornata", scrivi });
      expect(r.result).toMatchObject({ scritto: true, main: { usaIlFile: true } });
      expect(r.fileChanged!.content).toBe(primo);
    });

    it("un file non ancora usato da nessuno non toglie niente dalla scheda", async () => {
      // a hand-placed ground via on the very point of a via of the unused file: it is the board's, and stays
      const primo = (await scriviVisto({ files: { ...regole, "main.tsx": "export default () => <board />" }, args: { apply: true, bordo: false }, cache: { circuitJson: cj() }, scheda: "aggiornata", scrivi })).fileChanged!.content;
      const p = vieDelFile(primo)[0];
      const scheda = [...cj(), viaEsistente(p.x, p.y, "k_gnd")];
      const r = await eseguiCucitura({ files: { ...regole, "main.tsx": "export default () => <board />", [FILE_CUCITURA]: primo }, args: { bordo: false }, cache: { circuitJson: scheda }, scheda: "aggiornata", scrivi });
      const griglia = (r.result.coordinate as { griglia: Array<[number, number]> }).griglia;
      expect(griglia.length).toBeGreaterThan(5);
      expect(griglia.some(([x, y]) => x === p.x && y === p.y)).toBe(false);
    });
  });

  describe("il tetto di vie e la lunghezza del file", () => {
    /** as many vias as asked, each written as long as a real one gets: four digits in the name, a sign and three decimals in the coordinates, the smallest via of a project */
    const lunghe = (quante: number, rete = "GND"): EsitoCucitura => ({
      ...cuci([...scheda(), ...massaPiena()]),
      rete: { id: "source_net_0", nome: rete },
      via: { foroMm: 0.15, coronaMm: 0.45 },
      vie: Array.from({ length: quante }, () => ({ x: -123.456, y: -123.456, tipo: "griglia" as const })),
    });
    const lunghezza = (e: EsitoCucitura) => {
      const f = fileDellaCucitura(e);
      if ("errore" in f) throw new Error(f.errore);
      return f.contenuto.length;
    };

    it("al tetto di serie il file sta sotto il limite di un file di progetto con un quarto di margine, e al massimo che una chiamata puo' chiedere ci sta ancora", () => {
      expect(MAX_VIE_DI_SERIE).toBe(1000);
      expect(lunghezza(lunghe(MAX_VIE_DI_SERIE))).toBeLessThan(MAX_FILE_CHARS * 0.8);
      expect(lunghezza(lunghe(MAX_VIE_LIMITE))).toBeLessThan(MAX_FILE_CHARS * 0.95);
      // the 1500 of before did not fit: that is why the cap came down
      expect(fileDellaCucitura(lunghe(1500))).toMatchObject({ errore: expect.stringMatching(/1500 vie fanno un file di \d+ caratteri, oltre i 200000/) });
      expect(leggiOpzioniCucitura({ maxVie: MAX_VIE_LIMITE })).toMatchObject({ opzioni: { maxVie: MAX_VIE_LIMITE } });
      expect(leggiOpzioniCucitura({ maxVie: MAX_VIE_LIMITE + 1 })).toMatchObject({ errori: [expect.stringMatching(/maxVie: 1201 fuori dai limiti 1..1200/)] });
    });

    it("una scheda che ne chiederebbe di piu' si ferma al tetto di serie, e il file scritto e' sotto il limite", async () => {
      const grande = [...scheda(100, 100), ...massaPiena(["top", "bottom"], 100, 100), viaEsistente(-48, -48, "k_gnd")];
      let scritto = "";
      const r = await scriviVisto({
        files: { ...regole, "main.tsx": "export default () => <board />" },
        args: { apply: true, passoMm: 2 },
        cache: { circuitJson: grande },
        scheda: "aggiornata",
        scrivi: async (_path, content) => void (scritto = content),
      });
      expect(r.result).toMatchObject({ ok: true, scritto: true, vie: MAX_VIE_DI_SERIE, tetto: { maxVie: MAX_VIE_DI_SERIE, raggiunto: true } });
      expect(vieDelFile(scritto)).toHaveLength(MAX_VIE_DI_SERIE);
      expect(scritto.length).toBe(r.result.chars);
      expect(scritto.length).toBeLessThan(MAX_FILE_CHARS * 0.8);
    });

    it("un file che non ci starebbe non si scrive: l'anteprima lo dice, apply rifiuta", async () => {
      // a net with a long name makes long lines: 1200 vias of it do not fit
      const nome = `GND_${"A".repeat(56)}`;
      expect(fileDellaCucitura(lunghe(MAX_VIE_LIMITE, nome))).toMatchObject({ errore: expect.stringMatching(/oltre i 200000 che un file del progetto puo' avere/) });
      const grande = [
        { type: "pcb_board", pcb_board_id: "b", width: 100, height: 100, center: { x: 0, y: 0 }, num_layers: 2 },
        { type: "source_net", source_net_id: "source_net_0", name: nome, subcircuit_connectivity_map_key: "k_gnd", subcircuit_id: "s" },
        ...massaPiena(["top", "bottom"], 100, 100),
        viaEsistente(-48, -48, "k_gnd"),
      ];
      const files = { ...regole, "main.tsx": "export default () => <board />" };
      const guarda = await eseguiCucitura({ files, args: { passoMm: 2, maxVie: MAX_VIE_LIMITE }, cache: { circuitJson: grande }, scheda: "aggiornata", scrivi });
      expect(guarda.result).toMatchObject({ ok: true, vie: MAX_VIE_LIMITE, scrivibile: false });
      expect((guarda.result.nonScrivibile as string[]).join(" ")).toMatch(/abbassa maxVie o allarga il passo/);
      const scrive = await eseguiCucitura({ files, args: { apply: true, passoMm: 2, maxVie: MAX_VIE_LIMITE }, cache: { circuitJson: grande }, scheda: "aggiornata", scrivi: async () => { throw new Error("non deve scrivere"); } });
      expect(scrive.result.error).toMatch(/oltre i 200000/);
    });

    it("rifare la cucitura a un altro passo non cambia la chiave dello schematico: ne' le vie ne' i commenti del file portano numeri che cambiano", () => {
      const base = [...scheda(), ...massaPiena(), viaEsistente(-6, -6, "k_gnd")];
      const file = (o: OpzioniCucitura) => {
        const f = fileDellaCucitura(cuci(base, o));
        if ("errore" in f) throw new Error(f.errore);
        return f.contenuto;
      };
      const rado = file({ passoMm: 4 });
      const fitto = file({ passoMm: 1.5, bordo: false, sfalsata: false });
      expect(vieDelFile(fitto).length).toBeGreaterThan(vieDelFile(rado).length * 2);
      const main = 'import { CucituraMassa } from "./cucitura-massa"\nexport default () => <board><CucituraMassa /></board>';
      expect(schematicKeyOf({ "main.tsx": main, [FILE_CUCITURA]: fitto })).toBe(schematicKeyOf({ "main.tsx": main, [FILE_CUCITURA]: rado }));
      // and the file written before this change, with the counts in its first line, is still the tool's
      const diPrima = rado.replace(/^\/\/ Cucitura della massa \(rete GND\): [^\n]*/, "// Cucitura della massa (rete GND): 57 vie passanti, foro 0.2 mm, corona 0.5 mm, passo 2.5 mm sfalsato, fila sul bordo ogni 2.5 mm.\n// 0 per le isole di massa, 23 sul bordo, 34 in griglia.");
      expect(diPrima).not.toBe(rado);
      expect(leggiFileDellaCucitura(diPrima)).toMatchObject({ stato: "dello_strumento", rete: "GND" });
      // a comment is in the key: the same vias under that first line read as another file to the schematic
      expect(schematicKeyOf({ "main.tsx": main, [FILE_CUCITURA]: diPrima })).not.toBe(schematicKeyOf({ "main.tsx": main, [FILE_CUCITURA]: rado }));
    });

    it("le vie sono tag scritti per esteso: la chiave dello schematico le toglie tutte, un elenco passato a .map resterebbe nella chiave", () => {
      const f = fileDellaCucitura(cuci([...scheda(), ...massaPiena(), viaEsistente(-6, -6, "k_gnd")], { passoMm: 2 }));
      if ("errore" in f) throw new Error(f.errore);
      expect(f.contenuto).toMatch(/pcbX=\{/);
      const perLoSchematico = soloCioCheLeggeLoSchematico(f.contenuto);
      expect(perLoSchematico).not.toMatch(/<via|pcbX|pcbY/);
      const conMap = 'export const CucituraMassa = () => (\n  <>\n    {[[1.25, 2.5], [3.75, 2.5]].map(([x, y], i) => (\n      <via name={`VCM${i + 1}`} pcbX={x} pcbY={y} connectsTo="net.GND" />\n    ))}\n  </>\n)\n';
      expect(soloCioCheLeggeLoSchematico(conMap)).toMatch(/3\.75/);
    });
  });

  it("una rete che net.<nome> non sa scrivere non si scrive", () => {
    const e = cuci([...scheda(), ...massaPiena()]);
    expect(fileDellaCucitura({ ...e, rete: { id: "x", nome: "GND-1" } })).toMatchObject({ errore: expect.any(String) });
  });

  it("senza scheda salvata lo dice", async () => {
    const r = await eseguiCucitura({ files: {}, args: {}, cache: null, scheda: null, scrivi });
    expect(r.result.error).toMatch(/compila prima/);
  });
});
