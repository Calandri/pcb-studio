import { describe, expect, it } from "vitest";
import { convertSoupToGerberCommands, stringifyGerberCommandLayers } from "circuit-json-to-gerber";
import { senzaRotazioneDiCarico } from "@/lib/gerber-rotation";

/** the polygons of every region in a layer, in mm */
const regioni = (gerber: string, decimali = 6): Array<Array<[number, number]>> => {
  const out: Array<Array<[number, number]>> = [];
  let cur: Array<[number, number]> | null = null;
  for (const r of gerber.split("\n")) {
    if (r === "G36*") cur = [];
    else if (r === "G37*") {
      if (cur) out.push(cur);
      cur = null;
    } else if (cur) {
      const m = r.match(/^X(-?\d+)Y(-?\d+)D0[12]\*$/);
      if (m) cur.push([Number(m[1]) / 10 ** decimali, Number(m[2]) / 10 ** decimali]);
    }
  }
  return out;
};

const scheda = { type: "pcb_board", pcb_board_id: "b", center: { x: 0, y: 0 }, width: 20, height: 20, thickness: 1.6, num_layers: 2, material: "fr4" };

describe("piazzole ruotate senza %LR", () => {
  it("una piazzola dell'LQFP a 135 gradi diventa una regione ruotata, non un rettangolo dritto", () => {
    const cj = [
      scheda,
      { type: "pcb_smtpad", pcb_smtpad_id: "p1", shape: "rotated_rect", x: 2, y: 1, width: 0.305, height: 1.194, ccw_rotation: 135, layer: "top" },
      { type: "pcb_smtpad", pcb_smtpad_id: "p2", shape: "rect", x: -3, y: 0, width: 0.6, height: 0.64, layer: "top" },
    ];
    const grezzi = stringifyGerberCommandLayers(convertSoupToGerberCommands(cj as never)) as Record<string, string>;
    // the library really does write it as a rotated aperture
    expect(grezzi.F_Cu).toMatch(/%LR135\*%/);

    const { layers, regioni: n, nonConvertiti } = senzaRotazioneDiCarico(grezzi);
    expect(nonConvertiti).toEqual([]);
    for (const nome of ["F_Cu", "F_Mask", "F_Paste"]) expect(layers[nome]).not.toMatch(/%LR/);
    expect(n).toBeGreaterThanOrEqual(1);

    const [poli] = regioni(layers.F_Cu);
    // closed outline: 4 corners and back to the first
    expect(poli).toHaveLength(5);
    const t = (135 * Math.PI) / 180;
    const atteso = [[-0.1525, -0.597], [0.1525, -0.597], [0.1525, 0.597], [-0.1525, 0.597]].map(([px, py]) => [
      2 + px * Math.cos(t) - py * Math.sin(t),
      1 + px * Math.sin(t) + py * Math.cos(t),
    ]);
    for (let i = 0; i < 4; i++) {
      expect(poli[i][0]).toBeCloseTo(atteso[i][0], 5);
      expect(poli[i][1]).toBeCloseTo(atteso[i][1], 5);
    }
    // the pad at 0 degrees is still an ordinary flash
    expect(layers.F_Cu).toMatch(/X-3000000Y0D03\*|X-03000000Y000000000D03\*|X-?0*3000000Y-?0*D03\*/);
  });

  it("uno strato senza rotazioni esce identico, un'apertura tonda ruotata resta un flash", () => {
    const senza = "%FSLAX46Y46*%\n%MOMM*%\n%ADD10C,0.5*%\nD10*\nX1000000Y1000000D03*\nM02*\n";
    const tonda = "%FSLAX46Y46*%\n%MOMM*%\n%ADD10C,0.5*%\nD10*\n%LR45*%\nX1000000Y1000000D03*\n%LR0*%\nM02*\n";
    const { layers, regioni: n } = senzaRotazioneDiCarico({ A: senza, B: tonda });
    expect(layers.A).toBe(senza);
    expect(layers.B).not.toMatch(/%LR/);
    expect(layers.B).toMatch(/X1000000Y1000000D03\*/);
    expect(n).toBe(0);
  });

  it("dopo una regione la coordinata che il file dava per sottintesa viene scritta per intero", () => {
    const g = "%FSLAX46Y46*%\n%MOMM*%\n%ADD10R,1X0.5*%\n%ADD11C,0.2*%\nD10*\n%LR90*%\nX1000000Y2000000D03*\n%LR0*%\nD11*\nY3000000D02*\nX4000000D01*\nM02*\n";
    const { layers } = senzaRotazioneDiCarico({ F_Cu: g });
    // the move kept X=1 from the flash: after the region it must say so
    expect(layers.F_Cu).toMatch(/\nX1000000Y3000000D02\*\n/);
    expect(layers.F_Cu).toMatch(/\nX4000000D01\*\n/);
    const [poli] = regioni(layers.F_Cu);
    // 1 x 0.5 turned by 90 degrees: 0.5 wide in x, 1 tall in y
    const xs = poli.map((p) => p[0]);
    const ys = poli.map((p) => p[1]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(0.5, 6);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(1, 6);
  });

  it("uno strato che non sa convertire per intero resta com'era ed e' segnalato", () => {
    const g = "%FSLAX46Y46*%\n%MOMM*%\n%ADD10R,1X0.5*%\nD10*\n%LR30*%\nX0Y0D02*\nX1000000Y0D01*\n%LR0*%\nM02*\n";
    const { layers, nonConvertiti } = senzaRotazioneDiCarico({ F_Cu: g });
    expect(nonConvertiti).toEqual(["F_Cu"]);
    expect(layers.F_Cu).toBe(g);
  });
});
