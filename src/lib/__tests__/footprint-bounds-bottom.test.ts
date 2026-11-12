import { describe, expect, it } from "vitest";
import { runTscircuitCode } from "@tscircuit/eval";
import { misuraIngombri } from "@/lib/component-clearance";
import { corpoDelPezzo } from "@/lib/footprint-bounds";
import { leggiIngombri } from "@/lib/ingombro";

/*
 * THE BODY OF A PART ON THE BOTTOM. tscircuit writes cad_component.rotation
 * {x: 0, y: 180, z: -θ} for a part on the bottom turned by θ, while its pads
 * are mirrored in x and turned by +θ. Reading z as the body's angle turned a
 * body at 45 degrees by 90, and an off-centre model box ended on the other
 * side of the origin at 90: a capacitor under the real body of a part on the
 * bottom read clear (review of 12/11/2026).
 */
type El = Record<string, unknown> & { type: string };

/**
 * A footprint whose pads are symmetric about its origin (so tscircuit puts the
 * model at the origin), with two tiny marker pads at the two ends of the long
 * axis of the model's box: 2 x 0,5 centred at (1; 0,5). Wherever tscircuit
 * puts the pads, the box must lie between the two markers.
 */
const pezzo = (name: string, layer: string, rot: number, x: number) => `
  <chip name="${name}" layer="${layer}" pcbX={${x}} pcbY={0} pcbRotation={${rot}}
    footprint={<footprint>
      <smtpad portHints={["1"]} pcbX={-2} pcbY={-1} width={0.5} height={0.5} shape="rect" />
      <smtpad portHints={["2"]} pcbX={2} pcbY={-1} width={0.5} height={0.5} shape="rect" />
      <smtpad portHints={["3"]} pcbX={2} pcbY={1} width={0.5} height={0.5} shape="rect" />
      <smtpad portHints={["4"]} pcbX={-2} pcbY={1} width={0.5} height={0.5} shape="rect" />
      <smtpad portHints={["5"]} pcbX={0} pcbY={0.5} width={0.1} height={0.1} shape="rect" />
      <smtpad portHints={["6"]} pcbX={2} pcbY={0.5} width={0.1} height={0.1} shape="rect" />
    </footprint>}
    cadModel={{ jscad: { type: "cuboid", size: [2, 0.5, 1], center: [1, 0.5, 0.5] } }}
  />`;

const ANGOLI = [0, 45, 90, 135, 180, 270, 315];

