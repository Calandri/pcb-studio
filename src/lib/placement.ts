import { DEFAULT_DESIGN_RULES, type DesignRules } from "./design-rules";

/**
 * HOW A BOARD GETS ARRANGED (Niccolo', 2026-07-29). The model, in three lines:
 *
 *   1. the LLM places, LOOKING at the board: it is an OPTICAL job;
 *   2. then the parts are drawn together by a MAGNET toward the pins of their
 *      own net, not toward each other's bodies;
 *   3. and it all happens BY BLOCKS, one logical block at a time.
 *
 * Why this way, and not with a formula. Deciding where a part goes is a
 * judgement: the microphone goes on the edge because it has to hear, the
 * crystal glued to the microcontroller because its two traces must be the
 * shortest on the board, the regulator away from the delicate signals. A
 * numeric solver knows none of this — it knows distances. Measured twice: the
 * geometric floorplan (vertical columns) cost 30% more copper without removing
 * a single overlap, and the model's own section plan, beautiful to read, cost
 * +76% because rectangles are rigid. So the arrangement is decided by whoever
 * understands what the parts DO, and the code does the two things code does
 * well: it closes the gaps and it verifies.
 *
 * The magnet pulls toward the PINS OF THE SAME NET, and this is the part that
 * matters. Attracting bodies toward bodies shortens the distance between
 * centres, which is not what gets routed: what gets routed is pad to pad. A
 * capacitor whose centre is 2mm from the chip's centre but whose pin looks the
 * other way has a long trace anyway. Pulling pin toward pin is pulling on the
 * copper that will actually be laid.
 *
 * By blocks because a block is a piece of circuit that does one thing, and
 * scattering it means undoing it: the biggest one goes first (it decides the
 * shape of the board), then the ones most connected to what is already placed.
 * Whatever a person has placed by hand is a constraint, never a suggestion.
 *
 * Placement: first you tidy the parts, then you pull the wires.
 *
 * A clearance error between one component's pad and another's is not a
 * routing problem: no trace, however well routed, can fix it. As long as two
 * parts are too close, that violation stays whatever the autorouter does,
 * and the routing starts out already losing — pushing copper into an alley
 * that does not exist.
 *
 * So placement comes first, and it works in rounds: it measures where parts
 * touch, moves them apart just enough, pulls them toward the parts they are
 * connected to (short copper = fewer vias and fewer rounds), and keeps the
 * result only if the score improves. When violations reach zero the squeeze
 * begins: each part tries to get closer to the center, and the step is
 * accepted only if it does not reopen a violation. That is how space is
 * minimized without breaking anything.
 *
 * Everything happens on the already compiled geometry (Circuit JSON):
 * compiling costs a minute and a half, and a loop that recompiles every
 * round would never finish. We compile once to get the pads, solve in
 * memory, and inject the final positions into the code just once.
 */

export interface PlacementViolation {
  a: string;
  b: string;
  /** distance measured between the two sides, in mm */
  gapMm: number;
  x: number;
  y: number;
}

export interface PlacementReport {
  rounds: number;
  moved: number;
  /** how many steps the magnet toward the pins took, when it ran */
  magnetSteps?: number;
  before: PlacementScore;
  after: PlacementScore;
  stoppedBecause: "pulito" | "non migliora piu'" | "giri esauriti" | "tempo scaduto";
  /** what is still out of spec, if anything remains */
  remaining: PlacementViolation[];
  /** parts kept still, and why */
  locked: string[];
  /** how many arrangements were tried */
  attempts: number;
  /** which one won */
  picked: number;
  /** each one's score: shows whether the tries were needed or not */
  candidates: Array<{
    attempt: number;
    violations: number;
    netLengthMm: number;
    areaMm2: number;
    densityPct: number;
  }>;
  /** how much of the occupied surface is covered by components, in % */
  densityPct: number;
  /** how many zones were improved by the local refinement */
  zonesImproved: number;
  /** capacitors brought onto the pin they supply */
  decouplingPlaced: number;
  /** parts aligned in a row or column with their neighbours */
  aligned: number;
  /** parts brought onto the regular grid */
  snapped: number;
  /** recognized logical blocks and how wide they are, in mm */
  blockSpread: Array<{ block: string; parts: number; spreadMm: number }>;
  /** how many blocks were placed in order, largest first */
  blocksPlaced: number;
}

export interface PlacementScore {
  /** clearances between different parts below the minimum */
  violations: number;
  /** area occupied by the pads, in mm² */
  areaMm2: number;
  /** sum of the distances between connected parts, in mm */
  netLengthMm: number;
  /**
   * How crowded the board is where it should not be: mm² of component
   * exceeding the density each bin can sustain.
   *
   * Without this term the only thing the solver minimizes is wire length —
   * and the absolute minimum of that sum is all the parts piled up in one
   * point. Overlaps prevent that, but only at the last millimeter: the
   * result is a compact clump with the rest of the board empty. It is the
   * term modern placers call density penalty, and it is what distinguishes
   * an arrangement from a tidy pile.
   */
  crowdingMm2: number;
}

export interface Placement {
  /** the component's name, as written in the code */
  name: string;
  center: { x: number; y: number };
  /** how much it moved from where it was */
  deltaMm: number;
  /**
   * Absolute rotation to write, when the magnet turned the part. Absent means
   * "leave it as it is": whoever writes it must not touch what it does not say.
   */
  rotation?: number;
}

export interface PlaceOptions {
  rules?: DesignRules;
  /** parts not to touch (placed by hand by the user) */
  locked?: Iterable<string>;
  maxRounds?: number;
  budgetMs?: number;
  /** brings parts closer after violations are zeroed (default true) */
  compact?: boolean;
  /**
   * How many different arrangements to try before choosing (default 10).
   * Each try starts from a different shuffle and lands in a different
   * minimum: they are all measured and the best one is kept. Raising it
   * costs linearly — one try is tens of milliseconds — and on hard boards
   * it pays off.
   */
  attempts?: number;
  /** shuffle seed: same seed, same board */
  seed?: number;
  /** refinement rounds per zone on the winning arrangement (default 2) */
  zoneRounds?: number;
  /**
   * Pitch of the grid the parts align to (default 0.5mm). A regular grid
   * aligns on its own what the eye expects to be aligned: four capacitors
   * in a row must be in a row, not a tenth of a millimeter from each other.
   */
  gridMm?: number;
  /**
   * Attaches the decoupling capacitors to the power pin they serve (default
   * on). A faraway capacitor reached by a trace that wanders is a capacitor
   * that stabilizes nothing.
   */
  decouplingToPins?: boolean;
  /**
   * Which logical block each component belongs to (name -> block), read from
   * the sources' `schSectionName`. The parts of the same block stay together:
   * a block is a piece of circuit that does one thing — the microcontroller
   * with its capacitors, the regulator with its own, the amp with its
   * feedback — and scattering it across the board means undoing it.
   */
  blocks?: Map<string, string>;
  /**
   * Each component's tags (name -> "mcu, chip"), written on the schematic.
   * They are how placement knows WHAT a part is without guessing: a
   * regulator and a crystal have the same number of pins and are not placed
   * the same way.
   */
  tags?: Map<string, string>;
  /**
   * The zone plan: to each sector its board rectangle. It is decided by a
   * model that LOOKS at the drawing, because it is a coarse spatial judgment
   * ("the power supply where the current enters, the microphones far from
   * the noise") and not a millimeter problem. Without it, the numeric solver
   * heaps everything at the center: the total wire length is minimal right
   * there.
   */
  zones?: Map<string, { minX: number; maxX: number; minY: number; maxY: number }>;
  /**
   * The zone of every single COMPONENT, by name. It is what the floorplan
   * decided by the model produces (sezioni.ts): exact, no guessing.
   *
   * `zones` above assigns by sector and matches the section's name against the
   * component's tags — and a part tagged "alimentazione del microfono" ended up
   * in the power section instead of the microphone one. When this map is there,
   * it wins: someone has already decided, part by part.
   */
  zoneOfComponent?: Map<string, { minX: number; maxX: number; minY: number; maxY: number }>;
  /**
   * Keeps the arrangement it finds and only legalizes and compacts it.
   *
   * Needed when the positions were decided by someone who knows what the
   * parts do — the input capacitor before the LDO, the test pad where you
   * can reach it with the probe, the two channels mirrored so they do not
   * drift out of phase. A score cannot express those decisions, so they must
   * not be reopened: the code does the two things it is unbeatable at,
   * namely separating what touches and shortening distances, leaving the
   * order as it is.
   */
  keepArrangement?: boolean;
  /**
   * Pulls the parts toward the pins of their own net after the arrangement has
   * been decided (magnetToPins). It is the second step of the model: the LLM
   * places, the magnet closes the gaps. Off by default, because on a layout
   * nobody asked to compact it would be one more thing moving on its own.
   */
  magnetToPins?: boolean;
  /** nets the magnet ignores: ground is poured, pulling toward it drags everything to the middle */
  magnetSkipNets?: Iterable<string>;
  /**
   * How much crowding weighs against wire length. 0 turns it off. It is the
   * parameter that decides whether you get a spread-out arrangement or a
   * compact clump: the two pull in opposite directions and the right point
   * is in between.
   */
  crowdingWeight?: number;
  /**
   * Computes a zone plan (a slice of board per sector) before optimizing
   * distances. OFF by default, and not out of laziness: in its current form
   * — full-height vertical columns, one per sector — it costs 30% more
   * copper and does not remove violations (2125mm versus 1636 on bat-bs).
   * It is too rigid: it ignores that sectors have different shapes and
   * prevents a part from sitting next to a partner in another column. A plan
   * given from the outside (opts.zones), decided by whoever looks at the
   * drawing, is another matter and works much better.
   */
  floorplan?: boolean;
}

interface El {
  type: string;
  [key: string]: unknown;
}

interface Pad {
  /** offset from the component's center */
  dx: number;
  dy: number;
  /** half-width and half-height, already accounting for round shapes */
  hw: number;
  hh: number;
  layer: string;
  /**
   * Which net it belongs to. The magnet needs it: it pulls pin toward pin of
   * the same net, which is the copper that will really be laid — not toward
   * the other component's centre, which is not what gets routed.
   */
  net: string;
}

/**
 * A pad's escape room: the stretch of trace that leaves it straight plus the
 * via that takes it to the other side.
 *
 * Needed because "no violations" and "routable" are not the same thing. You
 * can put two components 0.2mm from each other and have a clean DRC: only,
 * nothing fits in between, and the autorouter is left holding the
 * connections. A pad without an escape via is a pad that will be open.
 *
 * So every pad is born with its escape footprint, and placement treats it as
 * real geometry: the corridors for the copper are booked in advance, not
 * hoped for afterwards.
 */
function escapeRoomMm(rules: DesignRules): number {
  const clearance = rules.targetClearanceMm ?? rules.minClearanceMm;
  // half a via (its center sits just outside the pad) plus the clearance that
  // via must keep from anyone else's copper
  return rules.minViaDiameterMm / 2 + clearance;
}

interface Item {
  id: string;
  name: string;
  x: number;
  y: number;
  /** starting position: needed to compute the displacement to inject */
  x0: number;
  y0: number;
  /*
   * The starting ORIGIN, which is not the starting centre when the footprint
   * is off-centre (0,28 mm on the MEMS microphones, 0,26 mm on the USB
   * connector). Everything here reasons about centres, because that is what
   * pads and courtyards are relative to; but what gets injected is pcbX/pcbY,
   * i.e. an ORIGIN. Emitting the centre as if it were the origin moved those
   * parts by their offset at every single run — a part nobody had touched
   * drifted a quarter of a millimetre per compile, in the same direction,
   * forever.
   */
  ox0: number;
  oy0: number;
  /**
   * Rotation IMPOSED by the magnet, in degrees counterclockwise (0/90/180/270),
   * on top of the one the part already had. A magnet does not only pull, it
   * ORIENTS: it turns the piece until its poles look at the ones attracting it.
   * Here the poles are the pins — turning a capacitor so that its VDD pin faces
   * the chip's VDD pin shortens the copper far more than moving it closer while
   * it looks the other way.
   */
  rot: number;
  /** the rotation it was compiled with: the emitted one is r0 + rot */
  r0: number;
  pads: Pad[];
  /*
   * Footprint relative to the center, one value per side. Keeping just one
   * per axis (the famous "half-footprint") means treating every footprint as
   * if it were symmetric: a part with the pads all on one side becomes twice
   * as wide as it really is, and the solver spends its time separating parts
   * that do not touch while the ones that really do stay where they are.
   */
  left: number;
  right: number;
  bottom: number;
  top: number;
  /*
   * The BARE keep-out zone, without the escape room: it is the one the
   * placement check compares. Kept separate from the footprint because two
   * components can sit as tight as they like for the DRC, but if their
   * courtyards touch, routing is skipped wholesale.
   */
  cLeft: number;
  cRight: number;
  cBottom: number;
  cTop: number;
  locked: boolean;
  /** prevailing layer: two parts on opposite sides do not bother each other */
  layer: string;
  /** type declared by tscircuit: simple_chip, simple_capacitor, ... */
  ftype: string;
  /** its sector's rectangle, if the zone plan assigns one */
  zone?: { minX: number; maxX: number; minY: number; maxY: number };
}

