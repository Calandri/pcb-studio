import { describe, expect, it } from "vitest";

/*
 * "SPINGI E SPOSTA": ONE TEST FOR EACH BLOCK of the two moves (mosse.ts, with
 * nothing pushed), and the way back from the corrections to the copper
 * (rameDelleCorrezioni).
 *
 * A block is an answer: it names what blocks (which pad, which hole, the edge,
 * which trace) and gives no copper, so the board is as it was. The moves read
 * the model and never write it: after all of them the model is the one that
 * was read.
 *
 * The board is the test board of spinta-scheda.ts. The blocks of a stretch
 * that leaves a pad, of a stretch that ends on a via, of a stretch that would
 * vanish and of the edge are in spinta-gesto.test.ts; the ones of hand copper
 * in spinta-gesto-a-mano.test.ts.
 */
import { applyManualRoutes } from "@/lib/manual-routes";
import { iniziaGesto, muoviGesto } from "@/lib/spinta/gesto";
import { leggiModello, type Modello } from "@/lib/spinta/modello";
import { spostaVia, traslaTratto, type Blocco, type EsitoDellaMossa } from "@/lib/spinta/mosse";
import { correzioniDellaMossa, rameDelleCorrezioni } from "@/lib/spinta/salvataggio";
import { trace, wire, type El } from "./scheda-di-prova";
import { AUX, GND, GND_RAMO, rameDiSerie, REGOLE, schedaDiSpinta, SIG, viaDi } from "./spinta-scheda";

/** the copper of a model for what it is: every path and every via */
const rame = (m: Modello): string => JSON.stringify([m.piste.map((p) => p.punti), m.vie.map((v) => [v.x, v.y])]);
const blocco = (esito: EsitoDellaMossa): Blocco => {
  if (esito.ok) throw new Error("mossa fatta, e doveva essere bloccata");
  return esito.blocco;
};
/** the via of that id of a model, moved to a place */
const via = (m: Modello, id: string, a: { x: number; y: number }) => spostaVia(m, m.viaPerId.get(id)!, a);
const tratto = (m: Modello, id: string, quale: number, di: { x: number; y: number }) => traslaTratto(m, { pista: m.pistaPerId.get(id)!, tratto: quale }, di);

