"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * The BOM with live JLCPCB availability: per line you see whether the part
 * can really be ordered (stock, unit and line price, basic/preferred), the
 * datasheet link, the component's tolerance and role in the circuit, and —
 * when it is out of stock — the equivalent part numbers with their stock.
 * Values come from /api/stock (jlcsearch, 24h cache); "aggiorna stock"
 * forces a fresh lookup.
 */

interface StockAlt {
  lcsc: string;
  found: boolean;
  stock: number | null;
  priceUsd: number | null;
}

interface StockLine {
  designators: string;
  quantity: number;
  lcsc: string;
  lcscUrl: string;
  jlcpcbUrl: string;
  mouser: { stock: number; priceUsd: number | null; url: string; sku: string } | null;
  status: "ok" | "low" | "out" | "unknown";
  stock: number | null;
  priceUsd: number | null;
  basic: boolean | null;
  preferred: boolean | null;
  mfr: string | null;
  tolerance: string | null;
  costUsd: number | null;
  alternatives: StockAlt[];
  seenAt: string | null;
}

interface StockResponse {
  lines: StockLine[];
  summary: {
    total: number;
    ok: number;
    low: number;
    out: number;
    unknown: number;
    costUsd: number;
  };
  error?: string;
}

interface Description {
  component: string;
  role: string;
  why: string;
}

