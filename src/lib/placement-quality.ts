import { DEFAULT_DESIGN_RULES, type DesignRules } from "./design-rules";

/**
 * Quality of the PLACEMENT, i.e. of where the parts sit.
 *
 * It does not duplicate the DRC or the electrical checks: those look at the
 * already-routed copper and the distances between traces. Here we look at
 * something that comes first, and it is the one that ruins everything — if
 * two components touch, the router does not even start, and the board ends up
 * "traceless" through no fault of the routing. Measured on BAT: 62 placement
 * problems, 85 connections reported as missing, and the autorouter never
 * started.
 *
 * Every finding carries the NAMES of the two components and the coordinates:
 * "fix the placement" is not an instruction, "R_M2CLK sits on top of U4" is.
 */

export type PlacementRule =
  | "overlap"
  | "too_close"
  | "off_board"
  | "connector_inside"
  | "far_from_connections";

export interface PlacementIssue {
  rule: PlacementRule;
  severity: "warn" | "fail";
  message: string;
  /** components involved, so they can be highlighted on the board */
  components: string[];
  x?: number;
  y?: number;
}

export interface PlacementQuality {
  components: number;
  /** pairs that touch: until this is zero the router does not start */
  overlaps: number;
  issues: PlacementIssue[];
  /** true when nothing prevents routing */
  routable: boolean;
}

export function emptyPlacementQuality(): PlacementQuality {
  return { components: 0, overlaps: 0, issues: [], routable: true };
}

type El = Record<string, unknown>;
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const round2 = (v: number): number => Math.round(v * 100) / 100;

interface Box {
  name: string;
  ftype: string | null;
  x: number;
  y: number;
  hw: number;
  hh: number;
  /**
   * Which face it lives on. Two parts on opposite faces cannot touch: there is
   * a millimetre and a half of fibreglass between them. Without this, the check
   * reported the microcontroller as overlapping by 8,18 mm with a resistor
   * mounted UNDERNEATH it — nine invented overlaps out of nine on bat-bs, plus
   * ten short distances that do not exist, and the real problems drowned in
   * the noise.
   */
  layer: string;
  /**
   * The COPPER: one rectangle per pad, with its face. The clearance rule talks
   * about copper, not about keep-out zones — and the courtyard of an 0603
   * already carries 0,7 mm of margin per side. Measuring the clearance between
   * courtyards reported eleven "too close" on bat-bs-blocchi where the copper
   * had 1,4 mm of air: noise that buried the two real overlaps.
   */
  pads: Array<{ minX: number; maxX: number; minY: number; maxY: number; layer: string }>;
  ports: string[];
}

/**
 * Real footprint of a component: the LARGER of courtyard and pad bounding
 * box. They are two different things and tscircuit checks them separately;
 * looking at only one lets placements through that later fail (on crystals
 * the pads extend beyond the declared courtyard).
 */
function boxesOf(circuitJson: unknown[]): Box[] {
  const els = circuitJson as El[];
  const by = (t: string) => els.filter((e) => e.type === t);
  const sourceName = new Map<string, { name: string; ftype: string | null }>();
  for (const c of by("source_component")) {
    const id = str(c.source_component_id);
    if (id) sourceName.set(id, { name: str(c.name) ?? id, ftype: str(c.ftype) });
  }
  const portsOfComponent = new Map<string, string[]>();
  for (const p of by("pcb_port")) {
    const cid = str(p.pcb_component_id);
    const sid = str(p.source_port_id);
    if (!cid || !sid) continue;
    portsOfComponent.set(cid, [...(portsOfComponent.get(cid) ?? []), sid]);
  }

  const span = (p: El, axis: "x" | "y"): number[] => {
    const pts = p.points;
    if (Array.isArray(pts) && pts.length) {
      const v = (pts as Array<Record<string, unknown>>)
        .map((q) => num(q[axis]))
        .filter(Number.isFinite);
      return v.length ? [Math.min(...v), Math.max(...v)] : [];
    }
    const c = p[axis];
    if (typeof c !== "number" || !Number.isFinite(c)) return [];
    const size =
      axis === "x"
        ? num(p.width ?? p.outer_width ?? p.hole_width ?? 0.5)
        : num(p.height ?? p.outer_height ?? p.hole_height ?? 0.5);
    return [c - size / 2, c + size / 2];
  };

  const out: Box[] = [];
  for (const comp of by("pcb_component")) {
    const cid = str(comp.pcb_component_id);
    if (!cid) continue;
    const src = sourceName.get(String(comp.source_component_id));
    const pads = els.filter(
      (p) =>
        (p.type === "pcb_smtpad" || p.type === "pcb_plated_hole") &&
        p.pcb_component_id === cid,
    );
    const xs = pads.flatMap((p) => span(p, "x"));
    const ys = pads.flatMap((p) => span(p, "y"));

    const court = els.find(
      (e) =>
        (e.type === "pcb_courtyard_rect" || e.type === "pcb_courtyard_outline") &&
        e.pcb_component_id === cid,
    );
    if (court?.type === "pcb_courtyard_rect") {
      const c = court.center as { x?: number; y?: number } | undefined;
      xs.push(num(c?.x) - num(court.width) / 2, num(c?.x) + num(court.width) / 2);
      ys.push(num(c?.y) - num(court.height) / 2, num(c?.y) + num(court.height) / 2);
    } else if (court) {
      for (const p of (court.outline ?? []) as Array<Record<string, unknown>>) {
        xs.push(num(p.x));
        ys.push(num(p.y));
      }
    }
    if (xs.length === 0 || ys.length === 0) continue;
    /*
     * The face: the one declared by the component, otherwise the prevailing one
     * among its pads (a through-hole part has copper on both, and then it
     * bothers everybody — which is right).
     */
    const facce = new Set(pads.map((p) => str(p.layer) ?? "").filter(Boolean));
    const layer =
      str(comp.layer) ?? (facce.size === 1 ? [...facce][0] : "both");
    const l = Math.min(...xs), r = Math.max(...xs);
    const b = Math.min(...ys), t = Math.max(...ys);
    out.push({
      name: src?.name ?? cid,
      ftype: src?.ftype ?? null,
      x: (l + r) / 2,
      y: (b + t) / 2,
      hw: (r - l) / 2,
      hh: (t - b) / 2,
      layer: pads.some((p) => p.type === "pcb_plated_hole") ? "both" : layer,
      pads: pads
        .map((p) => {
          const sx = span(p, "x");
          const sy = span(p, "y");
          if (sx.length !== 2 || sy.length !== 2) return null;
          return {
            minX: sx[0],
            maxX: sx[1],
            minY: sy[0],
            maxY: sy[1],
            layer: p.type === "pcb_plated_hole" ? "both" : (str(p.layer) ?? "top"),
          };
        })
        .filter((v): v is NonNullable<typeof v> => v !== null),
      ports: portsOfComponent.get(cid) ?? [],
    });
  }
  return out;
}

