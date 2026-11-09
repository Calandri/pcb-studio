// Fallisce se @tscircuit/core caricherebbe una copia NON corretta di una delle
// librerie in patches/ (vedi src/lib/engine-patches.mjs). Gira prima e dopo
// `next build`: una build con la copia sbagliata non arriva in produzione.
//
//   node scripts/check-patches.mjs
import { patchedLibraries } from "../src/lib/engine-patches.mjs";

const { ok, libraries } = patchedLibraries(process.cwd());
for (const lib of libraries) {
  console.log(`${lib.patched ? "ok   " : "MANCA"} ${lib.name}  ${lib.file ?? "(non trovata)"}`);
}
if (!ok) {
  console.error(
    "patch di tscircuit non applicata alla copia che il compilatore carica: " +
      "controlla patchedDependencies e packageExtensions in package.json, poi pnpm install",
  );
  process.exit(1);
}
