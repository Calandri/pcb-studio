import { describe, expect, it } from "vitest";
import { apertiDellaSchedaCheEsce } from "@/lib/aperti-export";
import { collegamentiAperti } from "@/lib/open-connections";
import { FLOTTANTE, areaDelRame, puntoSulRame, readPours, insidePour } from "@/lib/pours";
import { conColateFlottanti } from "@/lib/pours-recompute";
import { runPrcChecks } from "@/lib/prc";
import { unroutedGroups } from "@/lib/route-score";
import { colata, pezzo, rete, scheda, trace, via, wire, type El } from "./scheda-di-prova";

/*
 * OGNI COLATA DEVE ESSERE COLLEGATA ALLA SUA RETE, a meno di dichiararla
 * flottante (Niccolo', 17/11/2026: "questa cosa che ci sono pour non collegati
 * e' grave, e non si vede bene da PCB STUDIO"). Un pezzo di colata che il rame
 * non unisce alla parte principale della sua rete e' un collegamento mancante,
 * nella stessa lista e nello stesso conteggio degli altri.
 */

const board = scheda();

/**
 * La massa: C1 e C2 unite dalla colata di inner1 attraverso due vie. Con `C3`
 * c'e' anche C3 sulla rete, in (16; 0), che il rame non raggiunge.
 */
const massaCon = (C3 = false): El[] => [
  board,
  ...pezzo("C1", [["2", 0, 0]]),
  ...pezzo("C2", [["2", 8, 0]]),
  ...(C3 ? pezzo("C3", [["2", 16, 0]]) : []),
  ...rete(1, "GND", C3 ? ["C1_2", "C2_2", "C3_2"] : ["C1_2", "C2_2"]),
  colata("piano", 1, "inner1", -5, -5, 12, 5),
  via("v1", 0.8, 0, 1),
  via("v2", 8.8, 0, 1),
  trace("t1", "st_GND_0", [wire(0, 0), wire(0.8, 0)]),
  trace("t2", "st_GND_1", [wire(8, 0), wire(8.8, 0)]),
];
const massa = massaCon();

/** una colata di massa marcata flottante */
const flottante = (el: El): El => ({ ...el, [FLOTTANTE]: true });

