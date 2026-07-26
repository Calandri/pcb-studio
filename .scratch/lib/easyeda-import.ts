import { convertRawEasyEdaToTs, fetchEasyEDAComponent } from "easyeda";

// L'API EasyEDA rifiuta (403) le richieste senza browser headers; il pacchetto
// non li manda, quindi si inietta un fetch personalizzato.
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Referer: "https://easyeda.com/",
  Accept: "application/json, text/plain, */*",
};

const patchedFetch: typeof globalThis.fetch = (url, init = {}) =>
  globalThis.fetch(url, {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), ...BROWSER_HEADERS },
    signal: AbortSignal.timeout(20_000),
  });

export interface ImportedComponent {
  /** nome del componente esportato dal modulo TSX */
  name: string;
  code: string;
  lcsc: string;
}

/**
 * Scarica footprint e simbolo REALI di un part JLCPCB/LCSC e li converte in un
 * componente tscircuit. Deterministico: nessuna dimensione inventata dall'LLM.
 */
export async function importComponentFromLcsc(
  lcscRaw: string,
): Promise<ImportedComponent> {
  const lcsc = lcscRaw.trim().toUpperCase();
  if (!/^C\d{2,10}$/.test(lcsc)) {
    throw new Error(`Invalid LCSC part number "${lcscRaw}" (expected e.g. C7593)`);
  }

  const raw = await fetchEasyEDAComponent(lcsc, { fetch: patchedFetch });
  const code = await convertRawEasyEdaToTs({ rawEasy: raw });

  const exported = /export const ([A-Za-z][A-Za-z0-9_]*)/.exec(code);
  if (!exported) throw new Error(`Could not determine component name for ${lcsc}`);

  return { name: exported[1], code, lcsc };
}