describe("spinta, blocchi: what stops a via", () => {
  const modello = leggiModello(schedaDiSpinta(), REGOLE);
  const com_era = rame(modello);
  // the lone via of PWR, at (6; -9): it has no trace, so only what it comes near can stop it
  const lone = (a: { x: number; y: number }) => blocco(via(modello, "v_pwr", a));

  it("a pad of another net: named by part and pin", () => {
    // R4.2 is of AUX: its copper ends at y = -8.3, the ring of the via would reach -8.45
    expect(lone({ x: 16, y: -8.75 })).toMatchObject({
      motivo: "pad",
      cosa: { tipo: "pad", nome: "R4.2", id: "pad_R4_2" },
      dove: { x: 16, y: -8, layer: "top" },
      messaggio: "bloccato dalla piazzola R4.2",
      distanza: expect.closeTo(0.15, 6),
      richiesta: 0.2,
    });
    // 0.2 mm of air and it goes
    expect(via(modello, "v_pwr", { x: 16, y: -8.8 }).ok).toBe(true);
  });

  it("a hole: a bare one, kept as far as the edge of the board; a plated one, by the name of its pin", () => {
    // the bare hole at (10; 1), one millimetre wide
    expect(lone({ x: 10, y: 1.9 })).toMatchObject({
      motivo: "foro",
      cosa: { tipo: "foro", id: "foro_1", metallizzato: false },
      dove: { x: 10, y: 1 },
      messaggio: "bloccato da un foro",
    });
    // the plated hole of J1, of ground: its copper is 1.5 mm wide
    expect(lone({ x: 0, y: -9.8 })).toMatchObject({
      motivo: "foro",
      cosa: { tipo: "foro", nome: "J1.1", id: "foro_J1_1", metallizzato: true },
      dove: { x: 0, y: -11 },
      messaggio: "bloccato dal foro J1.1",
    });
  });

  it("a keepout, on whatever layer it is of: a via is copper on all of them", () => {
    // the keepout of the top layer, from y = 0.5 up: the ring would reach 0.6
    expect(lone({ x: 0, y: 0.3 })).toMatchObject({ motivo: "keepout", cosa: { tipo: "keepout", id: "zona_1" }, messaggio: "bloccato da una zona vietata al rame" });
    expect(via(modello, "v_pwr", { x: 0, y: 0.1 }).ok).toBe(true);
  });

  it("the edge of the board, and the notch in it", () => {
    expect(lone({ x: 6, y: -14.5 })).toMatchObject({ motivo: "bordo", cosa: { tipo: "bordo" }, messaggio: "bloccato dal bordo della scheda" });
    // the notch comes down to y = 11 between x = -5 and x = 5
    expect(lone({ x: 0, y: 10.5 })).toMatchObject({ motivo: "bordo", dove: { x: 0, y: 11 } });
  });

  it("a trace of another net too close: named by its connection, with the place nearest to the via", () => {
    // the trace of AUX runs down x = 18
    expect(lone({ x: 17.5, y: -3 })).toMatchObject({
      motivo: "pista",
      cosa: { tipo: "pista", connessione: AUX, tratto: 1 },
      dove: { x: 18, y: -3, layer: "top" },
      messaggio: `bloccato dalla pista ${AUX}`,
    });
  });

  it("a new acute angle: the via taken back past the corner before it", () => {
    // the via in the path of SIG at (-4; 6): its stretch comes from (-10; 6), and (-11; 7) is behind that corner
    expect(blocco(via(modello, "v_sig_a", { x: -11, y: 7 }))).toMatchObject({
      motivo: "angolo_acuto",
      cosa: { tipo: "pista", connessione: SIG },
      dove: { x: -10, y: 6, layer: "top" },
      messaggio: `bloccato: la pista ${SIG} tornerebbe indietro con un angolo acuto`,
    });
  });

  it("the end of its trace carried into a pad of its own net: the trace would enter it askew", () => {
    // the via at the end of the branch of ground, taken into the plated hole of J1, of ground too
    expect(blocco(via(modello, "v_gnd", { x: 0, y: -11 }))).toMatchObject({
      motivo: "pad",
      cosa: { tipo: "foro", nome: "J1.1" },
      messaggio: "bloccato dalla piazzola J1.1: la pista ci entrerebbe di traverso",
    });
  });

  it("none of them touched the board", () => {
    expect(rame(modello)).toBe(com_era);
  });
});

