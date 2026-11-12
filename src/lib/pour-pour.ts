/**
 * TWO POURS OF DIFFERENT NETS ON ONE LAYER, MEASURED AGAINST EACH OTHER.
 *
 * Nothing measured a pour against another pour. Between 17:00 and 17:37 of
 * 2026-11-11 the board of sbb-dl-principale on the server had the bottom ground
 * pour overlapping the hand strips of the USB receptacle's shield (another
 * net), and the summary said zero errors: the DRC measures a plane against the
 * vias of the other nets (check 8) and against nothing else of copper poured.
 * The overlap came from the pills of the shield, held by the strip as the
 * rectangles around them (see abbracciaRamePropio), and on the board saved at
 * 17:06 it is still there.
 *
 * Here every pair of pours of different nets on the same layer is measured,
 * copper against copper (holes included: an island in the hole of a plane is
 * measured against the hole). The minimum is the larger of the two clearances
 * (a pour's own, DISTANZA_PROPRIA, or the project's), less the hundredth the
 * plane check allows for the polygons of older boards. Where the near point of
 * a pour is a pad or a via of its own net (a pour holds its own copper whole),
 * that copper is the edge: the other pour kept its own clearance from it, and
 * that is the minimum there. Two pours that touch or overlap are a short
 * whatever the clearances: that is never excused.
 */

import { distanzaPropria, planeServedPorts, readPours } from "./pours";
import { stratiDiRame } from "./strati-rame";

type El = Record<string, unknown> & { type?: unknown };
type Punto = { x: number; y: number };

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** the hundredth the plane check allows too (see TOLLERANZA_COLATA_MM in drc.ts) */
const TOLLERANZA_MM = 0.01;

/** how near to a pad or a via of its net a point of a pour is that pad's or that via's copper */
const SUL_RAME_PROPRIO_MM = 0.003;

export interface ColateVicine {
  a: string;
  b: string;
  reteA: string;
  reteB: string;
  layer: string;
  /** copper to copper: 0 when they touch or overlap */
  distanzaMm: number;
  minimoMm: number;
  x: number;
  y: number;
}

/** what the summary says when two pours of different nets are too close (CompileSummary.poursTooClose) */
export interface ColateCheSiToccano {
  count: number;
  detail: string;
}

const dPS = (p: Punto, a: Punto, b: Punto): { d: number; q: Punto } => {
  const dx = b.x - a.x, dy = b.y - a.y, l = dx * dx + dy * dy;
  const t = l > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l)) : 0;
  const q = { x: a.x + t * dx, y: a.y + t * dy };
  return { d: Math.hypot(p.x - q.x, p.y - q.y), q };
};
const orient = (a: Punto, b: Punto, c: Punto) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
/** distance between two segments, with the point of the first that is nearest (the silkscreen check measures with it too) */
export function dSS(a: Punto, b: Punto, c: Punto, d: Punto): { d: number; p: Punto } {
  const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
  if (o1 * o2 < 0 && o3 * o4 < 0) {
    const t = o3 / (o3 - o4);
    return { d: 0, p: { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) } };
  }
  const cands = [
    { ...dPS(a, c, d), p: a },
    { ...dPS(b, c, d), p: b },
    { d: dPS(c, a, b).d, p: dPS(c, a, b).q },
    { d: dPS(d, a, b).d, p: dPS(d, a, b).q },
  ];
  return cands.reduce((m, x) => (x.d < m.d ? x : m));
}
/** whether a point is inside a polygon (even-odd; the part footprints measure with it too) */
export function dentro(x: number, y: number, a: Punto[]): boolean {
  let d = false;
  for (let i = 0, j = a.length - 1; i < a.length; j = i++) {
    if (a[i].y > y !== a[j].y > y && x < ((a[j].x - a[i].x) * (y - a[i].y)) / (a[j].y - a[i].y) + a[i].x) d = !d;
  }
  return d;
}

interface Colata {
  id: string;
  net: string;
  layer: string;
  clearance: number;
  anelli: Punto[][];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** its edges in cells, built when first asked */
  celle?: Map<string, number[]>;
  lati?: Array<[Punto, Punto]>;
}

