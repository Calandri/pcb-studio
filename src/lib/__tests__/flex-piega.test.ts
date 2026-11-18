import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ParteFlessibile } from "@/components/board/ParteFlessibile";
import { puntoVersoIlGlb, scenaDelFlessibile, versoIlGlb, type MeshDelFlessibile } from "@/lib/flex-3d";
import { contornoRigido, soloLaParteRigida } from "@/lib/flex-glb";
import { piegaPunto, piegaturaDi, testoDellaCoda, testoDellaPiega } from "@/lib/flex-piega";
import { flessibileDellaScheda, type Punto } from "@/lib/flex-zone";

/*
 * "La scheda che vedo nel 3D non ha il minimo senso logico", "la scheda deve
 * piegarsi di 90 gradi" (Niccolo', 2026-11-18): il visore 3D disegnava la coda
 * della tm-4l-q1 come 45 mm di scheda rigida da 1,6 mm, piatta. Qui la coda si
 * piega come dice flex.json. La scheda di prova e' la Q1 semplificata: parte
 * rigida 42,5 x 51,5, coda larga 37 che esce dal bordo basso (y = -25,75),
 * due pieghe a 90 gradi verso il top con raggio 2,2 a y = -28,117 e -34,002,
 * pila da 0,1 mm, irrigiditore FR4 da 0,8 sotto.
 */
type El = Record<string, unknown> & { type: string };
const rett = (x1: number, y1: number, x2: number, y2: number): Punto[] => [
  { x: x1, y: y1 },
  { x: x2, y: y1 },
  { x: x2, y: y2 },
  { x: x1, y: y2 },
];
const BORDO = -25.75;
const FINE = -70.169;
const CODA = rett(-16.25, FINE, 20.75, BORDO);
const CONTORNO: Punto[] = [
  { x: -21.25, y: 25.75 },
  { x: -21.25, y: BORDO },
  { x: -16.25, y: BORDO },
  { x: -16.25, y: FINE },
  { x: 20.75, y: FINE },
  { x: 20.75, y: BORDO },
  { x: 21.25, y: BORDO },
  { x: 21.25, y: 25.75 },
];
const piega = (i: number, y: number, verso = "su", angolo = 90, raggio = 2.2): El => ({
  type: "pcb_flex_bend",
  pcb_flex_bend_id: `pcb_flex_bend_${i}`,
  nome: `piega ${i + 1}`,
  from: { x: -16.25, y },
  to: { x: 20.75, y },
  radius_mm: raggio,
  angle_deg: angolo,
  direction: verso,
});
function scheda(pieghe: El[], extra: El[] = []): El[] {
  return [
    { type: "pcb_board", pcb_board_id: "b", center: { x: 0, y: 0 }, width: 42.5, height: 95.919, thickness: 1.6, outline: CONTORNO },
    {
      type: "pcb_flex_zone",
      pcb_flex_zone_id: "z0",
      nome: "coda di massa",
      layers: ["inner2"],
      points: CODA,
      cutouts: [{ nome: "foro vite", points: rett(8.5, -47.9, 10.9, -45.5) }],
    },
    { type: "pcb_flex_stackup", pcb_flex_stackup_id: "s0", thickness_mm: 0.1, coverlay: "giallo", materials: [] },
    ...pieghe,
    {
      type: "pcb_flex_stiffener",
      pcb_flex_stiffener_id: "i0",
      nome: "rinforzo",
      layer: "bottom",
      material: "fr4",
      thickness_mm: 0.8,
      points: rett(5.7, -50.419, 13.4, -42.719),
      holes: [{ x: 9.7, y: -46.719, diameter_mm: 2.4 }],
    },
    ...extra,
  ];
}
const Q1 = scheda([piega(0, -28.117), piega(1, -34.002)]);
const TOP_RIGIDO = 0.8;
/** la quota della mezzeria della coda ripiegata: due archi di raggio 2,25 e il tratto dritto fra i due archi */
const ZM = 2 * 2.25 + (34.002 - 28.117 - 2.25 * (Math.PI / 2));

const coda = (els: El[]) => piegaturaDi(flessibileDellaScheda(els)!).code[0];
const vertici = (m: MeshDelFlessibile[], parte: string): number[][] => {
  const out: number[][] = [];
  for (const x of m.filter((q) => q.parte === parte)) for (let i = 0; i < x.posizioni.length; i += 3) out.push([x.posizioni[i], x.posizioni[i + 1], x.posizioni[i + 2]]);
  return out;
};

