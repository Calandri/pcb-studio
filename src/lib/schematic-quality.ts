/**
 * SCHEMATIC quality: deterministic checks on the drawing, twins of drc.ts
 * (manufacturability) and prc.ts (electrical behavior). Here we measure
 * whether the drawing is READABLE: overlapping symbols, net labels printed
 * over symbols, crossings, sheet density, functional sections used.
 *
 * Needed because the model only optimizes what it measures: without these
 * metrics it saw rich geometric feedback on the PCB and nothing on the
 * schematic, so it produced unreadable schematics without noticing.
 *
 * The schematic layout is done entirely by @tscircuit/core: if even a single
 * component of a group has schX/schY, the group switches to "relative" mode
 * and everything else ends up piled on the origin. Hence the check on the
 * sources: schSectionName and schX/schY do not end up in the Circuit JSON, so
 * they must be read from the project code.
 *
 * LLM-first: nothing is fixed here, we produce data for the model's
 * self-correction loop.
 */

export type SchematicRule =
  | "symbol_overlap"
  | "sch_coords_in_source"
  | "sections_with_groups"
  | "no_sections"
  | "label_over_symbol"
  | "trace_crossings"
  | "sheet_overflow"
  | "sheet_too_sparse";

export interface SchematicIssue {
  rule: SchematicRule;
  severity: "warn" | "fail";
  message: string;
}

export interface SchOverlapPair {
  a: string;
  b: string;
  /** intersection area in schematic units squared */
  areaSu2: number;
  x: number;
  y: number;
}

export interface SchLabelCollision {
  label: string;
  component: string;
  x: number;
  y: number;
}

export interface SchLongTrace {
  name: string;
  lengthSu: number;
  from: { x: number; y: number };
  to: { x: number; y: number };
}

export interface SchematicQuality {
  symbols: number;
  /** pairs of overlapping symbols, the 8 worst by area */
  symbolOverlaps: SchOverlapPair[];
  symbolOverlapCount: number;
  /** pairs not overlapping but closer than CROWD_GAP_SU */
  crowdedPairs: number;
  /** net labels drawn over a symbol, max 8 */
  labelOverlaps: SchLabelCollision[];
  labelOverlapCount: number;
  /** crossings between wires (renderer is_crossing flag, otherwise estimated) */
  traceCrossings: number;
  crossingsEstimated: boolean;
  sheet: {
    widthSu: number;
    heightSu: number;
    /** symbol area / bounding box area: how full the sheet is */
    density: number;
    fitsA4: boolean;
  };
  /** functional sections declared with schSectionName in the sources */
  sections: string[];
  /** sections that also have a <schematicsection> frame */
  sectionsWithFrames: string[];
  /** files that put schX/schY on placed components (disables the auto layout) */
  schCoordFiles: string[];
  /** longest wires: the candidates to become net labels, max 5 */
  longestTraces: SchLongTrace[];
  issues: SchematicIssue[];
}

interface El {
  type: string;
  [key: string]: unknown;
}

interface Box {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  label: string;
}

type Sources = Record<string, string>;

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

const round2 = (v: number): number => Math.round(v * 100) / 100;
const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/** minimum area for an overlap to count as one */
const OVERLAP_MIN_AREA_SU2 = 1e-4;
/** below this distance two symbols are "stuck together" without overlapping */
const CROWD_GAP_SU = 0.05;
/** symbols are shrunk by this much before the label test (pin stubs) */
const LABEL_TOLERANCE_SU = 0.02;

// Upstream renderer constants (@tscircuit/circuit-json-util): needed to
// rebuild the box of a net label without importing the package.
const LABEL_CHAR_WIDTH_SU = 0.12;
const LABEL_PADDING_SU = 0.12;
const LABEL_HEIGHT_SU = 0.2;
const TRACE_HALF_WIDTH_SU = 0.05;

// Usable area of an A4 in schematic units: 297x210mm / 9.2364 mm-per-unit,
// minus the inner margin of 0.541 su per side used by the tscircuit sheet.
const A4_MAX_WIDTH_SU = 31.07;
const A4_MAX_HEIGHT_SU = 21.65;

const MAX_LIST = 8;

export function emptySchematicQuality(): SchematicQuality {
  return {
    symbols: 0,
    symbolOverlaps: [],
    symbolOverlapCount: 0,
    crowdedPairs: 0,
    labelOverlaps: [],
    labelOverlapCount: 0,
    traceCrossings: 0,
    crossingsEstimated: false,
    sheet: { widthSu: 0, heightSu: 0, density: 0, fitsA4: true },
    sections: [],
    sectionsWithFrames: [],
    schCoordFiles: [],
    longestTraces: [],
    issues: [],
  };
}

