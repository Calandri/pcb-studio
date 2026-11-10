import { describe, expect, it } from "vitest";
import { baseHolds, boardBaseOf } from "@/lib/board-base";
import { planFastUpdate } from "@/lib/fast-update";
import { boardFreshness, nextBoardBase, parseManualEdits, serializeManualEdits, withoutManualEdits } from "@/lib/manual-edits";
import { filesHash } from "@/lib/project-store";

type El = Record<string, unknown>;
type Placement = { selector: string; center: { x: number; y: number }; rotation?: number; layer?: "top" | "bottom" };

const part = (n: number, name: string, x: number): El[] => [
  { type: "source_component", source_component_id: `sc${n}`, name },
  {
    type: "pcb_component",
    pcb_component_id: `pc${n}`,
    source_component_id: `sc${n}`,
    center: { x, y: 0 },
    display_offset_x: x,
    display_offset_y: 0,
    rotation: 0,
    width: 1,
    height: 0.5,
    layer: "top",
  },
  { type: "pcb_smtpad", pcb_smtpad_id: `pad${n}`, pcb_component_id: `pc${n}`, shape: "rect", x, y: 0, width: 0.5, height: 0.5, layer: "top" },
];

/** two parts as the code places them: R1 at x 0, C1 at x 5 */
const board = (): El[] => [
  { type: "pcb_board", pcb_board_id: "b", center: { x: 0, y: 0 }, width: 40, height: 30 },
  ...part(1, "R1", 0),
  ...part(2, "C1", 5),
];

const editsFile = (placements: Placement[], extra: Record<string, unknown> = {}) =>
  serializeManualEdits({ ...parseManualEdits("{}"), pcb_placements: placements, ...extra });

/** the files of the project, library included (none here) */
const files = (edits: string, main = "export default () => <board />") => ({ "main.tsx": main, "manual-edits.json": edits });

const centerOf = (cj: unknown[], id: string) => (cj as El[]).find((e) => e.pcb_component_id === id && e.type === "pcb_component")!.center as { x: number; y: number };

describe("la base della scheda salvata", () => {
  it("non cambia con le posizioni a mano, cambia col codice e con lo schematico", () => {
    const a = boardBaseOf(files(editsFile([{ selector: "R1", center: { x: 1, y: 0 } }])));
    const moved = boardBaseOf(files(editsFile([{ selector: "R1", center: { x: 9, y: 3 }, rotation: 90 }])));
    expect(moved.key).toBe(a.key);
    // il pezzo, e a parte la rotazione che ora porta a mano
    expect(moved.placed).toEqual(["R1", "R1#rot"]);
    expect(a.placed).toEqual(["R1"]);
    const code = boardBaseOf(files(editsFile([{ selector: "R1", center: { x: 1, y: 0 } }]), "export default () => null"));
    expect(code.key).not.toBe(a.key);
    const sch = boardBaseOf(
      files(editsFile([{ selector: "R1", center: { x: 1, y: 0 } }], { schematic_placements: [{ selector: "R1", center: { x: 2, y: 2 } }] })),
    );
    expect(sch.key).not.toBe(a.key);
  });

  it("regge quando si aggiungono pezzi tenuti a mano, non quando uno viene lasciato andare", () => {
    const saved = boardBaseOf(files(editsFile([{ selector: "R1", center: { x: 1, y: 0 } }])));
    const more = boardBaseOf(files(editsFile([{ selector: "R1", center: { x: 1, y: 0 } }, { selector: "C1", center: { x: 6, y: 0 } }])));
    expect(baseHolds(saved, more)).toEqual({ ok: true });
    const fewer = boardBaseOf(files(editsFile([])));
    expect(baseHolds(saved, fewer)).toEqual({ ok: false, why: "liberati", released: ["R1"] });
    expect(baseHolds(null, more)).toMatchObject({ ok: false, why: "nessuna base" });
  });
});

