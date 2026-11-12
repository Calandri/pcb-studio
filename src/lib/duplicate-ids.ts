/*
 * TWO ELEMENTS OF A BOARD WITH THE SAME ID.
 *
 * Every element of a board has an id of its own within its type (pcb_trace_id,
 * pcb_via_id, pcb_smtpad_id...): tscircuit numbers them as it reads the files.
 * Two with the same one means something is on the board twice. On
 * sbb-dl-principale (12/11/2026) the board saved at 12:02:14 had 7 traces and
 * 7 vias of the board before next to the ones the files draw, each with the id
 * of a new one (pcb_trace_0, _1, _3, _4, _17, _18, _85): a compile had carried
 * the old copper over, one trace ran across a pad of U9, and nothing said so.
 * That road is closed (see compileProject), and this is what would have said
 * it on any other road: a board with a doubled id is never saved in silence.
 */

/** the facts about the doubled ids of a board, as the summary carries its other warnings */
export interface IdDoppi {
  /** how many elements have the id of an earlier element of their type */
  count: number;
  /** the fact in words, with the first of them by type and id */
  detail: string;
}

/** how the warning begins in the message of a summary: said once, however many times the board is saved */
export const AVVISO_ID_DOPPI = "ATTENZIONE id doppi:";

/** how many ids are named for each type before "e altri N" */
const ESEMPI = 4;

/**
 * The elements of the board (`pcb_*`) that have the id of an earlier element
 * of their type. Errors and warnings are not elements of the board, and what
 * has no id of its type is not counted. Null on a board with none.
 */
export function idDoppi(circuitJson: unknown[]): IdDoppi | null {
  const visti = new Map<string, Set<string>>();
  const doppi = new Map<string, string[]>();
  for (const e of circuitJson) {
    if (!e || typeof e !== "object") continue;
    const el = e as Record<string, unknown>;
    const tipo = typeof el.type === "string" ? el.type : "";
    if (!tipo.startsWith("pcb_") || tipo.endsWith("_error") || tipo.endsWith("_warning")) continue;
    const id = el[`${tipo}_id`];
    if (typeof id !== "string" || id === "") continue;
    let delTipo = visti.get(tipo);
    if (!delTipo) visti.set(tipo, (delTipo = new Set()));
    if (delTipo.has(id)) doppi.set(tipo, [...(doppi.get(tipo) ?? []), id]);
    else delTipo.add(id);
  }
  if (doppi.size === 0) return null;
  const count = [...doppi.values()].reduce((n, ids) => n + ids.length, 0);
  const elenco = [...doppi]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([tipo, ids]) => {
      const diversi = [...new Set(ids)];
      const altri = diversi.length - ESEMPI;
      return `${ids.length} ${tipo} (${diversi.slice(0, ESEMPI).join(", ")}${altri > 0 ? ` e altri ${altri}` : ""})`;
    })
    .join(", ");
  return {
    count,
    detail:
      `${count} ${count === 1 ? "elemento della scheda ha" : "elementi della scheda hanno"} l'id di un altro dello stesso tipo: ${elenco}. ` +
      "Sulla scheda c'e' qualcosa in doppio, di solito rame di una scheda precedente rimasto accanto a quello dei file: " +
      "guardala prima di esportarla, e ricompilala",
  };
}

/**
 * Says it in the message of the summary saved with the board, where the page,
 * inspect_board and the answer of a compile read first. In place, like the
 * other notes a summary gets before it is saved (see conIlPerche), and once.
 */
export function avvisaDegliIdDoppi(summary: unknown, doppi: IdDoppi): void {
  if (!summary || typeof summary !== "object") return;
  const s = summary as { message?: unknown };
  const message = typeof s.message === "string" ? s.message : "";
  if (message.includes(AVVISO_ID_DOPPI)) return;
  s.message = `${message}${message ? " " : ""}${AVVISO_ID_DOPPI} ${doppi.detail}.`;
}
