import { it } from "vitest";
import "./zz-neon-dns";
import { compileProject } from "@/lib/compile";
import { withLibrary } from "@/lib/agent-tools";
import { getProject } from "@/lib/project-store";
it("compila e stampa", async () => {
  const fsMap = await withLibrary(await getProject(process.env.PROGETTO!));
  const { summary } = await compileProject(fsMap, {} as never);
  const s = summary as { prcViolations?: Array<Record<string, unknown>>; drcViolations?: Array<Record<string, unknown>> };
  for (const v of s.prcViolations ?? []) console.log("PRC", JSON.stringify(v).slice(0, 400));
  for (const v of s.drcViolations ?? []) console.log("DRC", JSON.stringify(v).slice(0, 300));
}, 900000);
