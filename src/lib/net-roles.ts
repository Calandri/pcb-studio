/**
 * WHAT A NET IS FOR: ground, a supply rail, or a signal.
 *
 * Three modules used to answer this question and all three answered it
 * differently. The electrical checks wanted the name to be exactly `GND`; the
 * ERC accepted `GND` followed by a word boundary; the placer took anything
 * starting with a `v`. So the same board was a board with a ground for the
 * placer and a board without one for the checks.
 *
 * It matters because a name is rarely bare. A real board carries `GND_2`,
 * `P3V3_MCU`, `VBAT_2`, `P3V3_SD_LDO` — and the import itself adds a suffix
 * when a net has the same name as a component (BAT_BS has a test point called
 * `GND`, so its ground net had to become `GND_2`). Measured on that board:
 * ZERO of its 71 nets were recognised as ground or supply, so the electrical
 * check reported a clean board without having looked at it. With the names read
 * properly it reports nineteen findings — eight connectors whose ground pad has
 * no return via nearby, eleven power traces below the minimum width.
 *
 * The rule is the one an engineer uses reading a netlist: the FIRST piece of
 * the name says what the net is, what follows says which one of them it is.
 * `P3V3_SD_LDO` is the 3.3V rail of the SD regulator; `GND_2` is ground.
 */

export type RuoloRete = "massa" | "potenza" | "segnale";

/**
 * The first piece of the name, uppercase: what the net IS. `P3V3_SD_LDO` ->
 * `P3V3`, `GND_2` -> `GND`, `NetC28_2` -> `NETC28`.
 */
const radiceDi = (nome: string): string => nome.trim().split(/[_\-\s]/)[0].toUpperCase();

/** ground, including the letter suffixes analog/digital designs use */
const MASSA = /^(GND|AGND|DGND|PGND|VSS|EARTH|GROUND)[A-Z0-9]*$|^0V$/;

/**
 * A supply: either a named rail, or a voltage written as a number. Both ways of
 * writing one are in the wild: `3V3`, `P3V3`, `+5V`, `1V8`, `12V`, `+3.3V`,
 * `V33`.
 */
const POTENZA = /^(VCC|VDD|VBAT|VIN|VOUT|VBUS|VSYS|VPP|VRAIL|VREF)[A-Z0-9+]*$/;
const TENSIONE = /^\+?P?(\d+(\.\d+)?V\d*|V\d+(V\d+)?)$/;

export function ruoloDiRete(nome: string | null | undefined): RuoloRete {
  if (!nome) return "segnale";
  const radice = radiceDi(nome);
  if (!radice) return "segnale";
  if (MASSA.test(radice)) return "massa";
  if (POTENZA.test(radice) || TENSIONE.test(radice)) return "potenza";
  return "segnale";
}

/** ground, by name */
export const eMassa = (nome: string | null | undefined): boolean =>
  ruoloDiRete(nome) === "massa";

/** a supply rail, by name */
export const ePotenza = (nome: string | null | undefined): boolean =>
  ruoloDiRete(nome) === "potenza";

/**
 * ground or supply: the nets that carry current rather than information, and
 * the ones a plane is poured for.
 */
export const eAlimentazione = (nome: string | null | undefined): boolean =>
  ruoloDiRete(nome) !== "segnale";
