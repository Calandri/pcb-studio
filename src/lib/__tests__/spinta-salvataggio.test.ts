import { beforeAll, describe, expect, it } from "vitest";

/*
 * "SPINGI E SPOSTA", PHASE 2: THE COPPER OF THE FILES MOVED BY HAND IS SAVED
 * WITHOUT DOUBLES.
 *
 * A via dragged in Sposta, and the traces it carries or pushes, are saved in
 * manual-edits.json as CORRECTIONS of the files' copper: a route with
 * `replaces` (it takes the place of the trace the files draw for a connection)
 * and an entry of `pcb_vias` (a lone via of the files, moved). The six rules
 * they are laid by are in one place, applyManualRoutes, which the compile and
 * the fast update both go through: every case here asks the two the same
 * question and wants the same answer.
 *
 * The boards are compiled for real. The traces of a connection are counted by
 * the NAME of the connection, never by id: the doubled copper this phase closes
 * (a hand route added next to the trace of the files, measured in phase 0) has
 * two ids, and idDoppi does not see it.
 *
 * As in spinta-misure.test.ts, the points of a `pcbPath` are relative to the
 * PART of the first pin: R1 is at (-10; 0), so { x: -2, y: 0 } is (-12; 0).
 */
import { boardBaseOf } from "@/lib/board-base";
import { compileProject } from "@/lib/compile";
import { DESIGN_RULES_PATH } from "@/lib/design-rules";
import { idDoppi } from "@/lib/duplicate-ids";
import { planFastUpdate } from "@/lib/fast-update";
import {
  applyCopperPatch,
  emptyManualEdits,
  findOrphanEdits,
  MANUAL_EDITS_PATH,
  parseManualEdits,
  releaseManualEdits,
  senzaAssorbite,
  serializeManualEdits,
} from "@/lib/manual-edits";
import { applyManualRoutes, manualRouteKey, statoDelRame, viaMoveKey, type ManualRoute, type ManualViaMove } from "@/lib/manual-routes";
import { filesHash } from "@/lib/project-store";
import { rerouteLocal } from "@/lib/reroute-local";
import { pezzo, rete, scheda, trace, via as viaDiRete, wire, type El } from "./scheda-di-prova";

const REGOLE = JSON.stringify({
  preset: "custom",
  rules: { minTraceWidthMm: 0.15, minClearanceMm: 0.15, pourClearanceMm: 0.2, autoPlaneVias: false, autoroute: false },
});

const PISTA_FRA_PIEDINI = `<trace from=".R1 > .pin2" to=".R2 > .pin1" pcbPath={[
      { x: 5, y: 0 },
      { x: 5, y: 0, via: true, fromLayer: "top", toLayer: "bottom" },
      { x: 5, y: 0 },
      { x: 15, y: 0 },
      { x: 15, y: 0, via: true, fromLayer: "bottom", toLayer: "top" },
      { x: 15, y: 0 },
    ]} thickness="0.2mm" />`;
/** the trace of R1.pin1 toward ground: down the column `x` (relative to R1), through a via, to y = -5 */
const pistaVersoMassa = (x: number) => `<trace from=".R1 > .pin1" to="net.GND" pcbPath={[
      { x: ${x}, y: 0 },
      { x: ${x}, y: -3 },
      { x: ${x}, y: -3, via: true, fromLayer: "top", toLayer: "bottom" },
      { x: ${x}, y: -3 },
      { x: ${x}, y: -5 },
    ]} thickness="0.2mm" />`;
/** the trace of R3.pin1 toward ground, which ends on the lone via: R3 is at (-10; -6), so it ends at (0; `fine` - 6) */
const pistaAllaVia = (fine: number) => `<trace from=".R3 > .pin1" to="net.GND" pcbPath={[
      { x: -2, y: 0 },
      { x: -2, y: -2 },
      { x: 10, y: -2 },
      { x: 10, y: ${fine} },
    ]} thickness="0.2mm" />`;
const viaIsolata = (y: number) => `<via name="V1" pcbX={0} pcbY={${y}} connectsTo="net.GND" fromLayer="top" toLayer="bottom" />`;

/** a board drawn in its files; each piece of copper can be left out or written another way */
const main = (rame: { versoMassa?: string; allaVia?: string; via?: string } = {}) => `export default () => (
  <board width="40mm" height="24mm">
    <net name="GND" />
    <resistor name="R1" resistance="1k" footprint="0402" pcbX={-10} pcbY={0} />
    <resistor name="R2" resistance="1k" footprint="0402" pcbX={10} pcbY={0} />
    <resistor name="R3" resistance="1k" footprint="0402" pcbX={-10} pcbY={-6} />
    ${PISTA_FRA_PIEDINI}
    ${rame.versoMassa ?? pistaVersoMassa(-2)}
    ${rame.allaVia ?? pistaAllaVia(0)}
    ${rame.via ?? viaIsolata(-6)}
  </board>
)
`;
const conMain = (testo: string): Record<string, string> => ({ "main.tsx": testo, [DESIGN_RULES_PATH]: REGOLE });
const FILES = conMain(main());
const FRA_PIEDINI = ".R1 > .pin2 to .R2 > .pin1";
const VERSO_MASSA = ".R1 > .pin1 to net.GND";
const ALLA_VIA = ".R3 > .pin1 to net.GND";
const QUANDO = "2026-11-12T10:00:00.000Z";

type Punto = { x: number; y: number; layer: "top" | "bottom" };
const top = (x: number, y: number): Punto => ({ x, y, layer: "top" });
const bottom = (x: number, y: number): Punto => ({ x, y, layer: "bottom" });

/** the trace toward ground as the files draw it, and pushed one millimetre to the left */
const MASSA_DEI_FILE = [top(-10.51, 0), top(-12, 0), top(-12, -3), bottom(-12, -3), bottom(-12, -5)];
const MASSA_SPOSTATA = [top(-10.51, 0), top(-13, 0), top(-13, -3), bottom(-13, -3), bottom(-13, -5)];
const massaSpostata: ManualRoute = {
  connection: VERSO_MASSA,
  points: MASSA_SPOSTATA,
  width: 0.2,
  replaces: { original: MASSA_DEI_FILE, width: 0.2 },
  gesto: "g1",
  at: QUANDO,
};
/** the lone via dragged one millimetre up, and the trace that ends on it, which follows */
const viaSpostata: ManualViaMove = { net: "GND", from: { x: 0, y: -6 }, to: { x: 0, y: -5 }, holeDiameter: 0.2, outerDiameter: 0.3, layers: ["top", "bottom"], gesto: "g2", at: QUANDO };
const ALLA_VIA_DEI_FILE = [top(-10.51, -6), top(-12, -6), top(-12, -8), top(0, -8), top(0, -6)];
const ALLA_VIA_SPOSTATA = [top(-10.51, -6), top(-12, -6), top(-12, -8), top(0, -8), top(0, -5)];
const allaViaSpostata: ManualRoute = {
  connection: ALLA_VIA,
  points: ALLA_VIA_SPOSTATA,
  width: 0.2,
  replaces: { original: ALLA_VIA_DEI_FILE, width: 0.2 },
  gesto: "g2",
  at: QUANDO,
};
/** the trace between the two pins taken off: a correction with no points of its own */
const FRA_PIEDINI_DEI_FILE = [top(-9.49, 0), top(-5, 0), bottom(-5, 0), bottom(5, 0), top(5, 0), top(9.49, 0)];
const fraPiedinitolta: ManualRoute = { connection: FRA_PIEDINI, points: [], width: 0.2, replaces: { original: FRA_PIEDINI_DEI_FILE, width: 0.2 }, gesto: "g3", at: QUANDO };

