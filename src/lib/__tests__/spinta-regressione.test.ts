import { beforeAll, describe, expect, it } from "vitest";

/*
 * "SPINGI E SPOSTA", PHASE 2, REGRESSION: A BOARD WITH NO CORRECTION OF THE
 * FILES' COPPER IS THE BOARD OF BEFORE.
 *
 * The phase adds two kinds of hand edit (a route with `replaces`, a moved via)
 * to the one place that lays hand copper, applyManualRoutes. A board that has
 * neither must come out of the compile and of the fast update as it did: no
 * check changes its answer (CHECKS_ENGINE_VERSION is not touched).
 *
 * The copper below (RAME_DEI_FILE, RAME_CON_LE_MODIFICHE) was written down
 * from the code of BEFORE the phase (fb8ccc6), on the board of
 * spinta-misure.test.ts with the hand edits that existed then: a part moved, a
 * route between two pins that replaces the trace of the files (with two vias
 * of its own) and a route added as a branch of a net. It is every pcb_trace and
 * every pcb_via of the board, whole and in order. If this test fails, the
 * copper of a board without corrections changed: that is the thing to look
 * at, not the numbers below.
 *
 * The rest of the board is not written down (tscircuit numbers its warnings
 * at random, and it is megabytes on a real board): it is shown untouched by
 * identity, element by element, through the function that lays the copper.
 */
import { boardBaseOf } from "@/lib/board-base";
import { compileProject } from "@/lib/compile";
import { DESIGN_RULES_PATH } from "@/lib/design-rules";
import { planFastUpdate } from "@/lib/fast-update";
import { countManualEdits, MANUAL_EDITS_PATH, parseManualEdits, serializeManualEdits } from "@/lib/manual-edits";
import { applyManualRoutes } from "@/lib/manual-routes";
import { filesHash } from "@/lib/project-store";
import { rerouteLocal } from "@/lib/reroute-local";

type El = Record<string, unknown> & { type: string };

const REGOLE = JSON.stringify({
  preset: "custom",
  rules: { minTraceWidthMm: 0.15, minClearanceMm: 0.15, pourClearanceMm: 0.2, autoPlaneVias: false, autoroute: false },
});
const MAIN = `export default () => (
  <board width="40mm" height="24mm">
    <net name="GND" />
    <resistor name="R1" resistance="1k" footprint="0402" pcbX={-10} pcbY={0} />
    <resistor name="R2" resistance="1k" footprint="0402" pcbX={10} pcbY={0} />
    <resistor name="R3" resistance="1k" footprint="0402" pcbX={-10} pcbY={-6} />
    <trace from=".R1 > .pin2" to=".R2 > .pin1" pcbPath={[
      { x: 5, y: 0 },
      { x: 5, y: 0, via: true, fromLayer: "top", toLayer: "bottom" },
      { x: 5, y: 0 },
      { x: 15, y: 0 },
      { x: 15, y: 0, via: true, fromLayer: "bottom", toLayer: "top" },
      { x: 15, y: 0 },
    ]} thickness="0.2mm" />
    <trace from=".R1 > .pin1" to="net.GND" pcbPath={[
      { x: -2, y: 0 },
      { x: -2, y: -3 },
      { x: -2, y: -3, via: true, fromLayer: "top", toLayer: "bottom" },
      { x: -2, y: -3 },
      { x: -2, y: -5 },
    ]} thickness="0.2mm" />
    <trace from=".R3 > .pin1" to="net.GND" />
    <via name="V1" pcbX={0} pcbY={-6} connectsTo="net.GND" fromLayer="top" toLayer="bottom" />
  </board>
)
`;
const FILES: Record<string, string> = { "main.tsx": MAIN, [DESIGN_RULES_PATH]: REGOLE };
/** the hand edits of before the phase, as the file was written then: no `pcb_vias`, no `replaces` */
const MODIFICHE = `${JSON.stringify(
  {
    schematic_placements: [],
    pcb_placements: [{ selector: "R3", center: { x: -8, y: -8 } }],
    manual_trace_hints: [],
    pcb_routes: [
      {
        connection: ".R1 > .pin1 to net.GND",
        from: ".R1 > .pin1",
        to: ".R3 > .pin1",
        points: [
          { x: -10.51, y: 0, layer: "top" },
          { x: -13, y: 0, layer: "top" },
          { x: -13, y: -4, layer: "top" },
        ],
        width: 0.2,
        id: ".R1 > .pin1 ~ .R3 > .pin1",
      },
      {
        connection: ".R1 > .pin2 to .R2 > .pin1",
        from: ".R1 > .pin2",
        to: ".R2 > .pin1",
        points: [
          { x: -9.49, y: 0, layer: "top" },
          { x: -7, y: 0, layer: "top" },
          { x: -4, y: 3, layer: "top" },
          { x: -4, y: 3, layer: "bottom" },
          { x: 4, y: 3, layer: "bottom" },
          { x: 4, y: 3, layer: "top" },
          { x: 7, y: 0, layer: "top" },
          { x: 9.49, y: 0, layer: "top" },
        ],
        width: 0.2,
        id: ".R1 > .pin2 ~ .R2 > .pin1",
      },
    ],
  },
  null,
  2,
)}\n`;
const CON_LE_MODIFICHE = { ...FILES, [MANUAL_EDITS_PATH]: MODIFICHE };

