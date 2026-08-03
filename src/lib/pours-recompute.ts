import {
  convertCircuitJsonToInputProblem,
  CopperPourPipelineSolver,
  initializeManifoldGeometry,
} from "@tscircuit/copper-pour-solver";

import { planeServedPorts, readPours } from "./pours";

/**
 * THE PLANES, POURED AGAIN ONCE ALL THE COPPER IS ON THE BOARD.
 *
 * tscircuit computes a pour while it builds the board, and it carves it around
 * everything it can see: pads, vias, its own traces, cutouts. The copper of an
 * IMPORTED board is not among those. It arrives after, as manual edits, because
 * that is the whole point of manual edits — the agent rewrites main.tsx every
 * turn and the copper a person drew must survive that.
 *
 * So the pour was computed against a board with no traces on it, and it poured
 * over them. Measured on BAT_BS: the ground plane of the top face had 67
 * openings while 475 traces of other nets ran underneath it. On the screen it
 * reads as "the pour has eaten the traces", which is exactly what it was doing,
 * and in the gerbers it is ground shorted to every signal.
 *
 * The fix is not to move the copper earlier — it belongs where it is — but to
 * pour again at the end, with the same solver tscircuit uses, on a board that
 * now has everything. One extra second per plane, and the plane is the shape it
 * would have had if it had been poured last, which is how a real CAD does it:
 * the pour is always the last thing computed.
 */

interface El {
  type: string;
  [key: string]: unknown;
}

