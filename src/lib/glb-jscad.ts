import { scostamentoDelModello } from "./footprint-bounds";

/**
 * THE PARTS DRAWN WITH cadModel={{ jscad }} CAME OUT OF THE GLB INSIDE OUT.
 *
 * circuit-json-to-gltf 0.0.107 turns a jscad plan into triangles, reverses them
 * once (as it does for STL) and once more when it mirrors x for glTF. OBJ models
 * pass through a third, mirroring axis swap and come out right; jscad parts do
 * not: every triangle faces inwards while its normal still points out. The
 * viewer culls the faces it sees from outside, so on the 3D view of
 * sbb-dl-principale (152 jscad parts, 16/11/2026) each box showed only its far
 * walls (the grey "walls") and its floor, which lies exactly on the board's top
 * face and fought with it (the black stripes), or hung black over the edge.
 * The same converter also drops the colour of `colorize` and paints every jscad
 * part 50% grey, and re-centres the model on the part: a box declared off the
 * part's origin (J3, a connector 1,85 mm towards the board) moved over the edge,
 * where neither the tscircuit viewer nor our clearance checks (corpoDelPezzo)
 * put it.
 *
 * Here the finished GLB is corrected in place, before it is cached and sent:
 * the triangles of the jscad parts are turned back to agree with their normals
 * (only where most of them disagree, so a fixed converter is left alone), each
 * part gets its declared colour, and an off-centre box goes back where it was
 * declared (only if the converter centred it). The GLB is also what an agent
 * reads, so it is fixed at the source, not in the canvas.
 */

type El = Record<string, unknown> & { type: string };

interface GltfJson {
  nodes?: Array<{ name?: string; mesh?: number; translation?: number[] }>;
  meshes?: Array<{ name?: string; primitives: Array<{ indices?: number; material?: number; attributes: Record<string, number> }> }>;
  materials?: Array<Record<string, unknown>>;
  accessors?: Array<{
    bufferView?: number;
    byteOffset?: number;
    componentType: number;
    count: number;
    type: string;
    min?: number[];
    max?: number[];
  }>;
  bufferViews?: Array<{ byteOffset?: number; byteLength: number }>;
}

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

/** the colour a jscad plan declares (first `colorize` met), as RGBA 0..1 */
export function coloreDelPiano(plan: unknown): [number, number, number, number] | null {
  if (!plan || typeof plan !== "object") return null;
  if (Array.isArray(plan)) {
    for (const p of plan) {
      const c = coloreDelPiano(p);
      if (c) return c;
    }
    return null;
  }
  const o = plan as Record<string, unknown>;
  if (o.type === "colorize" && Array.isArray(o.color) && o.color.length >= 3) {
    const [r, g, b, a] = o.color.map(Number);
    if ([r, g, b].every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) {
      return [r, g, b, Number.isFinite(a) && a > 0 && a <= 1 ? a : 1];
    }
  }
  for (const v of Object.values(o)) {
    if (v && typeof v === "object") {
      const c = coloreDelPiano(v);
      if (c) return c;
    }
  }
  return null;
}

/** name of the part (what the converter writes on the GLB node) -> its cad_component with a jscad plan */
function pezziJscad(circuitJson: unknown): Map<string, El> {
  const el = (Array.isArray(circuitJson) ? circuitJson : []) as El[];
  const nomi = new Map<string, string>();
  for (const e of el) {
    if (e.type === "source_component" && typeof e.name === "string") {
      nomi.set(String(e.source_component_id), e.name);
    }
  }
  const out = new Map<string, El>();
  for (const e of el) {
    if (e.type !== "cad_component" || !e.model_jscad) continue;
    // a part with a mesh file is drawn from the file, not from the plan
    if (e.model_stl_url || e.model_obj_url || e.model_glb_url || e.model_gltf_url || e.model_step_url) continue;
    const nome = nomi.get(String(e.source_component_id));
    if (nome) out.set(nome, e);
  }
  return out;
}

/**
 * The GLB with the jscad parts turned right side out and in their colour. A
 * buffer that is not a GLB, or a board without jscad parts, comes back as is.
 */
