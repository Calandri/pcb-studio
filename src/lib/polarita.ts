/**
 * PARTS THAT HAVE A WAY ROUND: THE OBLIGATIONS, CHECKED ON EVERY BOARD.
 *
 * On the first board of the sonda del suolo PCB Basic mounted a LED the wrong
 * way round (Niccolo', 2026-11-20: "quando un componente ha la polarita' va
 * controllato anche in fase di design! e ci devono essere obblighi"). The
 * causes, from the audit of that day: tscircuit draws the silkscreen of a
 * <led> and of a <diode> as a U closed on the ANODE (its pin 1), which a fab
 * reads as the cathode (tscircuit/core issue 5565); whole boards with no pin 1
 * or polarity mark at all; generic <chip>s used as diodes with pins called
 * only 1 and 2. The written rule is docs/pcb-revisione-circuitale.md, section 0.
 *
 * WHAT HAS A WAY ROUND: a LED, a diode, a polarized capacitor
 * (`polarized`, which tscircuit writes as are_pins_interchangeable: false), a
 * battery, and every chip, transistor or connector with a pin 1 (three pins or
 * more, or two for a connector). A two-pin <chip> named as a diode (D, LED) or
 * a battery (BT) has a way round too, and so has one named as a capacitor
 * whose part says it is a tantalum, electrolytic or polymer one. Parts not
 * mounted (doNotPlace) are left out.
 *
 * WHAT EACH ONE MUST HAVE:
 *  a. its roles declared by name: anode and cathode, + and -, or a pin 1. A
 *     two-pin <chip> used as a diode or a polarized capacitor with pins called
 *     only 1 and 2 is an error ("ruoli");
 *  b. a mark in the silkscreen of its face that a person reads right with the
 *     part mounted: a bar on the cathode or a "+" on the anode of a diode, a
 *     "+" on the + of a polarized capacitor or a battery (a stripe marks the +
 *     of a tantalum and the - of an electrolytic: it is not a sure mark), a dot
 *     at pin 1. On its side, outside the body (the box of its pads) and off the
 *     pads (the mask opens there and the ink is cut away): "segno". For a
 *     two-terminal part a mark on the ANODE side that is not a "+" reads as the
 *     cathode, the error of the sonda: "segno_al_contrario".
 *
 * How a mark is told from the rest of the ink: each silkscreen element of the
 * face that belongs to the part or to no part is read as it prints (its
 * strokes, see disegnoStampato), what falls under the body or on a pad is left
 * out, and what is left must stand to one side: the middle of it toward the
 * mark's pad and away from the rest. An outline drawn all round the part is
 * not a mark; the reference text of a part is not one either.
 *
 * The compile writes these as electrical checks ("polarita", in red: the board
 * still compiles), and the export refuses to certify a board that has any
 * (see nonCertificata in engine-version.ts): a board without these marks does
 * not go to the factory.
 */
import { propDaiSorgenti } from "./bom";
import { corpoDelPezzo, padBounds, type Bounds, type Corpo } from "./footprint-bounds";
import { padGeometry, type PadGeometry } from "./pcb-route-model";
import { nomiNonMontati } from "./non-montati";
import { disegnoStampato } from "./silkscreen-clearance";

type El = Record<string, unknown> & { type: string };
type Punto = { x: number; y: number };

export type TipoConVerso = "led" | "diodo" | "condensatore" | "batteria" | "integrato";
/** what the mark must point at */
export type Riferimento = "catodo" | "piu" | "pin1";

export interface PiazzolaDelPezzo {
  bounds: Bounds;
  centro: Punto;
  numero: number | null;
  nomi: string[];
}

export interface PezzoConVerso {
  id: string;
  nome: string;
  tipo: TipoConVerso;
  faccia: "top" | "bottom";
  piazzole: PiazzolaDelPezzo[];
  /** what covers the board once the part is mounted: its pads and the body of its 3D model (see corpiDeiPezzi) */
  corpo: Bounds;
  /** the body of its 3D model as it lies, turned with the part (a QFP at 45 degrees): what hides a mark; null without a model */
  scocca: Corpo | null;
  /** the pad the mark points at: pin 1, the cathode, the + */
  chiave: PiazzolaDelPezzo | null;
  /** for a two-terminal part, the other one (the anode, the -) */
  altra: PiazzolaDelPezzo | null;
  riferimento: Riferimento;
  /** whether its roles are declared by name */
  ruoliDichiarati: boolean;
  /** what the part is, said in the message ("un <chip> usato come diodo") */
  comeSiChiama: string;
}

export type MotivoDiPolarita = "ruoli" | "segno" | "segno_al_contrario" | "segno_conteso";

