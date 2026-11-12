/**
 * Version of the checks engine (DRC, PRC, schematic quality, variant
 * engine, compile summary structure). INCREMENT on every change to those
 * logics: the compile cache is valid only if produced by the same
 * version — otherwise the board must be re-evaluated (POST /api/recheck),
 * because a "truth" computed with old checks is no longer a truth.
 */
// 2 (2026-10-19): plated holes measured by shape, real connectivity for
// "unrouted", per-rule caps, edge on the real outline, via nets from their trace
// 3 (2026-10-20): the stencil opening of each pad is the pad plus the project's
// pasteExpansionMm, no longer tscircuit's 70%: older boards must be recompiled
// or rechecked before their Gerber can be exported
// 4 (2026-10-20): no piece of a pour narrower than the minimum trace width
// (pour-necks.ts); through vias get their pad on the inner layers in the Gerber
// 5 (2026-11-01): necks into fine-pitch pins and short pad-to-pad bridges accepted by power_trace_width, the PRC count
// beyond the 15 listed, the fab class of the project's own rules, dangling traces on vias, same-net copper in the
// placement gap, pours re-poured from their declared outline (d689551); polygonal pads measured on their outline
// (20a62ca)
// 6 (2026-11-11): pill and turned-pill pads get their stencil opening (tscircuit writes none: the flash and a
// six-pad part of sbb-dl-principale had no paste at all), and a part whose pads still have no opening is a
// "paste_missing" failure. Older boards must be recompiled or rechecked before their Gerber can be exported
// 7 (2026-11-11): every via is a through hole. A via written on part of the stack (tscircuit does it for the via of a
// hand-drawn trace that joins an outer layer and an inner one: 32 of the 253 of sbb-dl-principale) was taken for blind
// or buried: the planes of the layers it left out closed over the hole (inner1 ground on 20 holes of VBUS, VSYS, NRST
// and the SD lines) and the drill file did not have it. Now every via lists the whole stack, the planes open around it
// on every layer, the drill file has it, and a plane too close to a via of another net is a "pour_clearance" violation.
// Older boards must be recompiled or rechecked before their Gerber can be exported: a recheck pours again the planes
// of a board that has such a via. And a board that still has a plane over a via of another net, because the planes
// could not be poured again, is not filed under this engine by the compile or by the recheck (see motoreDaSalvare)
// 8 (2026-11-11): a trace is paired with a pad by position only on the layer of that trace (a through hole on every
// layer, see stratoDelPad). pin_escape took the first pad under the end in plan view: on sbb-dl-principale a bottom
// trace entering the ball IC6.E1 straight was measured against the top pad C4.2 over it and reported at 45 degrees,
// and the house rule that straightens escapes would have bent it. The same reading is fixed in the net of a trace
// without one, the pads of a net tie (DRC and matched lengths), the dangling traces, the net of a spliced power
// trace and the tie stubs of the plane check
// 9 (2026-11-11): the pours are drawn like a CAD's. Every pour starts again from the outline its file declares, in any
// file the board imports (sbb-dl-principale keeps its 296 in righe_2/3/4 and none was put back: each was re-poured from
// tscircuit's own pour, 0.19 mm inside the outline and cut by a square at every vertex, which made the staircases, the
// lumps at the bends and the lobes around the vias); a `<copperpour>` with no outline starts from the board's. Every obstacle is grown by the clearance with round corners and arcs within 2
// micrometres, outside the true curve (the solver's 32-sided circles stood up to 6 micrometres inside the clearance);
// the edge band follows the outline with no square on its vertices; own pads are held by their real shape (a pill held
// as its bounding box brought the TM board's NetC1_1 strip within 0.019 mm of the ground plane); the opening that takes
// out the necks uses as many segments as its radius needs, keeps the declared corners and is idempotent; every ring is
// cleaned of what it does not need, only ever taking copper away; the pours are written so that no hole of one, drawn
// clear in the Gerber, erases copper of another written before it. Every board's
// pours change shape: compile it again ("Aggiorna"). A recheck of an older board takes out necks and cleans the rings,
// it does not pour again from the declared outlines, so a board of an older engine with pours on it keeps its engine
// through a recheck and the export refuses it until a compile (see colateDiUnMotoreDiPrima); the export writes the
// pours in that order whatever saved the board. A declaration is poured only when tscircuit poured it (a pour in a
// comment, in a component never used or behind a false condition was poured from the text). And two pours of
// different nets on one layer that touch or stand closer than the larger of their two clearances are a
// "pour_pour_clearance" violation, and the export refuses the board (nothing measured pour against pour: the
// server's board of 17:06 had the ground pour over the USB shield)
// 10 (2026-11-11): the silkscreen is measured (silkscreen-clearance.ts): against another drawing and against bare
// copper closer than the project's minSilkscreenClearanceMm (0.15 mm unless design-rules.json says otherwise), and
// over the holes of vias and bare holes. Nothing measured it: on tm-4l-q1 the outlines of two parts overlapped and the
// designators ran over other outlines and over vias with every check green. It is a warning (CompileSummary.silkscreen):
// not in the DRC count nor in the fab class, it does not stop the export and does not keep a board under an older
// engine. Copper and pours do not change: a board of engine 9 comes to 10 with a recheck ("Ricontrolla"), no compile
// 11 (2026-11-12): the footprints of the parts in assembly are measured (ingombro.ts, component-clearance.ts): the
// declared courtyard, or the rectangle around body and pads (the body of a 3D model's box too, a two-pad passive's
// from its standard size) grown by the project's componentCourtyardExcessMm (0.2 mm a side unless design-rules.json
// says otherwise). Two parts on one face whose footprints overlap hit each other in assembly: an error
// (CompileSummary.courtyards, targets.courtyardCollisions, allGreen false, the board is not ready), not in the DRC nor
// in the fab class, and the export goes on; a compile with such a pair is not ok. Two footprints that only touch do
// not hit, and tscircuit's pcb_courtyard_overlap_error of every pair the check measures is absorbed (it says the
// opposite on a contact); it stays an error only for a pair the check could not measure. Warnings: parts whose footprint is their pads alone, parts in a connector's mating space, outlines and
// designators written as board drawings. On sbb-dl-principale 26 pairs had pads under 0.30 mm with every check green.
// And the distance from a segment to a rectangle is taken side against side (it was taken from the corners only, and a
// short segment running along a pad, its ends in front of the side, came out as far as the corners): trace against pad,
// silkscreen against pad, a pill pad against a rect pad and the board edge measure true.
// Copper and pours do not change: a board of engine 10 comes to 11 with a recheck ("Ricontrolla"), no compile
// 12 (2026-11-12): every point of a DRC violation says the layer its problem is on (drc.ts, PuntoDrc): the trace or the
// pad of one layer, the plane that did not open around a via, the pad off its plane; nothing for what goes through the
// board (a hole, a via, two through pads). The viewer draws each dot only on the face it belongs to, by the rule of
// strati-visibili.ts: with the top chosen the dots of the bottom were all there ("solo i marcatori della faccia
// visibile", Niccolo'). No check changes its answer and no count changes: only the summary gains the layer, so a board
// of engine 11 comes to 12 with a recheck ("Ricontrolla"), no compile. Until then its dots stay on every face.
// In the same engine, one check does change its answer: the ERC no longer reports the three ports (top, bottom, pin1)
// tscircuit gives to every <via> written in a file as "pin non collegato" (erc.ts). sbb-dl-principale had 543 such
// lines for its 181 vias and "Cuci la massa" adds three per via: the list, 200 lines at most, held nothing else. The
// count of unconnected pins of a board with written vias goes down by three per via; a recheck is enough.
// And the export refuses a board where two elements have the same id (nonCertificata, duplicate-ids.ts): it is
// measured on the board about to go, like a plane over a via, so no saved answer changes.
// Still in 12 (not published when this was added): boards of six and eight copper layers. The layers of a board come
// from one place (strati-rame.ts: top, inner1..inner(n-2), bottom, from the number the board declares) and every list
// written by hand uses it. On a board of two or four layers no check changes its answer and no count changes. On six
// and eight layers two answers change, both corrections: a hand route through inner3..inner6 is read and laid on a
// board that has that layer (it was thrown away whole when read, so it could not be saved and its connection stayed
// open; on a board without that layer it is left off and its connection stays open, as before); and pour against pour
// knows the vias and the through holes of a pour's own net on every layer of the board (the list stopped at inner4:
// on an 8-layer board, where a pour on inner5 or inner6 holds a via of its net whole, the other pour standing at its
// own clearance from that via was reported as "pour_pour_clearance"; the same for a pour written on inner5 or inner6
// of a board with fewer layers). The other checks already read the layer as it is written
// 13 (2026-11-12): the pours are measured against the traces and the pads of the other nets, not only against the vias
// (drc.ts, check 9). The fast update never pours: a trace drawn in Instrada across the pour of another net, or a part
// moved in Sposta whose pads land in the old pour of another net, stayed in that copper, a short, with every check
// green, under today's engine, and the Gerber export answered 200 (measured on a compiled board: spinta-misure.test.ts).
// Now every wire segment of a trace with its width, every SMD pad on its layer and the copper of every plated hole on
// every layer is measured against every pour of another net on that layer: under the pour's clearance (its own when
// it declares one, the project's otherwise, with the tolerance of the vias) it is a "pour_clearance" violation with
// its point and its layer. The copper measured is the poured one: where a pad or a via of the pour's own net, which
// the pour holds whole, is as near as the pour, the gap is theirs and the pair checks judge it (a trace across a
// ground pad is a "trace over pad", on a board just compiled too), unless that copper lies in the poured copper as
// well. Copper of the pour's own net is never a violation (ground pads in the ground pour, the pads and the vias a
// declared strip joins), nor a net tie against the nets it joins, nor copper with no known net. And a board where a
// trace or a pad touches the poured copper of another net or lies in it says so in its summary
// (CompileSummary.poursOverCopper: which trace or pad, by connection or by part and pin, and on which layer) and is
// refused by the export, which measures the board about to go as it does for a plane over a via: "Aggiorna" pours
// again around that copper. A board whose pours come from a compile has no such violation, so no answer of it
// changes: a board of engine 12 comes to 13 with a recheck ("Ricontrolla"), no compile. A recheck does not pour again
// for this: a board with copper in a pour still needs "Aggiorna" after it
export const CHECKS_ENGINE_VERSION = 13;