describe("spinta, blocchi: what cannot be taken at all", () => {
  /** the test board with some copper more, or written another way */
  const con = (rame_: Record<string, El | null>) => leggiModello(schedaDiSpinta(rame_), REGOLE);

  it("an arc: none of its stretches has a direction to keep", () => {
    const m = con({ t_aux: { ...rameDiSerie().t_aux, arco: true } });
    expect(blocco(tratto(m, "t_aux", 1, { x: -0.5, y: 0 }))).toMatchObject({ motivo: "arco", cosa: { tipo: "pista", connessione: AUX }, messaggio: `bloccato: la pista ${AUX} e' un arco` });
  });

  it("a T junction: the stretch another trace ends on, and the stem that ends on it", () => {
    const m = con({});
    // the side of ground, on which the branch ends at (-17; -2)
    expect(blocco(tratto(m, "t_gnd", 1, { x: 0.5, y: 0 }))).toMatchObject({
      motivo: "giunzione_a_t",
      cosa: { tipo: "pista", connessione: GND_RAMO },
      dove: { x: -17, y: -2, layer: "top" },
      messaggio: `bloccato da una giunzione a T con la pista ${GND_RAMO}`,
    });
    expect(blocco(tratto(m, "t_gnd_ramo", 0, { x: 0, y: 0.5 }))).toMatchObject({
      motivo: "giunzione_a_t",
      cosa: { tipo: "pista", connessione: GND },
      messaggio: `bloccato da una giunzione a T con la pista ${GND}`,
    });
  });

  it("a via that stands in the pad where its trace ends: moved, it would take the end out of the pad", () => {
    // a via of PWR in the pad of R4.1, where the trace of PWR ends
    const m = con({ v_pad: viaDi("v_pad", 15, -8, 3) });
    expect(blocco(via(m, "v_pad", { x: 15, y: -9 }))).toMatchObject({
      motivo: "collegamento",
      cosa: { tipo: "pad", nome: "R4.1" },
      messaggio: "bloccato: la via sta nella piazzola R4.1, dove finisce la sua pista: spostata, la staccherebbe",
    });
  });

  it("a via a trace runs through with no corner of its own there: moved, it would leave the trace behind", () => {
    // a via of ground on the side of ground, half way down it
    const m = con({ v_sul_tratto: viaDi("v_sul_tratto", -17, 3, 1) });
    expect(blocco(via(m, "v_sul_tratto", { x: -16, y: 3 }))).toMatchObject({
      motivo: "giunzione_a_t",
      cosa: { tipo: "pista", connessione: GND, tratto: 1 },
      dove: { x: -17, y: 3, layer: "top" },
      messaggio: `bloccato: la pista ${GND} passa sulla via senza un suo vertice`,
    });
  });

  it("a via its trace goes through on one layer: its two stretches are drawn again, and the corner between them may not fold back", () => {
    // the branch of ground goes on past its via and turns up: (-17; -2), the via at (-8; -2), (-8; 4)
    const m = con({ t_gnd_ramo: trace("t_gnd_ramo", "st_GND_1", [wire(-17, -2), wire(-8, -2), wire(-8, 4)]) });
    // toward the outside of the corner both stretches gain a leg at 45 degrees, and the trace goes on
    expect(via(m, "v_gnd", { x: -9, y: -1 }).ok).toBe(true);
    // toward the inside the two legs would meet in the via coming back on each other
    expect(blocco(via(m, "v_gnd", { x: -7, y: -3 }))).toMatchObject({
      motivo: "angolo_acuto",
      cosa: { tipo: "pista", connessione: GND_RAMO },
      dove: { x: -7, y: -3, layer: "top" },
      messaggio: `bloccato: la pista ${GND_RAMO} farebbe un angolo acuto`,
    });
  });

  it("as a gesture: what cannot be taken says so at once, and what is stopped on its way stands at the last good place with the board as it was beyond it", () => {
    const scheda = schedaDiSpinta({ t_aux: { ...rameDiSerie().t_aux, arco: true } });
    expect(iniziaGesto({ circuitJson: scheda, regole: REGOLE, presa: { tipo: "tratto", pcbTraceId: "t_aux", indice: 1 } })).toEqual({ rifiuto: `bloccato: la pista ${AUX} e' un arco` });
    const inizio = iniziaGesto({ circuitJson: scheda, regole: REGOLE, presa: { tipo: "via", pcbViaId: "v_pwr" } });
    if ("rifiuto" in inizio) throw new Error(inizio.rifiuto);
    // up into the keepout: it stops under it, 0.3 mm of ring below y = 0.5
    const fermo = muoviGesto(inizio.gesto, { x: 0, y: 3 });
    expect(fermo.blocco?.motivo).toBe("bloccato da una zona vietata al rame");
    expect(fermo.posizione.y).toBeLessThanOrEqual(0.2);
    expect(fermo.nascosti).toBe(inizio.stato.nascosti);
    expect(fermo.tratti).toEqual([]);
  });
});

