import { Fragment, act, createElement, useCallback, useMemo, useState } from "react";
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
import { rameDelFile, schedaConIlRame } from "@/lib/spinta/rame-locale";
import { BoardCanvas } from "../board/BoardCanvas";
import { NESSUN_RAME } from "../board/gesto-del-rame";
import type { CosaSiSposta } from "../board/cosa-si-sposta";
import { VIEW_PRESETS } from "../ViewPresets";
import { EditorBar } from "../workspace/EditorBar";
import { AGGIORNAMENTI_INDIETRO, AUTOSAVE_MS, RIPROVE_DEL_RAME, SEGUE_IL_RAME_MS, useManualEditor, type ManualEditor } from "../workspace/useManualEditor";
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
/** `scheda`: the saved board the page holds; `locale`: the board the canvas draws, with the gestures waiting laid on it */
const fuori = {} as { editor: ManualEditor; scheda: unknown[]; locale: unknown[] };
/** when set, the fast update waits for it before it answers: the seconds the saved board takes to follow on a big board */
let cancelloDellaScheda: Promise<void> | null = null;
/** how many `copper` saves the server answers with "the board was saved again, try again" before it takes one */
let riprove = 0;
/** how many fast updates of the saved board were asked */
let aggiornamenti = 0;
/** how many fast updates come back "the files changed while I worked, ask again" before one is done */
let indietro = 0;
/** when set, a `copper` save waits for it before it reaches the server: a save that takes seconds, as on a big board */
let cancello: Promise<void> | null = null;

