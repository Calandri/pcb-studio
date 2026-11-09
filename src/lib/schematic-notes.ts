/**
 * schematico.json: what the drawing says about the circuit and the circuit
 * cannot say about itself.
 *
 *   {"sezioni": [{"nome": "caricatore", "titolo": "Caricatore BQ24210", "pezzi": ["IC1", "C16"]}],
 *    "commenti": {"C16": "100 nF sull'ingresso VUSB del caricatore"},
 *    "reti": {"M_NetC1_1": "U10.VBAT"}}
 *
 * WHY A FILE AND NOT schSectionName. A big generated board (the HTL-401, 183
 * parts) cannot emit <schematicsection>: tscircuit spends minutes more in its
 * section packing, and schSectionName never reaches the Circuit JSON. The
 * sections, the one-line comments and the readable net names therefore travel
 * in a project file of their own, read by the sheet only: the circuit, the
 * board and the compile never see it (it is left out of the files hash, so
 * writing it does not make the board stale).
 *
 * Everything in it is text written by a user: it is cleaned here (control and
 * bidi characters out, lengths capped) and drawn as React text children,
 * never as markup. A broken file is ignored with a warning, never thrown.
 */

export const SCHEMATIC_NOTES_PATH = "schematico.json";

/** the most write_file accepts for the file: 15 sections and 183 comments are ~20 kB */
export const SCHEMATIC_NOTES_MAX_BYTES = 256 * 1024;

export interface SchematicNotesSection {
  /** key of the section, as in the file */
  name: string;
  /** what a person reads on the frame (titolo, or the key when missing) */
  title: string;
  /** designators of the parts in the section */
  pieces: string[];
}

export interface SchematicNotes {
  sections: SchematicNotesSection[];
  /** designator -> one-line comment */
  comments: Map<string, string>;
  /** net name in the Circuit JSON -> name to show */
  nets: Map<string, string>;
  /** what was wrong with the file and what was done about it */
  warnings: string[];
}

const LIMITS = {
  sections: 200,
  piecesPerSection: 2000,
  comments: 5000,
  nets: 5000,
  name: 60,
  title: 120,
  comment: 300,
  netName: 80,
  warnings: 8,
};

/*
 * Control characters would break the line, the bidi overrides (U+202A..E,
 * U+2066..9) would let a comment display reversed text over a designator:
 * both go. Runs of whitespace become one space, the drawing has one line.
 */
const UNSAFE = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

