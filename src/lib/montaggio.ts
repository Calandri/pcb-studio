/**
 * THE ASSEMBLY PACKAGE OF A BOARD, IN ONE CONVENTION: the pick and place in the
 * convention of JLCPCB / EasyEDA (the one PCB Basic mounted the chips of the
 * sonda del suolo right with), the comparison by NAME of every part with a way
 * round against its LCSC footprint, the assembly drawings of the two faces and
 * the polarity of every part in words. Written after the audit of 2026-11-20
 * (Audit_polarita): rotations of the bottom read "from above" on one board and
 * "from below" on another and declared nowhere, a drawing whose legend put
 * "anode" on the cathode, footprints whose pad 1 is the opposite of the LCSC one.
 *
 * THE CONVENTION (declared in the notes, CONVENZIONE below):
 *   top    : P = R(rot) F + c        rot counter-clockwise, F the LCSC/EasyEDA footprint of the code at 0 degrees
 *   bottom : P = R(-rot) Mx F + c    X and Y seen from the top, rotation seen from the bottom (Mx mirrors x)
 * The rotation is found by laying the LCSC pads on the board's: of the
 * rotations that fit (symmetric footprints), the FUNCTION of the pins decides
 * (anode, cathode, +, the names of the pins), the pad number only after, and
 * never alone for a part with a way round. Coordinates are the ones the pick
 * and place always had (centriDiMontaggio): only the rotation changes. A part
 * with no LCSC footprint keeps the angle of our footprint, read the same way
 * (on the bottom 360 - angle), and the notes say to orient it by the drawing.
 *
 * Ported from the scripts that made the order of 2026-11-20 with zero misses
 * (lavoro_wildy: adatta.py, genera_cpl.py, versi.py, verifica.py), with the
 * roles of the pins read from the board (polarita.ts) instead of hand tables.
 * The check (verificaMontaggio) reads the rows back by a path of its own.
 */
import { righeCpl, type PnpRow } from "./bom";
import type { ImprontaLcsc, PiazzolaLcsc } from "./lcsc-impronte";
import { nomiNonMontati } from "./non-montati";
import { pezziConVerso, type PezzoConVerso } from "./polarita";

type El = Record<string, unknown> & { type: string };
type Punto = { x: number; y: number };

export const CONVENZIONE =
  "Pick and place convention, one for the whole board: JLCPCB / EasyEDA. Rotation is counter-clockwise, from the LCSC / EasyEDA footprint " +
  "of the part code at 0 degrees. Top side: seen from the top. Bottom side: X and Y seen from the top, rotation seen from the bottom.";

export interface PiazzolaMontata {
  x: number;
  y: number;
  pin: number | null;
  nomi: string[];
}

export interface PezzoMontato {
  id: string;
  nome: string;
  faccia: "top" | "bottom";
  rotazione: number;
  lcsc: string | null;
  piazzole: PiazzolaMontata[];
  verso: PezzoConVerso | null;
}

/** what the rows of the pick and place are read from (righeCpl, centriDiMontaggio) */
const TIPI_DEL_CPL = new Set(["source_component", "pcb_component", "cad_component", "pcb_smtpad", "pcb_plated_hole", "source_port", "pcb_port", "pcb_board"]);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const modulo = (a: number) => Math.round((((a % 360) + 360) % 360) * 1000) / 1000;

