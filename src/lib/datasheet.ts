import { extractText, getDocumentProxy } from "unpdf";

/** Past this threshold the text is truncated: a whole datasheet does not fit in the context. */
const MAX_TEXT_CHARS = 120_000;

export interface ExtractedDatasheet {
  text: string;
  pages: number;
  truncated: boolean;
}

/** Extracts text from a PDF (upload or URL). PDFs are untrusted input. */
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

/**
 * Hosts nobody is allowed to fetch from, whatever the URL says.
 *
 * Until now a person typed the address and the risk was theirs. From the moment
 * the addresses come out of a FILE SOMEONE UPLOADED — an Altium board carries a
 * datasheet link on every component — the fetch becomes a request our server
 * makes on a stranger's behalf, and "http://169.254.169.254/latest/meta-data/"
 * is a URL like any other: it is the cloud metadata service, and it answers with
 * credentials. Same for anything on localhost or on the private network, which
 * from inside a datacentre means the neighbours.
 *
 * So: only public addresses. The check is on the resolved IP, not on the name,
 * because a name can point wherever it likes.
 */
function isPrivateAddress(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  if (h === "::1" || h === "0.0.0.0") return true;
  // IPv6 unique-local and link-local
  if (/^f[cd][0-9a-f]{2}:/i.test(h) || /^fe80:/i.test(h)) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!v4) return false;
  const [a, b, c] = [Number(v4[1]), Number(v4[2]), Number(v4[3])];
  void c;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local: the metadata service
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  return false;
}

async function assertPublicHost(hostname: string): Promise<void> {
  if (isPrivateAddress(hostname)) {
    throw new Error(`indirizzo non consentito: ${hostname}`);
  }
  /*
   * The NAME can be public and its ADDRESS private: it is the classic way round
   * a check made on the string. So the name is resolved and the addresses are
   * checked one by one.
   */
  try {
    const { lookup } = await import("node:dns/promises");
    const indirizzi = await lookup(hostname, { all: true });
    for (const { address } of indirizzi) {
      if (isPrivateAddress(address)) {
        throw new Error(`${hostname} punta a un indirizzo privato (${address})`);
      }
    }
  } catch (err) {
    // a name that does not resolve is not a security problem: the fetch will fail
    if (err instanceof Error && err.message.includes("indirizzo privato")) throw err;
  }
}

export async function fetchDatasheetFromUrl(
  url: string,
): Promise<ExtractedDatasheet & { title: string }> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("only http(s) URLs are supported");
  }
  await assertPublicHost(parsed.hostname);
  const res = await fetch(parsed, {
    signal: AbortSignal.timeout(30_000),
    headers: { "User-Agent": "pcb-studio/1.0" },
    // a redirect can land where the check would have refused: they are followed
    // by hand, one at a time, checking each hop
    redirect: "manual",
  });
  const finale = await seguiRedirect(res, parsed);
  if (!finale.ok) throw new Error(`datasheet fetch failed: HTTP ${finale.status}`);
  const buf = await finale.arrayBuffer();
  if (buf.byteLength > 30 * 1024 * 1024) throw new Error("datasheet too large (>30MB)");
  const extracted = await extractDatasheetText(buf);
  const title = decodeURIComponent(parsed.pathname.split("/").pop() || "datasheet.pdf");
  return { ...extracted, title };
}

/** follows up to five redirects, checking the destination of each one */
async function seguiRedirect(res: Response, from: URL, giri = 5): Promise<Response> {
  let corrente = res;
  let base = from;
  for (let i = 0; i < giri; i++) {
    if (corrente.status < 300 || corrente.status >= 400) return corrente;
    const dove = corrente.headers.get("location");
    if (!dove) return corrente;
    const prossima = new URL(dove, base);
    if (prossima.protocol !== "https:" && prossima.protocol !== "http:") {
      throw new Error("redirect verso un protocollo non consentito");
    }
    await assertPublicHost(prossima.hostname);
    base = prossima;
    corrente = await fetch(prossima, {
      signal: AbortSignal.timeout(30_000),
      headers: { "User-Agent": "pcb-studio/1.0" },
      redirect: "manual",
    });
  }
  throw new Error("troppi redirect");
}
