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
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
}

export interface SchWire {
  id: string;
  d: string;
  net: string | null;
  /** power or ground: drawn in green, as on the mockup */
  power: boolean;
  /** declared connection that produced the wire, e.g. ".J1 > .VBAT to .D1 > .cathode" */
  declaredAs: string | null;
}

export interface SchJunction extends Pt {
  net: string | null;
  power: boolean;
  /** true = node between multiple wires, false = attachment to a pin */
  isNode: boolean;
}

export interface SchNetLabelDrawn {
  text: string;
  net: string | null;
  power: boolean;
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
  /** displayName of the <schematicsection>, when tscircuit wrote it */
  title: string | null;
}

export interface SchematicModel {
  nodes: SchNode[];
  wires: SchWire[];
  junctions: SchJunction[];
  netLabels: SchNetLabelDrawn[];
  /** divider lines between functional sections (only when there are no frames) */
  dividers: Array<{ x1: number; y1: number; x2: number; y2: number }>;
  /** section titles */
  sectionTitles: Array<{ x: number; y: number; text: string }>;
  /** one frame around every functional section */
  sectionFrames: SchSectionFrame[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  /** nets present on the sheet, for the right column and for highlighting */
  nets: Array<{ name: string; power: boolean; ground: boolean; nodes: number }>;
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
const POWER_HINT = /^(gnd|agnd|dgnd|vss|vcc|vdd|vbat|v\+|\+?\d?v\d|p\d ?v?\d)|(^|_)\+?\d+v\d*($|_)/i;
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

export function buildSchematicModel(circuitJson: unknown[] | null): SchematicModel {
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
  };
  if (!circuitJson || circuitJson.length === 0) return empty;

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
    const section = src ? str(src.sch_section_name) : null;

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
        },
      );
      for (const d of art.stubs) paths.push({ d, filled: false });
      for (const [a, b] of art.segments) obstacles.push(boxOf([a, b]));
      for (const d of art.marks) paths.push({ d, filled: true });
      labels.push(...art.labels);
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
      ports: sheetPorts.map((p) => ({
        x: p.x,
        y: p.y,
        net: p.net,
        power: p.power,
        label: p.label,
        selector: p.selector,
        connected: p.connected,
      })),
      section,
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

  const wires: SchWire[] = [];
  const junctions: SchJunction[] = [];
  /** every wire with its points: the section frames take the wires with them */
  const wirePoints: Pt[][] = [];
  for (const trace of byType(circuitJson, "schematic_trace")) {
    const key = str(trace.subcircuit_connectivity_map_key);
    const net = nameOf(key);
    const power = isPower(key, net);
    const edges = Array.isArray(trace.edges) ? (trace.edges as El[]) : [];
    const segments: string[] = [];
    const pts: Pt[] = [];
    for (const edge of edges) {
      const from = edge.from as Pt | undefined;
      const to = edge.to as Pt | undefined;
      if (!from || !to) continue;
      pts.push({ x: num(from.x), y: -num(from.y) }, { x: num(to.x), y: -num(to.y) });
      segments.push(
        `M${r(num(from.x))} ${r(-num(from.y))}L${r(num(to.x))} ${r(-num(to.y))}`,
      );
    }
    if (segments.length === 0) continue;
    wirePoints.push(pts);
    wires.push({
      id: String(trace.schematic_trace_id),
      d: segments.join(""),
      net,
      power,
      declaredAs: declaredByTraceId.get(String(trace.source_trace_id ?? "")) ?? null,
    });
    for (const j of (Array.isArray(trace.junctions) ? trace.junctions : []) as Pt[]) {
      junctions.push({ x: num(j.x), y: -num(j.y), net, power, isNode: true });
    }
  }

  /*
   * Dot where a wire ends on a pin. It is placed only where a segment truly
   * ends on the pin: a wire that passes NEAR a pin is not connected to it,
   * and the dot is what tells the two apart.
   */
  const wireEnds = new Set<string>();
  for (const pts of wirePoints) for (const pt of pts) wireEnds.add(`${r(pt.x)},${r(pt.y)}`);
  for (const node of nodes) {
    for (const port of node.ports) {
      if (!wireEnds.has(`${r(port.x)},${r(port.y)}`)) continue;
      junctions.push({ x: port.x, y: port.y, net: port.net, power: port.power, isNode: false });
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
    const hasRailSymbol = Boolean(str(label.symbol_name));
    const shape: NetLabelShape = hasRailSymbol ? (isGround(key, raw) ? "ground" : "rail") : "flag";
    const art = netLabelArt(attach, side, shape, net);

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
    // loose label: reconnect it to the nearest pin of its net
    const loose = !atPin && !atWire ? portNear(attach, net) : null;
    const owner = atPin ?? loose;

    const drawnLabel: SchNetLabelDrawn = {
      text: net,
      net,
      power: isPower(key, raw),
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
    else if (onSegment && !wireEnds.has(`${r(attach.x)},${r(attach.y)}`)) {
      looseLabels.set(drawnLabel, { side, shape, along: onSegment });
    }
  }

  const sectionTitles = byType(circuitJson, "schematic_text")
    .filter((e) => !e.schematic_component_id && str(e.text))
    .map((e) => {
      const pos = e.position as Pt | undefined;
      return { x: num(pos?.x), y: -num(pos?.y), text: String(e.text) };
    });
  // lines with no component: tscircuit's dividers between the sections
  const sectionLines = byType(circuitJson, "schematic_line")
    .filter((e) => !e.schematic_component_id)
    .map((e) => ({
      x1: num(e.x1),
      y1: -num(e.y1),
      x2: num(e.x2),
      y2: -num(e.y2),
    }));
  const sectionFrames = frameSections(nodes, netLabels, labelOwner, wirePoints, sectionTitles, sectionLines);
  // redundant once every section has its own frame
  const dividers = sectionFrames.length > 0 ? [] : sectionLines;

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
    for (const label of node.labels) {
      const fixed = label.fixed === true || label.tone === "pin" || label.tone === "number";
      items.push({
        box: textBox(label),
        fixed,
        rank: label.tone === "name" ? 0 : 1,
        owner: node.id,
        move: (dx, dy) => {
          label.x += dx;
          label.y += dy;
        },
      });
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
    .map((n) => ({ ...n, nodes: nodeCountByNet.get(n.name) ?? 0 }))
    .sort((a, b) => Number(b.power || b.ground) - Number(a.power || a.ground) || b.nodes - a.nodes);

  return { nodes, wires, junctions, netLabels, dividers, sectionTitles, sectionFrames, bounds, nets };
}

function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
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
        if (other.body && other.owner === item.owner) continue;
        if (!overlaps(b, other.box, 0.005)) continue;
        area +=
          (Math.min(b.maxX, other.box.maxX) - Math.max(b.minX, other.box.minX)) *
          (Math.min(b.maxY, other.box.maxY) - Math.max(b.minY, other.box.minY));
      }
    }
    return area;
  };

  for (const item of movable) {
    const h = item.box.maxY - item.box.minY;
    // above and below first, moving away a little at a time; then sideways
    let tries = item.tries;
    if (!tries) {
      tries = [[0, 0]];
      for (let i = 1; i <= 4; i++) tries.push([0, -i * h * 0.6], [0, i * h * 0.6]);
      for (const dx of [-0.25, 0.25, -0.5, 0.5]) tries.push([dx, 0]);
    }
    const at = ([dx, dy]: [number, number]): Box => ({
      minX: item.box.minX + dx,
      maxX: item.box.maxX + dx,
      minY: item.box.minY + dy,
      maxY: item.box.maxY + dy,
    });
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
        if (a < bestArea && a < start * 0.5) {
          bestArea = a;
          best = t;
        }
      }
    }
    if (best[0] !== 0 || best[1] !== 0) item.move(best[0], best[1]);
    item.box = at(best);
    index(item);
  }
}
