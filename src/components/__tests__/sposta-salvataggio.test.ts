import { describe, expect, it } from "vitest";
import type { EditEvent, PlacementPatch } from "@/lib/manual-edits";
import { boardPartsByName, patchesFromEvents, placementOnBoard } from "../workspace/placement-patches";
import { boardAgrees, settledMoves, withPlacements } from "../workspace/useManualEditor";

/*
 * tm-4l-r3, 2026-11-09: in Sposta a dropped part took seconds to save (every
 * save read the 3,8 MB board, rewrote the 326 KB file and sent it back, then
 * moved the board and downloaded it again), and in the meantime parts jumped
 * back and moves landed on top of each other. A drop is now saved as the
 * absolute place the person let go of the part, and a board that arrives only
 * takes away the overrides it already shows.
 */

const BOARD = [
  { type: "source_component", source_component_id: "s1", name: "C1" },
  { type: "source_component", source_component_id: "s2", name: "U1" },
  { type: "source_component", source_component_id: "s3", name: "R9" },
  // the origin is 0,3 mm off the copper centre, like an off-centre footprint
  { type: "pcb_component", pcb_component_id: "pc1", source_component_id: "s1", center: { x: 10, y: 5 }, display_offset_x: 10.3, display_offset_y: 5, rotation: 0, layer: "top" },
  { type: "pcb_component", pcb_component_id: "pc2", source_component_id: "s2", center: { x: -4, y: 2 }, display_offset_x: "-4mm", display_offset_y: "2mm", rotation: 90, layer: "top" },
  // no origin on this board: it cannot be read here and goes the old way
  { type: "pcb_component", pcb_component_id: "pc3", source_component_id: "s3", center: { x: 1, y: 1 }, rotation: 0, layer: "bottom" },
];

const move = (name: string, from: { x: number; y: number }, to: { x: number; y: number }, extra: Partial<EditEvent> = {}): EditEvent =>
  ({ edit_event_type: "edit_pcb_component_location", component_name: name, original_center: from, new_center: to, ...extra }) as EditEvent;

describe("uno spostamento si salva come posto assoluto, letto sulla scheda a schermo", () => {
  const parts = boardPartsByName(BOARD);

  it("l'origine della scheda piu' lo spostamento, qualunque sia la distanza fra origine e centro", () => {
    const { placements, rest } = patchesFromEvents([move("C1", { x: 10, y: 5 }, { x: 12.5, y: 4 })], parts);
    expect(rest).toHaveLength(0);
    expect(placements).toEqual([{ name: "C1", x: 12.8, y: 4 }]);
  });

  it("piu' gesti sullo stesso pezzo: l'ultima posizione, e la rotazione dichiarata prima resta", () => {
    const { placements } = patchesFromEvents(
      [
        move("U1", { x: -4, y: 2 }, { x: -4, y: 2 }, { new_rotation: 180 }),
        move("U1", { x: -4, y: 2 }, { x: -3, y: 2 }),
        move("U1", { x: -3, y: 2 }, { x: -2, y: 1 }, { new_layer: "bottom" }),
      ],
      parts,
    );
    expect(placements).toEqual([{ name: "U1", x: -2, y: 1, rotation: 180, layer: "bottom" }]);
  });

  it("un pezzo senza origine sulla scheda, o uno schematico, resta un evento per il server", () => {
    const sch = { edit_event_type: "edit_schematic_component_location", component_name: "C1", original_center: { x: 0, y: 0 }, new_center: { x: 1, y: 1 } } as EditEvent;
    const r9 = move("R9", { x: 1, y: 1 }, { x: 2, y: 1 });
    const { placements, rest } = patchesFromEvents([r9, sch], parts);
    expect(placements).toHaveLength(0);
    expect(rest).toEqual([r9, sch]);
  });

  it("la scheda mostra il posto salvato: al millesimo, rotazione e faccia solo se dichiarate", () => {
    const patch: PlacementPatch = { name: "C1", x: 10.3, y: 5 };
    expect(boardAgrees(placementOnBoard(parts, "C1"), patch)).toBe(true);
    expect(boardAgrees(placementOnBoard(parts, "C1"), { ...patch, x: 10.31 })).toBe(false);
    expect(boardAgrees(placementOnBoard(parts, "C1"), { ...patch, rotation: 90 })).toBe(false);
    expect(boardAgrees(placementOnBoard(parts, "U1"), { name: "U1", x: -4, y: 2, rotation: 450 })).toBe(true);
    expect(boardAgrees(placementOnBoard(parts, "R9"), { name: "R9", x: 1, y: 1 })).toBe(false);
  });
});

