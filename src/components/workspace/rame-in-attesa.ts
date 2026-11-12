import { percorsoDellaPista, stessoPercorso } from "@/lib/manual-routes";
import type { SalvataggioDelGesto } from "@/lib/spinta/gesto-tipi";

/*
 * A copper gesture let go in "Sposta" stays on screen until the saved board
 * shows it, like a dropped part (settledMoves, boardAgrees): here is what
 * "shows it" means for copper. Pure, so it can be tested without a page.
 */

/** as close as a part's origin has to be for a board to show its move (boardAgrees) */
const STESSO_POSTO_MM = 0.002;

/**
 * The board shows what a gesture asked to be saved: every moved via is where
 * it was put, and every path the gesture wrote (a correction of the files'
 * copper, a hand route rewritten) is the path of a trace of the board, compared
 * as the corrections themselves are (stessoPercorso). A route with no points
 * only takes copper out, and asks nothing of the board.
 */
export function schedaMostraIlRame(circuitJson: readonly unknown[], salvataggio: SalvataggioDelGesto): boolean {
  const percorsi = [...salvataggio.routes, ...salvataggio.riscritte].map((r) => r.points).filter((p) => p.length > 1);
  const vie = salvataggio.vias.map((v) => v.to);
  const percorsiVisti = new Set<number>();
  const vieViste = new Set<number>();
  for (const el of circuitJson as Array<Record<string, unknown> | null>) {
    if (percorsiVisti.size === percorsi.length && vieViste.size === vie.length) break;
    if (el?.type === "pcb_trace" && percorsiVisti.size < percorsi.length) {
      const suo = percorsoDellaPista(el);
      for (const [i, p] of percorsi.entries()) if (!percorsiVisti.has(i) && stessoPercorso(suo, p)) percorsiVisti.add(i);
    } else if (el?.type === "pcb_via" && typeof el.x === "number" && typeof el.y === "number") {
      for (const [i, v] of vie.entries()) {
        if (Math.abs(el.x - v.x) <= STESSO_POSTO_MM && Math.abs(el.y - v.y) <= STESSO_POSTO_MM) vieViste.add(i);
      }
    }
  }
  return percorsiVisti.size === percorsi.length && vieViste.size === vie.length;
}
