/**
 * From Circuit JSON to a tscircuit project (main.tsx).
 *
 * It lives apart because two importers produce the same thing and must produce
 * it the SAME way: KiCad (kicad-to-circuit-json) and Altium (altium-toolkit)
 * both hand over Circuit JSON, and from there on the work is identical —
 * components with their real footprint, connections, board outline.
 *
 * The project document IS code: whoever imports gets a main.tsx the agent can
 * then edit like any other, not an opaque blob. That is why the footprints are
 * rebuilt inline from the pcb elements: the imported board keeps the pad
 * geometry it had, without guessing which library part it resembled.
 */
import { disposizionePin, type LatiDelSimbolo } from "./altium-schematic";

interface El {
  type: string;
  [key: string]: unknown;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

const r3 = (v: number): number => Number(v.toFixed(3));

const toPascalCase = (s: string): string => {
  const parts = s.replace(/[^A-Za-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
  const name = parts.map((p) => p[0].toUpperCase() + p.slice(1)).join("");
  return /^[A-Z]/.test(name) ? name : `K${name}`;
};

/** selector-safe component reference: R1, U2, J3 */
const safeRef = (name: string): string => name.replace(/[^A-Za-z0-9_]/g, "_");

const NET_SAFE_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
const safeNet = (name: string): string => {
  const cleaned = name.replace(/[^A-Za-z0-9_]/g, "_").replace(/^(\d)/, "P$1");
  return NET_SAFE_RE.test(cleaned) ? cleaned : `N_${cleaned}`;
};

/**
 * Net names that are legal AND still distinct.
 *
 * A selector cannot hold a `+` or a `/`, so the name gets cleaned up — and two
 * different nets can clean up to the same thing: `+3V3` and `-3V3` both become
 * `N__3V3`, which is a board where the positive rail and the negative rail are
 * one net. Nobody would ever see it: the file is right, the project is wrong,
 * and it shorts the power supply.
 *
 * So the cleaning is done ONCE over the whole model, and a name already taken by
 * another net gets a number. The order is the order the nets appear in the
 * model, which is stable for a given file, so the same import always produces
 * the same names.
 */
function risolviNomiRete(cj: El[]): (raw: string) => string {
  const preso = new Map<string, string>();
  const mappa = new Map<string, string>();
  /*
   * The COMPONENTS get first claim on a name. A board can have a test point
   * whose designator is `GND` and a net called `GND` — this one has both, plus
   * `VBAT` — and tscircuit refuses two children with the same name: "Multiple
   * immediate children found with name GND". The part keeps its name, because
   * that name is printed on the board and used in every selector; the net takes
   * the number.
   */
  const DI_UN_COMPONENTE = "<questo nome e' di un componente>";
  for (const el of cj) {
    if (el.type !== "source_component") continue;
    const nome = safeRef(String(el.name ?? ""));
    if (nome) preso.set(nome, DI_UN_COMPONENTE);
  }
  for (const el of cj) {
    if (el.type !== "source_net") continue;
    const raw = String(el.name ?? "");
    if (!raw || mappa.has(raw)) continue;
    let nome = safeNet(raw);
    if (preso.has(nome) && preso.get(nome) !== raw) {
      let i = 2;
      while (preso.has(`${nome}_${i}`)) i++;
      nome = `${nome}_${i}`;
    }
    preso.set(nome, raw);
    mappa.set(raw, nome);
  }
  return (raw: string) => mappa.get(raw) ?? safeNet(raw);
}

// ---------------------------------------------------------------------------
// footprint soup -> <footprint> JSX (shared by component and project import)
// ---------------------------------------------------------------------------

interface FootprintCtx {
  /** subtract this center and counter-rotate (project components are placed) */
  cx?: number;
  cy?: number;
  rotationDeg?: number;
  /**
   * The component sits on the BOTTOM of the board.
   *
   * A part on the underside is seen from above through the board: tscircuit
   * models it by mirroring the footprint's x and flipping every layer inside it
   * (verified: a pad written at local x = -1 on a bottom chip comes out at +1).
   * So the geometry read from a CAD, which is already in board coordinates,
   * has to be written back PRE-MIRRORED, otherwise it lands mirrored on the
   * board.
   */
  sotto?: boolean;
}

function localize(x: number, y: number, ctx: FootprintCtx): { x: number; y: number } {
  let dx = x - (ctx.cx ?? 0);
  let dy = y - (ctx.cy ?? 0);
  const rot = ctx.rotationDeg ?? 0;
  if (rot) {
    const rad = (-rot * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const rx = dx * cos - dy * sin;
    const ry = dx * sin + dy * cos;
    dx = rx;
    dy = ry;
  }
  // the mirror comes last, on the already-derotated coordinate: it is the
  // inverse of what tscircuit applies first when it lays the footprint down
  return { x: r3(ctx.sotto ? -dx : dx), y: r3(dy) };
}

/**
 * The layer to WRITE so that the layer to SEE is the right one.
 *
 * Inside a bottom component every layer is flipped: a pad written "top" comes
 * out on the bottom. Which is exactly what you want for a part's own pads, and
 * exactly what you must undo when writing the side the pad is really on.
 */
const faccia = (reale: string, ctx: FootprintCtx): string =>
  ctx.sotto ? (reale === "bottom" ? "top" : "bottom") : reale;

function portHintsOf(el: El): string[] {
  const hints = (el.port_hints as string[] | undefined) ?? [];
  return hints.map(String);
}

function footprintJsx(elements: El[], ctx: FootprintCtx, indent: string): string {
  const lines: string[] = [];
  for (const el of elements) {
    const x = num(el.x);
    const y = num(el.y);
    if (el.type === "pcb_smtpad" && x !== null && y !== null) {
      const p = localize(x, y, ctx);
      const hints = JSON.stringify(portHintsOf(el));
      const rot = num(el.ccw_rotation);
      const layer = faccia(String(el.layer ?? "top"), ctx);
      /*
       * The solder mask opening. Without it a pad is a rectangle of copper on a
       * drawing; with it there is the ring of bare laminate the fab actually
       * leaves, which is what a pad looks like on a board and in the CAD it came
       * from.
       */
      const mask = num(el.soldermask_margin);
      const maskProp = mask !== null && mask > 0 ? ` solderMaskMargin={${r3(mask)}}` : "";
      /*
       * A ROUND pad is described by a radius, not by width and height: tscircuit
       * refuses `shape="circle"` without one, and the component fails to build
       * whole. It cost 43 of the 98 components of a real board, all of them with
       * circular pads, and the message says it plainly: "Invalid props for
       * smtpad: radius (Required)".
       */
      if (el.shape === "circle") {
        const r = num(el.radius) ?? (num(el.width) ?? 0) / 2;
        lines.push(
          `${indent}<smtpad portHints={${hints}} shape="circle" radius={${r3(r)}} pcbX={${p.x}} pcbY={${p.y}} layer="${layer}"${maskProp} />`,
        );
      } else {
        const w = num(el.width) ?? (num(el.radius) ?? 0) * 2;
        const h = num(el.height) ?? (num(el.radius) ?? 0) * 2;
        /*
         * A PAD TURNED ON ITS OWN.
         *
         * `shape="rect"` throws `ccwRotation` away — measured: the same pad
         * written at 0 and at 90 degrees compiles to the identical rectangle.
         * Only the component's rotation turns its pads. So a pad the CAD turned
         * by itself came out across the part instead of along it: 149 out of 336
         * on this board, and it is what put 76 pads on top of each other.
         *
         * At a quarter turn the sides are simply swapped, which every later pass
         * understands without knowing anything about rotation. At any other
         * angle — this board has pads at 45 degrees — the shape has to say so:
         * `rotated_rect` keeps it, and composes with the component's rotation
         * (verified: 45 inside a part turned by 90 comes out at 135).
         *
         * The angle that goes in is the one RELATIVE to the component, because
         * the component's own is applied afterwards; and underneath the board it
         * is mirrored, which turns an angle into its supplement.
         */
        const locale = ((((rot ?? 0) - (ctx.rotationDeg ?? 0)) % 360) + 360) % 360;
        const mezzoGiro = locale % 180;
        const dritto = mezzoGiro < 3 || mezzoGiro > 177;
        const diTraverso = Math.abs(mezzoGiro - 90) < 3;
        if (dritto || diTraverso) {
          lines.push(
            `${indent}<smtpad portHints={${hints}} shape="rect" width={${r3(diTraverso ? h : w)}} height={${r3(diTraverso ? w : h)}} pcbX={${p.x}} pcbY={${p.y}} layer="${layer}"${maskProp} />`,
          );
        } else {
          const scritta = ctx.sotto ? (180 - locale + 360) % 360 : locale;
          lines.push(
            `${indent}<smtpad portHints={${hints}} shape="rotated_rect" width={${r3(w)}} height={${r3(h)}} ccwRotation={${r3(scritta)}} pcbX={${p.x}} pcbY={${p.y}} layer="${layer}"${maskProp} />`,
          );
        }
      }
    } else if (el.type === "pcb_plated_hole" && x !== null && y !== null) {
      const p = localize(x, y, ctx);
      const hints = JSON.stringify(portHintsOf(el));
      lines.push(
        `${indent}<platedhole portHints={${hints}} pcbX={${p.x}} pcbY={${p.y}} holeDiameter={${r3(num(el.hole_diameter) ?? 0.8)}} outerDiameter={${r3(num(el.outer_diameter) ?? 1.6)}} />`,
      );
    } else if (el.type === "pcb_hole" && x !== null && y !== null) {
      const p = localize(x, y, ctx);
      lines.push(
        `${indent}<hole pcbX={${p.x}} pcbY={${p.y}} diameter={${r3(num(el.hole_diameter) ?? num(el.diameter) ?? 1)}} />`,
      );
    } else if (el.type === "pcb_silkscreen_text" && x !== null && y !== null) {
      const p = localize(x, y, ctx);
      const text = String(el.text ?? "").replace(/"/g, '\\"');
      if (text) {
        const layer = faccia(String(el.layer ?? "top"), ctx);
        lines.push(
          `${indent}<silkscreentext pcbX={${p.x}} pcbY={${p.y}} text="${text}" fontSize={${r3(num(el.font_size) ?? 1)}} layer="${layer}" />`,
        );
      }
    } else if (el.type === "pcb_silkscreen_path") {
      /*
       * The outline printed around a part: it belongs to the footprint, so it
       * travels with the part when it is moved and is drawn in white, not in
       * copper. Which is the whole point — arriving as copper it was a track
       * around every component.
       */
      const route = ((el.route as Array<Record<string, unknown>> | undefined) ?? [])
        .map((p) => ({ x: num(p.x), y: num(p.y) }))
        .filter((p): p is { x: number; y: number } => p.x !== null && p.y !== null)
        .map((p) => localize(p.x, p.y, ctx));
      if (route.length >= 2) {
        const punti = route.map((p) => `{x:${p.x},y:${p.y}}`).join(",");
        lines.push(
          `${indent}<silkscreenpath route={[${punti}]} strokeWidth={${r3(num(el.stroke_width) ?? 0.1)}} layer="${faccia(String(el.layer ?? "top"), ctx)}" />`,
        );
      }
    } else if (el.type === "pcb_courtyard_rect") {
      const cx = num(el.center ? (el.center as { x?: number }).x : el.x);
      const cy = num(el.center ? (el.center as { y?: number }).y : el.y);
      const p = localize(cx ?? 0, cy ?? 0, ctx);
      lines.push(
        `${indent}<courtyardrect width={${r3(num(el.width) ?? 1)}} height={${r3(num(el.height) ?? 1)}} pcbX={${p.x}} pcbY={${p.y}} />`,
      );
    }
  }
  return lines.join("\n");
}


const FTYPE_ELEMENT: Record<string, string> = {
  simple_resistor: "resistor",
  simple_capacitor: "capacitor",
  simple_led: "led",
  simple_diode: "diode",
  simple_inductor: "inductor",
  simple_crystal: "crystal",
  simple_transistor: "transistor",
  simple_mosfet: "mosfet",
  simple_pinheader: "pinheader",
  simple_fuse: "fuse",
};

/**
 * What a component IS, beyond its geometry: the manufacturer code, the electrical
 * value, who makes it, and where its datasheet lives.
 *
 * It travels apart because it does not live in the Circuit JSON: it comes from
 * the source CAD (Altium keeps it in the native model, KiCad in the fields) and
 * without it an imported board is a bag of pads with designators — a BOM you
 * cannot order from, and a part nobody can look up.
 */
export interface ComponentIdentity {
  /** manufacturer part number: the only unambiguous name a part has */
  mpn?: string;
  /** electrical value with its unit, e.g. "3.9 pF", "10 kOhm" */
  valore?: string;
  produttore?: string;
  descrizione?: string;
  /** the datasheet the file itself points to */
  datasheetUrl?: string;
}

export interface ProjectFromCircuitJson {
  fsMap: Record<string, string>;
  components: number;
  traces: number;
}

export function circuitJsonToProjectFiles(
  cj: El[],
  opts: {
    origine: string;
    larghezzaMm?: number;
    altezzaMm?: number;
    /** identity per component name: see ComponentIdentity */
    identita?: Map<string, ComponentIdentity>;
    /** how many copper layers the board has: 4 when there are inner planes */
    strati?: number;
    /**
     * The 3D body of each component, by designator.
     *
     * A board without them is drawn in 3D as bare laminate: tscircuit gives a
     * part a shape only when it knows a model for it, and an imported board knows
     * none. The source CAD does: it carries the manufacturer's STEP inside the
     * file, and this is where that arrives in the project — as code, so it can be
     * read, changed and versioned like the rest.
     */
    corpi3d?: Map<
      string,
      {
        url?: string;
        /** a plain box, for a part with a height and no model */
        scatola?: { larghezza: number; profondita: number; altezza: number };
        altezzaMm?: number;
      }
    >;
    /** the poured planes: layer plus the net they carry */
    piani?: Array<{ faccia: string; net: string }>;
    /**
     * HOW THE CIRCUIT WAS DRAWN, when the source CAD says so.
     *
     * The section each component belongs to (the sheet it was drawn on) and the
     * sides of its symbol. Without it tscircuit lays the schematic out from
     * nothing and produces one crowded sheet; with it the drawing comes back in
     * the blocks its designer worked in. See altium-schematic.ts.
     */
    schematica?: {
      perComponente: Map<string, { sezione?: string; lati?: LatiDelSimbolo }>;
      sezioni: Array<{ nome: string; titolo: string }>;
    };
  },
): ProjectFromCircuitJson {
  const pcbComponentBySource = new Map<string, El>();
  for (const el of cj) {
    if (el.type === "pcb_component" && el.source_component_id) {
      pcbComponentBySource.set(String(el.source_component_id), el);
    }
  }
  const portById = new Map<string, El>();
  for (const el of cj) {
    if (el.type === "source_port") portById.set(String(el.source_port_id), el);
  }
  const compNameById = new Map<string, string>();
  for (const el of cj) {
    if (el.type === "source_component") {
      compNameById.set(String(el.source_component_id), String(el.name ?? "?"));
    }
  }

  const nomeDiRete = risolviNomiRete(cj);

  const componentLines: string[] = [];
  let compIndex = 0;
  for (const el of cj) {
    if (el.type !== "source_component") continue;
    compIndex++;
    const sourceId = String(el.source_component_id);
    const pcb = pcbComponentBySource.get(sourceId);
    const name = safeRef(String(el.name ?? `K${compIndex}`));
    const ftype = String(el.ftype ?? "simple_chip");
    const center = (pcb?.center as { x?: number; y?: number } | undefined) ?? {};
    const cx = num(center.x) ?? 0;
    const cy = num(center.y) ?? 0;
    const rotation = pcb ? (num(pcb.rotation) ?? 0) : 0;
    /*
     * WHICH SIDE OF THE BOARD THE PART IS ON.
     *
     * Half a real board lives underneath: on BAT_BS 44 components out of 98. The
     * source CAD says so and the Circuit JSON carries it in pcb_component.layer;
     * what was written here ignored it, so every bottom part was rebuilt on top —
     * and landed on top of the parts that were already there. The board came out
     * with 23 overlapping pads that do not touch on the real thing, because they
     * are on opposite faces.
     */
    const sotto = String(pcb?.layer ?? "top") === "bottom";
    const pos = ` pcbX={${r3(cx)}} pcbY={${r3(cy)}}${rotation ? ` pcbRotation={${rotation}}` : ""}${sotto ? ` layer="bottom"` : ""}`;

    // inline footprint from this component's pcb elements (real geometry)
    const compEls = cj.filter((e) => e.pcb_component_id === pcb?.pcb_component_id);
    const hasGeometry = compEls.some(
      (e) => e.type === "pcb_smtpad" || e.type === "pcb_plated_hole" || e.type === "pcb_hole",
    );
    const footprint = hasGeometry
      ? `\n    footprint={\n      <footprint>\n${footprintJsx(compEls, { cx, cy, rotationDeg: rotation, sotto }, "        ")}\n      </footprint>\n    }`
      : "";

    // pin labels from source ports
    const pinLabels = cj
      .filter((e) => e.type === "source_port" && e.source_component_id === sourceId)
      .map((e) => {
        const pin = e.pin_number ? `pin${e.pin_number}` : String(e.name ?? "?");
        return `${pin}: "${String(e.name ?? pin)}"`;
      });
    const labels = pinLabels.length ? `\n    pinLabels={{ ${pinLabels.join(", ")} }}` : "";

    /*
     * WHAT THE PART IS, not just where its pads are.
     *
     * A board arrives with a designator and a footprint; without the value and
     * the manufacturer code it is a bag of pads you cannot order. The identity
     * comes from the source CAD and is written here, so the imported project has
     * a BOM from minute one instead of ninety-eight anonymous chips.
     */
    const corpo = opts.corpi3d?.get(name);
    const cad = corpo?.url
      ? ` cadModel={{ objUrl: "${corpo.url}" }}`
      : corpo?.scatola
        ? /*
           * No model in the file: a box of the declared height over the real
           * footprint. It says what it is (a placeholder) and it is worth having,
           * because the 3D view is where you find out whether the enclosure closes.
           */
          ` cadModel={{ jscad: { type: "colorize", color: [0.24, 0.26, 0.25], shape: { type: "cuboid", size: [${corpo.scatola.larghezza}, ${corpo.scatola.profondita}, ${corpo.scatola.altezza}], center: [0, 0, ${r3(corpo.scatola.altezza / 2)}] } } }}`
        : "";

    const id = opts.identita?.get(name);
    const value = id?.valore ?? (el.display_value ? String(el.display_value) : null);
    // passive tags require their value prop (resistance/capacitance/...): when
    // the PCB carries no value, fall back to a chip with the real footprint
    const VALUE_PROPS: Record<string, string> = {
      resistor: "resistance",
      capacitor: "capacitance",
      inductor: "inductance",
    };
    /*
     * The kind of part is read from the VALUE when the source CAD does not say
     * it: Altium marks everything `simple_chip`, but a part with a capacitance
     * is a capacitor, and written as a chip it loses its value and its symbol.
     */
    const daValore = /^[\d.,]+\s*[pnuµm]?f$/i.test((value ?? "").trim())
      ? "capacitor"
      : /ohms?$|Ω$/i.test((value ?? "").trim())
        ? "resistor"
        : /^[\d.,]+\s*[pnuµm]?h$/i.test((value ?? "").trim())
          ? "inductor"
          : null;
    /*
     * IL TIPO DI PARTE DAL DESIGNATOR, quando il CAD non lo dice.
     *
     * Altium marca tutto `simple_chip`, e un diodo scritto come chip perde il suo
     * simbolo sullo schematico e fa dire a tscircuit "il prefisso D e' di un
     * diodo". Il designator lo sa: e' la convenzione piu' vecchia che c'e'.
     *
     * Solo i tipi che non richiedono proprieta' che il file non ha: un
     * <crystal> vuole frequenza E capacita' di carico, un <fuse> la corrente, e
     * senza quelle il componente non si costruisce affatto — perdere la parte e'
     * peggio che chiamarla chip.
     */
    const daDesignator = /^LED\d*$/i.test(name)
      ? "led"
      : /^D\d/i.test(name)
        ? "diode"
        : /^(J|CN|CON)\d/i.test(name)
          ? "connector"
          : null;
    const wantedTag = FTYPE_ELEMENT[ftype] ?? daValore ?? daDesignator ?? "chip";
    const requiredProp = VALUE_PROPS[wantedTag];
    const tag = requiredProp && !value ? "chip" : wantedTag;
    /*
     * The value written the way the compiler reads it: "10 kOhms" is a phrase,
     * "10kohm" is a quantity. Spaces out, plural out, and the unit lowercase —
     * otherwise the part compiles with no value and the BOM has a hole exactly
     * where the number was.
     */
    const valorePulito = (value ?? "")
      .trim()
      .replace(/\s+/g, "")
      .replace(/ohms$/i, "ohm")
      .replace(/farads?$/i, "F");
    const valueProp = requiredProp && value ? ` ${requiredProp}="${valorePulito}"` : "";
    const esc = (v: string) => v.replace(/"/g, "&quot;").replace(/\s+/g, " ").trim();
    const mpnProp = id?.mpn ? ` manufacturerPartNumber="${esc(id.mpn)}"` : "";
    const descr = [id?.produttore, id?.descrizione].filter(Boolean).join(" - ");
    const descrProp = descr ? ` description="${esc(descr).slice(0, 200)}"` : "";

    /*
     * WHERE THE PART SITS ON THE DRAWING, and how its symbol is built.
     *
     * Not coordinates: a section name. Pinning schX/schY turns tscircuit's
     * schematic layout off, and a board whose symbols are laid out by hand at
     * the source CAD's scale comes back sparse and full of wires running the
     * width of the sheet (measured on BAT_BS: 24 crossings over 71x57 su against
     * 7 over 56x33). The section says WHICH BLOCK the part belongs to and lets
     * the layout do its job inside it, which is the same thing the sheets of the
     * original schematic were.
     */
    const disegno = opts.schematica?.perComponente.get(name);
    const sezioneProp = disegno?.sezione ? ` schSectionName="${disegno.sezione}"` : "";
    /*
     * The sides of the symbol. tscircuit halves the pins left and right in pin
     * order, which on a 64 pin part is a column of sixty-four labels; the file
     * knows the designer put the resets on one side and the memory bus on the
     * other. Only for the parts that have a symbol worth reproducing — a two pin
     * capacitor is better off with its own.
     */
    const disposizione = disposizionePin(disegno?.lati);
    const pinProp = disposizione ? ` schPinArrangement={${disposizione}}` : "";

    componentLines.push(
      `    <${tag} name="${name}"${valueProp}${mpnProp}${descrProp}${pos}${sezioneProp}${pinProp}${cad}${footprint}${labels} />`,
    );
  }

  // connectivity: 2-port source traces become direct <trace>; larger nets get <net>
  const netLines: string[] = [];
  const traceLines: string[] = [];
  const namedNets = new Set<string>();
  const selectorOf = (sourcePortId: string): string | null => {
    const port = portById.get(sourcePortId);
    if (!port) return null;
    const comp = compNameById.get(String(port.source_component_id ?? ""));
    if (!comp) return null;
    return `.${safeRef(comp)} > .${String(port.name ?? `pin${port.pin_number ?? "?"}`)}`;
  };

  for (const el of cj) {
    if (el.type !== "source_trace") continue;
    const ports = ((el.connected_source_port_ids as string[] | undefined) ?? [])
      .map(selectorOf)
      .filter((s): s is string => s !== null);
    if (ports.length < 2) continue;
    const netIds = (el.connected_source_net_ids as string[] | undefined) ?? [];
    const netName = netIds.length
      ? (() => {
          const id = String(netIds[0]);
          const net = cj.find((e) => e.type === "source_net" && e.source_net_id === id);
          return net ? String(net.name) : null;
        })()
      : null;
    if (ports.length === 2 && !netName) {
      traceLines.push(`    <trace from="${ports[0]}" to="${ports[1]}" />`);
    } else {
      const net = netName ? nomeDiRete(netName) : safeNet(`NET_${traceLines.length}`);
      if (!namedNets.has(net)) {
        namedNets.add(net);
        netLines.push(`    <net name="${net}" />`);
      }
      for (const port of ports) {
        traceLines.push(`    <trace from="${port}" to="net.${net}" />`);
      }
    }
  }

  const board = cj.find((el) => el.type === "pcb_board");
  const bw = board ? (num(board.width) ?? 40) : 40;
  const bh = board ? (num(board.height) ?? 30) : 30;

  /*
   * The silkscreen that belongs to no part — the board's name, a polarity mark,
   * a logo outline — hangs off the board, not off a footprint. On an imported
   * board it is a handful of rows against hundreds inside the components, and
   * dropping it would delete exactly the writing a person put there by hand.
   */
  const silkLines: string[] = [];
  for (const el of cj) {
    if (el.pcb_component_id) continue;
    if (el.type === "pcb_silkscreen_text") {
      const text = String(el.text ?? "").replace(/"/g, '\\"');
      if (!text) continue;
      silkLines.push(
        `    <silkscreentext pcbX={${r3(num(el.x) ?? 0)}} pcbY={${r3(num(el.y) ?? 0)}} text="${text}" fontSize={${r3(num(el.font_size) ?? 1)}} layer="${String(el.layer ?? "top")}" />`,
      );
    } else if (el.type === "pcb_silkscreen_path") {
      const route = ((el.route as Array<Record<string, unknown>> | undefined) ?? [])
        .map((p) => ({ x: num(p.x), y: num(p.y) }))
        .filter((p): p is { x: number; y: number } => p.x !== null && p.y !== null);
      if (route.length < 2) continue;
      const punti = route.map((p) => `{x:${r3(p.x)},y:${r3(p.y)}}`).join(",");
      silkLines.push(
        `    <silkscreenpath route={[${punti}]} strokeWidth={${r3(num(el.stroke_width) ?? 0.1)}} layer="${String(el.layer ?? "top")}" />`,
      );
    }
  }

  /*
   * The planes. A pour is not decoration: it is where the returns go, and on a
   * four layer board it is most of the copper. Written as <copperpour> it is the
   * same thing the app builds on its own boards, so from here on the imported
   * board is treated like any other.
   */
  const pourLines = (opts.piani ?? []).map(
    (p) => `    <copperpour layer="${p.faccia}" connectsTo="net.${nomeDiRete(p.net)}" />`,
  );
  const strati = opts.strati && opts.strati > 2 ? ` layers={${opts.strati}}` : "";

  /*
   * The frames and the titles of the blocks. `schSectionName` alone packs the
   * parts together but draws nothing around them: these are the lines and the
   * names that make a sheet look like a schematic instead of eight clusters that
   * happen to be near each other. The name must match the components' section
   * exactly, so both come from the same list.
   */
  const sectionLines = (opts.schematica?.sezioni ?? []).map(
    (s) =>
      `    <schematicsection name="${s.nome}" displayName="${s.titolo.replace(/"/g, "&quot;")}" />`,
  );

  const mainTsx = `// ${opts.origine}
// ${componentLines.length} componenti, ${traceLines.length} connessioni
export default () => (
  <board width="${r3(opts.larghezzaMm ?? bw)}mm" height="${r3(opts.altezzaMm ?? bh)}mm"${strati} autorouter="auto_cloud">
${componentLines.join("\n")}${sectionLines.length ? `\n${sectionLines.join("\n")}` : ""}
${netLines.join("\n")}
${traceLines.join("\n")}${
    pourLines.length + silkLines.length > 0 ? `\n${[...pourLines, ...silkLines].join("\n")}` : ""
  }
  </board>
)
`;

  return {
    fsMap: { "main.tsx": mainTsx },
    components: componentLines.length,
    traces: traceLines.length,
  };
}

export { footprintJsx, portHintsOf, toPascalCase, safeRef, safeNet, risolviNomiRete, num, r3 };
export type { El, FootprintCtx };