function clean(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(UNSAFE, " ").replace(/\s+/g, " ").trim();
  if (text.length === 0) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Reads the file. null when there is no file (the sheet is the one of
 * today); a file that cannot be used gives empty notes with the reason.
 */
export function parseSchematicNotes(raw: string | null | undefined): SchematicNotes | null {
  if (raw === null || raw === undefined || raw.trim().length === 0) return null;
  const notes: SchematicNotes = { sections: [], comments: new Map(), nets: new Map(), warnings: [] };
  const warn = (text: string) => {
    if (notes.warnings.length < LIMITS.warnings) notes.warnings.push(text);
  };
  if (raw.length > SCHEMATIC_NOTES_MAX_BYTES) {
    warn(`${SCHEMATIC_NOTES_PATH} troppo grande (${Math.round(raw.length / 1024)} kB): ignorato`);
    return notes;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    warn(`${SCHEMATIC_NOTES_PATH} non e' un JSON valido: ignorato`);
    return notes;
  }
  if (!isObject(data)) {
    warn(`${SCHEMATIC_NOTES_PATH} non contiene un oggetto: ignorato`);
    return notes;
  }

  const taken = new Map<string, string>();
  if (data.sezioni !== undefined && !Array.isArray(data.sezioni)) warn("sezioni non e' una lista: ignorate");
  const sections = Array.isArray(data.sezioni) ? data.sezioni : [];
  if (sections.length > LIMITS.sections) warn(`${sections.length} sezioni: tengo le prime ${LIMITS.sections}`);
  for (const [i, s] of sections.slice(0, LIMITS.sections).entries()) {
    if (!isObject(s)) {
      warn(`sezione ${i + 1}: non e' un oggetto, ignorata`);
      continue;
    }
    const name = clean(s.nome, LIMITS.name);
    if (!name) {
      warn(`sezione ${i + 1}: manca il nome, ignorata`);
      continue;
    }
    if (notes.sections.some((x) => x.name === name)) {
      warn(`sezione ${name} ripetuta: tengo la prima`);
      continue;
    }
    const pieces: string[] = [];
    for (const p of Array.isArray(s.pezzi) ? s.pezzi.slice(0, LIMITS.piecesPerSection) : []) {
      const ref = clean(p, LIMITS.name);
      if (!ref) continue;
      const other = taken.get(ref);
      if (other) {
        warn(`${ref} e' gia' nella sezione ${other}: resta li'`);
        continue;
      }
      taken.set(ref, name);
      pieces.push(ref);
    }
    notes.sections.push({ name, title: clean(s.titolo, LIMITS.title) ?? name, pieces });
  }

  const readMap = (value: unknown, key: string, max: number, limit: number, into: Map<string, string>) => {
    if (value === undefined) return;
    if (!isObject(value)) {
      warn(`${key} non e' un oggetto: ignorato`);
      return;
    }
    // Object.entries gives own keys only: a "__proto__" key is a plain entry
    // here, and it lands in a Map, never on a prototype
    const entries = Object.entries(value);
    if (entries.length > limit) warn(`${entries.length} voci in ${key}: tengo le prime ${limit}`);
    for (const [k, v] of entries.slice(0, limit)) {
      const ref = clean(k, LIMITS.netName);
      const text = clean(v, max);
      if (ref && text) into.set(ref, text);
    }
  };
  readMap(data.commenti, "commenti", LIMITS.comment, LIMITS.comments, notes.comments);
  readMap(data.reti, "reti", LIMITS.netName, LIMITS.nets, notes.nets);
  return notes;
}

/**
 * Checks a schematico.json before it is written into a project: it must be
 * JSON with an object inside and within the size limit. What is inside the
 * object is not refused (the sheet ignores what it cannot use and says why).
 */
export function validateSchematicNotesFile(content: string): string | null {
  const bytes = new TextEncoder().encode(content).length;
  if (bytes > SCHEMATIC_NOTES_MAX_BYTES) {
    return `${SCHEMATIC_NOTES_PATH} too large (${bytes} bytes, max ${SCHEMATIC_NOTES_MAX_BYTES})`;
  }
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch (err) {
    return `${SCHEMATIC_NOTES_PATH} is not valid JSON (${err instanceof Error ? err.message : String(err)})`;
  }
  if (!isObject(data)) return `${SCHEMATIC_NOTES_PATH} must contain a JSON object`;
  return null;
}

/*
 * The bridge to the sheet. The sheet is built from the Circuit JSON alone, so
 * the notes ride along as one extra element of a type nothing else reads
 * (every consumer of the Circuit JSON filters by type). It is added in the
 * browser right before drawing, never saved, never exported.
 */
export const SCHEMATIC_NOTES_ELEMENT = "pcb_studio_schematic_notes";

export function withSchematicNotes(circuitJson: unknown[], raw: string | null | undefined): unknown[] {
  if (raw === null || raw === undefined) return circuitJson;
  return [...circuitJson, { type: SCHEMATIC_NOTES_ELEMENT, raw }];
}

export function schematicNotesOf(circuitJson: unknown[]): SchematicNotes | null {
  for (let i = circuitJson.length - 1; i >= 0; i--) {
    const e = circuitJson[i] as { type?: unknown; raw?: unknown } | null;
    if (e?.type === SCHEMATIC_NOTES_ELEMENT) return parseSchematicNotes(typeof e.raw === "string" ? e.raw : null);
  }
  return null;
}
