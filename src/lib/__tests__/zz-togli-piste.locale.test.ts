// BANCO LOCALE (non committare): toglie dal progetto le piste tirate a mano di manual-edits.json (pcb_routes) e nient'altro.
// Chiesto da Niccolo' il 12/11/2026 sul dongle ("togli le piste vecchie e i via vecchi"): le 100 piste della V1.1 restavano
// sulla scheda dopo il nuovo piazzamento e solo il visore le poteva togliere, buttando pero' anche le posizioni a mano.
// Sicurezze: controlla di parlare col progetto giusto (main.tsx uguale a quello atteso), salva una revisione nel DB, scrive solo
// se il file non e' cambiato nel frattempo (updateProjectFile: versione letta = versione scritta, altrimenti rilegge e rifa').
import { it } from "vitest";
import "./zz-neon-dns";
import fs from "node:fs";
import { getProject, saveRevision, updateProjectFile } from "@/lib/project-store";
it("toglie le piste a mano", async () => {
  const projectId = process.env.PROGETTO!;
  const atteso = fs.readFileSync(process.env.MAIN_ATTESO!, "utf8");
  const prima = await getProject(projectId);
  if (prima["main.tsx"] !== atteso) throw new Error("main.tsx del DB non e' quello atteso: non tocco niente");
  await saveRevision(projectId, prima, null);
  let tolte = 0; let posizioni = 0;
  const r = await updateProjectFile(projectId, "manual-edits.json", (current) => {
    if (current === null) return null;
    const m = JSON.parse(current) as { pcb_routes?: unknown[]; pcb_placements?: unknown[] };
    tolte = (m.pcb_routes ?? []).length; posizioni = (m.pcb_placements ?? []).length;
    if (tolte === 0) return null;
    m.pcb_routes = [];
    return JSON.stringify(m, null, 1);
  });
  console.log("ESITO scritto:", r.written, "| piste tolte:", tolte, "| posizioni a mano lasciate:", posizioni);
}, 120000);
