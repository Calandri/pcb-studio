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
async function datasheetDaLcsc(mpn: string): Promise<string | null> {
  try {
    const ricerca = new URL("https://jlcsearch.tscircuit.com/api/search");
    ricerca.searchParams.set("q", mpn);
    ricerca.searchParams.set("limit", "1");
    const res = await fetch(ricerca, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const dati = (await res.json()) as { components?: Array<{ lcsc?: number; mfr?: string }> };
    const primo = dati.components?.[0];
    // the code must be the SAME part, not something that looks like it
    if (!primo?.lcsc || String(primo.mfr ?? "").toUpperCase() !== mpn.toUpperCase()) return null;

    const pagina = await fetch(`https://www.lcsc.com/product-detail/C${primo.lcsc}.html`, {
      signal: AbortSignal.timeout(15_000),
      headers: { "User-Agent": "pcb-studio/1.0" },
    });
    if (!pagina.ok) return null;
    const html = await pagina.text();
    const m = /https:\/\/datasheet\.lcsc\.com\/[^"' ]+\.pdf/i.exec(html);
    return m ? m[0] : null;
  } catch {
    return null;
  }
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
  /** one entry per PART, not per component */
  const perMpn = new Map<string, { url: string; titolo: string }>();
  for (const [designator, id] of identita) {
    if (!id.datasheetUrl) continue;
    const mpn = (id.mpn ?? "").trim();
    if (!mpn) continue;
    if (perMpn.has(mpn)) continue;
    perMpn.set(mpn, {
      url: id.datasheetUrl,
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
  for (const [mpn, { url, titolo }] of daFare) {
    onProgress?.(fatti++, daFare.length, mpn);
    let usato = url;
    try {
      let pdf: Awaited<ReturnType<typeof fetchDatasheetFromUrl>>;
      try {
        pdf = await fetchDatasheetFromUrl(url);
      } catch (primoErrore) {
        // the link in the file is dead: the part is looked up by code
        const ripiego = await datasheetDaLcsc(mpn);
        if (!ripiego) throw primoErrore;
        usato = ripiego;
        pdf = await fetchDatasheetFromUrl(ripiego);
        out.da_lcsc++;
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