/*
 * How little a displacement has to be to be worth writing: one micron, i.e.
 * "anything at all".
 *
 * It used to be half a grid step, 0.25 mm, and that silently threw away exactly
 * the moves of the finishing passes — aligning to a neighbour and snapping to
 * the grid shift things by a tenth or two. So the board that got WRITTEN was a
 * mixture: the big moves applied, the small ones dropped. The placer scored an
 * arrangement (1 violation) and produced another one (19, measured on
 * bat-bs-blocchi by recompiling its own output). Whatever the solver approves
 * is what must end up on the board, down to the micron.
 */
const EMIT_EPS = 0.001;

/**
 * What gets written for a part: the ORIGIN, and the rotation if it was turned.
 *
 * The origin, not the centre, because pcbX/pcbY is a requested origin — and the
 * two differ by the offset of an off-centre footprint (0,28 mm on the MEMS
 * microphones). With a rotation there is one more step: tscircuit turns the
 * footprint around the ORIGIN, so the centre ends up at origin + R(theta)·offset.
 * To land the centre where the solver decided, the origin to ask for is
 * centre_decided − R(theta)·offset. Getting this wrong moves the part by the
 * offset every single time it is saved.
 */
function daScrivere(it: Item): Placement | null {
  const spostato = Math.hypot(it.x - it.x0, it.y - it.y0);
  const girato = it.rot % 360 !== 0;
  if (spostato < EMIT_EPS && !girato) return null;
  // the footprint offset, as it was compiled
  const dx = it.x0 - it.ox0;
  const dy = it.y0 - it.oy0;
  const rad = (it.rot * Math.PI) / 180;
  const rx = dx * Math.cos(rad) - dy * Math.sin(rad);
  const ry = dx * Math.sin(rad) + dy * Math.cos(rad);
  return {
    name: it.name,
    center: {
      x: Math.round((it.x - rx) * 1000) / 1000,
      y: Math.round((it.y - ry) * 1000) / 1000,
    },
    deltaMm: Math.round(spostato * 100) / 100,
    ...(girato ? { rotation: ((it.r0 + it.rot) % 360 + 360) % 360 } : {}),
  };
}

const halfW = (it: Item): number => Math.max(it.right, it.left);
const halfH = (it: Item): number => Math.max(it.top, it.bottom);

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * The center of a pad that does not declare one.
 *
 * Some footprints describe pads as POLYGONS — a list of vertices — and those
 * carry neither x nor y. Everything that reads coordinates skips them: the
 * clearance check, the placement, the autorouter. They are pads you can see
 * on the drawing but that do not exist for the tools, and that is how the
 * four ground pads of a microphone used to disappear without anyone saying
 * so. The center is derived from the vertices: it is an honest
 * approximation, and worth far more than a hole in the data.
 */
function centroDaVertici(el: { points?: unknown }): { x: number; y: number } | null {
  const punti = el.points as Array<{ x?: unknown; y?: unknown }> | undefined;
  if (!Array.isArray(punti) || punti.length === 0) return null;
  const xs = punti.map((p) => (typeof p.x === "number" ? p.x : NaN)).filter(Number.isFinite);
  const ys = punti.map((p) => (typeof p.y === "number" ? p.y : NaN)).filter(Number.isFinite);
  if (xs.length === 0 || ys.length === 0) return null;
  return {
    x: (Math.min(...xs) + Math.max(...xs)) / 2,
    y: (Math.min(...ys) + Math.max(...ys)) / 2,
  };
}

const GRID = 0.05;
const snap = (v: number): number => Math.round(v / GRID) * GRID;

/**
 * Connectors do not move: their position is a mechanical decision, not an
 * electrical one. A USB-C that must stick out to plug into the phone, or a
 * header that must face the edge, becomes unusable if the solver pulls it
 * toward the center, even while being "fine" for the DRC.
 */
const MECHANICAL = /^(J|CN|SW|USB|X_?CONN)/i;

function isMechanical(name: string, ftype: string): boolean {
  if (MECHANICAL.test(name)) return true;
  return ftype === "simple_connector" || ftype === "simple_pin_header";
}

/** Parts geometry, read from the already compiled Circuit JSON. */
function readItems(circuitJson: unknown[], locked: Set<string>, escape: number): Item[] {
  const elements = circuitJson as El[];
  const names = new Map<string, { name: string; ftype: string }>();
  for (const el of elements) {
    if (el.type !== "source_component" || !el.source_component_id) continue;
    names.set(String(el.source_component_id), {
      name: String(el.name ?? ""),
      ftype: String(el.ftype ?? ""),
    });
  }

  /*
   * Which net every pad is on, propagated port to port. It is not read from the
   * pad (pcb_ports carry no connectivity key) and not only from the traces that
   * NAME a net: the autorouter's ground tree names only the ports it joins, so
   * reading only the named nets left most of ground without a net.
   */
  const netOfPad = padNets(elements);

  const padsByComponent = new Map<string, Pad[]>();
  for (const el of elements) {
    if (el.type !== "pcb_smtpad" && el.type !== "pcb_plated_hole") continue;
    const owner = String(el.pcb_component_id ?? "");
    if (!owner) continue;
    // a polygonal pad does not declare a center: it is derived from the
    // vertices, so it stops being invisible to everything
    const centro = centroDaVertici(el as { points?: unknown });
    const x = num(el.x) ?? centro?.x ?? null;
    const y = num(el.y) ?? centro?.y ?? null;
    if (x === null || y === null) continue;
    /*
     * A pad is measured in four different ways depending on its shape: rect
     * has width/height, circle has radius, a through hole has
     * outer_width/height or outer_diameter. Reading only one means treating
     * the others as dimensionless points: those were exactly the round test
     * points that ended up on top of the capacitors without anyone noticing.
     */
    const diameter = num(el.outer_diameter) ?? num(el.diameter);
    const radius = num(el.radius);
    let w = num(el.width) ?? num(el.outer_width) ?? diameter ?? (radius !== null ? radius * 2 : 0);
    let h = num(el.height) ?? num(el.outer_height) ?? diameter ?? (radius !== null ? radius * 2 : 0);
    // polygon pads: the size lives in the vertices, and without this branch a
    // shaped pad (the pins of certain connectors) counted as a point
    const points = el.points as Array<{ x?: unknown; y?: unknown }> | undefined;
    if ((w <= 0 || h <= 0) && Array.isArray(points) && points.length > 0) {
      const xs = points.map((p) => num(p.x)).filter((v): v is number => v !== null);
      const ys = points.map((p) => num(p.y)).filter((v): v is number => v !== null);
      if (xs.length > 0 && ys.length > 0) {
        w = Math.max(...xs) - Math.min(...xs);
        h = Math.max(...ys) - Math.min(...ys);
      }
    }
    if (w <= 0 || h <= 0) continue;
    const list = padsByComponent.get(owner) ?? [];
    // a through hole lives on all layers: treated as "everywhere"
    const layer = el.type === "pcb_plated_hole" ? "*" : String(el.layer ?? "top");
    list.push({
      dx: x,
      dy: y,
      hw: w / 2,
      hh: h / 2,
      layer,
      net: netOfPad.get(String(el.pcb_port_id ?? "")) ?? "",
    });
    padsByComponent.set(owner, list);
  }

  /*
   * The COURTYARD is the keep-out zone declared by the footprint: it covers
   * the component's body, not just its pads. It is what the placement check
   * looks at, and it is why a placement done on pads alone passed the DRC
   * yet blew up the whole routing — "Autorouting was skipped because PCB
   * placement errors were found". Twenty-two overlapping courtyards and the
   * router does not even start.
   */
  const courtyards = new Map<string, { minX: number; maxX: number; minY: number; maxY: number }>();
  const growCourtyard = (owner: string, x: number, y: number) => {
    const box = courtyards.get(owner) ?? { minX: x, maxX: x, minY: y, maxY: y };
    box.minX = Math.min(box.minX, x);
    box.maxX = Math.max(box.maxX, x);
    box.minY = Math.min(box.minY, y);
    box.maxY = Math.max(box.maxY, y);
    courtyards.set(owner, box);
  };
  for (const el of elements) {
    const owner = String(el.pcb_component_id ?? "");
    if (!owner) continue;
    if (el.type === "pcb_courtyard_rect") {
      const center = (el.center as { x?: unknown; y?: unknown } | undefined) ?? {};
      const cx = num(center.x);
      const cy = num(center.y);
      const w = num(el.width);
      const h = num(el.height);
      if (cx === null || cy === null || w === null || h === null) continue;
      growCourtyard(owner, cx - w / 2, cy - h / 2);
      growCourtyard(owner, cx + w / 2, cy + h / 2);
    } else if (el.type === "pcb_courtyard_outline") {
      for (const p of (el.outline as Array<{ x?: unknown; y?: unknown }> | undefined) ?? []) {
        const px = num(p.x);
        const py = num(p.y);
        if (px !== null && py !== null) growCourtyard(owner, px, py);
      }
    }
  }

  const items: Item[] = [];
  for (const el of elements) {
    if (el.type !== "pcb_component") continue;
    const id = String(el.pcb_component_id ?? "");
    const center = (el.center as { x?: number; y?: number } | undefined) ?? {};
    const cx = num(center.x);
    const cy = num(center.y);
    if (!id || cx === null || cy === null) continue;
    const meta = names.get(String(el.source_component_id ?? "")) ?? { name: id, ftype: "" };
    const pads = (padsByComponent.get(id) ?? []).map((p) => ({
      ...p,
      dx: p.dx - cx,
      dy: p.dy - cy,
    }));
    if (pads.length === 0) continue;
    const courtyard = courtyards.get(id) ?? null;
    /*
     * Which way this part's copper comes out: along the line its pads lie
     * on. With many pads (a chip) it comes out on every side, and then room
     * is reserved everywhere.
     */
    const spreadX = Math.max(...pads.map((p) => p.dx)) - Math.min(...pads.map((p) => p.dx));
    const spreadY = Math.max(...pads.map((p) => p.dy)) - Math.min(...pads.map((p) => p.dy));
    const padAxis: "x" | "y" | "both" =
      pads.length > 4 || (spreadX > 0.1 && spreadY > 0.1)
        ? "both"
        : spreadX >= spreadY
          ? "x"
          : "y";
    items.push({
      id,
      name: meta.name || id,
      x: cx,
      y: cy,
      x0: cx,
      y0: cy,
      ox0: num(el.display_offset_x) ?? cx,
      oy0: num(el.display_offset_y) ?? cy,
      rot: 0,
      r0: num(el.rotation) ?? 0,
      pads,
      /*
       * The footprint is the widest of three things: the pads, the
       * footprint's courtyard, and the escape room the copper will have to
       * occupy to get out. The courtyard because otherwise the bodies overlap
       * and routing is skipped wholesale; the escape room because otherwise
       * you get a compact board in which nothing fits through.
       */
      /*
       * The escape room is reserved ONLY along the axis, not on all four
       * sides. From an 0603 the traces come out front and back, from the two
       * ends of the pads: nobody uses the flanks. Reserving it all around,
       * two capacitors that could sit side by side ended up a millimeter and
       * a half apart to make room for a corridor nobody needs. The axis is
       * the one along which the pads lie: if they sit side by side
       * horizontally you come out left and right, and vice versa.
       */
      left: Math.max(
        Math.max(...pads.map((p) => p.hw - p.dx)) + (padAxis !== "y" ? escape : 0),
        courtyard ? cx - courtyard.minX : 0,
      ),
      right: Math.max(
        Math.max(...pads.map((p) => p.hw + p.dx)) + (padAxis !== "y" ? escape : 0),
        courtyard ? courtyard.maxX - cx : 0,
      ),
      bottom: Math.max(
        Math.max(...pads.map((p) => p.hh - p.dy)) + (padAxis !== "x" ? escape : 0),
        courtyard ? cy - courtyard.minY : 0,
      ),
      top: Math.max(
        Math.max(...pads.map((p) => p.hh + p.dy)) + (padAxis !== "x" ? escape : 0),
        courtyard ? courtyard.maxY - cy : 0,
      ),
      cLeft: courtyard ? cx - courtyard.minX : Math.max(...pads.map((p) => p.hw - p.dx)),
      cRight: courtyard ? courtyard.maxX - cx : Math.max(...pads.map((p) => p.hw + p.dx)),
      cBottom: courtyard ? cy - courtyard.minY : Math.max(...pads.map((p) => p.hh - p.dy)),
      cTop: courtyard ? courtyard.maxY - cy : Math.max(...pads.map((p) => p.hh + p.dy)),
      locked: locked.has(meta.name) || isMechanical(meta.name, meta.ftype),
      ftype: meta.ftype,
      layer: String(el.layer ?? "top"),
    });
  }
  return items;
}

/**
 * Which net every pad is on, by pcb_port id.
 *
 * Union-find over the schematic traces: a trace joins the pins it touches, a
 * named net joins everything hanging on it, and the propagation runs until the
 * groups stop growing. It is the only way ground comes out as ONE net: the
 * autorouter's spanning tree names only the ports, never the net.
 */
