"use client";

import { useEffect, useState } from "react";
import { Card, SettingsShell } from "./SettingsShell";
import { Btn, Chip, EmptyState } from "./ui";

type Project = {
  id: string;
  access?: string;
  visibility?: string;
  updated_at?: string;
};

export function ProjectsPage({
  projectId,
  user,
}: {
  projectId: string;
  user: { email: string; name: string | null };
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void fetch("/api/projects")
      .then((r) => r.json())
      .then((d) => setProjects(d.projects ?? []))
      .catch(() => undefined);
  }, []);

  return (
    <SettingsShell
      title="Progetti"
      subtitle="le tue schede"
      projectId={projectId}
      user={user}
    >
      <div className="mb-5 flex items-center justify-between">
        <p className="text-xs text-faint">
          {projects.length} progett{projects.length === 1 ? "o" : "i"} accessibil
          {projects.length === 1 ? "e" : "i"}
        </p>
        <Btn
          variant="primary"
          disabled={busy}
          onClick={async () => {
            const id = prompt("Nome del nuovo progetto:");
            if (!id) return;
            setBusy(true);
            const d = await fetch("/api/projects", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ id }),
            }).then((r) => r.json().catch(() => null));
            setBusy(false);
            if (d?.id) window.location.search = `?project=${d.id}`;
          }}
        >
          + Nuovo progetto
        </Btn>
      </div>

      {projects.length === 0 ? (
        <EmptyState
          title="Nessun progetto ancora"
          hint="Crea il primo, oppure importa una scheda KiCad dalla pagina Datasheet"
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => {
            const active = p.id === projectId;
            return (
              <a
                key={p.id}
                href={`/?project=${p.id}`}
                className={`card group p-4 transition-all hover:-translate-y-0.5 ${
                  active ? "ring-2 ring-brand/40" : ""
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 flex-1 truncate text-sm font-semibold text-text group-hover:text-brand-strong">
                    {p.id}
                  </p>
                  {active && <Chip tone="brand">aperto</Chip>}
                </div>
                <div className="mt-3 flex items-center gap-1.5">
                  {p.access === "shared" && <Chip>condiviso</Chip>}
                  {p.visibility === "private" && <Chip>privato</Chip>}
                  {p.visibility === "org" && <Chip tone="accent">team</Chip>}
                  {p.visibility === "link" && <Chip tone="accent">link</Chip>}
                </div>
              </a>
            );
          })}
        </div>
      )}
    </SettingsShell>
  );
}