const conLeCorrezioni = (correzioni: { routes?: ManualRoute[]; vias?: ManualViaMove[]; placements?: Array<{ selector: string; center: { x: number; y: number } }> }): string =>
  serializeManualEdits({ ...emptyManualEdits(), pcb_placements: correzioni.placements ?? [], pcb_routes: correzioni.routes ?? [], pcb_vias: correzioni.vias ?? [] });

const mm = (v: unknown) => Math.round(Number(v) * 1e4) / 1e4;
const posto = (e: Record<string, unknown>) => `${mm(e.x)};${mm(e.y)}`;
const piste = (cj: unknown[]) => (cj as El[]).filter((e) => e.type === "pcb_trace");
const vie = (cj: unknown[]) => (cj as El[]).filter((e) => e.type === "pcb_via");
/** the path of a trace as it is read: the layer of every point, "via" where it changes face */
const percorso = (e: El) =>
  ((e.route as Array<Record<string, unknown>> | undefined) ?? []).map((p) => `${p.route_type === "via" ? "via" : p.layer} ${posto(p)}`).join(" > ");
const scritto = (punti: Punto[]) =>
  punti.flatMap((p, i) => (i > 0 && punti[i - 1].layer !== p.layer ? [`via ${p.x};${p.y}`, `${p.layer} ${p.x};${p.y}`] : [`${p.layer} ${p.x};${p.y}`])).join(" > ");
/**
 * THE TRACES OF ONE CONNECTION, by the name the files give it: every source
 * trace of that name, every pcb_trace of each. Never by id.
 */
const pisteDi = (cj: unknown[], connessione: string) => {
  const sorgenti = new Set((cj as El[]).filter((e) => e.type === "source_trace" && e.display_name === connessione).map((e) => e.source_trace_id));
  return piste(cj).filter((e) => sorgenti.has(e.source_trace_id));
};
/** the copper of a board for what it is: every path and every hole with its size, in order */
const rame = (cj: unknown[]) => ({
  piste: piste(cj).map(percorso).sort(),
  vie: vie(cj).map((v) => `${posto(v)} ${mm(v.outer_diameter)}/${mm(v.hole_diameter)}`).sort(),
});
/** the part of 0.3 x 0.3 mm tscircuit lays for a <via>, and its three ports: where they are */
const accantoAllaVia = (cj: unknown[]) => {
  const sorgenti = new Set((cj as El[]).filter((e) => e.type === "source_manually_placed_via").map((e) => e.source_manually_placed_via_id));
  const corpi = (cj as El[]).filter((e) => e.type === "pcb_component" && sorgenti.has(e.source_component_id));
  return corpi.map((c) => ({
    centro: posto(c.center as Record<string, unknown>),
    porte: (cj as El[]).filter((e) => e.type === "pcb_port" && e.pcb_component_id === c.pcb_component_id).map(posto),
  }));
};

type Compilata = Awaited<ReturnType<typeof compileProject>>;
let base: Compilata;
beforeAll(async () => {
  base = await compileProject(FILES);
}, 120_000);

/** the two roads a board takes: a compile of the files with the corrections, and the fast update of the board compiled without */
const perDueStrade = async (edits: string, files: Record<string, string> = FILES, compilataSenza: Compilata = base) => {
  const conLeModifiche = { ...files, [MANUAL_EDITS_PATH]: edits };
  const compilata = await compileProject(conLeModifiche);
  const veloce = rerouteLocal(compilataSenza.circuitJson, conLeModifiche, edits);
  if (!veloce.circuitJson) throw new Error(`aggiornamento veloce: ${veloce.result.reason}`);
  return { conLeModifiche, compilata, veloce: { circuitJson: veloce.circuitJson, result: veloce.result } };
};

describe("spinta, salvataggio: a correction with `replaces` on a trace the files draw toward a net", () => {
  it("the board of the files: one trace for each connection, and the trace toward ground where the files put it", () => {
    for (const connessione of [FRA_PIEDINI, VERSO_MASSA, ALLA_VIA]) expect(pisteDi(base.circuitJson, connessione), connessione).toHaveLength(1);
    expect(pisteDi(base.circuitJson, VERSO_MASSA).map(percorso)).toEqual([scritto(MASSA_DEI_FILE)]);
    expect(pisteDi(base.circuitJson, ALLA_VIA).map(percorso)).toEqual([scritto(ALLA_VIA_DEI_FILE)]);
    expect(vie(base.circuitJson).map(posto).sort()).toEqual(["-12;-3", "-5;0", "0;-6", "5;0"]);
  });

  it("leaves ONE trace for that connection, the route's, in the compile and in the fast update; and no id is doubled", async () => {
    const { compilata, veloce } = await perDueStrade(conLeCorrezioni({ routes: [massaSpostata] }));
    for (const board of [compilata.circuitJson, veloce.circuitJson]) {
      // counted by connection: the trace of the files is out, the route is in its place
      const diMassa = pisteDi(board, VERSO_MASSA);
      expect(diMassa).toHaveLength(1);
      expect(diMassa.map(percorso)).toEqual([scritto(MASSA_SPOSTATA)]);
      // with the id of the trace it replaced, and marked as hand copper with its key
      expect(diMassa[0].pcb_trace_id).toBe(pisteDi(base.circuitJson, VERSO_MASSA)[0].pcb_trace_id);
      expect(diMassa[0]).toMatchObject({ manual: true, manual_route_id: manualRouteKey(massaSpostata) });
      expect(idDoppi(board)).toBeNull();
      // the via of the file's trace went with it, the route's own is in its place: as many holes as before
      expect(vie(board).map(posto).sort()).toEqual(["-13;-3", "-5;0", "0;-6", "5;0"]);
      // the other connections are as the files draw them
      for (const connessione of [FRA_PIEDINI, ALLA_VIA]) {
        expect(pisteDi(board, connessione).map(percorso)).toEqual(pisteDi(base.circuitJson, connessione).map(percorso));
      }
    }
    expect(rame(veloce.circuitJson)).toEqual(rame(compilata.circuitJson));
    expect(veloce.result).toMatchObject({ ok: true, manualRoutes: 1, manualBranches: 0 });
    expect(veloce.result.orphans.total).toBe(0);
    expect(compilata.summary.manualEditsOrphans).toBeUndefined();
  }, 120_000);

  it("the vias of the route keep the size of the vias of the trace it replaces, whether the route says it or not", async () => {
    // the files' via is 0.3/0.2 (tscircuit's own); the project's default for a hand via is 0.6/0.3
    const detta = { ...massaSpostata, viaDiameter: 0.3, viaHoleDiameter: 0.2 };
    for (const route of [massaSpostata, detta]) {
      const { compilata, veloce } = await perDueStrade(conLeCorrezioni({ routes: [route] }));
      for (const board of [compilata.circuitJson, veloce.circuitJson]) {
        const sua = vie(board).find((v) => posto(v) === "-13;-3")!;
        expect([sua.outer_diameter, sua.hole_diameter]).toEqual([0.3, 0.2]);
      }
    }
  }, 120_000);

  it("with the part of the trace moved by a pcb_placement, the compile and the fast update lay the same copper for that connection", async () => {
    const spostato = [{ selector: "R1", center: { x: -10, y: 2 } }];
    // the fact the rule stands on (phase 0): alone, the copper of the files follows the part in a compile and not in the fast update
    const soloIlPezzo = await perDueStrade(conLeCorrezioni({ placements: spostato }));
    expect(pisteDi(soloIlPezzo.compilata.circuitJson, VERSO_MASSA).map(percorso)).toEqual(["top -10.51;2 > top -12;2 > top -12;-1 > via -12;-1 > bottom -12;-1 > bottom -12;-3"]);
    expect(pisteDi(soloIlPezzo.veloce.circuitJson, VERSO_MASSA).map(percorso)).toEqual([scritto(MASSA_DEI_FILE)]);

    // with the correction the two agree: it is found by the name of the connection, wherever the files' trace is
    const { compilata, veloce } = await perDueStrade(conLeCorrezioni({ placements: spostato, routes: [massaSpostata] }));
    for (const board of [compilata.circuitJson, veloce.circuitJson]) {
      expect(pisteDi(board, VERSO_MASSA).map(percorso)).toEqual([scritto(MASSA_SPOSTATA)]);
      expect(idDoppi(board)).toBeNull();
    }
    expect(pisteDi(veloce.circuitJson, VERSO_MASSA).map((p) => p.route)).toEqual(pisteDi(compilata.circuitJson, VERSO_MASSA).map((p) => p.route));
    expect(veloce.result.orphans.total).toBe(0);
    expect(compilata.summary.manualEditsOrphans).toBeUndefined();
  }, 120_000);
});