export function BomView({ projectId }: { projectId: string }) {
  const [rows, setRows] = useState<Array<Record<string, unknown>> | null>(null);
  const [stock, setStock] = useState<StockResponse | null>(null);
  const [roles, setRoles] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    async (refresh: boolean) => {
      if (refresh) setRefreshing(true);
      try {
        const [bomRes, stockRes, descRes] = await Promise.all([
          fetch(`/api/export?projectId=${projectId}&kind=bom-json`).then((r) => r.json()),
          fetch(`/api/stock?projectId=${projectId}${refresh ? "&refresh=1" : ""}`).then((r) =>
            r.json(),
          ),
          fetch(`/api/describe-component?projectId=${projectId}`)
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null),
        ]);
        if (bomRes.error) setError(String(bomRes.error));
        else setRows(bomRes.rows ?? []);
        if (!stockRes.error) setStock(stockRes as StockResponse);
        if (descRes?.descriptions) {
          setRoles(
            new Map(
              (descRes.descriptions as Description[]).map((d) => [
                d.component,
                d.why || d.role,
              ]),
            ),
          );
        }
      } catch (err) {
        setError(String(err));
      } finally {
        setRefreshing(false);
      }
    },
    [projectId],
  );

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setRows(null);
      setStock(null);
      setError(null);
      void load(false);
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <p className="max-w-md text-center text-sm leading-relaxed text-danger">{error}</p>
      </div>
    );
  }

  if (!rows) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-faint">
        <span className="dot dot-busy" /> Preparazione della distinta...
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-faint">
        Nessun componente nella distinta.
      </div>
    );
  }

  const stockByName = new Map((stock?.lines ?? []).map((l) => [l.designators, l]));

  return (
    <div className="h-full overflow-auto p-5">
      {stock && (
        <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-[10px] border border-line bg-[#0E1513] px-3.5 py-2.5">
          <span className="text-[11px] font-semibold tracking-[0.06em] text-faint uppercase">
            Disponibilità JLCPCB
          </span>
          <Summary n={stock.summary.ok} label="disponibili" cls="text-brand" />
          {stock.summary.low > 0 && <Summary n={stock.summary.low} label="sotto scorta" cls="text-[#E8B23B]" />}
          {stock.summary.out > 0 && <Summary n={stock.summary.out} label="esauriti" cls="text-danger" />}
          {stock.summary.unknown > 0 && <Summary n={stock.summary.unknown} label="senza codice" cls="text-faint" />}
          <span className="text-[12px] font-semibold text-[#C7D6D1]">
            ~${stock.summary.costUsd.toLocaleString("it-IT", { minimumFractionDigits: 2 })}
            <span className="ml-1 font-normal text-faint">componenti</span>
          </span>
          <span className="flex-1" />
          <button
            type="button"
            onClick={() => void load(true)}
            disabled={refreshing}
            className="rounded-md border border-line-strong px-2.5 py-1 text-[11px] font-semibold text-[#C7D6D1] transition-colors hover:border-[#3A5A50] disabled:text-faint"
          >
            {refreshing ? "controllo..." : "aggiorna stock"}
          </button>
        </div>
      )}

      <table className="w-full table-fixed border-collapse text-left">
        <thead className="sticky top-0 bg-canvas">
          <tr>
            <Th>designators</Th>
            <Th>qtà</Th>
            <Th>valore</Th>
            <Th>package</Th>
            <Th>lcsc</Th>
            <Th>disponibilità</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const line = stockByName.get(String(row.designators ?? ""));
            const firstDesignator = String(row.designators ?? "").split(",")[0];
            const role = roles.get(firstDesignator);
            return (
              <tr key={i} className="align-top transition-colors hover:bg-[#101A17]">
                <td className="border-b border-line px-3 py-2 text-[12px] text-muted">
                  <div className="max-w-[260px] break-words font-medium text-[#C7D6D1]">
                    {formatCell(row.designators)}
                  </div>
                  {role && (
                    <div className="mt-0.5 max-w-[260px] text-[10.5px] leading-[1.35] text-faint">
                      {role}
                    </div>
                  )}
                </td>
                <td className="border-b border-line px-3 py-2 text-[12px] whitespace-nowrap text-muted">
                  {formatCell(row.quantity)}
                </td>
                <td className="border-b border-line px-3 py-2 text-[12px] whitespace-nowrap text-muted">
                  {formatCell(row.value)}
                  {line?.tolerance && (
                    <span className="ml-1.5 rounded border border-line px-1 font-mono text-[9.5px] text-faint">
                      {line.tolerance}
                    </span>
                  )}
                </td>
                <td className="border-b border-line px-3 py-2 text-[12px] whitespace-nowrap text-muted">
                  {formatCell(row.package)}
                </td>
                <td className="border-b border-line px-3 py-2 text-[12px] whitespace-nowrap">
                  {line?.lcscUrl ? (
                    <a
                      href={line.lcscUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      title="scheda tecnica del componente"
                      className="font-mono text-[11px] text-brand underline-offset-2 hover:underline"
                    >
                      {formatCell(row.lcsc)} ↗
                    </a>
                  ) : (
                    <span className="font-mono text-[11px] text-muted">{formatCell(row.lcsc)}</span>
                  )}
                </td>
                <td className="border-b border-line px-3 py-2">
                  {stock ? <StockCell line={line} /> : <span className="dot dot-busy" />}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="border-b border-line-strong px-3 py-2 font-mono text-[10px] font-semibold tracking-[0.06em] whitespace-nowrap text-faint uppercase">
      {children}
    </th>
  );
}

function Summary({ n, label, cls }: { n: number; label: string; cls: string }) {
  return (
    <span className={`text-[12px] font-semibold ${cls}`}>
      {n} <span className="font-normal text-faint">{label}</span>
    </span>
  );
}

function StockCell({ line }: { line: StockLine | undefined }) {
  if (!line) return <span className="text-[12px] text-faint">—</span>;
  if (line.status === "unknown") {
    return (
      <span className="text-[12px] text-faint">
        {line.lcsc ? "non trovato" : "senza codice"}
      </span>
    );
  }
  const style =
    line.status === "ok"
      ? "border-[#1E4D3C] bg-[#0E241B] text-brand"
      : line.status === "low"
        ? "border-[#4A3A16] bg-[#221B0C] text-[#E8B23B]"
        : "border-[#4A2320] bg-[#241211] text-danger";
  return (
    <div className="flex flex-col gap-1">
      <span className="flex flex-wrap items-center gap-1.5">
        <a
          href={line.jlcpcbUrl || line.lcscUrl}
          target="_blank"
          rel="noreferrer noopener"
          title="magazzino di assemblaggio JLCPCB: e' questo numero che conta per la produzione (lcsc.com mostra lo stock retail, diverso)"
          className={`inline-flex w-fit rounded-md border px-2 py-px font-mono text-[11px] font-semibold transition-opacity hover:opacity-80 ${style}`}
        >
          {line.status === "out" ? "esaurito" : `${line.stock?.toLocaleString("it-IT")} pz`} ↗
        </a>
        {line.basic && (
          <span
            title="componente basic JLCPCB: montaggio senza sovrapprezzo"
            className="rounded border border-[#1E4D3C] px-1.5 font-mono text-[9.5px] text-brand"
          >
            basic
          </span>
        )}
      </span>
      <span className="font-mono text-[9px] tracking-wide text-[#42544F]">
        JLCPCB · magazzino assemblaggio
      </span>
      {line.mouser && (
        <a
          href={line.mouser.url || undefined}
          target="_blank"
          rel="noreferrer noopener"
          title={`Mouser SKU ${line.mouser.sku}: altra fonte quando JLCPCB non basta`}
          className={`inline-flex w-fit items-center gap-1 rounded-md border px-2 py-px font-mono text-[11px] font-semibold transition-opacity hover:opacity-80 ${
            line.mouser.stock >= line.quantity
              ? "border-[#2C4C62] bg-[#0D1B26] text-[#7FB4FF]"
              : "border-[#4A2320] bg-[#241211] text-danger"
          }`}
        >
          Mouser: {line.mouser.stock.toLocaleString("it-IT")} pz ↗
        </a>
      )}
      {(line.priceUsd !== null || line.costUsd !== null) && (
        <span className="font-mono text-[10px] text-faint">
          {line.priceUsd !== null && `$${line.priceUsd}/pz`}
          {line.costUsd !== null && line.quantity > 1 && ` · $${line.costUsd} tot`}
        </span>
      )}
      {(line.status === "out" || line.status === "low") &&
        line.alternatives.some((a) => a.found) && (
          <span className="flex flex-col gap-0.5 text-[10.5px] text-faint">
            {line.alternatives
              .filter((a) => a.found)
              .map((a) => (
                <a
                  key={a.lcsc}
                  href={`https://www.lcsc.com/product-detail/${a.lcsc}.html`}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="underline-offset-2 hover:underline"
                >
                  → {a.lcsc}: {a.stock?.toLocaleString("it-IT") ?? "?"} pz
                  {a.priceUsd !== null && ` · $${a.priceUsd}`}
                </a>
              ))}
          </span>
        )}
    </div>
  );
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  // supplier codes arrive as a map {"JLCPCB Part #": "C14663"}: on
  // screen the code is what matters, not the JSON
  if (typeof value === "object") {
    const values = Object.values(value as Record<string, unknown>)
      .map(String)
      .filter(Boolean);
    return values.length ? values.join(" · ") : "—";
  }
  return String(value);
}
