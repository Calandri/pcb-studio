import { beforeAll, describe, expect, it } from "vitest";
import { compileProject, type CompileResult } from "@/lib/compile";
import { resolveDesignRules } from "@/lib/design-rules";
import { applyCopperPatch, emptyManualEdits, type ManualEdits } from "@/lib/manual-edits";
import { applyManualRoutes, larghezzeDeiTratti, percorsoDellaPista, type ManualRoutePoint } from "@/lib/manual-routes";
import { chiudiGesto, iniziaGesto, muoviGesto, preseDelRame } from "@/lib/spinta/gesto";
import type { BersaglioDelRame, PresaDelRame, SalvataggioDelGesto, StatoDelGesto } from "@/lib/spinta/gesto-tipi";
import { leggiRame, verificaRame } from "@/lib/spinta/verifica";
import { comeDetto, GUARDATE, LIMITI, posto, QUANDO, salva, violazioni } from "./spinta-prove";
import { REGOLE, schedaFitta } from "./spinta-scheda";
import { wire, type El } from "./scheda-di-prova";

/*
 * SPOSTA SULLE PISTE A PIU' LARGHEZZE (16/11/2026). Dalla v0.36.0 una pista dice
 * la larghezza su un punto del pcbPath, e Sposta la teneva ferma: «la pista
 * cambia larghezza lungo il percorso». Su sbb-dl-principale le piste di R82
 * (collo, 0,3 in mezzo) tenevano ferme le loro vie. Ora si spostano: ogni tratto
 * tiene la sua larghezza, il punto dove cambia segue il gesto come gli altri,
 * il salvataggio scrive la larghezza sui punti e la scheda ricompilata ha la
 * pista spostata con gli stessi colli.
 *
 * La pista di prova, da R1.2 (-7.175; 0) a R2.1 (7.175; 0), in coordinate della
 * scheda:
 *
 *   (-7.175;0) R1.2 esce dritta, 0,2
 *   (-7.175;2) da qui 0,6 ............ (-3;2)
 *   (-3;2) sale, 0,6 ................. (-3;4)
 *   (-3;4) da qui 0,2 ................ (1;4)
 *   (1;4) sale, 0,2 .................. (1;6) via, sotto 0,4
 *   (1;6) bottom, 0,4 ................ (5;6) via, sopra 0,2
 *   (5;6) top, 0,2 ................... (7.175;6), poi giu' dritta in R2.1
 */
// relative to the centre of R1, (-8; 0)
const PCB_PATH = [
  `{ x: 0.825, y: 2, width: 0.6 }`,
  `{ x: 5, y: 2 }`,
  `{ x: 5, y: 4, width: 0.2 }`,
  `{ x: 9, y: 4 }`,
  `{ x: 9, y: 6 }`,
  `{ x: 9, y: 6, via: true, fromLayer: "top", toLayer: "bottom", width: 0.4 }`,
  `{ x: 9, y: 6 }`,
  `{ x: 13, y: 6 }`,
  `{ x: 13, y: 6, via: true, fromLayer: "bottom", toLayer: "top", width: 0.2 }`,
  `{ x: 13, y: 6 }`,
  `{ x: 15.175, y: 6 }`,
].join(", ");
const MAIN = `export default () => (
  <board width="30mm" height="18mm">
    <resistor name="R1" resistance="1k" footprint="0603" pcbX={-8} pcbY={0} />
    <resistor name="R2" resistance="1k" footprint="0603" pcbX={8} pcbY={0} />
    <trace from=".R1 > .pin2" to=".R2 > .pin1" pcbPathRelativeTo=".R1 > .pin2" pcbPath={[${PCB_PATH}]} thickness="0.2mm" />
  </board>
)
`;

type Punto = { route_type: string; x: number; y: number; width?: number; layer?: string };
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
const piste = (cj: unknown[]) => (cj as El[]).filter((e) => e.type === "pcb_trace");
/** a route as the copper says it: wires with place, layer and width, vias with place */
const rameDi = (route: unknown): string[] =>
  (route as Punto[]).map((p) => (p.route_type === "via" ? `via ${r4(p.x)};${r4(p.y)}` : `${r4(p.x)};${r4(p.y)} ${p.layer} ${p.width}`));
