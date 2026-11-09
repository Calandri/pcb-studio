/**
 * What the schematic does when you point at it: selection, highlight, hover
 * cards, search, zoom. Pure functions over the model, so they are tested
 * without a browser and the canvas only wires them to the mouse.
 *
 * WHY HIT-TESTING HERE AND NOT ON THE SVG NODES. Pins are a point at the end
 * of a stub, a wire is a 1 px line: catching them with pointer events on the
 * drawing means sub-pixel targets. Testing the pointer against the geometry,
 * with a tolerance in screen pixels, makes them as easy to hit as a part, and
 * keeps the drawing (SchematicSheet) free of interaction.
 *
 * A net touching a part is lit everywhere, far pins and labels included,
 * EXCEPT the rails: on the HTL-401 GND has 137 pins and P3V3 26, lighting them
 * would light the whole sheet and hide what the part is really tied to. A rail
 * is lit only near the part (its pins, the wires and symbols on them); clicking
 * the rail itself, or one of its pins, lights it all.
 */

import type { SchNode, SchematicModel } from "./schematic-model";
import { textBox, type Box, type Pt } from "./schematic-shapes";

export type { Box, Pt } from "./schematic-shapes";

/** a net with more pins than this is a rail: lit only next to the selected part */
export const RAIL_PINS = 12;

/** the highlight color: not green, which on this sheet already means power */
export const HIGHLIGHT_COLOR = "#FFB938";
/** what is not part of the selection fades to this */
export const HIGHLIGHT_FADE = 0.14;

export type SchTarget =
  | { kind: "node"; id: string }
  | { kind: "port"; nodeId: string; selector: string }
  | { kind: "net"; net: string };

/**
 * What to draw lit. Nets are lit everywhere; `keys` are single elements
 * (wireKey, labelKey, junctionKey) lit on their own: the bit of a rail next to
 * the selected part.
 */
export interface SheetHighlight {
  nets: Set<string>;
  keys: Set<string>;
  /** components drawn at full strength */
  nodes: Set<string>;
  /** components outlined as the selection, with the area the outline wraps */
  focus: Map<string, Box>;
  /** pins ringed */
  ports: Set<string>;
}

export const wireKey = (id: string): string => `w:${id}`;
export const labelKey = (i: number): string => `l:${i}`;
export const junctionKey = (i: number): string => `j:${i}`;

/** is the element lit, by its net or by its own key */
export function isLit(h: SheetHighlight, net: string | null, key?: string): boolean {
  return (net !== null && h.nets.has(net)) || (key !== undefined && h.keys.has(key));
}

interface IndexedPort {
  node: SchNode;
  selector: string;
  x: number;
  y: number;
}

export interface SchIndex {
  nodeById: Map<string, SchNode>;
  nodeByName: Map<string, SchNode>;
  portsByNet: Map<string, IndexedPort[]>;
  wiresByNet: Map<string, string[]>;
  labelsByNet: Map<string, number[]>;
  junctionsByNet: Map<string, number[]>;
  segments: Map<string, Array<[Pt, Pt]>>;
  ground: Set<string>;
  /** pin number by selector: the model keeps the pin name, the number is in the Circuit JSON */
  pinNumbers: Map<string, string>;
  /** pins by position, to find who sits at the other end of a wire */
  portsAt: Map<string, IndexedPort[]>;
  /** what each part covers with its texts: designator and value sit outside the frame */
  extent: Map<string, Box>;
}

const at = (p: Pt): string => `${Math.round(p.x * 1000)},${Math.round(p.y * 1000)}`;

/**
 * The segments of a wire path. Absolute and relative M, L, H, V: what a
 * schematic wire is made of. Curves don't appear on a schematic.
 */
