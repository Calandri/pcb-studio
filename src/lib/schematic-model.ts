/**
 * From Circuit JSON to the schematic drawing.
 *
 * WHY NOT THE TSCIRCUIT VIEWER. The tscircuit viewer just draws: the colors
 * are its own, the symbols are its own, and above all you cannot build an
 * editor on top of it (no multi-selection, no grid snapping, no net
 * highlighting). Here the geometric model is extracted and drawn with PCB
 * Studio's visual language, so the interaction is ours.
 *
 * Coordinate system: the schematic has Y pointing up, SVG points down. The
 * flip happens ONCE here (y_svg = -y_sch): from here on everything is already
 * in SVG coordinates and nobody has to remember it again. Whoever needs to go
 * back (the editor, when saving a move) uses toSchematicY.
 *
 * The shapes tscircuit does not draw for us (IC bodies with their pins, net
 * label flags, power symbols) are in schematic-shapes.ts.
 */

import { symbols } from "schematic-symbols";
import {
  SCH_TEXT,
  boxOf,
  chipArt,
  commentLabel,
  fit,
  netLabelArt,
  overlaps,
  pinCaption,
  r,
  sideOf,
  textBox,
  textWidth,
  type Box,
  type NetLabelShape,
  type PinSide,
  type Pt,
  type SchLabel,
} from "./schematic-shapes";
import { schematicNotesOf, type SchematicNotes } from "./schematic-notes";
import {
  distToSegment,
  findJunctions,
  pieceSize,
  sideAlong,
  wireAsLabels,
  wireEnds,
  wireLength,
  type WireReason,
} from "./schematic-wires";

export type { Pt, SchLabel } from "./schematic-shapes";

export const toSchematicY = (svgY: number): number => -svgY;

export interface SchPort {
  x: number;
  y: number;
  net: string | null;
  power: boolean;
  /** pin caption, if the component has one (VCC, SDA, anode...) */
  label: string | null;
  /** tscircuit selector, e.g. ".R1 > .pin1": what goes inside a trace */
  selector: string;
  /** true if a wire already reaches the pin */
  connected: boolean;
}

export interface SchNode {
  id: string;
  name: string;
  /** manufacturer's part number, when available (LP5907MFX, SHT40...) */
  part: string | null;
  /** human-readable value: 100nF, 4k7, green */
  value: string | null;
  kind: "box" | "symbol";
  center: Pt;
  /** only for kind=box */
  box: { x: number; y: number; w: number; h: number } | null;
  /** symbol strokes, or the pin lines and contact marks of a box */
  paths: Array<{ d: string; filled: boolean }>;
  labels: SchLabel[];
  ports: SchPort[];
  section: string | null;
  /** the whole comment from schematico.json "commenti" (the sheet may show it cut) */
  comment?: string;
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
}

export interface SchWire {
  id: string;
  d: string;
  net: string | null;
  /** power rail or ground: each class has its color on the sheet */
  power: boolean;
  /** ground (a subset of power): drawn apart from the positive rails */
  ground: boolean;
  /** declared connection that produced the wire, e.g. ".J1 > .VBAT to .D1 > .cathode" */
  declaredAs: string | null;
}

export interface SchJunction extends Pt {
  net: string | null;
  power: boolean;
  ground: boolean;
  /** true = node between multiple wires, false = attachment to a pin */
  isNode: boolean;
}

export interface SchNetLabelDrawn {
  /** what is written: the name from schematico.json "reti" when there is one */
  text: string;
  /** the net as in the Circuit JSON: highlighting and connectivity use this */
  net: string | null;
  power: boolean;
  ground: boolean;
  /**
   * drawn by us in place of a wire too long to follow (or one leaving its
   * section): the connectivity is the wire's, only the drawing changed
   */
  forWire?: string;
  /** flag with the name, ground bars, or rail bar */
  shape: NetLabelShape;
  /** outline of the flag or strokes of the power symbol */
  outline: string;
  /** the flag is filled; a power symbol is strokes only */
  closed: boolean;
  /** where the text goes (SVG baseline anchor) */
  textAt: Pick<SchLabel, "x" | "y" | "anchor" | "size" | "vertical">;
  /** point the label attaches to: a pin end or a wire end */
  attach: Pt;
  /** area covered, for overlaps and sheet bounds */
  box: Box;
  /**
   * pin the label belongs to when it does NOT touch it (tscircuit left it
   * loose): the sheet draws a dashed line from here to the label
   */
  port?: Pt;
  /**
   * declared connections passing through the label's pin, e.g.
   * ".U3 > .DATA to .U1 > .PDM_D0": needed to remove them from main.tsx —
   * label-only connections have no wire to click, you click the label
   */
  declaredAs?: string[];
}

export interface SchSectionFrame {
  x: number;
  y: number;
  w: number;
  h: number;
  /** displayName of the <schematicsection>, or titolo from schematico.json */
  title: string | null;
  /** key of the section in schematico.json */
  name?: string;
  /** designators of the parts inside, for a section from schematico.json */
  pieces?: string[];
  /** sections whose frame overlaps this one */
  overlaps?: string[];
  /**
   * the larger of two overlapping frames: drawn dashed and unfilled, under
   * the smaller one, so a section scattered across the sheet does not hide
   * the compact ones inside it
   */
  dashed?: boolean;
}

/** a schematic_trace drawn as net labels at its ends instead of a wire */
export interface SchLabeledWire {
  id: string;
  net: string | null;
  /** lunghezza = too long for a signal, alimentazione = a rail, sezione = leaves its section */
  reason: WireReason;
  length: number;
}

