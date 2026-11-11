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
// of a board that has such a via
export const CHECKS_ENGINE_VERSION = 7;

/**
 * The first engine whose planes open around EVERY via, whatever layers it
 * lists. A board saved by an older one, with a via written on part of the
 * stack, has planes that were poured without seeing that hole: a recheck pours
 * them again (see ricolaSeLeVieEranoParziali).
 */
export const ENGINE_VIE_PASSANTI = 7;
