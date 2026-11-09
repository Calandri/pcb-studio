import { describe, expect, it } from "vitest";
import { applyPlacementPatches, applyRoutePatch, emptyManualEdits, type EditEvent } from "@/lib/manual-edits";
import type { ManualRoute } from "@/lib/manual-routes";
import {
  HISTORY_MAX,
  partStates,
  placeRequest,
  routesRequest,
  withPartStates,
  withRoutes,
} from "../workspace/manual-history";

/*
 * tm-4l-r3, 2026-11-10: "Cmd+Z non mi fa piu' tornare indietro". Undo read the
 * whole file back and sent it back whole (326 KB), then waited for the board;
 * a Cmd+Z pressed meanwhile was dropped, a detached trace could not be undone,
 * and on a board older than the files the keys did nothing at all. Every step
 * now says what it changed, and undo writes back only that.
 */

const move = (name: string, from: { x: number; y: number }, to: { x: number; y: number }, extra: Partial<EditEvent> = {}): EditEvent =>
  ({ edit_event_type: "edit_pcb_component_location", component_name: name, original_center: from, new_center: to, original_rotation: 0, original_layer: "top", ...extra }) as EditEvent;

const route = (from: string, to: string, y = 0): ManualRoute => ({
  connection: `${from} to ${to}`,
  from,
  to,
  width: 0.2,
  points: [
    { x: 0, y, layer: "top" },
    { x: 1, y, layer: "top" },
  ],
});

describe("un passo di pezzi sa com'erano prima e come sono dopo", () => {
  it("prima: dove il primo gesto e' partito e la posizione che c'era nel file; dopo: l'ultimo gesto e quella scritta", () => {
    const batch = [
      move("C1", { x: 10, y: 5 }, { x: 11, y: 5 }),
      move("C1", { x: 11, y: 5 }, { x: 11, y: 5 }, { new_rotation: 90 }),
      move("U1", { x: 0, y: 0 }, { x: 1, y: 1 }, { original_rotation: 180, original_layer: "bottom", new_layer: "top" }),
    ];
    const { before, after } = partStates(
      batch,
      ["C1", "U1"],
      [
        { selector: "C1", placement: { selector: "C1", center: { x: 10.3, y: 5 } } },
        { selector: "U1", placement: null },
      ],
      [
        { selector: "C1", center: { x: 11.3, y: 5 }, rotation: 90 },
        { selector: "U1", center: { x: 1, y: 1 }, layer: "top" },
      ],
    );
    expect(before).toEqual([
      { selector: "C1", placement: { selector: "C1", center: { x: 10.3, y: 5 } }, center: { x: 10, y: 5 }, rotation: 0, layer: "top" },
      { selector: "U1", placement: null, center: { x: 0, y: 0 }, rotation: 180, layer: "bottom" },
    ]);
    expect(after.map((a) => [a.selector, a.center, a.rotation, a.layer])).toEqual([
      ["C1", { x: 11, y: 5 }, 90, "top"],
      ["U1", { x: 1, y: 1 }, 180, "top"],
    ]);
  });

  it("annullare scrive la posizione di prima esatta, e toglie quella dei pezzi che prima non l'avevano", () => {
    const req = placeRequest([
      { selector: "C1", placement: { selector: "C1", center: { x: 10.3, y: 5 } }, center: { x: 10, y: 5 }, rotation: 0, layer: "top" },
      { selector: "U1", placement: null, center: { x: 0, y: 0 }, rotation: 180, layer: "bottom" },
    ]);
    expect(req).toEqual({ placements: [{ name: "C1", x: 10.3, y: 5, exact: true }], remove: ["U1"] });

    const file = {
      ...emptyManualEdits(),
      pcb_placements: [
        { selector: "C1", center: { x: 11.3, y: 5 }, rotation: 90 },
        { selector: "U1", center: { x: 1, y: 1 }, layer: "top" as const },
        { selector: "R7", center: { x: 3, y: 3 } },
      ],
    };
    const { edits, before } = applyPlacementPatches(file, req.placements, req.remove);
    // the turn of the undone move does not survive: the placement is exactly the old one
    expect(edits.pcb_placements).toEqual([
      { selector: "R7", center: { x: 3, y: 3 } },
      { selector: "C1", center: { x: 10.3, y: 5 } },
    ]);
    expect(before.map((b) => b.selector)).toEqual(["U1", "C1"]);
    expect(withPartStates(file, [{ selector: "U1", placement: null, center: { x: 0, y: 0 }, rotation: 0, layer: "top" }]).pcb_placements.map((p) => p.selector)).toEqual(["C1", "R7"]);
  });

  it("la storia tiene almeno 50 passi", () => {
    expect(HISTORY_MAX).toBeGreaterThanOrEqual(50);
  });
});

describe("le piste si scrivono e si annullano per chiave", () => {
  it("Applica aggiunge e dice cosa ha sostituito; annullare toglie le nuove e rimette le vecchie", () => {
    const vecchia = route(".R1 > .pin1", ".C1 > .pin2", 0);
    const altra = route(".R2 > .pin1", ".C2 > .pin2", 5);
    const file = { ...emptyManualEdits(), pcb_routes: [vecchia, altra] };
    const ridisegnata = route(".R1 > .pin1", ".C1 > .pin2", 2);
    const nuova = route(".R3 > .pin1", ".C3 > .pin2", 9);
    const r = applyRoutePatch(file, [ridisegnata, nuova], []);
    expect(r.replaced).toEqual([vecchia]);
    expect(r.edits.pcb_routes).toEqual([altra, ridisegnata, nuova]);

    const undo = routesRequest({ before: r.replaced, after: r.added }, "undo");
    const back = applyRoutePatch(r.edits, undo.add, undo.remove);
    expect(back.edits.pcb_routes).toEqual([altra, vecchia]);
    // and the page's copy follows the same way
    expect(withRoutes(r.edits, undo.add, undo.remove).pcb_routes).toEqual([altra, vecchia]);
    const redo = routesRequest({ before: r.replaced, after: r.added }, "redo");
    expect(applyRoutePatch(back.edits, redo.add, redo.remove).edits.pcb_routes).toEqual([altra, ridisegnata, nuova]);
  });
});
