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

import { parseManualRoutes, type ManualRoute } from "./manual-routes";

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
      out[key].push({
        selector: p.selector,
        center: { x: round3(p.center.x), y: round3(p.center.y) },
        ...(Number.isFinite(p.rotation) ? { rotation: Number(p.rotation) } : {}),
        ...(p.auto === true ? { auto: true as const } : {}),
      });
    }
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
  return `${JSON.stringify(edits, null, 2)}\n`;
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

// ---------------------------------------------------------------------------
// JSX scanning
//
// We need to know where each tag's attributes begin and end. A regex is not
// enough: `<trace from=".U1 > .VCC" />` contains a ">" inside a string and
// `pinLabels={{ ... }}` can contain one inside braces, so a `[^>]*>` would
// close the tag in the wrong place and the injection would end up in the
// middle of an attribute. This scanner accounts for strings and braces.
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
}

const isNameStart = (c: string) => /[A-Za-z_]/.test(c);
const isNameChar = (c: string) => /[A-Za-z0-9_.$]/.test(c);

export function scanJsxTags(src: string): JsxTag[] {
  const tags: JsxTag[] = [];
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== "<") continue;
    const nameStart = i + 1;
    if (nameStart >= src.length || !isNameStart(src[nameStart])) continue;
    let j = nameStart;
    while (j < src.length && isNameChar(src[j])) j++;
    const name = src.slice(nameStart, j);

    // attributes: scan up to the closing ">" ignoring those inside strings
    // or inside {} expressions
    let depth = 0;
    let quote: string | null = null;
    let k = j;
    let closed = -1;
    for (; k < src.length; k++) {
      const c = src[k];
      if (quote) {
        if (c === "\\") k++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        quote = c;
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth <= 0) {
        closed = k;
        break;
      }
    }
    if (closed === -1) continue;
    // the self-closing "/" is not part of the attributes
    let attrsEnd = closed;
    while (attrsEnd > j && /\s/.test(src[attrsEnd - 1])) attrsEnd--;
    if (attrsEnd > j && src[attrsEnd - 1] === "/") attrsEnd--;

    tags.push({ name, start: i, end: closed + 1, attrsStart: j, attrsEnd });
    i = closed;
  }
  return tags;
}

/** raw value of an attribute inside a tag's attribute text */
export function readAttr(attrs: string, attr: string): string | null {
  const re = new RegExp(`(^|\\s)${attr}\\s*=\\s*`, "g");
  const m = re.exec(attrs);
  if (!m) return null;
  const i = m.index + m[0].length;
  if (attrs[i] === '"' || attrs[i] === "'") {
    const q = attrs[i];
    const end = attrs.indexOf(q, i + 1);
    return end === -1 ? null : attrs.slice(i + 1, end);
  }
  if (attrs[i] === "{") {
    let depth = 0;
    for (let k = i; k < attrs.length; k++) {
      if (attrs[k] === "{") depth++;
      else if (attrs[k] === "}") {
        depth--;
        if (depth === 0) return attrs.slice(i + 1, k);
      }
    }
    return null;
  }
  const end = attrs.slice(i).search(/\s|$/);
  return attrs.slice(i, i + (end === -1 ? attrs.length : end));
}

/** numeric value of a prop written as schX={-4} or schX="2mm" */
export function readNumericProp(attrs: string, attr: string): number | null {
  const raw = readAttr(attrs, attr);
  if (raw === null) return null;
  const n = Number.parseFloat(raw.trim().replace(/mm$/, ""));
  return Number.isFinite(n) ? n : null;
}

/** replaces the prop if present, otherwise appends it to the attributes */
function upsertAttr(attrs: string, attr: string, valueExpr: string): string {
  const re = new RegExp(`(^|\\s)${attr}\\s*=\\s*`);
  const m = re.exec(attrs);
  if (!m) return `${attrs.replace(/\s+$/, "")} ${attr}=${valueExpr}`;
  const valueStart = m.index + m[0].length;
  const raw = readAttr(attrs, attr);
  if (raw === null) return `${attrs.replace(/\s+$/, "")} ${attr}=${valueExpr}`;
  // length of the original value, delimiters included
  const delim = attrs[valueStart];
  const consumed =
    delim === '"' || delim === "'" || delim === "{" ? raw.length + 2 : raw.length;
  return (
    attrs.slice(0, m.index + (m[1] ? m[1].length : 0)) +
    `${attr}=${valueExpr}` +
    attrs.slice(valueStart + consumed)
  );
}

// tags that have a name attribute but are not placeable components: injecting
// pcbX on a <trace> or a <net> is a compile error
const NOT_PLACEABLE = new Set(["trace", "net", "schematicsection", "netlabel"]);

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
  if (!raw) return fsMap;
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

/**
 * Translates viewer events into manual edits.
 *
 * The viewer reasons in global board coordinates, the injected props are
 * relative to the parent: so the DISPLACEMENT is applied to the existing prop
 * instead of the absolute position. On a flat board the two coincide; on a
 * component inside a <group> only the displacement is correct.
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
  };
  const tags = scanJsxTags(main);
  const attrsOf = (name: string): string | null => {
    for (const tag of tags) {
      if (NOT_PLACEABLE.has(tag.name.toLowerCase())) continue;
      const attrs = main.slice(tag.attrsStart, tag.attrsEnd);
      if (readAttr(attrs, "name") === name) return attrs;
    }
    return null;
  };

  for (const event of events) {
    if (event.in_progress) continue;

    if (
      event.edit_event_type === "edit_pcb_component_location" &&
      event.pcb_component_id &&
      event.original_center &&
      event.new_center
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
       */
      const offX = typeof el.display_offset_x === "number" ? el.display_offset_x : null;
      const offY = typeof el.display_offset_y === "number" ? el.display_offset_y : null;
      const baseX =
        existing?.x ??
        offX ??
        (attrs ? readNumericProp(attrs, "pcbX") : null) ??
        event.original_center.x;
      const baseY =
        existing?.y ??
        offY ??
        (attrs ? readNumericProp(attrs, "pcbY") : null) ??
        event.original_center.y;
      out.pcb_placements = upsertPlacement(
        out.pcb_placements,
        name,
        {
          x: baseX + (event.new_center.x - event.original_center.x),
          y: baseY + (event.new_center.y - event.original_center.y),
        },
        event.new_rotation,
      );
      continue;
    }

    if (
      event.edit_event_type === "edit_schematic_component_location" &&
      event.schematic_component_id &&
      event.original_center &&
      event.new_center
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

    if (event.pcb_edit_event_type === "edit_trace_hint" && event.pcb_port_id) {
      const selector = portSelector(circuitJson, event.pcb_port_id);
      if (!selector) continue;
      const route = (event.route ?? []).filter((p) => Number.isFinite(p?.x) && Number.isFinite(p?.y));
      const rest = out.manual_trace_hints.filter((h) => h.pcb_port_selector !== selector);
      if (route.length > 0) {
        rest.push({
          pcb_port_selector: selector,
          offsets: route.map((p) => ({
            x: round3(p.x),
            y: round3(p.y),
            ...(p.via ? { via: true } : {}),
          })),
        });
      }
      out.manual_trace_hints = rest;
    }
  }
  return out;
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
  return {
    pcb_routes:
      !traceActive
        ? edits.pcb_routes
        : name === null
          ? []
          : edits.pcb_routes.filter((r) => !r.connection.includes(`.${name} >`)),
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