export function pathSegments(d: string): Array<[Pt, Pt]> {
  const out: Array<[Pt, Pt]> = [];
  const tokens = d.match(/[MLHVZmlhvz]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? [];
  let cmd = "";
  let cur: Pt = { x: 0, y: 0 };
  let start: Pt = cur;
  let i = 0;
  const next = () => Number(tokens[i++]);
  while (i < tokens.length) {
    const t = tokens[i];
    if (/^[A-Za-z]$/.test(t)) {
      cmd = t;
      i++;
      if (cmd === "Z" || cmd === "z") {
        out.push([cur, start]);
        cur = start;
      }
      continue;
    }
    const rel = cmd === cmd.toLowerCase();
    let to: Pt;
    switch (cmd.toUpperCase()) {
      case "M": {
        const x = next();
        const y = next();
        cur = rel ? { x: cur.x + x, y: cur.y + y } : { x, y };
        start = cur;
        // further pairs after an M are line-tos, as in SVG
        cmd = rel ? "l" : "L";
        continue;
      }
      case "L": {
        const x = next();
        const y = next();
        to = rel ? { x: cur.x + x, y: cur.y + y } : { x, y };
        break;
      }
      case "H": {
        const x = next();
        to = { x: rel ? cur.x + x : x, y: cur.y };
        break;
      }
      case "V": {
        const y = next();
        to = { x: cur.x, y: rel ? cur.y + y : y };
        break;
      }
      default:
        i++;
        continue;
    }
    if (Number.isFinite(to.x) && Number.isFinite(to.y)) out.push([cur, to]);
    cur = to;
  }
  return out;
}

const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
};

export function buildIndex(model: SchematicModel, circuitJson?: unknown[] | null): SchIndex {
  const idx: SchIndex = {
    nodeById: new Map(),
    nodeByName: new Map(),
    portsByNet: new Map(),
    wiresByNet: new Map(),
    labelsByNet: new Map(),
    junctionsByNet: new Map(),
    segments: new Map(),
    ground: new Set(model.nets.filter((n) => n.ground).map((n) => n.name)),
    pinNumbers: new Map(),
    portsAt: new Map(),
    extent: new Map(),
  };
  // schematic_port carries the number; the model's port is the same point
  // with y flipped, on the same component
  const numberAt = new Map<string, string>();
  for (const e of (circuitJson ?? []) as Array<Record<string, unknown>>) {
    if (e?.type !== "schematic_port" || e.pin_number === undefined || e.pin_number === null) continue;
    const c = e.center as { x?: unknown; y?: unknown } | undefined;
    if (typeof c?.x !== "number" || typeof c?.y !== "number") continue;
    numberAt.set(`${String(e.schematic_component_id)}|${c.x.toFixed(3)},${(-c.y).toFixed(3)}`, String(e.pin_number));
  }
  for (const node of model.nodes) {
    let ext: Box = { ...node.bbox };
    for (const l of node.labels) {
      const b = textBox(l);
      ext = { minX: Math.min(ext.minX, b.minX), minY: Math.min(ext.minY, b.minY), maxX: Math.max(ext.maxX, b.maxX), maxY: Math.max(ext.maxY, b.maxY) };
    }
    idx.extent.set(node.id, ext);
    idx.nodeById.set(node.id, node);
    if (!idx.nodeByName.has(node.name)) idx.nodeByName.set(node.name, node);
    for (const p of node.ports) {
      const entry = { node, selector: p.selector, x: p.x, y: p.y };
      if (p.net) push(idx.portsByNet, p.net, entry);
      push(idx.portsAt, at(p), entry);
      const n = numberAt.get(`${node.id}|${p.x.toFixed(3)},${p.y.toFixed(3)}`);
      if (n) idx.pinNumbers.set(p.selector, n);
    }
  }
  for (const w of model.wires) {
    idx.segments.set(w.id, pathSegments(w.d));
    if (w.net) push(idx.wiresByNet, w.net, w.id);
  }
  model.netLabels.forEach((l, i) => {
    if (!l.net) return;
    push(idx.labelsByNet, l.net, i);
    if (l.shape === "ground") idx.ground.add(l.net);
  });
  model.junctions.forEach((j, i) => {
    if (j.net) push(idx.junctionsByNet, j.net, i);
  });
  return idx;
}

/** pins on the net */
export const pinCount = (idx: SchIndex, net: string): number => idx.portsByNet.get(net)?.length ?? 0;

export const isRail = (idx: SchIndex, net: string): boolean =>
  idx.ground.has(net) || pinCount(idx, net) > RAIL_PINS;

const near = (a: Pt, b: Pt, eps = 0.02) => Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps;

