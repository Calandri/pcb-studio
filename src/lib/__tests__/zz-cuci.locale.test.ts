// BANCO LOCALE (non committare): lancia lo strumento stitch_ground su una scheda compilata dal banco, come fa la produzione.
// PROGETTO_DIR = cartella del progetto, CIRCUITO = circuit.json compilato da quei file, ARGOMENTI = JSON delle opzioni, USCITA = file .json
import { it } from "vitest";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eseguiCucitura } from "@/lib/ground-stitching-tool";
it("cuci", async () => {
  const dir = process.env.PROGETTO_DIR!;
  const files: Record<string, string> = {};
  for (const f of readdirSync(dir)) if (/\.(tsx|json)$/.test(f)) files[f.replace(/__/g, "/")] = readFileSync(join(dir, f), "utf8");
  const circuitJson = JSON.parse(readFileSync(process.env.CIRCUITO!, "utf8"));
  const args = JSON.parse(process.env.ARGOMENTI || "{}");
  const scritti: Record<string, string> = {};
  const r = await eseguiCucitura({ files, args, cache: { circuitJson } as any, scheda: (process.env.STATO as any) || "aggiornata", scrivi: async (p, c) => { scritti[p] = c; } });
  writeFileSync(process.env.USCITA!, JSON.stringify({ result: r.result, scritti }, null, 1));
}, 600_000);
