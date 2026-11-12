import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * "SPINGI E SPOSTA": HAND COPPER MOVED IN SPOSTA IS REWRITTEN IN ITS PLACE.
 *
 * Copper that is already a hand route of manual-edits.json (drawn in Instrada,
 * or imported from another CAD) is not a correction of the files: there is no
 * trace of the files under it to replace. The gesture sends, next to its
 * corrections, the list `riscritte`: for each such route the key it has in the
 * file and its new path, and nothing else. The save (`copper` of
 * /api/manual-edits) reads them as strictly as the corrections, checks them
 * against the file and the saved board, and writes each in the place of the
 * route it names: the route of the file, with the new path.
 *
 *   - nothing about the route comes from the page: its connection, its pads,
 *     its net, its width and the size of its vias are the file's;
 *   - the key of a route drawn between two pads is the pair, and stays; the
 *     key of an imported route is made of its points, and changes with them:
 *     the old key leaves the file and the new one enters;
 *   - only the stretches the gesture laid answer for their direction: an
 *     imported route may hold stretches at any angle, and those are a given;
 *   - the board after it has ONE piece of copper for the route, by the fast
 *     update as by a compile: the copper of the old key goes with its key.
 *
 * The board is compiled for real: three resistors, two nets with no copper in
 * the files, and the copper as an import leaves it. A tree of ground (G, with
 * a stub K whose first stretch is at an odd angle), a signal that changes face
 * twice (three traces and two vias, each a route of its own, meeting at shared
 * points) and one trace drawn in Instrada between two pins (D). The files are
 * the real store, in memory; the saved board is handed by a mocked compile
 * cache.
 */
const stato = vi.hoisted(() => ({
  riga: null as null | { filesHash: string; circuitJson: unknown[]; summary: unknown; createdAt: string; engineVersion: number; base: null },
}));

vi.mock("@/lib/acl", () => ({
  requireProjectAccess: async () => ({ ok: true, viewer: null }),
  accessoDaRichiesta: async () => true,
}));
vi.mock("@/lib/project-store", async (originale) => {
  const vero = await originale<typeof import("@/lib/project-store")>();
  return {
    ...vero,
    getCompileCache: vi.fn(async () => stato.riga),
    getCompileMeta: vi.fn(async () => (stato.riga ? { filesHash: stato.riga.filesHash, createdAt: stato.riga.createdAt, engineVersion: 14, base: null } : null)),
  };
});
// the real check, watched: which saves run it and which do not
vi.mock("@/lib/spinta/verifica", async (originale) => {
  const vero = await originale<typeof import("@/lib/spinta/verifica")>();
  return { ...vero, verificaRame: vi.fn(vero.verificaRame) };
});

import { POST } from "@/app/api/manual-edits/route";
import { compileProject } from "@/lib/compile";
import { DESIGN_RULES_PATH } from "@/lib/design-rules";
import { idDoppi } from "@/lib/duplicate-ids";
import { applyCopperPatch, correzioniNuove, emptyManualEdits, MANUAL_EDITS_PATH, parseManualEdits, serializeManualEdits } from "@/lib/manual-edits";
import { manualRouteKey, type ManualRoute } from "@/lib/manual-routes";
import { filesHash, getProject, writeProjectFile } from "@/lib/project-store";
import { rerouteLocal } from "@/lib/reroute-local";
import { leggiRame, passiDi, trattiStorti, verificaRame } from "@/lib/spinta/verifica";

const LIMITI = { maxRoutes: 200, maxPoints: 2000, maxVias: 500 };

type El = Record<string, unknown> & { type: string };

const REGOLE = JSON.stringify({
  preset: "custom",
  rules: { minTraceWidthMm: 0.15, minClearanceMm: 0.15, pourClearanceMm: 0.2, autoPlaneVias: false, autoroute: false },
});
/** no copper in the files: every trace of this board is a hand route of manual-edits.json */
const MAIN = `export default () => (
  <board width="40mm" height="24mm">
    <net name="GND" />
    <net name="SIG" />
    <resistor name="R1" resistance="1k" footprint="0402" pcbX={-10} pcbY={0} />
    <resistor name="R2" resistance="1k" footprint="0402" pcbX={10} pcbY={0} />
    <resistor name="R3" resistance="1k" footprint="0402" pcbX={-10} pcbY={-6} />
    <trace from=".R1 > .pin1" to="net.GND" />
    <trace from=".R3 > .pin1" to="net.GND" />
    <trace from=".R1 > .pin2" to="net.SIG" />
    <trace from=".R2 > .pin1" to="net.SIG" />
    <trace from=".R3 > .pin2" to=".R2 > .pin2" />
  </board>
)
`;
const FILES: Record<string, string> = { "main.tsx": MAIN, [DESIGN_RULES_PATH]: REGOLE };
const FRA_PIEDINI = ".R3 > .pin2 to .R2 > .pin2";

