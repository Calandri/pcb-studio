import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * POST /api/manual-edits {action: "copper"}: the save of copper moved in
 * Sposta ("spingi e sposta", phase 2). One gesture is one save: the routes with
 * `replaces` and the moved vias it made.
 *
 *   - only who can edit the project, and only from the browser session: the
 *     personal token lets go of named parts and nothing else;
 *   - what arrives is read within the limits of one save, and refused with the
 *     reason (400) when it is not written right;
 *   - the server does not trust the viewer: the copper is checked against the
 *     SAVED board, and copper that breaks a distance, or that starts from
 *     something the board no longer has, is answered 409 and nothing is
 *     written;
 *   - what is written carries the gesture and the instant of the save.
 *
 * AND IT IS THE ONLY DOOR A CORRECTION ENTERS THE FILE BY WITHOUT A CHECK OF
 * ITS OWN. The saves of drawn traces (`routes`, and the old one that sends
 * `routes` with no action) refuse an entry with `replaces`: they do not read
 * the board. The save of the whole file (`set`, the undo history) checks the
 * same way every correction the file does not hold already, and checks
 * nothing when it only keeps or drops them.
 *
 * The files are the real store, in memory. The saved board is a board compiled
 * for real, handed by a mocked compile cache (the cache is in the database).
 */
const stato = vi.hoisted(() => ({
  sessione: true,
  token: true,
  riga: null as null | { filesHash: string; circuitJson: unknown[]; summary: unknown; createdAt: string; engineVersion: number; base: null },
  /** when set, what getCompileMeta answers instead of the row: another save got in between */
  meta: null as null | { filesHash: string; createdAt: string },
  /** when set, runs once right after the next read of the project's files: another save that lands just then */
  dopoLaLettura: null as null | (() => Promise<void>),
}));

vi.mock("@/lib/acl", () => ({
  requireProjectAccess: async () => ({ ok: stato.sessione, viewer: null }),
  accessoDaRichiesta: async () => stato.token,
}));
vi.mock("@/lib/project-store", async (originale) => {
  const vero = await originale<typeof import("@/lib/project-store")>();
  return {
    ...vero,
    getProject: vi.fn(async (id: string) => {
      // a copy, as the database gives one: the store in memory hands out its own object, which a later write changes
      const files = { ...(await vero.getProject(id)) };
      const poi = stato.dopoLaLettura;
      stato.dopoLaLettura = null;
      if (poi) await poi();
      return files;
    }),
    getCompileCache: vi.fn(async () => stato.riga),
    getCompileMeta: vi.fn(async () =>
      stato.riga ? { filesHash: stato.meta?.filesHash ?? stato.riga.filesHash, createdAt: stato.meta?.createdAt ?? stato.riga.createdAt, engineVersion: 13, base: null } : null,
    ),
  };
});
// the real check, watched: which saves run it (it is two runs of the DRC at most) and which do not
vi.mock("@/lib/spinta/verifica", async (originale) => {
  const vero = await originale<typeof import("@/lib/spinta/verifica")>();
  return { ...vero, verificaRame: vi.fn(vero.verificaRame) };
});

import { POST } from "@/app/api/manual-edits/route";
import { compileProject } from "@/lib/compile";
import { DESIGN_RULES_PATH } from "@/lib/design-rules";
import { idDoppi } from "@/lib/duplicate-ids";
import { emptyManualEdits, MANUAL_EDITS_PATH, parseManualEdits, sameManualEdits, serializeManualEdits, type ManualEdits } from "@/lib/manual-edits";
import { manualRouteKey, percorsoDellaPista } from "@/lib/manual-routes";
import { filesHash, getCompileCache, getCompileMeta, getProject, writeProjectFile } from "@/lib/project-store";
import { rerouteLocal } from "@/lib/reroute-local";
import { verificaRame } from "@/lib/spinta/verifica";

type El = Record<string, unknown> & { type: string };

const REGOLE = JSON.stringify({
  preset: "custom",
  rules: { minTraceWidthMm: 0.15, minClearanceMm: 0.15, pourClearanceMm: 0.2, autoPlaneVias: false, autoroute: false },
});
/** the board of spinta-salvataggio.test.ts: a trace between two pins, one toward ground, one that ends on a lone via */
const main = (colonna = -2, via = -6) => `export default () => (
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
      { x: ${colonna}, y: 0 },
      { x: ${colonna}, y: -3 },
      { x: ${colonna}, y: -3, via: true, fromLayer: "top", toLayer: "bottom" },
      { x: ${colonna}, y: -3 },
      { x: ${colonna}, y: -5 },
    ]} thickness="0.2mm" />
    <trace from=".R3 > .pin1" to="net.GND" pcbPath={[
      { x: -2, y: 0 },
      { x: -2, y: -2 },
      { x: 10, y: -2 },
      { x: 10, y: 0 },
    ]} thickness="0.2mm" />
    <via name="V1" pcbX={0} pcbY={${via}} connectsTo="net.GND" fromLayer="top" toLayer="bottom" />
  </board>
)
`;
const FILES: Record<string, string> = { "main.tsx": main(), [DESIGN_RULES_PATH]: REGOLE };
const VERSO_MASSA = ".R1 > .pin1 to net.GND";
const ALLA_VIA = ".R3 > .pin1 to net.GND";

