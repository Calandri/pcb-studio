/**
 * Dal Circuit JSON al disegno dello schematico.
 *
 * PERCHE' NON IL VIEWER DI TSCIRCUIT. Il viewer di tscircuit disegna e basta:
 * i colori sono i suoi, i simboli sono i suoi, e soprattutto non si puo'
 * costruirci sopra un editor (niente selezione multipla, niente aggancio alla
 * griglia, niente evidenziazione della net). Qui si estrae il modello
 * geometrico e lo si disegna con il linguaggio visivo di PCB Studio, cosi'
 * l'interazione e' nostra.
 *
 * Sistema di coordinate: lo schematico ha la Y verso l'alto, l'SVG verso il
 * basso. Il ribaltamento avviene UNA VOLTA qui (y_svg = -y_sch): da qui in poi
 * tutto e' gia' in coordinate SVG e nessuno deve piu' ricordarselo. Chi deve
 * tornare indietro (l'editor, quando salva uno spostamento) usa toSchematicY.
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
  /** testo ruotato di 90 gradi: pin sui lati alto/basso di un integrato */
  vertical?: boolean;
}

export interface SchNode {
  id: string;
  name: string;
  /** sigla del costruttore, quando c'e' (LP5907MFX, SHT40...) */
  part: string | null;
  /** valore leggibile: 100nF, 4k7, verde */
  value: string | null;
  kind: "box" | "symbol";
  center: Pt;
  /** solo per kind=box */
  box: { x: number; y: number; w: number; h: number } | null;
  /** solo per kind=symbol */
  paths: Array<{ d: string; filled: boolean }>;
  labels: SchLabel[];
  ports: Array<{ x: number; y: number; net: string | null; power: boolean }>;
  section: string | null;
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
}

export interface SchWire {
  id: string;
  d: string;
  net: string | null;
  /** alimentazione o massa: si disegna in verde, come sul mockup */
  power: boolean;
}

export interface SchJunction extends Pt {
  net: string | null;
  power: boolean;
}

export interface SchNetLabelDrawn extends Pt {
  text: string;
  anchor: "start" | "end";
  net: string | null;
  power: boolean;
}

export interface SchematicModel {
  nodes: SchNode[];
  wires: SchWire[];
  junctions: SchJunction[];
  netLabels: SchNetLabelDrawn[];
  /** linee divisorie fra sezioni funzionali */
  dividers: Array<{ x1: number; y1: number; x2: number; y2: number }>;
  /** titoli delle sezioni */
  sectionTitles: Array<{ x: number; y: number; text: string }>;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  /** net presenti sul foglio, per la colonna di destra e per l'evidenziazione */
  nets: Array<{ name: string; power: boolean; ground: boolean; nodes: number }>;
}

type El = Record<string, unknown>;

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

function byType(circuitJson: unknown[], type: string): El[] {
  return (circuitJson as El[]).filter((e) => e?.type === type);
}

/**
 * Valore leggibile del componente. Ogni famiglia espone il proprio campo:
 * leggerne uno solo lascia meta' della distinta senza valore.
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
 * Nomi che denunciano un rail: o iniziano come un'alimentazione (GND, VCC,
 * VBAT...) o contengono una tensione (MIC_3V3, P3V3_SD, VDD_1V8). Il secondo
 * caso serve perche' i rail derivati prendono il nome dal carico, non dalla
 * tensione: senza questo MIC_3V3 verrebbe disegnato come un segnale qualsiasi.
 */
const POWER_HINT = /^(gnd|agnd|dgnd|vss|vcc|vdd|vbat|v\+|\+?\d?v\d|p\d ?v?\d)|(^|_)\+?\d+v\d*($|_)/i;

