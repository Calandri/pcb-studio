import { neon } from "@neondatabase/serverless";

/**
 * Mouser as a second supplier next to JLCPCB/LCSC: lookup by manufacturer
 * part number (the LCSC code means nothing outside that catalog, the MPN is
 * the universal key). The Search API key is free (mouser.it/iot) and lives in
 * MOUSER_API_KEY; without it the feature simply stays off.
 *
 * Results are cached 24h in mouser_cache: stock and prices move, but not by
 * the minute, and the free key has daily call limits worth respecting.
 */

export interface MouserInfo {
  mpn: string;
  stock: number;
  /** unit price at the first price break, in USD, only when Mouser quoted USD */
  priceUsd: number | null;
  /** the same price in the currency Mouser quoted it in (the key's locale) */
  price: number | null;
  /** ISO code of that currency, when known: "USD", "EUR"... */
  currency: string | null;
  sku: string;
  url: string;
  found: boolean;
}

const CACHE_HOURS = 24;
/** MPNs per request: the free key has a daily quota, a BOM has a few dozen lines */
export const MAX_MPNS_PER_REQUEST = 80;
const LIVE_BUDGET_MS = 40_000;

/**
 * A price as Mouser writes it, which depends on the locale of the key: "$0.123",
 * "0,123 €", "1.234,56 €", "1,234.56". Stripping everything but digits and the
 * dot turned "0,123" into 123 — a ten-cent capacitor priced at a hundred and
 * twenty-three. The decimal separator is the LAST of comma and dot when both
 * appear; a lone comma or dot is decimal unless it repeats (thousands).
 */