type Punto = { x: number; y: number; layer: "top" | "bottom" };
const top = (x: number, y: number): Punto => ({ x, y, layer: "top" });
const bottom = (x: number, y: number): Punto => ({ x, y, layer: "bottom" });
const massaIn = (x: number): Punto[] => [top(-10.51, 0), top(x, 0), top(x, -3), bottom(x, -3), bottom(x, -5)];
/** the trace toward ground pushed one millimetre to the left, as the viewer sends it: no gesture, no instant of its own */
const massaSpostata = { connection: VERSO_MASSA, points: massaIn(-13), width: 0.2, viaDiameter: 0.3, viaHoleDiameter: 0.2, replaces: { original: massaIn(-12), width: 0.2 } };
/** the lone via dragged one millimetre up, with the trace that ends on it */
const viaSpostata = { net: "GND", from: { x: 0, y: -6 }, to: { x: 0, y: -5 }, holeDiameter: 0.2, outerDiameter: 0.3, layers: ["top", "bottom"] };
const allaVia = (y: number): Punto[] => [top(-10.51, -6), top(-12, -6), top(-12, -8), top(0, -8), top(0, y)];
const allaViaSpostata = { connection: ALLA_VIA, points: allaVia(-5), width: 0.2, replaces: { original: allaVia(-6), width: 0.2 } };

const piste = (cj: unknown[]) => (cj as El[]).filter((e) => e.type === "pcb_trace");
const pisteDi = (cj: unknown[], connessione: string) => {
  const sorgenti = new Set((cj as El[]).filter((e) => e.type === "source_trace" && e.display_name === connessione).map((e) => e.source_trace_id));
  return piste(cj).filter((e) => sorgenti.has(e.source_trace_id));
};

let progetto = 0;
let P = "";
let compilata: Awaited<ReturnType<typeof compileProject>>;
beforeAll(async () => {
  compilata = await compileProject(FILES);
}, 120_000);

/** a project with these files and this board saved for them */
const conLaScheda = async (files: Record<string, string>, circuitJson: unknown[], editsScritti?: string) => {
  P = `prova-copper-${++progetto}`;
  for (const [path, testo] of Object.entries(files)) await writeProjectFile(P, path, testo);
  if (editsScritti !== undefined) await writeProjectFile(P, MANUAL_EDITS_PATH, editsScritti);
  stato.riga = { filesHash: filesHash(await getProject(P)), circuitJson, summary: {}, createdAt: "2026-11-12T10:00:00.000Z", engineVersion: 13, base: null };
};
const chiama = (body: Record<string, unknown>, intestazioni: Record<string, string> = {}) =>
  POST(
    new Request("http://x/api/manual-edits", {
      method: "POST",
      headers: { "content-type": "application/json", ...intestazioni },
      body: JSON.stringify({ projectId: P, action: "copper", gesto: "g1", ...body }),
    }),
  );
const salvati = async () => parseManualEdits((await getProject(P))[MANUAL_EDITS_PATH]);
/** any other save of the same route: the body as it is */
const posta = (body: Record<string, unknown>) =>
  POST(new Request("http://x/api/manual-edits", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: P, ...body }) }));
let istante = 0;
/**
 * What the page does after every save: the fast update of the saved board for
 * the files as they are now. The board it gives becomes the saved one.
 */
const aggiornaVeloce = async (): Promise<unknown[]> => {
  const files = await getProject(P);
  const fatto = rerouteLocal(stato.riga!.circuitJson, files, files[MANUAL_EDITS_PATH]);
  // null only when there is nothing to lay and nothing to take off: the board stays the one it was
  const circuitJson = fatto.circuitJson ?? stato.riga!.circuitJson;
  stato.riga = { ...stato.riga!, filesHash: filesHash(files), circuitJson, createdAt: new Date(Date.UTC(2026, 10, 12, 11, 0, ++istante)).toISOString() };
  return circuitJson;
};
const scritto = async () => (await getProject(P))[MANUAL_EDITS_PATH];

beforeEach(async () => {
  Object.assign(stato, { sessione: true, token: true, meta: null, dopoLaLettura: null });
  await conLaScheda(FILES, compilata.circuitJson);
  vi.mocked(verificaRame).mockClear();
  vi.mocked(getCompileCache).mockClear();
  vi.mocked(getCompileMeta).mockClear();
});

describe("POST action copper: who may", () => {
  it("without the right to edit the project it answers 403, and nothing is written", async () => {
    stato.sessione = false;
    stato.token = false;
    const r = await chiama({ routes: [massaSpostata] });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: "forbidden" });
    expect(await scritto()).toBeUndefined();
  });

  it("the personal token is not enough: it lets go of named parts, it does not move copper", async () => {
    stato.sessione = false;
    stato.token = true;
    const r = await chiama({ routes: [massaSpostata], vias: [viaSpostata] }, { authorization: "Bearer pcbs_prova" });
    expect(r.status).toBe(403);
    // not even dressed as a release
    expect((await chiama({ routes: [massaSpostata], names: ["R1"] }, { authorization: "Bearer pcbs_prova" })).status).toBe(403);
    expect(await scritto()).toBeUndefined();
  });
});

