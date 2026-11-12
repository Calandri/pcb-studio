import { beforeAll, describe, expect, it } from "vitest";

/*
 * "SPINGI E SPOSTA", THE PUSH, ON A BOARD COMPILED FOR REAL: what a gesture
 * that pushes asks to be saved goes the whole way a save goes, and the board
 * it leaves is the copper the gesture drew.
 *
 * Two traces of two connections run side by side between four resistors: A
 * along y = 0, B along y = -0.5 under it, each with a stretch at 45 degrees at
 * either end. A lone via of ground stands above them at (0; 1.5). Dragged down
 * to (0; 0.3) its ring (0.15) wants A at -0.15 or lower, and A wants B at
 * -0.55: a chain of two.
 *
 * Twice: with the two traces drawn in the files (two corrections with
 * `replaces`), and with the two traces as hand routes of manual-edits.json
 * (two routes rewritten by their key), the via a correction both times.
 */
import { compileProject } from "@/lib/compile";
import { DESIGN_RULES_PATH, resolveDesignRules } from "@/lib/design-rules";
import { emptyManualEdits, MANUAL_EDITS_PATH, serializeManualEdits, type ManualEdits } from "@/lib/manual-edits";
import { manualRouteKey, parseManualRoutes, percorsoDellaPista, type ManualRoutePoint } from "@/lib/manual-routes";
import { rerouteLocal } from "@/lib/reroute-local";
import { chiudiGesto, iniziaGesto, muoviGesto } from "@/lib/spinta/gesto";
import type { El } from "./scheda-di-prova";
import { comeDetto, piste, posto, salva, vie } from "./spinta-prove";

const top = (x: number, y: number): ManualRoutePoint => ({ x, y, layer: "top" });
const A = ".R1 > .pin2 to .R2 > .pin1";
const B = ".R3 > .pin2 to .R4 > .pin1";
/** the two paths, as the board has them: A along y = 0, B along y = -0.5 */
const DI_A = [top(-9.49, 2), top(-8, 2), top(-6, 0), top(6, 0), top(8, 2), top(9.49, 2)];
const DI_B = [top(-9.49, -3), top(-8, -3), top(-5.5, -0.5), top(5.5, -0.5), top(8, -3), top(9.49, -3)];
/** and where the via at (0; 0.3) leaves them: A 0.15 lower, B 0.05 lower, their diagonals longer along their own lines */
const A_SPINTA = [top(-9.49, 2), top(-8, 2), top(-5.85, -0.15), top(5.85, -0.15), top(8, 2), top(9.49, 2)];
const B_SPINTA = [top(-9.49, -3), top(-8, -3), top(-5.55, -0.55), top(5.55, -0.55), top(8, -3), top(9.49, -3)];

/** the points of a path in the frame of a part at (x; y), as a pcbPath is written */
const relativo = (punti: ManualRoutePoint[], x: number, y: number) =>
  punti.slice(1, -1).map((p) => `{ x: ${Math.round((p.x - x) * 1e4) / 1e4}, y: ${Math.round((p.y - y) * 1e4) / 1e4} }`).join(", ");
const main = (conLePiste: boolean) => `export default () => (
  <board width="40mm" height="24mm">
    <net name="GND" />
    <resistor name="R1" resistance="1k" footprint="0402" pcbX={-10} pcbY={2} />
    <resistor name="R2" resistance="1k" footprint="0402" pcbX={10} pcbY={2} />
    <resistor name="R3" resistance="1k" footprint="0402" pcbX={-10} pcbY={-3} />
    <resistor name="R4" resistance="1k" footprint="0402" pcbX={10} pcbY={-3} />
    <trace from=".R1 > .pin2" to=".R2 > .pin1" ${conLePiste ? `pcbPath={[${relativo(DI_A, -10, 2)}]} thickness="0.2mm"` : ""} />
    <trace from=".R3 > .pin2" to=".R4 > .pin1" ${conLePiste ? `pcbPath={[${relativo(DI_B, -10, -3)}]} thickness="0.2mm"` : ""} />
    <trace from=".R1 > .pin1" to="net.GND" />
    <via name="V1" pcbX={0} pcbY={1.5} connectsTo="net.GND" fromLayer="top" toLayer="bottom" />
  </board>
)
`;
const conMain = (testo: string): Record<string, string> => ({
  "main.tsx": testo,
  [DESIGN_RULES_PATH]: JSON.stringify({
    preset: "custom",
    rules: { minTraceWidthMm: 0.15, minClearanceMm: 0.15, pourClearanceMm: 0.2, autoPlaneVias: false, autoroute: false },
  }),
});
const REGOLE = resolveDesignRules(conMain("")).rules;
/** the same two traces drawn in Instrada: two hand routes between their pads */
const A_MANO: ManualEdits = {
  ...emptyManualEdits(),
  pcb_routes: parseManualRoutes([
    { connection: A, from: ".R1 > .pin2", to: ".R2 > .pin1", width: 0.2, points: DI_A },
    { connection: B, from: ".R3 > .pin2", to: ".R4 > .pin1", width: 0.2, points: DI_B },
  ]),
};

