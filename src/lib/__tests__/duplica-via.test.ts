import { describe, expect, it } from "vitest";
import { compileProject } from "@/lib/compile";
import { retiDelCircuito } from "@/lib/gruppi-di-rame";
import { applyCopperPatch, emptyManualEdits, parseManualEdits, type ManualEdits } from "@/lib/manual-edits";
import { applyManualRoutes, statoDelRame } from "@/lib/manual-routes";
import { chiudiGesto, iniziaGesto, muoviGesto } from "@/lib/spinta/gesto";
import { leggiRame, verificaRame } from "@/lib/spinta/verifica";
import { provaViaNuova, salvataggioDellaVia, viaDaCopiare, type ViaCopiata } from "@/lib/spinta/via-nuova";
import { LIMITI, QUANDO } from "./spinta-prove";
import { REGOLE, schedaDiSpinta } from "./spinta-scheda";
import type { El } from "./scheda-di-prova";

/*
 * DUPLICA VIA (16/11/2026, Niccolo': «metti anche DUPLICA VIA, facendo copia e
 * incolla, cosi' posso creare vie di cucitura di massa»). Una via copiata si
 * incolla dove si vuole: stessa rete, foro, corona e strati, legata a nessuna
 * pista. Prima di posarla si guardano le regole: rame delle altre reti,
 * piazzole e le loro aperture, fori, zone vietate, bordo. Si salva come una
 * voce di pcb_vias con `aggiunta`, si posa nella compilazione e
 * nell'aggiornamento veloce, si annulla, si sposta come le altre vie.
 *
 * La scheda e' quella di spinta-scheda.ts: v_pwr e' la via sola di PWR in
 * (6; -9), la pista PWR corre a y = -4 sul top, SIG a y = 6 (sotto fra -4 e 4),
 * R3.2 (PWR) e' una piazzola di 0,6 in (-14; -8), il keepout del top e' attorno
 * a (0; 1,5), il bordo a x = 20.
 */
const scheda = schedaDiSpinta();
const pwr = (): ViaCopiata => {
  const c = viaDaCopiare(scheda, REGOLE, "v_pwr");
  if ("rifiuto" in c) throw new Error(c.rifiuto);
  return c;
};
const prova = (x: number, y: number, inAttesa?: Parameters<typeof provaViaNuova>[0]["inAttesa"]) =>
  provaViaNuova({ circuitJson: scheda, regole: REGOLE, via: pwr(), dove: { x, y }, inAttesa });
const motivo = (e: ReturnType<typeof prova>) => (e.ok ? "posata" : e.blocco.motivo);

const vieIncollate = (cj: unknown[]) => (cj as El[]).filter((e) => e.type === "pcb_via" && e.aggiunta_da !== undefined);
const reteDi = (cj: unknown[], via: El) => {
  const reti = retiDelCircuito(cj);
  return reti.nome(reti.diVia(via as never) ?? "");
};

/** a paste saved as /api/manual-edits saves it: the body as JSON, read, checked on the board, written into the file */
function salva(cj: unknown[], file: ManualEdits, salvataggio: ReturnType<typeof salvataggioDellaVia>) {
  const letto = leggiRame(JSON.parse(JSON.stringify({ ...salvataggio, gesto: "g1" })), LIMITI, QUANDO);
  if ("errore" in letto) throw new Error(letto.errore);
  return { verifica: verificaRame({ circuitJson: cj, regole: REGOLE, correnti: file, rame: letto.rame }), file: applyCopperPatch(file, letto.rame).edits };
}

describe("copiare una via", () => {
  it("una via sola di una rete col nome si copia: rete, corona, foro e strati", () => {
    expect(pwr()).toEqual({ net: "PWR", corona: 0.6, foro: 0.3, strati: ["top", "bottom"] });
  });
  it("una via che non c'e' non si copia, e lo dice", () => {
    expect(viaDaCopiare(scheda, REGOLE, "v_nessuna")).toEqual({ rifiuto: expect.stringContaining("non e' sulla scheda") });
  });
});

