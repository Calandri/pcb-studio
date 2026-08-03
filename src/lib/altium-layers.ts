import type { Layer, ManualRoute } from "./manual-routes";

/**
 * The LAYERS of an Altium board, and what each one is for.
 *
 * Without this everything arrives as copper on two faces. Measured on BAT_BS: of
 * the 2333 "tracks" only 870 are copper. The other 1463 are 609 of silkscreen,
 * 506 of assembly drawing, 336 of courtyard and 12 mechanical, and imported as
 * copper they become a board where the outline printed around every part is a
 * track. That is what "the copper import is butchered" looked like, and it is
 * also why the vias were missing: they live in their own array, on their own
 * layer, and nobody was reading it.
 *
 * The file says all of it. Every primitive carries `layerId`, `primitiveLayers`
 * maps that id to a name, and the stack in `layers` says which of those names
 * are copper and IN WHICH ORDER. What was missing was reading it.
 *
 * The copper faces are named by POSITION in the stack, never by name: here the
 * inner layers are called GND and PWR, on the next board they will be called
 * something else, and a layer named GND is not necessarily the second one.
 */

export type Genere =
  | "rame"
  | "serigrafia"
  | "pasta"
  | "maschera"
  | "courtyard"
  | "montaggio"
  | "meccanico"
  | "ignoto";

export interface Strato {
  genere: Genere;
  /** the copper face, only for copper layers */
  faccia?: Layer;
  /** which side of the board it documents */
  lato: "top" | "bottom";
  nome: string;
}

/** Altium works in mils, Circuit JSON in millimetres */
export const MIL = 0.0254;

/** mils on the Altium sheet -> millimetres from the centre of the board */
export type Trasforma = (xMil: number, yMil: number) => { x: number; y: number };

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const r3 = (v: number): number => Number(v.toFixed(3));
/*
 * Widths keep a decimal more than positions: a 6 mil trace is 0.1524mm, and
 * rounded to 0.152 it lands a ten-thousandth under the minimum the same file
 * declares — five hundred violations of a rule the board actually respects.
 */
const r4 = (v: number): number => Number(v.toFixed(4));
const arr = (v: unknown): Array<Record<string, unknown>> =>
  Array.isArray(v) ? (v as Array<Record<string, unknown>>) : [];

const NON_RAME = /overlay|paste|solder|dielectric|mechanical|courtyard|assembly|designator|drill|keep.?out|3d body|component center|multi.?layer/i;

/** what each layer id is, read from the stack and from the primitive names */
export function leggiStrati(pcb: Record<string, unknown>): Map<number, Strato> {
  const out = new Map<number, Strato>();

  /*
   * The copper, in stack order. `layers` is the physical stack (Top Paste, Top
   * Overlay, TOP, Dielectric, GND, ...) and each entry carries the
   * `legacyLayerId` that the primitives use. Ordering by the stack is what makes
   * the first copper layer top, the last bottom, and the ones in between inner1
   * and inner2 — the four faces tscircuit knows.
   */
  const rame: Array<{ id: number; nome: string }> = [];
  for (const l of arr(pcb.layers)) {
    const nome = String(l.name ?? "").trim();
    const id = num(l.legacyLayerId);
    if (!nome || id === null || NON_RAME.test(nome)) continue;
    rame.push({ id, nome });
  }
  const facce: Layer[] = ["top", "inner1", "inner2", "bottom"];
  rame.forEach((r, i) => {
    const faccia: Layer =
      i === 0 ? "top" : i === rame.length - 1 ? "bottom" : (facce[Math.min(i, 2)] ?? "inner2");
    out.set(r.id, {
      genere: "rame",
      faccia,
      lato: faccia === "bottom" ? "bottom" : "top",
      nome: r.nome,
    });
  });

  for (const p of arr(pcb.primitiveLayers)) {
    const id = num(p.layerId);
    const nome = String(p.name ?? "").trim();
    if (id === null || !nome || out.has(id)) continue;
    const lato: "top" | "bottom" = /bottom/i.test(nome) ? "bottom" : "top";
    const genere: Genere = /overlay/i.test(nome)
      ? "serigrafia"
      : /paste/i.test(nome)
        ? "pasta"
        : /solder/i.test(nome)
          ? "maschera"
          : /courtyard/i.test(nome)
            ? "courtyard"
            : /designator|comment/i.test(nome)
              ? "serigrafia" // the reference printed on the board IS silkscreen
              : /assembly|3d body|component center/i.test(nome)
                ? "montaggio"
                : /mechanical|keep.?out|drill|multi.?layer/i.test(nome)
                  ? "meccanico"
                  : "ignoto";
    out.set(id, { genere, lato, nome });
  }
  return out;
}

/** how many primitives of each kind sit on each layer: the import's receipt */
export function inventario(
  pcb: Record<string, unknown>,
  strati: Map<number, Strato>,
): Array<{ strato: string; genere: Genere; tipo: string; quante: number }> {
  const conta = new Map<string, number>();
  const tipi: Array<[string, unknown]> = [
    ["tracce", pcb.tracks],
    ["archi", pcb.arcs],
    ["via", pcb.vias],
    ["riempimenti", pcb.fills],
    ["regioni", pcb.regions],
    ["testi", pcb.texts],
    ["pad", pcb.pads],
  ];
  for (const [tipo, lista] of tipi) {
    for (const el of arr(lista)) {
      const s = strati.get(num(el.layerId) ?? -1);
      const key = `${s?.nome ?? `id=${el.layerId}`}|${s?.genere ?? "ignoto"}|${tipo}`;
      conta.set(key, (conta.get(key) ?? 0) + 1);
    }
  }
  return [...conta]
    .map(([k, quante]) => {
      const [strato, genere, tipo] = k.split("|");
      return { strato, genere: genere as Genere, tipo, quante };
    })
    .sort((a, b) => b.quante - a.quante);
}

/**
 * THE NAME OF EVERY PAD, which is the number printed in the datasheet.
 *
 * The toolkit does not expose it: a pad comes back with its size, its net and no
 * name, so an imported board had pins numbered by a global counter — the first
 * pin of the microcontroller was called 22, and every selector, label and error
 * message said 22. It is in the file, at the head of each pad record in
 * `Pads6/Data`: one byte of type, a four byte block length, one byte of string
 * length, then the name. Read straight from `rawRecords`, which the toolkit does
 * hand over.
 *
 * The order matters and is not the obvious one: this board stores the pads of its
 * LQFP64 as 24, 23, 22, 19, 8… so numbering them by position would have produced
 * a plausible and wrong pinout — the worst kind.
 */