describe("le colate isolate sono collegamenti mancanti", () => {
  it("una rete con una regione sola non segnala niente", () => {
    expect(collegamentiAperti(massa)).toEqual({ collegamenti: [], reti: 0 });
  });

  it("un pezzo di colata senza via e senza piazzole: segnalato con rete, strato, area e punto", () => {
    const { collegamenti, reti } = collegamentiAperti([...massa, colata("isola", 1, "top", 14, -2, 18, 2)]);
    expect(reti).toBe(1);
    expect(collegamenti).toHaveLength(1);
    const c = collegamenti[0];
    expect(c).toMatchObject({ id: "GND#colata0", nome: "GND", da: { porta: "", componente: "", strato: "top" } });
    expect(c.colata).toMatchObject({ strati: ["top"], colate: ["isola"], strato: "top" });
    expect(c.colata!.areaMm2).toBeCloseTo(16, 6);
    // il punto e' sul rame dell'isola
    expect(insidePour(c.colata!.x, c.colata!.y, readPours([colata("isola", 1, "top", 14, -2, 18, 2)])[0])).toBe(true);
    expect(c.da).toMatchObject({ x: c.colata!.x, y: c.colata!.y });
    // e arriva al piedino piu' vicino della parte principale della rete
    expect(c.a).toMatchObject({ piedino: "C2.2", x: 8, y: 0 });
    expect(c.da.piedino).toBe(`colata isolata su top, 16.00 mm², in (${c.colata!.x.toFixed(2)}, ${c.colata!.y.toFixed(2)})`);
  });

  it("un'isola di colata senza via con dentro una piazzola: la piazzola e' scollegata", () => {
    // C3 sta nella colata di massa del top, ma quel pezzo non ha vie verso il piano
    const circuito = massaCon(true);
    const isola = colata("isola", 1, "top", 14, -2, 18, 2);
    const { collegamenti } = collegamentiAperti([...circuito, isola]);
    expect(collegamenti).toHaveLength(1);
    const c = collegamenti[0];
    // la piazzola lasciata fuori, e dove sta la colata che la tiene
    expect(c.da).toMatchObject({ piedino: "C3.2", porta: "pp_C3_2" });
    expect(c.a).toMatchObject({ piedino: "C2.2" });
    expect(c.colata).toMatchObject({ strati: ["top"], colate: ["isola"] });
    // con una via nel pezzo, verso il piano di inner1 allungato da una tessera che lo accavalla, e' unita
    const tessera = colata("piano-est", 1, "inner1", 11, -5, 19, 5);
    expect(collegamentiAperti([...circuito, isola, tessera]).collegamenti).toHaveLength(1);
    expect(collegamentiAperti([...circuito, isola, tessera, via("v3", 17, 1, 1)]).collegamenti).toEqual([]);
  });

  it("due colate che si sovrappongono sono un pezzo solo: niente da segnalare", () => {
    // tre tessere del top: una con C1 dentro, una che la accavalla, una dentro l'altra, una che tocca solo un lato
    const tessere = [
      colata("t1", 1, "top", -2, -2, 4, 2),
      colata("t2", 1, "top", 3, -4, 9, 1),
      colata("t3", 1, "top", 5, -3, 6, -2),
      colata("t4", 1, "top", 9, -4, 11, -1),
    ];
    // la rete ha un piedino solo, C1, nella prima: le altre tre si uniscono solo per il rame che si tocca
    const circuito: El[] = [board, ...pezzo("C1", [["2", 0, 0]]), ...rete(1, "GND", ["C1_2"])];
    expect(collegamentiAperti([...circuito, ...tessere]).collegamenti).toEqual([]);
    // staccata di un decimo, l'ultima e' un pezzo a se'
    const staccata = colata("t4", 1, "top", 9.1, -4, 11, -1);
    expect(collegamentiAperti([...circuito, ...tessere.slice(0, 3), staccata]).collegamenti.map((c) => c.colata?.colate)).toEqual([["t4"]]);
    // contate una per una erano tre isole senza piazzole; l'area dell'unione conta una volta il rame comune
    const forme = readPours(tessere);
    expect(areaDelRame(forme)).toBeCloseTo(24 + 30 - 1 * 3 + 0 + 6, 6);
  });

  it("un'isola collegata da una via a un'altra regione della rete: non segnalata", () => {
    const isola = colata("isola", 1, "top", 14, -2, 18, 2);
    const ponte = colata("ponte", 1, "bottom", 10, -2, 17, 2);
    // il ponte del bottom tocca il piano attraverso la via v4, l'isola del top attraverso v5
    const conVie = [...massa, isola, ponte, via("v4", 11, 0, 1), via("v5", 16, 1, 1)];
    expect(collegamentiAperti(conVie).collegamenti).toEqual([]);
    // senza la via del top l'isola del top resta fuori, e il ponte no
    const senza = collegamentiAperti(conVie.filter((e) => e.pcb_via_id !== "v5")).collegamenti;
    expect(senza).toHaveLength(1);
    expect(senza[0].colata).toMatchObject({ strati: ["top"], colate: ["isola"] });
    // senza la via del bottom, top e bottom sono un'isola sola su due strati
    const sopraSotto = collegamentiAperti(conVie.filter((e) => e.pcb_via_id !== "v4")).collegamenti;
    expect(sopraSotto).toHaveLength(1);
    expect(sopraSotto[0].colata).toMatchObject({ strati: ["top", "bottom"], colate: ["isola", "ponte"] });
    expect(sopraSotto[0].colata!.areaMm2).toBeCloseTo(16 + 28, 6);
  });

  it("una colata dichiarata flottante non e' segnalata, ne' come collegamento ne' come isola morta", () => {
    const isola = flottante(colata("isola", 1, "top", 14, -2, 18, 2));
    expect(collegamentiAperti([...massa, isola]).collegamenti).toEqual([]);
    expect(runPrcChecks([...massa, isola] as never).filter((v) => v.rule === "pour_island")).toEqual([]);
    // senza la dichiarazione e' un'isola morta per il controllo elettrico, come prima
    const normale = colata("isola", 1, "top", 14, -2, 18, 2);
    expect(runPrcChecks([...massa, normale] as never).filter((v) => v.rule === "pour_island")).toHaveLength(1);
    // un piedino della rete dentro una colata flottante resta scollegato
    expect(collegamentiAperti([...massaCon(true), isola]).collegamenti.map((c) => c.da.piedino)).toEqual(["C3.2"]);
  });

  it("una colata su una rete senza piedini e' sempre segnalata", () => {
    const vuota: El = { type: "source_net", source_net_id: "source_net_9", name: "NESSUNA" };
    const { collegamenti, reti } = collegamentiAperti([...massa, vuota, colata("orfana", 9, "bottom", -4, 6, 0, 9)]);
    expect(reti).toBe(1);
    expect(collegamenti).toHaveLength(1);
    expect(collegamenti[0]).toMatchObject({ nome: "NESSUNA", lunghezzaMm: 0, colata: { strati: ["bottom"] } });
    // nessun piedino da raggiungere: i due capi sono lo stesso punto
    expect(collegamenti[0].a).toBe(collegamenti[0].da);
  });

  it("il conteggio dei collegamenti mancanti le conta, e l'export le rifiuta", () => {
    const circuito = [...massa, colata("isola", 1, "top", 14, -2, 18, 2)];
    // la rete della massa e' aperta, col suo pezzo di colata
    const gruppi = unroutedGroups(circuito);
    expect([...gruppi.keys()]).toEqual(["chiave_1"]);
    expect(gruppi.get("chiave_1")!.nome).toMatch(/^colata isolata GND su top, 16\.00 mm², in \(/);
    expect(gruppi.get("chiave_1")!.tratti).toEqual(collegamentiAperti(circuito).collegamenti);
    // una rete che nessuna traccia nomina e' un gruppo suo
    const vuota: El = { type: "source_net", source_net_id: "source_net_9", name: "NESSUNA" };
    const conOrfana = [...circuito, vuota, colata("orfana", 9, "bottom", -4, 6, 0, 9)];
    expect([...unroutedGroups(conOrfana).keys()]).toEqual(["chiave_1", "colata:net:NESSUNA"]);
    // l'export conta le due reti e dice dove sono le colate
    const rifiuto = apertiDellaSchedaCheEsce(conOrfana);
    expect(rifiuto).toMatchObject({ count: 2, reti: 2 });
    expect(rifiuto!.detail).toMatch(/^2 collegamenti aperti su 2 reti: GND \(colata isolata su top, 16\.00 mm², in \(.*\)\), NESSUNA \(colata isolata su bottom, 12\.00 mm²/);
    // e una scheda senza isole non ha niente da rifiutare
    expect(apertiDellaSchedaCheEsce(massa)).toBeNull();
  });

  it("la colata flottante di una rete non nasconde quella isolata di un'altra", () => {
    const vdd = [...pezzo("U1", [["1", -3, 3]]), ...rete(2, "VDD", ["U1_1"])];
    const circuito = [...massa, ...vdd, colata("g", 1, "top", 14, -2, 18, 2), flottante(colata("v", 2, "bottom", 14, -2, 18, 2))];
    expect(collegamentiAperti(circuito).collegamenti.map((c) => c.id)).toEqual(["GND#colata0"]);
    // e in un'isola sua, una flottante accanto a una che non lo e' non basta a tacerla
    const insieme = [...massa, flottante(colata("f", 1, "top", 14, -2, 18, 2)), colata("g", 1, "top", 17, -2, 19, 2)];
    expect(collegamentiAperti(insieme).collegamenti.map((c) => c.colata?.colate)).toEqual([["f", "g"]]);
  });
});

describe("la geometria delle colate isolate", () => {
  it("il punto sta sul rame anche quando il centro della scatola e' in un buco", () => {
    const anello: El = {
      ...colata("anello", 1, "top", -5, -5, 5, 5),
      brep_shape: {
        outer_ring: { vertices: [{ x: -5, y: -5 }, { x: 5, y: -5 }, { x: 5, y: 5 }, { x: -5, y: 5 }] },
        inner_rings: [{ vertices: [{ x: -4, y: -4 }, { x: 4, y: -4 }, { x: 4, y: 4 }, { x: -4, y: 4 }] }],
      },
    };
    const [forma] = readPours([anello]);
    const p = puntoSulRame(forma);
    expect(insidePour(p.x, p.y, forma)).toBe(true);
    expect(areaDelRame([forma])).toBeCloseTo(100 - 64, 6);
  });

  it("l'area di due tessere accavallate conta una volta il rame comune", () => {
    const forme = readPours([colata("a", 1, "top", 0, 0, 4, 4), colata("b", 1, "top", 2, 2, 6, 6)]);
    expect(areaDelRame(forme)).toBeCloseTo(16 + 16 - 4, 6);
  });
});

describe("la dichiarazione flottante nei file", () => {
  /** due colate di massa dal file: la prima flottante, la seconda no */
  const file = (attr: string) => ({
    "main.tsx": `export default () => (
  <board width="40mm" height="40mm">
    <copperpour layer="top" connectsTo="net.GND" ${attr} outline={[{x: 14, y: -2}, {x: 18, y: -2}, {x: 18, y: 2}, {x: 14, y: 2}]} />
    <copperpour layer="top" connectsTo="net.GND" outline={[{x: -2, y: -2}, {x: 4, y: -2}, {x: 4, y: 2}, {x: -2, y: 2}]} />
  </board>
)`,
  });
  const circuito: El[] = [
    { type: "source_net", source_net_id: "source_net_1", name: "GND" },
    colata("a", 1, "top", 14.5, -1.5, 17.5, 1.5),
    colata("b", 1, "top", -1.5, -1.5, 3.5, 1.5),
  ];
  const marcate = (attr: string) =>
    conColateFlottanti(circuito, file(attr))
      .filter((e) => e.type === "pcb_copper_pour" && e[FLOTTANTE] === true)
      .map((e) => e.pcb_copper_pour_id);

  it("flottante, flottante={true} e flottante=\"true\" marcano i pezzi della sua colata, e solo quelli", () => {
    expect(marcate("flottante")).toEqual(["a"]);
    expect(marcate("flottante={true}")).toEqual(["a"]);
    expect(marcate('flottante="true"')).toEqual(["a"]);
  });

  it("flottante={false}, o niente, non marcano niente: e una marcatura non piu' dichiarata si toglie", () => {
    expect(marcate("flottante={false}")).toEqual([]);
    expect(marcate("")).toEqual([]);
    // nessuna dichiarazione e nessuna marcatura: lo stesso array
    expect(conColateFlottanti(circuito, file(""))).toBe(circuito);
    const giaMarcato = [circuito[0], flottante(circuito[1]), circuito[2]];
    expect(conColateFlottanti(giaMarcato, file("")).some((e) => FLOTTANTE in e)).toBe(false);
  });

  it("una flottante in un commento non conta", () => {
    const testo = file("flottante")["main.tsx"].replace(/(<copperpour [^>]*flottante[^>]*\/>)/, "{/* $1 */}");
    expect(testo).toContain("{/* <copperpour");
    expect(conColateFlottanti(circuito, { "main.tsx": testo }).some((e) => FLOTTANTE in e)).toBe(false);
  });
});

/*
 * Una scheda vera, compilata: la massa del top tiene i due pad di massa, quella
 * del bottom non ha una via che la porti al top. Il riepilogo conta la rete
 * aperta e la nomina con strato, area e punto; dichiarata flottante, niente.
 */
describe("la compilazione conta le colate isolate", () => {
  const codice = (flottante: string) => `export default () => (
  <board width="24mm" height="12mm" layers={4}>
    <net name="GND" />
    <resistor name="R1" resistance="1k" footprint="0805" pcbX={-6} pcbY={0} />
    <resistor name="R2" resistance="1k" footprint="0805" pcbX={6} pcbY={0} />
    <trace from=".R1 > .pin2" to="net.GND" />
    <trace from=".R2 > .pin2" to="net.GND" />
    <copperpour layer="top" connectsTo="net.GND" outline={[{x: -11, y: -5}, {x: 11, y: -5}, {x: 11, y: 5}, {x: -11, y: 5}]} />
    <copperpour layer="bottom" connectsTo="net.GND" ${flottante} outline={[{x: -4, y: -4}, {x: 4, y: -4}, {x: 4, y: 4}, {x: -4, y: 4}]} />
  </board>
)
`;
  const regole = JSON.stringify({ preset: "custom", rules: { minClearanceMm: 0.15, minTraceWidthMm: 0.127, autoroute: false, autoPlaneVias: false } });

  it("una colata del bottom senza via e' un collegamento aperto; dichiarata flottante no", async () => {
    const { compileProject } = await import("@/lib/compile");
    const { DESIGN_RULES_PATH } = await import("@/lib/design-rules");
    const isolata = await compileProject({ "main.tsx": codice(""), [DESIGN_RULES_PATH]: regole });
    expect(isolata.summary.unroutedTotal).toBe(1);
    expect(isolata.summary.unroutedConnections).toHaveLength(1);
    expect(isolata.summary.unroutedConnections[0]).toMatch(/^colata isolata GND su bottom, 64\.00 mm², in \(/);
    const [dettaglio] = isolata.summary.unroutedDetail;
    expect(dettaglio.nets).toEqual(["GND"]);
    expect(dettaglio.points[0]).toMatchObject({ layer: "bottom" });
    expect(apertiDellaSchedaCheEsce(isolata.circuitJson as unknown[])).toMatchObject({ count: 1, reti: 1 });

    const voluta = await compileProject({ "main.tsx": codice("flottante"), [DESIGN_RULES_PATH]: regole });
    expect((voluta.circuitJson as El[]).filter((e) => e.type === "pcb_copper_pour" && e.layer === "bottom").every((e) => e[FLOTTANTE] === true)).toBe(true);
    expect(voluta.summary.unroutedTotal).toBe(0);
    expect(voluta.summary.unroutedConnections).toEqual([]);
    expect((voluta.summary.prcViolations ?? []).filter((v) => v.rule === "pour_island")).toEqual([]);
    expect(apertiDellaSchedaCheEsce(voluta.circuitJson as unknown[])).toBeNull();
  }, 180_000);
});