/** every pcb_trace and every pcb_via of the board of the files, as the code of before the phase compiled it */
const RAME_DEI_FILE: unknown[] = [
  {"type": "pcb_via", "pcb_via_id": "pcb_via_0", "x": 0, "y": -6, "hole_diameter": 0.2, "outer_diameter": 0.3, "layers": ["top", "bottom"], "from_layer": "top", "to_layer": "bottom", "subcircuit_id": "subcircuit_source_group_0", "subcircuit_connectivity_map_key": "unnamedsubcircuitsubcircuit_source_group_0_connectivity_net1", "pcb_trace_id": "source_net_0"},
  {"type": "pcb_trace", "pcb_trace_id": "pcb_trace_0", "route": [{"route_type": "wire", "x": -9.49, "y": 0, "width": 0.2, "layer": "top", "start_pcb_port_id": "pcb_port_1"}, {"route_type": "wire", "x": -5, "y": 0, "width": 0.2, "layer": "top"}, {"route_type": "via", "x": -5, "y": 0, "from_layer": "top", "to_layer": "bottom"}, {"route_type": "wire", "x": -5, "y": 0, "width": 0.2, "layer": "bottom"}, {"route_type": "wire", "x": 5, "y": 0, "width": 0.2, "layer": "bottom"}, {"route_type": "via", "x": 5, "y": 0, "from_layer": "bottom", "to_layer": "top"}, {"route_type": "wire", "x": 5, "y": 0, "width": 0.2, "layer": "top"}, {"route_type": "wire", "x": 9.49, "y": 0, "width": 0.2, "layer": "top", "end_pcb_port_id": "pcb_port_2"}], "source_trace_id": "source_trace_0", "subcircuit_id": "subcircuit_source_group_0", "trace_length": 22.18},
  {"type": "pcb_via", "pcb_via_id": "pcb_via_1", "pcb_trace_id": "pcb_trace_0", "x": -5, "y": 0, "hole_diameter": 0.2, "outer_diameter": 0.3, "layers": ["top", "bottom"], "from_layer": "top", "to_layer": "bottom", "subcircuit_id": "subcircuit_source_group_0", "subcircuit_connectivity_map_key": "unnamedsubcircuitsubcircuit_source_group_0_connectivity_net0"},
  {"type": "pcb_via", "pcb_via_id": "pcb_via_2", "pcb_trace_id": "pcb_trace_0", "x": 5, "y": 0, "hole_diameter": 0.2, "outer_diameter": 0.3, "layers": ["bottom", "top"], "from_layer": "bottom", "to_layer": "top", "subcircuit_id": "subcircuit_source_group_0", "subcircuit_connectivity_map_key": "unnamedsubcircuitsubcircuit_source_group_0_connectivity_net0"},
  {"type": "pcb_trace", "pcb_trace_id": "pcb_trace_1", "route": [{"route_type": "wire", "x": -10.51, "y": 0, "width": 0.2, "layer": "top", "start_pcb_port_id": "pcb_port_0"}, {"route_type": "wire", "x": -12, "y": 0, "width": 0.2, "layer": "top"}, {"route_type": "wire", "x": -12, "y": -3, "width": 0.2, "layer": "top"}, {"route_type": "via", "x": -12, "y": -3, "from_layer": "top", "to_layer": "bottom"}, {"route_type": "wire", "x": -12, "y": -3, "width": 0.2, "layer": "bottom"}, {"route_type": "wire", "x": -12, "y": -5, "width": 0.2, "layer": "bottom"}], "source_trace_id": "source_trace_1", "subcircuit_id": "subcircuit_source_group_0", "trace_length": 8.09},
  {"type": "pcb_via", "pcb_via_id": "pcb_via_3", "pcb_trace_id": "pcb_trace_1", "x": -12, "y": -3, "hole_diameter": 0.2, "outer_diameter": 0.3, "layers": ["top", "bottom"], "from_layer": "top", "to_layer": "bottom", "subcircuit_id": "subcircuit_source_group_0", "subcircuit_connectivity_map_key": "unnamedsubcircuitsubcircuit_source_group_0_connectivity_net1"},
];

