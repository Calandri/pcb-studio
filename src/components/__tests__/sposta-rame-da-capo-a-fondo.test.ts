import { Fragment, act, createElement, useCallback, useState } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * THE COPPER GESTURE OF "SPOSTA" FROM END TO END, with nothing standing in for
 * anything but the database and the browser:
 *
 *   the real canvas and the real editor (mounted on the fake DOM), the pointer
 *   down on a target, the REAL solver (lib/spinta/gesto.ts), the save the
 *   editor sends, the REAL route of /api/manual-edits (read, check against the
 *   saved board, write), the real fast update, and the board that comes back.
 *
 * The other tests each hold one end still (the canvas with a mocked solver,
 * the solver with no canvas, the route with a body written by hand). This one
 * is here because the three were written apart, against a contract: it says
 * they fit, on a board compiled for real.
 *
 * The files are the real store, in memory; the saved board is handed by a
 * mocked compile cache, as in manual-edits-copper-route.test.ts.
 */
const stato = vi.hoisted(() => ({
  riga: null as null | { filesHash: string; circuitJson: unknown[]; summary: unknown; createdAt: string; engineVersion: number; base: null },
}));
vi.mock("@/lib/acl", () => ({
  requireProjectAccess: async () => ({ ok: true, viewer: null }),
  accessoDaRichiesta: async () => false,
}));
vi.mock("@/lib/project-store", async (originale) => {
  const vero = await originale<typeof import("@/lib/project-store")>();
  return {
    ...vero,
    // a copy, as the database gives one
    getProject: vi.fn(async (id: string) => ({ ...(await vero.getProject(id)) })),
    getCompileCache: vi.fn(async () => stato.riga),
    getCompileMeta: vi.fn(async () => (stato.riga ? { filesHash: stato.riga.filesHash, createdAt: stato.riga.createdAt, engineVersion: stato.riga.engineVersion, base: null } : null)),
  };
});

import { GET, POST } from "@/app/api/manual-edits/route";
import { compileProject } from "@/lib/compile";
import { DESIGN_RULES_PATH, resolveDesignRules } from "@/lib/design-rules";
import { idDoppi } from "@/lib/duplicate-ids";
import { CHECKS_ENGINE_VERSION } from "@/lib/engine-version";
import { MANUAL_EDITS_PATH, parseManualEdits } from "@/lib/manual-edits";
import { filesHash, getProject, writeProjectFile } from "@/lib/project-store";
import { rerouteLocal } from "@/lib/reroute-local";
import { preseDelRame } from "@/lib/spinta/gesto";
import { BoardCanvas } from "../board/BoardCanvas";
import type { CosaSiSposta } from "../board/cosa-si-sposta";
import { VIEW_PRESETS } from "../ViewPresets";
import { EditorBar } from "../workspace/EditorBar";
import { AUTOSAVE_MS, useManualEditor, type ManualEditor } from "../workspace/useManualEditor";
import { apriFinestra, dentro, numeri, type Finestra, type Nodo } from "./dom-finto";

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
const ALLA_VIA = ".R3 > .pin1 to net.GND";
/**
 * A second board, for the push: a trace between two resistors whose long
 * stretch runs along y = 0, and a lone via of ground 1.5 mm above it. Dragged
 * down, the via comes too close to the stretch, which is of another net and
 * can slide: it steps aside.
 */