describe("the body of a part on the bottom lies where its pads are", () => {
  it("tscircuit's convention, measured: z = -θ on the bottom, and the model's box lands between its marker pads on both faces", async () => {
    const casi = ["top", "bottom"].flatMap((layer) => ANGOLI.map((rot) => ({ layer, rot })));
    const code = `export default () => (<board width="200mm" height="20mm">${casi.map((c, k) => pezzo(`U${k + 1}`, c.layer, c.rot, -90 + k * 12)).join("\n")}</board>)`;
    const cj = (await runTscircuitCode({ "main.tsx": code }, { mainComponentPath: "main.tsx" })) as El[];
    casi.forEach((c, k) => {
      const sc = cj.find((e) => e.type === "source_component" && e.name === `U${k + 1}`)!;
      const pc = cj.find((e) => e.type === "pcb_component" && e.source_component_id === sc.source_component_id)!;
      const cad = cj.find((e) => e.type === "cad_component" && e.pcb_component_id === pc.pcb_component_id)!;
      // the convention itself
      expect(pc.rotation).toBe(c.rot);
      expect(cad.rotation).toEqual({ x: 0, y: c.layer === "bottom" ? 180 : 0, z: c.layer === "bottom" ? (360 - c.rot) % 360 : c.rot });
      const segni = cj.filter((e) => e.type === "pcb_smtpad" && e.pcb_component_id === pc.pcb_component_id && Number(e.width) < 0.2) as Array<El & { x: number; y: number }>;
      expect(segni).toHaveLength(2);
      const [a, b] = segni;
      const corpo = corpoDelPezzo(cad, { dalModello: true })!;
      // the box's centre halfway between the markers
      expect(corpo.x).toBeCloseTo((a.x + b.x) / 2, 6);
      expect(corpo.y).toBeCloseTo((a.y + b.y) / 2, 6);
      // its long side along them: the rectangle's angle is the markers' direction, modulo a half turn
      const direzione = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
      const scarto = ((((corpo.rot - direzione) % 180) + 180) % 180);
      expect(Math.min(scarto, 180 - scarto)).toBeLessThan(1e-6);
      expect(corpo).toMatchObject({ w: 2, h: 0.5 });
    });
  }, 120_000);

  /*
   * The reviewer's case: a body 4 x 1 at 45 degrees, no courtyard, and a
   * capacitor inside the real body. The cad_component written as tscircuit
   * writes it on each face.
   */
  const scena = (layer: "top" | "bottom"): El[] => {
    const c = Math.SQRT1_2;
    const lungo = (t: number) => ({ x: t * c, y: t * c });
    const sotto = layer === "bottom";
    const pad = (id: string, p: { x: number; y: number }, w: number, h: number, rot: number) => ({
      type: "pcb_smtpad",
      pcb_smtpad_id: `${id}_${p.x}_${p.y}`,
      pcb_component_id: id,
      shape: "rotated_rect",
      x: p.x,
      y: p.y,
      width: w,
      height: h,
      ccw_rotation: rot,
      layer,
    });
    return [
      { type: "source_component", source_component_id: "s_U1", name: "U1", ftype: "simple_chip" },
      { type: "pcb_component", pcb_component_id: "U1", source_component_id: "s_U1", center: { x: 0, y: 0 }, layer, rotation: 45, width: 1, height: 1 },
      pad("U1", lungo(-0.4), 0.3, 0.3, 45),
      pad("U1", lungo(0.4), 0.3, 0.3, 45),
      {
        type: "cad_component",
        cad_component_id: "cad_U1",
        pcb_component_id: "U1",
        source_component_id: "s_U1",
        position: { x: 0, y: 0, z: sotto ? -0.7 : 0.7 },
        rotation: { x: 0, y: sotto ? 180 : 0, z: sotto ? 315 : 45 },
        model_jscad: { type: "cuboid", size: [4, 1, 1], center: [0, 0, 0.5] },
      },
      // a capacitor 1,5 mm along the body's axis: under the real body
      { type: "source_component", source_component_id: "s_C1", name: "C1", ftype: "simple_chip" },
      { type: "pcb_component", pcb_component_id: "C1", source_component_id: "s_C1", center: lungo(1.5), layer, rotation: 45, width: 1, height: 1 },
      pad("C1", lungo(1.4), 0.1, 0.1, 45),
      pad("C1", lungo(1.6), 0.1, 0.1, 45),
    ] as El[];
  };

  it("a capacitor under the body of a part at 45 degrees hits it on the bottom as on the top", () => {
    const sopra = misuraIngombri(scena("top"), 0.2).scontri;
    const sotto = misuraIngombri(scena("bottom"), 0.2).scontri;
    expect(sopra.map((s) => [s.a, s.b])).toEqual([["U1", "C1"]]);
    expect(sotto.map((s) => [s.a, s.b, s.faccia])).toEqual([["U1", "C1", "bottom"]]);
    expect(sotto[0].sovrapposizioneMm).toBeCloseTo(sopra[0].sovrapposizioneMm, 6);
    // the same footprint on both faces: the body's rectangle turned with the part, not across it
    const [u1sopra] = leggiIngombri(scena("top"), 0.2);
    const [u1sotto] = leggiIngombri(scena("bottom"), 0.2);
    expect(u1sotto.forme[0].box).toEqual(u1sopra.forme[0].box);
  });

  it("a box off the model's origin on the bottom at 90 degrees stays on its side of the origin", () => {
    // the model's box 1 mm along x of the footprint: on the bottom, mirrored to -1, then turned by 90 to (0; -1)
    const cad = {
      type: "cad_component",
      position: { x: 0, y: 0, z: -0.7 },
      rotation: { x: 0, y: 180, z: 270 },
      model_jscad: { type: "cuboid", size: [1, 0.5, 1], center: [1, 0, 0.5] },
    };
    const c = corpoDelPezzo(cad, { dalModello: true })!;
    expect(c.x).toBeCloseTo(0, 9);
    expect(c.y).toBeCloseTo(-1, 9);
    expect(c.rot).toBe(90);
    // a model flipped about x (rotation.x 180) mirrors y, not x
    const suX = corpoDelPezzo({ ...cad, rotation: { x: 180, y: 0, z: 0 }, model_jscad: { type: "cuboid", size: [1, 0.5, 1], center: [1, 0.5, 0.5] } }, { dalModello: true })!;
    expect(suX.x).toBeCloseTo(1, 9);
    expect(suX.y).toBeCloseTo(-0.5, 9);
    // a model stood on its side has no w x h on the board
    expect(corpoDelPezzo({ ...cad, rotation: { x: 90, y: 0, z: 0 } }, { dalModello: true })).toBeNull();
  });
});
