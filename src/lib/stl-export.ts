import type { MeshData } from "./mesh3d";

/**
 * ASCII STL export directly from the triangulated meshes: works the same for
 * parametric enclosures, AI enclosures and imported CAD, without rebuilding
 * the geom3.
 */
export function meshesToStl(meshes: MeshData[], solidName: string): string {
  const lines: string[] = [`solid ${solidName}`];
  for (const mesh of meshes) {
    const { positions } = mesh;
    const indices =
      mesh.indices && mesh.indices.length > 0
        ? mesh.indices
        : Array.from({ length: positions.length / 3 }, (_, i) => i);
    for (let i = 0; i + 2 < indices.length; i += 3) {
      const [a, b, c] = [indices[i] * 3, indices[i + 1] * 3, indices[i + 2] * 3];
      const [nx, ny, nz] = faceNormal(positions, a, b, c);
      lines.push(
        `  facet normal ${fmt(nx)} ${fmt(ny)} ${fmt(nz)}`,
        "    outer loop",
        `      vertex ${fmt(positions[a])} ${fmt(positions[a + 1])} ${fmt(positions[a + 2])}`,
        `      vertex ${fmt(positions[b])} ${fmt(positions[b + 1])} ${fmt(positions[b + 2])}`,
        `      vertex ${fmt(positions[c])} ${fmt(positions[c + 1])} ${fmt(positions[c + 2])}`,
        "    endloop",
        "  endfacet",
      );
    }
  }
  lines.push(`endsolid ${solidName}`);
  return lines.join("\n");
}

function faceNormal(p: number[], a: number, b: number, c: number): [number, number, number] {
  const ux = p[b] - p[a];
  const uy = p[b + 1] - p[a + 1];
  const uz = p[b + 2] - p[a + 2];
  const vx = p[c] - p[a];
  const vy = p[c + 1] - p[a + 1];
  const vz = p[c + 2] - p[a + 2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

function fmt(n: number): string {
  return Number(n.toFixed(4)).toString();
}

/** downloads a text file in the browser */
export function downloadTextFile(fileName: string, content: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5_000);
}