const MAIN_CON_UNA_VICINA = `export default () => (
  <board width="40mm" height="24mm">
    <net name="GND" />
    <resistor name="R1" resistance="1k" footprint="0402" pcbX={-10} pcbY={2} />
    <resistor name="R2" resistance="1k" footprint="0402" pcbX={10} pcbY={2} />
    <trace from=".R1 > .pin2" to=".R2 > .pin1" pcbPath={[
      { x: 2, y: 0 },
      { x: 4, y: -2 },
      { x: 16, y: -2 },
      { x: 18, y: 0 },
    ]} thickness="0.2mm" />
    <trace from=".R1 > .pin1" to="net.GND" />
    <via name="V1" pcbX={0} pcbY={1.5} connectsTo="net.GND" fromLayer="top" toLayer="bottom" />
  </board>
)
`;
const FILES_CON_UNA_VICINA: Record<string, string> = { "main.tsx": MAIN_CON_UNA_VICINA, [DESIGN_RULES_PATH]: REGOLE };
const VICINA = ".R1 > .pin2 to .R2 > .pin1";
const FLAGS = { ...VIEW_PRESETS[0].flags, is_showing_copper_pours: true };

const mm = (v: unknown) => Math.round(Number(v) * 1e4) / 1e4;
const vie = (cj: unknown[]) => (cj as El[]).filter((e) => e.type === "pcb_via").map((v) => `${mm(v.x)};${mm(v.y)}`).sort();
/** the path of the trace of a connection, by the name the files give it: the place of every wire point, a via where it changes face */
const percorso = (cj: unknown[], connessione: string): string[] => {
  const sorgenti = new Set((cj as El[]).filter((e) => e.type === "source_trace" && e.display_name === connessione).map((e) => e.source_trace_id));
  return (cj as El[])
    .filter((e) => e.type === "pcb_trace" && sorgenti.has(e.source_trace_id))
    .map((e) => ((e.route as Array<Record<string, unknown>>) ?? []).filter((p) => p.route_type === "wire").map((p) => `${mm(p.x)};${mm(p.y)}`).join(" > "));
};

let compilata: Awaited<ReturnType<typeof compileProject>>;
let conUnaVicina: Awaited<ReturnType<typeof compileProject>>;
beforeAll(async () => {
  compilata = await compileProject(FILES);
  conUnaVicina = await compileProject(FILES_CON_UNA_VICINA);
}, 120_000);

let progetto = 0;
let P = "";
let istante = 0;
let f: Finestra;
/** every write the page asked of the server, and what the server answered */
let scritture: Array<{ action: unknown; status: number; error?: unknown }> = [];
const fuori = {} as { editor: ManualEditor; scheda: unknown[] };
/** when set, a `copper` save waits for it before it reaches the server: a save that takes seconds, as on a big board */
let cancello: Promise<void> | null = null;

