// BANCO LOCALE (non committare): chiede alla cucitura di PCB Studio (copia con la sonda) il verdetto per una lista di punti.
// CIRCUITO = circuit.json, REGOLE = design-rules.json del progetto, PUNTI = json [[x,y],...], OPZIONI = json, USCITA = file json
import { it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { cuciLaMassa } from "@/lib/zz-ground-stitching-sonda";
import { resolveDesignRules } from "@/lib/design-rules";
it("sonda", async () => {
  const cj = JSON.parse(readFileSync(process.env.CIRCUITO!, "utf8"));
  const regole = resolveDesignRules({ "design-rules.json": readFileSync(process.env.REGOLE!, "utf8") } as any).rules;
  const punti = JSON.parse(readFileSync(process.env.PUNTI!, "utf8")).map(([x, y]: number[]) => ({ x, y }));
  const r: any = cuciLaMassa(cj, regole, { ...(JSON.parse(process.env.OPZIONI || "{}")), sonda: punti } as any);
  writeFileSync(process.env.USCITA!, JSON.stringify(r.sonda ?? r));
}, 600_000);