/**
 * Trasformazione dal sistema del simbolo a quello del foglio.
 *
 * Si ricava da DUE punti noti in entrambi i sistemi (due piedini): due punti
 * fissano rotazione, scala e traslazione di una similitudine, che e' esattamente
 * cio' che tscircuit applica ai simboli. Con un solo piedino resta la sola
 * traslazione, con nessuno il centro del componente.
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
      // (dp / ds) come numero complesso: rotazione + scala in un colpo solo
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

  // chiave di connettivita' -> net vera. E' l'unico modo di sapere se un filo
  // e' un'alimentazione: sulle tracce c'e' solo la chiave, il nome sta sulla net
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
  const netOf = (key: unknown) => (typeof key === "string" ? netByKey.get(key) : undefined);
  /*
   * Una net e' di alimentazione se lo dichiara la sorgente OPPURE se lo dice il
   * nome. Il flag da solo non basta: tscircuit marca is_power solo quando la
   * net e' dichiarata come sorgente di tensione, quindi un rail chiamato P3V3
   * uscito da un LDO resta "segnale" e si disegnerebbe grigio come un GPIO.
   * Sul foglio l'alimentazione si deve riconoscere a colpo d'occhio.
   */
  const isPower = (key: unknown, fallbackText?: string | null): boolean => {
    const net = netOf(key);
    if (net?.power || net?.ground) return true;
    const name = net?.name ?? fallbackText;
    return name ? POWER_HINT.test(name) : false;
  };

  // testi che tscircuit attacca ai componenti di libreria: nome e sigla
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

  // net di ogni porta, per accendere anche i piedini quando si evidenzia una net
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

    const sheetPorts = (portsByComponent.get(id) ?? []).map((p) => {
      const c = p.center as Pt | undefined;
      const sourcePortId = str(p.source_port_id);
      const key = sourcePortId ? netByPort.get(sourcePortId) : undefined;
      const net = key ? (netOf(key)?.name ?? null) : null;
      return {
        x: num(c?.x),
        y: -num(c?.y),
        pin: String(p.pin_number ?? ""),
        label: str(p.display_pin_label),
        side: String(p.side_of_component ?? ""),
        net,
        power: isPower(key, net),
      };
    });

    // sigla del costruttore: e' il testo del componente che NON e' il suo nome
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
      // il simbolo vive nel suo sistema: lo si ancora ai piedini veri del foglio
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
          // il simbolo mette il testo appoggiato al corpo: qualche centesimo di
          // stacco evita che il reoforo tagli la prima lettera del valore
          const gap = anchor === "start" ? 0.06 : anchor === "end" ? -0.06 : 0;
          labels.push({
            x: pos.x + gap,
            y: pos.y,
            text,
            anchor,
            size: prim.text === "{REF}" ? 0.24 : 0.2,
            tone: prim.text === "{REF}" ? "name" : "value",
          });
        }
      }
      // simbolo senza testi propri: il nome va messo comunque, altrimenti sul
      // foglio ci sono forme anonime
      if (!labels.some((l) => l.tone === "name")) {
        labels.push({
          x: center.x,
          y: center.y - height / 2 - 0.22,
          text: name,
          anchor: "middle",
          size: 0.24,
          tone: "name",
        });
        if (value) {
          labels.push({
            x: center.x,
            y: center.y + height / 2 + 0.38,
            text: value,
            anchor: "middle",
            size: 0.2,
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
      // Sigla e nome vanno FUORI, sopra la scatola. Dentro finirebbero sopra i
      // primi piedini: un integrato ha spesso il piedino 1 proprio nell'angolo
      // in alto a sinistra, che e' dove verrebbe naturale scrivere il nome.
      labels.push({
        x: box.x,
        y: box.y - 0.14,
        text: name,
        anchor: "start",
        size: 0.3,
        tone: "name",
      });
      // La sigla divide la riga col nome: si scrive solo se ci sta accanto,
      // altrimenti le due scritte si accavallano ("U3SPH0641LU4H_1") ed e' il
      // nome, quello che serve sempre, a diventare illeggibile.
      const subtitle = part ?? value;
      if (subtitle && textWidth(name, 0.3) + textWidth(subtitle, 0.2) + 0.2 <= width) {
        labels.push({
          x: box.x + width,
          y: box.y - 0.14,
          text: subtitle,
          anchor: "end",
          size: 0.2,
          tone: "value",
        });
      }
      // sigle dei piedini dentro la scatola, verso il bordo da cui escono.
      // Due sigle affacciate devono stare nella stessa larghezza, quindi il
      // budget e' meta' scatola: quando non ci sta il nome si ripiega sul
      // numero, e se non ci sta nemmeno quello non si scrive niente. Meglio un
      // piedino muto che un piedino illeggibile sopra un altro.
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
      ports: sheetPorts.map((p) => ({ x: p.x, y: p.y, net: p.net, power: p.power })),
      section,
      bbox: {
        minX: Math.min(...xs),
        minY: Math.min(...ys),
        maxX: Math.max(...xs),
        maxY: Math.max(...ys),
      },
    });
  }

  const wires: SchWire[] = [];
  const junctions: SchJunction[] = [];
  for (const trace of byType(circuitJson, "schematic_trace")) {
    const key = str(trace.subcircuit_connectivity_map_key);
    const net = key ? (netOf(key)?.name ?? null) : null;
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
    });
    for (const j of (Array.isArray(trace.junctions) ? trace.junctions : []) as Pt[]) {
      junctions.push({ x: num(j.x), y: -num(j.y), net, power });
    }
  }

  const netLabels: SchNetLabelDrawn[] = [];
  for (const label of byType(circuitJson, "schematic_net_label")) {
    const text = str(label.text);
    if (!text) continue;
    const center = label.center as Pt | undefined;
    const key = str(label.source_net_id);
    const net = key ? (netOf(key)?.name ?? text) : text;
    netLabels.push({
      x: num(center?.x),
      y: -num(center?.y),
      text: netOf(key)?.name ?? text,
      anchor: label.anchor_side === "right" ? "end" : "start",
      net,
      power: isPower(key, text),
    });
  }

  // linee e titoli senza componente: sono le cornici delle sezioni funzionali
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

/** larghezza approssimata di un testo monospaziato, in unita' di disegno */
const textWidth = (text: string, size: number): number => text.length * size * 0.6;
