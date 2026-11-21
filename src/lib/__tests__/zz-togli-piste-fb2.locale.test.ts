// BANCO LOCALE (non committare): toglie dal progetto SOLO le piste a mano di manual-edits.json che partono da FB2 (".FB2 > ...").
// 18/11/2026, dongle V1.3: le due piste di Niccolo' di FB2 sono state riscritte nel file con la via spostata a 0,20 dalla piazzola.
// Sicurezze: main.tsx del DB uguale a quello atteso, revisione salvata, scrive solo se il file non e' cambiato nel frattempo.
import { it } from "vitest";
import "./zz-neon-dns";
import fs from "node:fs";
import { getProject, saveRevision, updateProjectFile } from "@/lib/project-store";
it("toglie le piste a mano di FB2", async () => {
  const projectId = process.env.PROGETTO!;
  const atteso = fs.readFileSync(process.env.MAIN_ATTESO!, "utf8");
  const prima = await getProject(projectId);
  if (prima["main.tsx"] !== atteso) throw new Error("main.tsx del DB non e' quello atteso: non tocco niente");
  await saveRevision(projectId, prima, null);
  let tolte: string[] = []; let restano: string[] = [];
  const r = await updateProjectFile(projectId, "manual-edits.json", (current) => {
    if (current === null) return null;
    const m = JSON.parse(current) as { pcb_routes?: Array<{ connection?: string }> };
    const rr = m.pcb_routes ?? [];
    tolte = rr.filter((x) => String(x.connection).startsWith(".FB2 >")).map((x) => String(x.connection));
    m.pcb_routes = rr.filter((x) => !String(x.connection).startsWith(".FB2 >"));
    restano = m.pcb_routes.map((x) => String(x.connection));
    if (tolte.length === 0) return null;
    return JSON.stringify(m, null, 1);
  });
  console.log("ESITO scritto:", r.written, "| tolte:", JSON.stringify(tolte), "| restano:", JSON.stringify(restano));
}, 120000);
