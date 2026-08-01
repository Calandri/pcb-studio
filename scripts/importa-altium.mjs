/**
 * IMPORTA UNA SCHEDA ALTIUM DA TERMINALE.
 *
 *   pnpm importa:altium <cartella-o-file...> [--progetto <id>] [--su <url>]
 *                       [--senza-datasheet] [--senza-footprint] [--senza-compilare]
 *
 * Esempi:
 *   pnpm importa:altium ~/Downloads/BAT_BS
 *   pnpm importa:altium ~/Downloads/BAT_BS --progetto altium-bat-bs
 *   pnpm importa:altium ~/schede/BS.PcbDoc ~/schede/BS.SchDoc --su http://localhost:3000
 *
 * Una cartella viene letta per intero: .PcbDoc, .SchDoc, .PrjPcb, .PcbLib,
 * .SchLib, .IntLib. Tutto il resto viene ignorato senza lamentarsi.
 *
 * PARLA CON L'APP, non ricostruisce l'import da capo: chiama
 * POST /api/import/altium col token personale, cioe' la stessa strada che fa il
 * browser quando trascini i file sulla pagina. Cosi' una scheda importata da
 * qui e una importata dal browser sono la stessa scheda, e questo file resta
 * sessanta righe che non hanno bisogno di sapere nulla di Altium.
 *
 * Serve un token: PCB_STUDIO_TOKEN nell'ambiente o in .env.local
 * (lo si crea in Impostazioni -> Chiavi API, comincia per pcbs_).
 * L'indirizzo di default e' la produzione: --su per puntare altrove.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const ESTENSIONI = [".pcbdoc", ".schdoc", ".prjpcb", ".pcbdwf", ".pcblib", ".schlib", ".intlib"];
const estensione = (f) => (/\.[a-z0-9]+$/i.exec(f)?.[0] ?? "").toLowerCase();

/** le variabili di .env.local, senza sovrascrivere l'ambiente */
try {
  const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  for (const riga of env.split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(riga.trim());
    if (m) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, "");
  }
} catch {
  // nessun .env.local: il token puo' arrivare dall'ambiente
}

const argomenti = process.argv.slice(2);
const opzione = (nome) => {
  const i = argomenti.indexOf(nome);
  return i >= 0 ? (argomenti[i + 1] ?? null) : null;
};
const flag = (nome) => argomenti.includes(nome);
const conValore = new Set(["--progetto", "--su"]);
const percorsi = argomenti.filter(
  (a, i) => !a.startsWith("--") && !conValore.has(argomenti[i - 1]),
);

const uso = () =>
  console.error(
    "uso: pnpm importa:altium <cartella-o-file...> [--progetto <id>] [--su <url>]" +
      " [--senza-datasheet] [--senza-footprint] [--senza-compilare]",
  );

if (percorsi.length === 0) {
  uso();
  process.exit(1);
}

const token = process.env.PCB_STUDIO_TOKEN;
if (!token) {
  console.error(
    "manca PCB_STUDIO_TOKEN (Impostazioni -> Chiavi API su pcb-studio.com, comincia per pcbs_)",
  );
  process.exit(1);
}
const base = (opzione("--su") ?? process.env.PCB_STUDIO_URL ?? "https://pcb-studio.com").replace(
  /\/+$/,
  "",
);

/** i file da caricare: una cartella si espande, un file si prende com'e' */
const daLeggere = [];
for (const p of percorsi) {
  const info = statSync(p, { throwIfNoEntry: false });
  if (!info) {
    console.error(`non esiste: ${p}`);
    process.exit(1);
  }
  if (info.isDirectory()) {
    for (const f of readdirSync(p).sort()) {
      if (ESTENSIONI.includes(estensione(f))) daLeggere.push(join(p, f));
    }
  } else if (ESTENSIONI.includes(estensione(p))) {
    daLeggere.push(p);
  } else {
    console.error(`estensione non gestita, salto: ${p}`);
  }
}
if (daLeggere.length === 0) {
  console.error(`nessun file Altium trovato (cerco ${ESTENSIONI.join(", ")})`);
  process.exit(1);
}

