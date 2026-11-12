import { initializeManifoldGeometry } from "@tscircuit/copper-pour-solver";
import { getManifoldModuleSync } from "@tscircuit/manifold-2d";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_DESIGN_RULES, DESIGN_RULES_PATH, type DesignRules } from "@/lib/design-rules";
import { distanzaPuntoForma, rameDelPad } from "@/lib/drc";
import { cuciLaMassa, type EsitoCucitura, type OpzioniCucitura } from "@/lib/ground-stitching";
import { eseguiCucitura } from "@/lib/ground-stitching-tool";
import { cerchio } from "@/lib/pour-geometry";
import { senzaColliStretti, type FormaColata } from "@/lib/pour-necks";
import { DISTANZA_PROPRIA } from "@/lib/pours";
import { eScheggia } from "@/lib/pours-recompute";

/*
 * Le colate di altre reti che una via di cucitura attraversa (sbb-dongle,
 * 12/11/2026: piano P3V3 pieno su inner2, zero vie proposte). Schede costruite
 * a mano, con le regole del dongle: corona 0,5, distanza delle colate 0,25,
 * quindi la ricolata apre il piano di 0,5 mm attorno al centro di ogni via, e
 * un collo sotto 0,15 mm (minTraceWidthMm) e' un taglio.
 *
 * Ogni scheda si giudica anche con la misura della ricolata, non con quella
 * dello strumento: il piano aperto attorno alle vie proposte, tolti i colli
 * con senzaColliStretti e le schegge con eScheggia come fa ricolaPiani, deve
 * tornare in un pezzo solo.
 */

type El = { type: string; [key: string]: unknown };
type P = { x: number; y: number };

const REGOLE: DesignRules = {
  ...DEFAULT_DESIGN_RULES,
  minTraceWidthMm: 0.15,
  minClearanceMm: 0.15,
  minViaHoleMm: 0.15,
  minViaDiameterMm: 0.5,
  pourClearanceMm: 0.25,
  minHoleToHoleMm: 0.25,
  minBoardEdgeClearanceMm: 0.3,
};
/** half the ring, and what the re-pour opens around the centre of a via: ring + the pour's clearance */
const R = 0.25;
const APERTURA = 0.5;
const COLLO = 0.15;

const rett = (x0: number, y0: number, x1: number, y1: number): P[] => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];
let n = 0;
const scheda = (w = 20, h = 20): El[] => [
  { type: "pcb_board", pcb_board_id: "b", width: w, height: h, center: { x: 0, y: 0 }, num_layers: 4 },
  { type: "source_net", source_net_id: "source_net_0", name: "GND", subcircuit_connectivity_map_key: "k_gnd", subcircuit_id: "s" },
  { type: "source_net", source_net_id: "source_net_1", name: "P3V3", subcircuit_connectivity_map_key: "k_p3v3", subcircuit_id: "s" },
];
const colata = (layer: string, punti: P[], net = "source_net_0", buchi: P[][] = [], altro: Record<string, unknown> = {}): El => ({
  type: "pcb_copper_pour",
  pcb_copper_pour_id: `colata_${n++}`,
  layer,
  source_net_id: net,
  shape: "brep",
  brep_shape: { outer_ring: { vertices: punti }, inner_rings: buchi.map((v) => ({ vertices: v })) },
  ...altro,
});
const via = (x: number, y: number, rete: string): El => ({
  type: "pcb_via", pcb_via_id: `via_${n++}`, x, y, outer_diameter: 0.5, hole_diameter: 0.2, layers: ["top", "inner1", "inner2", "bottom"], subcircuit_connectivity_map_key: rete,
});
/**
 * The ground as on the dongle: top, bottom and inner1 whole, 0.3 from the edge;
 * inner2 is the other net's. `legata`: one ground via in a corner ties the
 * three layers, so none of them is an island that gets a via of its own first.
 */
