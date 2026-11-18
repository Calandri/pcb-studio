"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader, OrbitControls } from "three-stdlib";
import {
  puntoVersoIlGlb,
  scenaDelFlessibile,
  versoIlGlb,
  type ScenaDelFlessibile,
  type VistaDelFlessibile,
} from "@/lib/flex-3d";
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
 *
 * A RIGID-FLEX BOARD (flex.json): the GLB carries only the rigid part, and the
 * tail is drawn here from the compiled circuit (lib/flex-3d), thin as its
 * stack and FOLDED as it is mounted, each bend with its words on it. A switch
 * shows it flat instead (Piegata / Spianata); folded is the default.
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
  circuitJson = null,
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
  /** the compiled board: where the flexible tail of a rigid-flex board is read from */
  circuitJson?: unknown[] | null;
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

  // ---- the flexible tail of a rigid-flex board ---------------------------
  const scena = useMemo(() => scenaDelFlessibile(circuitJson), [circuitJson]);
  // the board loader reads it when the GLB arrives (declared first, this effect runs before it)
  const scenaRef = useRef<ScenaDelFlessibile | null>(null);
  useEffect(() => {
    scenaRef.current = scena;
  }, [scena]);
  const [piegata, setPiegata] = useState(true);
  /**
   * The GLB of the board, once loaded: its scene (where the tail goes) and
   * what it says of the tail ("rigida": the tail is not in it and is drawn
   * here). Tied to the project it was loaded for: right after a change of
   * project the old model is not a host for the new tail.
   */
  const [caricato, setCaricato] = useState<{ per: string; modello: THREE.Object3D; flex: string | null } | null>(null);
  const ospite = caricato?.per === projectId ? caricato.modello : null;
  const glbFlex = caricato?.per === projectId ? caricato.flex : null;

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
    // the bottom face carries parts too: with every light above, turning the
    // board over showed it black
    const under = new THREE.DirectionalLight(0xffffff, 0.9);
    under.position.set(-40, -80, 30);
    scene.add(hemi, key, fill, under);

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
        const flex = res.headers.get("x-pcb-flex");
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
        /*
         * The board is centred and laid with the tail FLAT, as it was before
         * the tail was folded: the frame the enclosures are placed in does not
         * move with the switch. The folded tail replaces it right after.
         */
        const piana = flex === "rigida" && scenaRef.current ? gruppoDellaCoda(scenaRef.current.spianata) : null;
        if (piana) model.add(piana);
        normalizeBoardGroup(world.boardGroup, {
          widthMm: boardWidthMm,
          heightMm: boardHeightMm,
        });
        if (piana) {
          model.remove(piana);
          liberaGruppo(piana);
        }
        setCaricato({ per: projectId, modello: model, flex });
      } catch {
        if (cancelled) return;
        world.boardGroup.add(fallbackBoard(boardWidthMm, boardHeightMm, parts));
        normalizeBoardGroup(world.boardGroup, {
          widthMm: boardWidthMm,
          heightMm: boardHeightMm,
        });
      }
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

  // ---- the tail, folded or flat ------------------------------------------
  useEffect(() => {
    if (!ospite || !scena || glbFlex !== "rigida") return;
    const gruppo = gruppoDellaCoda(piegata ? scena.piegata : scena.spianata);
    ospite.add(gruppo);
    return () => {
      ospite.remove(gruppo);
      liberaGruppo(gruppo);
    };
  }, [ospite, scena, glbFlex, piegata]);

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

  return (
    <>
      <div ref={hostRef} className="absolute inset-0" />
      {scena && (
        <SceltaDellaCoda
          piegata={piegata}
          onPiegata={setPiegata}
          testi={scena.testiDelleCode}
          intera={glbFlex === "intera"}
          caricata={glbFlex === "rigida"}
        />
      )}
    </>
  );
}

/**
 * The switch of a rigid-flex board: folded (as mounted, the default) or flat
 * (as the fab cuts it), with what the bends make of each tail written under
 * it, so the 3D says by itself that the tail is folded and how.
 */