export interface ProblemaDiPolarita {
  nome: string;
  motivo: MotivoDiPolarita;
  messaggio: string;
  x: number;
  y: number;
  faccia: "top" | "bottom";
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** names that say the anode, the cathode, the + and the - of a two-terminal part */
const ANODO = /^(a|an|anode|anodo|\+|pos|plus|p)$/i;
const CATODO = /^(k|c|cat|cathode|catodo|-|neg|minus|n)$/i;
/**
 * A part with no way round, said by its DESCRIPTION in the sources (never by its
 * name or its code): a bidirectional TVS, description="TVS bidirezionale ..."
 * or "bidirectional". tscircuit does not carry the description into the board,
 * so it is read from the files (propDaiSorgenti).
 */
const BIDIREZIONALE = /bidirection|bi-direction|bidirezional/i;
/** what to write, said in the messages and in the agent's instructions */
export const COME_DIRE_BIDIREZIONALE = `scrivi nella description del pezzo la parola «bidirezionale» (o «bidirectional»), per esempio description="TVS bidirezionale sulla linea USB": allora non ha verso`;
/** what says a capacitor has a + */
const CONDENSATORE_POLARIZZATO = /tantal|electrolyt|elettrolit|polymer|polimer|\bT520|\bTAJ|\bTPS[A-Z]|\bECAP|\bpolarized|polarizzat/i;
/** a reference text: a designator, never a mark */
const DESIGNATORE = /^[A-Z]{1,4}\d+[A-Z]?$/;

/** how far from its pad a mark may stand (mm) */
const PORTATA_MM = 1.6;
/** how far to one side the middle of a mark must be, as a share of the half distance between the two pads */
const DA_UN_LATO = 0.3;
/** ink this near a pad is on its mask opening (mm) */
const APERTURA_MM = 0.05;
/** a step of the strokes when they are read point by point (mm) */
const PASSO_MM = 0.1;

const distanzaDaBox = (p: Punto, b: Bounds) => Math.hypot(Math.max(b.minX - p.x, 0, p.x - b.maxX), Math.max(b.minY - p.y, 0, p.y - b.maxY));
const dentroBox = (p: Punto, b: Bounds, margine = 0) => p.x > b.minX - margine && p.x < b.maxX + margine && p.y > b.minY - margine && p.y < b.maxY + margine;
const unione = (bs: Bounds[]): Bounds | null =>
  bs.length === 0
    ? null
    : bs.reduce((a, b) => ({ minX: Math.min(a.minX, b.minX), maxX: Math.max(a.maxX, b.maxX), minY: Math.min(a.minY, b.minY), maxY: Math.max(a.maxY, b.maxY) }));

/**
 * THE BODY OF EVERY PART, as the person mounting it sees the board: the box of
 * its pads and the body of its 3D model (cad size, or the box of its jscad
 * model: corpoDelPezzo), whichever reaches further. A connector or a module
 * whose body covers its pin 1 has its mark just outside the body, which can be
 * millimetres from the pad.
 */
export function corpiDeiPezzi(els: El[]): Map<string, { faccia: "top" | "bottom"; corpo: Bounds; scocca: Corpo | null }> {
  const facce = new Map<string, "top" | "bottom">();
  for (const e of els) if (e.type === "pcb_component") facce.set(String(e.pcb_component_id), e.layer === "bottom" ? "bottom" : "top");
  const box = new Map<string, Bounds[]>();
  const scocche = new Map<string, Corpo>();
  const metti = (id: string, b: Bounds) => {
    const l = box.get(id) ?? [];
    l.push(b);
    box.set(id, l);
  };
  for (const e of els) {
    if ((e.type !== "pcb_smtpad" && e.type !== "pcb_plated_hole") || typeof e.pcb_component_id !== "string") continue;
    const b = padBounds(e);
    if (b) metti(e.pcb_component_id, b);
  }
  for (const e of els) {
    if (e.type !== "cad_component" || typeof e.pcb_component_id !== "string" || !box.has(e.pcb_component_id)) continue;
    const c = corpoDelPezzo(cuboDelModello(e), { dalModello: true });
    if (!c) continue;
    scocche.set(e.pcb_component_id, c);
    const a = (c.rot * Math.PI) / 180;
    const hw = (Math.abs(Math.cos(a)) * c.w + Math.abs(Math.sin(a)) * c.h) / 2;
    const hh = (Math.abs(Math.sin(a)) * c.w + Math.abs(Math.cos(a)) * c.h) / 2;
    metti(e.pcb_component_id, { minX: c.x - hw, maxX: c.x + hw, minY: c.y - hh, maxY: c.y + hh });
  }
  const out = new Map<string, { faccia: "top" | "bottom"; corpo: Bounds; scocca: Corpo | null }>();
  for (const [id, bs] of box) out.set(id, { faccia: facce.get(id) ?? "top", corpo: unione(bs)!, scocca: scocche.get(id) ?? null });
  return out;
}

/**
 * A jscad model made of several pieces (a body with its balls or its leads,
 * coloured: the PSRAM IC6, the LQFP U1) read as its largest cuboid, the
 * package, so corpoDelPezzo can lay it on the board; the leads lie over the
 * pads, which count by themselves.
 */
function cuboDelModello(cad: El): El {
  const scatole: Array<{ x0: number; x1: number; y0: number; y1: number }> = [];
  const visita = (m: unknown, prof: number) => {
    if (!m || typeof m !== "object" || prof > 6 || scatole.length > 200) return;
    const o = m as { type?: unknown; shape?: unknown; shapes?: unknown; size?: unknown; center?: unknown };
    if (o.type === "colorize") return visita(o.shape, prof + 1);
    if (o.type === "union" && Array.isArray(o.shapes)) return o.shapes.forEach((x) => visita(x, prof + 1));
    if (o.type !== "cuboid" && o.type !== "roundedCuboid") return;
    const sz = Array.isArray(o.size) ? o.size.map(Number) : [];
    const ce = Array.isArray(o.center) ? o.center.map(Number) : [0, 0];
    const [w, h] = sz;
    const [cx, cy] = [ce[0] ?? 0, ce[1] ?? 0];
    if (![w, h, cx, cy].every(Number.isFinite) || w <= 0 || h <= 0) return;
    scatole.push({ x0: cx - w / 2, x1: cx + w / 2, y0: cy - h / 2, y1: cy + h / 2 });
  };
  visita(cad.model_jscad, 0);
  if (scatole.length === 0) return cad;
  const { x0, x1, y0, y1 } = scatole.reduce((a, b) => ((b.x1 - b.x0) * (b.y1 - b.y0) > (a.x1 - a.x0) * (a.y1 - a.y0) ? b : a));
  return { ...cad, model_jscad: { type: "cuboid", size: [x1 - x0, y1 - y0, 1], center: [(x0 + x1) / 2, (y0 + y1) / 2, 0] } };
}

/**
 * THE CORNER A1 OF A BGA THAT HAS NO BALL A1 (the PSRAM IC6 of sbb-dl-principale):
 * one pitch past A2 along row A (A1 = A2 + (A2 - A3)), or past B1 along column
 * 1. The datasheet calls it A1 and the mark goes there; no ball has to be
 * renamed A1 for it. null when the balls are not named by row and column.
 */
function angoloA1(piazzole: PiazzolaDelPezzo[]): PiazzolaDelPezzo | null {
  const con = (n: string) => piazzole.find((q) => q.nomi.some((x) => x.toUpperCase() === n)) ?? null;
  for (const [vicina, lontana] of [
    ["A2", "A3"],
    ["B1", "C1"],
  ]) {
    const a = con(vicina);
    const b = con(lontana);
    if (!a || !b) continue;
    const c = { x: 2 * a.centro.x - b.centro.x, y: 2 * a.centro.y - b.centro.y };
    const passo = Math.hypot(a.centro.x - b.centro.x, a.centro.y - b.centro.y) / 4;
    return { bounds: { minX: c.x - passo, maxX: c.x + passo, minY: c.y - passo, maxY: c.y + passo }, centro: c, numero: null, nomi: ["A1 (angolo)"] };
  }
  return null;
}

/** pin 1 declared in the description: "pin 1 = A1", "pin1: B3", "piedino 1 = 5" */
const PIN1_DICHIARATO = /\b(?:pin|piedino)\s*1\s*[=:]\s*([A-Za-z]{0,2}\d{1,3})\b/i;

/** every part of the board that has a way round, with its pads and the one its mark points at */
export function pezziConVerso(circuitJson: readonly unknown[], fileDelProgetto: Record<string, string> = {}): PezzoConVerso[] {
  const els = circuitJson as El[];
  const nonMontati = nomiNonMontati(circuitJson);
  const tuttiINomi = new Set(els.filter((e) => e.type === "source_component" && typeof e.name === "string").map((e) => String(e.name)));
  const descrizioni = Object.keys(fileDelProgetto).length > 0 ? propDaiSorgenti(fileDelProgetto, tuttiINomi, ["description"]) : new Map<string, string>();
  const corpi = corpiDeiPezzi(els);
  const sorgenti = new Map<string, El>();
  const porteSorgente = new Map<string, El>();
  const portePcb = new Map<string, string>();
  for (const el of els) {
    if (el.type === "source_component") sorgenti.set(String(el.source_component_id), el);
    else if (el.type === "source_port") porteSorgente.set(String(el.source_port_id), el);
    else if (el.type === "pcb_port") portePcb.set(String(el.pcb_port_id), String(el.source_port_id ?? ""));
  }
  const piazzolePer = new Map<string, PiazzolaDelPezzo[]>();
  for (const el of els) {
    if (el.type !== "pcb_smtpad" && el.type !== "pcb_plated_hole") continue;
    const id = typeof el.pcb_component_id === "string" ? el.pcb_component_id : null;
    if (!id) continue;
    const b = padBounds(el);
    if (!b) continue;
    const sp = typeof el.pcb_port_id === "string" ? porteSorgente.get(portePcb.get(el.pcb_port_id) ?? "") : undefined;
    const nomi = new Set<string>();
    for (const h of [sp?.name, ...((sp?.port_hints as unknown[] | undefined) ?? [])]) if (typeof h === "string" && h) nomi.add(h);
    const numero = num(sp?.pin_number);
    const lista = piazzolePer.get(id) ?? [];
    lista.push({ bounds: b, centro: { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }, numero, nomi: [...nomi] });
    piazzolePer.set(id, lista);
  }

  const out: PezzoConVerso[] = [];
  for (const pc of els) {
    if (pc.type !== "pcb_component") continue;
    const id = String(pc.pcb_component_id ?? "");
    const sc = sorgenti.get(String(pc.source_component_id ?? ""));
    if (!sc) continue;
    const nome = String(sc.name ?? id);
    if (nonMontati.has(nome)) continue;
    const piazzole = piazzolePer.get(id) ?? [];
    // pins, not pads: a pin of several pads (a thermal pad, a shield) is one
    const pin = new Map<number, PiazzolaDelPezzo>();
    for (const p of piazzole) if (p.numero !== null && !pin.has(p.numero)) pin.set(p.numero, p);
    if (pin.size < 2) continue;
    const faccia = pc.layer === "bottom" ? "bottom" : "top";
    const ftype = String(sc.ftype ?? "");
    const descrizione = descrizioni.get(nome) ?? (typeof sc.description === "string" ? sc.description : "");
    const testoDelPezzo = [sc.manufacturer_part_number, descrizione, sc.display_value].filter((v) => typeof v === "string").join(" ");
    const bidirezionale = BIDIREZIONALE.test(descrizione);
    const prefisso = (nome.match(/^[A-Za-z]+/)?.[0] ?? "").toUpperCase();
    const due = pin.size === 2;
    const conNomi = (re: RegExp) => [...pin.values()].find((p) => p.nomi.some((n) => re.test(n))) ?? null;
    const base = { id, nome, faccia, piazzole, corpo: corpi.get(id)?.corpo ?? unione(piazzole.map((q) => q.bounds))!, scocca: corpi.get(id)?.scocca ?? null } as const;

    // a bidirectional TVS drawn as a <diode> (TPD1E1B04 on sbb-dl-principale): no way round, when its description says so
    if (ftype === "simple_diode" && bidirezionale) continue;
    if (ftype === "simple_led" || ftype === "simple_diode") {
      // a <led> or a <diode> says its roles by being one: tscircuit's pin 1 is the anode, pin 2 the cathode, whatever the pads are called
      out.push({ ...base, tipo: ftype === "simple_led" ? "led" : "diodo", chiave: conNomi(/^cathode$/i) ?? pin.get(2) ?? null, altra: conNomi(/^anode$/i) ?? pin.get(1) ?? null, riferimento: "catodo", ruoliDichiarati: true, comeSiChiama: ftype === "simple_led" ? "il LED" : "il diodo" });
      continue;
    }
    if ((ftype === "simple_capacitor" && sc.are_pins_interchangeable === false) || ftype === "simple_battery") {
      out.push({ ...base, tipo: ftype === "simple_battery" ? "batteria" : "condensatore", chiave: conNomi(/^(pos|anode)$/i) ?? pin.get(1) ?? null, altra: conNomi(/^(neg|cathode)$/i) ?? pin.get(2) ?? null, riferimento: "piu", ruoliDichiarati: true, comeSiChiama: ftype === "simple_battery" ? "la batteria" : "il condensatore polarizzato" });
      continue;
    }
    if (ftype === "simple_chip" && due) {
      const diodo = prefisso === "D" || prefisso === "LED";
      const batteria = prefisso === "BT";
      const condensatore = prefisso === "C" && CONDENSATORE_POLARIZZATO.test(testoDelPezzo);
      const connettore = ["J", "P", "CN", "CON", "X"].includes(prefisso);
      if (!diodo && !batteria && !condensatore && !connettore) continue;
      if (diodo && bidirezionale) continue;
      if (connettore) {
        out.push({ ...base, tipo: "integrato", chiave: pin.get(1) ?? null, altra: null, riferimento: "pin1", ruoliDichiarati: true, comeSiChiama: "il connettore" });
        continue;
      }
      const catodo = conNomi(CATODO);
      const anodo = conNomi(ANODO);
      const ruoli = catodo !== null && anodo !== null && catodo !== anodo;
      out.push({
        ...base,
        tipo: diodo ? "diodo" : batteria ? "batteria" : "condensatore",
        chiave: ruoli ? (diodo ? catodo : anodo) : null,
        altra: ruoli ? (diodo ? anodo : catodo) : null,
        riferimento: diodo ? "catodo" : "piu",
        ruoliDichiarati: ruoli,
        comeSiChiama: diodo ? "un <chip> usato come diodo o LED" : batteria ? "un <chip> usato come batteria" : "un <chip> usato come condensatore polarizzato",
      });
      continue;
    }
    // three pins or more: a pin 1 (chips, transistors, mosfets, connectors, pin headers, crystals with a dot)
    if (pin.size >= 3 && /^simple_(chip|transistor|mosfet|pin_header|connector|crystal|resonator|potentiometer|switch|push_button)$/.test(ftype)) {
      // pin 1, or the ball or the contact called A1 (a BGA, a USB-C plug), or the corner A1 of a BGA with no ball there
      // a pin 1 declared in the description ("pin 1 = A1", the name of the datasheet) comes first
      const dichiarato = descrizione.match(PIN1_DICHIARATO)?.[1]?.toUpperCase() ?? null;
      const perNome = (n: string) => piazzole.find((q) => q.nomi.some((x) => x.toUpperCase() === n) || (q.numero !== null && String(q.numero) === n)) ?? null;
      // balls named by row and column (A2, B1...): tscircuit numbers them in the order of the pads, so its pin 1 is
      // no datasheet pin 1 unless the ball is A1
      const unoDiTscircuit = pin.get(1) ?? null;
      const sfera = unoDiTscircuit?.nomi.find((n) => !/^(pin)?\d+$/i.test(n)) ?? null;
      const perGriglia = sfera !== null && /^[A-Z]{1,2}\d{1,2}$/i.test(sfera) && !/^a1$/i.test(sfera);
      const uno =
        (dichiarato ? (perNome(dichiarato) ?? (dichiarato === "A1" ? angoloA1(piazzole) : null)) : null) ??
        (perGriglia ? null : unoDiTscircuit) ??
        piazzole.find((q) => q.nomi.some((n) => /^a1$/i.test(n))) ??
        angoloA1(piazzole) ??
        unoDiTscircuit;
      out.push({ ...base, tipo: "integrato", chiave: uno, altra: null, riferimento: "pin1", ruoliDichiarati: uno !== null, comeSiChiama: ftype === "simple_transistor" || ftype === "simple_mosfet" ? "il transistor" : "il pezzo" });
    } else if (ftype === "simple_pin_header" && due) {
      out.push({ ...base, tipo: "integrato", chiave: pin.get(1) ?? null, altra: null, riferimento: "pin1", ruoliDichiarati: true, comeSiChiama: "il connettore" });
    }
  }
  return out;
}

/** one silkscreen element read for the marks: its face, its part, its text, and its ink as points */
interface Inchiostro {
  faccia: "top" | "bottom";
  /** the part it is drawn in (its <footprint>), or, for a drawing of the board, the part it is nearest to: null for none */
  pezzo: string | null;
  /** a drawing of the board as near to two parts: it is a mark of neither (the ids of the two) */
  conteso?: [string, string];
  testo: string | null;
  punti: Punto[];
  box: Bounds;
}

function inchiostri(els: El[]): Inchiostro[] {
  const out: Inchiostro[] = [];
  for (const el of els) {
    if (typeof el.type !== "string" || !el.type.startsWith("pcb_silkscreen_")) continue;
    const d = disegnoStampato(el);
    if (!d) continue;
    const punti: Punto[] = [];
    for (const [a, b] of d.segmenti) {
      const passi = Math.max(1, Math.min(200, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / PASSO_MM)));
      for (let k = 0; k <= passi; k++) punti.push({ x: a.x + ((b.x - a.x) * k) / passi, y: a.y + ((b.y - a.y) * k) / passi });
    }
    for (const r of d.regioni) for (const p of r) punti.push(p);
    if (punti.length === 0) continue;
    const xs = punti.map((p) => p.x);
    const ys = punti.map((p) => p.y);
    out.push({
      faccia: d.faccia,
      pezzo: typeof el.pcb_component_id === "string" && el.pcb_component_id ? el.pcb_component_id : null,
      testo: d.testo,
      punti,
      box: { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) },
    });
  }
  return out;
}

