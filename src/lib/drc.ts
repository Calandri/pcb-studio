import { DEFAULT_DESIGN_RULES, type DesignRules } from "./design-rules";

export interface DrcViolation {
  rule: string;
  message: string;
}

interface El {
  type: string;
  [key: string]: unknown;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

interface Box {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  layer: string | null;
  label: string;
  group: string | null;
}

function boxDistance(a: Box, b: Box): number {
  const dx = Math.max(a.minX - b.maxX, b.minX - a.maxX, 0);
  const dy = Math.max(a.minY - b.maxY, b.minY - a.maxY, 0);
  return Math.hypot(dx, dy);
}

/**
 * DRC deterministico su Circuit JSON (bbox-based, conservativo):
 * larghezze piste, dimensioni via, distanza dal bordo, clearance pad-pad tra
 * net diverse. La clearance pista-pista resta delegata all'autorouter
 * (traceClearance): qui si verificano gli elementi statici.
 */
export function runDrcChecks(
  circuitJson: El[],
  rules: DesignRules = DEFAULT_DESIGN_RULES,
): DrcViolation[] {
  const raw: DrcViolation[] = [];
  const push = (rule: string, message: string) => {
    if (raw.length < 500) raw.push({ rule, message });
  };

  // --- mappa porta -> gruppo di connettivita' (per sapere se due pad sono sulla stessa net)
  const portGroup = new Map<string, string>();
  for (const el of circuitJson) {
    if (el.type !== "source_trace") continue;
    const key = String(el.subcircuit_connectivity_map_key ?? el.source_trace_id ?? "");
    for (const pid of (el.connected_source_port_ids as string[] | undefined) ?? []) {
      portGroup.set(pid, key);
    }
  }
  const pcbPortToSource = new Map<string, string>();
  for (const el of circuitJson) {
    if (el.type === "pcb_port" && el.pcb_port_id && el.source_port_id) {
      pcbPortToSource.set(String(el.pcb_port_id), String(el.source_port_id));
    }
  }
  const groupOfPcbPort = (pcbPortId: unknown): string | null => {
    const sp = pcbPortToSource.get(String(pcbPortId ?? ""));
    return sp ? (portGroup.get(sp) ?? null) : null;
  };

  // --- 1. larghezza piste
  for (const el of circuitJson) {
    if (el.type !== "pcb_trace") continue;
    const route = (el.route as Array<{ width?: number }> | undefined) ?? [];
    const widths = route.map((p) => num(p.width)).filter((w): w is number => w !== null);
    const minW = widths.length ? Math.min(...widths) : null;
    if (minW !== null && minW < rules.minTraceWidthMm - 1e-6) {
      push(
        "min_trace_width",
        `Trace ${el.pcb_trace_id} width ${minW}mm < min ${rules.minTraceWidthMm}mm`,
      );
    }
  }

  // --- 2. dimensioni via / fori
  for (const el of circuitJson) {
    if (el.type !== "pcb_via" && el.type !== "pcb_plated_hole") continue;
    const hole = num(el.hole_diameter);
    const outer = num(el.outer_diameter);
    if (hole !== null && hole < rules.minViaHoleMm - 1e-6) {
      push("min_via_hole", `${el.type} hole ${hole}mm < min ${rules.minViaHoleMm}mm`);
    }
    if (el.type === "pcb_via" && outer !== null && outer < rules.minViaDiameterMm - 1e-6) {
      push("min_via_diameter", `via pad ${outer}mm < min ${rules.minViaDiameterMm}mm`);
    }
  }

  // --- bbox di pad e fori per bordo scheda + clearance
  const boxes: Box[] = [];
  for (const el of circuitJson) {
    if (el.type === "pcb_smtpad") {
      const x = num(el.x);
      const y = num(el.y);
      if (x === null || y === null) continue;
      const w = num(el.width) ?? (num(el.radius) ?? 0) * 2;
      const h = num(el.height) ?? (num(el.radius) ?? 0) * 2;
      boxes.push({
        minX: x - w / 2,
        maxX: x + w / 2,
        minY: y - h / 2,
        maxY: y + h / 2,
        layer: el.layer ? String(el.layer) : null,
        label: String(el.pcb_smtpad_id ?? "pad"),
        group: groupOfPcbPort(el.pcb_port_id),
      });
    } else if (el.type === "pcb_plated_hole" || el.type === "pcb_via") {
      const x = num(el.x);
      const y = num(el.y);
      const d = num(el.outer_diameter) ?? num(el.hole_diameter);
      if (x === null || y === null || d === null) continue;
      boxes.push({
        minX: x - d / 2,
        maxX: x + d / 2,
        minY: y - d / 2,
        maxY: y + d / 2,
        layer: null, // attraversa tutti i layer
        label: String(el.pcb_via_id ?? el.pcb_plated_hole_id ?? el.type),
        group: groupOfPcbPort(el.pcb_port_id),
      });
    }
  }

  // --- 3. distanza dal bordo scheda
  const board = circuitJson.find((el) => el.type === "pcb_board");
  const bw = board ? num(board.width) : null;
  const bh = board ? num(board.height) : null;
  if (board && bw !== null && bh !== null) {
    const center = (board.center as { x?: number; y?: number } | undefined) ?? {};
    const cx = num(center.x) ?? 0;
    const cy = num(center.y) ?? 0;
    const m = rules.minBoardEdgeClearanceMm;
    for (const b of boxes) {
      if (
        b.minX < cx - bw / 2 + m - 1e-6 ||
        b.maxX > cx + bw / 2 - m + 1e-6 ||
        b.minY < cy - bh / 2 + m - 1e-6 ||
        b.maxY > cy + bh / 2 - m + 1e-6
      ) {
        push(
          "board_edge_clearance",
          `${b.label} closer than ${m}mm to the board edge`,
        );
      }
    }
  }

  // --- 4. clearance pad-pad tra net diverse (stesso layer o elemento passante)
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      if (a.layer && b.layer && a.layer !== b.layer) continue;
      if (a.group !== null && a.group === b.group) continue;
      const d = boxDistance(a, b);
      if (d < rules.minClearanceMm - 1e-6) {
        push(
          "pad_clearance",
          `${a.label} <-> ${b.label}: ${d.toFixed(3)}mm < min ${rules.minClearanceMm}mm`,
        );
      }
    }
  }

  // Le stesse violazioni si ripetono decine di volte (una per via, per pad...):
  // aggregarle per regola tiene il feedback all'LLM leggibile e corto.
  const byRule = new Map<string, DrcViolation[]>();
  for (const v of raw) {
    const list = byRule.get(v.rule) ?? [];
    list.push(v);
    byRule.set(v.rule, list);
  }
  const aggregated: DrcViolation[] = [];
  for (const [rule, list] of byRule) {
    if (list.length <= 3) {
      aggregated.push(...list);
    } else {
      aggregated.push({
        rule,
        message: `${list.length}x ${rule}: ${list[0].message} (and ${list.length - 1} more)`,
      });
    }
  }
  return aggregated;
}
