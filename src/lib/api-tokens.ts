import { createHash, randomBytes } from "node:crypto";
import { neon } from "@neondatabase/serverless";

/**
 * Personal tokens for MCP access.
 * Only the hash lives in the database: the plaintext token is shown once, at
 * creation. A DB dump does not let anyone be impersonated.
 */

export interface ApiTokenInfo {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

const PREFIX = "pcbs_";

function db() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not configured");
  return neon(url);
}

const hash = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

export async function createApiToken(
  userId: string,
  name: string,
): Promise<{ token: string; info: ApiTokenInfo }> {
  const sql = db();
  const secret = randomBytes(24).toString("base64url");
  const token = `${PREFIX}${secret}`;
  const prefix = token.slice(0, PREFIX.length + 6);

  const rows = (await sql`
    INSERT INTO api_tokens (user_id, name, token_hash, prefix)
    VALUES (${userId}, ${name.slice(0, 60) || "token"}, ${hash(token)}, ${prefix})
    RETURNING id, name, prefix, created_at
  `) as Array<Record<string, unknown>>;

  const r = rows[0];
  return {
    token,
    info: {
      id: String(r.id),
      name: String(r.name),
      prefix: String(r.prefix),
      createdAt: String(r.created_at),
      lastUsedAt: null,
    },
  };
}

export async function listApiTokens(userId: string): Promise<ApiTokenInfo[]> {
  const sql = db();
  const rows = (await sql`
    SELECT id, name, prefix, created_at, last_used_at
    FROM api_tokens WHERE user_id = ${userId} ORDER BY created_at DESC
  `) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    prefix: String(r.prefix),
    createdAt: String(r.created_at),
    lastUsedAt: r.last_used_at ? String(r.last_used_at) : null,
  }));
}

export async function revokeApiToken(userId: string, id: string): Promise<void> {
  const sql = db();
  await sql`DELETE FROM api_tokens WHERE id = ${id} AND user_id = ${userId}`;
}

/** Resolves a token to a user; updates the last-used timestamp. */
export async function resolveApiToken(
  token: string,
): Promise<{ userId: string; email: string } | null> {
  if (!token?.startsWith(PREFIX)) return null;
  const sql = db();
  const rows = (await sql`
    SELECT t.id, t.user_id, u.email
    FROM api_tokens t JOIN users u ON u.id = t.user_id
    WHERE t.token_hash = ${hash(token)} LIMIT 1
  `) as Array<{ id: string; user_id: string; email: string }>;
  if (rows.length === 0) return null;

  void sql`UPDATE api_tokens SET last_used_at = now() WHERE id = ${rows[0].id}`.catch(
    () => {},
  );
  return { userId: rows[0].user_id, email: rows[0].email ?? "" };
}
