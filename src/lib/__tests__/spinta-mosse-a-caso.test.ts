import { describe, expect, it } from "vitest";

/*
 * "SPINGI E SPOSTA": A THOUSAND MOVES AT RANDOM, AND THE CHECKS AFTER EACH.
 *
 * What one test of one move cannot show: that WHATEVER is grabbed and WHEREVER
 * it is dragged, the copper that comes out is copper the house rules accept.
 * The moves are drawn from a seed, so the same thousand every run.
 *
 * Every move is made twice over: in one leap (the elementary move of mosse.ts,
 * straight to the place asked) and as the gesture makes it (gesto.ts: in short
 * steps from the start, stopping at the last good one). Whenever either moves
 * any copper:
 *   - every stretch it gives is at 0, 45 or 90 degrees ON WHOLE UNITS, the
 *     check `dx == 0 || dy == 0 || |dx| == |dy|` with no tolerance, and hand
 *     copper is on whole microns;
 *   - saved the way a save goes (read, verified on the saved board, written in
 *     the file, laid by applyManualRoutes), the copper on the board is exactly
 *     the copper the move said, and no id is doubled;
 *   - runDrcChecks on that board has no violation of a distance, of an angle
 *     or of a pad exit more than the board had before the move.
 * And on the boards the moves leave, the targets preseDelRame marks as never
 * moving (`fermo`) are exactly the ones iniziaGesto refuses, sentence for
 * sentence.
 *
 * The moves go in walks of eight on one board, each from the board the one
 * before left, so that copper already moved is moved again; half of the walks
 * on the test board drawn in its files, half on the same board with its copper
 * as hand routes (pieces of a net chained end to end, every via a route of its
 * own) and a trace and a via of the files next to them. Every second walk on
 * each has three traces with a stretch off its direction by a hair, as the
 * sources of a real board write them: such a stretch is left as it is until a
 * move touches it, and what the move writes in its place is exact.
 */
import { runDrcChecks } from "@/lib/drc";
import { idDoppi } from "@/lib/duplicate-ids";
import { applyCopperPatch, emptyManualEdits, type ManualEdits } from "@/lib/manual-edits";
import { applyManualRoutes, manualRouteKey, percorsoDellaPista, type ManualRoutePoint } from "@/lib/manual-routes";
import { direzioneEsatta, inUnita } from "@/lib/spinta/geometria";
import { chiudiGesto, iniziaGesto, muoviGesto } from "@/lib/spinta/gesto";
import type { PresaDelRame, SalvataggioDelGesto } from "@/lib/spinta/gesto-tipi";
import { capiDelTratto, leggiModello } from "@/lib/spinta/modello";
import { spostaVia, traslaTratto, type MotivoDelBlocco } from "@/lib/spinta/mosse";
import { correzioniDellaMossa, riscritteDellaMossa } from "@/lib/spinta/salvataggio";
import { leggiRame, trattiStorti, verificaRame } from "@/lib/spinta/verifica";
import type { El } from "./scheda-di-prova";
import { casuale, fermiComeIRifiuti, rameQuasiEsatto, REGOLE, schedaAMano, schedaDiSpinta } from "./spinta-scheda";

const MOSSE = 1000;
const PASSI_PER_GIRO = 8;
const LIMITI = { maxRoutes: 200, maxPoints: 2000, maxVias: 500 };
const QUANDO = "2026-11-12T10:00:00.000Z";

/** the checks a move must not make worse: the distances, the angles, the exits from the pads */
const GUARDATE = ["pad_clearance", "trace_pad_clearance", "trace_trace_clearance", "board_edge_clearance", "hole_to_hole", "trace_angle", "pin_escape"];
const violazioni = (cj: unknown[]): Record<string, number> => {
  const out: Record<string, number> = Object.fromEntries(GUARDATE.map((r) => [r, 0]));
  for (const v of runDrcChecks(cj as never, REGOLE)) if (v.rule in out) out[v.rule] += v.count ?? 1;
  return out;
};