export interface SchematicModel {
  nodes: SchNode[];
  wires: SchWire[];
  junctions: SchJunction[];
  netLabels: SchNetLabelDrawn[];
  /** divider lines between functional sections (only when there are no frames) */
  dividers: Array<{ x1: number; y1: number; x2: number; y2: number }>;
  /** section titles (anchor start unless said otherwise) */
  sectionTitles: Array<{ x: number; y: number; text: string; anchor?: "start" | "end" }>;
  /** one frame around every functional section */
  sectionFrames: SchSectionFrame[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  /** nets present on the sheet, for the right column and for highlighting */
  nets: Array<{ name: string; power: boolean; ground: boolean; nodes: number; label?: string }>;
  /** wires replaced by net labels at their ends (drawing only) */
  labeledWires: SchLabeledWire[];
  /** pairs of sections from schematico.json whose frames overlap */
  sectionOverlaps: Array<[string, string]>;
  /** net name in the Circuit JSON -> name shown, from schematico.json "reti" */
  netLabelNames: Record<string, string>;
  /** what schematico.json had wrong, said on the sheet instead of breaking it */
  noteWarnings: string[];
}

type El = Record<string, unknown>;

/** families whose canonical selectors are .name > .pinN, never the caption */
const PASSIVE_PIN_NUMBER = new Set(["simple_resistor", "simple_capacitor", "simple_inductor"]);

/** families drawn as a connector: a body with contacts */
const CONNECTOR_FTYPES = new Set(["simple_pin_header", "simple_connector"]);
/** J1, CN3: the designator of a connector, by convention (IEEE 315) */
const CONNECTOR_REFDES = /^(J|CN)\d+$/i;

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

function byType(circuitJson: unknown[], type: string): El[] {
  return (circuitJson as El[]).filter((e) => e?.type === type);
}

/**
 * Human-readable value of the component. Each family exposes its own field:
 * reading only one leaves half the BOM without a value.
 */
function displayValue(src: El): string | null {
  return (
    str(src.display_value) ??
    str(src.display_capacitance) ??
    str(src.display_resistance) ??
    str(src.display_inductance) ??
    str(src.color) ??
    null
  );
}

/*
 * Names that give away a rail: either they start like a power supply (GND,
 * VCC, VBAT...) or they contain a voltage (MIC_3V3, P3V3_SD, VDD_1V8). The
 * second case is needed because derived rails take their name from the load,
 * not from the voltage: without it MIC_3V3 would be drawn like any signal.
 */
const POWER_HINT = /^(gnd|agnd|dgnd|vss|vcc|vdd|vbat|vbus|vusb|vsys|vin|vio|vref|vcore|v\+|\+?\d?v\d|p\d ?v?\d)|(^|_)\+?\d+v\d*($|_)/i;
const GROUND_HINT = /^(gnd|agnd|dgnd|pgnd|vss|ground)|(^|_)gnd($|_)/i;

/**
 * Transformation from the symbol's system to the sheet's system.
 *
 * It is derived from TWO points known in both systems (two pins): two points
 * fix the rotation, scale and translation of a similarity, which is exactly
 * what tscircuit applies to symbols. With a single pin only the translation
 * remains, with none the component center.
 */
function symbolTransform(
  symbolPorts: Array<{ x: number; y: number }>,
  sheetPorts: Array<{ x: number; y: number }>,
  fallbackCenter: Pt,
  symbolCenter: Pt,
): (p: Pt) => Pt {
  if (symbolPorts.length >= 2 && sheetPorts.length >= 2) {
    const [s0, s1] = symbolPorts;
    const [p0, p1] = sheetPorts;
    const dsx = s1.x - s0.x;
    const dsy = s1.y - s0.y;
    const den = dsx * dsx + dsy * dsy;
    if (den > 1e-12) {
      const dpx = p1.x - p0.x;
      const dpy = p1.y - p0.y;
      // (dp / ds) as a complex number: rotation + scale in one shot
      const ar = (dpx * dsx + dpy * dsy) / den;
      const ai = (dpy * dsx - dpx * dsy) / den;
      return (p) => {
        const rx = p.x - s0.x;
        const ry = p.y - s0.y;
        return { x: p0.x + ar * rx - ai * ry, y: p0.y + ai * rx + ar * ry };
      };
    }
  }
  if (symbolPorts.length >= 1 && sheetPorts.length >= 1) {
    const dx = sheetPorts[0].x - symbolPorts[0].x;
    const dy = sheetPorts[0].y - symbolPorts[0].y;
    return (p) => ({ x: p.x + dx, y: p.y + dy });
  }
  const dx = fallbackCenter.x - symbolCenter.x;
  const dy = fallbackCenter.y - symbolCenter.y;
  return (p) => ({ x: p.x + dx, y: p.y + dy });
}

interface SymbolPrimitive {
  type: string;
  points?: Array<{ x: number; y: number }>;
  fill?: boolean;
  closed?: boolean;
  text?: string;
  x?: number;
  y?: number;
  anchor?: string;
  radius?: number;
}

interface SymbolDef {
  primitives: SymbolPrimitive[];
  center: { x: number; y: number };
  ports: Array<{ x: number; y: number; labels: string[] }>;
}

const symbolRegistry = symbols as unknown as Record<string, SymbolDef | undefined>;

/**
 * Symbol text anchors ("middle_bottom", "top_left", "middle_right") name the
 * point of the TEXT that sits on the given position. Both halves matter:
 * reading only the horizontal one put every "bottom" designator with its
 * baseline on the lead and every "top" value on top of the body.
 */
function symbolTextPlacement(
  anchor: string | undefined,
  size: number,
): { anchor: "start" | "middle" | "end"; dx: number; dy: number } {
  const a = anchor ?? "middle_left";
  const h = a.includes("left") ? "start" : a.includes("right") ? "end" : "middle";
  const dy = a.includes("bottom") ? -0.02 : a.includes("top") ? size * 0.75 + 0.02 : size * 0.35;
  const dx = h === "start" ? 0.04 : h === "end" ? -0.04 : 0;
  return { anchor: h, dx, dy };
}

/** test point symbol whose lead ends on the given side of the part */
function testpointFor(port: Pt, center: Pt): string {
  const dx = port.x - center.x;
  const dy = port.y - center.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx <= 0 ? "testpoint_right" : "testpoint_left";
  // sheet y points down: a pin below the center is the up-facing symbol
  return dy > 0 ? "testpoint_up" : "testpoint_down";
}

/**
 * @param notes sections, comments and net names from schematico.json; by
 * default the ones riding along in the Circuit JSON (see withSchematicNotes)
 */
export function buildSchematicModel(
  circuitJson: unknown[] | null,
  notes: SchematicNotes | null = circuitJson ? schematicNotesOf(circuitJson) : null,
): SchematicModel {
  const empty: SchematicModel = {
    nodes: [],
    wires: [],
    junctions: [],
    netLabels: [],
    dividers: [],
    sectionTitles: [],
    sectionFrames: [],
    bounds: { minX: -1, minY: -1, maxX: 1, maxY: 1 },
    nets: [],
    labeledWires: [],
    sectionOverlaps: [],
    netLabelNames: {},
    noteWarnings: notes?.warnings ?? [],
  };
  if (!circuitJson || circuitJson.length === 0) return empty;
  const noteWarnings = [...(notes?.warnings ?? [])];
  /** section of each designator, from schematico.json */
  const noteSectionOf = new Map<string, string>();
  for (const s of notes?.sections ?? []) for (const p of s.pieces) noteSectionOf.set(p, s.name);
  /** the name written for a net: the readable one from the file, or its own */
  const shown = (net: string | null): string | null => (net ? (notes?.nets.get(net) ?? net) : null);

  const sourceComponents = new Map<string, El>();
  for (const e of byType(circuitJson, "source_component")) {
    sourceComponents.set(String(e.source_component_id), e);
  }

  // connectivity key -> real net. It is the only way to know whether a wire
  // is a power rail: on the traces there is only the key, the name is on the net
  const netByKey = new Map<string, { name: string; power: boolean; ground: boolean }>();
  for (const e of byType(circuitJson, "source_net")) {
    const key = str(e.subcircuit_connectivity_map_key);
    const name = str(e.name);
    if (!key || !name) continue;
    netByKey.set(key, {
      name,
      power: e.is_power === true || e.is_positive_voltage_source === true,
      ground: e.is_ground === true,
    });
  }
  // source_net_id -> connectivity key: the labels of named nets point to the
  // net by id, the traces by key, and without the bridge the two halves never meet
  const netIdToKey = new Map<string, string>();
  for (const e of byType(circuitJson, "source_net")) {
    const id = str(e.source_net_id);
    const key = str(e.subcircuit_connectivity_map_key);
    if (id && key) netIdToKey.set(id, key);
  }

  /*
   * Readable name for nets WITHOUT a source_net. With schTraceAutoLabelEnabled
   * tscircuit does not create the source_net but emits a schematic_net_label
   * that names the net after the pin ("U1_OSC32_IN"), attached to the same
   * connectivity key as the traces. Without this detour those pins stay
   * anonymous: hovering over an IC lit up only the named rails (P3V3, GND...)
   * and every signal looked disconnected.
   */
  const labelTextByKey = new Map<string, string>();
  for (const l of byType(circuitJson, "schematic_net_label")) {
    const key = str(l.source_net_id);
    const text = str(l.text);
    if (key && text && !labelTextByKey.has(key)) labelTextByKey.set(key, text);
  }

  // a net id arrives in two forms: connectivity key (traces, auto-labels) or
  // source_net_id (labels of named nets). Always normalize to the key.
  const keyOf = (id: unknown): string | null => {
    if (typeof id !== "string" || id.length === 0) return null;
    if (netByKey.has(id) || labelTextByKey.has(id)) return id;
    return netIdToKey.get(id) ?? null;
  };
  const nameOf = (id: unknown): string | null => {
    const key = keyOf(id);
    return key ? (netByKey.get(key)?.name ?? labelTextByKey.get(key) ?? null) : null;
  };
  const netOf = (key: unknown) => (typeof key === "string" ? netByKey.get(key) : undefined);
  /*
   * A net is a power net if the source declares it OR if the name says so.
   * The flag alone is not enough: tscircuit marks is_power only when the net
   * is declared as a voltage source, so a rail named P3V3 coming out of an
   * LDO stays a "signal" and would be drawn gray like a GPIO. On the sheet a
   * power rail must be recognizable at a glance.
   */
  const isPower = (key: unknown, fallbackText?: string | null): boolean => {
    const net = netOf(key);
    if (net?.power || net?.ground) return true;
    const name = net?.name ?? fallbackText;
    return name ? POWER_HINT.test(name) : false;
  };
  const isGround = (key: unknown, fallbackText?: string | null): boolean => {
    const net = netOf(key);
    if (net?.ground) return true;
    const name = net?.name ?? fallbackText;
    return name ? GROUND_HINT.test(name) : false;
  };

  // texts tscircuit attaches to library components: name and part number
  const textsByComponent = new Map<string, string[]>();
  for (const e of byType(circuitJson, "schematic_text")) {
    const compId = str(e.schematic_component_id);
    const text = str(e.text);
    if (!compId || !text) continue;
    const list = textsByComponent.get(compId) ?? [];
    list.push(text);
    textsByComponent.set(compId, list);
  }

  const portsByComponent = new Map<string, El[]>();
  for (const e of byType(circuitJson, "schematic_port")) {
    const compId = str(e.schematic_component_id);
    if (!compId) continue;
    const list = portsByComponent.get(compId) ?? [];
    list.push(e);
    portsByComponent.set(compId, list);
  }

  // net of each port, to light up the pins too when a net is highlighted
  const netByPort = new Map<string, string>();
  for (const t of byType(circuitJson, "source_trace")) {
    const key = str(t.subcircuit_connectivity_map_key);
    if (!key) continue;
    const ports = Array.isArray(t.connected_source_port_ids)
      ? (t.connected_source_port_ids as unknown[])
      : [];
    for (const p of ports) if (typeof p === "string") netByPort.set(p, key);
  }

  // connectivity key of every pin, by selector: the net labels need it to
  // find the <trace> elements to offer for removal
  const keyBySelector = new Map<string, string>();

  const nodes: SchNode[] = [];
  /** what each component occupies besides its texts, for the final overlap pass */
  const bodies = new Map<string, { body: Box | null; obstacles: Box[] }>();
  /** connectivity key of every pin: the labels drawn in place of a wire need it */
  const portKey = new Map<SchPort, string | null>();
  /** the comment of a part follows the text it is written under, if that one moves */
  const commentUnder = new Map<SchLabel, SchLabel>();
  for (const comp of byType(circuitJson, "schematic_component")) {
    const id = String(comp.schematic_component_id);
    const src = sourceComponents.get(String(comp.source_component_id));
    const name = (src && str(src.name)) ?? id;
    const ftype = String(src?.ftype ?? "");
    const centerSch = comp.center as Pt | undefined;
    const center: Pt = { x: num(centerSch?.x), y: -num(centerSch?.y) };
    const size = comp.size as { width?: number; height?: number } | undefined;
    const width = num(size?.width);
    const height = num(size?.height);

    const seenSelectors = new Set<string>();
    const sheetPorts = (portsByComponent.get(id) ?? [])
      .map((p) => {
        const c = p.center as Pt | undefined;
        const sourcePortId = str(p.source_port_id);
        const key = sourcePortId ? netByPort.get(sourcePortId) : undefined;
        const net = nameOf(key);
        const pin = String(p.pin_number ?? "");
        /*
         * The selector that will end up inside a <trace>. For chips and diodes
         * the caption is canonical (.U1 > .VCC, .D2 > .anode) and is preferred
         * over the number: it stays valid if the component is replaced with
         * another package. For passives instead tscircuit ALWAYS uses the
         * number (.R1 > .pin1): their display_pin_label says "anode"/"cathode"
         * but it is only a caption — writing it in a trace would produce a
         * connection the compiler cannot resolve (and it would not match the
         * display_name).
         */
        const label = str(p.display_pin_label);
        const passive = PASSIVE_PIN_NUMBER.has(ftype);
        const selector = `.${name} > .${passive ? `pin${pin}` : (label ?? `pin${pin}`)}`;
        if (key) keyBySelector.set(selector, key);
        return {
          x: num(c?.x),
          y: -num(c?.y),
          pin,
          label,
          side: String(p.side_of_component ?? ""),
          net,
          key: key ?? null,
          power: isPower(key, net),
          selector,
          connected: p.is_connected === true || Boolean(key),
        };
      })
      /*
       * The Circuit JSON can have two port elements for the SAME pin (it
       * happens on crystals): with the same selector the React key collides
       * and the console fills up with "duplicate key". It is the same logical
       * pin: keep one.
       */
      .filter((p) => {
        if (seenSelectors.has(p.selector)) return false;
        seenSelectors.add(p.selector);
        return true;
      });

    // manufacturer's part number: it is the component text that is NOT its name
    const extraTexts = (textsByComponent.get(id) ?? []).filter((t) => t !== name);
    const part =
      (src && str(src.manufacturer_part_number)) ??
      extraTexts.find((t) => t.length > 2) ??
      null;
    const value = src ? displayValue(src) : null;
    // the file's sections win: the generator writes them where tscircuit cannot
    const section = noteSectionOf.get(name) ?? (src ? str(src.sch_section_name) : null);
    const comment = notes?.comments.get(name) ?? null;

    /*
     * A part with a single pin and no pin name is a test point, a terminal or
     * a pad (the HTL-401 test points arrive as one-pin <chip>): a box with a
     * "1" inside means nothing on a schematic, the test point symbol does.
     */
    let symbolName = str(comp.symbol_name);
    let fromSinglePin = false;
    if (!symbolName && sheetPorts.length === 1 && !pinCaption(sheetPorts[0].label, sheetPorts[0].pin)) {
      symbolName = testpointFor(sheetPorts[0], center);
      fromSinglePin = true;
    }
    const symbol = symbolName ? symbolRegistry[symbolName] : undefined;
    const labels: SchLabel[] = [];
    const paths: Array<{ d: string; filled: boolean }> = [];
    const drawn: Pt[] = [];
    let box: SchNode["box"] = null;
    /** pin lines: texts must not cross them */
    const obstacles: Box[] = [];

    if (symbol) {
      // the symbol lives in its own system: anchor it to the sheet's real pins
      const matched: Array<{ s: Pt; p: Pt }> = [];
      for (const sp of symbol.ports) {
        const hit = sheetPorts.find(
          (shp) => sp.labels.includes(shp.pin) || (shp.label && sp.labels.includes(shp.label)),
        );
        if (hit) matched.push({ s: { x: sp.x, y: -sp.y }, p: { x: hit.x, y: hit.y } });
      }
      if (matched.length < 2 && symbol.ports.length === sheetPorts.length) {
        matched.length = 0;
        for (const [i, sp] of symbol.ports.entries()) {
          matched.push({ s: { x: sp.x, y: -sp.y }, p: sheetPorts[i] });
        }
      }
      const tf = symbolTransform(
        matched.map((m) => m.s),
        matched.map((m) => m.p),
        center,
        { x: symbol.center.x, y: -symbol.center.y },
      );

      for (const prim of symbol.primitives) {
        if (prim.type === "path" && Array.isArray(prim.points) && prim.points.length > 1) {
          const pts = prim.points.map((p) => tf({ x: p.x, y: -p.y }));
          drawn.push(...pts);
          const d =
            pts.map((p, i) => `${i === 0 ? "M" : "L"}${r(p.x)} ${r(p.y)}`).join(" ") +
            (prim.closed ? " Z" : "");
          paths.push({ d, filled: prim.fill === true });
        } else if (prim.type === "circle" && prim.radius) {
          const c = tf({ x: num(prim.x), y: -num(prim.y) });
          const rad = prim.radius;
          drawn.push({ x: c.x - rad, y: c.y - rad }, { x: c.x + rad, y: c.y + rad });
          paths.push({
            d: `M${r(c.x - rad)} ${r(c.y)}a${rad} ${rad} 0 1 0 ${rad * 2} 0a${rad} ${rad} 0 1 0 ${-rad * 2} 0`,
            filled: prim.fill === true,
          });
        } else if (prim.type === "box") {
          const c = tf({ x: num(prim.x), y: -num(prim.y) });
          const w = num((prim as { width?: number }).width);
          const h = num((prim as { height?: number }).height);
          drawn.push({ x: c.x - w / 2, y: c.y - h / 2 }, { x: c.x + w / 2, y: c.y + h / 2 });
          paths.push({
            d: `M${r(c.x - w / 2)} ${r(c.y - h / 2)}h${r(w)}v${r(h)}h${r(-w)}Z`,
            filled: prim.fill === true,
          });
        } else if (prim.type === "text" && prim.text) {
          const isRef = prim.text === "{REF}";
          // a diode or a transistor has no value: its part number is what
          // an engineer writes there (BAS40, MMBT2222)
          const text = isRef
            ? name
            : prim.text === "{VAL}"
              ? (value ?? part ?? "")
              : prim.text;
          if (!text) continue;
          const pos = tf({ x: num(prim.x), y: -num(prim.y) });
          const sizeT = isRef ? SCH_TEXT.symbolName : SCH_TEXT.symbolValue;
          const place = symbolTextPlacement(prim.anchor, sizeT);
          labels.push({
            x: pos.x + place.dx,
            y: pos.y + place.dy,
            text,
            anchor: place.anchor,
            size: sizeT,
            tone: isRef ? "name" : "value",
          });
        }
      }
      // symbol with no texts of its own: the name must be added anyway,
      // otherwise the sheet has anonymous shapes
      if (!labels.some((l) => l.tone === "name")) {
        const b = drawn.length > 0 ? boxOf(drawn) : { minX: center.x, minY: center.y, maxX: center.x, maxY: center.y };
        labels.push({
          x: (b.minX + b.maxX) / 2,
          y: b.minY - 0.06,
          text: name,
          anchor: "middle",
          size: SCH_TEXT.symbolName,
          tone: "name",
        });
        const below = value ?? part;
        if (below) {
          labels.push({
            x: (b.minX + b.maxX) / 2,
            y: b.maxY + 0.06 + SCH_TEXT.symbolValue * 0.75,
            text: below,
            anchor: "middle",
            size: SCH_TEXT.symbolValue,
            tone: "value",
          });
        }
      }
      if (comment) {
        // under the value, or under the designator when there is none
        const under = labels.find((l) => l.tone === "value") ?? labels.find((l) => l.tone === "name");
        if (under) {
          const b = textBox(under);
          const span = drawn.length > 0 ? boxOf(drawn).maxX - boxOf(drawn).minX : width;
          const note = commentLabel(comment, under.x, b.maxY + 0.02 + SCH_TEXT.comment * 0.75, Math.max(1.8, span + 0.6), under.anchor);
          labels.push(note);
          commentUnder.set(note, under);
        }
      }
    } else {
      box = {
        x: center.x - width / 2,
        y: center.y - height / 2,
        w: width,
        h: height,
      };
      const art = chipArt(
        box,
        sheetPorts.map((p) => ({
          x: p.x,
          y: p.y,
          side: (["left", "right", "top", "bottom"].includes(p.side) ? p.side : sideOf(p, box!)) as PinSide,
          number: p.pin,
          name: p.label,
        })),
        {
          name,
          subtitle: part ?? value,
          connector: CONNECTOR_FTYPES.has(ftype) || CONNECTOR_REFDES.test(name),
          comment,
        },
      );
      for (const d of art.stubs) paths.push({ d, filled: false });
      for (const [a, b] of art.segments) obstacles.push(boxOf([a, b]));
      for (const d of art.marks) paths.push({ d, filled: true });
      labels.push(...art.labels);
      const note = art.labels.find((l) => l.tone === "comment" && !l.fixed);
      const under = art.labels.find((l) => l.tone === "value") ?? art.labels.find((l) => l.tone === "name");
      if (note && under && !under.fixed) commentUnder.set(note, under);
    }

    const xs = [...sheetPorts.map((p) => p.x), ...drawn.map((p) => p.x)];
    const ys = [...sheetPorts.map((p) => p.y), ...drawn.map((p) => p.y)];
    if (box) {
      xs.push(box.x, box.x + box.w);
      ys.push(box.y, box.y + box.h);
    } else if (!fromSinglePin || drawn.length === 0) {
      // the symbol's own frame; a test point drawn in place of a one-pin
      // box keeps only what is drawn, or its grab area would be the old box
      xs.push(center.x - width / 2, center.x + width / 2, center.x);
      ys.push(center.y - height / 2, center.y + height / 2, center.y);
    }

    bodies.set(id, { body: drawn.length > 0 ? boxOf(drawn) : null, obstacles });
    const ports = sheetPorts.map((p) => {
      const port: SchPort = {
        x: p.x,
        y: p.y,
        net: p.net,
        power: p.power,
        label: p.label,
        selector: p.selector,
        connected: p.connected,
      };
      portKey.set(port, p.key);
      return port;
    });
    nodes.push({
      id,
      name,
      part,
      value,
      kind: symbol ? "symbol" : "box",
      center,
      box,
      paths,
      labels,
      ports,
      section,
      ...(comment ? { comment } : {}),
      bbox: {
        minX: Math.min(...xs),
        minY: Math.min(...ys),
        maxX: Math.max(...xs),
        maxY: Math.max(...ys),
      },
    });
  }

  // name of the declared connection, so it can be removed from the code when
  // the user clicks the wire: the drawn wire does not know which <trace> it
  // was born from, the source_trace does
  const declaredByTraceId = new Map<string, string>();
  // and per connectivity key: label-only connections have no wire, their
  // label must know which <trace> created them
  const declaredByKey = new Map<string, string[]>();
  for (const t of byType(circuitJson, "source_trace")) {
    const id = str(t.source_trace_id);
    const name = str(t.display_name);
    if (id && name) declaredByTraceId.set(id, name);
    const key = str(t.subcircuit_connectivity_map_key);
    if (key && name) {
      const list = declaredByKey.get(key) ?? [];
      list.push(name);
      declaredByKey.set(key, list);
    }
  }

  const flatPorts: Array<{ node: SchNode; port: SchPort }> = [];
  for (const n of nodes) for (const p of n.ports) flatPorts.push({ node: n, port: p });
  const TOUCH = 0.02;
  const portNear = (pt: Pt, net?: string | null) => {
    let best: (typeof flatPorts)[number] | null = null;
    let bestD = Infinity;
    for (const fp of flatPorts) {
      if (net !== undefined && fp.port.net !== net) continue;
      const d = Math.hypot(fp.port.x - pt.x, fp.port.y - pt.y);
      if (d < bestD) {
        bestD = d;
        best = fp;
      }
    }
    return best ? { ...best, d: bestD } : null;
  };
  const portByPoint = new Map<string, (typeof flatPorts)[number]>();
  for (const fp of flatPorts) portByPoint.set(`${r(fp.port.x)},${r(fp.port.y)}`, fp);
  const portAt = (p: Pt) => {
    const exact = portByPoint.get(`${r(p.x)},${r(p.y)}`);
    if (exact) return exact;
    const near = portNear(p);
    return near && near.d < TOUCH ? { node: near.node, port: near.port } : null;
  };

  /*
   * The wires tscircuit drew, minus the ones too long to follow or leaving
   * their section (schematic-wires.ts says where the threshold comes from):
   * those become a label at each end, a symbol for rails and grounds.
   */
  const piece = pieceSize(
    byType(circuitJson, "schematic_component").map((c) => {
      const s = c.size as { width?: number; height?: number } | undefined;
      return { width: num(s?.width), height: num(s?.height) };
    }),
  );
  const sectionBoxes = new Map<string, Box>();
  for (const n of nodes) {
    if (!n.section) continue;
    const cur = sectionBoxes.get(n.section);
    sectionBoxes.set(
      n.section,
      cur
        ? {
            minX: Math.min(cur.minX, n.bbox.minX),
            minY: Math.min(cur.minY, n.bbox.minY),
            maxX: Math.max(cur.maxX, n.bbox.maxX),
            maxY: Math.max(cur.maxY, n.bbox.maxY),
          }
        : { ...n.bbox },
    );
  }
  interface TraceDrawn {
    id: string;
    key: string | null;
    net: string | null;
    power: boolean;
    ground: boolean;
    segments: Array<[Pt, Pt]>;
    points: Pt[];
    d: string;
    declaredAs: string | null;
    ends: Array<{ at: Pt; toward: Pt; on: { node: SchNode; port: SchPort } | null }>;
  }
  const all: Array<{ t: TraceDrawn; length: number; reason: WireReason | null }> = [];
  for (const trace of byType(circuitJson, "schematic_trace")) {
    const key = str(trace.subcircuit_connectivity_map_key);
    const net = nameOf(key);
    const edges = Array.isArray(trace.edges) ? (trace.edges as El[]) : [];
    const segments: Array<[Pt, Pt]> = [];
    const parts: string[] = [];
    for (const edge of edges) {
      const from = edge.from as Pt | undefined;
      const to = edge.to as Pt | undefined;
      if (!from || !to) continue;
      const a = { x: num(from.x), y: -num(from.y) };
      const b = { x: num(to.x), y: -num(to.y) };
      segments.push([a, b]);
      parts.push(`M${r(a.x)} ${r(a.y)}L${r(b.x)} ${r(b.y)}`);
    }
    if (segments.length === 0) continue;
    const t: TraceDrawn = {
      id: String(trace.schematic_trace_id),
      key,
      net,
      power: isPower(key, net),
      ground: isGround(key, net),
      segments,
      points: segments.flat(),
      d: parts.join(""),
      declaredAs: declaredByTraceId.get(String(trace.source_trace_id ?? "")) ?? null,
      ends: wireEnds(segments).map((e) => ({ ...e, on: portAt(e.at) })),
    };
    const length = wireLength(segments);
    // a wire with no free ends (a loop) has nowhere to put its labels: it stays
    const reason =
      t.ends.length >= 2
        ? wireAsLabels(
            { length, power: t.power, points: t.points, endSections: t.ends.map((e) => e.on?.node.section ?? null) },
            piece,
            (s) => sectionBoxes.get(s) ?? null,
          )
        : null;
    all.push({ t, length, reason });
  }
  /*
   * A rail is drawn either as wires or as symbols, never half and half: a
   * short strap kept next to the symbols of the wire it belonged to runs
   * right through them. So when one wire of a connected piece of rail goes,
   * the whole piece goes. Signals are judged wire by wire: their short wires
   * are the local drawing worth keeping.
   */
  const touches = (a: TraceDrawn, b: TraceDrawn) => touchingWires(a, b, TOUCH);
  const railsByKey = new Map<string, typeof all>();
  for (const w of all) {
    if (!w.t.power || !w.t.key) continue;
    const list = railsByKey.get(w.t.key) ?? [];
    list.push(w);
    railsByKey.set(w.t.key, list);
  }
  for (const group of railsByKey.values()) {
    if (!group.some((w) => w.reason)) continue;
    const seen = new Set<(typeof all)[number]>();
    for (const start of group) {
      if (seen.has(start)) continue;
      const island = [start];
      seen.add(start);
      for (let i = 0; i < island.length; i++) {
        for (const other of group) {
          if (seen.has(other) || !touches(island[i].t, other.t)) continue;
          seen.add(other);
          island.push(other);
        }
      }
      if (!island.some((w) => w.reason)) continue;
      for (const w of island) w.reason ??= "alimentazione";
    }
  }
  const kept: TraceDrawn[] = [];
  const cut: TraceDrawn[] = [];
  const labeledWires: SchLabeledWire[] = [];
  for (const { t, length, reason } of all) {
    if (reason) {
      cut.push(t);
      labeledWires.push({ id: t.id, net: t.net, reason, length: r(length) });
    } else {
      kept.push(t);
    }
  }

  const wires: SchWire[] = kept.map((t) => ({
    id: t.id,
    d: t.d,
    net: t.net,
    power: t.power,
    ground: t.ground,
    declaredAs: t.declaredAs,
  }));
  /** every wire with its points: the section frames take the wires with them */
  const wirePoints: Pt[][] = kept.map((t) => t.points);

  // junction dots from what is drawn: where three or more conductors meet
  const junctions: SchJunction[] = [];
  const byNet = new Map<string, { segments: Array<[Pt, Pt]>; pins: Pt[]; t: TraceDrawn }>();
  for (const t of kept) {
    const k = t.key ?? `#${t.id}`;
    const g = byNet.get(k) ?? { segments: [], pins: [], t };
    g.segments.push(...t.segments);
    byNet.set(k, g);
  }
  for (const fp of flatPorts) {
    const k = portKey.get(fp.port);
    if (k) byNet.get(k)?.pins.push(fp.port);
  }
  for (const g of byNet.values()) {
    for (const p of findJunctions([g])) {
      junctions.push({ x: p.x, y: p.y, net: g.t.net, power: g.t.power, ground: g.t.ground, isNode: true });
    }
  }

  /*
   * Dot where a wire ends on a pin. It is placed only where a segment truly
   * ends on the pin: a wire that passes NEAR a pin is not connected to it,
   * and the dot is what tells the two apart.
   */
  const wireEndKeys = new Set<string>();
  for (const pts of wirePoints) for (const pt of pts) wireEndKeys.add(`${r(pt.x)},${r(pt.y)}`);
  for (const node of nodes) {
    for (const port of node.ports) {
      if (!wireEndKeys.has(`${r(port.x)},${r(port.y)}`)) continue;
      const ground = isGround(portKey.get(port) ?? null, port.net);
      junctions.push({ x: port.x, y: port.y, net: port.net, power: port.power, ground, isNode: false });
    }
  }

  /*
   * Net labels, drawn where tscircuit attaches them: the point of the flag on
   * the pin end (or on the end of the wire), the ground and rail symbols
   * hanging from the pin. Before, the labels were moved into columns beside
   * the component and tied back with dashed diagonals: the name was far from
   * its pin, and a column of dashes crossing the sheet is exactly what an
   * engineer's drawing never has.
   */
  const netLabels: SchNetLabelDrawn[] = [];
  /** the node each label belongs to, for the section frames */
  const labelOwner = new Map<SchNetLabelDrawn, SchNode | null>();
  /** labels tscircuit left loose: they may move, their dashed line follows */
  const looseLabels = new Map<
    SchNetLabelDrawn,
    { side: PinSide; shape: NetLabelShape; along?: [Pt, Pt] }
  >();
  for (const label of byType(circuitJson, "schematic_net_label")) {
    const raw = str(label.text);
    if (!raw) continue;
    const center = label.center as Pt | undefined;
    const anchorPos = label.anchor_position as Pt | undefined;
    const attach: Pt = anchorPos
      ? { x: num(anchorPos.x), y: -num(anchorPos.y) }
      : { x: num(center?.x), y: -num(center?.y) };
    // labels point to the net by source_net_id (named nets) or by
    // connectivity key (auto-labels): nameOf covers both
    const key = keyOf(str(label.source_net_id));
    const net = nameOf(key) ?? raw;
    const sideRaw = String(label.anchor_side ?? "");
    let side: PinSide;
    if (sideRaw === "left" || sideRaw === "right" || sideRaw === "top" || sideRaw === "bottom") {
      side = sideRaw;
    } else {
      const dx = num(center?.x) - attach.x;
      const dy = -num(center?.y) - attach.y;
      side = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? "left" : "right") : dy >= 0 ? "top" : "bottom";
    }
    /*
     * Grounds and rails are a symbol, always: tscircuit sometimes names a
     * rail with a flag (P3V3 on a pull-up), and the same rail drawn two ways
     * on one sheet reads as two different things.
     */
    const hasRailSymbol = Boolean(str(label.symbol_name)) || isPower(key, raw);
    const shape: NetLabelShape = hasRailSymbol ? (isGround(key, raw) ? "ground" : "rail") : "flag";
    const text = shown(net) ?? net;
    const art = netLabelArt(attach, side, shape, text);

    const onPin = portNear(attach);
    const atPin = onPin && onPin.d < TOUCH ? onPin : null;
    // on a wire: at its end or anywhere along it (a label can name a wire mid-run)
    let onSegment: [Pt, Pt] | null = null;
    if (!atPin) {
      for (const pts of wirePoints) {
        for (let i = 0; i + 1 < pts.length && !onSegment; i += 2) {
          if (distToSegment(attach, pts[i], pts[i + 1]) < TOUCH) onSegment = [pts[i], pts[i + 1]];
        }
        if (onSegment) break;
      }
    }
    const atWire = onSegment !== null;
    // a label that named a wire now drawn as labels: those labels name it
    if (!atPin && !atWire && cut.some((t) => t.segments.some(([a, b]) => distToSegment(attach, a, b) < TOUCH))) {
      continue;
    }
    // loose label: reconnect it to the nearest pin of its net
    const loose = !atPin && !atWire ? portNear(attach, net) : null;
    const owner = atPin ?? loose;

    const drawnLabel: SchNetLabelDrawn = {
      text,
      net,
      power: isPower(key, raw),
      ground: isGround(key, raw),
      shape,
      outline: art.outline,
      closed: art.closed,
      textAt: art.text,
      attach,
      box: art.box,
      ...(loose && loose.d > 0.05 ? { port: { x: loose.port.x, y: loose.port.y } } : {}),
    };
    if (owner) {
      // the <trace> elements touching this pin: clicking the label in Connect
      // mode removes them from main.tsx. Compare the two ends of the declared
      // name, not a substring: ".U1 > .QSPI_IO0" must not also match the
      // trace of ".U1 > .QSPI_IO00".
      const sel = owner.port.selector;
      const declared = (declaredByKey.get(keyBySelector.get(sel) ?? key ?? "") ?? []).filter(
        (d) => d.split(" to ").some((capo) => capo.trim() === sel),
      );
      if (declared.length > 0) drawnLabel.declaredAs = declared;
    }
    netLabels.push(drawnLabel);
    labelOwner.set(drawnLabel, owner?.node ?? null);
    if (drawnLabel.port) looseLabels.set(drawnLabel, { side, shape });
    // in the middle of a wire (not on its ends): it can slide along it
    else if (onSegment && !wireEndKeys.has(`${r(attach.x)},${r(attach.y)}`)) {
      looseLabels.set(drawnLabel, { side, shape, along: onSegment });
    }
  }

