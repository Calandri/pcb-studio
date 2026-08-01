import { MIL } from "./altium-layers";

/**
 * THE 3D BODIES OF AN ALTIUM BOARD.
 *
 * A .PcbDoc carries the real models of its parts: the STEP the manufacturer
 * published, embedded in the file. On BAT_BS there are 23 distinct ones, used by
 * 87 of the 98 components — the microphone, the LQFP64, the microSD connector,
 * every capacitor. Until now the 3D view of an imported board showed a bare
 * board, because nothing was reading them.
 *
 * STEP is not a mesh: it is a boundary representation, and to draw it you need a
 * CAD kernel. `occt-import-js` is one, in WebAssembly, and it is already in the
 * tree (circuit-json-to-gltf depends on it). It runs ONCE, at import, and what
 * gets stored is the mesh: the biggest model on this board is 1.5MB of STEP and
 * takes a second to read, which is fine once and not fine on every page load.
 *
 * WHAT THE ORIENTATION IS, AND HOW WE KNOW IT IS RIGHT. Altium stores, per body,
 * the rotation to apply to the model (`modelRotationDeg` x/y/z, applied in that
 * order) and the height the part ends up with (`overallHeightMil`). So there is a
 * check that needs no eyes: rotate the mesh, measure its z extent, compare with
 * the declared height. Measured on twelve bodies: eleven match to the
 * hundredth of a millimetre (1.08, 0.60, 1.60, 6.12...). That is what says the
 * rotation order is the right one.
 *
 * The z of the rotated mesh is then shifted so that zero is the board surface
 * and the part sits on it (plus its standoff, when it has one).
 */

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const r3 = (v: number): number => Number(v.toFixed(3));

export interface Modello3D {
  /** file name, unique per model plus orientation */
  nome: string;
  /** the mesh as OBJ, with the body colour on the vertices */
  obj: string;
  triangoli: number;
  /** the height the mesh comes out at, and the one the file declares */
  altezzaMm: number;
  altezzaDichiarataMm: number;
}

export interface Corpo3D {
  designator: string;
  /** the model to use, or null when the file has no model for this part */
  modello: string | null;
  /** height in millimetres, from the file */
  altezzaMm: number;
  /**
   * A plain box, for a part the file gives a height but no model.
   * Sizes in millimetres, in the component's own frame.
   */
  scatola?: { larghezza: number; profondita: number; altezza: number };
}

export interface Bodies3DResult {
  modelli: Modello3D[];
  corpi: Corpo3D[];
  warnings: string[];
}

/** rotation in degrees around x, then y, then z: the order Altium applies */
function ruota(
  p: [number, number, number],
  rx: number,
  ry: number,
  rz: number,
): [number, number, number] {
  const rad = (a: number) => (a * Math.PI) / 180;
  let [x, y, z] = p;
  let c = Math.cos(rad(rx));
  let s = Math.sin(rad(rx));
  [y, z] = [y * c - z * s, y * s + z * c];
  c = Math.cos(rad(ry));
  s = Math.sin(rad(ry));
  [x, z] = [x * c + z * s, -x * s + z * c];
  c = Math.cos(rad(rz));
  s = Math.sin(rad(rz));
  [x, y] = [x * c - y * s, x * s + y * c];
  return [x, y, z];
}

const norm360 = (a: number): number => ((a % 360) + 360) % 360;

/**
 * The bodies of the board, with their models converted to meshes.
 *
 * The bodies carry no component index — only a position — so each one is given
 * to the component whose pads it sits on. Six millimetres of tolerance: a body
 * is drawn on top of its own part, and nothing else on a board is that close to
 * being somewhere else.
 */
