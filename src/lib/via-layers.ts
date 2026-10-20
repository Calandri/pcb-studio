/**
 * A THROUGH VIA HAS A PAD ON EVERY INNER LAYER WHERE IT IS CONNECTED.
 *
 * tscircuit writes a through via as `layers: ["top", "bottom"]`, and
 * circuit-json-to-gerber flashes the via pad only on the layers listed. So on
 * the inner layers the drilled barrel met the copper only where a pour
 * happened to cover it. Measured on BIRDY_BAT on 2026-10-20: a via of NetC28_2
 * sitting on the edge of its pour on inner2 kept copper on less than three
 * quarters of its wall (annular ring -0.035 mm).
 *
 * The first fix drew the pad on EVERY inner layer, and the fab's checker
 * (Eurocircuits, same day) answered with 65 annular-ring errors and two
 * clearance errors, all on pads that connect nothing: an unused inner pad is
 * still a ring a fab has to hold, and two of them 0.7 mm apart are 0.197 mm
 * from each other. Altium ("remove unused pads"), KiCad and the fabs themselves
 * keep only the FUNCTIONAL inner pads.
 *
 * So, for the Gerber, a through via gets its pad on an inner layer when it is
 * connected there: it touches a pour of its own net on that layer, or a trace
 * on that layer reaches it (ends on it or runs over it: a via in the middle of a
 * segment is connected too, as one on BIRDY_BAT's inner2 showed). Everywhere else the inner layer keeps only the
 * clearance the pour engine already cuts around the hole.
 */
type El = Record<string, unknown> & { type?: unknown };
type Punto = { x: number; y: number };

export function stratiDiRame(numeroStrati: number): string[] {
  const n = Number.isFinite(numeroStrati) && numeroStrati >= 2 ? Math.floor(numeroStrati) : 2;
  return ["top", ...Array.from({ length: n - 2 }, (_, i) => `inner${i + 1}`), "bottom"];
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function dentro(p: Punto, anello: Punto[]): boolean {
  let s = false;
  for (let i = 0, j = anello.length - 1; i < anello.length; j = i++) {
    const a = anello[i];
    const b = anello[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) s = !s;
  }
  return s;
}

function distanzaDalBordo(p: Punto, anello: Punto[]): number {
  let d = Infinity;
  for (let i = 0, j = anello.length - 1; i < anello.length; j = i++) {
    const a = anello[j];
    const b = anello[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
    d = Math.min(d, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
  }
  return d;
}

/** the via's circle and the pour's copper share at least a point */
function toccaColata(p: Punto, raggio: number, forma: { outer_ring?: { vertices?: Punto[] }; inner_rings?: Array<{ vertices?: Punto[] }> }): boolean {
  const fuori = forma.outer_ring?.vertices ?? [];
  if (fuori.length < 3) return false;
  const buchi = (forma.inner_rings ?? []).map((r) => r.vertices ?? []).filter((r) => r.length >= 3);
  const inRame = dentro(p, fuori) && !buchi.some((b) => dentro(p, b));
  if (inRame) return true;
  // centre outside the copper: it still touches when an edge of the copper is within the pad
  return [fuori, ...buchi].some((r) => distanzaDalBordo(p, r) < raggio);
}

export function viePassantiSuOgniStrato<T extends El>(circuitJson: T[]): T[] {
  const scheda = circuitJson.find((el) => el.type === "pcb_board") as El | undefined;
  const strati = stratiDiRame(Number(scheda?.num_layers ?? 2));
  const interni = strati.slice(1, -1);
  if (interni.length === 0) return circuitJson;

  const chiaveDiRete = new Map<string, string>();
  for (const el of circuitJson) {
    if (el.type === "source_net" && typeof el.source_net_id === "string") {
      chiaveDiRete.set(el.source_net_id, String(el.subcircuit_connectivity_map_key ?? ""));
    }
  }
  const colate = circuitJson
    .filter((el) => el.type === "pcb_copper_pour" && interni.includes(String(el.layer)))
    .map((el) => ({
      strato: String(el.layer),
      chiave: chiaveDiRete.get(String(el.source_net_id ?? "")) ?? "",
      forma: (el.brep_shape ?? {}) as Parameters<typeof toccaColata>[2],
    }));
  /** the trace copper on the inner layers, segment by segment, with its width */
  const segmenti: Array<{ strato: string; a: Punto; b: Punto; w: number }> = [];
  for (const el of circuitJson) {
    if (el.type !== "pcb_trace" || !Array.isArray(el.route)) continue;
    const route = el.route as Array<Record<string, unknown>>;
    for (let i = 0; i < route.length; i++) {
      const q = route[i];
      const x = num(q.x);
      const y = num(q.y);
      const l = String(q.layer ?? "");
      if (x === null || y === null || !interni.includes(l)) continue;
      const w = num(q.width) ?? 0;
      const n = route[i + 1];
      const nx = n ? num(n.x) : null;
      const ny = n ? num(n.y) : null;
      if (n && nx !== null && ny !== null && String(n.layer ?? "") === l) segmenti.push({ strato: l, a: { x, y }, b: { x: nx, y: ny }, w });
      else segmenti.push({ strato: l, a: { x, y }, b: { x, y }, w });
    }
  }

  return circuitJson.map((el) => {
    if (el.type !== "pcb_via") return el;
    const l = Array.isArray(el.layers) ? (el.layers as unknown[]).map(String) : [];
    if (!(l.includes("top") && l.includes("bottom"))) return el; // blind or buried: as it is
    const x = num(el.x);
    const y = num(el.y);
    const r = (num(el.outer_diameter) ?? 0) / 2;
    if (x === null || y === null || !(r > 0)) return el;
    const p = { x, y };
    const chiave = String(el.subcircuit_connectivity_map_key ?? "");
    const collegati = interni.filter(
      (s) =>
        (chiave !== "" && colate.some((c) => c.strato === s && c.chiave === chiave && toccaColata(p, r, c.forma))) ||
        segmenti.some((q) => q.strato === s && distanzaDalBordo(p, [q.a, q.b]) < r + q.w / 2),
    );
    if (collegati.length === 0) return el;
    return { ...el, layers: ["top", ...collegati, "bottom"] };
  });
}