/*
 * I file salgono COMPRESSI. Non per risparmiare: il corpo di una richiesta su
 * Vercel si ferma a 4.5 MB e un progetto Altium vero e' di piu' (BAT_BS: 5.8 MB
 * in dodici file, rifiutati con un 413). Gli stessi file gzippati sono 2.8 MB,
 * perche' un contenitore OLE e' mezzo aria. Il nome finisce per .gz e
 * l'endpoint sa cosa farne.
 */
const form = new FormData();
let bytes = 0;
let compressi = 0;
for (const p of daLeggere) {
  const dati = readFileSync(p);
  const gz = gzipSync(dati, { level: 9 });
  bytes += dati.byteLength;
  compressi += gz.byteLength;
  form.append("file", new Blob([gz]), `${p.split("/").pop()}.gz`);
}
const progetto = opzione("--progetto");
if (progetto) form.append("projectId", progetto);
for (const [flagCli, campo] of [
  ["--senza-datasheet", "senzaDatasheet"],
  ["--senza-footprint", "senzaFootprint"],
  ["--senza-compilare", "senzaCompilare"],
]) {
  if (flag(flagCli)) form.append(campo, "1");
}

console.log(
  `${daLeggere.length} file (${(bytes / 1024 / 1024).toFixed(1)} MB, ${(compressi / 1024 / 1024).toFixed(1)} compressi)` +
    ` -> ${base}/api/import/altium${progetto ? ` [progetto ${progetto}]` : ""}`,
);
if (compressi > 4.4 * 1024 * 1024) {
  console.error(
    "attenzione: anche compresso il carico supera i 4.5 MB che l'hosting accetta." +
      " Carica meno file per volta (il .PcbDoc da solo basta per la scheda).",
  );
}
const inizio = Date.now();
const risposta = await fetch(`${base}/api/import/altium`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}` },
  body: form,
  // un .PcbDoc grande, piu' i datasheet, piu' la compilazione: minuti, non secondi
  signal: AbortSignal.timeout(15 * 60 * 1000),
});
const secondi = Math.round((Date.now() - inizio) / 1000);
const testo = await risposta.text();
let dati;
try {
  dati = JSON.parse(testo);
} catch {
  console.error(`risposta non JSON (${risposta.status}): ${testo.slice(0, 400)}`);
  process.exit(1);
}
if (!risposta.ok) {
  console.error(`errore ${risposta.status}: ${dati.error ?? testo.slice(0, 400)}`);
  process.exit(1);
}

const p = dati.project;
console.log(`\n=== ${p?.id ?? "(nessun progetto)"} in ${secondi}s ===`);
if (p) {
  console.log(`  componenti   ${p.components}`);
  console.log(`  connessioni  ${p.traces}`);
  console.log(`  rame         ${p.routes} segmenti`);
  console.log(`  footprint    ${p.footprints} dalla scheda, ${dati.components} dalle librerie`);
  if (p.datasheets) {
    console.log(
      `  datasheet    ${p.datasheets.scaricati}/${p.datasheets.su} (${p.datasheets.pagine} pagine)`,
    );
  }
  if (p.compiled) {
    const c = p.compiled;
    console.log(
      `  compilato    ok=${c.ok} piste=${c.piste} via=${c.via} piani=${c.piani} errori=${c.errori} DRC=${c.drc}`,
    );
  }
  const dettagli = Object.entries(dati.stats ?? {}).filter(([, v]) => typeof v === "number");
  if (dettagli.length) {
    console.log(`  dettagli     ${dettagli.map(([k, v]) => `${k}=${v}`).join("  ")}`);
  }
  console.log(`\n  apri: ${base}/?project=${p.id}`);
}
for (const w of dati.warnings ?? []) console.log(`  - ${w}`);
