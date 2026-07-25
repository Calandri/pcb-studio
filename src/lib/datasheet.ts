import { extractText, getDocumentProxy } from "unpdf";

/** Oltre questa soglia il testo viene troncato: un datasheet intero non entra nel contesto. */
const MAX_TEXT_CHARS = 120_000;

export interface ExtractedDatasheet {
  text: string;
  pages: number;
  truncated: boolean;
}

/** Estrae il testo da un PDF (upload o URL). I PDF sono input non fidato. */
export async function extractDatasheetText(
  data: ArrayBuffer,
): Promise<ExtractedDatasheet> {
  const pdf = await getDocumentProxy(new Uint8Array(data));
  const { text, totalPages } = await extractText(pdf, { mergePages: true });
  const full = Array.isArray(text) ? text.join("\n") : text;
  return {
    text: full.slice(0, MAX_TEXT_CHARS),
    pages: totalPages,
    truncated: full.length > MAX_TEXT_CHARS,
  };
}

export async function fetchDatasheetFromUrl(
  url: string,
): Promise<ExtractedDatasheet & { title: string }> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("only http(s) URLs are supported");
  }
  const res = await fetch(parsed, {
    signal: AbortSignal.timeout(30_000),
    headers: { "User-Agent": "pcb-studio/1.0" },
  });
  if (!res.ok) throw new Error(`datasheet fetch failed: HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength > 30 * 1024 * 1024) throw new Error("datasheet too large (>30MB)");
  const extracted = await extractDatasheetText(buf);
  const title = decodeURIComponent(parsed.pathname.split("/").pop() || "datasheet.pdf");
  return { ...extracted, title };
}