describe("POST action copper: what is written right", () => {
  it("a coordinate that is not a finite number, or beyond 1000 mm, answers 400 with the reason", async () => {
    // JSON has no NaN: it arrives as null
    const nonFinita = await chiama({ routes: [{ ...massaSpostata, points: [top(-10.51, 0), { x: Number.NaN, y: 0, layer: "top" }] }] });
    expect(nonFinita.status).toBe(400);
    expect(await nonFinita.json()).toEqual({ error: "pista 1: punto 2: una coordinata non e' un numero finito" });
    const lontana = await chiama({ routes: [{ ...massaSpostata, points: [top(-10.51, 0), top(-1000.5, 0)] }] });
    expect(lontana.status).toBe(400);
    expect(await lontana.json()).toEqual({ error: "pista 1: punto 2: una coordinata e' oltre 1000 mm" });
    const via = await chiama({ vias: [{ ...viaSpostata, to: { x: 0, y: 1e9 } }] });
    expect(via.status).toBe(400);
    expect(await via.json()).toEqual({ error: "via 1: una coordinata e' oltre 1000 mm" });
    expect(await scritto()).toBeUndefined();
  });

  it("the limits of one save, the names and the sizes: 400 with the reason", async () => {
    const corta = { ...massaSpostata, points: [top(0, 0), top(1, 0)] };
    for (const [body, motivo] of [
      [{ routes: Array.from({ length: 201 }, () => corta) }, "troppe piste in un salvataggio (massimo 200)"],
      [{ vias: Array.from({ length: 501 }, () => viaSpostata) }, "troppe vie in un salvataggio (massimo 500)"],
      [{ routes: [{ ...massaSpostata, points: Array.from({ length: 2001 }, (_, i) => top(i / 10, 0)) }] }, "troppi punti in un salvataggio (massimo 2000)"],
      [{ routes: [{ ...massaSpostata, width: 20 }] }, "pista 1: la larghezza deve stare fra 0.05 e 10 mm"],
      [{ vias: [{ ...viaSpostata, outerDiameter: 9 }] }, "via 1: il diametro della via deve stare fra 0.1 e 6 mm"],
      [{ vias: [{ ...viaSpostata, net: "GND; DROP" }] }, "via 1: la rete va scritta col suo nome (lettere, cifre e _)"],
      [{ routes: [{ ...massaSpostata, connection: "pcb_trace_1" }] }, 'pista 1: la connessione va scritta con pezzo e piedino, o con la rete (".U9 > .pin1 to .USB1 > .pin35", ".R1 > .pin1 to net.GND")'],
      [{}, "nessuna correzione da salvare"],
      [{ routes: [massaSpostata], gesto: "" }, "manca il gesto, o non e' un nome (lettere, cifre, _ e -, al piu' 64)"],
    ] as Array<[Record<string, unknown>, string]>) {
      const r = await chiama(body);
      expect(r.status, motivo).toBe(400);
      expect(await r.json()).toEqual({ error: motivo });
    }
    expect(await scritto()).toBeUndefined();
  });
});

describe("POST action copper: the copper against the saved board", () => {
  it("copper that breaks a distance answers 409 with the reason, and nothing is written", async () => {
    // the via of ground dropped on the trace between the two pins, another net: (0; 0) is on its stretch of the bottom face
    const sopra = await chiama({ vias: [{ ...viaSpostata, to: { x: 0, y: 0 } }] });
    expect(sopra.status).toBe(409);
    const dettoDellaVia = (await sopra.json()) as { error: string; reason: string; cambiata?: boolean };
    expect(dettoDellaVia.reason).toMatch(/^il rame viola una distanza che prima era rispettata: .*mm < min 0\.15mm/);
    expect(dettoDellaVia.error).toBe(`rame non salvato: ${dettoDellaVia.reason}`);
    expect(dettoDellaVia.cambiata).toBeUndefined();

    // the trace toward ground drawn across the trace between the two pins, on the top face
    const attraverso = [top(-10.51, 0), top(-10.51, 1), top(-7, 1), top(-7, -3), bottom(-7, -3), bottom(-7, -5)];
    const incrocia = await chiama({ routes: [{ ...massaSpostata, points: attraverso }] });
    expect(incrocia.status).toBe(409);
    expect(((await incrocia.json()) as { reason: string }).reason).toMatch(/^il rame viola una distanza che prima era rispettata: /);

    // a good correction sent with a bad one is not written either: one gesture, one save
    expect((await chiama({ routes: [massaSpostata], vias: [{ ...viaSpostata, to: { x: 0, y: 0 } }] })).status).toBe(409);
    expect(await scritto()).toBeUndefined();
  });

  it("a stretch that is not at 0, 45 or 90 degrees, or of no length, answers 409", async () => {
    const storta = await chiama({ routes: [{ ...massaSpostata, points: [top(-10.51, 0), top(-13, -1), top(-13, -3)] }] });
    expect(storta.status).toBe(409);
    expect(((await storta.json()) as { reason: string }).reason).toBe(`la pista ${VERSO_MASSA} il tratto da (-10.51; 0) a (-13; -1) non e' a 0, 45 o 90 gradi`);
    const ferma = await chiama({ routes: [{ ...massaSpostata, points: [top(-10.51, 0), top(-13, 0), top(-13, 0), top(-13, -3)] }] });
    expect(ferma.status).toBe(409);
    expect(((await ferma.json()) as { reason: string }).reason).toBe(`la pista ${VERSO_MASSA} ha un tratto di lunghezza zero in (-13; 0)`);
    expect(await scritto()).toBeUndefined();
  });

  it("the saved board changed after the gesture: 409, said as such, and nothing is written", async () => {
    // the gesture was made on a board where the trace ran down the column of -11; the saved one has it at -12
    const altrove = await chiama({ routes: [{ ...massaSpostata, replaces: { original: massaIn(-11), width: 0.2 } }] });
    expect(altrove.status).toBe(409);
    expect(await altrove.json()).toEqual({
      error: `rame non salvato: la pista ${VERSO_MASSA} non e' piu' dove il gesto l'ha presa: la scheda salvata e' cambiata dopo il gesto, ricaricala e rifallo`,
      reason: `la pista ${VERSO_MASSA} non e' piu' dove il gesto l'ha presa: la scheda salvata e' cambiata dopo il gesto, ricaricala e rifallo`,
      cambiata: true,
    });
    // a compile saved another board while this save was reading the first
    stato.meta = { filesHash: stato.riga!.filesHash, createdAt: "2026-11-12T10:00:07.000Z" };
    const intanto = await chiama({ routes: [massaSpostata] });
    expect(intanto.status).toBe(409);
    expect(await intanto.json()).toMatchObject({ reason: expect.stringContaining("la scheda e' stata salvata di nuovo"), cambiata: true });
    // no board at all to check it on
    stato.meta = null;
    stato.riga = null;
    const senzaScheda = await chiama({ routes: [massaSpostata] });
    expect(senzaScheda.status).toBe(409);
    expect(((await senzaScheda.json()) as { reason: string }).reason).toBe("non c'e' una scheda compilata su cui verificarlo: premi Aggiorna");
    expect(await scritto()).toBeUndefined();
  });
});