const piste = (cj: unknown[]) => (cj as El[]).filter((e) => e.type === "pcb_trace");
const vie = (cj: unknown[]) => (cj as El[]).filter((e) => e.type === "pcb_via");
const larghezzaDi = (e: El): number => Number((e.route as Array<Record<string, unknown>>).find((p) => p.route_type === "wire")?.width);
/** the stretches of some paths, as text, in no order */
const comeTratti = (percorsi: Array<{ punti: ManualRoutePoint[]; larga: number }>): string[] =>
  percorsi.flatMap(({ punti, larga }) =>
    punti.slice(1).flatMap((b, i) => (punti[i].layer === b.layer ? [JSON.stringify({ x1: punti[i].x, y1: punti[i].y, x2: b.x, y2: b.y, layer: b.layer, width: larga })] : [])),
  );
const trattiDellaScheda = (cj: unknown[], senza: ReadonlySet<string>): string[] =>
  comeTratti(piste(cj).filter((e) => !senza.has(String(e.pcb_trace_id))).map((e) => ({ punti: percorsoDellaPista(e), larga: larghezzaDi(e) })));
const posto = (v: object): string => `${Number((v as { x?: unknown }).x)};${Number((v as { y?: unknown }).y)}`;

/** the stretches of a path, each as text the same whichever way it is read */
const stretti = (punti: readonly ManualRoutePoint[]): Set<string> => {
  const out = new Set<string>();
  for (let k = 1; k < punti.length; k++) {
    const [a, b] = [punti[k - 1], punti[k]];
    if (a.layer !== b.layer) continue;
    out.add(`${a.x},${a.y}>${b.x},${b.y}@${a.layer}`);
    out.add(`${b.x},${b.y}>${a.x},${a.y}@${a.layer}`);
  }
  return out;
};

/**
 * A path a move gives: every stretch THE MOVE WROTE at 0, 45 or 90 degrees on
 * whole units, a change of layer in one place; on whole microns for hand
 * copper. The stretches the path had before (`prima`) are a given: a stretch
 * the sources wrote off its direction by a hair stays as it is until a move
 * touches it.
 */
function direzioniEsatte(punti: readonly ManualRoutePoint[], griglia: number, dove: string, prima: readonly ManualRoutePoint[]): void {
  const dati = stretti(prima);
  for (const q of punti) {
    expect([Math.abs(inUnita(q.x)) % griglia, Math.abs(inUnita(q.y)) % griglia], `${dove}: ${JSON.stringify(q)} fuori griglia`).toEqual([0, 0]);
    // the number written is the number of the grid: nothing left for a rounding to move
    expect([q.x, q.y], dove).toEqual([inUnita(q.x) / 1e4, inUnita(q.y) / 1e4]);
  }
  for (let k = 1; k < punti.length; k++) {
    const dx = inUnita(punti[k].x) - inUnita(punti[k - 1].x);
    const dy = inUnita(punti[k].y) - inUnita(punti[k - 1].y);
    if (punti[k].layer !== punti[k - 1].layer) expect([dx, dy], `${dove}: cambio di strato fra due posti`).toEqual([0, 0]);
    else if (!dati.has(`${punti[k - 1].x},${punti[k - 1].y}>${punti[k].x},${punti[k].y}@${punti[k].layer}`)) {
      expect(direzioneEsatta(dx, dy), `${dove}: tratto ${k} di ${JSON.stringify(punti)}`).toBe(true);
    }
  }
}

/** a board and the file of hand edits that lays its copper */
interface Stato {
  scheda: El[];
  edits: ManualEdits;
}

/**
 * What a move asks to be saved, taken the way a save takes it, on the board
 * the move started from: the board and the file it leaves.
 */
