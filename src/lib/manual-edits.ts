/**
 * Manual edits: the human's geometric layer.
 *
 * WHY A SEPARATE FILE. In PCB Studio main.tsx belongs to the agent, which
 * rewrites it in full at every turn. If dragging a component wrote into
 * main.tsx, the first "fix the decoupling" would erase hours of hand
 * placement; and conversely a human touching the file breaks the agent's
 * work. Here the two domains stay separate: main.tsx says WHAT is connected
 * to what, manual-edits.json says WHERE it sits and HOW the trace runs.
 * Neither overwrites the other.
 *
 * HOW IT IS APPLIED. Not at runtime on the Circuit JSON (it would be lost at
 * the first re-route) but at compile time, injecting into the sources the same
 * props that tscircuit honors with the highest priority:
 *   - schematic position   -> schX / schY on the component tag
 *   - position on the copper -> pcbX / pcbY on the component tag
 *   - path of a trace      -> manualEdits={{manual_trace_hints}} on the <board>
 * The user's sources are never modified: the injection lives only in the file
 * map passed to the compiler.
 *
 * Verified on @tscircuit/core 0.0.1512: schX/schY on a SINGLE component lock
 * that component and leave auto layout to the others even when the sheet is
 * split into sections (schSectionName), while the manualEdits prop with
 * schematic_placements is ignored by the sectioned layout and pcb_placements
 * are ignored as soon as a component already has pcbX/pcbY. That is why we go
 * through props and not the native format, which would not work here.
 */

import { manualRouteKey, parseManualRoutes, portSelectorResolver, type ManualRoute } from "./manual-routes";
import { parentFrameOffset, parseLength } from "./pcb-route-model";

export const MANUAL_EDITS_PATH = "manual-edits.json";

export interface ManualPlacement {
  /** component name, e.g. "R1" */
  selector: string;
  /** value to write into the position props (parent-relative coordinates) */
  center: { x: number; y: number };
  /** rotation in counterclockwise degrees, when the user changed it by hand */
  rotation?: number;
  /**
   * True when the position was decided by the PLACER, not by a person.
   *
   * It is saved all the same — otherwise the layout you are looking at exists
   * only in the compile cache and the next compile invents another one, which
   * is what made the parts look like they moved by themselves. But it is not a
   * constraint: an explicit "rearrange" may move it again, while a position
   * placed by hand stays where it was put.
   */
  auto?: boolean;
}

export interface ManualTraceHint {
  /** port selector, e.g. ".R1 > .pin1" */
  pcb_port_selector: string;
  /** waypoints in mm, board coordinates */
  offsets: Array<{ x: number; y: number; via?: boolean }>;
}

export interface ManualEdits {
  schematic_placements: ManualPlacement[];
  pcb_placements: ManualPlacement[];
  manual_trace_hints: ManualTraceHint[];
  /**
   * Manually routed traces: exact path, not a suggestion. The geometry
   * replaces the autorouter's for the declared connection — see
   * manual-routes.ts.
   */
  pcb_routes: ManualRoute[];
  /**
   * Which compiled board these edits were made on, and on which sources.
   *
   * Every manual edit changes this file, so the compile cache — keyed by the
   * hash of ALL the files — is "stale" from the first move on, by
   * construction. That is expected: the local reroute applies the moves to
   * the cached board and saves it under the new hash. What must NOT happen is
   * applying them to a board compiled from OTHER sources (the agent rewrote
   * main.tsx meanwhile) and calling the result current. So when an edit is
   * saved on a board that was current, the board's hash and the hash of the
   * sources without this file are written here; the reroute checks both
   * before trusting the cache. Written by the server, never by hand.
   */
  board_base?: BoardBase;
}

export interface BoardBase {
  /** files_hash of the compile cache the edits were made on */
  files_hash: string;
  /** hash of the sources (library included) WITHOUT manual-edits.json */
  sources_hash: string;
}

export function emptyManualEdits(): ManualEdits {
  return {
    schematic_placements: [],
    pcb_placements: [],
    manual_trace_hints: [],
    pcb_routes: [],
  };
}

export function countManualEdits(edits: ManualEdits): {
  schematic: number;
  pcb: number;
  /** positions decided by the placer and saved, not held by a person */
  pcbAuto: number;
  traceHints: number;
  routes: number;
  total: number;
} {
  const schematic = edits.schematic_placements.filter((p) => !p.auto).length;
  /*
   * Only what a PERSON is holding still. The placer's saved positions are in
   * the same list — they have to be, otherwise the layout exists nowhere — but
   * counting them here would say "57 held by hand" on a board where nobody
   * held anything, and "release all" would look far more destructive than it is.
   */
  const pcb = edits.pcb_placements.filter((p) => !p.auto).length;
  const pcbAuto = edits.pcb_placements.length - pcb;
  const traceHints = edits.manual_trace_hints.length;
  const routes = edits.pcb_routes.length;
  return {
    schematic,
    pcb,
    pcbAuto,
    traceHints,
    routes,
    /*
     * EVERYTHING there is to apply, automatic positions included: this is the
     * number that decides whether the sources get the props injected. Counting
     * only what was placed by hand meant that a board whose whole layout came
     * from the placer had "nothing to apply" — the positions were written to
     * file, read back, and then quietly ignored at compile time, so the board
     * went back to the coordinates in main.tsx. The UI shows `pcb` (by hand)
     * and `pcbAuto` separately; this total is for the compiler.
     */
    total: schematic + pcb + pcbAuto + traceHints + routes,
  };
}

const isPoint = (v: unknown): v is { x: number; y: number } =>
  typeof v === "object" &&
  v !== null &&
  Number.isFinite((v as { x: unknown }).x) &&
  Number.isFinite((v as { y: unknown }).y);

/**
 * Defensive parsing: the file is written by the server but lives in the
 * project's file map, so it can arrive hand-edited or truncated. A malformed
 * entry is discarded, it does not fail the compilation of the whole board.
 */
