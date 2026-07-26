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
 * La scena del designer di scocche: scheda (GLB dal server, o scatole di
 * riserva ricavate dal circuit json) piu' le mesh delle scocche e dei moduli
 * importati. three vive solo qui dentro: il componente e' caricato con
 * next/dynamic ssr:false e il resto dell'app gli passa dati piani.
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
  /** 0..1: 1 = piena, valori bassi mostrano la scheda attraverso la scocca */
  enclosureOpacity: number;
  /** alzata dei pezzi sopra la scheda (vista esplosa), in mm */
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

  // ---- setup scena (una volta) -------------------------------------------
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
    // le scocche sono scritte in spazio Z-up (mm, origine al centro scheda):
    // il gruppo le porta nel mondo Y-up di three
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

  // ---- caricamento scheda --------------------------------------------------
  useEffect(() => {
    if (boardLoadedFor.current === projectId) return;
    boardLoadedFor.current = projectId;
    let cancelled = false;

    (async () => {
      const world = worldRef.current;
      if (!world) return;
      let viaGlb = false;
      try {
        const res = await fetch(`/api/project/pcb-glb?projectId=${projectId}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buffer = await res.arrayBuffer();
        const gltf = await new GLTFLoader().parseAsync(buffer, "");
        if (cancelled) return;
        const model = gltf.scene;
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
    // la scheda si ricarica solo cambiando progetto: dimensioni e componenti
    // entrano nel GLB / nel fallback del momento
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // ---- sincronizzazione scocche --------------------------------------------
  useEffect(() => {
    const world = worldRef.current;
    if (!world) return;

    const seen = new Set<string>();
    for (const item of meshes) {
      seen.add(item.id);
      let nodes = world.meshNodes.get(item.id);
      // ricostruisce i nodi se il numero di solidi e' cambiato
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
        // esplosa: i solidi sopra il piano componenti si alzano, il guscio
        // inferiore resta. Alzata lungo la Z autoriale (il gruppo la porta in Y)
        node.rotation.z = (item.transform.rotZ * Math.PI) / 180;
        const centroidZ = meshCentroidZ(item.meshes[i]);
        node.position.set(
          item.transform.x,
          item.transform.y,
          item.transform.z + (centroidZ > 1.6 ? explodedMm : 0),
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

/** distanza media da z=0: decide se il solido si alza nella vista esplosa */
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

/** scheda di riserva quando il GLB non arriva: sagoma + scatole componenti */
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
  // il fallback e' costruito in Z-up come le scocche: ci pensa
  // normalizeBoardGroup a distenderlo sul piano XZ
  return group;
}
