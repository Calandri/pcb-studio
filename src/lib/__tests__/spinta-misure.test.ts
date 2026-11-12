import { beforeAll, describe, expect, it, vi } from "vitest";

/*
 * MEASURES FOR "SPINGI E SPOSTA" (dragging vias and traces in Sposta, phase 0).
 *
 * Measures 1 to 3 test no new behaviour: every case pins a fact of the engine
 * AS IT WAS on origin/main 3affe7c (v0.31.0) that the feature will stand on.
 * They were read on boards compiled for real, not deduced from the code:
 *  1. what a compiled via carries, and how its net NAME is found;
 *  2. what a hand route of manual-edits.json does to a trace the files draw:
 *     it replaces it, it is added next to it, or it is not laid at all;
 *  3. a file trace taken off in the viewer comes back with a compile.
 * Where that behaviour is a defect a later phase corrects, the test says what
 * happens today and a `// FASE n:` comment says what it has to say then: that
 * is the line to change when the phase lands.
 *
 * Measure 6 was such a defect and is corrected (phase 0b, engine 13): a trace
 * or a pad laid by the fast update inside the old pour of another net was seen
 * by no check and went to the export. Its cases now say what happens: the DRC
 * reports it, the summary says it, the export answers 409 until a compile
 * pours again. The geometry of that check is in pours-rame.test.ts.
 *
 * The fixtures lean on one more measured fact: the points of a `pcbPath` are
 * relative to the PART of the anchor pin (the first pin, or the one named by
 * pcbPathRelativeTo), not to the board. R1 is at (-10; 0), so { x: 5, y: 0 }
 * is (-5; 0) on the board.
 */
type El = Record<string, unknown> & { type: string };
type Punto = { x: number; y: number };

const db = vi.hoisted(() => ({
  row: null as null | { filesHash: string; circuitJson: unknown[]; summary: unknown; createdAt: string; engineVersion: number; base?: unknown },
  files: {} as Record<string, string>,
  saves: [] as Array<{ hash: string; circuitJson: unknown[]; summary: unknown; engine: number }>,
}));

vi.mock("@/lib/acl", () => ({ requireProjectAccess: vi.fn(async () => ({ viewer: null, ok: true })) }));
vi.mock("@/lib/agent-tools", () => ({ withLibrary: vi.fn(async (f: Record<string, string>) => f) }));
vi.mock("@/lib/project-store", async (originale) => {
  const vero = await originale<typeof import("@/lib/project-store")>();
  return {
    ...vero,
    getProject: vi.fn(async () => db.files),
    getCompileCache: vi.fn(async () => db.row),
    saveCompileCache: vi.fn(async (_p: string, hash: string, circuitJson: unknown[], summary: unknown, engine: number) => {
      db.saves.push({ hash, circuitJson, summary, engine });
      return { saved: true };
    }),
  };
});

import JSZip from "jszip";
import { GET as esporta } from "@/app/api/export/route";
import { POST as aggiornaVeloce } from "@/app/api/reroute-local/route";
import { boardBaseOf } from "@/lib/board-base";
import { compileProject } from "@/lib/compile";
import { DESIGN_RULES_PATH, resolveDesignRules } from "@/lib/design-rules";
import { colateSopraIlRame, runDrcChecks } from "@/lib/drc";
import { idDoppi } from "@/lib/duplicate-ids";
import { CHECKS_ENGINE_VERSION, nonCertificata } from "@/lib/engine-version";
import { planFastUpdate } from "@/lib/fast-update";
import { MANUAL_EDITS_PATH, serializeManualEdits } from "@/lib/manual-edits";
import { filesHash } from "@/lib/project-store";
import { rerouteLocal } from "@/lib/reroute-local";
import { deleteTrace } from "@/lib/trace-edit";

const REGOLE = JSON.stringify({
  preset: "custom",
  rules: { minTraceWidthMm: 0.15, minClearanceMm: 0.15, pourClearanceMm: 0.2, autoPlaneVias: false, autoroute: false },
});

/** a board drawn in its files: a trace between two pins with two vias, a trace toward a net with one, a lone <via> */
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
const FRA_PIEDINI = ".R1 > .pin2 to .R2 > .pin1";
const VERSO_MASSA = ".R1 > .pin1 to net.GND";

const mm = (v: unknown) => Math.round(Number(v) * 1e4) / 1e4;
const posto = (e: Record<string, unknown>) => `${mm(e.x)};${mm(e.y)}`;
const piste = (cj: unknown[]) => (cj as El[]).filter((e) => e.type === "pcb_trace");
const vie = (cj: unknown[]) => (cj as El[]).filter((e) => e.type === "pcb_via");
/** the path of a trace as it is read: the layer of every point, "via" where it changes face */
const percorso = (e: El) =>
  ((e.route as Array<Record<string, unknown>> | undefined) ?? []).map((p) => `${p.route_type === "via" ? "via" : p.layer} ${posto(p)}`).join(" > ");
