"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Chip } from "./ui";

/**
 * Shell condiviso delle pagine di gestione full-screen (Fase UI-2): le sezioni
 * che prima vivevano schiacciate nella sidebar da 292px (Progetti, Libreria,
 * Datasheet, Team) sono diventate pagine intere. Stessa testata per tutte:
 * identita', via di ritorno allo Studio, progetto corrente, utente.
 */
export function SettingsShell({
  title,
  subtitle,
  projectId,
  user,
  children,
}: {
  title: string;
  subtitle?: string;
  projectId: string;
  user: { email: string };
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <header className="flex h-14 flex-none items-center gap-4 border-b border-line bg-surface px-5">
        <Link
          href={`/?project=${projectId}`}
          className="group flex items-center gap-2.5"
          title="Torna allo Studio"
        >
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand text-ink transition-transform group-hover:scale-105">
            <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4">
              <path
                d="M3 10h3.2l1.6-4 2.4 8 1.8-4H17"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <span className="text-[15px] font-bold tracking-tight text-text">PCB Studio</span>
        </Link>

        <span className="text-faint">/</span>
        <h1 className="text-sm font-semibold text-text">{title}</h1>
        {subtitle && <span className="hidden text-xs text-faint md:inline">{subtitle}</span>}

        <div className="ml-auto flex items-center gap-3">
          <Link href={`/?project=${projectId}`}>
            <Chip tone="brand">{projectId}</Chip>
          </Link>
          <span
            className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-wash text-[11px] font-bold text-brand-strong"
            title={user.email}
          >
            {user.email.slice(0, 2).toUpperCase()}
          </span>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-5 py-8">{children}</main>
    </div>
  );
}

/** card moderna: titolo, hint opzionale, contenuto */
export function Card({
  title,
  hint,
  children,
  className = "",
}: {
  title: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card p-5 ${className}`}>
      <h2 className="text-sm font-semibold text-text">{title}</h2>
      {hint && <p className="mt-1 text-xs leading-relaxed text-faint">{hint}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}
