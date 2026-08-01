import { requireProjectAccess } from "@/lib/acl";
import { buildBom } from "@/lib/bom";
import { mouserForParts } from "@/lib/mouser";
import { getCompileCache, getProject } from "@/lib/project-store";
import { stockForParts, toleranceFromMpn } from "@/lib/stock";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Live availability of the BOM lines: for each line, how many pieces JLCPCB
 * has in stock, at what price, and whether the part is a basic/preferred one
 * (the cheap ones for assembly). Values come from jlcsearch and are cached
 * for 24h; `?refresh=1` forces a fresh lookup.
 *
 * Status per line: "ok" (enough pieces), "low" (some, not enough for the
 * quantity needed), "out" (none), "unknown" (no supplier code or lookup
 * failed). Out/low lines also carry the stock of their equivalent part
 * numbers, so an alternative is one glance away instead of one search.
 */

/** equivalent part numbers from the BOM cell ("C123 C456 C789") */
function altCodes(alternatives: string): string[] {
  return alternatives.split(/\s+/).filter((c) => /^C\d+$/i.test(c)).slice(0, 3);
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const projectId = url.searchParams.get("projectId") ?? "";
  if (!/^[\w-]{1,64}$/.test(projectId)) {
    return Response.json({ error: "projectId non valido" }, { status: 400 });
  }
  const { ok } = await requireProjectAccess(projectId, "view");
  if (!ok) return Response.json({ error: "forbidden" }, { status: 403 });

  const cached = await getCompileCache(projectId).catch(() => null);
  if (!cached?.circuitJson) {
    return Response.json({ error: "nessuna scheda compilata" }, { status: 404 });
  }
  const fsMap = await getProject(projectId);
  const rows = buildBom(cached.circuitJson as never, fsMap);

  const refresh = url.searchParams.get("refresh") === "1";
  const altOf = new Map(rows.map((r) => [r.designators, altCodes(r.alternatives)]));
  const allCodes = [
    ...rows.map((r) => r.lcsc).filter(Boolean),
    ...[...altOf.values()].flat(),
  ];
  const [stock, mouser] = await Promise.all([
    stockForParts(allCodes, refresh),
    mouserForParts(rows.map((r) => r.manufacturerPartNumber).filter(Boolean)),
  ]);

  const lines = rows.map((r) => {
    const info = stock.get(r.lcsc);
    const status = !r.lcsc || !info?.found
      ? "unknown"
      : info.stock >= r.quantity
        ? "ok"
        : info.stock > 0
          ? "low"
          : "out";
    const alternatives = (altOf.get(r.designators) ?? []).map((code) => {
      const a = stock.get(code);
      return {
        lcsc: code,
        found: Boolean(a?.found),
        stock: a?.stock ?? null,
        priceUsd: a?.priceUsd ?? null,
      };
    });
    const m = r.manufacturerPartNumber ? mouser.get(r.manufacturerPartNumber) : undefined;
    return {
      designators: r.designators,
      quantity: r.quantity,
      lcsc: r.lcsc,
      lcscUrl: r.lcscUrl,
      jlcpcbUrl: r.jlcpcbUrl,
      mouser: m?.found
        ? { stock: m.stock, priceUsd: m.priceUsd, url: m.url, sku: m.sku }
        : null,
      status,
      stock: info?.stock ?? null,
      priceUsd: info?.priceUsd ?? null,
      basic: info?.basic ?? null,
      preferred: info?.preferred ?? null,
      mfr: info?.mfr ?? null,
      tolerance: info?.mfr ? toleranceFromMpn(info.mfr) : null,
      costUsd: info?.priceUsd !== null && info?.priceUsd !== undefined
        ? Math.round(info.priceUsd * r.quantity * 100) / 100
        : null,
      alternatives,
      seenAt: info?.seenAt ?? null,
    };
  });

  const summary = {
    total: lines.length,
    ok: lines.filter((l) => l.status === "ok").length,
    low: lines.filter((l) => l.status === "low").length,
    out: lines.filter((l) => l.status === "out").length,
    unknown: lines.filter((l) => l.status === "unknown").length,
    costUsd:
      Math.round(
        lines.reduce((sum, l) => sum + (l.costUsd ?? 0), 0) * 100,
      ) / 100,
  };
  return Response.json({ lines, summary });
}
