import { describe, expect, it } from "vitest";

/*
 * "SPINGI E SPOSTA", THE PUSH: the traces in the way of the copper in hand
 * step aside (risolutore.ts), each by the least it takes, and push the ones
 * behind them.
 *
 * The boards are the dense ones of spinta-scheda.ts: traces S0, S1... of
 * different nets whose middle stretches run side by side half a millimetre
 * apart (0.2 mm wide: 0.3 mm of air, and the project draws at 0.2), S0 the
 * lowest; a lone via of GND above them (ring 0.6 mm); a trace T above
 * everything; two traces on the bottom; a pad behind the bundle.
 *
 * The numbers follow from those: a via whose centre is at y keeps the nearest
 * middle stretch at y - 0.3 (its ring) - 0.2 (the air) - 0.1 (half the trace)
 * = y - 0.6 or lower, and two stretches keep their centre lines 0.4 apart.
 */
import { direzioneEsatta, inUnita } from "@/lib/spinta/geometria";
import { chiudiGesto, iniziaGesto, muoviGesto } from "@/lib/spinta/gesto";
import type { PresaDelRame, StatoDelGesto } from "@/lib/spinta/gesto-tipi";
import { leggiModello } from "@/lib/spinta/modello";
import { PROFONDITA_MASSIMA, Risolutore, SPINTE_MASSIME, TEMPO_MASSIMO_MS } from "@/lib/spinta/risolutore";
import { comeDetto, GUARDATE, posto, salva, violazioni } from "./spinta-prove";
import { REGOLE, schedaFitta, type OpzioniFitta } from "./spinta-scheda";

const VIA: PresaDelRame = { tipo: "via", pcbViaId: "v_su" };
const tratto = (pcbTraceId: string, indice: number): PresaDelRame => ({ tipo: "tratto", pcbTraceId, indice });

function prendi(opzioni: OpzioniFitta, presa: PresaDelRame = VIA) {
  const board = schedaFitta(opzioni);
  // the board of the test breaks no rule to begin with
  expect(violazioni(board.scheda)).toEqual(Object.fromEntries(GUARDATE.map((r) => [r, 0])));
  const esito = iniziaGesto({ circuitJson: board.scheda, regole: REGOLE, presa });
  if ("rifiuto" in esito) throw new Error(esito.rifiuto);
  return { ...board, gesto: esito.gesto, fermo: esito.stato };
}

/** the long stretches along x that a state draws, as "layer y", the highest first: the middle stretches of the traces it moved */
const mezzi = (stato: StatoDelGesto): string[] =>
  stato.tratti
    .filter((t) => t.y1 === t.y2 && Math.abs(t.x2 - t.x1) > 4)
    .sort((a, b) => b.y1 - a.y1 || a.layer.localeCompare(b.layer))
    .map((t) => `${t.layer} ${t.y1}`);

/** every stretch a state draws is at 0, 45 or 90 degrees on whole units */
function esatto(stato: StatoDelGesto): void {
  for (const t of stato.tratti) expect(direzioneEsatta(inUnita(t.x2) - inUnita(t.x1), inUnita(t.y2) - inUnita(t.y1)), JSON.stringify(t)).toBe(true);
}

/**
 * What a state asks to be saved goes the way a save goes, and the board it
 * leaves is the copper the state drew, with no check of the house worse than
 * before (see spinta-prove.ts).
 */
function salvato(board: ReturnType<typeof prendi>, stato: StatoDelGesto) {
  const salvataggio = chiudiGesto(board.gesto, stato, "g1")!;
  const dopo = salva({ scheda: board.scheda, edits: board.edits }, salvataggio, "spinta");
  comeDetto(
    board.scheda,
    dopo.scheda,
    { piste: new Set(stato.nascosti.pcbTraceIds), vie: new Set(stato.nascosti.pcbViaIds) },
    { tratti: stato.tratti.map((t) => JSON.stringify(t)), vie: stato.vie.map(posto) },
    "spinta",
  );
  expect(violazioni(dopo.scheda)).toEqual(violazioni(board.scheda));
  return salvataggio;
}