export function parseMouserPrice(raw: unknown): number | null {
  const t = String(raw ?? "").replace(/[^\d.,]/g, "");
  if (!/\d/.test(t)) return null;
  const virgola = t.lastIndexOf(",");
  const punto = t.lastIndexOf(".");
  let numero: string;
  if (virgola >= 0 && punto >= 0) {
    const decimale = virgola > punto ? "," : ".";
    const migliaia = decimale === "," ? "." : ",";
    numero = t.split(migliaia).join("").replace(decimale, ".");
  } else if (virgola >= 0) {
    numero = t.split(",").length > 2 ? t.split(",").join("") : t.replace(",", ".");
  } else if (punto >= 0) {
    numero = t.split(".").length > 2 ? t.split(".").join("") : t;
  } else {
    numero = t;
  }
  const v = Number(numero);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** the currency of a price break: the field when there is one, the symbol otherwise */
export function mouserCurrency(currency: unknown, price: unknown): string | null {
  if (typeof currency === "string" && /^[A-Z]{3}$/i.test(currency.trim())) {
    return currency.trim().toUpperCase();
  }
  const p = String(price ?? "");
  if (p.includes("€")) return "EUR";
  if (p.includes("£")) return "GBP";
  if (p.includes("$")) return "USD";
  return null;
}

function db() {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  return neon(url);
}

async function ensureTable(sql: NonNullable<ReturnType<typeof db>>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS mouser_cache (
      mpn text PRIMARY KEY,
      sku text,
      stock integer NOT NULL DEFAULT 0,
      price_usd double precision,
      url text,
      found boolean NOT NULL DEFAULT true,
      seen_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  // the quoted price and its currency, next to the USD one
  await sql`ALTER TABLE mouser_cache ADD COLUMN IF NOT EXISTS price double precision`;
  await sql`ALTER TABLE mouser_cache ADD COLUMN IF NOT EXISTS currency text`;
}

interface MouserPart {
  MouserPartNumber?: string;
  Availability?: string;
  ProductDetailUrl?: string;
  PriceBreaks?: Array<{ Quantity?: number; Price?: string; Currency?: string }>;
}

/** a failed lookup, as opposed to a part Mouser does not have: never cached */
interface Fetched {
  info: MouserInfo;
  transient: boolean;
}

async function fetchMouser(mpn: string): Promise<Fetched> {
  const info: MouserInfo = {
    mpn, stock: 0, priceUsd: null, price: null, currency: null, sku: "", url: "", found: false,
  };
  const empty = (transient: boolean): Fetched => ({ info, transient });
  const key = process.env.MOUSER_API_KEY;
  if (!key) return empty(true);
  try {
    const res = await fetch(
      `https://api.mouser.com/api/v1/search/partnumber?apiKey=${encodeURIComponent(key)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          SearchByPartRequest: { mouserPartNumber: mpn.slice(0, 60), records: 1 },
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) return empty(true);
    const data = (await res.json()) as {
      SearchResults?: { Parts?: MouserPart[] };
      Errors?: unknown[];
    };
    // an answer that carries errors (quota, bad key) is a failure, not a miss
    if (Array.isArray(data.Errors) && data.Errors.length > 0) return empty(true);
    const part = data.SearchResults?.Parts?.[0];
    if (!part) return empty(false);
    const stock = Number((part.Availability ?? "").replace(/\D/g, "")) || 0;
    const rottura = part.PriceBreaks?.[0];
    const price = parseMouserPrice(rottura?.Price);
    const currency = price !== null ? mouserCurrency(rottura?.Currency, rottura?.Price) : null;
    return {
      info: {
        mpn,
        stock,
        // a euro price is not a dollar price: priceUsd only when it IS dollars
        priceUsd: currency === "USD" ? price : null,
        price,
        currency,
        sku: String(part.MouserPartNumber ?? ""),
        url: String(part.ProductDetailUrl ?? ""),
        found: true,
      },
      transient: false,
    };
  } catch {
    return empty(true);
  }
}

/** Mouser stock for a list of MPNs, cache-first, free-key-friendly */
export async function mouserForParts(mpns: string[]): Promise<Map<string, MouserInfo>> {
  const out = new Map<string, MouserInfo>();
  const unique = [...new Set(mpns.map((m) => m.trim()).filter((m) => m.length >= 4))].slice(
    0,
    MAX_MPNS_PER_REQUEST,
  );
  if (!process.env.MOUSER_API_KEY || unique.length === 0) return out;

  const sql = db();
  const missing: string[] = [];
  if (sql) {
    try {
      await ensureTable(sql);
      /*
       * make_interval, not `interval '${n} hours'`: inside quotes the parameter
       * is not a parameter, the query failed every time, the catch below
       * swallowed it, and the cache was written and never read.
       */
      const rows = (await sql`
        SELECT mpn, sku, stock, price_usd, price, currency, url, found FROM mouser_cache
        WHERE mpn = ANY(${unique}) AND seen_at > now() - make_interval(hours => ${CACHE_HOURS}::int)
      `) as Array<Record<string, unknown>>;
      for (const r of rows) {
        const priceUsd = r.price_usd === null || r.price_usd === undefined ? null : Number(r.price_usd);
        out.set(String(r.mpn), {
          mpn: String(r.mpn),
          stock: Number(r.stock) || 0,
          priceUsd,
          price: r.price === null || r.price === undefined ? priceUsd : Number(r.price),
          currency: r.currency ? String(r.currency) : priceUsd !== null ? "USD" : null,
          sku: String(r.sku ?? ""),
          url: String(r.url ?? ""),
          found: Boolean(r.found),
        });
      }
    } catch {
      // cache miss: fall through to live lookup for everything
    }
  }
  for (const mpn of unique) if (!out.has(mpn)) missing.push(mpn);

  const CONCURRENCY = 3;
  const startedAt = Date.now();
  for (let i = 0; i < missing.length; i += CONCURRENCY) {
    // out of time: what is left stays without a Mouser answer, and uncached
    if (Date.now() - startedAt > LIVE_BUDGET_MS) break;
    const batch = await Promise.all(missing.slice(i, i + CONCURRENCY).map(fetchMouser));
    for (const { info } of batch) out.set(info.mpn, info);
    if (sql) {
      for (const { info, transient } of batch) {
        // a failure is not cached as "Mouser does not have it" for a day
        if (transient) continue;
        await sql`
          INSERT INTO mouser_cache (mpn, sku, stock, price_usd, price, currency, url, found)
          VALUES (${info.mpn}, ${info.sku}, ${info.stock}, ${info.priceUsd}, ${info.price},
                  ${info.currency}, ${info.url}, ${info.found})
          ON CONFLICT (mpn) DO UPDATE SET
            sku = EXCLUDED.sku, stock = EXCLUDED.stock, price_usd = EXCLUDED.price_usd,
            price = EXCLUDED.price, currency = EXCLUDED.currency,
            url = EXCLUDED.url, found = EXCLUDED.found, seen_at = now()
        `.catch(() => {});
      }
    }
  }
  return out;
}