/** every stretch of a path with its width, as "layer (x1;y1)-(x2;y2) w" */
const trattiDi = (punti: readonly ManualRoutePoint[], larga: number): string[] => {
  const w = larghezzeDeiTratti(punti, larga);
  return punti.slice(1).flatMap((b, i) => {
    const a = punti[i];
    return a.layer === b.layer ? [`${a.layer} (${r4(a.x)};${r4(a.y)})-(${r4(b.x)};${r4(b.y)}) ${w[i]}`] : [];
  });
};
const trattiDelloStato = (s: StatoDelGesto): string[] => s.tratti.map((t) => `${t.layer} (${r4(t.x1)};${r4(t.y1)})-(${r4(t.x2)};${r4(t.y2)}) ${t.width}`);

const regole = resolveDesignRules({}).rules;
let fatta: CompileResult;
let pista: El;

beforeAll(async () => {
  fatta = await compileProject({ "main.tsx": MAIN });
  pista = piste(fatta.circuitJson)[0];
}, 120_000);

function bersaglio(trova: (b: BersaglioDelRame) => boolean): BersaglioDelRame {
  const b = preseDelRame(fatta.circuitJson).find(trova);
  if (!b) throw new Error("bersaglio non trovato");
  return b;
}
const presaDi = (b: BersaglioDelRame): PresaDelRame =>
  b.tipo === "via" ? { tipo: "via", pcbViaId: b.pcbViaId } : { tipo: "tratto", pcbTraceId: b.pcbTraceId, indice: b.indice };

/** a gesture on the board from the target to `verso`, let go there */
function gesto(b: BersaglioDelRame, verso: { x: number; y: number }): { stato: StatoDelGesto; salvataggio: SalvataggioDelGesto } {
  const esito = iniziaGesto({ circuitJson: fatta.circuitJson, regole, presa: presaDi(b) });
  if ("rifiuto" in esito) throw new Error(esito.rifiuto);
  const stato = muoviGesto(esito.gesto, verso);
  expect(stato.blocco).toBeNull();
  const salvataggio = chiudiGesto(esito.gesto, stato, "g1");
  if (!salvataggio) throw new Error("niente da salvare");
  return { stato, salvataggio };
}

/**
 * What the save of a gesture does, as /api/manual-edits does it (the body as
 * JSON, read, checked on the saved board, written into the file), then the
 * fast update and the compile of the files with that manual-edits.json.
 */
async function salvaERicompila(s: SalvataggioDelGesto): Promise<{ edits: ManualEdits; veloce: unknown[]; ricompilata: CompileResult }> {
  const corpo = JSON.parse(JSON.stringify({ routes: s.routes, vias: s.vias, riscritte: s.riscritte, gesto: "g1" }));
  const letto = leggiRame(corpo, LIMITI, QUANDO);
  if ("errore" in letto) throw new Error(letto.errore);
  expect(verificaRame({ circuitJson: fatta.circuitJson, regole, correnti: emptyManualEdits(), rame: letto.rame })).toEqual({ ok: true });
  const edits = applyCopperPatch(emptyManualEdits(), letto.rame).edits;
  const veloce = applyManualRoutes({ circuitJson: fatta.circuitJson, routes: edits.pcb_routes, vias: edits.pcb_vias });
  expect(veloce.rame).toEqual({ orfane: { routes: [], vias: [] }, assorbite: { routes: [], vias: [] } });
  const ricompilata = await compileProject({ "main.tsx": MAIN, "manual-edits.json": JSON.stringify(edits) });
  expect(ricompilata.summary.manualEditsOrphans).toBeUndefined();
  return { edits, veloce: veloce.circuitJson, ricompilata };
}