/**
 * The first engine that measures the footprints of the parts and absorbs
 * tscircuit's courtyard errors of the pairs it measures (see the note of 11):
 * a board saved by an older one kept them among its errors.
 */
export const ENGINE_INGOMBRI = 11;

/**
 * The first engine whose pours start again from the outlines the files
 * declare and are written in an order where no hole erases another pour (see
 * conContorniDichiarati and ordinePerIlGerber in pours-recompute.ts). Only a
 * compile pours that way: see colateDiUnMotoreDiPrima.
 */
export const ENGINE_COLATE_DAI_CONTORNI = 9;

/**
 * The first engine whose planes open around EVERY via, whatever layers it
 * lists. A board saved by an older one, with a via written on part of the
 * stack, has planes that were poured without seeing that hole: a recheck pours
 * them again (see ricolaSeLeVieEranoParziali).
 */
export const ENGINE_VIE_PASSANTI = 7;

/** what the summary says when a plane was not opened around a via of another net (see CompileSummary.planesOverVias) */
export interface PianiSuVie {
  /** how many vias have their pad in the copper of another net's plane */
  count: number;
  /** the fact in words, with the first of them by name */
  detail: string;
}

const pianiSuVieDi = (summary: unknown): PianiSuVie | null => {
  const p = (summary as { planesOverVias?: Partial<PianiSuVie> } | null | undefined)?.planesOverVias;
  return p && typeof p.count === "number" && p.count > 0 ? { count: p.count, detail: String(p.detail ?? "") } : null;
};

