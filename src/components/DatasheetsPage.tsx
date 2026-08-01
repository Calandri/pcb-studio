"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, SettingsShell } from "./SettingsShell";
import { Chip, EmptyState } from "./ui";

type Datasheet = { id: number; title: string; pages?: number };

export function DatasheetsPage({
  projectId,
  user,
}: {
  projectId: string;
  user: { email: string; name: string | null };
}) {
  const [datasheets, setDatasheets] = useState<Datasheet[]>([]);
  const [uploading, setUploading] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void fetch(`/api/datasheet?projectId=${projectId}`)
      .then((r) => r.json())
      .then((d) => setDatasheets(d.datasheets ?? []))
      .catch(() => undefined);
  }, [projectId]);

  useEffect(refresh, [refresh]);

  const uploadDatasheet = useCallback(
    async (file: File) => {
      setUploading(true);
      setNote(null);
      try {
        const form = new FormData();
        form.append("file", file);
        const res = await fetch(`/api/datasheet?projectId=${projectId}`, {
          method: "POST",
          body: form,
        });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
        setNote(`"${d.title}" caricato (${d.pages} pagine, id ${d.id}): chiedi in chat di ricavarne il componente.`);
        refresh();
      } catch (err) {
        setNote(err instanceof Error ? err.message : String(err));
      } finally {
        setUploading(false);
      }
    },
    [projectId, refresh],
  );

  const uploadKicad = useCallback(async (files: FileList) => {
    setUploading(true);
    setNote(null);
    try {
      const form = new FormData();
      for (const file of Array.from(files)) form.append("file", file);
      const res = await fetch("/api/import/kicad", { method: "POST", body: form });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
      if (d.project) {
        window.location.search = `?project=${d.project.id}`;
        return;
      }
      setNote(
        `${d.components?.length ?? 0} footprint importati in libreria: usabili subito in qualunque progetto.`,
      );
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }, []);

  return (
    <SettingsShell
      title="Datasheet e import"
      subtitle="materiale sorgente per i componenti"
      projectId={projectId}
      user={user}
    >
      {note && (
        <p className="mb-5 rounded-lg bg-accent-wash px-3 py-2 text-xs leading-relaxed text-accent">
          {note}
        </p>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card
          title="Datasheet PDF"
          hint="L'agente legge il datasheet (pinout, package, land pattern) e ne ricava il componente di libreria con la geometria reale."
        >
          <label className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed border-line-strong px-4 py-8 text-center transition-colors hover:border-brand hover:bg-brand-wash/40">
            <svg viewBox="0 0 20 20" fill="none" className="h-6 w-6 text-faint">
              <path
                d="M10 13.5V4.5M10 4.5 6.5 8M10 4.5 13.5 8M3.5 14v1.5a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V14"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="text-sm font-medium text-muted">
              {uploading ? "Caricamento..." : "Carica un PDF"}
            </span>
            <span className="text-xs text-faint">max 30MB, testo estratto automaticamente</span>
            <input
              type="file"
              accept="application/pdf"
              className="hidden"
              disabled={uploading}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void uploadDatasheet(file);
              }}
            />
          </label>

          {datasheets.length === 0 ? (
            <div className="mt-4">
              <EmptyState title="Nessun datasheet in questo progetto" />
            </div>
          ) : (
            <ul className="mt-4 space-y-2">
              {datasheets.map((d) => (
                <li key={d.id} className="flex items-center gap-3 rounded-lg border border-line px-3.5 py-2.5">
                  <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4 flex-none text-faint">
                    <path
                      d="M5 3h7l3 3v11H5V3Zm7 0v3h3"
                      stroke="currentColor"
                      strokeWidth="1.3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  <p className="min-w-0 flex-1 truncate text-sm text-text" title={d.title}>
                    {d.title}
                  </p>
                  <Chip>id {d.id}</Chip>
                  {d.pages && <Chip>{d.pages} pagine</Chip>}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card
          title="Importa da KiCad"
          hint=".kicad_mod diventa un componente di libreria col footprint reale; .kicad_pcb (con o senza .kicad_sch) diventa un nuovo progetto completo di posizioni e connettività. Da Altium: apri in KiCad e salva come KiCad."
        >
          <label className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed border-line-strong px-4 py-8 text-center transition-colors hover:border-brand hover:bg-brand-wash/40">
            <svg viewBox="0 0 20 20" fill="none" className="h-6 w-6 text-faint">
              <path
                d="M4 4h12v12H4zM7 4v12M4 8h3M4 12h3M13 8h3M13 12h3"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="text-sm font-medium text-muted">
              {uploading ? "Caricamento..." : "Carica file KiCad"}
            </span>
            <span className="text-xs text-faint">
              .kicad_mod · .kicad_pcb · .kicad_sch — anche insieme
            </span>
            <input
              type="file"
              accept=".kicad_mod,.kicad_pcb,.kicad_sch"
              multiple
              className="hidden"
              disabled={uploading}
              onChange={(e) => {
                const list = e.target.files;
                e.target.value = "";
                if (list?.length) void uploadKicad(list);
              }}
            />
          </label>
        </Card>
      </div>
    </SettingsShell>
  );
}