export async function modelli3dNativi(
  pcb: Record<string, unknown>,
): Promise<Bodies3DResult> {
  const out: Bodies3DResult = { modelli: [], corpi: [], warnings: [] };
  const bodies = Array.isArray(pcb.componentBodies)
    ? (pcb.componentBodies as Array<Record<string, unknown>>)
    : [];
  if (bodies.length === 0) return out;

  /** one entry per model id: the file repeats the same model more than once */
  const perId = new Map<string, Record<string, unknown>>();
  for (const m of Array.isArray(pcb.embeddedModels)
    ? (pcb.embeddedModels as Array<Record<string, unknown>>)
    : []) {
    const id = String(m.id ?? "");
    if (id && !perId.has(id) && String(m.format ?? "") === "step") perId.set(id, m);
  }

  /** the pad cloud of each component, to say which part a body belongs to */
  const gruppi = Array.isArray(pcb.componentPrimitiveGroups)
    ? (pcb.componentPrimitiveGroups as Array<Record<string, unknown>>)
    : [];
  const rotazioneDi = new Map<string, number>();
  const componenti = new Map<string, Record<string, unknown>>();
  for (const c of Array.isArray(pcb.components)
    ? (pcb.components as Array<Record<string, unknown>>)
    : []) {
    const nome = String(c.designator ?? "").trim();
    if (!nome) continue;
    rotazioneDi.set(nome, num(c.rotation) ?? 0);
    componenti.set(nome, c);
  }
  const centri: Array<{ des: string; x: number; y: number }> = [];
  for (const g of gruppi) {
    const pads = Array.isArray(g.pads) ? (g.pads as Array<Record<string, unknown>>) : [];
    const des = String(g.designator ?? "").trim();
    if (!des || pads.length === 0) continue;
    centri.push({
      des,
      x: pads.reduce((s, p) => s + (num(p.x) ?? 0), 0) / pads.length,
      y: pads.reduce((s, p) => s + (num(p.y) ?? 0), 0) / pads.length,
    });
  }

  /** bodies grouped by model AND orientation: the same model can be turned two ways */
  const gruppiRot = new Map<
    string,
    { modelId: string; rx: number; ry: number; rz: number; altezza: number; colore: string; standoff: number; designator: string[] }
  >();
  let orfani = 0;
  let senzaModello = 0;

  for (const b of bodies) {
    const pos = (b.positionMil ?? {}) as Record<string, unknown>;
    const bx = num(pos.x) ?? 0;
    const by = num(pos.y) ?? 0;
    let vicino: { des: string; d: number } | null = null;
    for (const k of centri) {
      const d = Math.hypot(k.x - bx, k.y - by);
      if (!vicino || d < vicino.d) vicino = { des: k.des, d };
    }
    if (!vicino || vicino.d * MIL > 6) {
      orfani++;
      continue;
    }
    const modelId = String(b.modelId ?? "");
    const altezza = (num(b.overallHeightMil) ?? 0) * MIL;
    if (!modelId || !perId.has(modelId)) {
      senzaModello++;
      out.corpi.push({ designator: vicino.des, modello: null, altezzaMm: r3(altezza) });
      continue;
    }
    const mr = (b.modelRotationDeg ?? {}) as Record<string, unknown>;
    /*
     * The z of the model rotation ALREADY contains the component's rotation
     * (verified: a part turned by 270 has a model turned by 270), and tscircuit
     * applies the component's rotation again when it places the part. So what
     * gets baked into the mesh is the difference: on this board it is zero for 66
     * bodies out of 87, which is exactly what "the footprint and the model agree"
     * looks like.
     */
    const rz = norm360((num(mr.z) ?? 0) - (rotazioneDi.get(vicino.des) ?? 0));
    const rx = num(mr.x) ?? 0;
    const ry = num(mr.y) ?? 0;
    const colore = String(
      ((b.bodyColor ?? {}) as Record<string, unknown>).hex ?? "#808080",
    );
    const chiave = `${modelId}|${rx}|${ry}|${rz}`;
    const gia = gruppiRot.get(chiave);
    if (gia) gia.designator.push(vicino.des);
    else {
      gruppiRot.set(chiave, {
        modelId,
        rx,
        ry,
        rz,
        altezza,
        colore,
        standoff: (num(b.standoffHeightMil) ?? 0) * MIL,
        designator: [vicino.des],
      });
    }
  }

  if (gruppiRot.size === 0) {
    if (senzaModello) out.warnings.push(`${senzaModello} corpi 3D senza modello nel file`);
    return out;
  }

  /*
   * The wasm has no types of its own, and one `any` at the boundary is honest:
   * what comes back is described right below and nothing else is trusted.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const modulo = (await import("occt-import-js" as any)) as any;
  const occtimportjs = (modulo.default ?? modulo) as (
    opts?: unknown,
  ) => Promise<{
    ReadStepFile: (
      data: Uint8Array,
      params: unknown,
    ) => {
      success: boolean;
      meshes: Array<{
        attributes: { position: { array: ArrayLike<number> } };
        index: { array: ArrayLike<number> };
      }>;
    };
  }>;
  const occt = await occtimportjs();

  let n = 0;
  for (const [, g] of gruppiRot) {
    const m = perId.get(g.modelId);
    const testo = String(m?.payloadText ?? "");
    if (!testo) continue;
    let letto: ReturnType<Awaited<ReturnType<typeof occtimportjs>>["ReadStepFile"]>;
    try {
      letto = occt.ReadStepFile(new Uint8Array(Buffer.from(testo, "utf8")), null);
    } catch (err) {
      out.warnings.push(
        `modello 3D di ${g.designator[0]} illeggibile: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    if (!letto.success || letto.meshes.length === 0) {
      out.warnings.push(`modello 3D di ${g.designator[0]} senza geometria`);
      continue;
    }

    /* rotate, measure, then drop it onto the board surface */
    const punti: Array<[number, number, number]> = [];
    const facce: number[][] = [];
    let zmin = Infinity;
    let zmax = -Infinity;
    for (const mesh of letto.meshes) {
      const base = punti.length;
      const pos = mesh.attributes.position.array;
      for (let i = 0; i < pos.length; i += 3) {
        const p = ruota([pos[i], pos[i + 1], pos[i + 2]], g.rx, g.ry, g.rz);
        if (p[2] < zmin) zmin = p[2];
        if (p[2] > zmax) zmax = p[2];
        punti.push(p);
      }
      const idx = mesh.index.array;
      for (let i = 0; i + 2 < idx.length; i += 3) {
        facce.push([base + idx[i] + 1, base + idx[i + 1] + 1, base + idx[i + 2] + 1]);
      }
    }
    if (punti.length === 0 || facce.length === 0) continue;

    const dz = g.standoff - zmin;
    const rgb = [1, 3, 5].map((i) => Number.parseInt(g.colore.slice(i, i + 2), 16) / 255);
    const colore = rgb.every((v) => Number.isFinite(v)) ? rgb : [0.5, 0.5, 0.5];
    const righe: string[] = [
      `# ${g.designator.join(", ")} - modello STEP incorporato nel file Altium`,
      `# ruotato (${g.rx}, ${g.ry}, ${g.rz}) e appoggiato sulla scheda`,
    ];
    for (const p of punti) {
      righe.push(
        `v ${r3(p[0])} ${r3(p[1])} ${r3(p[2] + dz)} ${colore[0].toFixed(3)} ${colore[1].toFixed(3)} ${colore[2].toFixed(3)}`,
      );
    }
    for (const f of facce) righe.push(`f ${f[0]} ${f[1]} ${f[2]}`);

    const nome = `${g.designator[0]}-${n++}.obj`.replace(/[^A-Za-z0-9._-]/g, "_");
    out.modelli.push({
      nome,
      obj: `${righe.join("\n")}\n`,
      triangoli: facce.length,
      altezzaMm: r3(zmax - zmin),
      altezzaDichiarataMm: r3(g.altezza),
    });
    for (const des of g.designator) {
      out.corpi.push({ designator: des, modello: nome, altezzaMm: r3(g.altezza) });
    }
  }

  /*
   * The parts with NO body. Altium draws nothing for them and neither would we,
   * except that some are real parts whose library simply has no model: this board
   * has a connector 5mm tall. For those the file still declares a height, and a
   * box with the right height over the right footprint is worth more than a hole
   * in the assembly — as long as it is called what it is.
   *
   * Test points, fiducials and net ties are left out on purpose: they are copper,
   * not parts, and the height Altium carries for them is inherited nonsense (one
   * fiducial claims 12.8mm).
   */
  const conCorpo = new Set(out.corpi.map((c) => c.designator));
  for (const g of gruppi) {
    const des = String(g.designator ?? "").trim();
    if (!des || conCorpo.has(des)) continue;
    const comp = componenti.get(des);
    const altezza = (num(comp?.height) ?? 0) * MIL;
    const genere = String(
      ((comp?.componentKind ?? {}) as Record<string, unknown>).name ?? "",
    );
    if (altezza <= 0 || /no-bom/.test(genere)) continue;
    const pads = Array.isArray(g.pads) ? (g.pads as Array<Record<string, unknown>>) : [];
    if (pads.length === 0) continue;
    /* the pad cloud in the component's own frame: tscircuit turns the box itself */
    const cx = pads.reduce((s, p) => s + (num(p.x) ?? 0), 0) / pads.length;
    const cy = pads.reduce((s, p) => s + (num(p.y) ?? 0), 0) / pads.length;
    const rot = (-(num(comp?.rotation) ?? 0) * Math.PI) / 180;
    const co = Math.cos(rot);
    const si = Math.sin(rot);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of pads) {
      const dx = (num(p.x) ?? 0) - cx;
      const dy = (num(p.y) ?? 0) - cy;
      const w = ((num(p.sizeTopX) ?? 0) / 2) * MIL;
      const h = ((num(p.sizeTopY) ?? 0) / 2) * MIL;
      const x = (dx * co - dy * si) * MIL;
      const y = (dx * si + dy * co) * MIL;
      minX = Math.min(minX, x - w); maxX = Math.max(maxX, x + w);
      minY = Math.min(minY, y - h); maxY = Math.max(maxY, y + h);
    }
    if (!Number.isFinite(minX)) continue;
    out.corpi.push({
      designator: des,
      modello: null,
      altezzaMm: r3(altezza),
      scatola: {
        larghezza: r3(Math.max(0.4, maxX - minX)),
        profondita: r3(Math.max(0.4, maxY - minY)),
        altezza: r3(altezza),
      },
    });
    out.warnings.push(
      `${des} non ha un modello 3D nel file: disegnato come scatola alta ${r3(altezza)}mm sul suo footprint`,
    );
  }

  if (orfani) out.warnings.push(`${orfani} corpi 3D non assegnati a nessun componente`);
  if (senzaModello) {
    out.warnings.push(`${senzaModello} corpi 3D senza modello incorporato: restano senza forma`);
  }
  /*
   * A model whose mesh does not come out the declared height is reported: it
   * means the rotation of that one is not the usual one, and it is better to
   * know which part to look at than to find it by turning the board around.
   */
  for (const m of out.modelli) {
    if (Math.abs(m.altezzaMm - m.altezzaDichiarataMm) > 0.2) {
      out.warnings.push(
        `il modello 3D ${m.nome} esce alto ${m.altezzaMm}mm dove il file dichiara ${m.altezzaDichiarataMm}mm`,
      );
    }
  }
  return out;
}