/** every mounted part, with its pads, its LCSC code and, when it has one, its way round */
export function pezziMontati(circuitJson: readonly unknown[], fileDelProgetto: Record<string, string> = {}): PezzoMontato[] {
  const els = circuitJson as El[];
  const nonMontati = nomiNonMontati(circuitJson);
  const sorgenti = new Map<string, El>();
  const porte = new Map<string, El>();
  const pcbPorte = new Map<string, string>();
  for (const el of els) {
    if (el.type === "source_component") sorgenti.set(String(el.source_component_id), el);
    else if (el.type === "source_port") porte.set(String(el.source_port_id), el);
    else if (el.type === "pcb_port") pcbPorte.set(String(el.pcb_port_id), String(el.source_port_id ?? ""));
  }
  const piazzole = new Map<string, PiazzolaMontata[]>();
  for (const el of els) {
    if (el.type !== "pcb_smtpad" && el.type !== "pcb_plated_hole") continue;
    const id = typeof el.pcb_component_id === "string" ? el.pcb_component_id : null;
    if (!id) continue;
    let x = num(el.x);
    let y = num(el.y);
    if (el.shape === "polygon" && Array.isArray(el.points)) {
      const pts = (el.points as Array<{ x?: unknown; y?: unknown }>).map((q) => ({ x: num(q?.x), y: num(q?.y) })).filter((q): q is Punto => q.x !== null && q.y !== null);
      if (pts.length > 0) {
        x = (Math.min(...pts.map((q) => q.x)) + Math.max(...pts.map((q) => q.x))) / 2;
        y = (Math.min(...pts.map((q) => q.y)) + Math.max(...pts.map((q) => q.y))) / 2;
      }
    }
    if (x === null || y === null) continue;
    const sp = typeof el.pcb_port_id === "string" ? porte.get(pcbPorte.get(el.pcb_port_id) ?? "") : undefined;
    const nomi = [sp?.name, ...((sp?.port_hints as unknown[] | undefined) ?? [])].filter((n): n is string => typeof n === "string" && n.length > 0);
    const lista = piazzole.get(id) ?? [];
    lista.push({ x, y, pin: num(sp?.pin_number), nomi });
    piazzole.set(id, lista);
  }
  const versi = new Map(pezziConVerso(circuitJson, fileDelProgetto).map((p) => [p.id, p]));
  const out: PezzoMontato[] = [];
  for (const pc of els) {
    if (pc.type !== "pcb_component") continue;
    const sc = sorgenti.get(String(pc.source_component_id ?? ""));
    if (!sc) continue;
    const nome = String(sc.name ?? "");
    if (!nome || nonMontati.has(nome)) continue;
    const id = String(pc.pcb_component_id ?? "");
    const jlc = (sc.supplier_part_numbers as Record<string, unknown> | undefined)?.jlcpcb;
    const lcsc = Array.isArray(jlc) && typeof jlc[0] === "string" ? jlc[0].trim().toUpperCase() : null;
    out.push({
      id,
      nome,
      faccia: pc.layer === "bottom" ? "bottom" : "top",
      rotazione: num(pc.rotation) ?? 0,
      lcsc: lcsc && /^C\d{2,10}$/.test(lcsc) ? lcsc : null,
      piazzole: piazzole.get(id) ?? [],
      verso: versi.get(id) ?? null,
    });
  }
  return out;
}

/** the LCSC codes of the mounted parts: what the footprints are read for */
export const codiciLcsc = (circuitJson: readonly unknown[]): string[] => [...new Set(pezziMontati(circuitJson).map((p) => p.lcsc).filter((c): c is string => c !== null))];

const R = (a: number, p: Punto): Punto => {
  const r = (a * Math.PI) / 180;
  return { x: p.x * Math.cos(r) - p.y * Math.sin(r), y: p.x * Math.sin(r) + p.y * Math.cos(r) };
};
/** where the point p of the footprint at 0 degrees goes with rotation a of the pick and place (without the centre) */
export const piazza = (a: number, p: Punto, faccia: "top" | "bottom"): Punto => (faccia === "bottom" ? R(-a, { x: -p.x, y: p.y }) : R(a, p));

const norma = (s: unknown) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9+-]/g, "");
const MASSE = new Set(["GND", "VSS", "GROUND", "AGND", "DGND", "PGND", "EP", "EPAD", "GNDPAD", "VSSA", "PAD"]);
const eMassa = (s: string) => MASSE.has(s) || s.startsWith("GND") || s.startsWith("VSS");
const FUNZIONI: Record<string, "K" | "A" | "+" | "-"> = { K: "K", C: "K", CATHODE: "K", CATODE: "K", CATODO: "K", A: "A", ANODE: "A", ANODO: "A", "+": "+", POS: "+", "-": "-", NEG: "-" };
/** K, A, + or - of an LCSC pad, from the name of its pin in the symbol */
export const funzioneLcsc = (p: PiazzolaLcsc): "K" | "A" | "+" | "-" | null => FUNZIONI[norma(p.nome)] ?? null;

/** the role of one of our pads: K / A for a diode, + / - for a polarized capacitor or a battery */
function ruoloNostro(pezzo: PezzoMontato, q: PiazzolaMontata): "K" | "A" | "+" | "-" | null {
  const v = pezzo.verso;
  if (!v || !v.chiave || !v.altra) return null;
  const stessa = (k: { centro: Punto }) => Math.hypot(k.centro.x - q.x, k.centro.y - q.y) < 1e-6;
  if (stessa(v.chiave)) return v.riferimento === "catodo" ? "K" : "+";
  if (stessa(v.altra)) return v.riferimento === "catodo" ? "A" : "-";
  return null;
}
/** whether two names say the same function: K/C/cathode, A/anode, +/pos, -/neg */
const stessaFunzione = (a: string | null, b: string | null) => a !== null && b !== null && (a === b || (a === "+" && b === "A") || (a === "A" && b === "+") || (a === "-" && b === "K") || (a === "K" && b === "-"));

