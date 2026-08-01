import { neon } from "@neondatabase/serverless";

/**
 * Live stock availability for the BOM (JLCPCB via jlcsearch).
 *
 * The lookup by LCSC code is exact and free of charge, but it is still an
 * external service: results are cached in `parts_cache` for CACHE_HOURS so a
 * page refresh does not mean a new round-trip per component, and a deploy or
 * a cold start never hammers the upstream API.
 */

export interface StockInfo {
  lcsc: string;
  stock: number;
  priceUsd: number | null;
  basic: boolean;
  preferred: boolean;
  mfr: string;
  /** when the value was fetched */
  seenAt: string;
  /** false when the lookup failed or the part is unknown */
  found: boolean;
}

const CACHE_HOURS = 24;
const JLCSEARCH_BASE = "https://jlcsearch.tscircuit.com";

/**
 * Component tolerance from the manufacturer's part number. Two honest
 * patterns, no more: the EIA 3-digit code followed by the tolerance letter
 * (104K = ±10%), and the Yageo WA-series letter (WAF = ±1%, WAJ = ±5%).
 * Everything else (C0G/NPO, ICs, crystals) simply reports nothing — a missing
 * chip beats a wrong one.
 */
export function toleranceFromMpn(mpn: string): string | null {
  const PCT: Record<string, string> = { F: "±1%", G: "±2%", J: "±5%", K: "±10%", M: "±20%" };
  const wa = /WA([FJ])/.exec(mpn);
  if (wa) return PCT[wa[1]];
  const eia = /\d{3}([FGJKM])/.exec(mpn);
  return eia ? PCT[eia[1]] : null;
}

function db() {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  return neon(url);
}

async function ensureTable(sql: NonNullable<ReturnType<typeof db>>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS parts_cache (
      lcsc text PRIMARY KEY,
      mfr text,
      stock integer NOT NULL DEFAULT 0,
      price_usd double precision,
      basic boolean NOT NULL DEFAULT false,
      preferred boolean NOT NULL DEFAULT false,
      found boolean NOT NULL DEFAULT true,
      seen_at timestamptz NOT NULL DEFAULT now()
    )
  `;
}

async function readCache(lcscs: string[]): Promise<Map<string, StockInfo>> {
  const out = new Map<string, StockInfo>();
  const sql = db();
  if (!sql || lcscs.length === 0) return out;
  try {
    await ensureTable(sql);
    const rows = (await sql`
      SELECT lcsc, mfr, stock, price_usd, basic, preferred, found, seen_at
      FROM parts_cache
      WHERE lcsc = ANY(${lcscs}) AND seen_at > now() - interval '${CACHE_HOURS} hours'
    `) as Array<Record<string, unknown>>;
    for (const r of rows) {
      out.set(String(r.lcsc), {
        lcsc: String(r.lcsc),
        stock: Number(r.stock) || 0,
        priceUsd: r.price_usd === null ? null : Number(r.price_usd),
        basic: Boolean(r.basic),
        preferred: Boolean(r.preferred),
        mfr: String(r.mfr ?? ""),
        seenAt: String(r.seen_at),
        found: Boolean(r.found),
      });
    }
  } catch {
    // a cache failure must not block the live lookup
  }
  return out;
}

async function writeCache(infos: StockInfo[]): Promise<void> {
  const sql = db();
  if (!sql || infos.length === 0) return;
  try {
    await ensureTable(sql);
    for (const i of infos.slice(0, 200)) {
      await sql`
        INSERT INTO parts_cache (lcsc, mfr, stock, price_usd, basic, preferred, found)
        VALUES (${i.lcsc}, ${i.mfr}, ${i.stock}, ${i.priceUsd}, ${i.basic}, ${i.preferred}, ${i.found})
        ON CONFLICT (lcsc) DO UPDATE SET
          mfr = EXCLUDED.mfr, stock = EXCLUDED.stock, price_usd = EXCLUDED.price_usd,
          basic = EXCLUDED.basic, preferred = EXCLUDED.preferred,
          found = EXCLUDED.found, seen_at = now()
      `;
    }
  } catch {
    // the cache is a plus: losing a write changes nothing for the user
  }
}

/** one live lookup per code, with modest concurrency so we stay polite */
async function fetchLive(lcsc: string): Promise<StockInfo> {
  const url = new URL(`${JLCSEARCH_BASE}/api/search`);
  url.searchParams.set("q", lcsc);
  url.searchParams.set("limit", "1");
  const empty: StockInfo = {
    lcsc, stock: 0, priceUsd: null, basic: false, preferred: false,
    mfr: "", seenAt: new Date().toISOString(), found: false,
  };
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return empty;
    const data = (await res.json()) as { components?: Array<Record<string, unknown>> };
    const c = (data.components ?? []).find((x) => `C${x.lcsc}`.toUpperCase() === lcsc.toUpperCase());
    if (!c) return empty;
    return {
      lcsc,
      stock: Number(c.stock) || 0,
      priceUsd: typeof c.price === "number" ? Math.round(c.price * 10000) / 10000 : null,
      basic: Boolean(c.is_basic),
      preferred: Boolean(c.is_preferred),
      mfr: String(c.mfr ?? "").slice(0, 80),
      seenAt: new Date().toISOString(),
      found: true,
    };
  } catch {
    return empty;
  }
}

/**
 * Stock for a list of LCSC codes: cache first, live lookup for the rest.
 * `refresh: true` skips the cache read (the values are rewritten anyway).
 */
export async function stockForParts(lcscs: string[], refresh = false): Promise<Map<string, StockInfo>> {
  const unique = [...new Set(lcscs.filter((c) => /^C\d+$/i.test(c)))];
  const out = refresh ? new Map<string, StockInfo>() : await readCache(unique);
  const missing = unique.filter((c) => !out.has(c));

  const CONCURRENCY = 4;
  const fresh: StockInfo[] = [];
  for (let i = 0; i < missing.length; i += CONCURRENCY) {
    const batch = await Promise.all(missing.slice(i, i + CONCURRENCY).map(fetchLive));
    fresh.push(...batch);
  }
  for (const info of fresh) out.set(info.lcsc, info);
  void writeCache(fresh);
  return out;
}