export function nomiDeiPad(pcb: Record<string, unknown>): string[] {
  const grezzi = arr(pcb.rawRecords).filter((r) =>
    /Pads6\/Data/.test(String(r.registryId ?? "")),
  );
  return grezzi.map((r) => {
    const b64 = String(r.rawBase64 ?? "");
    if (!b64) return "";
    const buf = Buffer.from(b64, "base64");
    // 0x02 is the pad record; anything else is not one and is left alone
    if (buf.length < 7 || buf.readUInt8(0) !== 2) return "";
    const blocco = buf.readUInt32LE(1);
    const len = buf.readUInt8(5);
    if (len + 1 > blocco || 6 + len > buf.length) return "";
    return buf.subarray(6, 6 + len).toString("latin1").trim();
  });
}

/** the name of each net, by index */
export function nomiDelleReti(pcb: Record<string, unknown>): Map<number, string> {
  const out = new Map<number, string>();
  for (const n of arr(pcb.nets)) {
    const i = num(n.netIndex);
    const nome = String(n.name ?? "").trim();
    if (i !== null && nome) out.set(i, nome);
  }
  return out;
}

/**
 * An Altium arc as a polyline.
 *
 * Angles are degrees counterclockwise from the positive x axis, and the arc runs
 * CCW from start to end: when the end is not past the start it has wrapped
 * around, and a start equal to the end is a full circle (there are two on this
 * board, the ring pads of a test point). One segment every fifteen degrees is
 * below what the eye or the fab resolves.
 */
function arcoInPunti(
  arc: Record<string, unknown>,
  t: Trasforma,
): Array<{ x: number; y: number }> {
  const cx = num(arc.x);
  const cy = num(arc.y);
  const r = num(arc.radius);
  if (cx === null || cy === null || r === null || r <= 0) return [];
  const da = num(arc.startAngle) ?? 0;
  const a = num(arc.endAngle) ?? 0;
  const ampiezza = a > da ? a - da : a + 360 - da;
  const passi = Math.max(2, Math.ceil(ampiezza / 15));
  const punti: Array<{ x: number; y: number }> = [];
  for (let i = 0; i <= passi; i++) {
    const ang = ((da + (ampiezza * i) / passi) * Math.PI) / 180;
    const p = t(cx + r * Math.cos(ang), cy + r * Math.sin(ang));
    punti.push({ x: r3(p.x), y: r3(p.y) });
  }
  return punti;
}

export interface RameNativo {
  routes: ManualRoute[];
  tracce: number;
  archi: number;
  via: number;
  /** copper with no net: geometry with no owner, which is not imported */
  senzaRete: number;
  /** zero length slivers: not copper, leftovers of edits */
  scartate: number;
  /** filled rectangles of copper: on this board they are the net tie bridges */
  riempimenti: number;
  /**
   * The bridges, named: a net tie is a component whose two pads are on two
   * different nets and are joined by a slab of copper. The board shorts them,
   * the schematic keeps them apart on purpose, and whoever imports has to be
   * told which is which.
   */
  ponti: Array<{ da: string; a: string }>;
}

/**
 * The copper already drawn, on the layer it is actually on.
 *
 * Only what has a NET: a copper primitive without one is a fill or a keepout,
 * and imported as a trace it would be a piece of metal that belongs to nothing —
 * the router cannot respect it and the check cannot count it.
 *
 * A via becomes a route of two points at the same place on two different layers:
 * that is exactly the shape manual-routes turns into a via, the same one the
 * router produces, so nothing downstream needs a special case. Six hundred and
 * forty of them on this board, and until now all six hundred and forty were
 * dropped on the floor.
 */
