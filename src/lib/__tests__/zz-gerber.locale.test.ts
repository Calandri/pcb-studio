// BANCO LOCALE (non committare): Gerber, forature, BOM e pick&place come la route di export
import { it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { convertSoupToGerberCommands, convertSoupToExcellonDrillCommands, stringifyExcellonDrill, stringifyGerberCommandLayers } from "circuit-json-to-gerber";
import { convertCircuitJsonToPickAndPlaceRows } from "circuit-json-to-pnp-csv";
import { bomToCsv, buildBom, centriDiMontaggio, pnpToCsv } from "@/lib/bom";
import { senzaRotazioneDiCarico } from "@/lib/gerber-rotation";
import { serigrafiaStampabile } from "@/lib/silk-stroke";
import { viePassantiSuOgniStrato } from "@/lib/via-layers";
it("gerber", async () => {
  const cj = JSON.parse(readFileSync(process.env.CIRCUITO!, "utf8"));
  const out = process.env.USCITA!; mkdirSync(out, { recursive: true });
  const { layers } = serigrafiaStampabile(senzaRotazioneDiCarico(stringifyGerberCommandLayers(convertSoupToGerberCommands(viePassantiSuOgniStrato(cj)))).layers);
  for (const [n, c] of Object.entries(layers)) writeFileSync(`${out}/${n}.gbr`, c as string);
  for (const isPlated of [true, false]) {
    const drill = convertSoupToExcellonDrillCommands({ circuitJson: cj, is_plated: isPlated });
    writeFileSync(`${out}/${isPlated ? "drill_plated" : "drill_unplated"}.drl`, stringifyExcellonDrill(drill));
  }
  writeFileSync(`${out}/pnp.csv`, pnpToCsv(centriDiMontaggio(convertCircuitJsonToPickAndPlaceRows(cj), cj)));
  const fsMap: Record<string, string> = { "main.tsx": readFileSync(process.env.MAIN!, "utf8") };
  writeFileSync(`${out}/bom.csv`, bomToCsv(buildBom(cj, fsMap)));
}, 300000);
