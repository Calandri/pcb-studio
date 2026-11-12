/**
 * THE SHAPE OF A ZONE OF THE BOARD: a keepout or a cutout, read from the
 * element the Circuit JSON has for it.
 *
 * It lived inside ground-stitching.ts, which loads the geometry runtime and the
 * Gerber writer. The solver of the viewer (src/lib/spinta/) needs the same
 * shapes in the browser, so the reading stands here on its own, with nothing
 * to load, and both read a zone the same way.
 */
import type { Punto } from "./ground-stitching";

type El = { type: string; [key: string]: unknown };

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** a zone of the board: a polygon, a circle, or a slot milled along a line (its half-width as r) */
export type Sagoma = { punti: Punto[] } | { x: number; y: number; r: number } | { tratti: Array<[Punto, Punto]>; r: number };

/**
 * The shape of a keepout or a cutout: its polygon, its circle, or for a cutout
 * drawn as a path (`shape: "path"`, a slot slot_width wide milled along a
 * route) the line with half the width. A slot written in pieces (slot_length,
 * space_between_slots) counts whole: the bridges between the pieces are no
 * place for a via.
 */
export function sagomaDiZona(el: El): Sagoma | null {
  const c = el.center as { x?: unknown; y?: unknown } | undefined;
  const cx = num(c?.x) ?? num(el.x);
  const cy = num(c?.y) ?? num(el.y);
  const shape = String(el.shape ?? "");
  if (shape === "path") {
    const linea = ((el.route as Array<{ x?: unknown; y?: unknown }> | undefined) ?? [])
      .map((p) => ({ x: num(p?.x), y: num(p?.y) }))
      .filter((p): p is Punto => p.x !== null && p.y !== null);
    if (linea.length === 0) return null;
    const r = Math.max(0, num(el.slot_width) ?? 0) / 2;
    if (linea.length === 1) return { x: linea[0].x, y: linea[0].y, r };
    return { tratti: linea.slice(1).map((p, i) => [linea[i], p] as [Punto, Punto]), r };
  }
  if (shape === "circle" && cx !== null && cy !== null && num(el.radius) !== null) return { x: cx, y: cy, r: num(el.radius)! };
  if (shape === "rect" && cx !== null && cy !== null && num(el.width) !== null && num(el.height) !== null) {
    const w = num(el.width)! / 2, h = num(el.height)! / 2;
    const rad = ((num(el.rotation) ?? num(el.ccw_rotation) ?? 0) * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    return {
      punti: [[-w, -h], [w, -h], [w, h], [-w, h]].map(([u, v]) => ({ x: cx + u * cos - v * sin, y: cy + u * sin + v * cos })),
    };
  }
  const punti = ((el.points as Array<{ x?: unknown; y?: unknown }> | undefined) ?? [])
    .map((p) => ({ x: num(p?.x), y: num(p?.y) }))
    .filter((p): p is Punto => p.x !== null && p.y !== null);
  return punti.length >= 3 ? { punti } : null;
}
