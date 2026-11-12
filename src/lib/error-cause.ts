/**
 * WHY IT FAILED, NOT ONLY THAT IT FAILED.
 *
 * A database call that dies on the network comes back from the Neon driver as
 * "Error connecting to database: TypeError: fetch failed". That sentence is the
 * same for a closed socket, a refused connection, a timeout and a body the
 * server would not take: the reason lives in `cause`, one or two levels down
 * (undici puts the socket error there, with a code such as UND_ERR_SOCKET), or in
 * `sourceError`, where the Neon driver keeps the TypeError it wrapped.
 * Reporting only the top message leaves whoever reads it with nothing to act on.
 *
 * The chain is walked a few levels and joined; the result is short, so it can
 * go in a tool answer, and it never contains the request, only error text.
 */
export function motivoErrore(err: unknown, max = 400): string {
  const parti: string[] = [];
  let e: unknown = err;
  for (let i = 0; i < 4 && e; i++) {
    if (e instanceof Error) {
      const code = (e as { code?: unknown }).code;
      parti.push(`${typeof code === "string" ? `[${code}] ` : ""}${e.message}`);
      // undici chains with `cause`, the Neon driver keeps the fetch error in `sourceError`
      e = (e as { cause?: unknown }).cause ?? (e as { sourceError?: unknown }).sourceError;
    } else {
      parti.push(String(e));
      break;
    }
  }
  const unico = parti.filter((p, i) => p && parti.indexOf(p) === i).join(" <- causa: ");
  return unico.length > max ? `${unico.slice(0, max - 1)}…` : unico;
}

/** the error and its causes, as motivoErrore walks them */
function catena(err: unknown): Array<{ testo: string; code: unknown }> {
  const out: Array<{ testo: string; code: unknown }> = [];
  let e: unknown = err;
  for (let i = 0; i < 4 && e; i++) {
    if (e instanceof Error) {
      out.push({ testo: e.message, code: (e as { code?: unknown }).code });
      e = (e as { cause?: unknown }).cause ?? (e as { sourceError?: unknown }).sourceError;
    } else {
      out.push({ testo: String(e), code: undefined });
      break;
    }
  }
  return out;
}

/**
 * WHAT KIND OF FAILURE, AND NOTHING ELSE. A sentence of ours for an error of
 * the database or the network, with its code when it is one (ENOTFOUND,
 * ETIMEDOUT, a SQLSTATE such as 28P01): never the driver's text, which can
 * carry the host, the address, the user and pieces of a password. For what
 * travels to whoever called (a tool answer, an HTTP error); the full reason,
 * cleaned (see motivoSenzaSegreti in agent-tools.ts), goes to the log only.
 */
export function classeErrore(err: unknown): string {
  const parti = catena(err);
  const testo = parti.map((p) => `${typeof p.code === "string" ? p.code : ""} ${p.testo}`).join(" | ");
  // a code is only letters, digits and underscores: nothing of the request fits in it
  const codice = parti.map((p) => p.code).find((c): c is string => typeof c === "string" && (/^[A-Z][A-Z0-9_]{1,39}$/.test(c) || /^[0-9A-Z]{5}$/.test(c)));
  const classe = /password authentication|authentication failed|\b28P01\b|\b28000\b|unauthori[sz]ed|permission denied|invalid (password|credentials|api key)|\b40[13]\b/i.test(testo)
    ? "autenticazione rifiutata"
    : /time(d)? ?out|ETIMEDOUT|UND_ERR_\w*TIMEOUT|\b57014\b/i.test(testo)
      ? "tempo scaduto"
      : /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPIPE|UND_ERR_SOCKET|socket|fetch failed|connection (refused|reset|terminated|closed)/i.test(testo)
        ? "connessione rifiutata o interrotta"
        : "altro errore";
  return codice ? `${classe} [${codice}]` : classe;
}
