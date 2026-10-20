/**
 * ROTATED PADS AS REGIONS, NOT AS %LR.
 *
 * circuit-json-to-gerber draws a pad that is not at 0/90/180/270 degrees by
 * flashing its ordinary aperture inside a "load rotation" block:
 * `%LR135*%  X..Y..D03*  %LR0*%`. %LR is valid Gerber (added in the 2016
 * revision), but it is the one command many readers still skip: Altium and
 * KiCad never write it, and a reader that ignores it flashes every rotated pad
 * square to the axes. Measured on BIRDY_BAT on 2026-10-21: JLCPCB's viewer drew
 * the 64 pads of the STM32 (LQFP64 at 135 degrees) as horizontal and vertical
 * bars stepping along the diagonals, 0.05 mm apart. Eurocircuits read it right;
 * a factory whose CAM reads it wrong etches a board that cannot be soldered,
 * and nothing in the files warns anyone.
 *
 * So every flash made under a rotation is written out as a region (G36/G37):
 * the outline of the aperture, rotated about the flash point. That is what
 * Altium and KiCad write for a rotated pad, and every reader draws it. Round
 * apertures look the same at any angle and are flashed as before. A layer that
 * uses a rotation this cannot convert (an unknown macro, a draw with a rotated
 * rectangle) is left exactly as it was and reported, never half converted.
 */

type Punto = [number, number];

/** segments for half a circle in an approximated arc: 0.001 mm off on a 0.3 mm pill */
const SEGMENTI_SEMICERCHIO = 24;

type Apertura = { tipo: string; p: number[] };

function arco(cx: number, cy: number, r: number, da: number, a: number, n: number): Punto[] {
  const out: Punto[] = [];
  for (let i = 0; i <= n; i++) {
    const t = da + ((a - da) * i) / n;
    out.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
  }
  return out;
}

/** stadium of total size w x h, centred on the origin, long axis along x if w > h */
function pillola(w: number, h: number): Punto[] {
  if (Math.abs(w - h) < 1e-9) return arco(0, 0, w / 2, 0, 2 * Math.PI, 2 * SEGMENTI_SEMICERCHIO).slice(0, -1);
  if (w > h) {
    const r = h / 2;
    const c = w / 2 - r;
    return [...arco(c, 0, r, -Math.PI / 2, Math.PI / 2, SEGMENTI_SEMICERCHIO), ...arco(-c, 0, r, Math.PI / 2, (3 * Math.PI) / 2, SEGMENTI_SEMICERCHIO)];
  }
  const r = w / 2;
  const c = h / 2 - r;
  return [...arco(0, c, r, 0, Math.PI, SEGMENTI_SEMICERCHIO), ...arco(0, -c, r, Math.PI, 2 * Math.PI, SEGMENTI_SEMICERCHIO)];
}

/** the outline of an aperture at 0 degrees, or null when this cannot draw it exactly */
function contorno(a: Apertura): Punto[] | null {
  const p = a.p;
  switch (a.tipo) {
    case "R": {
      if (p.length !== 2) return null; // a rectangle with a hole is not a region
      const [w, h] = p;
      return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
    }
    case "O":
      return p.length === 2 ? pillola(p[0], p[1]) : null;
    case "P": {
      if (p.length < 2 || p.length > 3) return null;
      const [d, n, rot = 0] = p;
      return Array.from({ length: Math.round(n) }, (_, i) => {
        const t = ((rot + (360 * i) / Math.round(n)) * Math.PI) / 180;
        return [(d / 2) * Math.cos(t), (d / 2) * Math.sin(t)] as Punto;
      });
    }
    case "HORZPILL":
    case "VERTPILL": {
      // $1 width, $2 height, $3 circle diameter, $4 circle offset: a stadium only when the circles close the box
      const [w, h, d, off] = p;
      const lungo = a.tipo === "HORZPILL" ? w : h;
      const corto = a.tipo === "HORZPILL" ? h : w;
      if (Math.abs(d - corto) > 1e-6 || Math.abs(off - (lungo - d) / 2) > 1e-6) return null;
      return pillola(w, h);
    }
    case "ROUNDRECT": {
      // $1 corner radius, then the four corner centres
      const r = p[0];
      const xs = [p[1], p[3], p[5], p[7]];
      const ys = [p[2], p[4], p[6], p[8]];
      if (xs.some((v) => !Number.isFinite(v)) || ys.some((v) => !Number.isFinite(v))) return null;
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      const q = SEGMENTI_SEMICERCHIO / 2;
      return [
        ...arco(x1, y0, r, -Math.PI / 2, 0, q),
        ...arco(x1, y1, r, 0, Math.PI / 2, q),
        ...arco(x0, y1, r, Math.PI / 2, Math.PI, q),
        ...arco(x0, y0, r, Math.PI, (3 * Math.PI) / 2, q),
      ];
    }
    default:
      return null;
  }
}

