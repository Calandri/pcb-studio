import { describe, expect, it } from "vitest";

/*
 * "SPINGI E SPOSTA", PHASE 2: THE SERVER DOES NOT TRUST THE VIEWER.
 *
 * The copper a gesture sends (routes with `replaces`, moved vias) is read
 * within the limits of one save (leggiRame) and then checked against the saved
 * board (verificaRame): every stretch at 0, 45 or 90 degrees and longer than
 * nothing, the copper it starts from still on the board, and no distance
 * broken that held before. The distances are the ones of runDrcChecks, on the
 * board before and after.
 *
 * The boards are written by hand (scheda-di-prova.ts): two parts, R1 with its
 * pads at (-10; 0) and (-9; 0), R2 at (10; 0) and (11; 0); two nets, GND on
 * the first pin of each and SIG on the second. The trace of ground runs above
 * the parts, along y = 5; the one of the signal below them, along y = -3; and
 * a lone via of ground stands at (0; -6).
 */
import { resolveDesignRules } from "@/lib/design-rules";
import { runDrcChecks } from "@/lib/drc";
import { applyCopperPatch, correzioniNuove, emptyManualEdits, type CopperPatch, type ManualEdits } from "@/lib/manual-edits";
import { applyManualRoutes, type ManualRoute, type ManualViaMove } from "@/lib/manual-routes";
import { leggiRame, trattiStorti, verificaRame } from "@/lib/spinta/verifica";
import { colata, pezzo, rete, scheda, trace, via, wire, type El } from "./scheda-di-prova";

const REGOLE = resolveDesignRules({}).rules;
const GND = ".R1 > .1 to net.GND";

type Punto = { x: number; y: number; layer: "top" | "bottom" };
const top = (x: number, y: number): Punto => ({ x, y, layer: "top" });
/** the trace of ground with its long stretch at `y` */
const massaA = (y: number): Punto[] => [top(-10, 0), top(-10, y), top(10, y), top(10, 0)];
const comeRoute = (punti: Punto[]) => punti.map((p) => wire(p.x, p.y, p.layer));
/**
 * A lone via as a compile writes it: with the connectivity key of its net,
 * which is what the DRC knows its net by (a via with `pcb_trace_id` alone is
 * copper of no net to it, and is not measured).
 */
const viaDi = (id: string, x: number, y: number, n: number): El => ({ ...via(id, x, y, n), subcircuit_connectivity_map_key: `chiave_${n}` });

const circuito = (rame: El[] = [], massa: Punto[] = massaA(5)): El[] => [
  scheda(2),
  ...pezzo("R1", [["1", -10, 0], ["2", -9, 0]]),
  ...pezzo("R2", [["1", 10, 0], ["2", 11, 0]]),
  ...rete(1, "GND", ["R1_1", "R2_1"]),
  ...rete(2, "SIG", ["R1_2", "R2_2"]),
  trace("t_gnd", "st_GND_0", comeRoute(massa)),
  trace("t_sig", "st_SIG_0", comeRoute([top(-9, 0), top(-9, -3), top(11, -3), top(11, 0)])),
  viaDi("v_gnd", 0, -6, 1),
  ...rame,
];
const SCHEDA = circuito();

const massaSpostata = (y: number, da = 5): ManualRoute => ({ connection: GND, points: massaA(y), width: 0.2, replaces: { original: massaA(da), width: 0.2 } });
const viaSpostata = (to: { x: number; y: number }, altro: Partial<ManualViaMove> = {}): ManualViaMove => ({
  net: "GND",
  from: { x: 0, y: -6 },
  to,
  holeDiameter: 0.3,
  outerDiameter: 0.6,
  layers: ["top", "bottom"],
  ...altro,
});
const verifica = (rame: Partial<CopperPatch>, circuitJson: El[] = SCHEDA, correnti: ManualEdits = emptyManualEdits()) =>
  verificaRame({ circuitJson, regole: REGOLE, correnti, rame: { routes: [], vias: [], ...rame } });