describe("spinta, salvataggio: the correction taken away (Cmd+Z, a release)", () => {
  it("the fast update puts the starting trace back on the saved board, with its vias, and asks for no compile", async () => {
    const edits = conLeCorrezioni({ routes: [massaSpostata] });
    const { conLeModifiche, compilata, veloce } = await perDueStrade(edits);
    // from the board a compile saved and from the one the fast update saved
    for (const salvata of [compilata.circuitJson, veloce.circuitJson]) {
      const piano = planFastUpdate({ filesHash: filesHash(conLeModifiche), base: boardBaseOf(conLeModifiche), circuitJson: salvata }, FILES, FILES);
      // "save": a board to file, made here. Not "compile"
      if (piano.kind !== "save") throw new Error(`aggiornamento veloce: ${piano.kind}`);
      expect(piano.unchanged).toBe(false);
      const diMassa = pisteDi(piano.board, VERSO_MASSA);
      expect(diMassa.map(percorso)).toEqual([scritto(MASSA_DEI_FILE)]);
      // the trace of the files again: no hand mark, nothing remembered, the id it had
      expect(diMassa[0]).not.toHaveProperty("manual");
      expect(diMassa[0]).not.toHaveProperty("manual_route_id");
      expect(diMassa[0]).not.toHaveProperty("replaces");
      expect(diMassa[0].pcb_trace_id).toBe(pisteDi(base.circuitJson, VERSO_MASSA)[0].pcb_trace_id);
      // the copper of the whole board is the one of the files, holes and their sizes included
      expect(rame(piano.board)).toEqual(rame(base.circuitJson));
      expect(vie(piano.board).filter((v) => v.manual === true)).toEqual([]);
      expect(idDoppi(piano.board)).toBeNull();
      // and it stays so: a second update finds nothing to do
      const ancora = planFastUpdate({ filesHash: filesHash(FILES), base: boardBaseOf(FILES), circuitJson: piano.board }, FILES, FILES);
      expect(ancora.kind).toBe("unchanged");
    }
  }, 120_000);

  it("a moved via goes back where the files put it, with its part and its ports", async () => {
    const edits = conLeCorrezioni({ vias: [viaSpostata], routes: [allaViaSpostata] });
    const { conLeModifiche, compilata } = await perDueStrade(edits);
    const piano = planFastUpdate({ filesHash: filesHash(conLeModifiche), base: boardBaseOf(conLeModifiche), circuitJson: compilata.circuitJson }, FILES, FILES);
    if (piano.kind !== "save") throw new Error(`aggiornamento veloce: ${piano.kind}`);
    expect(rame(piano.board)).toEqual(rame(base.circuitJson));
    expect(accantoAllaVia(piano.board)).toEqual([{ centro: "0;-6", porte: ["0;-6", "0;-6", "0;-6"] }]);
    expect(vie(piano.board).filter((v) => v.moved_from !== undefined)).toEqual([]);
    // the via itself is the element of the files, as it was
    expect(vie(piano.board).find((v) => posto(v) === "0;-6")).toEqual(vie(base.circuitJson).find((v) => posto(v) === "0;-6"));
  }, 120_000);

  it("releasing the traces of a part lets go of the corrections of its gestures, moved vias included", () => {
    const edits = parseManualEdits(conLeCorrezioni({ vias: [viaSpostata], routes: [massaSpostata, allaViaSpostata] }));
    // R3 is the part of the trace that ends on the via: its gesture (g2) goes, the one of R1 (g1) stays
    const senzaR3 = releaseManualEdits(edits, "traces", "R3");
    expect(senzaR3.pcb_routes.map((r) => r.gesto)).toEqual(["g1"]);
    expect(senzaR3.pcb_vias).toEqual([]);
    const senzaR1 = releaseManualEdits(edits, "traces", "R1");
    expect(senzaR1.pcb_routes.map((r) => r.gesto)).toEqual(["g2"]);
    expect(senzaR1.pcb_vias.map((v) => v.gesto)).toEqual(["g2"]);
    // every trace released: every moved via with them; the positions of the parts are another scope
    expect(releaseManualEdits(edits, "traces", null)).toMatchObject({ pcb_routes: [], pcb_vias: [] });
    expect(releaseManualEdits(edits, "pcb", null).pcb_vias).toHaveLength(1);
  });
});

