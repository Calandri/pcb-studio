"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Btn, Chip, EmptyState, Field, Select } from "./ui";

/* Admin console ("ORG and users" redesign, Niccolo's mockup):
   PLATFORM sidebar with 5 sections + tables. Same palette as the Studio. */

type SectionId = "super" | "users" | "sheets" | "projects" | "parts";

const SECTIONS: Array<{ id: SectionId; name: string; cta: string }> = [
  { id: "super", name: "Super admin", cta: "Nuova organizzazione" },
  { id: "users", name: "Utenti", cta: "Invita utente" },
  { id: "sheets", name: "Gestione datasheet", cta: "Carica datasheet" },
  { id: "projects", name: "Gestione progetti", cta: "Nuovo progetto" },
  { id: "parts", name: "Gestione componenti", cta: "Nuovo componente" },
];

type Project = {
  id: string;
  name?: string;
  visibility?: string;
  access?: string;
  orgId?: string | null;
  createdBy?: string | null;
  updatedAt?: string;
  checks?: { drcViolations: number; prcViolations: number; allGreen: boolean; checksStale: boolean } | null;
};
type Org = { id: string; name: string; slug?: string; plan?: string };
type Member = { userId: string; email: string; role: string };
type Token = { id: string; name: string; prefix: string };
type LibraryItem = { id: number; name: string; description: string; source: string; sourceRef: string | null; version: number; code?: string };
type Datasheet = { id: number; title: string; pages?: number };

const G = "#0BA36C";
const W = "#E8B23B";
const R = "#FF6B5A";

const PART_STATUS: Record<string, { label: string; ink: string }> = {
  lcsc: { label: "Verificato", ink: G },
  kicad: { label: "Verificato", ink: G },
  datasheet: { label: "Geometria da PDF", ink: W },
  llm: { label: "Da verificare", ink: W },
  manual: { label: "Da verificare", ink: W },
};

function pinCountOf(code: string | undefined): string {
  if (!code) return "—";
  const pads = code.match(/portHints=/g)?.length ?? 0;
  return pads > 0 ? String(pads) : "—";
}