/** the same with the hand edits above: by a compile, by the fast update, by either of them twice */
const RAME_CON_LE_MODIFICHE: unknown[] = [
  {"type": "pcb_via", "pcb_via_id": "pcb_via_0", "x": 0, "y": -6, "hole_diameter": 0.2, "outer_diameter": 0.3, "layers": ["top", "bottom"], "from_layer": "top", "to_layer": "bottom", "subcircuit_id": "subcircuit_source_group_0", "subcircuit_connectivity_map_key": "unnamedsubcircuitsubcircuit_source_group_0_connectivity_net1", "pcb_trace_id": "source_net_0"},
  {"type": "pcb_trace", "pcb_trace_id": "pcb_trace_0", "route": [{"route_type": "wire", "x": -9.49, "y": 0, "layer": "top", "width": 0.2}, {"route_type": "wire", "x": -7, "y": 0, "layer": "top", "width": 0.2}, {"route_type": "wire", "x": -4, "y": 3, "layer": "top", "width": 0.2}, {"route_type": "via", "x": -4, "y": 3, "from_layer": "top", "to_layer": "bottom", "via_diameter": 0.6, "via_hole_diameter": 0.3}, {"route_type": "wire", "x": -4, "y": 3, "layer": "bottom", "width": 0.2}, {"route_type": "wire", "x": 4, "y": 3, "layer": "bottom", "width": 0.2}, {"route_type": "via", "x": 4, "y": 3, "from_layer": "bottom", "to_layer": "top", "via_diameter": 0.6, "via_hole_diameter": 0.3}, {"route_type": "wire", "x": 4, "y": 3, "layer": "top", "width": 0.2}, {"route_type": "wire", "x": 7, "y": 0, "layer": "top", "width": 0.2}, {"route_type": "wire", "x": 9.49, "y": 0, "layer": "top", "width": 0.2}], "source_trace_id": "source_trace_0", "subcircuit_id": "subcircuit_source_group_0", "trace_length": 22.18, "manual": true, "manual_route_id": ".R1 > .pin2 ~ .R2 > .pin1"},
  {"type": "pcb_trace", "pcb_trace_id": "pcb_trace_1", "route": [{"route_type": "wire", "x": -10.51, "y": 0, "width": 0.2, "layer": "top", "start_pcb_port_id": "pcb_port_0"}, {"route_type": "wire", "x": -12, "y": 0, "width": 0.2, "layer": "top"}, {"route_type": "wire", "x": -12, "y": -3, "width": 0.2, "layer": "top"}, {"route_type": "via", "x": -12, "y": -3, "from_layer": "top", "to_layer": "bottom"}, {"route_type": "wire", "x": -12, "y": -3, "width": 0.2, "layer": "bottom"}, {"route_type": "wire", "x": -12, "y": -5, "width": 0.2, "layer": "bottom"}], "source_trace_id": "source_trace_1", "subcircuit_id": "subcircuit_source_group_0", "trace_length": 8.09},
  {"type": "pcb_via", "pcb_via_id": "pcb_via_3", "pcb_trace_id": "pcb_trace_1", "x": -12, "y": -3, "hole_diameter": 0.2, "outer_diameter": 0.3, "layers": ["top", "bottom"], "from_layer": "top", "to_layer": "bottom", "subcircuit_id": "subcircuit_source_group_0", "subcircuit_connectivity_map_key": "unnamedsubcircuitsubcircuit_source_group_0_connectivity_net1"},
  {"type": "pcb_trace", "pcb_trace_id": "pcb_trace_manual_branch_0", "source_trace_id": "source_trace_1", "subcircuit_id": "subcircuit_source_group_0", "manual": true, "manual_route_id": ".R1 > .pin1 ~ .R3 > .pin1", "route": [{"route_type": "wire", "x": -10.51, "y": 0, "layer": "top", "width": 0.2}, {"route_type": "wire", "x": -13, "y": 0, "layer": "top", "width": 0.2}, {"route_type": "wire", "x": -13, "y": -4, "layer": "top", "width": 0.2}]},
  {"type": "pcb_via", "pcb_via_id": "pcb_via_manual_0", "manual": true, "x": -4, "y": 3, "outer_diameter": 0.6, "hole_diameter": 0.3, "layers": ["top", "bottom"], "declared_layers": ["top", "bottom"], "subcircuit_connectivity_map_key": "unnamedsubcircuitsubcircuit_source_group_0_connectivity_net0"},
  {"type": "pcb_via", "pcb_via_id": "pcb_via_manual_1", "manual": true, "x": 4, "y": 3, "outer_diameter": 0.6, "hole_diameter": 0.3, "layers": ["top", "bottom"], "declared_layers": ["bottom", "top"], "subcircuit_connectivity_map_key": "unnamedsubcircuitsubcircuit_source_group_0_connectivity_net0"},
];

