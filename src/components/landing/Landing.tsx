"use client";

import { useState } from "react";

/**
 * Public landing page of PCB Studio (bilingual IT/EN). It presents the product
 * as it is: the agent designs, the human steers, the board comes out ready for
 * the factory. Usage model: free, with your own agent via MCP (or your own API
 * key, coming soon) — no metered copilot.
 */

type Lang = "it" | "en";

const COPY = {
  it: {
    nav: { login: "Accedi", cta: "Inizia gratis" },
    hero: {
      badge: "Gratis · Porta il tuo agente",
      title: "La tua prossima scheda,\nprogettata parlando.",
      sub: "PCB Studio trasforma una conversazione in elettronica reale: schematico, sbroglio con le regole del produttore, distinta con codici fornitore e scocca 3D. Tu descrivi cosa deve fare, l'agente la disegna, tu la mandi in produzione.",
      ctaPrimary: "Inizia gratis",
      ctaSecondary: "Usa il tuo Claude via MCP",
      note: "Nessuna carta di credito. Si accede con un link via email.",
    },
    steps: {
      title: "Dal prompt alla fabbrica",
      items: [
        {
          n: "01",
          title: "Descrivi il circuito",
          body: "«Un data logger con ESP32, due sensori I2C e batteria LiPo». L'agente sceglie i componenti reali a magazzino e scrive il progetto.",
        },
        {
          n: "02",
          title: "Dirigi, correggi, tocca con mano",
          body: "Sposti componenti e tiri fili a mano nel viewer, o chiedi in chat. DRC, regole elettriche e controlli di produzione girano a ogni compilazione.",
        },
        {
          n: "03",
          title: "Mandi in produzione",
          body: "Gerber, distinta con codici LCSC e pick & place, pronti per il produttore. E la scocca 3D in STL per contenere tutto.",
        },
      ],
    },
    features: {
      title: "Tutto quello che serve, in un solo posto",
      items: [
        {
          tag: "Schematico",
          title: "Schemi che si leggono",
          body: "Sezioni funzionali, cornici, etichette di rete e controlli di qualità del disegno: lo schema esce come lo disegnerebbe un ingegnere, non un diagramma generato.",
        },
        {
          tag: "Sbroglio",
          title: "Regole vere, non suggerimenti",
          body: "Autorouting cloud, DRC con le regole JLCPCB, controlli elettrici (ERC) e di potenza (PRC) a ogni compilazione. Se qualcosa non va, lo vedi sulla scheda.",
        },
        {
          tag: "Editor",
          title: "L'AI progetta, tu dirigi",
          body: "Trascini simboli e componenti, colleghi i piedini a mano, fissi le posizioni che non devono cambiare. Le tue modifiche manuali restano tue: l'agente le rispetta.",
        },
        {
          tag: "Libreria",
          title: "Componenti che esistono",
          body: "Footprint e simboli dai cataloghi LCSC/JLCPCB, datasheet come contesto per l'agente, distinta con codici fornitore e quantità.",
        },
        {
          tag: "3D · nuovo",
          title: "Anche la scocca",
          body: "Scocca parametrica a due gusci auto-dimensionata sulla scheda, import di STEP/STL/OBJ/GLB, scocche generate dall'agente su misura. Export STL in millimetri.",
        },
        {
          tag: "Simulazione",
          title: "Numeri prima del ferro",
          body: "Simulazione SPICE integrata per verificare timing, filtri e partitori prima di ordinare: l'agente riporta le misure, non le impressioni.",
        },
      ],
    },
    shots: {
      title: "Così si presenta",
      captions: [
        ["Schematico", "Sezioni funzionali e controlli di leggibilità"],
        ["Sbroglio", "Viste dedicate e verifiche sulla scheda"],
        ["Scocca 3D", "La scheda dentro il suo contenitore"],
      ],
    },
    mcp: {
      title: "Porta il tuo agente",
      sub: "PCB Studio espone tutti gli strumenti di progettazione via MCP: il tuo Claude Code, Cursor o qualsiasi client MCP progetta con lo stesso motore dell'app. Generi un token nella sezione Team e sei operativo.",
      cmd: "claude mcp add --transport http pcb-studio https://pcb-studio.vercel.app/api/mcp/mcp --header \"Authorization: Bearer pcbs_iltuotoken\"",
      points: [
        "Stesso motore di compilazione, DRC e libreria dell'app",
        "Il token vale quanto il tuo utente: stessa ACL, stessi progetti",
        "Leggi e scrivi progetti, compili, esporti — tutto da tool",
      ],
    },
    pricing: {
      title: "Gratis. Sul serio.",
      body: "Niente abbonamento e niente copilot a consumo: l'intelligenza la porti tu. Colleghi il tuo agente via MCP, oppure imposti la tua API key (tua o dell'organizzazione) nella pagina del team.",
      card1: {
        title: "Con il tuo agente (MCP)",
        body: "Claude Code, Cursor o qualsiasi client MCP: progetti dal tuo ambiente, con i tuoi modelli e i tuoi limiti.",
        tag: "Disponibile ora",
      },
      card2: {
        title: "Con la tua API key",
        body: "Il copilota integrato nello Studio con la tua chiave GLM o Gemini, cifrata e salvata nel tuo profilo o in quello dell'organizzazione.",
        tag: "Disponibile ora",
      },
    },
    final: {
      title: "La scheda che hai in testa merita di esistere.",
      sub: "Registrati con la tua email aziendale e progetta la prima scheda oggi.",
      cta: "Inizia gratis",
    },
    footer: "Un progetto personale di Niccolò Calandri — open source, licenza GPL-3.0-or-later.",
  },
  en: {
    nav: { login: "Sign in", cta: "Start for free" },
    hero: {
      badge: "Free · Bring your own agent",
      title: "Your next board,\ndesigned by talking.",
      sub: "PCB Studio turns a conversation into real electronics: schematic, routing with the fabricator's rules, a BOM with supplier part numbers and a 3D enclosure. You describe what it must do, the agent draws it, you send it to production.",
      ctaPrimary: "Start for free",
      ctaSecondary: "Use your Claude via MCP",
      note: "No credit card. Sign in with an email link.",
    },
    steps: {
      title: "From prompt to factory",
      items: [
        {
          n: "01",
          title: "Describe the circuit",
          body: "“A data logger with an ESP32, two I2C sensors and a LiPo battery”. The agent picks real in-stock parts and writes the project.",
        },
        {
          n: "02",
          title: "Steer, fix, touch it",
          body: "Drag components and draw wires by hand in the viewer, or just ask in chat. DRC, electrical rules and fabrication checks run on every compile.",
        },
        {
          n: "03",
          title: "Send it to production",
          body: "Gerbers, a BOM with LCSC part numbers and pick & place, ready for the fab. Plus a 3D-printable enclosure as STL.",
        },
      ],
    },
    features: {
      title: "Everything you need, in one place",
      items: [
        {
          tag: "Schematic",
          title: "Schematics people can read",
          body: "Functional sections, frames, net labels and drawing-quality checks: the sheet looks like an engineer drew it, not like generated art.",
        },
        {
          tag: "Routing",
          title: "Real rules, not hints",
          body: "Cloud autorouting, DRC with JLCPCB rules, electrical (ERC) and power (PRC) checks on every compile. If something is wrong, you see it on the board.",
        },
        {
          tag: "Editor",
          title: "AI designs, you steer",
          body: "Drag symbols and components, wire pins by hand, pin the positions that must not change. Your manual edits stay yours: the agent respects them.",
        },
        {
          tag: "Library",
          title: "Parts that actually exist",
          body: "Footprints and symbols from the LCSC/JLCPCB catalogs, datasheets as agent context, and a BOM with supplier codes and quantities.",
        },
        {
          tag: "3D · new",
          title: "The enclosure too",
          body: "A two-shell parametric enclosure auto-sized to the board, STEP/STL/OBJ/GLB import, agent-designed custom enclosures. STL export in millimetres.",
        },
        {
          tag: "Simulation",
          title: "Numbers before solder",
          body: "Built-in SPICE simulation to verify timing, filters and dividers before ordering: the agent reports measurements, not impressions.",
        },
      ],
    },
    shots: {
      title: "This is what it looks like",
      captions: [
        ["Schematic", "Functional sections and readability checks"],
        ["Routing", "Purpose-built views and on-board checks"],
        ["3D enclosure", "The board inside its case"],
      ],
    },
    mcp: {
      title: "Bring your own agent",
      sub: "PCB Studio exposes every design tool over MCP: your Claude Code, Cursor or any MCP client designs with the same engine as the app. Generate a token in the Team section and you're set.",
      cmd: "claude mcp add --transport http pcb-studio https://pcb-studio.vercel.app/api/mcp/mcp --header \"Authorization: Bearer pcbs_yourtoken\"",
      points: [
        "Same compile engine, DRC and library as the app",
        "The token acts as you: same ACL, same projects",
        "Read and write projects, compile, export — all as tools",
      ],
    },
    pricing: {
      title: "Free. Really.",
      body: "No subscription and no metered copilot: you bring the intelligence. Connect your agent via MCP, or set your own API key (yours or your organisation's) in the team page.",
      card1: {
        title: "With your agent (MCP)",
        body: "Claude Code, Cursor or any MCP client: design from your environment, with your models and your limits.",
        tag: "Available now",
      },
      card2: {
        title: "With your API key",
        body: "The copilot built into the Studio, running on your GLM or Gemini key — encrypted and stored on your profile or your organisation's.",
        tag: "Available now",
      },
    },
    final: {
      title: "The board in your head deserves to exist.",
      sub: "Sign up with your work email and design your first board today.",
      cta: "Start for free",
    },
    footer: "A personal project by Niccolò Calandri — open source, GPL-3.0-or-later license.",
  },
} as const;

