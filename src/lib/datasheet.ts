import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
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
const BLOCKED = (() => {
  const list = new BlockList();
  for (const [net, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10], // carrier-grade NAT
    ["127.0.0.0", 8],
    ["169.254.0.0", 16], // link-local: the metadata service
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4], // multicast
    ["240.0.0.0", 4],
  ] as const) {
    list.addSubnet(net, prefix, "ipv4");
  }
  for (const [net, prefix] of [
    ["::", 128],
    ["::1", 128],
    ["64:ff9b::", 96], // NAT64: an IPv4 address in disguise
    ["100::", 64],
    ["2001:db8::", 32],
    ["fc00::", 7], // unique-local
    ["fe80::", 10], // link-local
    ["fec0::", 10], // site-local
    ["ff00::", 8], // multicast
  ] as const) {
    list.addSubnet(net, prefix, "ipv6");
  }
  return list;
})();

/**
 * Is this host, or this resolved address, off limits? Literal addresses are
 * checked against the reserved ranges; an IPv4 address wrapped in IPv6
 * (`[::ffff:169.254.169.254]`, which the URL parser rewrites as
 * `::ffff:a9fe:a9fe`) is unwrapped first: it used to match no rule at all.
 */
export function isPrivateAddress(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  const kind = isIP(h);
  if (kind === 4) return BLOCKED.check(h, "ipv4");
  if (kind !== 6) return false;
  const mapped = /^(?:0{0,4}:){0,5}:?ffff:(.+)$/.exec(h);
  if (mapped) {
    const tail = mapped[1];
    if (isIP(tail) === 4) return BLOCKED.check(tail, "ipv4");
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
    if (hex) {
      const hi = parseInt(hex[1], 16);
      const lo = parseInt(hex[2], 16);
      const v4 = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
      return BLOCKED.check(v4, "ipv4");
    }
    return true;
  }
  return BLOCKED.check(h, "ipv6");
}

/**
 * DNS resolution that refuses private addresses AT CONNECT TIME. Checking the
 * name first and letting fetch resolve it again left a window: a name can
 * answer with a public address to the check and a private one to the
 * connection (DNS rebinding). Here the address that is checked is the one the
 * socket connects to.
 */
const safeLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "", 4);
    const list = addresses as LookupAddress[];
    const bad = list.find((a) => isPrivateAddress(a.address));
    if (bad) {
      return callback(
        new Error(`${hostname} punta a un indirizzo privato (${bad.address})`),
        "",
        4,
      );
    }
    if (options.all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
    callback(null, list[0].address, list[0].family);
  });
};

const MAX_DATASHEET_BYTES = 30 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

interface Fetched {
  status: number;
  location: string | null;
  body: Buffer;
}

/**
 * One GET with the private-address check on the socket and a hard size cap
 * while reading: the body used to be read whole into memory and only then
 * measured, so a server sending gigabytes filled the function's memory first.
 */
function safeGet(url: URL): Promise<Fetched> {
  if (isPrivateAddress(url.hostname)) {
    return Promise.reject(new Error(`indirizzo non consentito: ${url.hostname}`));
  }
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: "GET",
        lookup: safeLookup,
        headers: { "User-Agent": "pcb-studio/1.0", Accept: "application/pdf,*/*" },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = typeof res.headers.location === "string" ? res.headers.location : null;
        if (status >= 300 && status < 400) {
          res.resume();
          return resolve({ status, location, body: Buffer.alloc(0) });
        }
        const declared = Number(res.headers["content-length"] ?? 0);
        if (declared > MAX_DATASHEET_BYTES) {
          res.destroy();
          return reject(new Error("datasheet too large (>30MB)"));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_DATASHEET_BYTES) {
            res.destroy();
            reject(new Error("datasheet too large (>30MB)"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve({ status, location, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("datasheet fetch timed out")));
    req.on("error", reject);
    req.end();
  });
}

export async function fetchDatasheetFromUrl(
  url: string,
): Promise<ExtractedDatasheet & { title: string }> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("only http(s) URLs are supported");
  }
  // a redirect can land where the check would have refused: they are
  // followed by hand, one at a time, each hop with the same checks
  const finale = await seguiRedirect(parsed);
  if (finale.status < 200 || finale.status >= 300) {
    throw new Error(`datasheet fetch failed: HTTP ${finale.status}`);
  }
  const buf = finale.body;
  const extracted = await extractDatasheetText(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
  );
  const last = parsed.pathname.split("/").pop() || "datasheet.pdf";
  let title = last;
  try {
    title = decodeURIComponent(last);
  } catch {
    // a malformed %-escape is still a usable title as it is
  }
  return { ...extracted, title };
}

/** follows up to five redirects, checking the destination of each one */
async function seguiRedirect(from: URL, giri = 5): Promise<Fetched> {
  let base = from;
  let corrente = await safeGet(base);
  for (let i = 0; i < giri; i++) {
    if (corrente.status < 300 || corrente.status >= 400) return corrente;
    if (!corrente.location) return corrente;
    const prossima = new URL(corrente.location, base);
    if (prossima.protocol !== "https:" && prossima.protocol !== "http:") {
      throw new Error("redirect verso un protocollo non consentito");
    }
    base = prossima;
    corrente = await safeGet(prossima);
  }
  throw new Error("troppi redirect");
}
