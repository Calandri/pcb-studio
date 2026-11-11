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

/*
 * sbb-dl-principale, 2026-11-11: the saved board had 32 vias written on the two
 * layers their trace joins. The fast update saves a board too, and no board is
 * saved with such a via.
 */
describe("the fast update leaves only through vias on the board it saves", () => {
  const quattro = ["top", "inner1", "inner2", "bottom"];
  const board4 = (): El[] => [
    { type: "pcb_board", pcb_board_id: "b", center: { x: 0, y: 0 }, width: 40, height: 30, num_layers: 4 },
    ...part(1, "R1", 0),
    ...part(2, "C1", 5),
    { type: "pcb_via", pcb_via_id: "pcb_via_7", pcb_trace_id: "t", x: 3, y: 3, outer_diameter: 0.5, hole_diameter: 0.2, layers: ["inner2", "bottom"], from_layer: "inner2", to_layer: "bottom" },
    { type: "pcb_via", pcb_via_id: "pcb_via_8", pcb_trace_id: "t", x: 4, y: 3, outer_diameter: 0.5, hole_diameter: 0.2, layers: quattro, from_layer: "top", to_layer: "bottom" },
  ];
  const viaOf = (cj: unknown[], id: string) => (cj as El[]).find((e) => e.pcb_via_id === id)!;

  it("a part moved: the board that is saved has the via on every layer, and still says which two its trace joins", () => {
    const f0 = files(editsFile([]));
    const saved = { filesHash: filesHash(f0), base: boardBaseOf(f0), circuitJson: board4() };
    const f1 = files(editsFile([{ selector: "R1", center: { x: 1, y: 0 } }]));
    const plan = planFastUpdate(saved, f1, f1);
    expect(plan.kind).toBe("save");
    if (plan.kind !== "save") return;
    expect(centerOf(plan.board, "pc1").x).toBeCloseTo(1, 9);
    expect(viaOf(plan.board, "pcb_via_7")).toMatchObject({ layers: quattro, from_layer: "inner2", to_layer: "bottom", declared_layers: ["inner2", "bottom"] });
    expect(viaOf(plan.board, "pcb_via_8").layers).toEqual(quattro);
  });

  it("nothing to move: a via to complete is not a change by itself, but the board filed again goes with it completed", () => {
    // the board is exactly the one of these files: nothing is written, as before
    const f = files(editsFile([{ selector: "R1", center: { x: 0, y: 0 } }]));
    const b = board4();
    expect(planFastUpdate({ filesHash: filesHash(f), base: boardBaseOf(f), circuitJson: b }, f, f).kind).toBe("unchanged");

    // filed under an older hash: it is saved under the new one, and what is saved has only through vias
    const f0 = files(editsFile([]));
    const plan = planFastUpdate({ filesHash: filesHash(f0), base: boardBaseOf(f0), circuitJson: b }, f, f);
    expect(plan).toMatchObject({ kind: "save", unchanged: true, hash: filesHash(f) });
    if (plan.kind !== "save") return;
    expect(viaOf(plan.board, "pcb_via_7")).toMatchObject({ layers: quattro, from_layer: "inner2", to_layer: "bottom" });
    expect(centerOf(plan.board, "pc1").x).toBe(0);
    // the saved board is not touched, and one with nothing to complete goes through as the same array
    expect(viaOf(b, "pcb_via_7").layers).toEqual(["inner2", "bottom"]);
    const again = planFastUpdate({ filesHash: filesHash(f0), base: boardBaseOf(f0), circuitJson: plan.board }, f, f);
    if (again.kind === "save") expect(again.board).toBe(plan.board);
    expect(again.kind).toBe("save");
  });

  it("a board from before the base existed, with a part let go, still asks for the compile: a via to complete does not make it a change", () => {
    // no base on the row: the chain in the file vouches for it, and cannot see a part let go
    const f0 = files(editsFile([]));
    const chain = nextBoardBase({ cacheFilesHash: filesHash(f0), filesHashBefore: filesHash(f0), sourcesHash: filesHash(withoutManualEdits(f0)), previous: undefined });
    const f1 = files(editsFile([], { board_base: chain }));
    const plan = planFastUpdate({ filesHash: filesHash(f0), base: null, circuitJson: board4() }, f1, f1);
    expect(plan).toMatchObject({ kind: "compile", reason: "niente da applicare in locale" });
  });
});
