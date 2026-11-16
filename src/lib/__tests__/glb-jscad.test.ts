import { convertCircuitJsonToGltf } from "circuit-json-to-gltf";
import { describe, expect, it } from "vitest";
import { coloreDelPiano, raddrizzaPezziJscad } from "@/lib/glb-jscad";

/*
 * THE JSCAD PARTS OF THE 3D VIEW, through the real converter. On
 * sbb-dl-principale (16/11/2026) every cadModel={{ jscad }} box came out of the
 * GLB inside out and grey: only its far walls and its floor were drawn, the floor
 * fighting with the board's face (black stripes). After raddrizzaPezziJscad each
 * box is right side out, in its declared colour, and an off-centre box (J3) sits
 * where it was declared.
 */
type El = Record<string, unknown> & { type: string };

const pezzo = (n: number, nome: string, x: number, y: number, rotZ: number, jscad: unknown): El[] => [
  { type: "source_component", source_component_id: `sc${n}`, name: nome, ftype: "simple_chip" },
  {
    type: "pcb_component",
    pcb_component_id: `pc${n}`,
    source_component_id: `sc${n}`,
    center: { x, y },
    width: 2,
    height: 2,
    layer: "top",
    rotation: rotZ,
  },
  {
    type: "cad_component",
    cad_component_id: `cad${n}`,
    pcb_component_id: `pc${n}`,
    source_component_id: `sc${n}`,
    position: { x, y, z: 0.8 },
    rotation: { x: 0, y: 0, z: rotZ },
    model_jscad: jscad,
    model_origin_alignment: "center_of_component_on_board_surface",
  },
];

const scheda: El[] = [
  {
    type: "pcb_board",
    pcb_board_id: "b0",
    center: { x: 0, y: 0 },
    width: 60,
    height: 60,
    thickness: 1.6,
    num_layers: 2,
    material: "fr4",
  },
  // two equal boxes in two colours: the converter gives them one mesh
  ...pezzo(1, "U1", -10, 5, 0, { type: "colorize", color: [0.12, 0.12, 0.13], shape: { type: "cuboid", size: [4, 3, 1.2], center: [0, 0, 0.6] } }),
  ...pezzo(2, "U2", 10, 5, 0, { type: "colorize", color: [0.85, 0.75, 0.3], shape: { type: "cuboid", size: [4, 3, 1.2], center: [0, 0, 0.6] } }),
  // the J3 of sbb-dl-principale: a box declared 1,85 mm off the part, turned by 90
  ...pezzo(3, "J3", 22.75, -22.125, 90, { type: "colorize", color: [0.93, 0.93, 0.9], shape: { type: "cuboid", size: [14.9, 11.5, 6.1], center: [0, 1.85, 3.05] } }),
];

interface Glb {
  json: {
    nodes: Array<{ name?: string; mesh?: number; translation?: number[] }>;
    meshes: Array<{ primitives: Array<{ indices: number; material: number; attributes: Record<string, number> }> }>;
    materials: Array<{ pbrMetallicRoughness?: { baseColorFactor?: number[] } }>;
    accessors: Array<{ bufferView: number; byteOffset?: number; componentType: number; count: number }>;
    bufferViews: Array<{ byteOffset?: number }>;
  };
  bin: DataView;
}

function leggiGlb(buf: ArrayBuffer): Glb {
  const v = new DataView(buf);
  const jsonLen = v.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jsonLen)));
  const binLen = v.getUint32(20 + jsonLen, true);
  return { json, bin: new DataView(buf, 28 + jsonLen, binLen) };
}

function numeri(g: Glb, accessor: number, comp: number): number[] {
  const a = g.json.accessors[accessor];
  const start = (g.json.bufferViews[a.bufferView].byteOffset ?? 0) + (a.byteOffset ?? 0);
  const out: number[] = [];
  for (let i = 0; i < a.count * comp; i++) {
    out.push(
      a.componentType === 5126
        ? g.bin.getFloat32(start + i * 4, true)
        : a.componentType === 5125
          ? g.bin.getUint32(start + i * 4, true)
          : g.bin.getUint16(start + i * 2, true),
    );
  }
  return out;
}

