"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, SettingsShell } from "./SettingsShell";
import { Btn, Chip, EmptyState, Field } from "./ui";

type ComponentMeta = {
  id: number;
  name: string;
  description: string;
  source: string;
  sourceRef: string | null;
  version: number;
  datasheetUrl: string | null;
  schematicNotes: string;
  layoutNotes: string;
};

const SOURCE_LABELS: Record<string, string> = {
  lcsc: "LCSC/EasyEDA",
  datasheet: "datasheet",
  llm: "agente",
  manual: "manuale",
  kicad: "KiCad",
};

export function LibraryDetailPage({
  name,
  projectId,
  user,
}: {
  name: string;
  projectId: string;
  user: { email: string; name: string | null };
}) {
  const [component, setComponent] = useState<ComponentMeta | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [datasheetUrl, setDatasheetUrl] = useState("");
  const [schematicNotes, setSchematicNotes] = useState("");
  const [layoutNotes, setLayoutNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [renderKey, setRenderKey] = useState(0);

  useEffect(() => {
    void fetch(`/api/library/component?name=${encodeURIComponent(name)}`)
      .then((r) => (r.status === 404 ? null : r.json()))
      .then((d) => {
        if (!d?.component) {
          setNotFound(true);
          return;
        }
        setComponent(d.component);
        setDatasheetUrl(d.component.datasheetUrl ?? "");
        setSchematicNotes(d.component.schematicNotes ?? "");
        setLayoutNotes(d.component.layoutNotes ?? "");
      })
      .catch(() => setNotFound(true));
  }, [name]);

  const save = useCallback(async () => {
    setSaving(true);
    setNote(null);
    const res = await fetch("/api/library/component", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        datasheetUrl: datasheetUrl.trim() || null,
        schematicNotes,
        layoutNotes,
      }),
    });
    setSaving(false);
    setNote(res.ok ? "Salvato." : `Errore ${res.status}`);
    if (res.ok) setRenderKey((k) => k + 1);
  }, [name, datasheetUrl, schematicNotes, layoutNotes]);

  if (notFound) {
    return (
      <SettingsShell title="Libreria" projectId={projectId} user={user}>
        <EmptyState title={`Componente "${name}" non trovato`} hint="Torna alla libreria" />
      </SettingsShell>
    );
  }
  if (!component) {
    return (
      <SettingsShell title="Libreria" projectId={projectId} user={user}>
        <p className="text-xs text-faint">caricamento…</p>
      </SettingsShell>
    );
  }

  const lcscUrl =
    component.source === "lcsc" && component.sourceRef
      ? `https://www.lcsc.com/product-detail/${component.sourceRef}.html`
      : null;
  const datasheetHref = component.datasheetUrl || lcscUrl;

  return (
    <SettingsShell
      title={component.name}
      subtitle="scheda componente di libreria"
      projectId={projectId}
      user={user}
    >
      {note && (
        <p className="mb-5 rounded-lg bg-accent-wash px-3 py-2 text-xs leading-relaxed text-accent">
          {note}
        </p>
      )}

      <div className="card mb-5 flex flex-wrap items-center gap-4 p-5">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-mono text-lg font-bold text-text">{component.name}</h2>
            <Chip tone="brand">v{component.version}</Chip>
            <Chip>{SOURCE_LABELS[component.source] ?? component.source}</Chip>
            {component.sourceRef && <Chip>{component.sourceRef}</Chip>}
          </div>
          {component.description && (
            <p className="mt-2 text-sm leading-relaxed text-muted">{component.description}</p>
          )}
        </div>
        {datasheetHref && (
          <a
            href={datasheetHref}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-2 text-xs font-medium text-brand-strong transition-colors hover:border-brand hover:bg-brand-wash/40"
          >
            <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4">
              <path
                d="M5 3h7l3 3v11H5V3Zm7 0v3h3M8 15l4-4m0 0h-3m3 0v3"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Datasheet ↗
          </a>
        )}
      </div>

      <div className="mb-5 grid gap-5 lg:grid-cols-2">
        <Card title="Simbolo schematico">
          <div className="flex min-h-[220px] items-center justify-center overflow-hidden rounded-lg bg-white p-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/library/render?name=${encodeURIComponent(name)}&view=schematic&k=${renderKey}`}
              alt={`Simbolo schematico di ${name}`}
              className="max-h-[320px] max-w-full object-contain"
            />
          </div>
        </Card>
        <Card title="Footprint PCB">
          <div className="flex min-h-[220px] items-center justify-center overflow-hidden rounded-lg bg-white p-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/library/render?name=${encodeURIComponent(name)}&view=pcb&k=${renderKey}`}
              alt={`Footprint PCB di ${name}`}
              className="max-h-[320px] max-w-full object-contain"
            />
          </div>
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Datasheet" hint="Link online (produttore, LCSC) o al PDF che userai offline.">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <Field
              name="datasheetUrl"
              type="url"
              placeholder="https://… (link al datasheet)"
              className="flex-1"
            />
            <Btn type="submit" disabled={saving}>
              Salva
            </Btn>
          </form>
        </Card>

        <Card title="Note" hint="Appunti per chi userà il componente dopo di te.">
          <label className="mb-1 block text-[11px] font-medium text-faint">Note di schematico</label>
          <textarea
            value={schematicNotes}
            onChange={(e) => setSchematicNotes(e.target.value)}
            rows={3}
            placeholder="es. pin 3 va tirato alto se non usato, simbolo con power a sinistra…"
            className="mb-3 w-full rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm text-text outline-none placeholder:text-faint focus:border-brand focus:ring-2 focus:ring-brand/15"
          />
          <label className="mb-1 block text-[11px] font-medium text-faint">Note di layout</label>
          <textarea
            value={layoutNotes}
            onChange={(e) => setLayoutNotes(e.target.value)}
            rows={3}
            placeholder="es. courtyard generoso per il rework manuale, attenzione al pad termico…"
            className="w-full rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm text-text outline-none placeholder:text-faint focus:border-brand focus:ring-2 focus:ring-brand/15"
          />
          <div className="mt-3">
            <Btn variant="primary" disabled={saving} onClick={() => void save()}>
              Salva note e datasheet
            </Btn>
          </div>
        </Card>
      </div>
    </SettingsShell>
  );
}
