import { describe, expect, it } from "vitest";
import { apertiDellaScheda, collegamentiAperti, rameDellaScheda } from "@/lib/open-connections";
import { unroutedGroups } from "@/lib/route-score";
import { colata, pezzo, piedinoPassante, rete, scheda, trace, via, wire, type El } from "./scheda-di-prova";

const board = scheda();

/** i due capi di ogni tratto, senza verso */
const capi = (circuito: El[]) =>
  collegamentiAperti(circuito).collegamenti.map((c) => [c.da.piedino, c.a.piedino].sort().join(" - "));

/** tre resistenze in fila, un piedino ciascuna sulla stessa rete */
const treInFila: El[] = [
  board,
  ...pezzo("R1", [["1", 0, 0]]),
  ...pezzo("R2", [["1", 5, 0]]),
  ...pezzo("R3", [["1", 12, 0]]),
  ...rete(1, "SDA", ["R1_1", "R2_1", "R3_1"]),
];

describe("i collegamenti aperti veri", () => {
  it("rete tutta unita: nessuna linea", () => {
    const circuito = [...treInFila, trace("t1", "st_SDA_0", [wire(0, 0), wire(5, 0), wire(12, 0)])];
    expect(collegamentiAperti(circuito)).toEqual({ collegamenti: [], reti: 0 });
  });

  it("due gruppi: una linea, fra le due piazzole piu' vicine", () => {
    // R1 e R2 unite dalla pista, R3 sola: la linea va da R3 a R2 (7 mm), non a R1 (12 mm)
    const circuito = [...treInFila, trace("t1", "st_SDA_0", [wire(0, 0), wire(5, 0)])];
    const { collegamenti, reti } = collegamentiAperti(circuito);
    expect(reti).toBe(1);
    expect(collegamenti).toHaveLength(1);
    expect(collegamenti[0]).toMatchObject({
      nome: "SDA",
      // parte dal piedino rimasto fuori
      da: { piedino: "R3.1", x: 12, y: 0, strato: "top", componente: "pc_R3", porta: "pp_R3_1" },
      a: { piedino: "R2.1", x: 5, y: 0, strato: "top" },
      lunghezzaMm: 7,
    });
  });

  it("tre gruppi: due linee, non tre", () => {
    expect(capi(treInFila)).toEqual(["R1.1 - R2.1", "R2.1 - R3.1"]);
    expect(collegamentiAperti(treInFila).reti).toBe(1);
  });

  it("unione attraverso una via: top e bottom sono un gruppo solo", () => {
    const base: El[] = [
      board,
      ...pezzo("R1", [["1", 0, 0]]),
      ...pezzo("C1", [["1", 6, 0, "bottom"]]),
      ...rete(1, "SDA", ["R1_1", "C1_1"]),
      trace("t1", "st_SDA_0", [wire(0, 0), wire(3, 0)]),
      trace("t2", "st_SDA_1", [wire(3, 0, "bottom"), wire(6, 0, "bottom")]),
    ];
    // senza la via le due piste si sovrappongono in pianta ma non si toccano
    const senza = collegamentiAperti(base).collegamenti;
    expect(senza).toHaveLength(1);
    expect(senza[0]).toMatchObject({ da: { piedino: "R1.1", strato: "top" }, a: { piedino: "C1.1", strato: "bottom" } });
    expect(collegamentiAperti([...base, via("v", 3, 0, 1)]).collegamenti).toEqual([]);
  });

  it("unione attraverso una colata: le piazzole dentro la colata della loro rete sono unite", () => {
    const base: El[] = [
      board,
      ...pezzo("C1", [["2", 0, 0]]),
      ...pezzo("C2", [["2", 8, 0]]),
      ...pezzo("C3", [["2", 4, 6]]),
      ...rete(1, "GND", ["C1_2", "C2_2", "C3_2"]),
    ];
    expect(capi(base)).toHaveLength(2);
    // la colata prende C1 e C2; C3 resta fuori
    const conColata = collegamentiAperti([...base, colata("gnd", 1, "top", -2, -2, 10, 2)]).collegamenti;
    expect(conColata).toHaveLength(1);
    expect(conColata[0]).toMatchObject({ da: { piedino: "C3.2" } });
    // e il conteggio del compile e' lo stesso: una rete aperta, con quel tratto
    expect(unroutedGroups([...base, colata("gnd", 1, "top", -2, -2, 10, 2)]).get("chiave_1")?.tratti).toEqual(conColata);
  });

  it("unione attraverso un foro passante su due facce", () => {
    const circuito: El[] = [
      board,
      ...pezzo("R1", [["1", 0, 0]]),
      ...pezzo("C1", [["1", 8, 0, "bottom"]]),
      ...piedinoPassante("J4", "pin3", 4, 0),
      ...rete(1, "TASTO", ["R1_1", "C1_1", "J4_pin3"]),
      trace("t1", "st_TASTO_0", [wire(0, 0), wire(4, 0)]),
      trace("t2", "st_TASTO_1", [wire(4, 0, "bottom"), wire(8, 0, "bottom")]),
    ];
    expect(collegamentiAperti(circuito).collegamenti).toEqual([]);
    // senza la pista del bottom, C1 resta fuori: la linea arriva al foro, che e' su ogni strato
    const aperto = collegamentiAperti(circuito.slice(0, -1)).collegamenti;
    expect(aperto).toHaveLength(1);
    expect(aperto[0]).toMatchObject({ da: { piedino: "C1.1", strato: "bottom" }, a: { piedino: "J4.3", strato: null } });
  });

  it("due piazzole sovrapposte sono unite", () => {
    const circuito: El[] = [board, ...pezzo("TP1", [["1", 0, 0]]), ...pezzo("R1", [["1", 0.4, 0]]), ...rete(1, "TP", ["TP1_1", "R1_1"])];
    expect(collegamentiAperti(circuito).collegamenti).toEqual([]);
  });

  it("un piedino che nessuna traccia nomina non ha niente da unire", () => {
    const circuito: El[] = [board, ...pezzo("R1", [["1", 0, 0], ["2", 2, 0]]), ...pezzo("R2", [["1", 5, 0]]), ...rete(1, "SDA", ["R1_1", "R2_1"])];
    expect(capi(circuito)).toEqual(["R1.1 - R2.1"]);
  });
});

