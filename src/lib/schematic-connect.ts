/**
 * Collegamenti fatti a mano sullo schematico.
 *
 * PERCHE' QUI E NON IN manual-edits.json. Spostare un simbolo e' geometria e
 * vive nel file delle modifiche manuali; collegare due piedini e' PROGETTO
 * ELETTRICO e deve stare in main.tsx come <trace>. Se un collegamento vivesse
 * fuori dalle sorgenti, l'agente non saprebbe che esiste: al primo "aggiungi il
 * decoupling" ragionerebbe su un circuito diverso da quello che l'utente vede,
 * e la distinta e lo sbroglio nascerebbero da due verita' diverse.
 *
 * La scrittura e' chirurgica: si inserisce (o si toglie) UNA riga <trace>
 * lasciando intatto tutto il resto del file. Nessuna riscrittura, cosi' due
 * collegamenti a mano di fila non possono perdere il lavoro dell'agente in
 * mezzo.
 */

/** ".U1 > .VCC" oppure "net.GND": le due forme che accetta un trace */
const SELECTOR = /^(\.[A-Za-z_][\w$]*\s*>\s*\.[\w$.+-]+|net\.[A-Za-z_][\w$]*)$/;

export function isValidSelector(value: string): boolean {
  return SELECTOR.test(value.trim());
}

/** normalizza gli spazi cosi' due scritture dello stesso collegamento coincidono */
export function normalizeSelector(value: string): string {
  return value.trim().replace(/\s*>\s*/, " > ");
}

export interface ConnectResult {
  ok: boolean;
  main: string;
  /** motivo del rifiuto, gia' scritto per l'utente */
  error?: string;
  /** riga aggiunta o tolta */
  trace?: string;
}

const traceRegex = (from: string, to: string): RegExp => {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // un collegamento non ha verso: A->B e B->A sono la stessa riga
  return new RegExp(
    `\\s*<trace\\b[^>]*?(?:from="${esc(from)}"[^>]*?to="${esc(to)}"|from="${esc(to)}"[^>]*?to="${esc(from)}")[^>]*/>`,
    "g",
  );
};

/** esiste gia' un collegamento fra questi due punti? */
export function hasConnection(main: string, from: string, to: string): boolean {
  return traceRegex(from, to).test(main);
}

/**
 * Aggiunge un <trace> subito prima della chiusura del board, che e' dove
 * stanno gia' tutti gli altri: il file resta leggibile e l'ordine e' quello in
 * cui i collegamenti sono stati creati.
 */
export function addConnection(main: string, fromRaw: string, toRaw: string): ConnectResult {
  const from = normalizeSelector(fromRaw);
  const to = normalizeSelector(toRaw);

  if (!isValidSelector(from) || !isValidSelector(to)) {
    return { ok: false, main, error: "selettore non valido" };
  }
  if (from === to) {
    return { ok: false, main, error: "un piedino non si collega a se stesso" };
  }
  if (hasConnection(main, from, to)) {
    return { ok: false, main, error: "questi due punti sono gia' collegati" };
  }

  const close = main.lastIndexOf("</board>");
  if (close === -1) {
    return { ok: false, main, error: "non trovo la chiusura del board in main.tsx" };
  }

  // si riusa il rientro della riga di chiusura, cosi' la riga nuova si allinea
  const lineStart = main.lastIndexOf("\n", close) + 1;
  const indent = `${main.slice(lineStart, close)}  `;
  const trace = `<trace from="${from}" to="${to}" />`;
  return {
    ok: true,
    main: `${main.slice(0, lineStart)}${indent}${trace}\n${main.slice(lineStart)}`,
    trace,
  };
}

/** toglie il collegamento fra due punti, se c'e' */
export function removeConnection(main: string, fromRaw: string, toRaw: string): ConnectResult {
  const from = normalizeSelector(fromRaw);
  const to = normalizeSelector(toRaw);
  if (!isValidSelector(from) || !isValidSelector(to)) {
    return { ok: false, main, error: "selettore non valido" };
  }
  const re = traceRegex(from, to);
  if (!re.test(main)) {
    return { ok: false, main, error: "questo collegamento non e' scritto in main.tsx" };
  }
  return { ok: true, main: main.replace(traceRegex(from, to), ""), trace: `${from} -> ${to}` };
}

/**
 * Spezza in due il nome che il compilatore da' a un collegamento
 * (".J1 > .VBAT to .D1 > .cathode"): e' cio' che arriva quando l'utente clicca
 * un filo gia' disegnato e chiede di toglierlo.
 */
export function parseDeclaredTrace(declared: string): { from: string; to: string } | null {
  const parts = declared.split(" to ");
  if (parts.length !== 2) return null;
  const from = normalizeSelector(parts[0]);
  const to = normalizeSelector(parts[1]);
  if (!isValidSelector(from) || !isValidSelector(to)) return null;
  return { from, to };
}
