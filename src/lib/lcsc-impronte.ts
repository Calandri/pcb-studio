/**
 * THE LCSC / EASYEDA FOOTPRINT OF A PART CODE (Cxxxx): its pads at 0 degrees,
 * with the name of each pin from the symbol, as JLCPCB and PCB Basic place the
 * part. Read from EasyEDA's public API, the one the parts of a BOM are bought
 * by; kept in the database, one row per code (a code with no footprint too),
 * so EasyEDA, which limits requests by address, is asked once per code.
 *
 * Two uses (montaggio.ts): the rotation of the pick and place in the
 * JLCPCB/EasyEDA convention, found by laying these pads on the pads of the
 * board; and the check, by NAME, that the anode, the cathode, the + or pin 1
 * of the LCSC footprint fall on ours (the LED of Wurth: pad 1 = cathode; the
 * one of the sonda, C2286: pad 1 = anode).
 *
 * The reading is the one of the order of 2026-11-20 (impronta_easyeda.py):
 * one EasyEDA unit is 10 mil, y up, from the origin of the footprint (head).
 */
import { neon } from "@neondatabase/serverless";

export interface PiazzolaLcsc {
  num: string;
  nome: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ImprontaLcsc {
  codice: string;
  titolo: string;
  /** the package, as EasyEDA calls it ("LED-SMD_L1.6-W0.8-R-RD", "X1SON-2_..._BI-1") */
  impronta: string;
  pads: PiazzolaLcsc[];
}

const U = 0.254;
const CODICE = /^C\d{2,10}$/;
/** pads a footprint may have: a BGA of a few hundred balls, not a garbled answer */
const MAX_PIAZZOLE = 2000;
/** a code EasyEDA said it has no footprint for is asked again after this long */
const RIPROVA_ASSENTE_MS = 7 * 24 * 3600_000;

const parseForse = (v: unknown): Record<string, unknown> | null => {
  if (typeof v === "string") {
    try {
      const o = JSON.parse(v);
      return typeof o === "object" && o ? (o as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return typeof v === "object" && v ? (v as Record<string, unknown>) : null;
};
const fin = (s: unknown): number | null => {
  const n = typeof s === "string" ? Number(s) : typeof s === "number" ? s : NaN;
  return Number.isFinite(n) ? n : null;
};

/** the footprint from the `result` of EasyEDA's answer; null when it has none that reads */
export function leggiImprontaEasyEda(codice: string, result: unknown): ImprontaLcsc | null {
  const res = parseForse(result);
  if (!res) return null;
  const simbolo = parseForse(res.dataStr) ?? {};
  const dettaglio = parseForse(res.packageDetail) ?? {};
  const pk = parseForse(dettaglio.dataStr);
  if (!pk) return null;
  // the name of each pin, from the symbol: "P~...^^...^^...^^...~name^^...~number"
  const nomi = new Map<string, string>();
  for (const s of Array.isArray(simbolo.shape) ? (simbolo.shape as unknown[]) : []) {
    if (typeof s !== "string" || !s.startsWith("P~")) continue;
    const seg = s.split("^^");
    const numero = seg[0].split("~")[3];
    const nome = seg.length > 3 ? (seg[3].split("~")[4] ?? "") : "";
    const num2 = seg.length > 4 ? (seg[4].split("~")[4] ?? numero) : numero;
    if (num2) nomi.set(String(num2), String(nome).slice(0, 40));
  }
  const head = parseForse(pk.head) ?? {};
  const ox = fin(head.x);
  const oy = fin(head.y);
  if (ox === null || oy === null) return null;
  const pads: PiazzolaLcsc[] = [];
  for (const s of Array.isArray(pk.shape) ? (pk.shape as unknown[]) : []) {
    if (typeof s !== "string") continue;
    const c = s.split("~");
    if (c[0] !== "PAD") continue;
    const x = fin(c[2]);
    const y = fin(c[3]);
    let w = fin(c[4]);
    let h = fin(c[5]);
    if (x === null || y === null || w === null || h === null) continue;
    w *= U;
    h *= U;
    const rot = fin(c[11]) ?? 0;
    if (Math.abs((((rot % 180) + 180) % 180) - 90) < 1e-6) [w, h] = [h, w];
    const num = String(c[8] ?? "").slice(0, 12);
    pads.push({ num, nome: nomi.get(num) ?? "", x: (x - ox) * U, y: -(y - oy) * U, w, h });
    if (pads.length > MAX_PIAZZOLE) return null;
  }
  if (pads.length === 0) return null;
  return {
    codice,
    titolo: String(res.title ?? "").slice(0, 120),
    impronta: String(dettaglio.title ?? "").slice(0, 120),
    pads,
  };
}

const INTESTAZIONI = {
  Accept: "application/json",
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Referer: "https://easyeda.com/",
};

/** asks EasyEDA: the footprint, null when it has none, undefined when it did not answer (try again later) */
async function chiediAEasyEda(codice: string, fetcher: typeof fetch): Promise<ImprontaLcsc | null | undefined> {
  try {
    const r = await fetcher(`https://easyeda.com/api/products/${codice}/components?version=6.4.19.5`, {
      headers: INTESTAZIONI,
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return undefined;
    const d = (await r.json()) as { success?: unknown; result?: unknown };
    if (!d || typeof d !== "object") return undefined;
    if (!d.result) return null;
    return leggiImprontaEasyEda(codice, d.result);
  } catch {
    return undefined;
  }
}

type Voce = { impronta: ImprontaLcsc | null; quando: number };
const memoria = (globalThis as unknown as { __pcbStudioLcsc?: Map<string, Voce> });
const inMemoria = (memoria.__pcbStudioLcsc ??= new Map());

function db() {
  const url = process.env.DATABASE_URL;
  return url ? neon(url) : null;
}
let ddl: Promise<unknown> | null = null;
async function tabella(sql: NonNullable<ReturnType<typeof db>>): Promise<void> {
  ddl ??= sql`
    CREATE TABLE IF NOT EXISTS lcsc_footprints (
      code text PRIMARY KEY,
      footprint jsonb,
      fetched_at timestamptz NOT NULL DEFAULT now()
    )
  `.catch((err) => {
    ddl = null;
    throw err;
  });
  await ddl;
}

export interface OpzioniImpronte {
  /** how long the questions to EasyEDA may take, all together (ms): what is not asked in time is asked next time */
  budgetMs?: number;
  /** for the tests: the fetch EasyEDA is asked with */
  fetcher?: typeof fetch;
}

/**
 * The LCSC footprints of these codes: from memory, from the database, else
 * asked to EasyEDA one at a time within the time given. A code with no
 * footprint maps to null; a code not read in time is absent from the map.
 */
export async function improntePerCodici(codiciRaw: readonly string[], opz: OpzioniImpronte = {}): Promise<Map<string, ImprontaLcsc | null>> {
  const codici = [...new Set(codiciRaw.map((c) => c.trim().toUpperCase()).filter((c) => CODICE.test(c)))];
  const out = new Map<string, ImprontaLcsc | null>();
  const adesso = Date.now();
  const valida = (v: Voce) => v.impronta !== null || adesso - v.quando < RIPROVA_ASSENTE_MS;
  for (const c of codici) {
    const v = inMemoria.get(c);
    if (v && valida(v)) out.set(c, v.impronta);
  }
  const sql = db();
  const daLeggere = codici.filter((c) => !out.has(c));
  if (sql && daLeggere.length > 0) {
    try {
      await tabella(sql);
      const righe = (await sql`SELECT code, footprint, fetched_at FROM lcsc_footprints WHERE code = ANY(${daLeggere})`) as Array<{ code: string; footprint: unknown; fetched_at: string }>;
      for (const r of righe) {
        const impronta = r.footprint ? leggiSalvata(r.code, r.footprint) : null;
        const voce = { impronta, quando: new Date(r.fetched_at).getTime() };
        if (!valida(voce)) continue;
        inMemoria.set(r.code, voce);
        out.set(r.code, impronta);
      }
    } catch {
      /* without the database EasyEDA is asked, and memory keeps it */
    }
  }
  // the tests never reach EasyEDA unless they hand a fetch of their own
  if (!opz.fetcher && process.env.NODE_ENV === "test") return out;
  const fetcher = opz.fetcher ?? fetch;
  const fine = Date.now() + (opz.budgetMs ?? 30_000);
  // EasyEDA limits requests by address: after a refusal it is given a pause, after three in a row it is left for next time
  let rifiuti = 0;
  for (const c of codici) {
    if (out.has(c)) continue;
    if (Date.now() > fine || rifiuti >= 3) break;
    const impronta = await chiediAEasyEda(c, fetcher);
    if (impronta === undefined) {
      rifiuti++;
      await new Promise((r) => setTimeout(r, Math.min(3000, Math.max(0, fine - Date.now()))));
      continue;
    }
    rifiuti = 0;
    inMemoria.set(c, { impronta, quando: Date.now() });
    out.set(c, impronta);
    if (sql) {
      try {
        await sql`
          INSERT INTO lcsc_footprints (code, footprint, fetched_at) VALUES (${c}, ${impronta ? JSON.stringify(impronta) : null}::jsonb, now())
          ON CONFLICT (code) DO UPDATE SET footprint = EXCLUDED.footprint, fetched_at = now()
        `;
      } catch {
        /* memory keeps it */
      }
    }
  }
  return out;
}

/** a footprint read back from the database, checked as if it came from outside */
function leggiSalvata(codice: string, v: unknown): ImprontaLcsc | null {
  const o = parseForse(v);
  if (!o || !Array.isArray(o.pads)) return null;
  const pads: PiazzolaLcsc[] = [];
  for (const p of o.pads as Array<Record<string, unknown>>) {
    const x = fin(p?.x);
    const y = fin(p?.y);
    const w = fin(p?.w);
    const h = fin(p?.h);
    if (x === null || y === null || w === null || h === null) continue;
    pads.push({ num: String(p.num ?? "").slice(0, 12), nome: String(p.nome ?? "").slice(0, 40), x, y, w, h });
    if (pads.length > MAX_PIAZZOLE) return null;
  }
  return pads.length > 0 ? { codice, titolo: String(o.titolo ?? "").slice(0, 120), impronta: String(o.impronta ?? "").slice(0, 120), pads } : null;
}

/** the LCSC codes the sources of a project name (supplierPartNumbers={{ jlcpcb: ["C2286"] }}) */
export function codiciDaiSorgenti(fsMap: Record<string, string>): string[] {
  const out = new Set<string>();
  for (const [path, testo] of Object.entries(fsMap)) {
    if (!path.endsWith(".tsx") || typeof testo !== "string") continue;
    for (const m of testo.matchAll(/jlcpcb\s*:\s*\[([^\]]{0,400})\]/g)) {
      for (const c of m[1].matchAll(/C\d{2,10}/g)) out.add(c[0]);
    }
    if (out.size > 2000) break;
  }
  return [...out];
}

/**
 * The footprints of the codes a project names, read while it compiles: what is
 * read in time is in memory for the checks of this compile (impronteInMemoria),
 * and in the database for every later one. Never throws.
 */
export async function scaldaImpronte(fsMap: Record<string, string>, budgetMs = 20_000): Promise<void> {
  try {
    await improntePerCodici(codiciDaiSorgenti(fsMap), { budgetMs });
  } catch {
    /* the checks say what they could compare */
  }
}

/** the footprints already read, without asking anybody: for the checks, which are synchronous */
export function impronteInMemoria(codici: readonly string[]): Map<string, ImprontaLcsc | null> {
  const out = new Map<string, ImprontaLcsc | null>();
  for (const c of codici) {
    const v = inMemoria.get(c);
    if (v) out.set(c, v.impronta);
  }
  return out;
}
