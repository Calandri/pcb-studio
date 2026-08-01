/**
 * PRC — "poor man's Physics Rule Checks" (Fase 3.e): deterministic electrical
 * checks on the compiled Circuit JSON. DRC says the board can be FABRICATED;
 * these checks say whether it has a chance of WORKING: decoupling close to
 * the IC it serves, no dead copper pour islands, return-path vias at
 * connectors, power traces actually wide.
 *
 * Everything is geometry + connectivity maps from the Circuit JSON — no
 * simulation, no ML. Violations are data for the model's self-correction
 * loop (LLM-first: the model decides what to fix).
 */

import { eMassa, ePotenza } from "./net-roles";

export interface PrcViolation {
  rule: "decoupling_distance" | "pour_island" | "return_via_connector" | "power_trace_width";
  severity: "warn" | "fail";
  message: string;
  x?: number;
  y?: number;
}

const DECOUPLING_MAX_MM = 3;
const RETURN_VIA_MAX_MM = 2;
const POWER_TRACE_MIN_WIDTH_MM = 0.4;

/*
 * Ground and supplies are recognised by the shared classifier, not by a regex
 * of our own: the two anchored patterns that lived here demanded a bare name,
 * so on a board whose ground net is called `GND_2` and whose rails are
 * `P3V3_MCU` and `VBAT_2` — which is every imported board — none of the checks
 * below ever ran, and the report came back clean without having looked.
 */

