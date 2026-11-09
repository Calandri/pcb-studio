/**
 * THE BOARD THE RIGHT WAY UP.
 *
 * altium-toolkit hands a .PcbDoc over in SVG "top view" space: every y is
 * mirrored across the board (PcbGeometryFlipper.flipGeometryVertically, y =
 * minY + maxY - y, angles 360 - a), the native model and the Circuit JSON it
 * derives from it alike. Altium, like tscircuit, has y pointing UP. Imported
 * as it came, the whole board was mirrored top to bottom: on TM_4L U2 pin 1 at
 * (-18.45; -5.65) instead of (-18.45; 5.65) and the pins going clockwise,
 * every rotation with its sign changed, and the Gerbers of an imported board
 * described a board nobody can assemble (2026-11-09: bat-bs, birdy-bs,
 * altium-ht-tm-4g, altium-queen-ht, tm-4l-r3). Copper and DRC added up because
 * the mirror is consistent, which is why it went unnoticed.
 *
 * Here the same mirror is applied once more, to everything the importer reads
 * from a board: the flip is its own inverse, so the board comes back exactly
 * as Altium has it. A .PcbLib is not flipped by the toolkit and is not touched.
 */

type El = Record<string, unknown>;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const angolo = (a: unknown): number => {
  const n = (Number(a ?? 0) % 360 + 360) % 360;
  return Math.round(n * 1e9) / 1e9;
};

/** the toolkit's own axis: y = minY + maxY - y, read from the board outline it used */
export function assiDelRibaltamento(pcb: El): { mil: number } | null {
  const o = (pcb.boardOutline ?? null) as El | null;
  const minY = num(o?.minY);
  const h = num(o?.heightMil);
  if (minY === null || h === null) return null;
  return { mil: 2 * minY + h };
}

/* ------------------------------------------------------------- native model */

function segmento(s: El, y: (v: unknown) => number): El {
  const out: El = { ...s };
  if (s.y1 !== undefined) out.y1 = y(s.y1);
  if (s.y2 !== undefined) out.y2 = y(s.y2);
  if (s.type === "arc") {
    if (s.cy !== undefined) out.cy = y(s.cy);
    out.startAngle = angolo(360 - Number(s.startAngle ?? 0));
    out.endAngle = angolo(360 - Number(s.endAngle ?? 0));
  }
  return out;
}

function puntiRegione(points: unknown, y: (v: unknown) => number): El[] {
  return (Array.isArray(points) ? (points as El[]) : []).map((p) => {
    const q: El = { ...p, y: y(p.y) };
    if (p.centerY !== null && p.centerY !== undefined) q.centerY = y(p.centerY);
    if (p.startAngle !== null && p.startAngle !== undefined) q.startAngle = angolo(360 - Number(p.startAngle));
    if (p.endAngle !== null && p.endAngle !== undefined) q.endAngle = angolo(360 - Number(p.endAngle));
    return q;
  });
}

function regione(r: El, y: (v: unknown) => number): El {
  const out: El = { ...r, points: puntiRegione(r.points, y) };
  if (Array.isArray(r.holes)) out.holes = (r.holes as unknown[]).map((h) => puntiRegione(h, y));
  if (Array.isArray(r.bendingLines)) {
    out.bendingLines = (r.bendingLines as El[]).map((l) => ({
      ...l,
      ...(l.y1 === null || l.y1 === undefined ? {} : { y1: y(l.y1) }),
      ...(l.y2 === null || l.y2 === undefined ? {} : { y2: y(l.y2) }),
    }));
  }
  return out;
}

const pad = (p: El, y: (v: unknown) => number): El => ({
  ...p,
  y: y(p.y),
  rotation: angolo(360 - Number(p.rotation ?? 0)),
  ...(p.holeRotation === null || p.holeRotation === undefined
    ? {}
    : { holeRotation: angolo(360 - Number(p.holeRotation)) }),
});

const fill = (f: El, y: (v: unknown) => number): El => {
  const a = y(f.y1);
  const b = y(f.y2);
  return { ...f, y1: Math.min(a, b), y2: Math.max(a, b) };
};

const lista = (v: unknown): El[] => (Array.isArray(v) ? (v as El[]) : []);

/** the primitives of one set (a board, or one component's group), mirrored */
function primitive(src: El, y: (v: unknown) => number): El {
  const out: El = { ...src };
  if (Array.isArray(src.polygons)) {
    out.polygons = lista(src.polygons).map((p) => ({ ...p, segments: lista(p.segments).map((s) => segmento(s, y)) }));
  }
  if (Array.isArray(src.fills)) out.fills = lista(src.fills).map((f) => fill(f, y));
  if (Array.isArray(src.tracks)) out.tracks = lista(src.tracks).map((t) => ({ ...t, y1: y(t.y1), y2: y(t.y2) }));
  if (Array.isArray(src.arcs)) {
    out.arcs = lista(src.arcs).map((a) => ({
      ...a,
      y: y(a.y),
      startAngle: angolo(360 - Number(a.startAngle ?? 0)),
      endAngle: angolo(360 - Number(a.endAngle ?? 0)),
    }));
  }
  if (Array.isArray(src.vias)) out.vias = lista(src.vias).map((v) => ({ ...v, y: y(v.y) }));
  if (Array.isArray(src.pads)) out.pads = lista(src.pads).map((p) => pad(p, y));
  for (const k of ["regions", "shapeBasedRegions", "boardRegions"]) {
    if (Array.isArray(src[k])) out[k] = lista(src[k]).map((r) => regione(r, y));
  }
  if (Array.isArray(src.texts)) {
    out.texts = lista(src.texts).map((t) => ({ ...t, y: y(t.y), rotation: angolo(360 - Number(t.rotation ?? 0)) }));
  }
  if (Array.isArray(src.components)) {
    out.components = lista(src.components).map((c) => ({
      ...c,
      y: y(c.y),
      rotation: angolo(360 - Number(c.rotation ?? 0)),
    }));
  }
  return out;
}

