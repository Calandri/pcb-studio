/**
 * Regole di casa applicate alla rotta finale, qualunque router l'abbia
 * prodotta. Stanno in un modulo a parte perche' sono trasformazioni pure sul
 * Circuit JSON: si possono verificare senza far girare una compilazione.
 */
import { DEFAULT_DESIGN_RULES } from "./design-rules";
import { escapeOffAxisDeg } from "./drc";

export interface CircuitElement {
  type: string;
  [key: string]: unknown;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * Copia del circuito in cui ogni pista esce dal pad DRITTA: dove il router ha
 * attaccato al pad un segmento diagonale, si inserisce un tratto breve
 * perpendicolare al bordo del pad e solo dopo si riparte verso il punto
 * successivo. Regola di casa (Niccolo', 2026-07-26): un diagonale attaccato al
 * pad riduce il rame utile del giunto e lascia angoli acuti all'incisione.
 *
 * Come per le piste sottili, il risultato gareggia con l'originale invece di
 * sostituirlo: spostare rame puo' avvicinare net diverse, e a decidere e' il DRC.
 */
export function straightenPinEscapes(circuitJson: CircuitElement[]): CircuitElement[] {
  const pads = circuitJson.filter((el) => el.type === "pcb_smtpad");
  const padAt = (x: number, y: number): CircuitElement | null =>
    pads.find((el) => {
      const px = num(el.x);
      const py = num(el.y);
      if (px === null || py === null) return false;
      const w = (num(el.width) ?? (num(el.radius) ?? 0) * 2) / 2;
      const h = (num(el.height) ?? (num(el.radius) ?? 0) * 2) / 2;
      return Math.abs(px - x) <= w + 1e-6 && Math.abs(py - y) <= h + 1e-6;
    }) ?? null;

  // stesso criterio angolare del controllo: si tocca solo cio' che e' davvero
  // storto, e lo si porta in asse qualunque sia la lunghezza del tratto
  const MAX_DEG = 12;
  const MAX_STUB = 0.3;

  return circuitJson.map((el) => {
    if (el.type !== "pcb_trace") return el;
    const route = (el.route as Array<Record<string, unknown>> | undefined) ?? [];
    if (route.length < 2) return el;

    const next = [...route];
    let changed = false;

    // si lavora sui due capi: e' li' che la pista tocca un pad
    for (const end of ["start", "end"] as const) {
      const i = end === "start" ? 0 : next.length - 1;
      const j = end === "start" ? 1 : next.length - 2;
      const from = next[i];
      const to = next[j];
      const x = num(from.x);
      const y = num(from.y);
      const tx = num(to.x);
      const ty = num(to.y);
      if (x === null || y === null || tx === null || ty === null) continue;

      const dx = tx - x;
      const dy = ty - y;
      if (Math.hypot(dx, dy) < 1e-6) continue;
      if (escapeOffAxisDeg(dx, dy) <= MAX_DEG) continue; // gia' in asse

      const pad = padAt(x, y);
      if (!pad) continue;

      // perpendicolare al bordo da cui si esce: sul lato lungo del pad
      const pw = num(pad.width) ?? 0;
      const ph = num(pad.height) ?? 0;
      const horizontal = pw > ph ? true : ph > pw ? false : Math.abs(dx) >= Math.abs(dy);
      // il tratto dritto vale al massimo 0,3mm e comunque meno di meta' della
      // distanza dal punto successivo, per non superarlo
      const span = Math.abs(horizontal ? dx : dy);
      const stub = Math.min(MAX_STUB, Math.max(span * 0.4, 0.05));

      const point = {
        ...from,
        x: horizontal ? x + Math.sign(dx) * stub : x,
        y: horizontal ? y : y + Math.sign(dy) * stub,
      };
      next.splice(end === "start" ? 1 : next.length - 1, 0, point);
      changed = true;
    }

    return changed ? { ...el, route: next } : el;
  });
}

/**
 * Copia del circuito con ogni segmento di pista sotto la larghezza minima
 * portato al minimo di fabbrica. Il solver a volte assottiglia un tratto per
 * passare in mezzo a due ostacoli: il tratto sottile non e' producibile, ma
 * allargarlo puo' violare una distanza. Per questo il risultato viene messo in
 * gara con l'originale invece che sostituirlo.
 */
export function widenThinTraces(circuitJson: CircuitElement[]): CircuitElement[] {
  const min = DEFAULT_DESIGN_RULES.minTraceWidthMm;
  return circuitJson.map((el) => {
    if (el.type !== "pcb_trace") return el;
    const route = el.route as Array<Record<string, unknown>> | undefined;
    if (!route?.some((p) => typeof p.width === "number" && p.width < min)) return el;
    return {
      ...el,
      route: route.map((p) =>
        typeof p.width === "number" && p.width < min ? { ...p, width: min } : p,
      ),
    };
  });
}

