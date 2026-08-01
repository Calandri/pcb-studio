"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, SettingsShell } from "./SettingsShell";
import { Btn, Chip, Field, Select } from "./ui";

type Share = { userId: string; email: string; role: string };
type Visibility = "private" | "org" | "link";

const VISIBILITY_OPTIONS: Array<{
  value: Visibility;
  label: string;
  hint: string;
  icon: React.ReactNode;
}> = [
  {
    value: "private",
    label: "Solo io",
    hint: "Nessun altro vi accede",
    icon: (
      <path d="M10 3a3 3 0 0 0-3 3v2H6a2 2 0 0 0-2 2v5a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-5a2 2 0 0 0-2-2h-1V6a3 3 0 0 0-3-3Zm-1.5 3a1.5 1.5 0 0 1 3 0v2h-3V6Z" />
    ),
  },
  {
    value: "org",
    label: "Tutta l'organizzazione",
    hint: "Chi è nel tuo team",
    icon: (
      <path d="M7 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Zm6 0a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM2.5 16c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4v1h-9v-1Zm9 0c0-2 1.5-3.4 3.5-3.8 1.8-.3 3.5.9 3.5 3.3v1.5h-7V16Z" />
    ),
  },
  {
    value: "link",
    label: "Chi ha il link",
    hint: "In sola lettura",
    icon: (
      <path d="M8 12a3 3 0 0 0 4.2.4l2.5-2.5a3 3 0 1 0-4.2-4.2l-1.3 1.3M12 8a3 3 0 0 0-4.2-.4L5.3 10a3 3 0 1 0 4.2 4.2l1.3-1.3" />
    ),
  },
];

/**
 * Settings for the SINGLE project: visibility and invites. Organization
 * members, projects and MCP tokens live one level up, in /org.
 */
export function TeamPage({
  projectId,
  user,
}: {
  projectId: string;
  user: { email: string; name: string | null };
}) {
  const [shares, setShares] = useState<Share[]>([]);
  const [visibility, setVisibility] = useState<Visibility>("private");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const refreshShares = useCallback(() => {
    void fetch(`/api/projects/share?projectId=${projectId}`)
      .then((r) => r.json())
      .then((d) => {
        setShares(d.shares ?? []);
        if (d.visibility) setVisibility(d.visibility);
      })
      .catch(() => undefined);
  }, [projectId]);

  useEffect(refreshShares, [refreshShares]);

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

  return (
    <SettingsShell
      title={`Impostazioni di ${projectId}`}
      subtitle="visibilità e condivisione del progetto"
      projectId={projectId}
      user={user}
    >
      {note && (
        <p className="mb-5 rounded-lg bg-accent-wash px-3 py-2 text-xs leading-relaxed text-accent">
          {note}
        </p>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Chi può vedere questo progetto">
          <div className="grid gap-2 sm:grid-cols-3">
            {VISIBILITY_OPTIONS.map((opt) => {
              const active = visibility === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  disabled={busy}
                  onClick={async () => {
                    const d = await post("/api/projects/share", {
                      projectId,
                      visibility: opt.value,
                    });
                    if (d) setVisibility(opt.value);
                  }}
                  className={`rounded-xl border px-3.5 py-3 text-left transition-all ${
                    active
                      ? "border-brand bg-brand-wash/50 ring-2 ring-brand/15"
                      : "border-line hover:border-brand hover:bg-brand-wash/30"
                  }`}
                >
                  <svg viewBox="0 0 20 20" fill="none" className={`h-5 w-5 ${active ? "text-brand-strong" : "text-faint"}`}>
                    <g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                      {opt.icon}
                    </g>
                  </svg>
                  <p className={`mt-2 text-xs font-semibold ${active ? "text-brand-strong" : "text-text"}`}>
                    {opt.label}
                  </p>
                  <p className="mt-0.5 text-[11px] text-faint">{opt.hint}</p>
                </button>
              );
            })}
          </div>
        </Card>

        <Card title="Invita sul progetto" hint="La persona riceve accesso a questo progetto col ruolo scelto.">
          <form
            className="flex flex-col gap-2 sm:flex-row"
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
            <Field name="email" type="email" required placeholder="Email" className="flex-1" />
            <Select
              name="role"
              options={[
                { value: "viewer", label: "Può vedere" },
                { value: "editor", label: "Può modificare" },
              ]}
            />
            <Btn type="submit" variant="primary" disabled={busy}>
              Invita
            </Btn>
          </form>
          {shares.length > 0 ? (
            <ul className="mt-4 divide-y divide-line">
              {shares.map((s) => (
                <li key={s.userId} className="flex items-center gap-3 py-2.5">
                  <span className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-sunken text-[10px] font-semibold text-muted">
                    {s.email.slice(0, 2).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-muted">{s.email}</span>
                  <Chip tone={s.role === "editor" ? "brand" : "neutral"}>
                    {s.role === "editor" ? "modifica" : "vede"}
                  </Chip>
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
                    <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none">
                      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-4 text-xs text-faint">Nessun invitato: il progetto è solo tuo.</p>
          )}
        </Card>
      </div>
    </SettingsShell>
  );
}
