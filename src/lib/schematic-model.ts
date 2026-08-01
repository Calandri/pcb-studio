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
 */

import { symbols } from "schematic-symbols";

export const toSchematicY = (svgY: number): number => -svgY;

export interface Pt {
  x: number;
  y: number;
}

export interface SchLabel {
  x: number;
  y: number;
  text: string;
  anchor: "start" | "middle" | "end";
  size: number;
  tone: "name" | "value" | "pin";
  /** text rotated 90 degrees: pins on the top/bottom sides of an IC */
  vertical?: boolean;
}

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
  /** only for kind=symbol */
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

export interface SchNetLabelDrawn extends Pt {
  text: string;
  anchor: "start" | "end";
  net: string | null;
  power: boolean;
  /** pin the label was attached to by the column layout */
  port?: Pt;
  /** attach point declared by tscircuit (different from the text center) */
  attach?: Pt;
  /** true if the column layout already placed it: the deconflict skips it */
  columnPlaced?: boolean;
  /**
   * declared connections passing through the label's pin, e.g.
   * ".U3 > .DATA to .U1 > .PDM_D0": needed to remove them from main.tsx —
   * label-only connections have no wire to click, you click the dashed line
   */
  declaredAs?: string[];
}

export interface SchematicModel {
  nodes: SchNode[];
  wires: SchWire[];
  junctions: SchJunction[];
  netLabels: SchNetLabelDrawn[];
  /** divider lines between functional sections */
  dividers: Array<{ x1: number; y1: number; x2: number; y2: number }>;
  /** section titles */
  sectionTitles: Array<{ x: number; y: number; text: string }>;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  /** nets present on the sheet, for the right column and for highlighting */
  nets: Array<{ name: string; power: boolean; ground: boolean; nodes: number }>;
}

type El = Record<string, unknown>;

/** families whose canonical selectors are .name > .pinN, never the caption */
const PASSIVE_PIN_NUMBER = new Set(["simple_resistor", "simple_capacitor", "simple_inductor"]);

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

const ANCHOR_MAP: Record<string, "start" | "middle" | "end"> = {
  left: "start",
  right: "end",
  center: "middle",
  top_left: "start",
  bottom_left: "start",
  middle_left: "start",
  top_right: "end",
  bottom_right: "end",
  middle_right: "end",
  top_center: "middle",
  bottom_center: "middle",
  middle_center: "middle",
};

