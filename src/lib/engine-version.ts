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
// in the fab class, and the export goes on; tscircuit's pcb_courtyard_overlap_error of such a pair is not counted a
// second time. Warnings: parts whose footprint is their pads alone, parts in a connector's mating space, outlines and
// designators written as board drawings. On sbb-dl-principale 26 pairs had pads under 0.30 mm with every check green.
// And the distance from a segment to a rectangle is taken side against side (it was taken from the corners only, and a
// short segment running along a pad, its ends in front of the side, came out as far as the corners): trace against pad,
// silkscreen against pad, a pill pad against a rect pad and the board edge measure true.
// Copper and pours do not change: a board of engine 10 comes to 11 with a recheck ("Ricontrolla"), no compile
export const CHECKS_ENGINE_VERSION = 11;

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
  return perche.length > 0 ? perche.join(". ") : null;
}

/**
 * Two pours of different nets too close on one layer (CompileSummary.poursTooClose,
 * measured by pour-pour.ts). The export measures the board itself and refuses
 * it, like a plane over a via; the summary says why with the words above.
 */
const colateVicineDi = (summary: unknown): { count: number; detail: string } | null => {
  const c = (summary as { poursTooClose?: { count?: unknown; detail?: unknown } } | null | undefined)?.poursTooClose;
  return c && typeof c.count === "number" && c.count > 0 ? { count: c.count, detail: String(c.detail ?? "") } : null;
};