describe("POST action copper: what it writes", () => {
  it("the corrections of one drag: the same gesture and an instant on each, the via with hole, ring and layers, the routes by part and pin, and no id of the circuit", async () => {
    const prima = Date.now();
    const r = await chiama({ gesto: "g-7f3a", routes: [massaSpostata, allaViaSpostata], vias: [viaSpostata] });
    expect(r.status).toBe(200);
    const detto = (await r.json()) as { ok: boolean; routes: unknown[]; vias: unknown[]; replaced: unknown; counts: { routes: number } };
    expect(detto).toMatchObject({ ok: true, replaced: { routes: [], vias: [] }, counts: { routes: 2 } });

    const edits = await salvati();
    expect(edits.pcb_routes).toHaveLength(2);
    expect(edits.pcb_vias).toHaveLength(1);
    const tutte = [...edits.pcb_routes, ...edits.pcb_vias];
    // one gesture, one instant: the server's, in ISO 8601
    expect(new Set(tutte.map((c) => c.gesto))).toEqual(new Set(["g-7f3a"]));
    expect(new Set(tutte.map((c) => c.at)).size).toBe(1);
    const quando = Date.parse(String(tutte[0].at));
    expect(String(tutte[0].at)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(quando).toBeGreaterThanOrEqual(prima);
    expect(quando).toBeLessThanOrEqual(Date.now());
    expect(edits.pcb_vias[0]).toEqual({ ...viaSpostata, gesto: "g-7f3a", at: tutte[0].at });
    for (const route of edits.pcb_routes) {
      expect(route.connection).toMatch(/^\.[A-Za-z_][\w$-]* > \.\S+ to (\.[A-Za-z_][\w$-]* > \.\S+|net\.\w+)$/);
      expect(route.replaces?.original.length).toBeGreaterThanOrEqual(2);
      expect(route).not.toHaveProperty("from");
      expect(route).not.toHaveProperty("id");
    }
    expect(edits.pcb_routes[0]).toEqual({ ...massaSpostata, gesto: "g-7f3a", at: tutte[0].at });
    // what the answer says was written is what the file holds
    expect(detto.routes).toEqual(edits.pcb_routes);
    expect(detto.vias).toEqual(edits.pcb_vias);
    // names, places and sizes: nothing numbered at a compile
    expect(await scritto()).not.toMatch(/pcb_(trace|via|port|component)_|source_(trace|net|port|component)_/);

    // and the fast update of that file lays it: one trace for each connection, the via once, no id doubled
    const files = await getProject(P);
    const veloce = rerouteLocal(compilata.circuitJson, files, files[MANUAL_EDITS_PATH]);
    expect(veloce.result).toMatchObject({ ok: true, manualRoutes: 2 });
    expect(veloce.result.orphans.total).toBe(0);
    expect(pisteDi(veloce.circuitJson!, VERSO_MASSA)).toHaveLength(1);
    expect(pisteDi(veloce.circuitJson!, ALLA_VIA)).toHaveLength(1);
    expect((veloce.circuitJson as El[]).filter((e) => e.type === "pcb_via")).toHaveLength((compilata.circuitJson as El[]).filter((e) => e.type === "pcb_via").length);
    expect(idDoppi(veloce.circuitJson!)).toBeNull();
  });

  it("a second drag of the same trace takes the place of the first, keeps where the files put it, and says what it replaced", async () => {
    expect((await chiama({ gesto: "g1", routes: [massaSpostata], vias: [viaSpostata] })).status).toBe(200);
    const [primaRoute] = (await salvati()).pcb_routes;
    const [primaVia] = (await salvati()).pcb_vias;
    // the saved board is still the one of the files (the fast update of the first drag has not run): the second starts from what is on screen
    const ancora = { ...massaSpostata, points: massaIn(-14), replaces: { original: massaIn(-13), width: 0.2 } };
    const r = await chiama({ gesto: "g2", routes: [ancora], vias: [{ ...viaSpostata, from: { x: 0, y: -5 }, to: { x: 1, y: -5 } }] });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { replaced: unknown }).replaced).toEqual({ routes: [primaRoute], vias: [primaVia] });
    const edits = await salvati();
    expect(edits.pcb_routes).toHaveLength(1);
    expect(edits.pcb_routes[0]).toMatchObject({ points: massaIn(-14), replaces: { original: massaIn(-12), width: 0.2 }, gesto: "g2" });
    expect(manualRouteKey(edits.pcb_routes[0])).toBe(manualRouteKey(primaRoute));
    expect(edits.pcb_vias).toHaveLength(1);
    expect(edits.pcb_vias[0]).toMatchObject({ from: { x: 0, y: -6 }, to: { x: 1, y: -5 }, gesto: "g2" });
  });

  it("the corrections the files have absorbed leave manual-edits.json at the next save that has the board in hand", async () => {
    // whoever generates the sources copied the two corrections there (the trace down the column of -13, the via at (0; -5)) and the board was compiled
    const ricopiati = { ...FILES, "main.tsx": main(-3, -5) };
    const laVia = { ...viaSpostata, gesto: "g1", at: "2026-11-12T09:00:00.000Z" };
    const laPista = { ...massaSpostata, gesto: "g1", at: "2026-11-12T09:00:00.000Z" };
    const nelFile = serializeManualEdits({ ...emptyManualEdits(), pcb_placements: [{ selector: "R2", center: { x: 10, y: 0 } }], pcb_routes: [laPista], pcb_vias: [laVia] });
    const conIRicopiati = await compileProject({ ...ricopiati, [MANUAL_EDITS_PATH]: nelFile });
    await conLaScheda(ricopiati, conIRicopiati.circuitJson, nelFile);
    expect((await salvati()).pcb_routes).toHaveLength(1);

    // the next gesture: the trace that ends on the via, which now stands at (0; -5), pushed down to y = -9
    const giu = [top(-10.51, -6), top(-12, -6), top(-12, -9), top(0, -9), top(0, -6)];
    const r = await chiama({ gesto: "g2", routes: [{ connection: ALLA_VIA, points: giu, width: 0.2, replaces: { original: allaVia(-6), width: 0.2 } }] });
    expect(r.status).toBe(200);
    const edits = await salvati();
    // the two absorbed ones are gone, the new one is there, and the rest of the file is as it was
    expect(edits.pcb_routes.map((x) => [x.connection, x.gesto])).toEqual([[ALLA_VIA, "g2"]]);
    expect(edits.pcb_vias).toEqual([]);
    expect(edits.pcb_placements).toEqual([{ selector: "R2", center: { x: 10, y: 0 } }]);
    expect(await scritto()).not.toContain("pcb_vias");

    // a save of another kind that reads the board does the same: here, the release of every hand position
    await conLaScheda(ricopiati, conIRicopiati.circuitJson, nelFile);
    const rilascio = await POST(
      new Request("http://x/api/manual-edits", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: P, action: "release", scope: "pcb" }) }),
    );
    expect(rilascio.status).toBe(200);
    expect(await salvati()).toMatchObject({ pcb_placements: [], pcb_routes: [], pcb_vias: [] });
  }, 120_000);
});