/** one layer: the text with every rotated flash turned into a region, or null if it cannot be done whole */
function convertiStrato(testo: string): { testo: string; regioni: number } | null {
  if (!testo.includes("%LR")) return { testo, regioni: 0 };
  const fs = testo.match(/%FSLAX(\d)(\d)Y(\d)(\d)\*%/);
  if (!fs) return null;
  const decimali = Number(fs[2]);
  const scala = 10 ** decimali;
  const aperture = new Map<number, Apertura>();
  for (const m of testo.matchAll(/%ADD(\d+)([A-Za-z_][A-Za-z0-9_]*),?([^*]*)\*%/g)) {
    aperture.set(Number(m[1]), { tipo: m[2], p: m[3] ? m[3].split("X").map(Number) : [] });
  }
  const fmt = (v: number) => String(Math.round(v * scala));

  // statements: an extended command %...% or a word command ending in *
  const istruzioni = testo.match(/%[^%]*%|[^%*\n]*\*/g) ?? [];
  const out: string[] = [];
  let rot = 0;
  let ap: number | null = null;
  let x = 0, y = 0;
  let modo = "G01";
  let esplicito = false; // after a region the current point moved: the next coordinate must be absolute
  let regioni = 0;
  for (const grezza of istruzioni) {
    const s = grezza.trim();
    if (!s) continue;
    if (s.startsWith("%")) {
      const lr = s.match(/^%LR(-?[0-9.]+)\*%$/);
      if (lr) {
        rot = Number(lr[1]);
        continue; // dropped: every rotated flash below becomes a region
      }
      out.push(s);
      continue;
    }
    const g = s.match(/^G0?([123])\*$/);
    if (g) modo = `G0${g[1]}`;
    const sel = s.match(/^(?:G54)?D(\d+)\*$/);
    if (sel && Number(sel[1]) >= 10) {
      ap = Number(sel[1]);
      out.push(s);
      continue;
    }
    const c = s.match(/^(G0?[123])?(?:X(-?\d+))?(?:Y(-?\d+))?((?:I-?\d+)?(?:J-?\d+)?)D0?([123])\*$/);
    if (!c) {
      out.push(s);
      continue;
    }
    if (c[1]) modo = `G0${c[1].slice(-1)}`;
    const nx = c[2] !== undefined ? Number(c[2]) / scala : x;
    const ny = c[3] !== undefined ? Number(c[3]) / scala : y;
    const op = c[5];
    const ruotata = Math.abs(((rot % 360) + 360) % 360) > 1e-9;
    const apertura = ap !== null ? aperture.get(ap) : undefined;
    if (ruotata && op === "1" && apertura && apertura.tipo !== "C") return null; // a rotated rectangle drawn as a stroke
    if (ruotata && op === "3" && apertura && apertura.tipo !== "C") {
      const forma = contorno(apertura);
      if (!forma) return null;
      const t = (rot * Math.PI) / 180;
      const pts = forma.map(([px, py]) => [nx + px * Math.cos(t) - py * Math.sin(t), ny + px * Math.sin(t) + py * Math.cos(t)] as Punto);
      out.push("G36*", "G01*", `X${fmt(pts[0][0])}Y${fmt(pts[0][1])}D02*`);
      for (const q of [...pts.slice(1), pts[0]]) out.push(`X${fmt(q[0])}Y${fmt(q[1])}D01*`);
      out.push("G37*");
      if (modo !== "G01") out.push(`${modo}*`);
      // the plotter now sits on the last vertex, the original stream on the flash point
      x = nx;
      y = ny;
      esplicito = true;
      regioni++;
      continue;
    }
    if (esplicito && (c[2] === undefined || c[3] === undefined)) {
      out.push(`${c[1] ?? ""}X${fmt(nx)}Y${fmt(ny)}${c[4]}D0${op}*`);
    } else out.push(s);
    esplicito = false;
    x = nx;
    y = ny;
  }
  return { testo: out.join("\n") + "\n", regioni };
}

export function senzaRotazioneDiCarico<T extends Record<string, unknown>>(
  layers: T,
): { layers: T; regioni: number; nonConvertiti: string[] } {
  const out: Record<string, unknown> = {};
  let regioni = 0;
  const nonConvertiti: string[] = [];
  for (const [nome, contenuto] of Object.entries(layers)) {
    if (typeof contenuto !== "string") {
      out[nome] = contenuto;
      continue;
    }
    const r = convertiStrato(contenuto);
    if (!r) {
      out[nome] = contenuto;
      nonConvertiti.push(nome);
      continue;
    }
    out[nome] = r.testo;
    regioni += r.regioni;
  }
  return { layers: out as T, regioni, nonConvertiti };
}