function padNets(elements: El[]): Map<string, string> {
  const padre = new Map<string, string>();
  const radice = (a: string): string => {
    let r = a;
    while (padre.get(r) && padre.get(r) !== r) r = padre.get(r)!;
    padre.set(a, r);
    return r;
  };
  const unisci = (a: string, b: string) => {
    if (!a || !b) return;
    if (!padre.has(a)) padre.set(a, a);
    if (!padre.has(b)) padre.set(b, b);
    const ra = radice(a);
    const rb = radice(b);
    if (ra !== rb) padre.set(ra, rb);
  };
  for (const el of elements) {
    if (el.type !== "source_trace") continue;
    const porte = ((el.connected_source_port_ids as unknown[] | undefined) ?? []).map(String);
    for (let i = 1; i < porte.length; i++) unisci(porte[0], porte[i]);
    for (const netId of ((el.connected_source_net_ids as unknown[] | undefined) ?? []).map(String)) {
      if (porte[0]) unisci(porte[0], `net:${netId}`);
    }
  }
  const out = new Map<string, string>();
  for (const el of elements) {
    if (el.type !== "pcb_port" || !el.pcb_port_id) continue;
    const sp = String(el.source_port_id ?? "");
    if (!sp || !padre.has(sp)) continue;
    out.set(String(el.pcb_port_id), radice(sp));
  }
  /*
   * The net LABELS too, with the same root: whoever has to skip the poured nets
   * asks "what group is net:X in?" and the answer must be the same string the
   * pads carry.
   */
  for (const chiave of [...padre.keys()]) {
    if (chiave.startsWith("net:")) out.set(chiave, radice(chiave));
  }
  return out;
}

/**
 * The net groups that have a POUR: the magnet ignores them.
 *
 * Ground and the supplies are poured, not routed: pulling a part toward the
 * fifty pads of ground would drag everything to the middle of the board and
 * shorten copper that will never be laid.
 *
 * A pad's group is the root of the union-find, which can be a port rather than
 * the net label: so the LABEL is asked for its own root, and that is the group
 * to skip.
 */
function planeNetKeys(circuitJson: unknown[]): Set<string> {
  const elements = circuitJson as El[];
  const gruppi = new Set<string>();
  const perChiave = padNets(elements);
  for (const el of elements) {
    if (el.type !== "pcb_copper_pour") continue;
    const net = String(el.source_net_id ?? "");
    if (!net) continue;
    const radice = perChiave.get(`net:${net}`);
    if (radice) gruppi.add(radice);
  }
  return gruppi;
}

/** Who is connected to whom, and with how many wires: the weight of the magnet. */
function readLinks(circuitJson: unknown[], items: Item[]): Map<string, number> {
  const elements = circuitJson as El[];
  const portOwner = new Map<string, string>();
  for (const el of elements) {
    if (el.type !== "pcb_port" || !el.pcb_port_id) continue;
    portOwner.set(String(el.pcb_port_id), String(el.pcb_component_id ?? ""));
  }
  const sourcePortToPcb = new Map<string, string>();
  for (const el of elements) {
    if (el.type !== "pcb_port" || !el.source_port_id) continue;
    sourcePortToPcb.set(String(el.source_port_id), String(el.pcb_port_id ?? ""));
  }
  const index = new Map(items.map((it, i) => [it.id, i]));
  const links = new Map<string, number>();
  const join = (owners: string[], weight: number) => {
    const unique = [...new Set(owners.filter((o) => index.has(o)))];
    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length; j++) {
        const a = index.get(unique[i])!;
        const b = index.get(unique[j])!;
        const key = a < b ? `${a}:${b}` : `${b}:${a}`;
        links.set(key, (links.get(key) ?? 0) + weight);
      }
    }
  };

  /*
   * Two components are connected in two different ways, and for years we
   * only saw one of them.
   *
   * The first is the direct wire: a trace joining two pins. The second is
   * the NET: ten components all declaring "I am on P3V3" have no trace
   * joining them pairwise, yet they really must be connected, in copper, on
   * the board. On this board the second form is the majority — it is how a
   * readable schematic is drawn, with net labels instead of wires crossing
   * the sheet — so the placer was optimizing a fraction of the true
   * connectivity and the decoupling capacitors did not come out tied to the
   * chip they supply.
   */
  const membersOfNet = new Map<string, string[]>();
  for (const el of elements) {
    if (el.type !== "source_trace") continue;
    const ports = (el.connected_source_port_ids as string[] | undefined) ?? [];
    const owners = ports.map((p) => portOwner.get(sourcePortToPcb.get(p) ?? "") ?? "");
    join(owners, 1);
    for (const netId of (el.connected_source_net_ids as string[] | undefined) ?? []) {
      const list = membersOfNet.get(netId) ?? [];
      list.push(...owners.filter(Boolean));
      membersOfNet.set(netId, list);
    }
  }

  /*
   * Wide nets are weighed less. Ground and power touch half the board: if
   * every pair counted one, the magnet would crush them all into a single
   * clump and the rest of the circuit would no longer count for anything.
   * The weight drops with the width of the net, so a signal between two pins
   * weighs what it should and ground stays in the background.
   */
  for (const [, members] of membersOfNet) {
    const unique = [...new Set(members)];
    if (unique.length < 2) continue;
    join(unique, 1 / (unique.length - 1));
  }
  return links;
}

/**
 * The clearance violations between different parts. The footprint is checked
 * first (a few dozen comparisons), and only for pairs that graze each other
 * do we go down to the single pad: comparing every pad with every other
 * would cost a hundred times as much to give the same answer.
 */

/**
 * What an active component is, that is, one around which a block is built.
 *
 * It is NOT guessed from the pin count. Counting them is a shortcut that is
 * always wrong somewhere: with the threshold at eight, the regulators were
 * left out — they have five, and they are exactly the ones whose capacitors
 * matter most (a capacitor far from its LDO is an LDO that oscillates).
 * With a lower threshold, crystals and connectors would get in, and they
 * are not blocks.
 *
 * The component itself says it: every part carries its tags (mcu, ldo,
 * memory, sensor, crystal, connector...) written by whoever put it on the
 * schematic. Where tags are missing — old schematics — we fall back on the
 * type tscircuit already knows, which at least tells an active from a
 * passive.
 */
const ACTIVE_TAGS = /\b(mcu|micro|microcontrollore|chip|ldo|regolatore|regulator|memoria|memory|psram|flash|sensore|sensor|microfono|amplificatore|amplifier|driver|codec|convertitore|adc|dac)\b/i;
const PASSIVE_ANCHOR_TAGS = /\b(connettore|connector|quarzo|crystal|oscillatore|test|punto)\b/i;

function isChip(it: Item, tags?: Map<string, string>): boolean {
  const tag = tags?.get(it.name);
  if (tag) {
    if (PASSIVE_ANCHOR_TAGS.test(tag)) return false;
    return ACTIVE_TAGS.test(tag);
  }
  return it.ftype === "simple_chip";
}

const hasThroughHole = (it: Item): boolean => it.pads.some((p) => p.layer === "*");

/** two parts bother each other only if they are on the same side, or if one
 * of them has a through hole crossing the board from side to side */
const canCollide = (a: Item, b: Item): boolean =>
  a.layer === b.layer || hasThroughHole(a) || hasThroughHole(b);

function violations(items: Item[], clearance: number): PlacementViolation[] {
  const out: PlacementViolation[] = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i];
      const b = items[j];
      if (!canCollide(a, b)) continue;
      if (Math.abs(a.x - b.x) > halfW(a) + halfW(b) + clearance) continue;
      if (Math.abs(a.y - b.y) > halfH(a) + halfH(b) + clearance) continue;
      for (const pa of a.pads) {
        for (const pb of b.pads) {
          // two pads on opposite sides do not see each other; a through hole
          // ("*") crosses them all and therefore sees everyone
          if (pa.layer !== pb.layer && pa.layer !== "*" && pb.layer !== "*") continue;
          const gx =
            Math.abs(a.x + pa.dx - (b.x + pb.dx)) - (pa.hw + pb.hw);
          const gy =
            Math.abs(a.y + pa.dy - (b.y + pb.dy)) - (pa.hh + pb.hh);
          // rectangles: the distance is zero if they overlap on one axis
          const gap = Math.max(gx, gy) < 0 ? 0 : Math.hypot(Math.max(gx, 0), Math.max(gy, 0));
          if (gap < clearance - 1e-9) {
            out.push({
              a: a.name,
              b: b.name,
              gapMm: Math.round(gap * 1000) / 1000,
              x: (a.x + pa.dx + b.x + pb.dx) / 2,
              y: (a.y + pa.dy + b.y + pb.dy) / 2,
            });
          }
        }
      }
    }
  }
  return out;
}

/** How many pads go off the edge or sit too close to it. */
function edgeProblems(
  items: Item[],
  board: { x: number; y: number; w: number; h: number } | null,
  margin: number,
): number {
  if (!board) return 0;
  const left = board.x - board.w / 2 + margin;
  const right = board.x + board.w / 2 - margin;
  const bottom = board.y - board.h / 2 + margin;
  const top = board.y + board.h / 2 - margin;
  let count = 0;
  for (const item of items) {
    // mechanical parts sit on the edge by trade: sticking out is their job,
    // not a defect
    if (item.locked) continue;
    if (item.x - item.left < left) count++;
    else if (item.x + item.right > right) count++;
    else if (item.y - item.bottom < bottom) count++;
    else if (item.y + item.top > top) count++;
  }
  return count;
}

/**
 * Moves apart what touches until it no longer touches. Works on the
 * footprint, not the single pad: separating two parts' footprints also
 * guarantees the pads inside them, and costs fifty comparisons instead of
 * twenty thousand.
 *
 * The exit is on the shorter side: if two parts overlap by a tenth of a
 * millimeter vertically and by three millimeters horizontally, the move is
 * a tenth. It is the difference between an adjustment and an upheaval of
 * the drawing.
 */
function separate(
  items: Item[],
  clearance: number,
  board: { x: number; y: number; w: number; h: number } | null,
  margin: number,
  passes = 80,
  /** if present, only these move: the others act as a wall */
  movable?: Set<number>,
): boolean {
  for (let pass = 0; pass < passes; pass++) {
    let touched = false;
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i];
        const b = items[j];
        const freeA = !a.locked && (!movable || movable.has(i));
        const freeB = !b.locked && (!movable || movable.has(j));
        if (!freeA && !freeB) continue;
        if (!canCollide(a, b)) continue;
        // true distance between the two footprints on each axis: negative if
        // they overlap, positive if there is air in between
        const gapX = Math.max(a.x - a.left - (b.x + b.right), b.x - b.left - (a.x + a.right));
        const gapY = Math.max(a.y - a.bottom - (b.y + b.top), b.y - b.bottom - (a.y + a.top));
        if (gapX >= clearance || gapY >= clearance) continue;
        const overlapX = clearance - gapX;
        const overlapY = clearance - gapY;
        touched = true;
        // what is still does not move: the other one takes the whole burden
        const shareA = !freeA ? 0 : !freeB ? 1 : 0.5;
        const shareB = 1 - shareA;
        if (overlapX < overlapY) {
          const dir = b.x >= a.x ? 1 : -1;
          a.x -= overlapX * shareA * dir;
          b.x += overlapX * shareB * dir;
        } else {
          const dir = b.y >= a.y ? 1 : -1;
          a.y -= overlapY * shareA * dir;
          b.y += overlapY * shareB * dir;
        }
      }
    }
    keepInside(items, board, margin, movable);
    if (!touched) return true;
  }
  return false;
}

/** no part leaves the board (mechanical ones are exempt: sticking out is their trade) */
function keepInside(
  items: Item[],
  board: { x: number; y: number; w: number; h: number } | null,
  margin: number,
  movable?: Set<number>,
): void {
  if (!board) return;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.locked || (movable && !movable.has(i))) continue;
    // the boundary is the sector's rectangle when there is one, the board
    // edge otherwise: that is how the logical division becomes a spatial one
    const box = it.zone ?? {
      minX: board.x - board.w / 2,
      maxX: board.x + board.w / 2,
      minY: board.y - board.h / 2,
      maxY: board.y + board.h / 2,
    };
    const left = box.minX + margin + it.left;
    const right = box.maxX - margin - it.right;
    const bottom = box.minY + margin + it.bottom;
    const top = box.maxY - margin - it.top;
    if (left <= right) it.x = Math.min(Math.max(it.x, left), right);
    if (bottom <= top) it.y = Math.min(Math.max(it.y, bottom), top);
  }
}

function areaMm2(items: Item[]): number {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const it of items) {
    minX = Math.min(minX, it.x - it.left);
    maxX = Math.max(maxX, it.x + it.right);
    minY = Math.min(minY, it.y - it.bottom);
    maxY = Math.max(maxY, it.y + it.top);
  }
  if (!Number.isFinite(minX)) return 0;
  return Math.round((maxX - minX) * (maxY - minY) * 10) / 10;
}

/**
 * Crowding: the board is divided into bins and we look at how much component
 * copper sits in each. Whatever exceeds the bin's quota is space someone
 * else will not get.
 *
 * The bins are five millimeters: smaller, and every chip would come out as a
 * clump of its own; larger, and they would notice nothing.
 */
const BIN_MM = 5;
const DENSITA_AMMESSA = 0.55;

