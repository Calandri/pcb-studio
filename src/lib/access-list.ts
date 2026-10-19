/**
 * Chi puo' entrare.
 *
 * PCB Studio compila sul server il codice tscircuit dei progetti, e quel
 * codice gira nello stesso processo che tiene le chiavi del database e dei
 * modelli: finche' la compilazione non ha una sandbox sua, un account e'
 * fiducia piena. Per questo l'iscrizione non e' aperta a chiunque abbia
 * un'email: entrano solo gli indirizzi e i domini elencati.
 *
 *   AUTH_ALLOWED_EMAILS   indirizzi esatti, separati da virgola
 *   AUTH_ALLOWED_DOMAINS  domini interi (es. 3bee.com), separati da virgola
 *
 * In produzione, senza nessuna delle due, non entra nessuno: un'istanza
 * dimenticata aperta e' il caso da evitare, non quello da rendere comodo.
 * In sviluppo, senza liste, entra chiunque (il magic link va in console).
 */

function list(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export interface AccessListEnv {
  AUTH_ALLOWED_EMAILS?: string;
  AUTH_ALLOWED_DOMAINS?: string;
  NODE_ENV?: string;
}

export function isEmailAllowed(
  email: string | null | undefined,
  env: AccessListEnv = process.env,
): boolean {
  const emails = list(env.AUTH_ALLOWED_EMAILS);
  const domains = list(env.AUTH_ALLOWED_DOMAINS).map((d) => d.replace(/^@/, ""));
  if (emails.length === 0 && domains.length === 0) return env.NODE_ENV !== "production";

  const address = (email ?? "").trim().toLowerCase();
  const at = address.lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) return false;
  return emails.includes(address) || domains.includes(address.slice(at + 1));
}
