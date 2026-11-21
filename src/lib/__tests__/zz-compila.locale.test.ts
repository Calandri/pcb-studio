// BANCO LOCALE (non committare): compila una cartella di progetto come fa la produzione e salva circuito e riepilogo.
import { it } from "vitest";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compileProject } from "@/lib/compile";
it("compila", async () => {
  const dir = process.env.PROGETTO_DIR!; const out = process.env.USCITA!;
  const fsMap: Record<string, string> = {};
  for (const f of readdirSync(dir)) if (/\.(tsx|json)$/.test(f) && !f.includes("circuit") ) fsMap[f.replace(/__/g, "/")] = readFileSync(join(dir, f), "utf8");
  const t0 = Date.now();
  const r: any = await compileProject(fsMap as any, (process.env.SENZA_ROUTING ? { route: false } : {}) as any);
  writeFileSync(`${out}.circuit.json`, JSON.stringify(r.circuitJson));
  writeFileSync(`${out}.summary.json`, JSON.stringify({ ms: Date.now() - t0, ...r.summary }, (_k, v) => (v instanceof Map ? Object.fromEntries(v) : v)));
}, 1_500_000);
