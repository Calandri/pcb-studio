/**
 * Estrae dal Circuit JSON le informazioni che un CAD mostra nei suoi pannelli:
 * errori con posizione, componenti con coordinate e reti, distanze.
 * Tutto client-side sui dati gia' validati dal server.
 */

export interface InspectIssue {
  id: string;
  kind: "error" | "warning";
  type: string;
  message: string;
  /** posizione sulla scheda, quando l'elemento la porta con se' */
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
  /** numero di piedini del componente */
  pins: number;
  /** codice del fornitore, es. LCSC C14663 */
  supplier: string | null;
  /** scheda tecnica del componente, quando il fornitore la espone */
  datasheetUrl: string | null;
  ftype: string | null;
  /** ingombro reale sulla scheda, in mm */
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

export function extractComponents(circuitJson: unknown[] | null): InspectComponent[] {
  if (!circuitJson) return [];
  const elements = circuitJson as El[];

  // nome/valore stanno su source_component, posizione su pcb_component
  const sources = new Map<string, El>();
  for (const el of elements) {
    if (el.type === "source_component" && el.source_component_id) {
      sources.set(String(el.source_component_id), el);
    }
  }

  // porta -> reti, per elencare i collegamenti di ogni componente
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
      // il contenitore sta su pcb_component o, per i chip, sul source
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
      widthMm: num(el.width),
      heightMm: num(el.height),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/** primo codice fornitore dichiarato sul componente (di norma LCSC) */
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
 * LCSC pubblica la scheda tecnica sulla pagina del componente: si linka quella
 * invece del PDF, che cambia URL a ogni revisione.
 */
function datasheetUrl(supplier: string | null): string | null {
  if (!supplier) return null;
  return /^C\d+$/i.test(supplier)
    ? `https://www.lcsc.com/product-detail/${supplier}.html`
    : null;
}

/** distanza centro-centro in mm fra due componenti */
export function distanceMm(a: InspectComponent, b: InspectComponent): number | null {
  if (a.x === null || a.y === null || b.x === null || b.y === null) return null;
  return Math.round(Math.hypot(a.x - b.x, a.y - b.y) * 100) / 100;
}