/** a drawing of the board is contested when the second nearest part is nearer than this more than the first (mm), or than a quarter of its distance */
const CONTESA_MM = 0.1;
const contesa = (d1: number, d2: number) => d2 - d1 < Math.max(CONTESA_MM, 0.25 * d2);

/**
 * EVERY MARK TO ONE PART. A drawing inside a part's <footprint> is that part's.
 * A drawing of the board (no part) is the part whose body (the box of its pads)
 * is nearest to it, on its face and within PORTATA_MM: a dot drawn beside J5 is
 * J5's, not of the diode next to it. When two parts are nearly as near
 * (contesa) it is neither's, and the check says so.
 */
/** a pad of the board: its box, to find it, and its shape as it lies, turned (a QFP at 45 degrees), to tell what it covers */
interface Apertura {
  b: Bounds;
  g: PadGeometry;
}

/** whether a point falls on the opening of a pad, within `margine`: the pad as it lies, not the box around it */
function sullApertura(q: Punto, a: Apertura, margine: number): boolean {
  if (!dentroBox(q, a.b, margine)) return false;
  const r = (-a.g.rot * Math.PI) / 180;
  const dx = q.x - a.g.x;
  const dy = q.y - a.g.y;
  const lx = dx * Math.cos(r) - dy * Math.sin(r);
  const ly = dx * Math.sin(r) + dy * Math.cos(r);
  return Math.abs(lx) < a.g.w / 2 + margine && Math.abs(ly) < a.g.h / 2 + margine;
}

