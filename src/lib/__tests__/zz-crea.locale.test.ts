// BANCO LOCALE (non committare): crea il progetto PROGETTO con lo stesso proprietario e la stessa org di DA.
import { it } from "vitest";
import "./zz-neon-dns";
import { neon } from "@neondatabase/serverless";
import { createProject } from "@/lib/project-store";
it("crea", async () => {
  const sql = neon(process.env.DATABASE_URL!);
  const righe = (await sql`SELECT created_by, org_id FROM projects WHERE id = ${process.env.DA!}`) as Array<{ created_by: string; org_id: string | null }>;
  if (!righe.length) throw new Error("progetto di partenza non trovato");
  const ok = await createProject(process.env.PROGETTO!, { userId: righe[0].created_by, orgId: righe[0].org_id, name: process.env.NOME ?? null });
  console.log("CREATO", ok, "org", righe[0].org_id ? "si" : "no");
}, 60000);
