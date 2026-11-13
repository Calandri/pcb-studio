import { describe, expect, it } from "vitest";

/*
 * "SPINGI E SPOSTA", A WIDE TRACE: a stretch of a trace wider than its corners
 * are long moves, and the block says which stretch is too short.
 *
 * The trace is the VBAT of sbb-dl-principale as it was on 2026-11-13: 0.8 mm
 * wide, out of its pad, a diagonal, a long stretch up, a corner stretch of
 * 0.57 mm, and a long stretch across. The rule was "no stretch shorter than
 * the trace is wide": the corner was already shorter, so the long stretch
 * could not go toward it by a micron, and the block said "a stretch would
 * vanish", neither which nor why.
 */
import { chiudiGesto, iniziaGesto, muoviGesto, preseDelRame } from "@/lib/spinta/gesto";
import type { StatoDelGesto } from "@/lib/spinta/gesto-tipi";
import { emptyManualEdits } from "@/lib/manual-edits";
import { pezzo, rete, scheda, trace, wire, type El } from "./scheda-di-prova";
import { GUARDATE, salva, violazioni } from "./spinta-prove";
import { REGOLE } from "./spinta-scheda";

const largo = (x: number, y: number) => ({ ...wire(x, y), width: 0.8 });

/** the pad at (0; -6), up a millimetre, a diagonal to x = -1.5, up to y = 4, the corner of 0.57 mm, across to x = 6, a diagonal, and straight into the other pad */
const larga = (): El[] => [
  { ...scheda(2), width: 40, height: 30 },
  ...pezzo("Va", [["1", 0, -6]]),
  ...pezzo("Vb", [["1", 9.5, 5.9]]),
  ...rete(2, "VBAT", ["Va_1", "Vb_1"]),
  trace("t_v", "st_VBAT_0", [largo(0, -6), largo(0, -5), largo(-1.5, -3.5), largo(-1.5, 4), largo(-1.1, 4.4), largo(6, 4.4), largo(7.5, 5.9), largo(9.5, 5.9)]),
];

function prendi(indice: number) {
  const cj = larga();
  expect(violazioni(cj)).toEqual(Object.fromEntries(GUARDATE.map((r) => [r, 0])));
  const presa = preseDelRame(cj).find((p) => p.tipo === "tratto" && p.indice === indice)!;
  expect(presa.fermo).toBeUndefined();
  const esito = iniziaGesto({ circuitJson: cj, regole: REGOLE, presa: { tipo: "tratto", pcbTraceId: "t_v", indice } });
  if ("rifiuto" in esito) throw new Error(esito.rifiuto);
  return { scheda: cj, gesto: esito.gesto };
}

/** the corners of the trace a state draws, in order */
const angoli = (stato: StatoDelGesto) => [...stato.tratti.map((t) => [t.x1, t.y1]), [stato.tratti.at(-1)!.x2, stato.tratti.at(-1)!.y2]];

describe("spinta: a trace wider than its corners are long", () => {
  it("the long stretch goes toward the short corner, until 0.2 mm of the corner are left", () => {
    // the stretch up along x = -1.5 (2), asked to go 2 mm to the right: the corner of 0.57 mm gets shorter with it
    const board = prendi(2);
    const poco = muoviGesto(board.gesto, { x: -1.4, y: 0 });
    expect(poco).toMatchObject({ blocco: null, mosso: true });
    expect(angoli(poco)).toEqual([[0, -6], [0, -5], [-1.4, -3.6], [-1.4, 4.1], [-1.1, 4.4], [6, 4.4], [7.5, 5.9], [9.5, 5.9]]);

    const stato = muoviGesto(board.gesto, { x: 0.5, y: 0 });
    expect(stato.blocco?.motivo).toBe("bloccato: il tratto accanto e' lungo 0,57 mm e non si accorcia sotto 0,2 mm");
    const x = stato.tratti[2].x1;
    // 0.2 mm of diagonal are 0.1414 mm across: the stretch stops between -1.25 and -1.24, as near as the halving of the last step takes it
    expect(x).toBeGreaterThan(-1.26);
    expect(x).toBeLessThanOrEqual(-1.2414);
    expect(stato.tratti.every((t) => t.width === 0.8)).toBe(true);
    // what it leaves is saved, and no check is worse for it
    const dopo = salva({ scheda: board.scheda, edits: emptyManualEdits() }, chiudiGesto(board.gesto, stato, "g1")!, "larga");
    expect(violazioni(dopo.scheda)).toEqual(violazioni(board.scheda));
  });

  it("the other way nothing is short: the stretch goes as far as it is asked", () => {
    const board = prendi(2);
    const stato = muoviGesto(board.gesto, { x: -3.5, y: 0 });
    expect(stato).toMatchObject({ blocco: null, mosso: true });
    expect(angoli(stato)).toEqual([[0, -6], [0, -5], [-3.5, -1.5], [-3.5, 2], [-1.1, 4.4], [6, 4.4], [7.5, 5.9], [9.5, 5.9]]);
  });

  it("the stretch across goes toward the corner too, and stops at the same 0.2 mm", () => {
    // the stretch across (4), asked to go down: its end slides down the corner before it, which gets shorter
    const board = prendi(4);
    const stato = muoviGesto(board.gesto, { x: 2, y: 2 });
    expect(stato.blocco?.motivo).toBe("bloccato: il tratto accanto e' lungo 0,57 mm e non si accorcia sotto 0,2 mm");
    const y = stato.tratti[4].y1;
    expect(y).toBeLessThan(4.16);
    expect(y).toBeGreaterThanOrEqual(4.1414);
  });

  it("the corner itself, pushed into its own corner, says it is the one that is short", () => {
    // the corner stretch (3), asked to go up and to the left: its two ends come together along the stretches beside it
    const board = prendi(3);
    const stato = muoviGesto(board.gesto, { x: -3, y: 6 });
    expect(stato.blocco?.motivo).toBe("bloccato: questo tratto e' lungo 0,57 mm e non si accorcia sotto 0,2 mm");
    expect(stato.mosso).toBe(true);
    const t = stato.tratti[3];
    const lungo = Math.hypot(t.x2 - t.x1, t.y2 - t.y1);
    expect(lungo).toBeGreaterThanOrEqual(0.2 - 1e-6);
    expect(lungo).toBeLessThan(0.26);
  });
});
