import { describe, expect, it } from "vitest";

/*
 * "SPINGI E SPOSTA", THE PUSH: WHAT IT COSTS.
 *
 * The plan wants a movement of the pointer solved in under 8 ms on the
 * developer's machine, and holds it under 40 ms here. On a board of 300
 * traces and 300 vias (4514 elements), measured on 2026-11-13 on that machine
 * with the suite running on four workers:
 *   - reading the model: 6 ms;
 *   - iniziaGesto (the model, and whether the thing can be taken): 5.5 ms;
 *   - muoviGesto of a via that pushes a trace aside, half a millimetre in a
 *     few steps, each solved from the start of the gesture: 0.08 ms;
 *   - the same via moved a step where nothing is in its way: 0.003 ms;
 *   - a via pushing a chain of eight traces on the dense board, 1.7 mm in
 *     eleven steps, the whole chain solved at each: 1.8 ms.
 * The bounds below are loose on purpose: they catch a solve that has become
 * ten times slower, not a busy machine.
 */
import { chiudiGesto, iniziaGesto, muoviGesto } from "@/lib/spinta/gesto";
import { leggiModello } from "@/lib/spinta/modello";
import { REGOLE, schedaFitta, schedaGrande } from "./spinta-scheda";

/** the middle one of the times a thing takes, ms: one slow run (a collection of garbage) does not count */
function mediana(volte: number, cosa: (i: number) => void): number {
  const tempi: number[] = [];
  for (let i = 0; i < volte; i++) {
    const t = performance.now();
    cosa(i);
    tempi.push(performance.now() - t);
  }
  return tempi.sort((a, b) => a - b)[Math.floor(volte / 2)];
}

describe("spinta, tempi", () => {
  it("on a board of 300 traces and 300 vias: the model, the start of a gesture, and a movement of the pointer that pushes, each far under 40 ms", () => {
    const scheda = schedaGrande();
    expect(scheda.filter((e) => e.type === "pcb_trace")).toHaveLength(300);
    expect(scheda.filter((e) => e.type === "pcb_via")).toHaveLength(300);

    const modello = mediana(7, () => leggiModello(scheda, REGOLE));
    const presa = { tipo: "via" as const, pcbViaId: "v_155" };
    const inizia = mediana(7, () => iniziaGesto({ circuitJson: scheda, regole: REGOLE, presa }));
    const inizio = iniziaGesto({ circuitJson: scheda, regole: REGOLE, presa });
    if ("rifiuto" in inizio) throw new Error(inizio.rifiuto);
    const via = scheda.find((e) => e.pcb_via_id === "v_155") as unknown as { x: number; y: number };

    // down onto the middle stretch of its cell, which gives way: every position pushes
    const spinge = muoviGesto(inizio.gesto, { x: via.x, y: via.y - 0.7 });
    expect(spinge.blocco).toBeNull();
    expect(spinge.nascosti.pcbTraceIds).toEqual(["t_155"]);
    expect(chiudiGesto(inizio.gesto, spinge, "g")?.routes).toHaveLength(1);
    const conSpinta = mediana(200, (i) => {
      const stato = muoviGesto(inizio.gesto, { x: via.x + (i % 7) * 0.02, y: via.y - 0.45 - (i % 5) * 0.05 });
      if (stato.nascosti.pcbTraceIds.length !== 1) throw new Error("non ha spinto");
    });
    // up, where nothing is in its way: the cost of a step with no push
    const libero = mediana(200, (i) => {
      const stato = muoviGesto(inizio.gesto, { x: via.x + (i % 7) * 0.02, y: via.y + 0.05 + (i % 5) * 0.02 });
      if (stato.blocco || stato.nascosti.pcbTraceIds.length !== 0) throw new Error("non era libero");
    });

    // a chain: eight traces pushed by one via
    const fitta = schedaFitta({ quante: 8 });
    const catena = iniziaGesto({ circuitJson: fitta.scheda, regole: REGOLE, presa: { tipo: "via", pcbViaId: "v_su" } });
    if ("rifiuto" in catena) throw new Error(catena.rifiuto);
    expect(muoviGesto(catena.gesto, { x: 0, y: 1.6 }).nascosti.pcbTraceIds).toHaveLength(8);
    const inCatena = mediana(100, (i) => {
      const stato = muoviGesto(catena.gesto, { x: (i % 5) * 0.03, y: 1.6 - (i % 4) * 0.03 });
      if (stato.nascosti.pcbTraceIds.length !== 8) throw new Error("la catena non e' di otto");
    });

    expect(modello).toBeLessThan(250);
    expect(inizia).toBeLessThan(250);
    expect(conSpinta).toBeLessThan(40);
    expect(libero).toBeLessThan(40);
    expect(inCatena).toBeLessThan(40);
    // the push does not make a free step a matter of milliseconds
    expect(libero).toBeLessThan(5);
  });
});