export function highlightFor(
  model: SchematicModel,
  idx: SchIndex,
  target: SchTarget | null,
): SheetHighlight | null {
  if (!target) return null;
  const h: SheetHighlight = {
    nets: new Set(),
    keys: new Set(),
    nodes: new Set(),
    focus: new Map(),
    ports: new Set(),
  };
  const lightNet = (net: string) => {
    h.nets.add(net);
    for (const p of idx.portsByNet.get(net) ?? []) {
      h.ports.add(p.selector);
      h.nodes.add(p.node.id);
    }
  };

  if (target.kind === "net") {
    if (!idx.portsByNet.has(target.net) && !idx.wiresByNet.has(target.net) && !idx.labelsByNet.has(target.net)) {
      return null;
    }
    lightNet(target.net);
    return h;
  }

  const node = idx.nodeById.get(target.kind === "node" ? target.id : target.nodeId);
  if (!node) return null;
  h.nodes.add(node.id);

  if (target.kind === "port") {
    const port = node.ports.find((p) => p.selector === target.selector);
    if (!port) return null;
    h.ports.add(port.selector);
    // a pin asks for its net: all of it, a rail too
    if (port.net) lightNet(port.net);
    return h;
  }

  h.focus.set(node.id, idx.extent.get(node.id) ?? node.bbox);
  for (const port of node.ports) {
    if (!port.net) continue;
    if (!isRail(idx, port.net)) {
      lightNet(port.net);
      continue;
    }
    // a rail: only what sits on this part's pins, and the parts at the other
    // end of those wires stay readable (the decoupling cap on the supply pin)
    const here: Pt = { x: port.x, y: port.y };
    for (const id of idx.wiresByNet.get(port.net) ?? []) {
      const segs = idx.segments.get(id) ?? [];
      if (!segs.some(([a, b]) => near(a, here) || near(b, here))) continue;
      h.keys.add(wireKey(id));
      for (const [a, b] of segs) {
        for (const end of [a, b]) for (const other of idx.portsAt.get(at(end)) ?? []) h.nodes.add(other.node.id);
      }
    }
    for (const i of idx.labelsByNet.get(port.net) ?? []) {
      const l = model.netLabels[i];
      if (near(l.attach, here) || (l.port && near(l.port, here))) h.keys.add(labelKey(i));
    }
    for (const i of idx.junctionsByNet.get(port.net) ?? []) {
      if (near(model.junctions[i], here)) h.keys.add(junctionKey(i));
    }
  }
  return h;
}

// ------------------------------------------------------------- geometry

const grow = (b: Box | null, x0: number, y0: number, x1 = x0, y1 = y0): Box =>
  b
    ? { minX: Math.min(b.minX, x0), minY: Math.min(b.minY, y0), maxX: Math.max(b.maxX, x1), maxY: Math.max(b.maxY, y1) }
    : { minX: x0, minY: y0, maxX: x1, maxY: y1 };

/** the area a target covers on the sheet: what a zoom on it frames */
export function targetBox(model: SchematicModel, idx: SchIndex, target: SchTarget): Box | null {
  if (target.kind === "net") {
    let b: Box | null = null;
    for (const p of idx.portsByNet.get(target.net) ?? []) b = grow(b, p.x, p.y);
    for (const id of idx.wiresByNet.get(target.net) ?? []) {
      for (const [a, c] of idx.segments.get(id) ?? []) b = grow(grow(b, a.x, a.y), c.x, c.y);
    }
    for (const i of idx.labelsByNet.get(target.net) ?? []) {
      const l = model.netLabels[i].box;
      b = grow(b, l.minX, l.minY, l.maxX, l.maxY);
    }
    return b;
  }
  const id = target.kind === "node" ? target.id : target.nodeId;
  const box = idx.extent.get(id);
  return box ? { ...box } : null;
}

export interface View {
  x: number;
  y: number;
  k: number;
}

/**
 * The view that frames a box. A part alone would fill the screen: the zoom
 * stops at `maxK`, where its texts read at their natural size, and `pad`
 * keeps some of what is around it in view, so you know where you are.
 */
export function viewForBox(
  box: Box,
  size: { w: number; h: number },
  { pad = 1, margin = 48, minK = 4, maxK = 140 }: { pad?: number; margin?: number; minK?: number; maxK?: number } = {},
): View {
  const w = Math.max(box.maxX - box.minX + pad * 2, 0.001);
  const h = Math.max(box.maxY - box.minY + pad * 2, 0.001);
  const fit = Math.min((size.w - margin * 2) / w, (size.h - margin * 2) / h);
  const k = Math.min(maxK, Math.max(minK, fit));
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;
  return { x: size.w / 2 - cx * k, y: size.h / 2 - cy * k, k };
}

