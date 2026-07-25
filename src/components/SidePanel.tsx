"use client";

import { useCallback, useEffect, useState } from "react";
import type { RailKey } from "./Rail";
import { Btn, Empty, Field, Select, Silk } from "./ui";

export interface LibraryItem {
  id: number;
  name: string;
  description: string;
  source: string;
  version: number;
}
interface Project {
  id: string;
  visibility: "private" | "org" | "link";
  access: "owner" | "org" | "shared";
  updatedAt: string;
}
interface Org {
  id: string;
  name: string;
  role: string;
}
interface Share {
  userId: string;
  email: string;
  role: "viewer" | "editor";
}
interface Member {
  userId: string;
  email: string;
  role: string;
}
interface Datasheet {
  id: number;
  title: string;
  pages: number | null;
}

const TITLES: Record<Exclude<RailKey, null>, string> = {
  projects: "Progetti",
  library: "Libreria componenti",
  datasheets: "Datasheet",
  team: "Team e condivisione",
};

export function SidePanel({
  panel,
  projectId,
  user,
  library,
  onClose,
  onUploadDatasheet,
  uploading,
}: {
  panel: Exclude<RailKey, null>;
  projectId: string;
  user: { email: string };
  library: LibraryItem[];
  onClose: () => void;
  onUploadDatasheet: (file: File) => void;
  uploading: boolean;
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [shares, setShares] = useState<Share[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [datasheets, setDatasheets] = useState<Datasheet[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    setNote(null);
    if (panel === "projects") {
      void fetch("/api/projects")
        .then((r) => r.json())
        .then((d) => {
          setProjects(d.projects ?? []);
          setOrgs(d.organizations ?? []);
        })
        .catch(() => setNote("impossibile caricare i progetti"));
    }
    if (panel === "datasheets") {
      void fetch(`/api/datasheet?projectId=${projectId}`)
        .then((r) => r.json())
        .then((d) => setDatasheets(d.datasheets ?? []))
        .catch(() => setNote("impossibile caricare i datasheet"));
    }
    if (panel === "team") {
      void fetch(`/api/projects/share?projectId=${projectId}`)
        .then((r) => r.json())
        .then((d) => setShares(d.shares ?? []))
        .catch(() => undefined);
      void fetch("/api/orgs")
        .then((r) => r.json())
        .then((d) => {
          setOrgs(d.organizations ?? []);
          const first = d.organizations?.[0];
          if (first) {
            void fetch(`/api/orgs?orgId=${first.id}`)
              .then((r) => r.json())
              .then((m) => setMembers(m.members ?? []))
              .catch(() => undefined);
          }
        })
        .catch(() => undefined);
    }
  }, [panel, projectId]);

  const post = useCallback(
    async (url: string, body: Record<string, unknown>) => {
      setBusy(true);
      setNote(null);
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await res.json().catch(() => ({}));
      setBusy(false);
      if (!res.ok) {
        setNote(d.error ?? `errore ${res.status}`);
        return null;
      }
      return d;
    },
    [],
  );

  return (
    <aside className="panel-in flex w-72 flex-none flex-col border-r border-edge bg-panel">
      <header className="flex h-12 flex-none items-center justify-between border-b border-edge px-3">
        <Silk>{TITLES[panel]}</Silk>
        <button
          type="button"
          onClick={onClose}
          className="text-faint transition-colors hover:text-ink"
          title="Chiudi"
        >
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {note && (
          <p className="mb-3 rounded border border-copper/40 bg-copper/10 px-2 py-1.5 text-[11px] text-copper">
            {note}
          </p>
        )}

        {panel === "projects" && (
          <div className="space-y-3">
            <Btn
              variant="solid"
              disabled={busy}
              onClick={async () => {
                const id = prompt("Identificativo del nuovo progetto:");
                if (!id) return;
                const d = await post("/api/projects", { id });
                if (d) window.location.search = `?project=${d.id}`;
              }}
            >
              + Nuovo progetto
            </Btn>
            <ul className="space-y-1">
              {projects.map((p) => (
                <li key={p.id}>
                  <a
                    href={`/?project=${p.id}`}
                    className={`block rounded-md border px-2.5 py-2 transition-colors ${
                      p.id === projectId
                        ? "border-solder-dim/50 bg-solder-dim/10"
                        : "border-edge hover:border-edge-bright hover:bg-raised"
                    }`}
                  >
                    <div className="font-mono text-xs text-ink">{p.id}</div>
                    <div className="mt-0.5 flex gap-2 font-mono text-[10px] text-faint">
                      <span>{p.access}</span>
                      <span>·</span>
                      <span>{p.visibility}</span>
                    </div>
                  </a>
                </li>
              ))}
              {projects.length === 0 && <Empty>Nessun progetto.</Empty>}
            </ul>
          </div>
        )}

        {panel === "library" && (
          <div className="space-y-3">
            <p className="text-[11px] leading-relaxed text-dim">
              Componenti riusabili in ogni progetto. Chiedi in chat di importarne uno da
              codice LCSC per avere il footprint reale del produttore.
            </p>
            <ul className="space-y-1">
              {library.map((c) => (
                <li
                  key={c.id}
                  className="rounded-md border border-edge px-2.5 py-2"
                  title={c.description}
                >
                  <div className="font-mono text-xs text-solder">{c.name}</div>
                  <div className="mt-0.5 font-mono text-[10px] text-faint">
                    v{c.version} · {c.source}
                  </div>
                </li>
              ))}
              {library.length === 0 && <Empty>Libreria vuota.</Empty>}
            </ul>
          </div>
        )}

        {panel === "datasheets" && (
          <div className="space-y-3">
            <label className="flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed border-edge-bright px-3 py-4 text-xs text-dim transition-colors hover:border-solder-dim hover:text-ink">
              {uploading ? "Caricamento..." : "Carica un PDF"}
              <input
                type="file"
                accept="application/pdf"
                className="hidden"
                disabled={uploading}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) onUploadDatasheet(file);
                }}
              />
            </label>
            <ul className="space-y-1">
              {datasheets.map((d) => (
                <li key={d.id} className="rounded-md border border-edge px-2.5 py-2">
                  <div className="truncate text-xs text-ink" title={d.title}>
                    {d.title}
                  </div>
                  <div className="mt-0.5 font-mono text-[10px] text-faint">
                    id {d.id}
                    {d.pages ? ` · ${d.pages} pagine` : ""}
                  </div>
                </li>
              ))}
              {datasheets.length === 0 && <Empty>Nessun datasheet caricato.</Empty>}
            </ul>
          </div>
        )}

        {panel === "team" && (
          <div className="space-y-5">
            <section className="space-y-2">
              <Silk>Condividi questo progetto</Silk>
              <form
                className="space-y-2"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const form = new FormData(e.currentTarget);
                  e.currentTarget.reset();
                  const d = await post("/api/projects/share", {
                    projectId,
                    email: String(form.get("email") ?? ""),
                    role: String(form.get("role") ?? "viewer"),
                  });
                  if (d?.shares) setShares(d.shares);
                  if (d?.share && !d.share.shared) setNote(d.share.reason);
                }}
              >
                <Field name="email" type="email" required placeholder="email" className="w-full" />
                <div className="flex gap-2">
                  <Select
                    name="role"
                    className="flex-1"
                    options={[
                      { value: "viewer", label: "può vedere" },
                      { value: "editor", label: "può modificare" },
                    ]}
                  />
                  <Btn type="submit" variant="solid" disabled={busy}>
                    Invia
                  </Btn>
                </div>
              </form>
              <ul className="space-y-1">
                {shares.map((s) => (
                  <li key={s.userId} className="flex items-center gap-2 text-[11px]">
                    <span className="min-w-0 flex-1 truncate text-dim">{s.email}</span>
                    <span className="font-mono text-[10px] text-faint">{s.role}</span>
                    <button
                      type="button"
                      disabled={busy}
                      className="text-faint transition-colors hover:text-alert"
                      onClick={async () => {
                        const d = await post("/api/projects/share", {
                          projectId,
                          removeUserId: s.userId,
                        });
                        if (d?.shares) setShares(d.shares);
                      }}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            </section>

            <section className="space-y-2">
              <Silk>Visibilità</Silk>
              <div className="flex flex-wrap gap-1.5">
                {(
                  [
                    ["private", "solo me"],
                    ["org", "tutta l'org"],
                    ["link", "chi ha il link"],
                  ] as const
                ).map(([value, label]) => (
                  <Btn
                    key={value}
                    disabled={busy}
                    onClick={() => void post("/api/projects/share", { projectId, visibility: value })}
                  >
                    {label}
                  </Btn>
                ))}
              </div>
            </section>

            <section className="space-y-2">
              <Silk>{orgs[0]?.name ?? "Organizzazione"}</Silk>
              <form
                className="space-y-2"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const form = new FormData(e.currentTarget);
                  e.currentTarget.reset();
                  if (!orgs[0]) return;
                  const d = await post("/api/orgs", {
                    action: "invite",
                    orgId: orgs[0].id,
                    email: String(form.get("email") ?? ""),
                    role: String(form.get("role") ?? "member"),
                  });
                  if (d?.members) setMembers(d.members);
                  if (d && d.joined === false) setNote("invito registrato: entrerà al primo accesso");
                }}
              >
                <Field name="email" type="email" required placeholder="invita per email" className="w-full" />
                <div className="flex gap-2">
                  <Select
                    name="role"
                    className="flex-1"
                    options={[
                      { value: "member", label: "membro" },
                      { value: "admin", label: "admin" },
                    ]}
                  />
                  <Btn type="submit" disabled={busy}>
                    Invita
                  </Btn>
                </div>
              </form>
              <ul className="space-y-1">
                {members.map((m) => (
                  <li key={m.userId} className="flex items-center gap-2 text-[11px]">
                    <span className="min-w-0 flex-1 truncate text-dim">{m.email}</span>
                    <span className="font-mono text-[10px] text-faint">{m.role}</span>
                    {m.email !== user.email && orgs[0] && (
                      <button
                        type="button"
                        disabled={busy}
                        className="text-faint transition-colors hover:text-alert"
                        onClick={async () => {
                          const d = await post("/api/orgs", {
                            action: "remove_member",
                            orgId: orgs[0].id,
                            userId: m.userId,
                          });
                          if (d?.members) setMembers(d.members);
                        }}
                      >
                        ×
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          </div>
        )}
      </div>
    </aside>
  );
}
