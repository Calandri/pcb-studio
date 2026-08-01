# PCB Studio

> Progetto personale di [Niccolò Calandri](https://github.com/Calandri), open
> source con licenza GPL-3.0.

Designa schede elettroniche vere parlando con un agente AI: schematico,
sbroglio con le regole del produttore, distinta con codici fornitore e scocca
3D. Tu descrivi cosa deve fare la scheda, l'agente la disegna, tu la mandi in
produzione.

Il progetto è scritto in [tscircuit](https://github.com/tscircuit/tscircuit):
il codice `.tsx` È il progetto. L'agente lo scrive e lo compila; la
compilazione instrada il PCB, esegue il DRC e misura la qualità dello
schematico. Tu puoi rifinire tutto a mano dal browser: sposti i componenti
(snap a passi standard, frecce, rotazione), instradi le piste clic per clic,
stacchi e ridisegni quello che non ti piace — il rame della zona si rifa in
un secondo, senza ricompilare la scheda.

## Cosa c'è dentro

- **Next.js 16** (App Router, Turbopack) + React 19, TypeScript
- **tscircuit** per schematico, autorouting e export (Gerber, BOM, pick&place)
- **Auth.js v5** con magic link via email (AWS SES)
- **Neon Postgres** per progetti, chat, cache di compilazione, libreria
- **Agente LLM** (GLM / Gemini, BYOK) con strumenti di progettazione e un
  server MCP per pilotare l'app da agenti esterni — vedi [MCP.md](./MCP.md)

L'import STEP usa [occt-import-js](https://github.com/kovacsv/occt-import-js)
(LGPL-2.1, © Viktor Kovacs), vendored in `public/occt/` con la sua licenza.

## Sviluppo

```bash
pnpm install
cp .env.example .env.local   # e riempi i valori
pnpm dev
```

Le variabili d'ambiente necessarie sono elencate e commentate in
[.env.example](./.env.example). In sviluppo il magic link di login viene
stampato nella console del server, non serve aprire la mail.

## Usa il modello che hai già (MCP)

Non serve pagare un agente in più: PCB Studio espone un **server MCP** e il
modello che usi già — Claude Code o qualsiasi client MCP — può progettare la
scheda con gli strumenti dell'app (leggere il progetto, scrivere i file,
compilare, cercare componenti, simulare). Due passi: token personale in
**Team → Accesso da agenti esterni**, poi `claude mcp add`. Tutto in
[MCP.md](./MCP.md).

## Struttura

- `src/app` — pagine (studio, libreria, datasheet, team) e API route
- `src/lib` — motore: compilazione, autorouting, DRC, piazzamento, editing
  manuale, agente LLM
- `src/components` — studio, canvas della scheda e dello schematico, editor
- `MCP.md` — accesso da agenti esterni via MCP

## Licenza

[GPL-3.0-or-later](./LICENSE). Il progetto era MIT fino alla versione 0.5: e'
passato a GPL-3 quando e' entrato l'import da Altium, che si appoggia a
[`altium-toolkit`](https://github.com/SunboX/altium-toolkit) — GPL-3 anche
quello. Le copie gia' rilasciate sotto MIT restano MIT per chi le ha.

In pratica: puoi usarlo, studiarlo, modificarlo e ridistribuirlo; se
ridistribuisci il programma o un lavoro che lo incorpora, devi distribuire anche
il sorgente sotto la stessa licenza. Usarlo come servizio su un tuo server non e'
distribuzione e non fa scattare nulla (GPL-3 non e' AGPL).