type Punto = { x: number; y: number; layer: "top" | "bottom" };
const top = (x: number, y: number): Punto => ({ x, y, layer: "top" });
const bottom = (x: number, y: number): Punto => ({ x, y, layer: "bottom" });
/** a piece of the copper of a net, as an import writes it; a via is two points in one place on two layers, with its sizes */
const diRete = (net: string, points: Punto[], via = false): ManualRoute => ({
  connection: `net.${net}`,
  points,
  width: 0.2,
  net,
  importato: true,
  ...(via ? { viaDiameter: 0.6, viaHoleDiameter: 0.3 } : {}),
});
/** the ground: from R1.pin1 down the column of x = -12 to R3.pin1 */
const G = diRete("GND", [top(-10.51, 0), top(-12, 0), top(-12, -6), top(-10.51, -6)]);
/** a stub of the ground that leaves the corner of G at an odd angle, as another CAD drew it */
const K = diRete("GND", [top(-12, -6), top(-14, -7), top(-16, -7)]);
/** the signal: on top from R1.pin2 to a via, under the board to a second via, on top again to R2.pin1 */
const S1 = diRete("SIG", [top(-9.49, 0), top(-5, 0)]);
const V1 = diRete("SIG", [top(-5, 0), bottom(-5, 0)], true);
const S2 = diRete("SIG", [bottom(-5, 0), bottom(5, 0)]);
const V2 = diRete("SIG", [bottom(5, 0), top(5, 0)], true);
const S3 = diRete("SIG", [top(5, 0), top(9.49, 0)]);
/** drawn in Instrada between R3.pin2 and R2.pin2: keyed by the pair, whatever its points */
const D: ManualRoute = {
  connection: FRA_PIEDINI,
  from: ".R3 > .pin2",
  to: ".R2 > .pin2",
  points: [top(-9.49, -6), top(-7, -6), top(-7, -8), top(12, -8), top(12, 0), top(10.51, 0)],
  width: 0.2,
  id: ".R2 > .pin2 ~ .R3 > .pin2",
};
const NEL_FILE = [G, K, S1, V1, S2, V2, S3, D];
const FILE = serializeManualEdits({ ...emptyManualEdits(), pcb_routes: NEL_FILE });
const chiave = manualRouteKey;
/** the same route with another path: what the file holds after the save, but for the gesture and the instant */
const con = (route: ManualRoute, points: Punto[]): ManualRoute => ({ ...route, points });
/** what the gesture sends for a route: the key it has in the file, and its new path */
const mossa = (route: ManualRoute, points: Punto[]) => ({ chiave: chiave(route), points });

const piste = (cj: unknown[]) => (cj as El[]).filter((e) => e.type === "pcb_trace");
const vie = (cj: unknown[]) => (cj as El[]).filter((e) => e.type === "pcb_via");
const percorso = (e: El) => ((e.route as El[] | undefined) ?? []).map((p) => `${p.route_type === "via" ? "via" : p.layer} ${p.x};${p.y}`).join(" > ");
const scritto = (punti: Punto[]) =>
  punti.flatMap((p, i) => (i > 0 && punti[i - 1].layer !== p.layer ? [`via ${p.x};${p.y}`, `${p.layer} ${p.x};${p.y}`] : [`${p.layer} ${p.x};${p.y}`])).join(" > ");
/** the copper of a board for what it is: every trace with the key of its route, every hole with its size */
const rame = (cj: unknown[]) => ({
  piste: piste(cj).map((e) => `[${e.manual_route_id}] ${percorso(e)}`).sort(),
  vie: vie(cj).map((v) => `${v.x};${v.y} ${v.outer_diameter}/${v.hole_diameter}`).sort(),
});
/** the traces laid for the route of that key */
const pisteDellaChiave = (cj: unknown[], k: string) => piste(cj).filter((e) => e.manual_route_id === k);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

let progetto = 0;
let istante = 0;
let P = "";
let compilata: Awaited<ReturnType<typeof compileProject>>;
beforeAll(async () => {
  compilata = await compileProject({ ...FILES, [MANUAL_EDITS_PATH]: FILE });
}, 120_000);
beforeEach(async () => {
  P = `prova-riscritte-${++progetto}`;
  for (const [path, testo] of Object.entries(FILES)) await writeProjectFile(P, path, testo);
  await writeProjectFile(P, MANUAL_EDITS_PATH, FILE);
  stato.riga = { filesHash: filesHash(await getProject(P)), circuitJson: compilata.circuitJson, summary: compilata.summary, createdAt: "2026-11-12T10:00:00.000Z", engineVersion: 14, base: null };
  vi.mocked(verificaRame).mockClear();
});

const posta = (body: Record<string, unknown>) =>
  POST(new Request("http://x/api/manual-edits", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: P, ...body }) }));
/** the save of a gesture: `riscritte` as the gesture sends them, with the two lists of corrections it always sends */
const copper = (riscritte: unknown, altro: Record<string, unknown> = {}) => posta({ action: "copper", gesto: "g1", routes: [], vias: [], riscritte, ...altro });
const testoDelFile = async () => (await getProject(P))[MANUAL_EDITS_PATH];
const nelFile = async () => parseManualEdits(await testoDelFile());
/** what the page does after a save: the fast update of the saved board, which becomes the saved one */
const aggiornaVeloce = async (): Promise<unknown[]> => {
  const files = await getProject(P);
  const fatto = rerouteLocal(stato.riga!.circuitJson, files, files[MANUAL_EDITS_PATH]);
  if (!fatto.circuitJson) throw new Error(`aggiornamento veloce: ${fatto.result.reason}`);
  stato.riga = { ...stato.riga!, filesHash: filesHash(files), circuitJson: fatto.circuitJson, createdAt: new Date(Date.UTC(2026, 10, 12, 11, 0, ++istante)).toISOString() };
  return fatto.circuitJson;
};
/** "Aggiorna": the board of the files as they are now, from nothing */
const compila = async () => compileProject(await getProject(P));
/** a refusal of the check: its reason, and that nothing was written */
const rifiutato = async (r: Response): Promise<{ error: string; reason: string; cambiata?: boolean }> => {
  expect(r.status).toBe(409);
  const detto = (await r.json()) as { error: string; reason: string; cambiata?: boolean };
  expect(detto.error).toBe(`rame non salvato: ${detto.reason}`);
  expect(await testoDelFile()).toBe(FILE);
  return detto;
};

