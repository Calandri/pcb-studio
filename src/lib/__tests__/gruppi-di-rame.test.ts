import { describe, expect, it } from "vitest";
import { gruppiDiRame, isoleDiRame, retiDelCircuito } from "@/lib/gruppi-di-rame";
import { colata, rete, scheda, trace, wire, type El } from "./scheda-di-prova";

const board = scheda();

/** un piedino senza pezzo: porta sorgente, porta pcb e piazzola SMD sullo strato dato */
const pin = (id: string, x: number, y: number, layer = "top"): El[] => [
  { type: "source_port", source_port_id: `sp_${id}`, name: id },
  { type: "pcb_port", pcb_port_id: `pp_${id}`, source_port_id: `sp_${id}`, x, y, layers: [layer] },
  { type: "pcb_smtpad", shape: "rect", pcb_smtpad_id: `pad_${id}`, pcb_port_id: `pp_${id}`, x, y, width: 0.6, height: 0.6, layer },
];

/** una via che di suo non dice niente: la rete la dice cio' che le si aggiunge */
const via = (id: string, x: number, y: number, extra: Record<string, unknown> = {}): El => ({
  type: "pcb_via",
  pcb_via_id: id,
  x,
  y,
  outer_diameter: 0.6,
  hole_diameter: 0.3,
  layers: ["top", "inner1", "inner2", "bottom"],
  ...extra,
});

describe("la rete di ogni pezzo di rame", () => {
  const circuito: El[] = [board, ...pin("a", 0, 0), ...pin("b", 5, 0), ...pin("c", 0, 5), ...rete(3, "VBUS", ["a", "b"]), ...rete(4, "GND", ["c"])];
  const reti = retiDelCircuito(circuito);
  const vbus = reti.diPorta.get("pp_a")!;

  it("i piedini appesi alla stessa rete sono una rete, col suo nome", () => {
    expect(reti.diPorta.get("pp_b")).toBe(vbus);
    expect(reti.diPorta.get("pp_c")).not.toBe(vbus);
    expect(reti.nome(vbus)).toBe("VBUS");
    expect(reti.nomeDiPorta.get("pp_c")).toBe("GND");
    expect(reti.pinDiPorta.get("pp_a")).toBe("a");
  });

  it("una via dice la sua rete con la chiave di connettivita'", () => {
    expect(reti.diVia(via("v", 1, 1, { subcircuit_connectivity_map_key: "chiave_3" }))).toBe(vbus);
  });

  it("una via nata da <via> non ha nome ne' source_net_id: la rete e' il source_net_* in pcb_trace_id", () => {
    expect(reti.diVia(via("v", 1, 1, { pcb_trace_id: "source_net_3" }))).toBe(vbus);
    // un pcb_trace_id che e' davvero una pista non dice nessuna rete
    expect(reti.diVia(via("v", 1, 1, { pcb_trace_id: "pcb_trace_12" }))).toBeNull();
  });

  it("le chiavi del rame posato da noi o dal router tornano alla stessa rete", () => {
    expect(reti.diChiave("net:source_net_3")).toBe(vbus);
    expect(reti.diChiave("source_net_3_mst0")).toBe(vbus);
    expect(reti.diChiave("st_VBUS_1")).toBe(vbus);
    expect(reti.diChiave("sp_b")).toBe(vbus);
    expect(reti.diChiave("mai_vista")).toBeNull();
  });

  it("una pista prende la rete dalla sua traccia sorgente, una colata dal suo source_net_id", () => {
    expect(reti.diTraccia(trace("t", "st_VBUS_0", [wire(0, 0), wire(5, 0)]))).toBe(vbus);
    expect(reti.diColata(colata("c", 3, "top", -1, -1, 1, 1))).toBe(vbus);
  });

  it("un piedino che nessuna traccia nomina e' una rete a se', e non e' una rete vera", () => {
    const solo = retiDelCircuito([board, ...pin("x", 0, 0)]);
    expect(solo.diPorta.get("pp_x")).toBe("sp_x");
    expect(solo.eRete("sp_x")).toBe(false);
    expect(reti.eRete(vbus)).toBe(true);
  });
});