/**
 * `sources` is optional because schSectionName and schX/schY live only in the
 * project code: without sources the geometric metrics stay valid and the
 * sections simply come out as unknown.
 */
export function analyzeSchematic(
  circuitJson: El[],
  sources: Sources = {},
): SchematicQuality {
  const result = emptySchematicQuality();

  const sourceNames = new Map<string, string>();
  for (const el of circuitJson) {
    if (el.type === "source_component" && el.source_component_id) {
      sourceNames.set(String(el.source_component_id), String(el.name ?? ""));
    }
  }

  // --- symbol boxes
  const symbolBoxes: Box[] = [];
  for (const el of circuitJson) {
    if (el.type !== "schematic_component") continue;
    const center = (el.center as { x?: number; y?: number } | undefined) ?? {};
    const size = (el.size as { width?: number; height?: number } | undefined) ?? {};
    const cx = num(center.x);
    const cy = num(center.y);
    const w = num(size.width);
    const h = num(size.height);
    if (cx === null || cy === null || w === null || h === null) continue;
    const name =
      sourceNames.get(String(el.source_component_id ?? "")) ||
      String(el.schematic_component_id ?? "symbol");
    symbolBoxes.push({
      minX: cx - w / 2,
      maxX: cx + w / 2,
      minY: cy - h / 2,
      maxY: cy + h / 2,
      label: name,
    });
  }

  // Sections are read anyway: they also help explain a failed compile.
  const src = analyzeSources(sources);
  result.sections = src.sections;
  result.sectionsWithFrames = src.sectionsWithFrames;
  result.schCoordFiles = src.schCoordFiles;

  // A failed compile produces no symbols: better no data than false data.
  if (symbolBoxes.length === 0) {
    if (src.schCoordFiles.length > 0) {
      result.issues.push({
        rule: "sch_coords_in_source",
        severity: "warn",
        message: schCoordsMessage(src.schCoordFiles),
      });
    }
    return result;
  }
  result.symbols = symbolBoxes.length;

  // --- overlaps between symbols
  const overlaps: SchOverlapPair[] = [];
  let crowded = 0;
  for (let i = 0; i < symbolBoxes.length; i++) {
    for (let j = i + 1; j < symbolBoxes.length; j++) {
      const a = symbolBoxes[i];
      const b = symbolBoxes[j];
      const ix = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
      const iy = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
      if (ix > 0 && iy > 0) {
        const area = ix * iy;
        if (area <= OVERLAP_MIN_AREA_SU2) continue;
        overlaps.push({
          a: a.label,
          b: b.label,
          areaSu2: round3(area),
          x: round2((Math.max(a.minX, b.minX) + Math.min(a.maxX, b.maxX)) / 2),
          y: round2((Math.max(a.minY, b.minY) + Math.min(a.maxY, b.maxY)) / 2),
        });
      } else {
        const gapX = Math.max(a.minX - b.maxX, b.minX - a.maxX, 0);
        const gapY = Math.max(a.minY - b.maxY, b.minY - a.maxY, 0);
        if (Math.hypot(gapX, gapY) < CROWD_GAP_SU) crowded++;
      }
    }
  }
  overlaps.sort((x, y) => y.areaSu2 - x.areaSu2);
  result.symbolOverlapCount = overlaps.length;
  result.symbolOverlaps = overlaps.slice(0, MAX_LIST);
  result.crowdedPairs = crowded;

  // --- net labels over symbols
  const labelBoxes: Box[] = [];
  for (const el of circuitJson) {
    if (el.type !== "schematic_net_label") continue;
    const box = netLabelBox(el);
    if (box) labelBoxes.push(box);
  }
  const collisions: SchLabelCollision[] = [];
  for (const label of labelBoxes) {
    for (const symbol of symbolBoxes) {
      const ix =
        Math.min(label.maxX, symbol.maxX - LABEL_TOLERANCE_SU) -
        Math.max(label.minX, symbol.minX + LABEL_TOLERANCE_SU);
      const iy =
        Math.min(label.maxY, symbol.maxY - LABEL_TOLERANCE_SU) -
        Math.max(label.minY, symbol.minY + LABEL_TOLERANCE_SU);
      if (ix <= 0 || iy <= 0) continue;
      collisions.push({
        label: label.label,
        component: symbol.label,
        x: round2((label.minX + label.maxX) / 2),
        y: round2((label.minY + label.maxY) / 2),
      });
      break;
    }
  }
  result.labelOverlapCount = collisions.length;
  result.labelOverlaps = collisions.slice(0, MAX_LIST);

  // --- crossings and long wires
  const traces = analyzeTraces(circuitJson);
  result.traceCrossings = traces.crossings;
  result.crossingsEstimated = traces.estimated;
  result.longestTraces = traces.longest;

  // --- sheet bounding box
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let symbolArea = 0;
  const grow = (b: Box) => {
    minX = Math.min(minX, b.minX);
    maxX = Math.max(maxX, b.maxX);
    minY = Math.min(minY, b.minY);
    maxY = Math.max(maxY, b.maxY);
  };
  for (const b of symbolBoxes) {
    grow(b);
    symbolArea += (b.maxX - b.minX) * (b.maxY - b.minY);
  }
  for (const b of labelBoxes) grow(b);
  for (const p of traces.points) {
    minX = Math.min(minX, p.x - TRACE_HALF_WIDTH_SU);
    maxX = Math.max(maxX, p.x + TRACE_HALF_WIDTH_SU);
    minY = Math.min(minY, p.y - TRACE_HALF_WIDTH_SU);
    maxY = Math.max(maxY, p.y + TRACE_HALF_WIDTH_SU);
  }
  const widthSu = Number.isFinite(minX) ? maxX - minX : 0;
  const heightSu = Number.isFinite(minY) ? maxY - minY : 0;
  const sheetArea = widthSu * heightSu;
  result.sheet = {
    widthSu: round2(widthSu),
    heightSu: round2(heightSu),
    density: sheetArea > 0 ? round3(symbolArea / sheetArea) : 0,
    // a sheet is fine in portrait too: checking only landscape rejected
    // taller-than-wide drawings that fit an A4 perfectly well
    fitsA4:
      (widthSu <= A4_MAX_WIDTH_SU && heightSu <= A4_MAX_HEIGHT_SU) ||
      (widthSu <= A4_MAX_HEIGHT_SU && heightSu <= A4_MAX_WIDTH_SU),
  };

  result.issues = buildIssues(result, src);
  return result;
}