describe("una pista a piu' larghezze in Sposta", () => {
  it("la scheda di prova: ogni tratto con la sua larghezza, la via di sotto a 0,4, e il percorso dice la larghezza su ogni punto", () => {
    expect(trattiDi(percorsoDellaPista(pista), 0.2)).toEqual([
      "top (-7.175;0)-(-7.175;2) 0.2",
      "top (-7.175;2)-(-3;2) 0.6",
      "top (-3;2)-(-3;4) 0.6",
      "top (-3;4)-(1;4) 0.2",
      "top (1;4)-(1;6) 0.2",
      "bottom (1;6)-(5;6) 0.4",
      "top (5;6)-(7.175;6) 0.2",
      "top (7.175;6)-(7.175;0) 0.2",
    ]);
    expect(violazioni(fatta.circuitJson)).toEqual(Object.fromEntries(GUARDATE.map((r) => [r, 0])));
  });

  it("i tratti e le vie si prendono: nessuno e' fermo perche' la pista cambia larghezza", () => {
    const prese = preseDelRame(fatta.circuitJson);
    for (const b of prese) expect(b.fermo ?? "").not.toContain("cambia larghezza");
    const liberi = prese.filter((b) => !b.fermo).map((b) => (b.tipo === "via" ? `via ${r4(b.x)};${r4(b.y)}` : `${b.layer} ${r4(b.x1)};${r4(b.y1)} ${b.width}`));
    // the wide stretches, the narrow one between two corners and the via between 0,2 and 0,4
    expect(liberi).toEqual(expect.arrayContaining(["top -7.175;2 0.6", "top -3;2 0.6", "top -3;4 0.2", "via 1;6"]));
  });

  it("un tratto largo spostato di lato: tiene 0,6, i vicini le loro larghezze, e il punto dove cambia lo segue", async () => {
    const { stato, salvataggio } = gesto(bersaglio((b) => b.tipo === "tratto" && r4(b.x1) === -3 && r4(b.x2) === -3), { x: -2.5, y: 3 });
    const attesi = [
      "top (-7.175;0)-(-7.175;2) 0.2",
      "top (-7.175;2)-(-2.5;2) 0.6",
      "top (-2.5;2)-(-2.5;4) 0.6",
      "top (-2.5;4)-(1;4) 0.2",
      "top (1;4)-(1;6) 0.2",
      "bottom (1;6)-(5;6) 0.4",
      "top (5;6)-(7.175;6) 0.2",
      "top (7.175;6)-(7.175;0) 0.2",
    ];
    // what the viewer draws while the gesture is in hand
    expect(trattiDelloStato(stato)).toEqual(attesi);
    // what is saved: the width of the first stretch, and a width on a point only where it changes, as a pcbPath says it
    const [route] = salvataggio.routes;
    expect(route.width).toBe(0.2);
    expect(route.points.filter((p) => p.width !== undefined).map((p) => `${r4(p.x)};${r4(p.y)} ${p.layer} ${p.width}`)).toEqual([
      "-7.175;2 top 0.6",
      "-2.5;4 top 0.2",
      "1;6 bottom 0.4",
      "5;6 top 0.2",
    ]);
    expect(route.replaces!.width).toBe(0.2);
    expect(route.replaces!.original.filter((p) => p.width !== undefined).map((p) => `${r4(p.x)};${r4(p.y)} ${p.width}`)).toEqual([
      "-7.175;2 0.6",
      "-3;4 0.2",
      "1;6 0.4",
      "5;6 0.2",
    ]);

    const { veloce, ricompilata } = await salvaERicompila(salvataggio);
    for (const scheda of [veloce, ricompilata.circuitJson]) {
      const [mossa] = piste(scheda);
      expect(mossa.manual).toBe(true);
      expect(trattiDi(percorsoDellaPista(mossa), 0.2)).toEqual(attesi);
      // every segment has one width at its two ends, as the compile writes a pcbPath with widths
      const route = mossa.route as Punto[];
      for (let i = 1; i < route.length; i++) {
        const [a, b] = [route[i - 1], route[i]];
        if (a.route_type === "wire" && b.route_type === "wire" && (a.x !== b.x || a.y !== b.y)) expect(a.width, JSON.stringify([a, b])).toBe(b.width);
      }
      expect(violazioni(scheda)).toEqual(violazioni(fatta.circuitJson));
    }
    // the fast update and the compile lay the same copper
    expect(rameDi(piste(ricompilata.circuitJson)[0].route)).toEqual(rameDi(piste(veloce)[0].route));
  }, 120_000);

  it("un tratto stretto spostato di lato: tiene 0,2 fra due tratti di 0,6 e 0,2", async () => {
    const { stato, salvataggio } = gesto(bersaglio((b) => b.tipo === "tratto" && r4(b.y1) === 4 && r4(b.y2) === 4), { x: -1, y: 3.5 });
    const attesi = [
      "top (-7.175;0)-(-7.175;2) 0.2",
      "top (-7.175;2)-(-3;2) 0.6",
      "top (-3;2)-(-3;3.5) 0.6",
      "top (-3;3.5)-(1;3.5) 0.2",
      "top (1;3.5)-(1;6) 0.2",
      "bottom (1;6)-(5;6) 0.4",
      "top (5;6)-(7.175;6) 0.2",
      "top (7.175;6)-(7.175;0) 0.2",
    ];
    expect(trattiDelloStato(stato)).toEqual(attesi);
    const { veloce, ricompilata } = await salvaERicompila(salvataggio);
    for (const scheda of [veloce, ricompilata.circuitJson]) expect(trattiDi(percorsoDellaPista(piste(scheda)[0]), 0.2)).toEqual(attesi);
  }, 120_000);

  it("la via fra un tratto di 0,2 e uno di 0,4 si sposta: il gomito nuovo ha la larghezza del suo tratto, e la via resta una", async () => {
    const via = bersaglio((b) => b.tipo === "via" && r4(b.x) === 1 && r4(b.y) === 6);
    const { stato, salvataggio } = gesto(via, { x: 1.5, y: 6 });
    const attesi = [
      "top (-7.175;0)-(-7.175;2) 0.2",
      "top (-7.175;2)-(-3;2) 0.6",
      "top (-3;2)-(-3;4) 0.6",
      "top (-3;4)-(1;4) 0.2",
      "top (1;4)-(1;5.5) 0.2",
      "top (1;5.5)-(1.5;6) 0.2",
      "bottom (1.5;6)-(5;6) 0.4",
      "top (5;6)-(7.175;6) 0.2",
      "top (7.175;6)-(7.175;0) 0.2",
    ];
    expect(trattiDelloStato(stato)).toEqual(attesi);
    expect(stato.vie.map(posto)).toEqual(["1.5;6"]);
    const { veloce, ricompilata } = await salvaERicompila(salvataggio);
    for (const scheda of [veloce, ricompilata.circuitJson]) {
      expect(trattiDi(percorsoDellaPista(piste(scheda)[0]), 0.2)).toEqual(attesi);
      const vie = (scheda as El[]).filter((e) => e.type === "pcb_via").map(posto).sort();
      expect(vie).toEqual(["1.5;6", "5;6"]);
      expect(violazioni(scheda)).toEqual(violazioni(fatta.circuitJson));
    }
  }, 120_000);

  it("la stessa via spostata in su: il gomito nuovo e' dal lato di sotto, e ha 0,4 come il suo tratto", async () => {
    const via = bersaglio((b) => b.tipo === "via" && r4(b.x) === 1 && r4(b.y) === 6);
    const { stato, salvataggio } = gesto(via, { x: 1, y: 6.5 });
    const attesi = [
      "top (-7.175;0)-(-7.175;2) 0.2",
      "top (-7.175;2)-(-3;2) 0.6",
      "top (-3;2)-(-3;4) 0.6",
      "top (-3;4)-(1;4) 0.2",
      "top (1;4)-(1;6.5) 0.2",
      "bottom (1;6.5)-(1.5;6) 0.4",
      "bottom (1.5;6)-(5;6) 0.4",
      "top (5;6)-(7.175;6) 0.2",
      "top (7.175;6)-(7.175;0) 0.2",
    ];
    expect(trattiDelloStato(stato)).toEqual(attesi);
    const { veloce, ricompilata } = await salvaERicompila(salvataggio);
    for (const scheda of [veloce, ricompilata.circuitJson]) expect(trattiDi(percorsoDellaPista(piste(scheda)[0]), 0.2)).toEqual(attesi);
  }, 120_000);

  it("Cmd+Z: tolta la correzione, la pista dei file torna senza compilare, con i suoi colli, punto per punto", async () => {
    const via = bersaglio((b) => b.tipo === "via" && r4(b.x) === 1 && r4(b.y) === 6);
    const { salvataggio } = gesto(via, { x: 1.5, y: 6 });
    const { edits, veloce } = await salvaERicompila(salvataggio);
    expect(edits.pcb_routes).toHaveLength(1);
    // the undo writes the file as it was, and the fast update puts back what the copper of the correction remembers
    const tornata = applyManualRoutes({ circuitJson: veloce, routes: [], vias: [] });
    const [pistaTornata] = piste(tornata.circuitJson);
    expect(pistaTornata.manual).toBeUndefined();
    expect(rameDi(pistaTornata.route)).toEqual(rameDi(pista.route));
    expect((tornata.circuitJson as El[]).filter((e) => e.type === "pcb_via").map(posto).sort()).toEqual(["1;6", "5;6"]);
  }, 120_000);

  it("una correzione fatta sui colli di prima resta orfana se i file li hanno cambiati: vincono i file", async () => {
    const { salvataggio } = gesto(bersaglio((b) => b.tipo === "tratto" && r4(b.x1) === -3 && r4(b.x2) === -3), { x: -2.5, y: 3 });
    const letto = leggiRame(JSON.parse(JSON.stringify({ routes: salvataggio.routes, vias: [], gesto: "g1" })), LIMITI, QUANDO);
    if ("errore" in letto) throw new Error(letto.errore);
    const edits = applyCopperPatch(emptyManualEdits(), letto.rame).edits;
    // the files now say 0,5 where they said 0,6
    const altri = MAIN.replace("{ x: 0.825, y: 2, width: 0.6 }", "{ x: 0.825, y: 2, width: 0.5 }");
    const ricompilata = await compileProject({ "main.tsx": altri, "manual-edits.json": JSON.stringify(edits) });
    expect(ricompilata.summary.manualEditsOrphans?.pcb_routes.length).toBe(1);
    const [deiFile] = piste(ricompilata.circuitJson);
    expect(deiFile.manual).toBeUndefined();
    expect(larghezzeDeiTratti(percorsoDellaPista(deiFile), 0.2)).toContain(0.5);
  }, 120_000);

  it("il server rifiuta una larghezza su un punto fuori misura, come quella di una pista", () => {
    const { salvataggio } = gesto(bersaglio((b) => b.tipo === "tratto" && r4(b.x1) === -3 && r4(b.x2) === -3), { x: -2.5, y: 3 });
    for (const w of [0, -1, 11, "0.3", null]) {
      const route = { ...salvataggio.routes[0], points: salvataggio.routes[0].points.map((p, i) => (i === 1 ? { ...p, width: w } : p)) };
      const letto = leggiRame(JSON.parse(JSON.stringify({ routes: [route], vias: [], gesto: "g1" })), LIMITI, QUANDO);
      expect("errore" in letto ? letto.errore : "letto", String(w)).toContain("punto 2: la larghezza deve stare fra");
    }
  });
});