describe("incollarla: prima di posarla, le regole del progetto", () => {
  it("in un posto libero si posa", () => {
    expect(prova(0, -7)).toEqual({ ok: true, dove: { x: 0, y: -7 } });
  });
  it("troppo vicina a una pista di un'altra rete, su qualunque strato: no, e dice quale", () => {
    expect(motivo(prova(0, 6.5))).toContain("bloccato dalla pista");
  });
  it("sopra un'altra via, o col foro troppo vicino: no", () => {
    expect(motivo(prova(6, -9))).toContain("bloccato dalla via di PWR");
    expect(motivo(prova(6.5, -9))).toContain("bloccato dalla via di PWR");
  });
  it("sul bordo, in un ritaglio o in una zona vietata al rame: no", () => {
    expect(motivo(prova(19.9, 0))).toContain("bordo");
    expect(motivo(prova(0, 1.5))).toContain("zona vietata al rame su top: la via e' passante e ci entra");
    // the zone that said no goes with the refusal: the viewer draws it, whatever layer is in view
    const inZona = prova(0, 1.5);
    expect(inZona.ok === false && inZona.blocco.zona).toBeTruthy();
    expect(motivo(prova(0, 13))).toMatch(/bordo|ritaglio/);
  });
  it("contro l'apertura della maschera di una piazzola, anche della sua rete: no, con la misura", () => {
    // R3.2 (PWR) is 0,6 x 0,6 at (-14; -8): its top edge at y = -7,7; the ring of 0,6 at y = -7,38 leaves 0,02 mm of mask
    const e = prova(-14, -7.38);
    expect(motivo(e)).toBe("bloccato dalla piazzola R3.2: la corona sarebbe a 0,02 mm dall'apertura della maschera, servono 0,05 mm");
    expect(motivo(prova(-14, -7.8))).toContain("dentro l'apertura");
    // far enough from it, on its own trace, it is a via of the net like any other
    expect(prova(-14, -6.8).ok).toBe(true);
  });
  it("troppo vicina a una via incollata e non ancora sulla scheda: no", () => {
    const attesa = [{ net: "PWR", x: 0.4, y: -7, corona: 0.6, foro: 0.3 }];
    expect(motivo(prova(0, -7, attesa))).toBe("bloccato dalla via di PWR appena messa");
    expect(prova(0, -6, attesa).ok).toBe(true);
  });
});

