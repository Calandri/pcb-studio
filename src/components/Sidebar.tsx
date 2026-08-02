"use client";

import { useCallback, useEffect, useState } from "react";
import { InspectPanel } from "./InspectPanel";
import { Btn, Chip, EmptyState, Field, SectionLabel, Select } from "./ui";
import { LogoMark } from "./Logo";

export type SectionKey = "org" | "library" | "inspect" | "datasheets" | "team";

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

const NAV: Array<{ key: SectionKey; label: string; icon: React.ReactNode }> = [
  {
    key: "org",
    label: "Organizzazione",
    icon: (
      <path
        d="M3.8 8.2 10 4l6.2 4.2M5 9.5V16h10V9.5M8 16v-4h4v4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
  },
  {
    key: "library",
    label: "Componenti",
    icon: (
      <>
        <rect x="6.2" y="6.2" width="7.6" height="7.6" rx="1.2" stroke="currentColor" strokeWidth="1.4" />
        <path
          d="M8.2 6.2V3.8M11.8 6.2V3.8M8.2 13.8v2.4M11.8 13.8v2.4M6.2 8.2H3.8M6.2 11.8H3.8M13.8 8.2h2.4M13.8 11.8h2.4"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      </>
    ),
  },
  {
    key: "inspect",
    label: "Ispeziona",
    icon: (
      <>
        <circle cx="9" cy="9" r="4.6" stroke="currentColor" strokeWidth="1.4" />
        <path d="M12.4 12.4 16.6 16.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        <path d="M7.2 9h3.6M9 7.2v3.6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      </>
    ),
  },
  {
    key: "datasheets",
    label: "Datasheet",
    icon: (
      <>
        <path d="M5.2 3.2h5.6l4 4v9.6H5.2V3.2Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
        <path d="M10.6 3.4v3.8h3.8M7.6 11h4.8M7.6 13.4h3.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </>
    ),
  },
  {
    key: "team",
    label: "Team",
    icon: (
      <>
        <circle cx="7.8" cy="7.2" r="2.6" stroke="currentColor" strokeWidth="1.4" />
        <path d="M3.2 15.8c.5-2.6 2.3-4.1 4.6-4.1s4.1 1.5 4.6 4.1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        <path d="M13.4 5.4a2.4 2.4 0 0 1 0 4.5M14.6 12.4c1.5.5 2.4 1.7 2.7 3.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </>
    ),
  },
];

export function Sidebar({
  section,
  onSection,
  projectId,
  user,
  library,
  uploading,
  onUploadDatasheet,
  onImportKicad,
  collapsed,
  onToggleCollapsed,
  circuitJson,
  circuitStale,
  onAsk,
}: {
  section: SectionKey;
  onSection: (s: SectionKey) => void;
  projectId: string;
  user: { email: string; name: string | null };
  library: LibraryItem[];
  uploading: boolean;
  onUploadDatasheet: (file: File) => void;
  onImportKicad: (files: FileList) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  circuitJson: unknown[] | null;
  circuitStale: boolean;
  onAsk: (prompt: string) => void;
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [shares, setShares] = useState<Share[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [datasheets, setDatasheets] = useState<Datasheet[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [tokens, setTokens] = useState<Array<{ id: string; name: string; prefix: string }>>([]);
  const [freshToken, setFreshToken] = useState<string | null>(null);

  useEffect(() => {
    void fetch("/api/projects")
      .then((r) => r.json())
      .then((d) => {
        setProjects(d.projects ?? []);
        setOrgs(d.organizations ?? []);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    // a message about the section you have just left has nothing to say about
    // the one you are opening
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNote(null);
    if (section === "datasheets") {
      void fetch(`/api/datasheet?projectId=${projectId}`)
        .then((r) => r.json())
        .then((d) => setDatasheets(d.datasheets ?? []))
        .catch(() => undefined);
    }
    if (section === "team") {
      void fetch("/api/tokens")
        .then((r) => r.json())
        .then((d) => setTokens(d.tokens ?? []))
        .catch(() => undefined);
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
  }, [section, projectId]);

  const post = useCallback(async (url: string, body: Record<string, unknown>) => {
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
      setNote(d.error ?? `Errore ${res.status}`);
      return null;
    }
    return d;
  }, []);

  const counts: Record<SectionKey, number | undefined> = {
    org: projects.length || undefined,
    library: library.length || undefined,
    inspect: undefined,
    datasheets: datasheets.length || undefined,
    team: undefined,
  };

  return (
    <aside
      className={`flex flex-none flex-col border-r border-line bg-surface transition-[width] duration-200 ${
        collapsed ? "w-[60px]" : "w-[292px]"
      }`}
    >
      <div className={`flex items-center py-4 ${collapsed ? "flex-col gap-2 px-2" : "gap-2.5 px-4"}`}>
        <button
          type="button"
          onClick={onToggleCollapsed}
          title={collapsed ? "Espandi il menu" : "Riduci il menu"}
          className="group relative flex h-8 w-8 flex-none items-center justify-center rounded-lg transition-transform hover:scale-105"
        >
          <LogoMark size={32} className="group-hover:opacity-0" />
          <svg
            viewBox="0 0 20 20"
            fill="none"
            className="absolute h-4 w-4 opacity-0 transition-opacity group-hover:opacity-100"
          >
            <path
              d={collapsed ? "M7.5 5 12.5 10l-5 5" : "M12.5 5 7.5 10l5 5"}
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        {!collapsed && (
          <span className="flex flex-col leading-none">
            <span className="text-[15px] font-bold tracking-tight text-text">PCB Studio</span>
            <span className="mt-[3px] text-[10px] text-faint">AI PCB Designer</span>
          </span>
        )}
      </div>

      <nav className={`flex gap-1 pb-3 ${collapsed ? "flex-col items-center px-2" : "px-3"}`}>
        {NAV.map((item) => {
          const active = section === item.key;
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => onSection(item.key)}
              title={item.label}
              className={`group relative flex items-center justify-center rounded-lg transition-colors ${
                collapsed ? "h-10 w-10" : "flex-1 flex-col gap-1 px-1 py-2"
              } ${
                active ? "bg-brand-wash text-brand-strong" : "text-faint hover:bg-sunken hover:text-muted"
              }`}
            >
              <svg viewBox="0 0 20 20" fill="none" className="h-[17px] w-[17px]">
                {item.icon}
              </svg>
              {!collapsed && <span className="text-[10px] font-semibold">{item.label}</span>}
              {counts[item.key] !== undefined && (
                <span className="absolute right-1 top-0.5 font-mono text-[9px] text-faint">
                  {counts[item.key]}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div
        className={`min-h-0 flex-1 overflow-y-auto border-t border-line px-4 py-4 ${
          collapsed ? "hidden" : ""
        }`}
      >
        {note && (
          <p className="mb-3 rounded-lg bg-accent-wash px-3 py-2 text-xs leading-relaxed text-accent">
            {note}
          </p>
        )}

        {section === "library" && (
          <div className="slide-in space-y-3">
            <SectionLabel>Componenti riusabili</SectionLabel>
            <p className="text-xs leading-relaxed text-faint">
              Chiedi in chat di importare un componente dal suo codice LCSC: arriva col
              footprint reale del produttore.
            </p>
            <ul className="space-y-1.5">
              {library.map((c) => (
                <li
                  key={c.id}
                  className="rounded-lg border border-line px-3 py-2.5"
                  title={c.description}
                >
                  <p className="truncate font-mono text-xs font-medium text-text">{c.name}</p>
                  <div className="mt-1 flex items-center gap-1.5">
                    <Chip tone="brand">v{c.version}</Chip>
                    <Chip>{c.source}</Chip>
                  </div>
                </li>
              ))}
              {library.length === 0 && (
                <EmptyState
                  title="Libreria vuota"
                  hint="Esempio: «importa il componente LCSC C7593»"
                />
              )}
            </ul>
          </div>
        )}

        {section === "inspect" && (
          <InspectPanel circuitJson={circuitJson} stale={circuitStale} projectId={projectId} onAsk={onAsk} />
        )}

        {section === "datasheets" && (
          <div className="slide-in space-y-3">
            <SectionLabel>Datasheet del progetto</SectionLabel>
            <label className="flex cursor-pointer flex-col items-center gap-1.5 rounded-xl border border-dashed border-line-strong px-4 py-6 text-center transition-colors hover:border-brand hover:bg-brand-wash/40">
              <svg viewBox="0 0 20 20" fill="none" className="h-5 w-5 text-faint">
                <path
                  d="M10 13.5V4.5M10 4.5 6.5 8M10 4.5 13.5 8M3.5 14v1.5a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V14"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span className="text-xs font-medium text-muted">
                {uploading ? "Caricamento..." : "Carica un PDF"}
              </span>
              <span className="text-[11px] text-faint">
                l&apos;agente ne ricava il componente
              </span>
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
            <label className="flex cursor-pointer flex-col items-center gap-1.5 rounded-xl border border-dashed border-line-strong px-4 py-6 text-center transition-colors hover:border-brand hover:bg-brand-wash/40">
              <svg viewBox="0 0 20 20" fill="none" className="h-5 w-5 text-faint">
                <path
                  d="M4 4h12v12H4zM7 4v12M4 8h3M4 12h3M13 8h3M13 12h3"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span className="text-xs font-medium text-muted">
                {uploading ? "Caricamento..." : "Importa da KiCad o Altium"}
              </span>
              <span className="text-[11px] text-faint">
                .kicad_pcb o .PcbDoc come nuovo progetto, .kicad_mod e .PcbLib in
                libreria
              </span>
              {/*
                One control for both: the file says which CAD it comes from, and
                asking the person to pick the right button first is asking them
                to do the computer's job.
              */}
              <input
                type="file"
                accept=".kicad_mod,.kicad_pcb,.kicad_sch,.PcbDoc,.SchDoc,.PcbLib,.SchLib,.PrjPcb,.IntLib"
                multiple
                className="hidden"
                disabled={uploading}
                onChange={(e) => {
                  const list = e.target.files;
                  e.target.value = "";
                  if (list?.length) onImportKicad(list);
                }}
              />
            </label>
            <ul className="space-y-1.5">
              {datasheets.map((d) => (
                <li key={d.id} className="rounded-lg border border-line px-3 py-2.5">
                  <p className="truncate text-xs font-medium text-text" title={d.title}>
                    {d.title}
                  </p>
                  <div className="mt-1 flex items-center gap-1.5">
                    <Chip>id {d.id}</Chip>
                    {d.pages && <Chip>{d.pages} pagine</Chip>}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {section === "team" && (
          <div className="slide-in space-y-6">
            <section className="space-y-2.5">
              <SectionLabel>Condividi questo progetto</SectionLabel>
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
                <Field name="email" type="email" required placeholder="Email" className="w-full" />
                <div className="flex gap-2">
                  <Select
                    name="role"
                    className="flex-1"
                    options={[
                      { value: "viewer", label: "Può vedere" },
                      { value: "editor", label: "Può modificare" },
                    ]}
                  />
                  <Btn type="submit" variant="primary" disabled={busy}>
                    Invita
                  </Btn>
                </div>
              </form>
              {shares.length > 0 && (
                <ul className="space-y-1">
                  {shares.map((s) => (
                    <li
                      key={s.userId}
                      className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-sunken"
                    >
                      <span className="min-w-0 flex-1 truncate text-xs text-muted">{s.email}</span>
                      <Chip>{s.role === "editor" ? "modifica" : "vede"}</Chip>
                      <button
                        type="button"
                        disabled={busy}
                        title="Rimuovi"
                        className="text-faint transition-colors hover:text-danger"
                        onClick={async () => {
                          const d = await post("/api/projects/share", {
                            projectId,
                            removeUserId: s.userId,
                          });
                          if (d?.shares) setShares(d.shares);
                        }}
                      >
                        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none">
                          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                        </svg>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="space-y-2.5">
              <SectionLabel>Chi può vederlo</SectionLabel>
              <div className="grid gap-1.5">
                {(
                  [
                    ["private", "Solo io", "Nessun altro vi accede"],
                    ["org", "Tutta l'organizzazione", "Chi è nel tuo team"],
                    ["link", "Chi ha il link", "In sola lettura"],
                  ] as const
                ).map(([value, label, hint]) => (
                  <button
                    key={value}
                    type="button"
                    disabled={busy}
                    onClick={() => void post("/api/projects/share", { projectId, visibility: value })}
                    className="rounded-lg border border-line px-3 py-2 text-left transition-colors hover:border-brand hover:bg-brand-wash/40"
                  >
                    <p className="text-xs font-medium text-text">{label}</p>
                    <p className="text-[11px] text-faint">{hint}</p>
                  </button>
                ))}
              </div>
            </section>

            <section className="space-y-2.5">
              <SectionLabel>{orgs[0]?.name ?? "Organizzazione"}</SectionLabel>
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
                  if (d && d.joined === false) setNote("Invito registrato: entrerà al primo accesso.");
                }}
              >
                <Field name="email" type="email" required placeholder="Invita per email" className="w-full" />
                <div className="flex gap-2">
                  <Select
                    name="role"
                    className="flex-1"
                    options={[
                      { value: "member", label: "Membro" },
                      { value: "admin", label: "Amministratore" },
                    ]}
                  />
                  <Btn type="submit" disabled={busy}>
                    Aggiungi
                  </Btn>
                </div>
              </form>
              <ul className="space-y-1">
                {members.map((m) => (
                  <li
                    key={m.userId}
                    className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-sunken"
                  >
                    <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-sunken text-[10px] font-semibold text-muted">
                      {m.email.slice(0, 2).toUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs text-muted">{m.email}</span>
                    <Chip tone={m.role === "owner" ? "brand" : "neutral"}>{m.role}</Chip>
                    {m.email !== user.email && orgs[0] && (
                      <button
                        type="button"
                        disabled={busy}
                        title="Rimuovi dal team"
                        className="text-faint transition-colors hover:text-danger"
                        onClick={async () => {
                          const d = await post("/api/orgs", {
                            action: "remove_member",
                            orgId: orgs[0].id,
                            userId: m.userId,
                          });
                          if (d?.members) setMembers(d.members);
                        }}
                      >
                        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none">
                          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                        </svg>
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </section>

            <section className="space-y-2.5">
              <SectionLabel>Accesso da agenti esterni (MCP)</SectionLabel>
              <p className="text-[11px] leading-relaxed text-faint">
                Un token permette a Claude Code o a un altro agente di progettare
                sulle tue schede usando gli stessi strumenti dell&apos;app.
              </p>
              {freshToken && (
                <div className="space-y-1.5 rounded-lg bg-brand-wash p-2.5">
                  <p className="text-[11px] font-semibold text-brand-strong">
                    Copialo ora: non verrà più mostrato.
                  </p>
                  <code className="block break-all rounded bg-surface px-2 py-1.5 font-mono text-[10px] text-text">
                    {freshToken}
                  </code>
                  <Btn size="sm" onClick={() => setFreshToken(null)}>
                    Ho copiato
                  </Btn>
                </div>
              )}
              <Btn
                size="sm"
                disabled={busy}
                onClick={async () => {
                  const d = await post("/api/tokens", { action: "create", name: "Claude Code" });
                  if (d) {
                    setFreshToken(d.token);
                    setTokens(d.tokens ?? []);
                  }
                }}
              >
                + Genera token
              </Btn>
              <ul className="space-y-1">
                {tokens.map((t) => (
                  <li key={t.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-sunken">
                    <span className="min-w-0 flex-1 truncate text-xs text-muted">{t.name}</span>
                    <Chip>{t.prefix}…</Chip>
                    <button
                      type="button"
                      disabled={busy}
                      title="Revoca"
                      className="text-faint transition-colors hover:text-danger"
                      onClick={async () => {
                        const d = await post("/api/tokens", { action: "revoke", id: t.id });
                        if (d) setTokens(d.tokens ?? []);
                      }}
                    >
                      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none">
                        <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                      </svg>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        )}
      </div>

      <div
        className={`flex border-t border-line py-3 ${
          collapsed ? "flex-col items-center gap-2 px-2" : "items-center gap-2 px-4"
        }`}
      >
        <span
          className="flex h-7 w-7 flex-none items-center justify-center rounded-full bg-brand-wash text-[10px] font-bold text-brand-strong"
          title={user.email}
        >
          {user.email.slice(0, 2).toUpperCase()}
        </span>
        {!collapsed && (
          <span className="min-w-0 flex-1 truncate text-xs text-muted" title={user.email}>
            {user.email}
          </span>
        )}
        {/* /api/auth/signout is a route, not a page: <Link> would navigate to it on the client and the session would never be closed */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a
          href="/api/auth/signout"
          title="Esci"
          className="rounded-lg p-1.5 text-faint transition-colors hover:bg-danger-wash hover:text-danger"
        >
          <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none">
            <path
              d="M6 14H3.5a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1H6M10.5 11 13.5 8l-3-3M13.5 8H6"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </a>
      </div>
    </aside>
  );
}
