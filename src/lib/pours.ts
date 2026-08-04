/**
 * The poured copper, read as geometry.
 *
 * It lives apart because two different things need it and neither should own
 * it: the house rule that stitches the planes (house-rules.ts) and the check
 * that verifies they are stitched (drc.ts). Both need to answer one question —
 * "is this point inside the plane of this net, on this layer?" — and they must
 * answer it the same way, otherwise one adds vias the other keeps asking for.
 */

import { eMassa } from "./net-roles";

export interface PourShape {
  /** the net the plane belongs to */
  net: string;
  layer: string;
  /** outline, in board coordinates */
  outer: Array<{ x: number; y: number }>;
  /** the holes: the islands the pour leaves around pads and vias of other nets */
  holes: Array<Array<{ x: number; y: number }>>;
  /** bounding box, to discard a point without walking the whole outline */
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

type El = Record<string, unknown>;
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

const asPoints = (v: unknown): Array<{ x: number; y: number }> => {
  if (!Array.isArray(v)) return [];
  const out: Array<{ x: number; y: number }> = [];
  for (const p of v) {
    const x = num((p as { x?: unknown })?.x);
    const y = num((p as { y?: unknown })?.y);
    if (x !== null && y !== null) out.push({ x, y });
  }
  return out;
};

/** every pour on the board, with its geometry ready to be questioned */
export function readPours(circuitJson: unknown[]): PourShape[] {
  const out: PourShape[] = [];
  for (const raw of circuitJson as El[]) {
    if (raw.type !== "pcb_copper_pour") continue;
    const brep = raw.brep_shape as
      | {
          outer_ring?: { vertices?: unknown };
          inner_rings?: Array<{ vertices?: unknown }>;
        }
      | undefined;
    const outer = asPoints(brep?.outer_ring?.vertices);
    if (outer.length < 3) continue;
    const holes = (brep?.inner_rings ?? [])
      .map((r) => asPoints(r?.vertices))
      .filter((r) => r.length >= 3);
    const xs = outer.map((p) => p.x);
    const ys = outer.map((p) => p.y);
    out.push({
      net: String(raw.source_net_id ?? ""),
      layer: String(raw.layer ?? "inner1"),
      outer,
      holes,
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minY: Math.min(...ys),
      maxY: Math.max(...ys),
    });
  }
  return out;
}

/** point inside a ring: ray casting, the standard one */
function insideRing(x: number, y: number, ring: Array<{ x: number; y: number }>): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** whether the point is on the copper of this pour (holes excluded) */
export function insidePour(x: number, y: number, pour: PourShape): boolean {
  if (x < pour.minX || x > pour.maxX || y < pour.minY || y > pour.maxY) return false;
  if (!insideRing(x, y, pour.outer)) return false;
  return !pour.holes.some((h) => insideRing(x, y, h));
}

/**
 * Distance from the point to the nearest edge of the pour, negative if outside.
 *
 * Being inside is not enough for a stitching via: it must be inside with room
 * to spare, otherwise the via lands on the edge of the plane and the copper
 * around it is not enough to connect it.
 */
export function marginInsidePour(x: number, y: number, pour: PourShape): number {
  if (!insidePour(x, y, pour)) return -1;
  let best = Infinity;
  for (const ring of [pour.outer, ...pour.holes]) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      best = Math.min(best, distanceToSegment(x, y, ring[j], ring[i]));
    }
  }
  return best;
}

function distanceToSegment(
  x: number,
  y: number,
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return Math.hypot(x - a.x, y - a.y);
  const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len2));
  return Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy));
}

/**
 * Which nets have a plane and on which layers. The map answers the question
 * that decides whether a via is needed: "is there poured copper of this net on
 * THIS face?"
 */
export function pourLayersByNet(pours: PourShape[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const p of pours) {
    if (!p.net) continue;
    const set = out.get(p.net) ?? new Set<string>();
    set.add(p.layer);
    out.set(p.net, set);
  }
  return out;
}

/**
 * The pcb_ports whose net has a plane, and the net they belong to.
 *
 * It is read through the SOURCE TRACES that name a net, because the port
 * carries no net: the trace does. Reading only `connected_source_net_ids` on
 * the trace, though, is exactly the mistake that left ground wired — the
 * autorouter builds a spanning tree over ground (source_net_0_mst0, mst1...)
 * and those traces name only the PORTS they join, never the net. So whoever
 * had to throw away the ground copper found nothing to throw away, and the
 * ground stayed drawn with wires in the middle of the plane.
 */