  /*
   * The labels in place of the wires drawn as labels: one at each free end,
   * growing the way the wire left, with the net name (a flag) or the symbol
   * of the rail. A net with no name gets the name of its first pin (R4.1), the
   * same at both ends: two flags must say the same thing to be read as one net.
   */
  const unnamedNet = new Map<string, string>();
  for (const fp of flatPorts) {
    const k = portKey.get(fp.port);
    if (!k || nameOf(k)) continue;
    const pinRef = fp.port.selector.replace(/^\./, "").replace(" > .", ".").replace(/\.pin(\d+)$/, ".$1");
    const cur = unnamedNet.get(k);
    if (!cur || pinRef.localeCompare(cur, undefined, { numeric: true }) < 0) unnamedNet.set(k, pinRef);
  }
  const labelAt = new Set(netLabels.map((l) => `${r(l.attach.x)},${r(l.attach.y)}|${l.net ?? l.text}`));
  const labelForWire = (t: TraceDrawn, at: Pt, toward: Pt, owner: SchNode | null) => {
    const text = shown(t.net) ?? (t.key ? unnamedNet.get(t.key) : undefined);
    if (!text) return;
    const seen = `${r(at.x)},${r(at.y)}|${t.net ?? text}`;
    if (labelAt.has(seen)) return;
    labelAt.add(seen);
    const shape: NetLabelShape = t.ground ? "ground" : t.power ? "rail" : "flag";
    const art = netLabelArt(at, sideAlong(at, toward), shape, text);
    const drawnLabel: SchNetLabelDrawn = {
      text,
      net: t.net,
      power: t.power,
      ground: t.ground,
      shape,
      outline: art.outline,
      closed: art.closed,
      textAt: art.text,
      attach: at,
      box: art.box,
      forWire: t.id,
      ...(t.declaredAs ? { declaredAs: [t.declaredAs] } : {}),
    };
    netLabels.push(drawnLabel);
    labelOwner.set(drawnLabel, owner);
  };
  /*
   * Only the ends that touch something get a label: a pin, or a wire still
   * drawn. An end that touched only another wire now drawn as labels is
   * named by that wire's labels, and an end that led only to a net label of
   * tscircuit is named by the label at the other end.
   */
  const keptByKey = segmentsByKey(kept);
  for (const t of cut) {
    for (const e of t.ends) {
      const onKept = t.key ? (keptByKey.get(t.key) ?? []).some(([a, b]) => distToSegment(e.at, a, b) < TOUCH) : false;
      if (e.on || onKept) labelForWire(t, e.at, e.toward, e.on?.node ?? null);
    }
  }
  /*
   * A kept wire that ended ON a wire now drawn as labels would end in the
   * air: it gets the label too, continuing the way it was going.
   */
  const cutByKey = segmentsByKey(cut);
  for (const t of kept) {
    const cutSegments = t.key ? cutByKey.get(t.key) : undefined;
    if (!cutSegments) continue;
    for (const e of t.ends) {
      if (e.on || !cutSegments.some(([a, b]) => distToSegment(e.at, a, b) < TOUCH)) continue;
      const held = kept.some(
        (o) => o !== t && o.key === t.key && o.segments.some(([a, b]) => distToSegment(e.at, a, b) < TOUCH),
      );
      if (held) continue;
      labelForWire(t, e.at, { x: 2 * e.at.x - e.toward.x, y: 2 * e.at.y - e.toward.y }, null);
    }
  }