const distanze = (cj: unknown[]) => runDrcChecks(cj as never, REGOLE).filter((v) => /clearance|hole_to_hole/.test(v.rule));

describe("spinta, verifica: the copper against the saved board", () => {
  it("the board of the test breaks no distance, and copper moved into free space is good", () => {
    expect(distanze(SCHEDA)).toEqual([]);
    expect(verifica({ routes: [massaSpostata(6)] })).toEqual({ ok: true });
    expect(verifica({ vias: [viaSpostata({ x: 0, y: -7 })] })).toEqual({ ok: true });
    expect(verifica({ routes: [massaSpostata(6)], vias: [viaSpostata({ x: 2, y: -8 })] })).toEqual({ ok: true });
  });

  it("every stretch at 0, 45 or 90 degrees, on whole tenths of a micron, and none of no length", () => {
    const con = (points: Punto[]): ManualRoute => ({ ...massaSpostata(6), points });
    // a diagonal of exactly 45 degrees, down to the fourth decimal
    expect(trattiStorti(con([top(0, 0), top(1.2345, 1.2345), top(1.2345, 3), top(0.2345, 4)]))).toBeNull();
    // one tenth of a micron off the diagonal is not 45 degrees
    expect(trattiStorti(con([top(0, 0), top(1.2345, 1.2346)]))).toBe("il tratto da (0; 0) a (1.2345; 1.2346) non e' a 0, 45 o 90 gradi");
    expect(trattiStorti(con([top(0, 0), top(2, 0), top(2, 0), top(2, 3)]))).toBe("ha un tratto di lunghezza zero in (2; 0)");
    // two numbers that differ under the grid are one place: a stretch of no length all the same
    expect(trattiStorti(con([top(0, 0), top(2, 0), top(2.00004, 0)]))).toBe("ha un tratto di lunghezza zero in (2; 0)");
    // a change of layer is a via, in one place
    expect(trattiStorti(con([top(0, 0), top(2, 0), { x: 2, y: 0, layer: "bottom" }, { x: 2, y: 3, layer: "bottom" }]))).toBeNull();
    expect(trattiStorti(con([top(0, 0), { x: 2, y: 0, layer: "bottom" }]))).toBe("cambia strato fra (0; 0) e (2; 0): una via sta in un punto solo");
    // a route with no points only takes the trace out: nothing to judge
    expect(trattiStorti(con([]))).toBeNull();

    expect(verifica({ routes: [con([top(-10, 0), top(-10, 5), top(10, 6), top(10, 0)])] })).toEqual({
      ok: false,
      motivo: `la pista ${GND} il tratto da (-10; 5) a (10; 6) non e' a 0, 45 o 90 gradi`,
    });
    expect(verifica({ routes: [con([top(-10, 0), top(-10, 6), top(-10, 6), top(10, 6), top(10, 0)])] })).toEqual({
      ok: false,
      motivo: `la pista ${GND} ha un tratto di lunghezza zero in (-10; 6)`,
    });
  });

  it("a stretch the files already drew a hair off 45 degrees is a given; one the correction lays answers for itself", () => {
    // the sources write a diagonal with rounded ends: (-10; 5) to (-8; 7.0001), one tenth of a micron off
    const deiFile: Punto[] = [top(-10, 0), top(-10, 5), top(-8, 7.0001), top(10, 7.0001), top(10, 0)];
    const scheda = circuito([], deiFile);
    // the long stretch pushed up by one millimetre: the diagonal is where the files put it, untouched
    const spinta: Punto[] = [top(-10, 0), top(-10, 5), top(-8, 7.0001), top(-7, 8.0001), top(9, 8.0001), top(10, 7.0001), top(10, 0)];
    const correzione = (points: Punto[]): ManualRoute => ({ connection: GND, points, width: 0.2, replaces: { original: deiFile, width: 0.2 } });
    expect(trattiStorti(correzione(spinta))).toBe("il tratto da (-10; 5) a (-8; 7.0001) non e' a 0, 45 o 90 gradi");
    expect(verifica({ routes: [correzione(spinta)] }, scheda)).toEqual({ ok: true });
    // the same stretch moved by the correction is no longer a given
    const mossa: Punto[] = [top(-10, 0), top(-10, 4), top(-8, 6.0001), top(-8, 7.0001), top(10, 7.0001), top(10, 0)];
    expect(verifica({ routes: [correzione(mossa)] }, scheda)).toEqual({
      ok: false,
      motivo: `la pista ${GND} il tratto da (-10; 4) a (-8; 6.0001) non e' a 0, 45 o 90 gradi`,
    });
  });

  it("copper that breaks a distance is refused, in the words of the DRC", () => {
    // the trace of ground brought to 0.2 mm from the centre line of the signal's: 0 mm of copper between them
    const vicina = verifica({ routes: [massaSpostata(-2.8)] });
    expect(vicina.ok).toBe(false);
    expect(vicina).not.toHaveProperty("cambiata");
    expect((vicina as { motivo: string }).motivo).toMatch(/^il rame viola una distanza che prima era rispettata: .*t_(gnd|sig).*<-> .*t_(gnd|sig).*mm < min 0\.\d+mm/);
    // the via of ground dropped on the trace of the signal
    const sopra = verifica({ vias: [viaSpostata({ x: 0, y: -3 })] });
    expect(sopra.ok).toBe(false);
    expect((sopra as { motivo: string }).motivo).toMatch(/^il rame viola una distanza che prima era rispettata: .*t_sig/);
    // the same judgement the DRC gives on the board with that copper laid
    const posata = applyManualRoutes({ circuitJson: SCHEDA, routes: [massaSpostata(-2.8)], vias: [] }).circuitJson;
    expect(distanze(posata).map((v) => v.rule)).toContain("trace_trace_clearance");
    // one good correction does not carry a bad one through
    expect(verifica({ routes: [massaSpostata(6)], vias: [viaSpostata({ x: 0, y: -3 })] }).ok).toBe(false);
  });

  it("a distance already broken elsewhere is not this copper's fault; one more is, and so is the same number in another place", () => {
    // a via of the signal half a tenth of a millimetre from the pad of ground of R2: broken before any gesture
    const giaRotta = circuito([viaDi("v_sig", 10.55, -0.55, 2)]);
    expect(distanze(giaRotta).length).toBeGreaterThan(0);
    expect(verifica({ routes: [massaSpostata(6)] }, giaRotta)).toEqual({ ok: true });
    expect(verifica({ routes: [massaSpostata(-2.8)] }, giaRotta).ok).toBe(false);

    // the trace of ground already too close to the signal's: moved away it is good, moved along and still too close it is not
    const giaVicina = circuito([], massaA(-2.8));
    const prima = distanze(giaVicina);
    expect(prima.map((v) => v.rule)).toContain("trace_trace_clearance");
    expect(verifica({ routes: [massaSpostata(6, -2.8)] }, giaVicina)).toEqual({ ok: true });
    const ancoraVicina = applyManualRoutes({ circuitJson: giaVicina, routes: [massaSpostata(-2.75, -2.8)], vias: [] }).circuitJson;
    // as many as before...
    const quante = (v: Array<{ rule: string; count?: number }>) => v.filter((x) => x.rule === "trace_trace_clearance").reduce((n, x) => n + (x.count ?? 1), 0);
    expect(quante(distanze(ancoraVicina))).toBe(quante(prima));
    // ...but not where they were: refused
    expect(verifica({ routes: [massaSpostata(-2.75, -2.8)] }, giaVicina).ok).toBe(false);
  });

  it("copper moved into the old pour of another net is not refused here: it is said after the save and stops the export", () => {
    const conColata = circuito([colata("c_sig", 2, "top", -5, 7, 5, 9)]);
    const dentro = applyManualRoutes({ circuitJson: conColata, routes: [massaSpostata(8)], vias: [] }).circuitJson;
    expect(runDrcChecks(dentro as never, REGOLE).map((v) => v.rule)).toContain("pour_clearance");
    expect(verifica({ routes: [massaSpostata(8)] }, conColata)).toEqual({ ok: true });
  });

  it("the copper the gesture started from is not on the board any more: the board changed, and it is said so", () => {
    // the trace of ground is at y = 5 on the board; the gesture took it at y = 4.9
    const altrove = verifica({ routes: [massaSpostata(6, 4.9)] });
    expect(altrove).toEqual({
      ok: false,
      motivo: `la pista ${GND} non e' piu' dove il gesto l'ha presa: la scheda salvata e' cambiata dopo il gesto, ricaricala e rifallo`,
      cambiata: true,
    });
    // a connection that has no trace on the board
    expect(verifica({ routes: [{ ...massaSpostata(6), connection: ".R2 > .2 to net.SIG" }] })).toMatchObject({ ok: false, cambiata: true });
    // no via of that net in that place; a via of another size there
    expect(verifica({ vias: [viaSpostata({ x: 0, y: -7 }, { from: { x: 1, y: -6 } })] })).toEqual({
      ok: false,
      motivo: "la via di GND non e' piu' in (1; -6): la scheda salvata e' cambiata dopo il gesto, ricaricala e rifallo",
      cambiata: true,
    });
    expect(verifica({ vias: [viaSpostata({ x: 0, y: -7 }, { net: "SIG" })] })).toMatchObject({ ok: false, cambiata: true });
    expect(verifica({ vias: [viaSpostata({ x: 0, y: -7 }, { outerDiameter: 0.45, holeDiameter: 0.2 })] })).toMatchObject({
      ok: false,
      motivo: expect.stringContaining("non ha piu' le misure che il gesto ha letto"),
      cambiata: true,
    });
  });

  it("copper a correction already moved can be moved again: on the board that shows it, and on the one that does not show it yet", () => {
    const prima = applyCopperPatch(emptyManualEdits(), { routes: [massaSpostata(6)], vias: [viaSpostata({ x: 0, y: -7 })] }).edits;
    const mostrata = applyManualRoutes({ circuitJson: SCHEDA, routes: prima.pcb_routes, vias: prima.pcb_vias }).circuitJson as El[];
    // the second drag starts from what is on screen: the trace at y = 6, the via at (0; -7)
    const ancora: Partial<CopperPatch> = { routes: [massaSpostata(7, 6)], vias: [viaSpostata({ x: 0, y: -8 }, { from: { x: 0, y: -7 } })] };
    expect(verifica(ancora, mostrata, prima)).toEqual({ ok: true });
    // two drags in a row: the fast update of the first is still running, the saved board is the one of the files
    expect(verifica(ancora, SCHEDA, prima)).toEqual({ ok: true });
    // without the first in the file, the same copper starts from nothing that is there
    expect(verifica(ancora, SCHEDA)).toMatchObject({ ok: false, cambiata: true });
    // and what would be written keeps where the files put both
    const scritte = applyCopperPatch(prima, { routes: ancora.routes!, vias: ancora.vias! }).edits;
    expect(scritte.pcb_routes.map((r) => r.replaces?.original)).toEqual([massaA(5)]);
    expect(scritte.pcb_vias.map((v) => [v.from, v.to])).toEqual([[{ x: 0, y: -6 }, { x: 0, y: -8 }]]);
  });
});

