import { describe, expect, it } from "vitest";
import { summarizeCircuit } from "@/lib/compile";
import { collegamentiAperti } from "@/lib/open-connections";
import { computeUnroutedGroupKeys, scoreCircuit, unroutedGroups } from "@/lib/route-score";
import { colata, pezzo, rete, scheda, trace, via, wire, type El } from "./scheda-di-prova";

/*
 * I collegamenti aperti del riepilogo (unroutedConnections, unroutedTotal,
 * unroutedDetail e i suoi points, targets.unrouted) vengono da
 * collegamentiAperti, la stessa fonte del visore.
 *
 * Prima il riepilogo li contava per conto suo, e in due modi mancava il
 * bersaglio. Una rete con una colata era data per unita dal piano senza
 * guardare: su sbb-dl-principale (n89, 12/11/2026) R16.2 stava a 0,70 mm dalla
 * colata di P3V3_SD e D17.A in un'isoletta di massa staccata dal resto, e il
 * riepilogo diceva 1 aperto dove erano 3. E i punti del dettaglio erano le
 * piazzole fuori dall'isola con piu' piedini: su sbb-dongle, a pari piedini,
 * indicavano J1.B9 e FB1.1, che il rame univa gia'.
 */
const riepilogo = (circuito: El[]) => summarizeCircuit(circuito, {});

describe("una rete con una colata e' unita solo dove il rame si tocca", () => {
  /*
   * P3V3_SD: la colata sul bottom prende FL1.16 e C5.1. R16.2 e' fuori, il suo
   * bordo a 0,70 mm da quello della colata, e nessuna pista ci arriva.
   */
  const fuoriDallaColata: El[] = [
    scheda(),
    ...pezzo("FL1", [["16", 5, 0, "bottom"]]),
    ...pezzo("C5", [["1", 2, 0, "bottom"]]),
    ...pezzo("R16", [["2", 11, 0, "bottom"]]),
    ...rete(56, "P3V3_SD", ["FL1_16", "C5_1", "R16_2"]),
    colata("p3v3_sd", 56, "bottom", 0, -2, 10, 2),
  ];

  it("una piazzola a 0,70 mm dalla colata della sua rete e' un collegamento aperto", () => {
    // il bordo della piazzola e' a x = 10,7, quello della colata a x = 10
    expect(computeUnroutedGroupKeys(fuoriDallaColata)).toEqual(new Set(["chiave_56"]));
    expect(scoreCircuit(fuoriDallaColata).unrouted).toBe(1);
    const s = riepilogo(fuoriDallaColata);
    expect(s.unroutedTotal).toBe(1);
    expect(s.targets.unrouted).toBe(1);
    expect(s.targets.allGreen).toBe(false);
    // col nome del collegamento del piedino rimasto fuori, non del primo che la rete dichiara
    expect(s.unroutedConnections).toEqual([".R16 > .2 to net.P3V3_SD"]);
    expect(s.unroutedDetail).toEqual([
      {
        name: ".R16 > .2 to net.P3V3_SD",
        nets: ["P3V3_SD"],
        // i due capi del tratto che manca: R16.2 e la piazzola piu' vicina della rete, FL1.16
        points: [
          { x: 11, y: 0, layer: "bottom" },
          { x: 5, y: 0, layer: "bottom" },
        ],
      },
    ]);
    expect(s.message).toContain("1 UNROUTED");
  });

  it("la stessa piazzola dentro la colata non lo e'", () => {
    const dentro = fuoriDallaColata.map((e) => (e.pcb_smtpad_id === "pad_R16_2" || e.pcb_port_id === "pp_R16_2" ? { ...e, x: 8 } : e));
    expect(computeUnroutedGroupKeys(dentro).size).toBe(0);
    expect(riepilogo(dentro).unroutedTotal).toBe(0);
  });

  /*
   * GND: la colata grande sul bottom prende C1.2 e C2.2. D17.A sta in
   * un'isoletta di colata della stessa rete, staccata 0,32 mm, senza vie.
   */
  const isolettaStaccata: El[] = [
    scheda(),
    ...pezzo("C1", [["2", -5, -5, "bottom"]]),
    ...pezzo("C2", [["2", 5, -5, "bottom"]]),
    ...pezzo("D17", [["A", 0, 0.9, "bottom"]]),
    ...rete(15, "GND", ["C1_2", "C2_2", "D17_A"]),
    colata("gnd_grande", 15, "bottom", -10, -10, 10, 0),
    colata("gnd_isoletta", 15, "bottom", -1, 0.32, 1, 1.5),
  ];

  it("una piazzola di massa in un'isoletta di colata staccata dal resto, senza vie, e' un collegamento aperto", () => {
    expect(computeUnroutedGroupKeys(isolettaStaccata)).toEqual(new Set(["chiave_15"]));
    const s = riepilogo(isolettaStaccata);
    expect(s.unroutedTotal).toBe(1);
    expect(s.unroutedConnections).toEqual([".D17 > .A to net.GND"]);
    expect(s.unroutedDetail[0].points[0]).toEqual({ x: 0, y: 0.9, layer: "bottom" });
    expect(s.unroutedDetail[0].points).toHaveLength(2);
  });

  it("una via nell'isoletta e una nel piano interno della massa la uniscono al resto", () => {
    // un piano di massa su inner1, e una via che dall'isoletta e una dalla colata grande ci scendono
    const cucita = [
      ...isolettaStaccata,
      colata("gnd_inner", 15, "inner1", -10, -10, 10, 10),
      via("v_isoletta", 0.7, 1.2, 15),
      via("v_grande", 0, -3, 15),
    ];
    expect(computeUnroutedGroupKeys(cucita).size).toBe(0);
    expect(riepilogo(cucita).unroutedTotal).toBe(0);
  });

  it("una rete davvero tutta unita da colata, vie e piste non ha collegamenti aperti", () => {
    const unita: El[] = [
      scheda(),
      // nella colata del top
      ...pezzo("C1", [["2", -5, 5, "top"]]),
      // fuori dalla colata, ci arriva una pista
      ...pezzo("C2", [["2", 8, 5, "top"]]),
      // sul bottom, una via nella piazzola scende al piano interno
      ...pezzo("C3", [["2", 0, -6, "bottom"]]),
      ...rete(15, "GND", ["C1_2", "C2_2", "C3_2"]),
      colata("gnd_top", 15, "top", -8, 2, 4, 8),
      colata("gnd_inner", 15, "inner1", -10, -10, 10, 10),
      trace("t_c2", "st_GND_1", [wire(8, 5), wire(3, 5)]),
      // dal top al piano interno
      via("v_top", -2, 5, 15),
      via("v_c3", 0, -6, 15),
    ];
    expect(collegamentiAperti(unita).collegamenti).toEqual([]);
    expect(computeUnroutedGroupKeys(unita).size).toBe(0);
    const s = riepilogo(unita);
    expect(s.unroutedTotal).toBe(0);
    expect(s.unroutedConnections).toEqual([]);
    expect(s.unroutedDetail).toEqual([]);
    expect(s.targets.unrouted).toBe(0);
    expect(s.connectionGroups).toBe(1);
    // togli la via del top: la colata del top, con C1 e C2, resta staccata dal piano
    const senzaVia = unita.filter((e) => e.pcb_via_id !== "v_top");
    expect(riepilogo(senzaVia).unroutedTotal).toBe(1);
  });
});