const rame = (cj: unknown[]) => (cj as El[]).filter((e) => e.type === "pcb_trace" || e.type === "pcb_via");
/** what this phase writes on a board for a correction: none of it belongs on a board without one */
const SEGNI = ["replaces", "moved_from", "manual_removed"];
const coiSegni = (cj: unknown[]) => (cj as El[]).filter((e) => SEGNI.some((s) => s in e));

let deiFile: Awaited<ReturnType<typeof compileProject>>;
let compilata: Awaited<ReturnType<typeof compileProject>>;
beforeAll(async () => {
  deiFile = await compileProject(FILES);
  compilata = await compileProject(CON_LE_MODIFICHE);
}, 120_000);

describe("spinta, regressione: a board with no correction of the files' copper", () => {
  it("the compile gives the copper of before, with and without hand edits", () => {
    expect(rame(deiFile.circuitJson)).toEqual(RAME_DEI_FILE);
    expect(rame(compilata.circuitJson)).toEqual(RAME_CON_LE_MODIFICHE);
    expect(coiSegni(deiFile.circuitJson)).toEqual([]);
    expect(coiSegni(compilata.circuitJson)).toEqual([]);
    expect(compilata.summary.manualEditsOrphans).toBeUndefined();
    expect(compilata.summary.manualEdits).toEqual({ schematic: 0, pcb: 1, pcbAuto: 0, traceHints: 0, routes: 2, total: 3 });
  });

  it("the fast update gives the copper of before: from the board of the files, on its own board again, on the compiled one", () => {
    const veloce = rerouteLocal(deiFile.circuitJson, CON_LE_MODIFICHE, MODIFICHE);
    expect(veloce.result).toEqual({
      ok: true,
      moved: 1,
      rerouted: false,
      manualRoutes: 1,
      manualBranches: 1,
      drc: null,
      // the answer names the moved vias among the orphans it lists: an empty list, on a board without any
      orphans: { pcb_placements: [], schematic_placements: [], pcb_routes: [], pcb_vias: [], manual_trace_hints: [], total: 0 },
    });
    expect(rame(veloce.circuitJson!)).toEqual(RAME_CON_LE_MODIFICHE);
    const ancora = rerouteLocal(veloce.circuitJson!, CON_LE_MODIFICHE, MODIFICHE);
    expect(JSON.stringify(ancora.circuitJson)).toBe(JSON.stringify(veloce.circuitJson));
    const sullaCompilata = rerouteLocal(compilata.circuitJson, CON_LE_MODIFICHE, MODIFICHE);
    expect(JSON.stringify(sullaCompilata.circuitJson)).toBe(JSON.stringify(compilata.circuitJson));
    expect(coiSegni(veloce.circuitJson!)).toEqual([]);

    // the hand routes taken away again: the hand copper goes and the trace of the files does NOT come back (phase 0,
    // measure 2). That is today's rule for a drawn route, and only a correction with `replaces` changes it
    const soloIlPezzo = serializeManualEdits({ ...parseManualEdits(MODIFICHE), pcb_routes: [] });
    const senza = rerouteLocal(veloce.circuitJson!, { ...FILES, [MANUAL_EDITS_PATH]: soloIlPezzo }, soloIlPezzo);
    expect(rame(senza.circuitJson!)).toEqual(RAME_DEI_FILE.filter((e) => !JSON.stringify(e).includes("pcb_trace_0")));

    // and the plan of the fast update: a board to file for the edited files, nothing to do for the files alone
    const scheda = { filesHash: filesHash(FILES), base: boardBaseOf(FILES), circuitJson: deiFile.circuitJson };
    const piano = planFastUpdate(scheda, CON_LE_MODIFICHE, CON_LE_MODIFICHE);
    if (piano.kind !== "save") throw new Error(`aggiornamento veloce: ${piano.kind}`);
    expect(JSON.stringify(piano.board)).toBe(JSON.stringify(veloce.circuitJson));
    expect(planFastUpdate(scheda, FILES, FILES).kind).toBe("unchanged");
  });

  it("nothing but the copper is touched: every other element comes out of applyManualRoutes as the very object that went in", () => {
    const board = deiFile.circuitJson as El[];
    const edits = parseManualEdits(MODIFICHE);
    const posata = applyManualRoutes({ circuitJson: board, routes: edits.pcb_routes }).circuitJson as El[];
    const dentro = new Set<unknown>(board);
    const altro = posata.filter((e) => e.type !== "pcb_trace" && e.type !== "pcb_via");
    expect(altro).toHaveLength(board.length - rame(board).length);
    expect(altro.every((e) => dentro.has(e))).toBe(true);
    // the copper the hand routes do not speak of is the same objects too: the trace toward ground, its via, the lone via
    expect(rame(posata).filter((e) => dentro.has(e)).map((e) => (e.type === "pcb_via" ? e.pcb_via_id : e.pcb_trace_id))).toEqual(["pcb_via_0", "pcb_trace_1", "pcb_via_3"]);
    // and a board with no hand copper at all comes back as the same array, with or without the list of the moved vias
    expect(applyManualRoutes({ circuitJson: board, routes: [] }).circuitJson).toBe(board);
    expect(applyManualRoutes({ circuitJson: board, routes: [], vias: [] }).circuitJson).toBe(board);
    expect(applyManualRoutes({ circuitJson: board, routes: parseManualEdits(undefined).pcb_routes }).circuitJson).toBe(board);
  });

  it("the file of the hand edits is read and written as before: no new key in it, the same counts", () => {
    const letti = parseManualEdits(MODIFICHE);
    expect(letti.pcb_vias).toEqual([]);
    expect(serializeManualEdits(letti)).toBe(MODIFICHE);
    expect(MODIFICHE).not.toContain("pcb_vias");
    expect(countManualEdits(letti)).toEqual({ schematic: 0, pcb: 1, pcbAuto: 0, traceHints: 0, routes: 2, total: 3 });
    expect(letti.pcb_routes.map((r) => Object.keys(r))).toEqual([
      ["connection", "from", "to", "points", "width", "id"],
      ["connection", "from", "to", "points", "width", "id"],
    ]);
  });
});