export function rameNativo(
  pcb: Record<string, unknown>,
  strati: Map<number, Strato>,
  t: Trasforma,
  larghezzaPredefinitaMm: number,
): RameNativo {
  /** every route below carries this: it is copper that arrives, not copper we drew */
  const nomi = nomiDelleReti(pcb);
  const out: RameNativo = {
    routes: [],
    tracce: 0,
    archi: 0,
    via: 0,
    senzaRete: 0,
    scartate: 0,
    riempimenti: 0,
    ponti: [],
  };
  const importato = true as const;

  const rete = (el: Record<string, unknown>): string | null => {
    const i = num(el.netIndex);
    return i === null ? null : (nomi.get(i) ?? null);
  };

  /*
   * A RUN OF COPPER IS ONE LINE, NOT A HEAP OF SEGMENTS.
   *
   * Altium stores a track per straight piece, and importing them one by one gives
   * the right geometry and the wrong drawing: every piece is a polyline of two
   * points with round caps, so at each bend two caps overlap and a 45 degree
   * staircase comes out as a chain of sausages instead of a clean bend. It also
   * means the checks see 870 traces where the board has a few hundred runs.
   *
   * So the pieces that share an endpoint, on the same net, the same layer and the
   * same width, are chained into one polyline. Nothing moves: the endpoints are
   * the file's, to the micron.
   */
  const daUnire = new Map<
    string,
    Array<{ a: { x: number; y: number }; b: { x: number; y: number }; faccia: Layer; net: string; width: number }>
  >();
  for (const tr of arr(pcb.tracks)) {
    const s = strati.get(num(tr.layerId) ?? -1);
    if (s?.genere !== "rame" || !s.faccia) continue;
    const net = rete(tr);
    if (!net) {
      out.senzaRete++;
      continue;
    }
    const x1 = num(tr.x1);
    const y1 = num(tr.y1);
    const x2 = num(tr.x2);
    const y2 = num(tr.y2);
    if (x1 === null || y1 === null || x2 === null || y2 === null) continue;
    const a = t(x1, y1);
    const b = t(x2, y2);
    /*
     * Le schegge a lunghezza zero non sono rame: Altium ne lascia un centinaio,
     * lunghe meno di un micron, resti di modifiche. Importate diventano tracce
     * vere che i controlli contano e che nessuno vede.
     */
    if (r3(a.x) === r3(b.x) && r3(a.y) === r3(b.y)) {
      out.scartate++;
      continue;
    }
    const width = r4((num(tr.width) ?? 0) * MIL || larghezzaPredefinitaMm);
    const chiave = `${net}|${s.faccia}|${width}`;
    daUnire.set(chiave, [
      ...(daUnire.get(chiave) ?? []),
      {
        a: { x: r3(a.x), y: r3(a.y) },
        b: { x: r3(b.x), y: r3(b.y) },
        faccia: s.faccia,
        net,
        width,
      },
    ]);
    out.tracce++;
  }

  for (const [, pezzi] of daUnire) {
    /** which pieces touch each point: a point with two is a bend, with more a fork */
    const perPunto = new Map<string, number[]>();
    const k = (p: { x: number; y: number }) => `${p.x},${p.y}`;
    pezzi.forEach((p, i) => {
      for (const estremo of [p.a, p.b]) {
        perPunto.set(k(estremo), [...(perPunto.get(k(estremo)) ?? []), i]);
      }
    });
    const usato = new Array(pezzi.length).fill(false);
    /** the next piece, only where exactly two meet: a fork ends the run */
    const prosegui = (punto: { x: number; y: number }, da: number): number | null => {
      const qui = perPunto.get(k(punto)) ?? [];
      if (qui.length !== 2) return null;
      const altro = qui[0] === da ? qui[1] : qui[0];
      return usato[altro] ? null : altro;
    };
    for (let i = 0; i < pezzi.length; i++) {
      if (usato[i]) continue;
      usato[i] = true;
      const punti = [pezzi[i].a, pezzi[i].b];
      // forward, then backward: a run found from its middle is still one run
      for (const avanti of [true, false]) {
        let corrente = i;
        for (;;) {
          const coda = avanti ? punti[punti.length - 1] : punti[0];
          const prossimo = prosegui(coda, corrente);
          if (prossimo === null) break;
          usato[prossimo] = true;
          const p = pezzi[prossimo];
          const nuovo = k(p.a) === k(coda) ? p.b : p.a;
          if (avanti) punti.push(nuovo);
          else punti.unshift(nuovo);
          corrente = prossimo;
        }
      }
      out.routes.push({
        connection: `net.${pezzi[i].net}`,
        net: pezzi[i].net,
        points: punti.map((p) => ({ ...p, layer: pezzi[i].faccia })),
        width: pezzi[i].width,
        importato,
      });
    }
  }

  for (const ar of arr(pcb.arcs)) {
    const s = strati.get(num(ar.layerId) ?? -1);
    if (s?.genere !== "rame" || !s.faccia) continue;
    const net = rete(ar);
    if (!net) {
      out.senzaRete++;
      continue;
    }
    const punti = arcoInPunti(ar, t);
    if (punti.length < 2) continue;
    out.routes.push({
      connection: `net.${net}`,
      net,
      points: punti.map((p) => ({ ...p, layer: s.faccia! })),
      width: r4((num(ar.width) ?? 0) * MIL || larghezzaPredefinitaMm),
      // a curve, and it says so: the 0/45/90 rule is about straight traces
      arco: true,
      importato,
    });
    out.archi++;
  }

  for (const v of arr(pcb.vias)) {
    const net = rete(v);
    const x = num(v.x);
    const y = num(v.y);
    if (x === null || y === null) continue;
    if (!net) {
      out.senzaRete++;
      continue;
    }
    const da = strati.get(num(v.layerStartId) ?? -1)?.faccia;
    const a = strati.get(num(v.layerEndId) ?? -1)?.faccia;
    if (!da || !a || da === a) continue;
    const p = t(x, y);
    out.routes.push({
      connection: `net.${net}`,
      net,
      points: [
        { x: r3(p.x), y: r3(p.y), layer: da },
        { x: r3(p.x), y: r3(p.y), layer: a },
      ],
      width: larghezzaPredefinitaMm,
      /*
       * The via's REAL size. Without it every hole would be drawn at whatever
       * the project's minimum happens to be: on this board 0.35mm instead of the
       * 0.5mm the designer chose, and the annular ring on a 0.15mm drill would go
       * from 0.175 to 0.1 — a fab question, decided by a default.
       */
      viaDiameter: r4((num(v.diameter) ?? 0) * MIL) || undefined,
      viaHoleDiameter: r4((num(v.holeDiameter) ?? 0) * MIL) || undefined,
      importato,
    });
    out.via++;
  }

  /*
   * THE FILLED RECTANGLES, which on this board are the net ties.
   *
   * `fills` is a slab of copper with no net written on it, and nobody was
   * reading it. Four of them here, 0.762 x 0.254mm each, one per net tie: the
   * silkscreen beside them says "Net tie 10 mil" and each one sits astride the
   * two pads of an NT, which is how the board shorts two nets that the schematic
   * keeps apart. Without them the imported board is missing the only copper that
   * makes those four pairs one node.
   *
   * The net is taken from the pads the slab lands on, because the fill does not
   * carry one; when it lands on two different nets, that is a bridge and it is
   * reported as such.
   */
  /** the nets of each component's pads: a fill belongs to a component, and so do they */
  const retiDelComponente = new Map<number, string[]>();
  for (const p of arr(pcb.pads)) {
    const i = num(p.componentIndex);
    const n = rete(p);
    if (i === null || !n) continue;
    const lista = retiDelComponente.get(i) ?? [];
    if (!lista.includes(n)) lista.push(n);
    retiDelComponente.set(i, lista);
  }

  for (const f of arr(pcb.fills)) {
    const s = strati.get(num(f.layerId) ?? -1);
    if (s?.genere !== "rame" || !s.faccia) continue;
    const x1 = num(f.x1);
    const y1 = num(f.y1);
    const x2 = num(f.x2);
    const y2 = num(f.y2);
    if (x1 === null || y1 === null || x2 === null || y2 === null) continue;
    const larghezza = Math.abs(x2 - x1);
    const altezza = Math.abs(y2 - y1);
    if (larghezza === 0 || altezza === 0) continue;

    /*
     * The slab drawn as a run of copper: along its long side, as wide as its
     * short one. That is the same piece of copper, said the way the rest of the
     * board is said.
     */
    const orizzontale = larghezza >= altezza;
    const spessore = Math.min(larghezza, altezza) * MIL;
    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2;
    const capoA = orizzontale
      ? t(Math.min(x1, x2) + Math.min(larghezza, altezza) / 2, cy)
      : t(cx, Math.min(y1, y2) + Math.min(larghezza, altezza) / 2);
    const capoB = orizzontale
      ? t(Math.max(x1, x2) - Math.min(larghezza, altezza) / 2, cy)
      : t(cx, Math.max(y1, y2) - Math.min(larghezza, altezza) / 2);

    /*
     * The nets it joins: the ones of the pads of the component the fill belongs
     * to. One net and the slab is just copper; two and it is a bridge, which is
     * what a net tie is.
     */
    const reti = retiDelComponente.get(num(f.componentIndex) ?? -1) ?? [];
    const net = rete(f) ?? reti[0] ?? null;
    if (!net) {
      out.senzaRete++;
      continue;
    }
    if (reti.length > 1) out.ponti.push({ da: reti[0], a: reti[1] });
    out.routes.push({
      connection: `net.${net}`,
      net,
      points: [
        { x: r3(capoA.x), y: r3(capoA.y), layer: s.faccia },
        { x: r3(capoB.x), y: r3(capoB.y), layer: s.faccia },
      ],
      width: r4(spessore),
      importato,
    });
    out.riempimenti++;
  }

  return out;
}