function crowdingMm2(
  items: Item[],
  board: { x: number; y: number; w: number; h: number } | null,
): number {
  if (!board) return 0;
  const cols = Math.max(1, Math.ceil(board.w / BIN_MM));
  const rows = Math.max(1, Math.ceil(board.h / BIN_MM));
  const bins = new Float64Array(cols * rows);
  /*
   * A component's area is SPREAD over the bins it really covers, not dumped
   * whole into the one holding its center.
   *
   * Dumping it into the center, a QFP with a 20mm side — bigger than sixteen
   * bins — always overflowed, by an amount that did not depend on where it
   * sat: the number ended up dominated by the chips, which cannot be spread,
   * and stayed the same whatever arrangement was tried. Measured: 676mm²
   * with the parts heaped and 652 with the parts spread out, i.e. no
   * information at all.
   */
  for (const it of items) {
    const x0 = it.x - it.left;
    const x1 = it.x + it.right;
    const y0 = it.y - it.bottom;
    const y1 = it.y + it.top;
    const ci0 = Math.max(0, Math.floor((x0 - (board.x - board.w / 2)) / BIN_MM));
    const ci1 = Math.min(cols - 1, Math.floor((x1 - (board.x - board.w / 2)) / BIN_MM));
    const ri0 = Math.max(0, Math.floor((y0 - (board.y - board.h / 2)) / BIN_MM));
    const ri1 = Math.min(rows - 1, Math.floor((y1 - (board.y - board.h / 2)) / BIN_MM));
    for (let r = ri0; r <= ri1; r++) {
      for (let c = ci0; c <= ci1; c++) {
        const bx0 = board.x - board.w / 2 + c * BIN_MM;
        const by0 = board.y - board.h / 2 + r * BIN_MM;
        // how much of this part falls into this bin
        const larghezza = Math.max(0, Math.min(x1, bx0 + BIN_MM) - Math.max(x0, bx0));
        const altezza = Math.max(0, Math.min(y1, by0 + BIN_MM) - Math.max(y0, by0));
        bins[r * cols + c] += larghezza * altezza;
      }
    }
  }
  const quota = BIN_MM * BIN_MM * DENSITA_AMMESSA;
  let eccesso = 0;
  for (const v of bins) if (v > quota) eccesso += v - quota;
  return Math.round(eccesso * 10) / 10;
}

function netLengthMm(items: Item[], links: Map<string, number>): number {
  let total = 0;
  for (const [key, weight] of links) {
    const [i, j] = key.split(":").map(Number);
    total += Math.hypot(items[i].x - items[j].x, items[i].y - items[j].y) * weight;
  }
  return Math.round(total * 10) / 10;
}

/*
 * Courtyards that touch: it is what blows up the whole routing.
 *
 * "Touch" with a guard of five hundredths, not with a strict overlap: parking a
 * part exactly on the boundary of another one's keep-out zone (gap 0.00) passed
 * this check and then came out as an overlap on the compiled board, because
 * rounding to the micron falls on either side. Measured on bat-bs-blocchi: the
 * solver declared it clean and left the microcontroller grazing both crystals.
 */
const GUARDIA_COURTYARD = 0.05;

function courtyardOverlaps(items: Item[]): number {
  let count = 0;
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i];
      const b = items[j];
      if (!canCollide(a, b)) continue;
      const gapX = Math.max(a.x - a.cLeft - (b.x + b.cRight), b.x - b.cLeft - (a.x + a.cRight));
      const gapY = Math.max(a.y - a.cBottom - (b.y + b.cTop), b.y - b.cBottom - (a.y + a.cTop));
      if (gapX < GUARDIA_COURTYARD && gapY < GUARDIA_COURTYARD) count++;
    }
  }
  return count;
}

function score(
  items: Item[],
  links: Map<string, number>,
  clearance: number,
  board: { x: number; y: number; w: number; h: number } | null,
  margin: number,
): PlacementScore {
  return {
    violations:
      violations(items, clearance).length +
      edgeProblems(items, board, margin) +
      courtyardOverlaps(items),
    areaMm2: areaMm2(items),
    netLengthMm: netLengthMm(items, links),
    crowdingMm2: crowdingMm2(items, board),
  };
}

/**
 * Fewer violations first; then the cost, which is copper plus crowding; then
 * less area.
 *
 * The cost combines two things that pull in opposite directions: shortening
 * the wires brings parts closer, not crowding pushes them apart. Weighing
 * them together is the only way to get a spread-out arrangement instead of
 * a clump — comparing them in turn, first one and then the other, does not
 * work, because the first always wins. The weight is what makes a square
 * millimeter of crowding count as much as a few millimeters of copper.
 */
let PESO_AFFOLLAMENTO = 3;

const costo = (s: PlacementScore): number =>
  s.netLengthMm + PESO_AFFOLLAMENTO * s.crowdingMm2;

function better(a: PlacementScore, b: PlacementScore): boolean {
  if (a.violations !== b.violations) return a.violations < b.violations;
  const ca = costo(a);
  const cb = costo(b);
  if (Math.abs(ca - cb) > 0.05) return ca < cb;
  return a.areaMm2 < b.areaMm2 - 0.05;
}

function readBoard(circuitJson: unknown[]): { x: number; y: number; w: number; h: number } | null {
  for (const el of circuitJson as El[]) {
    if (el.type !== "pcb_board") continue;
    const center = (el.center as { x?: number; y?: number } | undefined) ?? {};
    const x = num(center.x) ?? 0;
    const y = num(center.y) ?? 0;
    const w = num(el.width);
    const h = num(el.height);
    if (w === null || h === null) return null;
    return { x, y, w, h };
  }
  return null;
}

/**
 * One placement attempt: separate, pull, squeeze. It works on the positions
 * it finds in the items and leaves them on the best result it has seen. It
 * is the part that repeats as many times as there are tries.
 */