const PASSO = 0.5;
function indice(c: Colata): void {
  if (c.celle) return;
  c.celle = new Map();
  c.lati = [];
  for (const a of c.anelli) {
    for (let i = 0; i < a.length; i++) {
      const p = a[i], q = a[(i + 1) % a.length];
      const k = c.lati.length;
      c.lati.push([p, q]);
      for (let gx = Math.floor(Math.min(p.x, q.x) / PASSO); gx <= Math.floor(Math.max(p.x, q.x) / PASSO); gx++) {
        for (let gy = Math.floor(Math.min(p.y, q.y) / PASSO); gy <= Math.floor(Math.max(p.y, q.y) / PASSO); gy++) {
          const key = `${gx},${gy}`;
          const l = c.celle.get(key);
          if (l) l.push(k);
          else c.celle.set(key, [k]);
        }
      }
    }
  }
}
const copre = (c: Colata, p: Punto) => dentro(p.x, p.y, c.anelli[0]) && !c.anelli.slice(1).some((h) => dentro(p.x, p.y, h));

/**
 * The pads and vias of each net on each layer, as distance functions: what a
 * pour of that net holds whole.
 */
function ramePropio(circuitJson: El[]): Map<string, Array<(p: Punto) => number>> {
  const out = new Map<string, Array<(p: Punto) => number>>();
  const metti = (layer: string, net: string, f: (p: Punto) => number) => {
    const k = `${layer}|${net}`;
    const l = out.get(k);
    if (l) l.push(f);
    else out.set(k, [f]);
  };
  const colate = readPours(circuitJson);
  const serviti = planeServedPorts(circuitJson, colate);
  const netDiChiave = new Map<string, string>();
  for (const el of circuitJson) {
    if (el.type === "source_net" && el.subcircuit_connectivity_map_key) netDiChiave.set(String(el.subcircuit_connectivity_map_key), String(el.source_net_id ?? ""));
  }
  /*
   * A via and a through hole are copper on EVERY layer of the board (the stack
   * comes from strati-rame.ts), and on any other layer a pour is written on:
   * tscircuit pours a `<copperpour>` on a layer the board does not declare and
   * says nothing. The list was written by hand up to inner4, so on an 8-layer
   * board a pour on inner5 or inner6 did not know the vias of its own net:
   * where it holds one whole, the other pour standing at its own clearance
   * from that via was reported as too close.
   */
  const pila = stratiDiRame(num(circuitJson.find((el) => el.type === "pcb_board")?.num_layers) ?? 2);
  const strati = [...new Set([...pila, ...colate.map((c) => c.layer)])];
  for (const el of circuitJson) {
    // a polygon pad may carry no x and y: its points say where it is
    const x = num(el.x) ?? 0, y = num(el.y) ?? 0;
    const senzaCentro = num(el.x) === null || num(el.y) === null;
    if (senzaCentro && !(el.type === "pcb_smtpad" && el.shape === "polygon")) continue;
    if (el.type === "pcb_via") {
      const net = netDiChiave.get(String(el.subcircuit_connectivity_map_key ?? ""));
      const r = (num(el.outer_diameter) ?? 0) / 2;
      if (net) for (const l of strati) metti(l, net, (p) => Math.hypot(p.x - x, p.y - y) - r);
      continue;
    }
    if (el.type !== "pcb_smtpad" && el.type !== "pcb_plated_hole") continue;
    const net = serviti.get(String(el.pcb_port_id ?? ""));
    if (!net) continue;
    const layers = el.type === "pcb_smtpad" ? [String(el.layer ?? "top")] : ((el.layers as string[] | undefined) ?? strati);
    // a polygon pad (the ground pads of the MEMS microphones) is its polygon
    const contorno =
      el.type === "pcb_smtpad" && el.shape === "polygon"
        ? ((el.points as Punto[] | undefined) ?? [])
        : el.shape === "hole_with_polygon_pad"
          ? ((el.pad_outline as Punto[] | undefined) ?? []).map((q) => {
              const r = ((num(el.ccw_rotation) ?? 0) * Math.PI) / 180;
              return { x: x + q.x * Math.cos(r) - q.y * Math.sin(r), y: y + q.x * Math.sin(r) + q.y * Math.cos(r) };
            })
          : [];
    if (contorno.length >= 3) {
      const f = (p: Punto) =>
        dentro(p.x, p.y, contorno) ? 0 : Math.min(...contorno.map((q, i) => dPS(p, contorno[(i + contorno.length - 1) % contorno.length], q).d));
      for (const l of layers) metti(l, net, f);
      continue;
    }
    const w = num(el.width) ?? num(el.outer_width) ?? num(el.rect_pad_width) ?? num(el.outer_diameter) ?? (num(el.radius) ?? 0) * 2;
    const h = num(el.height) ?? num(el.outer_height) ?? num(el.rect_pad_height) ?? num(el.outer_diameter) ?? (num(el.radius) ?? 0) * 2;
    const gradi = num(el.ccw_rotation) ?? num(el.rect_ccw_rotation) ?? 0;
    const shape = String(el.shape ?? "");
    const tondo = shape === "circle";
    const pillola = shape.includes("pill") || shape === "oval";
    const c = Math.cos((-gradi * Math.PI) / 180), s = Math.sin((-gradi * Math.PI) / 180);
    const f = (p: Punto) => {
      // in the pad's own frame
      const lx = (p.x - x) * c - (p.y - y) * s;
      const ly = (p.x - x) * s + (p.y - y) * c;
      if (tondo) return Math.hypot(lx, ly) - w / 2;
      if (pillola) {
        const r = Math.min(w, h) / 2;
        const mx = Math.max(0, w / 2 - r), my = Math.max(0, h / 2 - r);
        return Math.hypot(Math.max(0, Math.abs(lx) - mx), Math.max(0, Math.abs(ly) - my)) - r;
      }
      const dx = Math.abs(lx) - w / 2, dy = Math.abs(ly) - h / 2;
      return dx > 0 || dy > 0 ? Math.hypot(Math.max(0, dx), Math.max(0, dy)) : Math.max(dx, dy);
    };
    for (const l of layers) metti(l, net, f);
  }
  return out;
}