interface Anello {
  vertices: Array<{ x: number; y: number }>;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

export interface EsitoRicolata {
  circuitJson: El[];
  /** how many pours were recomputed, and what it cost them */
  ricolate: number;
  areaPrimaMm2: number;
  areaDopoMm2: number;
  /** rotated pads handed to the solver by hand, because it cannot read them */
  padRuotatiAggiunti: number;
}

const area = (v: Array<{ x: number; y: number }>): number => {
  let s = 0;
  for (let i = 0; i < v.length; i++) {
    const a = v[i];
    const b = v[(i + 1) % v.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s / 2);
};

/**
 * THE PADS THE SOLVER CANNOT READ.
 *
 * Its converter knows four shapes — rect, circle, pill, rotated_pill — and this
 * board has ninety pads that are `rotated_rect`: every component the designer
 * turned, which on a real board is most of them. They are not obstacles for the
 * pour, they are NOTHING: the plane flows straight over the pins of a
 * microcontroller sitting at 45 degrees, and what you see on screen is copper
 * touching the pads.
 *
 * The solver does understand a POLYGON obstacle, so the rotated rectangle is
 * handed to it as its four corners. Only for pads of ANOTHER net: a pad on the
 * pour's own net has to touch the plane, which is the point of a plane.
 *
 * One catch, read in its source: a polygon obstacle is subtracted with margin
 * ZERO unless its key says hole or cutout (dist/index.js:440). Copper flush
 * against a pad is still a defect, so the rectangle handed over is the pad
 * already grown by the project's clearance.
 */
function padRuotati(
  circuitJson: El[],
  faccia: string,
  netDellaColata: string,
  margineMm: number,
  /**
   * Which pads already live on a plane net, by the same reckoning the house
   * rules use: it walks the traces, so a ground pad that no trace names
   * directly still comes out as ground. Reading only `connected_source_net_ids`
   * left thirteen pads netless, and carving the plane away from its own pins is
   * how a return path goes missing.
   */
  serviti: Map<string, string>,
): Array<Record<string, unknown>> {
  const fuori: Array<Record<string, unknown>> = [];
  for (const el of circuitJson) {
    if (el.type !== "pcb_smtpad" || String(el.layer ?? "") !== faccia) continue;
    if (el.shape !== "rotated_rect") continue;
    const x = num(el.x);
    const y = num(el.y);
    const w = num(el.width);
    const h = num(el.height);
    if (x === null || y === null || w === null || h === null) continue;
    // its own net: the plane must reach it, not avoid it
    if (serviti.get(String(el.pcb_port_id ?? "")) === netDellaColata) continue;
    const rad = ((num(el.ccw_rotation) ?? 0) * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const a = w / 2 + margineMm;
    const b = h / 2 + margineMm;
    const points = [
      [-a, -b],
      [a, -b],
      [a, b],
      [-a, b],
    ].map(([dx, dy]) => ({ x: x + dx * cos - dy * sin, y: y + dx * sin + dy * cos }));
    fuori.push({
      shape: "polygon",
      padId: String(el.pcb_smtpad_id ?? ""),
      layer: faccia,
      /*
       * A key of its own: the solver subtracts whatever does not carry the
       * pour's key, and these must be subtracted.
       */
      connectivityKey: `unconnected:${String(el.pcb_smtpad_id ?? "")}`,
      points,
    });
  }
  return fuori;
}

const areaNetta = (forma: { outer_ring?: Anello; inner_rings?: Anello[] }): number =>
  area(forma.outer_ring?.vertices ?? []) -
  (forma.inner_rings ?? []).reduce((s, r) => s + area(r.vertices ?? []), 0);

export async function ricolaPiani({
  circuitJson,
  clearanceMm,
  bordoMm,
}: {
  circuitJson: El[];
  /** the project's minimum spacing: what the pour keeps from everything else */
  clearanceMm: number;
  /**
   * And from the edge of the board, which is a different number and a stricter
   * one: copper that reaches the rout leaves burrs and shorts on the panel.
   * Trusting the outline for it was wrong — measured 0.207mm against a rule that
   * asks for 0.3.
   */
  bordoMm: number;
}): Promise<EsitoRicolata> {
  const pours = circuitJson.filter((el) => el.type === "pcb_copper_pour");
  if (pours.length === 0) {
    return { circuitJson, ricolate: 0, areaPrimaMm2: 0, areaDopoMm2: 0, padRuotatiAggiunti: 0 };
  }

  await initializeManifoldGeometry();
  const serviti = planeServedPorts(circuitJson, readPours(circuitJson));

  const nuovi: El[] = [];
  let areaPrima = 0;
  let areaDopo = 0;
  let ricolate = 0;
  let aggiunti = 0;

  for (const pour of pours) {
    const brep = pour.brep_shape as { outer_ring?: Anello; inner_rings?: Anello[] } | undefined;
    const contorno = brep?.outer_ring?.vertices ?? [];
    if (contorno.length < 3) {
      nuovi.push(pour);
      continue;
    }
    areaPrima += areaNetta(brep ?? {});

    /*
     * The outline is the one this pour already has: the shape the file drew,
     * board edge already accounted for. What is recomputed is what it has to
     * keep away from — and this time the imported copper is in the room.
     */
    const problema = convertCircuitJsonToInputProblem(
      circuitJson as never,
      {
        layer: String(pour.layer) as never,
        source_net_id: String(pour.source_net_id ?? ""),
        pad_margin: clearanceMm,
        trace_margin: clearanceMm,
        board_edge_margin: bordoMm,
        cutout_margin: clearanceMm,
        outline: contorno,
      } as never,
    );

    /* the rotated pads the converter dropped on the floor */
    const mancanti = padRuotati(
      circuitJson,
      String(pour.layer),
      String(pour.source_net_id ?? ""),
      clearanceMm,
      serviti,
    );
    if (mancanti.length > 0) {
      const p = problema as unknown as { pads?: Array<Record<string, unknown>> };
      p.pads = [...(p.pads ?? []), ...mancanti];
      aggiunti += mancanti.length;
    }

    let forme: Array<{ outer_ring?: Anello; inner_rings?: Anello[] }> = [];
    try {
      forme = new CopperPourPipelineSolver(problema).getOutput().brep_shapes ?? [];
    } catch {
      // a plane that will not solve keeps the shape it had: better the old one
      // than none, and the numbers below say it did not change
      nuovi.push(pour);
      continue;
    }
    if (forme.length === 0) {
      nuovi.push(pour);
      continue;
    }

    ricolate++;
    forme.forEach((forma, i) => {
      areaDopo += areaNetta(forma);
      nuovi.push({
        ...pour,
        pcb_copper_pour_id: `${String(pour.pcb_copper_pour_id)}_r${i}`,
        brep_shape: forma,
      });
    });
  }

  return {
    circuitJson: [...circuitJson.filter((el) => el.type !== "pcb_copper_pour"), ...nuovi],
    ricolate,
    areaPrimaMm2: Number(areaPrima.toFixed(1)),
    areaDopoMm2: Number(areaDopo.toFixed(1)),
    padRuotatiAggiunti: aggiunti,
  };
}

export { num };