// ------------------------------------------------------------ hit test

const inBox = (p: Pt, b: Box, pad = 0) =>
  p.x >= b.minX - pad && p.x <= b.maxX + pad && p.y >= b.minY - pad && p.y <= b.maxY + pad;

function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * What is under the pointer, in sheet coordinates. `k` is the zoom (pixels
 * per unit): the tolerances are in pixels, so a pin is as easy to hit zoomed
 * out as zoomed in. `offsets` are the drag previews, the parts are drawn there.
 *
 * Order: inside an IC body it is the IC (its pins are at the end of the
 * stubs, outside); then a pin, a label, a wire, and last the part's frame.
 */
export function hitTest(
  model: SchematicModel,
  idx: SchIndex,
  pt: Pt,
  k: number,
  offsets: Record<string, { dx: number; dy: number }> = {},
): SchTarget | null {
  const local = (n: SchNode): Pt => {
    const o = offsets[n.id];
    return o ? { x: pt.x - o.dx, y: pt.y - o.dy } : pt;
  };
  for (const n of model.nodes) {
    if (!n.box) continue;
    const p = local(n);
    if (p.x >= n.box.x && p.x <= n.box.x + n.box.w && p.y >= n.box.y && p.y <= n.box.y + n.box.h) {
      return { kind: "node", id: n.id };
    }
  }

  const pinTol = Math.min(8 / k, 0.1);
  let bestPort: { node: SchNode; selector: string; d: number } | null = null;
  for (const n of model.nodes) {
    const p = local(n);
    if (!inBox(p, n.bbox, pinTol)) continue;
    for (const port of n.ports) {
      const d = Math.hypot(port.x - p.x, port.y - p.y);
      if (d <= pinTol && (!bestPort || d < bestPort.d)) bestPort = { node: n, selector: port.selector, d };
    }
  }
  if (bestPort) return { kind: "port", nodeId: bestPort.node.id, selector: bestPort.selector };

  const labelPad = 2 / k;
  for (const l of model.netLabels) {
    if (l.net && inBox(pt, l.box, labelPad)) return { kind: "net", net: l.net };
  }

  const wireTol = 5 / k;
  let bestWire: { net: string; d: number } | null = null;
  for (const w of model.wires) {
    if (!w.net) continue;
    for (const [a, b] of idx.segments.get(w.id) ?? []) {
      const d = distToSegment(pt, a, b);
      if (d <= wireTol && (!bestWire || d < bestWire.d)) bestWire = { net: w.net, d };
    }
  }
  if (bestWire) return { kind: "net", net: bestWire.net };

  let bestNode: { node: SchNode; area: number } | null = null;
  for (const n of model.nodes) {
    // the frame with its texts: clicking the designator picks the part
    const b = idx.extent.get(n.id) ?? n.bbox;
    if (!inBox(local(n), b, 0.05)) continue;
    const area = (b.maxX - b.minX) * (b.maxY - b.minY);
    // nested frames: the smallest is the one being pointed at
    if (!bestNode || area < bestNode.area) bestNode = { node: n, area };
  }
  return bestNode ? { kind: "node", id: bestNode.node.id } : null;
}

export const sameTarget = (a: SchTarget | null, b: SchTarget | null): boolean => {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === "node" && b.kind === "node") return a.id === b.id;
  if (a.kind === "port" && b.kind === "port") return a.selector === b.selector && a.nodeId === b.nodeId;
  return a.kind === "net" && b.kind === "net" && a.net === b.net;
};

// ------------------------------------------------------- what it is

/**
 * The comment written for a part in the project's schematico.json, when the
 * model carries it. Read defensively: the field is filled by the drawing
 * side, and a part without it is the normal case.
 */