  /*
   * A piece of rail drawn as wires that no label names (tscircuit straps
   * DGND1..3 of an ADC and leaves it at that): it gets one symbol, where it
   * fits. A ground hangs down, a rail stands up, sideways when that is where
   * the room is; never along a wire of its own.
   */
  const railIslands = new Map<string, TraceDrawn[][]>();
  for (const t of kept) {
    if (!t.power || !t.key) continue;
    const islands = railIslands.get(t.key) ?? [];
    const joined = islands.filter((isl) => isl.some((o) => touchingWires(o, t, TOUCH)));
    const merged = [t, ...joined.flat()];
    railIslands.set(t.key, [...islands.filter((isl) => !joined.includes(isl)), merged]);
  }
  const obstacles: Box[] = [
    ...nodes.map((n) => n.bbox),
    ...nodes.flatMap((n) => n.labels.map((l) => textBox(l))),
  ];
  for (const islands of railIslands.values()) {
    for (const island of islands) {
      const t = island[0];
      const segments = island.flatMap((w) => w.segments);
      const named = netLabels.some(
        (l) => (l.net ?? l.text) === (t.net ?? "") && segments.some(([a, b]) => distToSegment(l.attach, a, b) < TOUCH),
      );
      if (named) continue;
      const text = shown(t.net) ?? (t.key ? unnamedNet.get(t.key) : undefined);
      if (!text) continue;
      const shape: NetLabelShape = t.ground ? "ground" : "rail";
      const order: PinSide[] = t.ground ? ["top", "right", "left", "bottom"] : ["bottom", "right", "left", "top"];
      const points = [...new Map(segments.flat().map((p) => [`${r(p.x)},${r(p.y)}`, p])).values()]
        .map((p) => ({ p, pin: Boolean(portAt(p)) }))
        // corners of the strap before pin ends, then the lowest (ground) or highest (rail)
        .sort((a, b) => Number(a.pin) - Number(b.pin) || (t.ground ? b.p.y - a.p.y : a.p.y - b.p.y));
      const others = [
        ...obstacles,
        ...netLabels.map((l) => l.box),
        ...wirePoints.flatMap((pts) => {
          const out: Box[] = [];
          for (let i = 0; i + 1 < pts.length; i += 2) out.push(boxOf([pts[i], pts[i + 1]]));
          return out;
        }),
      ];
      /*
       * The first spot with nothing under it; else the least covered one, as
       * long as most of the symbol stays clear: a symbol on top of another
       * label explains less than no symbol.
       */
      let chosen: { p: Pt; side: PinSide } | null = null;
      let fallback: { p: Pt; side: PinSide; covered: number } | null = null;
      for (const { p } of points) {
        for (const side of order) {
          const grows = { left: { x: 1, y: 0 }, right: { x: -1, y: 0 }, top: { x: 0, y: 1 }, bottom: { x: 0, y: -1 } }[side];
          // a wire of its own already leaves this way
          const along = segments.some(([a, b]) => {
            const [from, to] = Math.hypot(a.x - p.x, a.y - p.y) < TOUCH ? [a, b] : Math.hypot(b.x - p.x, b.y - p.y) < TOUCH ? [b, a] : [null, null];
            if (!from || !to) return false;
            return (to.x - from.x) * grows.x + (to.y - from.y) * grows.y > 1e-6;
          });
          if (along) continue;
          const box = netLabelArt(p, side, shape, text).box;
          const inner = { minX: box.minX + 0.01, minY: box.minY + 0.01, maxX: box.maxX - 0.01, maxY: box.maxY - 0.01 };
          let covered = 0;
          for (const o of others) {
            if (!overlaps(inner, o, 0.005)) continue;
            covered +=
              (Math.min(inner.maxX, o.maxX) - Math.max(inner.minX, o.minX)) *
              (Math.min(inner.maxY, o.maxY) - Math.max(inner.minY, o.minY));
          }
          if (covered === 0) {
            chosen = { p, side };
            break;
          }
          const share = covered / Math.max(1e-6, (inner.maxX - inner.minX) * (inner.maxY - inner.minY));
          if (share < 0.15 && (!fallback || covered < fallback.covered)) fallback = { p, side, covered };
        }
        if (chosen) break;
      }
      const spot = chosen ?? fallback;
      if (!spot) continue;
      const art = netLabelArt(spot.p, spot.side, shape, text);
      const drawnLabel: SchNetLabelDrawn = {
        text,
        net: t.net,
        power: true,
        ground: t.ground,
        shape,
        outline: art.outline,
        closed: art.closed,
        textAt: art.text,
        attach: spot.p,
        box: art.box,
      };
      netLabels.push(drawnLabel);
      labelOwner.set(drawnLabel, portAt(spot.p)?.node ?? null);
    }
  }

