import type { ComponentIdentity } from "./circuit-json-to-project";
import { fetchDatasheetFromUrl } from "./datasheet";
import { datasheetMpns, saveDatasheet } from "./library-store";

/**
 * The datasheets of an imported board, taken from the links the file itself
 * carries.
 *
 * An Altium board records, on every component, the link to its datasheet: the
 * one whoever designed the board chose, not one guessed from a search. On
 * BAT_BS that is 72 components out of 98. So there is nothing to search for and
 * no external service to ask: there is a list of addresses to fetch.
 *
 * Two things make it worth automating instead of leaving it to whoever imports:
 *
 * - it is by PART, not by component: the seventeen identical capacitors of a
 *   board share one datasheet, and downloading it seventeen times would be
 *   seventeen times the wait and seventeen copies of the same text for the model
 *   to read. On BAT_BS the 98 components are 31 distinct part numbers;
 *
 * - it happens once, at import: from then on the agent that has to place a part
 *   or check a pinout finds the pages already there, instead of asking the
 *   person to go and fetch a PDF.
 *
 * The addresses come from a file someone uploaded, so they go through the
 * fetch's own protection (datasheet.ts): no private addresses, no unchecked
 * redirects. A board is untrusted input like any other.
 */

/**
 * The datasheet of a part, when the link in the file is dead.
 *
 * Measured on BAT_BS: 19 of the 21 links in the file answer 404. They were
 * written in 2024, and manufacturers move their PDFs — Murata, TDK and Yageo all
 * did. A link that no longer works is worth as much as no link.
 *
 * So the part is looked up by CODE, which does not go stale: jlcsearch turns a
 * manufacturer code into an LCSC code, and LCSC keeps a copy of the datasheet on
 * its own servers. Same source the app already uses for stock and prices.
 */
/**
 * A supplier code as LCSC writes it, from whatever the search answered.
 *
 * The answer is somebody else's JSON and the code ends up INSIDE main.tsx, as a
 * prop: a positive integer, and nothing else, becomes `C<number>`.
 */
export function codiceLcsc(valore: unknown): string | null {
  const testo = typeof valore === "number" ? String(valore) : typeof valore === "string" ? valore.trim() : "";
  const m = /^C?(\d{1,12})$/i.exec(testo);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? `C${n}` : null;
}

/** a part code reduced to what identifies it: upper case, letters and digits */
const normalizza = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, "");

/**
 * WHICH SEARCH RESULT IS THE PART, if any.
 *
 * Only the SAME code counts as the part: equal once punctuation and case are
 * gone ("SPH0641LU4H-1" and "SPH0641LU4H1" are the same string). A result that
 * merely starts with the code — "LM358D" for "LM358", "SPH0641LU4H-1" for
 * "SPH0641LU4H" — is a RELATIVE: often the same die in another package, often
 * not. It is returned as approximate, so that it can lend its datasheet (a
 * family datasheet is better than none, and it is labelled) but never its order
 * code, which would put a different part on the bill of materials with full
 * confidence. The old rule accepted any two extra characters as the same part.
 */
export function sceltaLcsc(
  mpn: string,
  risultati: Array<{ lcsc?: unknown; mfr?: unknown }>,
): { codice: string; mfr: string; approssimato: boolean } | null {
  const cercato = normalizza(mpn);
  if (!cercato) return null;
  let parente: { codice: string; mfr: string; approssimato: boolean } | null = null;
  for (const c of risultati) {
    const codice = codiceLcsc(c?.lcsc);
    const mfr = String(c?.mfr ?? "");
    const suo = normalizza(mfr);
    if (!codice || !suo) continue;
    if (suo === cercato) return { codice, mfr, approssimato: false };
    const lungo = suo.length > cercato.length ? suo : cercato;
    const corto = suo.length > cercato.length ? cercato : suo;
    if (!parente && corto.length >= 4 && lungo.startsWith(corto) && lungo.length - corto.length <= 2) {
      parente = { codice, mfr, approssimato: true };
    }
  }
  return parente;
}