describe("la coda piegata come dice flex.json", () => {
  it("Q1: le due pieghe a 90 gradi verso il top riportano la coda 6,0 mm sopra il top della scheda, parallela", () => {
    const c = coda(Q1);
    expect(c.pieghe.map((p) => p.numero)).toEqual([1, 2]);
    expect(c.angoloTotale).toBe(180);
    // la faccia della coda che dopo la U guarda la scheda e' quella che era il top (w = +0,05)
    const quote = [-40, -50, -60, -70].map((y) => piegaPunto(c, 0, y, 0.05)[2]);
    for (const z of quote) expect(z - TOP_RIGIDO).toBeCloseTo(6.0, 2);
    // parallela: la stessa quota dappertutto, anche di traverso
    expect(piegaPunto(c, -15, -60, 0.05)[2]).toBeCloseTo(quote[0], 9);
    expect(piegaPunto(c, 20, -45, 0.05)[2]).toBeCloseTo(quote[0], 9);
  });

  it("Q1: la coda torna sopra la scheda, dal lato top, senza allungarsi", () => {
    const c = coda(Q1);
    // in fondo alla coda: 34,4 mm oltre l'arco della seconda piega, partendo da y = -26,35
    const fine = piegaPunto(c, 0, FINE, 0);
    expect(fine[1]).toBeCloseTo(-26.35 + (-35.769 - FINE), 1);
    expect(fine[1]).toBeGreaterThan(BORDO);
    // la mezzeria non si allunga: la somma dei tratti piegati e' la lunghezza piana
    let lungo = 0;
    let prima = piegaPunto(c, 0, BORDO, 0);
    let ultimo = BORDO;
    for (let k = 1; BORDO - k * 0.05 >= FINE; k++) {
      ultimo = BORDO - k * 0.05;
      const p = piegaPunto(c, 0, ultimo, 0);
      lungo += Math.hypot(p[0] - prima[0], p[1] - prima[1], p[2] - prima[2]);
      prima = p;
    }
    expect(lungo).toBeCloseTo(BORDO - ultimo, 3);
  });

  it("la faccia interna dell'arco sta al raggio dichiarato, la parte prima della piega resta piana", () => {
    const c = coda(Q1);
    expect(piegaPunto(c, 3, -26.0, 0.05)).toEqual([3, -26.0, 0.05]);
    // a meta' della prima piega: centro dell'arco a y = -26,35 - 0, z = 2,25
    const p = c.pieghe[0];
    const centro = { y: p.c.y - p.h * p.n.y, z: p.rm };
    const dentro = piegaPunto(c, 0, -28.117, 0.05);
    expect(Math.hypot(dentro[1] - centro.y, dentro[2] - centro.z)).toBeCloseTo(2.2, 6);
    const fuori = piegaPunto(c, 0, -28.117, -0.05);
    expect(Math.hypot(fuori[1] - centro.y, fuori[2] - centro.z)).toBeCloseTo(2.3, 6);
  });

  it("una sola piega a 90 gradi: la coda sale in verticale; verso il bottom scende", () => {
    const su = coda(scheda([piega(0, -30)]));
    const a = piegaPunto(su, 0, -50, 0);
    const b = piegaPunto(su, 0, -60, 0);
    expect(a[1]).toBeCloseTo(b[1], 9);
    expect(b[2] - a[2]).toBeCloseTo(10, 9);
    expect(testoDellaCoda(su)).toBe("coda flessibile: una piega, in tutto 90° verso il top, esce in verticale sopra la scheda");
    const giu = coda(scheda([piega(0, -30, "giu")]));
    expect(piegaPunto(giu, 0, -60, 0)[2]).toBeLessThan(-10);
    expect(testoDellaPiega(giu.pieghe[0])).toBe("piega 1: 90° verso il bottom");
  });

  it("una piega a 180 gradi: la coda ripiegata e' a due raggi di mezzeria sopra", () => {
    const c = coda(scheda([piega(0, -30, "su", 180, 1)]));
    expect(piegaPunto(c, 0, -60, 0)[2]).toBeCloseTo(2 * 1.05, 9);
    expect(testoDellaCoda(c)).toBe("coda flessibile: una piega, in tutto 180° verso il top, torna sopra la scheda");
  });

  it("le parole: numero, angolo e verso di ogni piega, e la somma sulla coda", () => {
    const c = coda(Q1);
    expect(c.pieghe.map(testoDellaPiega)).toEqual(["piega 1: 90° verso il top", "piega 2: 90° verso il top"]);
    expect(testoDellaCoda(c)).toBe("coda flessibile: 2 pieghe, in tutto 180° verso il top, torna sopra la scheda");
  });

  it("pieghe con gli archi sovrapposti: la coda resta piana e lo dice", () => {
    const c = coda(scheda([piega(0, -28), piega(1, -29)]));
    expect(c.pieghe).toEqual([]);
    expect(testoDellaCoda(c)).toMatch(/troppo vicine/);
  });
});

