import { KicadToCircuitJsonConverter } from "kicad-to-circuit-json";
import { parseKicadModToCircuitJson } from "kicad-component-converter";

/**
 * KiCad import (Fase 3.g): .kicad_mod footprint -> library component TSX,
 * .kicad_pcb (+ optional .kicad_sch) -> tscircuit project files.
 *
 * The converters emit Circuit JSON; we serialize it back to tscircuit code
 * because the project document IS code (the agent edits it with write_file).
 * Footprints are rebuilt inline from the pcb elements (the converter expands
 * them), so imported designs keep their REAL pad geometry — no guessing.
 *
 * Altium: no open converter exists. Bridge path: KiCad imports .SchDoc/.PcbDoc
 * natively, save as KiCad project, import here.
 */

interface El {
  type: string;
  [key: string]: unknown;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

const r3 = (v: number): number => Number(v.toFixed(3));

const toPascalCase = (s: string): string => {
  const parts = s.replace(/[^A-Za-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
  const name = parts.map((p) => p[0].toUpperCase() + p.slice(1)).join("");
  return /^[A-Z]/.test(name) ? name : `K${name}`;
};

/** selector-safe component reference: R1, U2, J3 */
const safeRef = (name: string): string => name.replace(/[^A-Za-z0-9_]/g, "_");

const NET_SAFE_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
const safeNet = (name: string): string => {
  const cleaned = name.replace(/[^A-Za-z0-9_]/g, "_").replace(/^(\d)/, "P$1");
  return NET_SAFE_RE.test(cleaned) ? cleaned : `N_${cleaned}`;
};

// ---------------------------------------------------------------------------
// footprint soup -> <footprint> JSX (shared by component and project import)
// ---------------------------------------------------------------------------

interface FootprintCtx {
  /** subtract this center and counter-rotate (project components are placed) */
  cx?: number;
  cy?: number;
  rotationDeg?: number;
}

function localize(x: number, y: number, ctx: FootprintCtx): { x: number; y: number } {
  let dx = x - (ctx.cx ?? 0);
  let dy = y - (ctx.cy ?? 0);
  const rot = ctx.rotationDeg ?? 0;
  if (rot) {
    const rad = (-rot * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const rx = dx * cos - dy * sin;
    const ry = dx * sin + dy * cos;
    dx = rx;
    dy = ry;
  }
  return { x: r3(dx), y: r3(dy) };
}

function portHintsOf(el: El): string[] {
  const hints = (el.port_hints as string[] | undefined) ?? [];
  return hints.map(String);
}

function footprintJsx(elements: El[], ctx: FootprintCtx, indent: string): string {
  const lines: string[] = [];
  for (const el of elements) {
    const x = num(el.x);
    const y = num(el.y);
    if (el.type === "pcb_smtpad" && x !== null && y !== null) {
      const p = localize(x, y, ctx);
      const hints = JSON.stringify(portHintsOf(el));
      const shape = el.shape === "circle" ? "circle" : "rect";
      const w = num(el.width) ?? (num(el.radius) ?? 0) * 2;
      const h = num(el.height) ?? (num(el.radius) ?? 0) * 2;
      const rot = num(el.ccw_rotation);
      lines.push(
        `${indent}<smtpad portHints={${hints}} shape="${shape}" width={${r3(w)}} height={${r3(h)}} pcbX={${p.x}} pcbY={${p.y}}${rot ? ` ccwRotation={${rot}}` : ""} layer="${String(el.layer ?? "top")}" />`,
      );
    } else if (el.type === "pcb_plated_hole" && x !== null && y !== null) {
      const p = localize(x, y, ctx);
      const hints = JSON.stringify(portHintsOf(el));
      lines.push(
        `${indent}<platedhole portHints={${hints}} pcbX={${p.x}} pcbY={${p.y}} holeDiameter={${r3(num(el.hole_diameter) ?? 0.8)}} outerDiameter={${r3(num(el.outer_diameter) ?? 1.6)}} />`,
      );
    } else if (el.type === "pcb_hole" && x !== null && y !== null) {
      const p = localize(x, y, ctx);
      lines.push(
        `${indent}<hole pcbX={${p.x}} pcbY={${p.y}} diameter={${r3(num(el.hole_diameter) ?? num(el.diameter) ?? 1)}} />`,
      );
    } else if (el.type === "pcb_silkscreen_text" && x !== null && y !== null) {
      const p = localize(x, y, ctx);
      const text = String(el.text ?? "").replace(/"/g, '\\"');
      if (text) {
        lines.push(
          `${indent}<silkscreentext pcbX={${p.x}} pcbY={${p.y}} text="${text}" fontSize={${r3(num(el.font_size) ?? 1)}} />`,
        );
      }
    } else if (el.type === "pcb_courtyard_rect") {
      const cx = num(el.center ? (el.center as { x?: number }).x : el.x);
      const cy = num(el.center ? (el.center as { y?: number }).y : el.y);
      const p = localize(cx ?? 0, cy ?? 0, ctx);
      lines.push(
        `${indent}<courtyardrect width={${r3(num(el.width) ?? 1)}} height={${r3(num(el.height) ?? 1)}} pcbX={${p.x}} pcbY={${p.y}} />`,
      );
    }
    // silkscreen paths/lines are dropped in v1 (cosmetic, often hundreds of segments)
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// component import: .kicad_mod -> library component TSX
// ---------------------------------------------------------------------------

export interface ImportedKicadComponent {
  name: string;
  code: string;
}

export async function importKicadFootprint(
  filename: string,
  content: string,
): Promise<ImportedKicadComponent> {
  const soup = (await parseKicadModToCircuitJson(content)) as El[];
  const base = filename.replace(/\.kicad_mod$/i, "");
  const name = toPascalCase(base);

  const pinNumbers = new Set<string>();
  for (const el of soup) {
    for (const hint of portHintsOf(el)) {
      if (/^\d+$/.test(hint)) pinNumbers.add(hint);
    }
  }
  const pinLabels = [...pinNumbers]
    .sort((a, b) => Number(a) - Number(b))
    .map((n, i) => `pin${i + 1}: "${n}"`)
    .join(", ");

  const body = footprintJsx(soup, {}, "      ");
  const code = `// Importato da KiCad footprint: ${base}.kicad_mod
export const ${name} = (props: any) => (
  <chip
    {...props}
    footprint={
      <footprint>
${body}
      </footprint>
    }${pinLabels ? `\n    pinLabels={{ ${pinLabels} }}` : ""}
  />
)
`;
  return { name, code };
}

// ---------------------------------------------------------------------------
// project import: .kicad_pcb (+ .kicad_sch) -> main.tsx
// ---------------------------------------------------------------------------

export interface ImportedKicadProject {
  fsMap: Record<string, string>;
  stats: Record<string, number | undefined>;
  warnings: string[];
  components: number;
  traces: number;
}

const FTYPE_ELEMENT: Record<string, string> = {
  simple_resistor: "resistor",
  simple_capacitor: "capacitor",
  simple_led: "led",
  simple_diode: "diode",
  simple_inductor: "inductor",
  simple_crystal: "crystal",
  simple_transistor: "transistor",
  simple_mosfet: "mosfet",
  simple_pinheader: "pinheader",
  simple_fuse: "fuse",
};

export function importKicadProject(
  files: Array<{ path: string; content: string }>,
): ImportedKicadProject {
  const converter = new KicadToCircuitJsonConverter();
  for (const f of files) converter.addFile(f.path, f.content);
  converter.runUntilFinished();
  const cj = converter.getOutput() as El[];
  const stats = converter.getStats();
  const warnings = converter.getWarnings();

  const pcbComponentBySource = new Map<string, El>();
  for (const el of cj) {
    if (el.type === "pcb_component" && el.source_component_id) {
      pcbComponentBySource.set(String(el.source_component_id), el);
    }
  }
  const portById = new Map<string, El>();
  for (const el of cj) {
    if (el.type === "source_port") portById.set(String(el.source_port_id), el);
  }
  const compNameById = new Map<string, string>();
  for (const el of cj) {
    if (el.type === "source_component") {
      compNameById.set(String(el.source_component_id), String(el.name ?? "?"));
    }
  }

  const componentLines: string[] = [];
  let compIndex = 0;
  for (const el of cj) {
    if (el.type !== "source_component") continue;
    compIndex++;
    const sourceId = String(el.source_component_id);
    const pcb = pcbComponentBySource.get(sourceId);
    const name = safeRef(String(el.name ?? `K${compIndex}`));
    const ftype = String(el.ftype ?? "simple_chip");
    const center = (pcb?.center as { x?: number; y?: number } | undefined) ?? {};
    const cx = num(center.x) ?? 0;
    const cy = num(center.y) ?? 0;
    const rotation = pcb ? (num(pcb.rotation) ?? 0) : 0;
    const pos = ` pcbX={${r3(cx)}} pcbY={${r3(cy)}}${rotation ? ` pcbRotation={${rotation}}` : ""}`;

    // inline footprint from this component's pcb elements (real geometry)
    const compEls = cj.filter((e) => e.pcb_component_id === pcb?.pcb_component_id);
    const hasGeometry = compEls.some(
      (e) => e.type === "pcb_smtpad" || e.type === "pcb_plated_hole" || e.type === "pcb_hole",
    );
    const footprint = hasGeometry
      ? `\n    footprint={\n      <footprint>\n${footprintJsx(compEls, { cx, cy, rotationDeg: rotation }, "        ")}\n      </footprint>\n    }`
      : "";

    // pin labels from source ports
    const pinLabels = cj
      .filter((e) => e.type === "source_port" && e.source_component_id === sourceId)
      .map((e) => {
        const pin = e.pin_number ? `pin${e.pin_number}` : String(e.name ?? "?");
        return `${pin}: "${String(e.name ?? pin)}"`;
      });
    const labels = pinLabels.length ? `\n    pinLabels={{ ${pinLabels.join(", ")} }}` : "";

    const value = el.display_value ? String(el.display_value) : null;
    // passive tags require their value prop (resistance/capacitance/...): when
    // the PCB carries no value, fall back to a chip with the real footprint
    const VALUE_PROPS: Record<string, string> = {
      resistor: "resistance",
      capacitor: "capacitance",
    };
    const wantedTag = FTYPE_ELEMENT[ftype] ?? "chip";
    const requiredProp = VALUE_PROPS[wantedTag];
    const tag = requiredProp && !value ? "chip" : wantedTag;
    const valueProp = requiredProp && value ? ` ${requiredProp}="${value}"` : "";

    componentLines.push(`    <${tag} name="${name}"${valueProp}${pos}${footprint}${labels} />`);
  }

  // connectivity: 2-port source traces become direct <trace>; larger nets get <net>
  const netLines: string[] = [];
  const traceLines: string[] = [];
  const namedNets = new Set<string>();
  const selectorOf = (sourcePortId: string): string | null => {
    const port = portById.get(sourcePortId);
    if (!port) return null;
    const comp = compNameById.get(String(port.source_component_id ?? ""));
    if (!comp) return null;
    return `.${safeRef(comp)} > .${String(port.name ?? `pin${port.pin_number ?? "?"}`)}`;
  };

  for (const el of cj) {
    if (el.type !== "source_trace") continue;
    const ports = ((el.connected_source_port_ids as string[] | undefined) ?? [])
      .map(selectorOf)
      .filter((s): s is string => s !== null);
    if (ports.length < 2) continue;
    const netIds = (el.connected_source_net_ids as string[] | undefined) ?? [];
    const netName = netIds.length
      ? (() => {
          const id = String(netIds[0]);
          const net = cj.find((e) => e.type === "source_net" && e.source_net_id === id);
          return net ? String(net.name) : null;
        })()
      : null;
    if (ports.length === 2 && !netName) {
      traceLines.push(`    <trace from="${ports[0]}" to="${ports[1]}" />`);
    } else {
      const net = safeNet(netName ?? `NET_${traceLines.length}`);
      if (!namedNets.has(net)) {
        namedNets.add(net);
        netLines.push(`    <net name="${net}" />`);
      }
      for (const port of ports) {
        traceLines.push(`    <trace from="${port}" to="net.${net}" />`);
      }
    }
  }

  const board = cj.find((el) => el.type === "pcb_board");
  const bw = board ? (num(board.width) ?? 40) : 40;
  const bh = board ? (num(board.height) ?? 30) : 30;

  const mainTsx = `// Importato da KiCad (${files.map((f) => f.path).join(", ")})
// ${componentLines.length} componenti, ${traceLines.length} connessioni
export default () => (
  <board width="${r3(bw)}mm" height="${r3(bh)}mm" autorouter="auto_cloud">
${componentLines.join("\n")}
${netLines.join("\n")}
${traceLines.join("\n")}
  </board>
)
`;

  return {
    fsMap: { "main.tsx": mainTsx },
    stats,
    warnings,
    components: componentLines.length,
    traces: traceLines.length,
  };
}
