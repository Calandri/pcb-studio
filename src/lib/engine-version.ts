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
export const CHECKS_ENGINE_VERSION = 8;

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
 */
export function motoreDaSalvare(summary: unknown, precedente: number = CHECKS_ENGINE_VERSION): number {
  if (!pianiSuVieDi(summary)) return CHECKS_ENGINE_VERSION;
  return Math.min(precedente, ENGINE_VIE_PASSANTI - 1);
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
  if (!p) return null;
  return (
    `${p.detail}. La scheda NON e' certificata per l'export finche' un piano copre una via: ` +
    `premi Aggiorna o Ricontrolla per rifare le colate, e se il piano resta sulla via sposta la via o il piano`
  );
}