/** the server: the real routes of /api/manual-edits */
const server = async (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }): Promise<Response> => {
  if (!url.startsWith("/api/manual-edits")) return Response.json({ error: "non c'e'" }, { status: 404 });
  if ((init?.method ?? "GET") === "GET") return GET(new Request(`http://x${url}`));
  if (cancello && (JSON.parse(init?.body ?? "{}") as Record<string, unknown>).action === "copper") await cancello;
  if (riprove > 0 && (JSON.parse(init?.body ?? "{}") as Record<string, unknown>).action === "copper") {
    riprove -= 1;
    // what rameRifiutato(SCHEDA_RISALVATA, true, true) answers when a fast update saved a board under the save
    scritture.push({ action: "copper", status: 409, error: "riprova" });
    return Response.json({ error: "rame non salvato: la scheda e' stata salvata di nuovo mentre la leggevo: riprova sulla scheda di adesso", cambiata: true, riprova: true }, { status: 409 });
  }
  const risposta = await POST(new Request(`http://x${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: init?.body }));
  const corpo = (await risposta.clone().json()) as Record<string, unknown>;
  scritture.push({ action: (JSON.parse(init?.body ?? "{}") as Record<string, unknown>).action, status: risposta.status, ...(corpo.error ? { error: corpo.error } : {}) });
  return risposta;
};
/** what /api/reroute-local does after a save: the fast update of the saved board for the files of now, saved in its place */
const aggiornaVeloce = async (): Promise<unknown[]> => {
  aggiornamenti += 1;
  if (cancelloDellaScheda) await cancelloDellaScheda;
  const files = await getProject(P);
  const fatto = rerouteLocal(stato.riga!.circuitJson, files, files[MANUAL_EDITS_PATH]);
  const circuitJson = fatto.circuitJson ?? stato.riga!.circuitJson;
  stato.riga = { ...stato.riga!, filesHash: filesHash(files), circuitJson, createdAt: new Date(Date.UTC(2026, 10, 12, 11, 0, ++istante)).toISOString() };
  return circuitJson;
};

/** when set, the page has the choice of what Sposta moves, as Studio has: the parts to begin with */
let conLaScelta = false;

const REGOLE_LETTE = resolveDesignRules(FILES).rules;

/** the editor and the canvas of Sposta wired as Studio wires them */
function Pagina() {
  const [cosa, setCosa] = useState<CosaSiSposta>("pezzi");
  const scelta = conLaScelta ? { cosaSiSposta: cosa } : {};
  const [circuitJson, setCircuitJson] = useState(() => stato.riga!.circuitJson);
  const onApplied = useCallback(async () => {
    if (indietro > 0) {
      // what Studio answers when /api/reroute-local says `retry` with `fileCambiati`: the board is not saved, nothing is wrong
      indietro -= 1;
      aggiornamenti += 1;
      return { ok: false, retry: true, reason: "i file sono cambiati mentre aggiornavo la scheda: riprovo su quelli di adesso" };
    }
    setCircuitJson(await aggiornaVeloce());
    return { ok: true };
  }, []);
  const editor = useManualEditor({ projectId: P, onApplied });
  const [vista, setVista] = useState(circuitJson);
  if (vista !== circuitJson) {
    setVista(circuitJson);
    editor.dropShownCopper(circuitJson);
  }
  // the board of Sposta, as Studio works it out: the saved board with the gestures waiting already laid on it
  const { rameAvanti, rameDaPosare, saved } = editor;
  const locale = useMemo(
    () => (rameAvanti ? schedaConIlRame({ circuitJson, regole: REGOLE_LETTE, saved, gesti: rameDaPosare }) : circuitJson),
    [circuitJson, rameAvanti, rameDaPosare, saved],
  );
  Object.assign(fuori, { editor, scheda: circuitJson, locale });
  return createElement(
    Fragment,
    null,
    createElement(EditorBar, { editor, scope: "pcb", ...scelta, ...(conLaScelta ? { onCosaSiSposta: setCosa } : {}) }),
    createElement(BoardCanvas, {
      circuitJson: locale,
      flags: FLAGS,
      layer: "top",
      mode: editor.mode === "move" ? "move" : "view",
      regole: REGOLE_LETTE,
      rameInAttesa: NESSUN_RAME,
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
/** the quiet of the autosave, then the quiet after which the saved board follows the copper: a gesture written and on the saved board */
const salvaEsegue = async () => {
  await passa(AUTOSAVE_MS);
  await passa(SEGUE_IL_RAME_MS);
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
  cancelloDellaScheda = null;
  riprove = 0;
  aggiornamenti = 0;
  indietro = 0;
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

    await salvaEsegue();
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
    await salvaEsegue();
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
    await salvaEsegue();
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
    await salvaEsegue();
    expect(percorso(fuori.scheda, ALLA_VIA)).toEqual(["-10.51;-6 > -12;-6 > -12;-9 > 0;-9 > 0;-6"]);
    // the trace is now a correction laid on the board: its stretch is found again where the first gesture left it
    const secondo = preseDelRame(fuori.scheda).find((p) => p.tipo === "tratto" && p.y1 === -9 && p.y2 === -9)!;
    await trascina(secondo.tipo === "tratto" ? `tratto:${secondo.pcbTraceId}:${secondo.indice}` : "", [-6, -9], [-6, -10]);
    await salvaEsegue();
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

  it("un salvataggio che dura secondi: la barra dice che salva, un altro gesto parte subito dalla scheda col primo gia' posato, e i due si salvano in fila", async () => {
    await apri();
    const via = preseDelRame(compilata.circuitJson).find((p) => p.tipo === "via" && p.x === 0 && p.y === -6)!;
    let apriIlCancello!: () => void;
    cancello = new Promise<void>((ok) => {
      apriIlCancello = ok;
    });
    await trascina(`via:${via.tipo === "via" ? via.pcbViaId : ""}`, [0, -6], [0, -5]);
    await salvaEsegue();
    // the save is on its way and does not come back: the gesture waits to be written
    expect(fuori.editor.saveState).toBe("salvo");
    expect(fuori.editor.copper).toHaveLength(1);
    expect(scritture).toEqual([]);
    // the saved board is the one of before; the board the canvas draws has the via where it was put, with its trace
    expect(vie(fuori.scheda)).toEqual(["-12;-3", "-5;0", "0;-6", "5;0"]);
    expect(vie(fuori.locale)).toEqual(["-12;-3", "-5;0", "0;-5", "5;0"]);
    expect(percorso(fuori.locale, ALLA_VIA)).toEqual(["-10.51;-6 > -12;-6 > -12;-8 > 0;-8 > 0;-5"]);
    expect(idDoppi(fuori.locale)).toBeNull();

    // a stretch of that same trace, taken meanwhile: the gesture starts at once, from where the first one left the copper
    const tratto = preseDelRame(fuori.locale).find((p) => p.tipo === "tratto" && p.y1 === -8 && p.y2 === -8)!;
    expect(tratto.tipo).toBe("tratto");
    await trascina(tratto.tipo === "tratto" ? `tratto:${tratto.pcbTraceId}:${tratto.indice}` : "", [-6, -8], [-6, -9]);
    expect(f.contenitore.textContent).not.toContain("un momento");
    expect(fuori.editor.copper).toHaveLength(2);
    expect(percorso(fuori.locale, ALLA_VIA)).toEqual(["-10.51;-6 > -12;-6 > -12;-9 > 0;-9 > 0;-5"]);
    expect(vie(fuori.locale)).toEqual(["-12;-3", "-5;0", "0;-5", "5;0"]);
    expect(idDoppi(fuori.locale)).toBeNull();
    // what the page expects the file to hold once both are saved
    const atteso = rameDelFile(fuori.editor.saved, fuori.scheda, fuori.editor.rameDaPosare);

    // the first save comes back, the second goes after it: both taken by the server, in the order they were made
    await salvaEsegue();
    expect(scritture).toEqual([]);
    apriIlCancello();
    cancello = null;
    await calma();
    await calma();
    expect(scritture.map((s) => [s.action, s.status])).toEqual([["copper", 200], ["copper", 200]]);
    expect(fuori.editor.error).toBeNull();
    // written, and the saved board has not followed yet: it does when the hand has been still, once for the two
    expect(vie(fuori.scheda)).toEqual(["-12;-3", "-5;0", "0;-6", "5;0"]);
    expect(fuori.editor.saveState).toBe("segue");
    expect(aggiornamenti).toBe(0);
    await passa(SEGUE_IL_RAME_MS);
    expect(aggiornamenti).toBe(1);
    // the file the server holds is the one the page had laid, and the saved board shows the same copper
    const file = await salvati();
    const senzaFirma = <T extends { gesto?: string; at?: string }>(v: T) => ({ ...v, gesto: undefined, at: undefined });
    expect(file.pcb_vias.map(senzaFirma)).toEqual(atteso.vias.map(senzaFirma));
    expect(file.pcb_routes.map(senzaFirma)).toEqual(atteso.routes.map(senzaFirma));
    expect(vie(fuori.scheda)).toEqual(["-12;-3", "-5;0", "0;-5", "5;0"]);
    expect(percorso(fuori.scheda, ALLA_VIA)).toEqual(["-10.51;-6 > -12;-6 > -12;-9 > 0;-9 > 0;-5"]);
    expect(idDoppi(fuori.scheda)).toBeNull();
    expect(fuori.editor.copper).toEqual([]);
    expect(fuori.editor.rameAvanti).toBe(false);
    // nothing ahead of the saved board: the canvas draws that very board
    expect(fuori.locale).toBe(fuori.scheda);

    // Cmd+Z twice: one gesture back at a time
    await f.tasto("z", { metaKey: true });
    await calma();
    expect(percorso(fuori.scheda, ALLA_VIA)).toEqual(["-10.51;-6 > -12;-6 > -12;-8 > 0;-8 > 0;-5"]);
    await f.tasto("z", { metaKey: true });
    await calma();
    expect(vie(fuori.scheda)).toEqual(["-12;-3", "-5;0", "0;-6", "5;0"]);
    expect(percorso(fuori.scheda, ALLA_VIA)).toEqual(["-10.51;-6 > -12;-6 > -12;-8 > 0;-8 > 0;-6"]);
    expect((await salvati()).pcb_vias).toEqual([]);
    expect(fuori.editor.error).toBeNull();
  }, 60_000);

  it("la scheda salvata ci mette secondi a seguire: i gesti non la aspettano, e quando arriva li mostra tutti", async () => {
    await apri();
    const via = preseDelRame(compilata.circuitJson).find((p) => p.tipo === "via" && p.x === 0 && p.y === -6)!;
    let apriLaScheda!: () => void;
    cancelloDellaScheda = new Promise<void>((ok) => {
      apriLaScheda = ok;
    });
    await trascina(`via:${via.tipo === "via" ? via.pcbViaId : ""}`, [0, -6], [0, -5]);
    await salvaEsegue();
    // written, and the fast update that follows it does not come back: the saved board is still the old one
    expect(scritture.map((s) => [s.action, s.status])).toEqual([["copper", 200]]);
    expect(fuori.editor.saveState).toBe("segue");
    expect(vie(fuori.scheda)).toEqual(["-12;-3", "-5;0", "0;-6", "5;0"]);
    expect(vie(fuori.locale)).toEqual(["-12;-3", "-5;0", "0;-5", "5;0"]);

    // the via again, from where it stands on the board the canvas draws: no waiting for the saved one
    const ora = preseDelRame(fuori.locale).find((p) => p.tipo === "via" && p.x === 0 && p.y === -5)!;
    expect(ora.tipo).toBe("via");
    await trascina(`via:${ora.tipo === "via" ? ora.pcbViaId : ""}`, [0, -5], [1, -5]);
    expect(f.contenitore.textContent).not.toContain("un momento");
    await salvaEsegue();
    expect(scritture.map((s) => [s.action, s.status])).toEqual([["copper", 200], ["copper", 200]]);
    expect(vie(fuori.locale)).toEqual(["-12;-3", "-5;0", "1;-5", "5;0"]);
    expect(fuori.editor.error).toBeNull();

    // the saved board catches up: it shows both, and the canvas goes back to drawing it as it is
    apriLaScheda();
    cancelloDellaScheda = null;
    await calma();
    await calma();
    expect(vie(fuori.scheda)).toEqual(["-12;-3", "-5;0", "1;-5", "5;0"]);
    expect(idDoppi(fuori.scheda)).toBeNull();
    expect(fuori.editor.copper).toEqual([]);
    expect(fuori.locale).toBe(fuori.scheda);
    // one correction in the file, from where the files put the via to where it stands now
    expect((await salvati()).pcb_vias.map((v) => ({ from: v.from, to: v.to }))).toEqual([{ from: { x: 0, y: -6 }, to: { x: 1, y: -5 } }]);
  }, 60_000);

  it("la scheda risalvata sotto un salvataggio (l'aggiornamento veloce del gesto di prima): il server dice di riprovare, la pagina riprova da sola e il gesto non si perde", async () => {
    await apri();
    const via = preseDelRame(compilata.circuitJson).find((p) => p.tipo === "via" && p.x === 0 && p.y === -6)!;
    riprove = 2;
    await trascina(`via:${via.tipo === "via" ? via.pcbViaId : ""}`, [0, -6], [0, -5]);
    await salvaEsegue();
    await passa(300);
    await passa(600);
    expect(scritture.map((s) => [s.action, s.status])).toEqual([["copper", 409], ["copper", 409], ["copper", 200]]);
    expect(fuori.editor.error).toBeNull();
    expect(vie(fuori.scheda)).toEqual(["-12;-3", "-5;0", "0;-5", "5;0"]);
    expect(fuori.editor.copper).toEqual([]);

    // a refusal that does not go away is said, and the copper goes back: the gesture is not tried for ever
    const ora = preseDelRame(fuori.scheda).find((p) => p.tipo === "via" && p.x === 0 && p.y === -5)!;
    riprove = 99;
    await trascina(`via:${ora.tipo === "via" ? ora.pcbViaId : ""}`, [0, -5], [1, -5]);
    await salvaEsegue();
    for (let i = 1; i <= RIPROVE_DEL_RAME; i++) await passa(300 * i);
    expect(scritture.filter((s) => s.status === 409)).toHaveLength(2 + RIPROVE_DEL_RAME);
    expect(fuori.editor.error).toContain("riprova sulla scheda di adesso");
    expect(fuori.editor.copper).toEqual([]);
    expect(vie(fuori.locale)).toEqual(["-12;-3", "-5;0", "0;-5", "5;0"]);
  }, 60_000);

  it("una via incollata si prende subito: spostata, poi tolta con Canc, senza aspettare un salvataggio; i tre si salvano in fila e Cmd+Z la rimette", async () => {
    conLaScelta = true;
    await apri();
    const bottone = (nome: string) => f.contenitore.cerca((n) => n.tagName === "BUTTON" && n.textContent === nome)[0];
    // the canvas of the board: the svg the copper targets are in (the bar has svgs of its own)
    const tavola = () => f.contenitore.cerca((n) => n.tagName === "svg" && n.cerca((q) => q.getAttribute("data-presa") !== null).length > 0)[0];
    const scelta = () => f.contenitore.cerca((n) => n.getAttribute("data-via-scelta") !== null)[0];
    await f.spara(bottone("vie"), "click");
    // the lone via of ground, chosen with a press and copied
    const via = preseDelRame(compilata.circuitJson).find((p) => p.tipo === "via" && p.x === 0 && p.y === -6)!;
    const presa = bersaglio(`via:${via.tipo === "via" ? via.pcbViaId : ""}`);
    await f.spara(presa, "pointerdown", a(0, -6));
    await f.spara(presa, "pointerup", a(0, -6));
    await f.tasto("c", { metaKey: true });
    // pasted at (6; -9): on the board the canvas draws at once, a via like the others
    await f.spara(tavola(), "pointermove", a(6, -9));
    await f.tasto("v", { metaKey: true });
    expect(fuori.editor.copper).toHaveLength(1);
    expect(vie(fuori.locale)).toEqual(["-12;-3", "-5;0", "0;-6", "5;0", "6;-9"]);
    const incollata = preseDelRame(fuori.locale).find((p) => p.tipo === "via" && p.x === 6 && p.y === -9)!;
    expect(incollata.tipo).toBe("via");

    // taken and moved before anything is saved
    await trascina(`via:${incollata.tipo === "via" ? incollata.pcbViaId : ""}`, [6, -9], [8, -9]);
    expect(f.contenitore.textContent).not.toContain("un momento");
    expect(fuori.editor.copper).toHaveLength(2);
    expect(vie(fuori.locale)).toEqual(["-12;-3", "-5;0", "0;-6", "5;0", "8;-9"]);
    // the choice went with the via: it is the one Canc speaks of
    expect(numeri(scelta(), "cx", "cy")).toEqual([8, -9]);
    expect(scritture).toEqual([]);

    // Canc: the via goes at once, and nothing has been written yet
    await f.tasto("Delete");
    expect(fuori.editor.copper).toHaveLength(3);
    expect(vie(fuori.locale)).toEqual(["-12;-3", "-5;0", "0;-6", "5;0"]);
    expect(scelta()).toBeUndefined();

    // the three go in the order they were made: pasted, moved, taken out
    await salvaEsegue();
    expect(scritture.map((s) => [s.action, s.status])).toEqual([["copper", 200], ["copper", 200], ["unpaste", 200]]);
    expect(fuori.editor.error).toBeNull();
    expect((await salvati()).pcb_vias).toEqual([]);
    expect(vie(fuori.scheda)).toEqual(["-12;-3", "-5;0", "0;-6", "5;0"]);
    expect(fuori.editor.copper).toEqual([]);

    // Cmd+Z puts it back where it was taken out, as a pasted via still
    await f.tasto("z", { metaKey: true });
    await calma();
    expect((await salvati()).pcb_vias.map((v) => ({ net: v.net, to: v.to, aggiunta: v.aggiunta }))).toEqual([{ net: "GND", to: { x: 8, y: -9 }, aggiunta: true }]);
    expect(vie(fuori.scheda)).toEqual(["-12;-3", "-5;0", "0;-6", "5;0", "8;-9"]);
    expect(fuori.editor.error).toBeNull();
  }, 60_000);

  it("Canc su una via dei file non la toglie e dice perche'; Canc su una incollata e Cmd+Z prima del salvataggio la rimette senza scrivere niente", async () => {
    conLaScelta = true;
    await apri();
    const bottone = (nome: string) => f.contenitore.cerca((n) => n.tagName === "BUTTON" && n.textContent === nome)[0];
    // the canvas of the board: the svg the copper targets are in (the bar has svgs of its own)
    const tavola = () => f.contenitore.cerca((n) => n.tagName === "svg" && n.cerca((q) => q.getAttribute("data-presa") !== null).length > 0)[0];
    await f.spara(bottone("vie"), "click");
    const via = preseDelRame(compilata.circuitJson).find((p) => p.tipo === "via" && p.x === 0 && p.y === -6)!;
    const presa = bersaglio(`via:${via.tipo === "via" ? via.pcbViaId : ""}`);
    await f.spara(presa, "pointerdown", a(0, -6));
    await f.spara(presa, "pointerup", a(0, -6));
    // a via of the files: not from here
    await f.tasto("Delete");
    expect(f.contenitore.textContent).toContain("da qui si tolgono solo le vie incollate");
    expect(fuori.editor.copper).toEqual([]);
    const elimina = () => f.contenitore.cerca((n) => n.getAttribute("data-duplica-via-togli") !== null)[0];
    expect(elimina().getAttribute("disabled")).not.toBeNull();

    await f.tasto("c", { metaKey: true });
    await f.spara(tavola(), "pointermove", a(6, -9));
    await f.tasto("v", { metaKey: true });
    await salvaEsegue();
    expect(scritture.map((s) => [s.action, s.status])).toEqual([["copper", 200]]);
    expect(vie(fuori.scheda)).toEqual(["-12;-3", "-5;0", "0;-6", "5;0", "6;-9"]);

    // the pasted one, chosen: the button of the panel takes it out
    const incollata = preseDelRame(fuori.scheda).find((p) => p.tipo === "via" && p.x === 6 && p.y === -9)!;
    const sua = bersaglio(`via:${incollata.tipo === "via" ? incollata.pcbViaId : ""}`);
    await f.spara(sua, "pointerdown", a(6, -9));
    await f.spara(sua, "pointerup", a(6, -9));
    expect(elimina().getAttribute("disabled")).toBeNull();
    await f.spara(elimina(), "click");
    expect(vie(fuori.locale)).toEqual(["-12;-3", "-5;0", "0;-6", "5;0"]);
    // Cmd+Z before the quiet of the autosave: the via is back, and the server was asked nothing
    await f.tasto("z", { metaKey: true });
    expect(vie(fuori.locale)).toEqual(["-12;-3", "-5;0", "0;-6", "5;0", "6;-9"]);
    await salvaEsegue();
    expect(scritture.map((s) => [s.action, s.status])).toEqual([["copper", 200]]);
    expect((await salvati()).pcb_vias).toHaveLength(1);
  }, 60_000);

  it("Cmd+Z su un gesto non ancora inviato, mentre quello di prima si sta salvando: sparisce e NON viene scritto quando tocca a lui", async () => {
    await apri();
    const via = preseDelRame(compilata.circuitJson).find((p) => p.tipo === "via" && p.x === 0 && p.y === -6)!;
    await trascina(`via:${via.tipo === "via" ? via.pcbViaId : ""}`, [0, -6], [0, -5]);
    // the second let go before the first is sent: one round of saves takes them both, one after the other
    const ora = preseDelRame(fuori.locale).find((p) => p.tipo === "via" && p.x === 0 && p.y === -5)!;
    await trascina(`via:${ora.tipo === "via" ? ora.pcbViaId : ""}`, [0, -5], [1, -5]);
    expect(fuori.editor.copper).toHaveLength(2);
    let apriIlCancello!: () => void;
    cancello = new Promise<void>((ok) => {
      apriIlCancello = ok;
    });
    await passa(AUTOSAVE_MS);
    // the first is on its way, held; the second waits its turn in the same round
    expect(scritture).toEqual([]);
    expect(vie(fuori.locale)).toEqual(["-12;-3", "-5;0", "1;-5", "5;0"]);

    // Cmd+Z: the second goes back at once
    await f.tasto("z", { metaKey: true });
    expect(fuori.editor.copper).toHaveLength(1);
    expect(vie(fuori.locale)).toEqual(["-12;-3", "-5;0", "0;-5", "5;0"]);

    // the first save comes back: the second is NOT written after it
    apriIlCancello();
    cancello = null;
    await calma();
    await calma();
    await passa(AUTOSAVE_MS);
    await passa(SEGUE_IL_RAME_MS);
    expect(scritture.map((s) => [s.action, s.status])).toEqual([["copper", 200]]);
    expect((await salvati()).pcb_vias.map((v) => v.to)).toEqual([{ x: 0, y: -5 }]);
    expect(vie(fuori.scheda)).toEqual(["-12;-3", "-5;0", "0;-5", "5;0"]);
    expect(fuori.editor.copper).toEqual([]);
    expect(fuori.editor.error).toBeNull();
    // and it can be done again: it is what Cmd+Shift+Z brings back
    expect(fuori.editor.canRedo).toBe(true);
  }, 60_000);

  it("l'aggiornamento della scheda resta indietro perche' i file sono cambiati sotto di lui: non e' un errore, si richiede alla prossima quiete e la scheda segue", async () => {
    await apri();
    const via = preseDelRame(compilata.circuitJson).find((p) => p.tipo === "via" && p.x === 0 && p.y === -6)!;
    indietro = 2;
    await trascina(`via:${via.tipo === "via" ? via.pcbViaId : ""}`, [0, -6], [0, -5]);
    await salvaEsegue();
    // asked once, came back "ask again": nothing is said, the saved board is the old one and the canvas draws the copper all the same
    expect(aggiornamenti).toBe(1);
    expect(fuori.editor.error).toBeNull();
    expect(vie(fuori.scheda)).toEqual(["-12;-3", "-5;0", "0;-6", "5;0"]);
    expect(vie(fuori.locale)).toEqual(["-12;-3", "-5;0", "0;-5", "5;0"]);
    expect(fuori.editor.saveState).toBe("segue");
    // not asked again at once: only when the quiet is over
    await passa(SEGUE_IL_RAME_MS - 100);
    expect(aggiornamenti).toBe(1);
    await passa(100);
    expect(aggiornamenti).toBe(2);
    expect(fuori.editor.error).toBeNull();
    // the third one is done: the board follows
    await passa(SEGUE_IL_RAME_MS);
    expect(aggiornamenti).toBe(3);
    expect(vie(fuori.scheda)).toEqual(["-12;-3", "-5;0", "0;-5", "5;0"]);
    expect(fuori.editor.copper).toEqual([]);
    expect(fuori.locale).toBe(fuori.scheda);
    expect(fuori.editor.error).toBeNull();
    expect(fuori.editor.saveState).toBe("salvato");

    // a row of them without end is said, like any update that could not be done
    indietro = AGGIORNAMENTI_INDIETRO + 1;
    const ora = preseDelRame(fuori.scheda).find((p) => p.tipo === "via" && p.x === 0 && p.y === -5)!;
    await trascina(`via:${ora.tipo === "via" ? ora.pcbViaId : ""}`, [0, -5], [1, -5]);
    await salvaEsegue();
    for (let i = 0; i < AGGIORNAMENTI_INDIETRO; i++) await passa(SEGUE_IL_RAME_MS);
    expect(fuori.editor.error).toContain("la scheda non li ha ancora seguiti");
    // the copper is still where it was put, on the board the canvas draws
    expect(vie(fuori.locale)).toEqual(["-12;-3", "-5;0", "1;-5", "5;0"]);
  }, 60_000);

  it("l'azione unpaste toglie solo una via incollata, per rete e posto: una via dei file spostata resta, e un corpo sbagliato e' rifiutato", async () => {
    conLaScelta = true;
    await apri();
    const bottone = (nome: string) => f.contenitore.cerca((n) => n.tagName === "BUTTON" && n.textContent === nome)[0];
    const tavola = () => f.contenitore.cerca((n) => n.tagName === "svg" && n.cerca((q) => q.getAttribute("data-presa") !== null).length > 0)[0];
    await f.spara(bottone("vie"), "click");
    const via = preseDelRame(compilata.circuitJson).find((p) => p.tipo === "via" && p.x === 0 && p.y === -6)!;
    const presa = bersaglio(`via:${via.tipo === "via" ? via.pcbViaId : ""}`);
    await f.spara(presa, "pointerdown", a(0, -6));
    await f.spara(presa, "pointerup", a(0, -6));
    await f.tasto("c", { metaKey: true });
    await f.spara(tavola(), "pointermove", a(6, -9));
    await f.tasto("v", { metaKey: true });
    // and the via of the files, moved: a correction, not a pasted via
    await trascina(`via:${via.tipo === "via" ? via.pcbViaId : ""}`, [0, -6], [0, -5]);
    await salvaEsegue();
    expect((await salvati()).pcb_vias.map((v) => [v.to.x, v.to.y, v.aggiunta === true])).toEqual([[6, -9, true], [0, -5, false]]);

    const chiedi = async (via: unknown) => {
      const r = await server("/api/manual-edits", { method: "POST", body: JSON.stringify({ projectId: P, action: "unpaste", via }) });
      return [r.status, ((await r.json()) as { removed?: boolean }).removed];
    };
    // what does not read is refused, and nothing is written
    expect(await chiedi(undefined)).toEqual([400, undefined]);
    expect(await chiedi({ net: "GND", x: "6", y: -9 })).toEqual([400, undefined]);
    expect(await chiedi({ net: "GND; DROP", x: 6, y: -9 })).toEqual([400, undefined]);
    expect(await chiedi({ net: "GND", x: 6, y: Number.NaN })).toEqual([400, undefined]);
    // the moved via of the files is not a pasted one: it stays
    expect(await chiedi({ net: "GND", x: 0, y: -5 })).toEqual([200, false]);
    // another net, another place: nothing
    expect(await chiedi({ net: "PWR", x: 6, y: -9 })).toEqual([200, false]);
    expect(await chiedi({ net: "GND", x: 6, y: -8.9 })).toEqual([200, false]);
    expect((await salvati()).pcb_vias).toHaveLength(2);
    // the pasted one, by its net and its place
    expect(await chiedi({ net: "GND", x: 6, y: -9 })).toEqual([200, true]);
    expect((await salvati()).pcb_vias.map((v) => [v.to.x, v.to.y])).toEqual([[0, -5]]);
    // gone already: said, and nothing written
    expect(await chiedi({ net: "GND", x: 6, y: -9 })).toEqual([200, false]);
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
    await salvaEsegue();
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
    await salvaEsegue();
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

    await salvaEsegue();
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
    await salvaEsegue();
    expect(scritture).toEqual([{ action: "copper", status: 200 }]);
    const [doveSta] = vie(fuori.scheda).filter((v) => v.startsWith("0;"));
    const y = Number(doveSta.split(";")[1]);
    // moved toward the edge, and stopped inside the board with its ring and the edge clearance
    expect(y).toBeLessThan(-6);
    expect(y).toBeGreaterThan(-12 + 0.15);
    expect(idDoppi(fuori.scheda)).toBeNull();
  }, 60_000);
});