function attribuiti(els: El[], tutto: Inchiostro[], tutteLePiazzole: Apertura[]): Inchiostro[] {
  const corpi = [...corpiDeiPezzi(els)].map(([id, c]) => ({ id, ...c }));
  return tutto.map((ink) => {
    if (ink.pezzo !== null) return ink;
    const visti = ink.punti.filter((q) => !tutteLePiazzole.some((a) => sullApertura(q, a, APERTURA_MM)));
    if (visti.length === 0) return ink;
    const m = { x: visti.reduce((t, q) => t + q.x, 0) / visti.length, y: visti.reduce((t, q) => t + q.y, 0) / visti.length };
    let primo: { id: string; d: number } | null = null;
    let secondo: { id: string; d: number } | null = null;
    for (const c of corpi) {
      if (c.faccia !== ink.faccia) continue;
      const d = distanzaDaBox(m, c.corpo);
      if (d > PORTATA_MM * 1.5) continue;
      if (!primo || d < primo.d) {
        secondo = primo;
        primo = { id: c.id, d };
      } else if (!secondo || d < secondo.d) secondo = { id: c.id, d };
    }
    if (!primo || primo.d > PORTATA_MM) return ink;
    if (secondo && contesa(primo.d, secondo.d)) return { ...ink, conteso: [primo.id, secondo.id] as [string, string] };
    return { ...ink, pezzo: primo.id };
  });
}