export function nodeComment(node: SchNode): string | null {
  const raw = (node as SchNode & { comment?: unknown }).comment;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

/** ".U3 > .REFP" -> "REFP" */
const pinOfSelector = (selector: string): string => selector.split("> .").pop() ?? selector;

/** the number written next to the pin: from the Circuit JSON, or from a ".pinN" selector */
function pinNumber(idx: SchIndex, selector: string): string | null {
  const known = idx.pinNumbers.get(selector);
  if (known) return known;
  const m = /^pin(\d+)$/.exec(pinOfSelector(selector));
  return m ? m[1] : null;
}

export interface NetSummary {
  name: string;
  pins: number;
  rail: boolean;
}

export interface TargetInfo {
  /** pezzo, piedino, rete */
  kind: "pezzo" | "piedino" | "rete";
  title: string;
  lines: string[];
  /** nets of a part, signals first: in the selection card they can be clicked */
  nets: NetSummary[];
  /** the net of a pin, the one to jump to */
  net: string | null;
  /** parts on the net, for a net or a pin */
  parts: string[];
}

const natural = (a: string, b: string) => a.localeCompare(b, "it", { numeric: true });

const partsOn = (idx: SchIndex, net: string): string[] =>
  [...new Set((idx.portsByNet.get(net) ?? []).map((p) => p.node.name))].sort(natural);

function netLine(idx: SchIndex, net: string): string {
  const n = pinCount(idx, net);
  return `${net} · ${n} ${n === 1 ? "piedino" : "piedini"}`;
}

export function describeTarget(model: SchematicModel, idx: SchIndex, target: SchTarget): TargetInfo | null {
  if (target.kind === "net") {
    const pins = idx.portsByNet.get(target.net) ?? [];
    const parts = new Set(pins.map((p) => p.node.id)).size;
    const meta = model.nets.find((n) => n.name === target.net);
    const lines = [
      `${pins.length} ${pins.length === 1 ? "piedino collegato" : "piedini collegati"} su ${parts} ${parts === 1 ? "pezzo" : "pezzi"}`,
    ];
    if (idx.ground.has(target.net) || meta?.ground) lines.push("massa");
    else if (meta?.power) lines.push("alimentazione");
    return { kind: "rete", title: target.net, lines, nets: [], net: target.net, parts: partsOn(idx, target.net) };
  }
  const node = idx.nodeById.get(target.kind === "node" ? target.id : target.nodeId);
  if (!node) return null;

  if (target.kind === "port") {
    const port = node.ports.find((p) => p.selector === target.selector);
    if (!port) return null;
    const name = port.label ?? pinOfSelector(port.selector);
    const number = pinNumber(idx, port.selector);
    const named = name !== number && !/^pin\d+$/.test(name);
    const lines = [named ? `nome ${name}` : "senza nome"];
    lines.push(port.net ? `rete ${netLine(idx, port.net)}` : "scollegato");
    const title = number ? `${node.name} · piedino ${number}` : `${node.name} · ${name}`;
    const parts = port.net ? partsOn(idx, port.net).filter((n) => n !== node.name) : [];
    return { kind: "piedino", title, lines, nets: [], net: port.net, parts };
  }

  const lines: string[] = [];
  if (node.value) lines.push(node.value);
  if (node.part && node.part !== node.value) lines.push(node.part);
  const comment = nodeComment(node);
  if (comment) lines.push(comment);
  const nets = new Map<string, NetSummary>();
  for (const p of node.ports) {
    if (p.net && !nets.has(p.net)) nets.set(p.net, { name: p.net, pins: pinCount(idx, p.net), rail: isRail(idx, p.net) });
  }
  const list = [...nets.values()].sort((a, b) => Number(a.rail) - Number(b.rail) || natural(a.name, b.name));
  lines.push(
    `${node.ports.length} ${node.ports.length === 1 ? "piedino" : "piedini"} · ${list.length} ${list.length === 1 ? "rete" : "reti"}`,
  );
  if (node.section) lines.push(`sezione ${node.section}`);
  return { kind: "pezzo", title: node.name, lines, nets: list, net: null, parts: [] };
}

// --------------------------------------------------------------- search

export const MAX_QUERY = 64;

export interface SearchResult {
  target: SchTarget;
  kind: "pezzo" | "rete";
  label: string;
  detail: string;
  box: Box;
}

/**
 * Parts by designator, value, part number or comment; nets by name. Plain
 * substring matching on lowercased text: the query never becomes a regular
 * expression, so nothing typed can change what the search does.
 */
export function searchSchematic(
  model: SchematicModel,
  idx: SchIndex,
  query: string,
  limit = 50,
): SearchResult[] {
  const q = query.trim().slice(0, MAX_QUERY).toLowerCase();
  if (!q) return [];
  const scored: Array<{ score: number; result: SearchResult }> = [];
  const rank = (text: string | null | undefined, base: number): number | null => {
    if (!text) return null;
    const t = text.toLowerCase();
    if (t === q) return base;
    if (t.startsWith(q)) return base + 1;
    if (t.includes(q)) return base + 2;
    return null;
  };
  for (const node of model.nodes) {
    const comment = nodeComment(node);
    // designator, then net name, then value or part number, at each level
    // (exact, start, inside); a comment only after everything else
    const scores = [
      rank(node.name, 0),
      rank(node.value, 0.7),
      rank(node.part, 0.7),
      comment?.toLowerCase().includes(q) ? 4 : null,
    ].filter((s): s is number => s !== null);
    if (scores.length === 0) continue;
    scored.push({
      score: Math.min(...scores),
      result: {
        target: { kind: "node", id: node.id },
        kind: "pezzo",
        label: node.name,
        detail: [node.value, node.part !== node.value ? node.part : null].filter(Boolean).join(" · ") || (comment ?? ""),
        box: { ...(idx.extent.get(node.id) ?? node.bbox) },
      },
    });
  }
  const nets = new Set<string>([...idx.portsByNet.keys(), ...idx.labelsByNet.keys()]);
  for (const net of nets) {
    const s = rank(net, 0.5);
    if (s === null) continue;
    const box = targetBox(model, idx, { kind: "net", net });
    if (!box) continue;
    scored.push({
      score: s,
      result: { target: { kind: "net", net }, kind: "rete", label: net, detail: netLine(idx, net).split(" · ")[1], box },
    });
  }
  scored.sort((a, b) => a.score - b.score || natural(a.result.label, b.result.label));
  return scored.slice(0, limit).map((s) => s.result);
}

// ------------------------------------------------------------- sections

export interface SectionEntry {
  title: string;
  box: Box;
}

/** the section panels, top to bottom and left to right, as you read a sheet */
export function sectionList(model: SchematicModel): SectionEntry[] {
  return model.sectionFrames
    .map((f, i) => ({
      title: f.title?.trim() || model.sectionTitles[i]?.text || `Sezione ${i + 1}`,
      box: { minX: f.x, minY: f.y, maxX: f.x + f.w, maxY: f.y + f.h },
    }))
    .sort((a, b) => Math.round(a.box.minY * 2) - Math.round(b.box.minY * 2) || a.box.minX - b.box.minX);
}

// ---------------------------------------------------- selection in the URL

/**
 * The selection travels in the URL as text: "U3" (a part), "U3.REFP" (a pin),
 * "VREF" (a net), "net:VREF" when a part has the same name as the net. Anything
 * that is not a plain designator or net name is dropped, and a name that is
 * not on the sheet is ignored: the URL is input from whoever sent the link.
 */
const SEL_SHAPE = /^[A-Za-z0-9_.+\-~/#:]{1,96}$/;

export function cleanSel(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  return SEL_SHAPE.test(s) ? s : null;
}

export function targetKey(idx: SchIndex, target: SchTarget): string | null {
  if (target.kind === "net") return idx.nodeByName.has(target.net) ? `net:${target.net}` : target.net;
  const node = idx.nodeById.get(target.kind === "node" ? target.id : target.nodeId);
  if (!node) return null;
  return target.kind === "node" ? node.name : `${node.name}.${pinOfSelector(target.selector)}`;
}

export function resolveKey(idx: SchIndex, raw: unknown): SchTarget | null {
  const key = cleanSel(raw);
  if (!key) return null;
  const node = idx.nodeByName.get(key);
  if (node) return { kind: "node", id: node.id };
  const net = key.startsWith("net:") ? key.slice(4) : key;
  if (idx.portsByNet.has(net) || idx.labelsByNet.has(net) || idx.wiresByNet.has(net)) return { kind: "net", net };
  const dot = key.lastIndexOf(".");
  if (dot > 0) {
    const owner = idx.nodeByName.get(key.slice(0, dot));
    const pin = key.slice(dot + 1);
    const port = owner?.ports.find((p) => pinOfSelector(p.selector) === pin);
    if (owner && port) return { kind: "port", nodeId: owner.id, selector: port.selector };
  }
  return null;
}

/**
 * The part a selection key is about, among the names that exist on the board:
 * the bridge to the PCB view, which picks parts and knows nothing of nets.
 */
export function componentOfKey(key: string | null, names: ReadonlySet<string>): string | null {
  if (!key) return null;
  if (names.has(key)) return key;
  const dot = key.lastIndexOf(".");
  if (dot > 0 && names.has(key.slice(0, dot))) return key.slice(0, dot);
  return null;
}
