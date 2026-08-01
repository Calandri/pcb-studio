/**
 * Compiles JSCAD sources into triangulated meshes, inside a Web Worker: the
 * code may come from the AI and here it has no access to DOM, network or
 * external imports — only to the @jscad/modeling library passed to it.
 *
 * Source contract: it defines `main(jscad)` and returns a geom3 or an array
 * of geom3. The result is an array of flat meshes (positions/normals/indices),
 * ready to become BufferGeometry in the canvas.
 */

export interface JscadWorkerRequest {
  id: string;
  code: string;
}

export interface JscadWorkerResponse {
  id: string;
  meshes?: Array<{ positions: number[]; normals: number[]; indices: number[] }>;
  error?: string;
}

type Geom3 = { polygons: Array<{ vertices: number[][] }> };

let jscadPromise: Promise<unknown> | null = null;

function loadJscad(): Promise<unknown> {
  jscadPromise ??= import("@jscad/modeling");
  return jscadPromise;
}

self.onmessage = async (event: MessageEvent<JscadWorkerRequest>) => {
  const { id, code } = event.data;
  try {
    if (code.length > 100_000) throw new Error("sorgente troppo lungo (max 100k caratteri)");
    const jscad = await loadJscad();
    // no import/require/fetch in the source's environment: it only gets jscad
    const factory = new Function(
      "jscad",
      `"use strict";\nconst require = undefined, fetch = undefined, importScripts = undefined, XMLHttpRequest = undefined, WebSocket = undefined, self = undefined, globalThis = undefined;\n${code}\n;return main(jscad);`,
    );
    const result = factory(jscad) as Geom3 | Geom3[];
    const solids = (Array.isArray(result) ? result : [result]).filter(
      (g): g is Geom3 => Boolean(g && Array.isArray(g.polygons)),
    );
    if (solids.length === 0) {
      throw new Error("main() non ha restituito geometrie (geom3)");
    }
    const meshes = solids.map(geom3ToMesh);
    const response: JscadWorkerResponse = { id, meshes };
    self.postMessage(response);
  } catch (err) {
    const response: JscadWorkerResponse = {
      id,
      error: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(response);
  }
};

/** geom3 -> flat triangles (flat shading: one normal per face) */
function geom3ToMesh(geom: Geom3): {
  positions: number[];
  normals: number[];
  indices: number[];
} {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];

  for (const polygon of geom.polygons) {
    const vertices = polygon.vertices;
    if (vertices.length < 3) continue;
    const [a, b, c] = vertices;
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;

    const base = positions.length / 3;
    for (const v of vertices) {
      positions.push(v[0], v[1], v[2]);
      normals.push(nx, ny, nz);
    }
    // fan triangulation of the face (JSCAD polygons are convex)
    for (let i = 1; i < vertices.length - 1; i++) {
      indices.push(base, base + i, base + i + 1);
    }
  }

  return { positions, normals, indices };
}