/** the native .PcbDoc model, back in Altium's own orientation (mils) */
export function raddrizzaNativo(pcb: El): El {
  const asse = assiDelRibaltamento(pcb);
  if (!asse) return pcb;
  const y = (v: unknown) => asse.mil - Number(v ?? 0);
  const out = primitive(pcb, y);
  const o = (pcb.boardOutline ?? {}) as El;
  out.boardOutline = { ...o, segments: lista(o.segments).map((s) => segmento(s, y)) };
  // the per-component copies of the same primitives
  for (const k of ["componentPrimitiveGroups", "componentPrimitives"]) {
    if (Array.isArray(pcb[k])) out[k] = lista(pcb[k]).map((g) => primitive(g, y));
  }
  // 3D bodies: their position, and the model's turn, which follows the part's
  if (Array.isArray(pcb.componentBodies)) {
    out.componentBodies = lista(pcb.componentBodies).map((b) => {
      const pos = (b.positionMil ?? null) as El | null;
      const rot = (b.modelRotationDeg ?? null) as El | null;
      return {
        ...b,
        ...(pos ? { positionMil: { ...pos, y: y(pos.y) } } : {}),
        ...(rot && num(rot.z) !== null ? { modelRotationDeg: { ...rot, z: angolo(360 - Number(rot.z)) } } : {}),
      };
    });
  }
  return out;
}

/* ------------------------------------------------------------- Circuit JSON */

/** the toolkit's Circuit JSON of a board, mirrored back across the same axis (mm) */
export function raddrizzaCircuito(model: El[], asseMil: number): El[] {
  const K = asseMil * 0.0254;
  const y = (v: unknown) => {
    const n = num(v);
    return n === null ? v : Math.round((K - n) * 1e6) / 1e6;
  };
  const punto = (p: unknown): unknown => {
    if (!p || typeof p !== "object") return p;
    const q = p as El;
    return q.y === undefined ? q : { ...q, y: y(q.y) };
  };
  const anello = (r: unknown): unknown => {
    if (!r || typeof r !== "object") return r;
    const q = r as El;
    return Array.isArray(q.vertices) ? { ...q, vertices: (q.vertices as unknown[]).map(punto) } : q;
  };
  return model.map((raw) => {
    const el: El = { ...raw };
    if (el.y !== undefined) el.y = y(el.y);
    for (const k of ["center", "anchor_position", "position"]) {
      if (el[k] && typeof el[k] === "object") el[k] = punto(el[k]);
    }
    for (const k of ["route", "outline", "points", "pad_outline_absolute"]) {
      if (Array.isArray(el[k])) el[k] = (el[k] as unknown[]).map(punto);
    }
    // relative vectors turn sign, they do not cross the axis
    if (num(el.hole_offset_y) !== null) el.hole_offset_y = -Number(el.hole_offset_y);
    if (Array.isArray(el.pad_outline)) {
      el.pad_outline = (el.pad_outline as El[]).map((p) => (num(p.y) !== null ? { ...p, y: -Number(p.y) } : p));
    }
    const brep = el.brep_shape as El | undefined;
    if (brep && typeof brep === "object") {
      el.brep_shape = {
        ...brep,
        ...(brep.outer_ring ? { outer_ring: anello(brep.outer_ring) } : {}),
        ...(Array.isArray(brep.inner_rings) ? { inner_rings: (brep.inner_rings as unknown[]).map(anello) } : {}),
      };
    }
    for (const k of ["rotation", "ccw_rotation", "rect_ccw_rotation", "text_ccw_rotation"]) {
      if (num(el[k]) !== null) el[k] = angolo(360 - Number(el[k]));
    }
    return el;
  });
}

/**
 * A parsed .PcbDoc the right way up: the native model and the Circuit JSON,
 * across the same axis. Anything without a board outline (a schematic, a
 * library) comes back untouched.
 */
export function raddrizzaPcbDoc(model: El[], native: El): { model: El[]; native: El } {
  const pcb = (native.pcb ?? null) as El | null;
  if (!pcb) return { model, native };
  const asse = assiDelRibaltamento(pcb);
  if (!asse) return { model, native };
  return { model: raddrizzaCircuito(model, asse.mil), native: { ...native, pcb: raddrizzaNativo(pcb) } };
}
