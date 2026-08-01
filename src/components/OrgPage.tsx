"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, SettingsShell } from "./SettingsShell";
import { Btn, Chip, EmptyState, Field, Select } from "./ui";

type Project = { id: string; access?: string; visibility?: string; updated_at?: string };
type Member = { userId: string; email: string; role: string };
type Token = { id: string; name: string; prefix: string };
type LibraryItem = { id: number; name: string; description: string; source: string; version: number };
type Datasheet = { id: number; title: string; pages?: number };
type MaskedKey = { provider: "glm" | "gemini"; hint: string; scope: "user" | "org"; orgId: string | null };

const PROVIDER_LABELS: Record<MaskedKey["provider"], string> = {
  glm: "GLM (Z.ai)",
  gemini: "Gemini (Google)",
};

const SOURCE_LABELS: Record<string, string> = {
  lcsc: "LCSC",
  datasheet: "datasheet",
  llm: "agente",
  manual: "manuale",
  kicad: "KiCad",
  altium: "Altium",
};

/**
 * Organization dashboard (level ABOVE the projects):
 * projects, shared library, current project's datasheets, members, MCP tokens.
 */
export function OrgPage({
  currentProjectId,
  user,
}: {
  currentProjectId: string;
  user: { email: string; name: string | null };
}) {
  const [orgs, setOrgs] = useState<Array<{ id: string; name: string }>>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [tokens, setTokens] = useState<Token[]>([]);
  const [library, setLibrary] = useState<LibraryItem[]>([]);
  const [datasheets, setDatasheets] = useState<Datasheet[]>([]);
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [keys, setKeys] = useState<{ user: MaskedKey[]; org: MaskedKey[] }>({ user: [], org: [] });
  const [orgRoles, setOrgRoles] = useState<Array<{ id: string; name: string; role: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const reloadKeys = useCallback(() => {
    void fetch("/api/keys")
      .then((r) => r.json())
      .then((d) => {
        setKeys(d.keys ?? { user: [], org: [] });
        setOrgRoles(d.orgs ?? []);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    reloadKeys();
  }, [reloadKeys]);

  useEffect(() => {
    void fetch("/api/projects")
      .then((r) => r.json())
      .then((d) => setProjects(d.projects ?? []))
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
    void fetch("/api/tokens")
      .then((r) => r.json())
      .then((d) => setTokens(d.tokens ?? []))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    void fetch(`/api/project?projectId=${currentProjectId}`)
      .then((r) => r.json())
      .then((d) => setLibrary(d.library ?? []))
      .catch(() => undefined);
    void fetch(`/api/datasheet?projectId=${currentProjectId}`)
      .then((r) => r.json())
      .then((d) => setDatasheets(d.datasheets ?? []))
      .catch(() => undefined);
  }, [currentProjectId]);

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

  const orgName = orgs[0]?.name ?? "Organizzazione";

  return (
    <SettingsShell
      title={orgName}
      subtitle="membri, progetti e accessi"
      projectId={currentProjectId}
      user={user}
    >
      {note && (
        <p className="mb-5 rounded-lg bg-accent-wash px-3 py-2 text-xs leading-relaxed text-accent">
          {note}
        </p>
      )}

      {/* organization hero */}
      <div className="card mb-6 flex flex-wrap items-center gap-5 p-5">
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-wash text-lg font-bold text-brand-strong">
          {orgName.slice(0, 2).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-bold tracking-tight text-text">{orgName}</h2>
          <p className="mt-0.5 text-xs text-faint">
            {projects.length} progett{projects.length === 1 ? "o" : "i"} · {members.length} membr
            {members.length === 1 ? "o" : "i"} · {library.length} componenti in libreria
          </p>
        </div>
        <Btn
          variant="primary"
          disabled={busy}
          onClick={async () => {
            const id = prompt("Nome del nuovo progetto:");
            if (!id) return;
            const d = await post("/api/projects", { id });
            if (d?.id) window.location.href = `/?project=${d.id}`;
          }}
        >
          + Nuovo progetto
        </Btn>
      </div>

      {/* projects */}
      <h2 className="section-label mb-3">Progetti</h2>
      {projects.length === 0 ? (
        <EmptyState title="Nessun progetto" hint="Crea il primo, oppure importa una scheda KiCad" />
      ) : (
        <div className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => {
            const active = p.id === currentProjectId;
            return (
              <div
                key={p.id}
                className={`card group relative p-4 transition-all hover:-translate-y-0.5 hover:border-line-strong ${
                  active ? "ring-2 ring-brand/40" : ""
                }`}
              >
                <a href={`/?project=${p.id}`} className="block">
                  <div className="flex items-start justify-between gap-2 pr-8">
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
                <a
                  href={`/team?project=${p.id}`}
                  title={`Impostazioni di ${p.id} (visibilità e inviti)`}
                  className="absolute right-3 top-3 rounded-lg p-1.5 text-faint transition-colors hover:bg-sunken hover:text-text"
                >
                  <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4">
                    <path d="M10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" stroke="currentColor" strokeWidth="1.4" />
                    <path
                      d="M16.5 10a6.6 6.6 0 0 0-.1-1.1l1.6-1.2-1.5-2.6-1.9.8c-.5-.4-1.1-.8-1.7-1L12.5 2h-3L8.7 4.9c-.6.2-1.2.6-1.7 1l-1.9-.8-1.5 2.6L5.2 8.9a6.6 6.6 0 0 0 0 2.2l-1.6 1.2 1.5 2.6 1.9-.8c.5.4 1.1.8 1.7 1l.4 2.9h3l.4-2.9c.6-.2 1.2-.6 1.7-1l1.9.8 1.5-2.6-1.6-1.2c.1-.3.1-.7.1-1.1Z"
                      stroke="currentColor"
                      strokeWidth="1.2"
                      strokeLinejoin="round"
                    />
                  </svg>
                </a>
              </div>
            );
          })}
        </div>
      )}

      {/* library + datasheets of the current project */}
      <div className="mb-8 grid gap-5 lg:grid-cols-2">
        <Card
          title="Libreria componenti"
          hint="Footprint riusabili condivisi da tutti i progetti dell'organizzazione."
        >
          {library.length === 0 ? (
            <EmptyState
              title="Libreria vuota"
              hint="Esempio in chat: «importa il componente LCSC C7593»"
            />
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2">
              {library.slice(0, 8).map((c) => (
                <li key={c.id} className="rounded-lg border border-line px-3 py-2.5" title={c.description}>
                  <p className="truncate font-mono text-xs font-semibold text-text">{c.name}</p>
                  <div className="mt-1 flex items-center gap-1.5">
                    <Chip tone="brand">v{c.version}</Chip>
                    <Chip>{SOURCE_LABELS[c.source] ?? c.source}</Chip>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-4">
            <a href={`/library?project=${currentProjectId}`} className="text-xs font-medium text-brand-strong hover:underline">
              Apri la libreria completa →
            </a>
          </div>
        </Card>

        <Card
          title={`Datasheet di ${currentProjectId}`}
          hint="PDF sorgente per ricavare componenti con geometria reale."
        >
          {datasheets.length === 0 ? (
            <EmptyState title="Nessun datasheet" hint="Caricali dalla pagina Datasheet" />
          ) : (
            <ul className="space-y-2">
              {datasheets.slice(0, 6).map((d) => (
                <li key={d.id} className="flex items-center gap-3 rounded-lg border border-line px-3 py-2">
                  <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4 flex-none text-faint">
                    <path
                      d="M5 3h7l3 3v11H5V3Zm7 0v3h3"
                      stroke="currentColor"
                      strokeWidth="1.3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  <p className="min-w-0 flex-1 truncate text-xs text-text" title={d.title}>
                    {d.title}
                  </p>
                  {d.pages && <Chip>{d.pages} p.</Chip>}
                </li>
              ))}
            </ul>
          )}
          <div className="mt-4">
            <a href={`/datasheets?project=${currentProjectId}`} className="text-xs font-medium text-brand-strong hover:underline">
              Gestisci datasheet e import KiCad →
            </a>
          </div>
        </Card>
      </div>

      {/* members + agents */}
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Membri" hint="I membri dell'organizzazione vedono i progetti condivisi con il team.">
          <form
            className="flex flex-col gap-2 sm:flex-row"
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
            <Field name="email" type="email" required placeholder="Invita per email" className="flex-1" />
            <Select
              name="role"
              options={[
                { value: "member", label: "Membro" },
                { value: "admin", label: "Amministratore" },
              ]}
            />
            <Btn type="submit" disabled={busy}>
              Aggiungi
            </Btn>
          </form>
          {members.length > 0 && (
            <ul className="mt-4 divide-y divide-line">
              {members.map((m) => (
                <li key={m.userId} className="flex items-center gap-3 py-2.5">
                  <span className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-sunken text-[10px] font-semibold text-muted">
                    {m.email.slice(0, 2).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-muted">{m.email}</span>
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
                      <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none">
                        <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                      </svg>
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card
          title="Accesso da agenti esterni (MCP)"
          hint="Un token permette a Claude Code o a un altro agente di progettare sulle schede usando gli stessi strumenti dell'app."
        >
          {freshToken && (
            <div className="mb-4 space-y-2 rounded-xl bg-brand-wash p-3.5">
              <p className="text-xs font-semibold text-brand-strong">
                Copialo ora: non verrà più mostrato.
              </p>
              <code className="block break-all rounded-lg bg-surface px-3 py-2 font-mono text-[11px] text-text">
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
          {tokens.length > 0 && (
            <ul className="mt-4 divide-y divide-line">
              {tokens.map((t) => (
                <li key={t.id} className="flex items-center gap-3 py-2.5">
                  <span className="min-w-0 flex-1 truncate text-sm text-muted">{t.name}</span>
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
                    <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none">
                      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card
          title="Chiavi AI del copilota"
          hint="Il copilota si paga con le vostre chiavi: le personali hanno la precedenza su quelle dell'organizzazione, che restano come ripiego. Senza chiavi si usano quelle del server."
        >
          {keys.user.length + keys.org.length > 0 && (
            <ul className="mb-4 divide-y divide-line">
              {[...keys.user, ...keys.org].map((k) => (
                <li key={`${k.scope}-${k.provider}-${k.orgId ?? ""}`} className="flex items-center gap-3 py-2.5">
                  <span className="min-w-0 flex-1 truncate text-sm text-muted">
                    {PROVIDER_LABELS[k.provider]}
                    <span className="ml-2 font-mono text-xs text-faint">••••{k.hint}</span>
                  </span>
                  <Chip tone={k.scope === "user" ? "brand" : "accent"}>
                    {k.scope === "user" ? "mia" : "organizzazione"}
                  </Chip>
                  <button
                    type="button"
                    disabled={busy}
                    title="Elimina la chiave"
                    className="text-faint transition-colors hover:text-danger"
                    onClick={async () => {
                      const params = new URLSearchParams({
                        provider: k.provider,
                        scope: k.scope,
                        ...(k.orgId ? { orgId: k.orgId } : {}),
                      });
                      const res = await fetch(`/api/keys?${params}`, { method: "DELETE" });
                      if (res.ok) reloadKeys();
                      else setNote("Eliminazione non riuscita");
                    }}
                  >
                    <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none">
                      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <form
            className="flex flex-col gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              const formEl = e.currentTarget;
              const form = new FormData(formEl);
              const scope = String(form.get("scope") ?? "user");
              const d = await post("/api/keys", {
                provider: String(form.get("provider") ?? "glm"),
                scope,
                orgId: orgs[0]?.id,
                key: String(form.get("key") ?? ""),
              });
              if (d) {
                formEl.reset();
                reloadKeys();
              }
            }}
          >
            <div className="flex flex-col gap-2 sm:flex-row">
              <Select
                name="provider"
                options={[
                  { value: "glm", label: "GLM (Z.ai)" },
                  { value: "gemini", label: "Gemini (Google)" },
                ]}
              />
              <Select
                name="scope"
                options={[
                  { value: "user", label: "Chiave mia" },
                  ...(orgRoles.some((o) => o.role === "owner" || o.role === "admin")
                    ? [{ value: "org", label: "Chiave organizzazione" }]
                    : []),
                ]}
              />
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Field
                name="key"
                type="password"
                required
                placeholder="Incolla la chiave API"
                className="flex-1"
              />
              <Btn type="submit" disabled={busy}>
                Salva
              </Btn>
            </div>
            <p className="text-[11px] leading-relaxed text-faint">
              La chiave viene cifrata prima di essere salvata e non viene mai mostrata intera.
            </p>
          </form>
        </Card>
      </div>
    </SettingsShell>
  );
}