/** +1 the LCSC pin has the function of our pad, -1 another one, 0 it cannot be told */
function confronta(pezzo: PezzoMontato, e: PiazzolaLcsc, q: PiazzolaMontata): number {
  if (pezzo.verso?.altra) {
    const fe = funzioneLcsc(e);
    const fq = ruoloNostro(pezzo, q);
    if (!fe || !fq) return 0;
    return stessaFunzione(fe, fq) ? 1 : -1;
  }
  const ne = norma(e.nome);
  if (!ne || ne === norma(e.num) || /^\d+$/.test(ne)) return 0;
  const nostri = new Set(q.nomi.map(norma).filter((n) => n && !/^(PIN)?\d+$/.test(n)));
  if (nostri.has(ne)) return 1;
  // a ground of the LCSC symbol on a pad of ours called by its ball or contact (E5, B12): it cannot be told
  if (eMassa(ne)) return [...nostri].some(eMassa) ? 1 : 0;
  // the name is on another of our pads, and on that one only: this one is not it (GND, VBUS, VDD stand on many)
  const conQuelNome = pezzo.piazzole.filter((altra) => altra.nomi.some((n) => norma(n) === ne));
  if (conQuelNome.length === 1 && conQuelNome[0] !== q) return -1;
  return 0;
}

interface Adattamento {
  angolo: number;
  t: Punto;
  coppie: Array<{ e: PiazzolaLcsc; q: PiazzolaMontata; d: number }>;
  dentro: number;
  scarto: number;
  nomiSi: number;
  nomiNo: number;
  numeri: number;
}

const vicina = (P: PiazzolaMontata[], p: Punto) => {
  let best = P[0];
  let d = Infinity;
  for (const q of P) {
    const dq = Math.hypot(q.x - p.x, q.y - p.y);
    if (dq < d) {
      d = dq;
      best = q;
    }
  }
  return { q: best, d };
};

/** for each angle: the shift that lays the most LCSC pads on ours, the pairs, the counts */
function adatta(pezzo: PezzoMontato, E: PiazzolaLcsc[], angoli: number[], tol: number): Adattamento[] {
  const P = pezzo.piazzole;
  return angoli.map((a) => {
    const Et = E.map((e) => piazza(a, e, pezzo.faccia));
    let migliore: { dentro: number; somma: number; t: Punto } | null = null;
    // the shifts worth trying: one LCSC pad on one of ours (bounded: a BGA is matched on its first pads)
    for (const et of Et.slice(0, 24)) {
      for (const q of P) {
        const t = { x: q.x - et.x, y: q.y - et.y };
        let dentro = 0;
        let somma = 0;
        for (const ek of Et) {
          const { d } = vicina(P, { x: ek.x + t.x, y: ek.y + t.y });
          if (d <= tol) {
            dentro++;
            somma += d;
          }
        }
        if (!migliore || dentro > migliore.dentro || (dentro === migliore.dentro && somma < migliore.somma)) migliore = { dentro, somma, t };
      }
    }
    let t = migliore?.t ?? { x: 0, y: 0 };
    for (let k = 0; k < 3; k++) {
      let dx = 0;
      let dy = 0;
      let n = 0;
      for (const ek of Et) {
        const { q, d } = vicina(P, { x: ek.x + t.x, y: ek.y + t.y });
        if (d <= tol) {
          dx += q.x - ek.x - t.x;
          dy += q.y - ek.y - t.y;
          n++;
        }
      }
      if (n) t = { x: t.x + dx / n, y: t.y + dy / n };
    }
    const coppie: Adattamento["coppie"] = [];
    let scarto = 0;
    E.forEach((e, i) => {
      const { q, d } = vicina(P, { x: Et[i].x + t.x, y: Et[i].y + t.y });
      if (d <= tol) {
        coppie.push({ e, q, d });
        scarto = Math.max(scarto, d);
      }
    });
    const nomi = coppie.map(({ e, q }) => confronta(pezzo, e, q));
    // the same number, or the same ball or contact (C3, A5) when our pad is called by it
    const numeri = coppie.filter(({ e, q }) => (q.pin !== null && norma(e.num) === String(q.pin)) || (!/^\d+$/.test(e.num) && q.nomi.some((n) => norma(n) === norma(e.num)))).length;
    return { angolo: modulo(a), t, coppie, dentro: coppie.length, scarto, nomiSi: nomi.filter((v) => v === 1).length, nomiNo: nomi.filter((v) => v === -1).length, numeri };
  });
}

