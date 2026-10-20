/**
 * SILKSCREEN THAT PRINTS.
 *
 * circuit-json-to-gerber draws every silkscreen letter with a pen one eighth of
 * the font size wide. Measured on BAT_BS on 2026-10-20: designators at 0.559 mm
 * came out with a 0.070 mm stroke, the version label with 0.095 mm, and the
 * Altium outlines of seven parts had 0.10 mm lines. A silkscreen printer does
 * not draw that: JLCPCB states 0.153 mm as its minimum line, PCBWay 0.15 mm, and
 * below it the ink breaks up or is left out. The board looks labelled on screen
 * and arrives blank, with no warning anywhere.
 *
 * So every round pen of the silkscreen layers that is thinner than the minimum
 * is widened to the minimum, in the Gerber that goes to the factory. Only the
 * pen changes: the strokes keep their path, so a letter stays where it was and
 * only gets the ink it needed. Pens already at or above the minimum, and every
 * other layer, are left exactly as they were.
 *
 * 0.15 mm is the 6 mil every fab accepts, and the width most of the imported
 * boards already use for their outlines.
 */
export const SERIGRAFIA_TRATTO_MINIMO_MM = 0.15;

/** the legend layers, as circuit-json-to-gerber names them */
const SERIGRAFIA = /silkscreen/i;

/** a round aperture definition: %ADD<n>C,<diameter>[X<hole>]*% */
const APERTURA_TONDA = /%ADD(\d+)C,([0-9]*\.?[0-9]+)((?:X[0-9]*\.?[0-9]+)?)\*%/g;

export function serigrafiaStampabile<T extends Record<string, unknown>>(
  layers: T,
  minimoMm: number = SERIGRAFIA_TRATTO_MINIMO_MM,
): { layers: T; allargate: number } {
  const minimo = Number.isFinite(minimoMm) && minimoMm > 0 ? minimoMm : SERIGRAFIA_TRATTO_MINIMO_MM;
  let allargate = 0;
  const out: Record<string, unknown> = {};
  for (const [nome, contenuto] of Object.entries(layers)) {
    if (!SERIGRAFIA.test(nome) || typeof contenuto !== "string") {
      out[nome] = contenuto;
      continue;
    }
    out[nome] = contenuto.replace(APERTURA_TONDA, (intera, n: string, diametro: string, foro: string) => {
      const d = Number(diametro);
      if (!Number.isFinite(d) || d >= minimo - 1e-9) return intera;
      allargate++;
      return `%ADD${n}C,${minimo.toFixed(6)}${foro}*%`;
    });
  }
  return { layers: out as T, allargate };
}
