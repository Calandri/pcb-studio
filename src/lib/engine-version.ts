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
export const CHECKS_ENGINE_VERSION = 3;
