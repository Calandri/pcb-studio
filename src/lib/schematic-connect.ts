/**
 * Hand-made connections on the schematic.
 *
 * WHY HERE AND NOT IN manual-edits.json. Moving a symbol is geometry and
 * lives in the manual-edits file; connecting two pins is ELECTRICAL DESIGN
 * and must live in main.tsx as a <trace>. If a connection lived outside the
 * sources, the agent would not know it exists: at the first "add the
 * decoupling" it would reason about a circuit different from the one the user
 * sees, and the BOM and the routing would be born from two different truths.
 *
 * The writing is surgical: a single <trace> line is inserted (or removed)
 * leaving the rest of the file untouched. No rewriting, so two hand
 * connections in a row cannot lose the agent's work in between.
 */

/** ".U1 > .VCC" or "net.GND": the two forms a trace accepts */
const SELECTOR = /^(\.[A-Za-z_][\w$]*\s*>\s*\.[\w$.+-]+|net\.[A-Za-z_][\w$]*)$/;

export function isValidSelector(value: string): boolean {
  return SELECTOR.test(value.trim());
}

/** normalizes whitespace so two spellings of the same connection coincide */
export function normalizeSelector(value: string): string {
  return value.trim().replace(/\s*>\s*/, " > ");
}

export interface ConnectResult {
  ok: boolean;
  main: string;
  /** reason for the rejection, already written for the user */
  error?: string;
  /** line added or removed */
  trace?: string;
}

const traceRegex = (from: string, to: string): RegExp => {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // a connection has no direction: A->B and B->A are the same line
  return new RegExp(
    `\\s*<trace\\b[^>]*?(?:from="${esc(from)}"[^>]*?to="${esc(to)}"|from="${esc(to)}"[^>]*?to="${esc(from)}")[^>]*/>`,
    "g",
  );
};

/** does a connection between these two points already exist? */
export function hasConnection(main: string, from: string, to: string): boolean {
  return traceRegex(from, to).test(main);
}

/**
 * Adds a <trace> right before the board closing tag, which is where all the
 * others already are: the file stays readable and the order is the one in
 * which the connections were created.
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

  // the closing line's indent is reused, so the new line aligns
  const lineStart = main.lastIndexOf("\n", close) + 1;
  const indent = `${main.slice(lineStart, close)}  `;
  const trace = `<trace from="${from}" to="${to}" />`;
  return {
    ok: true,
    main: `${main.slice(0, lineStart)}${indent}${trace}\n${main.slice(lineStart)}`,
    trace,
  };
}

/** removes the connection between two points, if there is one */
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
 * Splits in two the name the compiler gives a connection
 * (".J1 > .VBAT to .D1 > .cathode"): this is what arrives when the user
 * clicks an already drawn wire and asks to remove it.
 */
export function parseDeclaredTrace(declared: string): { from: string; to: string } | null {
  const parts = declared.split(" to ");
  if (parts.length !== 2) return null;
  const from = normalizeSelector(parts[0]);
  const to = normalizeSelector(parts[1]);
  if (!isValidSelector(from) || !isValidSelector(to)) return null;
  return { from, to };
}
