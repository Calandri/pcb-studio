import * as THREE from "three";

/**
 * Dati mesh "piani" che attraversano il confine fra la pagina (Studio, che non
 * importa three) e il canvas 3D (l'unico che lo importa, caricato dinamico).
 * Le scocche JSCAD arrivano dal worker come array, i CAD importati vengono
 * ridotti allo stesso formato: il canvas li trasforma in BufferGeometry.
 */
export interface MeshData {
  positions: number[];
  normals?: number[];
  indices?: number[];
}

export interface MeshTransform {
  x: number;
  y: number;
  z: number;
  rotZ: number;
}

export const IDENTITY_TRANSFORM: MeshTransform = { x: 0, y: 0, z: 0, rotZ: 0 };

export interface SceneMesh {
  id: string;
  name: string;
  kind: "parametric" | "jscad" | "import";
  /** una scocca e' fatta di piu' solidi (guscio inferiore/superiore, inserti) */
  meshes: MeshData[];
  color: string;
  visible: boolean;
  transform: MeshTransform;
}

export function geometryFromMeshData(data: MeshData): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(data.positions, 3),
  );
  if (data.normals && data.normals.length === data.positions.length) {
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(data.normals, 3));
  }
  if (data.indices && data.indices.length > 0) {
    geometry.setIndex(data.indices);
  }
  if (!data.normals) geometry.computeVertexNormals();
  return geometry;
}

/** riduce una BufferGeometry qualsiasi (importata) al formato piano MeshData */
export function meshDataFromGeometry(geometry: THREE.BufferGeometry): MeshData {
  const pos = geometry.getAttribute("position");
  const positions = Array.from(pos.array as Float32Array);
  const normal = geometry.getAttribute("normal");
  const index = geometry.getIndex();
  return {
    positions,
    normals: normal ? Array.from(normal.array as Float32Array) : undefined,
    indices: index ? Array.from(index.array as Uint32Array) : undefined,
  };
}

/**
 * Normalizza il gruppo della scheda: qualunque sia l'orientamento del GLB in
 * ingresso, la scheda finisce sdraiata sul piano XZ (Y verso l'alto), centrata
 * sull'origine, con la faccia inferiore a y=0. L'asse con l'estensione minima
 * e' lo spessore della scheda (~1,6 mm): quello va in verticale.
 */
export function normalizeBoardGroup(group: THREE.Group): void {
  group.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(group);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());

  if (size.z <= size.x && size.z <= size.y) {
    // spessore su Z (mondo Z-up, tipico JSCAD): Z diventa Y
    group.rotation.x = -Math.PI / 2;
  } else if (size.x <= size.y && size.x <= size.z) {
    // spessore su X: X diventa Y
    group.rotation.z = Math.PI / 2;
  }
  // se lo spessore e' gia' su Y non serve ruotare

  group.updateMatrixWorld(true);
  const aligned = new THREE.Box3().setFromObject(group);
  const center = aligned.getCenter(new THREE.Vector3());
  group.position.x -= center.x;
  group.position.z -= center.z;
  group.position.y -= aligned.min.y;
}

/** colore di default per tipo di mesh, coerente col tema dell'app */
export const KIND_COLOR: Record<SceneMesh["kind"], string> = {
  parametric: "#3BE8B0",
  jscad: "#7FB4FF",
  import: "#E8B23B",
};