describe("una scheda che arriva toglie solo le sovrapposizioni che mostra gia'", () => {
  const parts = boardPartsByName(BOARD);
  const boardOf = (name: string) => placementOnBoard(parts, name);

  it("scritto e mostrato: va; scritto ma la scheda e' vecchia: resta", () => {
    const a = move("C1", { x: 10, y: 5 }, { x: 10, y: 5 });
    const b = move("U1", { x: -4, y: 2 }, { x: 0, y: 0 });
    const written = new WeakMap<EditEvent, PlacementPatch | null>([
      [a, { name: "C1", x: 10.3, y: 5 }],
      [b, { name: "U1", x: 0, y: 0 }],
    ]);
    const gone = settledMoves([a, b], () => true, written, boardOf);
    expect([...gone]).toEqual([a]);
  });

  it("un pezzo con un gesto ancora in viaggio o da mandare tiene tutto: la scheda della mossa prima non lo riporta indietro", () => {
    const a = move("C1", { x: 10, y: 5 }, { x: 10, y: 5 });
    const inViaggio = move("C1", { x: 10, y: 5 }, { x: 14, y: 5 });
    const written = new WeakMap<EditEvent, PlacementPatch | null>([[a, { name: "C1", x: 10.3, y: 5 }]]);
    // a is shown by the board, but the later move is sent and not written yet
    expect(settledMoves([a, inViaggio], () => true, written, boardOf).size).toBe(0);
    // or not even sent
    expect(settledMoves([a, inViaggio], (e) => e === a, written, boardOf).size).toBe(0);
  });

  it("decide l'ultimo gesto scritto del pezzo, e i gesti scritti alla vecchia maniera vanno appena scritti", () => {
    const vecchio = move("C1", { x: 10, y: 5 }, { x: 10, y: 5 });
    const nuovo = move("C1", { x: 10, y: 5 }, { x: 11, y: 5 });
    const written = new WeakMap<EditEvent, PlacementPatch | null>([
      [vecchio, { name: "C1", x: 10.3, y: 5 }],
      [nuovo, { name: "C1", x: 11.3, y: 5 }],
    ]);
    // the board shows the OLD position: the newer move keeps both
    expect(settledMoves([vecchio, nuovo], () => true, written, boardOf).size).toBe(0);
    const r9 = move("R9", { x: 1, y: 1 }, { x: 2, y: 1 });
    expect([...settledMoves([r9], () => true, new WeakMap([[r9, null]]), boardOf)]).toEqual([r9]);
  });

  it("la copia del file nella pagina prende le posizioni scritte senza perdere le altre", () => {
    const edits = {
      schematic_placements: [],
      manual_trace_hints: [],
      pcb_routes: [],
      pcb_placements: [
        { selector: "C1", center: { x: 1, y: 1 } },
        { selector: "C2", center: { x: 2, y: 2 } },
      ],
    };
    const next = withPlacements(edits, [{ selector: "C1", center: { x: 5, y: 5 }, rotation: 90 }]);
    expect(next.pcb_placements).toEqual([
      { selector: "C2", center: { x: 2, y: 2 } },
      { selector: "C1", center: { x: 5, y: 5 }, rotation: 90 },
    ]);
  });
});
