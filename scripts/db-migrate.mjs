// Applica db/schema.sql al database di DATABASE_URL.
//
//   DATABASE_URL=postgres://... pnpm db:migrate
//
// Lo schema e' idempotente (IF NOT EXISTS ovunque), quindi si rilancia senza
// rischi su un database gia' allineato: e' il primo comando da dare su un
// database nuovo, e l'unico da ripetere dopo ogni cambio di schema.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Pool } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL non impostata: niente da migrare.");
  process.exit(1);
}

const schema = readFileSync(fileURLToPath(new URL("../db/schema.sql", import.meta.url)), "utf8");
const pool = new Pool({ connectionString: url });

try {
  // query semplice senza parametri: Postgres accetta piu' istruzioni in un
  // colpo solo, e le esegue in un'unica transazione implicita
  await pool.query(schema);
  const { rows } = await pool.query(
    "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'",
  );
  console.log(`schema applicato: ${rows[0].n} tabelle nello schema public`);
} catch (err) {
  console.error(`migrazione fallita: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
