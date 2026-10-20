import { beforeAll, describe, expect, it } from "vitest";
import { initializeManifoldGeometry } from "@tscircuit/copper-pour-solver";
import { senzaColliStretti, type FormaColata } from "@/lib/pour-necks";

const rett = (x0: number, y0: number, x1: number, y1: number) => ({
  vertices: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }],
});
const area = (f: FormaColata) => {
  const a = (v: Array<{ x: number; y: number }>) =>
    Math.abs(v.reduce((s, p, i) => s + p.x * v[(i + 1) % v.length].y - v[(i + 1) % v.length].x * p.y, 0) / 2);
  return a(f.outer_ring!.vertices) - (f.inner_rings ?? []).reduce((s, r) => s + a(r.vertices), 0);
};

beforeAll(async () => {
  await initializeManifoldGeometry();
});

describe("colate senza colli piu' stretti di una pista", () => {
  it("due isole unite da un collo di 0,1 mm escono separate, il collo non c'e' piu'", () => {
    // due quadrati 2x2 uniti da una striscia 0,1 x 1 mm
    const forma: FormaColata = {
      outer_ring: {
        vertices: [
          { x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 0.95 }, { x: 3, y: 0.95 }, { x: 3, y: 0 }, { x: 5, y: 0 },
          { x: 5, y: 2 }, { x: 3, y: 2 }, { x: 3, y: 1.05 }, { x: 2, y: 1.05 }, { x: 2, y: 2 }, { x: 0, y: 2 },
        ],
      },
    };
    const pezzi = senzaColliStretti(forma, 0.15);
    expect(pezzi).toHaveLength(2);
    const tot = pezzi.reduce((s, p) => s + area(p), 0);
    expect(tot).toBeLessThan(8);
    expect(tot).toBeGreaterThan(7.9); // tolti il collo (0,1 mm2) e un filo di angoli
  });
  it("una colata larga con un buco torna com'era, buco compreso, e mai fuori dalla forma di partenza", () => {
    const forma: FormaColata = { outer_ring: rett(0, 0, 10, 6), inner_rings: [rett(3, 2, 5, 4)] };
    const pezzi = senzaColliStretti(forma, 0.15);
    expect(pezzi).toHaveLength(1);
    expect(pezzi[0].inner_rings).toHaveLength(1);
    expect(area(pezzi[0])).toBeGreaterThan(area(forma) - 0.02); // solo gli spigoli arrotondati
    expect(area(pezzi[0])).toBeLessThanOrEqual(area(forma) + 1e-9);
    for (const v of pezzi[0].outer_ring!.vertices) {
      expect(v.x).toBeGreaterThanOrEqual(-1e-9);
      expect(v.y).toBeLessThanOrEqual(6 + 1e-9);
    }
  });
  it("una punta sottile sparisce, una striscia larga come la pista resta", () => {
    const sottile: FormaColata = { outer_ring: rett(0, 0, 4, 0.1) };
    expect(senzaColliStretti(sottile, 0.15)).toHaveLength(0);
    const giusta: FormaColata = { outer_ring: rett(0, 0, 4, 0.16) };
    expect(senzaColliStretti(giusta, 0.15)).toHaveLength(1);
  });
  it("senza larghezza minima la forma resta quella", () => {
    const forma: FormaColata = { outer_ring: rett(0, 0, 1, 1) };
    expect(senzaColliStretti(forma, 0)).toEqual([forma]);
  });
});

describe("ricontrollo: le colate vecchie perdono le schegge", () => {
  it("una colata con collo diventa due, una pulita resta identica", async () => {
    const { colateSenzaColli } = await import("@/lib/pour-necks");
    const conCollo = {
      type: "pcb_copper_pour", pcb_copper_pour_id: "p", layer: "top",
      brep_shape: { outer_ring: { vertices: [
        { x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 0.95 }, { x: 3, y: 0.95 }, { x: 3, y: 0 }, { x: 5, y: 0 },
        { x: 5, y: 2 }, { x: 3, y: 2 }, { x: 3, y: 1.05 }, { x: 2, y: 1.05 }, { x: 2, y: 2 }, { x: 0, y: 2 } ] } },
    };
    const altro = { type: "pcb_smtpad", pcb_smtpad_id: "s" };
    const out: Array<Record<string, unknown>> = await colateSenzaColli<Record<string, unknown>>([conCollo, altro], 0.15);
    expect(out.filter((e) => e.type === "pcb_copper_pour").map((e) => e.pcb_copper_pour_id)).toEqual(["p_n0", "p_n1"]);
    expect(out).toContainEqual(altro);
    const ancora = await colateSenzaColli(out, 0.15);
    expect(ancora).toHaveLength(out.length);
  });
});