describe("spinta, riscritte: the board of the test", () => {
  it("every hand route is laid once, with its key on its copper, and the nets are closed", () => {
    expect(parseManualEdits(FILE).pcb_routes).toEqual(NEL_FILE);
    expect(piste(compilata.circuitJson).map((e) => e.manual_route_id).sort()).toEqual(NEL_FILE.map(chiave).sort());
    expect(rame(compilata.circuitJson).vie).toEqual(["-5;0 0.6/0.3", "5;0 0.6/0.3"]);
    expect(compilata.summary.unroutedConnections).toEqual([]);
    expect(idDoppi(compilata.circuitJson)).toBeNull();
    // the key of an imported route is its net and its points; the one of a drawn route is its two pads
    expect(chiave(G)).toMatch(/^net\.GND @ \w+$/);
    expect(chiave(con(G, [top(-10.51, 0), top(-13, 0)]))).not.toBe(chiave(G));
    expect(chiave(con(D, [top(-9.49, -6), top(10.51, 0)]))).toBe(chiave(D));
  });
});

describe("spinta, riscritte: an imported route moved", () => {
  it("the old key leaves the file and the new one enters in its place; one piece of copper for it after the fast update and after a compile, and no id doubled", async () => {
    // the column of the ground pushed three quarters of a millimetre to the left
    const spostata = [top(-10.51, 0), top(-12.75, 0), top(-12.75, -6), top(-10.51, -6)];
    const r = await copper([mossa(G, spostata)]);
    expect(r.status).toBe(200);
    const nuova = chiave(con(G, spostata));
    expect(nuova).not.toBe(chiave(G));
    const detto = (await r.json()) as { ok: boolean; routes: unknown[]; vias: unknown[]; riscritte: Array<{ chiave: string; route: ManualRoute }>; replaced: unknown };
    expect(detto).toMatchObject({ ok: true, routes: [], vias: [] });
    // what was written, by the key it took the place of; and the way back: the key it has now, and the route as it was
    expect(detto.riscritte).toEqual([{ chiave: chiave(G), route: { ...con(G, spostata), gesto: "g1", at: expect.stringMatching(ISO) } }]);
    expect(detto.replaced).toEqual({ routes: [], vias: [], riscritte: [{ chiave: nuova, route: G }] });

    // the file: the same routes in the same order, the first one with its new path, its gesture and its instant
    const edits = await nelFile();
    expect(edits.pcb_routes.slice(1)).toEqual(NEL_FILE.slice(1));
    expect(edits.pcb_routes[0]).toEqual(detto.riscritte[0].route);
    expect(edits.pcb_routes.map(chiave)).toEqual([nuova, ...NEL_FILE.slice(1).map(chiave)]);
    expect(edits.pcb_routes.map(chiave)).not.toContain(chiave(G));
    // not a correction: it replaces nothing of the files, and no moved via came with it
    expect(edits.pcb_routes[0]).not.toHaveProperty("replaces");
    expect(edits.pcb_vias).toEqual([]);

    // the fast update: the copper of the old key is off, the new one is laid once, the rest is as it was
    const veloce = await aggiornaVeloce();
    expect(pisteDellaChiave(veloce, chiave(G))).toEqual([]);
    expect(pisteDellaChiave(veloce, nuova).map(percorso)).toEqual([scritto(spostata)]);
    expect(piste(veloce).map((e) => e.manual_route_id).sort()).toEqual(edits.pcb_routes.map(chiave).sort());
    expect(rame(veloce).piste.filter((p) => !p.startsWith(`[${nuova}]`))).toEqual(rame(compilata.circuitJson).piste.filter((p) => !p.startsWith(`[${chiave(G)}]`)));
    expect(rame(veloce).vie).toEqual(rame(compilata.circuitJson).vie);
    expect(idDoppi(veloce)).toBeNull();
    // and again: the same board
    expect(JSON.stringify(await aggiornaVeloce())).toBe(JSON.stringify(veloce));

    // a compile of the same files lays the same copper
    const aggiornata = await compila();
    expect(rame(aggiornata.circuitJson)).toEqual(rame(veloce));
    expect(idDoppi(aggiornata.circuitJson)).toBeNull();
    expect(aggiornata.summary.unroutedConnections).toEqual([]);
    expect(aggiornata.summary.manualEditsOrphans).toBeUndefined();
  }, 120_000);

  it("a via moved with the two traces that end on it: three routes rewritten, the hole where it was put, nothing left at the old place", async () => {
    // the first via of the signal dragged one millimetre down; the trace on each face follows it with a stretch at 45 degrees
    const via = [top(-5, -1), bottom(-5, -1)];
    const sopra = [top(-9.49, 0), top(-6, 0), top(-5, -1)];
    const sotto = [bottom(-5, -1), bottom(-4, 0), bottom(5, 0)];
    const r = await copper([mossa(V1, via), mossa(S1, sopra), mossa(S2, sotto)]);
    expect(r.status).toBe(200);
    expect(verificaRame).toHaveBeenCalledTimes(1);

    const edits = await nelFile();
    // each in the place it had in the list; the others untouched, the second via among them
    expect(edits.pcb_routes.map((x) => x.points)).toEqual([G.points, K.points, sopra, via, sotto, V2.points, S3.points, D.points]);
    for (const k of [V1, S1, S2].map(chiave)) expect(edits.pcb_routes.map(chiave)).not.toContain(k);
    // one gesture: the same on the three; and the via is the via of the file, with the size nobody sent
    expect(edits.pcb_routes.filter((x) => x.gesto).map((x) => [x.gesto, x.at])).toEqual(Array.from({ length: 3 }, () => ["g1", edits.pcb_routes[2].at]));
    expect(edits.pcb_routes[3]).toEqual({ ...con(V1, via), gesto: "g1", at: expect.stringMatching(ISO) });
    expect(edits.pcb_routes[3]).toMatchObject({ viaDiameter: 0.6, viaHoleDiameter: 0.3, net: "SIG", importato: true });

    for (const scheda of [await aggiornaVeloce(), (await compila()).circuitJson]) {
      // the hole where it was put, with its size, and the other one where it was
      expect(rame(scheda).vie).toEqual(["-5;-1 0.6/0.3", "5;0 0.6/0.3"]);
      expect(pisteDellaChiave(scheda, chiave(con(V1, via))).map(percorso)).toEqual(["top -5;-1 > via -5;-1 > bottom -5;-1"]);
      expect(pisteDellaChiave(scheda, chiave(con(S1, sopra))).map(percorso)).toEqual([scritto(sopra)]);
      expect(pisteDellaChiave(scheda, chiave(con(S2, sotto))).map(percorso)).toEqual([scritto(sotto)]);
      // nothing at the old place: no copper of the three old keys, no point of any trace where the via was
      for (const k of [V1, S1, S2].map(chiave)) expect(pisteDellaChiave(scheda, k)).toEqual([]);
      expect(piste(scheda).flatMap((e) => (e.route as El[]).filter((p) => p.x === -5 && p.y === 0))).toEqual([]);
      expect(piste(scheda)).toHaveLength(NEL_FILE.length);
      expect(idDoppi(scheda)).toBeNull();
    }
    // the signal is still one piece of copper
    expect((await compila()).summary.unroutedConnections).toEqual([]);
  }, 120_000);
});

