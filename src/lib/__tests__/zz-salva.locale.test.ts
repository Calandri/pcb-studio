// BANCO LOCALE (non committare): il flusso del compile MCP contro il DB vero (DATABASE_URL dall'ambiente)
import { it } from "vitest";
import { compileProject } from "@/lib/compile";
import { withLibrary } from "@/lib/agent-tools";
import { filesHash, getProject, saveCompileCache, savePreviewCircuit } from "@/lib/project-store";
import { CHECKS_ENGINE_VERSION } from "@/lib/engine-version";
it("compila e salva", async () => {
  const projectId = process.env.PROGETTO!;
  const fsMap = await withLibrary(await getProject(projectId));
  let last = 0; let anteprime = 0; const errori: string[] = [];
  const t0 = Date.now();
  const { summary, circuitJson } = await compileProject(fsMap, {
    onProgress: (p: { circuitJson?: unknown[] }) => {
      if (!p.circuitJson || process.env.SENZA_ANTEPRIME) return;
      const now = Date.now(); if (now - last < 3000) return; last = now; anteprime++;
      void savePreviewCircuit(projectId, p.circuitJson).catch((e: unknown) => errori.push(String(e)));
    },
  } as never);
  console.log("compilato in", Date.now() - t0, "ms, anteprime", anteprime, "errori anteprime", errori.slice(0, 3));
  const r = await saveCompileCache(projectId, filesHash(fsMap), circuitJson as unknown[], summary, CHECKS_ENGINE_VERSION)
    .catch((err: unknown) => ({ saved: false, reason: err instanceof Error ? `${err.message} | causa: ${String((err as { cause?: unknown }).cause ?? "")}` : String(err) }));
  console.log("SALVATAGGIO", JSON.stringify(r), "hash", filesHash(fsMap).slice(0, 12), "dopo", Date.now() - t0, "ms");
}, 900000);