describe("spinta, salvataggio: a lone <via> and an entry of pcb_vias", () => {
  it("one via only, in the new place, with the part and the three ports tscircuit puts beside it", async () => {
    const { compilata, veloce } = await perDueStrade(conLeCorrezioni({ vias: [viaSpostata] }));
    for (const board of [compilata.circuitJson, veloce.circuitJson]) {
      // as many vias as the files draw: the one of the files moved, none added
      expect(vie(board)).toHaveLength(vie(base.circuitJson).length);
      expect(vie(board).map(posto).sort()).toEqual(["-12;-3", "-5;0", "0;-5", "5;0"]);
      const spostata = vie(board).find((v) => posto(v) === "0;-5")!;
      const deiFile = vie(base.circuitJson).find((v) => posto(v) === "0;-6")!;
      // the same element, moved: its id, its size, its net; and where it came from
      expect(spostata).toEqual({ ...deiFile, x: 0, y: -5, moved_from: { x: 0, y: -6 } });
      expect(accantoAllaVia(board)).toEqual([{ centro: "0;-5", porte: ["0;-5", "0;-5", "0;-5"] }]);
      expect(idDoppi(board)).toBeNull();
    }
    expect(veloce.result.orphans.total).toBe(0);
    expect(compilata.summary.manualEditsOrphans).toBeUndefined();
  }, 120_000);

  it("a via inside the path of a trace is not moved this way: the entry is an orphan and the trace keeps its hole", async () => {
    // the via of the trace toward ground, at (-12; -3): it travels with a `replaces` route of its trace, not alone
    const dentro: ManualViaMove = { ...viaSpostata, from: { x: -12, y: -3 }, to: { x: -11, y: -3 } };
    const { compilata, veloce } = await perDueStrade(conLeCorrezioni({ vias: [dentro] }));
    for (const board of [compilata.circuitJson, veloce.circuitJson]) expect(rame(board)).toEqual(rame(base.circuitJson));
    expect(veloce.result.orphans.pcb_vias).toEqual([viaMoveKey(dentro)]);
    expect(compilata.summary.manualEditsOrphans?.pcb_vias).toEqual([viaMoveKey(dentro)]);
  }, 120_000);
});

describe("spinta, salvataggio: laid twice", () => {
  it("a compile, then the fast update on the board it gave: the same Circuit JSON, and again", async () => {
    const edits = conLeCorrezioni({ vias: [viaSpostata], routes: [massaSpostata, allaViaSpostata, fraPiedinitolta] });
    const { conLeModifiche, compilata, veloce } = await perDueStrade(edits);
    const dopo = rerouteLocal(compilata.circuitJson, conLeModifiche, edits);
    expect(dopo.result).toMatchObject({ ok: true, moved: 0 });
    // element by element, in order: nothing moved, nothing added, nothing renumbered
    expect(dopo.circuitJson).toEqual(compilata.circuitJson);
    expect(JSON.stringify(dopo.circuitJson)).toBe(JSON.stringify(compilata.circuitJson));
    expect(idDoppi(dopo.circuitJson!)).toBeNull();
    // the same for the board the fast update made, and the two roads lay the same copper
    const ancora = rerouteLocal(veloce.circuitJson, conLeModifiche, edits);
    expect(JSON.stringify(ancora.circuitJson)).toBe(JSON.stringify(veloce.circuitJson));
    expect(rame(veloce.circuitJson)).toEqual(rame(compilata.circuitJson));
    expect(accantoAllaVia(veloce.circuitJson)).toEqual(accantoAllaVia(compilata.circuitJson));
    // one trace for every connection that keeps its copper, none for the one taken off
    expect(pisteDi(dopo.circuitJson!, VERSO_MASSA).map(percorso)).toEqual([scritto(MASSA_SPOSTATA)]);
    expect(pisteDi(dopo.circuitJson!, ALLA_VIA).map(percorso)).toEqual([scritto(ALLA_VIA_SPOSTATA)]);
    expect(pisteDi(dopo.circuitJson!, FRA_PIEDINI)).toEqual([]);
    // the plan of the fast update on the compiled board: the board of these files already, nothing to write
    const piano = planFastUpdate({ filesHash: filesHash(conLeModifiche), base: boardBaseOf(conLeModifiche), circuitJson: compilata.circuitJson }, conLeModifiche, conLeModifiche);
    if (piano.kind !== "save") throw new Error(`aggiornamento veloce: ${piano.kind}`);
    expect(JSON.stringify(piano.board)).toBe(JSON.stringify(compilata.circuitJson));
  }, 120_000);
});

describe("spinta, salvataggio: orphans", () => {
  it("the starting trace taken out of the files: the correction is not laid and is listed among the orphans", async () => {
    // the files no longer draw a trace for R1.pin1 toward ground (the connection is still declared)
    const senzaPista = conMain(main({ versoMassa: `<trace from=".R1 > .pin1" to="net.GND" />` }));
    const senza = await compileProject(senzaPista);
    expect(pisteDi(senza.circuitJson, VERSO_MASSA)).toEqual([]);
    const { compilata, veloce } = await perDueStrade(conLeCorrezioni({ routes: [massaSpostata] }), senzaPista, senza);
    const chiave = manualRouteKey(massaSpostata);
    for (const board of [compilata.circuitJson, veloce.circuitJson]) {
      // nothing laid: the copper is the one of the files, with no trace for that connection
      expect(pisteDi(board, VERSO_MASSA)).toEqual([]);
      expect(rame(board)).toEqual(rame(senza.circuitJson));
      expect(findOrphanEdits(board, parseManualEdits(conLeCorrezioni({ routes: [massaSpostata] }))).pcb_routes).toEqual([chiave]);
    }
    expect(compilata.summary.manualEditsOrphans).toMatchObject({ pcb_routes: [chiave], total: 1 });
    expect(compilata.summary.message).toContain("1 modifiche a mano non trovano piu' il loro pezzo");
    expect(veloce.result.orphans).toMatchObject({ pcb_routes: [chiave], total: 1 });
    expect(veloce.result.manualRoutes).toBe(0);
  }, 120_000);

  it("the same when the connection itself is gone from the files, and for a via the files no longer draw", async () => {
    const senzaNulla = conMain(main({ versoMassa: "", via: "" }));
    const senza = await compileProject(senzaNulla);
    expect(vie(senza.circuitJson).map(posto).sort()).toEqual(["-5;0", "5;0"]);
    const edits = conLeCorrezioni({ routes: [massaSpostata], vias: [viaSpostata] });
    const { compilata, veloce } = await perDueStrade(edits, senzaNulla, senza);
    for (const board of [compilata.circuitJson, veloce.circuitJson]) expect(rame(board)).toEqual(rame(senza.circuitJson));
    const orfane = { pcb_routes: [manualRouteKey(massaSpostata)], pcb_vias: [viaMoveKey(viaSpostata)], total: 2 };
    expect(compilata.summary.manualEditsOrphans).toMatchObject(orfane);
    expect(veloce.result.orphans).toMatchObject(orfane);
    // each correction stands alone: one of them an orphan does not stop another that has its copper
    const mista = await perDueStrade(conLeCorrezioni({ routes: [massaSpostata, allaViaSpostata] }), senzaNulla, senza);
    for (const board of [mista.compilata.circuitJson, mista.veloce.circuitJson]) {
      expect(pisteDi(board, ALLA_VIA).map(percorso)).toEqual([scritto(ALLA_VIA_SPOSTATA)]);
    }
    expect(mista.veloce.result.orphans.pcb_routes).toEqual([manualRouteKey(massaSpostata)]);
  }, 120_000);
});

