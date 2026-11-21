import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";
import { compileProject } from "./compile.js";
const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url).pathname, "utf8")
    .split("\n")
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, "")];
    }),
);
const sql = neon(env.DATABASE_URL);
const rows = await sql`SELECT path, content FROM project_files WHERE project_id = 'bat-bs'`;
console.log("files:", rows.map((r) => `${r.path} (${r.content.length}b)`).join(", "));
const fsMap = Object.fromEntries(rows.map((r) => [r.path, r.content]));
const { summary } = await compileProject(fsMap, { variants: 3 });
console.log("message:", summary.message);
console.log("targets:", JSON.stringify(summary.targets));
console.log("--- DRC ---");
for (const v of summary.drcViolations.slice(0, 12)) console.log(" ", v.rule, "->", v.message.slice(0, 130));
console.log("--- PRC ---");
for (const v of summary.prcViolations.slice(0, 12)) console.log(" ", v.severity, v.rule, "->", v.message.slice(0, 130));
if (summary.variantReport) for (const s of summary.variantReport) console.log("section", s.section, "picked", s.picked, JSON.stringify(s.candidates.map((c) => `${c.label}:${c.vias}v/${c.lengthMm}mm/drc${c.drc}`)));
