import { describe, expect, it } from "vitest";

/*
 * "SPINGI E SPOSTA", THE PUSH: A TRACE THAT GOES AROUND ANOTHER, and a via that
 * comes along the line of a stretch.
 *
 * AROUND. The trace K goes around the end of the trace M: one stretch of K
 * runs above the middle stretch of M (y = 0.4 over y = 0), K turns behind the
 * pad M ends on, and comes back under it (y = -0.4). A via above K pushes the
 * near stretch of K down, that one pushes M, and M pushes the FAR stretch of
 * K: a stretch of the trace that was pushed first, pushed by one that was
 * pushed after it. M is not squeezed between the two: the far stretch has all
 * the room it wants below, and moves on.
 *
 * IN LINE. A via that comes along the line of a stretch, toward its end, is on
 * neither side of it: the stretch that turns away at the corner faces the via
 * and steps aside, and the one in line only gets shorter.
 */
import { direzioneEsatta, inUnita } from "@/lib/spinta/geometria";
import { chiudiGesto, iniziaGesto, muoviGesto } from "@/lib/spinta/gesto";
import type { StatoDelGesto } from "@/lib/spinta/gesto-tipi";
import { emptyManualEdits } from "@/lib/manual-edits";
import { pezzo, rete, scheda, trace, wire, type El } from "./scheda-di-prova";
import { comeDetto, GUARDATE, posto, salva, violazioni } from "./spinta-prove";
import { REGOLE, viaDi } from "./spinta-scheda";

const base = (): El[] => [{ ...scheda(2), width: 40, height: 30 }, ...pezzo("Ga", [["1", 0, 12]]), ...pezzo("Gb", [["1", -15, -12]]), ...rete(1, "GND", ["Ga_1", "Gb_1"])];

/** K around the end of M, and a lone via of ground above the two at (-2; 2) */
const avvolta = (): El[] => [
  ...base(),
  ...pezzo("Ka", [["1", -11, 3.5]]),
  ...pezzo("Kb", [["1", -11, -3.5]]),
  ...rete(2, "K", ["Ka_1", "Kb_1"]),
  ...pezzo("Ma", [["1", -10, 0.5]]),
  ...pezzo("Mb", [["1", 5, -0.5]]),
  ...rete(3, "M", ["Ma_1", "Mb_1"]),
  // out of its pad, down to y = 0.4, along it past the pad of M, down behind it, back along y = -1.4 and y = -0.4, and down to its other pad
  trace("t_k", "st_K_0", [wire(-11, 3.5), wire(-9.1, 3.5), wire(-6, 0.4), wire(6, 0.4), wire(6, -1.4), wire(3.4, -1.4), wire(2.4, -0.4), wire(-6, -0.4), wire(-9.1, -3.5), wire(-11, -3.5)]),
  trace("t_m", "st_M_0", [wire(-10, 0.5), wire(-8, 0.5), wire(-7.5, 0), wire(3, 0), wire(3.5, -0.5), wire(5, -0.5)]),
  viaDi("v_su", -2, 2, 1),
];

/** S along y = 0 as far as (2; 0), then straight down: a via of ground on the same line, at (5; 0) */
const inLinea = (): El[] => [
  ...base(),
  ...pezzo("Sa", [["1", -10, 2]]),
  ...pezzo("Sb", [["1", 6, -5]]),
  ...rete(2, "S", ["Sa_1", "Sb_1"]),
  trace("t_s", "st_S_0", [wire(-10, 2), wire(-8, 2), wire(-6, 0), wire(2, 0), wire(2, -3), wire(4, -5), wire(6, -5)]),
  viaDi("v_su", 5, 0, 1),
];

function prendi(cj: El[]) {
  // the board of the test breaks no rule to begin with
  expect(violazioni(cj)).toEqual(Object.fromEntries(GUARDATE.map((r) => [r, 0])));
  const esito = iniziaGesto({ circuitJson: cj, regole: REGOLE, presa: { tipo: "via", pcbViaId: "v_su" } });
  if ("rifiuto" in esito) throw new Error(esito.rifiuto);
  return { scheda: cj, gesto: esito.gesto };
}

/** the long stretches along x a state draws, as their heights, the highest first */
const lunghi = (stato: StatoDelGesto): number[] =>
  stato.tratti
    .filter((t) => t.y1 === t.y2 && Math.abs(t.x2 - t.x1) > 4)
    .map((t) => t.y1)
    .sort((a, b) => b - a);

