/*
 * WHAT "SPOSTA" MOVES ON THE BOARD: the parts, the traces or the vias, one
 * kind at a time, chosen in the bar.
 *
 * With all three at once the pointer had to guess: a part lies over the traces
 * that run under it and over the vias next to its pads, and a press meant for
 * a via dragged the part (sbb-dl-principale, 2026-11-13). With one kind chosen
 * only that kind takes the press, and the rest of the board is still.
 *
 * A canvas given no choice moves everything, as it did: the tests and the
 * callers that have no bar keep that.
 */
export type CosaSiSposta = "pezzi" | "piste" | "vie";

export const COSE_CHE_SI_SPOSTANO: ReadonlyArray<{ cosa: CosaSiSposta; nome: string; aiuto: string }> = [
  { cosa: "pezzi", nome: "componenti", aiuto: "Trascina un componente: R lo ruota, le frecce lo muovono di un passo. Piste e vie restano ferme" },
  { cosa: "piste", nome: "piste", aiuto: "Trascina un tratto dritto di pista: scorre di lato e le piste vicine si scostano. Componenti e vie restano fermi" },
  { cosa: "vie", nome: "vie", aiuto: "Trascina una via: le sue piste la seguono e le piste vicine si scostano. Componenti e tratti restano fermi" },
];

/** what the strip under the board says to do, for the kind chosen */
export const comeSiSposta = (cosa: CosaSiSposta | undefined): string =>
  cosa === "piste"
    ? "Trascina un tratto dritto di pista: scorre di lato. Esc annulla, Cmd+Z torna indietro."
    : cosa === "vie"
      ? "Trascina una via: le sue piste la seguono. Esc annulla, Cmd+Z torna indietro."
      : cosa === "pezzi"
        ? "Trascina un componente per spostarlo."
        : "Trascina un componente, una via o un tratto dritto di pista per spostarlo. Esc annulla, Cmd+Z torna indietro.";
