import * as THREE from "three";

/**
 * "Flat" mesh data that crosses the boundary between the page (Studio, which
 * does not import three) and the 3D canvas (the only one that imports it,
 * loaded dynamically). JSCAD enclosures arrive from the worker as arrays,
 * imported CAD files are reduced to the same format: the canvas turns them
 * into BufferGeometry.
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
  /** an enclosure is made of several solids (lower/upper shell, inserts) */
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

/** reduces any (imported) BufferGeometry to the flat MeshData format */
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
 * Normalizes the board group: whatever the orientation of the input GLB, the
 * board ends up lying on the XZ plane (Y up), centered on the origin, with
 * its bottom face at y=0. The axis with the smallest extent is the board
 * thickness (~1.6 mm): that one goes vertical. If the expected dimensions are
 * known (mm) and the model is in another unit (meters, arbitrary units), it
 * scales it: enclosures and board must speak the same unit of measure.
 */
export function normalizeBoardGroup(
  group: THREE.Group,
  expected?: { widthMm: number | null; heightMm: number | null },
): void {
  group.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(group);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());

  if (size.z <= size.x && size.z <= size.y) {
    // thickness on Z (Z-up world, typical JSCAD): Z becomes Y
    group.rotation.x = -Math.PI / 2;
  } else if (size.x <= size.y && size.x <= size.z) {
    // thickness on X: X becomes Y
    group.rotation.z = Math.PI / 2;
  }
  // if the thickness is already on Y no rotation is needed

  if (expected?.widthMm && expected?.heightMm) {
    group.updateMatrixWorld(true);
    const before = new THREE.Box3().setFromObject(group).getSize(new THREE.Vector3());
    const modelHoriz = Math.max(before.x, before.z);
    const expectedHoriz = Math.max(expected.widthMm, expected.heightMm);
    if (modelHoriz > 0) {
      const ratio = expectedHoriz / modelHoriz;
      // generous tolerance: the outline may include overhanging elements
      if (ratio < 0.7 || ratio > 1.4) {
        group.scale.multiplyScalar(ratio);
      }
    }
  }

  group.updateMatrixWorld(true);
  const aligned = new THREE.Box3().setFromObject(group);
  const center = aligned.getCenter(new THREE.Vector3());
  group.position.x -= center.x;
  group.position.z -= center.z;
  group.position.y -= aligned.min.y;
}

/** default color per mesh kind, consistent with the app theme */
export const KIND_COLOR: Record<SceneMesh["kind"], string> = {
  parametric: "#3BE8B0",
  jscad: "#7FB4FF",
  import: "#E8B23B",
};
