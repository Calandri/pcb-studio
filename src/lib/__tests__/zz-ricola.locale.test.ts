// BANCO LOCALE (non committare): rifa' le colate di un circuito gia' compilato partendo dai contorni scritti nel main.tsx,
// con ricolaPiani e le regole del progetto, sul rame finale. Serve perche' ricolaPiani tiene il contorno esterno che
// tscircuit ha calcolato durante il montaggio, quando sulla scheda c'erano ancora le piste di passaggio dell'instradatore:
// sulla sonda del suolo (p24) quel contorno tagliava la colata P3V3_D di L3 lungo i pin 30-36 dell'MCU, piste che nel
// circuito finale non esistono piu'.
import { it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { ricolaPiani } from "@/lib/pours-recompute";
import { resolveDesignRules } from "@/lib/design-rules";
it("ricola", async () => {
  const circ = process.env.CIRCUITO!; const dir = process.env.PROGETTO_DIR!; const out = process.env.USCITA!;
  const c: any[] = JSON.parse(readFileSync(circ, "utf8"));
  const main = readFileSync(`${dir}/main.tsx`, "utf8");
  const regole = resolveDesignRules({ "main.tsx": main, "design-rules.json": readFileSync(`${dir}/design-rules.json`, "utf8") }).rules;
  const reti = new Map(c.filter((e) => e.type === "source_net").map((e) => [e.name, e]));
  const vecchie = c.filter((e) => e.type === "pcb_copper_pour");
  const nuove: any[] = [];
  let i = 0;
  for (const m of main.matchAll(/<copperpour layer="(\w+)" connectsTo="net\.(\w+)"[^>]*outline=\{\[(.*?)\]\}/g)) {
    const net = reti.get(m[2]);
    if (!net) throw new Error(`rete ${m[2]} non trovata`);
    const vertices = [...m[3].matchAll(/x:(-?[\d.]+),y:(-?[\d.]+)/g)].map((q) => ({ x: +q[1], y: +q[2] }));
    const stessa = vecchie.find((v) => v.layer === m[1] && v.source_net_id === net.source_net_id) ?? vecchie[0];
    nuove.push({ ...stessa, pcb_copper_pour_id: `pcb_copper_pour_ricolata_${i++}`, layer: m[1], source_net_id: net.source_net_id,
                 shape: "brep", brep_shape: { outer_ring: { vertices }, inner_rings: [] } });
  }
  const r = await ricolaPiani({
    circuitJson: [...c.filter((e) => e.type !== "pcb_copper_pour"), ...nuove],
    clearanceMm: regole.pourClearanceMm ?? regole.minClearanceMm,
    bordoMm: regole.minBoardEdgeClearanceMm,
    larghezzaMinimaMm: regole.minTraceWidthMm,
  });
  writeFileSync(out, JSON.stringify(r.circuitJson));
  const { circuitJson: _c, ...esito } = r;
  console.log("RICOLATA", nuove.length, "contorni", JSON.stringify(esito));
}, 600_000);