describe("spinta, salvataggio: corrections the files have absorbed", () => {
  it("the files already draw the result: nothing is laid, nothing is an orphan, and the corrections leave the file", async () => {
    // whoever generates the sources copied the two corrections there: the trace down the column of -13, the via at (0; -5)
    const ricopiati = conMain(main({ versoMassa: pistaVersoMassa(-3), via: viaIsolata(-5) }));
    const senza = await compileProject(ricopiati);
    expect(pisteDi(senza.circuitJson, VERSO_MASSA).map(percorso)).toEqual([scritto(MASSA_SPOSTATA)]);
    const edits = conLeCorrezioni({ routes: [massaSpostata], vias: [viaSpostata] });
    const { compilata, veloce } = await perDueStrade(edits, ricopiati, senza);
    for (const board of [compilata.circuitJson, veloce.circuitJson]) {
      // the copper of the files, untouched: no hand mark on the trace, no "moved from" on the via
      expect(rame(board)).toEqual(rame(senza.circuitJson));
      expect(pisteDi(board, VERSO_MASSA)[0]).not.toHaveProperty("manual");
      expect(vie(board).filter((v) => v.moved_from !== undefined || v.manual === true)).toEqual([]);
      expect(idDoppi(board)).toBeNull();
      const letti = parseManualEdits(edits);
      expect(statoDelRame(board, letti.pcb_routes, letti.pcb_vias)).toEqual({
        orfane: { routes: [], vias: [] },
        assorbite: { routes: [manualRouteKey(massaSpostata)], vias: [viaMoveKey(viaSpostata)] },
      });
      expect(findOrphanEdits(board, letti).total).toBe(0);
      // at the next save that has the board in hand they are out of manual-edits.json
      const salvate = senzaAssorbite(letti, board);
      expect(salvate.pcb_routes).toEqual([]);
      expect(salvate.pcb_vias).toEqual([]);
      expect(serializeManualEdits(salvate)).toBe(serializeManualEdits(emptyManualEdits()));
    }
    expect(compilata.summary.manualEditsOrphans).toBeUndefined();
    expect(veloce.result.manualRoutes).toBe(0);
  }, 120_000);

  it("copied by half: the via is already in `to` in the files, the trace that reached it is as it was. The via's correction goes, the trace's stays laid", async () => {
    const aMeta = conMain(main({ via: viaIsolata(-5) }));
    const senza = await compileProject(aMeta);
    // the files as they are: the via at (0; -5), the trace still ending where the via was, at (0; -6)
    expect(vie(senza.circuitJson).map(posto).sort()).toEqual(["-12;-3", "-5;0", "0;-5", "5;0"]);
    expect(pisteDi(senza.circuitJson, ALLA_VIA).map(percorso)).toEqual([scritto(ALLA_VIA_DEI_FILE)]);

    const edits = conLeCorrezioni({ vias: [viaSpostata], routes: [allaViaSpostata] });
    const { compilata, veloce } = await perDueStrade(edits, aMeta, senza);
    for (const board of [compilata.circuitJson, veloce.circuitJson]) {
      // the trace's correction is laid: one trace for the connection, ending on the via
      expect(pisteDi(board, ALLA_VIA).map(percorso)).toEqual([scritto(ALLA_VIA_SPOSTATA)]);
      expect(pisteDi(board, ALLA_VIA)[0]).toMatchObject({ manual: true, manual_route_id: manualRouteKey(allaViaSpostata) });
      // the via is the one of the files, where the files put it: not moved again, not doubled
      expect(vie(board).map(posto).sort()).toEqual(["-12;-3", "-5;0", "0;-5", "5;0"]);
      expect(vie(board).filter((v) => v.moved_from !== undefined)).toEqual([]);
      expect(idDoppi(board)).toBeNull();
      const letti = parseManualEdits(edits);
      expect(statoDelRame(board, letti.pcb_routes, letti.pcb_vias)).toEqual({
        orfane: { routes: [], vias: [] },
        assorbite: { routes: [], vias: [viaMoveKey(viaSpostata)] },
      });
      // the save takes the absorbed one out and keeps the other
      const salvate = senzaAssorbite(letti, board);
      expect(salvate.pcb_vias).toEqual([]);
      expect(salvate.pcb_routes).toEqual(letti.pcb_routes);
      // and the board of the file so saved is the same board
      const dopo = rerouteLocal(board, { ...aMeta, [MANUAL_EDITS_PATH]: serializeManualEdits(salvate) }, serializeManualEdits(salvate));
      expect(JSON.stringify(dopo.circuitJson)).toBe(JSON.stringify(board));
    }
    expect(veloce.result.orphans.total).toBe(0);
  }, 120_000);
});

describe("spinta, salvataggio: a route with `replaces` and no points", () => {
  it("takes the trace of the files out: the connection has no copper and the summary counts it among the open ones", async () => {
    // the board of the files has that connection closed
    expect(base.summary.unroutedConnections).not.toContain(FRA_PIEDINI);
    const edits = conLeCorrezioni({ routes: [fraPiedinitolta] });
    const { conLeModifiche, compilata, veloce } = await perDueStrade(edits);
    for (const board of [compilata.circuitJson, veloce.circuitJson]) {
      expect(pisteDi(board, FRA_PIEDINI)).toEqual([]);
      // its two vias went with it; the rest of the copper is the one of the files
      expect(vie(board).map(posto).sort()).toEqual(["-12;-3", "0;-6"]);
      expect(pisteDi(board, VERSO_MASSA).map(percorso)).toEqual([scritto(MASSA_DEI_FILE)]);
      expect(idDoppi(board)).toBeNull();
      // not an orphan: it did what it says
      expect(findOrphanEdits(board, parseManualEdits(edits)).total).toBe(0);
    }
    expect(compilata.summary.unroutedConnections).toContain(FRA_PIEDINI);
    expect(compilata.summary.unroutedTotal).toBe((base.summary.unroutedTotal ?? 0) + 1);
    expect(compilata.summary.unroutedDetail.find((d) => d.name === FRA_PIEDINI)?.points).toEqual([
      { x: -9.49, y: 0, layer: "top" },
      { x: 9.49, y: 0, layer: "top" },
    ]);
    // laid again on its own board it stays out, and taken away it gives the trace back with its two vias
    const dopo = rerouteLocal(compilata.circuitJson, conLeModifiche, edits);
    expect(JSON.stringify(dopo.circuitJson)).toBe(JSON.stringify(compilata.circuitJson));
    const piano = planFastUpdate({ filesHash: filesHash(conLeModifiche), base: boardBaseOf(conLeModifiche), circuitJson: compilata.circuitJson }, FILES, FILES);
    if (piano.kind !== "save") throw new Error(`aggiornamento veloce: ${piano.kind}`);
    expect(rame(piano.board)).toEqual(rame(base.circuitJson));
    expect(pisteDi(piano.board, FRA_PIEDINI)[0].pcb_trace_id).toBe(pisteDi(base.circuitJson, FRA_PIEDINI)[0].pcb_trace_id);
    expect(idDoppi(piano.board)).toBeNull();
  }, 120_000);
});