describe("aggiornamento veloce della scheda dopo uno spostamento", () => {
  it("due pezzi lasciati a un secondo di distanza: il secondo aggiornamento passa (sbb-dl-principale, 2026-11-10)", () => {
    // la scheda compilata dai file senza spostamenti
    const f0 = files(editsFile([]));
    const h0 = filesHash(f0);
    const sources = filesHash(withoutManualEdits(f0));
    const saved0 = { filesHash: h0, base: boardBaseOf(f0), circuitJson: board() };

    // 1. lascio R1: la scrittura annota nel file la scheda salvata in quel momento (la catena di prima)
    const chain1 = nextBoardBase({ cacheFilesHash: h0, filesHashBefore: h0, sourcesHash: sources, previous: undefined });
    const f1 = files(editsFile([{ selector: "R1", center: { x: 1, y: 0 } }], { board_base: chain1 }));

    // 2. il primo aggiornamento legge i file con R1 e lavora
    const plan1 = planFastUpdate(saved0, f1, f1);
    expect(plan1.kind).toBe("save");
    if (plan1.kind !== "save") return;

    // 3. intanto lascio C1: la scheda salvata e' ancora quella di prima, la catena resta su h0
    const chain2 = nextBoardBase({ cacheFilesHash: h0, filesHashBefore: filesHash(f1), sourcesHash: sources, previous: chain1 });
    expect(chain2).toEqual(chain1);
    const f2 = files(
      editsFile([{ selector: "R1", center: { x: 1, y: 0 } }, { selector: "C1", center: { x: 7, y: 0 } }], { board_base: chain2 }),
    );

    // 4. il primo aggiornamento salva la sua scheda sotto l'hash dei file che aveva letto
    const saved1 = { filesHash: plan1.hash, base: plan1.base, circuitJson: plan1.board as unknown[] };
    expect(saved1.filesHash).toBe(filesHash(f1));

    // la catena di prima qui rifiutava: la scheda salvata non e' piu' quella annotata nel file
    expect(
      boardFreshness({ cacheFilesHash: saved1.filesHash, filesHash: filesHash(f2), sourcesHash: sources, edits: parseManualEdits(f2["manual-edits.json"]) }),
    ).toBe(false);

    // 5. il secondo aggiornamento: la scheda dice da se' di che file e', e C1 va al suo posto
    const plan2 = planFastUpdate(saved1, f2, f2);
    expect(plan2.kind).toBe("save");
    if (plan2.kind !== "save") return;
    expect(plan2.hash).toBe(filesHash(f2));
    expect(centerOf(plan2.board, "pc1").x).toBeCloseTo(1, 9);
    expect(centerOf(plan2.board, "pc2").x).toBeCloseTo(7, 9);
  });

  it("niente da spostare su una scheda che e' gia' quella dei file: va bene cosi', non e' un errore", () => {
    const f = files(editsFile([{ selector: "R1", center: { x: 0, y: 0 } }]));
    const plan = planFastUpdate({ filesHash: filesHash(f), base: boardBaseOf(f), circuitJson: board() }, f, f);
    expect(plan.kind).toBe("unchanged");
    if (plan.kind === "unchanged") expect(plan.result.ok).toBe(true);
  });

  it("niente da spostare ma la scheda e' archiviata sotto un hash vecchio: passa sotto quello nuovo, cosi' com'e'", () => {
    const f0 = files(editsFile([]));
    // "fissa": R1 scritto dov'e' gia'
    const f1 = files(editsFile([{ selector: "R1", center: { x: 0, y: 0 } }]));
    const b = board();
    const plan = planFastUpdate({ filesHash: filesHash(f0), base: boardBaseOf(f0), circuitJson: b }, f1, f1);
    expect(plan).toMatchObject({ kind: "save", unchanged: true, hash: filesHash(f1) });
    if (plan.kind === "save") expect(plan.board).toBe(b);
  });

  it("una scheda compilata con posizioni vecchie prende quelle di adesso", () => {
    // un Aggiorna partito con R1 a x 1, finito dopo che R1 e' andato a x 3
    const fStart = files(editsFile([{ selector: "R1", center: { x: 1, y: 0 } }]));
    const compiled = board();
    const r1 = compiled.find((e) => e.pcb_component_id === "pc1" && e.type === "pcb_component")!;
    r1.center = { x: 1, y: 0 };
    r1.display_offset_x = 1;
    const fNow = files(editsFile([{ selector: "R1", center: { x: 3, y: 0 } }]));
    const plan = planFastUpdate({ filesHash: filesHash(fStart), base: boardBaseOf(fStart), circuitJson: compiled }, fNow, fNow);
    expect(plan.kind).toBe("save");
    if (plan.kind === "save") expect(centerOf(plan.board, "pc1").x).toBeCloseTo(3, 9);
  });

  it("il codice e' cambiato: serve la compilazione, e lo dice", () => {
    const f0 = files(editsFile([]));
    const f1 = files(editsFile([{ selector: "R1", center: { x: 1, y: 0 } }]), "export default () => null");
    const plan = planFastUpdate({ filesHash: filesHash(f0), base: boardBaseOf(f0), circuitJson: board() }, f1, f1);
    expect(plan.kind).toBe("compile");
    if (plan.kind === "compile") expect(plan.reason).toMatch(/codice/);
  });

  it("un pezzo lasciato andare torna dove lo mette il codice solo con la compilazione", () => {
    const f0 = files(editsFile([{ selector: "R1", center: { x: 1, y: 0 } }, { selector: "C1", center: { x: 7, y: 0 } }]));
    const f1 = files(editsFile([{ selector: "C1", center: { x: 7, y: 0 } }]));
    const plan = planFastUpdate({ filesHash: filesHash(f0), base: boardBaseOf(f0), circuitJson: board() }, f1, f1);
    expect(plan.kind).toBe("compile");
    if (plan.kind === "compile") expect(plan.reason).toMatch(/R1/);
  });

  it("un pezzo passato sull'altra faccia non si fa qui", () => {
    const f0 = files(editsFile([]));
    const f1 = files(editsFile([{ selector: "R1", center: { x: 1, y: 0 }, layer: "bottom" }]));
    const plan = planFastUpdate({ filesHash: filesHash(f0), base: boardBaseOf(f0), circuitJson: board() }, f1, f1);
    expect(plan.kind).toBe("compile");
  });

  it("l'ultima pista a mano tolta dal file esce anche dalla scheda", () => {
    const f0 = files(editsFile([]));
    // la scheda porta ancora il rame di una pista a mano che il file non descrive piu'
    const withTrace = [
      ...board(),
      { type: "pcb_trace", pcb_trace_id: "pcb_trace_manual_1", manual: true, manual_route_id: "k", route: [] },
      { type: "pcb_via", pcb_via_id: "pcb_via_manual_1", manual: true, x: 0, y: 0 },
    ];
    // archiviata sotto l'hash di prima: e' quella che resta dopo un Cmd+Z sulla pista
    const plan = planFastUpdate({ filesHash: "prima", base: boardBaseOf(f0), circuitJson: withTrace }, f0, f0);
    expect(plan.kind).toBe("save");
    if (plan.kind !== "save") return;
    expect(plan.unchanged).toBe(false);
    expect(plan.board.some((e) => e.type === "pcb_trace" || e.type === "pcb_via")).toBe(false);
    // e anche quando l'hash e' gia' quello dei file: non e' "niente da fare"
    const esatta = planFastUpdate({ filesHash: filesHash(f0), base: boardBaseOf(f0), circuitJson: withTrace }, f0, f0);
    expect(esatta.kind).toBe("save");
  });

  it("una rotazione a mano tolta (Cmd+Z) torna quella del codice solo con la compilazione", () => {
    const f0 = files(editsFile([{ selector: "R1", center: { x: 1, y: 0 }, rotation: 90 }]));
    const turned = board();
    const r1 = turned.find((e) => e.pcb_component_id === "pc1" && e.type === "pcb_component")!;
    r1.center = { x: 1, y: 0 };
    r1.display_offset_x = 1;
    r1.rotation = 90;
    // il file ora tiene R1 a mano senza rotazione: vale quella del codice
    const f1 = files(editsFile([{ selector: "R1", center: { x: 1, y: 0 } }]));
    const plan = planFastUpdate({ filesHash: filesHash(f0), base: boardBaseOf(f0), circuitJson: turned }, f1, f1);
    expect(plan.kind).toBe("compile");
    if (plan.kind === "compile") expect(plan.reason).toMatch(/R1/);
    // una scheda salvata quando la base portava solo i nomi regge ancora
    expect(baseHolds({ key: boardBaseOf(f0).key, placed: ["R1"] }, boardBaseOf(f0))).toEqual({ ok: true });
  });

  it("una scheda senza base non viene riarchiviata cosi' com'e': chiede la compilazione, come prima", () => {
    const f0 = files(editsFile([{ selector: "R1", center: { x: 0, y: 0 } }, { selector: "C1", center: { x: 7, y: 0 } }]));
    const h0 = filesHash(f0);
    const chain = nextBoardBase({ cacheFilesHash: h0, filesHashBefore: h0, sourcesHash: filesHash(withoutManualEdits(f0)), previous: undefined });
    // C1 liberato col token: la catena non lo vede, e sulla scheda non c'e' niente da spostare
    const f1 = files(editsFile([{ selector: "R1", center: { x: 0, y: 0 } }], { board_base: chain }));
    expect(planFastUpdate({ filesHash: h0, base: null, circuitJson: board() }, f1, f1).kind).toBe("compile");
  });

  it("una scheda salvata prima che esistesse la base vale ancora con la catena nel file", () => {
    const f0 = files(editsFile([]));
    const h0 = filesHash(f0);
    const chain = nextBoardBase({ cacheFilesHash: h0, filesHashBefore: h0, sourcesHash: filesHash(withoutManualEdits(f0)), previous: undefined });
    const f1 = files(editsFile([{ selector: "R1", center: { x: 1, y: 0 } }], { board_base: chain }));
    expect(planFastUpdate({ filesHash: h0, base: null, circuitJson: board() }, f1, f1).kind).toBe("save");
    // senza catena e senza base non si sa di che file sia: compilazione
    const f2 = files(editsFile([{ selector: "R1", center: { x: 1, y: 0 } }]));
    expect(planFastUpdate({ filesHash: h0, base: null, circuitJson: board() }, f2, f2).kind).toBe("compile");
  });
});
