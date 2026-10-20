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
 * `pasteExpansionMm` (zero when the project says nothing). Pads covered by
 * solder mask have no opening and get none. Through-hole pads get none either
 * unless the project asks for pin-in-paste (`pasteOnPlatedHoles`): tscircuit
 * pasted them on both faces, which on a normal line leaves solder on the pad
 * before the part goes in. A component listed in stencil.json gets the
 * openings drawn there instead of its pads' (see below).
 */

type El = Record<string, unknown> & { type: string };

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** below this an opening prints nothing: better no aperture than a pinhole */
const APERTURA_MINIMA_MM = 0.05;

/**
 * A FOOTPRINT THAT DRAWS ITS OWN STENCIL.
 *
 * tscircuit has no element for a paste opening that is not a pad, and some
 * parts cannot do without one: a bottom-port MEMS microphone wants a solid
 * copper ring for the acoustic seal and a BROKEN paste ring on it (Knowles
 * SiSonic design guide, Infineon IM72D128 datasheet), and a pad's own paste can
 * only be the whole pad. Altium draws these as paste primitives; here they live
 * in `stencil.json`, per component, in the footprint's own coordinates:
 *
 *   { "componenti": { "MIC1": { "aperture": [
 *       { "forma": "cerchio", "x": 0.66, "y": 0, "r": 0.13 },
 *       { "forma": "rettangolo", "x": -0.85, "y": -1.5, "w": 0.65, "h": 0.4, "rot": 0 } ] } } }
 *
 * A component listed there loses the automatic paste of all its pads and gets
 * exactly these openings, moved and turned with it (and mirrored when it sits
 * underneath, as tscircuit does with its footprint).
 */
export const STENCIL_PATH = "stencil.json";

export interface AperturaStencil {
  forma: "cerchio" | "rettangolo";
  x: number;
  y: number;
  r?: number;
  w?: number;
  h?: number;
  rot?: number;
}

export interface StencilProgetto {
  componenti: Record<string, { aperture: AperturaStencil[] }>;
}

const MAX_APERTURE = 400;
const finito = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** reads and checks stencil.json: a broken entry is reported and skipped, never guessed */
export function leggiStencil(fsMap: Record<string, string>): { stencil: StencilProgetto; avvisi: string[] } {
  const avvisi: string[] = [];
  const vuoto: StencilProgetto = { componenti: {} };
  const raw = fsMap[STENCIL_PATH];
  if (!raw) return { stencil: vuoto, avvisi };
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    avvisi.push(`${STENCIL_PATH} non e' un JSON valido (${err instanceof Error ? err.message : String(err)}): ignorato`);
    return { stencil: vuoto, avvisi };
  }
  const comps = (data as { componenti?: unknown })?.componenti;
  if (!comps || typeof comps !== "object") {
    avvisi.push(`${STENCIL_PATH}: manca l'oggetto "componenti", ignorato`);
    return { stencil: vuoto, avvisi };
  }
  const out: StencilProgetto = { componenti: {} };
  for (const [nome, voce] of Object.entries(comps as Record<string, unknown>)) {
    const aperture = (voce as { aperture?: unknown })?.aperture;
    if (!Array.isArray(aperture)) {
      avvisi.push(`${STENCIL_PATH}: ${nome} senza elenco "aperture", ignorato`);
      continue;
    }
    const buone: AperturaStencil[] = [];
    for (const a of aperture.slice(0, MAX_APERTURE)) {
      const ap = a as Record<string, unknown>;
      const ok =
        finito(ap.x) && Math.abs(ap.x) < 50 && finito(ap.y) && Math.abs(ap.y) < 50 &&
        ((ap.forma === "cerchio" && finito(ap.r) && ap.r >= APERTURA_MINIMA_MM / 2 && ap.r <= 5) ||
          (ap.forma === "rettangolo" && finito(ap.w) && finito(ap.h) &&
            ap.w >= APERTURA_MINIMA_MM && ap.h >= APERTURA_MINIMA_MM && ap.w <= 10 && ap.h <= 10 &&
            (ap.rot === undefined || finito(ap.rot))));
      if (ok) buone.push(ap as unknown as AperturaStencil);
      else avvisi.push(`${STENCIL_PATH}: ${nome}, apertura non valida ${JSON.stringify(a).slice(0, 120)}: saltata`);
    }
    if (aperture.length > MAX_APERTURE) avvisi.push(`${STENCIL_PATH}: ${nome} ha piu' di ${MAX_APERTURE} aperture, tenute le prime`);
    out.componenti[nome] = { aperture: buone };
  }
  return { stencil: out, avvisi };
}