export interface SilkEl {
  type: "pcb_silkscreen_path" | "pcb_silkscreen_text";
  layer: "top" | "bottom";
  /** the component this belongs to, by designator: it goes in its footprint */
  designator?: string;
  route?: Array<{ x: number; y: number }>;
  stroke_width?: number;
  text?: string;
  x?: number;
  y?: number;
  font_size?: number;
  ccw_rotation?: number;
}

/**
 * Silkscreen strings, cleaned of the mangling they arrive with.
 *
 * Altium writes its strings in a Windows codepage and what reaches here is
 * already broken: `0.1 µF` arrives as `0.1 <?>F`. Dropping the bad character
 * would print `0.1 F` on the board, which is not a missing value but a wrong one
 * — a hundred thousand times the capacitance. Before a unit letter that
 * character is micro, and everywhere else it is noise and goes.
 */
function testoPulito(raw: string): string {
  return raw
    .replace(/[�µμ](?=\s*[FHAVSs]\b)/g, "u")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The silkscreen: the white on the board that says which part is which.
 *
 * It comes back attached to its component (every one of the 609 lines on this
 * board belongs to one), so it ends up inside the footprint and travels with the
 * part when it is moved: that is what a footprint outline is for.
 *
 * `.Designator` and `.Comment` are not text, they are placeholders that Altium
 * renders as the reference and the value. Imported literally they would print
 * ".Designator" on seven parts.
 */
export function serigrafiaNativa(
  pcb: Record<string, unknown>,
  strati: Map<number, Strato>,
  t: Trasforma,
  designatorDi: (indice: number) => string | undefined,
  valoreDi: (designator: string) => string | undefined,
): SilkEl[] {
  const out: SilkEl[] = [];
  const proprietario = (el: Record<string, unknown>): string | undefined => {
    const i = num(el.componentIndex) ?? num(el.ownerIndex);
    return i === null ? undefined : designatorDi(i);
  };

  for (const tr of arr(pcb.tracks)) {
    const s = strati.get(num(tr.layerId) ?? -1);
    if (s?.genere !== "serigrafia") continue;
    const x1 = num(tr.x1);
    const y1 = num(tr.y1);
    const x2 = num(tr.x2);
    const y2 = num(tr.y2);
    if (x1 === null || y1 === null || x2 === null || y2 === null) continue;
    const a = t(x1, y1);
    const b = t(x2, y2);
    out.push({
      type: "pcb_silkscreen_path",
      layer: s.lato,
      designator: proprietario(tr),
      route: [
        { x: r3(a.x), y: r3(a.y) },
        { x: r3(b.x), y: r3(b.y) },
      ],
      stroke_width: r3(Math.max(0.05, (num(tr.width) ?? 4) * MIL)),
    });
  }

  for (const ar of arr(pcb.arcs)) {
    const s = strati.get(num(ar.layerId) ?? -1);
    if (s?.genere !== "serigrafia") continue;
    const punti = arcoInPunti(ar, t);
    if (punti.length < 2) continue;
    out.push({
      type: "pcb_silkscreen_path",
      layer: s.lato,
      designator: proprietario(ar),
      route: punti,
      stroke_width: r3(Math.max(0.05, (num(ar.width) ?? 4) * MIL)),
    });
  }

  for (const te of arr(pcb.texts)) {
    const s = strati.get(num(te.layerId) ?? -1);
    if (s?.genere !== "serigrafia") continue;
    const x = num(te.x);
    const y = num(te.y);
    if (x === null || y === null) continue;
    const designator = proprietario(te);
    const grezzo = String(te.text ?? "");
    const testo = /^\.designator$/i.test(grezzo.trim())
      ? (designator ?? "")
      : /^\.comment$/i.test(grezzo.trim())
        ? (designator ? (valoreDi(designator) ?? "") : "")
        : testoPulito(grezzo);
    if (!testo) continue;
    const p = t(x, y);
    out.push({
      type: "pcb_silkscreen_text",
      layer: s.lato,
      designator,
      text: testo.slice(0, 60),
      x: r3(p.x),
      y: r3(p.y),
      font_size: r3(Math.max(0.3, (num(te.height) ?? 40) * MIL)),
      ccw_rotation: num(te.rotation) ?? 0,
    });
  }

  /*
   * THE FILLED SHAPES: the logo, and the little marks.
   *
   * Silkscreen is not only lines and letters. Fifty-one shapes of this board are
   * `regions` — filled polygons — and reading only tracks, arcs and texts left
   * them out without a word: the customer's logo (a 2161 vertex outline of
   * "XNATURA - Environmental Technologies" plus a leaf, 100mm2, 2.8% of the
   * board), the pin one triangle of J2 and six marks on the microcontroller.
   * A board that comes back without its own name printed on it is not the same
   * board.
   *
   * They are drawn as a CLOSED PATH and not as a filled shape, because that is
   * what the format has: the outline of a logo reads as the logo, and it is the
   * same thing a stencil of it would say.
   */
  for (const re of arr(pcb.regions)) {
    const s = strati.get(num(re.layerId) ?? -1);
    if (s?.genere !== "serigrafia") continue;
    const punti = arr(re.points)
      .map((p) => ({ x: num(p.x), y: num(p.y) }))
      .filter((p): p is { x: number; y: number } => p.x !== null && p.y !== null)
      .map((p) => {
        const q = t(p.x, p.y);
        return { x: r3(q.x), y: r3(q.y) };
      });
    if (punti.length < 3) continue;
    /*
     * Simplified before writing: these outlines come out of a vector drawing and
     * carry a vertex every few microns — seven thousand of them, a hundred and
     * thirty kilobytes of coordinates on top of a project that is one hundred
     * and eighty. A twentieth of a millimetre is half the width of the thinnest
     * silkscreen line a fab will print, so nothing that can be seen is lost.
     */
    const ridotti = semplifica(punti, 0.015);
    const chiuso =
      ridotti[0].x === ridotti[ridotti.length - 1].x &&
      ridotti[0].y === ridotti[ridotti.length - 1].y
        ? ridotti
        : [...ridotti, ridotti[0]];
    out.push({
      type: "pcb_silkscreen_path",
      layer: s.lato,
      designator: proprietario(re),
      route: chiuso,
      stroke_width: 0.1,
    });
  }
  return out;
}

/**
 * Douglas-Peucker: drops the vertices that sit on the line between their
 * neighbours, within a tolerance. Written here because it is needed here and
 * nowhere else, and because the alternative — a dependency for forty lines — is
 * not one.
 */
function semplifica(
  punti: Array<{ x: number; y: number }>,
  tolleranza: number,
): Array<{ x: number; y: number }> {
  if (punti.length <= 2) return punti;
  const a = punti[0];
  const b = punti[punti.length - 1];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lung = Math.hypot(dx, dy);
  let peggiore = 0;
  let indice = 0;
  for (let i = 1; i < punti.length - 1; i++) {
    const p = punti[i];
    // distance from the segment, or from the point when the segment is a point
    const d =
      lung < 1e-9
        ? Math.hypot(p.x - a.x, p.y - a.y)
        : Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / lung;
    if (d > peggiore) {
      peggiore = d;
      indice = i;
    }
  }
  if (peggiore <= tolleranza) return [a, b];
  return [
    ...semplifica(punti.slice(0, indice + 1), tolleranza).slice(0, -1),
    ...semplifica(punti.slice(indice), tolleranza),
  ];
}

const dentroPoligono = (
  px: number,
  py: number,
  poly: Array<{ x: number; y: number }>,
): boolean => {
  let dentro = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > py !== b.y > py && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x) {
      dentro = !dentro;
    }
  }
  return dentro;
};

