/**
 * THE GLB OF A RIGID-FLEX BOARD CARRIES ONLY ITS RIGID PART.
 *
 * The converter (circuit-json-to-gltf) extrudes the whole outline of the board
 * at the board's thickness: on a rigid-flex board the tail came out as 45 mm
 * of 1.6 mm board, flat, which is nothing like the board. So before the
 * conversion, on the copy of the circuit made for it, the outline becomes the
 * outline minus the flexible zones of flex.json, and the 3D models of parts
 * whose centre is on a tail are taken out: the 3D view draws the tail itself,
 * thin and folded (flex-3d.ts), with those parts on it.
 *
 * Why the outline and not a pcb_cutout: the converter maps the board's picture
 * (copper, mask, silkscreen) onto the box of the board mesh, and draws the
 * picture over the box of the outline. Cut out of a full outline, the rigid
 * part would carry the picture of the whole board squeezed onto it.
 *
 * When the rigid part is not one piece (a tail joining two rigid boards) the
 * outline cannot say it: the circuit is left as it is, and the 3D view says so
 * and does not fold the tail.
 */
import { getManifoldModule } from "@tscircuit/manifold-2d";
import { contornoDellaScheda, flessibileDellaScheda, nelPoligono, profondita, vuotiDellaScheda, type Punto } from "./flex-zone";

type El = Record<string, unknown> & { type: string };

const areaConSegno = (p: Punto[]): number => {
  let a = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += (p[j].x + p[i].x) * (p[j].y - p[i].y);
  return -a / 2;
};

/**
 * The outline of the board minus its flexible zones and its own cutouts (on
 * independent flexible layers the gap closed between two tails is one: it is
 * not rigid board). null when the rigid part is not one piece, when a hole is
 * left that is not one of the board's cutouts (the converter cuts those by
 * itself), or on any failure.
 */
export async function contornoRigido(contorno: Punto[], zone: Punto[][], vuoti: Punto[][] = []): Promise<Punto[] | null> {
  if (contorno.length < 3 || zone.length === 0) return null;
  const m = await getManifoldModule();
  const daLiberare: Array<{ delete(): void }> = [];
  try {
    const tutto = m.CrossSection.ofPolygons([contorno.map((p) => [p.x, p.y] as [number, number])], "EvenOdd");
    daLiberare.push(tutto);
    const via = m.CrossSection.ofPolygons(
      [...zone, ...vuoti].map((z) => z.map((p) => [p.x, p.y] as [number, number])),
      "NonZero",
    );
    daLiberare.push(via);
    const resto = tutto.subtract(via);
    daLiberare.push(resto);
    const anelli = (resto.toPolygons() as Array<Array<[number, number]>>)
      .map((c) => c.map(([x, y]) => ({ x, y })))
      .filter((c) => c.length >= 3);
    const pieni = anelli.filter((c) => areaConSegno(c) > 1e-6);
    const buchi = anelli.filter((c) => areaConSegno(c) < -1e-6);
    // one piece; a hole only where the board has a cutout of its own, which the converter cuts by itself
    const deiVuoti = (b: Punto[]) => {
      const c = { x: b.reduce((t, q) => t + q.x, 0) / b.length, y: b.reduce((t, q) => t + q.y, 0) / b.length };
      return vuoti.some((v) => nelPoligono(c.x, c.y, v));
    };
    if (pieni.length !== 1 || !buchi.every(deiVuoti)) return null;
    return pieni[0];
  } catch {
    return null;
  } finally {
    for (const o of daLiberare) {
      try {
        o.delete();
      } catch {
        /* already gone */
      }
    }
  }
}

/**
 * What the GLB of a board is, said to the viewer: "rigida" only the rigid part
 * (the viewer draws the tail), "intera" a rigid-flex board left whole (its rigid
 * part is not one piece), null a board with no flexible zone.
 */
export type GlbDelFlessibile = "rigida" | "intera" | null;

/**
 * The circuit the GLB is made from: with flexible zones, the outline of the
 * rigid part only and no 3D model of a part standing on a tail. CHANGES the
 * circuit it is given (the route parses one for each request) and says what it
 * made of it; a board with no flexible zone is left as it came.
 */
export async function soloLaParteRigida(circuitJson: unknown[]): Promise<GlbDelFlessibile> {
  const els = circuitJson as El[];
  const flex = flessibileDellaScheda(els);
  if (!flex) return null;
  const board = els.find((el) => el?.type === "pcb_board");
  if (!board) return "intera";
  const rigido = await contornoRigido(
    contornoDellaScheda(els),
    flex.zone.map((z) => z.punti),
    vuotiDellaScheda(els),
  );
  if (!rigido) return "intera";
  board.outline = rigido.map((p) => ({ x: p.x, y: p.y }));

  const sullaCoda = new Set<string>();
  for (const el of els) {
    if (el.type !== "pcb_component") continue;
    const c = el.center as { x?: unknown; y?: unknown } | undefined;
    if (typeof c?.x !== "number" || typeof c?.y !== "number") continue;
    if (flex.zone.some((z) => profondita(c.x as number, c.y as number, z.punti) > 0)) sullaCoda.add(String(el.pcb_component_id));
  }
  if (sullaCoda.size > 0) {
    const resto = els.filter((el) => !(el.type === "cad_component" && sullaCoda.has(String(el.pcb_component_id))));
    els.length = 0;
    els.push(...resto);
  }
  return "rigida";
}
