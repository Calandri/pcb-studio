/**
 * What a part card says a component is, and where that sentence comes from.
 *
 * Three sources, in this order, and the card says which one it is showing:
 *  - "scritta nel progetto": the `description` written in the .tsx. It always
 *    wins: the person who wrote it knows what the part is;
 *  - "generata dal datasheet": the model's description (Descrivi da datasheet);
 *  - "dedotta dai collegamenti": the role guessed from the nets.
 * The generated one used to OVERWRITE the role and lead the card even when the
 * .tsx had a description: on sbb-dl-retro U2 (a SIMCom SIM7672G declared in
 * manufacturerPartNumber) read "tipo Quectel BG95" (2026-11-09). And never
 * "chip" on its own: that is the tscircuit element, not what the part is.
 */

export type FonteDescrizione = "progetto" | "datasheet" | "dedotta";

export const ETICHETTA_FONTE: Record<FonteDescrizione, string> = {
  progetto: "scritta nel progetto",
  datasheet: "generata dal datasheet",
  dedotta: "ruolo dedotto dai collegamenti",
};

export interface PezzoDaDescrivere {
  name: string;
  description: string | null;
  tags: string | null;
  role: string | null;
  why: string | null;
  mpn: string | null;
  value: string | null;
  /** the model's description, when one was generated */
  generated?: { role: string; why: string } | null;
}

export interface DescrizionePezzo {
  titolo: string;
  testo: string | null;
  fonte: FonteDescrizione | null;
  /** the value, or the manufacturer part number when there is no value */
  valore: string | null;
}

const soloChip = (s: string | null | undefined) => !s || /^\s*chip\s*$/i.test(s);

export function descriviPezzo(p: PezzoDaDescrivere): DescrizionePezzo {
  const valore = p.value || p.mpn || null;
  if (p.description) {
    return { titolo: p.tags || p.mpn || p.value || p.name, testo: p.description, fonte: "progetto", valore };
  }
  if (p.generated?.role) {
    return { titolo: p.generated.role, testo: p.generated.why || null, fonte: "datasheet", valore };
  }
  if (!soloChip(p.role)) {
    // "chip — alimentato da ..." says something, but not with that word in front
    const titolo = p.mpn ? p.role!.replace(/^\s*chip\b/i, p.mpn) : p.role!;
    return { titolo, testo: p.why || null, fonte: "dedotta", valore };
  }
  return { titolo: p.mpn || p.value || "senza descrizione nel progetto", testo: null, fonte: null, valore };
}

/** a long text is shown in 3 lines and opened with "altro": roughly 3 lines of a card */
export const LUNGHEZZA_TRE_RIGHE = 150;
