/**
 * THE PASTE OF EACH PAD IS THE PAD.
 *
 * tscircuit draws the stencil opening of every pad at 70% of its width and 70%
 * of its height: half the area. Measured on BAT_BS on 2026-10-20, all 336 pads
 * came out that way, while the Altium file asks for an expansion of zero, the
 * default of Altium and KiCad and what IPC-7525 starts from. Half the paste is
 * not a conservative choice: an 0402 with half its solder stands up on one end
 * during reflow, and a fine-pitch lead with half its fillet is a joint that
 * opens with the first thermal cycle. The Gerber shipped to the factory carried
 * it for every board.
 *
 * So, after compiling, every opening that belongs to a pad is redrawn from the
 * pad: same shape, same centre, same rotation, grown or shrunk by the project's
 * `pasteExpansionMm` (zero when the project says nothing). Openings that belong
 * to no pad (a footprint that draws its own stencil, like the segmented ring of
 * a MEMS microphone) are the designer's and are left alone; pads covered by
 * solder mask have no opening and get none.
 */

type El = Record<string, unknown> & { type: string };

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** below this an opening prints nothing: better no aperture than a pinhole */
const APERTURA_MINIMA_MM = 0.05;

export function pastaDaiPad<T extends El>(circuitJson: T[], expansionMm = 0): T[] {
  const e = Number.isFinite(expansionMm) ? expansionMm : 0;
  const pads = new Map<string, El>();
  for (const el of circuitJson) {
    if (el.type === "pcb_smtpad" && typeof el.pcb_smtpad_id === "string") pads.set(el.pcb_smtpad_id, el);
  }
  const out: T[] = [];
  for (const el of circuitJson) {
    if (el.type !== "pcb_solder_paste" || typeof el.pcb_smtpad_id !== "string") {
      out.push(el);
      continue;
    }
    const pad = pads.get(el.pcb_smtpad_id);
    if (!pad || pad.is_covered_with_solder_mask === true) {
      // a covered pad has nothing to print on; an orphan is left as it was
      if (!pad) out.push(el);
      continue;
    }
    const nuova = ridisegna(el, pad, e);
    if (nuova) out.push(nuova as T);
  }
  return out;
}

function ridisegna(paste: El, pad: El, e: number): El | null {
  const base: El = { ...paste };
  const x = num(pad.x);
  const y = num(pad.y);
  if (x !== null) base.x = x;
  if (y !== null) base.y = y;
  const shape = String(pad.shape);
  if (shape === "circle") {
    const r = num(pad.radius);
    if (r === null) return paste;
    const raggio = r + e;
    if (raggio * 2 < APERTURA_MINIMA_MM) return null;
    return { ...base, shape: "circle", radius: raggio };
  }
  const w = num(pad.width);
  const h = num(pad.height);
  if (w === null || h === null) return paste;
  const width = w + 2 * e;
  const height = h + 2 * e;
  if (width < APERTURA_MINIMA_MM || height < APERTURA_MINIMA_MM) return null;
  if (shape === "rect") return { ...base, shape: "rect", width, height };
  if (shape === "rotated_rect") {
    return { ...base, shape: "rotated_rect", width, height, ccw_rotation: num(pad.ccw_rotation) ?? 0 };
  }
  if (shape === "pill" || shape === "rotated_pill") {
    const r = num(pad.radius) ?? Math.min(w, h) / 2;
    return {
      ...base,
      width,
      height,
      radius: Math.max(0, Math.min(r + e, Math.min(width, height) / 2)),
      ...(shape === "rotated_pill" ? { ccw_rotation: num(pad.ccw_rotation) ?? 0 } : {}),
    };
  }
  return paste;
}
