"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader, OrbitControls } from "three-stdlib";
import type { InspectComponent } from "@/lib/inspect";
import {
  geometryFromMeshData,
  normalizeBoardGroup,
  type MeshData,
  type SceneMesh,
} from "@/lib/mesh3d";

/**
 * The enclosure designer scene: the board (GLB from the server, or fallback
 * boxes derived from the circuit json) plus the meshes of the enclosures and
 * imported modules. three lives only inside here: the component is loaded with
 * next/dynamic ssr:false and the rest of the app passes it plain data.
 */
export function EnclosureCanvas({
  projectId,
  boardWidthMm,
  boardHeightMm,
  parts,
  meshes,
  showEnclosures,
  enclosureOpacity,
  explodedMm,
  onBoardLoaded,
}: {
  projectId: string;
  boardWidthMm: number | null;
  boardHeightMm: number | null;
  parts: InspectComponent[];
  meshes: SceneMesh[];
  showEnclosures: boolean;
  /** 0..1: 1 = full, low values show the board through the enclosure */
  enclosureOpacity: number;
  /** lift of the parts above the board (exploded view), in mm */
  explodedMm: number;
  onBoardLoaded?: (viaGlb: boolean) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<{
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    renderer: THREE.WebGLRenderer;
    controls: OrbitControls;
    boardGroup: THREE.Group;
    enclosureGroup: THREE.Group;
    meshNodes: Map<string, THREE.Mesh[]>;
  } | null>(null);
  const boardLoadedFor = useRef<string | null>(null);

  // ---- scene setup (once) ----------------------------------------------
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 4000);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;

    const hemi = new THREE.HemisphereLight(0xbfeee0, 0x0a0f0e, 1.15);
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(60, 90, 40);
    const fill = new THREE.DirectionalLight(0x9fd8c4, 0.5);
    fill.position.set(-70, 30, -50);
    scene.add(hemi, key, fill);

    const boardGroup = new THREE.Group();
    const enclosureGroup = new THREE.Group();
    // enclosures are written in Z-up space (mm, origin at board center):
    // the group brings them into three's Y-up world
    enclosureGroup.rotation.x = -Math.PI / 2;
    scene.add(boardGroup, enclosureGroup);

    worldRef.current = {
      scene,
      camera,
      renderer,
      controls,
      boardGroup,
      enclosureGroup,
      meshNodes: new Map(),
    };

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = host;
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(host);

    let raf = 0;
    const tick = () => {
      controls.update();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      controls.dispose();
      scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          for (const m of Array.isArray(obj.material) ? obj.material : [obj.material]) {
            m.dispose();
          }
        }
      });
      renderer.dispose();
      renderer.domElement.remove();
      worldRef.current = null;
      boardLoadedFor.current = null;
    };
  }, []);

  // ---- board loading --------------------------------------------------
  useEffect(() => {
    if (boardLoadedFor.current === projectId) return;
    boardLoadedFor.current = projectId;
    let cancelled = false;

    (async () => {
      const world = worldRef.current;
      if (!world) return;
      let viaGlb = false;
      try {
        // no-store: with large responses (the GLB reaches 8MB) Chromium's
        // disk cache can fail the write and abort the whole fetch
        const res = await fetch(`/api/project/pcb-glb?projectId=${projectId}`, {
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buffer = await res.arrayBuffer();
        const gltf = await new GLTFLoader().parseAsync(buffer, "");
        if (cancelled) return;
        const model = gltf.scene;
        // the GLB comes out with the board rotated 180 degrees relative to
        // the circuit json coordinates (x -> -x): the connectors end up on
        // the opposite side from the declared one. It is straightened out,
        // otherwise the enclosures (built on the circuit coordinates) are
        // born with the hole on the wrong side. The rotation happens before
        // normalization, which centers the group anyway.
        model.rotation.y = Math.PI;
        world.boardGroup.add(model);
        viaGlb = true;
      } catch {
        if (cancelled) return;
        world.boardGroup.add(fallbackBoard(boardWidthMm, boardHeightMm, parts));
      }
      normalizeBoardGroup(world.boardGroup, {
        widthMm: boardWidthMm,
        heightMm: boardHeightMm,
      });
      frameCamera(world);
      onBoardLoaded?.(viaGlb);
    })();

    return () => {
      cancelled = true;
    };
    // the board reloads only when the project changes: dimensions and
    // components go into the GLB / fallback of the moment
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // ---- enclosure sync ------------------------------------------------
  useEffect(() => {
    const world = worldRef.current;
    if (!world) return;

    const seen = new Set<string>();
    for (const item of meshes) {
      seen.add(item.id);
      let nodes = world.meshNodes.get(item.id);
      // rebuild the nodes if the number of solids has changed
      if (nodes && nodes.length !== item.meshes.length) {
        for (const node of nodes) {
          world.enclosureGroup.remove(node);
          node.geometry.dispose();
          (node.material as THREE.Material).dispose();
        }
        nodes = undefined;
      }
      if (!nodes) {
        const material = new THREE.MeshStandardMaterial({
          color: new THREE.Color(item.color),
          roughness: 0.55,
          metalness: 0.05,
          transparent: true,
          side: THREE.DoubleSide,
        });
        nodes = item.meshes.map(
          (data) => new THREE.Mesh(geometryFromMeshData(data), material.clone()),
        );
        for (const node of nodes) world.enclosureGroup.add(node);
        world.meshNodes.set(item.id, nodes);
      }
      for (const [i, node] of nodes.entries()) {
        node.visible = item.visible && showEnclosures;
        const material = node.material as THREE.MeshStandardMaterial;
        material.opacity = enclosureOpacity;
        material.depthWrite = enclosureOpacity > 0.65;
        // progressive exploded view: the higher a solid sits, the more it
        // lifts — the tray stays almost still, the lid flies. The lift happens
        // along the authoring Z (the group carries it into Y)
        node.rotation.z = (item.transform.rotZ * Math.PI) / 180;
        const centroidZ = meshCentroidZ(item.meshes[i]);
        const liftFactor = Math.max(0, Math.min(1, (centroidZ - 2) / 10));
        node.position.set(
          item.transform.x,
          item.transform.y,
          item.transform.z + explodedMm * liftFactor,
        );
      }
    }

    for (const [id, nodes] of world.meshNodes) {
      if (seen.has(id)) continue;
      for (const node of nodes) {
        world.enclosureGroup.remove(node);
        node.geometry.dispose();
        (node.material as THREE.Material).dispose();
      }
      world.meshNodes.delete(id);
    }
  }, [meshes, showEnclosures, enclosureOpacity, explodedMm]);

  return <div ref={hostRef} className="absolute inset-0" />;
}

// ---------------------------------------------------------------------------

/** average distance from z=0: decides whether the solid lifts in the exploded view */
function meshCentroidZ(data: MeshData): number {
  let sum = 0;
  const count = data.positions.length / 3;
  for (let i = 2; i < data.positions.length; i += 3) sum += data.positions[i];
  return count > 0 ? sum / count : 0;
}

function frameCamera(world: {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  boardGroup: THREE.Group;
}): void {
  world.boardGroup.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(world.boardGroup);
  if (box.isEmpty()) {
    world.camera.position.set(60, 60, 60);
    return;
  }
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z, 10);
  const distance = radius * 2.1;
  world.camera.position.set(
    center.x + distance * 0.75,
    center.y + distance * 0.85,
    center.z + distance * 0.75,
  );
  world.camera.far = Math.max(4000, distance * 20);
  world.camera.updateProjectionMatrix();
  world.controls.target.copy(center);
  world.controls.update();

  const grid = new THREE.GridHelper(
    Math.ceil((radius * 2.4) / 10) * 10,
    Math.ceil((radius * 2.4) / 10),
    0x2c4c42,
    0x16211e,
  );
  grid.position.y = -0.15;
  world.scene.add(grid);
}

/** fallback board when the GLB does not arrive: outline + component boxes */
function fallbackBoard(
  widthMm: number | null,
  heightMm: number | null,
  parts: InspectComponent[],
): THREE.Group {
  const group = new THREE.Group();
  const w = widthMm ?? 50;
  const h = heightMm ?? 40;

  const board = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, 1.6),
    new THREE.MeshStandardMaterial({ color: 0x0e5c3f, roughness: 0.7 }),
  );
  board.position.z = 0.8;
  group.add(board);

  const material = new THREE.MeshStandardMaterial({ color: 0x2b3d38, roughness: 0.5 });
  for (const part of parts) {
    if (part.x === null || part.y === null || !part.widthMm || !part.heightMm) continue;
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(part.widthMm, part.heightMm, Math.min(part.widthMm, 4)),
      material,
    );
    box.position.set(part.x, part.y, 1.6 + Math.min(part.widthMm, 4) / 2);
    group.add(box);
  }
  // the fallback is built in Z-up like the enclosures:
  // normalizeBoardGroup takes care of laying it flat on the XZ plane
  return group;
}