describe("la coda in 3D (flex-3d)", () => {
  it("piegata: sottile, la coda ripiegata sopra la scheda, l'irrigiditore sulla faccia che ora guarda in su", () => {
    const s = scenaDelFlessibile(Q1)!;
    expect(s.spessoreMm).toBe(0.1);
    const lam = vertici(s.piegata.meshes, "laminato");
    expect(lam.length).toBeGreaterThan(100);
    const zMax = Math.max(...lam.map((v) => v[2]));
    expect(zMax).toBeCloseTo(ZM + 0.05, 4);
    // la parte oltre la seconda piega (ora sopra la scheda) e' tutta sulle due facce della coda ripiegata
    const oltre = lam.filter((v) => v[1] > BORDO + 0.5);
    expect(oltre.length).toBeGreaterThan(50);
    for (const v of oltre) expect([ZM - 0.05, ZM + 0.05].some((z) => Math.abs(v[2] - z) < 1e-4)).toBe(true);
    // l'irrigiditore era sotto: dopo la U sta sopra la coda, alto 0,8
    const irr = vertici(s.piegata.meshes, "irrigiditore");
    expect(Math.min(...irr.map((v) => v[2]))).toBeCloseTo(ZM + 0.05, 4);
    expect(Math.max(...irr.map((v) => v[2]))).toBeCloseTo(ZM + 0.85, 4);
    expect(s.piegata.etichette.map((e) => e.testo)).toEqual(["piega 1: 90° verso il top", "piega 2: 90° verso il top"]);
    expect(s.testiDelleCode).toEqual(["coda flessibile: 2 pieghe, in tutto 180° verso il top, torna sopra la scheda"]);
  });

  it("spianata: la coda com'era ma sottile, nel piano di mezzo della scheda", () => {
    const s = scenaDelFlessibile(Q1)!;
    const lam = vertici(s.spianata.meshes, "laminato");
    for (const v of lam) expect(Math.abs(v[2])).toBeLessThanOrEqual(0.05 + 1e-6);
    const ys = lam.map((v) => v[1]);
    expect(Math.min(...ys)).toBeCloseTo(FINE, 3);
    expect(Math.max(...ys)).toBeCloseTo(BORDO, 3);
  });

  it("il ritaglio e' un buco nella coda", () => {
    const s = scenaDelFlessibile(Q1)!;
    // nessun triangolo della faccia piana copre il centro del ritaglio
    const lam = s.spianata.meshes.find((m) => m.parte === "laminato")!.posizioni;
    const dentro = (px: number, py: number) => {
      for (let i = 0; i < lam.length; i += 9) {
        const [ax, ay, bx, by, cx, cy] = [lam[i], lam[i + 1], lam[i + 3], lam[i + 4], lam[i + 6], lam[i + 7]];
        const d = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
        if (Math.abs(d) < 1e-12) continue;
        const u = ((bx - px) * (cy - py) - (cx - px) * (by - py)) / d;
        const v = ((cx - px) * (ay - py) - (ax - px) * (cy - py)) / d;
        if (u >= 0 && v >= 0 && u + v <= 1) return true;
      }
      return false;
    };
    expect(dentro(9.7, -46.7)).toBe(false);
    expect(dentro(0, -46.7)).toBe(true);
  });

  it("il rame degli strati della zona, tagliato alla zona e piegato con lei", () => {
    const colata: El = {
      type: "pcb_copper_pour",
      pcb_copper_pour_id: "p0",
      layer: "inner2",
      shape: "brep",
      brep_shape: { outer_ring: { vertices: rett(-21, -69.9, 21, 25.5) }, inner_rings: [{ vertices: rett(-2, -61, 2, -57) }] },
    };
    const s = scenaDelFlessibile(scheda([piega(0, -28.117), piega(1, -34.002)], [colata]))!;
    const piano = vertici(s.spianata.meshes, "rame");
    expect(piano.length).toBeGreaterThan(0);
    // solo nella coda (y sotto il bordo), mai nella parte rigida
    for (const v of piano) expect(v[1]).toBeLessThanOrEqual(BORDO + 1e-6);
    // piegato: oltre la seconda piega a meta' spessore della coda ripiegata
    const piegato = vertici(s.piegata.meshes, "rame");
    expect(Math.max(...piegato.map((v) => v[2]))).toBeCloseTo(ZM, 4);
    // un rame su uno strato che la zona non ha non c'e'
    const altro = scenaDelFlessibile(scheda([piega(0, -28.117)], [{ ...colata, layer: "top" }]))!;
    expect(vertici(altro.spianata.meshes, "rame")).toEqual([]);
  });

  it("un pezzo sulla coda segue la piega", () => {
    const pezzo: El = { type: "pcb_component", pcb_component_id: "pc1", center: { x: 0, y: -60 }, width: 2, height: 1, layer: "top", rotation: 0 };
    const s = scenaDelFlessibile(scheda([piega(0, -28.117), piega(1, -34.002)], [pezzo]))!;
    const v = vertici(s.piegata.meshes, "pezzo");
    expect(v.length).toBe(36);
    // era sul top: dopo la U pende sotto la coda, verso la scheda
    expect(Math.max(...v.map((q) => q[2]))).toBeCloseTo(ZM - 0.05, 4);
    expect(Math.min(...v.map((q) => q[2]))).toBeCloseTo(ZM - 1.05, 4);
  });

  it("nel sistema del GLB: x girata, y della scheda su Z, l'alto su Y; le facce restano dritte", () => {
    // misurato sul GLB della tm-4l-q1: U2, a (-6,375; -4,25) sul bottom, sta nel nodo a (6,375; -0,8; -4,25)
    expect(puntoVersoIlGlb([-6.375, -4.25, -0.8])).toEqual([6.375, -0.8, -4.25]);
    // un triangolo della faccia top (antiorario visto da +z) resta rivolto in su (+Y)
    const t = versoIlGlb(new Float32Array([0, 0, 1, 1, 0, 1, 0, 1, 1]));
    const u = [t[3] - t[0], t[4] - t[1], t[5] - t[2]];
    const v = [t[6] - t[0], t[7] - t[1], t[8] - t[2]];
    expect(u[2] * v[0] - u[0] * v[2]).toBeGreaterThan(0);
  });

  it("una scheda senza flex.json non ha niente da disegnare", () => {
    expect(scenaDelFlessibile([{ type: "pcb_board", width: 10, height: 10 }])).toBeNull();
  });
});