describe("i gruppi di rame", () => {
  it("piazzole, tratti per strato e via di una rete unita sono un gruppo solo", () => {
    const circuito: El[] = [
      board,
      ...pin("a", 0, 0),
      ...pin("b", 6, 0, "bottom"),
      ...rete(1, "SDA", ["a", "b"]),
      trace("t1", "st_SDA_0", [wire(0, 0), wire(3, 0)]),
      trace("t2", "st_SDA_1", [wire(3, 0, "bottom"), wire(6, 0, "bottom")]),
      via("v", 3, 0, { pcb_trace_id: "source_net_1" }),
    ];
    const rame = gruppiDiRame(circuito);
    const sda = rame.reti.diPorta.get("pp_a")!;
    expect(rame.perRete.get(sda)).toHaveLength(1);
    const g = rame.gruppi[rame.diPorta("pp_a")];
    expect(rame.diPorta("pp_b")).toBe(g.indice);
    expect(rame.diVia("v")).toBe(g.indice);
    expect(rame.diTraccia("t2")).toBe(g.indice);
    expect(rame.diPiazzola("pad_b")).toBe(g.indice);
    expect(g.reti).toEqual([sda]);
    expect(g.piazzole.map((p) => [p.id, p.strato, p.rete])).toEqual([
      ["pad_a", "top", sda],
      ["pad_b", "bottom", sda],
    ]);
    expect(g.tratti.map((t) => [t.traccia, t.strato])).toEqual([
      ["t1", "top"],
      ["t2", "bottom"],
    ]);
    expect(g.vie).toMatchObject([{ id: "v", rete: sda, x: 3, y: 0, diametro: 0.6 }]);
    // quali piste sono della rete di una via
    expect(rame.reteDiVia("v")).toBe(sda);
    expect(rame.trattiDellaRete(rame.reteDiVia("v")!).map((t) => t.traccia)).toEqual(["t1", "t2"]);
  });

  it("senza la via le due facce restano due gruppi della stessa rete", () => {
    const circuito: El[] = [
      board,
      ...pin("a", 0, 0),
      ...pin("b", 6, 0, "bottom"),
      ...rete(1, "SDA", ["a", "b"]),
      trace("t1", "st_SDA_0", [wire(0, 0), wire(3, 0)]),
      trace("t2", "st_SDA_1", [wire(3, 0, "bottom"), wire(6, 0, "bottom")]),
    ];
    const rame = gruppiDiRame(circuito);
    expect(rame.perRete.get(rame.reti.diPorta.get("pp_a")!)).toHaveLength(2);
    expect(rame.diPorta("pp_a")).not.toBe(rame.diPorta("pp_b"));
  });

  it("una via senza chiave e senza traccia prende la rete del rame che tocca", () => {
    const circuito: El[] = [
      board,
      ...pin("a", 0, 0),
      ...pin("b", 5, 0),
      ...rete(1, "SDA", ["a", "b"]),
      trace("t1", "st_SDA_0", [wire(0, 0), wire(5, 0)]),
      via("v", 2, 0),
    ];
    const rame = gruppiDiRame(circuito);
    expect(rame.reteDiVia("v")).toBe(rame.reti.diPorta.get("pp_a"));
    expect(rame.diVia("v")).toBe(rame.diPorta("pp_a"));
  });

  it("una colata unisce le piazzole della sua rete che ci stanno dentro, sul suo strato", () => {
    const circuito: El[] = [
      board,
      ...pin("a", 0, 0),
      ...pin("b", 8, 0),
      ...pin("c", 4, 6),
      ...rete(1, "GND", ["a", "b", "c"]),
      colata("gnd_top", 1, "top", -2, -2, 10, 2),
    ];
    const rame = gruppiDiRame(circuito);
    expect(rame.diPorta("pp_a")).toBe(rame.diPorta("pp_b"));
    // c e' fuori dalla colata
    expect(rame.diPorta("pp_c")).not.toBe(rame.diPorta("pp_a"));
    const g = rame.gruppi[rame.diColata("gnd_top")];
    expect(g.colate).toMatchObject([{ id: "gnd_top", strato: "top", rete: rame.reti.diPorta.get("pp_a") }]);
    expect(g.piazzole.map((p) => p.id)).toEqual(["pad_a", "pad_b"]);
  });

  it("una colata su un altro strato non unisce senza una via, e con la via si'", () => {
    const base: El[] = [
      board,
      ...pin("a", 0, 0),
      ...pin("b", 8, 0),
      ...rete(1, "GND", ["a", "b"]),
      colata("gnd_inner", 1, "inner1", -2, -2, 10, 2),
    ];
    expect(gruppiDiRame(base).diPorta("pp_a")).not.toBe(gruppiDiRame(base).diPorta("pp_b"));
    // una via dentro ogni piazzola scende al piano
    const cucita = gruppiDiRame([...base, via("va", 0, 0, { pcb_trace_id: "source_net_1" }), via("vb", 8, 0, { pcb_trace_id: "source_net_1" })]);
    expect(cucita.diPorta("pp_a")).toBe(cucita.diPorta("pp_b"));
    expect(cucita.diVia("va")).toBe(cucita.diColata("gnd_inner"));
  });

  it("la colata di un'altra rete non unisce: una piazzola dentro la colata sbagliata resta sola", () => {
    const circuito: El[] = [
      board,
      ...pin("a", 0, 0),
      ...pin("b", 8, 0),
      ...rete(1, "SDA", ["a", "b"]),
      { type: "source_net", source_net_id: "source_net_2", name: "GND", subcircuit_connectivity_map_key: "chiave_2" },
      colata("gnd_top", 2, "top", -2, -2, 10, 2),
    ];
    const rame = gruppiDiRame(circuito);
    expect(rame.diPorta("pp_a")).not.toBe(rame.diPorta("pp_b"));
    expect(rame.gruppi[rame.diColata("gnd_top")].piazzole).toEqual([]);
  });

  it("due colate della stessa rete sullo stesso strato che si sovrappongono sono un gruppo", () => {
    const circuito: El[] = [
      board,
      ...pin("a", 0, 0),
      ...pin("b", 12, 0),
      ...rete(1, "GND", ["a", "b"]),
      // due piastrelle che si sovrappongono di un decimo, come le dichiara una scheda scritta da uno script
      colata("p1", 1, "top", -2, -2, 6.05, 2),
      colata("p2", 1, "top", 5.95, -2, 14, 2),
    ];
    const rame = gruppiDiRame(circuito);
    expect(rame.diColata("p1")).toBe(rame.diColata("p2"));
    expect(rame.diPorta("pp_a")).toBe(rame.diPorta("pp_b"));
    // staccate di tre decimi restano due
    const staccate = gruppiDiRame([...circuito.slice(0, -1), colata("p2", 1, "top", 6.35, -2, 14, 2)]);
    expect(staccate.diColata("p1")).not.toBe(staccate.diColata("p2"));
  });

  it("una pista che entra nella colata della sua rete e' unita a cio' che la colata tocca", () => {
    const circuito: El[] = [
      board,
      ...pin("a", 0, 0),
      ...pin("b", 12, 6),
      ...rete(1, "VBAT", ["a", "b"]),
      colata("vbat", 1, "top", -2, -2, 6, 2),
      // parte da b e finisce dentro la colata, lontano da a
      trace("t", "st_VBAT_1", [wire(12, 6), wire(5, 6), wire(5, 1)]),
    ];
    const rame = gruppiDiRame(circuito);
    expect(rame.diPorta("pp_a")).toBe(rame.diPorta("pp_b"));
  });

  it("due piazzole una sull'altra sullo stesso strato sono un pezzo di rame; su due facce no", () => {
    const sopra: El[] = [board, ...pin("a", 0, 0), ...pin("b", 0.4, 0), ...rete(1, "TP", ["a", "b"])];
    expect(gruppiDiRame(sopra).diPorta("pp_a")).toBe(gruppiDiRame(sopra).diPorta("pp_b"));
    const dueFacce: El[] = [board, ...pin("a", 0, 0), ...pin("b", 0.4, 0, "bottom"), ...rete(1, "TP", ["a", "b"])];
    expect(gruppiDiRame(dueFacce).diPorta("pp_a")).not.toBe(gruppiDiRame(dueFacce).diPorta("pp_b"));
  });

  it("un foro metallizzato unisce la pista del top e quella del bottom", () => {
    const circuito: El[] = [
      board,
      ...pin("a", 0, 0),
      ...pin("b", 8, 0, "bottom"),
      { type: "source_port", source_port_id: "sp_j", name: "pin1" },
      { type: "pcb_port", pcb_port_id: "pp_j", source_port_id: "sp_j", x: 4, y: 0, layers: ["top", "bottom"] },
      { type: "pcb_plated_hole", pcb_plated_hole_id: "foro_j", pcb_port_id: "pp_j", shape: "circle", x: 4, y: 0, hole_diameter: 0.9, outer_diameter: 1.5, layers: ["top", "bottom"] },
      ...rete(1, "TASTO", ["a", "b", "j"]),
      trace("t1", "st_TASTO_0", [wire(0, 0), wire(4, 0)]),
      trace("t2", "st_TASTO_1", [wire(4, 0, "bottom"), wire(8, 0, "bottom")]),
    ];
    const rame = gruppiDiRame(circuito);
    expect(new Set([rame.diPorta("pp_a"), rame.diPorta("pp_b"), rame.diPorta("pp_j")]).size).toBe(1);
    // il foro e' su ogni strato
    expect(rame.gruppi[rame.diPorta("pp_j")].piazzole.find((p) => p.id === "foro_j")).toMatchObject({ tipo: "foro", strato: null });
  });

  it("due reti sullo stesso pezzo di rame: il gruppo le nomina tutte e due", () => {
    const circuito: El[] = [
      board,
      ...pin("a", 0, 0),
      ...pin("b", 5, 0),
      ...pin("c", 2.5, 0),
      ...rete(1, "SDA", ["a", "b"]),
      ...rete(2, "SCL", ["c"]),
      // la pista di SDA passa sopra la piazzola di SCL
      trace("t1", "st_SDA_0", [wire(0, 0), wire(5, 0)]),
    ];
    const rame = gruppiDiRame(circuito);
    const g = rame.gruppi[rame.diPorta("pp_c")];
    expect(g.reti.map((r) => rame.reti.nome(r))).toEqual(["SDA", "SCL"]);
  });
});