describe("i punti del dettaglio sono i due capi del tratto che manca", () => {
  /*
   * sbb-dongle, `.J1 > .A9 to net.VBUS`: A9 sul top e B4 sul bottom nello stesso
   * punto, unite fra loro da una via e a nient'altro; B9 e FB1.1 unite dal rame.
   */
  const dongle: El[] = [
    scheda(),
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

  it("il caso del dongle: da J1.A9 / J1.B4 a J1.B9, non J1.B9 e FB1.1", () => {
    const s = riepilogo(dongle);
    expect(s.unroutedTotal).toBe(1);
    expect(s.unroutedDetail).toHaveLength(1);
    const [da, a, ...altri] = s.unroutedDetail[0].points;
    expect(altri).toEqual([]);
    // un capo sulle due piazzole unite solo fra loro...
    expect(da).toMatchObject({ x: -1.25, y: 1.95 });
    expect(["top", "bottom"]).toContain(da.layer);
    // ...l'altro sulla piazzola piu' vicina dell'altro gruppo
    expect(a).toEqual({ x: 1.25, y: 1.95, layer: "bottom" });
    // FB1.1 (2,63; 3,44) non e' un capo: il rame la unisce gia' a J1.B9
    expect(s.unroutedDetail[0].points.some((p) => p.x === 2.63)).toBe(false);
    // e il nome e' quello di un piedino rimasto fuori
    expect([".J1 > .A9 to net.VBUS", ".J1 > .B4 to net.VBUS"]).toContain(s.unroutedConnections[0]);
    expect(s.unroutedDetail[0].name).toBe(s.unroutedConnections[0]);
  });

  it("sono gli stessi tratti che il visore disegna", () => {
    const [tratto] = collegamentiAperti(dongle).collegamenti;
    const gruppo = unroutedGroups(dongle).get("chiave_7")!;
    expect(gruppo.tratti).toEqual([tratto]);
    expect(riepilogo(dongle).unroutedDetail[0].points).toEqual([
      { x: tratto.da.x, y: tratto.da.y, layer: tratto.da.strato },
      { x: tratto.a.x, y: tratto.a.y, layer: tratto.a.strato },
    ]);
  });

  it("una rete in tre isole: due tratti, quattro punti a coppie", () => {
    const tre: El[] = [
      scheda(),
      ...pezzo("R1", [["1", 0, 0]]),
      ...pezzo("R2", [["1", 5, 0]]),
      ...pezzo("R3", [["1", 12, 0]]),
      ...rete(1, "SDA", ["R1_1", "R2_1", "R3_1"]),
    ];
    const s = riepilogo(tre);
    // una rete aperta, non due: il conteggio resta per rete
    expect(s.unroutedTotal).toBe(1);
    expect(s.unroutedConnections).toHaveLength(1);
    expect(s.unroutedDetail[0].points).toEqual([
      { x: 0, y: 0, layer: "top" },
      { x: 5, y: 0, layer: "top" },
      { x: 5, y: 0, layer: "top" },
      { x: 12, y: 0, layer: "top" },
    ]);
  });

  it("un capo su un foro passante non ha strato: e' su tutti", () => {
    const conForo: El[] = [
      scheda(),
      ...pezzo("C1", [["1", 6, 0, "bottom"]]),
      { type: "source_component", source_component_id: "sc_J4", name: "J4" },
      { type: "source_port", source_port_id: "sp_J4_3", name: "pin3", source_component_id: "sc_J4" },
      { type: "pcb_port", pcb_port_id: "pp_J4_3", source_port_id: "sp_J4_3", pcb_component_id: "pc_J4", x: 0, y: 0, layers: ["top", "bottom"] },
      { type: "pcb_plated_hole", pcb_plated_hole_id: "foro_J4_3", pcb_port_id: "pp_J4_3", pcb_component_id: "pc_J4", shape: "circle", x: 0, y: 0, hole_diameter: 0.9, outer_diameter: 1.5, layers: ["top", "bottom"] },
      ...rete(1, "TASTO", ["C1_1", "J4_3"]),
    ];
    const punti = riepilogo(conForo).unroutedDetail[0].points;
    expect(punti).toContainEqual({ x: 0, y: 0, layer: null });
    expect(punti).toContainEqual({ x: 6, y: 0, layer: "bottom" });
  });
});

describe("i gruppi senza chiave di connettivita': uno per traccia dello schema", () => {
  /** a-b e b-c sono due tracce senza chiave: due gruppi, come li ha sempre contati il compile */
  const pin = (id: string, x: number): El[] => [
    { type: "source_port", source_port_id: `sp_${id}`, name: id },
    { type: "pcb_port", pcb_port_id: `pp_${id}`, source_port_id: `sp_${id}`, x, y: 0, layers: ["top"] },
    { type: "pcb_smtpad", shape: "rect", pcb_smtpad_id: `pad_${id}`, pcb_port_id: `pp_${id}`, x, y: 0, width: 0.6, height: 0.6, layer: "top" },
  ];
  const base: El[] = [
    scheda(),
    ...pin("a", 0),
    ...pin("b", 5),
    ...pin("c", 12),
    { type: "source_trace", source_trace_id: "st_ab", display_name: ".A to .B", connected_source_port_ids: ["sp_a", "sp_b"], connected_source_net_ids: [] },
    { type: "source_trace", source_trace_id: "st_bc", display_name: ".B to .C", connected_source_port_ids: ["sp_b", "sp_c"], connected_source_net_ids: [] },
  ];

  it("e' aperto solo il gruppo che il tratto mancante taglia", () => {
    // a e b unite: resta aperta la traccia b-c, non la a-b
    const circuito = [...base, trace("t1", "st_ab", [wire(0, 0), wire(5, 0)])];
    expect([...unroutedGroups(circuito).keys()]).toEqual(["st_bc"]);
    expect(unroutedGroups(circuito).get("st_bc")!.nome).toBe(".B to .C");
  });

  it("senza rame sono aperti tutti e due, ognuno col suo tratto", () => {
    const aperti = unroutedGroups(base);
    expect([...aperti.keys()]).toEqual(["st_ab", "st_bc"]);
    expect(aperti.get("st_ab")!.tratti.map((t) => [t.da.porta, t.a.porta].sort())).toEqual([["pp_a", "pp_b"]]);
    expect(aperti.get("st_bc")!.tratti.map((t) => [t.da.porta, t.a.porta].sort())).toEqual([["pp_b", "pp_c"]]);
  });
});
