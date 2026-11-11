import { describe, expect, it } from "vitest";
import { runTscircuitCode } from "@tscircuit/eval";
import { compileProject } from "@/lib/compile";
import { DESIGN_RULES_PATH } from "@/lib/design-rules";
import { ENGINE_VIE_PASSANTI } from "@/lib/engine-version";
import { ricolaPiani, ricolaSeLeVieEranoParziali, viePassanti } from "@/lib/pours-recompute";
import { vieSemprePassanti } from "@/lib/via-layers";

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
  it("are listed as obstacles on every layer they do not name, with the plane's key when they share its net", () => {
    const cj = [
      { type: "pcb_via", pcb_via_id: "v1", x: 1, y: 1, outer_diameter: 0.5, hole_diameter: 0.2, layers: ["top", "bottom"] },
      { type: "pcb_via", pcb_via_id: "v2", x: 2, y: 1, outer_diameter: 0.5, hole_diameter: 0.2, layers: ["top", "bottom"] },
      // written as if it stopped on inner1: the hole goes through all the same
      { type: "pcb_via", pcb_via_id: "v3", x: 3, y: 1, outer_diameter: 0.5, hole_diameter: 0.2, layers: ["top", "inner1"] },
      { type: "pcb_via", pcb_via_id: "v4", x: 4, y: 1, outer_diameter: 0.5, hole_diameter: 0.2, layers: ["inner2", "bottom"] },
    ] as El[];
    const reti = new Map([["v1", "gnd"], ["v2", "sig"], ["v4", "gnd"]]);
    // the faces too: the converter has the ones that name the face, the others come from here
    expect(viePassanti(cj, "top", "gnd", reti, "K").map((v) => v.padId)).toEqual(["v4"]);
    expect(viePassanti(cj, "bottom", "gnd", reti, "K").map((v) => v.padId)).toEqual(["v3"]);
    expect(viePassanti(cj, "inner1", "gnd", reti, "K").map((v) => v.padId)).toEqual(["v1", "v2", "v4"]);
    const sotto = viePassanti(cj, "inner2", "gnd", reti, "K");
    expect(sotto.map((v) => v.padId)).toEqual(["v1", "v2", "v3"]);
    expect(sotto[0].connectivityKey).toBe("K");
    expect(sotto[1].connectivityKey).toBe("unconnected-via:v2");
    expect(sotto[2].connectivityKey).toBe("unconnected-via:v3");
    // its own net: it stays in the plane, on a layer it does not name as well
    expect(viePassanti(cj, "top", "gnd", reti, "K")[0].connectivityKey).toBe("K");
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

/*
 * sbb-dl-principale, 2026-11-11. A hand-drawn trace that runs on inner2: its
 * via down to bottom was written `["inner2", "bottom"]`, the inner1 ground
 * plane closed over the hole, and 20 holes of VBUS, VSYS, NRST and the SD lines
 * were shorted to ground with a DRC of 0 errors.
 */
const INTERNA = `export default () => (
  <board width="20mm" height="12mm" layers={4} pcbStyle={{ viaHoleDiameter: 0.2, viaPadDiameter: 0.5 }}>
    <net name="GND" />
    <copperpour layer="inner1" connectsTo="net.GND" />
    <copperpour layer="top" connectsTo="net.GND" />
    <resistor name="R1" resistance="1k" footprint="0402" pcbX={-6} pcbY={0} />
    <resistor name="R2" resistance="1k" footprint="0402" pcbX={6} pcbY={0} layer="bottom" />
    <trace from=".R1 > .pin1" to="net.GND" />
    <trace from=".R1 > .pin2" to=".R2 > .pin2" pcbPathRelativeTo=".R1 > .pin2" pcbPath={[
      { x: 1.5, y: 0 },
      { x: 1.5, y: 0, via: true, fromLayer: "top", toLayer: "inner2" },
      { x: 1.5, y: 0 },
      { x: 9.5, y: 0 },
      { x: 9.5, y: 0, via: true, fromLayer: "inner2", toLayer: "bottom" },
      { x: 9.5, y: 0 },
    ]} thickness="0.25mm" />
  </board>
)
`;
const REGOLE_INTERNA = JSON.stringify({
  preset: "custom",
  rules: { minTraceWidthMm: 0.127, minClearanceMm: 0.152, minViaHoleMm: 0.2, minViaDiameterMm: 0.5, pourClearanceMm: 0.152, autoPlaneVias: false, autoroute: false },
});
const distSeg = (p: Punto, a: Punto, b: Punto) => {
  const dx = b.x - a.x, dy = b.y - a.y, l = dx * dx + dy * dy;
  const t = l > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
};
/** from the edge of the via's pad to the copper of the planes of one layer: 0 when the pad is in the copper */
const dalRame = (cj: El[], layer: string, via: El) => {
  const piani = cj.filter((e) => e.type === "pcb_copper_pour" && e.layer === layer);
  if (piani.some((p) => coperto(p, via.x!, via.y!))) return 0;
  const anelli = piani.flatMap((p) => [p.brep_shape!.outer_ring.vertices, ...(p.brep_shape!.inner_rings ?? []).map((r) => r.vertices)]);
  const d = Math.min(...anelli.flatMap((a) => a.map((q, i) => distSeg({ x: via.x!, y: via.y! }, a[(i + a.length - 1) % a.length], q))));
  return Math.max(0, d - via.outer_diameter! / 2);
};
type Via = El & { pcb_via_id: string; from_layer: string; to_layer: string; declared_layers?: string[] };

describe("a via written on part of the stack still goes through every plane", () => {
  it("compiled: the inner1 ground plane opens around the via that goes from inner2 to bottom", async () => {
    const { circuitJson, summary } = await compileProject({ "main.tsx": INTERNA, [DESIGN_RULES_PATH]: REGOLE_INTERNA });
    const cj = circuitJson as El[];
    const vie = cj.filter((e) => e.type === "pcb_via") as Via[];
    const giu = vie.find((v) => v.from_layer === "inner2" && v.to_layer === "bottom")!;
    const su = vie.find((v) => v.from_layer === "top" && v.to_layer === "inner2")!;
    expect(giu && su).toBeTruthy();
    // tscircuit wrote them on the layers between the two ends; the board that comes out lists the stack
    expect(giu.declared_layers).toEqual(["inner2", "bottom"]);
    expect(su.declared_layers).toEqual(["top", "inner1", "inner2"]);
    for (const v of vie) expect(v.layers).toEqual(["top", "inner1", "inner2", "bottom"]);

    expect(cj.some((e) => e.type === "pcb_copper_pour" && e.layer === "inner1")).toBe(true);
    // at least the pour clearance (0.152) around the pad of each, on the plane neither of them uses
    for (const v of [giu, su]) expect(dalRame(cj, "inner1", v)).toBeGreaterThanOrEqual(0.152 - 0.01);
    // and on the top face, which the via going down from inner2 never named
    expect(dalRame(cj, "top", giu)).toBeGreaterThanOrEqual(0.152 - 0.01);
    expect(summary.drcViolations.filter((v) => v.rule === "pour_clearance")).toEqual([]);
  }, 120_000);

  it("poured as it was written, without the step that completes the vias: the opening is there all the same", async () => {
    const grezza = (await runTscircuitCode({ "main.tsx": INTERNA }, { mainComponentPath: "main.tsx" })) as El[];
    const giu = grezza.find((e) => e.type === "pcb_via" && (e as Via).from_layer === "inner2")!;
    expect(giu.layers).toEqual(["inner2", "bottom"]);
    const esito = await ricolaPiani({ circuitJson: grezza as never, clearanceMm: 0.152, bordoMm: 0.3 });
    const cj = esito.circuitJson as El[];
    expect(cj.find((e) => e.type === "pcb_via" && (e as Via).from_layer === "inner2")!.layers).toEqual(["inner2", "bottom"]);
    expect(dalRame(cj, "inner1", giu)).toBeGreaterThanOrEqual(0.152 - 0.01);
    expect(dalRame(cj, "top", giu)).toBeGreaterThanOrEqual(0.152 - 0.01);
  }, 120_000);

  it("a saved board of an older engine is poured again on recheck, and only that one", async () => {
    // the board as the engine before this one saved it: the plane over the hole
    const grezza = (await runTscircuitCode({ "main.tsx": INTERNA }, { mainComponentPath: "main.tsx" })) as El[];
    const giu = grezza.find((e) => e.type === "pcb_via" && (e as Via).from_layer === "inner2")!;
    const chiuso: El = {
      ...grezza.find((e) => e.type === "pcb_copper_pour" && e.layer === "inner1")!,
      brep_shape: { outer_ring: { vertices: [{ x: -9, y: -5 }, { x: 9, y: -5 }, { x: 9, y: 5 }, { x: -9, y: 5 }] }, inner_rings: [] },
    };
    const salvata = [...grezza.filter((e) => e.type !== "pcb_copper_pour"), chiuso];
    expect(dalRame(salvata, "inner1", giu)).toBe(0);

    const regole = { clearanceMm: 0.152, bordoMm: 0.3, larghezzaMinimaMm: 0.127 };
    const prima = vieSemprePassanti(salvata);
    const r = await ricolaSeLeVieEranoParziali({ circuitJson: prima as never, engineVersion: ENGINE_VIE_PASSANTI - 1, ...regole });
    expect(r).toMatchObject({ ricolata: true, vieParziali: 2 });
    expect(dalRame(r.circuitJson as El[], "inner1", giu)).toBeGreaterThanOrEqual(0.152 - 0.01);

    // a board made by this engine keeps its planes: they were poured seeing the hole
    const oggi = await ricolaSeLeVieEranoParziali({ circuitJson: prima as never, engineVersion: ENGINE_VIE_PASSANTI, ...regole });
    expect(oggi.ricolata).toBe(false);
    expect(oggi.circuitJson).toBe(prima);
    // and so does an older board whose vias all went from top to bottom
    const passanti = salvata.map((e) => (e.type === "pcb_via" ? { ...e, layers: ["top", "inner1", "inner2", "bottom"] } : e));
    const vecchia = await ricolaSeLeVieEranoParziali({ circuitJson: passanti as never, engineVersion: ENGINE_VIE_PASSANTI - 1, ...regole });
    expect(vecchia).toMatchObject({ ricolata: false, vieParziali: 0 });
    expect(vecchia.circuitJson).toBe(passanti);
  }, 120_000);
});