/**
 * what the summary says when a trace or a pad is in the copper of another net's pour (see
 * CompileSummary.poursOverCopper, measured by colateSopraIlRame in drc.ts)
 */
export interface ColateSuRame {
  /** how many traces and pads touch the copper of a pour of another net or lie in it */
  count: number;
  /** the fact in words: the first of them by the name a person knows them by, each with its pour and its layer */
  detail: string;
}

const colateSuRameDi = (summary: unknown): ColateSuRame | null => {
  const r = (summary as { poursOverCopper?: Partial<ColateSuRame> } | null | undefined)?.poursOverCopper;
  return r && typeof r.count === "number" && r.count > 0 ? { count: r.count, detail: String(r.detail ?? "") } : null;
};

/**
 * THE ENGINE A BOARD JUST COMPILED OR RECHECKED IS FILED UNDER.
 *
 * Today's, unless a plane still covers a via of another net. The planes are
 * poured again at the end of every compile and, for a board that needs it, of
 * a recheck, but that step can leave a plane as it was: the solver of one pour
 * fails or gives nothing back and the old shape is kept (ricolaPiani), or the
 * whole step fails and tscircuit's own pours stay on the board (compileProject).
 * Filed under today's engine, such a board was exportable with a plane over a
 * hole, and the only trace of it was a line of the DRC, which the export does
 * not read (review of the through-via fix, 2026-11-11).
 *
 * So that board keeps an engine older than ENGINE_VIE_PASSANTI, the one it had
 * when it had one: the export refuses it like any board checked by an older
 * engine, and the answer of the compile or of the recheck says why (see
 * nonCertificata).
 *
 * Nor to a board a recheck found with the pours of an engine before
 * ENGINE_COLATE_DAI_CONTORNI (CompileSummary.poursFromOlderEngine, see
 * colateDiUnMotoreDiPrima): it keeps the engine it had, below that one.
 */
