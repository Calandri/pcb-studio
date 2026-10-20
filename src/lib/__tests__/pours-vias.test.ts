import { describe, expect, it } from "vitest";
import { runTscircuitCode } from "@tscircuit/eval";
import { ricolaPiani, viePassanti } from "@/lib/pours-recompute";

type Punto = { x: number; y: number };
type El = Record<string, unknown> & { type: string } & {
  x?: number; y?: number; layer?: string; layers?: string[]; outer_diameter?: number; padId?: string; connectivityKey?: string;
  brep_shape?: { outer_ring: { vertices: Punto[] }; inner_rings?: Array<{ vertices: Punto[] }> };
};

const dentro = (x: number, y: number, anello: Array<{ x: number; y: number }>) => {
  let ok = false;
  for (let i = 0, j = anello.length - 1; i < anello.length; j = i++) {
    const a = anello[i], b = anello[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) ok = !ok;
  }
  return ok;
};
/** is the point covered by copper of this pour piece (outer ring minus its holes)? */
const coperto = (pour: El, x: number, y: number) => {
  const b = pour.brep_shape!;
  if (!dentro(x, y, b.outer_ring.vertices)) return false;
  return !(b.inner_rings ?? []).some((r) => dentro(x, y, r.vertices));
};

describe("through vias on the inner planes", () => {
  it("are listed as obstacles on an inner layer only, with the plane's key when they share its net", () => {
    const cj = [
      { type: "pcb_via", pcb_via_id: "v1", x: 1, y: 1, outer_diameter: 0.5, hole_diameter: 0.2, layers: ["top", "bottom"] },
      { type: "pcb_via", pcb_via_id: "v2", x: 2, y: 1, outer_diameter: 0.5, hole_diameter: 0.2, layers: ["top", "bottom"] },
      { type: "pcb_via", pcb_via_id: "v3", x: 3, y: 1, outer_diameter: 0.5, hole_diameter: 0.2, layers: ["top", "inner1"] },
    ] as El[];
    const reti = new Map([["v1", "gnd"], ["v2", "sig"]]);
    expect(viePassanti(cj, "top", "gnd", reti, "K")).toHaveLength(0);
    const sotto = viePassanti(cj, "inner2", "gnd", reti, "K");
    expect(sotto.map((v) => v.padId)).toEqual(["v1", "v2"]);
    expect(sotto[0].connectivityKey).toBe("K");
    expect(sotto[1].connectivityKey).toBe("unconnected-via:v2");
  });

  it("a signal via through the inner ground plane gets its opening, a ground via stays in the copper", async () => {
    const code = `export default () => (
      <board width="20mm" height="20mm" layers={4}>
        <chip name="U1" pcbX={-6} pcbY={0} footprint="soic8" />
        <chip name="U2" pcbX={6} pcbY={0} layer="bottom" footprint="soic8" />
        <via pcbX={0} pcbY={0} fromLayer="top" toLayer="bottom" outerDiameter="0.6mm" holeDiameter="0.3mm" connectsTo="net.SIG" />
        <via pcbX={0} pcbY={4} fromLayer="top" toLayer="bottom" outerDiameter="0.6mm" holeDiameter="0.3mm" connectsTo="net.GND" />
        <trace from=".U1 > .pin1" to="net.SIG" />
        <trace from=".U2 > .pin1" to="net.SIG" />
        <trace from=".U1 > .pin4" to="net.GND" />
        <copperpour layer="inner1" connectsTo="net.GND" />
      </board>
    )`;
    const cj = (await runTscircuitCode({ "main.tsx": code }, { mainComponentPath: "main.tsx" })) as El[];
    const vie = cj.filter((e) => e.type === "pcb_via") as Array<El & { x: number; y: number; outer_diameter: number; layers: string[] }>;
    expect(vie.length).toBeGreaterThanOrEqual(2);
    const segnale = vie.find((v) => Math.abs(v.x) < 1e-6 && Math.abs(v.y) < 1e-6)!;
    const massa = vie.find((v) => Math.abs(v.x) < 1e-6 && Math.abs(v.y - 4) < 1e-6)!;
    // come le scrivono le piste manuali e l'import (applyManualRoutes): passanti, ma dichiarate solo top e bottom
    segnale.layers = ["top", "bottom"];
    massa.layers = ["top", "bottom"];
    const esito = await ricolaPiani({ circuitJson: cj as never, clearanceMm: 0.2, bordoMm: 0.3 });
    const piani = (esito.circuitJson as El[]).filter((e) => e.type === "pcb_copper_pour" && e.layer === "inner1");
    expect(piani.length).toBeGreaterThan(0);
    // nessun pezzo di piano di massa copre la via di segnale ne' il suo anello di distanza
    for (let a = 0; a < 360; a += 30) {
      const r = segnale.outer_diameter / 2 + 0.15;
      const px = segnale.x + r * Math.cos((a * Math.PI) / 180), py = segnale.y + r * Math.sin((a * Math.PI) / 180);
      expect(piani.some((p) => coperto(p, px, py))).toBe(false);
    }
    expect(piani.some((p) => coperto(p, segnale.x, segnale.y))).toBe(false);
    // la via di massa e' nel rame del suo piano
    expect(piani.some((p) => coperto(p, massa.x + massa.outer_diameter / 2 + 0.05, massa.y))).toBe(true);
  }, 120000);
});