describe("spinta: a via dragged against a trace of another net", () => {
  it("the stretch in its way slides aside by the least that keeps the distance, its neighbours follow exactly, and it goes back when the pointer does", () => {
    // one trace, its middle stretch along y = 0; the via starts at (0; 1.5)
    const board = prendi({ quante: 1 });
    const { gesto, fermo } = board;
    expect(fermo).toMatchObject({ nascosti: { pcbTraceIds: [], pcbViaIds: ["v_su"] }, tratti: [], mosso: false });

    // 0.2 mm of air at y = 0.6: not yet
    for (const y of [1, 0.6]) expect(muoviGesto(gesto, { x: 0, y })).toMatchObject({ blocco: null, tratti: [], posizione: { x: 0, y } });
    expect(muoviGesto(gesto, { x: 0, y: 0.6 }).nascosti).toBe(fermo.nascosti);

    // lower than that the stretch gives way: as far as 0.2 mm of air ask, and no further
    const stato = muoviGesto(gesto, { x: 0, y: 0.5 });
    expect(stato).toMatchObject({ blocco: null, mosso: true, posizione: { x: 0, y: 0.5 }, vie: [{ x: 0, y: 0.5, outerDiameter: 0.6, holeDiameter: 0.3 }] });
    expect(stato.nascosti).toEqual({ pcbTraceIds: ["t_s0"], pcbViaIds: ["v_su"] });
    // the middle stretch 0.1 lower, the two diagonals 0.1 longer along their own lines, the stretches out of the pads as they were
    const q = (x1: number, y1: number, x2: number, y2: number) => ({ x1, y1, x2, y2, layer: "top", width: 0.2 });
    expect(stato.tratti).toEqual([q(-16, 2, -14, 2), q(-14, 2, -11.9, -0.1), q(-11.9, -0.1, 11.9, -0.1), q(11.9, -0.1, 14, 2), q(14, 2, 16, 2)]);
    esatto(stato);
    const salvataggio = salvato(board, stato);
    expect(salvataggio.routes.map((r) => r.connection)).toEqual([".S0a > .1 to net.S0"]);
    expect(salvataggio.vias).toHaveLength(1);

    // and back: the trace is where the files put it, and the hidden copper is the object of the start
    const tornato = muoviGesto(gesto, { x: 0, y: 1.5 });
    expect(tornato).toEqual(fermo);
    expect(tornato.nascosti).toBe(fermo.nascosti);
    expect(chiudiGesto(gesto, tornato, "g1")).toBeNull();
    // half way back the trace is half way back
    expect(mezzi(muoviGesto(gesto, { x: 0, y: 0.55 }))).toEqual(["top -0.05"]);
  });

  it("it pushes on every layer: the traces of the top and the ones of the bottom under them", () => {
    // three on the top (0.5, 0, -0.5) and two on the bottom (0.7, 0.2); the via comes down to y = 0.9
    const board = prendi({ quante: 3, sotto: true });
    const stato = muoviGesto(board.gesto, { x: 0, y: 0.9 });
    expect(stato.blocco).toBeNull();
    expect(stato.nascosti.pcbTraceIds).toEqual(["t_s1", "t_s2", "t_b0", "t_b1"]);
    expect(mezzi(stato)).toEqual(["bottom 0.3", "top 0.3", "bottom -0.1", "top -0.1"]);
    esatto(stato);
    salvato(board, stato);
    // a little higher only the bottom is in its way
    const prima = muoviGesto(board.gesto, { x: 0, y: 1.1 });
    expect(prima.nascosti.pcbTraceIds).toEqual(["t_b0", "t_b1"]);
    expect(mezzi(prima)).toEqual(["bottom 0.5", "bottom 0.1"]);
  });
});