export function motoreDaSalvare(summary: unknown, precedente: number = CHECKS_ENGINE_VERSION): number {
  let motore = CHECKS_ENGINE_VERSION;
  if (pianiSuVieDi(summary)) motore = Math.min(precedente, ENGINE_VIE_PASSANTI - 1);
  if (colateDiPrimaDi(summary)) motore = Math.min(motore, precedente, ENGINE_COLATE_DAI_CONTORNI - 1);
  return motore;
}

/** what the summary says when the pours on a board were made by an older engine (see CompileSummary.poursFromOlderEngine) */
export interface ColateDiPrima {
  /** the engine that made them */
  engine: number;
  /** how many pours the board has */
  count: number;
  /** the fact in words */
  detail: string;
}

const colateDiPrimaDi = (summary: unknown): ColateDiPrima | null => {
  const c = (summary as { poursFromOlderEngine?: Partial<ColateDiPrima> } | null | undefined)?.poursFromOlderEngine;
  return c && typeof c.count === "number" && c.count > 0
    ? { engine: Number(c.engine ?? 0), count: c.count, detail: String(c.detail ?? "") }
    : null;
};

/**
 * POURS THAT ONLY A COMPILE MAKES AGAIN.
 *
 * A recheck re-evaluates the board it is given: it takes out necks, cleans the
 * rings and, for a board that needs it, pours the planes again around the vias,
 * each from the shape it already has. It does not start again from the outlines
 * the files declare, and those shapes are an older engine's: pill pads held as
 * their bounding box, the staircases and lobes of tscircuit's own pour, pours
 * declared in comments or in components never used. Filed under today's
 * engine, such a board was exportable with those pours (review of the CAD-like
 * pours, 2026-11-11: an engine 6 board came out of a recheck under today's).
 *
 * So a board saved by an engine before ENGINE_COLATE_DAI_CONTORNI that has
 * pours keeps its engine through a recheck, and the export refuses it, both
 * saying that a compile ("Aggiorna") makes the pours again. A board with no
 * pours has nothing to make again: null, and it is lifted as before.
 */
export function colateDiUnMotoreDiPrima(circuitJson: unknown, engineVersion: number): ColateDiPrima | null {
  if (engineVersion >= ENGINE_COLATE_DAI_CONTORNI || !Array.isArray(circuitJson)) return null;
  const count = circuitJson.filter((el) => (el as { type?: unknown } | null)?.type === "pcb_copper_pour").length;
  if (count === 0) return null;
  return {
    engine: engineVersion,
    count,
    detail:
      `${count === 1 ? "la colata della scheda e' stata fatta" : `le ${count} colate della scheda sono state fatte`} ` +
      `dal motore ${engineVersion}, che non ripartiva dai contorni dichiarati nei file`,
  };
}

/**
 * Why such a board is not filed under today's engine and is not exported, in
 * the words the answer shows, with what to do about it; null when no plane
 * covers a via. The planes are poured again by a compile ("Aggiorna") and by a
 * recheck ("Ricontrolla") of a board in this state; when they come back over
 * the hole all the same, it is the via or the plane that has to move.
 *
 * The same words say why the export refuses a board for what it measures on
 * the board itself, each with its own way out: a trace or a pad in the copper
 * of another net's pour, two pours too close, pours of an older engine, an id
 * that two elements share.
 */