describe("le isole come le conta il compile", () => {
  it("non guardano le colate: due piazzole nella stessa colata restano due isole", () => {
    const circuito: El[] = [
      board,
      ...pin("a", 0, 0),
      ...pin("b", 8, 0),
      ...rete(1, "GND", ["a", "b"]),
      colata("gnd_top", 1, "top", -2, -2, 10, 2),
    ];
    const isola = isoleDiRame(circuito);
    expect(isola("pp_a")).not.toBe(isola("pp_b"));
    expect(gruppiDiRame(circuito).diPorta("pp_a")).toBe(gruppiDiRame(circuito).diPorta("pp_b"));
  });

  it("e non uniscono due piazzole sovrapposte", () => {
    const circuito: El[] = [board, ...pin("a", 0, 0), ...pin("b", 0.4, 0), ...rete(1, "TP", ["a", "b"])];
    const isola = isoleDiRame(circuito);
    expect(isola("pp_a")).not.toBe(isola("pp_b"));
  });

  it("piste, vie e piazzole si': la stessa isola del conteggio", () => {
    const circuito: El[] = [
      board,
      ...pin("a", 0, 0),
      ...pin("b", 6, 0, "bottom"),
      ...rete(1, "SDA", ["a", "b"]),
      trace("t1", "st_SDA_0", [wire(0, 0), wire(3, 0)]),
      trace("t2", "st_SDA_1", [wire(3, 0, "bottom"), wire(6, 0, "bottom")]),
      via("v", 3, 0),
    ];
    const isola = isoleDiRame(circuito);
    expect(isola("pp_a")).toBe(isola("pp_b"));
    // una porta che non c'e' e' un'isola a se', ogni volta
    expect(isola("mai_vista")).not.toBe(isola("mai_vista"));
  });
});
