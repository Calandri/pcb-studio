// BANCO LOCALE (non committare): il riepilogo di PCB Studio (DRC, PRC, errori) su un circuito gia' fatto, per esempio quello
// ricolato che va nei Gerber, con i file del progetto. CIRCUITO=... PROGETTO_DIR=... USCITA=...json
import { it } from "vitest";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { summarizeCircuit } from "@/lib/compile";
it("controlla", async () => {
  const c: unknown[] = JSON.parse(readFileSync(process.env.CIRCUITO!, "utf8"));
  const dir = process.env.PROGETTO_DIR!;
  const fs: Record<string, string> = {};
  for (const n of readdirSync(dir)) fs[n] = readFileSync(`${dir}/${n}`, "utf8");
  const s = await (summarizeCircuit as any)(c, fs);
  writeFileSync(process.env.USCITA!, JSON.stringify(s, null, 1));
  console.log("RIEPILOGO errori", s.errors?.length, "DRC", s.drcViolations?.length, "PRC", s.prcViolations?.length);
}, 300000);
