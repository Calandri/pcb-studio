import { beforeAll, describe, expect, it } from "vitest";

/*
 * A CORRECTION STARTS FROM THE COPPER OF THE FILES, even when the gesture was
 * made on a board that is behind the file.
 *
 * sbb-dl-principale, 2026-11-13: a trace dragged, the drag undone, and a board
 * laid before the undo back on screen. The next drag started from the copper
 * the first one had laid, which no file described any more, and was written
 * with that as `replaces.original`. The board knows the path of the files
 * under copper a correction laid (partenzaRicordata, `moved_from` for a via):
 * the server writes that.
 */
import { compileProject } from "@/lib/compile";
import { DESIGN_RULES_PATH, resolveDesignRules } from "@/lib/design-rules";
import { applyCopperPatch, emptyManualEdits, type ManualEdits } from "@/lib/manual-edits";
import { applyManualRoutes, stessoPercorso } from "@/lib/manual-routes";
import { chiudiGesto, iniziaGesto, muoviGesto, preseDelRame } from "@/lib/spinta/gesto";
import type { PresaDelRame } from "@/lib/spinta/gesto-tipi";
import { conLaPartenzaDeiFile, leggiRame, verificaRame } from "@/lib/spinta/verifica";

const REGOLE_DEL_PROGETTO = JSON.stringify({
  preset: "custom",
  rules: { minTraceWidthMm: 0.15, minClearanceMm: 0.15, pourClearanceMm: 0.2, autoPlaneVias: false, autoroute: false },
});
/** a trace toward ground that ends on a lone via in (0; -6), with a long stretch along y = -8 */
const MAIN = `export default () => (
  <board width="40mm" height="24mm">
    <net name="GND" />
    <resistor name="R1" resistance="1k" footprint="0402" pcbX={-10} pcbY={0} />
    <resistor name="R3" resistance="1k" footprint="0402" pcbX={-10} pcbY={-6} />
    <trace from=".R1 > .pin1" to="net.GND" />
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
const FILES: Record<string, string> = { "main.tsx": MAIN, [DESIGN_RULES_PATH]: REGOLE_DEL_PROGETTO };
const REGOLE = resolveDesignRules(FILES).rules;
const LIMITI = { maxRoutes: 200, maxPoints: 2000, maxVias: 500 };
const ALLA_VIA = ".R3 > .pin1 to net.GND";

let scheda: unknown[];
beforeAll(async () => {
  scheda = (await compileProject(FILES)).circuitJson;
}, 120_000);

/** a gesture on a board: what it asks to be saved, read the way the server reads it */
function gesto(cj: unknown[], presa: PresaDelRame, verso: { x: number; y: number }, id: string) {
  const esito = iniziaGesto({ circuitJson: cj, regole: REGOLE, presa });
  if ("rifiuto" in esito) throw new Error(esito.rifiuto);
  const stato = muoviGesto(esito.gesto, verso);
  expect(stato.mosso).toBe(true);
  const s = chiudiGesto(esito.gesto, stato, id)!;
  const letto = leggiRame({ routes: s.routes, vias: s.vias, gesto: id }, LIMITI, "2026-11-13T15:00:00.000Z");
  if ("errore" in letto) throw new Error(letto.errore);
  return letto.rame;
}
const posa = (cj: unknown[], edits: ManualEdits): unknown[] =>
  applyManualRoutes({ circuitJson: cj, routes: edits.pcb_routes, vias: edits.pcb_vias, viaDiameter: REGOLE.minViaDiameterMm, viaHoleDiameter: REGOLE.minViaHoleMm }).circuitJson;
const trattoA = (cj: unknown[], y: number): PresaDelRame => {
  const p = preseDelRame(cj).find((b) => b.tipo === "tratto" && b.y1 === y && b.y2 === y)!;
  if (p.tipo !== "tratto") throw new Error("non e' un tratto");
  return { tipo: "tratto", pcbTraceId: p.pcbTraceId, indice: p.indice };
};
const viaIn = (cj: unknown[], x: number, y: number): PresaDelRame => {
  const p = preseDelRame(cj).find((b) => b.tipo === "via" && b.x === x && b.y === y)!;
  if (p.tipo !== "via") throw new Error("non e' una via");
  return { tipo: "via", pcbViaId: p.pcbViaId };
};

describe("la partenza di una correzione e' il rame dei file", () => {
  it("una pista spostata, tolta dal file da un annulla, e spostata ancora dalla scheda di prima: la partenza scritta e' il percorso dei file", () => {
    // the first drag: the stretch along y = -8 down to y = -9, saved and laid
    const primo = gesto(scheda, trattoA(scheda, -8), { x: -6, y: -9 }, "g1");
    const deiFile = primo.routes[0].replaces!.original;
    const conIlPrimo = applyCopperPatch(emptyManualEdits(), primo).edits;
    const schedaDiPrima = posa(scheda, conIlPrimo);

    // the undo took it out of the file, and the board laid before the undo is still the one on screen
    const file = emptyManualEdits();
    const secondo = gesto(schedaDiPrima, trattoA(schedaDiPrima, -9), { x: -6, y: -10 }, "g2");
    // what the page sends starts from what it has on screen: the copper of the first drag
    expect(secondo.routes[0].connection).toBe(ALLA_VIA);
    expect(stessoPercorso(secondo.routes[0].replaces!.original, primo.routes[0].points)).toBe(true);

    const daiFile = conLaPartenzaDeiFile(schedaDiPrima, file, secondo);
    expect(stessoPercorso(daiFile.routes[0].replaces!.original, deiFile)).toBe(true);
    expect(daiFile.routes[0].points).toEqual(secondo.routes[0].points);
    // and it is good for that board: written, it is ONE correction, from the files to where the second drag left it
    expect(verificaRame({ circuitJson: schedaDiPrima, regole: REGOLE, correnti: file, rame: daiFile })).toEqual({ ok: true });
    const scritto = applyCopperPatch(file, daiFile).edits;
    expect(scritto.pcb_routes).toHaveLength(1);
    expect(stessoPercorso(scritto.pcb_routes[0].replaces!.original, deiFile)).toBe(true);
    // laid on the board of the files themselves (a compile), it goes where the drag said
    const compilata = posa(scheda, scritto);
    expect(preseDelRame(compilata).some((b) => b.tipo === "tratto" && b.y1 === -10 && b.y2 === -10)).toBe(true);
  });

  it("il file tiene ancora la prima correzione: la partenza resta quella mandata, la prende dal file chi la scrive", () => {
    const primo = gesto(scheda, trattoA(scheda, -8), { x: -6, y: -9 }, "g1");
    const conIlPrimo = applyCopperPatch(emptyManualEdits(), primo).edits;
    const schedaDiPrima = posa(scheda, conIlPrimo);
    const secondo = gesto(schedaDiPrima, trattoA(schedaDiPrima, -9), { x: -6, y: -10 }, "g2");
    expect(conLaPartenzaDeiFile(schedaDiPrima, conIlPrimo, secondo)).toBe(secondo);
    const scritto = applyCopperPatch(conIlPrimo, secondo).edits;
    expect(scritto.pcb_routes).toHaveLength(1);
    expect(stessoPercorso(scritto.pcb_routes[0].replaces!.original, primo.routes[0].replaces!.original)).toBe(true);
  });

  it("una via spostata, tolta dal file da un annulla, e spostata ancora dalla scheda di prima: parte dal posto dei file", () => {
    const primo = gesto(scheda, viaIn(scheda, 0, -6), { x: 0, y: -5 }, "g1");
    expect(primo.vias.map((v) => [v.from, v.to])).toEqual([[{ x: 0, y: -6 }, { x: 0, y: -5 }]]);
    const schedaDiPrima = posa(scheda, applyCopperPatch(emptyManualEdits(), primo).edits);
    const file = emptyManualEdits();
    const secondo = gesto(schedaDiPrima, viaIn(schedaDiPrima, 0, -5), { x: 1, y: -5 }, "g2");
    expect(secondo.vias[0].from).toEqual({ x: 0, y: -5 });

    const daiFile = conLaPartenzaDeiFile(schedaDiPrima, file, secondo);
    expect(daiFile.vias.map((v) => [v.from, v.to])).toEqual([[{ x: 0, y: -6 }, { x: 1, y: -5 }]]);
    expect(verificaRame({ circuitJson: schedaDiPrima, regole: REGOLE, correnti: file, rame: daiFile })).toEqual({ ok: true });
    expect(applyCopperPatch(file, daiFile).edits.pcb_vias.map((v) => [v.from, v.to])).toEqual([[{ x: 0, y: -6 }, { x: 1, y: -5 }]]);
  });

  it("rame dei file preso dov'e': niente da cambiare", () => {
    const primo = gesto(scheda, trattoA(scheda, -8), { x: -6, y: -9 }, "g1");
    expect(conLaPartenzaDeiFile(scheda, emptyManualEdits(), primo)).toBe(primo);
  });
});