describe("spinta, riscritte: a route drawn in Instrada moved", () => {
  it("the same key, new points, the same place in the file; one trace for its connection on the board", async () => {
    const giu = [top(-9.49, -6), top(-7, -6), top(-7, -9), top(12, -9), top(12, 0), top(10.51, 0)];
    const r = await copper([mossa(D, giu)]);
    expect(r.status).toBe(200);
    const detto = (await r.json()) as { riscritte: Array<{ chiave: string; route: ManualRoute }>; replaced: { riscritte: unknown[] } };
    // the pair of pads is the key before and after
    expect(detto.riscritte).toEqual([{ chiave: chiave(D), route: { ...con(D, giu), gesto: "g1", at: expect.stringMatching(ISO) } }]);
    expect(detto.replaced.riscritte).toEqual([{ chiave: chiave(D), route: D }]);
    const edits = await nelFile();
    expect(edits.pcb_routes.slice(0, 7)).toEqual(NEL_FILE.slice(0, 7));
    // its pads, its connection and the key written in it are the file's: only the path came from the page
    expect(edits.pcb_routes[7]).toEqual({ ...con(D, giu), gesto: "g1", at: expect.stringMatching(ISO) });
    expect(chiave(edits.pcb_routes[7])).toBe(chiave(D));

    const sorgente = (compilata.circuitJson as El[]).find((e) => e.type === "source_trace" && e.display_name === FRA_PIEDINI)!;
    for (const scheda of [await aggiornaVeloce(), (await compila()).circuitJson]) {
      const sue = piste(scheda).filter((e) => e.source_trace_id === sorgente.source_trace_id);
      expect(sue.map(percorso)).toEqual([scritto(giu)]);
      expect(sue[0].manual_route_id).toBe(chiave(D));
      expect(piste(scheda)).toHaveLength(NEL_FILE.length);
      expect(idDoppi(scheda)).toBeNull();
    }
    // moved again from where it is: the key did not change, so the same key names it
    const ancora = [top(-9.49, -6), top(-7, -6), top(-7, -10), top(12, -10), top(12, 0), top(10.51, 0)];
    expect((await copper([mossa(D, ancora)], { gesto: "g2" })).status).toBe(200);
    expect((await nelFile()).pcb_routes[7]).toMatchObject({ points: ancora, gesto: "g2" });
  }, 120_000);
});