/** box of a net label, rebuilt with the upstream renderer constants */
function netLabelBox(el: El): Box | null {
  const text = String(el.text ?? "");
  const width = text.length * LABEL_CHAR_WIDTH_SU + LABEL_PADDING_SU;
  const anchor = (el.anchor_position as { x?: number; y?: number } | undefined) ?? {};
  const center = (el.center as { x?: number; y?: number } | undefined) ?? {};
  const side = String(el.anchor_side ?? "");
  const ax = num(anchor.x);
  const ay = num(anchor.y);

  if (ax === null || ay === null) {
    const cx = num(center.x);
    const cy = num(center.y);
    if (cx === null || cy === null) return null;
    const horizontal = side !== "top" && side !== "bottom" && side !== "up" && side !== "down";
    const w = horizontal ? width : LABEL_HEIGHT_SU;
    const h = horizontal ? LABEL_HEIGHT_SU : width;
    return {
      minX: cx - w / 2,
      maxX: cx + w / 2,
      minY: cy - h / 2,
      maxY: cy + h / 2,
      label: text,
    };
  }

  // The label grows from the anchor in the direction OPPOSITE to the anchored side.
  switch (side) {
    case "left":
      return { minX: ax, maxX: ax + width, minY: ay - LABEL_HEIGHT_SU / 2, maxY: ay + LABEL_HEIGHT_SU / 2, label: text };
    case "right":
      return { minX: ax - width, maxX: ax, minY: ay - LABEL_HEIGHT_SU / 2, maxY: ay + LABEL_HEIGHT_SU / 2, label: text };
    case "bottom":
    case "down":
      return { minX: ax - LABEL_HEIGHT_SU / 2, maxX: ax + LABEL_HEIGHT_SU / 2, minY: ay, maxY: ay + width, label: text };
    case "top":
    case "up":
      return { minX: ax - LABEL_HEIGHT_SU / 2, maxX: ax + LABEL_HEIGHT_SU / 2, minY: ay - width, maxY: ay, label: text };
    default:
      return { minX: ax - width / 2, maxX: ax + width / 2, minY: ay - LABEL_HEIGHT_SU / 2, maxY: ay + LABEL_HEIGHT_SU / 2, label: text };
  }
}

interface Seg {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  key: string;
}