/** the traces of one connection, found by the name the files give it: ids are positional and are never relied on */
const pisteDi = (cj: unknown[], connessione: string) => {
  const sorgente = (cj as El[]).find((e) => e.type === "source_trace" && e.display_name === connessione);
  return sorgente ? piste(cj).filter((e) => e.source_trace_id === sorgente.source_trace_id) : [];
};
/** the copper of a board for what it is: every path and every hole, in order */
const rame = (cj: unknown[]) => ({ piste: piste(cj).map(percorso).sort(), vie: vie(cj).map(posto).sort() });
const conLeRoute = (routes: unknown[]) => JSON.stringify({ schematic_placements: [], pcb_placements: [], manual_trace_hints: [], pcb_routes: routes });

/**
 * THE NAME OF THE NET OF A VIA, the least that finds it. A compiled via has no
 * name and no net id of its own; it says its net in two ways:
 *  - a `<via connectsTo="net.X">` carries the id of the net in `pcb_trace_id`;
 *  - every via carries the connectivity key it shares with its net.
 * Null when the via is on copper that no named net holds (a trace between two
 * pins): there is no name to give.
 */
const reteDellaVia = (cj: unknown[], via: Record<string, unknown>): string | null => {
  const reti = (cj as El[]).filter((e) => e.type === "source_net");
  const chiave = via.subcircuit_connectivity_map_key;
  const rete =
    reti.find((n) => n.source_net_id === via.pcb_trace_id) ??
    reti.find((n) => typeof chiave === "string" && chiave !== "" && n.subcircuit_connectivity_map_key === chiave);
  return rete ? String(rete.name) : null;
};

let base: El[] = [];
beforeAll(async () => {
  base = (await compileProject(FILES)).circuitJson as El[];
}, 120_000);

describe("spinta, misura 1: what a compiled via carries", () => {
  it("a <via> and a via inside a pcbPath carry a position, a size and a connectivity key, never a name or a net id", () => {
    expect(vie(base).map(posto).sort()).toEqual(["-12;-3", "-5;0", "0;-6", "5;0"]);
    for (const v of vie(base)) {
      for (const campo of ["pcb_via_id", "x", "y", "hole_diameter", "outer_diameter", "layers", "from_layer", "to_layer", "subcircuit_connectivity_map_key", "pcb_trace_id"]) {
        expect(v, `${posto(v)}: ${campo}`).toHaveProperty(campo);
      }
      for (const campo of ["name", "source_net_id", "source_trace_id", "pcb_component_id", "source_component_id", "source_manually_placed_via_id"]) {
        expect(v, `${posto(v)}: ${campo}`).not.toHaveProperty(campo);
      }
    }
    // the name the file gives the via (V1) is nowhere in the circuit
    expect(JSON.stringify(base)).not.toContain('"V1"');
  });

  it("`pcb_trace_id` is the id of the NET on a <via connectsTo>, and the id of the trace on a via inside a pcbPath", () => {
    const gnd = base.find((e) => e.type === "source_net" && e.name === "GND")!;
    const isolata = vie(base).find((v) => posto(v) === "0;-6")!;
    expect(String(isolata.pcb_trace_id)).toMatch(/^source_net_\d+$/);
    expect(isolata.pcb_trace_id).toBe(gnd.source_net_id);
    expect(isolata.subcircuit_connectivity_map_key).toBe(gnd.subcircuit_connectivity_map_key);

    const [versoMassa] = pisteDi(base, VERSO_MASSA);
    const nellaPistaDiMassa = vie(base).find((v) => posto(v) === "-12;-3")!;
    expect(nellaPistaDiMassa.pcb_trace_id).toBe(versoMassa.pcb_trace_id);
    expect(nellaPistaDiMassa.subcircuit_connectivity_map_key).toBe(gnd.subcircuit_connectivity_map_key);

    const [fraPiedini] = pisteDi(base, FRA_PIEDINI);
    const sorgente = base.find((e) => e.type === "source_trace" && e.display_name === FRA_PIEDINI)!;
    for (const v of vie(base).filter((x) => ["-5;0", "5;0"].includes(posto(x)))) {
      expect(v.pcb_trace_id).toBe(fraPiedini.pcb_trace_id);
      // the key is the one of the connection: the trace itself carries none
      expect(v.subcircuit_connectivity_map_key).toBe(sorgente.subcircuit_connectivity_map_key);
    }
    expect(fraPiedini).not.toHaveProperty("subcircuit_connectivity_map_key");
  });

  it("a <via> also leaves a `source_manually_placed_via` with no name and an empty net id, tied to the hole by position alone", () => {
    const sorgenti = base.filter((e) => e.type === "source_manually_placed_via");
    expect(sorgenti).toHaveLength(1);
    expect(sorgenti[0]).not.toHaveProperty("name");
    expect(sorgenti[0].source_net_id).toBe("");
    // it is a part of the board, with three ports where the hole is: nothing on the pcb_via names it
    const corpo = base.find((e) => e.type === "pcb_component" && e.source_component_id === sorgenti[0].source_manually_placed_via_id)!;
    expect(corpo.center).toEqual({ x: 0, y: -6 });
    const porte = base.filter((e) => e.type === "pcb_port" && e.pcb_component_id === corpo.pcb_component_id);
    expect(porte.map(posto)).toEqual(["0;-6", "0;-6", "0;-6"]);
    // FASE 2: a `pcb_vias` correction moves the pcb_via; this part and its three ports have to travel with it
    // (found by position), or the board keeps a part of 0.3 x 0.3 mm and three ports where the hole was.
  });

  it("the NAME of the net is found from the via alone: by `pcb_trace_id` or by the connectivity key", () => {
    const isolata = vie(base).find((v) => posto(v) === "0;-6")!;
    const nellaPistaDiMassa = vie(base).find((v) => posto(v) === "-12;-3")!;
    expect(reteDellaVia(base, isolata)).toBe("GND");
    expect(reteDellaVia(base, nellaPistaDiMassa)).toBe("GND");
    // each of the two roads is enough for a <via connectsTo>
    expect(reteDellaVia(base, { ...isolata, subcircuit_connectivity_map_key: undefined })).toBe("GND");
    expect(reteDellaVia(base, { ...isolata, pcb_trace_id: undefined })).toBe("GND");
    // for a via inside a path only the key says the net: its `pcb_trace_id` is a trace
    expect(reteDellaVia(base, { ...nellaPistaDiMassa, subcircuit_connectivity_map_key: undefined })).toBeNull();
    // and a via on a trace between two pins has no named net at all
    for (const v of vie(base).filter((x) => ["-5;0", "5;0"].includes(posto(x)))) expect(reteDellaVia(base, v)).toBeNull();
    // FASE 2: `pcb_vias` keys a via by the NAME of its net and where the files put it. That holds for a
    // <via connectsTo> and for a via on a named net; a via inside the path of a trace between two pins
    // has no name to be keyed by, and travels with the `replaces` route of its trace.
  });
});