export interface OpzioniPasta {
  /** custom openings per component, see leggiStencil */
  stencil?: StencilProgetto;
  /** paste on through-hole pads (pin-in-paste): off unless the project asks */
  pasteOnPlatedHoles?: boolean;
}

export function pastaDaiPad<T extends El>(circuitJson: T[], expansionMm = 0, opzioni: OpzioniPasta = {}): T[] {
  const e = Number.isFinite(expansionMm) ? expansionMm : 0;
  const pads = new Map<string, El>();
  for (const el of circuitJson) {
    if (el.type === "pcb_smtpad" && typeof el.pcb_smtpad_id === "string") pads.set(el.pcb_smtpad_id, el);
  }
  // the components that draw their own stencil, by tscircuit id
  const nomeDi = new Map<string, string>();
  for (const el of circuitJson) {
    if (el.type === "source_component" && typeof el.source_component_id === "string") {
      nomeDi.set(el.source_component_id, String(el.name ?? ""));
    }
  }
  const conStencil = new Map<string, { comp: El; aperture: AperturaStencil[]; nome: string }>();
  const voci = opzioni.stencil?.componenti ?? {};
  for (const el of circuitJson) {
    if (el.type !== "pcb_component" || typeof el.pcb_component_id !== "string") continue;
    const nome = nomeDi.get(String(el.source_component_id ?? ""));
    if (nome && voci[nome]) conStencil.set(el.pcb_component_id, { comp: el, aperture: voci[nome].aperture, nome });
  }
  // through-hole pads, by centre: tscircuit pastes them without saying whose paste it is
  const fori = new Set<string>();
  for (const el of circuitJson) {
    if (el.type === "pcb_plated_hole" && num(el.x) !== null && num(el.y) !== null) {
      fori.add(`${(el.x as number).toFixed(4)},${(el.y as number).toFixed(4)}`);
    }
  }
  const out: T[] = [];
  for (const el of circuitJson) {
    if (el.type !== "pcb_solder_paste") {
      out.push(el);
      continue;
    }
    if (typeof el.pcb_smtpad_id !== "string") {
      const suForo = num(el.x) !== null && num(el.y) !== null &&
        fori.has(`${(el.x as number).toFixed(4)},${(el.y as number).toFixed(4)}`);
      if (suForo && opzioni.pasteOnPlatedHoles !== true) continue;
      out.push(el);
      continue;
    }
    const pad = pads.get(el.pcb_smtpad_id);
    if (pad && typeof pad.pcb_component_id === "string" && conStencil.has(pad.pcb_component_id)) continue;
    if (!pad || pad.is_covered_with_solder_mask === true) {
      // a covered pad has nothing to print on; an orphan is left as it was
      if (!pad) out.push(el);
      continue;
    }
    const nuova = ridisegna(el, pad, e);
    if (nuova) out.push(nuova as T);
  }
  for (const { comp, aperture, nome } of conStencil.values()) {
    aperture.forEach((a, i) => out.push(aperturaSullaScheda(comp, a, `${nome}_${i}`) as T));
  }
  return out;
}

/** a footprint opening placed where the component is: mirrored underneath, turned, moved */
function aperturaSullaScheda(comp: El, a: AperturaStencil, chiave: string): El {
  const sotto = comp.layer === "bottom";
  const rot = num(comp.rotation) ?? 0;
  const ox = num(comp.display_offset_x) ?? 0;
  const oy = num(comp.display_offset_y) ?? 0;
  const lx = sotto ? -a.x : a.x;
  const t = (rot * Math.PI) / 180;
  const x = ox + lx * Math.cos(t) - a.y * Math.sin(t);
  const y = oy + lx * Math.sin(t) + a.y * Math.cos(t);
  const base = {
    type: "pcb_solder_paste",
    pcb_solder_paste_id: `pcb_solder_paste_stencil_${chiave}`.replace(/[^A-Za-z0-9_]/g, "_"),
    pcb_component_id: comp.pcb_component_id,
    layer: sotto ? "bottom" : "top",
    x,
    y,
  };
  if (a.forma === "cerchio") return { ...base, shape: "circle", radius: a.r };
  const giro = ((((sotto ? -(a.rot ?? 0) : (a.rot ?? 0)) + rot) % 360) + 360) % 360;
  const dritto = Math.abs(giro % 90) < 1e-9 || Math.abs((giro % 90) - 90) < 1e-9;
  if (dritto) {
    const scambia = Math.round(giro / 90) % 2 === 1;
    return { ...base, shape: "rect", width: scambia ? a.h : a.w, height: scambia ? a.w : a.h };
  }
  return { ...base, shape: "rotated_rect", width: a.w, height: a.h, ccw_rotation: giro };
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