  /*
   * Sections: from schematico.json when it names parts on this sheet, else
   * the ones tscircuit drew. The file's frames are drawn after the overlap
   * pass, around the texts where they ended up.
   */
  const nodeByName = new Map(nodes.map((n) => [n.name, n]));
  const fromNotes = Boolean(notes?.sections.some((s) => s.pieces.some((p) => nodeByName.has(p))));
  const sectionTitles: SchematicModel["sectionTitles"] = fromNotes
    ? []
    : byType(circuitJson, "schematic_text")
        .filter((e) => !e.schematic_component_id && str(e.text))
        .map((e) => {
          const pos = e.position as Pt | undefined;
          return { x: num(pos?.x), y: -num(pos?.y), text: String(e.text) };
        });
  // lines with no component: tscircuit's dividers between the sections
  const sectionLines = fromNotes
    ? []
    : byType(circuitJson, "schematic_line")
        .filter((e) => !e.schematic_component_id)
        .map((e) => ({
          x1: num(e.x1),
          y1: -num(e.y1),
          x2: num(e.x2),
          y2: -num(e.y2),
        }));
  let sectionFrames = fromNotes
    ? []
    : frameSections(nodes, netLabels, labelOwner, wirePoints, sectionTitles, sectionLines);
  // redundant once every section has its own frame
  const dividers = sectionFrames.length > 0 ? [] : sectionLines;
  if (notes) {
    const missing = notes.sections.flatMap((s) => s.pieces).filter((p) => !nodeByName.has(p));
    if (missing.length > 0) {
      noteWarnings.push(
        `${missing.length} pezzi delle sezioni non sono sul foglio: ${missing.slice(0, 4).join(", ")}${missing.length > 4 ? "…" : ""}`,
      );
    }
    const orphanComments = [...notes.comments.keys()].filter((p) => !nodeByName.has(p));
    if (orphanComments.length > 0) {
      noteWarnings.push(`${orphanComments.length} commenti per pezzi che non sono sul foglio: ${orphanComments.slice(0, 4).join(", ")}${orphanComments.length > 4 ? "…" : ""}`);
    }
  }