function salva(stato: Stato, s: SalvataggioDelGesto, dove: string): Stato {
  let edits = stato.edits;
  if (s.riscritte.length > 0) {
    // the server: the route of that key, with its new path and nothing else changed
    const nuove = new Map(s.riscritte.map((r) => [r.chiave, r.points]));
    expect(nuove.size, dove).toBe(s.riscritte.length);
    for (const k of nuove.keys()) expect(edits.pcb_routes.filter((r) => manualRouteKey(r) === k), `${dove}: ${k}`).toHaveLength(1);
    for (const r of s.riscritte) direzioniEsatte(r.points, 10, `${dove}, riscritta ${r.chiave}`, edits.pcb_routes.find((x) => manualRouteKey(x) === r.chiave)!.points);
    edits = { ...edits, pcb_routes: edits.pcb_routes.map((r) => (nuove.has(manualRouteKey(r)) ? { ...r, points: nuove.get(manualRouteKey(r))! } : r)) };
  }
  if (s.routes.length > 0 || s.vias.length > 0) {
    for (const r of s.routes) {
      direzioniEsatte(r.points, 1, `${dove}, ${r.connection}`, r.replaces!.original);
      // the check the server makes of the same thing
      expect(trattiStorti(r), dove).toBeNull();
    }
    const letto = leggiRame({ routes: s.routes, vias: s.vias, gesto: "g" }, LIMITI, QUANDO);
    if ("errore" in letto) throw new Error(`${dove}: non letto: ${letto.errore}`);
    expect(verificaRame({ circuitJson: stato.scheda, regole: REGOLE, correnti: edits, rame: letto.rame }), dove).toEqual({ ok: true });
    edits = applyCopperPatch(edits, letto.rame).edits;
  }
  const posata = applyManualRoutes({
    circuitJson: stato.scheda,
    routes: edits.pcb_routes,
    vias: edits.pcb_vias,
    viaDiameter: REGOLE.minViaDiameterMm,
    viaHoleDiameter: REGOLE.minViaHoleMm,
  });
  expect(posata.rame, dove).toEqual({ orfane: { routes: [], vias: [] }, assorbite: { routes: [], vias: [] } });
  expect(posata.unknown, dove).toEqual([]);
  return { scheda: posata.circuitJson as El[], edits };
}

/**
 * The board after a move against what the move said: the stretches of the
 * traces it touched and the places of the vias it touched are the ones it
 * gave, and every other piece of copper is where it was.
 */
function comeDetto(
  prima: El[],
  dopo: El[],
  toccato: { piste: ReadonlySet<string>; vie: ReadonlySet<string> },
  detto: { tratti: string[]; vie: string[] },
  dove: string,
): void {
  expect(trattiDellaScheda(dopo, new Set()).sort(), `${dove}: le piste`).toEqual([...trattiDellaScheda(prima, toccato.piste), ...detto.tratti].sort());
  expect(vie(dopo).map(posto).sort(), `${dove}: le vie`).toEqual(
    [
      ...vie(prima)
        .filter((v) => !toccato.vie.has(String(v.pcb_via_id)))
        .map(posto),
      ...detto.vie,
    ].sort(),
  );
  expect(idDoppi(dopo), dove).toBeNull();
}