describe("la spinta su una pista a piu' larghezze", () => {
  /*
   * Il fascio di spinta-spinta.test.ts, con S1 (la traccia di mezzo) larga 0,3
   * dopo l'uscita dalle piazzole e 0,2 nelle uscite: la traccia T trascinata in
   * giu' spinge S2, S1 e S0. S1 si sposta con le sue larghezze, misurata col suo
   * rame, e il salvataggio la ricostruisce uguale.
   */
  it("la pista spinta tiene ogni tratto alla sua larghezza, e la scheda salvata e' il rame che il gesto ha disegnato", () => {
    const board = schedaFitta({ quante: 3, via: false, tratto: true });
    const s1 = board.scheda.find((e) => e.pcb_trace_id === "t_s1")!;
    const r = s1.route as Punto[];
    // the route as the compile writes a pcbPath with widths: the point where it changes, twice
    s1.route = [
      r[0],
      r[1],
      { ...wire(r[1].x, r[1].y), width: 0.3 },
      { ...r[2], width: 0.3 },
      { ...r[3], width: 0.3 },
      { ...r[4], width: 0.3 },
      r[4],
      r[5],
    ];
    expect(violazioni(board.scheda)).toEqual(Object.fromEntries(GUARDATE.map((k) => [k, 0])));
    const esito = iniziaGesto({ circuitJson: board.scheda, regole: REGOLE, presa: { tipo: "tratto", pcbTraceId: "t_t", indice: 2 } });
    if ("rifiuto" in esito) throw new Error(esito.rifiuto);
    const stato = muoviGesto(esito.gesto, { x: 2, y: 0.5 });
    expect(stato.blocco).toBeNull();
    expect(stato.nascosti.pcbTraceIds).toEqual(expect.arrayContaining(["t_t", "t_s2", "t_s1"]));
    const larghe = stato.tratti.filter((t) => t.width === 0.3);
    expect(larghe).toHaveLength(3);
    const salvataggio = chiudiGesto(esito.gesto, stato, "g1")!;
    const diS1 = salvataggio.routes.find((x) => x.replaces!.original.some((p) => p.width === 0.3))!;
    expect(diS1.width).toBe(0.2);
    const dopo = salva({ scheda: board.scheda, edits: board.edits }, salvataggio, "spinta a piu' larghezze");
    comeDetto(
      board.scheda,
      dopo.scheda,
      { piste: new Set(stato.nascosti.pcbTraceIds), vie: new Set(stato.nascosti.pcbViaIds) },
      { tratti: stato.tratti.map((t) => JSON.stringify(t)), vie: stato.vie.map(posto) },
      "spinta a piu' larghezze",
    );
    expect(violazioni(dopo.scheda)).toEqual(violazioni(board.scheda));
  });
});