export function OrgConsole({
  projectId,
  user,
}: {
  projectId: string;
  user: { email: string; name: string | null };
}) {
  const [section, setSection] = useState<SectionId>("projects");
  const [projects, setProjects] = useState<Project[]>([]);
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [tokens, setTokens] = useState<Token[]>([]);
  const [library, setLibrary] = useState<LibraryItem[]>([]);
  const [datasheets, setDatasheets] = useState<Datasheet[]>([]);
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [onlyUnverified, setOnlyUnverified] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // active organization in the console: the data (projects, members) follows it
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);

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

  const refreshOrgs = useCallback(async () => {
    const d = await fetch("/api/orgs")
      .then((r) => r.json())
      .catch(() => null);
    const list = d?.organizations ?? [];
    setOrgs(list);
    setSelectedOrgId((cur) => cur ?? list[0]?.id ?? null);
    return list as Array<{ id: string; name: string }>;
  }, []);

  useEffect(() => {
    void fetch("/api/projects")
      .then((r) => r.json())
      .then((d) => setProjects(d.projects ?? []))
      .catch(() => undefined);
    /*
     * The state is set inside the promise, that is after the answer comes back
     * and not while the effect runs: the rule cannot tell the two apart.
     */
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshOrgs();
    void fetch("/api/tokens")
      .then((r) => r.json())
      .then((d) => setTokens(d.tokens ?? []))
      .catch(() => undefined);
  }, [refreshOrgs]);

  // members follow the selected organization
  useEffect(() => {
    if (!selectedOrgId) return;
    /*
     * Emptying the list while the new one is being fetched is the point: without
     * it the members of the organisation you just left stay on screen until the
     * answer arrives, and they read as the members of the one you just chose.
     */
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMembers([]);
    void fetch(`/api/orgs?orgId=${selectedOrgId}`)
      .then((r) => r.json())
      .then((m) => setMembers(m.members ?? []))
      .catch(() => undefined);
  }, [selectedOrgId]);

  /** self-service creation of the company organization (closed story) */
  const createOrg = useCallback(async () => {
    const name = prompt("Nome della nuova organizzazione (es. la tua azienda):");
    if (!name || name.trim().length < 2) return;
    const d = await post("/api/orgs", { action: "create_org", name: name.trim() });
    if (d?.organization?.id) {
      await refreshOrgs();
      setSelectedOrgId(d.organization.id);
      setNote(`Organizzazione "${d.organization.name}" creata: sei il proprietario. Invita i colleghi da Utenti.`);
    }
  }, [post, refreshOrgs]);

  useEffect(() => {
    void fetch(`/api/project?projectId=${projectId}`)
      .then((r) => r.json())
      .then((d) => setLibrary(d.library ?? []))
      .catch(() => undefined);
    void fetch(`/api/datasheet?projectId=${projectId}`)
      .then((r) => r.json())
      .then((d) => setDatasheets(d.datasheets ?? []))
      .catch(() => undefined);
  }, [projectId]);

  // the visible projects follow the selected org (those without an assigned org
  // count as personal: the user's first org)
  const visibleProjects = projects.filter(
    (p) =>
      (p.orgId ?? null) === selectedOrgId ||
      (!p.orgId && selectedOrgId === orgs[0]?.id) ||
      !selectedOrgId,
  );

  const counts: Record<SectionId, string> = {
    super: String(orgs.length || 1),
    users: String(members.length),
    sheets: String(datasheets.length),
    projects: String(visibleProjects.length),
    parts: String(library.length),
  };

  const sectionMeta = {
    super: { title: "Super admin", sub: "Organizzazioni, quote e stato della piattaforma" },
    users: { title: "Utenti e ruoli", sub: "Membri, permessi e accessi dell'organizzazione" },
    sheets: { title: "Gestione datasheet", sub: "PDF sorgente e impronte ricavate con geometria reale" },
    projects: { title: "Gestione progetti", sub: "Visibilità, proprietari e stato dei controlli" },
    parts: { title: "Gestione componenti", sub: "Libreria condivisa da tutti i progetti dell'organizzazione" },
  }[section];

  const filteredParts = useMemo(() => {
    const q = query.trim().toLowerCase();
    return library.filter((c) => {
      if (onlyUnverified && PART_STATUS[c.source]?.ink === G) return false;
      if (!q) return true;
      return (
        c.name.toLowerCase().includes(q) ||
        (c.sourceRef ?? "").toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q)
      );
    });
  }, [library, query, onlyUnverified]);

  const newProject = useCallback(async () => {
    const id = prompt("Nome del nuovo progetto:");
    if (!id) return;
    const d = await post("/api/projects", { id });
    if (d?.id) window.location.href = `/?project=${d.id}`;
  }, [post]);

  const inviteUser = useCallback(() => {
    const email = prompt("Email da invitare nell'organizzazione:");
    if (!email || !selectedOrgId) return;
    void post("/api/orgs", { action: "invite", orgId: selectedOrgId, email, role: "member" }).then(
      (d) => {
        if (d?.members) setMembers(d.members);
        if (d && d.joined === false) setNote("Invito registrato: entrerà al primo accesso.");
      },
    );
  }, [post, selectedOrgId]);

  const ctaAction = useCallback(() => {
    if (section === "super") void createOrg();
    else if (section === "projects") void newProject();
    else if (section === "users") inviteUser();
    else if (section === "sheets") window.location.href = `/datasheets?project=${projectId}`;
    else if (section === "parts") window.location.href = `/?project=${projectId}`;
  }, [section, createOrg, newProject, inviteUser, projectId]);

  return (
    <div className="grid min-h-dvh grid-cols-[236px_minmax(0,1fr)] bg-canvas text-text">
      {/* ============ PLATFORM SIDEBAR ============ */}
      <aside className="flex min-h-dvh flex-col border-r border-line bg-surface">
        <Link
          href={`/?project=${projectId}`}
          className="flex items-center gap-2.5 border-b border-line px-4 py-[18px]"
          title="Torna allo Studio"
        >
          <span className="grid h-[30px] w-[30px] flex-none place-items-center rounded-[9px] bg-brand text-ink">
            <svg width="20" height="20" viewBox="0 0 32 32" fill="none" stroke="#FAFBFC" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 6h9l6 6v5" />
              <path d="M23 26h-9l-6-6v-5" />
              <path d="M7 17h5l3-7 3 12 2.5-5H26" />
            </svg>
          </span>
          <span className="flex flex-col gap-0.5">
            <span className="text-[13px] font-bold tracking-tight">PCB Studio</span>
            <span className="text-[10px] text-faint">Console di amministrazione</span>
          </span>
        </Link>

        <div className="px-3 pb-2 pt-4 text-[10px] font-semibold tracking-[0.09em] text-faint">
          PIATTAFORMA
        </div>
        <nav className="flex flex-col gap-0.5 px-2">
          {SECTIONS.map((s) => {
            const on = section === s.id;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => setSection(s.id)}
                className={`grid grid-cols-[3px_1fr_auto] items-center gap-2.5 rounded-lg px-2.5 py-[9px] text-left transition-colors ${
                  on ? "bg-brand-wash" : "hover:bg-sunken"
                }`}
              >
                <span className={`h-[18px] w-[3px] rounded-sm ${on ? "bg-brand" : "bg-transparent"}`} />
                <span className={`text-[13px] ${on ? "font-semibold text-brand-strong" : "text-muted"}`}>
                  {s.name}
                </span>
                <span className="font-mono text-[10px] text-faint">{counts[s.id]}</span>
              </button>
            );
          })}
        </nav>

        <div className="flex-1" />
        <div className="m-3.5 rounded-[10px] border border-line bg-sunken p-3">
          <div className="flex items-center gap-2.5">
            <span className="grid h-7 w-7 flex-none place-items-center rounded-lg bg-brand-wash text-[11px] font-semibold text-brand-strong">
              {user.email.slice(0, 2).toUpperCase()}
            </span>
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate text-xs font-medium">{user.name ?? user.email.split("@")[0]}</span>
              <span className="text-[10px] text-brand-strong">Super admin</span>
            </div>
          </div>
        </div>
      </aside>

      {/* ============ MAIN ============ */}
      <main className="flex min-w-0 flex-col">
        <header className="flex items-center gap-3.5 border-b border-line bg-surface px-6 py-[18px]">
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="text-[17px] font-bold tracking-tight">{sectionMeta.title}</h1>
            <p className="text-xs text-faint">{sectionMeta.sub}</p>
          </div>
          <div className="flex-1" />
          {orgs.length > 1 && (
            <select
              value={selectedOrgId ?? ""}
              onChange={(e) => setSelectedOrgId(e.target.value)}
              title="Organizzazione attiva"
              className="cursor-pointer rounded-[9px] border border-line bg-sunken px-2.5 py-2 text-xs text-muted outline-none transition-colors focus:border-brand"
            >
              {orgs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          )}
          {section === "parts" && (
            <div className="flex min-w-[210px] items-center gap-2 rounded-[9px] border border-line bg-sunken px-3 py-2 text-xs text-faint">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="7" cy="7" r="4.5" />
                <path d="M10.5 10.5 14 14" />
              </svg>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Cerca per sigla, package o codice LCSC"
                className="w-full bg-transparent text-muted outline-none placeholder:text-faint"
              />
            </div>
          )}
          <Btn variant="primary" onClick={() => void ctaAction()} disabled={busy}>
            {SECTIONS.find((s) => s.id === section)?.cta}
          </Btn>
        </header>

        <div className="flex min-w-0 flex-col gap-5 px-6 py-6">
          {note && (
            <p className="rounded-lg bg-accent-wash px-3 py-2 text-xs leading-relaxed text-accent">{note}</p>
          )}

          {section === "super" && (
            <SuperSection orgs={orgs} projects={visibleProjects} members={members} datasheets={datasheets} library={library} onGoProjects={() => setSection("projects")} />
          )}

          {section === "users" && (
            <UsersSection
              members={members}
              tokens={tokens}
              freshToken={freshToken}
              setFreshToken={setFreshToken}
              busy={busy}
              currentEmail={user.email}
              onRemove={(userId) =>
                selectedOrgId &&
                void post("/api/orgs", { action: "remove_member", orgId: selectedOrgId, userId }).then(
                  (d) => d?.members && setMembers(d.members),
                )
              }
              onCreateToken={() =>
                void post("/api/tokens", { action: "create", name: "Claude Code" }).then((d) => {
                  if (d) {
                    setFreshToken(d.token);
                    setTokens(d.tokens ?? []);
                  }
                })
              }
              onRevokeToken={(id) =>
                void post("/api/tokens", { action: "revoke", id }).then(
                  (d) => d && setTokens(d.tokens ?? []),
                )
              }
            />
          )}

          {section === "sheets" && <SheetsSection datasheets={datasheets} projectId={projectId} />}

          {section === "projects" && <ProjectsSection projects={visibleProjects} />}

          {section === "parts" && (
            <PartsSection
              parts={filteredParts}
              onlyUnverified={onlyUnverified}
              setOnlyUnverified={setOnlyUnverified}
              projectId={projectId}
            />
          )}
        </div>
      </main>
    </div>
  );
}