/** the rotation: first the geometry, then the function of the pins, then the pad number */
function scegli(pezzo: PezzoMontato, E: PiazzolaLcsc[]): { scelto: Adattamento; pari: Adattamento[]; deciso: "geometria" | "funzione" | "numero" | "indifferente" } | null {
  if (E.length === 0 || pezzo.piazzole.length === 0) return null;
  const angoli = [...new Set([0, 90, 180, 270, ...[0, 1, 2, 3].map((k) => modulo(pezzo.rotazione + 90 * k))])];
  const minimo = Math.min(E.length, pezzo.piazzole.length);
  let es: Adattamento[] = [];
  let top = 0;
  for (const tol of [0.3, 0.5, 0.8, 1.2]) {
    es = adatta(pezzo, E, angoli, tol);
    top = Math.max(...es.map((x) => x.dentro));
    if (top >= minimo) break;
  }
  // fewer than half the pads laid: the LCSC footprint is not this one
  if (top < Math.max(2, Math.ceil(minimo / 2))) return null;
  const pari = es.filter((x) => x.dentro === top).sort((a, b) => a.nomiNo - b.nomiNo || b.nomiSi - a.nomiSi || b.numeri - a.numeri || Math.round(a.scarto * 1000) - Math.round(b.scarto * 1000) || a.angolo - b.angolo);
  const a = pari[0];
  let deciso: "geometria" | "funzione" | "numero" | "indifferente" = "geometria";
  if (pari.length > 1) {
    const b = pari[1];
    if (a.nomiNo < b.nomiNo || (a.nomiNo === b.nomiNo && a.nomiSi > b.nomiSi)) deciso = "funzione";
    else if (a.numeri > b.numeri) deciso = "numero";
    else deciso = "indifferente";
  }
  return { scelto: a, pari, deciso };
}

/** a two-pad part with no LCSC footprint (a resistor, a capacitor): the chip footprint of EasyEDA, pad 1 on the left at 0 degrees */
function chipGenerico(p: PezzoMontato): PiazzolaLcsc[] | null {
  if (p.piazzole.length !== 2 || p.verso) return null;
  const d = Math.hypot(p.piazzole[0].x - p.piazzole[1].x, p.piazzole[0].y - p.piazzole[1].y);
  return [
    { num: "1", nome: "1", x: -d / 2, y: 0, w: 0, h: 0 },
    { num: "2", nome: "2", x: d / 2, y: 0, w: 0, h: 0 },
  ];
}

export interface RigaDiMontaggio extends PnpRow {
  /** what the rotation is taken from */
  riferimento: "lcsc" | "chip generico" | "nostra impronta";
  lcsc: string | null;
  deciso?: string;
}

export interface AvvisoLcsc {
  nome: string;
  lcsc: string;
  forte: boolean;
  messaggio: string;
}

const lato = (layer: unknown): "top" | "bottom" => (String(typeof layer === "object" && layer ? (layer as { name?: unknown }).name : layer) === "bottom" ? "bottom" : "top");
const nomeFunzione = (f: string) => (f === "K" ? "catodo" : f === "A" ? "anodo" : f);

/**
 * THE PICK AND PLACE IN THE CONVENTION, and what the comparison by name with
 * the LCSC footprints says. `impronte`: the footprints read (lcsc-impronte.ts),
 * a code missing from the map was not read and keeps our footprint's angle.
 */
export function montaggio(circuitJson: readonly unknown[], impronte: ReadonlyMap<string, ImprontaLcsc | null>, fileDelProgetto: Record<string, string> = {}): { righe: RigaDiMontaggio[]; avvisi: AvvisoLcsc[] } {
  const pezzi = new Map(pezziMontati(circuitJson, fileDelProgetto).map((p) => [p.nome, p]));
  const avvisi: AvvisoLcsc[] = [];
  // the pick and place library changes the circuit it is handed: it gets copies of what it reads, the board stays as it is
  const perLaLibreria = (circuitJson as El[]).filter((e) => TIPI_DEL_CPL.has(e?.type)).map((e) => structuredClone(e));
  const righe: RigaDiMontaggio[] = righeCpl(perLaLibreria).map((r) => {
    const p = pezzi.get(String(r.designator));
    const faccia = lato(r.layer);
    const nostra = (perche: RigaDiMontaggio["riferimento"]): RigaDiMontaggio => ({
      ...r,
      rotation: faccia === "bottom" ? modulo(-(num(r.rotation) ?? 0)) : modulo(num(r.rotation) ?? 0),
      riferimento: perche,
      lcsc: p?.lcsc ?? null,
    });
    if (!p) return nostra("nostra impronta");
    const impronta = p.lcsc ? impronte.get(p.lcsc) : undefined;
    const E = impronta?.pads ?? chipGenerico(p);
    if (!E) return nostra("nostra impronta");
    // an LCSC footprint of a bidirectional part: its two pins are the same, the numbers decide (as the order of 2026-11-20)
    const bidirezionale = !!impronta && p.verso?.tipo === "diodo" && BI.test(impronta.impronta);
    const s = scegli(bidirezionale ? { ...p, verso: null } : p, E);
    if (!s) {
      if (impronta && p.verso) {
        avvisi.push({ nome: p.nome, lcsc: impronta.codice, forte: true, messaggio: `${p.nome}: le piazzole dell'impronta LCSC ${impronta.codice} (${impronta.impronta}) non combaciano con le nostre: e' un'altra impronta, il verso non si puo' confrontare` });
      }
      return nostra("nostra impronta");
    }
    if (impronta && p.verso) avvisi.push(...(bidirezionale ? [avvisoBidirezionale(p, impronta)] : confrontoPerNome(p, impronta, s)));
    return { ...r, rotation: s.scelto.angolo, riferimento: impronta ? "lcsc" : "chip generico", lcsc: p.lcsc, deciso: s.deciso };
  });
  return { righe, avvisi };
}

