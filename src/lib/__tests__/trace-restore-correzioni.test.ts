import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * POST /api/trace {action: "restore"}: Cmd+Z after a trace was detached in
 * Instrada puts back the copper that went and the hand routes it came from.
 *
 * A drawn route comes back unchecked, as it is saved everywhere else. A
 * CORRECTION of the files' copper (a route with `replaces`, "spingi e sposta",
 * phase 2) wins over the files, and what a restore carries comes from the
 * page: so one the file does not hold already is checked like the gesture
 * that made it (verificaRame), on the board as the restore leaves it, inside
 * the write of the file. Refused, it is answered 409 and neither the file nor
 * the board changes.
 *
 * The files are the real store, in memory. The saved board is a board compiled
 * for real, handed and taken back by a mocked compile cache (the cache is in
 * the database).
 */
const stato = vi.hoisted(() => ({
  riga: null as null | { filesHash: string; circuitJson: unknown[]; summary: unknown; createdAt: string; engineVersion: number; base: unknown },
  /** how many boards were saved */
  salvate: 0,
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
    getCompileMeta: vi.fn(async () => (stato.riga ? { filesHash: stato.riga.filesHash, createdAt: stato.riga.createdAt, engineVersion: 13, base: stato.riga.base } : null)),
    saveCompileCache: vi.fn(async (_p: string, hash: string, circuitJson: unknown[], summary: unknown, engine: number, opts?: { base?: unknown }) => {
      stato.salvate++;
      stato.riga = { filesHash: hash, circuitJson, summary, createdAt: new Date(Date.UTC(2026, 10, 12, 12, 0, stato.salvate)).toISOString(), engineVersion: engine, base: opts?.base ?? null };
      return { saved: true };
    }),
  };
});
// the real check, watched: which restores run it and which do not
vi.mock("@/lib/spinta/verifica", async (originale) => {
  const vero = await originale<typeof import("@/lib/spinta/verifica")>();
  return { ...vero, verificaRame: vi.fn(vero.verificaRame) };
});

import { POST as salva } from "@/app/api/manual-edits/route";
import { POST as traccia } from "@/app/api/trace/route";
import { boardBaseOf } from "@/lib/board-base";
import { compileProject } from "@/lib/compile";
import { DESIGN_RULES_PATH } from "@/lib/design-rules";
import { idDoppi } from "@/lib/duplicate-ids";
import { MANUAL_EDITS_PATH, parseManualEdits } from "@/lib/manual-edits";
import { manualRouteKey, percorsoDellaPista, type ManualRoute } from "@/lib/manual-routes";
import { filesHash, getProject, writeProjectFile } from "@/lib/project-store";
import { rerouteLocal } from "@/lib/reroute-local";
import { verificaRame } from "@/lib/spinta/verifica";

type El = Record<string, unknown> & { type: string };