/** what the state asks to be saved goes the way a save goes: the board it leaves is the copper it drew, exact, with no check worse than before */
function salvato(board: ReturnType<typeof prendi>, stato: StatoDelGesto) {
  for (const t of stato.tratti) expect(direzioneEsatta(inUnita(t.x2) - inUnita(t.x1), inUnita(t.y2) - inUnita(t.y1)), JSON.stringify(t)).toBe(true);
  const salvataggio = chiudiGesto(board.gesto, stato, "g1")!;
  const dopo = salva({ scheda: board.scheda, edits: emptyManualEdits() }, salvataggio, "stretta");
  comeDetto(
    board.scheda,
    dopo.scheda,
    { piste: new Set(stato.nascosti.pcbTraceIds), vie: new Set(stato.nascosti.pcbViaIds) },
    { tratti: stato.tratti.map((t) => JSON.stringify(t)), vie: stato.vie.map(posto) },
    "stretta",
  );
  expect(violazioni(dopo.scheda)).toEqual(violazioni(board.scheda));
  return salvataggio;
}

describe("spinta: a trace that goes around the end of another", () => {
  it("the near stretch pushes the trace in between, and that one pushes the far stretch: nothing is squeezed", () => {
    const board = prendi(avvolta());
    // the ring of the via 0.2 mm from the near stretch at y = 1: nothing moves yet
    expect(muoviGesto(board.gesto, { x: -2, y: 1 })).toMatchObject({ blocco: null, tratti: [], posizione: { x: -2, y: 1 } });

    // 0.1 mm lower all three give way by 0.1: K at 0.3, M at -0.1, and K again at -0.5
    const stato = muoviGesto(board.gesto, { x: -2, y: 0.9 });
    expect(stato).toMatchObject({ blocco: null, mosso: true, posizione: { x: -2, y: 0.9 } });
    expect(stato.nascosti).toEqual({ pcbTraceIds: ["t_k", "t_m"], pcbViaIds: ["v_su"] });
    expect(lunghi(stato)).toEqual([0.3, -0.1, -0.5]);
    // one correction for each trace, the two stretches of K in one
    expect(salvato(board, stato).routes.map((r) => r.connection).sort()).toEqual([".Ka > .1 to net.K", ".Ma > .1 to net.M"]);

    // and back when the pointer goes back
    expect(muoviGesto(board.gesto, { x: -2, y: 1.5 }).tratti).toEqual([]);
  });

  it("what stops it is said by its name: the pad M ends on, which the near stretch of K comes down to", () => {
    // the pad of Mb (0.6 mm, at y = -0.5) keeps the near stretch at y = 0.1 or higher: the via at 0.7
    const board = prendi(avvolta());
    const stato = muoviGesto(board.gesto, { x: -2, y: 0 });
    expect(stato.blocco?.motivo).toBe("bloccato dalla piazzola Mb.1: la pista .Ka > .1 to net.K non ha spazio");
    expect(stato.posizione.y).toBeGreaterThanOrEqual(0.7);
    expect(stato.posizione.y).toBeLessThan(0.72);
    const y = stato.posizione.y;
    const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
    expect(lunghi(stato)).toEqual([r4(y - 0.6), r4(y - 1), r4(y - 1.4)]);
    salvato(board, stato);
  });
});

describe("spinta: a via that comes along the line of a stretch", () => {
  it("the stretch that turns away at the corner steps aside, and the one in line gets shorter", () => {
    const board = prendi(inLinea());
    // 0.2 mm of air from the corner at x = 2.6: not yet
    expect(muoviGesto(board.gesto, { x: 2.6, y: 0 })).toMatchObject({ blocco: null, tratti: [] });

    const stato = muoviGesto(board.gesto, { x: 2.5, y: 0 });
    expect(stato).toMatchObject({ blocco: null, mosso: true, posizione: { x: 2.5, y: 0 } });
    expect(stato.nascosti.pcbTraceIds).toEqual(["t_s"]);
    const q = (x1: number, y1: number, x2: number, y2: number) => ({ x1, y1, x2, y2, layer: "top", width: 0.2 });
    // the stretch down the side 0.1 to the left, the one along y = 0 shorter by as much, the diagonal under it longer along its own line
    expect(stato.tratti).toEqual([q(-10, 2, -8, 2), q(-8, 2, -6, 0), q(-6, 0, 1.9, 0), q(1.9, 0, 1.9, -2.9), q(1.9, -2.9, 4, -5), q(4, -5, 6, -5)]);
    salvato(board, stato);
  });
});