/** an LCSC footprint of a bidirectional part: EasyEDA writes it in the package name (X1SON-2_..._BI-1, SOD-882_..._BI) */
const BI = /(^|[-_])BI([-_]|$)/i;

function avvisoBidirezionale(p: PezzoMontato, impronta: ImprontaLcsc): AvvisoLcsc {
  return {
    nome: p.nome,
    lcsc: impronta.codice,
    forte: false,
    messaggio: `${p.nome}: l'impronta LCSC ${impronta.codice} (${impronta.impronta}) e' di un pezzo BIDIREZIONALE: se lo e', scrivi «bidirezionale» nella description e il pezzo non ha verso (il pick and place lo mette per numero)`,
  };
}

/** what the LCSC footprint says of the way round of a part, against ours (point 3 of the obligations) */
function confrontoPerNome(p: PezzoMontato, impronta: ImprontaLcsc, s: NonNullable<ReturnType<typeof scegli>>): AvvisoLcsc[] {
  const out: AvvisoLcsc[] = [];
  const base = { nome: p.nome, lcsc: impronta.codice };
  const v = p.verso!;
  const a = s.scelto;
  // two terminals: one name against is a part the wrong way round; many pins: some names never match (VDD on four
  // pins, VSS against GND), so only more names against than for says the footprint is turned
  if (v.altra ? a.nomiNo > 0 : a.nomiNo >= 3 && a.nomiNo > 2 * a.nomiSi) {
    out.push({
      ...base,
      forte: true,
      messaggio:
        `${p.nome}: i versi sono OPPOSTI all'impronta LCSC ${impronta.codice}: in nessuna rotazione che combacia ` +
        (v.altra ? `il catodo o il + dell'impronta LCSC cade sulla nostra piazzola con lo stesso ruolo` : `i nomi dei pin dell'impronta LCSC cadono sui nostri`) +
        ` (nomi che combaciano ${a.nomiSi}, contro ${a.nomiNo}). Controlla sul datasheet quale piazzola e' ${v.riferimento === "catodo" ? "il catodo" : v.riferimento === "piu" ? "il +" : "il pin 1"} e correggi i nomi dei piedini o l'impronta`,
    });
    return out;
  }
  // the numbering: the rotation the numbers alone would have given, against the one the names gave
  const perNumero = [...s.pari].sort((x, y) => y.numeri - x.numeri)[0];
  if (s.deciso === "funzione" && perNumero !== a && perNumero.nomiNo > 0) {
    const uno = impronta.pads.find((q) => q.num === "1");
    const nostroUno = p.piazzole.find((q) => q.pin === 1);
    const fe = uno ? funzioneLcsc(uno) : null;
    const fn = nostroUno ? ruoloNostro(p, nostroUno) : null;
    out.push({
      ...base,
      forte: false,
      messaggio:
        `${p.nome}: la numerazione delle piazzole e' OPPOSTA a quella dell'impronta LCSC ${impronta.codice}` +
        (fe && fn ? ` (LCSC: piazzola 1 = ${nomeFunzione(fe)}; progetto: piazzola 1 = ${nomeFunzione(fn)})` : "") +
        `: la rotazione del pick and place e' decisa per nome, non per numero, e il pezzo va giusto; controlla che i nomi dei piedini vengano dal datasheet`,
    });
  }
  return out;
}

/**
 * THE INDEPENDENT CHECK of the pick and place: each row read back with the
 * convention, the LCSC pads laid with the row's rotation and the shift that
 * fits best at THAT rotation (found here, not taken from the generator), and
 * for every part with a way round: the LCSC cathode, + or pin 1 must land on
 * our pad with that role. What does not, in words; empty when every row is right.
 */
