import { getManifoldModule } from "@tscircuit/manifold-2d";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { ParteFlessibile } from "@/components/board/ParteFlessibile";
import { DEFAULT_DESIGN_RULES } from "@/lib/design-rules";
import { runDrcChecks } from "@/lib/drc";
import { conFlessibile, ESEMPIO_FLEX, ESEMPIO_FLEX_DUE_STRATI, fileDelFlessibile, fileDelloStrato, FILE_COVERLAY, FLEX_PATH, ostacoliDelFlessibile, validaFileDelFlessibile } from "@/lib/flex";
import { scenaDelFlessibile } from "@/lib/flex-3d";
import { soloLaParteRigida } from "@/lib/flex-glb";
import { conRetino, ANELLO_DEL_RETINO } from "@/lib/flex-retino";
import { piegaPunto, piegaturaDi, testoDellaCoda } from "@/lib/flex-piega";
import { flessibileDellaScheda, nelPoligono, type Punto } from "@/lib/flex-zone";

/*
 * DUE STRATI FLESSIBILI INDIPENDENTI (air gap). Il caso della Q1 e della R3 v3
 * (B2_sagoma_Q1.json, 18/11/2026), semplificato: dal bordo basso della parte
 * rigida (y = -25,75) escono una «parte ripiegata» sul foglio con inner2 (x
 * -16,25..14,2, due pieghe a 90 gradi verso il top) e una «striscia» sul
 * foglio con inner1 (x 14,7..20,75, una piega a 90 gradi) che in fondo gira a L
 * sotto la parte ripiegata: spianate si sovrappongono. Il contorno della scheda
 * e' tutto il materiale; la fessura fra le due code, chiusa in fondo dalla L, e'
 * un cutout della scheda. E' l'esempio della documentazione (ESEMPIO_FLEX_DUE_STRATI).
 */
type El = Record<string, unknown> & { type: string };
const R = (x1: number, y1: number, x2: number, y2: number): Punto[] => [
  { x: x1, y: y1 },
  { x: x2, y: y1 },
  { x: x2, y: y2 },
  { x: x1, y: y2 },
];
const CONTORNO: Punto[] = [
  { x: -21.25, y: 25.75 },
  { x: -21.25, y: -25.75 },
  { x: -16.25, y: -25.75 },
  { x: -16.25, y: -56 },
  { x: -30, y: -56 },
  { x: -30, y: -62 },
  { x: 20.75, y: -62 },
  { x: 20.75, y: -25.75 },
  { x: 21.25, y: -25.75 },
  { x: 21.25, y: 25.75 },
];
const FESSURA = R(14.2, -56, 14.7, -25.75);
const STRATI = ["top", "inner1", "inner2", "bottom"];
const BOARD: El = { type: "pcb_board", pcb_board_id: "b", center: { x: 0, y: 0 }, width: 51.25, height: 87.75, thickness: 1.6, num_layers: 4, outline: CONTORNO };
const VUOTO: El = { type: "pcb_cutout", pcb_cutout_id: "fessura", shape: "polygon", points: FESSURA };
const SCHEDA = { contorno: CONTORNO, strati: STRATI };
const file = (v: unknown) => ({ [FLEX_PATH]: JSON.stringify(v) });
const conIlFlex = (v: unknown = ESEMPIO_FLEX_DUE_STRATI, extra: El[] = []): El[] => conFlessibile([{ ...BOARD }, VUOTO, ...extra], file(v));
const errori = (v: unknown) => {
  const e = validaFileDelFlessibile(JSON.stringify(v), SCHEDA);
  return "errori" in e ? e.errori : [];
};
const copia = () => JSON.parse(JSON.stringify(ESEMPIO_FLEX_DUE_STRATI)) as typeof ESEMPIO_FLEX_DUE_STRATI & Record<string, unknown>;

beforeAll(async () => {
  await getManifoldModule();
});