export function parseManualEdits(raw: string | undefined | null): ManualEdits {
  const out = emptyManualEdits();
  if (!raw) return out;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return out;
  }
  if (typeof data !== "object" || data === null) return out;
  const obj = data as Record<string, unknown>;

  for (const key of ["schematic_placements", "pcb_placements"] as const) {
    const list = obj[key];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (typeof item !== "object" || item === null) continue;
      const p = item as Record<string, unknown>;
      if (typeof p.selector !== "string" || !p.selector) continue;
      if (!isPoint(p.center)) continue;
      const rotation = normalizeRotation(p.rotation);
      out[key].push({
        selector: p.selector,
        center: { x: round3(p.center.x), y: round3(p.center.y) },
        ...(rotation !== null ? { rotation } : {}),
        ...(p.auto === true ? { auto: true as const } : {}),
      });
    }
  }
  const base = obj.board_base as Record<string, unknown> | undefined;
  if (base && typeof base.files_hash === "string" && typeof base.sources_hash === "string") {
    out.board_base = { files_hash: base.files_hash, sources_hash: base.sources_hash };
  }

  const hints = obj.manual_trace_hints;
  if (Array.isArray(hints)) {
    for (const item of hints) {
      if (typeof item !== "object" || item === null) continue;
      const h = item as Record<string, unknown>;
      if (typeof h.pcb_port_selector !== "string" || !h.pcb_port_selector) continue;
      if (!Array.isArray(h.offsets)) continue;
      const offsets = h.offsets
        .filter(isPoint)
        .map((o) => ({
          x: round3(o.x),
          y: round3(o.y),
          ...((o as { via?: unknown }).via === true ? { via: true } : {}),
        }));
      if (offsets.length === 0) continue;
      out.manual_trace_hints.push({ pcb_port_selector: h.pcb_port_selector, offsets });
    }
  }

  out.pcb_routes = parseManualRoutes(obj.pcb_routes);
  return out;
}