const massa = (w = 20, h = 20, legata = true): El[] => [
  ...["top", "inner1", "bottom"].map((s) => colata(s, rett(-w / 2 + 0.3, -h / 2 + 0.3, w / 2 - 0.3, h / 2 - 0.3))),
  ...(legata ? [via(w / 2 - 1, h / 2 - 1, "k_gnd")] : []),
];
const pad = (id: string, x: number, y: number, w: number, h: number, layer: string, rete: string): El[] => [
  { type: "source_port", source_port_id: `sp_${id}`, subcircuit_connectivity_map_key: rete },
  { type: "pcb_port", pcb_port_id: `pp_${id}`, source_port_id: `sp_${id}`, x, y, layers: [layer] },
  { type: "pcb_smtpad", pcb_smtpad_id: id, shape: "rect", x, y, width: w, height: h, layer, pcb_port_id: `pp_${id}` },
];

const cuci = (cj: El[], o: OpzioniCucitura = {}): EsitoCucitura => {
  const e = cuciLaMassa(cj, REGOLE, o);
  if (!e.ok) throw new Error(e.errore);
  return e;
};
const dentro = (x: number, y: number, a: P[]) => {
  let d = false;
  for (let i = 0, j = a.length - 1; i < a.length; j = i++) if (a[i].y > y !== a[j].y > y && x < ((a[j].x - a[i].x) * (y - a[i].y)) / (a[j].y - a[i].y) + a[i].x) d = !d;
  return d;
};
const nelRame = (f: FormaColata, x: number, y: number) =>
  dentro(x, y, f.outer_ring?.vertices ?? []) && !(f.inner_rings ?? []).some((b) => dentro(x, y, b.vertices));

/**
 * THE RE-POUR'S OWN MEASURE: the pour opened around these vias (a circle of
 * ring + clearance each, drawn as the re-pour draws it), then without the necks
 * narrower than the minimum and without the splinters (senzaColliStretti and
 * eScheggia, what ricolaPiani runs). Its pieces, the largest first.
 */
function ricolato(esterno: P[], buchi: P[][], vie: P[], apertura = APERTURA): FormaColata[] {
  const m = getManifoldModuleSync()!;
  const coppie = (a: P[]) => a.map((p) => [p.x, p.y] as [number, number]);
  const base = m.CrossSection.ofPolygons([esterno, ...buchi].map(coppie), "EvenOdd");
  const dischi = m.CrossSection.ofPolygons(vie.map((v) => coppie(cerchio(v.x, v.y, apertura))), "Positive");
  const tagliato = vie.length > 0 ? base.subtract(dischi) : base;
  const pezzi = tagliato.decompose();
  const area = (c: Array<[number, number]>) => c.reduce((s, [x, y], i) => s + x * c[(i + 1) % c.length][1] - c[(i + 1) % c.length][0] * y, 0) / 2;
  const out: FormaColata[] = [];
  for (const pezzo of pezzi) {
    const contorni = pezzo.toPolygons() as Array<Array<[number, number]>>;
    const forma: FormaColata = {
      outer_ring: { vertices: contorni.filter((c) => area(c) > 0)[0].map(([x, y]) => ({ x, y })) },
      inner_rings: contorni.filter((c) => area(c) < 0).map((c) => ({ vertices: c.map(([x, y]) => ({ x, y })) })),
    };
    out.push(...senzaColliStretti(forma, COLLO, "tutti").filter((f) => !eScheggia(f, REGOLE.pourClearanceMm!)));
  }
  for (const o of [...pezzi, ...(vie.length > 0 ? [tagliato] : []), dischi, base]) o.delete();
  const areaDi = (f: FormaColata) => {
    const a = (v: P[]) => Math.abs(v.reduce((s, p, i) => s + p.x * v[(i + 1) % v.length].y - v[(i + 1) % v.length].x * p.y, 0) / 2);
    return a(f.outer_ring?.vertices ?? []) - (f.inner_rings ?? []).reduce((s, r) => s + a(r.vertices), 0);
  };
  return out.sort((a, b) => areaDi(b) - areaDi(a));
}

beforeAll(async () => {
  await initializeManifoldGeometry();
});