describe("spinta, riscritte: the directions", () => {
  it("a new stretch that is crooked, of no length, or that changes layer away from its place answers 409; a crooked stretch the gesture did not touch is a given", async () => {
    // K leaves the corner of G at an odd angle, and that is how it was imported
    expect(trattiStorti(K)).toBe("il tratto da (-12; -6) a (-14; -7) non e' a 0, 45 o 90 gradi");
    expect(trattiStorti(K, passiDi(K.points))).toBeNull();

    // its last stretch laid at another odd angle
    const storta = await rifiutato(await copper([mossa(K, [top(-12, -6), top(-14, -7), top(-16, -7.5)])]));
    expect(storta).toEqual({
      error: "rame non salvato: la pista net.GND il tratto da (-14; -7) a (-16; -7.5) non e' a 0, 45 o 90 gradi",
      reason: "la pista net.GND il tratto da (-14; -7) a (-16; -7.5) non e' a 0, 45 o 90 gradi",
    });
    // one thousandth of a millimetre off the diagonal is not 45 degrees
    expect((await rifiutato(await copper([mossa(K, [top(-12, -6), top(-14, -7), top(-15, -8.001)])]))).reason).toBe(
      "la pista net.GND il tratto da (-14; -7) a (-15; -8.001) non e' a 0, 45 o 90 gradi",
    );
    // the odd stretch itself moved: it is no longer the one that was given
    expect((await rifiutato(await copper([mossa(K, [top(-12, -6), top(-14, -7.2), top(-16, -7.2)])]))).reason).toBe(
      "la pista net.GND il tratto da (-12; -6) a (-14; -7.2) non e' a 0, 45 o 90 gradi",
    );
    expect((await rifiutato(await copper([mossa(K, [top(-12, -6), top(-14, -7), top(-14, -7), top(-14, -9)])]))).reason).toBe(
      "la pista net.GND ha un tratto di lunghezza zero in (-14; -7)",
    );
    expect((await rifiutato(await copper([mossa(K, [top(-12, -6), top(-14, -7), bottom(-16, -7)])]))).reason).toBe(
      "la pista net.GND cambia strato fra (-14; -7) e (-16; -7): una via sta in un punto solo",
    );
    // a via that does not stay in one place
    expect((await rifiutato(await copper([mossa(V1, [top(-5, -1), bottom(-5, -1.1)])]))).reason).toBe(
      "la pista net.SIG cambia strato fra (-5; -1) e (-5; -1.1): una via sta in un punto solo",
    );

    // the odd stretch left where it was, the last one turned straight down: accepted
    const dritta = [top(-12, -6), top(-14, -7), top(-14, -9)];
    const r = await copper([mossa(K, dritta)]);
    expect(r.status).toBe(200);
    expect((await nelFile()).pcb_routes[1]).toMatchObject({ points: dritta, gesto: "g1" });
    const veloce = await aggiornaVeloce();
    expect(pisteDellaChiave(veloce, chiave(con(K, dritta))).map(percorso)).toEqual([scritto(dritta)]);
    expect(pisteDellaChiave(veloce, chiave(K))).toEqual([]);
    // moved again: the odd stretch is still a given, walked from either end, and a stretch at 45 degrees is good
    const ancora = [top(-13, -10), top(-14, -9), top(-14, -7), top(-12, -6)];
    expect((await copper([mossa(con(K, dritta), ancora)], { gesto: "g2" })).status).toBe(200);
  });
});

describe("spinta, riscritte: the start", () => {
  it("a key the file does not hold: 409 said as a board that changed, and nothing is written", async () => {
    const spostata = [top(-10.51, 0), top(-13, 0), top(-13, -6), top(-10.51, -6)];
    const detto = await rifiutato(await copper([{ chiave: "net.GND @ nonesiste", points: spostata }]));
    expect(detto).toEqual({
      error: "rame non salvato: la pista a mano net.GND @ nonesiste non e' piu' nel file come il gesto l'ha presa: la scheda salvata e' cambiata dopo il gesto, ricaricala e rifallo",
      reason: "la pista a mano net.GND @ nonesiste non e' piu' nel file come il gesto l'ha presa: la scheda salvata e' cambiata dopo il gesto, ricaricala e rifallo",
      cambiata: true,
    });
    // one good rewrite sent with it is not written either: one gesture, one save
    await rifiutato(await copper([mossa(D, [top(-9.49, -6), top(-7, -6), top(-7, -9), top(12, -9), top(12, 0), top(10.51, 0)]), { chiave: "net.GND @ nonesiste", points: spostata }]));

    // the key of an imported route goes with its points: the gesture of a page that did not reload names a route that is gone
    expect((await copper([mossa(G, spostata)])).status).toBe(200);
    const dopo = await testoDelFile();
    const vecchia = await copper([mossa(G, [top(-10.51, 0), top(-14, 0), top(-14, -6), top(-10.51, -6)])], { gesto: "g2" });
    expect(vecchia.status).toBe(409);
    expect(await vecchia.json()).toMatchObject({ cambiata: true });
    expect(await testoDelFile()).toBe(dopo);
    // by the key it has now it is moved again
    expect((await copper([mossa(con(G, spostata), [top(-10.51, 0), top(-14, 0), top(-14, -6), top(-10.51, -6)])], { gesto: "g2" })).status).toBe(200);
  });

  it("a curve and a correction of the files' copper are not rewritten: 409 with the reason, nothing written", async () => {
    const curva: ManualRoute = { ...K, arco: true };
    const correzione: ManualRoute = { connection: ".R1 > .pin1 to net.GND", points: [top(-10.51, 0), top(-11, 0)], width: 0.2, replaces: { original: [top(-10.51, 0), top(-12, 0)], width: 0.2 } };
    const conLoro = serializeManualEdits({ ...emptyManualEdits(), pcb_routes: [G, curva, S1, V1, S2, V2, S3, D, correzione] });
    await writeProjectFile(P, MANUAL_EDITS_PATH, conLoro);

    const dellaCurva = await copper([{ chiave: chiave(curva), points: [top(-12, -6), top(-14, -7), top(-14, -9)] }]);
    expect(dellaCurva.status).toBe(409);
    expect(await dellaCurva.json()).toEqual({ error: "rame non salvato: la pista net.GND e' una curva: non si sposta", reason: "la pista net.GND e' una curva: non si sposta" });

    const dellaCorrezione = await copper([{ chiave: chiave(correzione), points: [top(-10.51, 0), top(-11.5, 0)] }]);
    expect(dellaCorrezione.status).toBe(409);
    expect(((await dellaCorrezione.json()) as { reason: string }).reason).toBe(
      "la pista .R1 > .pin1 to net.GND e' una correzione del rame dei file: si corregge di nuovo, non si riscrive",
    );
    expect(await testoDelFile()).toBe(conLoro);
    // and what writes the file does not write them either, whoever calls it
    const file = parseManualEdits(conLoro);
    const nulla = applyCopperPatch(file, {
      routes: [],
      vias: [],
      riscritte: [
        { chiave: chiave(curva), points: [top(-12, -6), top(-14, -9)] },
        { chiave: chiave(correzione), points: [top(-10.51, 0), top(-11.5, 0)] },
        { chiave: "net.GND @ nonesiste", points: [top(0, 0), top(1, 0)] },
      ],
    });
    expect(nulla.edits.pcb_routes).toEqual(file.pcb_routes);
    expect(Object.keys(nulla.added)).toEqual(["routes", "vias"]);
    expect(Object.keys(nulla.replaced)).toEqual(["routes", "vias"]);
  });
});