export function planeServedPorts(
  circuitJson: unknown[],
  pours: PourShape[],
): Map<string, string> {
  const sorgente = planeServedSourcePorts(circuitJson, pours);
  const out = new Map<string, string>();
  for (const el of circuitJson as El[]) {
    if (el.type !== "pcb_port" || !el.pcb_port_id) continue;
    const net = sorgente.get(String(el.source_port_id ?? ""));
    if (net) out.set(String(el.pcb_port_id), net);
  }
  return out;
}

/**
 * The same thing, on the SOURCE ports: it is the form the traces speak, since
 * `connected_source_port_ids` holds source ports and not pcb ports. Mixing the
 * two is why the ground wires survived a removal pass that looked right: the
 * lookup never matched anything.
 */
export function planeServedSourcePorts(
  circuitJson: unknown[],
  pours: PourShape[],
): Map<string, string> {
  const nets = new Set(pours.map((p) => p.net).filter(Boolean));
  if (nets.size === 0) return new Map();
  const els = circuitJson as El[];

  /** source port -> net, from the traces that declare a net */
  const netOfSourcePort = new Map<string, string>();
  for (const el of els) {
    if (el.type !== "source_trace") continue;
    const suoi = ((el.connected_source_net_ids as unknown[] | undefined) ?? []).map(String);
    const net = suoi.find((n) => nets.has(n));
    if (!net) continue;
    for (const p of ((el.connected_source_port_ids as unknown[] | undefined) ?? []).map(String)) {
      netOfSourcePort.set(p, net);
    }
  }
  /*
   * Then it propagates: a trace joining two ports puts them on the same net
   * even if it names no net. It is what turns the spanning tree over ground
   * into "these fifty-three pads are all ground".
   */
  let grew = true;
  while (grew) {
    grew = false;
    for (const el of els) {
      if (el.type !== "source_trace") continue;
      const porte = ((el.connected_source_port_ids as unknown[] | undefined) ?? []).map(String);
      const noto = porte.map((p) => netOfSourcePort.get(p)).find(Boolean);
      if (!noto) continue;
      for (const p of porte) {
        if (!netOfSourcePort.has(p)) {
          netOfSourcePort.set(p, noto);
          grew = true;
        }
      }
    }
  }

  return netOfSourcePort;
}

/**
 * EVERY via on the board, wherever it is written.
 *
 * A via exists in two shapes: a `pcb_via` row, which is what the router leaves,
 * and a `via` point inside a trace's route, which is what hand-drawn and
 * imported copper produce (see manual-routes.ts). Reading only the first shape
 * means an imported board has no vias at all — six hundred and forty of them on
 * BAT_BS — so the stitching check declares its ground planes unconnected and the
 * pads next to a via adrift.
 *
 * The net comes from the connectivity key when there is one, and otherwise from
 * the source trace the copper implements.
 */
export function tutteLeVia(
  circuitJson: unknown[],
  netDiChiave: Map<string, string>,
): Array<{ x: number; y: number; net: string; facce: string[] }> {
  const els = circuitJson as El[];

  /** net name by source trace, for copper that carries no connectivity key */
  const nomeDiRete = new Map<string, string>();
  for (const el of els) {
    if (el.type === "source_net" && el.source_net_id) {
      nomeDiRete.set(String(el.source_net_id), String(el.source_net_id));
    }
  }
  const netDiSourceTrace = new Map<string, string>();
  for (const el of els) {
    if (el.type !== "source_trace" || !el.source_trace_id) continue;
    const reti = ((el.connected_source_net_ids as unknown[] | undefined) ?? []).map(String);
    if (reti[0]) netDiSourceTrace.set(String(el.source_trace_id), reti[0]);
  }

  /*
   * A THROUGH VIA CROSSES THE LAYERS IT PASSES BETWEEN.
   *
   * The hole is drilled through the board: a via that goes from top to bottom
   * touches the inner copper as well, whether anybody wrote it down or not. The
   * element carries only the two ends — from_layer and to_layer, which is all
   * the route point said — and reading it literally made the check declare that
   * two pours of one net, one on top and one on inner2, had no via joining
   * them, with six of them standing in both.
   */
  const facceDelloStack = ["top", "inner1", "inner2", "bottom"];
  const board = els.find((e) => e.type === "pcb_board");
  const strati = num(board?.num_layers) ?? 4;
  const attraversate = (facce: string[]): string[] => {
    if (strati < 3 || !facce.includes("top") || !facce.includes("bottom")) return facce;
    return facceDelloStack.slice(0, Math.min(strati, facceDelloStack.length));
  };

  const out: Array<{ x: number; y: number; net: string; facce: string[] }> = [];
  for (const el of els) {
    if (el.type === "pcb_via") {
      const x = num(el.x);
      const y = num(el.y);
      if (x === null || y === null) continue;
      out.push({
        x,
        y,
        net: netDiChiave.get(String(el.subcircuit_connectivity_map_key ?? "")) ?? "",
        facce: attraversate(((el.layers as unknown[] | undefined) ?? []).map(String)),
      });
      continue;
    }
    if (el.type !== "pcb_trace") continue;
    const net =
      netDiChiave.get(String(el.subcircuit_connectivity_map_key ?? "")) ??
      netDiSourceTrace.get(String(el.source_trace_id ?? "")) ??
      "";
    for (const p of (el.route as Array<Record<string, unknown>> | undefined) ?? []) {
      if (p.route_type !== "via") continue;
      const x = num(p.x);
      const y = num(p.y);
      if (x === null || y === null) continue;
      out.push({
        x,
        y,
        net,
        facce: attraversate(
          [String(p.from_layer ?? ""), String(p.to_layer ?? "")].filter(Boolean),
        ),
      });
    }
  }
  return out;
}