describe("una colata di un'altra rete dove la via non si collega", () => {
  /** the dongle in small: ground on top, inner1 and bottom, the P3V3 plane whole on inner2, a P3V3 pad with its via and one more via */
  const piano = rett(-5.7, -7.7, 5.7, 7.7);
  const dongle = (): El[] => [
    ...scheda(12, 16),
    // no via ties the three ground layers: two of them are islands, as the top island of the dongle was
    ...massa(12, 16, false),
    colata("inner2", piano, "source_net_1"),
    ...pad("P1", 2, 2, 0.6, 0.6, "top", "k_p3v3"),
    via(2, 3, "k_p3v3"),
    via(-3, -4, "k_p3v3"),
  ];

  it("il piano pieno di un'altra rete su uno strato interno si attraversa: vie proposte, fuori dalle piazzole e dalle vie di quella rete, e il piano resta un pezzo solo", () => {
    const cj = dongle();
    for (const opzioni of [{}, { passoMm: 2, passoBordoMm: 2 }, { passoMm: 1, passoBordoMm: 1 }] as OpzioniCucitura[]) {
      const e = cuci(cj, opzioni);
      // every one of them goes through the plane: there is nowhere else on this board
      expect(e.vie.length).toBeGreaterThan(8);
      // the islands of ground, which had no place, have their via
      expect(e.isole).toMatchObject({ trovate: 2, senzaPosto: [] });
      expect(e.conteggio.isola).toBeGreaterThan(0);
      expect(e.pianiAttraversati).toEqual({ vie: e.vie.length, piani: [{ rete: "P3V3", strato: "inner2", vie: e.vie.length }] });
      const p1 = rameDelPad(cj.find((x) => x.pcb_smtpad_id === "P1")!)!;
      for (const v of e.vie) {
        // from the pad and the vias of the plane's net what the rules ask of any other net (the pour's clearance, on every layer)
        expect(distanzaPuntoForma(p1, v.x, v.y) - R).toBeGreaterThanOrEqual(REGOLE.pourClearanceMm! - 1e-9);
        for (const [x, y] of [[2, 3], [-3, -4]]) expect(Math.hypot(v.x - x, v.y - y) - R - R).toBeGreaterThanOrEqual(REGOLE.pourClearanceMm! - 1e-9);
      }
      // the re-pour's own measure: the plane opened around every via, its necks taken off, is one piece, with both vias of its net on it
      const dopo = ricolato(piano, [], e.vie);
      expect(dopo).toHaveLength(1);
      expect(nelRame(dopo[0], 2, 3)).toBe(true);
      expect(nelRame(dopo[0], -3, -4)).toBe(true);
      for (const v of e.vie) expect(nelRame(dopo[0], v.x, v.y)).toBe(false);
    }
  });

  it("senza quel piano le stesse posizioni: col piano le vie non sono di piu'", () => {
    const cj = dongle();
    const senza = cj.filter((el) => !(el.type === "pcb_copper_pour" && el.layer === "inner2"));
    for (const opzioni of [{}, { passoMm: 1, passoBordoMm: 1 }] as OpzioniCucitura[]) {
      const col = cuci(cj, opzioni);
      const libere = cuci(senza, opzioni);
      expect(libere.pianiAttraversati).toEqual({ vie: 0, piani: [] });
      expect(col.vie.length).toBeLessThanOrEqual(libere.vie.length);
      expect(col.vie.length).toBeGreaterThan(libere.vie.length * 0.7);
    }
  });

  it("dove la via sta nella massa la colata vicina di un'altra rete resta un ostacolo", () => {
    // inner2: ground on the left half, the P3V3 plane on the right, 0.25 apart. The ground is poured on inner2, so a via must stand in it there
    const cj = [...scheda(), ...massa(), colata("inner2", rett(-9.7, -9.7, -0.125, 9.7)), colata("inner2", rett(0.125, -9.7, 9.7, 9.7), "source_net_1")];
    const e = cuci(cj, { bordo: false, passoMm: 1 });
    expect(e.vie.length).toBeGreaterThan(50);
    expect(e.pianiAttraversati).toEqual({ vie: 0, piani: [] });
    // the ring in the ground of inner2, and the ring plus the clearance out of the plane
    for (const v of e.vie) expect(v.x + R).toBeLessThanOrEqual(0.125 - REGOLE.pourClearanceMm! + 1e-9);
  });

  it("una rete messa in retiLontane non si attraversa, nemmeno a distanza zero", () => {
    const e = cuci(dongle(), { retiLontane: [{ rete: "P3V3", distanzaMm: 0 }] });
    expect(e.vie).toHaveLength(0);
    expect(e.pianiAttraversati).toEqual({ vie: 0, piani: [] });
    expect(e.scarti.colata_altra_rete).toBeGreaterThan(0);
  });

  it("lo strumento lo dice nell'anteprima: quante vie attraversano colate di altre reti e quali, e il resto della risposta e' quello di prima", async () => {
    const cj = dongle();
    const files = { "main.tsx": "", [DESIGN_RULES_PATH]: JSON.stringify({ preset: "custom", rules: REGOLE }) };
    const guarda = () => eseguiCucitura({ files, args: { passoMm: 2 }, cache: { circuitJson: cj }, scheda: "aggiornata", scrivi: async () => { throw new Error("un dryRun non scrive"); } });
    const visto = await guarda();
    const vie = visto.result.vie as number;
    expect(vie).toBeGreaterThan(8);
    expect(visto.result.pianiAttraversati).toEqual({ vie, piani: [{ rete: "P3V3", strato: "inner2", vie }] });
    expect(visto.result).toMatchObject({ ok: true, scritto: false, scrivibile: true, rete: "GND", via: { foroMm: 0.2, coronaMm: 0.5 } });
    // the same look, the same vias: the write carries the fingerprint of what was seen
    expect((await guarda()).result.impronta).toBe(visto.result.impronta);
  });
});

