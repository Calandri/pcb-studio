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
 *
 * AND BECAUSE IT IS CODE, IT IS EXECUTED. main.tsx is evaluated on the server,
 * so every string that comes from an imported file — a silkscreen text, a pin
 * name, a manufacturer code, a file name — is attacker-controlled input landing
 * in a program. None of it is ever pasted in raw: values go through jsLiteral()
 * inside an expression container, comments through commentSafe(), and the few
 * names written bare (designators, nets) are reduced to [A-Za-z0-9_] first.
 */
import { disposizionePin, type LatiDelSimbolo } from "./altium-schematic";

interface El {
  type: string;
  [key: string]: unknown;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

const r3 = (v: number): number => Number(v.toFixed(3));

const norm360 = (a: number): number => ((a % 360) + 360) % 360;

// ---------------------------------------------------------------------------
// generated code is code: the only three ways a value from the file gets in
// ---------------------------------------------------------------------------

/**
 * Any JSON-able value as a JavaScript expression, safe to put inside `{...}`.
 *
 * JSON is a subset of JavaScript, with two gaps that matter here: U+2028 and
 * U+2029 are legal raw inside a JSON string and are LINE TERMINATORS to a
 * JavaScript tokenizer older than ES2019 (and to every `//` comment), and
 * `</script` or `<!--` inside a string still closes a script block if the code
 * ever travels through HTML. Both are escaped; the value read back is the same.
 *
 * The one thing JSON cannot express safely in an object literal is a
 * `__proto__` key, which sets the prototype instead of a property: it is
 * dropped.
 */
export function jsLiteral(value: unknown): string {
  const json =
    JSON.stringify(value, (k, v) => (k === "__proto__" ? undefined : v)) ?? "undefined";
  return json
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
    .replace(/<(?=[/!])/g, "\\u003c");
}

/** a string from the file as a JavaScript string literal */
export const jsStr = (value: unknown): string => jsLiteral(String(value ?? ""));

/**
 * Text that goes into a `//` comment.
 *
 * A line comment ends at the first line terminator, and JavaScript has four:
 * \n, \r, U+2028 and U+2029. A file name or a datasheet URL carrying any of
 * them ends the comment and turns the rest of the line into code. They become
 * spaces, as does every other control character, `*\/` is broken up in case the
 * text ever lands in a block comment, and the length is capped.
 */
export function commentSafe(value: unknown, max = 160): string {
  const testo = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/\*\//g, "* /")
    .replace(/\s+/g, " ")
    .trim();
  return testo.length > max ? `${testo.slice(0, Math.max(0, max - 3))}...` : testo;
}

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
 * THE NAME EACH COMPONENT GETS IN THE PROJECT, decided once.
 *
 * A designator is cleaned to [A-Za-z0-9_] before it becomes a name, and two
 * different designators can clean up to the same thing: `C-1` and `C_1` are both
 * `C_1`. Written twice, tscircuit refuses the board ("Multiple immediate
 * children found with name C_1") — or worse, a selector picks the wrong part.
 * The second one gets a number and the import says so.
 *
 * A component with no name at all used to come out as `name=""`, and every
 * connection to it was dropped without a word because its selector was empty.
 * It gets `K<n>` instead, also said out loud. The named ones are placed first,
 * so a real relay called K3 keeps its name and the nameless part takes another.
 *
 * Everything that writes a component name — main.tsx, the net names, the order
 * codes added afterwards — reads it from here, so they cannot disagree.
 */
export interface NomiComponenti {
  /** the name written in main.tsx, by source_component_id */
  perId: Map<string, string>;
  /** the same, by the designator as the file writes it (first holder wins) */
  perDesignator: Map<string, string>;
  avvisi: string[];
}

export function nomiDeiComponenti(cj: El[]): NomiComponenti {
  const perId = new Map<string, string>();
  const perDesignator = new Map<string, string>();
  const avvisi: string[] = [];
  const presi = new Set<string>();
  const libero = (base: string): string => {
    let nome = base;
    for (let i = 2; presi.has(nome); i++) nome = `${base}_${i}`;
    presi.add(nome);
    return nome;
  };
  const componenti = cj.filter((el) => el.type === "source_component");
  componenti.forEach((el, i) => {
    const grezzo = String(el.name ?? "").trim();
    if (!grezzo) return;
    const base = safeRef(grezzo);
    const nome = libero(base);
    perId.set(String(el.source_component_id ?? `#${i}`), nome);
    if (!perDesignator.has(grezzo)) perDesignator.set(grezzo, nome);
    if (nome !== base) {
      avvisi.push(
        `il designator "${grezzo}" nel progetto diventerebbe ${base}, che e' gia' di un altro componente: chiamato ${nome}`,
      );
    }
  });
  componenti.forEach((el, i) => {
    const id = String(el.source_component_id ?? `#${i}`);
    if (perId.has(id)) return;
    const nome = libero(`K${i + 1}`);
    perId.set(id, nome);
    avvisi.push(`un componente senza designator nel file: chiamato ${nome}`);
  });
  return { perId, perDesignator, avvisi };
}

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
  for (const nome of nomiDeiComponenti(cj).perId.values()) preso.set(nome, DI_UN_COMPONENTE);
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
  /** where to say what could not be written exactly */
  avvisi?: string[];
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
 *
 * Only the two outer faces exist for pads and silkscreen: anything else the
 * file says is read as top, so no string from the file reaches the code.
 */
const faccia = (reale: unknown, ctx: FootprintCtx): "top" | "bottom" => {
  const vera = String(reale ?? "top") === "bottom" ? "bottom" : "top";
  return ctx.sotto ? (vera === "bottom" ? "top" : "bottom") : vera;
};

/**
 * The angle of an element relative to its component, which is what tscircuit
 * composes with the component's own rotation.
 */
const angoloLocale = (bordo: number, ctx: FootprintCtx): number =>
  norm360(bordo - (ctx.rotationDeg ?? 0));

/** the angle to write: underneath the board the mirror turns it into its supplement */
const angoloScritto = (locale: number, ctx: FootprintCtx): number =>
  ctx.sotto ? norm360(180 - locale) : locale;

/**
 * Quarter turns are written by swapping the sides, which every later pass
 * understands without knowing anything about rotation; any other angle has to be
 * stated.
 */
function quartoDiGiro(gradi: number): "dritto" | "traverso" | null {
  const m = norm360(gradi) % 180;
  if (m < 3 || m > 177) return "dritto";
  if (Math.abs(m - 90) < 3) return "traverso";
  return null;
}

/** a vector of the element's own frame, in the component's frame */
function vettoreLocale(
  ox: number,
  oy: number,
  locale: number,
  ctx: FootprintCtx,
): { x: number; y: number } {
  const rad = (locale * Math.PI) / 180;
  const x = ox * Math.cos(rad) - oy * Math.sin(rad);
  const y = ox * Math.sin(rad) + oy * Math.cos(rad);
  return { x: r3(ctx.sotto ? -x : x), y: r3(y) };
}

function portHintsOf(el: El): string[] {
  const hints = (el.port_hints as unknown[] | undefined) ?? [];
  return Array.isArray(hints) ? hints.map(String) : [];
}

const positivo = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && n > 0 ? n : null;
};

/**
 * A plated hole, with the shape it has.
 *
 * Reducing every one to a round pad with a round hole was wrong for half the
 * connectors that exist: the shell of a USB-C receptacle is held by SLOTS, a
 * pin header often has a square pad for pin one, and both converters say so —
 * `pill`/`oval` with their outer and hole sizes, `circular_hole_with_rect_pad`,
 * `pill_hole_with_rect_pad`, `hole_with_polygon_pad`. Each becomes the
 * `<platedhole shape=...>` tscircuit has for it.
 *
 * The rotation is handled like the pads': a quarter turn swaps the sides, any
 * other angle is written as `pcbRotation`, which tscircuit composes with the
 * component's. A shape nobody here knows becomes a round pad AND a line in the
 * report, never a silent guess.
 */
function platedHoleJsx(
  el: El,
  ctx: FootprintCtx,
  indent: string,
  p: { x: number; y: number },
  hints: string,
  maskProp: string,
): string {
  const forma = String(el.shape ?? "circle");
  const base = `portHints={${hints}} pcbX={${p.x}} pcbY={${p.y}}${maskProp}`;
  const giro = (bordo: number) => {
    const locale = angoloLocale(bordo, ctx);
    const quarto = quartoDiGiro(locale);
    return {
      locale,
      traverso: quarto === "traverso",
      prop: quarto ? "" : ` pcbRotation={${r3(angoloScritto(locale, ctx))}}`,
    };
  };

  if (forma === "oval" || forma === "pill") {
    let ow = positivo(el.outer_width) ?? positivo(el.outer_diameter);
    let oh = positivo(el.outer_height) ?? ow;
    let hw = positivo(el.hole_width) ?? positivo(el.hole_diameter);
    let hh = positivo(el.hole_height) ?? hw;
    if (ow && oh && hw && hh) {
      const g = giro(num(el.ccw_rotation) ?? 0);
      if (g.traverso) [ow, oh, hw, hh] = [oh, ow, hh, hw];
      return `${indent}<platedhole shape="${forma}" outerWidth={${r3(ow)}} outerHeight={${r3(oh)}} holeWidth={${r3(hw)}} holeHeight={${r3(hh)}}${g.prop} ${base} />`;
    }
  }

  if (
    forma === "circular_hole_with_rect_pad" ||
    forma === "pill_hole_with_rect_pad" ||
    forma === "rotated_pill_hole_with_rect_pad"
  ) {
    const w = positivo(el.rect_pad_width);
    const h = positivo(el.rect_pad_height);
    const rotRect = num(el.rect_ccw_rotation) ?? num(el.ccw_rotation) ?? 0;
    const g = giro(rotRect);
    const raggio = positivo(el.rect_border_radius);
    const bordo = raggio ? ` rectBorderRadius={${r3(raggio)}}` : "";
    const ox = num(el.hole_offset_x) ?? 0;
    const oy = num(el.hole_offset_y) ?? 0;
    /*
     * The hole offset is a vector of the pad's own frame: with the pad written
     * unrotated it is turned into the component's frame here, with the pad
     * written rotated it stays where it is and tscircuit turns it.
     */
    const off = ox || oy
      ? (() => {
          const v = g.prop ? { x: r3(ox), y: r3(oy) } : vettoreLocale(ox, oy, g.locale, ctx);
          return ` holeOffsetX={${v.x}} holeOffsetY={${v.y}}`;
        })()
      : "";
    if (w && h) {
      const [pw, ph] = g.traverso ? [h, w] : [w, h];
      if (forma === "circular_hole_with_rect_pad") {
        const d = positivo(el.hole_diameter);
        if (d) {
          return `${indent}<platedhole shape="circular_hole_with_rect_pad" holeDiameter={${r3(d)}} rectPadWidth={${r3(pw)}} rectPadHeight={${r3(ph)}}${bordo}${off}${g.prop} ${base} />`;
        }
      } else {
        let hw = positivo(el.hole_width);
        let hh = positivo(el.hole_height);
        if (hw && hh) {
          /* a slot turned against its own pad: only quarter turns can be said */
          const relativo = norm360((num(el.hole_ccw_rotation) ?? rotRect) - rotRect);
          const q = quartoDiGiro(relativo);
          if (q === "traverso") [hw, hh] = [hh, hw];
          if (q === null) {
            ctx.avvisi?.push(
              `un'asola ruotata di ${r3(relativo)} gradi rispetto al suo pad: scritta allineata al pad`,
            );
          }
          if (g.traverso) [hw, hh] = [hh, hw];
          return `${indent}<platedhole shape="pill_hole_with_rect_pad" holeWidth={${r3(hw)}} holeHeight={${r3(hh)}} rectPadWidth={${r3(pw)}} rectPadHeight={${r3(ph)}}${bordo}${off}${g.prop} ${base} />`;
        }
      }
    }
  }

  if (forma === "hole_with_polygon_pad") {
    /*
     * The pad outline is relative to the hole and is NOT turned by tscircuit
     * with the component, so it is written as the file states it.
     */
    const contorno = ((el.pad_outline as Array<Record<string, unknown>> | undefined) ?? [])
      .map((q) => ({ x: num(q?.x), y: num(q?.y) }))
      .filter((q): q is { x: number; y: number } => q.x !== null && q.y !== null);
    const forme = ["circle", "oval", "pill", "rotated_pill"];
    const foro = forme.includes(String(el.hole_shape)) ? String(el.hole_shape) : "circle";
    const d = positivo(el.hole_diameter);
    const hw = positivo(el.hole_width) ?? d;
    const hh = positivo(el.hole_height) ?? hw;
    if (contorno.length >= 3 && (foro === "circle" ? d : hw && hh)) {
      const misure =
        foro === "circle" ? `holeDiameter={${r3(d!)}}` : `holeWidth={${r3(hw!)}} holeHeight={${r3(hh!)}}`;
      const punti = contorno.map((q) => `{x:${r3(q.x)},y:${r3(q.y)}}`).join(",");
      return `${indent}<platedhole shape="hole_with_polygon_pad" holeShape="${foro}" ${misure} padOutline={[${punti}]} holeOffsetX={${r3(num(el.hole_offset_x) ?? 0)}} holeOffsetY={${r3(num(el.hole_offset_y) ?? 0)}} ${base} />`;
    }
  }

  if (forma !== "circle") {
    ctx.avvisi?.push(`un foro metallizzato di forma "${commentSafe(forma, 40)}" scritto come foro tondo`);
  }
  const hd = positivo(el.hole_diameter) ?? positivo(el.hole_width) ?? 0.8;
  const od =
    positivo(el.outer_diameter) ??
    (Math.max(
      num(el.outer_width) ?? 0,
      num(el.outer_height) ?? 0,
      num(el.rect_pad_width) ?? 0,
      num(el.rect_pad_height) ?? 0,
    ) ||
      1.6);
  return `${indent}<platedhole shape="circle" holeDiameter={${r3(hd)}} outerDiameter={${r3(od)}} ${base} />`;
}

/**
 * A hole with no copper: round, square, or a slot.
 *
 * tscircuit does NOT turn a hole with its component — it reads its width and
 * height as they are and only its own `pcbRotation` — so the sizes written are
 * the board's, whatever part the hole sits in. A slot used to be dropped on the
 * floor here (only `hole_diameter` was read, and a slot has none).
 */
function holeJsx(
  el: El,
  p: { x: number; y: number },
  indent: string,
  avvisi?: string[],
): string | null {
  const forma = String(el.hole_shape ?? el.shape ?? "circle");
  if (forma === "circle" || forma === "square") {
    const d = positivo(el.hole_diameter) ?? positivo(el.diameter);
    if (!d) return null;
    return forma === "square"
      ? `${indent}<hole shape="rect" width={${r3(d)}} height={${r3(d)}} pcbX={${p.x}} pcbY={${p.y}} />`
      : `${indent}<hole pcbX={${p.x}} pcbY={${p.y}} diameter={${r3(d)}} />`;
  }
  let w = positivo(el.hole_width) ?? positivo(el.width);
  let h = positivo(el.hole_height) ?? positivo(el.height);
  const tipo =
    forma === "rotated_pill" ? "pill" : ["pill", "oval", "rect"].includes(forma) ? forma : null;
  if (!w || !h || !tipo) {
    const d = Math.min(w ?? Infinity, h ?? Infinity);
    if (!Number.isFinite(d)) return null;
    avvisi?.push(`un foro di forma "${commentSafe(forma, 40)}" scritto come foro tondo`);
    return `${indent}<hole pcbX={${p.x}} pcbY={${p.y}} diameter={${r3(d)}} />`;
  }
  const rot = num(el.ccw_rotation) ?? 0;
  const quarto = quartoDiGiro(rot);
  if (quarto === "traverso") [w, h] = [h, w];
  let rotProp = "";
  if (quarto === null) {
    if (tipo === "pill") rotProp = ` pcbRotation={${r3(norm360(rot))}}`;
    else avvisi?.push(`un foro ${tipo} ruotato di ${r3(rot)} gradi: scritto dritto`);
  }
  return `${indent}<hole shape="${tipo}" width={${r3(w)}} height={${r3(h)}} pcbX={${p.x}} pcbY={${p.y}}${rotProp} />`;
}

function footprintJsx(elements: El[], ctx: FootprintCtx, indent: string): string {
  const lines: string[] = [];
  for (const el of elements) {
    const x = num(el.x);
    const y = num(el.y);
    /*
     * The solder mask opening. Without it a pad is a rectangle of copper on a
     * drawing; with it there is the ring of bare laminate the fab actually
     * leaves, which is what a pad looks like on a board and in the CAD it came
     * from.
     */
    const mask = num(el.soldermask_margin);
    const maskProp = mask !== null && mask > 0 ? ` solderMaskMargin={${r3(mask)}}` : "";
    if (el.type === "pcb_smtpad" && x !== null && y !== null) {
      const p = localize(x, y, ctx);
      const hints = jsLiteral(portHintsOf(el));
      const rot = num(el.ccw_rotation);
      const layer = faccia(el.layer, ctx);
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
        const locale = angoloLocale(rot ?? 0, ctx);
        const quarto = quartoDiGiro(locale);
        /*
         * An OBROUND pad is a pill, and at a quarter turn tscircuit has one
         * (`shape="pill"`, sides swapped like the rectangles'). At any other
         * angle the rotated rectangle around it is written instead, and said.
         */
        const pillola = el.shape === "pill" || el.shape === "rotated_pill";
        if (pillola && quarto && w > 0 && h > 0) {
          const [pw, ph] = quarto === "traverso" ? [h, w] : [w, h];
          const raggio = Math.min(num(el.radius) ?? Math.min(w, h) / 2, Math.min(w, h) / 2);
          lines.push(
            `${indent}<smtpad portHints={${hints}} shape="pill" width={${r3(pw)}} height={${r3(ph)}} radius={${r3(raggio)}} pcbX={${p.x}} pcbY={${p.y}} layer="${layer}"${maskProp} />`,
          );
          continue;
        }
        if (pillola) ctx.avvisi?.push("un pad ovale ruotato scritto come il rettangolo che lo contiene");
        /* the corner of a rounded rectangle: an LQFP pin is one */
        const angolo = num(el.rect_border_radius) ?? num(el.corner_radius);
        const angoloProp =
          angolo !== null && angolo > 0 ? ` cornerRadius={${r3(Math.min(angolo, Math.min(w, h) / 2))}}` : "";
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
        if (quarto) {
          const diTraverso = quarto === "traverso";
          lines.push(
            `${indent}<smtpad portHints={${hints}} shape="rect" width={${r3(diTraverso ? h : w)}} height={${r3(diTraverso ? w : h)}}${angoloProp} pcbX={${p.x}} pcbY={${p.y}} layer="${layer}"${maskProp} />`,
          );
        } else {
          lines.push(
            `${indent}<smtpad portHints={${hints}} shape="rotated_rect" width={${r3(w)}} height={${r3(h)}}${angoloProp} ccwRotation={${r3(angoloScritto(locale, ctx))}} pcbX={${p.x}} pcbY={${p.y}} layer="${layer}"${maskProp} />`,
          );
        }
      }
    } else if (el.type === "pcb_plated_hole" && x !== null && y !== null) {
      const p = localize(x, y, ctx);
      lines.push(platedHoleJsx(el, ctx, indent, p, jsLiteral(portHintsOf(el)), maskProp));
    } else if (el.type === "pcb_hole" && x !== null && y !== null) {
      const riga = holeJsx(el, localize(x, y, ctx), indent, ctx.avvisi);
      if (riga) lines.push(riga);
    } else if (el.type === "pcb_silkscreen_text" && x !== null && y !== null) {
      const p = localize(x, y, ctx);
      const text = String(el.text ?? "");
      if (text) {
        lines.push(
          `${indent}<silkscreentext pcbX={${p.x}} pcbY={${p.y}} text={${jsStr(text)}} fontSize={${r3(num(el.font_size) ?? 1)}} layer="${faccia(el.layer, ctx)}" />`,
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
        .map((p) => ({ x: num(p?.x), y: num(p?.y) }))
        .filter((p): p is { x: number; y: number } => p.x !== null && p.y !== null)
        .map((p) => localize(p.x, p.y, ctx));
      if (route.length >= 2) {
        const punti = route.map((p) => `{x:${p.x},y:${p.y}}`).join(",");
        lines.push(
          `${indent}<silkscreenpath route={[${punti}]} strokeWidth={${r3(num(el.stroke_width) ?? 0.1)}} layer="${faccia(el.layer, ctx)}" />`,
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

/**
 * The pin labels of a reusable footprint: `pin<n>` for every pad NUMBERED n.
 *
 * It used to number the sorted pad names from one — `pin${i + 1}` — which is
 * right only when the pads are 1..N with no gaps. A footprint with pads 1, 2,
 * 4, 5 (a part with a pin removed) got pin3 = "4" and pin4 = "5": every label
 * after the gap on the wrong pad. A pad named by a word (SH, EP, A1) is
 * reached by its own name and needs no label.
 */
export function etichetteDeiPin(elements: El[]): string {
  const etichette = new Map<string, string>();
  for (const e of elements) {
    for (const hint of portHintsOf(e)) {
      if (!/^\d+$/.test(hint)) continue;
      const chiave = `pin${Number(hint)}`;
      if (!etichette.has(chiave)) etichette.set(chiave, hint);
    }
  }
  const ordinate = [...etichette].sort((a, b) => Number(a[0].slice(3)) - Number(b[0].slice(3)));
  return ordinate.length ? jsLiteral(Object.fromEntries(ordinate)) : "";
}

/**
 * The board outline worth writing, or null when the rectangle says it all.
 *
 * Both converters hand over the outline the CAD drew, and what was written here
 * was always the bounding rectangle: an L shaped board, a board with a notch for
 * a connector, a round one, all came in as the rectangle around them — with
 * copper poured and parts allowed where there is no board. tscircuit takes the
 * polygon as `outline`; a plain rectangle stays width and height, which reads
 * better and is the same board.
 */
export function contornoDaScrivere(
  punti: unknown,
): { punti: Array<{ x: number; y: number }>; larghezza: number; altezza: number } | null {
  const grezzi = (Array.isArray(punti) ? punti : [])
    .map((p) => ({ x: num((p as { x?: unknown })?.x), y: num((p as { y?: unknown })?.y) }))
    .filter((p): p is { x: number; y: number } => p.x !== null && p.y !== null)
    .map((p) => ({ x: r3(p.x), y: r3(p.y) }));
  const puliti: Array<{ x: number; y: number }> = [];
  for (const p of grezzi) {
    const prima = puliti[puliti.length - 1];
    if (!prima || prima.x !== p.x || prima.y !== p.y) puliti.push(p);
  }
  // the closing vertex repeats the first one
  if (
    puliti.length > 1 &&
    puliti[0].x === puliti[puliti.length - 1].x &&
    puliti[0].y === puliti[puliti.length - 1].y
  ) {
    puliti.pop();
  }
  if (puliti.length < 3) return null;
  const xs = puliti.map((p) => p.x);
  const ys = puliti.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  if (maxX - minX <= 0 || maxY - minY <= 0) return null;
  const vicino = (a: number, b: number) => Math.abs(a - b) <= 0.01;
  const soloAngoli = puliti.every(
    (p) => (vicino(p.x, minX) || vicino(p.x, maxX)) && (vicino(p.y, minY) || vicino(p.y, maxY)),
  );
  if (soloAngoli) return null;
  return { punti: puliti, larghezza: r3(maxX - minX), altezza: r3(maxY - minY) };
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
 * The value of a passive as the compiler reads it, or null.
 *
 * "10 kOhms" is a phrase, "10kohm" is a quantity: spaces out, plural out,
 * a decimal comma becomes a point, and the European "4k7" becomes "4.7k". What
 * is still not a number followed by a unit is NOT written: it used to go in as
 * `resistance="..."` straight from the file, which is both a component that
 * fails to build and a string nobody had checked inside the code.
 */
export function valoreLeggibile(grezzo: string | null | undefined): string | null {
  let v = String(grezzo ?? "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/ohms$/i, "ohm")
    .replace(/farads?$/i, "F")
    .replace(/^(\d+),(\d+)/, "$1.$2");
  const europeo = /^(\d+)([RrKkMmGgpnuµ])(\d+)([A-Za-zµΩ]*)$/.exec(v);
  if (europeo) {
    const [, intero, unita, decimali, resto] = europeo;
    v = `${intero}.${decimali}${/^[Rr]$/.test(unita) ? "" : unita}${resto}`;
  }
  return /^\d+(?:\.\d+)?[A-Za-zµΩ]{0,8}$/.test(v) ? v : null;
}

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
  /**
   * The name the source CAD gives the footprint — "CAP 0402_1005", "SOT23-5",
   * "LQFP64". It is what goes in the PACKAGE column of the bill of materials: an
   * imported board writes its footprints inline, as geometry, and a purchasing
   * office reading "<footprint> inline" learns nothing about what to buy.
   */
  pattern?: string;
}

export interface ProjectFromCircuitJson {
  fsMap: Record<string, string>;
  components: number;
  traces: number;
  /** what could not be written as the file has it */
  warnings: string[];
  /** the name each designator got in main.tsx: see nomiDeiComponenti */
  nomi: Map<string, string>;
}

export function circuitJsonToProjectFiles(
  cj: El[],
  opts: {
    origine: string;
    larghezzaMm?: number;
    altezzaMm?: number;
    /**
     * The board outline, when the caller has a better one than the Circuit
     * JSON's (Altium: arcs included). Otherwise pcb_board.outline is used.
     */
    contorno?: Array<{ x: number; y: number }>;
    /** identity per component designator: see ComponentIdentity */
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
    /**
     * The poured planes: layer, the net they carry, and the outline the source
     * CAD drew when the pour is not a flood over the whole face. A split power
     * plane is four pours on one layer, one per rail, each with its own shape.
     */
    piani?: Array<{ faccia: string; net: string; contorno?: Array<{ x: number; y: number }> }>;
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
  const warnings: string[] = [];
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
  const nomi = nomiDeiComponenti(cj);
  warnings.push(...nomi.avvisi);

  const nomeDiRete = risolviNomiRete(cj);
  const avvisiForme: string[] = [];

  const componentLines: string[] = [];
  let compIndex = 0;
  for (const el of cj) {
    if (el.type !== "source_component") continue;
    compIndex++;
    const sourceId = String(el.source_component_id ?? `#${compIndex - 1}`);
    const pcb = pcbComponentBySource.get(sourceId);
    const grezzo = String(el.name ?? "").trim();
    const name = nomi.perId.get(sourceId) ?? `K${compIndex}`;
    /*
     * What the caller knows about a part is keyed by the designator the FILE
     * uses, which is not always the name written here (`C-1` becomes `C_1`).
     * Only the first holder of a designator answers to it: a renamed duplicate
     * is only looked up by its own new name.
     */
    const proprio = nomi.perDesignator.get(grezzo) === name;
    const cerca = <T,>(m: Map<string, T> | undefined): T | undefined =>
      m ? ((proprio ? m.get(grezzo) : undefined) ?? m.get(name)) : undefined;

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
    const pos = ` pcbX={${r3(cx)}} pcbY={${r3(cy)}}${rotation ? ` pcbRotation={${r3(rotation)}}` : ""}${sotto ? ` layer="bottom"` : ""}`;

    // inline footprint from this component's pcb elements (real geometry)
    const compEls = pcb ? cj.filter((e) => e.pcb_component_id === pcb.pcb_component_id) : [];
    const hasGeometry = compEls.some(
      (e) => e.type === "pcb_smtpad" || e.type === "pcb_plated_hole" || e.type === "pcb_hole",
    );
    const id = cerca(opts.identita);
    const nomeFootprint = id?.pattern?.replace(/\s+/g, " ").trim();
    const prima = avvisiForme.length;
    const footprint = hasGeometry
      ? `\n    footprint={\n      <footprint${nomeFootprint ? ` name={${jsStr(nomeFootprint.slice(0, 120))}}` : ""}>\n${footprintJsx(compEls, { cx, cy, rotationDeg: rotation, sotto, avvisi: avvisiForme }, "        ")}\n      </footprint>\n    }`
      : "";
    for (let i = prima; i < avvisiForme.length; i++) avvisiForme[i] = `${name}: ${avvisiForme[i]}`;

    // pin labels from source ports
    const porte = cj.filter((e) => e.type === "source_port" && e.source_component_id === sourceId);
    const etichette: Record<string, string> = {};
    for (const e of porte) {
      const numero = e.pin_number ? String(e.pin_number) : "";
      const pin = numero ? `pin${numero}` : String(e.name ?? "?");
      if (pin in etichette || pin === "__proto__") continue;
      etichette[pin] = String(e.name ?? pin);
    }
    const labels = Object.keys(etichette).length
      ? `\n    pinLabels={${jsLiteral(etichette)}}`
      : "";

    /*
     * WHAT THE PART IS, not just where its pads are.
     *
     * A board arrives with a designator and a footprint; without the value and
     * the manufacturer code it is a bag of pads you cannot order. The identity
     * comes from the source CAD and is written here, so the imported project has
     * a BOM from minute one instead of ninety-eight anonymous chips.
     */
    const corpo = cerca(opts.corpi3d);
    const scatola = corpo?.scatola;
    const misureScatola = scatola
      ? [scatola.larghezza, scatola.profondita, scatola.altezza].map((v) => num(v))
      : null;
    const cad = corpo?.url
      ? ` cadModel={{ objUrl: ${jsStr(corpo.url)} }}`
      : misureScatola && misureScatola.every((v) => v !== null && v > 0)
        ? /*
           * No model in the file: a box of the declared height over the real
           * footprint. It says what it is (a placeholder) and it is worth having,
           * because the 3D view is where you find out whether the enclosure closes.
           */
          ` cadModel={{ jscad: { type: "colorize", color: [0.24, 0.26, 0.25], shape: { type: "cuboid", size: [${misureScatola.map((v) => r3(v!)).join(", ")}], center: [0, 0, ${r3(misureScatola[2]! / 2)}] } } }}`
        : "";

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
    /*
     * DUE PIN VUOL DIRE DUE PIN.
     *
     * Un <diode>, un <resistor>, un <capacitor> accettano solo le etichette che
     * la loro forma prevede: pin1, pin2, anode, cathode. Su BIRDY_BS il diodo D8
     * arriva dal file con CINQUE porte (1, 2, 219, 220, 221 — il simbolo ne
     * dichiara piu' di quante ne ha il package), e tscircuit rifiuta di
     * costruirlo: componente perso, e con lui due connessioni, piu' l'errore di
     * piazzamento a valle.
     *
     * Meglio un simbolo generico che un componente che non esiste: se le porte
     * non stanno nella forma, si scrive <chip>, che le etichette le accetta
     * tutte. Si perde il triangolo sullo schematico, si tiene la scheda.
     */
    const massimoPin: Record<string, number> = {
      resistor: 2,
      capacitor: 2,
      led: 2,
      diode: 2,
      inductor: 2,
      crystal: 2,
      fuse: 2,
    };
    const troppePorte = (massimoPin[wantedTag] ?? Infinity) < porte.length;
    /*
     * The value written the way the compiler reads it (see valoreLeggibile). One
     * that cannot be read is not written, and the part becomes a chip rather
     * than a passive that fails to build.
     */
    const valoreScritto = requiredProp ? valoreLeggibile(value) : null;
    const tag = (requiredProp && !valoreScritto) || troppePorte ? "chip" : wantedTag;
    const valueProp = requiredProp && valoreScritto && tag !== "chip"
      ? ` ${requiredProp}={${jsStr(valoreScritto)}}`
      : "";
    const pulito = (v: string) => v.replace(/\s+/g, " ").trim();
    const mpnProp = id?.mpn ? ` manufacturerPartNumber={${jsStr(pulito(id.mpn).slice(0, 120))}}` : "";
    const descr = [id?.produttore, id?.descrizione].filter(Boolean).join(" - ");
    const descrProp = descr ? ` description={${jsStr(pulito(descr).slice(0, 200))}}` : "";

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
    const disegno = cerca(opts.schematica?.perComponente);
    const sezioneProp = disegno?.sezione ? ` schSectionName={${jsStr(disegno.sezione)}}` : "";
    /*
     * The sides of the symbol. tscircuit halves the pins left and right in pin
     * order, which on a 64 pin part is a column of sixty-four labels; the file
     * knows the designer put the resets on one side and the memory bus on the
     * other. Only for the parts that have a symbol worth reproducing — a two pin
     * capacitor is better off with its own.
     */
    const disposizione = disposizionePin(disegno?.lati);
    const pinProp = disposizione ? ` schPinArrangement={${jsLiteral(disposizione)}}` : "";

    componentLines.push(
      `    <${tag} name="${name}"${valueProp}${mpnProp}${descrProp}${pos}${sezioneProp}${pinProp}${cad}${footprint}${labels} />`,
    );
  }
  warnings.push(...avvisiForme.slice(0, 20));
  if (avvisiForme.length > 20) {
    warnings.push(`... e altri ${avvisiForme.length - 20} elementi scritti in forma approssimata`);
  }

  // connectivity: 2-port source traces become direct <trace>; larger nets get <net>
  const netLines: string[] = [];
  const traceLines: string[] = [];
  const namedNets = new Set<string>();
  /*
   * A port is reached by its name, which comes from the file. A name that cannot
   * be a selector at all — spaces, quotes, `>` — is reached by its pin number
   * instead, when it has one; whatever is written, it is a string literal.
   */
  const SELETTORE_IMPOSSIBILE = /[\s"'`\\<>,]/;
  const selectorOf = (sourcePortId: string): string | null => {
    const port = portById.get(sourcePortId);
    if (!port) return null;
    const comp = nomi.perId.get(String(port.source_component_id ?? ""));
    if (!comp) return null;
    const nome = String(port.name ?? "");
    const numero = port.pin_number ? String(port.pin_number) : "";
    const pin = nome && !SELETTORE_IMPOSSIBILE.test(nome) ? nome : numero ? `pin${numero}` : nome;
    if (!pin) return null;
    return `.${comp} > .${pin}`;
  };

  for (const el of cj) {
    if (el.type !== "source_trace") continue;
    const ports = ((el.connected_source_port_ids as string[] | undefined) ?? [])
      .map((p) => selectorOf(String(p)))
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
      traceLines.push(`    <trace from={${jsStr(ports[0])}} to={${jsStr(ports[1])}} />`);
    } else {
      const net = netName ? nomeDiRete(netName) : safeNet(`NET_${traceLines.length}`);
      if (!namedNets.has(net)) {
        namedNets.add(net);
        netLines.push(`    <net name="${net}" />`);
      }
      for (const port of ports) {
        traceLines.push(`    <trace from={${jsStr(port)}} to="net.${net}" />`);
      }
    }
  }

  const board = cj.find((el) => el.type === "pcb_board");
  const contorno = contornoDaScrivere(opts.contorno ?? board?.outline);
  const bw = contorno?.larghezza ?? (board ? (num(board.width) ?? 40) : 40);
  const bh = contorno?.altezza ?? (board ? (num(board.height) ?? 30) : 30);

  /*
   * The silkscreen that belongs to no part — the board's name, a polarity mark,
   * a logo outline — hangs off the board, not off a footprint. On an imported
   * board it is a handful of rows against hundreds inside the components, and
   * dropping it would delete exactly the writing a person put there by hand.
   */
  const silkLines: string[] = [];
  const diScheda: FootprintCtx = { avvisi: [] };
  for (const el of cj) {
    if (el.pcb_component_id) continue;
    /*
     * The holes that belong to nobody: mounting holes drilled in the board, not
     * in a part. They used to travel inside whatever footprint the CAD's flat
     * model had filed them under — three 2.4mm holes ended up inside a
     * microphone, on the other side of the board — and there they would follow
     * the part around if anybody moved it.
     */
    if (el.type === "pcb_hole") {
      const x = num(el.x);
      const y = num(el.y);
      if (x === null || y === null) continue;
      const riga = holeJsx(el, { x: r3(x), y: r3(y) }, "    ", diScheda.avvisi);
      if (riga) silkLines.push(riga);
      continue;
    }
    if (el.type === "pcb_silkscreen_text") {
      const text = String(el.text ?? "");
      if (!text) continue;
      silkLines.push(
        `    <silkscreentext pcbX={${r3(num(el.x) ?? 0)}} pcbY={${r3(num(el.y) ?? 0)}} text={${jsStr(text)}} fontSize={${r3(num(el.font_size) ?? 1)}} layer="${faccia(el.layer, diScheda)}" />`,
      );
    } else if (el.type === "pcb_silkscreen_path") {
      const route = ((el.route as Array<Record<string, unknown>> | undefined) ?? [])
        .map((p) => ({ x: num(p?.x), y: num(p?.y) }))
        .filter((p): p is { x: number; y: number } => p.x !== null && p.y !== null);
      if (route.length < 2) continue;
      const punti = route.map((p) => `{x:${r3(p.x)},y:${r3(p.y)}}`).join(",");
      silkLines.push(
        `    <silkscreenpath route={[${punti}]} strokeWidth={${r3(num(el.stroke_width) ?? 0.1)}} layer="${faccia(el.layer, diScheda)}" />`,
      );
    }
  }
  warnings.push(...(diScheda.avvisi ?? []).map((a) => `scheda: ${a}`));

  /*
   * The planes. A pour is not decoration: it is where the returns go, and on a
   * four layer board it is most of the copper. Written as <copperpour> it is the
   * same thing the app builds on its own boards, so from here on the imported
   * board is treated like any other.
   */
  const STRATO_DI_RAME = /^(top|bottom|inner[1-8])$/;
  const pourLines = (opts.piani ?? [])
    .filter((p) => STRATO_DI_RAME.test(String(p.faccia)))
    .map((p) => {
      /*
       * With an outline the pour fills exactly the shape the file drew; without
       * one it floods the face, which is what a ground plane does. Both are
       * <copperpour>: the outline is a prop, and it is what makes a split plane
       * representable at all.
       */
      /*
       * `boardEdgeMargin={0}` is not decoration: without it the solver keeps its
       * own 0.2mm back from the shape it is given, and an outline read off a file
       * comes out 0.2mm smaller all the way round. Measured on this board's power
       * layer: 563.01mm2 drawn, 468.23mm2 poured, 94.78mm2 missing — 17% of the
       * layer, lost to a default. The margin exists to keep copper off the edge of
       * the BOARD; here the edge is already where the CAD put it.
       */
      const punti = (p.contorno ?? [])
        .map((q) => ({ x: num(q?.x), y: num(q?.y) }))
        .filter((q): q is { x: number; y: number } => q.x !== null && q.y !== null);
      const contornoPiano = punti.length
        ? ` boardEdgeMargin={0} outline={[${punti.map((q) => `{x:${r3(q.x)},y:${r3(q.y)}}`).join(",")}]}`
        : "";
      return `    <copperpour layer="${p.faccia}" connectsTo="net.${nomeDiRete(String(p.net))}"${contornoPiano} />`;
    });
  const strati = num(opts.strati);
  const stratiProp =
    strati !== null && [4, 6, 8, 10].includes(strati) ? ` layers={${strati}}` : "";
  const outlineProp = contorno
    ? ` outline={[${contorno.punti.map((q) => `{x:${q.x},y:${q.y}}`).join(",")}]}`
    : "";

  /*
   * The frames and the titles of the blocks. `schSectionName` alone packs the
   * parts together but draws nothing around them: these are the lines and the
   * names that make a sheet look like a schematic instead of eight clusters that
   * happen to be near each other. The name must match the components' section
   * exactly, so both come from the same list.
   */
  const sectionLines = (opts.schematica?.sezioni ?? []).map(
    (s) =>
      `    <schematicsection name={${jsStr(s.nome)}} displayName={${jsStr(s.titolo)}} />`,
  );

  const larghezza = num(opts.larghezzaMm) ?? bw;
  const altezza = num(opts.altezzaMm) ?? bh;
  const mainTsx = `// ${commentSafe(opts.origine, 300)}
// ${componentLines.length} componenti, ${traceLines.length} connessioni
export default () => (
  <board width="${r3(larghezza)}mm" height="${r3(altezza)}mm"${outlineProp}${stratiProp} autorouter="auto_cloud">
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
    warnings,
    nomi: nomi.perDesignator,
  };
}

export { footprintJsx, holeJsx, portHintsOf, toPascalCase, safeRef, safeNet, risolviNomiRete, num, r3 };
export type { El, FootprintCtx };
