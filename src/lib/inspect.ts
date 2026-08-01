/**
 * Extracts from the Circuit JSON the information a CAD shows in its panels:
 * errors with position, components with coordinates and nets, distances.
 * All client-side on data already validated by the server.
 */

import { metaOf, readComponentMeta } from "./component-meta";
import { inferRoles } from "./component-roles";

export interface InspectIssue {
  id: string;
  kind: "error" | "warning";
  type: string;
  message: string;
  /** position on the board, when the element carries it */
  x: number | null;
  y: number | null;
}

export interface InspectComponent {
  id: string;
  name: string;
  footprint: string | null;
  value: string | null;
  x: number | null;
  y: number | null;
  layer: string | null;
  nets: string[];
  /** number of pins of the component */
  pins: number;
  /** supplier code, e.g. LCSC C14663 */
  supplier: string | null;
  /** component datasheet, when the supplier exposes it */
  datasheetUrl: string | null;
  ftype: string | null;
  /** what it is and why it is there, inferred from how it is connected */
  role: string | null;
  why: string | null;
  /**
   * What the designer WROTE about this component in the source.
   * It wins over role/why, which are inferred: an inference from the topology
   * does not know that a library <chip> is a 16 MHz crystal, the author does.
   */
  description: string | null;
  /** what it is exactly: crystal, ldo, psram... */
  tags: string | null;
  /** which part of the board it belongs to */
  domain: string | null;
  /** real footprint on the board, in mm */
  widthMm: number | null;
  heightMm: number | null;
}

type El = Record<string, unknown>;

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null;

export function extractIssues(circuitJson: unknown[] | null): InspectIssue[] {
  if (!circuitJson) return [];
  const out: InspectIssue[] = [];
  for (const raw of circuitJson as El[]) {
    const type = String(raw?.type ?? "");
    if (!type.endsWith("_error") && !type.endsWith("_warning")) continue;
    const center = (raw.center ?? {}) as { x?: number; y?: number };
    out.push({
      id: String(raw.pcb_error_id ?? raw.source_error_id ?? `${type}-${out.length}`),
      kind: type.endsWith("_error") ? "error" : "warning",
      type,
      message: String(raw.message ?? raw.error_type ?? type),
      x: num(raw.x) ?? num(center.x),
      y: num(raw.y) ?? num(center.y),
    });
  }
  return out;
}

export function extractComponents(
  circuitJson: unknown[] | null,
  /**
   * The project sources. Without them, description/tags/domain stay empty:
   * tscircuit accepts those props but does not carry them into the Circuit
   * JSON, so the only place they exist is the code.
   */
  projectFiles: Record<string, string> = {},
): InspectComponent[] {
  if (!circuitJson) return [];
  const elements = circuitJson as El[];
  const roles = inferRoles(circuitJson);
  const meta = readComponentMeta(projectFiles);

  // name/value live on source_component, position on pcb_component
  const sources = new Map<string, El>();
  for (const el of elements) {
    if (el.type === "source_component" && el.source_component_id) {
      sources.set(String(el.source_component_id), el);
    }
  }

  // port -> nets, to list the connections of each component
  const portToNets = new Map<string, Set<string>>();
  const netNames = new Map<string, string>();
  for (const el of elements) {
    if (el.type === "source_net" && el.source_net_id) {
      netNames.set(String(el.source_net_id), String(el.name ?? "net"));
    }
  }
  for (const el of elements) {
    if (el.type !== "source_trace") continue;
    const label =
      (el.connected_source_net_ids as string[] | undefined)
        ?.map((id) => netNames.get(id))
        .filter(Boolean)
        .join(", ") || String(el.display_name ?? "");
    for (const portId of (el.connected_source_port_ids as string[] | undefined) ?? []) {
      if (!portToNets.has(portId)) portToNets.set(portId, new Set());
      if (label) portToNets.get(portId)!.add(label.slice(0, 40));
    }
  }
  const portsByComponent = new Map<string, string[]>();
  for (const el of elements) {
    if (el.type !== "source_port" || !el.source_component_id) continue;
    const compId = String(el.source_component_id);
    const list = portsByComponent.get(compId) ?? [];
    list.push(String(el.source_port_id));
    portsByComponent.set(compId, list);
  }

  const out: InspectComponent[] = [];
  for (const el of elements) {
    if (el.type !== "pcb_component" || !el.source_component_id) continue;
    const compId = String(el.source_component_id);
    const source = sources.get(compId);
    const center = (el.center ?? {}) as { x?: number; y?: number };
    const nets = new Set<string>();
    for (const portId of portsByComponent.get(compId) ?? []) {
      for (const n of portToNets.get(portId) ?? []) nets.add(n);
    }
    out.push({
      id: String(el.pcb_component_id ?? compId),
      name: String(source?.name ?? "?"),
      // the container lives on pcb_component or, for chips, on the source
      footprint: String(el.footprinter_string ?? source?.footprinter_string ?? "") || null,
      value: source?.display_value ? String(source.display_value) : null,
      x: num(center.x),
      y: num(center.y),
      layer: el.layer ? String(el.layer) : null,
      nets: [...nets].sort(),
      pins: (portsByComponent.get(compId) ?? []).length,
      supplier: supplierCode(source),
      datasheetUrl: datasheetUrl(supplierCode(source)),
      ftype: source?.ftype ? String(source.ftype).replace(/^simple_/, "") : null,
      role: roles.get(String(source?.name ?? ""))?.role ?? null,
      why: roles.get(String(source?.name ?? ""))?.why ?? null,
      description: metaOf(meta, String(source?.name ?? "")).description,
      tags: metaOf(meta, String(source?.name ?? "")).tags,
      domain: metaOf(meta, String(source?.name ?? "")).domain,
      widthMm: num(el.width),
      heightMm: num(el.height),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/** first supplier code declared on the component (usually LCSC) */
function supplierCode(source: El | undefined): string | null {
  const map = source?.supplier_part_numbers as Record<string, unknown> | undefined;
  if (!map) return null;
  for (const value of Object.values(map)) {
    const code = Array.isArray(value) ? value[0] : value;
    if (code) return String(code);
  }
  return null;
}

/**
 * LCSC publishes the datasheet on the component page: we link that one
 * instead of the PDF, which changes URL at every revision.
 */
function datasheetUrl(supplier: string | null): string | null {
  if (!supplier) return null;
  return /^C\d+$/i.test(supplier)
    ? `https://www.lcsc.com/product-detail/${supplier}.html`
    : null;
}

/** center-to-center distance in mm between two components */
export function distanceMm(a: InspectComponent, b: InspectComponent): number | null {
  if (a.x === null || a.y === null || b.x === null || b.y === null) return null;
  return Math.round(Math.hypot(a.x - b.x, a.y - b.y) * 100) / 100;
}
