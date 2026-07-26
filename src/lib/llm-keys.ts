import { neon } from "@neondatabase/serverless";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Chiavi API dei modelli, per utente o per organizzazione (BYOK): chi le
 * imposta paga il proprio copilota. Precedenza: chiave dell'utente, poi quella
 * dell'organizzazione, poi quella del server (env).
 *
 * Le chiavi sono cifrate a riposo (AES-256-GCM): la master key deriva da
 * KEY_ENCRYPTION_SECRET, con ripiego su AUTH_SECRET che esiste sempre. Nel DB
 * restano anche le ultime 4 cifre in chiaro, per mostrarla mascherata.
 */

export type LlmProvider = "glm" | "gemini";
export const LLM_PROVIDERS: LlmProvider[] = ["glm", "gemini"];

export interface MaskedKey {
  provider: LlmProvider;
  hint: string;
  scope: "user" | "org";
  orgId: string | null;
  updatedAt: string;
}

export interface AgentKeyEntry {
  key: string;
  scope: "user" | "org";
}

export type AgentKeyMap = Partial<Record<LlmProvider, AgentKeyEntry>>;

function db() {
  const url = process.env.DATABASE_URL;
  return url ? neon(url) : null;
}

function masterKey(): Buffer {
  const secret = process.env.KEY_ENCRYPTION_SECRET ?? process.env.AUTH_SECRET;
  if (!secret) throw new Error("KEY_ENCRYPTION_SECRET/AUTH_SECRET mancanti");
  return createHash("sha256").update(`pcb-studio-llm-keys:${secret}`).digest();
}

function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, data]).toString("base64");
}

function decrypt(ciphertext: string): string {
  const raw = Buffer.from(ciphertext, "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const data = raw.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", masterKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

let ddlPromise: Promise<void> | null = null;
async function ensureTable(sql: NonNullable<ReturnType<typeof db>>): Promise<void> {
  // reset on failure: un errore transitorio non spegne la tabella per tutta la
  // vita del lambda
  ddlPromise ??= sql`
    CREATE TABLE IF NOT EXISTS llm_api_keys (
      owner_type text NOT NULL,
      owner_id text NOT NULL,
      provider text NOT NULL,
      key_ciphertext text NOT NULL,
      key_hint text NOT NULL,
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (owner_type, owner_id, provider)
    )
  `
    .then(() => undefined)
    .catch((err) => {
      ddlPromise = null;
      throw err;
    });
  await ddlPromise;
}

export async function saveLlmKey(
  ownerType: "user" | "org",
  ownerId: string,
  provider: LlmProvider,
  key: string,
  createdBy: string,
): Promise<void> {
  const sql = db();
  if (!sql) throw new Error("database non configurato");
  await ensureTable(sql);
  await sql`
    INSERT INTO llm_api_keys (owner_type, owner_id, provider, key_ciphertext, key_hint, created_by)
    VALUES (${ownerType}, ${ownerId}, ${provider}, ${encrypt(key)}, ${key.slice(-4)}, ${createdBy})
    ON CONFLICT (owner_type, owner_id, provider)
    DO UPDATE SET key_ciphertext = EXCLUDED.key_ciphertext,
                  key_hint = EXCLUDED.key_hint,
                  created_by = EXCLUDED.created_by,
                  updated_at = now()
  `;
}

export async function deleteLlmKey(
  ownerType: "user" | "org",
  ownerId: string,
  provider: LlmProvider,
): Promise<void> {
  const sql = db();
  if (!sql) return;
  await ensureTable(sql);
  await sql`
    DELETE FROM llm_api_keys
    WHERE owner_type = ${ownerType} AND owner_id = ${ownerId} AND provider = ${provider}
  `;
}

type Row = Record<string, unknown>;

function toMasked(r: Row, scope: "user" | "org"): MaskedKey {
  return {
    provider: String(r.provider) as LlmProvider,
    hint: String(r.key_hint),
    scope,
    orgId: scope === "org" ? String(r.owner_id) : null,
    updatedAt: String(r.updated_at),
  };
}

/** chiavi mascherate dell'utente e delle sue organizzazioni, per la pagina impostazioni */
export async function listMaskedKeys(
  userId: string,
  orgIds: string[],
): Promise<{ user: MaskedKey[]; org: MaskedKey[] }> {
  const sql = db();
  if (!sql) return { user: [], org: [] };
  await ensureTable(sql);
  const userRows = (await sql`
    SELECT provider, key_hint, updated_at FROM llm_api_keys
    WHERE owner_type = 'user' AND owner_id = ${userId}
    ORDER BY provider
  `) as Row[];
  const orgRows =
    orgIds.length === 0
      ? []
      : ((await sql`
          SELECT provider, key_hint, owner_id, updated_at FROM llm_api_keys
          WHERE owner_type = 'org' AND owner_id = ANY(${orgIds})
          ORDER BY provider
        `) as Row[]);
  return {
    user: userRows.map((r) => toMasked(r, "user")),
    org: orgRows.map((r) => toMasked(r, "org")),
  };
}

/** le chiavi da usare per un turno dell'agente: utente prima, poi org */
export async function getAgentKeys(userId: string, orgIds: string[]): Promise<AgentKeyMap> {
  const sql = db();
  if (!sql) return {};
  try {
    await ensureTable(sql);
    const rows = (await sql`
      SELECT owner_type, owner_id, provider, key_ciphertext FROM llm_api_keys
      WHERE (owner_type = 'user' AND owner_id = ${userId})
         OR (owner_type = 'org' AND owner_id = ANY(${orgIds}))
    `) as Row[];
    const keys: AgentKeyMap = {};
    // prima le org (base), poi l'utente sovrascrive: utente > org
    for (const r of rows.filter((x) => x.owner_type === "org")) {
      keys[String(r.provider) as LlmProvider] = {
        key: decrypt(String(r.key_ciphertext)),
        scope: "org",
      };
    }
    for (const r of rows.filter((x) => x.owner_type === "user")) {
      keys[String(r.provider) as LlmProvider] = {
        key: decrypt(String(r.key_ciphertext)),
        scope: "user",
      };
    }
    return keys;
  } catch {
    // una chiave illeggibile non deve fermare l'agente: si ripiega sulle env
    return {};
  }
}