function solveOnce(
  items: Item[],
  links: Map<string, number>,
  ctx: {
    clearance: number;
    board: { x: number; y: number; w: number; h: number } | null;
    margin: number;
    maxRounds: number;
    deadline: number;
    compact: boolean;
    /** if present, only these parts move: it is the per-zone refinement */
    movable?: Set<number>;
  },
): PlacementScore {
  const { clearance, board, margin } = ctx;
  const canMove = (i: number, it: Item) => !it.locked && (!ctx.movable || ctx.movable.has(i));

  separate(items, clearance + GRID, board, margin, 80, ctx.movable);
  for (let i = 0; i < items.length; i++) {
    if (!canMove(i, items[i])) continue;
    items[i].x = snap(items[i].x);
    items[i].y = snap(items[i].y);
  }
  let bestScore = score(items, links, clearance, board, margin);
  let best = items.map((i) => ({ x: i.x, y: i.y }));

  /*
   * We climb uphill: at each round the connected parts are pulled, the
   * clearance constraint is re-applied, and the round is KEPT only if the
   * score improves. If it worsens we go back and halve the strength.
   *
   * The fixed-strength loop did not work: with a strong magnet the
   * separation could no longer close the overlaps the magnet opened (A moves
   * away from B and lands on C, forever), and with a weak one nothing was
   * gained. Here the result decides the strength, round by round, and the
   * score cannot go up.
   */
  let strength = 0.08;
  for (let round = 1; round <= ctx.maxRounds; round++) {
    if (Date.now() > ctx.deadline || strength < 0.002) break;

    for (const [key, weight] of links) {
      const [i, j] = key.split(":").map(Number);
      const a = items[i];
      const b = items[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const w = strength * Math.min(weight, 4);
      if (canMove(i, a)) {
        a.x += dx * w;
        a.y += dy * w;
      }
      if (canMove(j, b)) {
        b.x -= dx * w;
        b.y -= dy * w;
      }
    }
    // we separate with a hair of margin above the required clearance: the
    // positions then land on a 0.05 grid and the rounding would eat exactly
    // that hair, leaving pairs at 0.175 instead of 0.2
    separate(items, clearance + GRID, board, margin, 80, ctx.movable);
    for (let i = 0; i < items.length; i++) {
      if (!canMove(i, items[i])) continue;
      items[i].x = snap(items[i].x);
      items[i].y = snap(items[i].y);
    }

    const now = score(items, links, clearance, board, margin);
    if (better(now, bestScore)) {
      bestScore = now;
      best = items.map((i) => ({ x: i.x, y: i.y }));
    } else {
      for (let i = 0; i < items.length; i++) {
        items[i].x = best[i].x;
        items[i].y = best[i].y;
      }
      strength /= 2;
    }
  }

  // we restart from the best, not from where we ended up
  for (let i = 0; i < items.length; i++) {
    items[i].x = best[i].x;
    items[i].y = best[i].y;
  }

  /*
   * Final squeeze: each part tries to get closer to the center of mass of
   * the parts it is connected to, one step at a time, and the step counts
   * only if it does not reopen a violation. It is the only honest way to
   * "minimize the gaps": you shorten as long as you can, and you stop when
   * touching would cost a violation.
   */
  if (ctx.compact) {
    const degree = new Map<number, number>();
    const neighbours = new Map<number, number[]>();
    for (const [key] of links) {
      const [i, j] = key.split(":").map(Number);
      degree.set(i, (degree.get(i) ?? 0) + 1);
      degree.set(j, (degree.get(j) ?? 0) + 1);
      neighbours.set(i, [...(neighbours.get(i) ?? []), j]);
      neighbours.set(j, [...(neighbours.get(j) ?? []), i]);
    }

    for (let step = 0.4; step >= GRID; step /= 2) {
      let movedAny = true;
      let guard = 0;
      while (movedAny && guard++ < 40 && Date.now() <= ctx.deadline) {
        movedAny = false;
        for (let i = 0; i < items.length; i++) {
          const it = items[i];
          const near = neighbours.get(i);
          if (!canMove(i, it) || !near || near.length === 0) continue;
          let ax = 0;
          let ay = 0;
          for (const other of near) {
            ax += items[other].x;
            ay += items[other].y;
          }
          const dx = ax / near.length - it.x;
          const dy = ay / near.length - it.y;
          const dist = Math.hypot(dx, dy);
          if (dist < step) continue;
          const px = it.x;
          const py = it.y;
          it.x = snap(px + (dx / dist) * step);
          it.y = snap(py + (dy / dist) * step);
          const now = score(items, links, clearance, board, margin);
          if (
            better(now, bestScore) ||
            (now.violations === bestScore.violations && now.netLengthMm < bestScore.netLengthMm)
          ) {
            bestScore = now;
            movedAny = true;
          } else {
            it.x = px;
            it.y = py;
          }
        }
      }
    }
  }

  return score(items, links, clearance, board, margin);
}

/**
 * Seeded pseudo-random generator. Deterministic on purpose: two compilations
 * of the same files must give the same board, otherwise you can no longer
 * tell whether a change improved things or just got lucky.
 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Shuffles the start. Two moves, the classic ones of placement: nudging one
 * part at random, and SWAPPING two parts of similar size. The swap counts
 * more than the nudge: it makes the solver jump into another basin, while
 * the nudge alone tends to bring it back where it already was.
 *
 * The intensity grows try after try, from a caress to a jolt. Shuffling hard
 * from the very first try does not work: the starting arrangement is not
 * random, it is written in sections by whoever designed the circuit, and
 * twelve swaps destroy it. The gentle tries look for a better minimum near
 * the good one; the violent ones are only useful if the gentle ones find
 * nothing.
 */
function shuffleStart(
  items: Item[],
  random: () => number,
  spreadMm: number,
  intensity: number,
): void {
  const free = items.filter((it) => !it.locked);
  if (free.length === 0) return;

  const swaps = Math.max(1, Math.round((free.length / 4) * intensity));
  for (let n = 0; n < swaps; n++) {
    const a = free[Math.floor(random() * free.length)];
    const b = free[Math.floor(random() * free.length)];
    if (a === b) continue;
    // only parts of comparable size are swapped: putting a QFP where a
    // capacitor sat is not a variant, it is an announced disaster
    const sizeA = (a.left + a.right) * (a.bottom + a.top);
    const sizeB = (b.left + b.right) * (b.bottom + b.top);
    if (sizeA > sizeB * 3 || sizeB > sizeA * 3) continue;
    const x = a.x;
    const y = a.y;
    a.x = b.x;
    a.y = b.y;
    b.x = x;
    b.y = y;
  }
  for (const it of free) {
    it.x += (random() - 0.5) * spreadMm * intensity;
    it.y += (random() - 0.5) * spreadMm * intensity;
  }
}

/** how much of the occupied surface is really covered by components, in % */
function densityPct(items: Item[]): number {
  const area = areaMm2(items);
  if (area <= 0) return 0;
  let used = 0;
  for (const it of items) used += (it.left + it.right) * (it.bottom + it.top);
  return Math.round((used / area) * 1000) / 10;
}


/**
 * The zone plan: to each sector its slice of board, decided BEFORE starting
 * to optimize distances.
 *
 * It is the piece that was missing, and the reason the solver heaped
 * everything at the center: minimizing the sum of the wires has its absolute
 * minimum in a single point, and no amount of tries leads it to decide that
 * the power supply goes where the current enters. That is not a consequence
 * of the distances, it is a choice that must be made first.
 *
 * How it is decided, without asking anyone: start from the ANCHORED sector —
 * the one containing the mechanical parts, the connector, which sits where
 * it sits and is not up for discussion — and give it the slice of board on
 * its side. Then proceed by electrical closeness: the next sector is the one
 * most connected to those already placed, and it takes the next slice. This
 * way the flow of current and signal crosses the board instead of bouncing
 * around inside it.
 *
 * The slices are columns, wide in proportion to what each sector needs: the
 * area of its parts divided by the density one wants to keep.
 */
function computeFloorplan(
  items: Item[],
  links: Map<string, number>,
  board: { x: number; y: number; w: number; h: number },
  sectorOf: Map<string, string>,
): Map<string, { minX: number; maxX: number; minY: number; maxY: number }> {
  const zone = new Map<string, { minX: number; maxX: number; minY: number; maxY: number }>();
  const membri = new Map<string, number[]>();
  items.forEach((it, i) => {
    const sett = sectorOf.get(it.name);
    if (!sett) return;
    membri.set(sett, [...(membri.get(sett) ?? []), i]);
  });
  if (membri.size < 2) return zone;

  const area = new Map<string, number>();
  for (const [sett, ids] of membri) {
    area.set(
      sett,
      ids.reduce((n, i) => n + (items[i].left + items[i].right) * (items[i].bottom + items[i].top), 0),
    );
  }

  /** how much two sectors are tied: the sum of the wires crossing them */
  const legame = new Map<string, number>();
  for (const [key, peso] of links) {
    const [i, j] = key.split(":").map(Number);
    const a = sectorOf.get(items[i]?.name ?? "");
    const b = sectorOf.get(items[j]?.name ?? "");
    if (!a || !b || a === b) continue;
    const k = a < b ? `${a}|${b}` : `${b}|${a}`;
    legame.set(k, (legame.get(k) ?? 0) + peso);
  }
  const quantoLegati = (a: string, b: string) =>
    legame.get(a < b ? `${a}|${b}` : `${b}|${a}`) ?? 0;

  /*
   * The anchored sector and which side it is on. The mechanical parts do not
   * move — the connector sticks out of the edge to plug into the phone — so
   * it is their sector that decides where to start slicing the board.
   */
  let ancora: string | null = null;
  let versoDestra = true;
  for (const [sett, ids] of membri) {
    const fissi = ids.filter((i) => items[i].locked);
    if (fissi.length === 0) continue;
    const mx = fissi.reduce((n, i) => n + items[i].x, 0) / fissi.length;
    ancora = sett;
    versoDestra = mx >= board.x;
    break;
  }

  const ordine: string[] = [];
  const restanti = new Set(membri.keys());
  const primo = ancora ?? [...restanti].sort((a, b) => (area.get(b) ?? 0) - (area.get(a) ?? 0))[0];
  ordine.push(primo);
  restanti.delete(primo);
  while (restanti.size > 0) {
    let migliore = [...restanti][0];
    let punteggio = -1;
    for (const cand of restanti) {
      // how tied it is to what is already placed, with a soft spot for the
      // last one placed: it is the one it will end up adjacent to
      const p =
        ordine.reduce((n, s, k) => n + quantoLegati(cand, s) * (k === ordine.length - 1 ? 2 : 1), 0);
      if (p > punteggio) {
        punteggio = p;
        migliore = cand;
      }
    }
    ordine.push(migliore);
    restanti.delete(migliore);
  }

  const totale = [...area.values()].reduce((n, v) => n + v, 0) || 1;
  const margine = 0.5;
  let cursore = versoDestra ? board.x + board.w / 2 : board.x - board.w / 2;
  for (const sett of ordine) {
    const quota = (area.get(sett) ?? 0) / totale;
    const larghezza = Math.max(6, (board.w - 2 * margine) * quota);
    const a = cursore;
    const b = versoDestra ? cursore - larghezza : cursore + larghezza;
    zone.set(sett, {
      minX: Math.min(a, b),
      maxX: Math.max(a, b),
      minY: board.y - board.h / 2,
      maxY: board.y + board.h / 2,
    });
    cursore = b;
  }
  return zone;
}

/**
 * Tidies the components until there are no more violations, then squeezes
 * them. It does not touch the copper: the traces must be redone afterwards,
 * and that is exactly why this step comes first.
 *
 * Not ONE single arrangement is tried: many are tried, starting from
 * different shuffles, all of them are measured (violations, estimated
 * copper, density) and the best is kept. A placement is a descent toward
 * the nearest minimum, and which minimum is nearest depends on where you
 * start: starting only once means accepting the first one that comes along.
 * It costs little — one try is tens of milliseconds — and the number of
 * tries can be raised at will.
 *
 * Then it refines by zone: it takes the winning arrangement and tries again
 * to improve one bin at a time, keeping the others still. It is the same
 * idea as the routing loop: a small problem is solved better than a big
 * one, and reshuffling the whole board to fix one corner throws away the
 * good that is elsewhere.
 */
export function placeComponents(
  circuitJson: unknown[],
  opts: PlaceOptions = {},
): { placements: Placement[]; report: PlacementReport } {
  const rules = opts.rules ?? DEFAULT_DESIGN_RULES;
  const clearance = rules.targetClearanceMm ?? rules.minClearanceMm;
  const margin = rules.minBoardEdgeClearanceMm;
  const maxRounds = Math.max(1, Math.min(opts.maxRounds ?? 600, 5000));
  const budgetMs = Math.max(1000, opts.budgetMs ?? 20_000);
  const attempts = Math.max(1, Math.min(opts.attempts ?? 10, 2000));
  const zoneRounds = Math.max(0, Math.min(opts.zoneRounds ?? 2, 20));
  const deadline = Date.now() + budgetMs;

  /*
   * Low weight by default. Measured on bat-bs: at weight 1 the crowding
   * drops by 7% and the copper grows by 4%, which is a good trade; at
   * weight 8 you gain 17% of crowding but pay 7% of copper, and it is not
   * worth it.
   */
  PESO_AFFOLLAMENTO = opts.crowdingWeight ?? 1;
  const lockedNames = new Set(opts.locked ?? []);
  const escape = escapeRoomMm(rules);
  const items = readItems(circuitJson, lockedNames, escape);
  const links = readLinks(circuitJson, items);
  const board = readBoard(circuitJson);

  /*
   * If no plan arrives from the outside, one is computed: it is what turns
   * the logical division (the sectors) into a spatial division (the zones).
   */
  const sectorOfName = new Map<string, string>();
  if (opts.tags) {
    for (const [name, tag] of opts.tags) {
      const sect = /\b(brain|alimentazione|analogico|sensori|memoria|comunicazione|interfaccia|meccanica)\b/i.exec(tag);
      if (sect) sectorOfName.set(name, sect[1].toLowerCase());
    }
  }
  /*
   * The plan is COMPUTED only when the arrangement is being decided. If
   * someone else decided the arrangement (keepArrangement), a computed plan
   * would squeeze it into zones that have nothing to do with it: measured,
   * the hand-made arrangement went from zero to six violations by being
   * stuffed into columns nobody had asked it for. An explicitly given plan
   * is always respected instead: that one is a request.
   */
  const zones =
    opts.zones && opts.zones.size > 0
      ? opts.zones
      : board && sectorOfName.size > 0 && !opts.keepArrangement && opts.floorplan === true
        ? computeFloorplan(items, links, board, sectorOfName)
        : new Map();
  if (opts.zoneOfComponent && opts.zoneOfComponent.size > 0) {
    // decided part by part: nothing to match, nothing to guess
    for (const it of items) {
      if (it.locked) continue;
      const rect = opts.zoneOfComponent.get(it.name);
      if (rect) it.zone = rect;
    }
  } else if (zones.size > 0 && opts.tags) {
    for (const it of items) {
      if (it.locked) continue;
      const tag = (opts.tags.get(it.name) ?? "").toLowerCase();
      for (const [sector, rect] of zones) {
        if (tag.includes(sector.toLowerCase())) {
          it.zone = rect;
          break;
        }
      }
    }
  }

  const before = score(items, links, clearance, board, margin);
  const report: PlacementReport = {
    rounds: 0,
    moved: 0,
    before,
    after: before,
    stoppedBecause: "giri esauriti",
    remaining: [],
    locked: items.filter((i) => i.locked).map((i) => i.name),
    attempts: 0,
    picked: 0,
    candidates: [],
    densityPct: densityPct(items),
    zonesImproved: 0,
    decouplingPlaced: 0,
    aligned: 0,
    snapped: 0,
    blockSpread: [],
    blocksPlaced: 0,
  };
  if (items.length === 0) return { placements: [], report };

  /*
   * Given arrangement: it is legalized and compacted, without reopening
   * anything. The magnet stays off on purpose — it is what would pull
   * everything back to the barycenter, undoing the decisions of whoever
   * arranged the parts.
   */
  if (opts.keepArrangement) {
    const ctx = { clearance, board, margin };
    /*
     * The magnet FIRST, then legalization: closing the gaps can bring two parts
     * to touch, and separate() is the one that puts things right. The other way
     * round the magnet would undo the separation it had just been given.
     */
    if (opts.magnetToPins) {
      report.magnetSteps = magnetToPins(items, ctx, {
        skipNets: new Set(opts.magnetSkipNets ?? planeNetKeys(circuitJson)),
      });
    }
    separate(items, clearance + GRID, board, margin);
    keepInside(items, board, margin);
    for (const it of items) {
      if (it.locked) continue;
      it.x = snap(it.x);
      it.y = snap(it.y);
    }
    report.aligned = alignNeighbours(items, links, ctx);
    report.snapped = snapToCoarseGrid(items, links, ctx, opts.gridMm ?? 0.5);
    const after = score(items, links, clearance, board, margin);
    report.after = after;
    report.densityPct = densityPct(items);
    report.remaining = violations(items, clearance).slice(0, 20);
    report.stoppedBecause = after.violations === 0 ? "pulito" : "non migliora piu'";
    const out: Placement[] = [];
    for (const it of items) {
      const p = daScrivere(it);
      if (p) out.push(p);
    }
    report.moved = out.length;
    return { placements: out, report };
  }

  /*
   * FIRST of all: the constructive placement, block by block, from the
   * largest down. The numeric solver that comes after no longer starts from
   * a random board but from an already drawn one, and its job becomes the
   * right one: removing the remaining overlaps and squeezing, not inventing
   * the arrangement.
   */
  const wired = wiredPowerPads(circuitJson, items, opts.tags);
  const plans = planBlocks(items, opts.blocks, opts.tags);
  const settled = new Set<number>();
  for (const plan of plans) {
    layoutBlock(plan, items, settled, wired.padOfCapacitor, clearance + escape, board, margin);
  }
  report.blocksPlaced = plans.length;

  /*
   * A capacitor placed on its pin is never touched again.
   *
   * Without this, the solver pulled it right back away: the magnet sees it
   * connected also to ground and to everything else, and the barycenter of
   * those forces is never next to the pin. The result was a capacitor that
   * started two millimeters from its VDD and ended up sixteen away. But the
   * closeness to the pin is not a force to be weighed against the others:
   * it is the reason that component exists, so it becomes a constraint, and
   * it is the other parts that must arrange themselves around it.
   */
  for (const it of items) {
    if (wired.padOfCapacitor.has(it.name)) {
      it.locked = true;
      report.decouplingPlaced += 1;
    }
  }

  const startPositions = items.map((i) => ({ x: i.x, y: i.y }));
  const ctx = {
    clearance,
    board,
    margin,
    maxRounds,
    deadline,
    compact: opts.compact !== false,
  };
  /*
   * The blocks enter the connections as one more magnet. It is not a rigid
   * constraint — a block that does not fit must be able to yield — but it
   * weighs more than any single wire, because keeping the microcontroller
   * together with its capacitors counts more than shortening a signal that
   * goes to the other side of the board.
   */
  /*
   * The organization has several levels, as on any well-made schematic: the
   * SECTOR (domain: sensori, alimentazione, brain) holds together an area of
   * the board; inside the sector the SECTION (schSectionName) holds together
   * a piece of circuit; inside the section the chip's block holds together a
   * component and its passives. Three nested magnets, of increasing
   * strength: what is close in the schematic must be born close on the
   * board, and the tighter the logical bond the shorter the distance.
   */
  const sectorOf = new Map<string, string>();
  if (opts.tags) {
    for (const [name, tag] of opts.tags) {
      const sector = /\b(brain|alimentazione|analogico|sensori|memoria|comunicazione|interfaccia|meccanica)\b/i.exec(tag);
      if (sector) sectorOf.set(name, sector[1].toLowerCase());
    }
  }
  if (sectorOf.size > 0) {
    const bySector = new Map<string, number[]>();
    items.forEach((it, i) => {
      const sector = sectorOf.get(it.name);
      if (!sector) return;
      bySector.set(sector, [...(bySector.get(sector) ?? []), i]);
    });
    for (const [, members] of bySector) {
      if (members.length < 2) continue;
      // the sector pulls gently: it groups an area, it does not squeeze a node
      const weight = 0.5 / (members.length - 1);
      for (let a = 0; a < members.length; a++) {
        for (let b = a + 1; b < members.length; b++) {
          const i = members[a];
          const j = members[b];
          const key = i < j ? `${i}:${j}` : `${j}:${i}`;
          links.set(key, (links.get(key) ?? 0) + weight);
        }
      }
    }
  }

  if (opts.blocks && opts.blocks.size > 0) {
    const byBlock = new Map<string, number[]>();
    items.forEach((it, i) => {
      const block = opts.blocks!.get(it.name);
      if (!block) return;
      byBlock.set(block, [...(byBlock.get(block) ?? []), i]);
    });
    for (const [, members] of byBlock) {
      if (members.length < 2) continue;
      /*
       * A block without a chip inside is not a block: it is a sack. A
       * section called "decoupling" that gathers the capacitors of four
       * different chips, held together, pulls every capacitor away from the
       * pin it must stabilize — that is, it does the opposite of what is
       * needed. Measured on bat-bs: with the sacks treated as blocks, the
       * density drops from 43.7 to 40.6 percent and the capacitors that
       * manage to reach their pin go from four to one.
       *
       * So only what has an owner is held together: a chip and the parts
       * around it. The role rules take care of the rest.
       */
      const hasChip = members.some((i) => isChip(items[i], opts.tags));
      if (!hasChip) continue;
      const weight = 2 / (members.length - 1);
      for (let a = 0; a < members.length; a++) {
        for (let b = a + 1; b < members.length; b++) {
          const i = members[a];
          const j = members[b];
          const key = i < j ? `${i}:${j}` : `${j}:${i}`;
          links.set(key, (links.get(key) ?? 0) + weight);
        }
      }
    }
  }

  const random = rng(opts.seed ?? 20260727);
  const spread = board ? Math.min(board.w, board.h) / 6 : 5;

  let bestScore: PlacementScore | null = null;
  let bestPositions = startPositions;

  for (let attempt = 0; attempt < attempts; attempt++) {
    // try 0 starts from the board as written: this way the result can never
    // be worse than what one would get without the tries
    for (let i = 0; i < items.length; i++) {
      items[i].x = startPositions[i].x;
      items[i].y = startPositions[i].y;
    }
    // the intensity rises with the try number: the first ones search near
    // what the author wrote, the last ones dare
    if (attempt > 0) {
      shuffleStart(items, random, spread, Math.min(1, 0.08 + (attempt / attempts) * 0.92));
    }

    const result = solveOnce(items, links, ctx);
    report.attempts = attempt + 1;
    report.candidates.push({
      attempt,
      violations: result.violations,
      netLengthMm: result.netLengthMm,
      areaMm2: result.areaMm2,
      densityPct: densityPct(items),
    });
    if (!bestScore || better(result, bestScore)) {
      bestScore = result;
      bestPositions = items.map((i) => ({ x: i.x, y: i.y }));
      report.picked = attempt;
    }
    if (Date.now() > deadline) {
      report.stoppedBecause = "tempo scaduto";
      break;
    }
  }

  for (let i = 0; i < items.length; i++) {
    items[i].x = bestPositions[i].x;
    items[i].y = bestPositions[i].y;
  }

  /*
   * Per-zone refinement: the board is divided into bins and one bin is
   * retried at a time, keeping everything else still. It is kept only if the
   * OVERALL score improves: a tidied zone that worsens its neighbours is not
   * an improvement.
   */
  if (zoneRounds > 0 && bestScore && board) {
    const zone = Math.max(8, Math.min(board.w, board.h) / 3);
    const cols = Math.max(1, Math.ceil(board.w / zone));
    const rows = Math.max(1, Math.ceil(board.h / zone));
    for (let round = 0; round < zoneRounds && Date.now() < deadline; round++) {
      for (let cy = 0; cy < rows && Date.now() < deadline; cy++) {
        for (let cx = 0; cx < cols && Date.now() < deadline; cx++) {
          const minX = board.x - board.w / 2 + cx * zone;
          const minY = board.y - board.h / 2 + cy * zone;
          const movable = new Set<number>();
          for (let i = 0; i < items.length; i++) {
            const it = items[i];
            if (it.locked) continue;
            if (it.x >= minX && it.x < minX + zone && it.y >= minY && it.y < minY + zone) {
              movable.add(i);
            }
          }
          if (movable.size < 2) continue;

          const restore = items.map((i) => ({ x: i.x, y: i.y }));
          for (const i of movable) {
            items[i].x += (random() - 0.5) * zone * 0.25;
            items[i].y += (random() - 0.5) * zone * 0.25;
          }
          const result = solveOnce(items, links, { ...ctx, movable });
          if (better(result, bestScore)) {
            bestScore = result;
            report.zonesImproved += 1;
          } else {
            for (let i = 0; i < items.length; i++) {
              items[i].x = restore[i].x;
              items[i].y = restore[i].y;
            }
          }
        }
      }
    }
  }

  /*
   * Last step: the good-design rules. They come AFTER the numeric solver and
   * not in its place, because the solver knows where the parts FIT and these
   * know where the parts GO. Each one applies only if it does not worsen the
   * score, so they cannot break what the solver has tidied.
   */
  const rulesCtx = { clearance, board, margin };
  if (opts.decouplingToPins !== false) {
    // the ones already pinned on their pin are locked: this pass only serves
    // the capacitors the schematic hung on the net instead of on the pin
    report.decouplingPlaced += pullDecouplingToPins(circuitJson, items, links, rulesCtx);
  }
  report.aligned = alignNeighbours(items, links, rulesCtx);
  report.snapped = snapToCoarseGrid(items, links, rulesCtx, opts.gridMm ?? 0.5);

  if (opts.blocks && opts.blocks.size > 0) {
    const byBlock = new Map<string, Item[]>();
    for (const it of items) {
      const block = opts.blocks.get(it.name);
      if (!block) continue;
      byBlock.set(block, [...(byBlock.get(block) ?? []), it]);
    }
    report.blockSpread = [...byBlock]
      .filter(([, parts]) => parts.length > 1)
      .map(([block, parts]) => {
        const xs = parts.map((p) => p.x);
        const ys = parts.map((p) => p.y);
        return {
          block,
          parts: parts.length,
          spreadMm:
            Math.round(Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * 10) / 10,
        };
      })
      .sort((a, b) => b.spreadMm - a.spreadMm);
  }

  const after = score(items, links, clearance, board, margin);
  report.after = after;
  report.densityPct = densityPct(items);
  report.remaining = violations(items, clearance).slice(0, 20);
  report.rounds = report.attempts;
  if (after.violations === 0) report.stoppedBecause = "pulito";
  else if (report.stoppedBecause !== "tempo scaduto") report.stoppedBecause = "non migliora piu'";

  const placements: Placement[] = [];
  for (const it of items) {
    const p = daScrivere(it);
    if (p) placements.push(p);
  }
  report.moved = placements.length;
  return { placements, report };
}

// ---------------------------------------------------------------------------
// Good-design rules: where a part GOES, not just where it fits
// ---------------------------------------------------------------------------

/**
 * A placement that respects the clearances is not yet a good placement. The
 * three rules below are what distinguish a drawn board from a solved one
 * (Niccolo', 2026-07-27):
 *
 * 1. A decoupling capacitor sits ATTACHED to the pin it supplies. Placing
 *    it far away and reaching it with a trace that wanders above and below
 *    means not having placed it: what stabilizes is the closeness, not the
 *    connection. The netlist does not say it — the capacitor is tied to the
 *    power net, not to the single pin — so the nearest free power pin of
 *    the chip it serves is chosen.
 * 2. Nearby, similar parts stay ALIGNED. Four capacitors in a row must have
 *    the same ordinate, not four ordinates that differ by a tenth: it is
 *    what makes a board readable, and readable means repairable.
 * 3. Positions sit on a regular GRID. A half-millimeter grid aligns on its
 *    own what the eye expects to be aligned.
 */

/** the nearest power pad a capacitor can lean against */
interface PowerPad {
  ownerId: string;
  x: number;
  y: number;
  hw: number;
  hh: number;
  /** how many capacitors have already been assigned to it */
  taken: number;
}

const POWER_NET = /^(v|p\d|3v3|5v|vbat|vcc|vdd|vin|vout|vbus|vsys)/i;


/**
 * Which power pin each capacitor is connected to, read from the schematic's
 * real wire. It is the information that makes it possible to put a capacitor
 * where it belongs instead of where it happens to be, and it only holds if
 * whoever wrote the schematic connected the capacitor to the PIN and not to
 * the net.
 */
function wiredPowerPads(
  circuitJson: unknown[],
  items: Item[],
  tags?: Map<string, string>,
): { padOfCapacitor: Map<string, PowerPad>; powerPads: Map<string, PowerPad[]> } {
  const elements = circuitJson as El[];
  const byId = new Map(items.map((it) => [it.id, it]));

  const netNames = new Map<string, string>();
  for (const el of elements) {
    if (el.type === "source_net" && el.source_net_id) {
      netNames.set(String(el.source_net_id), String(el.name ?? ""));
    }
  }
  const netOfPort = new Map<string, string>();
  for (const el of elements) {
    if (el.type !== "source_trace") continue;
    const nets = ((el.connected_source_net_ids as string[] | undefined) ?? [])
      .map((id) => netNames.get(id))
      .filter((n): n is string => Boolean(n));
    const power = nets.find((n) => POWER_NET.test(n));
    if (!power) continue;
    for (const p of (el.connected_source_port_ids as string[] | undefined) ?? []) {
      netOfPort.set(String(p), power);
    }
  }
  /*
   * Power also propagates from pin to pin. A second microphone powered by
   * the first — .U4 > .VDD connected to .U3 > .VDD, with only that touching
   * the MIC_3V3 net — has a power pin in every respect, but looking only at
   * the traces that name a net you would not see it. Result: that
   * microphone's capacitor was left without an anchor and ended up far from
   * the part it must supply.
   */
  let grew = true;
  while (grew) {
    grew = false;
    for (const el of elements) {
      if (el.type !== "source_trace") continue;
      const ports = ((el.connected_source_port_ids as string[] | undefined) ?? []).map(String);
      const known = ports.find((p) => netOfPort.has(p));
      if (!known) continue;
      const net = netOfPort.get(known)!;
      for (const p of ports) {
        if (!netOfPort.has(p)) {
          netOfPort.set(p, net);
          grew = true;
        }
      }
    }
  }

  const pcbPortOfSource = new Map<string, string>();
  for (const el of elements) {
    if (el.type !== "pcb_port" || !el.source_port_id) continue;
    pcbPortOfSource.set(String(el.source_port_id), String(el.pcb_port_id ?? ""));
  }
  const powerPortIds = new Set(
    [...netOfPort.keys()].map((src) => pcbPortOfSource.get(src) ?? ""),
  );

  const powerPads = new Map<string, PowerPad[]>();
  const padByPortId = new Map<string, PowerPad>();
  for (const el of elements) {
    if (el.type !== "pcb_smtpad" && el.type !== "pcb_plated_hole") continue;
    const owner = String(el.pcb_component_id ?? "");
    const item = byId.get(owner);
    if (!item || !isChip(item, tags)) continue;
    const portId = String(el.pcb_port_id ?? "");
    if (!powerPortIds.has(portId)) continue;
    const x = num(el.x);
    const y = num(el.y);
    if (x === null || y === null) continue;
    const radius = num(el.radius);
    const w = num(el.width) ?? num(el.outer_width) ?? (radius ?? 0) * 2;
    const h = num(el.height) ?? num(el.outer_height) ?? (radius ?? 0) * 2;
    const pad: PowerPad = { ownerId: owner, x, y, hw: w / 2, hh: h / 2, taken: 0 };
    powerPads.set(owner, [...(powerPads.get(owner) ?? []), pad]);
    padByPortId.set(portId, pad);
  }

  const ownerOfPcbPort = new Map<string, string>();
  for (const el of elements) {
    if (el.type !== "pcb_port" || !el.pcb_port_id) continue;
    ownerOfPcbPort.set(String(el.pcb_port_id), String(el.pcb_component_id ?? ""));
  }
  const padOfCapacitor = new Map<string, PowerPad>();
  for (const el of elements) {
    if (el.type !== "source_trace") continue;
    const ports = (el.connected_source_port_ids as string[] | undefined) ?? [];
    if (ports.length !== 2) continue;
    const pcbPorts = ports.map((p) => pcbPortOfSource.get(String(p)) ?? "");
    for (const [a, b] of [
      [0, 1],
      [1, 0],
    ]) {
      const pad = padByPortId.get(pcbPorts[b]);
      const cap = byId.get(ownerOfPcbPort.get(pcbPorts[a]) ?? "");
      if (pad && cap && !padOfCapacitor.has(cap.name)) padOfCapacitor.set(cap.name, pad);
    }
  }
  return { padOfCapacitor, powerPads };
}

/**
 * Brings every decoupling capacitor close to the power pin it serves. It
 * moves ONLY if the score does not worsen: a capacitor attached to the right
 * pin but overlapping something is not progress.
 */
function pullDecouplingToPins(
  circuitJson: unknown[],
  items: Item[],
  links: Map<string, number>,
  ctx: {
    clearance: number;
    board: { x: number; y: number; w: number; h: number } | null;
    margin: number;
  },
): number {
  const elements = circuitJson as El[];
  const byId = new Map(items.map((it) => [it.id, it]));

  // net of every pad, to recognize the power pins
  const netOfPort = new Map<string, string>();
  const netNames = new Map<string, string>();
  for (const el of elements) {
    if (el.type === "source_net" && el.source_net_id) {
      netNames.set(String(el.source_net_id), String(el.name ?? ""));
    }
  }
  for (const el of elements) {
    if (el.type !== "source_trace") continue;
    const nets = ((el.connected_source_net_ids as string[] | undefined) ?? [])
      .map((id) => netNames.get(id))
      .filter((n): n is string => Boolean(n));
    const power = nets.find((n) => POWER_NET.test(n));
    if (!power) continue;
    for (const p of (el.connected_source_port_ids as string[] | undefined) ?? []) {
      netOfPort.set(String(p), power);
    }
  }
  const pcbPortOfSource = new Map<string, string>();
  for (const el of elements) {
    if (el.type !== "pcb_port" || !el.source_port_id) continue;
    pcbPortOfSource.set(String(el.source_port_id), String(el.pcb_port_id ?? ""));
  }

  // the chips' power pads, the ones a capacitor leans against
  const powerPads = new Map<string, PowerPad[]>();
  for (const el of elements) {
    if (el.type !== "pcb_smtpad" && el.type !== "pcb_plated_hole") continue;
    const owner = String(el.pcb_component_id ?? "");
    const item = byId.get(owner);
    if (!item || !isChip(item)) continue; // only the actives
    const portId = String(el.pcb_port_id ?? "");
    const isPower = [...pcbPortOfSource.entries()].some(
      ([src, pcb]) => pcb === portId && netOfPort.has(src),
    );
    if (!isPower) continue;
    const x = num(el.x);
    const y = num(el.y);
    if (x === null || y === null) continue;
    const radius = num(el.radius);
    const w = num(el.width) ?? num(el.outer_width) ?? (radius ?? 0) * 2;
    const h = num(el.height) ?? num(el.outer_height) ?? (radius ?? 0) * 2;
    const list = powerPads.get(owner) ?? [];
    list.push({ ownerId: owner, x, y, hw: w / 2, hh: h / 2, taken: 0 });
    powerPads.set(owner, list);
  }
  if (powerPads.size === 0) return 0;

  const roles = new Map<string, string>();
  for (const el of elements) {
    if (el.type !== "source_component") continue;
    roles.set(String(el.name ?? ""), String(el.ftype ?? ""));
  }

  /*
   * Which PIN each capacitor is connected to, taken from the real wire.
   *
   * Before, the chip's nearest power pin was chosen. It is wrong twice: it
   * ignores what the schematic says — if someone wrote that C1 feeds VDD1,
   * C1 goes on VDD1 — and in practice it misses, because the capacitor
   * starts from where the solver left it and "nearest" is an accident of
   * that position. Measured on bat-bs: C1, connected to VDD1, ended up 23mm
   * from VDD1 and 4mm from VDD2.
   */
  const padOfCapacitor = new Map<string, PowerPad>();
  const padByPortId = new Map<string, PowerPad>();
  for (const el of elements) {
    if (el.type !== "pcb_smtpad" && el.type !== "pcb_plated_hole") continue;
    const owner = String(el.pcb_component_id ?? "");
    const list = powerPads.get(owner);
    if (!list) continue;
    const x = num(el.x);
    const y = num(el.y);
    const found = list.find((p) => p.x === x && p.y === y);
    if (found) padByPortId.set(String(el.pcb_port_id ?? ""), found);
  }
  const ownerOfPcbPort = new Map<string, string>();
  for (const el of elements) {
    if (el.type !== "pcb_port" || !el.pcb_port_id) continue;
    ownerOfPcbPort.set(String(el.pcb_port_id), String(el.pcb_component_id ?? ""));
  }
  for (const el of elements) {
    if (el.type !== "source_trace") continue;
    const ports = (el.connected_source_port_ids as string[] | undefined) ?? [];
    if (ports.length !== 2) continue;
    const pcbPorts = ports.map((p) => pcbPortOfSource.get(String(p)) ?? "");
    for (const [a, b] of [
      [0, 1],
      [1, 0],
    ]) {
      const pad = padByPortId.get(pcbPorts[b]);
      const capId = ownerOfPcbPort.get(pcbPorts[a]);
      if (!pad || !capId) continue;
      const cap = byId.get(capId);
      if (cap && !padOfCapacitor.has(cap.name)) padOfCapacitor.set(cap.name, pad);
    }
  }

  const index = new Map(items.map((it, i) => [it.id, i]));
  let moved = 0;
  let bestScore = score(items, links, ctx.clearance, ctx.board, ctx.margin);

  for (const item of items) {
    if (item.locked) continue;
    if (roles.get(item.name) !== "simple_capacitor") continue;
    // the chip this capacitor serves: the one it is connected to
    const self = index.get(item.id)!;
    let chipId: string | null = null;
    let chipDistance = Infinity;
    for (const [key] of links) {
      const [i, j] = key.split(":").map(Number);
      const other = i === self ? j : j === self ? i : -1;
      if (other < 0) continue;
      if (!powerPads.has(items[other].id)) continue;
      // among the chips it is connected to, the nearest one: a capacitor on
      // P3V3 is connected to every powered chip, but it serves only one
      const d = Math.hypot(items[other].x - item.x, items[other].y - item.y);
      if (d < chipDistance) {
        chipDistance = d;
        chipId = items[other].id;
      }
    }
    const pads = chipId ? powerPads.get(chipId) : null;
    if (!pads || pads.length === 0) continue;

    /*
     * The pin this capacitor is REALLY connected to, if the schematic says
     * so. Only when it does not — a capacitor hung on the net instead of on
     * the pin — do we fall back on the nearest free pin, which is a guess
     * but better than nothing.
     */
    const wired = padOfCapacitor.get(item.name);
    if (!wired) {
      pads.sort(
        (a, b) =>
          a.taken - b.taken ||
          Math.hypot(a.x - item.x, a.y - item.y) - Math.hypot(b.x - item.x, b.y - item.y),
      );
    }
    const pad = wired ?? pads[0];
    const wasX = item.x;
    const wasY = item.y;

    /*
     * Where it goes. Not flush against the pad: a capacitor resting on a
     * QFP's pin bumps into the two neighbouring pins, and indeed none of
     * those positions was ever accepted. It goes where a person would put
     * it: just OUTSIDE the chip's outline, on the side that pin comes out
     * of, and in line with it. This way the connection is a short straight
     * stretch, which is all that matters for a decoupling.
     */
    const chip = byId.get(chipId!)!;
    const half = Math.max(item.left, item.right, item.top, item.bottom);
    const gap = ctx.clearance + half;
    const dx = pad.x - chip.x;
    const dy = pad.y - chip.y;
    const spots =
      Math.abs(dx) >= Math.abs(dy)
        ? [
            // the pin faces right or left: the exit is sideways
            { x: chip.x + (dx >= 0 ? chip.cRight + gap : -chip.cLeft - gap), y: pad.y },
            { x: chip.x + (dx >= 0 ? chip.cRight + gap : -chip.cLeft - gap) + (dx >= 0 ? half : -half), y: pad.y },
          ]
        : [
            { x: pad.x, y: chip.y + (dy >= 0 ? chip.cTop + gap : -chip.cBottom - gap) },
            { x: pad.x, y: chip.y + (dy >= 0 ? chip.cTop + gap : -chip.cBottom - gap) + (dy >= 0 ? half : -half) },
          ];
    let placed = false;
    for (const spot of spots) {
      item.x = snap(spot.x);
      item.y = snap(spot.y);
      const now = score(items, links, ctx.clearance, ctx.board, ctx.margin);
      /*
       * We ONLY check that no violations are born. Demanding that the
       * estimated copper not grow as well means moving almost no capacitor:
       * bringing it closer to its pin moves it away from everything else it
       * is connected to (ground, first of all) and the estimate always gets
       * worse. But for a decoupling, closeness to the pin is not a trade-off
       * to be weighed: it is the reason that component exists.
       */
      if (now.violations <= bestScore.violations) {
        bestScore = now;
        placed = true;
        pad.taken += 1;
        moved += 1;
        break;
      }
    }
    if (!placed) {
      item.x = wasX;
      item.y = wasY;
    }
  }
  return moved;
}

/**
 * Aligns nearby, similarly-sized parts on the same row or column. It works
 * in bands: whatever sits within half a millimeter of the others takes the
 * group's median ordinate. Only if the score does not worsen.
 */
function alignNeighbours(
  items: Item[],
  links: Map<string, number>,
  ctx: {
    clearance: number;
    board: { x: number; y: number; w: number; h: number } | null;
    margin: number;
  },
  toleranceMm = 0.8,
): number {
  let aligned = 0;
  let bestScore = score(items, links, ctx.clearance, ctx.board, ctx.margin);

  for (const axis of ["y", "x"] as const) {
    const other = axis === "y" ? "x" : "y";
    const free = items.filter((it) => !it.locked);
    const used = new Set<Item>();
    for (const anchor of free) {
      if (used.has(anchor)) continue;
      const band = free.filter(
        (it) =>
          !used.has(it) &&
          Math.abs(it[axis] - anchor[axis]) <= toleranceMm &&
          Math.abs(it[other] - anchor[other]) < 25 &&
          Math.abs((it.left + it.right) - (anchor.left + anchor.right)) < 1.5,
      );
      if (band.length < 2) continue;
      const target = snap(
        band.map((it) => it[axis]).sort((a, b) => a - b)[Math.floor(band.length / 2)],
      );
      const was = band.map((it) => it[axis]);
      for (const it of band) it[axis] = target;
      const now = score(items, links, ctx.clearance, ctx.board, ctx.margin);
      if (now.violations <= bestScore.violations) {
        bestScore = now;
        aligned += band.length;
        for (const it of band) used.add(it);
      } else {
        band.forEach((it, i) => {
          it[axis] = was[i];
        });
      }
    }
  }
  return aligned;
}

/**
 * MAGNET TOWARD THE PINS OF THE SAME NET.
 *
 * Every movable part is pulled where its own pins want to go: for each of its
 * pads, the nearest pad of the same net that is NOT its own becomes a small
 * force, and the sum of those forces is the direction the part takes. One step
 * at a time, and the step is taken only if it opens no violation — no overlap,
 * no courtyard touching, nothing off the board or out of its zone.
 *
 * Toward the PINS, not toward the bodies: what gets routed is pad to pad. A
 * capacitor whose centre sits 2mm from the chip's centre but whose pin faces the
 * other way has a long trace anyway; moving it so that its pin looks at the
 * chip's pin shortens exactly the copper that will be laid.
 *
 * Ground is excluded on purpose: it is poured, not routed, so pulling parts
 * toward the fifty pads of ground would only drag everything to the middle of
 * the board — the same barycentre collapse the force-directed solver produces
 * when nobody stops it.
 */
function magnetToPins(
  items: Item[],
  ctx: { clearance: number; board: { x: number; y: number; w: number; h: number } | null; margin: number },
  opts: { passes?: number; step?: number; skipNets?: Set<string> } = {},
): number {
  const passes = opts.passes ?? 60;
  const step = opts.step ?? 0.25;
  const skip = opts.skipNets ?? new Set<string>();

  /** every pad on the board in absolute coordinates, grouped by net */
  const perNet = new Map<string, Array<{ owner: number; x: number; y: number }>>();
  const rebuild = () => {
    perNet.clear();
    for (let i = 0; i < items.length; i++) {
      for (const p of items[i].pads) {
        if (!p.net || skip.has(p.net)) continue;
        const list = perNet.get(p.net) ?? [];
        list.push({ owner: i, x: items[i].x + p.dx, y: items[i].y + p.dy });
        perNet.set(p.net, list);
      }
    }
  };

  let mosse = 0;
  for (let pass = 0; pass < passes; pass++) {
    rebuild();
    let cambiato = false;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.locked) continue;
      let fx = 0;
      let fy = 0;
      let n = 0;
      for (const p of it.pads) {
        if (!p.net || skip.has(p.net)) continue;
        const altri = perNet.get(p.net);
        if (!altri) continue;
        const px = it.x + p.dx;
        const py = it.y + p.dy;
        let best: { x: number; y: number; d: number } | null = null;
        for (const q of altri) {
          if (q.owner === i) continue;
          const d = Math.hypot(q.x - px, q.y - py);
          if (!best || d < best.d) best = { x: q.x, y: q.y, d };
        }
        if (!best || best.d < 1e-6) continue;
        // unit vector: every pin pulls with the same strength, so a part with
        // many pins is not dragged by whichever net happens to be furthest
        fx += (best.x - px) / best.d;
        fy += (best.y - py) / best.d;
        n++;
      }
      if (n === 0) continue;

      /*
       * FIRST it orients. Of the four right-angle positions it keeps the one
       * where the pins pull least — that is, the one where its pads are closest
       * to the pads of their own net — and only if it costs nothing: no overlap,
       * inside the board, inside its own zone. A magnet turns before it moves.
       */
      let tensione = tensioneDeiPiedini(items, i, perNet, skip);
      for (const giro of [90, 180, 270]) {
        ruotaItem(it, giro);
        const nuova = tensioneDeiPiedini(items, i, perNet, skip);
        const legale =
          violationsOf(items, i, ctx.clearance).length === 0 &&
          insideBoard(it, ctx.board, ctx.margin) &&
          insideZone(it);
        if (legale && nuova < tensione - 1e-6) {
          tensione = nuova;
          mosse++;
          cambiato = true;
          break;
        }
        // not good: put it back where it was and try the next quarter turn
        ruotaItem(it, 360 - giro);
      }

      const len = Math.hypot(fx, fy);
      if (len < 1e-6) continue;
      const oldX = it.x;
      const oldY = it.y;
      it.x = oldX + (fx / len) * step;
      it.y = oldY + (fy / len) * step;
      // the step must not cost anything: no overlap, inside the board, inside
      // its own zone if it has one
      const legale =
        violationsOf(items, i, ctx.clearance).length === 0 &&
        insideBoard(it, ctx.board, ctx.margin) &&
        insideZone(it);
      if (legale) {
        cambiato = true;
        mosse++;
      } else {
        it.x = oldX;
        it.y = oldY;
      }
    }
    if (!cambiato) break;
  }
  return mosse;
}