export function nonCertificata(summary: unknown): string | null {
  const p = pianiSuVieDi(summary);
  const c = colateVicineDi(summary);
  const perche: string[] = [];
  if (p) {
    perche.push(
      `${p.detail}. La scheda NON e' certificata per l'export finche' un piano copre una via: ` +
        `premi Aggiorna o Ricontrolla per rifare le colate, e se il piano resta sulla via sposta la via o il piano`,
    );
  }
  /*
   * And a board where a trace or a pad is in the copper of another net's pour:
   * the trace drawn across a pour and the part moved onto one, which the fast
   * update lays without pouring (see check 9 in drc.ts). Only a compile pours
   * around them: a recheck pours again for a plane over a via and for nothing
   * else, so "Ricontrolla" is not offered here.
   */
  const r = colateSuRameDi(summary);
  if (r) {
    perche.push(
      `${r.detail}. La scheda NON e' certificata per l'export finche' una colata copre il rame di un'altra rete: ` +
        `premi Aggiorna per rifare le colate, e se quel rame resta nella colata sposta lui o la colata`,
    );
  }
  if (c) {
    perche.push(
      `${c.detail}. La scheda NON e' certificata per l'export finche' due colate di reti diverse si toccano ` +
        `o stanno piu' vicine della loro distanza: correggi il contorno di una delle due (o la sua distanza) e premi Aggiorna`,
    );
  }
  const v = colateDiPrimaDi(summary);
  if (v) {
    perche.push(
      `${v.detail}. La scheda NON e' certificata per l'export finche' le colate non sono rifatte: ` +
        `premi Aggiorna per rifarle (Ricontrolla non le rifa')`,
    );
  }
  /*
   * And a board where two elements have the same id (duplicate-ids.ts): on
   * sbb-dl-principale, 12/11/2026, seven traces and seven vias of the board
   * before stayed next to the ones the files draw, one across a pad, and every
   * check was green. Saving such a board says it; here it does not go to the
   * factory. The export measures the board itself and passes what it finds.
   */
  const d = idDoppiDi(summary);
  if (d) {
    /*
     * What to do depends on where the board's copper comes from. A board drawn
     * in its files (design rules `autoroute: false`) is compiled from the files
     * alone, so "Aggiorna" takes the doubles away. Any other board carries the
     * copper of the saved board into the new one (carryCopper): a compile can
     * bring the doubles back, and a recheck or a move never clean them. Saying
     * "premi Aggiorna" there would promise what the compile does not do.
     */
    const daiFile = (summary as { copperFromFiles?: unknown } | null | undefined)?.copperFromFiles === true;
    perche.push(
      `${d.detail}. La scheda NON e' certificata per l'export finche' ha elementi in doppio: ` +
        (daiFile
          ? `premi Aggiorna per ricompilarla dai file`
          : `questa scheda riporta il rame della scheda salvata, quindi Aggiorna puo' non toglierli, e Ricontrolla e Sposta non li tolgono mai: ` +
            `va ripulito il rame salvato prima di esportare`),
    );
  }
  /*
   * And a board with open connections (aperti-export.ts): a pad of ground or of a supply left out of its copper is
   * a board that does not work. The export let it through; Niccolo', 2026-11-12: "blocco". Measured on the board
   * about to go, from the copper, and passed here by the export.
   */
  const ap = (summary as { openConnections?: { detail?: unknown } | null } | null | undefined)?.openConnections;
  if (ap && typeof ap.detail === "string" && ap.detail) {
    perche.push(
      `${ap.detail}. La scheda NON e' certificata per l'export finche' ha collegamenti aperti: ` +
        `chiudili (nel visore la vista "Collegamenti mancanti" li mostra) e riprova`,
    );
  }
  return perche.length > 0 ? perche.join(". ") : null;
}

/** what the summary says when two elements of the board have the same id (see idDoppi in duplicate-ids.ts) */
const idDoppiDi = (summary: unknown): { count: number; detail: string } | null => {
  const d = (summary as { duplicateIds?: { count?: unknown; detail?: unknown } | null } | null | undefined)?.duplicateIds;
  return d && typeof d.count === "number" && d.count > 0 ? { count: d.count, detail: String(d.detail ?? "") } : null;
};

/**
 * Two pours of different nets too close on one layer (CompileSummary.poursTooClose,
 * measured by pour-pour.ts). The export measures the board itself and refuses
 * it, like a plane over a via; the summary says why with the words above.
 */
const colateVicineDi = (summary: unknown): { count: number; detail: string } | null => {
  const c = (summary as { poursTooClose?: { count?: unknown; detail?: unknown } } | null | undefined)?.poursTooClose;
  return c && typeof c.count === "number" && c.count > 0 ? { count: c.count, detail: String(c.detail ?? "") } : null;
};