describe("spinta, riscritte: the distances", () => {
  it("a rewritten route that breaks a distance answers 409 in the words of the DRC, and nothing is written", async () => {
    // the via of the signal dropped on the column of the ground
    const sullaMassa = await rifiutato(await copper([mossa(V1, [top(-12, -3), bottom(-12, -3)])]));
    expect(sullaMassa.reason).toMatch(/^il rame viola una distanza che prima era rispettata: .*mm < min 0\.15mm/);
    expect(sullaMassa.cambiata).toBeUndefined();
    // the trace of the signal brought down along the drawn trace of another connection
    const sullaDisegnata = await rifiutato(await copper([mossa(S1, [top(-9.49, 0), top(-7, 0), top(-7, -7), top(-5, -7)])]));
    expect(sullaDisegnata.reason).toMatch(/^il rame viola una distanza che prima era rispettata: /);
    // a good one sent with a bad one is not written either
    await rifiutato(await copper([mossa(D, [top(-9.49, -6), top(-7, -6), top(-7, -9), top(12, -9), top(12, 0), top(10.51, 0)]), mossa(V1, [top(-12, -3), bottom(-12, -3)])]));
    expect(verificaRame).toHaveBeenCalledTimes(3);
    // with no board to measure on, nothing is written either
    stato.riga = null;
    expect((await rifiutato(await copper([mossa(G, [top(-10.51, 0), top(-13, 0), top(-13, -6), top(-10.51, -6)])]))).reason).toBe(
      "non c'e' una scheda compilata su cui verificarlo: premi Aggiorna",
    );
  });
});