describe("spinta: a chain", () => {
  it("three traces side by side all move, each by the least: the first as far as the via asks, the next as far as the one before it", () => {
    const board = prendi({ quante: 3 });
    const stato = muoviGesto(board.gesto, { x: 0, y: 0.8 });
    expect(stato).toMatchObject({ blocco: null, posizione: { x: 0, y: 0.8 } });
    expect(stato.nascosti.pcbTraceIds).toEqual(["t_s0", "t_s1", "t_s2"]);
    // 0.5 to 0.2 (0.3 mm), 0 to -0.2 (0.2 mm), -0.5 to -0.6 (0.1 mm): 0.4 between centre lines, 0.2 of air
    expect(mezzi(stato)).toEqual(["top 0.2", "top -0.2", "top -0.6"]);
    esatto(stato);
    expect(salvato(board, stato).routes).toHaveLength(3);
    // a little higher the third has no need to move yet
    expect(muoviGesto(board.gesto, { x: 0, y: 0.95 }).nascosti.pcbTraceIds).toEqual(["t_s1", "t_s2"]);
  });

  it("with a pad behind the third it is blocked: the pad is named, with the trace that has no room, and the copper stands at the last good step", () => {
    // the pad of AUX leaves the lowest trace 0.2 mm to go: the via can come down to y = 0.7
    const board = prendi({ quante: 3, padDietro: true });
    const stato = muoviGesto(board.gesto, { x: 0, y: 0.3 });
    expect(stato.blocco).toEqual({
      motivo: "bloccato dalla piazzola AUXa.1: la pista .S0a > .1 to net.S0 non ha spazio",
      alone: { x: 0, y: -1.3, raggioMm: expect.closeTo(0.4243, 3), layer: "top" },
    });
    expect(stato.posizione.x).toBe(0);
    expect(stato.posizione.y).toBeGreaterThanOrEqual(0.7);
    expect(stato.posizione.y).toBeLessThan(0.72);
    // everything it pushed stands where that step put it
    const y = stato.posizione.y;
    const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
    expect(mezzi(stato)).toEqual([`top ${r4(y - 0.6)}`, `top ${r4(y - 1)}`, `top ${r4(y - 1.4)}`]);
    esatto(stato);
    salvato(board, stato);
    // asked for further still, the same answer
    expect(muoviGesto(board.gesto, { x: 0, y: -5 }).blocco?.motivo).toBe(stato.blocco?.motivo);
  });

  it("a stretch dragged sideways pushes the same way", () => {
    // the trace T runs along y = 3.7 above three traces; its middle stretch is dragged down to y = 0.5
    const board = prendi({ quante: 3, via: false, tratto: true }, tratto("t_t", 2));
    expect(board.fermo.nascosti).toEqual({ pcbTraceIds: ["t_t"], pcbViaIds: [] });
    const stato = muoviGesto(board.gesto, { x: 2, y: 0.5 });
    expect(stato).toMatchObject({ blocco: null, mosso: true, posizione: { x: 2, y: 0.5 } });
    expect(stato.nascosti.pcbTraceIds).toEqual(["t_t", "t_s0", "t_s1", "t_s2"]);
    expect(mezzi(stato)).toEqual(["top 0.5", "top 0.1", "top -0.3", "top -0.7"]);
    esatto(stato);
    expect(salvato(board, stato).routes).toHaveLength(4);
    // and far into them: the diagonals of T sweep the bundle as well, and every trace is taken below them
    const giu = muoviGesto(board.gesto, { x: 2, y: -1.7 });
    expect(giu.blocco).toBeNull();
    expect(mezzi(giu)).toEqual(["top -1.7", "top -2.1", "top -2.5", "top -2.9"]);
    esatto(giu);
    salvato(board, giu);
  });

  it("hand copper is pushed on its own grid, and saved as rewritten routes", () => {
    // the same three traces as hand routes, four pieces chained for each
    const board = prendi({ quante: 3, aMano: true });
    const stato = muoviGesto(board.gesto, { x: 0.00004, y: 0.83336 });
    expect(stato.blocco).toBeNull();
    // the via is a via of the files, on the fine grid; the hand routes are on whole microns, a hair further than the least
    expect(stato.posizione).toEqual({ x: 0, y: 0.8334 });
    expect(mezzi(stato)).toEqual(["top 0.233", "top -0.167", "top -0.567"]);
    esatto(stato);
    const salvataggio = salvato(board, stato);
    expect(salvataggio.routes).toEqual([]);
    // the middle piece of each trace, and the two pieces chained to it
    expect(salvataggio.riscritte).toHaveLength(9);
    for (const r of salvataggio.riscritte) for (const p of r.points) expect([Math.abs(inUnita(p.x)) % 10, Math.abs(inUnita(p.y)) % 10]).toEqual([0, 0]);
  });
});

