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
 *
 * The <trace> tags are FOUND with the JSX scanner of manual-edits.ts, not
 * with a regex: the agent writes `to=` before `from=`, single quotes,
 * `from={".U1 > .VCC"}`, extra props, several lines — and a regex built for
 * `<trace from="..." to="..." />` could not find any of those to remove them,
 * nor see that they already existed before adding a duplicate.
 */

import { readAttr, scanJsxTags, type JsxTag } from "./manual-edits";

/*
 * ".U1 > .VCC" or "net.GND": the two forms a trace accepts. Pin names are
 * whatever the datasheet calls them — "~RST", "/CS", "D+", "IO0.1" — so the
 * pin part takes any character that cannot end a selector or a JSX string.
 * Component names follow tscircuit's: letters, digits, underscore, dash.
 */
const SELECTOR = /^(\.[A-Za-z_][\w$-]*\s*>\s*\.[^\s>"'{}<`]+|net\.[\w$+-]+)$/;

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

/** the <trace> tags of the file joining these two points, in either direction */
function tracesBetween(main: string, from: string, to: string): JsxTag[] {
  const a = normalizeSelector(from);
  const b = normalizeSelector(to);
  return scanJsxTags(main).filter((tag) => {
    if (tag.name !== "trace" || tag.inAttribute) return false;
    const attrs = main.slice(tag.attrsStart, tag.attrsEnd);
    const f = readAttr(attrs, "from");
    const t = readAttr(attrs, "to");
    if (f === null || t === null) return false;
    const nf = normalizeSelector(f);
    const nt = normalizeSelector(t);
    // a connection has no direction: A->B and B->A are the same line
    return (nf === a && nt === b) || (nf === b && nt === a);
  });
}

/** does a connection between these two points already exist? */
export function hasConnection(main: string, from: string, to: string): boolean {
  return tracesBetween(main, from, to).length > 0;
}

/**
 * Checks a selector against a compiled board, when there is one: the part
 * must have that pin. A part the board does not know yet (added after the
 * last compile) cannot be checked and passes; a net is never refused, as it
 * may be the one this very connection introduces.
 */
export function checkSelectorOnBoard(selector: string, circuitJson: unknown[] | null | undefined): string | null {
  if (!circuitJson?.length) return null;
  const m = /^\.(.+?)\s*>\s*\.(.+)$/.exec(selector.trim());
  if (!m) return null;
  const els = circuitJson as Array<Record<string, unknown>>;
  const comp = els.find((e) => e?.type === "source_component" && e.name === m[1]);
  if (!comp) return null;
  const pin = m[2];
  const has = els.some(
    (e) =>
      e?.type === "source_port" &&
      e.source_component_id === comp.source_component_id &&
      (e.name === pin || (Array.isArray(e.port_hints) && (e.port_hints as unknown[]).includes(pin))),
  );
  return has ? null : `${m[1]} non ha un piedino "${pin}"`;
}

/**
 * Adds a <trace> right before the board closing tag, which is where all the
 * others already are: the file stays readable and the order is the one in
 * which the connections were created.
 */
export function addConnection(
  main: string,
  fromRaw: string,
  toRaw: string,
  circuitJson?: unknown[] | null,
): ConnectResult {
  const from = normalizeSelector(fromRaw);
  const to = normalizeSelector(toRaw);

  if (!isValidSelector(from) || !isValidSelector(to)) {
    return { ok: false, main, error: "selettore non valido" };
  }
  if (from === to) {
    return { ok: false, main, error: "un piedino non si collega a se stesso" };
  }
  const wrong = checkSelectorOnBoard(from, circuitJson) ?? checkSelectorOnBoard(to, circuitJson);
  if (wrong) return { ok: false, main, error: wrong };
  if (hasConnection(main, from, to)) {
    return { ok: false, main, error: "questi due punti sono gia' collegati" };
  }

  // the board's REAL closing tag, not a "</board>" in a comment or a string
  const board = scanJsxTags(main).filter((t) => t.name === "board" && !t.inAttribute && t.closeStart !== undefined).pop();
  const close = board?.closeStart ?? -1;
  if (close === -1) {
    return { ok: false, main, error: "non trovo la chiusura del board in main.tsx" };
  }

  // the closing line's indent is reused, so the new line aligns
  const lineStart = main.lastIndexOf("\n", close) + 1;
  const before = main.slice(lineStart, close);
  const indent = /^\s*$/.test(before) ? `${before}  ` : "    ";
  const trace = `<trace from="${from}" to="${to}" />`;
  if (!/^\s*$/.test(before)) {
    // the closing tag shares its line with something: the trace goes right before it
    return { ok: true, main: `${main.slice(0, close)}\n${indent}${trace}\n${main.slice(close)}`, trace };
  }
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
  const found = tracesBetween(main, from, to);
  if (found.length === 0) {
    return { ok: false, main, error: "questo collegamento non e' scritto in main.tsx" };
  }
  // from the bottom, so earlier indexes stay valid
  let out = main;
  for (const tag of [...found].sort((x, y) => y.start - x.start)) {
    let s = tag.start;
    let e = tag.closeEnd ?? tag.end;
    // the whole line goes when the trace was alone on it
    const lineStart = out.lastIndexOf("\n", s - 1) + 1;
    const nl = out.indexOf("\n", e);
    const lineEnd = nl === -1 ? out.length : nl;
    if (/^\s*$/.test(out.slice(lineStart, s)) && /^\s*$/.test(out.slice(e, lineEnd))) {
      s = lineStart;
      e = nl === -1 ? out.length : nl + 1;
    }
    out = out.slice(0, s) + out.slice(e);
  }
  return { ok: true, main: out, trace: `${from} -> ${to}` };
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
