import { getManifoldModuleSync } from "@tscircuit/manifold-2d";
import { describe, expect, it } from "vitest";
import { DEFAULT_DESIGN_RULES, DESIGN_RULES_PATH, type DesignRules } from "@/lib/design-rules";
import { cuciLaMassa } from "@/lib/ground-stitching";
import { eseguiCucitura } from "@/lib/ground-stitching-tool";

/*
 * Se una colata di un'altra rete regge una via che la attraversa si misura col
 * motore geometrico delle colate, che si carica in modo asincrono. In questo
 * file nessuno lo carica prima: senza, la cucitura fa quello che faceva (ogni
 * colata di un'altra rete e' un ostacolo) e lo dice; lo strumento lo carica da
 * se' prima di cucire.
 */
type El = { type: string; [key: string]: unknown };
const REGOLE: DesignRules = { ...DEFAULT_DESIGN_RULES, minTraceWidthMm: 0.15, minClearanceMm: 0.15, minViaHoleMm: 0.15, minViaDiameterMm: 0.5, pourClearanceMm: 0.25 };
const rett = (x0: number, y0: number, x1: number, y1: number) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
const colata = (layer: string, net: string): El => ({
  type: "pcb_copper_pour", pcb_copper_pour_id: `colata_${layer}`, layer, source_net_id: net, shape: "brep",
  brep_shape: { outer_ring: { vertices: rett(-5.7, -7.7, 5.7, 7.7) }, inner_rings: [] },
});
/** ground on top, inner1 and bottom, the P3V3 plane whole on inner2 */
const scheda: El[] = [
  { type: "pcb_board", pcb_board_id: "b", width: 12, height: 16, center: { x: 0, y: 0 }, num_layers: 4 },
  { type: "source_net", source_net_id: "source_net_0", name: "GND", subcircuit_connectivity_map_key: "k_gnd", subcircuit_id: "s" },
  { type: "source_net", source_net_id: "source_net_1", name: "P3V3", subcircuit_connectivity_map_key: "k_p3v3", subcircuit_id: "s" },
  ...["top", "inner1", "bottom"].map((s) => colata(s, "source_net_0")),
  colata("inner2", "source_net_1"),
];

describe("senza il motore geometrico delle colate", () => {
  it("ogni colata di un'altra rete resta un ostacolo, come prima, e la risposta lo dice", () => {
    expect(getManifoldModuleSync()).toBeNull();
    const e = cuciLaMassa(scheda, REGOLE);
    if (!e.ok) throw new Error(e.errore);
    expect(e.vie).toHaveLength(0);
    expect(e.pianiAttraversati).toEqual({ vie: 0, piani: [] });
    expect(e.scarti.colata_altra_rete).toBeGreaterThan(0);
    expect(e.avvisi.join(" ")).toMatch(/motore geometrico delle colate non e' caricato/);
  });

  it("lo strumento lo carica prima di cucire", async () => {
    const files = { "main.tsx": "", [DESIGN_RULES_PATH]: JSON.stringify({ preset: "custom", rules: REGOLE }) };
    const visto = await eseguiCucitura({ files, args: {}, cache: { circuitJson: scheda }, scheda: "aggiornata", scrivi: async () => { throw new Error("un dryRun non scrive"); } });
    expect(getManifoldModuleSync()).not.toBeNull();
    expect(visto.result.vie as number).toBeGreaterThan(8);
    expect(visto.result.pianiAttraversati).toMatchObject({ vie: visto.result.vie, piani: [{ rete: "P3V3", strato: "inner2" }] });
    expect((visto.result.avvisi as string[]).join(" ")).not.toMatch(/motore geometrico/);
  });
});