/**
 * Whether a point is hidden by the part once mounted: under the package of its
 * 3D model, turned as it lies (a QFP at 45 degrees leaves its corners free), or,
 * without a model, under the box of its pads.
 */
function sottoIlCorpo(p: PezzoConVerso, q: Punto): boolean {
  const s = p.scocca;
  if (!s) return dentroBox(q, p.corpo, -0.02);
  const a = (-s.rot * Math.PI) / 180;
  const dx = q.x - s.x;
  const dy = q.y - s.y;
  const lx = dx * Math.cos(a) - dy * Math.sin(a);
  const ly = dx * Math.sin(a) + dy * Math.cos(a);
  return Math.abs(lx) < s.w / 2 - 0.02 && Math.abs(ly) < s.h / 2 - 0.02;
}

/** where the marks of one part are, read from the ink near it: on the side of its key pad, on the other side */
function segniDelPezzo(p: PezzoConVerso, tutto: Inchiostro[], tutteLePiazzole: Apertura[], soloContesi = false): { giusti: number; alContrario: number } {
  const corpo = p.corpo;
  if (!p.chiave) return { giusti: 0, alContrario: 0 };
  const intorno: Bounds = { minX: corpo.minX - PORTATA_MM, maxX: corpo.maxX + PORTATA_MM, minY: corpo.minY - PORTATA_MM, maxY: corpo.maxY + PORTATA_MM };
  const vicinePiazzole = tutteLePiazzole.filter(({ b }) => b.maxX > intorno.minX && b.minX < intorno.maxX && b.maxY > intorno.minY && b.minY < intorno.maxY);
  const centroPezzo = { x: (corpo.minX + corpo.maxX) / 2, y: (corpo.minY + corpo.maxY) / 2 };
  const semidiagonale = Math.hypot(corpo.maxX - corpo.minX, corpo.maxY - corpo.minY) / 2;
  let giusti = 0;
  let alContrario = 0;
  for (const ink of tutto) {
    if (ink.faccia !== p.faccia) continue;
    // each mark belongs to one part: its own drawings, and the drawings of the board nearest to it; a contested one to neither
    if (soloContesi ? !ink.conteso?.includes(p.id) : ink.pezzo !== p.id) continue;
    if (ink.box.maxX < intorno.minX || ink.box.minX > intorno.maxX || ink.box.maxY < intorno.minY || ink.box.minY > intorno.maxY) continue;
    // the name of a part is no mark
    if (ink.testo !== null && DESIGNATORE.test(ink.testo.trim())) continue;
    // what a person sees with the part mounted: off the body, off every pad's opening
    const visti = ink.punti.filter((q) => !sottoIlCorpo(p, q) && !vicinePiazzole.some((a) => sullApertura(q, a, APERTURA_MM)));
    if (visti.length === 0) continue;
    const m = { x: visti.reduce((t, q) => t + q.x, 0) / visti.length, y: visti.reduce((t, q) => t + q.y, 0) / visti.length };
    if (distanzaDaBox(m, intorno) > 0) continue;
    const piu = ink.testo !== null && ink.testo.trim() === "+";
    if (p.altra) {
      // two terminals: which side the middle of the ink stands on, along the line from the other pad to the key one
      const ux = p.chiave.centro.x - p.altra.centro.x;
      const uy = p.chiave.centro.y - p.altra.centro.y;
      const l = Math.hypot(ux, uy);
      if (l < 1e-6) continue;
      const mezzo = { x: (p.chiave.centro.x + p.altra.centro.x) / 2, y: (p.chiave.centro.y + p.altra.centro.y) / 2 };
      const t = ((m.x - mezzo.x) * ux + (m.y - mezzo.y) * uy) / l / (l / 2);
      const vicinoAllaChiave = distanzaDaBox(m, p.chiave.bounds) <= PORTATA_MM;
      const vicinoAllAltra = distanzaDaBox(m, p.altra.bounds) <= PORTATA_MM;
      if (p.riferimento === "catodo") {
        // a "+" stands on the anode; anything else stands on the cathode
        if (piu) {
          if (t < -DA_UN_LATO && vicinoAllAltra) giusti++;
          else if (t > DA_UN_LATO && vicinoAllaChiave) alContrario++;
        } else if (t > DA_UN_LATO && vicinoAllaChiave) giusti++;
        else if (t < -DA_UN_LATO && vicinoAllAltra) alContrario++;
      } else if (piu) {
        // a polarized capacitor or a battery: a "+" (docs/pcb-revisione-circuitale.md, 0.2). A bar or a U says nothing
        // sure here: a stripe marks the + of a tantalum and the - of an electrolytic
        if (t > DA_UN_LATO && vicinoAllaChiave) giusti++;
        else if (t < -DA_UN_LATO && vicinoAllAltra) alContrario++;
      }
      continue;
    }
    // pin 1: the ink stands just outside the BODY, to one side of the part, by pin 1: pin 1 (or the corner A1) among
    // the pads nearest to it. Measured from the body, so a mark just outside a connector that covers its pin 1 counts
    if (distanzaDaBox(m, corpo) > PORTATA_MM) continue;
    if (Math.hypot(m.x - centroPezzo.x, m.y - centroPezzo.y) < 0.25 * semidiagonale) continue;
    const candidate = p.piazzole.includes(p.chiave) ? p.piazzole : [...p.piazzole, p.chiave];
    const ordinate = [...candidate].sort((a, b) => distanzaDaBox(m, a.bounds) - distanzaDaBox(m, b.bounds));
    const primi = ordinate.slice(0, 3);
    if (primi.some((q) => q === p.chiave || (q.numero !== null && q.numero === p.chiave!.numero))) giusti++;
  }
  return { giusti, alContrario };
}