/** violations involving ONE item: the magnet checks its own step, not the board */
function violationsOf(items: Item[], index: number, clearance: number): PlacementViolation[] {
  const out: PlacementViolation[] = [];
  const a = items[index];
  for (let j = 0; j < items.length; j++) {
    if (j === index) continue;
    const b = items[j];
    if (!canCollide(a, b)) continue;
    const gapX = Math.max(a.x - a.cLeft - (b.x + b.cRight), b.x - b.cLeft - (a.x + a.cRight));
    const gapY = Math.max(a.y - a.cBottom - (b.y + b.cTop), b.y - b.cBottom - (a.y + a.cTop));
    if (gapX < 0 && gapY < 0) {
      out.push({ a: a.name, b: b.name, gapMm: Math.max(gapX, gapY), x: a.x, y: a.y });
      continue;
    }
    for (const pa of a.pads) {
      for (const pb of b.pads) {
        if (pa.layer !== "*" && pb.layer !== "*" && pa.layer !== pb.layer) continue;
        const dx = Math.abs(a.x + pa.dx - (b.x + pb.dx)) - (pa.hw + pb.hw);
        const dy = Math.abs(a.y + pa.dy - (b.y + pb.dy)) - (pa.hh + pb.hh);
        const gap = Math.max(dx, dy);
        if (gap < clearance) {
          out.push({ a: a.name, b: b.name, gapMm: gap, x: a.x + pa.dx, y: a.y + pa.dy });
          return out;
        }
      }
    }
  }
  return out;
}