export function verificaMontaggio(circuitJson: readonly unknown[], righe: readonly RigaDiMontaggio[], impronte: ReadonlyMap<string, ImprontaLcsc | null>, fileDelProgetto: Record<string, string> = {}): string[] {
  const pezzi = new Map(pezziMontati(circuitJson, fileDelProgetto).map((p) => [p.nome, p]));
  const scarti: string[] = [];
  for (const r of righe) {
    if (r.riferimento !== "lcsc" || !r.lcsc) continue;
    const p = pezzi.get(String(r.designator));
    const impronta = impronte.get(r.lcsc);
    if (!p || !impronta || !p.verso?.chiave) continue;
    const faccia = lato(r.layer);
    if (faccia !== p.faccia) {
      scarti.push(`${p.nome}: il pick and place lo mette sul ${faccia}, il progetto sul ${p.faccia}`);
      continue;
    }
    // the tolerance steps of the search, at THIS rotation: the first that lays at least half the pads
    const minimo = Math.min(impronta.pads.length, p.piazzole.length);
    let x = adatta(p, impronta.pads, [Number(r.rotation)], 0.3)[0];
    for (const tol of [0.5, 0.8, 1.2]) {
      if (x.dentro >= minimo) break;
      x = adatta(p, impronta.pads, [Number(r.rotation)], tol)[0];
    }
    if (x.dentro < Math.max(2, Math.ceil(minimo / 2))) {
      scarti.push(`${p.nome}: con la rotazione ${r.rotation} le piazzole LCSC ${impronta.codice} non cadono sulle nostre (${x.dentro} su ${impronta.pads.length})`);
      continue;
    }
    const chiave = p.verso.chiave.centro;
    // a bidirectional part has no way round to check: its rotation is decided by number
    if (p.verso.tipo === "diodo" && BI.test(impronta.impronta)) continue;
    if (p.verso.altra) {
      const ruolo = p.verso.riferimento === "catodo" ? "K" : "+";
      const sua = x.coppie.find(({ e }) => stessaFunzione(funzioneLcsc(e), ruolo));
      if (sua && Math.hypot(sua.q.x - chiave.x, sua.q.y - chiave.y) > 1e-6) {
        scarti.push(`${p.nome}: seguendo il pick and place il ${ruolo === "K" ? "catodo" : "+"} dell'impronta LCSC ${impronta.codice} cade sulla piazzola sbagliata`);
      }
    } else {
      // pin 1 of the LCSC footprint on one of our pins with another name: the part goes on turned
      const uno = x.coppie.find(({ e }) => e.num === "1" || norma(e.nome) === "A1");
      if (uno && confronta(p, uno.e, uno.q) === -1) {
        scarti.push(`${p.nome}: seguendo il pick and place il pin 1 dell'impronta LCSC ${impronta.codice} cade su un pin di un'altra funzione`);
      }
    }
  }
  return scarti;
}

/** the CSV of the rows, with the header JLCPCB reads */
export function csvDiMontaggio(righe: readonly RigaDiMontaggio[]): string {
  const cella = (s: string) => `"${s.replace(/"/g, '""')}"`;
  return ["Designator,Mid X,Mid Y,Layer,Rotation", ...righe.map((r) => [cella(String(r.designator)), Number(r.mid_x).toFixed(3), Number(r.mid_y).toFixed(3), cella(lato(r.layer)), String(modulo(Number(r.rotation)))].join(","))].join("\r\n");
}

/** the polarity of each part in words, against the part next to it: "D3: cathode (K) on the pad toward R18, ..." */
export function polaritaAParole(circuitJson: readonly unknown[], fileDelProgetto: Record<string, string> = {}): string[] {
  const pezzi = pezziMontati(circuitJson, fileDelProgetto);
  const centri = pezzi.map((p) => ({ nome: p.nome, faccia: p.faccia, c: centroDi(p) }));
  const out: string[] = [];
  for (const p of pezzi) {
    const v = p.verso;
    if (!v?.chiave) continue;
    const k = v.chiave.centro;
    const vicino = centri
      .filter((c) => c.nome !== p.nome && c.faccia === p.faccia && c.c)
      .sort((a, b) => Math.hypot(a.c!.x - k.x, a.c!.y - k.y) - Math.hypot(b.c!.x - k.x, b.c!.y - k.y))[0];
    // the corner A1 of a BGA with no ball there (polarita.ts, angoloA1): a place, not a pad
    const angolo = v.chiave.numero === null && v.chiave.nomi.includes("A1 (angolo)");
    const cosa = v.riferimento === "catodo" ? "cathode (K, bar)" : v.riferimento === "piu" ? "+ terminal" : angolo ? "pin 1 corner A1 (dot; the grid has no ball A1)" : "pin 1 (dot)";
    const vista = p.faccia === "bottom" ? "seen from the top (part on the bottom side)" : "seen from the top";
    out.push(
      `${p.nome} (${p.faccia}): ${cosa} ${angolo ? "at" : "on the pad at"} (${k.x.toFixed(2)}; ${k.y.toFixed(2)}) mm, ${vista}` +
        (vicino ? `, the pad nearer to ${vicino.nome}` : "") +
        (v.altra ? `; ${v.riferimento === "catodo" ? "anode" : "- terminal"} on the other pad, at (${v.altra.centro.x.toFixed(2)}; ${v.altra.centro.y.toFixed(2)}) mm` : "") +
        ".",
    );
  }
  return out;
}