/**
 * Every pair of pours of different nets on one layer that is closer than it
 * should be, nearest first. `regolaMm`: the project's pour clearance, for the
 * pours that declare none.
 */
export function colateTroppoVicine(circuitJson: unknown[], regolaMm: number): ColateVicine[] {
  const els = circuitJson as El[];
  const nomi = new Map<string, string>();
  for (const el of els) if (el.type === "source_net") nomi.set(String(el.source_net_id ?? ""), String(el.name ?? el.source_net_id ?? ""));
  const colate: Colata[] = [];
  for (const el of els) {
    if (el.type !== "pcb_copper_pour") continue;
    const b = el.brep_shape as { outer_ring?: { vertices?: Punto[] }; inner_rings?: Array<{ vertices?: Punto[] }> } | undefined;
    const valido = (a: Punto[]) => a.filter((p) => num(p?.x) !== null && num(p?.y) !== null);
    const esterno = valido(b?.outer_ring?.vertices ?? []);
    if (esterno.length < 3) continue;
    const anelli = [esterno, ...(b?.inner_rings ?? []).map((r) => valido(r.vertices ?? [])).filter((a) => a.length >= 3)];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of anelli[0]) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    colate.push({
      id: String(el.pcb_copper_pour_id ?? `pour${colate.length}`),
      net: String(el.source_net_id ?? ""),
      layer: String(el.layer ?? ""),
      clearance: distanzaPropria(el) ?? regolaMm,
      anelli,
      minX,
      minY,
      maxX,
      maxY,
    });
  }
  if (colate.length < 2) return [];
  let propri: Map<string, Array<(p: Punto) => number>> | null = null;
  const sulRame = (c: Colata, p: Punto) => {
    propri ??= ramePropio(els);
    return (propri.get(`${c.layer}|${c.net}`) ?? []).some((f) => f(p) <= SUL_RAME_PROPRIO_MM);
  };
  const out: ColateVicine[] = [];
  for (let i = 0; i < colate.length; i++) {
    for (let j = i + 1; j < colate.length; j++) {
      const a = colate[i], b = colate[j];
      if (a.layer !== b.layer || a.net === b.net) continue;
      const massimo = Math.max(a.clearance, b.clearance);
      const r = massimo;
      if (a.maxX + r < b.minX || b.maxX + r < a.minX || a.maxY + r < b.minY || b.maxY + r < a.minY) continue;
      indice(b);
      indice(a);
      /*
       * Over the edges of a against the edges of b near them: the nearest
       * approach of all, and the nearest where neither side is its own copper.
       */
      let tutto = { d: Infinity, p: { x: 0, y: 0 } };
      let bordi = { d: Infinity, p: { x: 0, y: 0 } };
      for (const [p, q] of a.lati!) {
        const visti = new Set<number>();
        for (let gx = Math.floor((Math.min(p.x, q.x) - r) / PASSO); gx <= Math.floor((Math.max(p.x, q.x) + r) / PASSO); gx++) {
          for (let gy = Math.floor((Math.min(p.y, q.y) - r) / PASSO); gy <= Math.floor((Math.max(p.y, q.y) + r) / PASSO); gy++) {
            for (const k of b.celle!.get(`${gx},${gy}`) ?? []) visti.add(k);
          }
        }
        if (visti.size === 0) continue;
        let mioRame: boolean | null = null;
        for (const k of visti) {
          const [c, d] = b.lati![k];
          const m = dSS(p, q, c, d);
          if (m.d < tutto.d) tutto = m;
          if (m.d >= bordi.d || m.d >= massimo) continue;
          mioRame ??= sulRame(a, { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
          if (mioRame || sulRame(b, { x: (c.x + d.x) / 2, y: (c.y + d.y) / 2 })) continue;
          bordi = m;
        }
      }
      // one inside the other with no edge crossing: a vertex of one in the copper of the other
      if (tutto.d > 0 && (copre(b, a.anelli[0][0]) || copre(a, b.anelli[0][0]))) tutto = { d: 0, p: copre(b, a.anelli[0][0]) ? a.anelli[0][0] : b.anelli[0][0] };
      const minimo = Math.min(a.clearance, b.clearance);
      const corto = tutto.d <= 1e-9;
      const vicine = !corto && (bordi.d < massimo - TOLLERANZA_MM || tutto.d < minimo - TOLLERANZA_MM);
      if (!corto && !vicine) continue;
      const peggiore = corto || tutto.d < minimo - TOLLERANZA_MM ? tutto : bordi;
      out.push({
        a: a.id,
        b: b.id,
        reteA: nomi.get(a.net) ?? a.net,
        reteB: nomi.get(b.net) ?? b.net,
        layer: a.layer,
        distanzaMm: corto ? 0 : peggiore.d,
        minimoMm: corto || tutto.d < minimo - TOLLERANZA_MM ? minimo : massimo,
        x: peggiore.p.x,
        y: peggiore.p.y,
      });
    }
  }
  return out.sort((x, y) => x.distanzaMm - y.distanzaMm);
}

/** the same in words for the summary and the export, or undefined when every pair keeps its distance */
export function colateCheSiToccano(circuitJson: unknown[], regolaMm: number): ColateCheSiToccano | undefined {
  const coppie = colateTroppoVicine(circuitJson, regolaMm);
  if (coppie.length === 0) return undefined;
  const c = coppie[0];
  const corti = coppie.filter((p) => p.distanzaMm === 0).length;
  const altre = coppie.length > 1 ? ` e altre ${coppie.length - 1} coppie` : "";
  return {
    count: coppie.length,
    detail:
      `${coppie.length} ${coppie.length === 1 ? "coppia" : "coppie"} di colate di reti diverse troppo vicine` +
      (corti > 0 ? ` (${corti} si toccano: corto)` : "") +
      `: ${c.a} (${c.reteA}) e ${c.b} (${c.reteB}) su ${c.layer}, ${c.distanzaMm.toFixed(3)}mm < ${c.minimoMm}mm` +
      ` a (${c.x.toFixed(2)}; ${c.y.toFixed(2)})${altre}`,
  };
}