/*
 * sbb-dongle, 12/11/2026, `.J1 > .A9 to net.VBUS`. La spina USB-C e' a cavallo
 * del bordo: A9 sul top e B4 sul bottom nello stesso punto (-1,25; 1,95), unite
 * fra loro da una via e a nient'altro; B9 sul bottom in (1,25; 1,95) e FB1.1 in
 * (2,63; 3,44) unite dal rame. Il riepilogo dava come punti B9 e FB1.1, che sono
 * gia' unite: il tratto che manca parte da A9 / B4.
 */
describe("il caso del dongle", () => {
  const dongle: El[] = [
    board,
    ...pezzo("J1", [
      ["A9", -1.25, 1.95, "top"],
      ["B4", -1.25, 1.95, "bottom"],
      ["B9", 1.25, 1.95, "bottom"],
    ]),
    ...pezzo("FB1", [["1", 2.63, 3.44, "bottom"]]),
    ...rete(7, "VBUS", ["J1_A9", "J1_B4", "J1_B9", "FB1_1"]),
    via("via_vbus", -1.25, 1.95, 7),
    trace("t_b9", "st_VBUS_2", [wire(1.25, 1.95, "bottom"), wire(1.25, 3.44, "bottom"), wire(2.63, 3.44, "bottom")]),
  ];

  it("una linea sola, da J1.A9 / J1.B4 al gruppo di J1.B9", () => {
    const { collegamenti } = collegamentiAperti(dongle);
    expect(collegamenti).toHaveLength(1);
    const c = collegamenti[0];
    expect(c.nome).toBe("VBUS");
    // parte dalle due piazzole unite solo fra loro, non da J1.B9
    expect(["J1.A9", "J1.B4"]).toContain(c.da.piedino);
    expect(c.da).toMatchObject({ x: -1.25, y: 1.95 });
    // e arriva alla piazzola piu' vicina dell'altro gruppo: J1.B9, non FB1.1
    expect(c.a).toMatchObject({ piedino: "J1.B9", x: 1.25, y: 1.95, strato: "bottom" });
    expect(c.lunghezzaMm).toBeCloseTo(2.5, 6);
  });

  it("mai fra J1.B9 e FB1.1, che il rame unisce gia'", () => {
    expect(capi(dongle)).not.toContain("FB1.1 - J1.B9");
    const rame = rameDellaScheda(dongle)!;
    expect(rame.diPorta("pp_J1_B9")).toBe(rame.diPorta("pp_FB1_1"));
    expect(rame.diPorta("pp_J1_A9")).toBe(rame.diPorta("pp_J1_B4"));
  });

  it("il riepilogo del compile dice lo stesso tratto, col nome del piedino rimasto fuori", () => {
    // prima dava le porte fuori dall'isola piu' grande: a pari piedini, J1.B9 e FB1.1
    const gruppo = unroutedGroups(dongle).get("chiave_7")!;
    expect(gruppo.tratti).toEqual(collegamentiAperti(dongle).collegamenti);
    expect([".J1 > .A9 to net.VBUS", ".J1 > .B4 to net.VBUS"]).toContain(gruppo.nome);
  });
});