/** the traces of one connection, by the name the files give it */
const pisteDi = (cj: unknown[], connessione: string) => {
  const sorgenti = new Set((cj as El[]).filter((e) => e.type === "source_trace" && e.display_name === connessione).map((e) => e.source_trace_id));
  return piste(cj).filter((e) => sorgenti.has(e.source_trace_id));
};
/** the copper of a board for what it is: every path, every hole with its size */
const rame = (cj: unknown[]) => ({
  piste: piste(cj).map((e) => JSON.stringify(percorsoDellaPista(e))).sort(),
  vie: vie(cj).map((v) => `${posto(v)} ${v.outer_diameter}/${v.hole_diameter}`).sort(),
});

let deiFile: unknown[];
let aMano: unknown[];
beforeAll(async () => {
  deiFile = (await compileProject(conMain(main(true)))).circuitJson;
  aMano = (await compileProject({ ...conMain(main(false)), [MANUAL_EDITS_PATH]: serializeManualEdits(A_MANO) })).circuitJson;
}, 120_000);

/** the via dragged from (0; 1.5) to (0; 0.3) on a board, and what the state it ends in asks to be saved, taken the way a save goes */
function trascina(scheda: unknown[], edits: ManualEdits) {
  expect(pisteDi(scheda, A).map(percorsoDellaPista)).toEqual([DI_A]);
  expect(pisteDi(scheda, B).map(percorsoDellaPista)).toEqual([DI_B]);
  const via = vie(scheda)[0];
  const inizio = iniziaGesto({ circuitJson: scheda, regole: REGOLE, presa: { tipo: "via", pcbViaId: String(via.pcb_via_id) } });
  if ("rifiuto" in inizio) throw new Error(inizio.rifiuto);
  const stato = muoviGesto(inizio.gesto, { x: 0, y: 0.3 });
  expect(stato).toMatchObject({ blocco: null, mosso: true, posizione: { x: 0, y: 0.3 }, vie: [{ x: 0, y: 0.3, outerDiameter: 0.3, holeDiameter: 0.2 }] });
  // the two traces are hidden from the still copper, in the order of the board, and drawn where the push leaves them
  expect(stato.nascosti).toEqual({ pcbTraceIds: [pisteDi(scheda, A)[0].pcb_trace_id, pisteDi(scheda, B)[0].pcb_trace_id], pcbViaIds: [via.pcb_via_id] });
  const q = (punti: ManualRoutePoint[]) => punti.slice(1).map((b, i) => ({ x1: punti[i].x, y1: punti[i].y, x2: b.x, y2: b.y, layer: "top", width: 0.2 }));
  expect(stato.tratti).toEqual([...q(A_SPINTA), ...q(B_SPINTA)]);

  const salvataggio = chiudiGesto(inizio.gesto, stato, "g1")!;
  // read, verified on the saved board, written in the file, laid: see `salva`
  const dopo = salva({ scheda: scheda as El[], edits }, salvataggio, "spinta compilata");
  comeDetto(
    scheda as El[],
    dopo.scheda,
    { piste: new Set(stato.nascosti.pcbTraceIds), vie: new Set(stato.nascosti.pcbViaIds) },
    { tratti: stato.tratti.map((t) => JSON.stringify(t)), vie: stato.vie.map(posto) },
    "spinta compilata",
  );
  // one trace for each connection, where the gesture drew it; the via is the element of the files, moved
  expect(pisteDi(dopo.scheda, A).map(percorsoDellaPista)).toEqual([A_SPINTA]);
  expect(pisteDi(dopo.scheda, B).map(percorsoDellaPista)).toEqual([B_SPINTA]);
  expect(piste(dopo.scheda)).toHaveLength(2);
  expect(vie(dopo.scheda).map((v) => [v.pcb_via_id, posto(v), v.moved_from])).toEqual([[via.pcb_via_id, "0;0.3", { x: 0, y: 1.5 }]]);
  return { salvataggio, dopo };
}

