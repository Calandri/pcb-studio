import { neon } from "@neondatabase/serverless";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * Model API keys, per user or per organization (BYOK): whoever sets them pays
 * for their own copilot. Precedence: the user's key, then the organization's,
 * then the server's (env).
 *
 * There is one provider: OpenRouter. The 3Bee model policy routes every model
 * through an OpenRouter preset (catalog/models.yml), so a BYOK key is an
 * OpenRouter key and nothing else.
 *
 * Encryption at rest, format `v1:<base64(salt | iv | tag | ciphertext)>`:
 * - the master secret is KEY_ENCRYPTION_SECRET; in production it is REQUIRED
 *   (no fallback on AUTH_SECRET, which rotates for unrelated reasons and would
 *   silently make every stored key unreadable). Development may fall back on
 *   AUTH_SECRET;
 * - every record gets its own key, HKDF-SHA256 over the secret with a random
 *   salt stored next to the ciphertext;
 * - AES-256-GCM with the owner and the provider bound as additional data: a
 *   ciphertext copied onto another user's row does not decrypt.
 * The DB also keeps the last 4 characters in cleartext, to display the key
 * masked.
 */

export type LlmProvider = "openrouter";
export const LLM_PROVIDERS: LlmProvider[] = ["openrouter"];

export interface MaskedKey {
  provider: LlmProvider;
  hint: string;
  scope: "user" | "org";
  orgId: string | null;
  updatedAt: string;
}

/**
 * A key ready to use, or the reason the stored one cannot be used. A broken
 * stored key is NOT the same as no key: the turn must fail with that reason
 * instead of moving silently onto the server's key.
 */
export type AgentKeyEntry =
  | { key: string; scope: "user" | "org"; error?: undefined }
  | { key?: undefined; scope: "user" | "org"; error: string };

export type AgentKeyMap = Partial<Record<LlmProvider, AgentKeyEntry>>;

export interface KeyBinding {
  ownerType: "user" | "org";
  ownerId: string;
  provider: LlmProvider;
}

type Env = Record<string, string | undefined>;

const FORMAT = "v1";
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HKDF_INFO = "pcb-studio/llm-keys/v1";
const MIN_PRODUCTION_SECRET_CHARS = 32;

function db() {
  const url = process.env.DATABASE_URL;
  return url ? neon(url) : null;
}

/** the master secret, enforcing the production rule */
export function encryptionSecret(env: Env = process.env): Buffer {
  const dedicated = env.KEY_ENCRYPTION_SECRET?.trim();
  const production = env.NODE_ENV === "production";
  if (dedicated) {
    if (production && dedicated.length < MIN_PRODUCTION_SECRET_CHARS) {
      throw new Error(
        `KEY_ENCRYPTION_SECRET troppo corto: in produzione servono almeno ${MIN_PRODUCTION_SECRET_CHARS} caratteri`,
      );
    }
    return Buffer.from(dedicated, "utf8");
  }
  if (production) {
    throw new Error(
      "KEY_ENCRYPTION_SECRET mancante: in produzione le chiavi BYOK si cifrano solo con un segreto dedicato",
    );
  }
  const fallback = env.AUTH_SECRET?.trim();
  if (!fallback) throw new Error("KEY_ENCRYPTION_SECRET (o AUTH_SECRET in sviluppo) mancante");
  return Buffer.from(fallback, "utf8");
}

function deriveKey(secret: Buffer, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, salt, HKDF_INFO, 32));
}

function additionalData(binding: KeyBinding): Buffer {
  return Buffer.from(
    `pcb-studio:llm-key:${binding.ownerType}:${binding.ownerId}:${binding.provider}`,
    "utf8",
  );
}