const insideBoard = (
  it: Item,
  board: { x: number; y: number; w: number; h: number } | null,
  margin: number,
): boolean => {
  if (!board) return true;
  return (
    it.x - it.left >= board.x - board.w / 2 + margin &&
    it.x + it.right <= board.x + board.w / 2 - margin &&
    it.y - it.bottom >= board.y - board.h / 2 + margin &&
    it.y + it.top <= board.y + board.h / 2 - margin
  );
};

/**
 * Turns a part by a multiple of 90 degrees: its pads travel around its centre
 * and its extents swap sides. Everything else in here reasons about the centre,
 * so this is all it takes for the whole rest — separation, checks, squeeze — to
 * see the turned piece.
 *
 * Multiples of 90 only: on a board nobody mounts a resistor at 37 degrees, and
 * with right angles a rectangle stays a rectangle, which is what keeps the
 * collision arithmetic exact.
 */
function ruotaItem(it: Item, gradi: number): void {
  const g = ((Math.round(gradi / 90) * 90) % 360 + 360) % 360;
  if (g === 0) return;
  const passi = g / 90;
  for (let k = 0; k < passi; k++) {
    for (const p of it.pads) {
      const dx = p.dx;
      const dy = p.dy;
      // 90 degrees counterclockwise: (x, y) -> (-y, x)
      p.dx = -dy;
      p.dy = dx;
      const hw = p.hw;
      p.hw = p.hh;
      p.hh = hw;
    }
    const { left, right, top, bottom, cLeft, cRight, cTop, cBottom } = it;
    it.left = bottom;
    it.bottom = right;
    it.right = top;
    it.top = left;
    it.cLeft = cBottom;
    it.cBottom = cRight;
    it.cRight = cTop;
    it.cTop = cLeft;
  }
  it.rot = (it.rot + g) % 360;
}