function centroDi(p: PezzoMontato): Punto | null {
  if (p.piazzole.length === 0) return null;
  return { x: p.piazzole.reduce((t, q) => t + q.x, 0) / p.piazzole.length, y: p.piazzole.reduce((t, q) => t + q.y, 0) / p.piazzole.length };
}

/** the notes of the assembly: the convention, where each rotation comes from, the polarity in words, the warnings */
export function noteDiMontaggio(circuitJson: readonly unknown[], righe: readonly RigaDiMontaggio[], avvisi: readonly AvvisoLcsc[], progetto: string, fileDelProgetto: Record<string, string> = {}): string {
  const t: string[] = [];
  t.push("ASSEMBLY NOTES");
  t.push(`Project: ${/^[\w.-]{1,80}$/.test(progetto) ? progetto : "-"}`);
  t.push("Written by PCB Studio. All dimensions in millimetres, coordinates of the Gerber files.");
  t.push("");
  t.push("1. PICK AND PLACE");
  t.push(`  ${CONVENZIONE}`);
  const nostre = righe.filter((r) => r.riferimento === "nostra impronta").map((r) => String(r.designator));
  const generici = righe.filter((r) => r.riferimento === "chip generico").map((r) => String(r.designator));
  t.push(`  Rows from the LCSC / EasyEDA footprint of the part code: ${righe.length - nostre.length - generici.length} of ${righe.length}.`);
  if (generici.length > 0) t.push(`  Two-pad parts with no LCSC footprint, as the EasyEDA chip footprint (pad 1 on the left at 0 degrees): ${generici.join(", ")}.`);
  if (nostre.length > 0) t.push(`  Rows from our own footprint (no LCSC footprint for the code): ${nostre.join(", ")}. Orient these by the assembly drawing and the words below.`);
  t.push("");
  t.push("2. ASSEMBLY DRAWINGS");
  t.push("  Assembly_top.svg (seen from the top) and Assembly_bottom.svg (seen from the BOTTOM, mirrored).");
  t.push("  Red dot = pin 1 (contact A1). Bar with K = cathode. + = positive terminal.");
  t.push("");
  t.push("3. POLARITY AND PIN 1 IN WORDS");
  const frasi = polaritaAParole(circuitJson, fileDelProgetto);
  if (frasi.length === 0) t.push("  No part with a polarity or a pin 1.");
  for (const f of frasi) t.push(`  ${f}`);
  const forti = avvisi.filter((a) => a.forte);
  if (forti.length > 0) {
    t.push("");
    t.push("4. TO CHECK BEFORE ASSEMBLY");
    for (const a of forti) t.push(`  ${a.nome} (LCSC ${a.lcsc}): our footprint and the LCSC one do not agree on the polarity. Please ask before placing it.`);
  }
  t.push("");
  return t.join("\n");
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/**
 * THE ASSEMBLY DRAWING OF ONE FACE, as an SVG: the outline of the board, the
 * pads of the parts of that face, their names, and the marks: a red dot at pin
 * 1, a bar with K at the cathode, a + at the + terminal. The bottom is drawn
 * seen from below (mirrored), and says so in its title.
 */
export function disegnoDiMontaggio(circuitJson: readonly unknown[], faccia: "top" | "bottom", progetto: string, fileDelProgetto: Record<string, string> = {}): string {
  const els = circuitJson as El[];
  const board = els.find((e) => e.type === "pcb_board");
  const contorno: Punto[] = Array.isArray(board?.outline) && (board!.outline as unknown[]).length >= 3
    ? (board!.outline as Array<{ x: number; y: number }>).map((q) => ({ x: Number(q.x), y: Number(q.y) }))
    : (() => {
        const w = num(board?.width) ?? 50;
        const h = num(board?.height) ?? 50;
        const c = (board?.center as Punto | undefined) ?? { x: 0, y: 0 };
        return [
          { x: c.x - w / 2, y: c.y - h / 2 },
          { x: c.x + w / 2, y: c.y - h / 2 },
          { x: c.x + w / 2, y: c.y + h / 2 },
          { x: c.x - w / 2, y: c.y + h / 2 },
        ];
      })();
  const sx = faccia === "bottom" ? -1 : 1;
  const xs = contorno.map((q) => q.x * sx);
  const ys = contorno.map((q) => q.y);
  const minX = Math.min(...xs) - 3;
  const maxX = Math.max(...xs) + 3;
  const minY = Math.min(...ys) - 3;
  const maxY = Math.max(...ys) + 3;
  const S = 12; // px per mm
  const W = (maxX - minX) * S;
  const H = (maxY - minY) * S + 70;
  const X = (x: number) => ((x * sx - minX) * S).toFixed(1);
  const Y = (y: number) => ((maxY - y) * S + 40).toFixed(1);
  const parti: string[] = [];
  parti.push(`<polygon points="${contorno.map((q) => `${X(q.x)},${Y(q.y)}`).join(" ")}" fill="#ffffff" stroke="#000" stroke-width="2"/>`);
  for (const el of els) {
    if (el.type !== "pcb_smtpad" && el.type !== "pcb_plated_hole") continue;
    if (el.type === "pcb_smtpad" && el.layer !== faccia) continue;
    const x = num(el.x);
    const y = num(el.y);
    if (x === null || y === null) continue;
    const w = num(el.width) ?? (num(el.radius) ?? (num(el.outer_diameter) ?? 0.5) / 2) * 2;
    const h = num(el.height) ?? w;
    parti.push(`<rect x="${(Number(X(x)) - (w * S) / 2).toFixed(1)}" y="${(Number(Y(y)) - (h * S) / 2).toFixed(1)}" width="${(w * S).toFixed(1)}" height="${(h * S).toFixed(1)}" fill="#c8c8c8"/>`);
  }
  for (const p of pezziMontati(circuitJson, fileDelProgetto)) {
    if (p.faccia !== faccia) continue;
    const c = centroDi(p);
    if (!c) continue;
    parti.push(`<text x="${X(c.x)}" y="${(Number(Y(c.y)) - 6).toFixed(1)}" font-size="11" font-family="Helvetica, Arial, sans-serif" text-anchor="middle" fill="#1a3d8f">${esc(p.nome)}</text>`);
    const v = p.verso;
    if (!v?.chiave) continue;
    const k = v.chiave.centro;
    if (v.riferimento === "pin1") {
      parti.push(`<circle cx="${X(k.x)}" cy="${Y(k.y)}" r="4" fill="#e00000"/>`);
    } else if (v.riferimento === "catodo" && v.altra) {
      // the bar just past the cathode, across the line between the two pads
      const ux = k.x - v.altra.centro.x;
      const uy = k.y - v.altra.centro.y;
      const l = Math.hypot(ux, uy) || 1;
      const bx = k.x + (ux / l) * 0.55;
      const by = k.y + (uy / l) * 0.55;
      const nx = -uy / l;
      const ny = ux / l;
      parti.push(`<line x1="${X(bx - nx * 0.5)}" y1="${Y(by - ny * 0.5)}" x2="${X(bx + nx * 0.5)}" y2="${Y(by + ny * 0.5)}" stroke="#e00000" stroke-width="3"/>`);
      parti.push(`<text x="${X(bx + (ux / l) * 0.6)}" y="${(Number(Y(by + (uy / l) * 0.6)) + 4).toFixed(1)}" font-size="11" font-weight="700" font-family="Helvetica, Arial, sans-serif" text-anchor="middle" fill="#e00000">K</text>`);
    } else if (v.altra) {
      const ux = k.x - v.altra.centro.x;
      const uy = k.y - v.altra.centro.y;
      const l = Math.hypot(ux, uy) || 1;
      parti.push(`<text x="${X(k.x + (ux / l) * 0.8)}" y="${(Number(Y(k.y + (uy / l) * 0.8)) + 5).toFixed(1)}" font-size="15" font-weight="700" font-family="Helvetica, Arial, sans-serif" text-anchor="middle" fill="#e00000">+</text>`);
    }
  }
  const titolo = faccia === "top" ? "TOP side, seen from the top" : "BOTTOM side, seen from the BOTTOM (mirrored)";
  const legenda = "Red dot = pin 1 (contact A1)    Bar with K = cathode    + = positive terminal";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W.toFixed(0)}" height="${H.toFixed(0)}" viewBox="0 0 ${W.toFixed(0)} ${H.toFixed(0)}">` +
    `<rect width="100%" height="100%" fill="#ffffff"/>` +
    `<text x="10" y="24" font-size="16" font-weight="700" font-family="Helvetica, Arial, sans-serif">${esc(`${/^[\w.-]{1,80}$/.test(progetto) ? progetto : "-"}: assembly drawing, ${titolo}`)}</text>` +
    parti.join("") +
    `<text x="10" y="${(H - 12).toFixed(0)}" font-size="13" font-family="Helvetica, Arial, sans-serif">${esc(legenda)}</text>` +
    `</svg>`
  );
}

/** what the export says of a board whose pick and place does not pass its own check (see nonCertificata) */
export function montaggioDaCertificare(scarti: readonly string[]): { count: number; detail: string } | null {
  if (scarti.length === 0) return null;
  return { count: scarti.length, detail: `il pick and place non passa la sua verifica: ${scarti.slice(0, 6).join("; ")}${scarti.length > 6 ? ` e altri ${scarti.length - 6}` : ""}` };
}