describe("spinta, riscritte: what one save may carry", () => {
  const buona = mossa(G, [top(-10.51, 0), top(-13, 0), top(-13, -6), top(-10.51, -6)]);
  const coiPunti = (points: unknown) => [{ chiave: chiave(G), points }];

  it("an entry is a key and a path, and nothing else: anything more, or anything wrong in them, answers 400 with the reason, and nothing is written", async () => {
    for (const [riscritte, motivo] of [
      ["tante", "le piste riscritte devono essere una lista"],
      [[null], "pista riscritta 1: non e' una pista riscritta"],
      [[[buona]], "pista riscritta 1: non e' una pista riscritta"],
      // nothing about the route comes from the page: not the route itself, not one field of it
      [[{ chiave: chiave(G), route: con(G, buona.points) }], "pista riscritta 1: porta solo la chiave e i punti, il resto della pista e' quello del file (in piu': route)"],
      [[{ ...buona, width: 0.5, net: "SIG" }], "pista riscritta 1: porta solo la chiave e i punti, il resto della pista e' quello del file (in piu': width, net)"],
      [[{ ...buona, replaces: { original: G.points, width: 0.2 } }], "pista riscritta 1: porta solo la chiave e i punti, il resto della pista e' quello del file (in piu': replaces)"],
      [[buona, { chiave: chiave(K), points: K.points, gesto: "g9" }], "pista riscritta 2: porta solo la chiave e i punti, il resto della pista e' quello del file (in piu': gesto)"],
      [[{ points: buona.points }], "pista riscritta 1: manca la chiave che la pista ha nel file"],
      [[{ chiave: "", points: buona.points }], "pista riscritta 1: manca la chiave che la pista ha nel file"],
      [[{ chiave: 7, points: buona.points }], "pista riscritta 1: manca la chiave che la pista ha nel file"],
      [[{ chiave: "x".repeat(501), points: buona.points }], "pista riscritta 1: manca la chiave che la pista ha nel file"],
      [[buona, { ...buona, points: G.points }], "pista riscritta 2: la stessa pista del file e' riscritta due volte"],
      [[{ chiave: chiave(G) }], "pista riscritta 1: i punti non sono una lista"],
      [coiPunti("due"), "pista riscritta 1: i punti non sono una lista"],
      [coiPunti([top(0, 0), null]), "pista riscritta 1: il punto 2 non e' un punto"],
      [coiPunti([]), "pista riscritta 1: una pista ha almeno due punti"],
      [coiPunti([top(0, 0)]), "pista riscritta 1: una pista ha almeno due punti"],
      // JSON has no NaN: it arrives as null
      [coiPunti([top(0, 0), { x: Number.NaN, y: 1, layer: "top" }]), "pista riscritta 1: punto 2: una coordinata non e' un numero finito"],
      [coiPunti([top(0, 0), { x: "3", y: 1, layer: "top" }]), "pista riscritta 1: punto 2: una coordinata non e' un numero finito"],
      [coiPunti([top(0, 0), top(0, 1000.5)]), "pista riscritta 1: punto 2: una coordinata e' oltre 1000 mm"],
      [coiPunti([top(0, 0), { x: 1, y: 0, layer: "rame" }]), "pista riscritta 1: punto 2: lo strato non e' uno strato di rame"],
      [coiPunti([top(0, 0), { x: 1, y: 0 }]), "pista riscritta 1: punto 2: lo strato non e' uno strato di rame"],
      // a hand route is read on the grid of the micron: a place off it is refused, not rounded
      [coiPunti([top(-10.51, 0), top(-12.7505, 0)]), "pista riscritta 1: punto 2: una coordinata non e' sulla griglia di 0.001 mm"],
      [coiPunti([top(0, 0.0004), top(1, 0)]), "pista riscritta 1: punto 1: una coordinata non e' sulla griglia di 0.001 mm"],
      // the list the gesture always sends, with nothing in it and nothing next to it
      [[], "nessuna correzione da salvare"],
    ] as Array<[unknown, string]>) {
      const r = await copper(riscritte);
      expect(r.status, motivo).toBe(400);
      expect(await r.json(), motivo).toEqual({ error: motivo });
    }
    expect((await copper([buona], { gesto: "un gesto" })).status).toBe(400);
    expect(await testoDelFile()).toBe(FILE);
    expect(verificaRame).not.toHaveBeenCalled();
  });

  it("they count with the corrections in the limits of one save: 200 routes, 2000 points", async () => {
    const lunga = (n: number) => Array.from({ length: n }, (_, i) => top(i / 10, 0));
    const correzione = { connection: ".R1 > .pin1 to net.GND", points: lunga(1500), width: 0.2, replaces: { original: [top(0, 0), top(1, 0)], width: 0.2 } };
    for (const [body, motivo] of [
      [{ riscritte: Array.from({ length: 201 }, () => buona) }, "troppe piste in un salvataggio (massimo 200)"],
      [{ routes: Array.from({ length: 150 }, () => correzione), riscritte: Array.from({ length: 51 }, () => buona) }, "troppe piste in un salvataggio (massimo 200)"],
      [{ riscritte: coiPunti(lunga(2001)) }, "troppi punti in un salvataggio (massimo 2000)"],
      [{ routes: [correzione], riscritte: coiPunti(lunga(501)) }, "troppi punti in un salvataggio (massimo 2000)"],
    ] as Array<[Record<string, unknown>, string]>) {
      const r = await posta({ action: "copper", gesto: "g1", ...body });
      expect(r.status, motivo).toBe(400);
      expect(await r.json()).toEqual({ error: motivo });
    }
    // within them it is read: 2000 points in one rewritten route
    const letta = leggiRame({ gesto: "g1", riscritte: coiPunti(lunga(2000)) }, LIMITI, "2026-11-12T10:00:00.000Z");
    expect("rame" in letta && letta.rame.riscritte?.[0].points).toHaveLength(2000);
    expect(await testoDelFile()).toBe(FILE);
  });

  it("what is read: the key, the path as it was sent on the grid of the micron, the gesture and the instant of the save", () => {
    const QUANDO = "2026-11-12T10:00:00.000Z";
    // what a sum of floats leaves on a number meant to be on the grid is taken off, nothing more
    const letta = leggiRame({ gesto: "g-7", riscritte: [{ chiave: chiave(V1), points: [top(-5, -1.1 - 0.02), bottom(-5, -1.12)] }, mossa(D, [top(0.1 + 0.2, 0), top(1, 0)])] }, LIMITI, QUANDO);
    if (!("rame" in letta)) throw new Error(letta.errore);
    expect(letta.rame).toEqual({
      routes: [],
      vias: [],
      riscritte: [
        { chiave: chiave(V1), points: [top(-5, -1.12), bottom(-5, -1.12)], gesto: "g-7", at: QUANDO },
        { chiave: chiave(D), points: [top(0.3, 0), top(1, 0)], gesto: "g-7", at: QUANDO },
      ],
    });
  });
});