describe("spinta, salvataggio: from the corrections back to the copper", () => {
  const scheda = schedaDiSpinta();
  const modello = leggiModello(scheda, REGOLE);

  it("laid: each correction is found on the board the gesture began on, and says where its copper goes; a via in the path of a trace is read from the two paths", () => {
    // the via in the path of SIG, moved: one route, no entry of pcb_vias
    const mossa = via(modello, "v_sig_a", { x: -4.5, y: 7 });
    if (!mossa.ok) throw new Error(mossa.blocco.messaggio);
    const rame_ = correzioniDellaMossa(modello, mossa, "g1");
    expect(rame_.vias).toEqual([]);
    expect(rameDelleCorrezioni(modello, rame_)).toEqual({ piste: mossa.piste, vie: mossa.vie, nonTrovate: { routes: [], vias: [] } });

    // the lone via at the end of the branch of ground, with its trace: a route and an entry of pcb_vias
    const conLaVia = via(modello, "v_gnd", { x: -7, y: -1.5 });
    if (!conLaVia.ok) throw new Error(conLaVia.blocco.messaggio);
    const dueVoci = correzioniDellaMossa(modello, conLaVia, "g2");
    expect([dueVoci.routes.length, dueVoci.vias.length]).toEqual([1, 1]);
    expect(rameDelleCorrezioni(modello, dueVoci, "posate")).toEqual({ piste: conLaVia.piste, vie: conLaVia.vie, nonTrovate: { routes: [], vias: [] } });
  });

  it("taken away: on the board that shows them, each goes back to where the files put it (what an undo draws)", () => {
    const mossa = via(modello, "v_gnd", { x: -7, y: -1.5 });
    if (!mossa.ok) throw new Error(mossa.blocco.messaggio);
    const rame_ = correzioniDellaMossa(modello, mossa, "g2");
    const posata = applyManualRoutes({ circuitJson: scheda, routes: rame_.routes, vias: rame_.vias, viaDiameter: 0.6, viaHoleDiameter: 0.3 }).circuitJson;
    const mostrata = leggiModello(posata, REGOLE);
    const indietro = rameDelleCorrezioni(mostrata, rame_, "tolte");
    expect(indietro.nonTrovate).toEqual({ routes: [], vias: [] });
    // the trace on the path it had, the via from where it is to where it was
    expect(indietro.piste.map((p) => [mostrata.piste[p.pista].connessione, p.punti])).toEqual([[GND_RAMO, modello.piste[modello.pistaPerId.get("t_gnd_ramo")!].punti]]);
    expect(indietro.vie.map((v) => [v.da, v.a])).toEqual([[{ x: -7, y: -1.5 }, { x: -8, y: -2 }]]);
    // on that board the corrections are not "to be laid" any more: their copper is not where they start from
    expect(rameDelleCorrezioni(mostrata, rame_, "posate")).toEqual({ piste: [], vie: [], nonTrovate: rame_ });
  });

  it("a correction whose copper is not on the board is said, not guessed: another connection, another path, a route that corrects nothing", () => {
    const mossa = via(modello, "v_gnd", { x: -7, y: -1.5 });
    if (!mossa.ok) throw new Error(mossa.blocco.messaggio);
    const [route] = correzioniDellaMossa(modello, mossa, "g2").routes;
    const altre = [
      { ...route, connection: ".R9 > .1 to net.GND" },
      { ...route, replaces: { ...route.replaces!, original: route.points } },
      { connection: route.connection, points: route.points, width: 0.2 },
    ];
    const altraVia = { net: "SIG", from: { x: -8, y: -2 }, to: { x: -7, y: -1.5 }, holeDiameter: 0.3, outerDiameter: 0.6, layers: ["top", "bottom"] };
    expect(rameDelleCorrezioni(modello, { routes: altre, vias: [altraVia] })).toEqual({ piste: [], vie: [], nonTrovate: { routes: altre, vias: [altraVia] } });
  });
});