/**
 * A piece of copper that sits inside an opening of another net's pour.
 *
 * It cannot be a pour of its own: the plane around it is written as a single
 * ring, it does not know the island is there, and it would close over it — in
 * the gerbers, a short. Cutting a channel out to the boundary keeps them apart
 * and costs a slit through the plane: on this board up to twenty millimetres of
 * it, for an island of three square millimetres. A ground plane with a twenty
 * millimetre cut across it is a worse board than one with a small piece of
 * copper drawn as a track.
 *
 * So the island comes in as COPPER BETWEEN ITS PADS, which is what it is there
 * to do, and the pour solver carves its own clearance around it — that it does
 * know how to do. The plane stays whole.
 */
export interface Isoletta {
  faccia: Layer;
  net: string;
  /** the pads it holds together, in board millimetres */
  pad: Array<{ x: number; y: number }>;
  /** how wide to draw it: the island's own thickness, within reason */
  larghezzaMm: number;
  areaMm2: number;
}

export interface PianoImportato {
  faccia: Layer;
  net: string;
  /** fraction of the board the pour covers, to say why it was taken */
  copertura: number;
  /**
   * The outline the file drew, in board millimetres, when the pour is NOT a
   * flood over the whole face. A split power plane is exactly this: four pieces
   * on one layer, one per rail, each with its own shape.
   */
  contorno?: Array<{ x: number; y: number }>;
}

/** area of a closed polygon, by the shoelace formula */
function areaPoligono(punti: Array<{ x: number; y: number }>): number {
  let somma = 0;
  for (let i = 0; i < punti.length; i++) {
    const a = punti[i];
    const b = punti[(i + 1) % punti.length];
    somma += a.x * b.y - b.x * a.y;
  }
  return Math.abs(somma / 2);
}

/**
 * The PLANES: the poured copper that carries the returns and the rails.
 *
 * Altium keeps a pour as a heap of filled regions with no net written on them,
 * so the net is read the way the board reads it: from what falls inside — the
 * vias AND the pads. Vias alone were not enough. Thirty-two of this board's
 * fifty-five copper regions have fewer than five vias in them (they are the
 * islands that hold a couple of pads up) and were dropped without a word, two
 * hundred square millimetres of copper.
 *
 * WHAT BECOMES A POUR. Whatever the file drew, with its own outline: a
 * `<copperpour>` takes one, and the belief written here before — that a split
 * plane could not be represented — was wrong, and it cost this board its entire
 * PWR layer (563mm2 over four rails: VBAT, 3V3_MCU, 3V3_MIC and one more).
 * Verified on @tscircuit/core: two pours on the same layer, different nets and
 * different outlines, compile and come back as two breps with the right nets.
 *
 * The one thing that is NOT taken is a region on a face where another net is
 * already poured as a FLOOD. The flood fills everything it is not told about —
 * it carves its clearances around pads and traces, never around another pour —
 * so an island grafted under it would be a short. Those are counted and named,
 * not silently dropped.
 */
