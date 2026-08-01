/**
 * Electrical rules (ERC) on the SCHEMATIC, twin of drc.ts (manufacturability)
 * and prc.ts (operation). Here we look at the electrical drawing: pins left
 * unconnected, nets that touch a single node, two sources facing each other
 * on the same net, repeated designators.
 *
 * These are the errors that pass every geometric check — the board is
 * manufactured just fine and does not work — so they must be reported before
 * routing, not after.
 *
 * LLM-first: nothing is corrected here, we produce data for the model's
 * self-correction loop.
 */

export type ErcRule =
  | "unconnected_pin"
  | "single_node_net"
  | "conflicting_sources"
  | "duplicate_designator"
  | "do_not_connect";

export interface ErcViolation {
  rule: ErcRule;
  severity: "warn" | "fail";
  message: string;
}

export interface ErcReport {
  violations: ErcViolation[];
  counts: Record<ErcRule, number>;
  /** schematic nets with role and effective width on the copper */
  nets: Array<{
    name: string;
    role: "potenza" | "massa" | "segnale";
    nodes: number;
    widthMm: number | null;
    onPlane: string | null;
  }>;
}

interface El {
  type: string;
  [key: string]: unknown;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

export function emptyErcReport(): ErcReport {
  return {
    violations: [],
    counts: {
      unconnected_pin: 0,
      single_node_net: 0,
      conflicting_sources: 0,
      duplicate_designator: 0,
      do_not_connect: 0,
    },
    nets: [],
  };
}

function netRole(name: string): "potenza" | "massa" | "segnale" {
  if (/^(gnd|agnd|dgnd|vss)\b/i.test(name)) return "massa";
  if (/^(v|p\d|3v3|5v|vbat|vcc|vdd|vin|vout|vbus)/i.test(name)) return "potenza";
  return "segnale";
}

export function runErcChecks(circuitJson: El[]): ErcReport {
  const report = emptyErcReport();
  const push = (rule: ErcRule, severity: "warn" | "fail", message: string) => {
    report.counts[rule] += 1;
    if (report.violations.length < 200) report.violations.push({ rule, severity, message });
  };

  const components = new Map<string, El>();
  for (const el of circuitJson) {
    if (el.type === "source_component" && el.source_component_id) {
      components.set(String(el.source_component_id), el);
    }
  }
  const nameOf = (componentId: unknown): string =>
    String(components.get(String(componentId ?? ""))?.name ?? "?");

  const ports = circuitJson.filter((el) => el.type === "source_port");
  const traces = circuitJson.filter((el) => el.type === "source_trace");
  const nets = circuitJson.filter((el) => el.type === "source_net");

  // port -> connectivity group
  const groupOfPort = new Map<string, string>();
  const portsInGroup = new Map<string, string[]>();
  for (const trace of traces) {
    const key = String(
      trace.subcircuit_connectivity_map_key ?? trace.source_trace_id ?? "",
    );
    for (const pid of (trace.connected_source_port_ids as string[] | undefined) ?? []) {
      groupOfPort.set(pid, key);
      const list = portsInGroup.get(key) ?? [];
      if (!list.includes(pid)) list.push(pid);
      portsInGroup.set(key, list);
    }
  }

  // --- 1. unconnected pins (and violated do_not_connect)
  for (const port of ports) {
    const id = String(port.source_port_id ?? "");
    const connected = groupOfPort.has(id);
    const label = `${nameOf(port.source_component_id)}.${String(port.name ?? "pin")}`;
    if (!connected) {
      if (port.must_be_connected) {
        push("unconnected_pin", "fail", `${label} deve essere collegato e non lo è`);
      } else if (!port.do_not_connect) {
        push("unconnected_pin", "warn", `${label} non è collegato a nulla`);
      }
    } else if (port.do_not_connect) {
      push("do_not_connect", "fail", `${label} è marcato «non collegare» ma ha un filo`);
    }
  }

  // --- 2. single-node net: a wire that goes nowhere
  for (const [key, list] of portsInGroup) {
    if (list.length >= 2) continue;
    const only = list[0];
    const port = ports.find((p) => String(p.source_port_id ?? "") === only);
    const label = port
      ? `${nameOf(port.source_component_id)}.${String(port.name ?? "pin")}`
      : key;
    push("single_node_net", "fail", `La net di ${label} tocca un solo piedino`);
  }

  // --- 3. two sources on the same net
  for (const [key, list] of portsInGroup) {
    const sources = list
      .map((id) => ports.find((p) => String(p.source_port_id ?? "") === id))
      .filter(
        (p): p is El =>
          Boolean(p) && Boolean(p!.provides_power || p!.provides_voltage),
      );
    if (sources.length < 2) continue;
    const labels = sources
      .map((p) => `${nameOf(p.source_component_id)}.${String(p.name ?? "pin")}`)
      .join(", ");
    push(
      "conflicting_sources",
      "fail",
      `Due sorgenti sulla stessa net (${key}): ${labels}`,
    );
  }

  // --- 4. duplicate designators
  const byName = new Map<string, number>();
  for (const component of components.values()) {
    const name = String(component.name ?? "");
    if (!name) continue;
    byName.set(name, (byName.get(name) ?? 0) + 1);
  }
  for (const [name, count] of byName) {
    if (count > 1) {
      push("duplicate_designator", "fail", `La sigla ${name} è usata ${count} volte`);
    }
  }

  // --- schematic nets, with the real width used on the copper
  const netNames = new Map<string, string>();
  for (const net of nets) {
    if (net.source_net_id) netNames.set(String(net.source_net_id), String(net.name ?? "net"));
  }
  const widthByGroup = new Map<string, number>();
  for (const el of circuitJson) {
    if (el.type !== "pcb_trace") continue;
    const key = String(el.subcircuit_connectivity_map_key ?? "");
    if (!key) continue;
    for (const p of (el.route as Array<Record<string, unknown>> | undefined) ?? []) {
      const w = num(p.width);
      if (w !== null) widthByGroup.set(key, Math.max(widthByGroup.get(key) ?? 0, w));
    }
  }
  const planeOfNet = new Map<string, string>();
  for (const el of circuitJson) {
    if (el.type !== "pcb_copper_pour") continue;
    const net = String(el.connects_to ?? "").replace(/^net\./, "");
    if (net) planeOfNet.set(net, String(el.layer ?? ""));
  }

  for (const trace of traces) {
    const key = String(
      trace.subcircuit_connectivity_map_key ?? trace.source_trace_id ?? "",
    );
    const name =
      ((trace.connected_source_net_ids as string[] | undefined) ?? [])
        .map((id) => netNames.get(id))
        .filter(Boolean)[0] ?? null;
    if (!name) continue;
    if (report.nets.some((n) => n.name === name)) continue;
    report.nets.push({
      name,
      role: netRole(name),
      nodes: (portsInGroup.get(key) ?? []).length,
      widthMm: widthByGroup.has(key)
        ? Math.round(widthByGroup.get(key)! * 1000) / 1000
        : null,
      onPlane: planeOfNet.get(name) ?? null,
    });
  }
  report.nets.sort(
    (a, b) =>
      (a.role === "segnale" ? 1 : 0) - (b.role === "segnale" ? 1 : 0) ||
      a.name.localeCompare(b.name),
  );

  return report;
}