describe("una volta per scheda", () => {
  it("la stessa scheda non si ricalcola: stesso risultato, stesso oggetto", () => {
    const scheda = [...treInFila];
    const primo = apertiDellaScheda(scheda);
    expect(primo.collegamenti).toHaveLength(2);
    expect(apertiDellaScheda(scheda)).toBe(primo);
    expect(rameDellaScheda(scheda)).toBe(rameDellaScheda(scheda));
    // un'altra scheda, anche uguale, e' un altro calcolo
    expect(apertiDellaScheda([...treInFila])).not.toBe(primo);
    expect(apertiDellaScheda(null)).toEqual({ collegamenti: [], reti: 0 });
  });

  it("una scheda che non si riesce a leggere non fa cadere la pagina: nessun tratto, e lo dice", () => {
    // un elemento che non e' un elemento: il calcolo si ferma li'
    const rotta = [...treInFila, null] as never as El[];
    expect(() => collegamentiAperti(rotta)).toThrow();
    const aperti = apertiDellaScheda(rotta);
    expect(aperti.collegamenti).toEqual([]);
    expect(aperti.nonCalcolati).toBeTruthy();
    expect(rameDellaScheda(rotta)).toBeNull();
    // una scheda letta bene non ha quel campo
    expect(apertiDellaScheda([...treInFila]).nonCalcolati).toBeUndefined();
  });

  it("una scheda vera per misura (110 aperti, 550 piste, 470 vie, 10 colate, 320 piazzole) sta sotto i 100 ms", () => {
    // 320 piedini di una rete di massa e di 105 reti a due piedini, piste a L con una via, dieci colate
    const els: El[] = [board];
    const massa: string[] = [];
    for (let i = 0; i < 110; i++) {
      els.push(...pezzo(`C${i}`, [["1", (i % 20) * 2 - 20, Math.floor(i / 20) * 3 - 18], ["2", (i % 20) * 2 - 19, Math.floor(i / 20) * 3 - 18]]));
      massa.push(`C${i}_2`);
    }
    els.push(...rete(0, "GND", massa));
    for (let i = 0; i < 100; i++) {
      els.push(...pezzo(`R${i}`, [["1", (i % 20) * 2 - 20, Math.floor(i / 20) * 3 + 2]]));
      els.push(...rete(i + 1, `S${i}`, [`C${i}_1`, `R${i}_1`]));
      const x = (i % 20) * 2 - 20;
      const y0 = Math.floor(i / 20) * 3 - 18;
      const y1 = Math.floor(i / 20) * 3 + 2;
      for (let k = 0; k < 5; k++) {
        const a = y0 + ((y1 - y0) * k) / 5;
        const b = y0 + ((y1 - y0) * (k + 1)) / 5;
        els.push(trace(`t${i}_${k}`, `st_S${i}_0`, [wire(x, a), wire(x, b)]));
      }
      for (let k = 0; k < 4; k++) els.push(via(`v${i}_${k}`, x, y0 + ((y1 - y0) * (k + 1)) / 5, i + 1));
    }
    for (let k = 0; k < 10; k++) els.push(colata(`colata${k}`, 200 + k, k % 2 ? "bottom" : "top", -20 + k * 4, 12, -17 + k * 4, 18));
    expect(els.filter((e) => e.type === "pcb_trace").length).toBeGreaterThanOrEqual(500);
    expect(els.filter((e) => e.type === "pcb_via").length).toBeGreaterThanOrEqual(400);
    expect(els.filter((e) => e.type === "pcb_smtpad").length).toBe(320);
    // il primo giro scalda il motore di JavaScript: si misura il secondo
    collegamentiAperti(els);
    const t0 = performance.now();
    const { collegamenti } = collegamentiAperti(els);
    const ms = performance.now() - t0;
    // la massa non ha rame: 110 piedini, 109 tratti; le cento reti a due piedini sono unite
    expect(collegamenti).toHaveLength(109);
    expect(ms).toBeLessThan(100);
  });
});