export function Landing() {
  const [lang, setLang] = useState<Lang>("it");
  const t = COPY[lang];

  return (
    <div className="min-h-dvh bg-canvas text-text">
      {/* nav */}
      <header className="sticky top-0 z-30 border-b border-line bg-[rgba(7,10,9,0.85)] backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-2.5 px-4 sm:gap-3 sm:px-5">
          <span className="grid h-[30px] w-[30px] flex-none place-items-center rounded-lg border border-[#2B4B41] bg-gradient-to-br from-[#123027] to-[#0E1A17]">
            <span className="h-3 w-3 rounded-[2px] border-[1.5px] border-brand" />
          </span>
          <span className="text-[15px] font-semibold tracking-[-0.01em] whitespace-nowrap">PCB Studio</span>
          <span className="hidden text-[11px] text-faint sm:inline">di Niccolò Calandri</span>
          <div className="flex-1" />
          <div className="flex flex-none gap-0.5 rounded-[9px] border border-line bg-[#0F1716] p-[3px] font-mono text-[11px]">
            {(["it", "en"] as const).map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => setLang(l)}
                className={`rounded-[6px] px-3 py-1.5 uppercase transition-colors ${
                  lang === l ? "bg-brand-wash font-semibold text-brand" : "text-[#7D8F8A] hover:text-text"
                }`}
              >
                {l}
              </button>
            ))}
          </div>
          <a
            href="/login"
            className="hidden flex-none rounded-[10px] border border-line-strong bg-[#141C1A] px-4 py-2 text-[13px] font-medium whitespace-nowrap text-[#C7D6D1] transition-colors hover:border-[#3A5A50] sm:inline-block"
          >
            {t.nav.login}
          </a>
          <a
            href="/login"
            className="flex-none rounded-[10px] bg-brand px-3.5 py-2 text-[12.5px] font-semibold whitespace-nowrap text-[#06110D] transition-opacity hover:opacity-90 sm:px-4 sm:text-[13px]"
          >
            {t.nav.cta}
          </a>
        </div>
      </header>

      {/* hero */}
      <section className="mx-auto max-w-6xl px-5 pt-16 pb-10 text-center">
        <span className="inline-block rounded-full border border-[#2C4C42] bg-brand-wash px-3.5 py-1.5 text-[12px] font-semibold text-brand">
          {t.hero.badge}
        </span>
        <h1 className="mx-auto mt-6 max-w-3xl text-[42px] leading-[1.08] font-bold tracking-[-0.02em] whitespace-pre-line sm:text-[56px]">
          {t.hero.title}
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-[16px] leading-[1.65] text-muted">
          {t.hero.sub}
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <a
            href="/login"
            className="rounded-[12px] bg-brand px-7 py-3.5 text-[15px] font-semibold text-[#06110D] transition-opacity hover:opacity-90"
          >
            {t.hero.ctaPrimary}
          </a>
          <a
            href="#mcp"
            className="rounded-[12px] border border-line-strong bg-[#141C1A] px-7 py-3.5 text-[15px] font-medium text-[#C7D6D1] transition-colors hover:border-[#3A5A50]"
          >
            {t.hero.ctaSecondary}
          </a>
        </div>
        <p className="mt-4 text-[12px] text-faint">{t.hero.note}</p>

        <div className="mt-12 overflow-hidden rounded-2xl border border-[#1F2C29] shadow-[0_0_80px_rgba(59,232,176,0.08)]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/landing/hero-esplosa.png" alt="PCB Studio — designer 3D di scocche" className="w-full" />
        </div>
      </section>

      {/* steps */}
      <section className="border-t border-line bg-sunken">
        <div className="mx-auto max-w-6xl px-5 py-16">
          <h2 className="text-center text-[28px] font-bold tracking-[-0.01em]">{t.steps.title}</h2>
          <div className="mt-10 grid gap-5 md:grid-cols-3">
            {t.steps.items.map((s) => (
              <div key={s.n} className="rounded-2xl border border-line bg-gradient-to-b from-[#0E1514] to-[#0A0F0E] p-6">
                <div className="font-mono text-[13px] font-semibold text-brand">{s.n}</div>
                <h3 className="mt-3 text-[17px] font-semibold">{s.title}</h3>
                <p className="mt-2 text-[13.5px] leading-[1.6] text-muted">{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* features */}
      <section className="border-t border-line">
        <div className="mx-auto max-w-6xl px-5 py-16">
          <h2 className="text-center text-[28px] font-bold tracking-[-0.01em]">{t.features.title}</h2>
          <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {t.features.items.map((f) => (
              <div key={f.tag} className="flex flex-col gap-2.5 rounded-2xl border border-line p-6 transition-colors hover:border-[#2C4C42]">
                <span className="w-fit rounded-md border border-[#2C4C42] bg-brand-wash px-2 py-1 font-mono text-[10px] font-semibold tracking-[0.06em] text-brand uppercase">
                  {f.tag}
                </span>
                <h3 className="text-[16px] font-semibold">{f.title}</h3>
                <p className="text-[13px] leading-[1.6] text-muted">{f.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* screenshots */}
      <section className="border-t border-line bg-sunken">
        <div className="mx-auto max-w-6xl px-5 py-16">
          <h2 className="text-center text-[28px] font-bold tracking-[-0.01em]">{t.shots.title}</h2>
          <div className="mt-10 grid gap-5 md:grid-cols-3">
            {(["schematico", "sbroglio", "scocca"] as const).map((img, i) => (
              <figure key={img} className="overflow-hidden rounded-2xl border border-line bg-[#0A0F0E]">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/landing/${img}.png`} alt={t.shots.captions[i][0]} className="aspect-[16/10] w-full object-cover object-top" />
                <figcaption className="px-4 py-3">
                  <div className="text-[13px] font-semibold">{t.shots.captions[i][0]}</div>
                  <div className="text-[11.5px] text-faint">{t.shots.captions[i][1]}</div>
                </figcaption>
              </figure>
            ))}
          </div>
        </div>
      </section>

      {/* mcp */}
      <section id="mcp" className="border-t border-line">
        <div className="mx-auto max-w-4xl px-5 py-16">
          <h2 className="text-center text-[28px] font-bold tracking-[-0.01em]">{t.mcp.title}</h2>
          <p className="mx-auto mt-4 max-w-2xl text-center text-[14.5px] leading-[1.65] text-muted">
            {t.mcp.sub}
          </p>
          <div className="mt-8 overflow-x-auto rounded-xl border border-[#1F2C29] bg-[#0A0F0E] px-4 py-3.5 sm:px-5 sm:py-4">
            <code className="font-mono text-[11px] leading-[1.7] whitespace-pre text-[#3BE8B0] sm:text-[12.5px]">
              {t.mcp.cmd}
            </code>
          </div>
          <ul className="mx-auto mt-6 flex max-w-2xl flex-col gap-2.5">
            {t.mcp.points.map((p) => (
              <li key={p} className="flex items-start gap-2.5 text-[13.5px] text-muted">
                <span className="mt-[7px] h-[7px] w-[7px] flex-none rounded-full bg-brand" />
                {p}
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* pricing */}
      <section className="border-t border-line bg-sunken">
        <div className="mx-auto max-w-4xl px-5 py-16 text-center">
          <h2 className="text-[28px] font-bold tracking-[-0.01em]">{t.pricing.title}</h2>
          <p className="mx-auto mt-4 max-w-2xl text-[14.5px] leading-[1.65] text-muted">{t.pricing.body}</p>
          <div className="mt-10 grid gap-5 sm:grid-cols-2">
            {[t.pricing.card1, t.pricing.card2].map((c) => (
              <div key={c.title} className="flex flex-col gap-2.5 rounded-2xl border border-line bg-gradient-to-b from-[#0E1514] to-[#0A0F0E] p-6 text-left">
                <span className="w-fit rounded-md border border-[#2C4C42] bg-brand-wash px-2 py-1 font-mono text-[10px] font-semibold text-brand uppercase">
                  {c.tag}
                </span>
                <h3 className="text-[16px] font-semibold">{c.title}</h3>
                <p className="text-[13px] leading-[1.6] text-muted">{c.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* final cta */}
      <section className="border-t border-line">
        <div className="mx-auto max-w-3xl px-5 py-20 text-center">
          <h2 className="text-[32px] leading-[1.15] font-bold tracking-[-0.02em]">{t.final.title}</h2>
          <p className="mt-4 text-[15px] text-muted">{t.final.sub}</p>
          <a
            href="/login"
            className="mt-8 inline-block rounded-[12px] bg-brand px-9 py-4 text-[16px] font-semibold text-[#06110D] transition-opacity hover:opacity-90"
          >
            {t.final.cta}
          </a>
        </div>
      </section>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-5 py-8 text-[12px] text-faint">
          <span className="grid h-[22px] w-[22px] place-items-center rounded-md border border-[#2B4B41] bg-gradient-to-br from-[#123027] to-[#0E1A17]">
            <span className="h-2 w-2 rounded-[2px] border border-brand" />
          </span>
          <span>{t.footer}</span>
          <span className="flex-1" />
          <a href="/login" className="px-1 py-2 transition-colors hover:text-text">{t.nav.login}</a>
        </div>
      </footer>
    </div>
  );
}