describe("il GLB porta solo la parte rigida (flex-glb)", () => {
  it("il contorno meno la coda e' il rettangolo rigido", async () => {
    const r = await contornoRigido(CONTORNO, [CODA]);
    expect(r).not.toBeNull();
    const ys = r!.map((p) => p.y);
    expect(Math.min(...ys)).toBeCloseTo(BORDO, 6);
    let a = 0;
    for (let i = 0, j = r!.length - 1; i < r!.length; j = i++) a += (r![j].x + r![i].x) * (r![j].y - r![i].y);
    expect(Math.abs(a / 2)).toBeCloseTo(42.5 * 51.5, 3);
  });

  it("il circuito per il GLB: contorno rigido, niente modello 3D dei pezzi sulla coda", async () => {
    const els = scheda(
      [piega(0, -28.117)],
      [
        { type: "pcb_component", pcb_component_id: "sulla_coda", center: { x: 0, y: -60 } },
        { type: "pcb_component", pcb_component_id: "sul_rigido", center: { x: 0, y: 0 } },
        { type: "cad_component", cad_component_id: "c1", pcb_component_id: "sulla_coda" },
        { type: "cad_component", cad_component_id: "c2", pcb_component_id: "sul_rigido" },
      ],
    );
    expect(await soloLaParteRigida(els)).toBe("rigida");
    const board = els.find((e) => e.type === "pcb_board")!;
    expect(Math.min(...(board.outline as Punto[]).map((p) => p.y))).toBeCloseTo(BORDO, 6);
    expect(els.filter((e) => e.type === "cad_component").map((e) => e.pcb_component_id)).toEqual(["sul_rigido"]);
  });

  it("una coda fra due parti rigide: il GLB resta intero", async () => {
    const contorno = [
      { x: -10, y: 10 }, { x: -10, y: 0 }, { x: -2, y: 0 }, { x: -2, y: -20 }, { x: -10, y: -20 }, { x: -10, y: -30 },
      { x: 10, y: -30 }, { x: 10, y: -20 }, { x: 2, y: -20 }, { x: 2, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 },
    ];
    expect(await contornoRigido(contorno, [rett(-2, -20, 2, 0)])).toBeNull();
  });

  it("una scheda senza zone flessibili non si tocca", async () => {
    const els: El[] = [{ type: "pcb_board", width: 10, height: 10 }];
    expect(await soloLaParteRigida(els)).toBeNull();
    expect(els).toEqual([{ type: "pcb_board", width: 10, height: 10 }]);
  });
});

describe("la vista PCB dice come piega la coda", () => {
  it("accanto a ogni linea numero, angolo e verso; sulla coda la somma", () => {
    const svg = renderToStaticMarkup(createElement(ParteFlessibile, { flessibile: flessibileDellaScheda(Q1), mmPerPx: 0.1 }));
    expect(svg).toContain("piega 1: 90° verso il top");
    expect(svg).toContain("piega 2: 90° verso il top");
    expect(svg).toContain("coda flessibile: 2 pieghe, in tutto 180° verso il top, torna sopra la scheda");
    // dentro il gruppo con y in su: il testo e' raddrizzato, non a specchio
    expect(svg).toMatch(/scale\(1 -1\)/);
  });
});