  /*
   * Final pass over the whole sheet: designators and values were placed by
   * each symbol without knowing what is around, so on a dense section the
   * name of a resistor ends up on a net label or inside a chip. Here they are
   * moved until they find room. What is tied to a pin (pin names and numbers,
   * net labels) never moves: it is the movable texts that make way.
   */
  const items: PlacedText[] = [];
  const fixedBox = (box: Box, owner: string | null, body = false): PlacedText => ({
    box,
    fixed: true,
    rank: -1,
    owner,
    body,
    move: () => {},
  });
  const thick = (b: Box, t = 0.012): Box => ({ minX: b.minX - t, minY: b.minY - t, maxX: b.maxX + t, maxY: b.maxY + t });
  for (const node of nodes) {
    const extra = bodies.get(node.id);
    if (node.box) {
      items.push(
        fixedBox(
          { minX: node.box.x, minY: node.box.y, maxX: node.box.x + node.box.w, maxY: node.box.y + node.box.h },
          // an IC's own texts stay out of its body too: what goes inside
          // (pin names, a centered designator) is placed by its layout
          node.id,
        ),
      );
    } else if (extra?.body) {
      items.push(fixedBox(extra.body, node.id, true));
    }
    for (const o of extra?.obstacles ?? []) items.push(fixedBox(thick(o), node.id));
    const placed = new Map<SchLabel, PlacedText>();
    for (const label of node.labels) {
      const fixed = label.fixed === true || label.tone === "pin" || label.tone === "number";
      // a comment comes last and is the only text that would rather vanish
      // than cover a pin or a wire
      const comment = !fixed && label.tone === "comment";
      const item: PlacedText = {
        box: textBox(label),
        fixed,
        rank: label.tone === "name" ? 0 : comment ? 2 : 1,
        owner: node.id,
        move: (dx, dy) => {
          label.x += dx;
          label.y += dy;
        },
        ...(comment
          ? {
              strict: true,
              drop: () => {
                node.labels = node.labels.filter((l) => l !== label);
              },
              // no free spot for the whole line: one more try at about half of it
              shorten: () => {
                const full = label.full ?? label.text;
                const shorter = fit(full, label.size, textWidth(label.text, label.size) * 0.55);
                if (shorter.length >= label.text.length || shorter.length < 8) return null;
                label.text = shorter;
                label.full = full;
                return textBox(label);
              },
            }
          : {}),
      };
      placed.set(label, item);
      items.push(item);
    }
    for (const [label, item] of placed) {
      const under = commentUnder.get(label);
      if (under) item.follows = placed.get(under);
    }
  }
  for (const label of netLabels) {
    const loose = looseLabels.get(label);
    if (!loose) {
      items.push(fixedBox(label.box, null));
      continue;
    }
    // a loose label is tied by its dashed line, not by its position: it is
    // the one that makes way, the line follows it. One sitting on a wire
    // only slides along that wire, so it stays on it.
    let tries: Array<[number, number]> | undefined;
    if (loose.along) {
      const [a, b] = loose.along;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const ux = len > 0 ? (b.x - a.x) / len : 0;
      const uy = len > 0 ? (b.y - a.y) / len : 0;
      const t0 = (label.attach.x - a.x) * ux + (label.attach.y - a.y) * uy;
      tries = [[0, 0]];
      for (let k = 1; k <= 8; k++) {
        for (const sgn of [1, -1]) {
          const t = t0 + sgn * k * 0.1;
          if (t >= 0.05 && t <= len - 0.05) tries.push([sgn * k * 0.1 * ux, sgn * k * 0.1 * uy]);
        }
      }
    }
    items.push({
      box: label.box,
      fixed: false,
      rank: 0.5,
      owner: null,
      tries,
      move: (dx, dy) => {
        const attach = { x: label.attach.x + dx, y: label.attach.y + dy };
        const art = netLabelArt(attach, loose.side, loose.shape, label.text);
        Object.assign(label, { attach, outline: art.outline, textAt: art.text, box: art.box });
      },
    });
  }
  // a value written across a wire reads as part of the wire
  for (const pts of wirePoints) {
    for (let i = 0; i + 1 < pts.length; i += 2) items.push(fixedBox(thick(boxOf([pts[i], pts[i + 1]])), null));
  }
  for (const t of sectionTitles) {
    items.push(fixedBox(textBox({ x: t.x, y: t.y, text: t.text, anchor: "start", size: SCH_TEXT.sectionTitle }), null));
  }
  deconflict(items);