export function pianiNativi(
  pcb: Record<string, unknown>,
  strati: Map<number, Strato>,
  t: Trasforma,
  areaBoardMm2: number,
  /** the board's minimum clearance: how wide the channels into the holes are cut */
  larghezzaCanaleMm = 0.1524,
): {
  piani: PianoImportato[];
  /** the pieces that come in as copper instead of as pours: see Isoletta */
  isolette: Isoletta[];
  parziali: Array<{
    strato: string;
    net: string;
    copertura: number;
    motivo: string;
    /** pads of that net sitting on this copper: what stays electrically loose */
    pad: number;
  }>;
} {
  const nomi = nomiDelleReti(pcb);
  const piani: PianoImportato[] = [];
  const isolette: Isoletta[] = [];
  const parziali: Array<{
    strato: string;
    net: string;
    copertura: number;
    motivo: string;
    pad: number;
  }> = [];

  interface Candidata {
    strato: Strato;
    net: string;
    copertura: number;
    punti: Array<{ x: number; y: number }>;
    /** the openings the file drew in it, in native units */
    buchi: Array<Array<{ x: number; y: number }>>;
    /** its place in `regioni`, to tell its own copper from everybody else's */
    indice: number;
  }
  const candidate: Candidata[] = [];

  /*
   * A POUR IS A POLYGON, AND A POLYGON IS MANY REGIONS.
   *
   * Altium splits one poured polygon into as many filled regions as it takes to
   * go around the obstacles: the ground of one face here is thirteen pieces of
   * the same object, and `polygonIndex` says so. Reading them one by one asks
   * each piece to prove its own net, and a piece holding two pads cannot — nine
   * of those thirteen have fewer than five vias in them. So the votes are pooled
   * BY POLYGON: the pieces of one pour decide together which net they carry,
   * which is the truth of the thing.
   */
  interface Voti {
    conta: Map<string, number>;
    /** votes from pads, which sit on the face and are the strongest evidence */
    daPad: Map<string, number>;
  }
  const perPoligono = new Map<string, Voti>();
  const regioni: Array<{
    strato: Strato;
    punti: Array<{ x: number; y: number }>;
    buchi: Array<Array<{ x: number; y: number }>>;
    copertura: number;
    chiave: string;
  }> = [];

  for (const r of arr(pcb.regions)) {
    const s = strati.get(num(r.layerId) ?? -1);
    if (s?.genere !== "rame" || !s.faccia) continue;
    const punti = arr(r.points ?? r.vertices ?? r.outline)
      .map((p) => ({ x: num(p.x), y: num(p.y) }))
      .filter((p): p is { x: number; y: number } => p.x !== null && p.y !== null);
    if (punti.length < 3) continue;

    /*
     * How much of the board it covers, by AREA and not by bounding box. The box
     * of a plane that hugs the outline of an L shaped board says 46% where the
     * copper is 6%, and that number both decided what came in and was printed
     * for whoever was reading.
     */
    const copertura =
      areaBoardMm2 > 0 ? (areaPoligono(punti) * MIL * MIL) / areaBoardMm2 : 0;

    /*
     * The holes: a pour is drawn with the openings for everything that must not
     * touch it, and the vias of the OTHER nets pass through them.
     */
    const buchi = arr(r.holes)
      .map((h) =>
        arr(Array.isArray(h) ? h : (h.points ?? h.vertices))
          .map((p) => ({ x: num(p.x), y: num(p.y) }))
          .filter((p): p is { x: number; y: number } => p.x !== null && p.y !== null),
      )
      .filter((h) => h.length >= 3);

    const idPoligono = num(r.polygonIndex);
    const chiave = `${s.faccia}|${idPoligono ?? `r${regioni.length}`}`;
    const voti = perPoligono.get(chiave) ?? { conta: new Map(), daPad: new Map() };
    const vota = (x: number | null, y: number | null, i: number | null, pad: boolean) => {
      if (x === null || y === null || i === null) return;
      if (!dentroPoligono(x, y, punti)) return;
      if (buchi.some((h) => dentroPoligono(x, y, h))) return;
      const nome = nomi.get(i);
      if (!nome) return;
      voti.conta.set(nome, (voti.conta.get(nome) ?? 0) + 1);
      if (pad) voti.daPad.set(nome, (voti.daPad.get(nome) ?? 0) + 1);
    };
    for (const v of arr(pcb.vias)) vota(num(v.x), num(v.y), num(v.netIndex), false);
    for (const p of arr(pcb.pads)) vota(num(p.x), num(p.y), num(p.netIndex), true);
    perPoligono.set(chiave, voti);
    regioni.push({ strato: s, punti, buchi, copertura, chiave });
  }

  for (const reg of regioni) {
    const voti = perPoligono.get(reg.chiave)!;
    /*
     * The winner has to beat the runner-up by a factor of two, and to have
     * something solid behind it: a plane is crossed by the vias and the pads of
     * everything else, each isolated by its own clearance, and that noise is
     * spread over many nets. This board's largest power region holds 34 votes
     * for 3V3_MCU and 9 for ground, the rest ones and twos.
     *
     * The floor keeps a single passing via from claiming a piece of copper: one
     * vote is enough only when it comes from a PAD, which sits on the face and
     * is soldered to it.
     */
    const classifica = [...voti.conta].sort((a, b) => b[1] - a[1]);
    const [vincitore, quante] = classifica[0] ?? [null, 0];
    const secondo = classifica[1]?.[1] ?? 0;
    const solido = quante >= 3 || (vincitore !== null && (voti.daPad.get(vincitore) ?? 0) >= 1);
    if (!vincitore || !solido || quante < 2 * secondo) {
      if (reg.copertura > 0.001) {
        parziali.push({
          strato: reg.strato.nome,
          net: vincitore ?? "(sconosciuta)",
          copertura: r3(reg.copertura),
          motivo: "non si capisce a quale rete appartiene",
          pad: voti.daPad.get(vincitore ?? "") ?? 0,
        });
      }
      continue;
    }
    candidate.push({
      strato: reg.strato,
      net: vincitore,
      copertura: reg.copertura,
      punti: reg.punti,
      buchi: reg.buchi,
      indice: regioni.indexOf(reg),
    });
  }

  /*
   * EVERY REGION KEEPS ITS OWN SHAPE, AND ITS HOLES STAY UNWRITTEN.
   *
   * A flood — a pour with no outline — fills the whole face, and that is how the
   * ground of this board used to arrive: a rectangle as big as the board
   * claiming to be ground. It is wrong twice. It says there is copper where the
   * file draws none (the top ground is 2681mm2 of the 3551 the flood claimed),
   * and it closes over the islands of the other nets, which in the gerbers we
   * export is a short that reaches the fab.
   *
   * So each region is written with the outline the file drew. Its OPENINGS are
   * not written, because a `<copperpour>` takes one ring and has nowhere to put
   * a second one — and the way round that, cutting a channel from the opening
   * out to the boundary, means slitting the plane from the middle of the board
   * to its edge: measured here, nineteen cuts, the longest twenty millimetres,
   * to keep out islands of three square millimetres. A ground plane with a
   * twenty millimetre cut in it is a worse board than one missing a scrap of
   * copper.
   *
   * What lives in those openings comes in as COPPER instead (see Isoletta): a
   * track between the pads the island held together, which the solver then
   * carves its own clearance around — that it does know how to do.
   */
  /**
   * What a piece of copper holds together: the pads AND the vias of its own net
   * that sit on it. The vias count, and it is not a detail — seventeen of this
   * board's regions have no pad on them and a via that ties them to their net
   * through another layer. Reading only the pads calls them dead copper, drops
   * them, and lets the plane around them close over live copper of another net.
   */
  const agganciDentro = (poligono: Array<{ x: number; y: number }>, net: string): number => {
    let n = 0;
    const conta = (x: number | null, y: number | null, i: number | null) => {
      if (x === null || y === null || i === null || nomi.get(i) !== net) return;
      if (dentroPoligono(x, y, poligono)) n++;
    };
    for (const p of arr(pcb.pads)) conta(num(p.x), num(p.y), num(p.netIndex));
    for (const v of arr(pcb.vias)) conta(num(v.x), num(v.y), num(v.netIndex));
    return n;
  };

  const scarti = new Set<number>();
  for (const c of candidate) {
    if (agganciDentro(c.punti, c.net) > 0) continue;
    const dentroUnAltra = candidate.some(
      (altra) =>
        altra.indice !== c.indice &&
        altra.strato.faccia === c.strato.faccia &&
        altra.net !== c.net &&
        altra.buchi.some((b) => c.punti.some((p) => dentroPoligono(p.x, p.y, b))),
    );
    if (dentroUnAltra) {
      scarti.add(c.indice);
      parziali.push({
        strato: c.strato.nome,
        net: c.net,
        copertura: r3(c.copertura),
        motivo:
          "e' dentro un'apertura del piano e non ha ne' un pad ne' una via della sua rete: e' rame morto",
        pad: 0,
      });
    }
  }

  for (const c of candidate) {
    if (scarti.has(c.indice)) continue;
    const faccia = c.strato.faccia!;

    /*
     * Inside somebody else's opening: it goes in as copper, not as a pour. See
     * Isoletta for why — the alternative is a slit through the plane that is
     * longer than the island is wide.
     */
    const dentroAltrui = candidate.some(
      (altra) =>
        altra.indice !== c.indice &&
        altra.strato.faccia === faccia &&
        altra.net !== c.net &&
        altra.buchi.some((b) => c.punti.some((p) => dentroPoligono(p.x, p.y, b))),
    );
    if (dentroAltrui) {
      /*
       * What the island holds together: its pads AND its vias. The vias count —
       * an island with one pad and a via is a pad brought down to another layer,
       * and reading only the pads leaves that pad connected to nothing.
       */
      const pad: Array<{ x: number; y: number }> = [];
      for (const p of [...arr(pcb.pads), ...arr(pcb.vias)]) {
        const x = num(p.x);
        const y = num(p.y);
        const i = num(p.netIndex);
        if (x === null || y === null || i === null || nomi.get(i) !== c.net) continue;
        if (!dentroPoligono(x, y, c.punti)) continue;
        const q = t(x, y);
        pad.push({ x: r3(q.x), y: r3(q.y) });
      }
      const areaMm2 = areaPoligono(c.punti) * MIL * MIL;
      let perimetro = 0;
      for (let i = 0; i < c.punti.length; i++) {
        const a = c.punti[i];
        const b = c.punti[(i + 1) % c.punti.length];
        perimetro += Math.hypot(a.x - b.x, a.y - b.y) * MIL;
      }
      // twice the area over the perimeter is the width of a strip of that shape
      const larghezza = perimetro > 0 ? Math.min(2, Math.max(0.2, (2 * areaMm2) / perimetro)) : 0.4;
      if (pad.length >= 2) {
        isolette.push({ faccia, net: c.net, pad, larghezzaMm: r3(larghezza), areaMm2: r3(areaMm2) });
        continue;
      }
      /*
       * One pad and nothing to join it to: as a track it would be a stub that
       * connects nothing. It stays out and it is counted.
       */
      parziali.push({
        strato: c.strato.nome,
        net: c.net,
        copertura: r3(c.copertura),
        motivo: "isoletta dentro il piano con un solo aggancio: non c'e' niente da collegare",
        pad: pad.length,
      });
      continue;
    }
    piani.push({
      faccia,
      net: c.net,
      copertura: r3(c.copertura),
      /*
       * The outline the file drew, simplified to a hundredth of a millimetre —
       * under what a fab can hold. The openings are NOT written: a pour takes one
       * ring and has nowhere to put an inner one, and whatever lives in those
       * openings comes in as copper of its own (see Isoletta), which the solver
       * then carves its own clearance around.
       */
      contorno: semplifica(
        c.punti.map((p) => t(p.x, p.y)),
        0.01,
      ).map((p) => ({ x: r3(p.x), y: r3(p.y) })),
    });
  }

  return { piani, isolette, parziali };
}