interface El {
  type: string;
  [key: string]: unknown;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

const PASSIVE_FTYPES = new Set([
  "simple_resistor",
  "simple_capacitor",
  "simple_led",
  "simple_diode",
  "simple_transistor",
  "simple_mosfet",
  "simple_pinheader",
  "simple_crystal",
  "simple_resonator",
  "simple_fuse",
  "simple_inductor",
  "simple_push_button",
  "simple_switch",
]);

interface Maps {
  netNameById: Map<string, string>;
  groupNet: Map<string, string>;
  portGroup: Map<string, string>;
  pcbPortBySource: Map<string, El>;
  padByPcbPort: Map<string, El>;
  groupOfPad: (pad: El) => string | null;
}

function buildMaps(circuitJson: El[]): Maps {
  const netNameById = new Map<string, string>();
  for (const el of circuitJson) {
    if (el.type === "source_net") {
      netNameById.set(String(el.source_net_id ?? ""), String(el.name ?? "?"));
    }
  }
  const groupNet = new Map<string, string>();
  const portGroup = new Map<string, string>();
  for (const el of circuitJson) {
    if (el.type !== "source_trace") continue;
    const key = String(el.subcircuit_connectivity_map_key ?? el.source_trace_id ?? "");
    const netIds = (el.connected_source_net_ids as string[] | undefined) ?? [];
    const netName = netIds.length ? netNameById.get(String(netIds[0])) : undefined;
    if (netName) groupNet.set(key, netName);
    for (const pid of (el.connected_source_port_ids as string[] | undefined) ?? []) {
      portGroup.set(pid, key);
    }
  }
  const pcbPortBySource = new Map<string, El>();
  const sourceByPcbPortId = new Map<string, string>();
  for (const el of circuitJson) {
    if (el.type === "pcb_port" && el.source_port_id) {
      pcbPortBySource.set(String(el.source_port_id), el);
      sourceByPcbPortId.set(String(el.pcb_port_id ?? ""), String(el.source_port_id));
    }
  }
  const padByPcbPort = new Map<string, El>();
  for (const el of circuitJson) {
    if (
      (el.type === "pcb_smtpad" || el.type === "pcb_plated_hole" || el.type === "pcb_via") &&
      el.pcb_port_id
    ) {
      // spliced vias inherit the pad's pcb_port_id: never let a via shadow the pad
      if (el.type === "pcb_via" && padByPcbPort.has(String(el.pcb_port_id))) continue;
      padByPcbPort.set(String(el.pcb_port_id), el);
    }
  }
  const groupOfPad = (pad: El): string | null => {
    const sourcePortId = sourceByPcbPortId.get(String(pad.pcb_port_id ?? ""));
    return sourcePortId ? (portGroup.get(sourcePortId) ?? null) : null;
  };
  return { netNameById, groupNet, portGroup, pcbPortBySource, padByPcbPort, groupOfPad };
}

function padsOfComponent(circuitJson: El[], sourceComponentId: string, maps: Maps): El[] {
  const pads: El[] = [];
  for (const el of circuitJson) {
    if (el.type !== "source_port" || el.source_component_id !== sourceComponentId) continue;
    const pad = maps.pcbPortBySource.get(String(el.source_port_id));
    if (pad) {
      const realPad = maps.padByPcbPort.get(String(pad.pcb_port_id ?? ""));
      if (realPad) pads.push(realPad);
    }
  }
  return pads;
}

function netNameOfPad(pad: El, maps: Maps): string | null {
  const group = maps.groupOfPad(pad);
  return group ? (maps.groupNet.get(group) ?? null) : null;
}

function pointInPolygon(x: number, y: number, points: Array<{ x: number; y: number }>): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i].x;
    const yi = points[i].y;
    const xj = points[j].x;
    const yj = points[j].y;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function runPrcChecks(circuitJson: El[]): PrcViolation[] {
  const violations: PrcViolation[] = [];
  const push = (v: PrcViolation) => {
    if (violations.filter((x) => x.rule === v.rule).length < 15) violations.push(v);
  };
  const maps = buildMaps(circuitJson);

  // --- 1. decoupling capacitors must sit next to the IC power pin they serve
  for (const comp of circuitJson) {
    if (comp.type !== "source_component") continue;
    if (String(comp.ftype ?? "") !== "simple_capacitor") continue;
    const valueText = String(comp.display_value ?? comp.capacitance ?? "");
    // capacitance arrives as numeric farads ("1e-7") or with SI suffix ("100nF")
    let farads: number | null = null;
    const suffix = /([\d.]+)\s*(p|n|u|µ)f/i.exec(valueText);
    if (suffix) {
      const mult: Record<string, number> = { p: 1e-12, n: 1e-9, u: 1e-6, "µ": 1e-6 };
      farads = Number(suffix[1]) * (mult[suffix[2].toLowerCase()] ?? 0);
    } else if (/^[\d.eE+-]+$/.test(valueText)) {
      farads = Number(valueText);
    }
    if (!farads || farads >= 1e-6) continue; // bulk cap, less placement-critical
    const fmtFarads = (f: number): string =>
      f >= 1e-6 ? `${f / 1e-6}uF` : f >= 1e-9 ? `${Math.round(f / 1e-9)}nF` : `${Math.round(f / 1e-12)}pF`;
    const valueLabel = /^[\d.eE+-]+$/.test(valueText) ? fmtFarads(farads) : valueText;
    const pads = padsOfComponent(circuitJson, String(comp.source_component_id), maps);
    if (pads.length !== 2) continue;
    const netA = netNameOfPad(pads[0], maps);
    const netB = netNameOfPad(pads[1], maps);
    const powerNet = [netA, netB].find((n) => n && ePotenza(n));
    const gndNet = [netA, netB].find((n) => n && eMassa(n));
    if (!powerNet || !gndNet) continue; // not a decoupling cap
    const powerPad = netNameOfPad(pads[0], maps) === powerNet ? pads[0] : pads[1];
    const px = num(powerPad.x);
    const py = num(powerPad.y);
    if (px === null || py === null) continue;

    // nearest IC pad on the same power net
    let best: { name: string; d: number } | null = null;
    for (const ic of circuitJson) {
      if (ic.type !== "source_component") continue;
      const ftype = String(ic.ftype ?? "");
      if (PASSIVE_FTYPES.has(ftype)) continue;
      for (const pad of padsOfComponent(circuitJson, String(ic.source_component_id), maps)) {
        if (netNameOfPad(pad, maps) !== powerNet) continue;
        const ix = num(pad.x);
        const iy = num(pad.y);
        if (ix === null || iy === null) continue;
        const d = Math.hypot(ix - px, iy - py);
        if (!best || d < best.d) best = { name: String(ic.name ?? "?"), d };
      }
    }
    if (best && best.d > DECOUPLING_MAX_MM) {
      push({
        rule: "decoupling_distance",
        severity: "warn",
        message: `${String(comp.name)} (${valueLabel}) is ${best.d.toFixed(1)}mm from the nearest ${powerNet} pin (${best.name}) — decoupling should be within ${DECOUPLING_MAX_MM}mm`,
        x: px,
        y: py,
      });
    }
  }

  // --- 2. copper pour islands: a pour with no same-net pad/via inside is dead copper
  for (const pour of circuitJson) {
    if (pour.type !== "pcb_copper_pour" || !pour.source_net_id) continue;
    const netName = maps.netNameById.get(String(pour.source_net_id));
    if (!netName) continue;
    const layer = String(
      typeof pour.layer === "object" && pour.layer !== null
        ? (pour.layer as { name?: string }).name
        : pour.layer,
    );
    const contains = (x: number, y: number): boolean => {
      if (pour.shape === "rect") {
        const c = (pour.center as { x?: number; y?: number } | undefined) ?? {};
        const cx = num(c.x) ?? 0;
        const cy = num(c.y) ?? 0;
        const w = num(pour.width) ?? 0;
        const h = num(pour.height) ?? 0;
        return Math.abs(x - cx) <= w / 2 && Math.abs(y - cy) <= h / 2;
      }
      if (pour.shape === "polygon" && Array.isArray(pour.points)) {
        return pointInPolygon(
          x,
          y,
          (pour.points as Array<{ x: number; y: number }>).map((p) => ({
            x: Number(p.x),
            y: Number(p.y),
          })),
        );
      }
      if (pour.shape === "brep") {
        const ring = (pour.brep_shape as { outer_ring?: { vertices?: Array<{ x: number; y: number }> } })
          ?.outer_ring?.vertices;
        if (ring && ring.length >= 3) {
          return pointInPolygon(x, y, ring.map((p) => ({ x: Number(p.x), y: Number(p.y) })));
        }
      }
      return true; // unknown shapes: don't flag
    };
    let connected = false;
    for (const el of circuitJson) {
      if (connected) break;
      const isCopper =
        el.type === "pcb_smtpad" || el.type === "pcb_plated_hole" || el.type === "pcb_via";
      if (!isCopper) continue;
      const x = num(el.x);
      const y = num(el.y);
      if (x === null || y === null) continue;
      if (netNameOfPad(el, maps) !== netName) continue;
      if (contains(x, y)) connected = true;
    }
    if (!connected) {
      const c = (pour.center as { x?: number; y?: number } | undefined) ?? {};
      push({
        rule: "pour_island",
        severity: "fail",
        message: `copper pour on ${layer} (${netName}) has no ${netName} pad or via inside — dead copper island`,
        x: num(c.x) ?? undefined,
        y: num(c.y) ?? undefined,
      });
    }
  }

  // --- 3. return-path vias at connectors (multilayer boards with a GND plane)
  const board = circuitJson.find((el) => el.type === "pcb_board");
  const numLayers = board ? (num(board.num_layers) ?? 2) : 2;
  if (numLayers >= 4) {
    const vias = circuitJson.filter((el) => el.type === "pcb_via");
    for (const comp of circuitJson) {
      if (comp.type !== "source_component") continue;
      const ftype = String(comp.ftype ?? "");
      const name = String(comp.name ?? "");
      if (ftype !== "simple_pinheader" && !/^J\d/.test(name)) continue;
      for (const pad of padsOfComponent(circuitJson, String(comp.source_component_id), maps)) {
        const net = netNameOfPad(pad, maps);
        if (!net || !eMassa(net)) continue;
        const px = num(pad.x);
        const py = num(pad.y);
        if (px === null || py === null) continue;
        const near = vias.some((via) => {
          const vx = num(via.x);
          const vy = num(via.y);
          if (vx === null || vy === null) return false;
          if (Math.hypot(vx - px, vy - py) > RETURN_VIA_MAX_MM) return false;
          let viaNet = netNameOfPad(via, maps);
          if (!viaNet) {
            // core vias have no pcb_port_id: infer the net from the nearest pad
            let bestD = 0.5;
            for (const el of circuitJson) {
              if (el.type !== "pcb_smtpad" && el.type !== "pcb_plated_hole") continue;
              const x2 = num(el.x);
              const y2 = num(el.y);
              if (x2 === null || y2 === null) continue;
              const d = Math.hypot(x2 - vx, y2 - vy);
              if (d < bestD) {
                bestD = d;
                viaNet = netNameOfPad(el, maps);
              }
            }
          }
          return viaNet === net;
        });
        if (!near) {
          push({
            rule: "return_via_connector",
            severity: "warn",
            message: `connector ${name} GND pad has no ${net} via within ${RETURN_VIA_MAX_MM}mm — weak return path on a ${numLayers}-layer board`,
            x: px,
            y: py,
          });
        }
      }
    }
  }

  // --- 4. power traces must actually be wide (house style: 0.5mm target)
  for (const el of circuitJson) {
    if (el.type !== "pcb_trace") continue;
    let net: string | null = null;
    if (el.source_trace_id) {
      net = maps.groupNet.get(String(el.source_trace_id)) ?? null;
    }
    if (!net) {
      // spliced traces (variant engine): infer the net from a touched pad
      const route = (el.route as Array<Record<string, unknown>> | undefined) ?? [];
      outer: for (const p of route) {
        if (p.route_type !== "wire") continue;
        for (const el2 of circuitJson) {
          if (el2.type !== "pcb_smtpad" && el2.type !== "pcb_plated_hole") continue;
          const x2 = num(el2.x);
          const y2 = num(el2.y);
          if (x2 === null || y2 === null) continue;
          if (Math.abs(x2 - Number(p.x)) <= 0.4 && Math.abs(y2 - Number(p.y)) <= 0.4) {
            net = netNameOfPad(el2, maps);
            break outer;
          }
        }
      }
    }
    if (!net || !ePotenza(net)) continue;
    const route = (el.route as Array<Record<string, unknown>> | undefined) ?? [];
    const widths = route
      .filter((p) => p.route_type === "wire")
      .map((p) => num(p.width))
      .filter((w): w is number => w !== null);
    if (!widths.length) continue;
    const minW = Math.min(...widths);
    if (minW < POWER_TRACE_MIN_WIDTH_MM - 1e-6) {
      const first = route.find((p) => p.route_type === "wire");
      push({
        rule: "power_trace_width",
        severity: "fail",
        message: `power net ${net} routed at ${minW}mm (min ${POWER_TRACE_MIN_WIDTH_MM}mm, house style 0.5mm)`,
        x: num(first?.x) ?? undefined,
        y: num(first?.y) ?? undefined,
      });
    }
  }

  return violations;
}