describe("spinta, salvataggio: what is written in manual-edits.json", () => {
  it("a file written before these fields reads as it did, with no moved via; and is written back byte for byte", () => {
    const vecchio = `${JSON.stringify(
      {
        schematic_placements: [],
        pcb_placements: [{ selector: "R1", center: { x: 1, y: 2 } }],
        manual_trace_hints: [],
        // in the order the file has always been written in: the key of the pair last
        pcb_routes: [{ connection: FRA_PIEDINI, from: ".R1 > .pin2", to: ".R2 > .pin1", points: [top(-9.49, 0), top(9.49, 0)], width: 0.2, id: ".R1 > .pin2 ~ .R2 > .pin1" }],
      },
      null,
      2,
    )}\n`;
    const letti = parseManualEdits(vecchio);
    expect(letti.pcb_vias).toEqual([]);
    expect(letti.pcb_routes[0]).not.toHaveProperty("replaces");
    expect(serializeManualEdits(letti)).toBe(vecchio);
    expect(parseManualEdits(undefined).pcb_vias).toEqual([]);
    expect(parseManualEdits("{").pcb_vias).toEqual([]);
  });

  it("the corrections go to the file and come back as they are: to 0.0001 mm, with their gesture, the via with hole, ring and layers, and no id of the circuit", () => {
    const fine: ManualRoute = { ...massaSpostata, points: [top(-10.5101, 0), top(-13.00004, 0), top(-13, -3.12346)], viaDiameter: 0.3, viaHoleDiameter: 0.2 };
    const testo = conLeCorrezioni({ routes: [fine], vias: [{ ...viaSpostata, to: { x: 0.00004, y: -5.12346 } }] });
    const letti = parseManualEdits(testo);
    expect(letti.pcb_routes).toEqual([{ ...fine, points: [top(-10.5101, 0), top(-13, 0), top(-13, -3.1235)] }]);
    expect(letti.pcb_vias).toEqual([{ ...viaSpostata, to: { x: 0, y: -5.1235 } }]);
    expect(parseManualEdits(serializeManualEdits(letti))).toEqual(letti);
    // a drawn route (no `replaces`) is rounded to the micron, as it always was
    expect(parseManualEdits(conLeCorrezioni({ routes: [{ connection: FRA_PIEDINI, points: [top(0.12345, 0), top(5, 0)], width: 0.2 }] })).pcb_routes[0].points[0].x).toBe(0.123);
    // names of parts, pins and nets, places and sizes: nothing that is numbered at a compile
    expect(testo).not.toMatch(/pcb_(trace|via|port|component)_|source_(trace|net|port|component)_/);
    for (const v of letti.pcb_vias) expect(v).toMatchObject({ holeDiameter: 0.2, outerDiameter: 0.3, layers: ["top", "bottom"] });
  });

  it("an entry that is not one is dropped, never thrown, and the others are read", () => {
    const buona = viaSpostata;
    const letti = parseManualEdits(
      JSON.stringify({
        pcb_vias: [
          null,
          "via",
          { ...buona, net: "" },
          { ...buona, net: 7 },
          { ...buona, from: { x: Number.NaN, y: 0 } },
          { ...buona, to: { x: 1e6, y: 0 } },
          { ...buona, to: buona.from },
          { ...buona, holeDiameter: undefined },
          { ...buona, outerDiameter: -1 },
          { ...buona, layers: ["top"] },
          { ...buona, layers: ["top", "rame"] },
          { ...buona, layers: undefined },
          buona,
          // two entries for one via of the files: the last one
          { ...buona, to: { x: 2, y: -5 }, gesto: "non un nome!", at: "ieri" },
        ],
        pcb_routes: [
          { ...massaSpostata, replaces: "no" },
          { ...massaSpostata, replaces: { original: [top(0, 0)], width: 0.2 } },
          { ...massaSpostata, replaces: { original: MASSA_DEI_FILE } },
          { ...massaSpostata, replaces: { original: [top(0, 0), { x: 1, y: 1, layer: "rame" }], width: 0.2 } },
          { ...massaSpostata, points: [top(0, 0)] },
          { ...massaSpostata, points: undefined },
          // what a drawn route can carry and a correction cannot: read without
          { ...massaSpostata, from: ".R1 > .pin1", to: ".R3 > .pin1", net: "GND", arco: true },
        ],
      }),
    );
    expect(letti.pcb_vias).toEqual([{ net: "GND", from: { x: 0, y: -6 }, to: { x: 2, y: -5 }, holeDiameter: 0.2, outerDiameter: 0.3, layers: ["top", "bottom"] }]);
    expect(letti.pcb_routes).toEqual([{ ...massaSpostata, points: [] }, massaSpostata]);
    // a list that is not a list, a file that is not an object
    expect(parseManualEdits(JSON.stringify({ pcb_vias: { 0: buona } })).pcb_vias).toEqual([]);
    expect(parseManualEdits("[]").pcb_vias).toEqual([]);
  });

  it("a trace or a via moved again keeps where the files put it: one correction for each, and what it replaced comes back for undo", () => {
    const primo = applyCopperPatch(emptyManualEdits(), { routes: [massaSpostata], vias: [viaSpostata] });
    expect(primo.edits.pcb_routes).toEqual([massaSpostata]);
    expect(primo.edits.pcb_vias).toEqual([viaSpostata]);
    expect(primo.replaced).toEqual({ routes: [], vias: [] });

    // the second drag starts from what is on screen: the path and the place the first one left
    const ANCORA_PIU_IN_LA = [top(-10.51, 0), top(-14, 0), top(-14, -3), bottom(-14, -3), bottom(-14, -5)];
    const ancora: ManualRoute = { ...massaSpostata, points: ANCORA_PIU_IN_LA, replaces: { original: MASSA_SPOSTATA, width: 0.2 }, gesto: "g9" };
    const viaAncora: ManualViaMove = { ...viaSpostata, from: viaSpostata.to, to: { x: 1, y: -5 }, gesto: "g9" };
    const secondo = applyCopperPatch(primo.edits, { routes: [ancora], vias: [viaAncora] });
    expect(secondo.edits.pcb_routes).toEqual([{ ...ancora, replaces: massaSpostata.replaces }]);
    expect(secondo.edits.pcb_vias).toEqual([{ ...viaAncora, from: viaSpostata.from }]);
    expect(secondo.replaced).toEqual({ routes: [massaSpostata], vias: [viaSpostata] });
    expect(manualRouteKey(secondo.edits.pcb_routes[0])).toBe(manualRouteKey(massaSpostata));

    // dragged back to where the files have it, the via has nothing left to correct
    const tornata = applyCopperPatch(secondo.edits, { routes: [], vias: [{ ...viaSpostata, from: { x: 1, y: -5 }, to: viaSpostata.from }] });
    expect(tornata.edits.pcb_vias).toEqual([]);
    // a drawn route is not a correction: this door does not write it
    expect(applyCopperPatch(emptyManualEdits(), { routes: [{ connection: FRA_PIEDINI, points: [top(0, 0), top(1, 0)], width: 0.2 }], vias: [] }).edits.pcb_routes).toEqual([]);
  });
});