export function stratiPredefiniti(): Map<number, Strato> {
  const out = new Map<number, Strato>();
  out.set(1, { genere: "rame", faccia: "top", lato: "top", nome: "TOP" });
  out.set(32, { genere: "rame", faccia: "bottom", lato: "bottom", nome: "BOTTOM" });
  for (let i = 2; i <= 31; i++) {
    out.set(i, {
      genere: "rame",
      faccia: i === 2 ? "inner1" : "inner2",
      lato: "top",
      nome: `Mid-Layer ${i - 1}`,
    });
  }
  out.set(33, { genere: "serigrafia", lato: "top", nome: "Top Overlay" });
  out.set(34, { genere: "serigrafia", lato: "bottom", nome: "Bottom Overlay" });
  out.set(35, { genere: "pasta", lato: "top", nome: "Top Paste" });
  out.set(36, { genere: "pasta", lato: "bottom", nome: "Bottom Paste" });
  out.set(37, { genere: "maschera", lato: "top", nome: "Top Solder" });
  out.set(38, { genere: "maschera", lato: "bottom", nome: "Bottom Solder" });
  out.set(74, { genere: "meccanico", lato: "top", nome: "Multi-Layer" });
  return out;
}

export interface PrimitivaFootprint {
  type: string;
  [key: string]: unknown;
}

/**
 * A footprint from a .PcbLib, turned into the pcb elements the serializer draws.
 *
 * The canonical model of a library file carries only the NAMES: one
 * source_component per footprint and not one pad — the geometry is in the native
 * tree and nowhere else, which is why importing three .PcbLib files produced
 * three components with nothing in them. Here the primitives are read where they
 * live.
 *
 * The pads have no number in the file: Altium keeps the order and not the name.
 * They are numbered in that order, which is the only thing the file says, and the
 * generated code says so — a pinout invented in silence would be worse than no
 * footprint at all.
 */