export function raddrizzaPezziJscad(glb: ArrayBuffer, circuitJson: unknown): ArrayBuffer {
  const piani = pezziJscad(circuitJson);
  if (piani.size === 0 || glb.byteLength < 20) return glb;
  const vista = new DataView(glb);
  if (vista.getUint32(0, true) !== GLB_MAGIC) return glb;

  const jsonLen = vista.getUint32(12, true);
  if (vista.getUint32(16, true) !== CHUNK_JSON) return glb;
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, jsonLen))) as GltfJson;
  const binHeader = 20 + jsonLen;
  if (binHeader + 8 > glb.byteLength || vista.getUint32(binHeader + 4, true) !== CHUNK_BIN) return glb;
  const binLen = vista.getUint32(binHeader, true);
  // a copy: the converter's buffer is not ours to change
  const bin = new Uint8Array(glb.slice(binHeader + 8, binHeader + 8 + binLen));
  const binView = new DataView(bin.buffer);

  const nodes = json.nodes ?? [];
  const meshes = (json.meshes ??= []);
  const materials = (json.materials ??= []);
  const giaGirati = new Set<number>();
  const materialePerColore = new Map<string, number>();
  let cambiato = false;

  for (const node of nodes) {
    if (node.mesh === undefined || !node.name || !piani.has(node.name)) continue;
    const mesh = meshes[node.mesh];
    if (!mesh) continue;

    for (const prim of mesh.primitives) {
      if (prim.indices === undefined || giaGirati.has(prim.indices)) continue;
      if (girataAlContrario(json, binView, prim)) {
        giraTriangoli(json, binView, prim.indices);
        giaGirati.add(prim.indices);
        cambiato = true;
      }
    }

    const cad = piani.get(node.name)!;
    const scosta = scostamentoDelModello(cad);
    // glTF node = [-x, height, y] of the board (circuit-json-to-gltf toGltfTranslation)
    const [tx, ty, tz] = node.translation ?? [0, 0, 0];
    const pos = cad.position as { x?: unknown; y?: unknown } | undefined;
    const sullOrigine =
      typeof pos?.x === "number" && typeof pos?.y === "number" && Math.abs(tx + pos.x) < 1e-6 && Math.abs(tz - pos.y) < 1e-6;
    if (scosta && (Math.abs(scosta.x) > 1e-6 || Math.abs(scosta.y) > 1e-6) && sullOrigine && centrata(json, mesh)) {
      node.translation = [tx - scosta.x, ty, tz + scosta.y];
      cambiato = true;
    }

    const colore = coloreDelPiano(cad.model_jscad);
    if (!colore) continue;
    const chiave = colore.map((v) => v.toFixed(4)).join(",");
    let materiale = materialePerColore.get(chiave);
    if (materiale === undefined) {
      materiale = materials.length;
      materials.push({
        name: `jscad_${chiave}`,
        pbrMetallicRoughness: { baseColorFactor: colore, metallicFactor: 0, roughnessFactor: 0.7 },
        alphaMode: colore[3] < 1 ? "BLEND" : "OPAQUE",
      });
      materialePerColore.set(chiave, materiale);
    }
    // the converter shares one mesh among identical boxes: each part gets its
    // own mesh entry (same accessors), so two equal boxes can differ in colour
    node.mesh = meshes.length;
    meshes.push({ name: mesh.name, primitives: mesh.primitives.map((p) => ({ ...p, material: materiale })) });
    cambiato = true;
  }
  if (!cambiato) return glb;

  const testo = new TextEncoder().encode(JSON.stringify(json));
  const jsonPad = (4 - (testo.length % 4)) % 4;
  const nuovoJsonLen = testo.length + jsonPad;
  const totale = 12 + 8 + nuovoJsonLen + 8 + binLen;
  const out = new ArrayBuffer(totale);
  const o = new DataView(out);
  const ob = new Uint8Array(out);
  o.setUint32(0, GLB_MAGIC, true);
  o.setUint32(4, vista.getUint32(4, true), true);
  o.setUint32(8, totale, true);
  o.setUint32(12, nuovoJsonLen, true);
  o.setUint32(16, CHUNK_JSON, true);
  ob.set(testo, 20);
  ob.fill(0x20, 20 + testo.length, 20 + nuovoJsonLen);
  o.setUint32(20 + nuovoJsonLen, binLen, true);
  o.setUint32(24 + nuovoJsonLen, CHUNK_BIN, true);
  ob.set(bin, 28 + nuovoJsonLen);
  return out;
}