describe("salvarla, posarla, annullarla, spostarla", () => {
  it("si salva come una voce di pcb_vias con aggiunta, si posa della sua rete, e posata due volte resta una", () => {
    const s = salvataggioDellaVia(pwr(), { x: 0, y: -7 }, "g1");
    const { verifica, file } = salva(scheda, emptyManualEdits(), s);
    expect(verifica).toEqual({ ok: true });
    expect(file.pcb_vias).toEqual([
      { net: "PWR", from: { x: 0, y: -7 }, to: { x: 0, y: -7 }, holeDiameter: 0.3, outerDiameter: 0.6, layers: ["top", "bottom"], gesto: "g1", at: QUANDO, aggiunta: true },
    ]);
    // the file as it is written and read back
    const riletto = parseManualEdits(JSON.stringify(file));
    expect(riletto.pcb_vias).toEqual(file.pcb_vias);
    const posata = applyManualRoutes({ circuitJson: scheda, routes: riletto.pcb_routes, vias: riletto.pcb_vias });
    expect(posata.rame).toEqual({ orfane: { routes: [], vias: [] }, assorbite: { routes: [], vias: [] } });
    const [via] = vieIncollate(posata.circuitJson);
    expect(via).toMatchObject({ x: 0, y: -7, outer_diameter: 0.6, hole_diameter: 0.3, subcircuit_connectivity_map_key: "chiave_3" });
    expect(reteDi(posata.circuitJson, via)).toBe("PWR");
    // the fast update runs again on the board it saved: the same board, one via
    const ancora = applyManualRoutes({ circuitJson: posata.circuitJson, routes: riletto.pcb_routes, vias: riletto.pcb_vias });
    expect(vieIncollate(ancora.circuitJson)).toHaveLength(1);
    expect((ancora.circuitJson as El[]).filter((e) => e.type === "pcb_via")).toHaveLength((posata.circuitJson as El[]).filter((e) => e.type === "pcb_via").length);
    // Cmd+Z writes the file without it: the next pass takes it away
    const tolta = applyManualRoutes({ circuitJson: posata.circuitJson, routes: [], vias: [] });
    expect(vieIncollate(tolta.circuitJson)).toEqual([]);
  });

  it("si sposta come una via sola: il gesto la prende, il salvataggio tiene dov'e' nata, e la scheda la mette nel posto nuovo", () => {
    const { file } = salva(scheda, emptyManualEdits(), salvataggioDellaVia(pwr(), { x: 0, y: -7 }, "g1"));
    const posata = applyManualRoutes({ circuitJson: scheda, routes: file.pcb_routes, vias: file.pcb_vias }).circuitJson;
    const id = String(vieIncollate(posata)[0].pcb_via_id);
    const esito = iniziaGesto({ circuitJson: posata, regole: REGOLE, presa: { tipo: "via", pcbViaId: id } });
    if ("rifiuto" in esito) throw new Error(esito.rifiuto);
    const stato = muoviGesto(esito.gesto, { x: 1, y: -7 });
    expect(stato.blocco).toBeNull();
    const s = chiudiGesto(esito.gesto, stato, "g2")!;
    expect(s.vias).toMatchObject([{ net: "PWR", from: { x: 0, y: -7 }, to: { x: 1, y: -7 } }]);
    const dopo = salva(posata, file, s);
    expect(dopo.verifica).toEqual({ ok: true });
    expect(dopo.file.pcb_vias).toMatchObject([{ net: "PWR", from: { x: 0, y: -7 }, to: { x: 1, y: -7 }, aggiunta: true }]);
    const spostata = applyManualRoutes({ circuitJson: posata, routes: [], vias: dopo.file.pcb_vias }).circuitJson;
    expect(vieIncollate(spostata).map((v) => [v.x, v.y])).toEqual([[1, -7]]);
    // another one pasted where the first was pasted: a via of its own, the first stays where it was moved (revisione, 16/11)
    const seconda = salva(spostata, dopo.file, salvataggioDellaVia(pwr(), { x: 0, y: -7 }, "g3"));
    expect(seconda.verifica).toEqual({ ok: true });
    expect(seconda.file.pcb_vias.map((v) => `${v.to.x};${v.to.y}`)).toEqual(["1;-7", "0;-7"]);
    const due = applyManualRoutes({ circuitJson: spostata, routes: [], vias: seconda.file.pcb_vias }).circuitJson;
    expect(vieIncollate(due).map((v) => `${v.x};${v.y}`).sort()).toEqual(["0;-7", "1;-7"]);
    // and brought back where it was pasted it stays: a pasted via is not a correction that comes to nothing
    const indietro = salva(spostata, dopo.file, { routes: [], riscritte: [], vias: [{ ...s.vias[0], from: { x: 1, y: -7 }, to: { x: 0, y: -7 } }] });
    expect(indietro.file.pcb_vias).toMatchObject([{ from: { x: 0, y: -7 }, to: { x: 0, y: -7 }, aggiunta: true }]);
  });

  it("il server rifiuta quello che il visore non manderebbe: fuori dalle regole, aggiunta scritta male, una via incollata che si sposta", () => {
    // near SIG: a distance that held before
    const vicina = salva(scheda, emptyManualEdits(), salvataggioDellaVia(pwr(), { x: 0, y: 6.5 }, "g1"));
    expect(vicina.verifica).toMatchObject({ ok: false, motivo: expect.stringContaining("distanza") });
    // against the opening of R3.2, which the DRC measures (pad_opening_clearance)
    const apertura = salva(scheda, emptyManualEdits(), salvataggioDellaVia(pwr(), { x: -14, y: -7.38 }, "g1"));
    expect(apertura.verifica).toMatchObject({ ok: false, motivo: expect.stringContaining("apertura") });
    const voce = salvataggioDellaVia(pwr(), { x: 0, y: -7 }, "g1").vias[0];
    const leggi = (v: Record<string, unknown>) => leggiRame({ routes: [], vias: [v], gesto: "g1" }, LIMITI, QUANDO);
    expect(leggi({ ...voce, aggiunta: "si" })).toEqual({ errore: "via 1: aggiunta e' true o non c'e'" });
    expect(leggi({ ...voce, to: { x: 1, y: -7 } })).toEqual({ errore: "via 1: una via incollata si posa dove e' incollata (from e to sono lo stesso posto)" });
    expect(leggi({ ...voce, aggiunta: undefined })).toEqual({ errore: "via 1: non si sposta" });
  });

  it("una via di una rete che la scheda non ha non si posa: e' orfana, e il salvataggio lo dice", () => {
    const voce = { ...salvataggioDellaVia(pwr(), { x: 0, y: -7 }, "g1").vias[0], net: "NESSUNA" };
    expect(statoDelRame(scheda, [], [voce]).orfane.vias).toEqual(["+NESSUNA @ 0,-7"]);
    const letto = leggiRame({ routes: [], vias: [voce], gesto: "g1" }, LIMITI, QUANDO);
    if ("errore" in letto) throw new Error(letto.errore);
    expect(verificaRame({ circuitJson: scheda, regole: REGOLE, correnti: emptyManualEdits(), rame: letto.rame })).toMatchObject({
      ok: false,
      motivo: expect.stringContaining("non verrebbe posata"),
    });
  });
});