/** how hard the pins pull: the sum of the distances to the nearest pad of the same net */
function tensioneDeiPiedini(
  items: Item[],
  index: number,
  perNet: Map<string, Array<{ owner: number; x: number; y: number }>>,
  skip: Set<string>,
): number {
  const it = items[index];
  let somma = 0;
  for (const p of it.pads) {
    if (!p.net || skip.has(p.net)) continue;
    const altri = perNet.get(p.net);
    if (!altri) continue;
    const px = it.x + p.dx;
    const py = it.y + p.dy;
    let best = Infinity;
    for (const q of altri) {
      if (q.owner === index) continue;
      const d = Math.hypot(q.x - px, q.y - py);
      if (d < best) best = d;
    }
    if (Number.isFinite(best)) somma += best;
  }
  return somma;
}

const insideZone = (it: Item): boolean =>
  !it.zone ||
  (it.x >= it.zone.minX && it.x <= it.zone.maxX && it.y >= it.zone.minY && it.y <= it.zone.maxY);

/**
 * Brings positions onto a regular grid. A coarse grid aligns on its own what
 * the eye expects to be aligned; it is accepted only if it opens no
 * violations, otherwise we stay on the fine grid.
 */
function snapToCoarseGrid(
  items: Item[],
  links: Map<string, number>,
  ctx: {
    clearance: number;
    board: { x: number; y: number; w: number; h: number } | null;
    margin: number;
  },
  gridMm: number,
): number {
  if (gridMm <= GRID) return 0;
  let snapped = 0;
  let bestScore = score(items, links, ctx.clearance, ctx.board, ctx.margin);
  for (const it of items) {
    if (it.locked) continue;
    const wasX = it.x;
    const wasY = it.y;
    const nx = Math.round(it.x / gridMm) * gridMm;
    const ny = Math.round(it.y / gridMm) * gridMm;
    if (nx === wasX && ny === wasY) continue;
    it.x = nx;
    it.y = ny;
    const now = score(items, links, ctx.clearance, ctx.board, ctx.margin);
    if (now.violations <= bestScore.violations) {
      bestScore = now;
      snapped += 1;
    } else {
      it.x = wasX;
      it.y = wasY;
    }
  }
  return snapped;
}

// ---------------------------------------------------------------------------
// Constructive placement: one block at a time
// ---------------------------------------------------------------------------

/**
 * How a board is placed, according to Niccolo' (2026-07-27) and according to
 * anyone who has ever drawn one by hand: you start from the largest block —
 * the microcontroller with its capacitors and its resistors — you settle it,
 * and then you attach the smaller blocks around it, each time taking the one
 * most tied to what is already in place.
 *
 * It is the opposite of what the solver used to do: starting from all the
 * parts together and hoping the forces would separate them. That way every
 * part found its place by accident, and a capacitor ended up twenty
 * millimeters from the pin it must stabilize because, when its turn came,
 * the right spot was already taken by someone else.
 *
 * Here the order IS the design: what counts most is served first, what has
 * fewer constraints adapts. And what is already placed is never touched
 * again — otherwise it would not be an order, it would be a scrum again.
 */
export interface BlockPlan {
  block: string;
  /** the block's parts, the chip first */
  members: number[];
  /** total area, in mm² */
  areaMm2: number;
  /** the index of the chip around which it is built, if any */
  chip: number | null;
}

/** the blocks, each with its chip inside and the parts orbiting it */
function planBlocks(
  items: Item[],
  blocks: Map<string, string> | undefined,
  tags: Map<string, string> | undefined,
): BlockPlan[] {
  const byBlock = new Map<string, number[]>();
  items.forEach((it, i) => {
    // without a declared section every part is a block of its own: better a
    // solitary block than putting it in someone else's pile
    const name = blocks?.get(it.name) ?? `~${it.name}`;
    byBlock.set(name, [...(byBlock.get(name) ?? []), i]);
  });

  return [...byBlock]
    .map(([block, members]) => {
      const chips = members.filter((i) => isChip(items[i], tags));
      const chip = chips.length
        ? chips.reduce((best, i) =>
            items[i].pads.length > items[best].pads.length ? i : best,
          )
        : null;
      const areaMm2 = members.reduce(
        (sum, i) => sum + (items[i].left + items[i].right) * (items[i].bottom + items[i].top),
        0,
      );
      return { block, members, areaMm2, chip };
    })
    .sort((a, b) => b.areaMm2 - a.areaMm2);
}

/**
 * Settles a block's parts around its chip: first the capacitors on the pin
 * they are connected to, then everything else in a ring, and each part stops
 * in the first spot that does not quarrel with what is already there.
 */
function layoutBlock(
  plan: BlockPlan,
  items: Item[],
  settled: Set<number>,
  padOfCapacitor: Map<string, PowerPad>,
  clearance: number,
  board: { x: number; y: number; w: number; h: number } | null,
  margin: number,
): void {
  const anchor = plan.chip !== null ? items[plan.chip] : items[plan.members[0]];
  const free = (i: number, x: number, y: number): boolean => {
    const it = items[i];
    const px = it.x;
    const py = it.y;
    it.x = x;
    it.y = y;
    let ok = true;
    for (const other of settled) {
      if (other === i) continue;
      const a = items[other];
      if (!canCollide(a, it)) continue;
      const gapX = Math.max(a.x - a.left - (it.x + it.right), it.x - it.left - (a.x + a.right));
      const gapY = Math.max(a.y - a.bottom - (it.y + it.top), it.y - it.bottom - (a.y + a.top));
      if (gapX < clearance && gapY < clearance) {
        ok = false;
        break;
      }
    }
    if (ok && board) {
      const inside =
        it.x - it.left >= board.x - board.w / 2 + margin &&
        it.x + it.right <= board.x + board.w / 2 - margin &&
        it.y - it.bottom >= board.y - board.h / 2 + margin &&
        it.y + it.top <= board.y + board.h / 2 - margin;
      if (!inside && !it.locked) ok = false;
    }
    if (!ok) {
      it.x = px;
      it.y = py;
    }
    return ok;
  };

  // 1. the chip: it stays where it is if it fits, otherwise it moves a little
  if (plan.chip !== null && !items[plan.chip].locked) {
    const chip = items[plan.chip];
    if (!free(plan.chip, chip.x, chip.y)) {
      for (let ring = 1; ring <= 40 && !free(plan.chip, chip.x, chip.y); ring++) {
        const d = ring * 0.5;
        const spots = [
          { x: chip.x + d, y: chip.y },
          { x: chip.x - d, y: chip.y },
          { x: chip.x, y: chip.y + d },
          { x: chip.x, y: chip.y - d },
        ];
        if (spots.some((s) => free(plan.chip!, snap(s.x), snap(s.y)))) break;
      }
    }
  }
  if (plan.chip !== null) settled.add(plan.chip);

  // 2. the capacitors on the pin they are connected to: it is the block's
  //    tightest constraint, so it is served first
  const chip = plan.chip !== null ? items[plan.chip] : null;
  const rest: number[] = [];
  for (const i of plan.members) {
    if (i === plan.chip) continue;
    const it = items[i];
    const pad = padOfCapacitor.get(it.name);
    if (!pad || !chip) {
      rest.push(i);
      continue;
    }
    const half = Math.max(it.left, it.right, it.top, it.bottom);
    const gap = clearance + half;
    const dx = pad.x - chip.x;
    const dy = pad.y - chip.y;
    // outside the chip's outline, on the pin's side and in line with it;
    // if taken, slide along that side, never changing sides
    const along = Math.abs(dx) >= Math.abs(dy) ? "y" : "x";
    const fixed =
      along === "y"
        ? chip.x + (dx >= 0 ? chip.cRight + gap : -chip.cLeft - gap)
        : chip.y + (dy >= 0 ? chip.cTop + gap : -chip.cBottom - gap);
    /*
     * The right spot is one: in line with the pin, just outside the chip.
     * If it is taken — it happens with the second capacitor on the same
     * pin — we try the OPPOSITE side of the chip FIRST, which is still in
     * line with that pin and therefore still short, and only afterwards do
     * we slide along the flank. Sliding and nothing else is what used to
     * take the second capacitor ten millimeters away: it always found a
     * free spot, but a faraway one.
     */
    const opposite =
      along === "y"
        ? chip.x + (dx >= 0 ? -chip.cLeft - gap : chip.cRight + gap)
        : chip.y + (dy >= 0 ? -chip.cBottom - gap : chip.cTop + gap);
    let done = false;
    const spots: Array<{ x: number; y: number }> = [
      along === "y" ? { x: fixed, y: pad.y } : { x: pad.x, y: fixed },
      along === "y" ? { x: opposite, y: pad.y } : { x: pad.x, y: opposite },
    ];
    for (const spot of spots) {
      if (free(i, snap(spot.x), snap(spot.y))) {
        done = true;
        break;
      }
    }
    for (let step = 1; step <= 24 && !done; step++) {
      for (const dir of [1, -1]) {
        const slide = dir * step * 0.5;
        const x = along === "y" ? fixed : pad.x + slide;
        const y = along === "y" ? pad.y + slide : fixed;
        if (free(i, snap(x), snap(y))) {
          done = true;
          break;
        }
      }
    }
    if (!done) rest.push(i);
    else settled.add(i);
  }

  // 3. the rest of the block, in rings around the anchor
  for (const i of rest) {
    if (items[i].locked) {
      settled.add(i);
      continue;
    }
    const it = items[i];
    let done = free(i, it.x, it.y);
    for (let ring = 1; ring <= 60 && !done; ring++) {
      const d = ring * 0.5;
      for (let a = 0; a < 12 && !done; a++) {
        const angle = (a / 12) * Math.PI * 2;
        done = free(i, snap(anchor.x + Math.cos(angle) * d), snap(anchor.y + Math.sin(angle) * d));
      }
    }
    settled.add(i);
  }
}
