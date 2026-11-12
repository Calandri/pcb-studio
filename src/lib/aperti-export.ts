import { collegamentiAperti } from "./open-connections";

/*
 * A BOARD WITH OPEN CONNECTIONS DOES NOT GO TO THE FACTORY.
 *
 * The export let it through: the open connections were a strong warning in the
 * panel and no more. Niccolo', 2026-11-12, asked whether the export should
 * warn or stop: "blocco". Gerber and pick and place stop, saying how many
 * connections are open, on how many nets, and which pads are left out; the
 * parts list does not depend on the copper and goes.
 *
 * Measured on the board about to go, from the copper itself
 * (open-connections.ts), like a plane over a via or a doubled id: the summary
 * saved with the board is not asked. Its own count took a net with a pour as
 * joined without looking whether the pad touches the pour, and a ground pad
 * left out of its plane read "0 aperti".
 */

/** what nonCertificata reads (engine-version.ts): how many, on how many nets, and the fact in words */
export interface ApertiAllExport {
  /** how many segments are missing; 0 only when they could not be measured */
  count: number;
  /** how many nets have at least one */
  reti: number;
  detail: string;
}

/** how many nets are named before "e altre N reti", and how many pads of a net before "e altri N" */
const RETI_NOMINATE = 4;
const PIEDINI_NOMINATI = 3;

/**
 * The open connections of the board about to be exported, in the words the
 * refusal shows: "3 collegamenti aperti su 2 reti: GND (D17.A), P3V3_SD
 * (R16.2)". Null when nothing is open. A board that cannot be measured is not
 * "nothing open": it comes back as not measured, and the export refuses it.
 */
export function apertiDellaSchedaCheEsce(circuitJson: unknown[]): ApertiAllExport | null {
  let aperti: ReturnType<typeof collegamentiAperti>;
  try {
    aperti = collegamentiAperti(circuitJson);
  } catch (err) {
    const perche = err instanceof Error ? err.message : String(err);
    return { count: 0, reti: 0, detail: `i collegamenti aperti di questa scheda non si sono potuti misurare (${perche})` };
  }
  if (aperti.nonCalcolati) {
    return { count: 0, reti: 0, detail: `i collegamenti aperti di questa scheda non si sono potuti misurare (${aperti.nonCalcolati})` };
  }
  const n = aperti.collegamenti.length;
  if (n === 0) return null;

  // net by net: its name, or its two pads when it has none, and the pads left out
  const perRete = new Map<string, { nome: string; fuori: string[]; tratti: number }>();
  for (const c of aperti.collegamenti) {
    const voce = perRete.get(c.rete) ?? { nome: c.nome || `${c.da.piedino} - ${c.a.piedino}`, fuori: [], tratti: 0 };
    voce.tratti += 1;
    if (!voce.fuori.includes(c.da.piedino)) voce.fuori.push(c.da.piedino);
    perRete.set(c.rete, voce);
  }
  // the nets with more open segments first; with as many, by name, so the sentence is the same for the same board
  const reti = [...perRete.values()].sort((a, b) => b.tratti - a.tratti || a.nome.localeCompare(b.nome));
  const nominate = reti.slice(0, RETI_NOMINATE).map((r) => {
    const altri = r.fuori.length - PIEDINI_NOMINATI;
    const piedini = r.fuori.slice(0, PIEDINI_NOMINATI).join(", ") + (altri > 0 ? ` e ${altri === 1 ? "un altro" : `altri ${altri}`}` : "");
    return `${r.nome} (${piedini})`;
  });
  const altre = reti.length - RETI_NOMINATE;
  const coda = altre > 0 ? ` e ${altre === 1 ? "un'altra rete" : `altre ${altre} reti`}` : "";
  return {
    count: n,
    reti: reti.length,
    detail:
      `${n} ${n === 1 ? "collegamento aperto" : "collegamenti aperti"} su ${reti.length} ${reti.length === 1 ? "rete" : "reti"}: ` +
      `${nominate.join(", ")}${coda}`,
  };
}
