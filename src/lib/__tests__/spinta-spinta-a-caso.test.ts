import { describe, expect, it } from "vitest";

/*
 * "SPINGI E SPOSTA", THE PUSH: GESTURES AT RANDOM ON DENSE BOARDS.
 *
 * The same questions as spinta-mosse-a-caso.test.ts, asked where the copper in
 * hand cannot move without pushing: five traces side by side, a trace above
 * them, two on the bottom under them, a via above and one below. Half of the
 * walks on that board drawn in its files, half with its traces as hand routes
 * (four pieces chained for each).
 *
 * Whenever a gesture moves any copper, pushed traces included:
 *   - every stretch it wrote is at 0, 45 or 90 degrees on whole units, and
 *     hand copper on whole microns;
 *   - saved the way a save goes (the hand routes rewritten by their key, the
 *     corrections read, verified on the saved board and written), the board is
 *     exactly the copper the gesture drew, and no id is doubled;
 *   - runDrcChecks has no violation of a distance, of the edge, between holes,
 *     of an angle or of a pad exit more than before.
 * The gestures go in walks of six, each on the board the one before left, so
 * that pushed copper is grabbed and pushed again.
 */
import { emptyManualEdits } from "@/lib/manual-edits";
import { chiudiGesto, iniziaGesto, muoviGesto } from "@/lib/spinta/gesto";
import type { PresaDelRame } from "@/lib/spinta/gesto-tipi";
import { capiDelTratto, leggiModello } from "@/lib/spinta/modello";
import { comeDetto, GUARDATE, posto, salva, violazioni, type Stato } from "./spinta-prove";
import { casuale, REGOLE, schedaFitta } from "./spinta-scheda";

const GESTI = 1600;
const PASSI_PER_GIRO = 6;

describe("spinta, gesti a caso", () => {
  it(`${GESTI} gestures that move copper on dense boards: what they push is exact, saved, laid as drawn, and no check is worse than before`, () => {
    const rng = casuale(20261113);
    const conta = { gesti: 0, spinti: 0, catene: 0, fermati: 0, vie: 0, tratti: 0, deiFile: 0, aMano: 0, rifiuti: 0, piuLunga: 0 };

    let giro = 0;
    let passi = 0;
    let stato: Stato = { scheda: [], edits: emptyManualEdits() };
    let prima: Record<string, number> = {};
    const riparti = () => {
      const board = schedaFitta({ quante: 5, tratto: true, sotto: true, aMano: giro % 2 === 1 });
      stato = { scheda: board.scheda, edits: board.edits };
      prima = violazioni(stato.scheda);
      expect(prima, "la scheda di partenza").toEqual(Object.fromEntries(GUARDATE.map((r) => [r, 0])));
      giro++;
      passi = 0;
    };
    riparti();

    let tentativi = 0;
    while (conta.gesti < GESTI && tentativi < 20 * GESTI) {
      tentativi++;
      if (passi++ >= PASSI_PER_GIRO) riparti();
      const dove = `gesto ${tentativi} (giro ${giro})`;
      const modello = leggiModello(stato.scheda, REGOLE);

      // what is grabbed, and where it is asked to go: most within the pitch of the bundle, some across it
      const angolo = rng() * 2 * Math.PI;
      const r = rng();
      const quanto = r < 0.5 ? 0.05 + rng() * 0.6 : r < 0.9 ? 0.4 + rng() * 1.6 : 1 + rng() * 4;
      const sposta = { x: Math.cos(angolo) * quanto, y: Math.sin(angolo) * quanto };
      let presa: PresaDelRame;
      let verso: { x: number; y: number };
      const diVia = rng() < 0.35;
      if (diVia) {
        const via = modello.vie[Math.floor(rng() * modello.vie.length)];
        presa = { tipo: "via", pcbViaId: via.id };
        verso = { x: via.x + sposta.x, y: via.y + sposta.y };
      } else {
        const tutti = modello.piste.flatMap((p) => p.tratti.map((t) => ({ p, t })));
        const { p, t } = tutti[Math.floor(rng() * tutti.length)];
        const [a, b] = capiDelTratto(p, t);
        presa = { tipo: "tratto", pcbTraceId: p.id, indice: t.indiceDiRoute };
        verso = { x: (a.x + b.x) / 2 + sposta.x, y: (a.y + b.y) / 2 + sposta.y };
      }

      const inizio = iniziaGesto({ circuitJson: stato.scheda, regole: REGOLE, presa });
      if ("rifiuto" in inizio) {
        conta.rifiuti++;
        continue;
      }
      const fine = muoviGesto(inizio.gesto, verso);
      if (tentativi % 20 === 0) expect(JSON.stringify(muoviGesto(inizio.gesto, verso)), dove).toBe(JSON.stringify(fine));
      // a gesture stopped on its way says what stops it
      if (fine.blocco) expect(fine.blocco.motivo, dove).toMatch(/^bloccato/);
      const salvataggio = chiudiGesto(inizio.gesto, fine, "g");
      expect(salvataggio !== null, dove).toBe(fine.mosso);
      if (!salvataggio) continue;

      conta.gesti++;
      if (fine.blocco) conta.fermati++;
      if (diVia) conta.vie++;
      else conta.tratti++;
      if (salvataggio.riscritte.length > 0) conta.aMano++;
      else conta.deiFile++;
      // the traces pushed aside, counted by net: a hand trace is several pieces of one net
      const inMano = new Set(inizio.stato.nascosti.pcbTraceIds);
      const spinte = new Set(fine.nascosti.pcbTraceIds.filter((id) => !inMano.has(id)).map((id) => modello.piste[modello.pistaPerId.get(id)!].nomeRete));
      if (spinte.size > 0) conta.spinti++;
      if (spinte.size > 1) conta.catene++;
      conta.piuLunga = Math.max(conta.piuLunga, spinte.size);

      const dopo = salva(stato, salvataggio, dove);
      comeDetto(
        stato.scheda,
        dopo.scheda,
        { piste: new Set(fine.nascosti.pcbTraceIds), vie: new Set(fine.nascosti.pcbViaIds) },
        { tratti: fine.tratti.map((t) => JSON.stringify(t)), vie: fine.vie.map(posto) },
        dove,
      );
      const poi = violazioni(dopo.scheda);
      for (const regola of GUARDATE) expect(poi[regola], `${dove}: ${regola}`).toBeLessThanOrEqual(prima[regola]);
      stato = dopo;
      prima = poi;
    }

    expect(conta.gesti).toBeGreaterThanOrEqual(GESTI);
    // of every kind, and with the push at work in many of them. Measured with this seed on the first 1200: 284 gestures
    // pushed a trace of another net, 147 of them two or more in a chain, the longest of seven nets; 196 were stopped on their way
    expect(conta.spinti).toBeGreaterThanOrEqual(300);
    expect(conta.catene).toBeGreaterThanOrEqual(150);
    expect(conta.piuLunga).toBeGreaterThanOrEqual(5);
    expect(conta.vie).toBeGreaterThanOrEqual(150);
    expect(conta.tratti).toBeGreaterThanOrEqual(300);
    expect(conta.deiFile).toBeGreaterThanOrEqual(300);
    expect(conta.aMano).toBeGreaterThanOrEqual(300);
    expect(conta.fermati).toBeGreaterThanOrEqual(50);
  }, 300_000);
});
