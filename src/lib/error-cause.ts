/**
 * WHY IT FAILED, NOT ONLY THAT IT FAILED.
 *
 * A database call that dies on the network comes back from the Neon driver as
 * "Error connecting to database: TypeError: fetch failed". That sentence is the
 * same for a closed socket, a refused connection, a timeout and a body the
 * server would not take: the reason lives in `cause`, one or two levels down
 * (undici puts the socket error there, with a code such as UND_ERR_SOCKET).
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
      e = (e as { cause?: unknown }).cause;
    } else {
      parti.push(String(e));
      break;
    }
  }
  const unico = parti.filter((p, i) => p && parti.indexOf(p) === i).join(" <- causa: ");
  return unico.length > max ? `${unico.slice(0, max - 1)}…` : unico;
}
