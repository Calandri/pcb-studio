import { fetchDatasheetFromUrl } from "./datasheet";
import { getDatasheetText, listDatasheets, saveDatasheet } from "./library-store";

/**
 * THE ERRATA OF A PART: the bugs the manufacturer admits to.
 *
 * A datasheet says what a chip should do; the errata says what it does instead.
 * For the microcontroller on this board that is thirty-eight pages and
 * eighty-one numbered defects, and reading them is a real step in designing
 * with the part — one that nobody does twice, and that everybody forgets
 * whether they did.
 *
 * THE ONE RULE: never an errata without its document. A model asked what the
 * errata of a chip are will produce a plausible list with revision numbers and
 * workarounds, and it will be invented — which is worse than knowing nothing,
 * because it reads exactly like knowledge. So the errata sheet is FOUND, its
 * URL and its bytes are kept, and the analysis quotes it. If no document
 * exists, that is the answer, and it is recorded as such.
 *
 * HOW IT IS FOUND, without a search engine and without guessing addresses:
 *
 *   1. From the datasheet the project ALREADY HAS. Manufacturers cite their own
 *      errata by document id: ST's STM32U5 datasheet says "refer to the
 *      STM32U59xxx and STM32U5Axxx errata sheet (ES0553)". Measured: of this
 *      board's 22 datasheets exactly one names an errata, and it is the right
 *      one.
 *   2. From the manufacturer's own documentation index, whose address is built
 *      from the part, and the errata links are read out of the page.
 *
 * When neither answers, the part has no published errata as far as we can see,
 * and that is what gets written. Two of this board's three chips are in that
 * case: AP Memory and Knowles do not publish errata at all — for them the
 * revision history at the end of the datasheet is the errata channel, and the
 * copy in the project being four years old is the finding.
 */

export interface DocumentoErrata {
  /** the document id the manufacturer uses, when it says one: ES0553 */
  codice: string | null;
  url: string;
  /** how it was found: it is what makes the answer checkable */
  come: "citato nel datasheet" | "indice del produttore";
}

export interface EsitoRicerca {
  trovato: DocumentoErrata | null;
  /** where it was looked for: an empty answer has to say where it looked */
  cercatoIn: string[];
  nota: string;
}

/** the errata document id a datasheet points at, when it points at one */
function codiceCitato(testo: string): string | null {
  const m =
    /errata\s+sheet\s*\(([A-Z]{2}\d{3,5})\)/i.exec(testo) ??
    /\b(ES\d{4})\b[^.]{0,60}errata/i.exec(testo) ??
    /errata[^.]{0,60}\b(ES\d{4})\b/i.exec(testo);
  return m ? m[1].toUpperCase() : null;
}

/**
 * The manufacturer's documentation page for a part, when we know how that
 * manufacturer builds its addresses. Nothing is guessed: a maker we have no
 * pattern for simply has no second channel.
 */
function indiceDelProduttore(mpn: string, produttore: string | null): string | null {
  const p = (produttore ?? "").toLowerCase();
  if (/stmicro|^st\b/.test(p) || /^stm32/i.test(mpn)) {
    const serie = /^stm32([a-z]\d)/i.exec(mpn)?.[1]?.toLowerCase();
    if (!serie) return null;
    return `https://www.st.com/en/microcontrollers-microprocessors/stm32${serie}-series/documentation.html`;
  }
  return null;
}

const LINK_ERRATA = /href="([^"]*errata[^"]*\.pdf)"/gi;

export async function cercaErrata(input: {
  projectId: string;
  mpn: string;
  produttore?: string | null;
}): Promise<EsitoRicerca> {
  const { projectId, mpn } = input;
  const cercatoIn: string[] = [];

  /*
   * THE TWO CHANNELS WORK TOGETHER, and neither is enough alone.
   *
   * The datasheet gives the document ID and not its address: ST's index holds
   * four errata sheets for one family of microcontrollers, and taking the first
   * one gave ES0499, which is the errata of another part (U575/U585) — right
   * shape, wrong chip, the worst kind of wrong. The id is what tells them apart.
   */
  let codice: string | null = null;
  const documenti = await listDatasheets(projectId).catch(() => []);
  for (const d of documenti) {
    if (!String(d.title ?? "").toUpperCase().includes(mpn.toUpperCase())) continue;
    cercatoIn.push(`datasheet in progetto (${d.title})`);
    const doc = await getDatasheetText(d.id, projectId).catch(() => null);
    codice = doc?.text ? codiceCitato(doc.text) : null;
    if (codice) break;
  }

  const indice = indiceDelProduttore(mpn, input.produttore ?? null);
  if (indice) {
    cercatoIn.push(indice);
    const html = await fetch(indice, { signal: AbortSignal.timeout(15_000) })
      .then((r) => (r.ok ? r.text() : ""))
      .catch(() => "");
    const link = [...new Set([...html.matchAll(LINK_ERRATA)].map((m) => m[1]))];
    if (link.length > 0) {
      const scelto = codice
        ? link.find((l) => l.toLowerCase().includes(codice!.toLowerCase()))
        : undefined;
      if (codice && !scelto) {
        return {
          trovato: null,
          cercatoIn,
          nota: `il datasheet cita ${codice} ma l'indice del produttore non lo elenca: ${link.length} altri errata, nessuno di questa parte`,
        };
      }
      /*
       * With no id there is no way to tell which of the family's errata belongs
       * to this part, and picking one would be a guess dressed as an answer.
       */
      if (!scelto) {
        return {
          trovato: null,
          cercatoIn,
          nota: `${link.length} errata sull'indice del produttore, ma il datasheet non dice quale sia di questa parte`,
        };
      }
      const url = scelto.startsWith("http") ? scelto : `https://www.st.com${scelto}`;
      return {
        trovato: { codice, url, come: "citato nel datasheet" },
        cercatoIn,
        nota: `il datasheet cita ${codice}, trovato sull'indice del produttore`,
      };
    }
  }

  return {
    trovato: null,
    cercatoIn,
    nota: codice
      ? `il datasheet cita ${codice} ma non si e' riusciti a raggiungere il documento`
      : cercatoIn.length
        ? "nessun documento di errata pubblicato che si riesca a raggiungere"
        : "non si sa dove cercare gli errata di questo produttore",
  };
}

/**
 * Downloads the errata sheet and keeps it beside the datasheets, so the
 * analysis that quotes it can be checked later against the same bytes.
 */
export async function scaricaErrata(input: {
  projectId: string;
  mpn: string;
  documento: DocumentoErrata;
}): Promise<{ pagine: number; caratteri: number; testo: string }> {
  const pdf = await fetchDatasheetFromUrl(input.documento.url);
  await saveDatasheet({
    projectId: input.projectId,
    title: `ERRATA ${input.documento.codice ?? ""} - ${input.mpn}`.trim(),
    sourceUrl: input.documento.url,
    text: pdf.text,
    pages: pdf.pages,
    mpn: input.mpn,
  });
  return { pagine: pdf.pages, caratteri: pdf.text.length, testo: pdf.text };
}