const FRA_PIEDINI = ".R1 > .pin2 to .R2 > .pin1";
const QUANDO = "2026-11-12T09:00:00.000Z";
/** a trace drawn in Instrada between the two pins: no `replaces`, it is not a correction */
const disegnata = { connection: FRA_PIEDINI, from: ".R1 > .pin2", to: ".R2 > .pin1", width: 0.2, points: [top(-9.49, 0), top(-7, 3), top(7, 3), top(9.49, 0)] };
const SOLO_CON_COPPER =
  "le correzioni del rame dei file (una pista con replaces) si salvano con l'azione copper, che le verifica sulla scheda salvata: qui si salvano solo piste disegnate";
/** the path of the one trace of a connection on a board, as a route stores it */
const tragitto = (cj: unknown[], connessione: string) => pisteDi(cj, connessione).map((p) => percorsoDellaPista(p));
const vieIn = (cj: unknown[]) =>
  (cj as El[])
    .filter((e) => e.type === "pcb_via")
    .map((v) => `${v.x};${v.y}`)
    .sort();
/** a state of the file as the undo history sends it back: the whole file */
const stato0 = (parti: Partial<ManualEdits>) => serializeManualEdits({ ...emptyManualEdits(), ...parti });
const laPista = { ...massaSpostata, gesto: "g1", at: QUANDO };
const laVia = { ...viaSpostata, gesto: "g1", at: QUANDO };

