"use client";

import { useCallback, useEffect, useState } from "react";

interface Project {
  id: string;
  name: string;
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
  name: string | null;
  role: string;
}

type Panel = "none" | "projects" | "share" | "org";

export function WorkspaceBar({
  projectId,
  user,
}: {
  projectId: string;
  user: { email: string; name: string | null };
}) {
  const [panel, setPanel] = useState<Panel>("none");
  const [projects, setProjects] = useState<Project[]>([]);
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [shares, setShares] = useState<Share[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const loadProjects = useCallback(async () => {
    const d = await fetch("/api/projects").then((r) => r.json()).catch(() => null);
    if (d?.projects) setProjects(d.projects);
    if (d?.organizations) setOrgs(d.organizations);
  }, []);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const openPanel = useCallback(
    async (next: Panel) => {
      setNote(null);
      setPanel((cur) => (cur === next ? "none" : next));
      if (next === "share") {
        const d = await fetch(`/api/projects/share?projectId=${projectId}`)
          .then((r) => r.json())
          .catch(() => null);
        if (d?.shares) setShares(d.shares);
      }
      if (next === "org" && orgs[0]) {
        const d = await fetch(`/api/orgs?orgId=${orgs[0].id}`)
          .then((r) => r.json())
          .catch(() => null);
        if (d?.members) setMembers(d.members);
      }
    },
    [projectId, orgs],
  );

  const createProject = useCallback(async () => {
    const id = prompt("Nome del nuovo progetto (lettere, numeri, trattini):");
    if (!id) return;
    setBusy(true);
    const res = await fetch("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
    const d = await res.json();
    setBusy(false);
    if (!res.ok) {
      setNote(d.error ?? "errore");
      return;
    }
    window.location.search = `?project=${d.id}`;
  }, []);

  const doShare = useCallback(
    async (body: Record<string, unknown>) => {
      setBusy(true);
      const res = await fetch("/api/projects/share", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, ...body }),
      });
      const d = await res.json();
      setBusy(false);
      if (!res.ok) return setNote(d.error ?? "errore");
      if (d.shares) setShares(d.shares);
      setNote(d.share && !d.share.shared ? d.share.reason : "fatto");
    },
    [projectId],
  );

  const doOrg = useCallback(async (body: Record<string, unknown>) => {
    setBusy(true);
    const res = await fetch("/api/orgs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await res.json();
    setBusy(false);
    if (!res.ok) return setNote(d.error ?? "errore");
    if (d.members) setMembers(d.members);
    setNote(d.joined === false ? "invito inviato: entrera' al primo accesso" : "fatto");
  }, []);

  const btn =
    "rounded border border-neutral-700 px-2 py-0.5 text-xs text-neutral-300 hover:border-emerald-600 hover:text-emerald-400";

  return (
    <>
      <div className="flex items-center gap-2">
        <button type="button" className={btn} onClick={() => void openPanel("projects")}>
          🗂 Progetti ({projects.length})
        </button>
        <button type="button" className={btn} onClick={() => void openPanel("share")}>
          👥 Condividi
        </button>
        <button type="button" className={btn} onClick={() => void openPanel("org")}>
          🏢 {orgs[0]?.name ?? "Org"}
        </button>
        <span className="ml-1 text-xs text-neutral-500" title={user.email}>
          {user.email}
        </span>
        <a href="/api/auth/signout" className={btn}>
          Esci
        </a>
      </div>

      {panel !== "none" && (
        <div className="absolute inset-x-0 top-[41px] z-20 border-b border-neutral-800 bg-neutral-900 px-4 py-3 text-sm shadow-lg">
          {note && <p className="mb-2 text-xs text-amber-400">{note}</p>}

          {panel === "projects" && (
            <div>
              <div className="mb-2 flex items-center gap-2">
                <span className="text-neutral-400">I tuoi progetti</span>
                <button type="button" className={btn} disabled={busy} onClick={createProject}>
                  + Nuovo
                </button>
              </div>
              <ul className="flex flex-wrap gap-2">
                {projects.map((p) => (
                  <li key={p.id}>
                    <a
                      href={`/?project=${p.id}`}
                      className={`block rounded border px-2 py-1 text-xs ${
                        p.id === projectId
                          ? "border-emerald-600 text-emerald-400"
                          : "border-neutral-700 text-neutral-300 hover:border-neutral-500"
                      }`}
                    >
                      {p.id}
                      <span className="ml-2 text-neutral-500">
                        {p.access} · {p.visibility}
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {panel === "share" && (
            <div className="space-y-3">
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  const form = new FormData(e.currentTarget);
                  void doShare({
                    email: String(form.get("email") ?? ""),
                    role: String(form.get("role") ?? "viewer"),
                  });
                  e.currentTarget.reset();
                }}
              >
                <input
                  name="email"
                  type="email"
                  required
                  placeholder="email della persona"
                  className="w-64 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs"
                />
                <select
                  name="role"
                  className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs"
                >
                  <option value="viewer">può vedere</option>
                  <option value="editor">può modificare</option>
                </select>
                <button type="submit" className={btn} disabled={busy}>
                  Condividi
                </button>
              </form>

              <div className="flex items-center gap-2 text-xs text-neutral-400">
                Visibilità:
                {(["private", "org", "link"] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    className={btn}
                    disabled={busy}
                    onClick={() => void doShare({ visibility: v })}
                  >
                    {v === "private" ? "solo me" : v === "org" ? "tutta l'org" : "chi ha il link"}
                  </button>
                ))}
              </div>

              <ul className="space-y-1 text-xs">
                {shares.map((s) => (
                  <li key={s.userId} className="flex items-center gap-2">
                    <span className="text-neutral-300">{s.email}</span>
                    <span className="text-neutral-500">{s.role}</span>
                    <button
                      type="button"
                      className={btn}
                      disabled={busy}
                      onClick={() => void doShare({ removeUserId: s.userId })}
                    >
                      rimuovi
                    </button>
                  </li>
                ))}
                {shares.length === 0 && (
                  <li className="text-neutral-500">Nessuna condivisione diretta.</li>
                )}
              </ul>
            </div>
          )}

          {panel === "org" && (
            <div className="space-y-3">
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  const form = new FormData(e.currentTarget);
                  if (orgs[0]) {
                    void doOrg({
                      action: "invite",
                      orgId: orgs[0].id,
                      email: String(form.get("email") ?? ""),
                      role: String(form.get("role") ?? "member"),
                    });
                  }
                  e.currentTarget.reset();
                }}
              >
                <input
                  name="email"
                  type="email"
                  required
                  placeholder="invita per email"
                  className="w-64 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs"
                />
                <select
                  name="role"
                  className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs"
                >
                  <option value="member">membro</option>
                  <option value="admin">admin</option>
                </select>
                <button type="submit" className={btn} disabled={busy}>
                  Invita
                </button>
              </form>

              <ul className="space-y-1 text-xs">
                {members.map((m) => (
                  <li key={m.userId} className="flex items-center gap-2">
                    <span className="text-neutral-300">{m.email}</span>
                    <span className="text-neutral-500">{m.role}</span>
                    {m.email !== user.email && orgs[0] && (
                      <button
                        type="button"
                        className={btn}
                        disabled={busy}
                        onClick={() =>
                          void doOrg({
                            action: "remove_member",
                            orgId: orgs[0].id,
                            userId: m.userId,
                          })
                        }
                      >
                        rimuovi
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </>
  );
}
