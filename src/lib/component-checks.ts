import { neon } from "@neondatabase/serverless";
import type { ControlloRegistrato, Voce } from "./component-status";

/**
 * THE RECORD OF WHAT HAS BEEN CHECKED, part by part.
 *
 * The board in component-status.ts turns green on evidence, and this is where
 * the evidence lives: who said the footprint matches the datasheet, against
 * which drawing, on which day. Without it "checked" is a feeling, and the first
 * person to inherit the project cannot tell a part somebody studied from a part
 * nobody has opened.
 *
 * It is kept apart from the project files on purpose. These rows are a LOG: they
 * accumulate, they carry names and dates, and they must survive the agent
 * rewriting main.tsx — which is exactly what the agent does, every turn.
 *
 * `impronta` is the fingerprint of the geometry the check was made against. A
 * check outlives the thing it checked: move a pad and the footprint check is
 * spent, and the board says so instead of staying green over a shape nobody
 * has looked at.
 */

export interface ControlloDaSalvare {
  projectId: string;
  componente: string;
  voce: Voce;
  stato: "fatto" | "non-applicabile";
  /** what was found, in one line: it is what a person reads a year later */
  nota: string;
  /** the document, the page, the measurement it rests on */
  fonte?: string;
  impronta?: string;
  chi: string;
}

function db() {
  const url = process.env.DATABASE_URL;
  return url ? neon(url) : null;
}

let tabella: Promise<void> | null = null;
async function ensureTable(sql: NonNullable<ReturnType<typeof db>>): Promise<void> {
  tabella ??= sql`
    CREATE TABLE IF NOT EXISTS component_checks (
      id bigserial PRIMARY KEY,
      project_id text NOT NULL,
      component text NOT NULL,
      voice text NOT NULL,
      state text NOT NULL,
      note text NOT NULL DEFAULT '',
      source text,
      fingerprint text,
      author text NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (project_id, component, voice)
    )
  `
    .then(() => undefined)
    .catch((err) => {
      tabella = null;
      throw err;
    });
  await tabella;
}

export async function salvaControllo(input: ControlloDaSalvare): Promise<void> {
  const sql = db();
  if (!sql) throw new Error("database non configurato");
  await ensureTable(sql);
  await sql`
    INSERT INTO component_checks
      (project_id, component, voice, state, note, source, fingerprint, author)
    VALUES (
      ${input.projectId}, ${input.componente}, ${input.voce}, ${input.stato},
      ${input.nota}, ${input.fonte ?? null}, ${input.impronta ?? null}, ${input.chi}
    )
    ON CONFLICT (project_id, component, voice) DO UPDATE SET
      state = EXCLUDED.state,
      note = EXCLUDED.note,
      source = EXCLUDED.source,
      fingerprint = EXCLUDED.fingerprint,
      author = EXCLUDED.author,
      created_at = now()
  `;
}

/** a check taken back: the voice goes back to being computed from the facts */
export async function togliControllo(
  projectId: string,
  componente: string,
  voce: Voce,
): Promise<void> {
  const sql = db();
  if (!sql) return;
  await ensureTable(sql);
  await sql`
    DELETE FROM component_checks
    WHERE project_id = ${projectId} AND component = ${componente} AND voice = ${voce}
  `;
}

export async function controlliDelProgetto(projectId: string): Promise<ControlloRegistrato[]> {
  const sql = db();
  if (!sql) return [];
  await ensureTable(sql);
  const righe = (await sql`
    SELECT component, voice, state, note, source, fingerprint, author, created_at
    FROM component_checks WHERE project_id = ${projectId}
  `) as Array<Record<string, unknown>>;
  return righe.map((r) => ({
    componente: String(r.component),
    voce: String(r.voice) as Voce,
    stato: String(r.state) === "non-applicabile" ? "non-applicabile" : "fatto",
    nota: String(r.note ?? ""),
    fonte: r.source ? String(r.source) : undefined,
    impronta: r.fingerprint ? String(r.fingerprint) : undefined,
    chi: String(r.author ?? ""),
    quando: new Date(String(r.created_at)).toISOString().slice(0, 10),
  }));
}