describe("il formato: pila.flessibili e zona.flessibile", () => {
  it("l'esempio a due strati e' valido sulla scheda di cui e' tutto il materiale", () => {
    const e = validaFileDelFlessibile(JSON.stringify(ESEMPIO_FLEX_DUE_STRATI), SCHEDA);
    expect("errori" in e ? e.errori : []).toEqual([]);
    if ("flex" in e) {
      expect(e.flex.pila?.flessibili?.map((f) => [f.nome, f.strati, f.spessoreMm])).toEqual([
        ["foglio inner2", ["inner2"], 0.1],
        ["foglio inner1", ["inner1"], 0.1],
      ]);
      // gli strati della zona, se non scritti, sono quelli del suo foglio
      expect(e.flex.zone.map((z) => [z.nome, z.flessibile, z.strati])).toEqual([
        ["parte ripiegata", "foglio inner2", ["inner2"]],
        ["striscia", "foglio inner1", ["inner1"]],
      ]);
    }
  });

  it("due zone dello stesso foglio non si sovrappongono", () => {
    const f = copia();
    f.zone[1].flessibile = "foglio inner2";
    expect(errori(f).join(" ")).toMatch(/si sovrappone alla zona «parte ripiegata», che e' sullo stesso strato flessibile «foglio inner2»/);
  });

  it("uno strato di rame continua in un solo foglio, la zona ha solo strati del suo foglio, flessibile solo con pila.flessibili", () => {
    const f = copia();
    f.pila.flessibili[1].strati = ["inner2"];
    expect(errori(f).join(" ")).toMatch(/continua in un solo strato flessibile/);
    const g = copia();
    (g.zone[0] as Record<string, unknown>).strati = ["inner1"];
    expect(errori(g).join(" ")).toMatch(/ha il rame di inner2: la zona puo' averne solo di questi/);
    const h = { ...ESEMPIO_FLEX, zone: [{ ...ESEMPIO_FLEX.zone[0], flessibile: "x" }] };
    expect(errori(h).join(" ")).toMatch(/non dichiara strati flessibili indipendenti/);
  });

  it("dove due zone si sovrappongono una piega, un irrigiditore o un'apertura deve dire la sua zona", () => {
    const f = copia();
    // un irrigiditore nella parte comune, senza zona
    f.irrigiditori = [{ ...f.irrigiditori[0], zona: undefined as unknown as string, punti: R(-10, -59, -5, -57), fori: [] }];
    expect(errori(f).join(" ")).toMatch(/sta in 2 zone sovrapposte .*scrivi "zona"/);
    f.irrigiditori[0].zona = "striscia";
    expect(errori(f)).toEqual([]);
  });

  it("sulla scheda: le zone col loro foglio, le pieghe e gli irrigiditori con la loro zona, la pila coi fogli; i ritagli non sono cutout della scheda", () => {
    const f = copia();
    (f.zone[0] as Record<string, unknown>).ritagli = [{ nome: "foro", punti: R(9, -47.5, 10.5, -46) }];
    const cj = conIlFlex(f);
    expect(cj.filter((e) => e.type === "pcb_flex_zone").map((e) => [e.nome, e.flex_layer, e.layers])).toEqual([
      ["parte ripiegata", "foglio inner2", ["inner2"]],
      ["striscia", "foglio inner1", ["inner1"]],
    ]);
    expect(cj.filter((e) => e.type === "pcb_flex_bend").map((e) => e.pcb_flex_zone_id)).toEqual(["pcb_flex_zone_0", "pcb_flex_zone_0", "pcb_flex_zone_1"]);
    expect(cj.find((e) => e.type === "pcb_flex_stiffener")?.pcb_flex_zone_id).toBe("pcb_flex_zone_0");
    expect((cj.find((e) => e.type === "pcb_flex_stackup")?.flex_layers as unknown[]).length).toBe(2);
    expect(cj.filter((e) => e.type === "pcb_cutout").map((e) => e.pcb_cutout_id)).toEqual(["fessura"]);
  });

  it("un flex.json di un solo foglio mette sulla scheda gli stessi elementi di prima, senza campi nuovi", () => {
    const cj = conFlessibile([{ ...BOARD, outline: [...R(-21.25, -60.75, 21.25, 25.75)] }], file(ESEMPIO_FLEX));
    for (const e of cj.filter((q) => q.type.startsWith("pcb_flex_"))) {
      expect(e).not.toHaveProperty("flex_layer");
      expect(e).not.toHaveProperty("flex_layers");
      if (e.type !== "pcb_flex_zone") expect(e).not.toHaveProperty("pcb_flex_zone_id");
    }
    expect(cj.some((e) => e.type === "pcb_cutout")).toBe(true);
  });
});

describe("dove finisce la parte rigida: misurato su cosa c'e' fuori da ogni lato", () => {
  it("la parte ripiegata confina col rigido solo sul bordo y = -25,75; il lato sulla fessura e quello sotto la striscia sono tagli", () => {
    const flex = flessibileDellaScheda(conIlFlex())!;
    const [rip, str] = flex.zone;
    const tutti = (l: { ax: number; bx: number; ay: number; by: number }[]) => l.map((q) => [Math.min(q.ax, q.bx), Math.max(q.ax, q.bx), q.ay, q.by]);
    expect(tutti(rip.confini)).toEqual([[-16.25, 14.2, -25.75, -25.75]]);
    expect(tutti(str.confini)).toEqual([[14.7, 20.75, -25.75, -25.75]]);
    // il lato x = 14,2 lungo la fessura e il fondo della parte ripiegata (sopra la L della striscia) sono tagli
    expect(rip.bordi.some((l) => l.ax === 14.2 && l.bx === 14.2)).toBe(true);
    expect(rip.bordi.some((l) => l.ay === -60 && l.by === -60)).toBe(true);
  });
});

describe("le colate: uno strato e' bucato da una zona solo dove nessuna zona con quello strato le sta sopra", () => {
  it("inner2 (della parte ripiegata): bucata dalla striscia tranne dove la parte ripiegata le sta sopra", () => {
    const ostacoli = ostacoliDelFlessibile([BOARD, VUOTO], file(ESEMPIO_FLEX_DUE_STRATI), 0.3, 0.25)!;
    const dentro = (strato: string, x: number, y: number) => ostacoli(strato).some((o) => nelPoligono(x, y, o.points as Punto[]));
    expect(dentro("inner2", 17, -40)).toBe(true); // striscia sola
    expect(dentro("inner2", -25, -59)).toBe(true); // la L della striscia oltre la parte ripiegata
    expect(dentro("inner2", 0, -58)).toBe(false); // la parte comune: c'e' il foglio con inner2
    expect(dentro("inner2", 0, -40)).toBe(false); // parte ripiegata
    expect(dentro("inner1", 0, -40)).toBe(true);
    expect(dentro("inner1", 0, -58)).toBe(false);
    expect(dentro("inner1", 17, -40)).toBe(false);
    // top e bottom non continuano in nessun foglio: bucati da tutte e due
    for (const p of [[0, -40], [17, -40], [0, -58]]) expect(dentro("top", p[0], p[1])).toBe(true);
  });
});

describe("il DRC per zona e per strato", () => {
  const drc = (els: El[]) => runDrcChecks(els as never, DEFAULT_DESIGN_RULES).filter((v) => v.rule.startsWith("flex_"));
  const pista = (id: string, layer: string, a: Punto, b: Punto): El => ({
    type: "pcb_trace",
    pcb_trace_id: id,
    route: [
      { route_type: "wire", x: a.x, y: a.y, width: 0.2, layer },
      { route_type: "wire", x: b.x, y: b.y, width: 0.2, layer },
    ],
  });

  it("una pista su inner2 nella parte comune e' del foglio con inner2: nessun errore; su inner1 nella sola parte ripiegata si'", () => {
    const giusta = drc(conIlFlex(undefined, [pista("t1", "inner2", { x: -10, y: -58.5 }, { x: 0, y: -58.5 })]));
    expect(giusta.filter((v) => v.rule === "flex_copper_layer")).toEqual([]);
    const sbagliata = drc(conIlFlex(undefined, [pista("t2", "inner1", { x: -10, y: -45 }, { x: 0, y: -45 })]));
    expect(sbagliata.filter((v) => v.rule === "flex_copper_layer").map((v) => v.message).join(" ")).toMatch(/inner1 nella zona flessibile «parte ripiegata»/);
  });

  it("l'esempio non ha errori della parte flessibile; la fessura sotto 0,5 si'", () => {
    expect(drc(conIlFlex())).toEqual([]);
    const f = copia();
    f.zone[1].punti[0] = { x: 14.4, y: -25.75 };
    f.zone[1].punti[5] = { x: 14.4, y: -56 };
    const stretta = conFlessibile([BOARD, { ...VUOTO, points: R(14.2, -56, 14.4, -25.75) }], file(f));
    const v = drc(stretta).filter((q) => q.rule === "flex_slot");
    expect(v).toHaveLength(1);
    expect(v[0].message).toMatch(/a 0\.2mm l'una dall'altra < min 0\.5mm/);
  });

  it("due zone dello stesso foglio sovrapposte sulla scheda: flex_layer_overlap", () => {
    const cj = conIlFlex().map((e) => (e.type === "pcb_flex_zone" && e.nome === "striscia" ? { ...e, flex_layer: "foglio inner2" } : e));
    expect(drc(cj).map((v) => v.rule)).toContain("flex_layer_overlap");
  });

  it("il raggio di piega si misura sullo spessore del foglio della sua zona", () => {
    const f = copia();
    (f.pila.flessibili[1] as Record<string, unknown>).spessoreMm = 0.3;
    // striscia: 2,2 < 10 x 0,3 = 3
    const v = drc(conIlFlex(f)).filter((q) => q.rule === "flex_bend_radius");
    expect(v.map((q) => q.message).join(" ")).toMatch(/piega «striscia»: raggio interno 2\.2mm < min 3mm/);
    expect(v).toHaveLength(1);
  });
});

describe("l'export: un profilo e un coverlay per foglio, la pila coi due fogli", () => {
  it("Flex1 e Flex2 col loro profilo e coverlay, niente coverlay unico; RigidFlex_Stackup dice air gap", () => {
    const fuori = fileDelFlessibile(conIlFlex(), {}, "prova");
    const nomi = Object.keys(fuori);
    for (const k of [1, 2]) {
      expect(nomi).toContain(fileDelloStrato(k).profilo);
      expect(nomi).toContain(fileDelloStrato(k).coverlay.top);
      expect(nomi).toContain(fileDelloStrato(k).coverlay.bottom);
    }
    expect(nomi).not.toContain(FILE_COVERLAY.top);
    const testo = fuori["RigidFlex_Stackup.txt"];
    expect(testo).toContain("2 INDEPENDENT FLEXIBLE LAYERS (AIR GAP)");
    expect(testo).toContain('Flexible layer 1 "foglio inner2": copper layers of the board that continue in it: Inner 2');
    expect(testo).toContain("Edge_Cuts.gbr        The envelope of the whole piece");
    // il profilo del foglio 2 ha la striscia e la sua piega, non la parte ripiegata
    expect(fuori[fileDelloStrato(2).profilo]).toContain("X20750000Y-62000000D01*");
    expect(fuori[fileDelloStrato(2).profilo]).not.toContain("X-16250000Y-60000000D01*");
  });

  it("un flex.json di un solo foglio ha i file di prima e nessun Flex1", () => {
    const fuori = fileDelFlessibile(conFlessibile([{ ...BOARD, outline: R(-21.25, -60.75, 21.25, 25.75) }], file(ESEMPIO_FLEX)), {}, "prova");
    expect(Object.keys(fuori).sort()).toEqual(["B_Coverlay.gbr", "B_Stiffener.gbr", "F_Coverlay.gbr", "Mech_RigidFlex.gbr", "RigidFlex_Stackup.txt"]);
  });
});

describe("il 3D e la vista PCB: ogni coda con le sue pieghe", () => {
  it("la parte ripiegata torna sopra la scheda, la striscia sale in verticale; i due fogli a quote diverse", () => {
    const flex = flessibileDellaScheda(conIlFlex())!;
    const [rip, str] = piegaturaDi(flex).code;
    expect(rip.pieghe).toHaveLength(2);
    expect(str.pieghe).toHaveLength(1);
    // inner1 sta sopra inner2 nella pila: la striscia esce piu' in alto
    expect(str.quotaMm).toBeGreaterThan(rip.quotaMm);
    expect(rip.angoloTotale).toBe(180);
    expect(str.angoloTotale).toBe(90);
    const a = piegaPunto(str, 17, -45, 0);
    const b = piegaPunto(str, 17, -50, 0);
    expect(b[2] - a[2]).toBeCloseTo(5, 6);
    expect(testoDellaCoda(str)).toBe("coda «striscia» (foglio inner1): una piega, in tutto 90° verso il top, esce in verticale sopra la scheda");
    const scena = scenaDelFlessibile(conIlFlex())!;
    expect(scena.piegata.etichette).toHaveLength(3);
  });

  it("il GLB ha la sola parte rigida: senza le due code e senza la fessura fra loro", async () => {
    const cj = conIlFlex();
    expect(await soloLaParteRigida(cj)).toBe("rigida");
    const contorno = cj.find((e) => e.type === "pcb_board")!.outline as Punto[];
    expect(Math.min(...contorno.map((p) => p.y))).toBeCloseTo(-25.75, 6);
    expect(Math.min(...contorno.map((p) => p.x))).toBeCloseTo(-21.25, 6);
  });

  it("nella vista PCB le zone hanno il colore del loro foglio e le pieghe le loro scritte", () => {
    const svg = renderToStaticMarkup(createElement(ParteFlessibile, { flessibile: flessibileDellaScheda(conIlFlex()), mmPerPx: 0.1 }));
    expect(svg).toContain('data-flessibile="foglio inner2"');
    expect(svg).toContain('data-flessibile="foglio inner1"');
    expect(svg).toContain("#4FC3F7");
    expect(svg).toContain("coda «parte ripiegata» (foglio inner2): 2 pieghe, in tutto 180° verso il top, torna sopra la scheda");
  });
});

describe("senza retino il rame della zona e' pieno, anche sulle pieghe", () => {
  it("una colata sulla piega non riceve nessun buco di griglia", () => {
    const colata: El = {
      type: "pcb_copper_pour",
      pcb_copper_pour_id: "p",
      layer: "inner2",
      shape: "brep",
      source_net_id: "gnd",
      brep_shape: { outer_ring: { vertices: R(-16, -59.5, 14, -26) }, inner_rings: [] },
    };
    const dopo = conRetino(conIlFlex(undefined, [colata]), 0.1);
    const p = dopo.find((e) => e.type === "pcb_copper_pour") as El & { brep_shape: { inner_rings: Array<Record<string, unknown>> } };
    expect(p.brep_shape.inner_rings.filter((a) => a[ANELLO_DEL_RETINO])).toEqual([]);
  });
});
