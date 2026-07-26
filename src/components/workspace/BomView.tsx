"use client";

import { useEffect, useState } from "react";

/**
 * Distinta base. Non si usa quella di runframe: la sua tabella carica
 * l'esportatore da una CDN a runtime e in questa app fallisce ("Cannot find
 * module"), lasciando la scheda con un errore al posto dei componenti. Qui le
 * righe arrivano dallo stesso endpoint che genera il CSV scaricabile, quindi
 * quello che si vede a video e' esattamente quello che si manda in produzione.
 */
export function BomView({ projectId }: { projectId: string }) {
  const [rows, setRows] = useState<Array<Record<string, unknown>> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError(null);
    fetch(`/api/export?projectId=${projectId}&kind=bom-json`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d.error) setError(String(d.error));
        else setRows(d.rows ?? []);
      })
      .catch((err) => !cancelled && setError(String(err)));
    return () => {
      cancelled = true;
    };
  }, [projectId]);

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

  const columns = Object.keys(rows[0]);

  return (
    <div className="h-full overflow-auto p-5">
      <table className="w-full border-collapse text-left">
        <thead className="sticky top-0 bg-canvas">
          <tr>
            {columns.map((c) => (
              <th
                key={c}
                className="border-b border-line-strong px-3 py-2 font-mono text-[10px] font-semibold tracking-[0.06em] whitespace-nowrap text-faint uppercase"
              >
                {c.replace(/_/g, " ")}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="transition-colors hover:bg-[#101A17]">
              {columns.map((c) => (
                <td
                  key={c}
                  className="border-b border-line px-3 py-2 align-top text-[12px] text-muted"
                >
                  {formatCell(row[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  // i codici fornitore arrivano come mappa {"JLCPCB Part #": "C14663"}: a
  // video conta il codice, non il JSON
  if (typeof value === "object") {
    const values = Object.values(value as Record<string, unknown>)
      .map(String)
      .filter(Boolean);
    return values.length ? values.join(" · ") : "—";
  }
  return String(value);
}