describe("una via incollata sopravvive alla compilazione e la colata della sua rete la prende", () => {
  it("compilata coi file, la via c'e', della sua rete, e la colata di GND non le apre un buco attorno", async () => {
    const main = `export default () => (
  <board width="20mm" height="14mm">
    <net name="GND" />
    <resistor name="R1" resistance="1k" footprint="0603" pcbX={-5} pcbY={0} />
    <resistor name="R2" resistance="1k" footprint="0603" pcbX={5} pcbY={0} />
    <trace from=".R1 > .pin1" to="net.GND" />
    <trace from=".R2 > .pin2" to="net.GND" />
    <net name="SIG" />
    <trace from=".R1 > .pin2" to="net.SIG" />
    <via name="V1" pcbX={0} pcbY={4} connectsTo="net.GND" fromLayer="top" toLayer="bottom" holeDiameter={0.3} outerDiameter={0.6} />
    <via name="V2" pcbX={4} pcbY={-4} connectsTo="net.SIG" fromLayer="top" toLayer="bottom" holeDiameter={0.3} outerDiameter={0.6} />
    <copperpour connectsTo="net.GND" layer="bottom" />
  </board>
)
`;
    const prima = await compileProject({ "main.tsx": main });
    const v1 = (prima.circuitJson as El[]).find((e) => e.type === "pcb_via" && reteDi(prima.circuitJson, e) === "GND");
    if (!v1) throw new Error("la scheda di prova non ha la via");
    const c = viaDaCopiare(prima.circuitJson, REGOLE, String(v1.pcb_via_id));
    if ("rifiuto" in c) throw new Error(c.rifiuto);
    expect(c.net).toBe("GND");
    const s = salvataggioDellaVia(c, { x: 0, y: -4 }, "g1");
    const { verifica, file } = salva(prima.circuitJson, emptyManualEdits(), s);
    expect(verifica).toEqual({ ok: true });
    const dopo = await compileProject({ "main.tsx": main, "manual-edits.json": JSON.stringify(file) });
    const [incollata] = vieIncollate(dopo.circuitJson);
    expect(incollata).toMatchObject({ x: 0, y: -4 });
    expect(reteDi(dopo.circuitJson, incollata)).toBe("GND");
    expect(dopo.summary.manualEditsOrphans).toBeUndefined();
    // the pour of GND on the bottom: the via is of its net, so no hole of clearance is cut around it
    const colata = (dopo.circuitJson as El[]).find((e) => e.type === "pcb_copper_pour" && e.layer === "bottom");
    expect(colata).toBeDefined();
    const buchi = JSON.stringify((colata as { brep_shape?: { inner_rings?: unknown[] } }).brep_shape?.inner_rings ?? []);
    const bucoVicinoA = (cx: number, cy: number) =>
      (buchi.match(/"x":(-?[\d.]+),"y":(-?[\d.]+)/g) ?? []).some((m) => {
        const [, x, y] = /"x":(-?[\d.]+),"y":(-?[\d.]+)/.exec(m)!;
        return Math.hypot(Number(x) - cx, Number(y) - cy) < 0.8;
      });
    // the via of SIG at (4; -4) has its hole in the pour, the pasted one of GND at (0; -4) none
    expect(bucoVicinoA(4, -4)).toBe(true);
    expect(bucoVicinoA(0, -4)).toBe(false);
  }, 180_000);
});