/*
 * THE RULES ON BOARDS WRITTEN BY HAND: the cases a compiled board of three
 * resistors does not have. Two nets, GND (1) and SIG (2); the parts and the
 * source traces as scheda-di-prova.ts writes them.
 */
describe("spinta, salvataggio: the rules, case by case", () => {
  const GND_R1 = ".R1 > .1 to net.GND";
  const circuito = (rame: El[]): El[] => [
    scheda(2),
    ...pezzo("R1", [["1", -10, 0], ["2", -9, 0]]),
    ...pezzo("R2", [["1", 10, 0], ["2", 11, 0]]),
    ...rete(1, "GND", ["R1_1", "R2_1"]),
    ...rete(2, "SIG", ["R1_2", "R2_2"]),
    ...rame,
  ];
  const correzione = (connection: string, original: Punto[], points: Punto[]): ManualRoute => ({ connection, points, width: 0.2, replaces: { original, width: 0.2 } });
  const posa = (cj: El[], routes: ManualRoute[], vias: ManualViaMove[] = []) => applyManualRoutes({ circuitJson: cj, routes, vias });
  /** the part and the ports tscircuit lays for a <via> at that place */
  const corpoDellaVia = (n: number, x: number, y: number): El[] => [
    { type: "source_manually_placed_via", source_manually_placed_via_id: `smpv_${n}`, source_net_id: "" },
    { type: "pcb_component", pcb_component_id: `pc_via_${n}`, source_component_id: `smpv_${n}`, center: { x, y }, width: 0.6, height: 0.6, layer: "top", rotation: 0 },
    ...["top", "bottom", "pin1"].map((nome) => ({ type: "pcb_port", pcb_port_id: `pp_via_${n}_${nome}`, pcb_component_id: `pc_via_${n}`, x, y, layers: ["top"] })),
  ];

  it("two traces of one connection: the starting path picks the nearest, and each correction keeps its own", () => {
    // two <trace> of R1.1 toward ground give two source traces with one name (measured on tscircuit)
    const dueSorgenti: El[] = [
      { type: "source_trace", source_trace_id: "st_GND_bis", display_name: GND_R1, subcircuit_connectivity_map_key: "chiave_1", connected_source_port_ids: ["sp_R1_1"], connected_source_net_ids: ["source_net_1"] },
      trace("t_su", "st_GND_0", [wire(-10, 0), wire(-10, 3)]),
      trace("t_giu", "st_GND_bis", [wire(-10, 0), wire(-10, -3)]),
    ];
    const su = correzione(GND_R1, [top(-10, 0), top(-10, 3)], [top(-10, 0), top(-10, 4)]);
    const giu = correzione(GND_R1, [top(-10, 0), top(-10, -3)], [top(-10, 0), top(-10, -4)]);
    expect(manualRouteKey(su)).not.toBe(manualRouteKey(giu));

    const soloGiu = posa(circuito(dueSorgenti), [giu]).circuitJson as El[];
    expect(piste(soloGiu).map((p) => [p.pcb_trace_id, percorso(p)])).toEqual([["t_su", "top -10;0 > top -10;3"], ["t_giu", "top -10;0 > top -10;-4"]]);
    const tutte = posa(circuito(dueSorgenti), [giu, su]);
    expect(piste(tutte.circuitJson).map((p) => [p.pcb_trace_id, percorso(p)])).toEqual([["t_su", "top -10;0 > top -10;4"], ["t_giu", "top -10;0 > top -10;-4"]]);
    expect(tutte.rame).toEqual({ orfane: { routes: [], vias: [] }, assorbite: { routes: [], vias: [] } });
    // twice, and with the corrections the other way round: the same board
    expect(posa(tutte.circuitJson as El[], [su, giu]).circuitJson).toEqual(tutte.circuitJson);
    // in the file, the second does not erase the first
    expect(applyCopperPatch(emptyManualEdits(), { routes: [su, giu], vias: [] }).edits.pcb_routes).toEqual([su, giu]);
    // one trace of the files is taken by one correction only: a third for that connection is an orphan
    const terza = correzione(GND_R1, [top(-10, 0), top(-7, 0)], [top(-10, 0), top(-7, 1)]);
    expect(posa(circuito(dueSorgenti), [giu, su, terza]).rame.orfane.routes).toEqual([manualRouteKey(terza)]);
  });

  it("the vias of the replaced trace go with it, unless another trace uses them", () => {
    const condivisa: El[] = [
      trace("t_a", "st_GND_0", [wire(-10, 0), wire(-5, 0), { route_type: "via", x: -5, y: 0, from_layer: "top", to_layer: "bottom" }, wire(-5, 0, "bottom"), wire(-5, -3, "bottom")]),
      trace("t_b", "st_GND_1", [wire(10, 0), wire(-5, 0), { route_type: "via", x: -5, y: 0, from_layer: "top", to_layer: "bottom" }, wire(-5, 0, "bottom"), wire(-5, 3, "bottom")]),
      { type: "pcb_via", pcb_via_id: "v_comune", pcb_trace_id: "t_a", x: -5, y: 0, outer_diameter: 0.45, hole_diameter: 0.2, layers: ["top", "bottom"] },
    ];
    const senzaVia = correzione(GND_R1, [top(-10, 0), top(-5, 0), bottom(-5, 0), bottom(-5, -3)], [top(-10, 0), top(-10, -3)]);
    const conLaCondivisa = posa(circuito(condivisa), [senzaVia]).circuitJson;
    // the hole stays: the other trace still changes layer through it
    expect(vie(conLaCondivisa).map((v) => v.pcb_via_id)).toEqual(["v_comune"]);
    // alone on its hole, the trace takes it away
    const sola = posa(circuito(condivisa.filter((e) => e.pcb_trace_id !== "t_b" || e.type === "pcb_via")), [senzaVia]).circuitJson;
    expect(vie(sola)).toEqual([]);
    // and the one of the files comes back with its size when the correction goes
    const tornata = posa(sola as El[], []).circuitJson;
    expect(vie(tornata).map((v) => [posto(v), v.outer_diameter, v.hole_diameter, v.pcb_trace_id])).toEqual([["-5;0", 0.45, 0.2, "t_a"]]);
    expect(piste(tornata).map(percorso)).toEqual(["top -10;0 > top -5;0 > via -5;0 > bottom -5;0 > bottom -5;-3"]);
  });

  it("a correction whose route is replaced by another of the same connection: the trace of the files comes back first, and the new one takes it", () => {
    const pista = [trace("t_a", "st_GND_0", [wire(-10, 0), wire(-10, 3)])];
    const prima = correzione(GND_R1, [top(-10, 0), top(-10, 3)], [top(-10, 0), top(-10, 4)]);
    const laPrima = posa(circuito(pista), [prima]).circuitJson as El[];
    // another correction, which does not start from the same path: another key
    const altra = correzione(GND_R1, [top(-10, 0), top(-10, 3.5)], [top(-10, 0), top(-10, 5)]);
    const dopo = posa(laPrima, [altra]);
    expect(piste(dopo.circuitJson).map((p) => [p.pcb_trace_id, percorso(p), p.manual_route_id])).toEqual([["t_a", "top -10;0 > top -10;5", manualRouteKey(altra)]]);
    expect(dopo.rame.orfane.routes).toEqual([]);
    // the orphans are asked on the board as it is BEFORE the pass (the fast update does): not an orphan there either
    expect(statoDelRame(laPrima, [altra], []).orfane.routes).toEqual([]);
    expect(idDoppi(dopo.circuitJson)).toBeNull();
  });

  it("a moved via: its net by name, its part and ports by position; moved again it keeps where it came from; an occupied place stops it", () => {
    const conLaVia = circuito([viaDiRete("v_gnd", 0, -6, 1), ...corpoDellaVia(1, 0, -6), viaDiRete("v_sig", 3, -6, 2), ...corpoDellaVia(2, 3, -6)]);
    const mossa: ManualViaMove = { net: "GND", from: { x: 0, y: -6 }, to: { x: 0, y: -4 }, holeDiameter: 0.3, outerDiameter: 0.6, layers: ["top", "bottom"] };
    const una = posa(conLaVia, [], [mossa]).circuitJson as El[];
    expect(vie(una).map((v) => [v.pcb_via_id, posto(v), v.moved_from])).toEqual([["v_gnd", "0;-4", { x: 0, y: -6 }], ["v_sig", "3;-6", undefined]]);
    expect(accantoAllaVia(una)).toEqual([
      { centro: "0;-4", porte: ["0;-4", "0;-4", "0;-4"] },
      { centro: "3;-6", porte: ["3;-6", "3;-6", "3;-6"] },
    ]);
    // the via of another net in that place is not this entry's via
    expect(posa(conLaVia, [], [{ ...mossa, net: "SIG" }]).rame.orfane.vias).toEqual([viaMoveKey({ ...mossa, net: "SIG" })]);
    // dragged again: the same entry of the file with another `to`, the same via, the same origin
    const due = posa(una, [], [{ ...mossa, to: { x: 1, y: -4 } }]).circuitJson as El[];
    expect(vie(due).map((v) => [v.pcb_via_id, posto(v), v.moved_from])).toEqual([["v_gnd", "1;-4", { x: 0, y: -6 }], ["v_sig", "3;-6", undefined]]);
    expect(accantoAllaVia(due)[0]).toEqual({ centro: "1;-4", porte: ["1;-4", "1;-4", "1;-4"] });
    // the entry gone: back, and the board is the one of the files
    expect(posa(due, [], []).circuitJson).toEqual(conLaVia);

    // a via of the files at both ends: moving one would put two holes in one place. Not laid, and listed
    const dueVie = circuito([viaDiRete("v_gnd", 0, -6, 1), viaDiRete("v_gnd_2", 0, -4, 1)]);
    const ferma = posa(dueVie, [], [mossa]);
    expect(ferma.circuitJson).toBe(dueVie);
    expect(ferma.rame).toEqual({ orfane: { routes: [], vias: [viaMoveKey(mossa)] }, assorbite: { routes: [], vias: [] } });
    expect(findOrphanEdits(dueVie, { ...emptyManualEdits(), pcb_vias: [mossa] })).toMatchObject({ pcb_vias: [viaMoveKey(mossa)], total: 1 });
  });

  it("the moved vias are named by whoever lays the routes: with them the via moves, without them the board is the one that came in", () => {
    // the compile and the fast update both hand applyManualRoutes the two lists of the file (compile.ts, reroute-local.ts)
    const conLaVia = circuito([viaDiRete("v_gnd", 0, -6, 1)]);
    const mossa: ManualViaMove = { net: "GND", from: { x: 0, y: -6 }, to: { x: 0, y: -4 }, holeDiameter: 0.3, outerDiameter: 0.6, layers: ["top", "bottom"] };
    const letti = parseManualEdits(serializeManualEdits({ ...emptyManualEdits(), pcb_vias: [mossa] }));
    expect(vie(applyManualRoutes({ circuitJson: conLaVia, routes: letti.pcb_routes, vias: letti.pcb_vias }).circuitJson).map(posto)).toEqual(["0;-4"]);
    // no list travels hidden with another: routes alone lay no via
    expect(applyManualRoutes({ circuitJson: conLaVia, routes: letti.pcb_routes }).circuitJson).toBe(conLaVia);
  });
});

