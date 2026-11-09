import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { raddrizzaCircuito, raddrizzaNativo } from "@/lib/altium-raddrizza";

/*
 * 2026-11-09: altium-toolkit consegna un .PcbDoc specchiato in y (vista SVG
 * dall'alto) e l'import lo prendeva cosi': su TM_4L U2 pin 1 a (-18,45; -5,65)
 * invece di (-18,45; 5,65), i piedini in senso orario, ogni rotazione col segno
 * cambiato. Qui si usa il ribaltamento VERO del toolkit su una piccola scheda
 * asimmetrica scritta a mano, e si controlla che l'import la rimetta dritta.
 */
type El = Record<string, unknown>;
const flipper = async () => {
  const p = path.join(process.cwd(), "node_modules/altium-toolkit/src/core/altium/PcbGeometryFlipper.mjs");
  return ((await import(pathToFileURL(p).href)) as { PcbGeometryFlipper: { flipGeometryVertically: (pcb: El) => El } })
    .PcbGeometryFlipper;
};

// U1: four pins counter-clockwise seen from above, 1 on top; a part turned 90; an arc; a text
const RAW: El = {
  boardOutline: {
    minX: 1000, minY: 1000, widthMil: 2000, heightMil: 1500,
    segments: [{ type: "line", x1: 1000, y1: 1000, x2: 3000, y2: 1000 }, { type: "arc", x1: 3000, y1: 1000, x2: 3000, y2: 2500, cx: 3000, cy: 1750, startAngle: 270, endAngle: 90 }],
  },
  components: [
    { designator: "U1", x: 2000, y: 2000, rotation: 0, layer: "TOP" },
    { designator: "R4", x: 2500, y: 1300, rotation: 90, layer: "TOP" },
  ],
  pads: [
    { name: "1", x: 2000, y: 2100, rotation: 0 },
    { name: "2", x: 1900, y: 2000, rotation: 90 },
    { name: "3", x: 2000, y: 1900, rotation: 0 },
    { name: "4", x: 2100, y: 2000, rotation: 90 },
  ],
  tracks: [{ x1: 2100, y1: 2000, x2: 2500, y2: 1300 }],
  arcs: [{ x: 2000, y: 2000, radius: 200, startAngle: 30, endAngle: 120 }],
  vias: [{ x: 2400, y: 1400 }],
  texts: [{ text: "U1", x: 2000, y: 2250, rotation: 45 }],
  regions: [{ points: [{ x: 1100, y: 1100 }, { x: 1200, y: 1100 }, { x: 1200, y: 1300 }] }],
  fills: [{ x1: 1500, y1: 1200, x2: 1600, y2: 1400 }],
};
const ang = (p: El, c: El) => Math.atan2(Number(p.y) - Number(c.y), Number(p.x) - Number(c.x));

describe("una scheda importata da Altium non e' specchiata", () => {
  it("il ribaltamento del toolkit viene tolto: posizioni, rotazioni, archi e regioni come nel file", async () => {
    const F = await flipper();
    const comeArriva = F.flipGeometryVertically(structuredClone(RAW));
    // the toolkit really mirrors it: pin 1 goes below the part
    expect((comeArriva.pads as El[])[0].y).toBeLessThan(((comeArriva.components as El[])[0].y as number));
    const dritto = raddrizzaNativo(comeArriva);
    for (const k of ["components", "pads", "tracks", "arcs", "vias", "texts", "fills"]) {
      expect(dritto[k], k).toEqual((RAW[k] as El[]).map((x) => expect.objectContaining(x)));
    }
    expect((dritto.regions as El[])[0].points).toEqual((RAW.regions as Array<{ points: El[] }>)[0].points.map((p) => expect.objectContaining(p)));
    expect((dritto.boardOutline as { segments: El[] }).segments).toEqual(
      (RAW.boardOutline as { segments: El[] }).segments.map((s) => expect.objectContaining(s)),
    );
  });

  it("pin 1 sopra, piedini in senso antiorario, R4 a 90 gradi", async () => {
    const dritto = raddrizzaNativo((await flipper()).flipGeometryVertically(structuredClone(RAW)));
    const [u1, r4] = dritto.components as El[];
    const pads = dritto.pads as El[];
    expect(Number(pads[0].y)).toBeGreaterThan(Number(u1.y));
    // counter-clockwise: the angle grows from pin 1 to pin 4 (modulo a turn)
    const a = pads.map((p) => ang(p, u1));
    for (let i = 1; i < a.length; i++) {
      const d = (((a[i] - a[i - 1]) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      expect(d).toBeGreaterThan(0);
      expect(d).toBeLessThan(Math.PI);
    }
    expect(r4.rotation).toBe(90);
  });

  it("anche il Circuit JSON del toolkit torna dritto, sullo stesso asse", () => {
    // axis in mil: 2*minY + height = 3500; the toolkit's model is K - y in mm
    const K = 3500 * 0.0254;
    const comeArriva: El[] = [
      { type: "pcb_component", center: { x: 50.8, y: K - 50.8 }, rotation: 270 },
      { type: "pcb_smtpad", x: 50.8, y: K - 53.34, ccw_rotation: 0 },
      { type: "pcb_plated_hole", x: 10, y: K - 20, hole_offset_y: -0.2, rect_ccw_rotation: 30 },
    ];
    const [c, p, h] = raddrizzaCircuito(comeArriva, 3500);
    expect(c.center).toEqual({ x: 50.8, y: 50.8 });
    expect(c.rotation).toBe(90);
    expect(p.y).toBeCloseTo(53.34, 6);
    expect(h).toMatchObject({ hole_offset_y: 0.2, rect_ccw_rotation: 330 });
    expect(h.y).toBeCloseTo(20, 6);
  });
});