export function serializeManualEdits(edits: ManualEdits): string {
  // a fixed key order, so the same edits always give the same file (and hash)
  const { board_base, ...rest } = edits;
  const ordered = {
    schematic_placements: rest.schematic_placements,
    pcb_placements: rest.pcb_placements,
    manual_trace_hints: rest.manual_trace_hints,
    pcb_routes: rest.pcb_routes,
    ...(board_base ? { board_base } : {}),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/** the same edits, whatever board they were made on */
export function sameManualEdits(a: ManualEdits, b: ManualEdits): boolean {
  return (
    serializeManualEdits({ ...a, board_base: undefined }) ===
    serializeManualEdits({ ...b, board_base: undefined })
  );
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/**
 * A rotation in [0, 360), rounded to the micro-degree: -90 and 270 are the
 * same placement, and 89.99999999 coming out of a float sum is 90. null for
 * anything that is not a finite number.
 */
export function normalizeRotation(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const r = Math.round((((v % 360) + 360) % 360) * 1e6) / 1e6;
  return r >= 360 ? 0 : r;
}

// ---------------------------------------------------------------------------
// JSX scanning
//
// We need to know where each tag's attributes begin and end. A regex is not
// enough: `<trace from=".U1 > .VCC" />` contains a ">" inside a string and
// `pinLabels={{ ... }}` can contain one inside braces, so a `[^>]*>` would
// close the tag in the wrong place and the injection would end up in the
// middle of an attribute.
//
// Nor is "count the quotes and the braces" enough, which is what this was:
// a `// it's the decoupling` comment opened a string at the apostrophe and the
// scanner swallowed every tag up to the next quote; `i<n` in a loop or
// `useState<Foo>()` became a tag; `"<resistor>"` inside a string became a
// component. So this is a small lexer, aware of the three places a `<` can be:
//   - JavaScript: comments, strings, template literals and regex literals are
//     skipped, and `<` opens a tag only in EXPRESSION position (after `(`,
//     `=`, `return`, `=>` ...) and directly followed by a name;
//   - a tag's attributes: JSX strings (no escapes) and `{...}` expressions,
//     which are JavaScript again and may contain JSX of their own;
//   - JSX children: text, where quotes are just characters, `{...}`
//     expressions, nested elements and the closing tag.
// A `<` that looked like a tag but never closes (a generic `<T>(x) => x`
// in a type) is rolled back and read as an operator. TypeScript itself is
// only a dev dependency, so it cannot do this at runtime.
// ---------------------------------------------------------------------------

export interface JsxTag {
  name: string;
  /** index of the "<" */
  start: number;
  /** index just past the ">" */
  end: number;
  /** range of the attribute text */
  attrsStart: number;
  attrsEnd: number;
  /** `<x ... />` */
  selfClosing: boolean;
  /** for an element with children: the range of its `</name>` */
  closeStart?: number;
  closeEnd?: number;
  /**
   * The tag sits INSIDE another tag's attributes (footprint={<footprint>...}):
   * it is part of that tag's value, not a component of the board.
   */
  inAttribute: boolean;
}

const isIdStart = (c: string | undefined): boolean => !!c && /[A-Za-z_$]/.test(c);
const isIdChar = (c: string | undefined): boolean => !!c && /[A-Za-z0-9_$]/.test(c);
/** JSX names: identifiers, member access, namespaces, custom elements */
const isTagNameChar = (c: string | undefined): boolean => !!c && /[A-Za-z0-9_$.:-]/.test(c);

/** words after which an expression starts, so `<` opens a tag and `/` a regex */
const EXPRESSION_KEYWORDS = new Set([
  "return", "yield", "await", "case", "default", "else", "do", "typeof",
  "void", "delete", "in", "of", "throw", "new", "extends",
]);

/**
 * The tags of a source file, in order. Tags that sit inside another tag's
 * attribute value (the <footprint> and <smtpad> of an inline footprint) are
 * part of that value, not elements of the board: they are left out unless
 * `includeNested` asks for them, flagged `inAttribute`.
 */
export function scanJsxTags(src: string, opts: { includeNested?: boolean } = {}): JsxTag[] {
  const tags: JsxTag[] = [];
  const n = src.length;

  const skipLineComment = (i: number): number => {
    const nl = src.indexOf("\n", i);
    return nl === -1 ? n : nl;
  };
  const skipBlockComment = (i: number): number => {
    const end = src.indexOf("*/", i + 2);
    return end === -1 ? n : end + 2;
  };
  /** a JS string: escapes count, a newline ends an unterminated one */
  const skipJsString = (i: number): number => {
    const q = src[i];
    for (let k = i + 1; k < n; k++) {
      const c = src[k];
      if (c === "\\") {
        k++;
        continue;
      }
      if (c === q) return k + 1;
      if (c === "\n") return k;
    }
    return n;
  };
  const skipTemplate = (i: number, depth: number, inAttr: boolean): number => {
    for (let k = i + 1; k < n; k++) {
      const c = src[k];
      if (c === "\\") {
        k++;
        continue;
      }
      if (c === "`") return k + 1;
      if (c === "$" && src[k + 1] === "{") {
        k = scanJs(k + 2, true, depth + 1, inAttr) - 1;
      }
    }
    return n;
  };
  const skipRegex = (i: number): number => {
    let inClass = false;
    for (let k = i + 1; k < n; k++) {
      const c = src[k];
      if (c === "\\") {
        k++;
        continue;
      }
      if (c === "\n") return k;
      if (inClass) {
        if (c === "]") inClass = false;
        continue;
      }
      if (c === "[") inClass = true;
      else if (c === "/") {
        let e = k + 1;
        while (e < n && /[a-z]/i.test(src[e])) e++;
        return e;
      }
    }
    return n;
  };

  /**
   * JavaScript from i. With untilBrace it stops after the `}` that closes the
   * expression it was called for and returns the index past it.
   */
  function scanJs(i: number, untilBrace: boolean, depth: number, inAttr: boolean): number {
    let braces = 0;
    // true when what follows is an expression: start, after an operator or
    // an opening bracket or a keyword
    let exprPos = true;
    let k = i;
    while (k < n) {
      const c = src[k];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") {
        k++;
        continue;
      }
      if (c === "/" && src[k + 1] === "/") {
        k = skipLineComment(k);
        continue;
      }
      if (c === "/" && src[k + 1] === "*") {
        k = skipBlockComment(k);
        continue;
      }
      if (c === '"' || c === "'") {
        k = skipJsString(k);
        exprPos = false;
        continue;
      }
      if (c === "`") {
        k = skipTemplate(k, depth, inAttr);
        exprPos = false;
        continue;
      }
      if (c === "/" && exprPos) {
        k = skipRegex(k);
        exprPos = false;
        continue;
      }
      if (c === "<" && exprPos && (isIdStart(src[k + 1]) || src[k + 1] === ">")) {
        const end = tryElement(k, depth, inAttr);
        if (end !== -1) {
          k = end;
          exprPos = false;
          continue;
        }
        k++;
        exprPos = true;
        continue;
      }
      if (isIdStart(c)) {
        let e = k + 1;
        while (e < n && isIdChar(src[e])) e++;
        const word = src.slice(k, e);
        // `a.return` is a property, not the keyword
        const prev = src[k - 1];
        exprPos = EXPRESSION_KEYWORDS.has(word) && prev !== ".";
        k = e;
        continue;
      }
      if (/[0-9]/.test(c)) {
        let e = k + 1;
        while (e < n && /[0-9A-Za-z_.]/.test(src[e])) e++;
        k = e;
        exprPos = false;
        continue;
      }
      if (c === "{") {
        braces++;
        exprPos = true;
        k++;
        continue;
      }
      if (c === "}") {
        if (untilBrace && braces === 0) return k + 1;
        braces--;
        // after a block `}` an expression may start (`} <x/>` is rare, `}/re/` too)
        exprPos = true;
        k++;
        continue;
      }
      if (c === ")" || c === "]") {
        exprPos = false;
        k++;
        continue;
      }
      // every other punctuator (operators, `(`, `[`, `,`, `;`, `=>` ...) starts an expression
      exprPos = true;
      k++;
    }
    return n;
  }

  /** JSX attribute value or text up to the end of the tag; -1 if it never closes */
  function scanTagAttrs(k: number, depth: number): { end: number; attrsEnd: number; selfClosing: boolean } | null {
    let last = "";
    while (k < n) {
      const c = src[k];
      if (!/\s/.test(c)) last = c === "=" ? "=" : last === "=" && c === "<" ? "=" : "";
      if (c === "/" && src[k + 1] === "/") {
        k = skipLineComment(k);
        continue;
      }
      if (c === "/" && src[k + 1] === "*") {
        k = skipBlockComment(k);
        continue;
      }
      if (c === '"' || c === "'") {
        // JSX attribute strings have no escapes
        const close = src.indexOf(c, k + 1);
        if (close === -1) return null;
        k = close + 1;
        continue;
      }
      if (c === "{") {
        k = scanJs(k + 1, true, depth + 1, true);
        continue;
      }
      if (c === "/" && src[k + 1] === ">") {
        return { end: k + 2, attrsEnd: k, selfClosing: true };
      }
      if (c === ">") return { end: k + 1, attrsEnd: k, selfClosing: false };
      if (c === "<") {
        // attr=<element/>: legal JSX, the element is the value
        if (last === "=" && (isIdStart(src[k + 1]) || src[k + 1] === ">")) {
          const end = tryElement(k, depth + 1, true);
          if (end === -1) return null;
          k = end;
          last = "";
          continue;
        }
        return null; // a `<` among attributes: this was never a tag
      }
      k++;
    }
    return null;
  }

  /** children of an element up to its closing tag; index past it, or -1 */
  function scanChildren(k: number, depth: number, inAttr: boolean): { closeStart: number; closeEnd: number } | null {
    while (k < n) {
      const c = src[k];
      if (c === "{") {
        k = scanJs(k + 1, true, depth + 1, inAttr);
        continue;
      }
      if (c === "<") {
        if (src[k + 1] === "/") {
          const close = src.indexOf(">", k + 2);
          if (close === -1) return null;
          return { closeStart: k, closeEnd: close + 1 };
        }
        if (isIdStart(src[k + 1]) || src[k + 1] === ">") {
          const end = tryElement(k, depth + 1, inAttr);
          if (end === -1) return null;
          k = end;
          continue;
        }
      }
      k++;
    }
    return null;
  }

  /**
   * A whole element from the `<` at i: the tag, its children, its closing
   * tag. Returns the index past it, or -1 rolling back what it recorded.
   */
  function tryElement(i: number, depth: number, inAttr: boolean): number {
    if (depth > 200) return -1;
    const mark = tags.length;
    let j = i + 1;
    // fragment `<>...</>`
    if (src[j] === ">") {
      const kids = scanChildren(j + 1, depth, inAttr);
      if (!kids) {
        tags.length = mark;
        return -1;
      }
      return kids.closeEnd;
    }
    while (j < n && isTagNameChar(src[j])) j++;
    const name = src.slice(i + 1, j);
    // `<T,>` and `<T extends X>` are generics, not tags
    const after = /^\s*(,|extends\b)/.exec(src.slice(j, j + 12));
    if (after) return -1;
    const tag: JsxTag = {
      name,
      start: i,
      end: -1,
      attrsStart: j,
      attrsEnd: j,
      selfClosing: false,
      inAttribute: inAttr,
    };
    tags.push(tag);
    const attrs = scanTagAttrs(j, depth);
    if (!attrs) {
      tags.length = mark;
      return -1;
    }
    tag.end = attrs.end;
    let attrsEnd = attrs.attrsEnd;
    while (attrsEnd > j && /\s/.test(src[attrsEnd - 1])) attrsEnd--;
    tag.attrsEnd = attrsEnd;
    tag.selfClosing = attrs.selfClosing;
    if (attrs.selfClosing) return attrs.end;
    const kids = scanChildren(attrs.end, depth, inAttr);
    if (!kids) {
      tags.length = mark;
      return -1;
    }
    tag.closeStart = kids.closeStart;
    tag.closeEnd = kids.closeEnd;
    return kids.closeEnd;
  }

  scanJs(0, false, 0, false);
  const sorted = tags.sort((a, b) => a.start - b.start);
  return opts.includeNested ? sorted : sorted.filter((t) => !t.inAttribute);
}

/** one attribute as written: where its name and its value sit in the attribute text */
export interface JsxAttr {
  name: string;
  nameStart: number;
  /** whole value, delimiters included; -1 when the attribute has no value */
  valueStart: number;
  valueEnd: number;
  /** "string": "x" or 'x'; "expr": {x}; "element": <x/>; "bare": no value */
  kind: "string" | "expr" | "element" | "bare";
  /** the text inside the delimiters */
  raw: string;
}

/**
 * The attributes of a tag, read in order. It knows strings, `{}` expressions
 * with strings, templates and comments inside them, and spreads, so an
 * attribute name written INSIDE another attribute's value (a `name` in the
 * `footprint={<footprint name="SOIC8"/>}` of a chip) is not mistaken for the
 * chip's own.
 */
export function parseJsxAttrs(attrs: string): JsxAttr[] {
  const out: JsxAttr[] = [];
  const n = attrs.length;
  /** index past the `}` matching the `{` at i, aware of strings and comments */
  const skipBraces = (i: number): number => {
    let depth = 0;
    for (let k = i; k < n; k++) {
      const c = attrs[k];
      if (c === '"' || c === "'" || c === "`") {
        for (k = k + 1; k < n && attrs[k] !== c; k++) if (attrs[k] === "\\") k++;
        continue;
      }
      if (c === "/" && attrs[k + 1] === "/") {
        const nl = attrs.indexOf("\n", k);
        k = nl === -1 ? n : nl;
        continue;
      }
      if (c === "/" && attrs[k + 1] === "*") {
        const e = attrs.indexOf("*/", k + 2);
        k = e === -1 ? n : e + 1;
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) return k + 1;
      }
    }
    return n;
  };
  let k = 0;
  while (k < n) {
    const c = attrs[k];
    if (/\s/.test(c)) {
      k++;
      continue;
    }
    if (c === "/" && attrs[k + 1] === "/") {
      const nl = attrs.indexOf("\n", k);
      k = nl === -1 ? n : nl;
      continue;
    }
    if (c === "/" && attrs[k + 1] === "*") {
      const e = attrs.indexOf("*/", k + 2);
      k = e === -1 ? n : e + 2;
      continue;
    }
    if (c === "{") {
      // spread {...props}
      k = skipBraces(k);
      continue;
    }
    if (!isIdStart(c)) {
      k++;
      continue;
    }
    const nameStart = k;
    while (k < n && /[A-Za-z0-9_$:.-]/.test(attrs[k])) k++;
    const name = attrs.slice(nameStart, k);
    let e = k;
    while (e < n && /\s/.test(attrs[e])) e++;
    if (attrs[e] !== "=") {
      out.push({ name, nameStart, valueStart: -1, valueEnd: -1, kind: "bare", raw: "" });
      continue;
    }
    e++;
    while (e < n && /\s/.test(attrs[e])) e++;
    const q = attrs[e];
    if (q === '"' || q === "'") {
      const close = attrs.indexOf(q, e + 1);
      const end = close === -1 ? n : close + 1;
      out.push({ name, nameStart, valueStart: e, valueEnd: end, kind: "string", raw: attrs.slice(e + 1, close === -1 ? n : close) });
      k = end;
      continue;
    }
    if (q === "{") {
      const end = skipBraces(e);
      out.push({ name, nameStart, valueStart: e, valueEnd: end, kind: "expr", raw: attrs.slice(e + 1, Math.max(e + 1, end - 1)) });
      k = end;
      continue;
    }
    if (q === "<") {
      // an element as a value: up to the end of what the scanner sees as one
      const inner = scanJsxTags(attrs.slice(e));
      const first = inner.find((t) => t.start === 0);
      const end = first ? e + (first.closeEnd ?? first.end) : n;
      out.push({ name, nameStart, valueStart: e, valueEnd: end, kind: "element", raw: attrs.slice(e, end) });
      k = end;
      continue;
    }
    // unquoted (not valid JSX, but tolerated): up to the next space
    let end = e;
    while (end < n && !/\s/.test(attrs[end])) end++;
    out.push({ name, nameStart, valueStart: e, valueEnd: end, kind: "bare", raw: attrs.slice(e, end) });
    k = end;
  }
  return out;
}

/** a `{"x"}`, `{'x'}` or `{`x`}` expression that is only a string literal */
function stringLiteralOf(expr: string): string | null {
  const t = expr.trim();
  const m = /^(["'])((?:\\.|(?!\1)[^\\])*)\1$/.exec(t) ?? /^`([^`$\\]*)`$/.exec(t);
  if (!m) return null;
  return m.length === 3 ? m[2].replace(/\\(.)/g, "$1") : m[1];
}

/**
 * Value of an attribute inside a tag's attribute text: the string for
 * "x", 'x' and {"x"}; the expression text for {expr}; null when absent.
 */
export function readAttr(attrs: string, attr: string): string | null {
  const a = parseJsxAttrs(attrs).find((x) => x.name === attr);
  if (!a || a.kind === "element") return a?.kind === "element" ? a.raw : null;
  if (a.valueStart === -1) return null;
  if (a.kind === "expr") return stringLiteralOf(a.raw) ?? a.raw;
  return a.raw;
}

/**
 * Numeric value of a prop written as pcbX={-4}, pcbX="2mm", pcbX="1cm",
 * pcbX="20mil", pcbX="0.1in". Anything else — an expression like
 * {base + 2}, a unit we do not know — is null: reading the first number of
 * "10 + 2" as 10 moved a part by two millimetres.
 */
export function readNumericProp(attrs: string, attr: string): number | null {
  const raw = readAttr(attrs, attr);
  if (raw === null) return null;
  return parseLength(raw);
}

/** replaces the prop if present, otherwise appends it to the attributes */
function upsertAttr(attrs: string, attr: string, valueExpr: string): string {
  const a = parseJsxAttrs(attrs).find((x) => x.name === attr);
  if (!a) return `${attrs.replace(/\s+$/, "")} ${attr}=${valueExpr}`;
  if (a.valueStart === -1) {
    // `name` with no value: give it one
    return attrs.slice(0, a.nameStart) + `${attr}=${valueExpr}` + attrs.slice(a.nameStart + attr.length);
  }
  return attrs.slice(0, a.nameStart) + `${attr}=${valueExpr}` + attrs.slice(a.valueEnd);
}

// tags that have a name attribute but are not placeable components: injecting
// pcbX on a <trace> or a <net> is a compile error
const NOT_PLACEABLE = new Set(["trace", "net", "schematicsection", "netlabel", "footprint"]);

/**
 * Rewrites the sources applying the manual edits. The result is what gets
 * compiled; the project files remain the ones written by the agent.
 */
export function injectManualEdits(main: string, edits: ManualEdits): string {
  const sch = new Map(edits.schematic_placements.map((p) => [p.selector, p.center]));
  const pcb = new Map(
    edits.pcb_placements.map((p) => [
      p.selector,
      { ...p.center, ...(p.rotation !== undefined ? { rotation: p.rotation } : {}) },
    ]),
  );
  const hints = edits.manual_trace_hints;
  if (sch.size === 0 && pcb.size === 0 && hints.length === 0) return main;

  const tags = scanJsxTags(main);
  // work from the bottom so the indexes of earlier tags stay valid
  let out = main;
  for (let i = tags.length - 1; i >= 0; i--) {
    const tag = tags[i];
    // part of another tag's value (the <footprint> of a chip): not a component
    if (tag.inAttribute) continue;
    const attrs = out.slice(tag.attrsStart, tag.attrsEnd);
    let next = attrs;

    if (tag.name === "board" && hints.length > 0) {
      const literal = JSON.stringify({ manual_trace_hints: hints });
      next = upsertAttr(next, "manualEdits", `{${literal}}`);
    }

    if (!NOT_PLACEABLE.has(tag.name.toLowerCase())) {
      const name = readAttr(attrs, "name");
      if (name) {
        const s = sch.get(name);
        if (s) {
          next = upsertAttr(next, "schX", `{${s.x}}`);
          next = upsertAttr(next, "schY", `{${s.y}}`);
        }
        const p = pcb.get(name);
        if (p) {
          next = upsertAttr(next, "pcbX", `{${p.x}}`);
          next = upsertAttr(next, "pcbY", `{${p.y}}`);
          if (p.rotation !== undefined) {
            next = upsertAttr(next, "pcbRotation", `{${p.rotation}}`);
          }
        }
      }
    }

    if (next !== attrs) {
      // without the space the tag becomes `schY={-2}/>`: valid, but unreadable
      // for whoever opens the compiled file to see what was injected
      if (out[tag.attrsEnd] === "/" && !/\s$/.test(next)) next += " ";
      out = out.slice(0, tag.attrsStart) + next + out.slice(tag.attrsEnd);
    }
  }
  return out;
}

/**
 * File map ready for the compiler: main.tsx with the props injected and
 * without the manual-edits file (it is not a module, the compiler does not
 * need it).
 */
export function applyManualEditsToFsMap(
  fsMap: Record<string, string>,
): Record<string, string> {
  const raw = fsMap[MANUAL_EDITS_PATH];
  // always a copy: the tscircuit runner adds entrypoint.tsx to the map it is
  // given, and with the caller's own object that file ended up in the hash
  // of the "current" sources, so a board compiled a second ago looked stale
  if (!raw) return { ...fsMap };
  const edits = parseManualEdits(raw);
  const rest = { ...fsMap };
  delete rest[MANUAL_EDITS_PATH];
  if (countManualEdits(edits).total === 0) return rest;
  const main = rest["main.tsx"];
  if (typeof main !== "string") return rest;
  return { ...rest, "main.tsx": injectManualEdits(main, edits) };
}

// ---------------------------------------------------------------------------
// Viewer edit events -> manual edits
// ---------------------------------------------------------------------------

export interface EditEvent {
  edit_event_type?: string;
  pcb_edit_event_type?: string;
  in_progress?: boolean;
  pcb_component_id?: string;
  schematic_component_id?: string;
  pcb_port_id?: string;
  original_center?: { x: number; y: number };
  new_center?: { x: number; y: number };
  /** absolute rotation in counterclockwise degrees, if the event changes it */
  new_rotation?: number;
  route?: Array<{ x: number; y: number; via?: boolean }>;
}

type El = Record<string, unknown>;

const findById = (circuitJson: unknown[], type: string, idKey: string, id: string): El | null =>
  (circuitJson as El[]).find((e) => e?.type === type && e[idKey] === id) ?? null;

/** source name of a component from its pcb/schematic element */
function sourceName(circuitJson: unknown[], sourceComponentId: unknown): string | null {
  if (typeof sourceComponentId !== "string") return null;
  const src = findById(circuitJson, "source_component", "source_component_id", sourceComponentId);
  const name = src?.name;
  return typeof name === "string" && name ? name : null;
}

/**
 * Port selector in the ".R1 > .pin1" form. Needed by the TraceHint tag, which
 * resolves the port by selector and not by id: ids change at every
 * compilation, the name does not.
 */
function portSelector(circuitJson: unknown[], pcbPortId: string): string | null {
  const pcbPort = findById(circuitJson, "pcb_port", "pcb_port_id", pcbPortId);
  if (!pcbPort) return null;
  const srcPortId = pcbPort.source_port_id;
  if (typeof srcPortId !== "string") return null;
  const srcPort = findById(circuitJson, "source_port", "source_port_id", srcPortId);
  if (!srcPort) return null;
  const comp = sourceName(circuitJson, srcPort.source_component_id);
  if (!comp) return null;
  const hints = Array.isArray(srcPort.port_hints) ? (srcPort.port_hints as unknown[]) : [];
  const pin =
    (typeof srcPort.name === "string" && srcPort.name) ||
    (hints.find((h) => typeof h === "string") as string | undefined);
  if (!pin) return null;
  return `.${comp} > .${pin}`;
}

const upsertPlacement = (
  list: ManualPlacement[],
  selector: string,
  center: { x: number; y: number },
  rotation?: number,
): ManualPlacement[] => {
  const previous = list.find((p) => p.selector === selector);
  const next = list.filter((p) => p.selector !== selector);
  // moved by hand: from now on it is a constraint, no longer the placer's guess
  next.push({
    selector,
    center: { x: round3(center.x), y: round3(center.y) },
    // a rotation not declared by the event survives the move
    ...(rotation !== undefined
      ? { rotation }
      : previous?.rotation !== undefined
        ? { rotation: previous.rotation }
        : {}),
  });
  return next;
};

/** how much a single save may carry: the editor sends one event per drag */
export const EDIT_LIMITS = {
  maxEvents: 500,
  maxHintPoints: 500,
  /** a coordinate beyond a metre is not on a board */
  maxCoordMm: 1000,
} as const;

const finitePoint = (v: unknown): v is { x: number; y: number } =>
  isPoint(v) &&
  Math.abs((v as { x: number }).x) <= EDIT_LIMITS.maxCoordMm &&
  Math.abs((v as { y: number }).y) <= EDIT_LIMITS.maxCoordMm;

/**
 * Translates viewer events into manual edits.
 *
 * The viewer reasons in global board coordinates, the injected props are
 * relative to the parent: so the DISPLACEMENT is applied to the existing prop
 * instead of the absolute position. On a flat board the two coincide; on a
 * component inside a <group> only the displacement is correct.
 *
 * Events come from the client and are checked one by one: a null entry, a
 * non-finite coordinate or rotation, an absurd one, is skipped instead of
 * being written as NaN into the file the compiler reads.
 */
export function applyEditEvents({
  circuitJson,
  main,
  edits,
  events,
}: {
  circuitJson: unknown[];
  main: string;
  edits: ManualEdits;
  events: EditEvent[];
}): ManualEdits {
  const out: ManualEdits = {
    schematic_placements: [...edits.schematic_placements],
    pcb_placements: [...edits.pcb_placements],
    manual_trace_hints: [...edits.manual_trace_hints],
    pcb_routes: [...edits.pcb_routes],
    ...(edits.board_base ? { board_base: edits.board_base } : {}),
  };
  // one pass over the sources, not one per event: an imported main.tsx is megabytes
  const attrsByName = new Map<string, string>();
  for (const tag of scanJsxTags(main)) {
    if (tag.inAttribute || NOT_PLACEABLE.has(tag.name.toLowerCase())) continue;
    const attrs = main.slice(tag.attrsStart, tag.attrsEnd);
    const name = readAttr(attrs, "name");
    if (name && !attrsByName.has(name)) attrsByName.set(name, attrs);
  }
  const attrsOf = (name: string): string | null => attrsByName.get(name) ?? null;

  for (const event of (Array.isArray(events) ? events : []).slice(0, EDIT_LIMITS.maxEvents)) {
    if (typeof event !== "object" || event === null) continue;
    if (event.in_progress) continue;
    if (event.new_rotation !== undefined && normalizeRotation(event.new_rotation) === null) continue;
    const newRotation =
      event.new_rotation === undefined ? undefined : (normalizeRotation(event.new_rotation) as number);

    if (
      event.edit_event_type === "edit_pcb_component_location" &&
      typeof event.pcb_component_id === "string" &&
      finitePoint(event.original_center) &&
      finitePoint(event.new_center)
    ) {
      const el = findById(circuitJson, "pcb_component", "pcb_component_id", event.pcb_component_id);
      const name = el && sourceName(circuitJson, el.source_component_id);
      if (!name) continue;
      const existing = out.pcb_placements.find((p) => p.selector === name)?.center;
      const attrs = attrsOf(name);
      /*
       * The base is an ORIGIN, and the viewer speaks in centres.
       *
       * It only sends the displacement, so centre-space deltas are fine — but
       * the fallback used `original_center` as if it were the origin, and on an
       * off-centre footprint (0,28 mm on the MEMS microphones) the first move of
       * a part that had never been pinned shifted it by that much. The compiled
       * board knows the real origin: display_offset. That comes first, then the
       * prop written in the sources, and only in the end the centre.
       *
       * The centre is in BOARD coordinates and the placement is relative to
       * the parent group: inside <group pcbX={10}> a part with no position of
       * its own was written at its absolute 12 and the group added its 10 on
       * top. The group's origin is taken off.
       */
      const offX = parseLength(el.display_offset_x);
      const offY = parseLength(el.display_offset_y);
      const frame = parentFrameOffset(circuitJson, el);
      const baseX =
        existing?.x ??
        offX ??
        (attrs ? readNumericProp(attrs, "pcbX") : null) ??
        event.original_center.x - frame.x;
      const baseY =
        existing?.y ??
        offY ??
        (attrs ? readNumericProp(attrs, "pcbY") : null) ??
        event.original_center.y - frame.y;
      out.pcb_placements = upsertPlacement(
        out.pcb_placements,
        name,
        {
          x: baseX + (event.new_center.x - event.original_center.x),
          y: baseY + (event.new_center.y - event.original_center.y),
        },
        newRotation,
      );
      continue;
    }

    if (
      event.edit_event_type === "edit_schematic_component_location" &&
      typeof event.schematic_component_id === "string" &&
      finitePoint(event.original_center) &&
      finitePoint(event.new_center)
    ) {
      const el = findById(
        circuitJson,
        "schematic_component",
        "schematic_component_id",
        event.schematic_component_id,
      );
      const name = el && sourceName(circuitJson, el.source_component_id);
      if (!name) continue;
      const existing = out.schematic_placements.find((p) => p.selector === name)?.center;
      const attrs = attrsOf(name);
      const baseX =
        existing?.x ?? (attrs ? readNumericProp(attrs, "schX") : null) ?? event.original_center.x;
      const baseY =
        existing?.y ?? (attrs ? readNumericProp(attrs, "schY") : null) ?? event.original_center.y;
      out.schematic_placements = upsertPlacement(out.schematic_placements, name, {
        x: baseX + (event.new_center.x - event.original_center.x),
        y: baseY + (event.new_center.y - event.original_center.y),
      });
      continue;
    }

    if (event.pcb_edit_event_type === "edit_trace_hint" && typeof event.pcb_port_id === "string") {
      const selector = portSelector(circuitJson, event.pcb_port_id);
      if (!selector) continue;
      const raw = Array.isArray(event.route) ? event.route : [];
      if (raw.length > EDIT_LIMITS.maxHintPoints) continue;
      const route = raw.filter(finitePoint) as Array<{ x: number; y: number; via?: boolean }>;
      // a hint with a broken point is not the hint that was drawn
      if (route.length !== raw.length) continue;
      const rest = out.manual_trace_hints.filter((h) => h.pcb_port_selector !== selector);
      if (route.length > 0) {
        rest.push({
          pcb_port_selector: selector,
          offsets: route.map((p) => ({
            x: round3(p.x),
            y: round3(p.y),
            ...(p.via === true ? { via: true } : {}),
          })),
        });
      }
      out.manual_trace_hints = rest;
    }
  }
  return out;
}

/**
 * The placer's positions merged into a manual-edits file, as `auto`: every
 * position held by hand IN THAT FILE stays as it is, and so does everything
 * else in it (routes, hints, schematic). Meant to run on the file as it is
 * NOW, not on the one read minutes ago when the rearrange started: in between
 * a person may have pinned a part or drawn a trace, and writing back the old
 * snapshot erased it.
 */
export function mergeAutoPlacements(raw: string | null, auto: ManualPlacement[]): string {
  const attuali = parseManualEdits(raw);
  const aMano = new Set(attuali.pcb_placements.filter((p) => !p.auto).map((p) => p.selector));
  const perNome = new Map(attuali.pcb_placements.map((p) => [p.selector, p] as const));
  // one entry per component: the placer's wins only where nobody holds it
  for (const p of auto) if (!aMano.has(p.selector)) perNome.set(p.selector, { ...p, auto: true });
  return serializeManualEdits({ ...attuali, pcb_placements: [...perNome.values()] });
}

/** removes the manual constraints of a component (or of all if name is null) */
export function releaseManualEdits(
  edits: ManualEdits,
  scope: "schematic" | "pcb" | "traces" | "all",
  name: string | null,
): ManualEdits {
  const keepPlacement = (list: ManualPlacement[], active: boolean) =>
    !active ? list : name === null ? [] : list.filter((p) => p.selector !== name);
  const schActive = scope === "schematic" || scope === "all";
  const pcbActive = scope === "pcb" || scope === "all";
  const traceActive = scope === "traces" || scope === "all";
  const touches = (r: ManualRoute): boolean =>
    r.connection.includes(`.${name} >`) ||
    (r.from?.startsWith(`.${name} >`) ?? false) ||
    (r.to?.startsWith(`.${name} >`) ?? false);
  return {
    ...(edits.board_base ? { board_base: edits.board_base } : {}),
    pcb_routes:
      !traceActive
        ? edits.pcb_routes
        : name === null
          ? []
          : edits.pcb_routes.filter((r) => !touches(r)),
    schematic_placements: keepPlacement(edits.schematic_placements, schActive),
    pcb_placements: keepPlacement(edits.pcb_placements, pcbActive),
    manual_trace_hints: !traceActive
      ? edits.manual_trace_hints
      : name === null
        ? []
        : edits.manual_trace_hints.filter(
            (h) => !h.pcb_port_selector.startsWith(`.${name} >`),
          ),
  };
}

// ---------------------------------------------------------------------------
// Orphan edits: what the file holds and the board no longer has
// ---------------------------------------------------------------------------

export interface OrphanEdits {
  /** pcb placements naming a component that is not on the board */
  pcb_placements: string[];
  schematic_placements: string[];
  /** routes whose connection, net or pads no longer exist: their key */
  pcb_routes: string[];
  /** trace hints whose port selector resolves to nothing */
  manual_trace_hints: string[];
  total: number;
}

/**
 * The edits that no longer apply to anything.
 *
 * Edits are keyed by NAME (the refdes, the connection, the pad selector),
 * because ids change at every compile. The price is that renaming R1 to R10 in
 * main.tsx leaves the R1 placement pointing at nothing, and before this nobody
 * said so: the injection skipped it, the route was dropped as "unknown", and
 * the part simply went back to automatic placement. Here every one of them is
 * listed, so the summary and the editor can show it.
 */
export function findOrphanEdits(circuitJson: unknown[], edits: ManualEdits): OrphanEdits {
  const els = (Array.isArray(circuitJson) ? circuitJson : []) as El[];
  const sourceByName = new Map<string, string>();
  for (const e of els) {
    if (e?.type === "source_component" && typeof e.name === "string" && typeof e.source_component_id === "string") {
      sourceByName.set(e.name, e.source_component_id);
    }
  }
  const onPcb = new Set<string>();
  const onSchematic = new Set<string>();
  for (const e of els) {
    if (e?.type === "pcb_component" && typeof e.source_component_id === "string") onPcb.add(e.source_component_id);
    if (e?.type === "schematic_component" && typeof e.source_component_id === "string") {
      onSchematic.add(e.source_component_id);
    }
  }
  const connections = new Set<string>();
  for (const e of els) {
    if (e?.type === "source_trace" && typeof e.display_name === "string") connections.add(e.display_name);
  }
  const nets = new Set<string>();
  for (const e of els) {
    if (e?.type === "source_net" && typeof e.name === "string") nets.add(e.name);
  }
  const resolvePort = portSelectorResolver(els);

  const pcb = edits.pcb_placements
    .filter((p) => {
      const id = sourceByName.get(p.selector);
      return !id || !onPcb.has(id);
    })
    .map((p) => p.selector);
  const sch = edits.schematic_placements
    .filter((p) => {
      const id = sourceByName.get(p.selector);
      return !id || !onSchematic.has(id);
    })
    .map((p) => p.selector);
  const routes = edits.pcb_routes
    .filter((r) => {
      if (r.net) return !nets.has(r.net);
      if (r.from && r.to) return !resolvePort(r.from) || !resolvePort(r.to);
      return !connections.has(r.connection);
    })
    .map((r) => manualRouteKey(r));
  const hints = edits.manual_trace_hints
    .filter((h) => !resolvePort(h.pcb_port_selector))
    .map((h) => h.pcb_port_selector);
  return {
    pcb_placements: pcb,
    schematic_placements: sch,
    pcb_routes: [...new Set(routes)],
    manual_trace_hints: hints,
    total: pcb.length + sch.length + new Set(routes).size + hints.length,
  };
}

// ---------------------------------------------------------------------------
// Is the cached board the board of these files?
// ---------------------------------------------------------------------------

/** the file map without this file: what the sources hash is computed on */
export function withoutManualEdits<T extends Record<string, string>>(fsMap: T): T {
  if (!(MANUAL_EDITS_PATH in fsMap)) return fsMap;
  return Object.fromEntries(Object.entries(fsMap).filter(([k]) => k !== MANUAL_EDITS_PATH)) as T;
}

/**
 * Whether the compile cache describes the current files.
 *   - "exact": compiled from exactly these files;
 *   - "edits": compiled from these SOURCES, and only manual edits made on it
 *     since (the board_base says so) — what a local reroute may apply;
 *   - false: compiled from something else. Working on it and calling the
 *     result current is how a stale board ends up shown as the real one.
 */
export function boardFreshness({
  cacheFilesHash,
  filesHash,
  sourcesHash,
  edits,
}: {
  cacheFilesHash: string | null | undefined;
  /** hash of all the current files, library included */
  filesHash: string;
  /** the same without manual-edits.json */
  sourcesHash: string;
  edits: ManualEdits;
}): "exact" | "edits" | false {
  if (!cacheFilesHash) return false;
  if (cacheFilesHash === filesHash) return "exact";
  const base = edits.board_base;
  if (base && base.files_hash === cacheFilesHash && base.sources_hash === sourcesHash) return "edits";
  return false;
}

/**
 * The board_base to write with an edit, given the state BEFORE it: the cache
 * was current for the files as they were (exact), or the previous base still
 * holds. Anything else drops it: the local reroute will then refuse, and a
 * real compile is needed.
 */
export function nextBoardBase({
  cacheFilesHash,
  filesHashBefore,
  sourcesHash,
  previous,
}: {
  cacheFilesHash: string | null | undefined;
  filesHashBefore: string;
  sourcesHash: string;
  previous: BoardBase | undefined;
}): BoardBase | undefined {
  if (!cacheFilesHash) return undefined;
  if (cacheFilesHash === filesHashBefore) return { files_hash: cacheFilesHash, sources_hash: sourcesHash };
  if (previous && previous.files_hash === cacheFilesHash && previous.sources_hash === sourcesHash) return previous;
  return undefined;
}