function analyzeTraces(circuitJson: El[]): {
  crossings: number;
  estimated: boolean;
  longest: SchLongTrace[];
  points: Array<{ x: number; y: number }>;
} {
  const netNames = new Map<string, string>();
  for (const el of circuitJson) {
    if (el.type === "source_net" && el.source_net_id) {
      netNames.set(String(el.source_net_id), String(el.name ?? ""));
    }
  }
  const traceNetName = new Map<string, string>();
  for (const el of circuitJson) {
    if (el.type !== "source_trace" || !el.source_trace_id) continue;
    const nets = (el.connected_source_net_ids as string[] | undefined) ?? [];
    const name = nets.map((id) => netNames.get(id)).find(Boolean);
    if (name) traceNetName.set(String(el.source_trace_id), name);
  }

  const points: Array<{ x: number; y: number }> = [];
  const segs: Seg[] = [];
  const longest: SchLongTrace[] = [];
  let flagged = 0;

  for (const el of circuitJson) {
    if (el.type !== "schematic_trace") continue;
    const edges =
      (el.edges as
        | Array<{
            from?: { x?: number; y?: number };
            to?: { x?: number; y?: number };
            is_crossing?: boolean;
          }>
        | undefined) ?? [];
    const key = String(el.subcircuit_connectivity_map_key ?? el.source_trace_id ?? el.schematic_trace_id ?? "");
    let length = 0;
    let first: { x: number; y: number } | null = null;
    let last: { x: number; y: number } | null = null;
    for (const edge of edges) {
      const ax = num(edge.from?.x);
      const ay = num(edge.from?.y);
      const bx = num(edge.to?.x);
      const by = num(edge.to?.y);
      if (ax === null || ay === null || bx === null || by === null) continue;
      if (edge.is_crossing) {
        flagged++;
        continue;
      }
      points.push({ x: ax, y: ay }, { x: bx, y: by });
      segs.push({ ax, ay, bx, by, key });
      length += Math.hypot(bx - ax, by - ay);
      first ??= { x: ax, y: ay };
      last = { x: bx, y: by };
    }
    if (length > 0 && first && last) {
      longest.push({
        name:
          traceNetName.get(String(el.source_trace_id ?? "")) ??
          String(el.schematic_trace_id ?? "trace"),
        lengthSu: round2(length),
        from: { x: round2(first.x), y: round2(first.y) },
        to: { x: round2(last.x), y: round2(last.y) },
      });
    }
  }

  let crossings = flagged;
  let estimated = false;
  // The core already marks crossings with is_crossing; the geometric estimate
  // is only needed if that flag was never produced at all.
  if (crossings === 0 && segs.length > 1) {
    estimated = true;
    outer: for (let i = 0; i < segs.length; i++) {
      for (let j = i + 1; j < segs.length; j++) {
        if (segs[i].key && segs[i].key === segs[j].key) continue;
        if (segmentsCross(segs[i], segs[j])) crossings++;
        if (crossings >= 200) break outer;
      }
    }
  }

  longest.sort((a, b) => b.lengthSu - a.lengthSu);
  return { crossings, estimated, longest: longest.slice(0, 5), points };
}

function segmentsCross(a: Seg, b: Seg): boolean {
  const d1 = cross(b, a.ax, a.ay);
  const d2 = cross(b, a.bx, a.by);
  const d3 = cross(a, b.ax, b.ay);
  const d4 = cross(a, b.bx, b.by);
  return (
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  );
}

function cross(s: Seg, px: number, py: number): number {
  return (s.bx - s.ax) * (py - s.ay) - (s.by - s.ay) * (px - s.ax);
}

interface SourceFacts {
  sections: string[];
  sectionsWithFrames: string[];
  schCoordFiles: string[];
  mixedSectionsAndGroups: string[];
}

/**
 * schSectionName and schX/schY are not serialized into the Circuit JSON, so
 * the only source is the project sources. Files under lib/ are excluded:
 * library components may legitimately contain coordinates internal to their
 * own symbols.
 */
