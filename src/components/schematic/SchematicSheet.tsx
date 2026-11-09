import type { PointerEvent as ReactPointerEvent } from "react";
import type { SchNode, SchematicModel } from "@/lib/schematic-model";
import { SCH_TEXT, type SchLabel } from "@/lib/schematic-shapes";
import {
  HIGHLIGHT_COLOR,
  HIGHLIGHT_FADE,
  isLit,
  junctionKey,
  labelKey,
  wireKey,
  type SheetHighlight,
} from "@/lib/schematic-interaction";

/**
 * The drawing of the schematic sheet, and nothing else.
 *
 * WHY SEPARATE FROM THE CANVAS. The canvas holds the interaction (pan, drag,
 * hover, link); this component only turns the model and the view into SVG.
 * Being pure it can be rendered outside the browser (renderToStaticMarkup ->
 * resvg -> PNG), which is how the drawing is checked by eye and by the tests
 * without opening the app. Every handler is optional: without them the sheet
 * is a static picture.
 *
 * Every text from the circuit (pin names, designators, nets) goes in as a
 * React text child, never as markup: React escapes it, so a pin called
 * "<script>" is drawn as those characters.
 */

/*
 * One color per class of net, the same on wires, dots and labels: positive
 * rails green (as on the mockup), grounds blue, signals neutral. Amber is
 * left to the highlight of the canvas (HIGHLIGHT_COLOR), so a lit net never
 * looks like a rail. Every text clears 4.5:1 against the sheet and every
 * wire 3:1, on both sheets (the test measures it).
 */
const DARK = {
  sheet: "#0A121C",
  sheetEdge: "#18222E",
  grid: "#1B2735",
  wire: "#71838F",
  power: "#0BA36C",
  ground: "#6E9FE6",
  /** a pin with nothing on it, in Link mode: the canvas hint calls them green */
  unlinked: "#0BA36C",
  outline: "#93A4AE",
  body: "#101A26",
  name: "#D4DEE4",
  value: "#8C9CA8",
  pin: "#AEBCC5",
  number: "#7B8D99",
  comment: "#8FA2AE",
  label: "#A3B3BD",
  labelEdge: "#4F6170",
  frame: "#2A3B4C",
  frameFill: "#0C1621",
  title: "#93A7B6",
  faint: "#75868F",
  warning: "#E8B23B",
  selected: "#3BE8B0",
};

/** the paper sheet: printing, exports, a light page */
const LIGHT: typeof DARK = {
  sheet: "#FBFAF7",
  sheetEdge: "#D9D6CC",
  grid: "#E4E1D8",
  wire: "#4A5866",
  power: "#0A7048",
  ground: "#2C5FB0",
  unlinked: "#0A8A5B",
  outline: "#34414D",
  body: "#F6F3E8",
  name: "#141B22",
  value: "#4E5C69",
  pin: "#2E3A45",
  number: "#5F6C78",
  comment: "#56636F",
  label: "#2E3A45",
  labelEdge: "#8A96A1",
  frame: "#BDB8AA",
  frameFill: "#F4F2EA",
  title: "#4E5C69",
  faint: "#5F6B76",
  warning: "#8A5A00",
  selected: "#0B7F8C",
};

export type SheetTheme = "dark" | "light";
export const SHEET_PALETTES: Record<SheetTheme, typeof DARK> = { dark: DARK, light: LIGHT };

/**
 * Below this size on screen a text is noise: pin names, pin numbers and
 * comments are left out when zoomed out that far. Parts, designators and
 * section titles always stay: they are how you find your way on the sheet.
 */
export const DETAIL_MIN_PX = 5;
const DETAIL_TONES = new Set<SchLabel["tone"]>(["pin", "number", "comment"]);
export const showsLabel = (label: Pick<SchLabel, "tone" | "size">, k: number): boolean =>
  !DETAIL_TONES.has(label.tone) || label.size * k >= DETAIL_MIN_PX;

/** a section title never shrinks below this on screen (it would vanish when zoomed out) */
const TITLE_MIN_PX = 11;

export interface SheetView {
  x: number;
  y: number;
  k: number;
}