describe("spinta, mosse a caso", () => {
  it(`${MOSSE} moves that move copper, in one leap and as a gesture: every stretch at 0, 45 or 90 degrees on whole units, the board as the move said, and no check worse than before`, () => {
    const rng = casuale(20261112);
    const ampiezza = (): number => {
      const r = rng();
      // a few under the grid, most within a millimetre, some across the board
      return r < 0.12 ? rng() * 0.004 : r < 0.72 ? 0.02 + rng() * 1.2 : 1 + rng() * 6;
    };
    const conta = { balzi: 0, gesti: 0, gestiFermati: 0, vie: 0, tratti: 0, deiFile: 0, aMano: 0, misti: 0, rifiuti: 0, raddrizzati: 0 };
    /** whether a move wrote exact copper in the place of a stretch that was off its direction by a hair */
    const raddrizza = (prima: readonly ManualRoutePoint[], dopo: readonly ManualRoutePoint[]): boolean => {
      const restano = stretti(dopo);
      for (let k = 1; k < prima.length; k++) {
        const [a, b] = [prima[k - 1], prima[k]];
        if (a.layer !== b.layer || direzioneEsatta(inUnita(b.x) - inUnita(a.x), inUnita(b.y) - inUnita(a.y))) continue;
        if (!restano.has(`${a.x},${a.y}>${b.x},${b.y}@${a.layer}`)) return true;
      }
      return false;
    };
    const bersagli = { fermi: 0, mobili: 0 };
    const blocchi = new Map<MotivoDelBlocco, number>();
    const segna = (motivo: MotivoDelBlocco) => blocchi.set(motivo, (blocchi.get(motivo) ?? 0) + 1);

    let giro = 0;
    let passi = 0;
    let stato: Stato = { scheda: [], edits: emptyManualEdits() };
    let prima: Record<string, number> = {};
    const riparti = () => {
      // in turn: the board of the files, the board of hand copper, and each again with stretches off their direction by a hair
      const quasi = giro % 4 >= 2;
      stato = giro % 2 === 0 ? { scheda: schedaDiSpinta(quasi ? rameQuasiEsatto() : {}), edits: emptyManualEdits() } : schedaAMano(quasi);
      prima = violazioni(stato.scheda);
      // the boards of the test break no rule to begin with: "no more than before" is "none"
      expect(prima, "la scheda di partenza").toEqual(Object.fromEntries(GUARDATE.map((r) => [r, 0])));
      giro++;
      passi = 0;
    };
    riparti();

    let tentativi = 0;
    while (conta.balzi + conta.gesti < MOSSE * 2 && tentativi < 40 * MOSSE) {
      tentativi++;
      if (passi++ >= PASSI_PER_GIRO) riparti();
      const dove = `mossa ${tentativi} (giro ${giro})`;
      // on the four boards as they start, and on a board the moves have changed every so often: the targets marked as never moving are the ones a gesture refuses
      if (giro <= 4 ? passi === 1 : tentativi % 20 === 0) {
        const quanti = fermiComeIRifiuti(stato.scheda, REGOLE);
        bersagli.fermi += quanti.fermi;
        bersagli.mobili += quanti.mobili;
      }
      const modello = leggiModello(stato.scheda, REGOLE);

      // --- what is grabbed, and where it is asked to go
      const angolo = rng() * 2 * Math.PI;
      const quanto = ampiezza();
      const sposta = { x: Math.cos(angolo) * quanto, y: Math.sin(angolo) * quanto };
      let presa: PresaDelRame;
      let verso: { x: number; y: number };
      let balzo: ReturnType<typeof spostaVia>;
      const diVia = rng() < 0.45;
      if (diVia) {
        const via = modello.vie[Math.floor(rng() * modello.vie.length)];
        presa = { tipo: "via", pcbViaId: via.id };
        verso = { x: via.x + sposta.x, y: via.y + sposta.y };
        balzo = spostaVia(modello, via.indice, verso);
        if (tentativi % 25 === 0) expect(spostaVia(modello, via.indice, verso), dove).toEqual(balzo);
      } else {
        const tutti = modello.piste.flatMap((p) => p.tratti.map((t) => ({ p, t })));
        const { p, t } = tutti[Math.floor(rng() * tutti.length)];
        const [a, b] = capiDelTratto(p, t);
        presa = { tipo: "tratto", pcbTraceId: p.id, indice: t.indiceDiRoute };
        verso = { x: (a.x + b.x) / 2 + sposta.x, y: (a.y + b.y) / 2 + sposta.y };
        balzo = traslaTratto(modello, { pista: p.indice, tratto: t.indice }, sposta);
        if (tentativi % 25 === 0) expect(traslaTratto(modello, { pista: p.indice, tratto: t.indice }, sposta), dove).toEqual(balzo);
      }

      // --- in one leap
      if (!balzo.ok) {
        segna(balzo.blocco.motivo);
        expect(balzo.blocco.messaggio.length, dove).toBeGreaterThan(10);
        expect([Number.isFinite(balzo.blocco.dove.x), Number.isFinite(balzo.blocco.dove.y)], dove).toEqual([true, true]);
      } else if (balzo.piste.length > 0 || balzo.vie.length > 0) {
        conta.balzi++;
        if (balzo.piste.some((m) => raddrizza(modello.piste[m.pista].punti, m.punti))) conta.raddrizzati++;
        for (const m of balzo.piste) direzioniEsatte(m.punti, modello.piste[m.pista].griglia, `${dove}, balzo`, modello.piste[m.pista].punti);
        const rame = correzioniDellaMossa(modello, balzo, "g");
        const dopo = salva(stato, { routes: rame.routes, vias: rame.vias, riscritte: riscritteDellaMossa(modello, balzo) }, `${dove}, balzo`);
        comeDetto(
          stato.scheda,
          dopo.scheda,
          { piste: new Set(balzo.piste.map((m) => modello.piste[m.pista].id)), vie: new Set(balzo.vie.map((m) => modello.vie[m.via].id)) },
          { tratti: comeTratti(balzo.piste.map((m) => ({ punti: m.punti, larga: modello.piste[m.pista].larghezza }))), vie: balzo.vie.map((m) => posto(m.a)) },
          `${dove}, balzo`,
        );
        const poi = violazioni(dopo.scheda);
        for (const r of GUARDATE) expect(poi[r], `${dove}, balzo: ${r}`).toBeLessThanOrEqual(prima[r]);
      }

      // --- as the gesture
      const inizio = iniziaGesto({ circuitJson: stato.scheda, regole: REGOLE, presa });
      if ("rifiuto" in inizio) {
        conta.rifiuti++;
        // what cannot be grabbed cannot be moved in one leap either
        expect(balzo.ok, `${dove}: ${inizio.rifiuto}`).toBe(false);
        continue;
      }
      const fine = muoviGesto(inizio.gesto, verso);
      if (tentativi % 25 === 0) expect(JSON.stringify(muoviGesto(inizio.gesto, verso)), dove).toBe(JSON.stringify(fine));
      expect(fine.nascosti, dove).toBe(inizio.stato.nascosti);
      // what the gesture draws: the stretches that were there as they were, every other one exact
      const cherano = new Set(trattiDellaScheda(stato.scheda, new Set()));
      for (const t of fine.tratti) {
        if (cherano.has(JSON.stringify(t))) continue;
        expect(direzioneEsatta(inUnita(t.x2) - inUnita(t.x1), inUnita(t.y2) - inUnita(t.y1)), `${dove}, gesto: ${JSON.stringify(t)}`).toBe(true);
      }
      // a via that meets nothing on its way stands where the leap puts it
      if (diVia && fine.blocco === null) {
        expect(balzo.ok, dove).toBe(true);
        if (balzo.ok && balzo.vie.length > 0) expect(fine.posizione, dove).toEqual(balzo.vie[0].a);
      }
      const salvataggio = chiudiGesto(inizio.gesto, fine, "g");
      expect(salvataggio !== null, dove).toBe(fine.mosso);
      if (!salvataggio) continue;
      conta.gesti++;
      if (fine.blocco) conta.gestiFermati++;
      if (diVia) conta.vie++;
      else conta.tratti++;
      const aMano = salvataggio.riscritte.length > 0;
      const deiFile = salvataggio.routes.length > 0 || salvataggio.vias.length > 0;
      if (aMano && deiFile) conta.misti++;
      else if (aMano) conta.aMano++;
      else conta.deiFile++;
      const dopo = salva(stato, salvataggio, `${dove}, gesto`);
      comeDetto(
        stato.scheda,
        dopo.scheda,
        { piste: new Set(fine.nascosti.pcbTraceIds), vie: new Set(fine.nascosti.pcbViaIds) },
        { tratti: fine.tratti.map((t) => JSON.stringify(t)), vie: fine.vie.map(posto) },
        `${dove}, gesto`,
      );
      const poi = violazioni(dopo.scheda);
      for (const r of GUARDATE) expect(poi[r], `${dove}, gesto: ${r}`).toBeLessThanOrEqual(prima[r]);
      // the next move starts from the board this one left
      stato = dopo;
      prima = poi;
    }

    // twice a thousand moves that moved copper were checked (measured with this seed: 906 leaps and 1095 gestures in 1935 tries)
    expect(conta.balzi + conta.gesti).toBeGreaterThanOrEqual(MOSSE * 2);
    expect(conta.balzi, "mosse in un balzo").toBeGreaterThanOrEqual(MOSSE / 2);
    expect(conta.gesti, "mosse col gesto").toBeGreaterThanOrEqual(MOSSE / 2);
    // of every kind: vias and stretches, copper of the files and hand copper, gestures stopped on their way, stretches off by a hair made exact
    expect(conta.vie).toBeGreaterThanOrEqual(300);
    expect(conta.tratti).toBeGreaterThanOrEqual(150);
    expect(conta.deiFile).toBeGreaterThanOrEqual(300);
    expect(conta.aMano).toBeGreaterThanOrEqual(200);
    expect(conta.gestiFermati).toBeGreaterThanOrEqual(80);
    expect(conta.raddrizzati).toBeGreaterThanOrEqual(30);
    // the targets were asked on boards of every kind, and both answers were given many times
    expect(bersagli.fermi).toBeGreaterThan(500);
    expect(bersagli.mobili).toBeGreaterThan(500);
    // and the blocks the board can give were all met on the way
    for (const motivo of ["pad_di_lato", "gomito", "giunzione_a_t", "angolo_acuto", "tratto_sparirebbe", "pista", "bordo", "keepout"] as MotivoDelBlocco[]) {
      expect(blocchi.get(motivo) ?? 0, motivo).toBeGreaterThan(0);
    }
  }, 300_000);
});