const mm = (v: number) => String(Number(v.toFixed(2))).replace(".", ",");

/**
 * THE CHECK: for every part with a way round, what it lacks, in words that say
 * the part, the pad and what to do. Empty for a board where every one has its
 * roles and its mark.
 */
export function controllaPolarita(circuitJson: readonly unknown[], fileDelProgetto: Record<string, string> = {}): ProblemaDiPolarita[] {
  const els = circuitJson as El[];
  const pezzi = pezziConVerso(circuitJson, fileDelProgetto);
  if (pezzi.length === 0) return [];
  const tutteLePiazzole: Apertura[] = [];
  for (const el of els) {
    if (el.type !== "pcb_smtpad" && el.type !== "pcb_plated_hole") continue;
    const b = padBounds(el);
    const g = padGeometry(el);
    if (b && g) tutteLePiazzole.push({ b, g });
  }
  const tutto = attribuiti(els, inchiostri(els), tutteLePiazzole);
  const nomeDi = new Map<string, string>();
  {
    const sc = new Map(els.filter((e) => e.type === "source_component").map((e) => [String(e.source_component_id), String(e.name ?? "")]));
    for (const e of els) if (e.type === "pcb_component") nomeDi.set(String(e.pcb_component_id), sc.get(String(e.source_component_id ?? "")) ?? "");
  }
  const out: ProblemaDiPolarita[] = [];
  for (const p of pezzi) {
    const corpo = p.corpo;
    const dove = p.chiave?.centro ?? { x: (corpo.minX + corpo.maxX) / 2, y: (corpo.minY + corpo.maxY) / 2 };
    const base = { nome: p.nome, x: dove.x, y: dove.y, faccia: p.faccia };
    if (!p.ruoliDichiarati || !p.chiave) {
      out.push({
        ...base,
        motivo: "ruoli",
        messaggio:
          `${p.nome}: e' ${p.comeSiChiama} ma i suoi piedini non dicono ${p.riferimento === "catodo" ? "anodo e catodo" : p.riferimento === "piu" ? "il + e il -" : "quale e' il pin 1"}. ` +
          (p.riferimento === "catodo"
            ? `Scrivi i nomi dal datasheet, per esempio pinLabels={{ pin1: "A", pin2: "K" }} (o anode / cathode), sui numeri giusti delle piazzole. Se e' un TVS bidirezionale, ${COME_DIRE_BIDIREZIONALE}`
            : p.riferimento === "piu"
              ? `Scrivi i nomi dal datasheet, per esempio pinLabels={{ pin1: "+", pin2: "-" }}, sui numeri giusti delle piazzole`
              : `Numera le piazzole dal pin 1 del datasheet, oppure dichiaralo nella description con il nome del datasheet, per esempio description="... pin 1 = A1" (un BGA senza sfera A1: l'angolo A1 si ricava dalla griglia, nessuna sfera va rinominata)`),
      });
      continue;
    }
    const { giusti, alContrario } = segniDelPezzo(p, tutto, tutteLePiazzole);
    const posto = `piazzola in (${mm(p.chiave.centro.x)}; ${mm(p.chiave.centro.y)}), faccia ${p.faccia}`;
    // a mark that would be this part's, were it not as near to another part: it is said, and it counts for neither
    if (giusti === 0 && segniDelPezzo(p, tutto, tutteLePiazzole, true).giusti > 0) {
      const conteso = tutto.find((ink) => ink.conteso?.includes(p.id))?.conteso;
      const altro = conteso ? nomeDi.get(conteso[0] === p.id ? conteso[1] : conteso[0]) : undefined;
      out.push({
        ...base,
        motivo: "segno_conteso",
        messaggio:
          `${p.nome}: il segno in serigrafia accanto a lui sta quasi alla stessa distanza da ${altro || "un altro pezzo"} e non si sa di chi dei due e': non vale per nessuno. ` +
          `Disegnalo dentro la <footprint> di ${p.nome}, o spostalo accanto alla sua ${posto} e lontano dall'altro pezzo`,
      });
      continue;
    }
    if (alContrario > 0 && giusti === 0) {
      out.push({
        ...base,
        motivo: "segno_al_contrario",
        messaggio:
          p.riferimento === "catodo"
            ? `${p.nome}: il segno in serigrafia sta dal lato dell'ANODO e chi monta lo legge come catodo (cosi' e' stato montato al contrario il LED della sonda). ` +
              `Metti una barra fuori dal corpo accanto al CATODO (${posto}) e, se vuoi, un «+» accanto all'anodo; togli il segno dal lato dell'anodo. ` +
              `Se e' un TVS bidirezionale, ${COME_DIRE_BIDIREZIONALE}`
            : `${p.nome}: il «+» in serigrafia sta dal lato del -. Mettilo accanto al + (${posto})`,
      });
      continue;
    }
    if (giusti === 0) {
      const cosa =
        p.riferimento === "catodo"
          ? `una barra accanto al catodo (${posto}), fuori dal corpo e dalle piazzole, o un «+» accanto all'anodo. Se e' un TVS bidirezionale, ${COME_DIRE_BIDIREZIONALE}`
          : p.riferimento === "piu"
            ? `un «+» accanto al + (${posto}), fuori dal corpo e dalle piazzole`
            : `un punto (<silkscreencircle>) accanto al pin 1 (${posto}), fuori dal corpo e dalle piazzole`;
      out.push({
        ...base,
        motivo: "segno",
        messaggio: `${p.nome}: nessun segno di ${p.riferimento === "catodo" ? "polarita'" : p.riferimento === "piu" ? "polarita' (+)" : "pin 1"} in serigrafia che si veda a pezzo montato. Aggiungi ${cosa}`,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// THE SILKSCREEN OF A <led> AND OF A <diode>
// ---------------------------------------------------------------------------

/** the pen of the marks drawn here (mm): what the fabs print without losing it */
const PENNA_SEGNO_MM = 0.12;

/**
 * Whether a silkscreen path is the U that tscircuit's footprinter draws round a
 * two-pad part, closed beyond pad `chiuso`: four points, the middle two beyond
 * that pad, the two ends by the other one.
 */
function eLaU(route: Punto[], chiuso: Punto, aperto: Punto): boolean {
  if (route.length !== 4) return false;
  const ux = aperto.x - chiuso.x;
  const uy = aperto.y - chiuso.y;
  const l2 = ux * ux + uy * uy;
  if (l2 < 1e-9) return false;
  const t = (p: Punto) => ((p.x - chiuso.x) * ux + (p.y - chiuso.y) * uy) / l2;
  return t(route[1]) < -0.05 && t(route[2]) < -0.05 && t(route[0]) > 0.5 && t(route[3]) > 0.5;
}

/**
 * THE SILKSCREEN OF EVERY <led> AND <diode>: a bar beside the CATHODE and a
 * "+" beside the anode, in place of the U closed on the anode that tscircuit
 * draws, read by the fabs as the cathode (tscircuit/core issue 5565). Only the
 * U the footprinter draws is replaced: a part with a silkscreen of its own (a
 * <footprint> written by hand) keeps it, and the check above judges it. Both
 * marks are drawn in the frame of the part, so a turned part has them turned.
 * The same array when there is nothing to replace.
 */
export function serigrafiaDellaPolarita<T>(circuitJson: T[], fileDelProgetto: Record<string, string> = {}): T[] {
  const els = circuitJson as unknown as El[];
  const pezzi = pezziConVerso(els, fileDelProgetto).filter((p) => (p.tipo === "led" || p.tipo === "diodo") && p.chiave && p.altra && p.ruoliDichiarati);
  if (pezzi.length === 0) return circuitJson;
  const via = new Set<El>();
  const nuovi: El[] = [];
  for (const p of pezzi) {
    const catodo = p.chiave!;
    const anodo = p.altra!;
    const u = els.filter(
      (el) =>
        el.type === "pcb_silkscreen_path" &&
        el.pcb_component_id === p.id &&
        eLaU(((el.route as Punto[] | undefined) ?? []).map((q) => ({ x: Number(q.x), y: Number(q.y) })), anodo.centro, catodo.centro),
    );
    if (u.length === 0) continue;
    for (const el of u) via.add(el);
    const faccia = (u[0].layer as string) ?? p.faccia;
    const lx = catodo.centro.x - anodo.centro.x;
    const ly = catodo.centro.y - anodo.centro.y;
    const l = Math.hypot(lx, ly);
    const ux = lx / l;
    const uy = ly / l;
    const nx = -uy;
    const ny = ux;
    // the half extent of a pad along the axis and across it
    const lungo = (b: Bounds) => (Math.abs(ux) * (b.maxX - b.minX) + Math.abs(uy) * (b.maxY - b.minY)) / 2;
    const largo = (b: Bounds) => (Math.abs(nx) * (b.maxX - b.minX) + Math.abs(ny) * (b.maxY - b.minY)) / 2;
    // the bar: across the axis, just past the cathode pad
    const d = lungo(catodo.bounds) + 0.25;
    const h = largo(catodo.bounds) + 0.15;
    const cb = { x: catodo.centro.x + ux * d, y: catodo.centro.y + uy * d };
    nuovi.push({
      type: "pcb_silkscreen_path",
      pcb_silkscreen_path_id: `pcb_silkscreen_path_catodo_${p.id}`,
      pcb_component_id: p.id,
      layer: faccia,
      route: [
        { x: cb.x - nx * h, y: cb.y - ny * h },
        { x: cb.x + nx * h, y: cb.y + ny * h },
      ],
      stroke_width: PENNA_SEGNO_MM,
    });
    // the "+": a text just past the anode pad, which every reading of the silkscreen tells for a "+"
    const da = lungo(anodo.bounds) + 0.45;
    nuovi.push({
      type: "pcb_silkscreen_text",
      pcb_silkscreen_text_id: `pcb_silkscreen_text_piu_${p.id}`,
      pcb_component_id: p.id,
      layer: faccia,
      font: "tscircuit2024",
      font_size: 0.6,
      text: "+",
      anchor_position: { x: anodo.centro.x - ux * da, y: anodo.centro.y - uy * da },
      anchor_alignment: "center",
    });
  }
  if (via.size === 0) return circuitJson;
  return [...els.filter((el) => !via.has(el)), ...nuovi] as unknown as T[];
}

/**
 * What the export says of a board that does not pass: how many parts with a way
 * round lack their roles or their mark, and which (see nonCertificata). null
 * for a board where every one has them. Measured on the board about to go.
 */
export function polaritaDellaSchedaCheEsce(circuitJson: readonly unknown[], fileDelProgetto: Record<string, string> = {}): { count: number; detail: string } | null {
  const problemi = controllaPolarita(circuitJson, fileDelProgetto);
  if (problemi.length === 0) return null;
  const nomi = [...new Set(problemi.map((p) => p.nome))];
  const alContrario = problemi.filter((p) => p.motivo === "segno_al_contrario").map((p) => p.nome);
  return {
    count: nomi.length,
    detail:
      `${nomi.length === 1 ? "un pezzo con un verso non ha" : `${nomi.length} pezzi con un verso non hanno`} i ruoli dei piedini o il segno in serigrafia ` +
      `(${nomi.slice(0, 12).join(", ")}${nomi.length > 12 ? ` e altri ${nomi.length - 12}` : ""})` +
      (alContrario.length > 0 ? `; con il segno dal lato sbagliato: ${alContrario.slice(0, 12).join(", ")}` : ""),
  };
}
