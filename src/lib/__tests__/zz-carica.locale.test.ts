// BANCO LOCALE (non committare): salva una revisione del progetto com'e' nel DB, poi scrive i file della cartella
// PROGETTO_DIR (solo quelli che cambiano) e ricompila salvando la cache, come il compile MCP.
import { it } from "vitest";
import "./zz-neon-dns";
import fs from "node:fs";
import path from "node:path";
import { compileProject } from "@/lib/compile";
import { withLibrary } from "@/lib/agent-tools";
import { filesHash, getProject, saveCompileCache, saveRevision, writeProjectFile } from "@/lib/project-store";
import { CHECKS_ENGINE_VERSION } from "@/lib/engine-version";
it("carica, compila e salva", async () => {
  const projectId = process.env.PROGETTO!;
  const dir = process.env.PROGETTO_DIR!;
  const prima = await getProject(projectId);
  await saveRevision(projectId, prima, null);
  const cambiati: string[] = [];
  for (const nome of fs.readdirSync(dir)) {
    const contenuto = fs.readFileSync(path.join(dir, nome), "utf8");
    if (prima[nome] === contenuto) continue;
    await writeProjectFile(projectId, nome, contenuto);
    cambiati.push(nome);
  }
  console.log("REVISIONE salvata; file scritti:", cambiati.join(", ") || "nessuno");
  const fsMap = await withLibrary(await getProject(projectId));
  const { summary, circuitJson } = await compileProject(fsMap, {} as never);
  const s = summary as { targets?: unknown };
  const r = await saveCompileCache(projectId, filesHash(fsMap), circuitJson as unknown[], summary, CHECKS_ENGINE_VERSION);
  console.log("COMPILATO", JSON.stringify(s.targets), "| SALVATAGGIO", JSON.stringify(r));
}, 900000);