/** the server: the real routes of /api/manual-edits */
const server = async (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }): Promise<Response> => {
  if (!url.startsWith("/api/manual-edits")) return Response.json({ error: "non c'e'" }, { status: 404 });
  if ((init?.method ?? "GET") === "GET") return GET(new Request(`http://x${url}`));
  if (cancello && (JSON.parse(init?.body ?? "{}") as Record<string, unknown>).action === "copper") await cancello;
  const risposta = await POST(new Request(`http://x${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: init?.body }));
  const corpo = (await risposta.clone().json()) as Record<string, unknown>;
  scritture.push({ action: (JSON.parse(init?.body ?? "{}") as Record<string, unknown>).action, status: risposta.status, ...(corpo.error ? { error: corpo.error } : {}) });
  return risposta;
};
/** what /api/reroute-local does after a save: the fast update of the saved board for the files of now, saved in its place */
const aggiornaVeloce = async (): Promise<unknown[]> => {
  const files = await getProject(P);
  const fatto = rerouteLocal(stato.riga!.circuitJson, files, files[MANUAL_EDITS_PATH]);
  const circuitJson = fatto.circuitJson ?? stato.riga!.circuitJson;
  stato.riga = { ...stato.riga!, filesHash: filesHash(files), circuitJson, createdAt: new Date(Date.UTC(2026, 10, 12, 11, 0, ++istante)).toISOString() };
  return circuitJson;
};

/** when set, the page has the choice of what Sposta moves, as Studio has: the parts to begin with */
let conLaScelta = false;

/** the editor and the canvas of Sposta wired as Studio wires them */
function Pagina() {
  const [cosa, setCosa] = useState<CosaSiSposta>("pezzi");
  const scelta = conLaScelta ? { cosaSiSposta: cosa } : {};
  const [circuitJson, setCircuitJson] = useState(() => stato.riga!.circuitJson);
  const onApplied = useCallback(async () => {
    setCircuitJson(await aggiornaVeloce());
    return { ok: true };
  }, []);
  const editor = useManualEditor({ projectId: P, onApplied });
  const [vista, setVista] = useState(circuitJson);
  if (vista !== circuitJson) {
    setVista(circuitJson);
    editor.dropShownCopper(circuitJson);
  }
  Object.assign(fuori, { editor, scheda: circuitJson });
  return createElement(
    Fragment,
    null,
    createElement(EditorBar, { editor, scope: "pcb", ...scelta, ...(conLaScelta ? { onCosaSiSposta: setCosa } : {}) }),
    createElement(BoardCanvas, {
      circuitJson,
      flags: FLAGS,
      layer: "top",
      mode: editor.mode === "move" ? "move" : "view",
      regole: resolveDesignRules(FILES).rules,
      rameInAttesa: editor.copper,
      onGestoDelRame: editor.addCopper,
      onMoveComponent: () => {},
      onPickComponent: () => {},
      ...scelta,
    } as never),
  );
}

/** the pointer at (x; y) millimetres, off the grid of Sposta (Alt) */
const a = (x: number, y: number) => ({ clientX: x, clientY: -y, altKey: true });
const calma = async () => {
  for (let i = 0; i < 6; i++) await act(async () => void (await new Promise((fatto) => setImmediate(fatto))));
};
const passa = async (ms: number) => {
  await act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
  await calma();
};
const bersaglio = (presa: string): Nodo => f.contenitore.cerca((n) => n.getAttribute("data-presa") === presa)[0];
const salvati = async () => parseManualEdits((await getProject(P))[MANUAL_EDITS_PATH]);
/** the stretches the gesture in hand draws, in millimetres */
const trattiMossi = () =>
  f.contenitore.cerca((n) => n.tagName === "line" && dentro(n, "data-rame-in-movimento")).map((n) => numeri(n, "x1", "y1", "x2", "y2"));
/** the project and its saved board, when a test wants another than the one every test starts with */
async function conLaScheda(files: Record<string, string>, scheda: unknown[]) {
  for (const [path, testo] of Object.entries(files)) await writeProjectFile(P, path, testo);
  stato.riga = { ...stato.riga!, filesHash: filesHash(await getProject(P)), circuitJson: scheda };
}

let smonta: (() => Promise<void>) | null = null;
async function apri() {
  ({ smonta } = await f.monta(createElement(Pagina)));
  await calma();
  await act(async () => fuori.editor.setMode("move"));
}
/** down on a target at `da`, the pointer to `verso`, its frame, and up */
async function trascina(presa: string, da: [number, number], verso: [number, number]) {
  const nodo = bersaglio(presa);
  expect(nodo, `il bersaglio ${presa}`).toBeDefined();
  await f.spara(nodo, "pointerdown", a(...da));
  await f.spara(nodo, "pointermove", a(...verso));
  await f.frame();
  await f.spara(nodo, "pointerup", a(...verso));
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  f = apriFinestra();
  vi.stubGlobal("fetch", server);
  scritture = [];
  P = `prova-da-capo-a-fondo-${++progetto}`;
  for (const [path, testo] of Object.entries(FILES)) await writeProjectFile(P, path, testo);
  stato.riga = { filesHash: filesHash(await getProject(P)), circuitJson: compilata.circuitJson, summary: {}, createdAt: "2026-11-12T10:00:00.000Z", engineVersion: CHECKS_ENGINE_VERSION, base: null };
});

afterEach(async () => {
  conLaScelta = false;
  cancello = null;
  await smonta?.();
  smonta = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  f.chiudi();
});

describe("il gesto sul rame in Sposta, da capo a fondo: visore, risolutore, server e scheda veri", () => {
  it("la scheda dei file: la via sola in (0; -6), la pista che ci finisce, e un bersaglio per ognuna", async () => {
    expect(vie(compilata.circuitJson)).toEqual(["-12;-3", "-5;0", "0;-6", "5;0"]);
    expect(percorso(compilata.circuitJson, ALLA_VIA)).toEqual(["-10.51;-6 > -12;-6 > -12;-8 > 0;-8 > 0;-6"]);
    await apri();
    const prese = preseDelRame(compilata.circuitJson);
    expect(prese.filter((p) => p.tipo === "via")).toHaveLength(4);
    for (const p of prese) {
      const nome = p.tipo === "via" ? `via:${p.pcbViaId}` : `tratto:${p.pcbTraceId}:${p.indice}`;
      // the stretches of the bottom are not drawn with the top chosen: no target for them
      if (p.tipo === "tratto" && p.layer !== "top") expect(bersaglio(nome), nome).toBeUndefined();
      else expect(bersaglio(nome), nome).toBeDefined();
    }
  }, 60_000);

  it("una via trascinata di un millimetro: un salvataggio accettato, la scheda la mostra dov'e' stata messa con la sua pista, e Cmd+Z la riporta", async () => {
    await apri();
    const via = preseDelRame(compilata.circuitJson).find((p) => p.tipo === "via" && p.x === 0 && p.y === -6)!;
    expect(via.tipo).toBe("via");
    await trascina(`via:${via.tipo === "via" ? via.pcbViaId : ""}`, [0, -6], [0, -5]);
    // let go: the gesture waits on screen, nothing is sent before the quiet of the autosave
    expect(fuori.editor.copper).toHaveLength(1);
    expect(scritture).toEqual([]);

    await passa(AUTOSAVE_MS);
    // ONE save, taken by the server as it is: read, checked against the saved board, written
    expect(scritture).toEqual([{ action: "copper", status: 200 }]);
    expect(fuori.editor.error).toBeNull();
    const file = await salvati();
    expect(file.pcb_vias.map((v) => ({ net: v.net, from: v.from, to: v.to }))).toEqual([{ net: "GND", from: { x: 0, y: -6 }, to: { x: 0, y: -5 } }]);
    expect(file.pcb_routes.filter((r) => r.replaces).map((r) => r.connection)).toEqual([ALLA_VIA]);
    // every correction of the drag carries its gesture
    const gesti = new Set([...file.pcb_vias.map((v) => v.gesto), ...file.pcb_routes.map((r) => r.gesto)]);
    expect(gesti.size).toBe(1);
    expect([...gesti][0]).toMatch(/^[\w-]{1,64}$/);

    // the board that came back: the via where it was put, its trace after it, nothing doubled, and nothing left waiting
    expect(vie(fuori.scheda)).toEqual(["-12;-3", "-5;0", "0;-5", "5;0"]);
    expect(percorso(fuori.scheda, ALLA_VIA)).toEqual(["-10.51;-6 > -12;-6 > -12;-8 > 0;-8 > 0;-5"]);
    expect(idDoppi(fuori.scheda)).toBeNull();
    expect(fuori.editor.copper).toEqual([]);

    // Cmd+Z: the file of before, by the save the server checks, and the copper of the files back
    await f.tasto("z", { metaKey: true });
    await calma();
    expect(scritture.map((s) => [s.action, s.status])).toEqual([["copper", 200], ["set", 200]]);
    const tornato = await salvati();
    expect(tornato.pcb_vias).toEqual([]);
    expect(tornato.pcb_routes).toEqual([]);
    expect(vie(fuori.scheda)).toEqual(["-12;-3", "-5;0", "0;-6", "5;0"]);
    expect(percorso(fuori.scheda, ALLA_VIA)).toEqual(["-10.51;-6 > -12;-6 > -12;-8 > 0;-8 > 0;-6"]);

    // Cmd+Shift+Z: the corrections enter again, checked again by the server, and the board shows them
    await f.tasto("z", { metaKey: true, shiftKey: true });
    await calma();
    expect(scritture.map((s) => [s.action, s.status])).toEqual([["copper", 200], ["set", 200], ["set", 200]]);
    expect(vie(fuori.scheda)).toEqual(["-12;-3", "-5;0", "0;-5", "5;0"]);
    expect(idDoppi(fuori.scheda)).toBeNull();
    expect(fuori.editor.error).toBeNull();
  }, 60_000);

  it("un tratto di pista trascinato di lato: scorre lungo la sua normale, i vicini si allungano, il server lo accetta e la scheda lo mostra", async () => {
    await apri();
    // the long stretch of the trace that ends on the via: from (-12; -8) to (0; -8)
    const tratto = preseDelRame(compilata.circuitJson).find((p) => p.tipo === "tratto" && p.y1 === -8 && p.y2 === -8)!;
    expect(tratto.tipo).toBe("tratto");
    const nome = tratto.tipo === "tratto" ? `tratto:${tratto.pcbTraceId}:${tratto.indice}` : "";
    // dragged down by a millimetre and sideways by three: only the part along the normal counts
    await trascina(nome, [-6, -8], [-3, -9]);
    await passa(AUTOSAVE_MS);
    expect(scritture).toEqual([{ action: "copper", status: 200 }]);
    expect(fuori.editor.error).toBeNull();
    expect(percorso(fuori.scheda, ALLA_VIA)).toEqual(["-10.51;-6 > -12;-6 > -12;-9 > 0;-9 > 0;-6"]);
    expect(vie(fuori.scheda)).toEqual(["-12;-3", "-5;0", "0;-6", "5;0"]);
    expect(idDoppi(fuori.scheda)).toBeNull();
    expect(fuori.editor.copper).toEqual([]);
    const file = await salvati();
    expect(file.pcb_vias).toEqual([]);
    expect(file.pcb_routes.map((r) => [r.connection, Boolean(r.replaces)])).toEqual([[ALLA_VIA, true]]);
  }, 60_000);

  it("un tratto trascinato e Cmd+Z: la pista torna sul percorso dei file", async () => {
    await apri();
    const tratto = preseDelRame(compilata.circuitJson).find((p) => p.tipo === "tratto" && p.y1 === -8 && p.y2 === -8)!;
    await trascina(tratto.tipo === "tratto" ? `tratto:${tratto.pcbTraceId}:${tratto.indice}` : "", [-6, -8], [-6, -9]);
    await passa(AUTOSAVE_MS);
    expect(percorso(fuori.scheda, ALLA_VIA)).toEqual(["-10.51;-6 > -12;-6 > -12;-9 > 0;-9 > 0;-6"]);
    await f.tasto("z", { metaKey: true });
    await calma();
    expect(scritture.map((s) => [s.action, s.status])).toEqual([["copper", 200], ["set", 200]]);
    expect(fuori.editor.error).toBeNull();
    expect(percorso(fuori.scheda, ALLA_VIA)).toEqual(["-10.51;-6 > -12;-6 > -12;-8 > 0;-8 > 0;-6"]);
    expect((await salvati()).pcb_routes).toEqual([]);
  }, 60_000);

  it("due spostamenti di fila dello stesso tratto e due Cmd+Z, il secondo con Ctrl: un passo indietro alla volta", async () => {
    await apri();
    const primo = preseDelRame(compilata.circuitJson).find((p) => p.tipo === "tratto" && p.y1 === -8 && p.y2 === -8)!;
    await trascina(primo.tipo === "tratto" ? `tratto:${primo.pcbTraceId}:${primo.indice}` : "", [-6, -8], [-6, -9]);
    await passa(AUTOSAVE_MS);
    expect(percorso(fuori.scheda, ALLA_VIA)).toEqual(["-10.51;-6 > -12;-6 > -12;-9 > 0;-9 > 0;-6"]);
    // the trace is now a correction laid on the board: its stretch is found again where the first gesture left it
    const secondo = preseDelRame(fuori.scheda).find((p) => p.tipo === "tratto" && p.y1 === -9 && p.y2 === -9)!;
    await trascina(secondo.tipo === "tratto" ? `tratto:${secondo.pcbTraceId}:${secondo.indice}` : "", [-6, -9], [-6, -10]);
    await passa(AUTOSAVE_MS);
    expect(percorso(fuori.scheda, ALLA_VIA)).toEqual(["-10.51;-6 > -12;-6 > -12;-10 > 0;-10 > 0;-6"]);

    await f.tasto("z", { metaKey: true });
    await calma();
    expect(percorso(fuori.scheda, ALLA_VIA)).toEqual(["-10.51;-6 > -12;-6 > -12;-9 > 0;-9 > 0;-6"]);
    await f.tasto("z", { ctrlKey: true });
    await calma();
    expect(percorso(fuori.scheda, ALLA_VIA)).toEqual(["-10.51;-6 > -12;-6 > -12;-8 > 0;-8 > 0;-6"]);
    expect(scritture.map((s) => [s.action, s.status])).toEqual([["copper", 200], ["copper", 200], ["set", 200], ["set", 200]]);
    expect(fuori.editor.error).toBeNull();
    expect((await salvati()).pcb_routes).toEqual([]);
  }, 60_000);

  it("un salvataggio che dura secondi: la barra dice che salva, un'altra presa dice di aspettare, e Cmd+Z premuto intanto annulla appena il salvataggio e' finito", async () => {
    await apri();
    const via = preseDelRame(compilata.circuitJson).find((p) => p.tipo === "via" && p.x === 0 && p.y === -6)!;
    const tratto = preseDelRame(compilata.circuitJson).find((p) => p.tipo === "tratto" && p.y1 === -8 && p.y2 === -8)!;
    let apriIlCancello!: () => void;
    cancello = new Promise<void>((ok) => {
      apriIlCancello = ok;
    });
    await trascina(`via:${via.tipo === "via" ? via.pcbViaId : ""}`, [0, -6], [0, -5]);
    await passa(AUTOSAVE_MS);
    // the save is on its way and does not come back: the gesture waits on screen
    expect(fuori.editor.saveState).toBe("salvo");
    expect(fuori.editor.copper).toHaveLength(1);
    expect(scritture).toEqual([]);

    // a press on other copper meanwhile starts nothing, and says why on the board
    const nodo = bersaglio(tratto.tipo === "tratto" ? `tratto:${tratto.pcbTraceId}:${tratto.indice}` : "");
    await f.spara(nodo, "pointerdown", a(-6, -8));
    await f.spara(nodo, "pointerup", a(-6, -8));
    expect(f.contenitore.textContent).toContain("un momento: la scheda sta ancora seguendo lo spostamento di prima");
    expect(fuori.editor.copper).toHaveLength(1);

    // Cmd+Z while it saves: it waits its turn behind the save
    await f.tasto("z", { metaKey: true });
    await calma();
    expect(scritture).toEqual([]);
    apriIlCancello();
    cancello = null;
    await calma();
    await calma();
    expect(scritture.map((s) => [s.action, s.status])).toEqual([["copper", 200], ["set", 200]]);
    expect(fuori.editor.error).toBeNull();
    // the file and the board are the ones of before, and nothing is left waiting on screen
    expect((await salvati()).pcb_vias).toEqual([]);
    expect(vie(fuori.scheda)).toEqual(["-12;-3", "-5;0", "0;-6", "5;0"]);
    expect(fuori.editor.copper).toEqual([]);
    expect(fuori.editor.canRedo).toBe(true);
  }, 60_000);

  it("la barra sceglie cosa si sposta: coi componenti il rame non si prende, con le vie si trascina la via, con le piste il tratto", async () => {
    conLaScelta = true;
    await apri();
    const via = preseDelRame(compilata.circuitJson).find((p) => p.tipo === "via" && p.x === 0 && p.y === -6)!;
    const tratto = preseDelRame(compilata.circuitJson).find((p) => p.tipo === "tratto" && p.y1 === -8 && p.y2 === -8)!;
    const presaVia = `via:${via.tipo === "via" ? via.pcbViaId : ""}`;
    const presaTratto = tratto.tipo === "tratto" ? `tratto:${tratto.pcbTraceId}:${tratto.indice}` : "";
    const bottone = (nome: string) => f.contenitore.cerca((n) => n.tagName === "BUTTON" && n.textContent === nome)[0];
    const scelto = () => f.contenitore.cerca((n) => n.getAttribute("data-cosa-si-sposta") !== null)[0]?.getAttribute("data-cosa-si-sposta");

    // the parts to begin with, as Sposta always was: no copper under the pointer
    expect(scelto()).toBe("pezzi");
    expect(bersaglio(presaVia)).toBeUndefined();
    expect(bersaglio(presaTratto)).toBeUndefined();

    // the vias: the via is there, the stretch is not
    await f.spara(bottone("vie"), "click");
    expect(scelto()).toBe("vie");
    expect(bersaglio(presaVia)).toBeDefined();
    expect(bersaglio(presaTratto)).toBeUndefined();
    await trascina(presaVia, [0, -6], [0, -5]);
    await passa(AUTOSAVE_MS);
    expect(scritture).toEqual([{ action: "copper", status: 200 }]);
    expect(vie(fuori.scheda)).toEqual(["-12;-3", "-5;0", "0;-5", "5;0"]);

    // the traces: the stretch is there, no via is
    await f.spara(bottone("piste"), "click");
    expect(scelto()).toBe("piste");
    expect(f.contenitore.cerca((n) => (n.getAttribute("data-presa") ?? "").startsWith("via:"))).toEqual([]);
    const ora = preseDelRame(fuori.scheda).find((p) => p.tipo === "tratto" && p.y1 === -8 && p.y2 === -8)!;
    const presaOra = ora.tipo === "tratto" ? `tratto:${ora.pcbTraceId}:${ora.indice}` : "";
    expect(bersaglio(presaOra)).toBeDefined();
    await trascina(presaOra, [-6, -8], [-6, -9]);
    await passa(AUTOSAVE_MS);
    expect(scritture.map((s) => [s.action, s.status])).toEqual([["copper", 200], ["copper", 200]]);
    expect(percorso(fuori.scheda, ALLA_VIA)).toEqual(["-10.51;-6 > -12;-6 > -12;-9 > 0;-9 > 0;-5"]);
    expect(fuori.editor.error).toBeNull();
  }, 60_000);

  it("una via trascinata contro una pista di un'altra rete la spinge da parte: si vede mentre si trascina, si salva con la via in un salvataggio solo, e Cmd+Z rimette tutte e due", async () => {
    await conLaScheda(FILES_CON_UNA_VICINA, conUnaVicina.circuitJson);
    const DEI_FILE = "-9.49;2 > -8;2 > -6;0 > 6;0 > 8;2 > 9.49;2";
    // the ring of the via is 0.3 across, the trace 0.2 wide, the distance to keep 0.2: with the via at y = 0.3 the stretch goes to y = -0.15
    const SPINTA = "-9.49;2 > -8;2 > -5.85;-0.15 > 5.85;-0.15 > 8;2 > 9.49;2";
    expect(percorso(conUnaVicina.circuitJson, VICINA)).toEqual([DEI_FILE]);
    expect(vie(conUnaVicina.circuitJson)).toEqual(["0;1.5"]);
    await apri();
    const via = preseDelRame(conUnaVicina.circuitJson).find((p) => p.tipo === "via")!;
    const nodo = bersaglio(`via:${via.tipo === "via" ? via.pcbViaId : ""}`);
    expect(nodo).toBeDefined();

    // in hand, halfway: the via is still far enough, the trace is where the files put it and the gesture does not draw it
    await f.spara(nodo, "pointerdown", a(0, 1.5));
    await f.spara(nodo, "pointermove", a(0, 0.9));
    await f.frame();
    expect(trattiMossi()).toEqual([]);
    // further down: the trace steps aside, and the gesture draws it where it was pushed
    await f.spara(nodo, "pointermove", a(0, 0.3));
    await f.frame();
    expect(trattiMossi()).toContainEqual([-5.85, -0.15, 5.85, -0.15]);
    // back up: the trace is back by itself
    await f.spara(nodo, "pointermove", a(0, 0.9));
    await f.frame();
    expect(trattiMossi()).toEqual([]);
    // and down again, where it is let go
    await f.spara(nodo, "pointermove", a(0, 0.3));
    await f.frame();
    await f.spara(nodo, "pointerup", a(0, 0.3));

    await passa(AUTOSAVE_MS);
    // ONE save for the via and for the trace it pushed, taken by the server as it is
    expect(scritture).toEqual([{ action: "copper", status: 200 }]);
    expect(fuori.editor.error).toBeNull();
    const file = await salvati();
    expect(file.pcb_vias.map((v) => ({ net: v.net, from: v.from, to: v.to }))).toEqual([{ net: "GND", from: { x: 0, y: 1.5 }, to: { x: 0, y: 0.3 } }]);
    expect(file.pcb_routes.map((r) => [r.connection, Boolean(r.replaces)])).toEqual([[VICINA, true]]);
    expect(new Set([...file.pcb_vias.map((v) => v.gesto), ...file.pcb_routes.map((r) => r.gesto)]).size).toBe(1);
    // the board that came back: the via where it was put, the trace pushed aside, one trace for its connection
    expect(vie(fuori.scheda)).toEqual(["0;0.3"]);
    expect(percorso(fuori.scheda, VICINA)).toEqual([SPINTA]);
    expect(idDoppi(fuori.scheda)).toBeNull();
    expect(fuori.editor.copper).toEqual([]);

    // Cmd+Z: one step takes back the via AND the trace it pushed
    await f.tasto("z", { metaKey: true });
    await calma();
    expect(scritture.map((s) => [s.action, s.status])).toEqual([["copper", 200], ["set", 200]]);
    expect(vie(fuori.scheda)).toEqual(["0;1.5"]);
    expect(percorso(fuori.scheda, VICINA)).toEqual([DEI_FILE]);
    expect((await salvati()).pcb_routes).toEqual([]);
  }, 60_000);

  it("una via spinta contro il bordo si ferma prima: il rame arriva fin dove puo', e quello si salva", async () => {
    await apri();
    const via = preseDelRame(compilata.circuitJson).find((p) => p.tipo === "via" && p.x === 0 && p.y === -6)!;
    // the board ends at y = -12: the pointer goes well past it
    await trascina(`via:${via.tipo === "via" ? via.pcbViaId : ""}`, [0, -6], [0, -20]);
    await passa(AUTOSAVE_MS);
    expect(scritture).toEqual([{ action: "copper", status: 200 }]);
    const [doveSta] = vie(fuori.scheda).filter((v) => v.startsWith("0;"));
    const y = Number(doveSta.split(";")[1]);
    // moved toward the edge, and stopped inside the board with its ring and the edge clearance
    expect(y).toBeLessThan(-6);
    expect(y).toBeGreaterThan(-12 + 0.15);
    expect(idDoppi(fuori.scheda)).toBeNull();
  }, 60_000);
});
