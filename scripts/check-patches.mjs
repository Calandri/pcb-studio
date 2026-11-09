// Fallisce se @tscircuit/core caricherebbe una copia NON corretta di una delle
// librerie in patches/ (vedi src/lib/engine-patches.mjs). Gira prima e dopo
// `next build`: una build con la copia sbagliata non arriva in produzione.
//
//   node scripts/check-patches.mjs            controlla
//   node scripts/check-patches.mjs --ripara   se manca, reinstalla e ricontrolla
//
// PERCHE' --ripara. Vercel ripristina node_modules dalla cache della build
// precedente e pnpm si fida dei nomi delle cartelle: il 09/11/2026 la cartella
// della libreria delle etichette con l'hash della patch c'era, ma il file dentro
// non conteneva la correzione, e `pnpm install --frozen-lockfile` rispondeva
// "Already up to date". Solo `--force` riscrive le cartelle e riapplica le patch
// (provato in locale). Costa una reinstallazione completa, e solo quando serve.
// --production=false perche' la build di Vercel gira con NODE_ENV=production e
// pnpm toglierebbe le devDependencies che la build usa (@tailwindcss/postcss).
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { patchedLibraries } from "../src/lib/engine-patches.mjs";

const repair = process.argv.includes("--ripara");

function report() {
  const result = patchedLibraries(process.cwd());
  for (const lib of result.libraries) {
    const why = lib.patched ? "ok   " : lib.file && existsSync(lib.file) ? "MANCA" : "ASSENTE";
    console.log(`${why} ${lib.name}  ${lib.file ?? "(non trovata)"}`);
  }
  return result.ok;
}

let ok = report();
if (!ok && repair) {
  console.log("copia senza correzione: reinstallo le dipendenze con --force e ricontrollo");
  execFileSync("pnpm", ["install", "--frozen-lockfile", "--force", "--production=false"], { stdio: "inherit" });
  ok = report();
}
if (!ok) {
  console.error(
    "patch di tscircuit non applicata alla copia che il compilatore carica: " +
      "controlla patchedDependencies e packageExtensions in package.json, poi pnpm install --force",
  );
  process.exit(1);
}