/** where an accessor's numbers start in the BIN chunk, and how to read one */
function lettore(json: GltfJson, view: DataView, accessor: number) {
  const a = json.accessors?.[accessor];
  const bv = a?.bufferView !== undefined ? json.bufferViews?.[a.bufferView] : undefined;
  if (!a || !bv) return null;
  const start = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const comp = a.type === "VEC3" ? 3 : a.type === "VEC2" ? 2 : 1;
  const leggi = (i: number, k = 0): number => {
    const at = i * comp + k;
    switch (a.componentType) {
      case 5126:
        return view.getFloat32(start + at * 4, true);
      case 5125:
        return view.getUint32(start + at * 4, true);
      case 5123:
        return view.getUint16(start + at * 2, true);
      case 5121:
        return view.getUint8(start + at);
      default:
        return NaN;
    }
  };
  return { a, start, leggi };
}

/** whether the mesh is centred on its node across the board (x and z of glTF), from the POSITION bounds */
function centrata(json: GltfJson, mesh: { primitives: Array<{ attributes: Record<string, number> }> }): boolean {
  let min = [Infinity, Infinity];
  let max = [-Infinity, -Infinity];
  for (const p of mesh.primitives) {
    const a = json.accessors?.[p.attributes.POSITION];
    if (!a?.min || !a?.max) return false;
    min = [Math.min(min[0], a.min[0]), Math.min(min[1], a.min[2])];
    max = [Math.max(max[0], a.max[0]), Math.max(max[1], a.max[2])];
  }
  return Math.abs(min[0] + max[0]) < 1e-3 && Math.abs(min[1] + max[1]) < 1e-3;
}

/** true when most triangles are wound against their own normals */
function girataAlContrario(
  json: GltfJson,
  view: DataView,
  prim: { indices?: number; attributes: Record<string, number> },
): boolean {
  if (prim.indices === undefined || prim.attributes.POSITION === undefined || prim.attributes.NORMAL === undefined) {
    return false;
  }
  const idx = lettore(json, view, prim.indices);
  const pos = lettore(json, view, prim.attributes.POSITION);
  const nor = lettore(json, view, prim.attributes.NORMAL);
  if (!idx || !pos || !nor) return false;
  let contro = 0;
  let tutti = 0;
  for (let t = 0; t + 2 < idx.a.count; t += 3) {
    const [i0, i1, i2] = [idx.leggi(t), idx.leggi(t + 1), idx.leggi(t + 2)];
    if (Math.max(i0, i1, i2) >= pos.a.count) continue;
    const p = (i: number) => [pos.leggi(i, 0), pos.leggi(i, 1), pos.leggi(i, 2)];
    const [a, b, c] = [p(i0), p(i1), p(i2)];
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const g = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const n = [nor.leggi(i0, 0), nor.leggi(i0, 1), nor.leggi(i0, 2)];
    const d = g[0] * n[0] + g[1] * n[1] + g[2] * n[2];
    if (d === 0) continue;
    tutti++;
    if (d < 0) contro++;
  }
  return tutti > 0 && contro > tutti / 2;
}

/** swaps the 2nd and 3rd index of every triangle, in the BIN chunk */
function giraTriangoli(json: GltfJson, view: DataView, accessor: number): void {
  const idx = lettore(json, view, accessor);
  if (!idx) return;
  const size = idx.a.componentType === 5125 ? 4 : idx.a.componentType === 5123 ? 2 : idx.a.componentType === 5121 ? 1 : 0;
  if (!size) return;
  const scrivi = (i: number, v: number) => {
    if (size === 4) view.setUint32(idx.start + i * 4, v, true);
    else if (size === 2) view.setUint16(idx.start + i * 2, v, true);
    else view.setUint8(idx.start + i, v);
  };
  for (let t = 0; t + 2 < idx.a.count; t += 3) {
    const b = idx.leggi(t + 1);
    scrivi(t + 1, idx.leggi(t + 2));
    scrivi(t + 2, b);
  }
}