export function footprintDaNativo(
  fp: Record<string, unknown>,
  strati: Map<number, Strato>,
): PrimitivaFootprint[] {
  const out: PrimitivaFootprint[] = [];
  let n = 0;

  for (const [i, p] of arr(fp.pads).entries()) {
    const x = num(p.x);
    const y = num(p.y);
    if (x === null || y === null) continue;
    const w = (num(p.sizeTopX) ?? 0) * MIL;
    const h = (num(p.sizeTopY) ?? 0) * MIL;
    const foro = (num(p.holeDiameter) ?? 0) * MIL;
    const hints = [String(i + 1)];
    if (foro > 0) {
      out.push({
        type: "pcb_plated_hole",
        pcb_plated_hole_id: `lib_ph_${n++}`,
        x: r3(x * MIL),
        y: r3(y * MIL),
        hole_diameter: r3(foro),
        outer_diameter: r3(Math.max(w, h) || foro * 2),
        port_hints: hints,
      });
      continue;
    }
    if (w <= 0 || h <= 0) continue;
    const s = strati.get(num(p.layerId) ?? -1);
    const tondo = String(p.shapeTopName ?? "").startsWith("round") && Math.abs(w - h) < 1e-6;
    out.push({
      type: "pcb_smtpad",
      pcb_smtpad_id: `lib_pad_${n++}`,
      x: r3(x * MIL),
      y: r3(y * MIL),
      layer: s?.faccia ?? "top",
      port_hints: hints,
      ...(tondo
        ? { shape: "circle", radius: r3(w / 2) }
        : { shape: "rect", width: r3(w), height: r3(h) }),
      ...(num(p.rotation) ? { ccw_rotation: num(p.rotation) } : {}),
    });
  }

  const t: Trasforma = (x, y) => ({ x: x * MIL, y: y * MIL });
  for (const tr of arr(fp.tracks)) {
    const s = strati.get(num(tr.layerId) ?? -1);
    if (s?.genere !== "serigrafia") continue;
    const x1 = num(tr.x1);
    const y1 = num(tr.y1);
    const x2 = num(tr.x2);
    const y2 = num(tr.y2);
    if (x1 === null || y1 === null || x2 === null || y2 === null) continue;
    out.push({
      type: "pcb_silkscreen_path",
      pcb_silkscreen_path_id: `lib_silk_${n++}`,
      layer: s.lato,
      route: [t(x1, y1), t(x2, y2)].map((p) => ({ x: r3(p.x), y: r3(p.y) })),
      stroke_width: r3(Math.max(0.05, (num(tr.width) ?? 4) * MIL)),
    });
  }
  for (const ar of arr(fp.arcs)) {
    const s = strati.get(num(ar.layerId) ?? -1);
    if (s?.genere !== "serigrafia") continue;
    const punti = arcoInPunti(ar, t);
    if (punti.length < 2) continue;
    out.push({
      type: "pcb_silkscreen_path",
      pcb_silkscreen_path_id: `lib_silk_${n++}`,
      layer: s.lato,
      route: punti,
      stroke_width: r3(Math.max(0.05, (num(ar.width) ?? 4) * MIL)),
    });
  }
  return out;
}

/**
 * THE FABRICATION RULES THE BOARD WAS DESIGNED TO.
 *
 * A .PcbDoc carries them — this one has fifty-six — and until now the imported
 * board was checked against pcb-studio's default preset instead: a board drawn
 * to six mil measured against five, or the other way round. The file states its
 * own limits, so they come in with it.
 *
 * Only the rules that apply to EVERYTHING are taken (`All` on both sides): the
 * narrow ones ("vias against pads that are not test points") are exceptions, and
 * a project-wide minimum taken from an exception would be a lie in the strict
 * direction.
 */
export function regoleNative(pcb: Record<string, unknown>): {
  minTraceWidthMm?: number;
  minClearanceMm?: number;
  minViaHoleMm?: number;
  minViaDiameterMm?: number;
  targetTraceWidthMm?: number;
  /** the narrow-scope clearance rules, which one global minimum cannot express */
  ristrette?: Array<{ nome: string; gapMm: number; ambito: string }>;
} {
  const generali = arr(pcb.rules).filter((r) => {
    const s1 = (r.scope1 ?? {}) as Record<string, unknown>;
    const s2 = (r.scope2 ?? {}) as Record<string, unknown>;
    return r.enabled !== false && s1.isAll === true && s2.isAll === true;
  });
  /** the value in millimetres of one constraint of the rule of a given kind */
  const valore = (kind: string, chiave: string): number | undefined => {
    const candidati = generali
      .filter((r) => String(r.ruleKind ?? "") === kind)
      // in Altium the smaller number is the stronger rule
      .sort((a, b) => (num(a.priority) ?? 99) - (num(b.priority) ?? 99));
    for (const r of candidati) {
      const valori = (r.constraintValues ?? {}) as Record<string, { valueMm?: unknown }>;
      const v = num(valori[chiave]?.valueMm);
      if (v !== null && v > 0) return v;
    }
    return undefined;
  };
  const fuori = (v: number | undefined, min: number, max: number) =>
    v !== undefined && v >= min && v <= max ? v : undefined;

  /*
   * The clearance rules with a NARROW scope. This board has one for vias against
   * pads that lets them come within 1 mil, where the general rule asks for 6, and
   * it is why 22 vias look too close to a pad they are perfectly legal next to.
   * pcb-studio has one minimum for everything, so the rule cannot be applied:
   * it is reported, and whoever imports knows why the check complains.
   */
  const ristrette: Array<{ nome: string; gapMm: number; ambito: string }> = [];
  for (const r of arr(pcb.rules)) {
    if (String(r.ruleKind ?? "") !== "Clearance" || r.enabled === false) continue;
    const s1 = (r.scope1 ?? {}) as Record<string, unknown>;
    const s2 = (r.scope2 ?? {}) as Record<string, unknown>;
    if (s1.isAll === true && s2.isAll === true) continue;
    const valori = (r.constraintValues ?? {}) as Record<string, { valueMm?: unknown }>;
    const gap = num(valori.GAP?.valueMm);
    if (gap === null) continue;
    ristrette.push({
      nome: String(r.name ?? "senza nome"),
      gapMm: gap,
      ambito: `${String(s1.predicate ?? "?")} / ${String(s2.predicate ?? "?")}`,
    });
  }

  return {
    ...(ristrette.length ? { ristrette } : {}),
    // the bounds keep a mangled file from turning into an unusable project
    minClearanceMm: fuori(valore("Clearance", "GAP"), 0.02, 2),
    minTraceWidthMm: fuori(valore("Width", "MINLIMIT"), 0.02, 2),
    targetTraceWidthMm: fuori(valore("Width", "PREFEREDWIDTH"), 0.05, 5),
    minViaDiameterMm: fuori(valore("RoutingVias", "MINWIDTH"), 0.1, 5),
    minViaHoleMm: fuori(valore("RoutingVias", "MINHOLEWIDTH"), 0.05, 5),
  };
}

/** the board outline as the file draws it, in millimetres from the centre */
export function contornoNativo(
  pcb: Record<string, unknown>,
  t: Trasforma,
): Array<{ x: number; y: number }> {
  const outline = (pcb.boardOutline ?? {}) as Record<string, unknown>;
  const punti: Array<{ x: number; y: number }> = [];
  for (const s of arr(outline.segments)) {
    const x = num(s.x1);
    const y = num(s.y1);
    if (x === null || y === null) continue;
    const p = t(x, y);
    punti.push({ x: r3(p.x), y: r3(p.y) });
  }
  return punti;
}