  const sectionOverlaps: Array<[string, string]> = [];
  if (fromNotes && notes) {
    const framed = frameNoteSections(
      notes,
      nodeByName,
      netLabels,
      labelOwner,
      kept.map((t) => ({ points: t.points, ends: t.ends.map((e) => e.on?.node ?? null) })),
    );
    sectionFrames = framed.frames;
    sectionTitles.push(...framed.titles);
    sectionOverlaps.push(...framed.overlaps);
    for (const s of notes.sections) {
      if (!framed.frames.some((f) => f.name === s.name)) noteWarnings.push(`sezione ${s.name}: nessun pezzo sul foglio`);
    }
    if (framed.overlaps.length > 0) {
      noteWarnings.push(
        `cornici sovrapposte: ${framed.overlaps
          .slice(0, 3)
          .map(([a, b]) => `${a} / ${b}`)
          .join(", ")}${framed.overlaps.length > 3 ? ` e altre ${framed.overlaps.length - 3}` : ""}`,
      );
    }
  }

  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const grow = (x: number, y: number) => {
    bounds.minX = Math.min(bounds.minX, x);
    bounds.minY = Math.min(bounds.minY, y);
    bounds.maxX = Math.max(bounds.maxX, x);
    bounds.maxY = Math.max(bounds.maxY, y);
  };
  for (const n of nodes) {
    grow(n.bbox.minX, n.bbox.minY);
    grow(n.bbox.maxX, n.bbox.maxY);
  }
  for (const j of junctions) grow(j.x, j.y);
  for (const l of netLabels) {
    grow(l.box.minX, l.box.minY);
    grow(l.box.maxX, l.box.maxY);
  }
  for (const d of dividers) {
    grow(d.x1, d.y1);
    grow(d.x2, d.y2);
  }
  for (const f of sectionFrames) {
    grow(f.x, f.y);
    grow(f.x + f.w, f.y + f.h);
  }
  if (!Number.isFinite(bounds.minX)) Object.assign(bounds, empty.bounds);

  const nodeCountByNet = new Map<string, number>();
  for (const n of nodes) {
    for (const p of n.ports) {
      if (!p.net) continue;
      nodeCountByNet.set(p.net, (nodeCountByNet.get(p.net) ?? 0) + 1);
    }
  }
  const nets = [...netByKey.values()]
    .map((n) => {
      const label = shown(n.name);
      return { ...n, nodes: nodeCountByNet.get(n.name) ?? 0, ...(label && label !== n.name ? { label } : {}) };
    })
    .sort((a, b) => Number(b.power || b.ground) - Number(a.power || a.ground) || b.nodes - a.nodes);

  return {
    nodes,
    wires,
    junctions,
    netLabels,
    dividers,
    sectionTitles,
    sectionFrames,
    bounds,
    nets,
    labeledWires,
    sectionOverlaps,
    netLabelNames: Object.fromEntries(notes?.nets ?? []),
    noteWarnings,
  };
}

/** two wires touch when an end of one lies on the other */
function touchingWires(
  a: { ends: Array<{ at: Pt }>; segments: Array<[Pt, Pt]> },
  b: { ends: Array<{ at: Pt }>; segments: Array<[Pt, Pt]> },
  touch: number,
): boolean {
  return (
    a.ends.some((e) => b.segments.some(([p, q]) => distToSegment(e.at, p, q) < touch)) ||
    b.ends.some((e) => a.segments.some(([p, q]) => distToSegment(e.at, p, q) < touch))
  );
}

function segmentsByKey(traces: Array<{ key: string | null; segments: Array<[Pt, Pt]> }>): Map<string, Array<[Pt, Pt]>> {
  const out = new Map<string, Array<[Pt, Pt]>>();
  for (const t of traces) {
    if (!t.key) continue;
    const list = out.get(t.key) ?? [];
    list.push(...t.segments);
    out.set(t.key, list);
  }
  return out;
}

/**
 * One frame per section of schematico.json, around its parts as they are
 * drawn: bodies, texts, the labels on their pins and the wires among them.
 *
 * The layout is tscircuit's, not ours, and it does not know the sections: a
 * section whose parts ended up far apart gets a frame that crosses another.
 * That is not hidden: the pair is reported, both frames are drawn dashed and
 * unfilled so neither covers the other, and their titles are kept apart.
 */
function frameNoteSections(
  notes: SchematicNotes,
  nodeByName: Map<string, SchNode>,
  labels: SchNetLabelDrawn[],
  labelOwner: Map<SchNetLabelDrawn, SchNode | null>,
  wires: Array<{ points: Pt[]; ends: Array<SchNode | null> }>,
): { frames: SchSectionFrame[]; titles: SchematicModel["sectionTitles"]; overlaps: Array<[string, string]> } {
  const PAD = 0.25;
  const HEAD = 0.45; // room for the title inside the frame
  const frames: SchSectionFrame[] = [];
  for (const s of notes.sections) {
    const members = s.pieces.map((p) => nodeByName.get(p)).filter((n): n is SchNode => Boolean(n));
    if (members.length === 0) continue;
    const inside = new Set(members);
    const pts: Pt[] = [];
    const take = (b: Box) => pts.push({ x: b.minX, y: b.minY }, { x: b.maxX, y: b.maxY });
    for (const n of members) {
      take(n.bbox);
      for (const l of n.labels) take(textBox(l));
    }
    for (const l of labels) {
      const owner = labelOwner.get(l);
      if (owner && inside.has(owner)) take(l.box);
    }
    for (const w of wires) {
      const on = w.ends.filter((n): n is SchNode => Boolean(n));
      if (on.length > 0 && on.every((n) => inside.has(n))) pts.push(...w.points);
    }
    const b = boxOf(pts);
    frames.push({
      x: b.minX - PAD,
      y: b.minY - PAD - HEAD,
      w: b.maxX - b.minX + PAD * 2,
      h: b.maxY - b.minY + PAD * 2 + HEAD,
      title: s.title,
      name: s.name,
      pieces: members.map((n) => n.name),
    });
  }

  const boxOfFrame = (f: SchSectionFrame): Box => ({ minX: f.x, minY: f.y, maxX: f.x + f.w, maxY: f.y + f.h });
  const overlapsList: Array<[string, string]> = [];
  for (let i = 0; i < frames.length; i++) {
    for (let j = i + 1; j < frames.length; j++) {
      if (!overlaps(boxOfFrame(frames[i]), boxOfFrame(frames[j]), 0.001)) continue;
      const a = frames[i];
      const b = frames[j];
      overlapsList.push([a.name!, b.name!]);
      a.overlaps = [...(a.overlaps ?? []), b.name!];
      b.overlaps = [...(b.overlaps ?? []), a.name!];
      if (a.w * a.h >= b.w * b.h) a.dashed = true;
      else b.dashed = true;
    }
  }
  // the large ones first: a smaller frame is drawn over the one it sits in
  frames.sort((a, b) => b.w * b.h - a.w * a.h);

  /*
   * The title in the top-left corner, in the band kept free for it. When
   * frames overlap, that corner may hold another section's texts or title:
   * then the top-right corner, then just outside the frame, above or below.
   * A title is not cut to a narrow frame below a readable length: its plate
   * keeps it legible where it runs past the edge.
   */
  const size = SCH_TEXT.sectionTitle;
  const titles: SchematicModel["sectionTitles"] = [];
  const taken: Box[] = [];
  const foreign = (f: SchSectionFrame): Box[] => {
    if (!f.overlaps?.length) return [];
    const mine = new Set(f.pieces);
    const out: Box[] = [];
    for (const n of nodeByName.values()) {
      if (mine.has(n.name)) continue;
      out.push(n.bbox, ...n.labels.map((l) => textBox(l)));
    }
    for (const l of labels) {
      const owner = labelOwner.get(l);
      if (!owner || !mine.has(owner.name)) out.push(l.box);
    }
    return out;
  };
  for (const f of frames) {
    const text = fit(f.title ?? f.name ?? "", size, Math.max(f.w - 0.3, textWidth("x".repeat(16), size)));
    const spots: SchematicModel["sectionTitles"] = [
      { x: f.x + 0.15, y: f.y + 0.32, text },
      { x: f.x + f.w - 0.15, y: f.y + 0.32, text, anchor: "end" },
      { x: f.x + 0.15, y: f.y - 0.08, text },
      { x: f.x + 0.15, y: f.y + f.h + size * 0.85, text },
    ];
    const boxFor = (t: (typeof spots)[number]) => textBox({ ...t, anchor: t.anchor ?? "start", size });
    const others = foreign(f);
    const free = (t: (typeof spots)[number]) => {
      const b = boxFor(t);
      return !taken.some((o) => overlaps(b, o)) && !others.some((o) => overlaps(b, o, 0.005));
    };
    const spot = spots.find(free) ?? spots.find((t) => !taken.some((o) => overlaps(boxFor(t), o))) ?? spots[0];
    taken.push(boxFor(spot));
    titles.push(spot);
  }
  return { frames, titles, overlaps: overlapsList };
}

/**
 * One frame around each functional section, with its title in the top-left
 * corner: the panels of a real sheet.
 *
 * tscircuit only draws vertical dividers between the sections of a row and
 * drops the title above the column, so on a dense sheet nothing says where a
 * section ends, and the Circuit JSON does not say which component belongs to
 * which section. It is rebuilt from the geometry: a section is the column
 * under its title, between the dividers of its row; a component belongs to
 * the nearest title above it in its column. The frame wraps what belongs to
 * the section: its components, the labels on their pins and the wires that
 * start from them (with the labels at their ends), and never crosses the
 * dividers.
 */