describe("spinta, riscritte: a rewritten route is a hand route like any other", () => {
  it("a save with none is the save of before: no such list in what is read, written or answered", () => {
    const correzione: ManualRoute = { connection: ".R1 > .pin1 to net.GND", points: [top(0, 0), top(1, 0)], width: 0.2, replaces: { original: [top(0, 0), top(2, 0)], width: 0.2 } };
    for (const corpo of [{ gesto: "g1", routes: [correzione] }, { gesto: "g1", routes: [correzione], vias: [], riscritte: [] }]) {
      const letta = leggiRame(corpo, LIMITI, "2026-11-12T10:00:00.000Z");
      if (!("rame" in letta)) throw new Error(letta.errore);
      expect(Object.keys(letta.rame)).toEqual(["routes", "vias"]);
      const scritta = applyCopperPatch(emptyManualEdits(), letta.rame);
      expect(Object.keys(scritta.added)).toEqual(["routes", "vias"]);
      expect(Object.keys(scritta.replaced)).toEqual(["routes", "vias"]);
      expect(scritta.edits.pcb_routes).toHaveLength(1);
    }
  });

  it("the route written is the route of the file with the new path: every field it had, and the gesture", () => {
    const ricca: ManualRoute = { connection: FRA_PIEDINI, from: ".R3 > .pin2", to: ".R2 > .pin2", points: D.points, width: 0.35, netTie: true, viaDiameter: 0.7, viaHoleDiameter: 0.35, id: D.id, gesto: "g0", at: "2026-11-11T08:00:00.000Z" };
    const file = { ...emptyManualEdits(), pcb_routes: [G, ricca, V1] };
    const nuovi = [top(-9.49, -6), top(10.51, -6), top(10.51, 0)];
    const fatto = applyCopperPatch(file, { routes: [], vias: [], riscritte: [{ chiave: chiave(ricca), points: nuovi, gesto: "g1", at: "2026-11-12T10:00:00.000Z" }] });
    expect(fatto.edits.pcb_routes).toEqual([G, { ...ricca, points: nuovi, gesto: "g1", at: "2026-11-12T10:00:00.000Z" }, V1]);
    expect(fatto.added).toEqual({ routes: [], vias: [], riscritte: [{ chiave: chiave(ricca), route: fatto.edits.pcb_routes[1] }] });
    expect(fatto.replaced).toEqual({ routes: [], vias: [], riscritte: [{ chiave: chiave(ricca), route: ricca }] });
    // and it goes to the file and comes back as it is
    expect(parseManualEdits(serializeManualEdits(fatto.edits)).pcb_routes).toEqual(fatto.edits.pcb_routes);
  });

  it("two imported routes that trade paths in one save: each key names the route the file held under it before the save", () => {
    // the key of an imported route is its net and its points: after the first is rewritten it has the key the second had
    const a = diRete("SIG", [top(0, 0), top(2, 0)]);
    const b = diRete("SIG", [top(0, 1), top(2, 1)]);
    const larga = { ...b, width: 0.4 };
    const fatto = applyCopperPatch(
      { ...emptyManualEdits(), pcb_routes: [a, larga] },
      { routes: [], vias: [], riscritte: [{ chiave: chiave(a), points: b.points }, { chiave: chiave(larga), points: a.points }] },
    );
    expect(fatto.edits.pcb_routes).toEqual([{ ...a, points: b.points }, { ...larga, points: a.points }]);
    expect(fatto.added.riscritte?.map((x) => x.chiave)).toEqual([chiave(a), chiave(larga)]);
  });

  it("it is not a correction of the files' copper: the undo history puts the old route back with no check, and the fast update lays it again", async () => {
    const spostata = [top(-10.51, 0), top(-13, 0), top(-13, -6), top(-10.51, -6)];
    expect((await copper([mossa(G, spostata)])).status).toBe(200);
    const dopo = await nelFile();
    const prima = parseManualEdits(FILE);
    // neither way is there a correction to bring in
    expect(correzioniNuove(prima, dopo)).toEqual({ routes: [], vias: [] });
    expect(correzioniNuove(dopo, prima)).toEqual({ routes: [], vias: [] });
    const mossaLi = await aggiornaVeloce();
    expect(pisteDellaChiave(mossaLi, chiave(con(G, spostata)))).toHaveLength(1);
    vi.mocked(verificaRame).mockClear();

    // Cmd+Z: the whole file as it was before the gesture
    const annulla = await posta({ action: "set", edits: FILE });
    expect(annulla.status).toBe(200);
    expect(verificaRame).not.toHaveBeenCalled();
    expect((await nelFile()).pcb_routes).toEqual(NEL_FILE);
    const tornata = await aggiornaVeloce();
    expect(rame(tornata)).toEqual(rame(compilata.circuitJson));
    expect(idDoppi(tornata)).toBeNull();
    // and the save of the drawn traces takes it as it takes any of them: it carries no `replaces`
    const ridisegnata = await posta({ action: "routes", add: [{ ...con(D, [top(-9.49, -6), top(-7, -6), top(-7, -9), top(12, -9), top(12, 0), top(10.51, 0)]), gesto: "g1" }] });
    expect(ridisegnata.status).toBe(200);
    expect(verificaRame).not.toHaveBeenCalled();
  });
});
