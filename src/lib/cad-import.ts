import * as THREE from "three";
import { GLTFLoader, OBJLoader, STLLoader } from "three-stdlib";
import { meshDataFromGeometry, type MeshData } from "./mesh3d";

/**
 * Parsing of user-uploaded CAD files, all client-side: the file is never
 * executed or interpreted by the server, which only stores it (base64).
 */

export const CAD_IMPORT_EXTENSIONS = [".stl", ".obj", ".glb", ".gltf", ".step", ".stp"];
export const CAD_IMPORT_MAX_BYTES = 15 * 1024 * 1024;

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
      return mergeObjectToMeshData(gltf.scene);
    }
    case ".step":
    case ".stp":
      return parseStep(buffer);
    default:
      throw new Error(`formato non gestito: ${ext}`);
  }
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

  const positions: number[] = [];
  const indices: number[] = [];
  for (const mesh of result.meshes) {
    const base = positions.length / 3;
    positions.push(...Array.from(mesh.attributes.position.array));
    if (mesh.index) {
      indices.push(...Array.from(mesh.index.array, (i) => base + i));
    } else {
      const count = mesh.attributes.position.array.length / 3;
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