function SceltaDellaCoda({
  piegata,
  onPiegata,
  testi,
  intera,
  caricata,
}: {
  piegata: boolean;
  onPiegata: (v: boolean) => void;
  testi: string[];
  intera: boolean;
  caricata: boolean;
}) {
  const idTesti = useId();
  const bottone = (attivo: boolean) =>
    `px-3 py-1 text-[12px] font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-white ${
      attivo ? "bg-[#E0A040] text-[#1A1206]" : "text-[#E0A040] hover:bg-[rgba(224,160,64,0.12)]"
    }`;
  return (
    <div className="absolute left-[18px] top-[18px] z-10 max-w-[min(420px,calc(100%-36px))] rounded-[10px] border border-[#5A4520] bg-[rgba(11,17,16,0.92)] px-3 py-2.5 text-[11px] text-[#B9CAC5] backdrop-blur">
      <div className="flex items-center gap-3">
        <span className="text-[12px] font-semibold text-[#E0A040]">Coda flessibile</span>
        <div role="group" aria-label="Come mostrare la coda flessibile" className="flex overflow-hidden rounded-md border border-[#E0A040]">
          <button type="button" aria-pressed={piegata} aria-describedby={idTesti} className={bottone(piegata)} onClick={() => onPiegata(true)}>
            Piegata
          </button>
          <button type="button" aria-pressed={!piegata} aria-describedby={idTesti} className={bottone(!piegata)} onClick={() => onPiegata(false)}>
            Spianata
          </button>
        </div>
      </div>
      <div id={idTesti}>
        {testi.map((t, i) => (
          <p key={i} className="mt-1.5 leading-snug">
            {t.replace(/^coda flessibile: /, "")}
          </p>
        ))}
      </div>
      {intera && (
        <p className="mt-1.5 leading-snug text-[#E8B23B]">
          La parte rigida non e&apos; un pezzo solo: qui la coda resta disegnata come la scheda, non piegata.
        </p>
      )}
      {!intera && !caricata && <p className="mt-1.5 leading-snug text-faint">La coda compare quando la scheda e&apos; caricata.</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------

/** the tail as three objects, in the GLB's frame: one mesh per material, a sprite per bend */
function gruppoDellaCoda(vista: VistaDelFlessibile): THREE.Group {
  const gruppo = new THREE.Group();
  gruppo.name = "coda-flessibile";
  for (const m of vista.meshes) {
    const geometria = new THREE.BufferGeometry();
    geometria.setAttribute("position", new THREE.BufferAttribute(versoIlGlb(m.posizioni), 3));
    geometria.computeVertexNormals();
    const trasparente = m.opacita < 1;
    const materiale = new THREE.MeshStandardMaterial({
      color: new THREE.Color(m.colore),
      roughness: m.parte === "rame" ? 0.35 : 0.6,
      metalness: m.parte === "rame" ? 0.55 : 0.05,
      side: THREE.DoubleSide,
      transparent: trasparente,
      opacity: m.opacita,
      depthWrite: !trasparente,
    });
    gruppo.add(new THREE.Mesh(geometria, materiale));
  }
  for (const e of vista.etichette) {
    const sprite = etichetta(e.testo);
    sprite.position.set(...puntoVersoIlGlb(e.posizione));
    gruppo.add(sprite);
  }
  return gruppo;
}

/** the words of a bend, always facing the camera, a constant 1.6 mm tall in the scene */
function etichetta(testo: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const alto = 56;
  const font = `600 ${alto * 0.62}px system-ui, -apple-system, sans-serif`;
  let largo = alto * testo.length * 0.5;
  if (ctx) {
    ctx.font = font;
    largo = Math.ceil(ctx.measureText(testo).width + alto * 0.7);
  }
  canvas.width = largo;
  canvas.height = alto;
  if (ctx) {
    ctx.fillStyle = "rgba(11,21,18,0.88)";
    ctx.beginPath();
    ctx.roundRect(0, 0, largo, alto, alto * 0.3);
    ctx.fill();
    ctx.font = font;
    ctx.fillStyle = "#F2F2F2";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(testo, largo / 2, alto / 2 + 1);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true }));
  const altezzaMm = 1.6;
  sprite.scale.set((altezzaMm * largo) / alto, altezzaMm, 1);
  sprite.renderOrder = 10;
  return sprite;
}

function liberaGruppo(gruppo: THREE.Group): void {
  gruppo.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    } else if (o instanceof THREE.Sprite) {
      o.material.map?.dispose();
      o.material.dispose();
    }
  });
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