describe("spinta, verifica: a save of the whole file (the undo history)", () => {
  /** the trace of the signal, which the files run below the parts, brought above them at `y` */
  const SIG = ".R1 > .2 to net.SIG";
  const segnaleA = (y: number): Punto[] => [top(-9, 0), top(-9, y), top(11, y), top(11, 0)];
  const segnaleSpostato = (y: number): ManualRoute => ({ connection: SIG, points: segnaleA(y), width: 0.2, replaces: { original: segnaleA(-3), width: 0.2 } });

  it("the corrections it brings in are the ones the file does not hold as they are: not the ones it keeps, not the ones it drops", () => {
    const via = viaSpostata({ x: 0, y: -7 });
    const disegnata: ManualRoute = { connection: GND, points: massaA(4), width: 0.2 };
    const file: ManualEdits = { ...emptyManualEdits(), pcb_routes: [massaSpostata(6), disegnata], pcb_vias: [via] };
    const con = (parti: Partial<ManualEdits>): ManualEdits => ({ ...emptyManualEdits(), ...parti });
    // the same state, and the same with something else of the file changed: nothing enters
    expect(correzioniNuove(file, file)).toEqual({ routes: [], vias: [] });
    expect(correzioniNuove(file, con({ pcb_routes: [massaSpostata(6)], pcb_vias: [via], pcb_placements: [{ selector: "R1", center: { x: 1, y: 1 } }] }))).toEqual({ routes: [], vias: [] });
    // a state that drops them: nothing enters either. A drawn route is not a correction, added or not
    expect(correzioniNuove(file, emptyManualEdits())).toEqual({ routes: [], vias: [] });
    expect(correzioniNuove(emptyManualEdits(), con({ pcb_routes: [disegnata] }))).toEqual({ routes: [], vias: [] });
    // the same key with another path, another `to`, or only another gesture: it is not the correction the file holds
    expect(correzioniNuove(file, con({ pcb_routes: [massaSpostata(7)], pcb_vias: [via] }))).toEqual({ routes: [massaSpostata(7)], vias: [] });
    expect(correzioniNuove(file, con({ pcb_routes: [massaSpostata(6)], pcb_vias: [{ ...via, to: { x: 0, y: -8 } }] }))).toEqual({ routes: [], vias: [{ ...via, to: { x: 0, y: -8 } }] });
    expect(correzioniNuove(file, con({ pcb_routes: [{ ...massaSpostata(6), gesto: "g7" }], pcb_vias: [via] })).routes).toHaveLength(1);
    // one the file never had
    expect(correzioniNuove(file, con({ pcb_routes: [massaSpostata(6), segnaleSpostato(8)], pcb_vias: [via] }))).toEqual({ routes: [segnaleSpostato(8)], vias: [] });
    expect(correzioniNuove(emptyManualEdits(), file)).toEqual({ routes: [massaSpostata(6)], vias: [via] });
  });

  it("is judged on the board of the file it asks for: a correction it brings back is not measured next to one it drops", () => {
    /*
     * A lone via of the signal stands above the trace of ground, at (0; 9).
     * The file holds a drag that pushed: the via brought down to (0; 6.5), and
     * the ground, which an earlier drag had taken to y = 6, moved on to y = 5.5
     * to leave it room. The state before that drag had the ground at y = 6 and
     * the via where the files put it. Ground at 6 with the via at 6.5 is 0.1 mm
     * of air; ground at 6 with the via back at 9 is the board that state asks for.
     */
    const conLaVia = circuito([viaDi("v_sig", 0, 9, 2)]);
    const viaScesa: ManualViaMove = { net: "SIG", from: { x: 0, y: 9 }, to: { x: 0, y: 6.5 }, holeDiameter: 0.3, outerDiameter: 0.6, layers: ["top", "bottom"] };
    const correnti: ManualEdits = { ...emptyManualEdits(), pcb_routes: [massaSpostata(5.5)], pcb_vias: [viaScesa] };
    const mostrata = applyManualRoutes({ circuitJson: conLaVia, routes: correnti.pcb_routes, vias: correnti.pcb_vias }).circuitJson as El[];
    expect(distanze(mostrata)).toEqual([]);
    const diPrima: ManualEdits = { ...emptyManualEdits(), pcb_routes: [massaSpostata(6)] };
    const entra = correzioniNuove(correnti, diPrima);
    expect(entra).toEqual({ routes: [massaSpostata(6)], vias: [] });
    // on the board that shows the pushed copper, and on the one that does not show it yet
    for (const scheda of [mostrata, conLaVia]) {
      expect(verificaRame({ circuitJson: scheda, regole: REGOLE, correnti, rame: entra, finale: diPrima })).toEqual({ ok: true });
      // written INTO the file instead, next to the via still down there, the same correction breaks a distance
      expect(verificaRame({ circuitJson: scheda, regole: REGOLE, correnti, rame: entra })).toMatchObject({ ok: false, motivo: expect.stringContaining("il rame viola una distanza") });
    }
    // a state that brings in copper bad on its own board is refused all the same
    const cattiva: ManualEdits = { ...emptyManualEdits(), pcb_routes: [massaSpostata(-2.8)] };
    expect(verificaRame({ circuitJson: mostrata, regole: REGOLE, correnti, rame: correzioniNuove(correnti, cattiva), finale: cattiva })).toMatchObject({
      ok: false,
      motivo: expect.stringContaining("il rame viola una distanza"),
    });
    const storta: ManualEdits = { ...emptyManualEdits(), pcb_routes: [{ ...massaSpostata(6), points: [top(-10, 0), top(-10, 5), top(10, 6), top(10, 0)] }] };
    expect(verificaRame({ circuitJson: mostrata, regole: REGOLE, correnti, rame: correzioniNuove(correnti, storta), finale: storta })).toMatchObject({
      ok: false,
      motivo: expect.stringContaining("non e' a 0, 45 o 90 gradi"),
    });
  });
});