export interface SheetFrame {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SheetLink {
  from: string;
  to: string;
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

export interface SheetHandlers {
  /** hover on a wire or a component: the nets to light up and the name to show */
  hover?: (nets: Set<string> | null, name: string | null) => void;
  nodeDown?: (e: ReactPointerEvent, node: SchNode) => void;
  /** pin clicked in link mode, in sheet coordinates (drag offset included) */
  portDown?: (port: { selector: string; x: number; y: number }) => void;
  unlink?: (declared: string) => void;
}

/** sheet frame around the drawing, with a generous margin */
export function sheetFrame(model: SchematicModel): SheetFrame {
  const b = model.bounds;
  const margin = Math.max(1.2, (b.maxX - b.minX) * 0.06);
  return {
    x: b.minX - margin,
    y: b.minY - margin,
    w: Math.max(b.maxX - b.minX + margin * 2, 2),
    h: Math.max(b.maxY - b.minY + margin * 2, 2),
  };
}

/** the view that fits the whole sheet in a viewport */
export function fitView(sheet: SheetFrame, size: { w: number; h: number }, margin = 40): SheetView {
  const k = Math.min(
    (size.w - margin * 2) / Math.max(sheet.w, 0.001),
    (size.h - margin * 2) / Math.max(sheet.h, 0.001),
  );
  return {
    x: size.w / 2 - (sheet.x + sheet.w / 2) * k,
    y: size.h / 2 - (sheet.y + sheet.h / 2) * k,
    k: Math.max(k, 1),
  };
}

const NO_OFFSETS: Record<string, { dx: number; dy: number }> = {};
const NO_SET = new Set<string>();

export function SchematicSheet({
  model,
  sheet,
  view,
  size,
  projectId,
  offsets = NO_OFFSETS,
  selected = NO_SET,
  pinnedNames = NO_SET,
  hoverNets = null,
  hoverName = null,
  linking = false,
  movable = false,
  linkFrom = null,
  cursor = null,
  pendingLinks = [],
  highlight = null,
  on = {},
  fontFamily = "var(--font-mono, 'IBM Plex Mono'), monospace",
  theme = "dark",
}: {
  model: SchematicModel;
  sheet: SheetFrame;
  view: SheetView;
  size: { w: number; h: number };
  projectId: string;
  offsets?: Record<string, { dx: number; dy: number }>;
  selected?: Set<string>;
  pinnedNames?: Set<string>;
  hoverNets?: Set<string> | null;
  hoverName?: string | null;
  linking?: boolean;
  movable?: boolean;
  linkFrom?: { selector: string; x: number; y: number } | null;
  cursor?: { x: number; y: number } | null;
  pendingLinks?: SheetLink[];
  /** selection (or hover preview) from the canvas: lit elements, the rest fades */
  highlight?: SheetHighlight | null;
  on?: SheetHandlers;
  fontFamily?: string;
  theme?: SheetTheme;
}) {
  const COLORS = SHEET_PALETTES[theme];
  const TONE = { name: COLORS.name, value: COLORS.value, pin: COLORS.pin, number: COLORS.number, comment: COLORS.comment };
  /** the color of a net's class: ground, positive rail, signal */
  const rail = (x: { power: boolean; ground: boolean }) => (x.ground ? COLORS.ground : COLORS.power);
  const px = 1 / view.k; // one pixel in drawing units
  /*
   * Line widths live in sheet units, like the texts: zooming in, a wire grows
   * together with the names next to it instead of staying a hairline under
   * huge letters. The floor in pixels keeps them visible when zoomed out.
   */
  const sw = (units: number, minPx = 1) => Math.max(units, minPx * px);
  const dim = (net: string | null, key?: string) =>
    highlight
      ? isLit(highlight, net, key) ? 1 : HIGHLIGHT_FADE
      : hoverNets && (!net || !hoverNets.has(net)) ? 0.12 : 1;
  const lit = (net: string | null, key?: string) =>
    highlight ? isLit(highlight, net, key) : Boolean(hoverNets && net && hoverNets.has(net));
  const hl = (net: string | null, key: string) => Boolean(highlight && isLit(highlight, net, key));
  const leave = () => on.hover?.(null, null);

  return (
    <svg width={size.w} height={size.h} className="block" style={{ fontFamily }}>
      <defs>
        <pattern
          id="sch-grid"
          width={1 * view.k}
          height={1 * view.k}
          patternUnits="userSpaceOnUse"
          x={view.x}
          y={view.y}
        >
          <circle cx={0} cy={0} r={0.9} fill={COLORS.grid} />
        </pattern>
      </defs>

      {/* the sheet: frame and grid, like on a technical drawing */}
      <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
        <rect
          x={sheet.x}
          y={sheet.y}
          width={sheet.w}
          height={sheet.h}
          rx={0.3}
          fill={COLORS.sheet}
          stroke={COLORS.sheetEdge}
          strokeWidth={px}
        />
      </g>
      <rect
        x={sheet.x * view.k + view.x}
        y={sheet.y * view.k + view.y}
        width={sheet.w * view.k}
        height={sheet.h * view.k}
        fill="url(#sch-grid)"
        pointerEvents="none"
      />

      <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
        {/* functional sections: a frame each, the title in the corner. Of two
            frames that overlap, the larger is dashed and unfilled, under the other */}
        <g pointerEvents="none">
          {model.sectionFrames.map((f, i) => {
            const crossed = f.dashed === true;
            return (
              <rect
                key={i}
                x={f.x}
                y={f.y}
                width={f.w}
                height={f.h}
                rx={0.12}
                fill={crossed ? "none" : COLORS.frameFill}
                stroke={COLORS.frame}
                strokeWidth={sw(crossed ? 0.02 : 0.016)}
                strokeDasharray={crossed ? `${sw(0.12, 6)} ${sw(0.08, 4)}` : undefined}
              />
            );
          })}
        </g>
        <g stroke={COLORS.frame} strokeWidth={sw(0.016)}>
          {model.dividers.map((d, i) => (
            <line key={i} x1={d.x1} y1={d.y1} x2={d.x2} y2={d.y2} />
          ))}
        </g>
        <g fill={COLORS.title} pointerEvents="none">
          {model.sectionTitles.map((t, i) => {
            /*
             * Zoomed out, the title grows to stay readable (it is how you find
             * a block on a 183-part sheet), keeping its top-left corner. The
             * plate behind it keeps it legible over a frame that crosses it.
             */
            const base = SCH_TEXT.sectionTitle;
            const size = Math.max(base, TITLE_MIN_PX * px);
            const top = t.y - base * 0.75;
            const w = t.text.length * size * 0.6;
            const x0 = t.anchor === "end" ? t.x - w : t.x;
            return (
              <g key={i}>
                <rect
                  x={x0 - size * 0.15}
                  y={top - size * 0.12}
                  width={w + size * 0.3}
                  height={size * 1.12}
                  rx={size * 0.15}
                  fill={COLORS.frameFill}
                  // fill-opacity, not opacity: no layer, and resvg does not
                  // choke on a plate that lies outside the picture
                  fillOpacity={0.85}
                />
                <text
                  x={t.x}
                  y={top + size * 0.75}
                  fontSize={size}
                  fontWeight={600}
                  letterSpacing={0.01}
                  textAnchor={t.anchor ?? "start"}
                >
                  {t.text}
                </text>
              </g>
            );
          })}
        </g>

        {/* wires: power rails in green, like on a designer's sheet */}
        <g fill="none" strokeLinecap="round" strokeLinejoin="round">
          {model.wires.map((w) => (
            <path
              key={w.id}
              d={w.d}
              stroke={hl(w.net, wireKey(w.id)) ? HIGHLIGHT_COLOR : w.power ? rail(w) : lit(w.net) ? COLORS.selected : COLORS.wire}
              strokeWidth={lit(w.net, wireKey(w.id)) ? sw(0.03, 2.4) : sw(0.018, w.power ? 1.5 : 1.3)}
              opacity={dim(w.net, wireKey(w.id))}
              onPointerEnter={() => on.hover?.(w.net ? new Set([w.net]) : null, w.net)}
              onPointerLeave={leave}
              onClick={(e) => {
                if (!linking || !w.declaredAs) return;
                e.stopPropagation();
                on.unlink?.(w.declaredAs);
              }}
              style={{ cursor: linking && w.declaredAs ? "pointer" : "crosshair" }}
            >
              {linking && w.declaredAs && <title>{`Togli: ${w.declaredAs}`}</title>}
            </path>
          ))}
        </g>
        <g pointerEvents="none">
          {model.junctions.map((j, i) => (
            <circle
              key={i}
              cx={j.x}
              cy={j.y}
              // the junction between multiple wires is bigger than the
              // attachment to a pin: two different things that must be told apart
              r={j.isNode ? sw(0.035, 3) : sw(0.02, 1.8)}
              fill={hl(j.net, junctionKey(i)) ? HIGHLIGHT_COLOR : j.power ? rail(j) : COLORS.wire}
              opacity={dim(j.net, junctionKey(i))}
            />
          ))}
        </g>

        {/* net labels: rails don't cross the sheet, they get named. A flag
            touches its pin with its point; ground and rails get their symbol.
            A label tscircuit left loose is tied to its pin by a dashed line. */}
        <g pointerEvents="none">
          {model.netLabels.map((l, i) => {
            const removable = linking && l.declaredAs && l.declaredAs.length > 0;
            const edge = hl(l.net, labelKey(i))
              ? HIGHLIGHT_COLOR
              : lit(l.net) ? COLORS.selected : l.power ? rail(l) : COLORS.labelEdge;
            const remove = (e: { stopPropagation: () => void }) => {
              e.stopPropagation();
              for (const d of l.declaredAs ?? []) on.unlink?.(d);
            };
            return (
              <g key={i} opacity={dim(l.net, labelKey(i))}>
                {l.port && (
                  <>
                    <path
                      d={`M${l.port.x} ${l.port.y}L${l.attach.x} ${l.attach.y}`}
                      fill="none"
                      stroke={l.power ? rail(l) : COLORS.labelEdge}
                      strokeWidth={sw(0.012)}
                      strokeDasharray={`${sw(0.05, 2.5)} ${sw(0.04, 2)}`}
                    />
                    {/* the dot at both ends is the connection point: without it,
                        the dashed line looks like it passes near the pin by chance */}
                    <circle cx={l.port.x} cy={l.port.y} r={sw(0.02, 1.8)} fill={edge} />
                  </>
                )}
                <path
                  d={l.outline}
                  fill={l.closed ? COLORS.sheet : "none"}
                  stroke={edge}
                  strokeWidth={sw(l.closed ? 0.012 : 0.02)}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  // in Link mode the label can be clicked to remove the
                  // connection: label-only connections have no wire,
                  // this is the only place to grab them
                  pointerEvents={removable ? "all" : "none"}
                  style={removable ? { cursor: "pointer" } : undefined}
                  onClick={removable ? remove : undefined}
                >
                  {removable && <title>{`Togli: ${(l.declaredAs ?? []).join(" · ")}`}</title>}
                </path>
                <text
                  x={l.textAt.x}
                  y={l.textAt.y}
                  fontSize={l.textAt.size}
                  textAnchor={l.textAt.anchor}
                  transform={l.textAt.vertical ? `rotate(-90 ${l.textAt.x} ${l.textAt.y})` : undefined}
                  fill={l.power ? rail(l) : COLORS.label}
                >
                  {l.text}
                </text>
              </g>
            );
          })}
        </g>

        {/* links drawn and not yet applied: dashed, because the real
            wire will be drawn by the compiler after the re-routing */}
        <g fill="none" pointerEvents="none">
          {pendingLinks.map((l, i) => (
            <path
              key={i}
              d={`M${l.ax} ${l.ay}L${l.bx} ${l.by}`}
              stroke={COLORS.selected}
              strokeWidth={1.8 * px}
              strokeDasharray={`${6 * px} ${4 * px}`}
            />
          ))}
          {linkFrom && cursor && (
            <path
              d={`M${linkFrom.x} ${linkFrom.y}L${cursor.x} ${cursor.y}`}
              stroke={COLORS.selected}
              strokeWidth={1.6 * px}
              strokeDasharray={`${5 * px} ${4 * px}`}
            />
          )}
        </g>

        {model.nodes.map((node) => {
          const off = offsets[node.id];
          const isSelected = selected.has(node.id);
          const pinned = pinnedNames.has(node.name);
          const halo = highlight?.focus.get(node.id);
          return (
            <g
              key={node.id}
              opacity={
                highlight
                  ? highlight.nodes.has(node.id) ? 1 : HIGHLIGHT_FADE
                  : hoverNets && !node.ports.some((p) => lit(p.net)) && hoverName !== node.name
                    ? 0.25
                    : 1
              }
              transform={off ? `translate(${off.dx} ${off.dy})` : undefined}
              onPointerDown={on.nodeDown ? (e) => on.nodeDown?.(e, node) : undefined}
              onPointerEnter={() => {
                const nets = node.ports.map((p) => p.net).filter((n): n is string => Boolean(n));
                on.hover?.(nets.length > 0 ? new Set(nets) : null, node.name);
              }}
              onPointerLeave={leave}
              style={{ cursor: movable ? "move" : "pointer" }}
            >
              {halo && (
                <rect
                  x={halo.minX - 0.1}
                  y={halo.minY - 0.1}
                  width={halo.maxX - halo.minX + 0.2}
                  height={halo.maxY - halo.minY + 0.2}
                  rx={0.1}
                  fill={HIGHLIGHT_COLOR}
                  fillOpacity={0.07}
                  stroke={HIGHLIGHT_COLOR}
                  strokeWidth={sw(0.016, 1.5)}
                  pointerEvents="none"
                />
              )}
              {/* grab area: without this you only catch the thin stroke */}
              <rect
                x={node.bbox.minX - 0.1}
                y={node.bbox.minY - 0.1}
                width={node.bbox.maxX - node.bbox.minX + 0.2}
                height={node.bbox.maxY - node.bbox.minY + 0.2}
                fill="transparent"
              />
              {node.box && (
                <rect
                  x={node.box.x}
                  y={node.box.y}
                  width={node.box.w}
                  height={node.box.h}
                  rx={0.12}
                  fill={COLORS.body}
                  stroke={isSelected ? COLORS.selected : COLORS.outline}
                  strokeWidth={sw(isSelected ? 0.03 : 0.022, isSelected ? 2.2 : 1.4)}
                />
              )}
              {node.paths.map((p, i) => (
                <path
                  key={i}
                  d={p.d}
                  fill={p.filled ? (isSelected ? COLORS.selected : COLORS.outline) : "none"}
                  stroke={isSelected ? COLORS.selected : COLORS.outline}
                  strokeWidth={sw(isSelected ? 0.028 : 0.02, isSelected ? 2 : 1.3)}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ))}
              {node.labels.map((l, i) => showsLabel(l, view.k) && (
                <text
                  key={i}
                  x={l.x}
                  y={l.y}
                  fontSize={l.size}
                  textAnchor={l.anchor}
                  fill={TONE[l.tone]}
                  fontWeight={l.tone === "name" ? 600 : 400}
                  fontStyle={l.tone === "comment" ? "italic" : undefined}
                  transform={l.vertical ? `rotate(-90 ${l.x} ${l.y})` : undefined}
                  pointerEvents="none"
                >
                  {l.text}
                </text>
              ))}
              {highlight &&
                node.ports.map((port) =>
                  highlight.ports.has(port.selector) ? (
                    <circle
                      key={`hl-${port.selector}`}
                      cx={port.x}
                      cy={port.y}
                      r={sw(0.045, 3.5)}
                      fill="none"
                      stroke={HIGHLIGHT_COLOR}
                      strokeWidth={sw(0.014, 1.5)}
                      pointerEvents="none"
                    />
                  ) : null,
                )}
              {linking &&
                node.ports.map((port) => {
                  const active = linkFrom?.selector === port.selector;
                  return (
                    <circle
                      key={port.selector}
                      cx={port.x}
                      cy={port.y}
                      r={(active ? 6 : 4) * px}
                      fill={active ? COLORS.selected : COLORS.sheet}
                      stroke={active ? COLORS.selected : port.connected ? COLORS.wire : COLORS.unlinked}
                      strokeWidth={1.6 * px}
                      style={{ cursor: "crosshair" }}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        // the circle is drawn inside the group translated
                        // by the drag: the link coordinates must live in the
                        // same system, otherwise the rubber band starts from
                        // the pin's old position
                        on.portDown?.({
                          selector: port.selector,
                          x: port.x + (off?.dx ?? 0),
                          y: port.y + (off?.dy ?? 0),
                        });
                      }}
                    >
                      <title>{`${port.selector}${port.net ? ` · ${port.net}` : " · scollegato"}`}</title>
                    </circle>
                  );
                })}
              {pinned && (
                <circle
                  cx={node.bbox.maxX + 0.14}
                  cy={node.bbox.minY - 0.02}
                  r={0.09}
                  fill={COLORS.selected}
                  pointerEvents="none"
                >
                  <title>Posizione fissata a mano</title>
                </circle>
              )}
            </g>
          );
        })}
      </g>

      {/* title block: project name and sheet, like on a real drawing */}
      <g fill={COLORS.faint} fontSize={11} pointerEvents="none">
        <text x={16} y={size.h - 14}>
          {projectId}
          {model.sectionTitles.length > 0 ? ` · ${model.sectionTitles.length} sezioni` : ""}
        </text>
        <text x={size.w - 16} y={size.h - 14} textAnchor="end">
          {model.nodes.length} componenti · {model.wires.length} collegamenti
          {model.labeledWires.length > 0 ? ` · ${model.labeledWires.length} fili come etichette` : ""}
        </text>
        {/* what schematico.json had wrong: said here, never a broken page */}
        {model.noteWarnings.slice(0, 3).map((w, i) => (
          <text key={i} x={16} y={size.h - 30 - i * 15} fill={COLORS.warning}>
            {w}
          </text>
        ))}
      </g>
    </svg>
  );
}
