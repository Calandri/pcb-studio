import * as THREE from "three";
import { GLTFLoader, OBJLoader, STLLoader } from "three-stdlib";
import { meshDataFromGeometry, type MeshData } from "./mesh3d";

/**
 * Parsing of user-uploaded CAD files, all client-side: the file is never
 * executed or interpreted by the server, which only stores it (base64).
 */

export const CAD_IMPORT_EXTENSIONS = [".stl", ".obj", ".glb", ".gltf", ".step", ".stp"];
export const CAD_IMPORT_MAX_BYTES = 15 * 1024 * 1024;
/**
 * What can actually be SAVED: the file travels as base64 inside a JSON body,
 * which grows it by a third, and a request body on Vercel stops at 4.5 MB.
 * Anything above this parses fine in the browser and then fails with a 413 on
 * save. Exposed for the upload form; parseCadFile keeps the larger limit
 * because it also re-reads files saved before.
 */
export const CAD_UPLOAD_MAX_BYTES = Math.floor((4.5 * 1024 * 1024 - 64 * 1024) * 0.75);

export function cadExtension(fileName: string): string | null {
  const lower = fileName.toLowerCase();
  return CAD_IMPORT_EXTENSIONS.find((ext) => lower.endsWith(ext)) ?? null;
}

export async function parseCadFile(fileName: string, buffer: ArrayBuffer): Promise<MeshData> {
  const ext = cadExtension(fileName);
  if (!ext) throw new Error(`formato non supportato: ${fileName}`);
  if (buffer.byteLength > CAD_IMPORT_MAX_BYTES) {
    throw new Error("file troppo grande (max 15 MB)");
  }

  switch (ext) {
    case ".stl":
      return meshDataFromGeometry(new STLLoader().parse(buffer));
    case ".obj":
      return mergeObjectToMeshData(
        new OBJLoader().parse(new TextDecoder().decode(buffer)),
      );
    case ".glb":
    case ".gltf": {
      const gltf = await new GLTFLoader().parseAsync(buffer, "");
      return gltfInMillimetri(mergeObjectToMeshData(gltf.scene));
    }
    case ".step":
    case ".stp":
      return parseStep(buffer);
    default:
      throw new Error(`formato non gestito: ${ext}`);
  }
}

/**
 * A glTF brought into the enclosure space: millimetres, Z up.
 *
 * The glTF specification fixes both: linear units are METRES and +Y is up. The
 * enclosures here are millimetres with Z up (the same space as STEP), so a
 * correctly exported 80mm box arrived 0.08 units wide — a speck — and lying on
 * its back. It is turned (+90 degrees about X: Y becomes Z) and scaled by 1000.
 *
 * The one exception is a file that is plainly NOT in metres: something wider
 * than ten "metres" is a model whose exporter wrote millimetres and called them
 * metres, which happens. That one is only turned, and left at its size.
 */
export function gltfInMillimetri(mesh: MeshData): MeshData {
  const p = mesh.positions;
  let estensione = 0;
  for (let asse = 0; asse < 3; asse++) {
    let min = Infinity;
    let max = -Infinity;
    for (let i = asse; i < p.length; i += 3) {
      if (p[i] < min) min = p[i];
      if (p[i] > max) max = p[i];
    }
    if (max > min) estensione = Math.max(estensione, max - min);
  }
  const scala = estensione > 10 ? 1 : 1000;
  const ruota = (v: number[] | undefined, fattore: number): number[] | undefined => {
    if (!v) return undefined;
    const out = new Array<number>(v.length);
    for (let i = 0; i + 2 < v.length; i += 3) {
      // `0 - x` and not `-x`: a negative zero would be the only difference
      out[i] = v[i] * fattore;
      out[i + 1] = 0 - v[i + 2] * fattore;
      out[i + 2] = v[i + 1] * fattore;
    }
    return out;
  };
  return {
    positions: ruota(p, scala)!,
    normals: ruota(mesh.normals, 1),
    indices: mesh.indices,
  };
}

/** merges all the meshes of a three.js object into a single MeshData */
function mergeObjectToMeshData(root: THREE.Object3D): MeshData {
  root.updateMatrixWorld(true);
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const normalMatrix = new THREE.Matrix3();
  const vertex = new THREE.Vector3();

  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const geometry = obj.geometry as THREE.BufferGeometry;
    const pos = geometry.getAttribute("position");
    if (!pos) return;
    const nor = geometry.getAttribute("normal");
    normalMatrix.getNormalMatrix(obj.matrixWorld);
    const base = positions.length / 3;

    for (let i = 0; i < pos.count; i++) {
      vertex.fromBufferAttribute(pos, i).applyMatrix4(obj.matrixWorld);
      positions.push(vertex.x, vertex.y, vertex.z);
      if (nor) {
        vertex.fromBufferAttribute(nor, i).applyMatrix3(normalMatrix).normalize();
        normals.push(vertex.x, vertex.y, vertex.z);
      }
    }
    const index = geometry.getIndex();
    if (index) {
      for (let i = 0; i < index.count; i++) indices.push(base + index.getX(i));
    } else {
      for (let i = 0; i < pos.count; i++) indices.push(base + i);
    }
  });

  if (positions.length === 0) throw new Error("nessuna geometria trovata nel file");
  return { positions, normals: normals.length > 0 ? normals : undefined, indices };
}

// ------------------------------------------------------------------ STEP

declare global {
  interface Window {
    occtimportjs?: (options?: { locateFile?: (path: string) => string }) => Promise<{
      ReadStepFile: (
        content: Uint8Array,
        params: null,
      ) => {
        success: boolean;
        meshes: Array<{
          attributes: { position: { array: Float32Array | number[] } };
          index?: { array: Uint32Array | number[] };
        }>;
      };
    }>;
  }
}

let occtScriptPromise: Promise<void> | null = null;

/** loads occt from /public: the wasm must be looked up next to the script, not in the bundle */
function loadOcctScript(): Promise<void> {
  occtScriptPromise ??= new Promise((resolve, reject) => {
    if (window.occtimportjs) return resolve();
    const script = document.createElement("script");
    script.src = "/occt/occt-import-js.js";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("caricamento di occt-import-js fallito"));
    document.head.appendChild(script);
  });
  return occtScriptPromise;
}

async function parseStep(buffer: ArrayBuffer): Promise<MeshData> {
  await loadOcctScript();
  const occt = await window.occtimportjs!();
  const result = occt.ReadStepFile(new Uint8Array(buffer), null);
  if (!result.success || result.meshes.length === 0) {
    throw new Error("il file STEP non contiene solidi leggibili");
  }

  /*
   * Plain loops, never `push(...array)`: spreading a big mesh passes every
   * coordinate as an argument of one call, and past a few hundred thousand of
   * them the engine refuses ("Maximum call stack size exceeded") — a real STEP
   * of an enclosure is easily that.
   */
  const positions: number[] = [];
  const indices: number[] = [];
  for (const mesh of result.meshes) {
    const base = positions.length / 3;
    const pos = mesh.attributes.position.array;
    for (let i = 0; i < pos.length; i++) positions.push(pos[i]);
    if (mesh.index) {
      const idx = mesh.index.array;
      for (let i = 0; i < idx.length; i++) indices.push(base + idx[i]);
    } else {
      const count = pos.length / 3;
      for (let i = 0; i < count; i++) indices.push(base + i);
    }
  }
  // OCCT works in mm Z-up like our enclosure space: no conversion
  return { positions, indices };
}

// ------------------------------------------------------------------ base64

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