async function cercaSuLcsc(
  mpn: string,
): Promise<{ codice: string; mfr: string; approssimato: boolean; datasheet: string | null } | null> {
  try {
    const ricerca = new URL("https://jlcsearch.tscircuit.com/api/search");
    ricerca.searchParams.set("q", mpn);
    /*
     * Piu' di un risultato, e si sceglie: cercando "ABS07-120-32.768KHZ-T" il
     * primo risultato e' "ABS07-32.768KHZ-T", che e' un altro quarzo, e quello
     * giusto e' il secondo. Prendere il primo e basta significava scartare la
     * parte che c'era.
     */
    ricerca.searchParams.set("limit", "8");
    const res = await fetch(ricerca, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const dati = (await res.json()) as { components?: unknown };
    const scelta = sceltaLcsc(
      mpn,
      Array.isArray(dati?.components) ? (dati.components as Array<{ lcsc?: unknown; mfr?: unknown }>) : [],
    );
    if (!scelta) return null;
    const { codice } = scelta;

    const pagina = await fetch(`https://www.lcsc.com/product-detail/${codice}.html`, {
      signal: AbortSignal.timeout(15_000),
      headers: { "User-Agent": "pcb-studio/1.0" },
    });
    if (!pagina.ok) return { ...scelta, datasheet: null };
    const html = await pagina.text();
    const m = /https:\/\/datasheet\.lcsc\.com\/[^"' <>\\]+\.pdf/i.exec(html);
    return { ...scelta, datasheet: m ? m[0] : null };
  } catch {
    return null;
  }
}

/**
 * THE ORDER CODE OF EVERY PART.
 *
 * An imported board arrives with the manufacturer part numbers its designer
 * wrote and with no supplier code, and a bill of materials without one cannot be
 * ordered: every row of BAT_BS said "NON ORDINABILE" while the search that finds
 * the code was already being run, for the datasheet, and the code thrown away.
 *
 * One search per distinct part, six at a time, and only for parts that have a
 * manufacturer number to search by. Whoever does not match exactly (see
 * sceltaLcsc) keeps no code at all rather than somebody else's, and is listed
 * in `approssimati` so the import can say which parts need a person.
 *
 * `codici` is keyed by the designator AS THE FILE WRITES IT, like `identita`;
 * the caller translates to the names main.tsx uses.
 */
export async function codiciLcsc(
  identita: Map<string, ComponentIdentity>,
  onProgress?: (fatti: number, totale: number, mpn: string) => void,
): Promise<{ codici: Map<string, string>; approssimati: Array<{ mpn: string; trovato: string }> }> {
  const perMpn = new Map<string, string[]>();
  for (const [designator, id] of identita) {
    const mpn = (id.mpn ?? "").trim();
    if (!mpn) continue;
    perMpn.set(mpn, [...(perMpn.get(mpn) ?? []), designator]);
  }
  const lista = [...perMpn];
  const out = new Map<string, string>();
  const approssimati: Array<{ mpn: string; trovato: string }> = [];
  let fatti = 0;
  const PARALLELE = 6;
  for (let i = 0; i < lista.length; i += PARALLELE) {
    const gruppo = lista.slice(i, i + PARALLELE);
    await Promise.all(
      gruppo.map(async ([mpn, designators]) => {
        onProgress?.(fatti++, lista.length, mpn);
        const trovato = await cercaSuLcsc(mpn).catch(() => null);
        if (!trovato) return;
        if (trovato.approssimato) {
          approssimati.push({ mpn, trovato: trovato.mfr });
          return;
        }
        for (const d of designators) out.set(d, trovato.codice);
      }),
    );
  }
  return { codici: out, approssimati };
}

export interface DatasheetImportResult {
  /** how many distinct parts had a link */
  candidati: number;
  scaricati: number;
  /** already in the project: nothing was downloaded again */
  gia_presenti: number;
  falliti: Array<{ mpn: string; url: string; errore: string }>;
  /** total pages read, to say what actually came in */
  pagine: number;
  /** recovered from LCSC because the link in the file was dead */
  da_lcsc: number;
}

/**
 * Downloads and stores what is missing. It never throws: a datasheet that does
 * not arrive is a line in the report, not a failed import — the board is already
 * in and it is worth more than its PDFs.
 */
export async function importDatasheetsForIdentities({
  projectId,
  identita,
  massimo = 60,
  onProgress,
}: {
  projectId: string;
  identita: Map<string, ComponentIdentity>;
  /** ceiling on the downloads, so an import cannot turn into an hour of fetching */
  massimo?: number;
  onProgress?: (fatti: number, totale: number, mpn: string) => void;
}): Promise<DatasheetImportResult> {
  /**
   * Una voce per PARTE, non per componente.
   *
   * Anche le parti SENZA link nel file: prima venivano saltate, e per quelle il
   * ripiego su LCSC non partiva nemmeno. Sono le due che contano di piu' su
   * questa scheda, il microcontrollore e il microfono, che il codice ce l'hanno
   * e il link no.
   */
  const perMpn = new Map<string, { url: string; titolo: string }>();
  for (const [designator, id] of identita) {
    const mpn = (id.mpn ?? "").trim();
    if (!mpn) continue;
    if (perMpn.has(mpn)) continue;
    perMpn.set(mpn, {
      url: id.datasheetUrl ?? "",
      titolo: [mpn, id.produttore, id.descrizione].filter(Boolean).join(" - ").slice(0, 200) ||
        designator,
    });
  }

  const gia = await datasheetMpns(projectId).catch(() => new Set<string>());
  const daFare = [...perMpn].filter(([mpn]) => !gia.has(mpn)).slice(0, massimo);

  const out: DatasheetImportResult = {
    candidati: perMpn.size,
    scaricati: 0,
    gia_presenti: perMpn.size - daFare.length,
    falliti: [],
    pagine: 0,
    da_lcsc: 0,
  };

  let fatti = 0;
  for (const [mpn, voce] of daFare) {
    const { url } = voce;
    let { titolo } = voce;
    onProgress?.(fatti++, daFare.length, mpn);
    let usato = url;
    try {
      let pdf: Awaited<ReturnType<typeof fetchDatasheetFromUrl>>;
      try {
        if (!url) throw new Error("nessun link nel file");
        pdf = await fetchDatasheetFromUrl(url);
      } catch (primoErrore) {
        // the link in the file is dead: the part is looked up by code
        const lcsc = await cercaSuLcsc(mpn);
        const ripiego = lcsc?.datasheet;
        if (!ripiego) throw primoErrore;
        usato = ripiego;
        pdf = await fetchDatasheetFromUrl(ripiego);
        out.da_lcsc++;
        /*
         * A relative's datasheet is labelled as such: whoever reads it later
         * (a person or the agent) must know it was found by resemblance.
         */
        if (lcsc?.approssimato) {
          titolo = `${titolo} (datasheet di ${lcsc.mfr}, trovato per somiglianza: da verificare)`.slice(0, 260);
        }
      }
      await saveDatasheet({
        projectId,
        title: titolo || pdf.title,
        sourceUrl: usato,
        text: pdf.text,
        pages: pdf.pages,
        mpn,
      });
      out.scaricati++;
      out.pagine += pdf.pages;
    } catch (err) {
      out.falliti.push({
        mpn,
        url: usato,
        errore: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}
