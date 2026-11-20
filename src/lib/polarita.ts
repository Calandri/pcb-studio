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
import { padBounds, type Bounds } from "./footprint-bounds";
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

export type MotivoDiPolarita = "ruoli" | "segno" | "segno_al_contrario";

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
/** a two-pin part whose two pins have the same role: a bidirectional TVS (A1, A2) */
const BIDIREZIONALE = /bidirection|bi-direction|bidirezional/i;
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

/** every part of the board that has a way round, with its pads and the one its mark points at */
export function pezziConVerso(circuitJson: readonly unknown[]): PezzoConVerso[] {
  const els = circuitJson as El[];
  const nonMontati = nomiNonMontati(circuitJson);
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
    const testoDelPezzo = [sc.manufacturer_part_number, sc.description, sc.display_value, sc.name].filter((v) => typeof v === "string").join(" ");
    const prefisso = (nome.match(/^[A-Za-z]+/)?.[0] ?? "").toUpperCase();
    const due = pin.size === 2;
    const conNomi = (re: RegExp) => [...pin.values()].find((p) => p.nomi.some((n) => re.test(n))) ?? null;
    const base = { id, nome, faccia, piazzole } as const;

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
      if (diodo && BIDIREZIONALE.test(testoDelPezzo)) continue;
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
      // pin 1, or the ball or the contact called A1 (a BGA, a USB-C plug)
      const uno = pin.get(1) ?? piazzole.find((q) => q.nomi.some((n) => /^a1$/i.test(n))) ?? null;
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
  pezzo: string | null;
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

/** where the marks of one part are, read from the ink near it: on the side of its key pad, on the other side */
function segniDelPezzo(p: PezzoConVerso, tutto: Inchiostro[], tutteLePiazzole: Bounds[]): { giusti: number; alContrario: number } {
  const corpo = unione(p.piazzole.map((q) => q.bounds));
  if (!corpo || !p.chiave) return { giusti: 0, alContrario: 0 };
  const intorno: Bounds = { minX: corpo.minX - PORTATA_MM, maxX: corpo.maxX + PORTATA_MM, minY: corpo.minY - PORTATA_MM, maxY: corpo.maxY + PORTATA_MM };
  const vicinePiazzole = tutteLePiazzole.filter((b) => b.maxX > intorno.minX && b.minX < intorno.maxX && b.maxY > intorno.minY && b.minY < intorno.maxY);
  const centroPezzo = { x: (corpo.minX + corpo.maxX) / 2, y: (corpo.minY + corpo.maxY) / 2 };
  const semidiagonale = Math.hypot(corpo.maxX - corpo.minX, corpo.maxY - corpo.minY) / 2;
  let giusti = 0;
  let alContrario = 0;
  for (const ink of tutto) {
    if (ink.faccia !== p.faccia) continue;
    if (ink.pezzo !== null && ink.pezzo !== p.id) continue;
    if (ink.box.maxX < intorno.minX || ink.box.minX > intorno.maxX || ink.box.maxY < intorno.minY || ink.box.minY > intorno.maxY) continue;
    // the name of a part is no mark
    if (ink.testo !== null && DESIGNATORE.test(ink.testo.trim())) continue;
    // what a person sees with the part mounted: off the body, off every pad's opening
    const visti = ink.punti.filter((q) => !dentroBox(q, corpo, -0.02) && !vicinePiazzole.some((b) => dentroBox(q, b, APERTURA_MM)));
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
    // pin 1: the ink stands to one side of the part, by pin 1, with pin 1 among the two pads nearest to it
    if (distanzaDaBox(m, p.chiave.bounds) > PORTATA_MM) continue;
    if (Math.hypot(m.x - centroPezzo.x, m.y - centroPezzo.y) < 0.25 * semidiagonale) continue;
    const ordinate = [...p.piazzole].sort((a, b) => distanzaDaBox(m, a.bounds) - distanzaDaBox(m, b.bounds));
    const primi = ordinate.slice(0, 2);
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
export function controllaPolarita(circuitJson: readonly unknown[]): ProblemaDiPolarita[] {
  const els = circuitJson as El[];
  const pezzi = pezziConVerso(circuitJson);
  if (pezzi.length === 0) return [];
  const tutto = inchiostri(els);
  const tutteLePiazzole: Bounds[] = [];
  for (const el of els) {
    if (el.type !== "pcb_smtpad" && el.type !== "pcb_plated_hole") continue;
    const b = padBounds(el);
    if (b) tutteLePiazzole.push(b);
  }
  const out: ProblemaDiPolarita[] = [];
  for (const p of pezzi) {
    const corpo = unione(p.piazzole.map((q) => q.bounds))!;
    const dove = p.chiave?.centro ?? { x: (corpo.minX + corpo.maxX) / 2, y: (corpo.minY + corpo.maxY) / 2 };
    const base = { nome: p.nome, x: dove.x, y: dove.y, faccia: p.faccia };
    if (!p.ruoliDichiarati || !p.chiave) {
      out.push({
        ...base,
        motivo: "ruoli",
        messaggio:
          `${p.nome}: e' ${p.comeSiChiama} ma i suoi piedini non dicono ${p.riferimento === "catodo" ? "anodo e catodo" : p.riferimento === "piu" ? "il + e il -" : "quale e' il pin 1"}. ` +
          (p.riferimento === "catodo"
            ? `Scrivi i nomi dal datasheet, per esempio pinLabels={{ pin1: "A", pin2: "K" }} (o anode / cathode), sui numeri giusti delle piazzole; se e' bidirezionale scrivilo nella description`
            : p.riferimento === "piu"
              ? `Scrivi i nomi dal datasheet, per esempio pinLabels={{ pin1: "+", pin2: "-" }}, sui numeri giusti delle piazzole`
              : `Numera le piazzole dal pin 1 del datasheet`),
      });
      continue;
    }
    const { giusti, alContrario } = segniDelPezzo(p, tutto, tutteLePiazzole);
    const posto = `piazzola in (${mm(p.chiave.centro.x)}; ${mm(p.chiave.centro.y)}), faccia ${p.faccia}`;
    if (alContrario > 0 && giusti === 0) {
      out.push({
        ...base,
        motivo: "segno_al_contrario",
        messaggio:
          p.riferimento === "catodo"
            ? `${p.nome}: il segno in serigrafia sta dal lato dell'ANODO e chi monta lo legge come catodo (cosi' e' stato montato al contrario il LED della sonda). ` +
              `Metti una barra fuori dal corpo accanto al CATODO (${posto}) e, se vuoi, un «+» accanto all'anodo; togli il segno dal lato dell'anodo`
            : `${p.nome}: il «+» in serigrafia sta dal lato del -. Mettilo accanto al + (${posto})`,
      });
      continue;
    }
    if (giusti === 0) {
      const cosa =
        p.riferimento === "catodo"
          ? `una barra accanto al catodo (${posto}), fuori dal corpo e dalle piazzole, o un «+» accanto all'anodo`
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
export function serigrafiaDellaPolarita<T>(circuitJson: T[]): T[] {
  const els = circuitJson as unknown as El[];
  const pezzi = pezziConVerso(els).filter((p) => (p.tipo === "led" || p.tipo === "diodo") && p.chiave && p.altra && p.ruoliDichiarati);
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
export function polaritaDellaSchedaCheEsce(circuitJson: readonly unknown[]): { count: number; detail: string } | null {
  const problemi = controllaPolarita(circuitJson);
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