/**
 * The pads of a plane net that are NOT connected to it: neither immersed in the
 * plane of their own face nor with a via of their own net within reach of their
 * edge. As long as this list is
 * empty the traces of that net are copper in the middle of copper and can go;
 * if it is not, throwing them away would disconnect something.
 */
export function padsOffPlane(
  circuitJson: unknown[],
  pours: PourShape[],
  reachMm = 1,
): Array<{ pad: string; port: string; net: string; x: number; y: number }> {
  const served = planeServedPorts(circuitJson, pours);
  if (served.size === 0) return [];
  const els = circuitJson as El[];
  const netDiChiave = netOfViaKey(circuitJson, pours);
  /*
   * The ends of OUR tie stubs (pcb_trace_plane_*). A pad joined to its via by
   * one of these is connected however far the via ended up: on a crowded board
   * the via has to step out to find room, and measuring only "a via within a
   * millimetre" declared adrift a pad that had its own copper going straight
   * into the plane.
   */
  const capiDiCollegamento: Array<{ x: number; y: number }> = [];
  for (const el of els) {
    if (el.type !== "pcb_trace") continue;
    if (!String(el.pcb_trace_id ?? "").startsWith("pcb_trace_plane_")) continue;
    for (const p of ((el.route as Array<Record<string, unknown>> | undefined) ?? [])) {
      const x = num(p.x);
      const y = num(p.y);
      if (x !== null && y !== null) capiDiCollegamento.push({ x, y });
    }
  }
  const vias = tutteLeVia(circuitJson, netDiChiave);
  /** the name of each net, to tell a ground from a rail */
  const nomeDellaRete = new Map<string, string>();
  for (const el of els) {
    if (el.type !== "source_net") continue;
    nomeDellaRete.set(String(el.source_net_id ?? ""), String(el.name ?? ""));
  }
  /** every point of copper, with the net it belongs to: what touches a pad */
  const tratti: Array<{ x: number; y: number; layer: string; net: string }> = [];
  {
    const netDiTraccia = new Map<string, string>();
    for (const el of els) {
      if (el.type !== "source_trace") continue;
      const reti = ((el.connected_source_net_ids as unknown[] | undefined) ?? []).map(String);
      if (reti[0]) netDiTraccia.set(String(el.source_trace_id ?? ""), reti[0]);
    }
    for (const el of els) {
      if (el.type !== "pcb_trace") continue;
      const net =
        netDiChiave.get(String(el.subcircuit_connectivity_map_key ?? "")) ??
        netDiTraccia.get(String(el.source_trace_id ?? "")) ??
        "";
      if (!net) continue;
      for (const p of (el.route as Array<Record<string, unknown>> | undefined) ?? []) {
        const x = num(p.x);
        const y = num(p.y);
        if (x === null || y === null) continue;
        tratti.push({ x, y, layer: String(p.layer ?? ""), net });
      }
    }
  }

  const out: Array<{ pad: string; port: string; net: string; x: number; y: number }> = [];
  for (const el of els) {
    if (el.type !== "pcb_smtpad") continue;
    const net = served.get(String(el.pcb_port_id ?? ""));
    if (!net) continue;
    let x = num(el.x);
    let y = num(el.y);
    let hw = (num(el.width) ?? (num(el.radius) ?? 0) * 2) / 2;
    let hh = (num(el.height) ?? (num(el.radius) ?? 0) * 2) / 2;
    if (x === null || y === null) {
      const pts = asPoints(el.points);
      if (pts.length === 0) continue;
      const minX = Math.min(...pts.map((p) => p.x));
      const maxX = Math.max(...pts.map((p) => p.x));
      const minY = Math.min(...pts.map((p) => p.y));
      const maxY = Math.max(...pts.map((p) => p.y));
      x = (minX + maxX) / 2;
      y = (minY + maxY) / 2;
      hw = (maxX - minX) / 2;
      hh = (maxY - minY) / 2;
    }
    const layer = String(el.layer ?? "top");
    const immerso = pours.some((p) => p.net === net && p.layer === layer && insidePour(x, y, p));
    if (immerso) continue;
    /*
     * Only a via of the SAME net connects, and the distance is measured from the
     * pad's EDGE, not from its centre. On the microcontroller's power pads
     * (0,5 x 2,25 mm) the via sits correctly just outside the pad and yet came
     * out 1,625 mm from the centre: measured that way it looked far, and two
     * perfectly connected pads were reported as adrift.
     */
    const conVia = vias.some((v) => {
      if (v.net !== net) return false;
      const dx = Math.max(Math.abs(v.x - x) - hw, 0);
      const dy = Math.max(Math.abs(v.y - y) - hh, 0);
      return Math.hypot(dx, dy) < reachMm;
    });
    if (conVia) continue;
    // our own stub going into the pad: that copper reaches the plane by
    // construction, wherever the via had to step out to
    const conCollegamento = capiDiCollegamento.some(
      (c) => Math.abs(c.x - x) <= hw + 0.05 && Math.abs(c.y - y) <= hh + 0.05,
    );
    if (conCollegamento) continue;
    /*
     * A RAIL IS NOT A GROUND.
     *
     * This check exists for the return path: a ground pad wants the plane under
     * it or a via within reach, because the return current travels there and a
     * detour is an antenna. A supply rail is another matter — it is routed with
     * traces, and its pour is copper for the current, not a return path — so a
     * pad of P3V3 fed by its own trace is connected, full stop. Measured on an
     * imported board: nine reports, all of them rails, every one of them with
     * copper of its own net arriving at the pad. Asking a rail for a via next to
     * each pad is asking the designer to redraw a board that works.
     *
     * So: ground keeps the strict rule, and any other net with a pour is only
     * reported when NO copper of its own net touches the pad at all.
     */
    if (!eMassa(nomeDellaRete.get(net) ?? net)) {
      const toccata = tratti.some(
        (t) =>
          t.net === net &&
          t.layer === layer &&
          Math.abs(t.x - x) <= hw + 0.06 &&
          Math.abs(t.y - y) <= hh + 0.06,
      );
      if (toccata) continue;
    }
    out.push({
      pad: String(el.pcb_smtpad_id ?? ""),
      port: String(el.pcb_port_id ?? ""),
      net,
      x,
      y,
    });
  }
  return out;
}