/**
 * Shortest distance between the copper of two components, pad against pad and
 * only on the same face. null when there is nothing to compare.
 */
function padGap(a: Box, b: Box): number | null {
  let best: number | null = null;
  for (const pa of a.pads) {
    for (const pb of b.pads) {
      if (pa.layer !== "both" && pb.layer !== "both" && pa.layer !== pb.layer) continue;
      const dx = Math.max(pa.minX - pb.maxX, pb.minX - pa.maxX);
      const dy = Math.max(pa.minY - pb.maxY, pb.minY - pa.maxY);
      // both negative: the pads overlap, and then the distance is negative
      const d = dx > 0 && dy > 0 ? Math.hypot(dx, dy) : Math.max(dx, dy);
      if (best === null || d < best) best = d;
    }
  }
  return best;
}

const isConnector = (b: Box): boolean =>
  b.ftype === "simple_pin_header" ||
  b.ftype === "simple_connector" ||
  /^(J|CN|P)\d/i.test(b.name);

export function analyzePlacement(
  circuitJson: unknown[] | null,
  rules: DesignRules = DEFAULT_DESIGN_RULES,
): PlacementQuality {
  if (!circuitJson?.length) return emptyPlacementQuality();
  const els = circuitJson as El[];
  const boxes = boxesOf(circuitJson);
  if (boxes.length === 0) return emptyPlacementQuality();

  const board = els.find((e) => e.type === "pcb_board");
  const bw = num(board?.width), bh = num(board?.height);
  const bc = board?.center as { x?: number; y?: number } | undefined;
  const bx = num(bc?.x), by = num(bc?.y);

  const issues: PlacementIssue[] = [];
  const clearance = rules.minClearanceMm;
  let overlaps = 0;

  // 1) who touches whom. The defect that blocks everything: the autorouter won't start.
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      // opposite faces: they cannot touch, there is the board in between
      if (a.layer !== "both" && b.layer !== "both" && a.layer !== b.layer) continue;
      const gapX = Math.abs(a.x - b.x) - (a.hw + b.hw);
      const gapY = Math.abs(a.y - b.y) - (a.hh + b.hh);
      const gap = Math.max(gapX, gapY);
      // far apart: neither the keep-out zones nor the copper can be a problem
      if (gap >= clearance) continue;
      /*
       * Two things, measured on two different geometries.
       *
       * The keep-out zones OVERLAPPING is what stops the router: it refuses to
       * start and the board comes out with no copper. That is a failure.
       *
       * The clearance, instead, is about COPPER: it is measured pad to pad. Two
       * courtyards a hundredth of a millimetre apart are fine as long as the
       * copper keeps its distance, and normally it keeps a lot of it, because
       * the courtyard already includes the margin.
       */
      const sovrapposti = gap < 0;
      const rameGap = padGap(a, b);
      const rameStretto = rameGap !== null && rameGap < clearance;
      if (!sovrapposti && !rameStretto) continue;
      overlaps++;
      if (issues.length < 60) {
        /*
         * Two overlapping keep-out zones are a fault ONLY if the copper is also
         * too close. Otherwise it is a deliberate choice, and often the right
         * one: a decoupling capacitor hugging the pin it feeds has its courtyard
         * inside the chip's — 0,48 mm on the microphones of this board — while
         * the copper keeps 0,36 mm, almost three times the minimum. Calling that
         * a failure means saying no to a design that is correct, and keeping the
         * production gauge red forever. It is worth SAYING, because the assembler
         * has to see it, so it stays as a warning with its numbers.
         */
        issues.push({
          rule: sovrapposti ? "overlap" : "too_close",
          severity: rameStretto ? "fail" : "warn",
          message: sovrapposti
            ? rameStretto
              ? `${a.name} e ${b.name} si sovrappongono di ${round2(-gap)}mm e il rame dista ${round2(rameGap ?? 0)}mm, sotto il minimo di ${clearance}mm`
              : `le zone di rispetto di ${a.name} e ${b.name} si sovrappongono di ${round2(-gap)}mm, ma il rame tiene ${round2(rameGap ?? 0)}mm: verifica che il montaggio sia possibile`
            : `il rame di ${a.name} e ${b.name} dista ${round2(rameGap ?? 0)}mm, sotto il minimo di ${clearance}mm`,
          components: [a.name, b.name],
          x: round2((a.x + b.x) / 2),
          y: round2((a.y + b.y) / 2),
        });
      }
    }
  }

  // 2) copper outside the board outline
  if (bw > 0 && bh > 0) {
    const left = bx - bw / 2, right = bx + bw / 2;
    const bottom = by - bh / 2, top = by + bh / 2;
    for (const b of boxes) {
      const out =
        Math.max(left - (b.x - b.hw), (b.x + b.hw) - right, bottom - (b.y - b.hh), (b.y + b.hh) - top);
      if (out <= 0.01 || issues.length >= 80) continue;
      /*
       * An edge connector MUST stick out: that is where the cable plugs in, or
       * in the case of a plug it is the board itself that inserts somewhere.
       * Flagging it as an error would mean flagging the correct design. For
       * everything else, sticking out means copper cut away by the mill.
       *
       * The allowOffBoard flag does not reach the Circuit JSON (verified: it
       * is not on the source_component), so the distinction is made by
       * component type, which is the information that survives.
       */
      const connector = isConnector(b);
      issues.push({
        rule: "off_board",
        severity: connector ? "warn" : "fail",
        message: connector
          ? `${b.name} sporge di ${round2(out)}mm dal bordo: normale per un connettore, verifica che sia voluto`
          : `${b.name} sporge di ${round2(out)}mm oltre il bordo: quel rame viene tagliato via`,
        components: [b.name],
        x: round2(b.x),
        y: round2(b.y),
      });
    }

    // 3) connectors far from the edge: a cable must be able to plug in
    for (const b of boxes.filter(isConnector)) {
      const toEdge = Math.min(
        b.x - b.hw - left,
        right - (b.x + b.hw),
        b.y - b.hh - bottom,
        top - (b.y + b.hh),
      );
      if (toEdge > 3 && issues.length < 90) {
        issues.push({
          rule: "connector_inside",
          severity: "warn",
          message: `il connettore ${b.name} e' a ${round2(toEdge)}mm dal bordo piu' vicino: da li' non ci si infila un cavo`,
          components: [b.name],
          x: round2(b.x),
          y: round2(b.y),
        });
      }
    }
  }

  /*
   * 4) parts far from what they are connected to. Not an error, a hint: a
   * trace twice as long as the board means the part is on the wrong side.
   * Measured on the longest connection, not the sum, because a ground net
   * touching thirty parts would skew everything.
   */
  const boxByPort = new Map<string, Box>();
  for (const b of boxes) for (const p of b.ports) boxByPort.set(p, b);
  const diagonal = Math.hypot(bw, bh) || 1;
  const worstLink = new Map<string, { other: string; mm: number }>();
  for (const t of els.filter((e) => e.type === "source_trace")) {
    const ports = (Array.isArray(t.connected_source_port_ids)
      ? t.connected_source_port_ids
      : []) as unknown[];
    const parts = [...new Set(ports.map((p) => (typeof p === "string" ? boxByPort.get(p) : undefined)))]
      .filter((b): b is Box => Boolean(b));
    if (parts.length !== 2) continue; // multi-node nets say nothing
    const [a, b] = parts;
    const mm = Math.hypot(a.x - b.x, a.y - b.y);
    for (const [self, other] of [[a, b], [b, a]] as const) {
      const cur = worstLink.get(self.name);
      if (!cur || mm > cur.mm) worstLink.set(self.name, { other: other.name, mm });
    }
  }
  for (const [name, link] of worstLink) {
    if (link.mm < diagonal * 0.55) continue;
    if (issues.length >= 100) break;
    issues.push({
      rule: "far_from_connections",
      severity: "warn",
      message: `${name} e' a ${round2(link.mm)}mm da ${link.other}, con cui e' collegato: piu' di meta' diagonale della scheda`,
      components: [name, link.other],
    });
  }

  const order: Record<PlacementIssue["severity"], number> = { fail: 0, warn: 1 };
  issues.sort((a, b) => order[a.severity] - order[b.severity]);

  return {
    components: boxes.length,
    overlaps,
    issues,
    routable: !issues.some((i) => i.severity === "fail"),
  };
}