const REGOLE = JSON.stringify({
  preset: "custom",
  rules: { minTraceWidthMm: 0.15, minClearanceMm: 0.15, pourClearanceMm: 0.2, autoPlaneVias: false, autoroute: false },
});
/** the board of spinta-salvataggio.test.ts: a trace between two pins, one toward ground, one that ends on a lone via */
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
    <trace from=".R3 > .pin1" to="net.GND" pcbPath={[
      { x: -2, y: 0 },
      { x: -2, y: -2 },
      { x: 10, y: -2 },
      { x: 10, y: 0 },
    ]} thickness="0.2mm" />
    <via name="V1" pcbX={0} pcbY={-6} connectsTo="net.GND" fromLayer="top" toLayer="bottom" />
  </board>
)
`;
const FILES: Record<string, string> = { "main.tsx": MAIN, [DESIGN_RULES_PATH]: REGOLE };
const FRA_PIEDINI = ".R1 > .pin2 to .R2 > .pin1";
const VERSO_MASSA = ".R1 > .pin1 to net.GND";
const ALLA_VIA = ".R3 > .pin1 to net.GND";

type Punto = { x: number; y: number; layer: "top" | "bottom" };
const top = (x: number, y: number): Punto => ({ x, y, layer: "top" });
const bottom = (x: number, y: number): Punto => ({ x, y, layer: "bottom" });
const massaIn = (x: number): Punto[] => [top(-10.51, 0), top(x, 0), top(x, -3), bottom(x, -3), bottom(x, -5)];
/** the trace toward ground pushed one millimetre to the left: a correction of the files' copper */
const massaSpostata = { connection: VERSO_MASSA, points: massaIn(-13), width: 0.2, replaces: { original: massaIn(-12), width: 0.2 } };
/** a trace drawn in Instrada between the two pins: no `replaces`, it is not a correction */
const disegnata = { connection: FRA_PIEDINI, from: ".R1 > .pin2", to: ".R2 > .pin1", width: 0.2, points: [top(-9.49, 0), top(-7, 3), top(7, 3), top(9.49, 0)] };

const piste = (cj: unknown[]) => (cj as El[]).filter((e) => e.type === "pcb_trace");
const pisteDi = (cj: unknown[], connessione: string) => {
  const sorgenti = new Set((cj as El[]).filter((e) => e.type === "source_trace" && e.display_name === connessione).map((e) => e.source_trace_id));
  return piste(cj).filter((e) => sorgenti.has(e.source_trace_id));
};
const tragitto = (cj: unknown[], connessione: string) => pisteDi(cj, connessione).map((p) => percorsoDellaPista(p));
const vieIn = (cj: unknown[]) =>
  (cj as El[])
    .filter((e) => e.type === "pcb_via")
    .map((v) => `${v.x};${v.y}`)
    .sort();
/** a board as the set of its elements: a restore puts copper back at the end of the list, not where it was */
const elementi = (cj: unknown[]) => cj.map((e) => JSON.stringify(e)).sort();

let progetto = 0;
let P = "";
let compilata: Awaited<ReturnType<typeof compileProject>>;
beforeAll(async () => {
  compilata = await compileProject(FILES);
}, 120_000);
beforeEach(async () => {
  P = `prova-rimetti-${++progetto}`;
  for (const [path, testo] of Object.entries(FILES)) await writeProjectFile(P, path, testo);
  const files = await getProject(P);
  stato.riga = { filesHash: filesHash(files), circuitJson: compilata.circuitJson, summary: compilata.summary, createdAt: "2026-11-12T10:00:00.000Z", engineVersion: 13, base: boardBaseOf(files) };
  stato.salvate = 0;
  vi.mocked(verificaRame).mockClear();
});

const posta = (rotta: (r: Request) => Promise<Response>, body: Record<string, unknown>) =>
  rotta(new Request("http://x/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: P, ...body }) }));
const scheda = () => stato.riga!.circuitJson;
const nelFile = async () => parseManualEdits((await getProject(P))[MANUAL_EDITS_PATH]);
/** what the page does after a save of manual-edits.json: the fast update of the saved board, which becomes the saved one */
const aggiornaVeloce = async (): Promise<unknown[]> => {
  const files = await getProject(P);
  const fatto = rerouteLocal(scheda(), files, files[MANUAL_EDITS_PATH]);
  stato.riga = { ...stato.riga!, filesHash: filesHash(files), circuitJson: fatto.circuitJson ?? scheda(), createdAt: new Date(Date.UTC(2026, 10, 12, 11, 0, ++progetto)).toISOString() };
  return scheda();
};
/** detaches the one trace of a connection, as Instrada does, and gives what went */
const stacca = async (connessione: string) => {
  const [pista] = pisteDi(scheda(), connessione);
  const r = await posta(traccia, { action: "delete", pcbTraceId: pista.pcb_trace_id });
  expect(r.status).toBe(200);
  return ((await r.json()) as { removed: { routes: ManualRoute[]; elements: El[] } }).removed;
};
const rimetti = (cosa: { routes?: unknown[]; elements?: unknown[] }) => posta(traccia, { action: "restore", ...cosa });

describe("POST /api/trace restore: a trace a correction had laid", () => {
  it("detached and put back: the correction is in the file again, and the board is the one of before the detach", async () => {
    expect((await posta(salva, { action: "copper", gesto: "g1", routes: [massaSpostata] })).status).toBe(200);
    const prima = await aggiornaVeloce();
    const filePrima = await nelFile();
    expect(tragitto(prima, VERSO_MASSA)).toEqual([massaIn(-13)]);
    vi.mocked(verificaRame).mockClear();

    // the detach: the copper goes with its hole, the correction leaves the file, and the answer says both
    const tolto = await stacca(VERSO_MASSA);
    expect(tolto.routes).toEqual(filePrima.pcb_routes);
    expect(tolto.routes[0].replaces).toEqual({ original: massaIn(-12), width: 0.2 });
    expect(tolto.elements.map((e) => e.type)).toEqual(["pcb_trace", "pcb_via"]);
    expect((await nelFile()).pcb_routes).toEqual([]);
    expect(pisteDi(scheda(), VERSO_MASSA)).toEqual([]);
    expect(vieIn(scheda())).toEqual(["-5;0", "0;-6", "5;0"]);
    // taking copper off is checked by nobody
    expect(verificaRame).not.toHaveBeenCalled();
    const staccata = scheda();

    // Cmd+Z: what went comes back, the correction through the check
    const r = await rimetti(tolto);
    expect(r.status).toBe(200);
    expect(verificaRame).toHaveBeenCalledTimes(1);
    expect((await nelFile()).pcb_routes).toEqual(filePrima.pcb_routes);
    expect(scheda()).not.toBe(staccata);
    expect(elementi(scheda())).toEqual(elementi(prima));
    expect(tragitto(scheda(), VERSO_MASSA)).toEqual([massaIn(-13)]);
    expect(pisteDi(scheda(), VERSO_MASSA)[0]).toMatchObject({ manual: true, manual_route_id: manualRouteKey(filePrima.pcb_routes[0]), replaces: { original: massaIn(-12) } });
    expect(vieIn(scheda())).toEqual(["-13;-3", "-5;0", "0;-6", "5;0"]);
    expect(idDoppi(scheda())).toBeNull();
    // and it is the board of that file: the fast update finds the same copper to lay, twice
    const dopo = await aggiornaVeloce();
    expect(elementi(dopo)).toEqual(elementi(prima));
    expect(JSON.stringify(await aggiornaVeloce())).toBe(JSON.stringify(dopo));
  });

  it("put back a second time, when the file holds it already: nothing enters, nothing is checked", async () => {
    expect((await posta(salva, { action: "copper", gesto: "g1", routes: [massaSpostata] })).status).toBe(200);
    await aggiornaVeloce();
    const tolto = await stacca(VERSO_MASSA);
    expect((await rimetti(tolto)).status).toBe(200);
    vi.mocked(verificaRame).mockClear();
    const conLei = scheda();
    // the same restore once more: its route is in the file as it is, its copper on the board
    const ancora = await rimetti(tolto);
    expect(ancora.status).toBe(200);
    expect(verificaRame).not.toHaveBeenCalled();
    expect((await nelFile()).pcb_routes).toHaveLength(1);
    expect(elementi(scheda())).toEqual(elementi(conLei));
    expect(idDoppi(scheda())).toBeNull();
  });
});

describe("POST /api/trace restore: a correction that is not good does not come in this way", () => {
  it("one that breaks a distance, or a crooked one: 409 with the reason, and neither the file nor the board changes", async () => {
    const intatta = scheda();
    // drawn across the trace between the two pins, on the top face: the copper `copper` refuses
    const attraverso = [top(-10.51, 0), top(-10.51, 1), top(-7, 1), top(-7, -3), bottom(-7, -3), bottom(-7, -5)];
    const incrocia = await rimetti({ routes: [{ ...massaSpostata, points: attraverso }] });
    expect(incrocia.status).toBe(409);
    const detto = (await incrocia.json()) as { error: string; reason: string; cambiata?: boolean };
    expect(detto.reason).toMatch(/^il rame viola una distanza che prima era rispettata: .*mm < min 0\.15mm/);
    expect(detto).toEqual({ error: `rame non salvato: ${detto.reason}`, reason: detto.reason });

    const storta = await rimetti({ routes: [{ ...massaSpostata, points: [top(-10.51, 0), top(-13, -1), top(-13, -3)] }] });
    expect(storta.status).toBe(409);
    expect(await storta.json()).toEqual({
      error: `rame non salvato: la pista ${VERSO_MASSA} il tratto da (-10.51; 0) a (-13; -1) non e' a 0, 45 o 90 gradi`,
      reason: `la pista ${VERSO_MASSA} il tratto da (-10.51; 0) a (-13; -1) non e' a 0, 45 o 90 gradi`,
    });
    // one that starts from copper no board has, and none among what is put back
    const daNulla = await rimetti({ routes: [{ ...massaSpostata, replaces: { original: massaIn(-11), width: 0.2 } }] });
    expect(daNulla.status).toBe(409);
    expect(await daNulla.json()).toMatchObject({ reason: expect.stringContaining("non e' piu' dove il gesto l'ha presa"), cambiata: true });
    // a drawn trace sent with it does not get in either: one restore, one write
    expect((await rimetti({ routes: [disegnata, { ...massaSpostata, points: attraverso }] })).status).toBe(409);

    expect(verificaRame).toHaveBeenCalledTimes(4);
    expect((await getProject(P))[MANUAL_EDITS_PATH]).toBeUndefined();
    expect(stato.salvate).toBe(0);
    expect(scheda()).toBe(intatta);
  });

  it("the copper of a detached correction put back with another route: 409, the copper stays off the board and the file without the route", async () => {
    expect((await posta(salva, { action: "copper", gesto: "g1", routes: [massaSpostata] })).status).toBe(200);
    await aggiornaVeloce();
    const tolto = await stacca(VERSO_MASSA);
    const staccata = scheda();
    const fileStaccato = (await getProject(P))[MANUAL_EDITS_PATH];
    const salvatePrima = stato.salvate;
    vi.mocked(verificaRame).mockClear();

    // the elements that went, as they went; the route that says what to lay there, changed: across the trace of another net
    const attraverso = [top(-10.51, 0), top(-10.51, 1), top(-7, 1), top(-7, -3), bottom(-7, -3), bottom(-7, -5)];
    const r = await rimetti({ elements: tolto.elements, routes: [{ ...tolto.routes[0], points: attraverso }] });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { reason: string }).reason).toMatch(/^il rame viola una distanza che prima era rispettata: /);
    expect(verificaRame).toHaveBeenCalledTimes(1);
    // nothing written: not the file, and not the board, which would have had the copper back
    expect((await getProject(P))[MANUAL_EDITS_PATH]).toBe(fileStaccato);
    expect(stato.salvate).toBe(salvatePrima);
    expect(scheda()).toBe(staccata);
    expect(pisteDi(scheda(), VERSO_MASSA)).toEqual([]);
  });
});