/**
 * The net of a via, by its connectivity key.
 *
 * It matters for one question that looks trivial and is not: "is there already a
 * via of THIS net next to the pad?". Answering it by counting any via at all —
 * as the first version did — meant that a signal via passing a millimetre from a
 * ground pad was enough to skip its tie, and the pad stayed connected to
 * nothing. Four pads on bat-bs-blocchi.
 */
export function netOfViaKey(circuitJson: unknown[], pours: PourShape[]): Map<string, string> {
  const served = planeServedPorts(circuitJson, pours);
  const out = new Map<string, string>();
  // pcb_port -> net is what we have; the key of a via is the connectivity group
  // of the trace it belongs to, and that group is shared with its pads
  const groupOfPcbPort = new Map<string, string>();
  for (const el of circuitJson as El[]) {
    if (el.type !== "pcb_port" || !el.pcb_port_id) continue;
    groupOfPcbPort.set(
      String(el.pcb_port_id),
      String(el.subcircuit_connectivity_map_key ?? el.source_port_id ?? ""),
    );
  }
  for (const [pcbPort, net] of served) {
    const key = groupOfPcbPort.get(pcbPort);
    if (key) out.set(key, net);
  }
  /*
   * The autorouter names its groups after the net it is routing
   * (source_net_0_mst3_0): the prefix up to _mst is the net, and that is a
   * readable, verifiable bridge. Without it the vias the router leaves on ground
   * would look like they belong to nobody.
   */
  for (const el of circuitJson as El[]) {
    if (el.type !== "pcb_via" && el.type !== "pcb_trace") continue;
    const key = String(el.subcircuit_connectivity_map_key ?? "");
    const m = /^(source_net_\d+)_mst/.exec(key);
    if (m && pours.some((p) => p.net === m[1])) out.set(key, m[1]);
    if (key.startsWith("net:")) {
      const net = key.slice(4);
      if (pours.some((p) => p.net === net)) out.set(key, net);
    }
  }
  return out;
}
