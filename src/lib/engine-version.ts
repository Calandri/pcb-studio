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
export const CHECKS_ENGINE_VERSION = 5;