export function sealApiKey(plain: string, binding: KeyBinding, env: Env = process.env): string {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(encryptionSecret(env), salt), iv);
  cipher.setAAD(additionalData(binding));
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${FORMAT}:${Buffer.concat([salt, iv, tag, data]).toString("base64")}`;
}

export function openApiKey(sealed: string, binding: KeyBinding, env: Env = process.env): string {
  const prefix = `${FORMAT}:`;
  if (!sealed.startsWith(prefix)) throw new Error("formato di cifratura sconosciuto");
  const raw = Buffer.from(sealed.slice(prefix.length), "base64");
  if (raw.length <= SALT_BYTES + IV_BYTES + TAG_BYTES) throw new Error("cifrato troncato");
  const salt = raw.subarray(0, SALT_BYTES);
  const iv = raw.subarray(SALT_BYTES, SALT_BYTES + IV_BYTES);
  const tag = raw.subarray(SALT_BYTES + IV_BYTES, SALT_BYTES + IV_BYTES + TAG_BYTES);
  const data = raw.subarray(SALT_BYTES + IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", deriveKey(encryptionSecret(env), salt), iv);
  decipher.setAAD(additionalData(binding));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

let ddlPromise: Promise<void> | null = null;
async function ensureTable(sql: NonNullable<ReturnType<typeof db>>): Promise<void> {
  // reset on failure: a transient error must not disable the table for the
  // whole lifetime of the lambda
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
  const sealed = sealApiKey(key, { ownerType, ownerId, provider });
  await sql`
    INSERT INTO llm_api_keys (owner_type, owner_id, provider, key_ciphertext, key_hint, created_by)
    VALUES (${ownerType}, ${ownerId}, ${provider}, ${sealed}, ${key.slice(-4)}, ${createdBy})
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

/** masked keys of the user and of their organizations, for the settings page */
export async function listMaskedKeys(
  userId: string,
  orgIds: string[],
): Promise<{ user: MaskedKey[]; org: MaskedKey[] }> {
  const sql = db();
  if (!sql) return { user: [], org: [] };
  await ensureTable(sql);
  const userRows = (await sql`
    SELECT provider, key_hint, updated_at FROM llm_api_keys
    WHERE owner_type = 'user' AND owner_id = ${userId} AND provider = ANY(${LLM_PROVIDERS})
    ORDER BY provider
  `) as Row[];
  const orgRows =
    orgIds.length === 0
      ? []
      : ((await sql`
          SELECT provider, key_hint, owner_id, updated_at FROM llm_api_keys
          WHERE owner_type = 'org' AND owner_id = ANY(${orgIds}) AND provider = ANY(${LLM_PROVIDERS})
          ORDER BY provider
        `) as Row[]);
  return {
    user: userRows.map((r) => toMasked(r, "user")),
    org: orgRows.map((r) => toMasked(r, "org")),
  };
}

/**
 * The key to use for a model call: the user's, else the first of their
 * organizations (in the order given) that has one.
 *
 * Throws when the lookup itself fails: not knowing whether the user has a key
 * is not the same as knowing they have none. A stored key that does not
 * decrypt comes back as an entry with `error`, never as "no key".
 */
export async function getAgentKeys(userId: string, orgIds: string[]): Promise<AgentKeyMap> {
  const sql = db();
  if (!sql) return {};
  await ensureTable(sql);
  const rows = (await sql`
    SELECT owner_type, owner_id, key_ciphertext FROM llm_api_keys
    WHERE provider = 'openrouter'
      AND ((owner_type = 'user' AND owner_id = ${userId})
        OR (owner_type = 'org' AND owner_id = ANY(${orgIds})))
  `) as Row[];
  return resolveAgentKeys(rows, userId, orgIds);
}

/** precedence and decryption, separated from the query to be testable */
export function resolveAgentKeys(
  rows: Row[],
  userId: string,
  orgIds: string[],
  env: Env = process.env,
): AgentKeyMap {
  const userRow = rows.find(
    (r) => r.owner_type === "user" && String(r.owner_id) === userId,
  );
  const orgRow = orgIds
    .map((id) => rows.find((r) => r.owner_type === "org" && String(r.owner_id) === id))
    .find(Boolean);
  const row = userRow ?? orgRow;
  if (!row) return {};

  const scope = row.owner_type === "user" ? "user" : "org";
  try {
    const key = openApiKey(
      String(row.key_ciphertext),
      { ownerType: scope, ownerId: String(row.owner_id), provider: "openrouter" },
      env,
    );
    return { openrouter: { key, scope } };
  } catch {
    const whose = scope === "user" ? "nel tuo profilo" : "nell'organizzazione";
    return {
      openrouter: {
        scope,
        error:
          `La chiave OpenRouter salvata ${whose} non si riesce a decifrare ` +
          "(il segreto di cifratura del server potrebbe essere cambiato): reinseriscila o cancellala " +
          "dalle impostazioni delle chiavi. Il turno non passa sulla chiave del server.",
      },
    };
  }
}