/** the part's node, the volume its triangles enclose (negative = inside out) and its colour */
function parte(g: Glb, nome: string) {
  const node = g.json.nodes.find((n) => n.name === nome)!;
  const prim = g.json.meshes[node.mesh!].primitives[0];
  const p = numeri(g, prim.attributes.POSITION, 3);
  const idx = numeri(g, prim.indices, 1);
  let volume = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]].map((i) => p.slice(i * 3, i * 3 + 3));
    volume += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  return { node, volume, colore: g.json.materials[prim.material].pbrMetallicRoughness?.baseColorFactor };
}

async function glbDi(circuito: El[]): Promise<ArrayBuffer> {
  const out = await convertCircuitJsonToGltf(structuredClone(circuito) as never, {
    format: "glb",
    // no board texture: only the parts matter here, and it is faster
    boardTextureResolution: 0,
  });
  const u8 = out instanceof ArrayBuffer ? new Uint8Array(out) : (out as Uint8Array);
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

describe("the jscad parts of the 3D view", () => {
  it("come out right side out, in their own colour, and J3 where it was declared", async () => {
    const g = leggiGlb(raddrizzaPezziJscad(await glbDi(scheda), scheda));

    const u1 = parte(g, "U1");
    const u2 = parte(g, "U2");
    const j3 = parte(g, "J3");
    expect(u1.volume).toBeCloseTo(4 * 3 * 1.2, 3);
    expect(u2.volume).toBeCloseTo(4 * 3 * 1.2, 3);
    expect(j3.volume).toBeCloseTo(14.9 * 11.5 * 6.1, 1);
    expect(u1.colore).toEqual([0.12, 0.12, 0.13, 1]);
    expect(u2.colore).toEqual([0.85, 0.75, 0.3, 1]);

    // turned by 90, the declared 1,85 mm along the part's y go to -x on the
    // board (corpoDelPezzo); glTF x is the board's -x
    expect(j3.node.translation![0]).toBeCloseTo(-(22.75 - 1.85), 6);
    expect(j3.node.translation![2]).toBeCloseTo(-22.125, 6);
    expect(u1.node.translation![0]).toBeCloseTo(10, 6);
  }, 120_000);

  it("a second pass changes nothing that is already right", async () => {
    const una = raddrizzaPezziJscad(await glbDi(scheda), scheda);
    const g = leggiGlb(raddrizzaPezziJscad(una, scheda));
    expect(parte(g, "U1").volume).toBeGreaterThan(0);
    expect(parte(g, "J3").node.translation![0]).toBeCloseTo(-(22.75 - 1.85), 6);
  }, 120_000);

  it("leaves alone what is not a GLB or has no jscad parts", () => {
    const testo = new TextEncoder().encode('{"asset":{}}').buffer as ArrayBuffer;
    expect(raddrizzaPezziJscad(testo, scheda)).toBe(testo);
    const vuoto = new ArrayBuffer(64);
    expect(raddrizzaPezziJscad(vuoto, [])).toBe(vuoto);
  });

  it("reads the colour of a plan wherever its colorize is", () => {
    expect(coloreDelPiano({ type: "colorize", color: [1, 0, 0], shape: {} })).toEqual([1, 0, 0, 1]);
    expect(coloreDelPiano({ type: "union", shapes: [{ type: "cuboid" }, { type: "colorize", color: [0, 0, 1, 0.5] }] })).toEqual([0, 0, 1, 0.5]);
    expect(coloreDelPiano({ type: "cuboid", size: [1, 1, 1] })).toBeNull();
    expect(coloreDelPiano({ type: "colorize", color: [255, 0, 0] })).toBeNull();
  });
});