describe("spinta, salvataggio: a correction laid on the saved board is still a correction", () => {
  /*
   * The saved board is the board WITH the corrections laid, and it is the one
   * every save judges them on (senzaAssorbite, findOrphanEdits). Copper a
   * correction laid must never read as copper the files draw: the correction
   * would leave manual-edits.json as "absorbed", and the next compile would put
   * the copper of the files back with nobody having asked.
   */
  it("laid by the compile and by the fast update, and laid again: never an orphan, never absorbed, the file keeps every one", async () => {
    const edits = conLeCorrezioni({ routes: [massaSpostata, allaViaSpostata], vias: [viaSpostata] });
    const letti = parseManualEdits(edits);
    const { conLeModifiche, compilata, veloce } = await perDueStrade(edits);
    for (const board of [compilata.circuitJson, veloce.circuitJson]) {
      expect(statoDelRame(board, letti.pcb_routes, letti.pcb_vias)).toEqual({ orfane: { routes: [], vias: [] }, assorbite: { routes: [], vias: [] } });
      expect(senzaAssorbite(letti, board)).toBe(letti);
      expect(findOrphanEdits(board, letti).total).toBe(0);
      // a second and a third pass on the board the first one gave
      let scheda = board;
      for (let giro = 0; giro < 2; giro++) {
        const ancora = rerouteLocal(scheda, conLeModifiche, edits);
        scheda = ancora.circuitJson ?? scheda;
        expect(senzaAssorbite(letti, scheda)).toBe(letti);
        expect(findOrphanEdits(scheda, letti).total).toBe(0);
        expect(vie(scheda).map(posto).sort()).toEqual(["-13;-3", "-5;0", "0;-5", "5;0"]);
        expect(pisteDi(scheda, VERSO_MASSA).map(percorso)).toEqual([scritto(MASSA_SPOSTATA)]);
        expect(pisteDi(scheda, ALLA_VIA).map(percorso)).toEqual([scritto(ALLA_VIA_SPOSTATA)]);
        expect(idDoppi(scheda)).toBeNull();
      }
    }
  }, 120_000);
});
