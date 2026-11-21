// BANCO LOCALE (non committare): il progetto nel DB e' uguale alla cartella? e la cache di compilazione?
import { it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { getProject, getCompileCache, filesHash } from "@/lib/project-store";
import { withLibrary } from "@/lib/agent-tools";
it("verifica", async () => {
  const p = await getProject(process.env.PROGETTO!); const dir = process.env.PROGETTO_DIR!;
  const diversi = fs.readdirSync(dir).filter((n) => p[n] !== fs.readFileSync(path.join(dir, n), "utf8"));
  const h = filesHash(await withLibrary(p));
  const c = (await getCompileCache(process.env.PROGETTO!, h)) as { summary?: { targets?: unknown } } | null;
  fs.writeFileSync("/tmp/sost/verifica_db.json", JSON.stringify({ diversi, cache: c ? c.summary?.targets ?? "presente" : null }));
  expect(diversi).toEqual([]);
}, 300000);