function analyzeSources(sources: Sources): SourceFacts {
  const sections = new Set<string>();
  const frames = new Set<string>();
  const schCoordFiles: string[] = [];
  const mixed: string[] = [];

  for (const [path, content] of Object.entries(sources)) {
    if (path.startsWith("lib/") || !path.endsWith(".tsx")) continue;

    for (const m of content.matchAll(/schSectionName\s*=\s*["'{`]?\s*["'`]?([\w -]+)/g)) {
      const name = m[1]?.trim();
      if (name) sections.add(name);
    }
    for (const m of content.matchAll(/<schematicsection[^>]*\bname\s*=\s*["']([^"']+)/gi)) {
      frames.add(m[1]);
    }

    // schX/schY inside a <schematic...> primitive are coordinates internal to
    // the symbol and are legitimate: those tags are removed before the test.
    const withoutSymbolPrimitives = content.replace(/<schematic[a-z]*\b[^>]*>/gi, "");
    if (/\bsch[XY]\s*=/.test(withoutSymbolPrimitives)) schCoordFiles.push(path);

    if (/schSectionName\s*=/.test(content) && /<group\b/.test(content)) mixed.push(path);
  }

  return {
    sections: Array.from(sections).sort(),
    sectionsWithFrames: Array.from(frames).sort(),
    schCoordFiles,
    mixedSectionsAndGroups: mixed,
  };
}

function schCoordsMessage(files: string[]): string {
  return (
    `${files.join(", ")} set schX/schY on placed components. A single schX/schY ` +
    `disables the schematic auto layout for the whole group, so every other ` +
    `component piles up on the origin. Remove them and use schSectionName instead.`
  );
}

function buildIssues(q: SchematicQuality, src: SourceFacts): SchematicIssue[] {
  const issues: SchematicIssue[] = [];

  if (q.symbolOverlapCount > 0) {
    const worst = q.symbolOverlaps[0];
    issues.push({
      rule: "symbol_overlap",
      severity: "fail",
      message:
        `${q.symbolOverlapCount} overlapping symbol pair(s), worst ${worst.a} <-> ${worst.b} ` +
        `(${worst.areaSu2} su^2 at ${worst.x},${worst.y}). The schematic auto layout is off ` +
        `or sections were mixed with groups.`,
    });
  }

  if (src.schCoordFiles.length > 0) {
    issues.push({
      rule: "sch_coords_in_source",
      severity: q.symbolOverlapCount > 0 ? "fail" : "warn",
      message: schCoordsMessage(src.schCoordFiles),
    });
  }

  if (src.mixedSectionsAndGroups.length > 0) {
    issues.push({
      rule: "sections_with_groups",
      severity: "fail",
      message:
        `${src.mixedSectionsAndGroups.join(", ")} mix schSectionName with <group> at the same ` +
        `level: group children are excluded from the section packing and get drawn on top of ` +
        `the sections. Per level pick one, flat components with sections or subcircuit groups.`,
    });
  }

  if (q.sections.length < 2 && q.symbols > 8) {
    issues.push({
      rule: "no_sections",
      severity: "fail",
      message:
        `${q.symbols} symbols and ${q.sections.length} functional section(s). Give every ` +
        `component a schSectionName (power, decoupling, mcu, clock, io...) and add one ` +
        `<schematicsection name="..." displayName="..." /> per section.`,
    });
  } else if (q.sections.length > 0 && q.sectionsWithFrames.length === 0) {
    issues.push({
      rule: "no_sections",
      severity: "warn",
      message:
        `Sections ${q.sections.join(", ")} are packed but have no frames: add one ` +
        `<schematicsection name="..." displayName="..." /> per section to draw the ` +
        `dividers and titles.`,
    });
  }

  if (q.labelOverlapCount > 0) {
    const worst = q.labelOverlaps[0];
    issues.push({
      rule: "label_over_symbol",
      severity: "warn",
      message:
        `${q.labelOverlapCount} net label(s) drawn over a symbol, e.g. "${worst.label}" over ` +
        `${worst.component} at ${worst.x},${worst.y}.`,
    });
  }

  if (q.symbols > 0 && q.traceCrossings > Math.max(1, q.symbols / 10)) {
    issues.push({
      rule: "trace_crossings",
      severity: "warn",
      message:
        `${q.traceCrossings} wire crossings${q.crossingsEstimated ? " (estimated)" : ""} for ` +
        `${q.symbols} symbols. Put connected parts in the same section and turn the longest ` +
        `wires into net labels (schTraceAutoLabelEnabled on the board).`,
    });
  }

  if (!q.sheet.fitsA4) {
    issues.push({
      rule: "sheet_overflow",
      severity: "warn",
      message:
        `The drawing is ${q.sheet.widthSu}x${q.sheet.heightSu} su and no longer fits an A4 ` +
        `sheet: split it into <group subcircuit> blocks joined by named nets.`,
    });
  }

  if (q.symbols > 3 && q.sheet.density > 0 && q.sheet.density < 0.02) {
    issues.push({
      rule: "sheet_too_sparse",
      severity: "warn",
      message:
        `Sheet density ${q.sheet.density}: the symbols are flung far apart, which almost ` +
        `always means the auto layout was disabled by a schX/schY.`,
    });
  }

  return issues;
}
