"use client";

import { useEffect, useState } from "react";
import { Card, SettingsShell } from "./SettingsShell";
import { Chip, EmptyState } from "./ui";

type LibraryItem = {
  id: number;
  name: string;
  description: string;
  source: string;
  version: number;
};

const SOURCE_LABELS: Record<string, string> = {
  lcsc: "LCSC/EasyEDA",
  datasheet: "datasheet",
  llm: "agente",
  manual: "manuale",
  kicad: "KiCad",
};

export function LibraryPage({
  projectId,
  user,
}: {
  projectId: string;
  user: { email: string; name: string | null };
}) {
  const [library, setLibrary] = useState<LibraryItem[]>([]);

  useEffect(() => {
    void fetch(`/api/project?projectId=${projectId}`)
      .then((r) => r.json())
      .then((d) => setLibrary(d.library ?? []))
      .catch(() => undefined);
  }, [projectId]);

  const bySource = library.reduce<Record<string, number>>((acc, c) => {
    acc[c.source] = (acc[c.source] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <SettingsShell
      title="Libreria componenti"
      subtitle="footprint riusabili, condivisi tra tutti i progetti"
      projectId={projectId}
      user={user}
    >
      <Card
        title="Come cresce la libreria"
        hint="Chiedi in chat «importa il componente LCSC C7593»: il footprint arriva reale dal produttore (EasyEDA). In alternativa: da un datasheet PDF o da un file .kicad_mod, sempre con geometria vera — mai inventata."
      >
        <div className="flex flex-wrap gap-2">
          {Object.entries(bySource).map(([source, count]) => (
            <Chip key={source} tone="neutral">
              {SOURCE_LABELS[source] ?? source}: {count}
            </Chip>
          ))}
          {library.length > 0 && <Chip tone="brand">{library.length} componenti</Chip>}
        </div>
      </Card>

      <div className="mt-5">
        {library.length === 0 ? (
          <EmptyState
            title="Libreria vuota"
            hint="Esempio: «importa il componente LCSC C7593 in libreria»"
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {library.map((c) => (
              <a
                key={c.id}
                href={`/library/${encodeURIComponent(c.name)}?project=${projectId}`}
                className="card block p-4 transition-all hover:-translate-y-0.5 hover:border-line-strong"
                title={c.description}
              >
                <p className="truncate font-mono text-sm font-semibold text-text">{c.name}</p>
                {c.description && (
                  <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-faint">
                    {c.description}
                  </p>
                )}
                <div className="mt-3 flex items-center gap-1.5">
                  <Chip tone="brand">v{c.version}</Chip>
                  <Chip>{SOURCE_LABELS[c.source] ?? c.source}</Chip>
                </div>
              </a>
            ))}
          </div>
        )}
      </div>
    </SettingsShell>
  );
}