describe("spinta, verifica: the copper of one save, as it is read", () => {
  const LIMITI = { maxRoutes: 200, maxPoints: 2000, maxVias: 500 };
  const QUANDO = "2026-11-12T10:00:00.000Z";
  const leggi = (corpo: Record<string, unknown>) => leggiRame({ gesto: "g1", ...corpo }, LIMITI, QUANDO);
  const errore = (corpo: Record<string, unknown>): string => {
    const esito = leggi(corpo);
    if (!("errore" in esito)) throw new Error("letto, e non doveva");
    return esito.errore;
  };
  const pista = { connection: ".U9 > .pin1 to .USB1 > .pin35", points: massaA(6), width: 0.2, replaces: { original: massaA(5), width: 0.25 } };
  const foro = { net: "P3V3", from: { x: 0, y: -6 }, to: { x: 0, y: -7 }, holeDiameter: 0.3, outerDiameter: 0.6, layers: ["top", "inner1", "inner2", "bottom"] };

  it("every correction read carries the gesture of the save and its instant; the via its hole, ring and layers; the route its connection by part and pin", () => {
    const esito = leggi({ routes: [pista, { ...pista, connection: ".R1 > .pin1 to net.GND", points: undefined, viaDiameter: 0.6, viaHoleDiameter: 0.3 }], vias: [foro] });
    if ("errore" in esito) throw new Error(esito.errore);
    expect(esito.rame.routes).toEqual([
      { connection: ".U9 > .pin1 to .USB1 > .pin35", points: massaA(6), width: 0.2, replaces: { original: massaA(5), width: 0.25 }, gesto: "g1", at: QUANDO },
      { connection: ".R1 > .pin1 to net.GND", points: [], width: 0.2, viaDiameter: 0.6, viaHoleDiameter: 0.3, replaces: { original: massaA(5), width: 0.25 }, gesto: "g1", at: QUANDO },
    ]);
    expect(esito.rame.vias).toEqual([{ ...foro, gesto: "g1", at: QUANDO }]);
    // to 0.0001 mm, and nothing the sender added goes through
    const fine = leggi({ routes: [{ ...pista, points: [top(0.12344, 0), top(5.00006, 0)], id: "pcb_trace_7", net: "GND", manual: true }], vias: [] });
    if ("errore" in fine) throw new Error(fine.errore);
    expect(fine.rame.routes[0]).toEqual({ ...pista, points: [top(0.1234, 0), top(5.0001, 0)], gesto: "g1", at: QUANDO });
  });

  it("a coordinate that is not a finite number, or beyond 1000 mm, is refused with the reason", () => {
    expect(errore({ routes: [{ ...pista, points: [top(0, 0), { x: Number.NaN, y: 1, layer: "top" }] }] })).toBe("pista 1: punto 2: una coordinata non e' un numero finito");
    // what JSON makes of NaN and of Infinity
    expect(errore({ routes: [{ ...pista, points: [top(0, 0), { x: null, y: 1, layer: "top" }] }] })).toBe("pista 1: punto 2: una coordinata non e' un numero finito");
    expect(errore({ routes: [{ ...pista, points: [top(0, 0), { x: "3", y: 1, layer: "top" }] }] })).toBe("pista 1: punto 2: una coordinata non e' un numero finito");
    expect(errore({ routes: [{ ...pista, points: [top(0, 0), top(0, 1000.5)] }] })).toBe("pista 1: punto 2: una coordinata e' oltre 1000 mm");
    expect(errore({ routes: [pista, { ...pista, replaces: { original: [top(0, 0), top(-1001, 0)], width: 0.2 } }] })).toBe("pista 2, pista di partenza: punto 2: una coordinata e' oltre 1000 mm");
    expect(errore({ vias: [{ ...foro, to: { x: 0, y: Number.POSITIVE_INFINITY } }] })).toBe("via 1: una coordinata non e' un numero finito");
    expect(errore({ vias: [foro, { ...foro, from: { x: 2000, y: 0 } }] })).toBe("via 2: una coordinata e' oltre 1000 mm");
    expect(errore({ vias: [{ ...foro, from: undefined }] })).toBe("via 1: una coordinata non e' un numero finito");
  });

  it("the limits of one save: 200 routes, 2000 points, 500 vias", () => {
    const corta = { ...pista, points: [top(0, 0), top(1, 0)] };
    expect("rame" in leggi({ routes: Array.from({ length: 200 }, () => corta) })).toBe(true);
    expect(errore({ routes: Array.from({ length: 201 }, () => corta) })).toBe("troppe piste in un salvataggio (massimo 200)");
    expect("rame" in leggi({ vias: Array.from({ length: 500 }, (_, i) => ({ ...foro, from: { x: i, y: 0 }, to: { x: i, y: 1 } })) })).toBe(true);
    expect(errore({ vias: Array.from({ length: 501 }, () => foro) })).toBe("troppe vie in un salvataggio (massimo 500)");
    const lunga = (n: number) => Array.from({ length: n }, (_, i) => top(i / 10, 0));
    expect("rame" in leggi({ routes: [{ ...pista, points: lunga(2000) }] })).toBe(true);
    expect(errore({ routes: [{ ...pista, points: lunga(2001) }] })).toBe("troppi punti in un salvataggio (massimo 2000)");
    // of all the routes together, and the same for their starting paths
    expect(errore({ routes: [{ ...pista, points: lunga(1500) }, { ...pista, points: lunga(501) }] })).toBe("troppi punti in un salvataggio (massimo 2000)");
    expect(errore({ routes: [{ ...pista, replaces: { original: lunga(2001), width: 0.2 } }] })).toBe("troppi punti in un salvataggio (massimo 2000)");
  });

  it("widths, vias, layers, names: anything else is refused with the reason, nothing is clamped or read around", () => {
    expect(errore({})).toBe("nessuna correzione da salvare");
    expect(errore({ routes: "tante" })).toBe("piste e vie devono essere due liste");
    expect(leggiRame({ routes: [pista] }, LIMITI, QUANDO)).toEqual({ errore: "manca il gesto, o non e' un nome (lettere, cifre, _ e -, al piu' 64)" });
    expect(leggiRame({ routes: [pista], gesto: "un gesto" }, LIMITI, QUANDO)).toHaveProperty("errore");
    expect(errore({ routes: [null] })).toBe("pista 1: non e' una pista");
    // a route that replaces nothing is a drawn trace: not for this door
    expect(errore({ routes: [{ ...pista, replaces: undefined }] })).toMatch(/^pista 1: manca la pista di partenza \(replaces\)/);
    expect(errore({ routes: [{ ...pista, replaces: { original: [top(0, 0)], width: 0.2 } }] })).toBe("pista 1: la pista di partenza ha meno di due punti");
    expect(errore({ routes: [{ ...pista, points: [top(0, 0)] }] })).toBe("pista 1: un punto solo non e' una pista");
    expect(errore({ routes: [{ ...pista, points: [top(0, 0), { x: 1, y: 0, layer: "rame" }] }] })).toBe("pista 1: punto 2: lo strato non e' uno strato di rame");
    expect(errore({ routes: [{ ...pista, points: [top(0, 0), { x: 1, y: 0 }] }] })).toBe("pista 1: punto 2: lo strato non e' uno strato di rame");
    for (const width of [0.01, 12, "0.2", undefined, Number.NaN]) {
      expect(errore({ routes: [{ ...pista, width }] }), String(width)).toBe("pista 1: la larghezza deve stare fra 0.05 e 10 mm");
    }
    expect(errore({ routes: [{ ...pista, replaces: { original: massaA(5), width: 0 } }] })).toBe("pista 1, pista di partenza: la larghezza deve stare fra 0.05 e 10 mm");
    expect(errore({ routes: [{ ...pista, viaDiameter: 7, viaHoleDiameter: 0.3 }] })).toBe("pista 1: il diametro della via deve stare fra 0.1 e 6 mm");
    expect(errore({ routes: [{ ...pista, viaDiameter: 0.6 }] })).toBe("pista 1: il foro della via deve stare fra 0.05 mm e il suo diametro");
    expect(errore({ vias: [{ ...foro, outerDiameter: 0.05 }] })).toBe("via 1: il diametro della via deve stare fra 0.1 e 6 mm");
    expect(errore({ vias: [{ ...foro, holeDiameter: 0.6 }] })).toBe("via 1: il foro della via deve stare fra 0.05 mm e il suo diametro");
    expect(errore({ vias: [{ ...foro, to: foro.from }] })).toBe("via 1: non si sposta");
    for (const layers of [["top"], ["top", "top"], ["top", "rame"], "top,bottom", undefined]) {
      expect(errore({ vias: [{ ...foro, layers }] }), String(layers)).toBe("via 1: gli strati vanno scritti tutti, ognuno una volta");
    }
    // the net by its name, as a selector `net.X` can write it
    for (const net of ["", "GND-1", "net.GND", "source_net_0 ", "3V3", 7]) {
      expect(errore({ vias: [{ ...foro, net }] }), String(net)).toBe("via 1: la rete va scritta col suo nome (lettere, cifre e _)");
    }
    // the connection by part and pin, or by net: never an id, never anything else
    for (const connection of ["source_trace_3", "pcb_trace_0", ".R1 > .pin1", ".R1 > .pin1 to", ".R1 > .pin1 to .R2 > .pin1 to .R3 > .pin1", " .R1 > .pin1 to net.GND", ".R1 > .pin1 to net.GND\"/>", 7, "x".repeat(400)]) {
      expect(errore({ routes: [{ ...pista, connection }] }), String(connection)).toMatch(/^pista 1: la connessione va scritta con pezzo e piedino/);
    }
    for (const connection of [".U9 > .pin1 to .USB1 > .pin35", ".R1 > .pin1 to net.GND", ".U1 > .~RST to .J1 > .D+"]) {
      expect("rame" in leggi({ routes: [{ ...pista, connection }] }), connection).toBe(true);
    }
  });
});
