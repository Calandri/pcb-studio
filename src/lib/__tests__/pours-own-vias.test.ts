import { describe, expect, it } from "vitest";
import { compileProject } from "@/lib/compile";
import { DESIGN_RULES_PATH } from "@/lib/design-rules";

/*
 * sbb-dl-retro, colate con distanza 0,25: 64 vie della rete della colata col
 * bordo della colata in mezzo all'anello (2026-11-09). Qui una via GND a 0,2 mm
 * da una pista di un'altra rete: piu' vicina della distanza della colata, quindi
 * il taglio attorno alla pista passava dentro l'anello.
 */
type P = { x: number; y: number };
const dentro = (x: number, y: number, a: P[]) => {
  let d = false;
  for (let i = 0, j = a.length - 1; i < a.length; j = i++) if (a[i].y > y !== a[j].y > y && x < ((a[j].x - a[i].x) * (y - a[i].y)) / (a[j].y - a[i].y) + a[i].x) d = !d;
  return d;
};
const distSeg = (p: P, a: P, b: P) => {
  const dx = b.x - a.x, dy = b.y - a.y, l = dx * dx + dy * dy;
  const t = l > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
};

const MAIN = `export default () => (
  <board width="20mm" height="12mm">
    <net name="GND" />
    <net name="SIG" />
    <copperpour layer="top" connectsTo="net.GND" />
    <resistor name="R1" resistance="1k" footprint="0402" pcbX={-6} pcbY={0} />
    <resistor name="R2" resistance="1k" footprint="0402" pcbX={6} pcbY={0} />
    <trace from=".R1 > .pin1" to="net.GND" />
    <trace from=".R2 > .pin2" to="net.GND" />
    <trace from=".R1 > .pin2" to=".R2 > .pin1" pcbPath={[{ x: 0.51, y: 0.4 }, { x: 11.49, y: 0.4 }]} />
    <via name="V1" pcbX={0} pcbY={0} connectsTo="net.GND" fromLayer="top" toLayer="bottom" />
  </board>
)
`;
const REGOLE = JSON.stringify({
  preset: "custom",
  rules: { minTraceWidthMm: 0.127, minClearanceMm: 0.152, minViaHoleMm: 0.2, minViaDiameterMm: 0.5, pourClearanceMm: 0.25, autoPlaneVias: false, autoroute: false },
});

describe("la colata tiene intere le vie della sua rete", () => {
  it("anello della via tutto dentro, e mai piu' vicina alla pista dell'altra rete della via stessa", async () => {
    const { circuitJson } = await compileProject({ "main.tsx": MAIN, [DESIGN_RULES_PATH]: REGOLE });
    const els = circuitJson as Array<Record<string, unknown>>;
    const via = els.find((e) => e.type === "pcb_via")!;
    const r = Number(via.outer_diameter) / 2;
    const pezzi = els
      .filter((e) => e.type === "pcb_copper_pour" && e.layer === "top")
      .map((e) => e.brep_shape as { outer_ring: { vertices: P[] }; inner_rings?: Array<{ vertices: P[] }> });
    const inColata = (x: number, y: number) => pezzi.some((b) => dentro(x, y, b.outer_ring.vertices) && !(b.inner_rings ?? []).some((h) => dentro(x, y, h.vertices)));
    const anello = Array.from({ length: 32 }, (_, i) => ({ x: Number(via.x) + r * 0.999 * Math.cos((i * Math.PI) / 16), y: Number(via.y) + r * 0.999 * Math.sin((i * Math.PI) / 16) }));
    expect(anello.filter((q) => !inColata(q.x, q.y))).toHaveLength(0);

    // the trace of the other net: the pour is never nearer to it than the via ring is
    const pista = els.find((e) => e.type === "pcb_trace")!;
    const punti = (pista.route as Array<{ x: number; y: number; width?: number }>).filter((p) => typeof p.x === "number");
    const mezza = Number(punti[0].width ?? 0.1) / 2;
    const daPista = (q: P) => Math.min(...punti.slice(1).map((b, i) => distSeg(q, punti[i], b))) - mezza;
    const viaPista = daPista({ x: Number(via.x), y: Number(via.y) }) - r;
    const bordo = pezzi.flatMap((b) => [b.outer_ring.vertices, ...(b.inner_rings ?? []).map((h) => h.vertices)]).flat();
    const minimo = Math.min(...bordo.map(daPista));
    expect(viaPista).toBeLessThan(0.25);
    expect(minimo).toBeGreaterThanOrEqual(viaPista - 0.01);
  }, 120_000);
});
