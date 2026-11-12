import { describe, expect, it } from "vitest";
import { apertiDellaSchedaCheEsce } from "@/lib/aperti-export";
import { nonCertificata } from "@/lib/engine-version";
import { pezzo, rete, scheda, trace, wire, type El } from "./scheda-di-prova";

/*
 * "Blocco" (Niccolo', 2026-11-12): a board with open connections is not
 * exported, and the refusal says how many, on how many nets and which pads are
 * left out. The count comes from the copper (open-connections.ts), here it is
 * only put in words.
 *
 * The board: three resistors in a row, one pin each on the net SDA, at x 0, 5
 * and 12.
 */
const board = scheda();
const treInFila: El[] = [
  board,
  ...pezzo("R1", [["1", 0, 0]]),
  ...pezzo("R2", [["1", 5, 0]]),
  ...pezzo("R3", [["1", 12, 0]]),
  ...rete(1, "SDA", ["R1_1", "R2_1", "R3_1"]),
];

describe("what the export says about a board with open connections", () => {
  it("a net all joined: nothing to say, nothing to refuse", () => {
    const unita = [...treInFila, trace("t1", "st_SDA_0", [wire(0, 0), wire(5, 0), wire(12, 0)])];
    expect(apertiDellaSchedaCheEsce(unita)).toBeNull();
    expect(nonCertificata({ openConnections: apertiDellaSchedaCheEsce(unita) })).toBeNull();
  });

  it("one pad left out: one connection, one net, the pad by part and pin", () => {
    // R1 and R2 joined by the trace, R3 alone
    const aperta = [...treInFila, trace("t1", "st_SDA_0", [wire(0, 0), wire(5, 0)])];
    expect(apertiDellaSchedaCheEsce(aperta)).toEqual({ count: 1, reti: 1, detail: "1 collegamento aperto su 1 rete: SDA (R3.1)" });
  });

  it("three islands of one net are two connections, not three, on one net", () => {
    const a = apertiDellaSchedaCheEsce(treInFila)!;
    expect(a.count).toBe(2);
    expect(a.reti).toBe(1);
    expect(a.detail).toMatch(/^2 collegamenti aperti su 1 rete: SDA \(R[123]\.1, R[123]\.1\)$/);
  });

  it("many nets: four by name, in a fixed order, then how many more", () => {
    // six nets, each with two pads and no copper: one open connection each; with as many each, by name
    const nomi = ["F", "A", "E", "B", "D", "C"];
    const sei: El[] = [
      board,
      ...nomi.flatMap((n, i) => [...pezzo(`R${n}`, [["1", i * 10, 0]]), ...pezzo(`C${n}`, [["1", i * 10, 6]]), ...rete(i + 1, n, [`R${n}_1`, `C${n}_1`])]),
    ];
    const a = apertiDellaSchedaCheEsce(sei)!;
    expect(a.count).toBe(6);
    expect(a.reti).toBe(6);
    expect(a.detail).toMatch(/^6 collegamenti aperti su 6 reti: A \([RC]A\.1\), B \([RC]B\.1\), C \([RC]C\.1\), D \([RC]D\.1\) e altre 2 reti$/);
  });

  it("the refusal names them and says what to do", () => {
    const aperta = [...treInFila, trace("t1", "st_SDA_0", [wire(0, 0), wire(5, 0)])];
    expect(nonCertificata({ openConnections: apertiDellaSchedaCheEsce(aperta) })).toBe(
      "1 collegamento aperto su 1 rete: SDA (R3.1). La scheda NON e' certificata per l'export finche' ha collegamenti aperti: " +
        'chiudili (nel visore la vista "Collegamenti mancanti" li mostra) e riprova',
    );
  });

  it("a board that cannot be read is not 'nothing open': it is not measured, and it is refused", () => {
    const a = apertiDellaSchedaCheEsce(null as never)!;
    expect(a.count).toBe(0);
    expect(a.detail).toMatch(/^i collegamenti aperti di questa scheda non si sono potuti misurare \(/);
    expect(nonCertificata({ openConnections: a })).toMatch(/non si sono potuti misurare .* NON e' certificata per l'export/);
  });
});