describe("spinta, compilata: a via pushes two traces, and the save takes it", () => {
  it("copper of the files: two corrections with `replaces` and the moved via; the fast update and a compile lay the copper the gesture drew", async () => {
    const { salvataggio, dopo } = trascina(deiFile, emptyManualEdits());
    expect(salvataggio).toEqual({
      routes: [
        { connection: A, points: A_SPINTA, width: 0.2, replaces: { original: DI_A, width: 0.2 }, gesto: "g1" },
        { connection: B, points: B_SPINTA, width: 0.2, replaces: { original: DI_B, width: 0.2 }, gesto: "g1" },
      ],
      vias: [{ net: "GND", from: { x: 0, y: 1.5 }, to: { x: 0, y: 0.3 }, holeDiameter: 0.2, outerDiameter: 0.3, layers: ["top", "bottom"], gesto: "g1" }],
      riscritte: [],
    });
    expect(JSON.stringify(salvataggio)).not.toMatch(/pcb_(trace|via|port|component)_|source_(trace|net|port|component)_/);
    const files = conMain(main(true));
    const scritto = serializeManualEdits(dopo.edits);
    const veloce = rerouteLocal(deiFile, { ...files, [MANUAL_EDITS_PATH]: scritto }, scritto);
    expect(veloce.result).toMatchObject({ ok: true });
    expect(veloce.result.orphans.total).toBe(0);
    expect(rame(veloce.circuitJson!)).toEqual(rame(dopo.scheda));
    const compilata = await compileProject({ ...files, [MANUAL_EDITS_PATH]: scritto });
    expect(rame(compilata.circuitJson)).toEqual(rame(dopo.scheda));
    expect(compilata.summary.manualEditsOrphans).toBeUndefined();
  }, 120_000);

  it("hand copper: the two routes rewritten by the key the file holds, the via a correction, all in one save; the fast update lays the copper the gesture drew", async () => {
    const { salvataggio, dopo } = trascina(aMano, A_MANO);
    expect(salvataggio).toEqual({
      routes: [],
      vias: [{ net: "GND", from: { x: 0, y: 1.5 }, to: { x: 0, y: 0.3 }, holeDiameter: 0.2, outerDiameter: 0.3, layers: ["top", "bottom"], gesto: "g1" }],
      riscritte: [
        { chiave: manualRouteKey(A_MANO.pcb_routes[0]), points: A_SPINTA },
        { chiave: manualRouteKey(A_MANO.pcb_routes[1]), points: B_SPINTA },
      ],
    });
    // the file: the two routes with their new paths and every other field as it was, and the entry of the via
    expect(dopo.edits.pcb_routes).toEqual([
      { ...A_MANO.pcb_routes[0], points: A_SPINTA },
      { ...A_MANO.pcb_routes[1], points: B_SPINTA },
    ]);
    expect(dopo.edits.pcb_vias).toHaveLength(1);
    const files = conMain(main(false));
    const scritto = serializeManualEdits(dopo.edits);
    const veloce = rerouteLocal(aMano, { ...files, [MANUAL_EDITS_PATH]: scritto }, scritto);
    expect(veloce.result).toMatchObject({ ok: true });
    expect(veloce.result.orphans.total).toBe(0);
    expect(rame(veloce.circuitJson!)).toEqual(rame(dopo.scheda));
    const compilata = await compileProject({ ...files, [MANUAL_EDITS_PATH]: scritto });
    expect(rame(compilata.circuitJson)).toEqual(rame(dopo.scheda));
  }, 120_000);
});