function frameSections(
  nodes: SchNode[],
  labels: SchNetLabelDrawn[],
  labelOwner: Map<SchNetLabelDrawn, SchNode | null>,
  wirePoints: Pt[][],
  titles: Array<{ x: number; y: number; text: string }>,
  dividers: Array<{ x1: number; y1: number; x2: number; y2: number }>,
): SchSectionFrame[] {
  if (titles.length === 0) return [];
  // the column of each title: the dividers of its row on either side
  const columns = titles.map((t) => {
    let left = -Infinity;
    let right = Infinity;
    for (const d of dividers) {
      const top = Math.min(d.y1, d.y2);
      const bottom = Math.max(d.y1, d.y2);
      if (t.y < top - 1 || t.y > bottom) continue;
      if (d.x1 <= t.x + 0.05) left = Math.max(left, d.x1);
      else right = Math.min(right, d.x1);
    }
    return { title: t, left, right };
  });
  const columnOf = (p: Pt) => {
    let best: (typeof columns)[number] | null = null;
    for (const c of columns) {
      if (p.x < c.left || p.x >= c.right || p.y < c.title.y - 0.2) continue;
      if (!best || c.title.y > best.title.y) best = c;
    }
    return best;
  };

  const extent = new Map<(typeof columns)[number], Box>();
  const add = (c: (typeof columns)[number] | null | undefined, b: Box) => {
    if (!c) return;
    const cur = extent.get(c);
    extent.set(
      c,
      cur
        ? {
            minX: Math.min(cur.minX, b.minX),
            minY: Math.min(cur.minY, b.minY),
            maxX: Math.max(cur.maxX, b.maxX),
            maxY: Math.max(cur.maxY, b.maxY),
          }
        : { ...b },
    );
  };
  const nodeColumn = new Map<SchNode, (typeof columns)[number]>();
  const columnAt = new Map<string, (typeof columns)[number]>();
  for (const n of nodes) {
    const c = columnOf(n.center);
    if (!c) continue;
    nodeColumn.set(n, c);
    add(c, n.bbox);
    for (const p of n.ports) columnAt.set(`${r(p.x)},${r(p.y)}`, c);
  }
  const wireColumnAt = new Map<string, (typeof columns)[number]>();
  for (const pts of wirePoints) {
    const c = pts.map((p) => columnAt.get(`${r(p.x)},${r(p.y)}`)).find(Boolean);
    if (!c) continue;
    add(c, boxOf(pts));
    for (const p of pts) wireColumnAt.set(`${r(p.x)},${r(p.y)}`, c);
  }
  for (const l of labels) {
    const owner = labelOwner.get(l);
    add((owner && nodeColumn.get(owner)) ?? wireColumnAt.get(`${r(l.attach.x)},${r(l.attach.y)}`), l.box);
  }

  const PAD = 0.25;
  const HEAD = 0.45; // room for the title inside the frame
  const GAP = 0.12; // distance kept from the dividers
  /*
   * Panels of the same row share top and bottom, and a panel between two
   * dividers fills its column: a sheet of aligned panels reads as a sheet,
   * boxes of random height read as clutter.
   */
  const rows = new Map<number, Array<[(typeof columns)[number], Box]>>();
  for (const [c, b] of extent) {
    const key = Math.round(c.title.y * 10);
    const list = rows.get(key) ?? [];
    list.push([c, b]);
    rows.set(key, list);
  }
  const frames: SchSectionFrame[] = [];
  for (const list of rows.values()) {
    const top = Math.min(...list.map(([, b]) => b.minY)) - PAD - HEAD;
    const bottom = Math.max(...list.map(([, b]) => b.maxY)) + PAD;
    for (const [c, b] of list) {
      const titleW = textWidth(c.title.text, SCH_TEXT.sectionTitle) + 0.3;
      const x0 = Number.isFinite(c.left) ? c.left + GAP : b.minX - PAD;
      const x1 = Math.max(Number.isFinite(c.right) ? c.right - GAP : b.maxX + PAD, x0 + titleW);
      const frame = { x: x0, y: top, w: x1 - x0, h: bottom - top, title: c.title.text };
      frames.push(frame);
      c.title.x = frame.x + 0.15;
      c.title.y = frame.y + 0.32;
    }
  }
  return frames;
}

/**
 * Texts that do not overlap.
 *
 * The order of importance is the one needed to understand the circuit: what
 * is tied to a pin is fixed (moving a pin number or a net label would detach
 * it), then the designator (without it you do not know what you are looking
 * at), then a loose net label (its dashed line follows it), then the value. A
 * movable text tries above and below, moving away a little at a time, then
 * sideways; if nothing is free it takes the spot that halves the overlap, or
 * stays where it is: better an overlap than a text shipped far away from its
 * component. A text may sit against its own symbol, never inside another
 * component, nor inside its own IC body.
 */
interface PlacedText {
  box: Box;
  fixed: boolean;
  rank: number;
  /** component the text belongs to */
  owner: string | null;
  /** a symbol body: an obstacle for the texts of OTHER components only */
  body?: boolean;
  /** the moves allowed, when not the default ones (a label on a wire slides along it) */
  tries?: Array<[number, number]>;
  move: (dx: number, dy: number) => void;
  /**
   * only a free spot will do, nothing is exempt (not even its own symbol):
   * with no free spot the text is dropped. A comment is worth less than the
   * pin or the wire it would cover.
   */
  strict?: boolean;
  drop?: () => void;
  /** a shorter version of the text, its new box; null when it cannot shrink */
  shorten?: () => Box | null;
  /** the text it is written under: it moves first, this one follows */
  follows?: PlacedText;
  /** the move applied by the pass */
  moved?: [number, number];
}

function deconflict(items: PlacedText[]): void {
  const movable = items.filter((i) => !i.fixed).sort((a, b) => a.rank - b.rank);
  // a coarse grid: a sheet like the HTL-401 has thousands of texts and wires
  const CELL = 1;
  const grid = new Map<string, PlacedText[]>();
  const cells = (b: Box) => {
    const out: string[] = [];
    for (let gx = Math.floor(b.minX / CELL); gx <= Math.floor(b.maxX / CELL); gx++) {
      for (let gy = Math.floor(b.minY / CELL); gy <= Math.floor(b.maxY / CELL); gy++) out.push(`${gx},${gy}`);
    }
    return out;
  };
  const index = (it: PlacedText) => {
    for (const c of cells(it.box)) {
      const list = grid.get(c) ?? [];
      list.push(it);
      grid.set(c, list);
    }
  };
  for (const it of items) if (it.fixed) index(it);
  /** how much of the box is covered by what is already placed */
  const covered = (item: PlacedText, b: Box) => {
    let area = 0;
    const seen = new Set<PlacedText>();
    for (const c of cells(b)) {
      for (const other of grid.get(c) ?? []) {
        if (other === item || seen.has(other)) continue;
        seen.add(other);
        if (!item.strict && other.body && other.owner === item.owner) continue;
        if (!overlaps(b, other.box, 0.005)) continue;
        area +=
          (Math.min(b.maxX, other.box.maxX) - Math.max(b.minX, other.box.minX)) *
          (Math.min(b.maxY, other.box.maxY) - Math.max(b.minY, other.box.minY));
      }
    }
    return area;
  };

  for (const item of movable) {
    const lead = item.follows?.moved;
    if (lead && (lead[0] !== 0 || lead[1] !== 0)) {
      item.move(lead[0], lead[1]);
      item.box = {
        minX: item.box.minX + lead[0],
        maxX: item.box.maxX + lead[0],
        minY: item.box.minY + lead[1],
        maxY: item.box.maxY + lead[1],
      };
    }
    const h = item.box.maxY - item.box.minY;
    // above and below first, moving away a little at a time; then sideways
    let tries = item.tries;
    if (!tries && item.strict) {
      // a comment searches wider before giving up: near first, then around
      tries = [];
      for (const dx of [0, -0.3, 0.3, -0.6, 0.6, -0.9])
        for (const dy of [0, h * 1.1, -h * 1.1, h * 2.2, -h * 2.2, h * 3.3]) tries.push([dx, dy]);
      tries.sort((a, b) => Math.hypot(a[0], a[1] * 2) - Math.hypot(b[0], b[1] * 2));
    }
    if (!tries) {
      tries = [[0, 0]];
      for (let i = 1; i <= 4; i++) tries.push([0, -i * h * 0.6], [0, i * h * 0.6]);
      for (const dx of [-0.25, 0.25, -0.5, 0.5]) tries.push([dx, 0]);
    }
    const shift = (b: Box, [dx, dy]: [number, number]): Box => ({
      minX: b.minX + dx,
      maxX: b.maxX + dx,
      minY: b.minY + dy,
      maxY: b.maxY + dy,
    });
    const at = (t: [number, number]): Box => shift(item.box, t);
    let best: [number, number] = [0, 0];
    const start = covered(item, item.box);
    let bestArea = start;
    if (start > 0) {
      for (const t of tries) {
        const a = covered(item, at(t));
        if (a === 0) {
          best = t;
          break;
        }
        // a partial improvement is worth a move only if it is a real one
        if (!item.strict && a < bestArea && a < start * 0.5) {
          bestArea = a;
          best = t;
        }
      }
      if (item.strict && covered(item, at(best)) > 0) {
        const shorter = item.shorten?.();
        const retry = shorter ? tries.find((t) => covered(item, shift(shorter, t)) === 0) : undefined;
        if (!shorter || !retry) {
          item.drop?.();
          continue;
        }
        item.box = shorter;
        best = retry;
      }
    }
    if (best[0] !== 0 || best[1] !== 0) item.move(best[0], best[1]);
    item.box = at(best);
    item.moved = best;
    index(item);
  }
}