/* ---------- shared table ---------- */
function Table({
  cols,
  header,
  children,
}: {
  cols: string;
  header: string[];
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface">
      <div
        className="grid gap-3.5 border-b border-line px-[18px] py-[13px] text-[10px] font-semibold tracking-[0.07em] text-faint"
        style={{ gridTemplateColumns: cols }}
      >
        {header.map((h) => (
          <div key={h}>{h}</div>
        ))}
      </div>
      {children}
    </div>
  );
}

function Row({ cols, children }: { cols: string; children: React.ReactNode }) {
  return (
    <div
      className="grid items-center gap-3.5 border-b border-line/60 px-[18px] py-3.5 transition-colors last:border-b-0 hover:bg-sunken"
      style={{ gridTemplateColumns: cols }}
    >
      {children}
    </div>
  );
}

function Mark({ text, ink = G }: { text: string; ink?: string }) {
  return (
    <span
      className="grid h-[26px] w-[26px] flex-none place-items-center rounded-[7px] text-[10px] font-semibold"
      style={{ background: ink === G ? "#12332A" : "#1B2534", color: ink }}
    >
      {text}
    </span>
  );
}

/* ---------- SUPER ADMIN ---------- */
function SuperSection({
  orgs,
  projects,
  members,
  datasheets,
  library,
  onGoProjects,
}: {
  orgs: Org[];
  projects: Project[];
  members: Member[];
  datasheets: Datasheet[];
  library: LibraryItem[];
  onGoProjects: () => void;
}) {
  const kpis = [
    { label: "Organizzazioni attive", value: String(Math.max(orgs.length, 1)), delta: "questo account", tint: G },
    { label: "Progetti totali", value: String(projects.length), delta: "accessibili da te", tint: G },
    { label: "Membri", value: String(members.length), delta: "nella tua organizzazione", tint: W },
    { label: "Componenti", value: String(library.length), delta: "in libreria condivisa", tint: "#8A96A2" },
  ];
  return (
    <>
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {kpis.map((k) => (
          <div key={k.label} className="flex flex-col gap-1.5 rounded-xl border border-line bg-surface p-4">
            <span className="text-[11px] font-medium text-faint">{k.label}</span>
            <span className="text-[26px] font-bold tracking-tight text-text">{k.value}</span>
            <span className="text-[11px]" style={{ color: k.tint }}>{k.delta}</span>
          </div>
        ))}
      </div>

      <Table cols="1.6fr 0.9fr 0.7fr 0.7fr 0.9fr 116px" header={["ORGANIZZAZIONE", "PIANO", "PROGETTI", "MEMBRI", "ARCHIVIO", "AZIONI"]}>
        {orgs.length === 0 && (
          <Row cols="1.6fr 0.9fr 0.7fr 0.7fr 0.9fr 116px">
            <div className="flex items-center gap-2.5">
              <Mark text="OR" />
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-[13px] font-medium">Organizzazione personale</span>
                <span className="font-mono text-[10px] text-faint">default</span>
              </div>
            </div>
            <div><Chip tone="brand">Pro</Chip></div>
            <div className="font-mono text-xs text-muted">{projects.length}</div>
            <div className="font-mono text-xs text-muted">{members.length || 1}</div>
            <div className="font-mono text-xs text-faint">—</div>
            <div className="flex gap-1.5">
              <Btn size="sm" onClick={onGoProjects}>Entra</Btn>
              <Btn size="sm" disabled>Sospendi</Btn>
            </div>
          </Row>
        )}
        {orgs.map((o) => (
          <Row key={o.id} cols="1.6fr 0.9fr 0.7fr 0.7fr 0.9fr 116px">
            <div className="flex items-center gap-2.5">
              <Mark text={o.name.slice(0, 2).toUpperCase()} />
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-[13px] font-medium">{o.name}</span>
                <span className="font-mono text-[10px] text-faint">{o.slug ?? o.id.slice(0, 8)}</span>
              </div>
            </div>
            <div><Chip tone="brand">{o.plan ?? "Pro"}</Chip></div>
            <div className="font-mono text-xs text-muted">{projects.length}</div>
            <div className="font-mono text-xs text-muted">{members.length}</div>
            <div className="font-mono text-xs text-faint">—</div>
            <div className="flex gap-1.5">
              <Btn size="sm" onClick={onGoProjects}>Entra</Btn>
              <Btn size="sm" disabled>Sospendi</Btn>
            </div>
          </Row>
        ))}
      </Table>

      <div className="grid gap-3 xl:grid-cols-3">
        <div className="rounded-xl border border-line bg-surface p-4">
          <div className="mb-2.5 text-xs font-semibold">Coda di importazione</div>
          <div className="flex flex-col gap-2">
            <div className="flex justify-between text-[11px] text-muted">
              Datasheet caricati<span className="font-mono" style={{ color: W }}>{datasheets.length}</span>
            </div>
            <div className="flex justify-between text-[11px] text-muted">
              Componenti da verificare
              <span className="font-mono" style={{ color: W }}>
                {library.filter((c) => PART_STATUS[c.source]?.ink === W).length}
              </span>
            </div>
            <div className="flex justify-between text-[11px] text-muted">
              Componenti verificati
              <span className="font-mono" style={{ color: G }}>
                {library.filter((c) => PART_STATUS[c.source]?.ink === G).length}
              </span>
            </div>
          </div>
        </div>
        <div className="rounded-xl border border-line bg-surface p-4">
          <div className="mb-2.5 text-xs font-semibold">Stato dei servizi</div>
          <div className="flex flex-col gap-2">
            {["Sbroglio automatico", "Estrazione datasheet", "Import KiCad"].map((s) => (
              <div key={s} className="flex items-center gap-2 text-[11px] text-muted">
                <span className="h-[7px] w-[7px] rounded-full" style={{ background: G }} />
                {s}
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-xl border border-line bg-surface p-4">
          <div className="mb-2.5 text-xs font-semibold">Registro attività</div>
          <div className="flex flex-col gap-2">
            {projects.slice(0, 3).map((p) => (
              <div key={p.id} className="text-[11px] text-muted">
                Ultimo aggiornamento: <span className="text-text">{p.id}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

/* ---------- USERS ---------- */
function UsersSection({
  members,
  tokens,
  freshToken,
  setFreshToken,
  busy,
  currentEmail,
  onRemove,
  onCreateToken,
  onRevokeToken,
}: {
  members: Member[];
  tokens: Token[];
  freshToken: string | null;
  setFreshToken: (t: string | null) => void;
  busy: boolean;
  currentEmail: string;
  onRemove: (userId: string) => void;
  onCreateToken: () => void;
  onRevokeToken: (id: string) => void;
}) {
  return (
    <>
      <Table cols="1.7fr 1fr 0.9fr 0.8fr 100px" header={["UTENTE", "RUOLO", "ULTIMO ACCESSO", "2FA", "AZIONI"]}>
        {members.map((m) => (
          <Row key={m.userId} cols="1.7fr 1fr 0.9fr 0.8fr 100px">
            <div className="flex items-center gap-2.5">
              <span className="grid h-[30px] w-[30px] flex-none place-items-center rounded-[9px] bg-brand-wash text-[11px] font-semibold text-brand-strong">
                {m.email.slice(0, 2).toUpperCase()}
              </span>
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-[13px] font-medium">{m.email.split("@")[0]}</span>
                <span className="truncate text-[10px] text-faint">{m.email}</span>
              </div>
            </div>
            <div>
              <Chip tone={m.role === "owner" ? "brand" : "neutral"}>
                {m.role === "owner" ? "Super admin" : m.role}
              </Chip>
            </div>
            <div className="text-xs text-faint">—</div>
            <div className="text-xs" style={{ color: G }}>Attiva</div>
            <div>
              {m.email !== currentEmail ? (
                <Btn size="sm" disabled={busy} onClick={() => onRemove(m.userId)}>
                  Gestisci
                </Btn>
              ) : (
                <Btn size="sm" disabled>
                  Gestisci
                </Btn>
              )}
            </div>
          </Row>
        ))}
      </Table>

      <div className="grid gap-3 xl:grid-cols-3">
        <div className="rounded-xl border border-line bg-surface p-4">
          <div className="mb-1.5 text-xs font-semibold">Ruoli disponibili</div>
          <p className="text-[11px] leading-relaxed text-muted">
            Super admin gestisce le organizzazioni · Admin gestisce membri e librerie · Membro
            progetta e sbroglia · Ospite vede in sola lettura.
          </p>
        </div>
        <div className="rounded-xl border border-line bg-surface p-4">
          <div className="mb-1.5 text-xs font-semibold">Inviti in sospeso</div>
          <p className="text-[11px] leading-relaxed text-muted">
            Gli inviti registrati entrano al primo accesso con il magic link. Il ruolo predefinito
            per i nuovi membri e&apos; Membro.
          </p>
        </div>
        <div className="rounded-xl border border-line bg-surface p-4">
          <div className="mb-1.5 text-xs font-semibold">Accesso da agenti esterni (MCP)</div>
          {freshToken && (
            <div className="mb-2 space-y-1.5 rounded-lg bg-brand-wash p-2.5">
              <p className="text-[10px] font-semibold text-brand-strong">Copialo ora: non verrà più mostrato.</p>
              <code className="block break-all rounded bg-surface px-2 py-1 font-mono text-[10px]">{freshToken}</code>
              <Btn size="sm" onClick={() => setFreshToken(null)}>Ho copiato</Btn>
            </div>
          )}
          <Btn size="sm" disabled={busy} onClick={onCreateToken}>+ Genera token</Btn>
          {tokens.length > 0 && (
            <ul className="mt-2.5 space-y-1.5">
              {tokens.map((t) => (
                <li key={t.id} className="flex items-center gap-2 text-[11px] text-muted">
                  <span className="min-w-0 flex-1 truncate">{t.name}</span>
                  <Chip>{t.prefix}…</Chip>
                  <button
                    type="button"
                    disabled={busy}
                    title="Revoca"
                    className="text-faint transition-colors hover:text-danger"
                    onClick={() => onRevokeToken(t.id)}
                  >
                    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none">
                      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}

/* ---------- DATASHEET ---------- */
function SheetsSection({ datasheets, projectId }: { datasheets: Datasheet[]; projectId: string }) {
  return (
    <>
      <Table cols="1.8fr 0.9fr 0.6fr 0.9fr 0.9fr 120px" header={["DATASHEET", "PROGETTO", "PAG.", "ESTRAZIONE", "COMPONENTI", "AZIONI"]}>
        {datasheets.map((d) => (
          <Row key={d.id} cols="1.8fr 0.9fr 0.6fr 0.9fr 0.9fr 120px">
            <div className="flex items-center gap-2.5">
              <span className="grid h-[30px] w-[26px] flex-none place-items-center rounded border border-line bg-sunken text-[8px] font-semibold text-faint">
                PDF
              </span>
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-[13px] font-medium" title={d.title}>{d.title}</span>
                <span className="text-[10px] text-faint">id {d.id}</span>
              </div>
            </div>
            <div className="font-mono text-[11px] text-muted">{projectId}</div>
            <div className="font-mono text-xs text-faint">{d.pages ?? "—"}</div>
            <div className="flex items-center gap-1.5 text-[11px]" style={{ color: G }}>
              <span className="h-1.5 w-1.5 flex-none rounded-full" style={{ background: G }} />
              Estratto
            </div>
            <div className="text-xs text-muted">—</div>
            <div>
              <Link href={`/datasheets?project=${projectId}`}>
                <Btn size="sm">Apri</Btn>
              </Link>
            </div>
          </Row>
        ))}
      </Table>
      <Link
        href={`/datasheets?project=${projectId}`}
        className="rounded-xl border border-dashed border-line-strong bg-surface p-5 text-center transition-colors hover:border-brand hover:bg-brand-wash/30"
      >
        <div className="mb-1 text-[13px] font-semibold text-text">Trascina qui un PDF</div>
        <div className="text-[11px] text-faint">
          L&apos;estrazione ricava impronte con geometria reale e le propone alla libreria.
        </div>
      </Link>
      {datasheets.length === 0 && <EmptyState title="Nessun datasheet in questo progetto" />}
    </>
  );
}

/* ---------- PROJECTS ---------- */
function ProjectsSection({ projects }: { projects: Project[] }) {
  const VIS: Record<string, { bg: string; ink: string }> = {
    org: { bg: "#241F16", ink: W },
    link: { bg: "#241F16", ink: W },
    private: { bg: "#1B2534", ink: "#9FB3C4" },
  };
  return (
    <Table cols="1.4fr 0.8fr 1fr 0.7fr 0.9fr 100px" header={["PROGETTO", "VISIBILITÀ", "PROPRIETARIO", "REV", "CONTROLLI", "AZIONI"]}>
      {projects.map((p) => {
        const vis = VIS[p.visibility ?? ""] ?? VIS.private;
        const c = p.checks;
        const [drcLabel, drcInk] = !c
          ? ["Mai eseguito", "#636E7B"]
          : c.allGreen
            ? ["Pulito", G]
            : [`${c.drcViolations + c.prcViolations} da correggere`, c.drcViolations + c.prcViolations > 5 ? R : W];
        return (
          <Row key={p.id} cols="1.4fr 0.8fr 1fr 0.7fr 0.9fr 100px">
            <div className="flex items-center gap-2.5">
              <span className="h-2 w-2 flex-none rounded-sm" style={{ background: c?.allGreen ? G : drcInk === "#636E7B" ? "#3A4654" : drcInk }} />
              <span className="truncate text-[13px] font-medium">{p.id}</span>
            </div>
            <div>
              <span
                className="rounded-md px-2 py-1 font-mono text-[10px]"
                style={{ background: vis.bg, color: vis.ink }}
              >
                {p.visibility === "org" ? "team" : (p.visibility ?? "privato")}
              </span>
            </div>
            <div className="truncate text-xs text-faint">{p.createdBy ? "tu" : "condiviso"}</div>
            <div className="font-mono text-xs text-muted">—</div>
            <div className="text-[11px]" style={{ color: drcInk }}>
              {drcLabel}
              {c?.checksStale ? " · da ricontrollare" : ""}
            </div>
            <div>
              <Link href={`/?project=${p.id}`}>
                <Btn size="sm">Apri</Btn>
              </Link>
            </div>
          </Row>
        );
      })}
    </Table>
  );
}

/* ---------- COMPONENTS ---------- */
function PartsSection({
  parts,
  onlyUnverified,
  setOnlyUnverified,
  projectId,
}: {
  parts: LibraryItem[];
  onlyUnverified: boolean;
  setOnlyUnverified: (v: boolean) => void;
  projectId: string;
}) {
  return (
    <>
      <div className="flex items-center gap-2.5">
        <button
          type="button"
          onClick={() => setOnlyUnverified(!onlyUnverified)}
          className={`rounded-[9px] border px-3 py-2.5 text-xs transition-colors ${
            onlyUnverified
              ? "border-brand bg-brand-wash/50 text-brand-strong"
              : "border-line bg-surface text-muted hover:border-line-strong"
          }`}
        >
          Solo da verificare
        </button>
        <Link href={`/?project=${projectId}`} className="rounded-[9px] border border-line bg-surface px-3 py-2.5 text-xs text-muted transition-colors hover:border-brand hover:text-brand-strong">
          Importa da LCSC
        </Link>
      </div>

      <Table cols="1.5fr 0.9fr 0.8fr 0.5fr 0.9fr 0.9fr" header={["COMPONENTE", "CODICE", "PACKAGE", "PIN", "USATO IN", "STATO"]}>
        {parts.map((c) => {
          const st = PART_STATUS[c.source] ?? { label: c.source, ink: "#8A96A2" };
          return (
            <Row key={c.id} cols="1.5fr 0.9fr 0.8fr 0.5fr 0.9fr 0.9fr">
              <div className="flex min-w-0 flex-col gap-0.5">
                <Link
                  href={`/library/${encodeURIComponent(c.name)}?project=${projectId}`}
                  className="truncate text-[13px] font-medium hover:text-brand-strong"
                >
                  {c.name}
                </Link>
                <span className="truncate text-[10px] text-faint">{c.description}</span>
              </div>
              <div className="font-mono text-[11px] text-brand-strong">{c.sourceRef ?? "—"}</div>
              <div className="font-mono text-[11px] text-muted">—</div>
              <div className="font-mono text-xs text-faint">{pinCountOf(c.code)}</div>
              <div className="text-xs text-faint">—</div>
              <div className="flex items-center gap-1.5 text-[11px]" style={{ color: st.ink }}>
                <span className="h-1.5 w-1.5 flex-none rounded-full" style={{ background: st.ink }} />
                {st.label}
              </div>
            </Row>
          );
        })}
      </Table>
      {parts.length === 0 && <EmptyState title="Nessun componente trovato" />}
    </>
  );
}