export function buildSchematicModel(circuitJson: unknown[] | null): SchematicModel {
  const empty: SchematicModel = {
    nodes: [],
    wires: [],
    junctions: [],
    netLabels: [],
    dividers: [],
    sectionTitles: [],
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

  const nodes: SchNode[] = [];
  for (const comp of byType(circuitJson, "schematic_component")) {
    const id = String(comp.schematic_component_id);
    const src = sourceComponents.get(String(comp.source_component_id));
    const name = (src && str(src.name)) ?? id;
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
        const passive = PASSIVE_PIN_NUMBER.has(String(src?.ftype));
        const selector = `.${name} > .${passive ? `pin${pin}` : (label ?? `pin${pin}`)}`;
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

    const symbolName = str(comp.symbol_name);
    const symbol = symbolName ? symbolRegistry[symbolName] : undefined;
    const labels: SchLabel[] = [];
    const paths: Array<{ d: string; filled: boolean }> = [];
    let box: SchNode["box"] = null;

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
          const d =
            pts.map((p, i) => `${i === 0 ? "M" : "L"}${r(p.x)} ${r(p.y)}`).join(" ") +
            (prim.closed ? " Z" : "");
          paths.push({ d, filled: prim.fill === true });
        } else if (prim.type === "circle" && prim.radius) {
          const c = tf({ x: num(prim.x), y: -num(prim.y) });
          const rad = prim.radius;
          paths.push({
            d: `M${r(c.x - rad)} ${r(c.y)}a${rad} ${rad} 0 1 0 ${rad * 2} 0a${rad} ${rad} 0 1 0 ${-rad * 2} 0`,
            filled: prim.fill === true,
          });
        } else if (prim.type === "box") {
          const c = tf({ x: num(prim.x), y: -num(prim.y) });
          const w = num((prim as { width?: number }).width);
          const h = num((prim as { height?: number }).height);
          paths.push({
            d: `M${r(c.x - w / 2)} ${r(c.y - h / 2)}h${r(w)}v${r(h)}h${r(-w)}Z`,
            filled: prim.fill === true,
          });
        } else if (prim.type === "text" && prim.text) {
          const pos = tf({ x: num(prim.x), y: -num(prim.y) });
          const text =
            prim.text === "{REF}" ? name : prim.text === "{VAL}" ? (value ?? "") : prim.text;
          if (!text) continue;
          const anchor = ANCHOR_MAP[prim.anchor ?? "left"] ?? "start";
          // the symbol puts the text flush against the body: a few hundredths
          // of clearance keeps the lead from cutting the first letter of the value
          const gap = anchor === "start" ? 0.06 : anchor === "end" ? -0.06 : 0;
          labels.push({
            x: pos.x + gap,
            y: pos.y,
            text,
            anchor,
            // a passive is half a unit wide: a caption at 0.24 would be longer
            // than the symbol and would end up over the wires next to it
            size: prim.text === "{REF}" ? 0.17 : 0.15,
            tone: prim.text === "{REF}" ? "name" : "value",
          });
        }
      }
      // symbol with no texts of its own: the name must be added anyway,
      // otherwise the sheet has anonymous shapes
      if (!labels.some((l) => l.tone === "name")) {
        labels.push({
          x: center.x,
          y: center.y - height / 2 - 0.22,
          text: name,
          anchor: "middle",
          size: 0.17,
          tone: "name",
        });
        if (value) {
          labels.push({
            x: center.x,
            y: center.y + height / 2 + 0.34,
            text: value,
            anchor: "middle",
            size: 0.15,
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
      // Part number and name go OUTSIDE, above the box. Inside they would land
      // on top of the first pins: an IC often has pin 1 right in the top-left
      // corner, which is where writing the name would feel natural.
      labels.push({
        x: box.x,
        y: box.y - 0.14,
        text: name,
        anchor: "start",
        size: 0.24,
        tone: "name",
      });
      // The part number shares the line with the name: it is written only if
      // it fits next to it, otherwise the two texts overlap ("U3SPH0641LU4H_1")
      // and it is the name — the one that is always needed — that becomes
      // unreadable.
      const subtitle = part ?? value;
      if (subtitle && textWidth(name, 0.24) + textWidth(subtitle, 0.17) + 0.2 <= width) {
        labels.push({
          x: box.x + width,
          y: box.y - 0.14,
          text: subtitle,
          anchor: "end",
          size: 0.17,
          tone: "value",
        });
      }
      // pin captions inside the box, toward the edge they come out of.
      // Two facing captions must fit in the same width, so the budget is half
      // the box: when the caption does not fit we fall back to the number, and
      // if even that does not fit nothing is written. Better a mute pin than
      // an unreadable one on top of another.
      const pinSize = 0.16;
      for (const p of sheetPorts) {
        const vertical = p.side === "top" || p.side === "bottom";
        const budget = (vertical ? height : width) / 2 - 0.2;
        const text = [p.label, p.pin].find(
          (t) => t && textWidth(t, pinSize) <= budget,
        );
        if (!text) continue;
        const inset = 0.14;
        labels.push({
          x: p.side === "left" ? box.x + inset : p.side === "right" ? box.x + box.w - inset : p.x,
          y:
            p.side === "top"
              ? box.y + inset
              : p.side === "bottom"
                ? box.y + box.h - inset
                : p.y + 0.06,
          text,
          anchor: p.side === "left" || p.side === "top" ? "start" : "end",
          size: pinSize,
          tone: "pin",
          ...(vertical ? { vertical: true } : {}),
        });
      }
    }

    const xs = [center.x, ...sheetPorts.map((p) => p.x)];
    const ys = [center.y, ...sheetPorts.map((p) => p.y)];
    if (box) {
      xs.push(box.x, box.x + box.w);
      ys.push(box.y, box.y + box.h);
    } else {
      xs.push(center.x - width / 2, center.x + width / 2);
      ys.push(center.y - height / 2, center.y + height / 2);
    }

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
  for (const trace of byType(circuitJson, "schematic_trace")) {
    const key = str(trace.subcircuit_connectivity_map_key);
    const net = nameOf(key);
    const power = isPower(key, net);
    const edges = Array.isArray(trace.edges) ? (trace.edges as El[]) : [];
    const segments: string[] = [];
    for (const edge of edges) {
      const from = edge.from as Pt | undefined;
      const to = edge.to as Pt | undefined;
      if (!from || !to) continue;
      segments.push(
        `M${r(num(from.x))} ${r(-num(from.y))}L${r(num(to.x))} ${r(-num(to.y))}`,
      );
    }
    if (segments.length === 0) continue;
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
   * Dot on every connected pin. It is the information that was missing: a
   * wire that REACHES a pin and a wire that passes NEAR it are drawn the
   * same, and without the dot they cannot be told apart. It is placed only
   * where a segment truly ends on the pin, otherwise everything would be
   * dotted.
   */
  const wireEnds = new Set<string>();
  const wireEndPts: Pt[] = [];
  for (const trace of byType(circuitJson, "schematic_trace")) {
    for (const edge of (Array.isArray(trace.edges) ? trace.edges : []) as El[]) {
      for (const pt of [edge.from, edge.to] as Array<Pt | undefined>) {
        if (!pt) continue;
        wireEnds.add(`${r(num(pt.x))},${r(-num(pt.y))}`);
        wireEndPts.push({ x: num(pt.x), y: -num(pt.y) });
      }
    }
  }
  for (const node of nodes) {
    for (const port of node.ports) {
      if (!wireEnds.has(`${r(port.x)},${r(port.y)}`)) continue;
      junctions.push({ x: port.x, y: port.y, net: port.net, power: port.power, isNode: false });
    }
  }

  const netLabels: SchNetLabelDrawn[] = [];
  // connectivity key of each label: needed by the column layout to trace
  // back to the <trace> elements to offer for removal
  const labelKeys = new Map<SchNetLabelDrawn, string>();
  for (const label of byType(circuitJson, "schematic_net_label")) {
    const text = str(label.text);
    if (!text) continue;
    const center = label.center as Pt | undefined;
    // labels point to the net by source_net_id (named nets) or by
    // connectivity key (auto-labels): nameOf covers both. Before, the key was
    // never resolved and the label stayed orphaned: no dashed line toward the
    // pin, no highlighting on mouse hover.
    const key = keyOf(str(label.source_net_id));
    const net = nameOf(key) ?? text;
    const drawn: SchNetLabelDrawn = {
      x: num(center?.x),
      y: -num(center?.y),
      text: net,
      anchor: label.anchor_side === "right" ? "end" : "start",
      net,
      power: isPower(key, text),
      // the real attach point is the anchor, not the text center:
      // it is what tells apart the labels that mark the end of a wire
      ...(label.anchor_position
        ? {
            attach: {
              x: num((label.anchor_position as Pt).x),
              y: -num((label.anchor_position as Pt).y),
            },
          }
        : {}),
    };
    netLabels.push(drawn);
    if (key) labelKeys.set(drawn, key);
  }

  /*
   * Column layout of the auto-labels. tscircuit drops them near the pin but
   * with no order: texts one over the other, crooked columns, and the
   * deconflict makes everything worse by moving them vertically at random.
   * Here every label that does not mark the end of a wire is put in a column
   * outside its component: same x for the whole column, rows at a fixed pitch
   * in the same order as the pins, so the dashed lines stay short and almost
   * horizontal instead of crossing diagonally.
   */
  const SLOT = 0.25; // row pitch: the row is 0.2 tall and does not overlap
  const RAIL_GAP = 0.55; // distance of the column from the pins
  const flatPorts: Array<{ node: SchNode; port: SchNode["ports"][number] }> = [];
  for (const n of nodes) for (const p of n.ports) flatPorts.push({ node: n, port: p });
  const columnJobs: Array<{
    label: SchNetLabelDrawn;
    node: SchNode;
    port: SchNode["ports"][number];
    side: "L" | "R";
  }> = [];
  for (const l of netLabels) {
    if (!l.net) continue;
    // marks the end of a wire: it stays where it is, it is not a pin label
    const attach = l.attach ?? l;
    if (wireEndPts.some((w) => Math.hypot(w.x - attach.x, w.y - attach.y) < 0.06)) continue;
    let best: (typeof flatPorts)[number] | null = null;
    let bestD = Infinity;
    for (const fp of flatPorts) {
      if (fp.port.net !== l.net) continue;
      const d = Math.hypot(fp.port.x - attach.x, fp.port.y - attach.y);
      if (d < bestD) {
        bestD = d;
        best = fp;
      }
    }
    if (!best) continue;
    columnJobs.push({
      label: l,
      node: best.node,
      port: best.port,
      side: best.port.x <= best.node.center.x ? "L" : "R",
    });
  }
  const groups = new Map<string, typeof columnJobs>();
  for (const job of columnJobs) {
    const key = `${job.node.id}:${job.side}`;
    const list = groups.get(key) ?? [];
    list.push(job);
    groups.set(key, list);
  }
  for (const [key, jobs] of groups) {
    const side = key.endsWith(":L") ? "L" : "R";
    const node = jobs[0].node;
    const railX =
      Math.round(
        (side === "L" ? node.bbox.minX - RAIL_GAP : node.bbox.maxX + RAIL_GAP) / 0.1,
      ) * 0.1;
    // same order as the pins, top to bottom: no crossings
    jobs.sort((a, b) => a.port.y - b.port.y);
    let prev = -Infinity;
    for (const job of jobs) {
      const y = Math.max(job.port.y, prev + SLOT);
      prev = y;
      job.label.x = railX;
      job.label.y = y;
      job.label.anchor = side === "L" ? "end" : "start";
      job.label.port = { x: job.port.x, y: job.port.y };
      job.label.columnPlaced = true;
      // the <trace> elements touching this pin: clicking the dashed line in
      // Connect mode removes them from main.tsx. Compare the two ends of the
      // declared name, not a substring: ".U1 > .QSPI_IO0" must not also match
      // the trace of ".U1 > .QSPI_IO00".
      const declared = (declaredByKey.get(labelKeys.get(job.label) ?? "") ?? []).filter(
        (d) => d.split(" to ").some((capo) => capo.trim() === job.port.selector),
      );
      if (declared.length > 0) job.label.declaredAs = declared;
    }
  }

  // lines and titles with no component: they are the frames of the functional sections
  const dividers = byType(circuitJson, "schematic_line")
    .filter((e) => !e.schematic_component_id)
    .map((e) => ({
      x1: num(e.x1),
      y1: -num(e.y1),
      x2: num(e.x2),
      y2: -num(e.y2),
    }));
  const sectionTitles = byType(circuitJson, "schematic_text")
    .filter((e) => !e.schematic_component_id && str(e.text))
    .map((e) => {
      const pos = e.position as Pt | undefined;
      return { x: num(pos?.x), y: -num(pos?.y), text: String(e.text) };
    });

  /*
   * Final pass over the whole sheet: the component texts and the net texts
   * were computed along two different paths and have never seen each other,
   * so they overlap. Here they are all looked at together.
   */
  const RANK = { name: 0, netLabel: 1, value: 2, pin: 3 };
  const texts: PlacedText[] = [];
  for (const node of nodes) {
    for (const label of node.labels) {
      // the captions inside a box are already columned by its layout:
      // moving them would push them out of the frame
      if (label.tone === "pin" && node.box) continue;
      texts.push({
        x: anchorCenter(label.x, label.text, label.size, label.anchor),
        y: label.y,
        w: textWidth(label.text, label.size),
        h: label.size,
        rank: RANK[label.tone],
        move: (dy) => {
          label.y += dy;
        },
      });
    }
  }
  for (const label of netLabels) {
    // column labels are already in place: moving them would ruin the
    // dashed line toward the pin
    if (label.columnPlaced) continue;
    texts.push({
      x: anchorCenter(label.x, label.text, 0.2, label.anchor),
      y: label.y,
      w: textWidth(label.text, 0.2),
      h: 0.2,
      rank: RANK.netLabel,
      move: (dy) => {
        label.y += dy;
      },
    });
  }
  deconflict(texts);

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
  for (const l of netLabels) grow(l.x, l.y);
  for (const d of dividers) {
    grow(d.x1, d.y1);
    grow(d.x2, d.y2);
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

  return { nodes, wires, junctions, netLabels, dividers, sectionTitles, bounds, nets };
}

const r = (v: number): number => Math.round(v * 1000) / 1000;


/**
 * Texts that do not overlap.
 *
 * The tscircuit layout positions captions and labels without knowing what
 * else is around, so on a dense section the name of a resistor ends up on top
 * of the net label next to it and nothing is readable anymore. Here the less
 * important ones are moved vertically until they find room.
 *
 * The order of importance is the one needed to understand the circuit: the
 * component name wins over everything (without it you do not know what you
 * are looking at), then the net label (says where the wire goes), then the
 * value, and last the pin captions. Whatever finds no room in a few attempts
 * stays where it is: better an overlap than a text shipped far away from its
 * component.
 */
interface PlacedText {
  x: number;
  y: number;
  w: number;
  h: number;
  rank: number;
  move: (dy: number) => void;
}

function deconflict(items: PlacedText[]): void {
  const sorted = [...items].sort((a, b) => a.rank - b.rank);
  const placed: PlacedText[] = [];
  const hits = (a: PlacedText, b: PlacedText) =>
    Math.abs(a.x - b.x) * 2 < a.w + b.w && Math.abs(a.y - b.y) * 2 < a.h + b.h;

  for (const item of sorted) {
    let dy = 0;
    for (let attempt = 0; attempt < 7; attempt++) {
      const probe = { ...item, y: item.y + dy };
      if (!placed.some((other) => hits(probe, other))) break;
      // alternate above and below, moving away: the text stays near its
      // component instead of always sliding in the same direction
      const step = Math.ceil((attempt + 1) / 2) * item.h * 1.05;
      dy = attempt % 2 === 0 ? -step : step;
    }
    if (dy !== 0) item.move(dy);
    placed.push({ ...item, y: item.y + dy });
  }
}

/** approximate width of a monospaced text, in drawing units */
const textWidth = (text: string, size: number): number => text.length * size * 0.6;

/** horizontal center of a text, whether the anchor is left, center or right */
const anchorCenter = (
  x: number,
  text: string,
  size: number,
  anchor: "start" | "middle" | "end",
): number => {
  const w = textWidth(text, size);
  return anchor === "start" ? x + w / 2 : anchor === "end" ? x - w / 2 : x;
};