describe("la colata che non regge resta un ostacolo, con lo stesso motivo", () => {
  it("un piano stretto che la via taglierebbe in due, o lascerebbe appeso a un collo sotto il minimo", () => {
    // a P3V3 strip along x on inner2, 0.9 wide: the opening is 1.0 across
    const stretta = rett(-9.7, -0.45, 9.7, 0.45);
    const e = cuci([...scheda(), ...massa(), colata("inner2", stretta, "source_net_1")], { bordo: false, passoMm: 1, sfalsata: false });
    expect(e.vie.length).toBeGreaterThan(100);
    expect(e.pianiAttraversati).toEqual({ vie: 0, piani: [] });
    expect(e.scarti.colata_altra_rete).toBe(19);
    // as before: the ring plus the clearance out of the strip
    for (const v of e.vie) expect(Math.abs(v.y) - 0.45 - R).toBeGreaterThanOrEqual(REGOLE.pourClearanceMm! - 1e-9);
    // and it is the cut the re-pour would make: one via in the middle of the strip leaves two pieces
    expect(ricolato(stretta, [], [{ x: 0, y: 0 }])).toHaveLength(2);

    // 1.2 wide: an opening in the middle leaves 0.1 of copper on each side, under the minimum of 0.15
    const media = rett(-9.7, -0.6, 9.7, 0.6);
    const m = cuci([...scheda(), ...massa(), colata("inner2", media, "source_net_1")], { bordo: false, passoMm: 1, sfalsata: false });
    expect(m.vie.some((v) => v.y === 0)).toBe(false);
    expect(m.scarti.colata_altra_rete).toBe(19);
    expect(ricolato(media, [], [{ x: 0, y: 0 }])).toHaveLength(2);
    // the rows beside it take a notch 0.1 deep out of its edges, and it holds
    expect(m.pianiAttraversati).toEqual({ vie: 38, piani: [{ rete: "P3V3", strato: "inner2", vie: 38 }] });
    expect(ricolato(media, [], m.vie)).toHaveLength(1);

    // 1.5 wide: 0.25 left on each side of the opening, wider than the minimum. The strip holds, and is gone through
    const larga = rett(-9.7, -0.75, 9.7, 0.75);
    const l = cuci([...scheda(), ...massa(), colata("inner2", larga, "source_net_1")], { bordo: false, passoMm: 2, sfalsata: false });
    expect(l.vie.filter((v) => v.y === 0)).toHaveLength(9);
    expect(l.pianiAttraversati).toEqual({ vie: 9, piani: [{ rete: "P3V3", strato: "inner2", vie: 9 }] });
    expect(ricolato(larga, [], l.vie)).toHaveLength(1);
  });

  it("una fila di vie che insieme taglierebbero il piano: l'ultima della fila scartata", () => {
    /*
     * A P3V3 strip along y, 3.6 wide, and one row of the grid across it (the
     * rest of the board is excluded): at pitch 1 five openings of 1.0 side by
     * side, 5 mm of cut over 3.6 of copper.
     */
    const striscia = rett(-1.8, -9.7, 1.8, 9.7);
    const cj = [...scheda(), ...massa(), colata("inner2", striscia, "source_net_1")];
    const soloLaFila = [{ x: 0, y: 5.25, w: 20, h: 9.5 }, { x: 0, y: -5.25, w: 20, h: 9.5 }];
    const e = cuci(cj, { bordo: false, passoMm: 1, sfalsata: false, zoneEscluse: soloLaFila });
    expect(e.vie.every((v) => v.y === 0)).toBe(true);
    // each opening alone leaves the strip whole, and the five together cut it
    for (const x of [-2, -1, 0, 1, 2]) expect(ricolato(striscia, [], [{ x, y: 0 }])).toHaveLength(1);
    expect(ricolato(striscia, [], [-2, -1, 0, 1, 2].map((x) => ({ x, y: 0 }))).length).toBeGreaterThan(1);
    // the grid tries 0, then -2 and 2, then -1, then 1: the first four hold together, the last would cut what is left
    expect(e.vie.filter((v) => Math.abs(v.x) <= 2).map((v) => v.x).sort((a, b) => a - b)).toEqual([-2, -1, 0, 2]);
    expect(e.pianiAttraversati).toEqual({ vie: 4, piani: [{ rete: "P3V3", strato: "inner2", vie: 4 }] });
    expect(e.scarti.colata_altra_rete).toBe(1);
    // away from the strip the row is whole
    expect(e.vie.filter((v) => Math.abs(v.x) > 2).length).toBe(14);
    // measured together, as the re-pour will: the strip with the four openings is one piece, from one end to the other
    const dopo = ricolato(striscia, [], e.vie);
    expect(dopo).toHaveLength(1);
    const ys = dopo[0].outer_ring!.vertices.map((p) => p.y);
    expect(Math.max(...ys)).toBeCloseTo(9.7, 3);
    expect(Math.min(...ys)).toBeCloseTo(-9.7, 3);
  });

  it("una via della rete del piano che resterebbe isolata", () => {
    /*
     * The P3V3 plane with a via of its net at (-1, 0), on a disc of plane
     * (radius 0.9) that a slot (out to 1.6) parts from the rest but for a
     * bridge 1 mm wide on its right. An opening at (0, 0) is as wide as the
     * bridge: the disc, and the via on it, would be a piece of their own.
     */
    const arco = (r: number, da: number, a: number, passi = 48): P[] =>
      Array.from({ length: passi + 1 }, (_, i) => ({ x: -1 + r * Math.cos(da + ((a - da) * i) / passi), y: r * Math.sin(da + ((a - da) * i) / passi) }));
    const dentroIl = Math.asin(0.5 / 0.9), fuoriDal = Math.asin(0.5 / 1.6);
    // the slot: counter-clockwise along its outer arc, back along the inner one
    const fessura = [...arco(1.6, fuoriDal, 2 * Math.PI - fuoriDal), ...arco(0.9, 2 * Math.PI - dentroIl, dentroIl)];
    const piano = rett(-9.7, -9.7, 9.7, 9.7);
    const cj = [...scheda(), ...massa(), colata("inner2", piano, "source_net_1", [fessura]), via(-1, 0, "k_p3v3")];
    const e = cuci(cj, { bordo: false, passoMm: 2, sfalsata: false });
    expect(e.pianiAttraversati.vie).toBe(e.vie.length);
    expect(e.vie.length).toBe(80);
    // the one position of the grid left out, 0.5 between its ring and the ring of the plane's via: no rule between vias refuses it
    expect(e.vie.some((v) => v.x === 0 && v.y === 0)).toBe(false);
    expect(e.scarti).toEqual({ colata_altra_rete: 1 });
    // (-2, 0) bites the other side of the disc and leaves it on its bridge
    expect(e.vie.some((v) => v.x === -2 && v.y === 0)).toBe(true);
    // with the vias proposed the via of the plane is on the plane, the one piece of it
    const dopo = ricolato(piano, [fessura], e.vie);
    expect(dopo).toHaveLength(1);
    expect(nelRame(dopo[0], -1, 0)).toBe(true);
    // with the one refused it is not: the re-pour leaves it on a piece of its own
    const tagliato = ricolato(piano, [fessura], [...e.vie, { x: 0, y: 0 }]);
    expect(tagliato.length).toBeGreaterThan(1);
    expect(nelRame(tagliato[0], -1, 0)).toBe(false);
  });

  it("due colate della stessa rete che si sovrappongono sono un rame solo: la via che le staccherebbe una dall'altra", () => {
    /*
     * The P3V3 copper of inner2 written as two pours: a block on the left and
     * one on the right, each with a tab 0.6 wide toward the other, the two tabs
     * lying one over the other for 0.6 mm at the origin. An opening there takes
     * the overlap away: neither pour is cut (each tab is only shorter), and the
     * two no longer meet.
     */
    const sinistra = [{ x: -9.7, y: -9.7 }, { x: -1, y: -9.7 }, { x: -1, y: -0.3 }, { x: 0.3, y: -0.3 }, { x: 0.3, y: 0.3 }, { x: -1, y: 0.3 }, { x: -1, y: 9.7 }, { x: -9.7, y: 9.7 }];
    const destra = sinistra.map((p) => ({ x: -p.x, y: p.y })).reverse();
    const cj = [...scheda(), ...massa(), colata("inner2", sinistra, "source_net_1"), colata("inner2", destra, "source_net_1")];
    const e = cuci(cj, { bordo: false, passoMm: 2, sfalsata: false });
    expect(e.vie.some((v) => v.x === 0 && v.y === 0)).toBe(false);
    expect(e.scarti).toEqual({ colata_altra_rete: 1 });
    expect(e.pianiAttraversati.vie).toBeGreaterThan(50);
    // the two as the one copper they are: with the vias proposed still one piece, with the one refused two
    const insieme = [{ x: -9.7, y: -9.7 }, { x: -1, y: -9.7 }, { x: -1, y: -0.3 }, { x: 1, y: -0.3 }, { x: 1, y: -9.7 }, { x: 9.7, y: -9.7 }, { x: 9.7, y: 9.7 }, { x: 1, y: 9.7 }, { x: 1, y: 0.3 }, { x: -1, y: 0.3 }, { x: -1, y: 9.7 }, { x: -9.7, y: 9.7 }];
    expect(ricolato(insieme, [], e.vie)).toHaveLength(1);
    expect(ricolato(insieme, [], [...e.vie, { x: 0, y: 0 }])).toHaveLength(2);
    // and each of the two alone would have let it through: its tab is only shorter
    expect(ricolato(sinistra, [], [{ x: 0, y: 0 }])).toHaveLength(1);
    expect(ricolato(destra, [], [{ x: 0, y: 0 }])).toHaveLength(1);
  });

  it("l'apertura non morde il rame della rete del piano: un piano che chiede piu' distanza tiene le vie piu' lontane dalle sue", () => {
    // the plane keeps 0.4 of its own: it opens 0.65 around a ground via, more than the 0.25 a via keeps from the via of another net
    const piano = rett(-9.7, -9.7, 9.7, 9.7);
    const cj = [...scheda(), ...massa(), colata("inner2", piano, "source_net_1", [], { [DISTANZA_PROPRIA]: 0.4 }), via(1.2, 0, "k_p3v3")];
    const e = cuci(cj, { bordo: false, passoMm: 2, sfalsata: false });
    expect(e.pianiAttraversati.vie).toBe(e.vie.length);
    // (2, 0): its ring 0.3 from the ring of the plane's via, enough for the rule between vias, and the opening would cut into that ring
    expect(e.vie.some((v) => v.x === 2 && v.y === 0)).toBe(false);
    expect(e.scarti).toEqual({ colata_altra_rete: 1 });
    expect(e.vie.some((v) => v.x === 0 && v.y === 0)).toBe(true);
    for (const v of e.vie) expect(Math.hypot(v.x - 1.2, v.y) - R - R).toBeGreaterThanOrEqual(0.4 - 1e-9);
    expect(ricolato(piano, [], e.vie, R + 0.4)).toHaveLength(1);
  });
});