describe("spinta, misura 2: a hand route on a connection the files draw", () => {
  /** a route as Instrada writes it: two pads of the net, on the connection of the file's trace toward the net */
  const ramoDiMassa = {
    connection: VERSO_MASSA,
    from: ".R1 > .pin1",
    to: ".R3 > .pin1",
    width: 0.2,
    points: [{ x: -10.51, y: 0, layer: "top" }, { x: -13, y: 0, layer: "top" }, { x: -13, y: -4, layer: "top" }],
  };
  /** a route between the two pins the file's trace joins */
  const fraPiedini = {
    connection: FRA_PIEDINI,
    from: ".R1 > .pin2",
    to: ".R2 > .pin1",
    width: 0.2,
    points: [
      { x: -9.49, y: 0, layer: "top" },
      { x: -7, y: 0, layer: "top" },
      { x: -4, y: 3, layer: "top" },
      { x: 4, y: 3, layer: "top" },
      { x: 7, y: 0, layer: "top" },
      { x: 9.49, y: 0, layer: "top" },
    ],
  };

  it("a file trace toward a net compiles, is named by part, pin and net, and ends where its path ends", () => {
    const sorgente = base.find((e) => e.type === "source_trace" && e.display_name === VERSO_MASSA)!;
    expect(sorgente.connected_source_port_ids).toHaveLength(1);
    expect(sorgente.connected_source_net_ids).toHaveLength(1);
    // from the pad of R1.pin1 through the points of the path: no pad at the other end
    expect(pisteDi(base, VERSO_MASSA).map(percorso)).toEqual(["top -10.51;0 > top -12;0 > top -12;-3 > via -12;-3 > bottom -12;-3 > bottom -12;-5"]);
    expect(pisteDi(base, FRA_PIEDINI).map(percorso)).toEqual(["top -9.49;0 > top -5;0 > via -5;0 > bottom -5;0 > bottom 5;0 > via 5;0 > top 5;0 > top 9.49;0"]);
  });

  it("toward a net the route is ADDED to the file's trace, between two pins it REPLACES it; no id is doubled either way, and the export takes the board", async () => {
    const edits = conLeRoute([ramoDiMassa, fraPiedini]);
    const files = { ...FILES, [MANUAL_EDITS_PATH]: edits };
    const compilata = await compileProject(files);
    const veloce = rerouteLocal(base, files, edits);
    expect(veloce.result).toMatchObject({ ok: true, manualRoutes: 1, manualBranches: 1 });
    // the compile and the fast update lay the same copper, and laying it twice changes nothing
    expect(rame(veloce.circuitJson!)).toEqual(rame(compilata.circuitJson));
    expect(rame(rerouteLocal(veloce.circuitJson!, files, edits).circuitJson!)).toEqual(rame(compilata.circuitJson));

    for (const scheda of [compilata.circuitJson, veloce.circuitJson!]) {
      // toward the net: the trace of the files AND the route, two traces of one connection
      const diMassa = pisteDi(scheda, VERSO_MASSA);
      expect(diMassa.map((p) => [p.pcb_trace_id, p.manual === true])).toEqual([
        [pisteDi(base, VERSO_MASSA)[0].pcb_trace_id, false],
        ["pcb_trace_manual_branch_0", true],
      ]);
      expect(diMassa.map(percorso)).toEqual([
        "top -10.51;0 > top -12;0 > top -12;-3 > via -12;-3 > bottom -12;-3 > bottom -12;-5",
        "top -10.51;0 > top -13;0 > top -13;-4",
      ]);
      // FASE 2: a correction with `replaces` on this trace leaves ONE trace for the connection, the route's.
      // And `idDoppi` is no guard for this: it is null today too, the added copper has an id of its own.
      expect(idDoppi(scheda)).toBeNull();

      // between two pins: the route alone, with the id of the trace it replaced, and the vias of that trace gone
      const fra = pisteDi(scheda, FRA_PIEDINI);
      expect(fra.map((p) => [p.pcb_trace_id, p.manual])).toEqual([[pisteDi(base, FRA_PIEDINI)[0].pcb_trace_id, true]]);
      expect(fra.map(percorso)).toEqual(["top -9.49;0 > top -7;0 > top -4;3 > top 4;3 > top 7;0 > top 9.49;0"]);
      expect(vie(scheda).map(posto).sort()).toEqual(["-12;-3", "0;-6"]);
      // FASE 2: unchanged. A route between the two pins of a file trace already replaces it.
    }

    // the board with the trace toward the net drawn twice is exported as it is
    db.files = files;
    db.row = { filesHash: filesHash(files), circuitJson: compilata.circuitJson, summary: compilata.summary, createdAt: "2026-11-12T10:00:00.000Z", engineVersion: CHECKS_ENGINE_VERSION, base: boardBaseOf(files) };
    // no check names the doubled trace. What the export does refuse on this board is another thing: R3.pin1 and the
    // via V1 are ground with no copper to the rest of the ground, and a board with an open connection does not go
    // (engine 13, aperti-export.ts)
    const esito = await esporta(new Request("http://x/api/export?projectId=p&kind=gerber"));
    expect(esito.status).toBe(409);
    const { reason } = (await esito.json()) as { reason: string };
    expect(reason).toMatch(/^\d+ collegament[oi] apert[oi] su 1 rete: GND \(/);
    expect(reason).not.toMatch(/doppio|colata/);
    // FASE 2: nothing to say about the trace toward the net any more, the doubled trace cannot be made.
  }, 120_000);

  it("taking the replacing route away again does NOT bring the file's trace back in the fast update: only a compile does", () => {
    const conLaRoute = { ...FILES, [MANUAL_EDITS_PATH]: conLeRoute([fraPiedini]) };
    const sostituita = planFastUpdate({ filesHash: filesHash(FILES), base: boardBaseOf(FILES), circuitJson: base }, conLaRoute, conLaRoute);
    if (sostituita.kind !== "save") throw new Error(`fast update: ${sostituita.kind}`);
    expect(pisteDi(sostituita.board, FRA_PIEDINI).map(percorso)).toEqual(["top -9.49;0 > top -7;0 > top -4;3 > top 4;3 > top 7;0 > top 9.49;0"]);

    // Cmd+Z, or "rilascia le piste": manual-edits.json is as it was before the route
    const annullata = planFastUpdate({ filesHash: filesHash(conLaRoute), base: boardBaseOf(conLaRoute), circuitJson: sostituita.board }, FILES, FILES);
    if (annullata.kind !== "save") throw new Error(`fast update: ${annullata.kind}`);
    // the hand copper goes, and the trace of the files is not on the saved board any more: the connection is open
    expect(pisteDi(annullata.board, FRA_PIEDINI)).toEqual([]);
    expect(vie(annullata.board).map(posto).sort()).toEqual(["-12;-3", "0;-6"]);
    // FASE 2: undoing or releasing a correction gives back the copper of the files in the fast update itself (one
    // gesture is one step of undo, with no "Aggiorna"): the path of the files, as in `base`, and its two vias.
  });

  it("a route keyed by its connection alone (no pads) REPLACES the file's trace, toward a net too", () => {
    // the shape of the entries written before the pad fields: still read, and what `replaces` can build on
    const soloConnessione = {
      connection: VERSO_MASSA,
      width: 0.2,
      points: [{ x: -10.51, y: 0, layer: "top" }, { x: -13, y: 0, layer: "top" }, { x: -13, y: -4, layer: "top" }, { x: -13, y: -4, layer: "bottom" }, { x: -13, y: -5, layer: "bottom" }],
    };
    const edits = conLeRoute([soloConnessione]);
    const veloce = rerouteLocal(base, { ...FILES, [MANUAL_EDITS_PATH]: edits }, edits);
    expect(veloce.result).toMatchObject({ ok: true, manualRoutes: 1, manualBranches: 0 });
    const diMassa = pisteDi(veloce.circuitJson!, VERSO_MASSA);
    expect(diMassa.map((p) => [p.pcb_trace_id, p.manual])).toEqual([[pisteDi(base, VERSO_MASSA)[0].pcb_trace_id, true]]);
    expect(diMassa.map(percorso)).toEqual(["top -10.51;0 > top -13;0 > top -13;-4 > via -13;-4 > bottom -13;-4 > bottom -13;-5"]);
    expect(idDoppi(veloce.circuitJson!)).toBeNull();
    // the via of the file's trace went with it; the route's own is hand copper, with the key of its net and no `pcb_trace_id`
    expect(vie(veloce.circuitJson!).map(posto).sort()).toEqual(["-13;-4", "-5;0", "0;-6", "5;0"]);
    const aMano = vie(veloce.circuitJson!).find((v) => posto(v) === "-13;-4")!;
    expect(aMano).toMatchObject({ pcb_via_id: "pcb_via_manual_0", manual: true });
    expect(aMano).not.toHaveProperty("pcb_trace_id");
    expect(reteDellaVia(veloce.circuitJson!, aMano)).toBe("GND");
  });

  it("a route whose second end is the net itself (`to: net.GND`) is not laid: it is an orphan", () => {
    const edits = conLeRoute([{ ...ramoDiMassa, to: "net.GND" }]);
    const veloce = rerouteLocal(base, { ...FILES, [MANUAL_EDITS_PATH]: edits }, edits);
    expect(veloce.result.orphans.pcb_routes).toEqual([".R1 > .pin1 ~ net.GND"]);
    expect(veloce.result).toMatchObject({ ok: true, manualRoutes: 0, manualBranches: 0 });
    expect(rame(veloce.circuitJson!)).toEqual(rame(base));
  });
});

describe("spinta, misura 3: a file trace taken off in the viewer", () => {
  it("leaves the saved board with its vias, writes nothing in manual-edits.json, and comes back with a compile from the files", async () => {
    const [pista] = pisteDi(base, FRA_PIEDINI);
    const tolta = deleteTrace(base, String(pista.pcb_trace_id), undefined)!;
    expect(tolta.connection).toBe(FRA_PIEDINI);
    expect(pisteDi(tolta.circuitJson, FRA_PIEDINI)).toEqual([]);
    expect(vie(tolta.circuitJson).map(posto).sort()).toEqual(["-12;-3", "0;-6"]);
    // nothing remembers it: the file of the hand edits is as it was
    expect(tolta.editsChanged).toBe(false);
    expect(tolta.edits.pcb_routes).toEqual([]);

    // the fast update leaves the board as it is: the trace stays off
    const piano = planFastUpdate({ filesHash: filesHash(FILES), base: boardBaseOf(FILES), circuitJson: tolta.circuitJson }, FILES, FILES);
    expect(piano.kind).toBe("unchanged");

    // "Aggiorna": the files, the hand edits as deleteTrace leaves them, the saved board in hand
    const files = { ...FILES, [MANUAL_EDITS_PATH]: serializeManualEdits(tolta.edits) };
    const aggiornata = await compileProject(files, { keepCopperFrom: tolta.circuitJson });
    expect(rame(aggiornata.circuitJson)).toEqual(rame(base));
    expect(pisteDi(aggiornata.circuitJson, FRA_PIEDINI)).toHaveLength(1);
    // FASE 2: a route with `replaces` and no points is what takes a file trace off for good (the compile leaves the
    // connection without copper and counts it among the open ones). It is laid out there and NOT wired to this
    // gesture: until it is, this test keeps saying that the trace comes back.
  }, 120_000);
});

describe("spinta, misura 6: copper laid by the fast update inside the old pour of another net", () => {
  /*
   * A ground pour over the whole top face and a strip of VBUS drawn by hand
   * between R3.pin2 and R4.pin1. The pads are 0402: 0.54 x 0.64 mm, at 0.51 mm
   * either side of the part. R1.pin1 is ground; R1.pin2 and R2.pin1 are one
   * connection with no copper yet; R2.pin2 is on SIG.
   */
  const CON_COLATA = `export default () => (
  <board width="30mm" height="16mm">
    <net name="GND" />
    <net name="VBUS" />
    <net name="SIG" />
    <copperpour layer="top" connectsTo="net.GND" />
    <copperpour layer="top" connectsTo="net.VBUS" outline={[{ x: -2.6, y: 4.75 }, { x: 2.6, y: 4.75 }, { x: 2.6, y: 5.25 }, { x: -2.6, y: 5.25 }]} />
    <resistor name="R1" resistance="1k" footprint="0402" pcbX={-8} pcbY={0} />
    <resistor name="R2" resistance="1k" footprint="0402" pcbX={8} pcbY={0} />
    <resistor name="R3" resistance="1k" footprint="0402" pcbX={-3} pcbY={5} />
    <resistor name="R4" resistance="1k" footprint="0402" pcbX={3} pcbY={5} />
    <trace from=".R1 > .pin1" to="net.GND" />
    <trace from=".R1 > .pin2" to=".R2 > .pin1" />
    <trace from=".R2 > .pin2" to="net.SIG" />
    <trace from=".R3 > .pin2" to="net.VBUS" />
    <trace from=".R4 > .pin1" to="net.VBUS" />
  </board>
)
`;
  const files: Record<string, string> = { "main.tsx": CON_COLATA, [DESIGN_RULES_PATH]: REGOLE };
  const dentro = (x: number, y: number, a: Punto[]) => {
    let d = false;
    for (let i = 0, j = a.length - 1; i < a.length; j = i++) if (a[i].y > y !== a[j].y > y && x < ((a[j].x - a[i].x) * (y - a[i].y)) / (a[j].y - a[i].y) + a[i].x) d = !d;
    return d;
  };
  const colate = (cj: unknown[]) => (cj as El[]).filter((e) => e.type === "pcb_copper_pour");
  /** whether a point of the top face is in the copper of a pour of that net */
  const nelRame = (cj: unknown[], rete: string, x: number, y: number) => {
    const net = (cj as El[]).find((e) => e.type === "source_net" && e.name === rete)!;
    return colate(cj).some((c) => {
      const b = c.brep_shape as { outer_ring: { vertices: Punto[] }; inner_rings?: Array<{ vertices: Punto[] }> };
      return c.layer === "top" && c.source_net_id === net.source_net_id && dentro(x, y, b.outer_ring.vertices) && !(b.inner_rings ?? []).some((r) => dentro(x, y, r.vertices));
    });
  };
  const delleColate = (drc: Array<{ rule: string }>) => drc.filter((d) => /pour|plane/.test(d.rule));
  type Riepilogo = { drcViolations: Array<{ rule: string; message: string; points?: Array<{ x: number; y: number; layer?: string }> }>; planesOverVias?: unknown; poursTooClose?: unknown; poursOverCopper?: { count: number; detail: string } };
  const riga = (hash: string, circuitJson: unknown[], summary: unknown, engine: number, deiFile: Record<string, string>) => ({
    filesHash: hash,
    circuitJson,
    summary,
    createdAt: "2026-11-12T10:00:00.000Z",
    engineVersion: engine,
    base: boardBaseOf(deiFile),
  });
  const esportaCome = (kind: string) => esporta(new Request(`http://x/api/export?projectId=p&kind=${kind}`));
  /** the reason of a refused export, and that it is a refusal */
  const motivoDelRifiuto = async (kind: string): Promise<string> => {
    const r = await esportaCome(kind);
    expect(r.status, kind).toBe(409);
    return ((await r.json()) as { reason: string }).reason;
  };
  /** a refusal that speaks of open connections alone: no pour, no doubled id */
  const SOLO_APERTI = /^\d+ collegament[oi] apert[oi] su \d+ ret[ei]: (?!.*(colata|doppio)).*NON e' certificata per l'export finche' ha collegamenti aperti/;
  /** the fast update of the saved board `prima` after the hand edits changed: what it saved */
  const conLAggiornamentoVeloce = async (edits: string) => {
    const conLeModifiche = { ...files, [MANUAL_EDITS_PATH]: edits };
    db.files = conLeModifiche;
    db.saves = [];
    db.row = riga(filesHash(files), prima.circuitJson, prima.summary, CHECKS_ENGINE_VERSION, files);
    const risposta = (await (await aggiornaVeloce(new Request("http://x/api/reroute-local", { method: "POST", body: JSON.stringify({ projectId: "p" }) }))).json()) as {
      ok: boolean;
      manualRoutes?: number;
      summary: Riepilogo;
    };
    const [salvata] = db.saves;
    // filed under today's engine, as the board of these files
    expect(salvata.engine).toBe(CHECKS_ENGINE_VERSION);
    expect(salvata.hash).toBe(filesHash(conLeModifiche));
    // the pours are the ones of before: the fast update never pours
    expect(colate(salvata.circuitJson)).toEqual(colate(prima.circuitJson));
    return { conLeModifiche, risposta, salvata, riepilogo: salvata.summary as Riepilogo };
  };
  const PERCHE = "La scheda NON e' certificata per l'export finche' una colata copre il rame di un'altra rete: premi Aggiorna per rifare le colate, e se quel rame resta nella colata sposta lui o la colata";

  let prima: Awaited<ReturnType<typeof compileProject>>;
  beforeAll(async () => {
    prima = await compileProject(files);
  }, 120_000);

  it("a board just compiled has nothing to say: a ground pad in the ground pour and the pads a declared strip joins are where the pour belongs", async () => {
    const gnd = (prima.circuitJson as El[]).find((e) => e.type === "source_net" && e.name === "GND")!;
    const vbus = (prima.circuitJson as El[]).find((e) => e.type === "source_net" && e.name === "VBUS")!;
    expect(colate(prima.circuitJson).map((c) => [c.layer, c.source_net_id])).toEqual([["top", gnd.source_net_id], ["top", vbus.source_net_id]]);
    // R1.pin1 (-8.51; 0), a ground pad, is IN the copper of the ground pour: its own net
    expect(nelRame(prima.circuitJson, "GND", -8.51, 0)).toBe(true);
    // R3.pin2 (-2.49; 5) and R4.pin1 (2.49; 5), the pads of VBUS, are IN the copper of the VBUS strip that joins them
    expect(nelRame(prima.circuitJson, "VBUS", -2.49, 5)).toBe(true);
    expect(nelRame(prima.circuitJson, "VBUS", 2.49, 5)).toBe(true);
    // and the ground pour opened around everything of the other nets: nothing to report, nothing to refuse
    expect(delleColate(runDrcChecks(prima.circuitJson as never, resolveDesignRules(files).rules))).toEqual([]);
    expect(delleColate(prima.summary.drcViolations)).toEqual([]);
    expect(prima.summary.poursOverCopper).toBeUndefined();
    expect(colateSopraIlRame(prima.circuitJson as never)).toBeUndefined();
    expect(nonCertificata(prima.summary)).toBeNull();
    db.files = files;
    db.row = riga(filesHash(files), prima.circuitJson, prima.summary, CHECKS_ENGINE_VERSION, files);
    // the export has nothing to say about the pours. It stops this board for the connections its files leave without
    // copper, which is another refusal (engine 13, aperti-export.ts)
    expect(await motivoDelRifiuto("gerber")).toMatch(SOLO_APERTI);
  }, 120_000);

  it("a trace drawn across the ground pour: the DRC says it, the summary says it, the export answers 409 with the trace and the layer, and 200 again after a compile", async () => {
    expect(nelRame(prima.circuitJson, "GND", 0, 0)).toBe(true);
    // the trace between R1.pin2 and R2.pin1 (not ground), drawn by hand straight across the ground pour
    const edits = conLeRoute([
      { connection: FRA_PIEDINI, from: ".R1 > .pin2", to: ".R2 > .pin1", width: 0.2, points: [{ x: -7.49, y: 0, layer: "top" }, { x: 7.49, y: 0, layer: "top" }] },
    ]);
    const { conLeModifiche: conLaPista, risposta, salvata, riepilogo } = await conLAggiornamentoVeloce(edits);
    expect(risposta).toMatchObject({ ok: true, manualRoutes: 1 });

    // the trace is on the board and runs in the copper of the old ground pour: a short
    expect(pisteDi(salvata.circuitJson, FRA_PIEDINI).map(percorso)).toEqual(["top -7.49;0 > top 7.49;0"]);
    expect(nelRame(salvata.circuitJson, "GND", 0, 0)).toBe(true);
    expect(nelRame(salvata.circuitJson, "GND", 3, 0)).toBe(true);

    // the DRC names the trace by its connection, the pour and the layer. The dot is where the trace enters the copper:
    // it leaves the pad of R1.pin2 (centre -7.49, half as wide as 0.54) and the pour starts 0.2 mm after the pad,
    // -7.49 + 0.27 + 0.2 = -7.02, on the top face
    const drc = delleColate(runDrcChecks(salvata.circuitJson as never, resolveDesignRules(conLaPista).rules)) as Riepilogo["drcViolations"];
    expect(drc).toHaveLength(1);
    expect(drc[0].rule).toBe("pour_clearance");
    expect(drc[0].message).toMatch(/^pcb_trace\S+ \(\.R1 > \.pin2 to \.R2 > \.pin1\) <-> GND pour on top: 0\.000mm < min 0\.2mm \(the trace is in the copper of the pour: a short\)$/);
    expect(drc[0].points).toHaveLength(1);
    expect(drc[0].points![0].x).toBeCloseTo(-7.02, 3);
    expect(drc[0].points![0].y).toBeCloseTo(0, 6);
    expect(drc[0].points![0].layer).toBe("top");
    expect(delleColate(riepilogo.drcViolations)).toEqual(drc);

    // the summary says it apart, in words, and so does the answer of the fast update
    const detto = {
      count: 1,
      detail:
        "1 pista sta nel rame di una colata di un'altra rete (la pista .R1 > .pin2 to .R2 > .pin1 nella colata GND su top): e' un corto",
    };
    expect(riepilogo.poursOverCopper).toEqual(detto);
    expect(risposta.summary.poursOverCopper).toEqual(detto);
    expect(colateSopraIlRame(salvata.circuitJson as never)).toEqual(detto);
    expect(riepilogo.planesOverVias).toBeUndefined();
    expect(riepilogo.poursTooClose).toBeUndefined();
    expect(nonCertificata(riepilogo)).toBe(`${detto.detail}. ${PERCHE}`);

    // and the board does not go to the factory: the export measures the board itself and says which trace, where and what to do
    db.row = riga(salvata.hash, salvata.circuitJson, salvata.summary, salvata.engine, conLaPista);
    for (const kind of ["gerber", "pnp"]) {
      const rifiuto = await esportaCome(kind);
      expect(rifiuto.status, kind).toBe(409);
      const { error, reason } = (await rifiuto.json()) as { error: string; reason: string };
      expect(reason).toBe(`${detto.detail}. ${PERCHE}`);
      expect(error).toBe(`ricompila la scheda prima di esportare: ${reason}`);
    }
    // a summary that does not say it changes nothing: the board is measured, the summary is not asked
    db.row = riga(salvata.hash, salvata.circuitJson, prima.summary, salvata.engine, conLaPista);
    expect((await esportaCome("gerber")).status).toBe(409);
    // the bill of materials reads the parts, not the copper: it goes on
    expect((await esportaCome("bom")).status).toBe(200);

    // "Aggiorna": the ground is poured again and keeps away from the trace, and the board goes
    const aggiornata = await compileProject(conLaPista);
    expect(pisteDi(aggiornata.circuitJson, FRA_PIEDINI).map(percorso)).toEqual(["top -7.49;0 > top 7.49;0"]);
    expect(nelRame(aggiornata.circuitJson, "GND", 0, 0)).toBe(false);
    expect(nelRame(aggiornata.circuitJson, "GND", 3, 0)).toBe(false);
    expect(delleColate(aggiornata.summary.drcViolations)).toEqual([]);
    expect(aggiornata.summary.poursOverCopper).toBeUndefined();
    db.row = riga(filesHash(conLaPista), aggiornata.circuitJson, aggiornata.summary, CHECKS_ENGINE_VERSION, conLaPista);
    const gerber = await esportaCome("gerber");
    expect(gerber.status).toBe(200);
    expect((await JSZip.loadAsync(await gerber.arrayBuffer())).file("F_Cu.gbr")).not.toBeNull();
    expect((await esportaCome("pnp")).status).toBe(200);
  }, 120_000);

  it("a part moved in Sposta: its pads land in the old ground pour, the DRC and the summary name them by part and pin, the export answers 409, and 200 again after a compile", async () => {
    // where R2 goes, (8; -4), the old ground pour is whole
    for (const x of [7.49, 8.51]) expect(nelRame(prima.circuitJson, "GND", x, -4)).toBe(true);
    const edits = JSON.stringify({ schematic_placements: [], pcb_placements: [{ selector: "R2", center: { x: 8, y: -4 } }], manual_trace_hints: [], pcb_routes: [] });
    const { conLeModifiche: conLoSpostamento, risposta, salvata, riepilogo } = await conLAggiornamentoVeloce(edits);
    expect(risposta.ok).toBe(true);
    // the two pads of R2 are where the part went, 0.51 mm either side of it: (7.49; -4) and (8.51; -4), in the copper
    const piazzole = (salvata.circuitJson as El[]).filter((e) => e.type === "pcb_smtpad" && Number(e.x) > 0 && Number(e.y) < 0);
    expect(piazzole.map(posto).sort()).toEqual(["7.49;-4", "8.51;-4"]);
    for (const p of piazzole) expect(nelRame(salvata.circuitJson, "GND", Number(p.x), Number(p.y))).toBe(true);

    // one violation per pad, with its dot in the middle of the pad, on the face of the pad and of the pour
    const drc = delleColate(riepilogo.drcViolations) as Riepilogo["drcViolations"];
    expect(drc.map((d) => [d.rule, d.message.replace(/^pcb_smtpad_\d+ /, ""), d.points])).toEqual([
      ["pour_clearance", "(R2.pin1) <-> GND pour on top: 0.000mm < min 0.2mm (the pad is in the copper of the pour: a short)", [{ x: 7.49, y: -4, layer: "top" }]],
      ["pour_clearance", "(R2.pin2) <-> GND pour on top: 0.000mm < min 0.2mm (the pad is in the copper of the pour: a short)", [{ x: 8.51, y: -4, layer: "top" }]],
    ]);
    const detto = {
      count: 2,
      detail:
        "2 piazzole stanno nel rame di una colata di un'altra rete (la piazzola R2.pin1 nella colata GND su top, la piazzola R2.pin2 nella colata GND su top): e' un corto",
    };
    expect(riepilogo.poursOverCopper).toEqual(detto);

    db.row = riga(salvata.hash, salvata.circuitJson, salvata.summary, salvata.engine, conLoSpostamento);
    for (const kind of ["gerber", "pnp"]) {
      const rifiuto = await esportaCome(kind);
      expect(rifiuto.status, kind).toBe(409);
      // the pads in the pour first, then the connection this board leaves open
      const { reason } = (await rifiuto.json()) as { reason: string };
      expect(reason.startsWith(`${detto.detail}. ${PERCHE}. `), reason).toBe(true);
      expect(reason.slice(`${detto.detail}. ${PERCHE}. `.length)).toMatch(SOLO_APERTI);
    }
    expect((await esportaCome("bom")).status).toBe(200);

    // "Aggiorna": the ground opens around R2 where it is now and closes where it was
    const aggiornata = await compileProject(conLoSpostamento);
    for (const x of [7.49, 8.51]) {
      expect(nelRame(aggiornata.circuitJson, "GND", x, -4)).toBe(false);
      expect(nelRame(aggiornata.circuitJson, "GND", x, 0)).toBe(true);
    }
    expect(delleColate(aggiornata.summary.drcViolations)).toEqual([]);
    expect(aggiornata.summary.poursOverCopper).toBeUndefined();
    db.row = riga(filesHash(conLoSpostamento), aggiornata.circuitJson, aggiornata.summary, CHECKS_ENGINE_VERSION, conLoSpostamento);
    // the pours no longer stop it; the connection left open still does
    expect(await motivoDelRifiuto("gerber")).toMatch(SOLO_APERTI);
    expect(await motivoDelRifiuto("pnp")).toMatch(SOLO_APERTI);
  }, 120_000);
});