describe("POST action routes: a correction of the files' copper does not enter by the door of the drawn traces", () => {
  it("an entry with `replaces` answers 400 with the reason, and nothing is written; a drawn trace is saved as before", async () => {
    for (const body of [
      { action: "routes", add: [massaSpostata] },
      // one among drawn traces is enough: the save is one
      { action: "routes", add: [disegnata, massaSpostata] },
      // whatever it says it replaces
      { action: "routes", add: [{ ...disegnata, replaces: null }] },
      { action: "routes", add: [{ ...disegnata, replaces: {} }], remove: ["una chiave"] },
      // the old save of the drawn traces, with no action
      { routes: [massaSpostata] },
      { routes: [disegnata, { ...massaSpostata, points: [] }] },
    ]) {
      const r = await posta(body);
      expect(r.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(await r.json()).toEqual({ error: SOLO_CON_COPPER });
    }
    expect(await scritto()).toBeUndefined();
    expect(verificaRame).not.toHaveBeenCalled();

    // the drawn trace goes in by both, as it always did: no board read, no check
    const nuova = await posta({ action: "routes", add: [disegnata] });
    expect(nuova.status).toBe(200);
    expect((await salvati()).pcb_routes).toEqual([{ ...disegnata, id: manualRouteKey(disegnata) }]);
    expect((await posta({ routes: [disegnata] })).status).toBe(200);
    expect((await salvati()).pcb_routes).toHaveLength(1);
    expect(verificaRame).not.toHaveBeenCalled();
  });
});

describe("POST action set: a correction enters the file checked, or not at all", () => {
  it("adding a correction that breaks a distance answers 409 like copper, and nothing is written", async () => {
    // the via of ground dropped on the trace between the two pins: the same copper `copper` refuses
    const sopra = await posta({ action: "set", edits: stato0({ pcb_vias: [{ ...laVia, to: { x: 0, y: 0 } }] }) });
    expect(sopra.status).toBe(409);
    const detto = (await sopra.json()) as { error: string; reason: string; cambiata?: boolean };
    expect(detto.reason).toMatch(/^il rame viola una distanza che prima era rispettata: .*mm < min 0\.15mm/);
    expect(detto).toEqual({ error: `rame non salvato: ${detto.reason}`, reason: detto.reason });
    expect(verificaRame).toHaveBeenCalledTimes(1);

    // a trace drawn across another net, sent as an object and with a good correction next to it: one save, nothing written
    const attraverso = [top(-10.51, 0), top(-10.51, 1), top(-7, 1), top(-7, -3), bottom(-7, -3), bottom(-7, -5)];
    const incrocia = await posta({ action: "set", edits: { pcb_placements: [{ selector: "R2", center: { x: 10, y: 1 } }], pcb_routes: [{ ...laPista, points: attraverso }], pcb_vias: [laVia] } });
    expect(incrocia.status).toBe(409);
    expect(((await incrocia.json()) as { reason: string }).reason).toMatch(/^il rame viola una distanza che prima era rispettata: /);
    expect(await scritto()).toBeUndefined();
  });

  it("adding a crooked correction, or one with a stretch of no length, answers 409", async () => {
    // the file is read like any file, so a point given twice is one point: what is refused here is the direction
    const storta = await posta({ action: "set", edits: stato0({ pcb_routes: [{ ...laPista, points: [top(-10.51, 0), top(-13, -1), top(-13, -3)] }] }) });
    expect(storta.status).toBe(409);
    expect(await storta.json()).toEqual({
      error: `rame non salvato: la pista ${VERSO_MASSA} il tratto da (-10.51; 0) a (-13; -1) non e' a 0, 45 o 90 gradi`,
      reason: `la pista ${VERSO_MASSA} il tratto da (-10.51; 0) a (-13; -1) non e' a 0, 45 o 90 gradi`,
    });
    // a change of layer away from where the trace is: a via in no place
    const senzaVia = await posta({ action: "set", edits: stato0({ pcb_routes: [{ ...laPista, points: [top(-10.51, 0), top(-13, 0), bottom(-13, -3)] }] }) });
    expect(senzaVia.status).toBe(409);
    expect(((await senzaVia.json()) as { reason: string }).reason).toBe(`la pista ${VERSO_MASSA} cambia strato fra (-13; 0) e (-13; -3): una via sta in un punto solo`);
    expect(await scritto()).toBeUndefined();
  });

  it("a correction that starts from copper the saved board does not have, a board saved again meanwhile, no board at all: 409, nothing written", async () => {
    const altrove = await posta({ action: "set", edits: stato0({ pcb_routes: [{ ...laPista, replaces: { original: massaIn(-11), width: 0.2 } }] }) });
    expect(altrove.status).toBe(409);
    expect(await altrove.json()).toMatchObject({ reason: expect.stringContaining("non e' piu' dove il gesto l'ha presa"), cambiata: true });

    stato.meta = { filesHash: stato.riga!.filesHash, createdAt: "2026-11-12T10:00:07.000Z" };
    const intanto = await posta({ action: "set", edits: stato0({ pcb_routes: [laPista] }) });
    expect(intanto.status).toBe(409);
    expect(await intanto.json()).toMatchObject({ reason: "la scheda e' stata salvata di nuovo mentre la leggevo: riprova sulla scheda di adesso", cambiata: true });

    stato.meta = null;
    stato.riga = null;
    const senzaScheda = await posta({ action: "set", edits: stato0({ pcb_routes: [laPista] }) });
    expect(senzaScheda.status).toBe(409);
    expect(await senzaScheda.json()).toEqual({
      error: "rame non salvato: non c'e' una scheda compilata su cui verificarlo: premi Aggiorna",
      reason: "non c'e' una scheda compilata su cui verificarlo: premi Aggiorna",
    });
    expect(await scritto()).toBeUndefined();
    // with no board a state WITHOUT corrections is still written, as before
    expect((await posta({ action: "set", edits: stato0({ pcb_placements: [{ selector: "R2", center: { x: 10, y: 1 } }] }) })).status).toBe(200);
    expect((await salvati()).pcb_placements).toEqual([{ selector: "R2", center: { x: 10, y: 1 } }]);
  });

  it("a good correction is written as the state says it, after one check", async () => {
    const voluto = stato0({ pcb_placements: [{ selector: "R2", center: { x: 10, y: 1 } }], pcb_routes: [laPista], pcb_vias: [laVia] });
    const r = await posta({ action: "set", edits: voluto });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, counts: { routes: 1 } });
    expect(sameManualEdits(await salvati(), parseManualEdits(voluto))).toBe(true);
    expect(verificaRame).toHaveBeenCalledTimes(1);
    // the same state again: it is in the file as it is, nothing enters, nothing is checked
    expect((await posta({ action: "set", edits: voluto })).status).toBe(200);
    expect(verificaRame).toHaveBeenCalledTimes(1);
  });

  it("the undo of a second move: the state of the first drag is accepted, its start remembered on the board, and the fast update lays the first drag's path", async () => {
    // first drag: the trace toward ground from the column of -12, where the files put it, to -13
    expect((await chiama({ gesto: "g1", routes: [massaSpostata] })).status).toBe(200);
    const dopoIlPrimo = (await scritto())!;
    expect(tragitto(await aggiornaVeloce(), VERSO_MASSA)).toEqual([massaIn(-13)]);
    // second drag, from what is on screen: -13 to -14. The file holds one correction, which starts where the files put the trace
    expect((await chiama({ gesto: "g2", routes: [{ ...massaSpostata, points: massaIn(-14), replaces: { original: massaIn(-13), width: 0.2 } }] })).status).toBe(200);
    const dopoIlSecondo = (await scritto())!;
    expect((await salvati()).pcb_routes).toMatchObject([{ points: massaIn(-14), replaces: { original: massaIn(-12), width: 0.2 }, gesto: "g2" }]);
    const conIlSecondo = await aggiornaVeloce();
    expect(tragitto(conIlSecondo, VERSO_MASSA)).toEqual([massaIn(-14)]);
    // the saved board draws the trace at -14 and nowhere says -12, except in what its copper remembers
    expect(pisteDi(conIlSecondo, VERSO_MASSA)[0].replaces).toMatchObject({ original: massaIn(-12) });

    // Cmd+Z: the whole file as it was after the first drag
    vi.mocked(verificaRame).mockClear();
    const annulla = await posta({ action: "set", edits: dopoIlPrimo });
    expect(annulla.status).toBe(200);
    expect(verificaRame).toHaveBeenCalledTimes(1);
    expect(sameManualEdits(await salvati(), parseManualEdits(dopoIlPrimo))).toBe(true);
    expect((await salvati()).pcb_routes).toMatchObject([{ points: massaIn(-13), replaces: { original: massaIn(-12), width: 0.2 }, gesto: "g1" }]);
    const tornata = await aggiornaVeloce();
    expect(tragitto(tornata, VERSO_MASSA)).toEqual([massaIn(-13)]);
    expect(vieIn(tornata)).toEqual(["-13;-3", "-5;0", "0;-6", "5;0"]);
    expect(idDoppi(tornata)).toBeNull();

    // Cmd+Shift+Z: the second drag again, checked again
    const ripeti = await posta({ action: "set", edits: dopoIlSecondo });
    expect(ripeti.status).toBe(200);
    expect(verificaRame).toHaveBeenCalledTimes(2);
    expect(tragitto(await aggiornaVeloce(), VERSO_MASSA)).toEqual([massaIn(-14)]);
  });

  it("an undo that brings one trace back while it lets go of another is judged on the board of the state asked for, not next to what it drops", async () => {
    // first drag: the trace toward ground to the column of -13
    expect((await chiama({ gesto: "g1", routes: [massaSpostata] })).status).toBe(200);
    const dopoIlPrimo = (await scritto())!;
    await aggiornaVeloce();
    /*
     * Second drag, of two traces at once (a trace pushed by another): the
     * trace between the two pins comes down and over the column of -13, and
     * the one toward ground moves on to -14 to leave it room. The two are good
     * together; the pushed one would lie on the trace toward ground where the
     * first drag had left it.
     */
    const fraDeiFile = [top(-9.49, 0), top(-5, 0), bottom(-5, 0), bottom(5, 0), top(5, 0), top(9.49, 0)];
    const fraScesa = [top(-9.49, 0), top(-9.49, -1.5), top(-12.85, -1.5), top(-12.85, -2.5), top(-5, -2.5), top(-5, 0), bottom(-5, 0), bottom(5, 0), top(5, 0), top(9.49, 0)];
    const spinta = { connection: FRA_PIEDINI, points: fraScesa, width: 0.2, viaDiameter: 0.3, viaHoleDiameter: 0.2, replaces: { original: fraDeiFile, width: 0.2 } };
    const piuInLa = { ...massaSpostata, points: massaIn(-14), replaces: { original: massaIn(-13), width: 0.2 } };
    expect((await chiama({ gesto: "g2", routes: [piuInLa, spinta] })).status).toBe(200);
    const conLaSpinta = await aggiornaVeloce();
    expect(tragitto(conLaSpinta, VERSO_MASSA)).toEqual([massaIn(-14)]);
    expect(tragitto(conLaSpinta, FRA_PIEDINI)).toEqual([fraScesa]);
    // the pushed trace alone, next to the first drag's path, is copper `copper` refuses: the two do not fit
    const sola = await chiama({ gesto: "g3", routes: [{ ...massaSpostata, points: massaIn(-13), replaces: { original: massaIn(-14), width: 0.2 } }] });
    expect(sola.status).toBe(409);
    expect(((await sola.json()) as { reason: string }).reason).toMatch(/^il rame viola una distanza che prima era rispettata: /);

    // Cmd+Z: the state of the first drag. The trace toward ground back to -13, the other one let go
    vi.mocked(verificaRame).mockClear();
    const annulla = await posta({ action: "set", edits: dopoIlPrimo });
    expect(annulla.status).toBe(200);
    expect(verificaRame).toHaveBeenCalledTimes(1);
    expect((await salvati()).pcb_routes.map((r) => [r.connection, r.gesto])).toEqual([[VERSO_MASSA, "g1"]]);
    const tornata = await aggiornaVeloce();
    expect(tragitto(tornata, VERSO_MASSA)).toEqual([massaIn(-13)]);
    expect(tragitto(tornata, FRA_PIEDINI)).toEqual([fraDeiFile]);
    expect(vieIn(tornata)).toEqual(["-13;-3", "-5;0", "0;-6", "5;0"]);
    expect(idDoppi(tornata)).toBeNull();
  });

  it("the check is made on the file actually being replaced: a correction another save took out meanwhile enters again, and is checked", async () => {
    // a correction that breaks a distance, put in the file past every door (the store, written directly)
    const sullaPista = { ...laVia, to: { x: 0, y: 0 } };
    const conQuella = stato0({ pcb_vias: [sullaPista] });
    await conLaScheda(FILES, compilata.circuitJson, conQuella);
    // the state asked for holds it as the file does: nothing enters, nothing to check
    expect((await posta({ action: "set", edits: conQuella })).status).toBe(200);
    expect(verificaRame).not.toHaveBeenCalled();

    // the same save, but another one empties the file between its first read and its write
    stato.dopoLaLettura = async () => {
      await writeProjectFile(P, MANUAL_EDITS_PATH, stato0({}));
    };
    const r = await posta({ action: "set", edits: conQuella });
    // on the file it would replace, the correction is new: checked there, refused, and the file stays as the other save left it
    expect(r.status).toBe(409);
    expect(((await r.json()) as { reason: string }).reason).toMatch(/^il rame viola una distanza che prima era rispettata: /);
    expect(verificaRame).toHaveBeenCalledTimes(1);
    expect(await salvati()).toMatchObject({ pcb_routes: [], pcb_vias: [] });

    // and with no board to check it on, the same: refused where it is written, not waved through
    await conLaScheda(FILES, compilata.circuitJson, conQuella);
    stato.riga = null;
    stato.dopoLaLettura = async () => {
      await writeProjectFile(P, MANUAL_EDITS_PATH, stato0({}));
    };
    const senzaScheda = await posta({ action: "set", edits: conQuella });
    expect(senzaScheda.status).toBe(409);
    expect(((await senzaScheda.json()) as { reason: string }).reason).toBe("non c'e' una scheda compilata su cui verificarlo: premi Aggiorna");
    expect(await salvati()).toMatchObject({ pcb_routes: [], pcb_vias: [] });
  });

  it("a state that only keeps or drops corrections is written without a check, and the fast update puts the files' copper back", async () => {
    expect((await chiama({ gesto: "g1", routes: [massaSpostata, allaViaSpostata], vias: [viaSpostata] })).status).toBe(200);
    const conTutte = await salvati();
    const mossa = await aggiornaVeloce();
    expect(tragitto(mossa, VERSO_MASSA)).toEqual([massaIn(-13)]);
    expect(vieIn(mossa)).toEqual(["-13;-3", "-5;0", "0;-5", "5;0"]);
    vi.mocked(verificaRame).mockClear();
    vi.mocked(getCompileMeta).mockClear();

    // the same corrections kept, and something else of the file changed
    const tenute = await posta({ action: "set", edits: serializeManualEdits({ ...conTutte, pcb_placements: [{ selector: "R2", center: { x: 10, y: 1 } }], pcb_routes: [...conTutte.pcb_routes, disegnata] }) });
    expect(tenute.status).toBe(200);
    expect((await salvati()).pcb_routes).toHaveLength(3);
    // one of them dropped: the via and the trace that ends on it go back, the other stays
    const unaSola = await posta({ action: "set", edits: serializeManualEdits({ ...conTutte, pcb_routes: [conTutte.pcb_routes[0]], pcb_vias: [] }) });
    expect(unaSola.status).toBe(200);
    const conUna = await aggiornaVeloce();
    expect(tragitto(conUna, VERSO_MASSA)).toEqual([massaIn(-13)]);
    expect(tragitto(conUna, ALLA_VIA)).toEqual([allaVia(-6)]);
    expect(vieIn(conUna)).toEqual(["-13;-3", "-5;0", "0;-6", "5;0"]);
    // all of them dropped: the copper of the files, as the board compiled from them has it
    const nessuna = await posta({ action: "set", edits: stato0({}) });
    expect(nessuna.status).toBe(200);
    expect(await salvati()).toMatchObject({ pcb_routes: [], pcb_vias: [] });
    const deiFile = await aggiornaVeloce();
    for (const connessione of [VERSO_MASSA, ALLA_VIA, FRA_PIEDINI]) expect(tragitto(deiFile, connessione), connessione).toEqual(tragitto(compilata.circuitJson, connessione));
    expect(vieIn(deiFile)).toEqual(vieIn(compilata.circuitJson));
    expect((deiFile as El[]).filter((e) => e.manual === true || e.moved_from !== undefined)).toEqual([]);
    expect(idDoppi(deiFile)).toBeNull();

    // three saves, and the check never ran: nor was the board asked for again
    expect(verificaRame).not.toHaveBeenCalled();
    expect(getCompileMeta).not.toHaveBeenCalled();
  });

  it("with no correction anywhere it is the save of before: the board read once, nothing checked", async () => {
    await conLaScheda(FILES, compilata.circuitJson, stato0({ pcb_placements: [{ selector: "R1", center: { x: -10, y: 1 } }], pcb_routes: [disegnata as never] }));
    vi.mocked(getCompileCache).mockClear();
    const voluto = stato0({ pcb_placements: [{ selector: "R3", center: { x: -9, y: -6 }, rotation: 90 }], pcb_routes: [{ ...disegnata, id: manualRouteKey(disegnata) } as never] });
    const r = await posta({ action: "set", edits: voluto });
    expect(r.status).toBe(200);
    const detto = (await r.json()) as { ok: boolean; edits: ManualEdits; counts: unknown; orphans: unknown };
    expect(detto.ok).toBe(true);
    expect(sameManualEdits(detto.edits, parseManualEdits(voluto))).toBe(true);
    expect(detto.counts).toEqual({ schematic: 0, pcb: 1, pcbAuto: 0, traceHints: 0, routes: 1, total: 2 });
    expect(detto.orphans).toEqual({ pcb_placements: [], schematic_placements: [], pcb_routes: [], pcb_vias: [], manual_trace_hints: [], total: 0 });
    // the file is the state asked for, and nothing else
    expect(sameManualEdits(await salvati(), parseManualEdits(voluto))).toBe(true);
    expect(await scritto()).not.toContain("pcb_vias");
    // what it read to do it: the saved board once, as before; not its row again, and no check
    expect(getCompileCache).toHaveBeenCalledTimes(1);
    expect(getCompileMeta).not.toHaveBeenCalled();
    expect(verificaRame).not.toHaveBeenCalled();
  });
});
