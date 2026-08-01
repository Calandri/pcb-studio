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
  /** lowest unit price in USD at the first price break, when published */
  priceUsd: number | null;
  sku: string;
  url: string;
  found: boolean;
}

const CACHE_HOURS = 24;

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
}

interface MouserPart {
  MouserPartNumber?: string;
  Availability?: string;
  ProductDetailUrl?: string;
  PriceBreaks?: Array<{ Quantity?: number; Price?: string }>;
}

async function fetchMouser(mpn: string): Promise<MouserInfo> {
  const empty: MouserInfo = { mpn, stock: 0, priceUsd: null, sku: "", url: "", found: false };
  const key = process.env.MOUSER_API_KEY;
  if (!key) return empty;
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
    if (!res.ok) return empty;
    const data = (await res.json()) as { SearchResults?: { Parts?: MouserPart[] } };
    const part = data.SearchResults?.Parts?.[0];
    if (!part) return empty;
    const stock = Number((part.Availability ?? "").replace(/\D/g, "")) || 0;
    const price = part.PriceBreaks?.[0]?.Price;
    return {
      mpn,
      stock,
      priceUsd: price ? Number(price.replace(/[^\d.]/g, "")) || null : null,
      sku: String(part.MouserPartNumber ?? ""),
      url: String(part.ProductDetailUrl ?? ""),
      found: true,
    };
  } catch {
    return empty;
  }
}

/** Mouser stock for a list of MPNs, cache-first, free-key-friendly */
export async function mouserForParts(mpns: string[]): Promise<Map<string, MouserInfo>> {
  const out = new Map<string, MouserInfo>();
  const unique = [...new Set(mpns.map((m) => m.trim()).filter((m) => m.length >= 4))];
  if (!process.env.MOUSER_API_KEY || unique.length === 0) return out;

  const sql = db();
  const missing: string[] = [];
  if (sql) {
    try {
      await ensureTable(sql);
      const rows = (await sql`
        SELECT mpn, sku, stock, price_usd, url, found FROM mouser_cache
        WHERE mpn = ANY(${unique}) AND seen_at > now() - interval '${CACHE_HOURS} hours'
      `) as Array<Record<string, unknown>>;
      for (const r of rows) {
        out.set(String(r.mpn), {
          mpn: String(r.mpn),
          stock: Number(r.stock) || 0,
          priceUsd: r.price_usd === null ? null : Number(r.price_usd),
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
  for (let i = 0; i < missing.length; i += CONCURRENCY) {
    const batch = await Promise.all(missing.slice(i, i + CONCURRENCY).map(fetchMouser));
    for (const info of batch) out.set(info.mpn, info);
    if (sql) {
      for (const info of batch) {
        await sql`
          INSERT INTO mouser_cache (mpn, sku, stock, price_usd, url, found)
          VALUES (${info.mpn}, ${info.sku}, ${info.stock}, ${info.priceUsd}, ${info.url}, ${info.found})
          ON CONFLICT (mpn) DO UPDATE SET
            sku = EXCLUDED.sku, stock = EXCLUDED.stock, price_usd = EXCLUDED.price_usd,
            url = EXCLUDED.url, found = EXCLUDED.found, seen_at = now()
        `.catch(() => {});
      }
    }
  }
  return out;
}