describe("spinta: the limits", () => {
  it("the constants", () => {
    expect([PROFONDITA_MASSIMA, SPINTE_MASSIME, TEMPO_MASSIMO_MS]).toEqual([8, 60, 150]);
  });

  it("a chain deeper than the limit is blocked, naming the trace it stopped on; the gesture stops at the last step that solves", () => {
    // nine traces: the via can push eight of them
    const board = prendi({ quante: 9 });
    const stato = muoviGesto(board.gesto, { x: 0, y: 1 });
    expect(stato.blocco?.motivo).toBe("bloccato: la pista .S0a > .1 to net.S0 non ha spazio (la catena di spinte supera 8 piste)");
    expect(stato.nascosti.pcbTraceIds).toEqual(["t_s1", "t_s2", "t_s3", "t_s4", "t_s5", "t_s6", "t_s7", "t_s8"]);
    // the eighth is 0.2 mm from the ninth, which has not moved: the via at 1.8
    expect(stato.posizione.y).toBeGreaterThanOrEqual(1.8);
    expect(stato.posizione.y).toBeLessThan(1.82);
    esatto(stato);
    salvato(board, stato);
  });

  it("each limit has its sentence: how deep, how many pushes, how long", () => {
    const { scheda } = schedaFitta({ quante: 5 });
    const modello = leggiModello(scheda, REGOLE);
    const via = modello.viaPerId.get("v_su")!;
    const di = (limiti: Partial<{ profondita: number; spinte: number; tempoMs: number }>, inizio?: number) =>
      new Risolutore(modello, { profondita: PROFONDITA_MASSIMA, spinte: SPINTE_MASSIME, tempoMs: TEMPO_MASSIMO_MS, ...limiti }).spostaVia(via, { x: 0, y: 1 }, inizio);
    // with the limits of the house the five give way: the via at 1, the highest at 0.4, each 0.4 under the one before
    const libero = di({});
    if (!libero.ok) throw new Error(libero.blocco.messaggio);
    expect(libero.piste.map((p) => modello.piste[p.pista].id)).toEqual(["t_s4", "t_s3", "t_s2", "t_s1", "t_s0"]);
    const frase = (esito: ReturnType<typeof di>) => (esito.ok ? "libero" : `${esito.blocco.motivo}: ${esito.blocco.messaggio}`);
    expect(frase(di({ profondita: 2 }))).toBe("catena: bloccato: la pista .S2a > .1 to net.S2 non ha spazio (la catena di spinte supera 2 piste)");
    // the via reaches the two highest by itself (two pushes), the highest then pushes the second further (a third): the fourth would be of the third trace
    expect(frase(di({ spinte: 3 }))).toBe("catena: bloccato: la pista .S2a > .1 to net.S2 non ha spazio (piu' di 3 spinte in un movimento)");
    // a movement that began to be worked on a second ago
    expect(frase(di({ tempoMs: 20 }, performance.now() - 1000))).toBe("catena: bloccato: la pista .S4a > .1 to net.S4 non ha spazio (il calcolo supera 20 ms)");
  });
});

describe("spinta: no oscillation, and the hidden copper", () => {
  it("the same gesture repeated gives the same state, byte for byte, whatever the pointer did in between, free or blocked", () => {
    const board = prendi({ quante: 5, padDietro: true });
    const { gesto } = board;
    const posti = [
      { x: 0, y: 1.6 },
      { x: 0.3, y: 1.2 },
      { x: -2, y: 0.7 },
      { x: 0, y: -3 },
    ];
    const prima = posti.map((p) => JSON.stringify(muoviGesto(gesto, p)));
    // the last one is blocked by the pad behind the bundle
    expect(JSON.parse(prima[3]).blocco.motivo).toContain("bloccato dalla piazzola AUXa.1");
    for (let giro = 0; giro < 3; giro++) {
      for (const k of [3, 0, 2, 1, 1, 3, 2, 0]) expect(JSON.stringify(muoviGesto(gesto, posti[k]))).toBe(prima[k]);
    }
    // and from a gesture begun anew
    const ancora = prendi({ quante: 5, padDietro: true });
    for (const [k, p] of posti.entries()) expect(JSON.stringify(muoviGesto(ancora.gesto, p))).toBe(prima[k]);
  });

  it("the hidden copper is the same object for as long as the same traces are pushed, and another when one enters or leaves", () => {
    const { gesto, fermo } = prendi({ quante: 3 });
    const a = (y: number, x = 0) => muoviGesto(gesto, { x, y });
    // nothing pushed: the object of the start
    expect(a(1.5).nascosti).toBe(fermo.nascosti);
    expect(a(1.2, 3).nascosti).toBe(fermo.nascosti);
    // the highest trace pushed, at any place that pushes only that one
    const una = a(1.05).nascosti;
    expect(una).toEqual({ pcbTraceIds: ["t_s2"], pcbViaIds: ["v_su"] });
    expect(una).not.toBe(fermo.nascosti);
    expect(a(1.02, 1).nascosti).toBe(una);
    expect(a(1.08, -2).nascosti).toBe(una);
    // a second one enters: another object, the same for that set
    const due = a(0.95).nascosti;
    expect(due.pcbTraceIds).toEqual(["t_s1", "t_s2"]);
    expect(due).not.toBe(una);
    expect(a(0.92).nascosti).toBe(due);
    // back: the objects that were, not new ones
    expect(a(1.05).nascosti).toBe(una);
    expect(a(1.5).nascosti).toBe(fermo.nascosti);
  });
});