describe("POST /api/trace restore: drawn copper comes back as before", () => {
  it("a drawn route with its copper, and copper of the files alone: put back, and the check never runs", async () => {
    // a trace drawn in Instrada between the two pins, laid in the place of the files' one
    expect((await posta(salva, { action: "routes", add: [disegnata] })).status).toBe(200);
    const conLaDisegnata = await aggiornaVeloce();
    expect(tragitto(conLaDisegnata, FRA_PIEDINI)).toEqual([disegnata.points]);
    const filePrima = await nelFile();

    const tolta = await stacca(FRA_PIEDINI);
    expect(tolta.routes).toEqual(filePrima.pcb_routes);
    expect(tolta.routes[0]).not.toHaveProperty("replaces");
    expect((await nelFile()).pcb_routes).toEqual([]);
    expect(pisteDi(scheda(), FRA_PIEDINI)).toEqual([]);
    const r = await rimetti(tolta);
    expect(r.status).toBe(200);
    expect((await nelFile()).pcb_routes).toEqual(filePrima.pcb_routes);
    expect(elementi(scheda())).toEqual(elementi(conLaDisegnata));

    // a trace the files draw, detached: no route went with it, and its copper comes back alone
    const prima = scheda();
    const deiFile = await stacca(ALLA_VIA);
    expect(deiFile.routes).toEqual([]);
    expect(deiFile.elements.map((e) => e.type)).toEqual(["pcb_trace"]);
    expect(pisteDi(scheda(), ALLA_VIA)).toEqual([]);
    expect((await rimetti(deiFile)).status).toBe(200);
    expect(elementi(scheda())).toEqual(elementi(prima));
    expect((await nelFile()).pcb_routes).toEqual(filePrima.pcb_routes);

    // two detaches and two restores of drawn copper: not one check
    expect(verificaRame).not.toHaveBeenCalled();
    // what a restore may carry is what it always could
    expect((await rimetti({ elements: [{ type: "pcb_component" }], routes: [] })).status).toBe(400);
    expect((await rimetti({ elements: Array.from({ length: 65 }, () => ({ type: "pcb_via" })) })).status).toBe(413);
  });
});
