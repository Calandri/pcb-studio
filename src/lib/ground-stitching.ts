/**
 * THE STITCHING OF THE GROUND ("cuci la massa").
 *
 * Niccolo', 12/11/2026, looking at a board: "I pour di massa hanno pochi via:
 * puoi fare una funzione che riempie la massa di via distanziati tra loro come
 * best practice, da 0,2?". Until the day before his rule was "mai vie messe da
 * una regola" (2026-11-09, "togli ogni AUTO"): this is the exception HE asks
 * for, and it stays an EXPLICIT action. No compile calls it. It is launched by
 * the stitch_ground tool (agent and MCP) and by the "Cuci la massa" command of
 * the viewer, which write the vias into a file of the project
 * (cucitura-massa.tsx, see ground-stitching-file.ts) and start no compile.
 *
 * THE PRACTICE (guides of fabs and tools, not standards: atlaspcb.com
 * "pcb-ground-plane-stitching-via", aivon.com "fr4-pcb-stitching-vias-when-and-
 * where-to-use-them", allpcb.com "minimum-drill-size-and-via-stitching-
 * grounding-techniques-for-emc-compliance", flux.ai "via-stitching-pcb-guide"):
 * - the largest gap between stitching vias is a twentieth of the wavelength at
 *   the highest frequency that matters, the wavelength IN THE MATERIAL:
 *   lambda = c / (f x sqrt(er)). FR4 (er about 4.3): about 2.7 mm at 2.7 GHz
 *   (the highest LTE band), about 4.6 mm at 1.575 GHz (GNSS);
 * - the value the guides give as "safe for the fab": a grid of about 3 mm, a
 *   row along the edge at 5-10 mm (closer when needed), regular or staggered,
 *   no clumps.
 * So the default pitch is 2.5 mm (lambda / 20 up to about 2.9 GHz in FR4),
 * changeable; the via is a 0.2 mm drill with a 0.5 mm ring, never below the
 * minimums of design-rules.json.
 *
 * WHERE A VIA MAY STAND, all of these together (each failure is counted under
 * its reason, see MOTIVI):
 * - inside the board outline and out of its cutouts, its ring at least
 *   minBoardEdgeClearanceMm from the edge;
 * - out of the excluded zones of the call and out of the board's keepouts;
 * - ground copper (the pours of the ground net) covers the WHOLE ring on at
 *   least two layers, otherwise it stitches nothing;
 * - on EVERY layer that has ground pours at all, outer or inner, the ground
 *   pour is there: the zones a project keeps without copper (antennas, crystals,
 *   acoustic ports, windows), the cutouts of a pour and the gaps between pours
 *   stay so on every layer, without having to be known. A via through a void of
 *   an inner plane, with ground above and below, would put a barrel and a hole
 *   where the copper was taken away on purpose;
 * - out of the footprint of every part on both faces (ingombro.ts: declared or
 *   computed) and out of every connector's mating space;
 * - from every pad (ground ones too: never a via in a pad) at least the pad-via
 *   distance of the project, from pads of other nets at least the pour's;
 * - drill to drill at least minHoleToHoleMm from every via, plated hole and
 *   bare hole, its ring as far from a bare hole as from the board edge;
 * - on EVERY layer (the via is a through hole) the disc "ring + the pour's
 *   clearance" (pourClearanceMm of the project, or the clearance the ground pour
 *   there declares for itself, see DISTANZA_PROPRIA) touches no copper of
 *   another net: traces, pads, vias, pours; never below the pair rules of the
 *   project (clearanceByPairMm), which the DRC holds the board to;
 * - from the traces of other nets `distanzaPisteMm` when given, and from the
 *   copper of the nets in `retiLontane` their own distance: there is no way to
 *   recognise a controlled impedance line for sure (a ground via next to a
 *   coplanar line changes its impedance), so whoever launches the tool names
 *   the radio nets or draws the zones;
 * - its hole at least the project's silkscreen clearance (minSilkscreenClearanceMm)
 *   from every stroke, text and filled drawing of the silkscreen, on both faces
 *   (the hole goes through both): a hole under a designator drills it away, and
 *   the silkscreen check of the compile (silkscreen-clearance.ts) would list
 *   every one of them;
 * - not within half a pitch of a ground via that is already there (it already
 *   stitches that spot), and not nearer to another proposed via than half the
 *   pitch (no clumps).
 * The distances are the DRC's own pieces (drc.ts: rameDelPad, rameDelForo,
 * foroDi, distanzaPuntoForma; design-rules.ts: distanzaMinimaFra), measured
 * from the copper of each thing, not from its box.
 *
 * GROUND ISLANDS: the pieces of ground pour that are not connected to the rest
 * (through pours, vias, pads, plated holes and traces of the net) get a via
 * FIRST, where one fits and reaches the main plane on another layer; the ones
 * where none fits are listed with their area and the reason.
 *
 * Pure and deterministic: the same board and options give the same vias in the
 * same order. The input is never changed.
 */

import { distanzaPuntoForma, foroDi, ingombroForma, pointSegDistance, rameDelForo, rameDelPad, TOLLERANZA_MM, type Capsula, type FormaRame } from "./drc";
import { distanzaDellaSerigrafia, distanzaMinimaFra, eccedenzaDellIngombro, MAX_POUR_CLEARANCE_MM, type DesignRules } from "./design-rules";
import { distanzaRiquadri, forma as formaDi, leggiIngombri, misuraForme, TOLLERANZA_INGOMBRI_MM, type Forma } from "./ingombro";
import { eMassa } from "./net-roles";
import { dSS } from "./pour-pour";
import { distanzaPropria } from "./pours";
import { disegnoStampato } from "./silkscreen-clearance";
import { stratiDiRame } from "./via-layers";

/** an element of the Circuit JSON, as drc.ts reads it */
type El = { type: string; [key: string]: unknown };
export type Punto = { x: number; y: number };

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

// ---------------------------------------------------------------------------
// The numbers: the practice above, and the limits of what a call may ask
// ---------------------------------------------------------------------------

/** lambda / 20 up to about 2.9 GHz in FR4: see the top of this file */
export const PASSO_DI_SERIE_MM = 2.5;
export const PASSO_MIN_MM = 1;
export const PASSO_MAX_MM = 10;
/** Niccolo': "da 0,2" */
export const FORO_DI_SERIE_MM = 0.2;
/** the ring the boards of 3Bee use with a 0.2 drill (pcbStyle viaPadDiameter 0.5) */
export const CORONA_DI_SERIE_MM = 0.5;
export const FORO_MIN_MM = 0.1;
export const FORO_MAX_MM = 1;
export const CORONA_MIN_MM = 0.2;
export const CORONA_MAX_MM = 2;
/** at least five hundredths of copper around the hole per side, as clampRules asks of the project's vias */
const ANELLO_MINIMO_MM = 0.1;
export const MAX_VIE_DI_SERIE = 1500;
/** a cap above which the file is no longer something a person reviews: 3000 lines of vias */
export const MAX_VIE_LIMITE = 3000;
export const MAX_ZONE = 50;
export const MAX_PUNTI_ZONA = 200;
export const MAX_RETI_LONTANE = 20;
/** coordinates beyond a metre are not a board */
const COORD_MAX_MM = 1000;
/** the relative permittivity of FR4 the guides use for the wavelength in the board */
export const ER_FR4 = 4.3;
const LUCE_M_S = 299_792_458;

/** the highest frequency (GHz) at which a gap of `passoMm` is still lambda / 20 in FR4 */
export function frequenzaCoperta(passoMm: number): number {
  return LUCE_M_S / (20 * (passoMm / 1000) * Math.sqrt(ER_FR4)) / 1e9;
}

// ---------------------------------------------------------------------------
// What a call asks
// ---------------------------------------------------------------------------

export type ZonaEsclusa = { x: number; y: number; w: number; h: number } | { punti: Punto[] };

export interface OpzioniCucitura {
  /** the net to stitch, by name or source_net_id; missing: the ground net (see sceltaDellaRete) */
  rete?: string;
  passoMm?: number;
  /** staggered: a triangular lattice, every via with its six neighbours one pitch away; else square */
  sfalsata?: boolean;
  /** a row of vias along the board outline */
  bordo?: boolean;
  passoBordoMm?: number;
  foroMm?: number;
  coronaMm?: number;
  maxVie?: number;
  /** from the traces of other nets; missing: the pour's clearance */
  distanzaPisteMm?: number;
  zoneEscluse?: ZonaEsclusa[];
  /** nets to keep farther from (the radio lines), by name, with their distance */
  retiLontane?: Array<{ rete: string; distanzaMm: number }>;
}

/** a name a message may repeat: a short identifier, nothing else of what was sent */
const NOME_SICURO = /^[A-Za-z0-9_+.\-]{1,60}$/;

export type LetturaOpzioni = { opzioni: OpzioniCucitura; apply: boolean } | { errori: string[] };

const CAMPI = [
  "rete", "passoMm", "sfalsata", "bordo", "passoBordoMm", "foroMm", "coronaMm", "maxVie",
  "distanzaPisteMm", "zoneEscluse", "retiLontane", "dryRun", "apply",
] as const;

/**
 * The options of a call as the tool receives them (any JSON), checked whole:
 * a field unknown, of the wrong type or out of its limits refuses the call with
 * every reason, and nothing of what was sent goes back but short identifiers
 * and numbers. `ignora`: fields the caller handles itself (projectId).
 */
export function leggiOpzioniCucitura(args: unknown, ignora: readonly string[] = []): LetturaOpzioni {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return { errori: ["serve un oggetto di parametri"] };
  const a = args as Record<string, unknown>;
  const errori: string[] = [];
  for (const k of Object.keys(a)) {
    if (!(CAMPI as readonly string[]).includes(k) && !ignora.includes(k)) {
      errori.push(`${/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(k) ? k : "un campo dal nome non valido"}: campo sconosciuto (ammessi ${CAMPI.join(", ")})`);
    }
  }
  const opzioni: OpzioniCucitura = {};
  const numero = (k: keyof OpzioniCucitura, min: number, max: number, intero = false): void => {
    const v = a[k];
    if (v === undefined) return;
    if (typeof v !== "number" || !Number.isFinite(v)) errori.push(`${k}: deve essere un numero (limiti ${min}..${max})`);
    else if (v < min || v > max) errori.push(`${k}: ${v} fuori dai limiti ${min}..${max}`);
    else if (intero && !Number.isInteger(v)) errori.push(`${k}: deve essere un intero`);
    else (opzioni as Record<string, unknown>)[k] = v;
  };
  const vero = (k: string): boolean | undefined => {
    const v = a[k];
    if (v === undefined) return undefined;
    if (typeof v !== "boolean") {
      errori.push(`${k}: deve essere true o false`);
      return undefined;
    }
    return v;
  };
  if (a.rete !== undefined) {
    if (typeof a.rete !== "string" || !NOME_SICURO.test(a.rete)) errori.push("rete: un nome di rete (lettere, cifre, _ + . -, al massimo 60)");
    else opzioni.rete = a.rete;
  }
  numero("passoMm", PASSO_MIN_MM, PASSO_MAX_MM);
  numero("passoBordoMm", PASSO_MIN_MM, PASSO_MAX_MM);
  numero("foroMm", FORO_MIN_MM, FORO_MAX_MM);
  numero("coronaMm", CORONA_MIN_MM, CORONA_MAX_MM);
  numero("maxVie", 1, MAX_VIE_LIMITE, true);
  numero("distanzaPisteMm", 0.05, MAX_POUR_CLEARANCE_MM);
  const sfalsata = vero("sfalsata");
  if (sfalsata !== undefined) opzioni.sfalsata = sfalsata;
  const bordo = vero("bordo");
  if (bordo !== undefined) opzioni.bordo = bordo;
  const coord = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= COORD_MAX_MM;
  if (a.zoneEscluse !== undefined) {
    if (!Array.isArray(a.zoneEscluse) || a.zoneEscluse.length > MAX_ZONE) errori.push(`zoneEscluse: un elenco di al massimo ${MAX_ZONE} zone`);
    else {
      const zone: ZonaEsclusa[] = [];
      a.zoneEscluse.forEach((z: unknown, i: number) => {
        const o = (typeof z === "object" && z !== null ? z : {}) as Record<string, unknown>;
        if (Array.isArray(o.punti)) {
          const punti = o.punti as Array<{ x?: unknown; y?: unknown }>;
          if (punti.length < 3 || punti.length > MAX_PUNTI_ZONA || !punti.every((p) => coord(p?.x) && coord(p?.y))) {
            errori.push(`zoneEscluse[${i}]: un poligono di 3..${MAX_PUNTI_ZONA} punti {x, y} in mm`);
          } else zone.push({ punti: punti.map((p) => ({ x: p.x as number, y: p.y as number })) });
        } else if (coord(o.x) && coord(o.y) && coord(o.w) && coord(o.h) && (o.w as number) > 0 && (o.h as number) > 0) {
          zone.push({ x: o.x as number, y: o.y as number, w: o.w as number, h: o.h as number });
        } else errori.push(`zoneEscluse[${i}]: un rettangolo {x, y, w, h} (centro e misure in mm) o un poligono {punti}`);
      });
      opzioni.zoneEscluse = zone;
    }
  }
  if (a.retiLontane !== undefined) {
    if (!Array.isArray(a.retiLontane) || a.retiLontane.length > MAX_RETI_LONTANE) errori.push(`retiLontane: un elenco di al massimo ${MAX_RETI_LONTANE} reti`);
    else {
      const reti: Array<{ rete: string; distanzaMm: number }> = [];
      a.retiLontane.forEach((r: unknown, i: number) => {
        const o = (typeof r === "object" && r !== null ? r : {}) as Record<string, unknown>;
        const d = o.distanzaMm;
        if (typeof o.rete !== "string" || !NOME_SICURO.test(o.rete) || typeof d !== "number" || !Number.isFinite(d) || d < 0 || d > MAX_POUR_CLEARANCE_MM) {
          errori.push(`retiLontane[${i}]: {rete: nome della rete, distanzaMm: 0..${MAX_POUR_CLEARANCE_MM}}`);
        } else reti.push({ rete: o.rete, distanzaMm: d });
      });
      opzioni.retiLontane = reti;
    }
  }
  const dryRun = vero("dryRun");
  const apply = vero("apply") ?? false;
  if (apply && dryRun === true) errori.push("dryRun e apply insieme: dryRun true guarda soltanto, apply true scrive il file");
  if (errori.length > 0) return { errori };
  return { opzioni, apply };
}

// ---------------------------------------------------------------------------
// What comes back
// ---------------------------------------------------------------------------

/** why a position was refused, in the order the checks run */
export const MOTIVI = {
  fuori_scheda: "fuori dal contorno della scheda o in un suo ritaglio",
  bordo: "troppo vicina al bordo della scheda (minBoardEdgeClearanceMm)",
  zona_esclusa: "in una zona esclusa dalla chiamata",
  zona_vietata: "in una zona vietata della scheda (keepout)",
  massa_su_meno_di_due_strati: "la massa copre tutta la corona su meno di due strati",
  manca_massa_esterna: "su uno strato esterno con colate di massa qui la massa non c'e' (zona senza rame)",
  manca_massa_interna: "su uno strato interno con colate di massa qui la massa non c'e' (zona senza rame, ritaglio della colata)",
  ingombro: "dentro l'ingombro di un pezzo",
  innesto: "dentro lo spazio di innesto di un connettore",
  piazzola: "troppo vicina a una piazzola (di qualunque rete)",
  foro: "troppo vicina a un foro (fra i fori, o la corona da un foro nudo)",
  via_esistente: "troppo vicina a una via esistente (fori o corone)",
  pista_altra_rete: "troppo vicina a una pista di un'altra rete",
  colata_altra_rete: "troppo vicina a una colata di un'altra rete",
  rete_lontana: "troppo vicina a una rete da cui stare lontano (retiLontane)",
  serigrafia: "il foro finirebbe sotto la serigrafia, o piu' vicino di minSilkscreenClearanceMm a una scritta o a un disegno",
  gia_cucita: "una via di massa esistente a meno di mezzo passo cuce gia' quel punto",
  vicina_a_cucitura: "troppo vicina a un'altra via di cucitura proposta (niente grumi)",
  non_raggiunge_il_piano: "sotto l'isola non c'e' la massa principale su un altro strato",
  tetto: "oltre il tetto di vie (maxVie)",
} as const;
export type MotivoScarto = keyof typeof MOTIVI;

export type TipoVia = "isola" | "bordo" | "griglia";

export interface IsolaDiMassa {
  strato: string;
  areaMm2: number;
  /** a point of the island, to find it on the board */
  x: number;
  y: number;
}

export interface EsitoCucitura {
  ok: true;
  rete: { id: string; nome: string };
  /** the via written, after the project's minimums */
  via: { foroMm: number; coronaMm: number };
  passoMm: number;
  sfalsata: boolean;
  bordo: { attiva: boolean; passoMm: number };
  /** the highest frequency at which the pitch is still lambda / 20 in FR4 */
  copreFinoGHz: number;
  /** the vias proposed, islands first, then the edge row, then the grid */
  vie: Array<{ x: number; y: number; tipo: TipoVia }>;
  conteggio: Record<TipoVia, number>;
  /** the positions tried (islands, edge, grid) and why the refused ones were */
  posizioniProvate: number;
  scarti: Partial<Record<MotivoScarto, number>>;
  isole: {
    trovate: number;
    collegate: IsolaDiMassa[];
    senzaPosto: Array<IsolaDiMassa & { motivo: MotivoScarto }>;
  };
  tetto: { maxVie: number; raggiunto: boolean };
  avvisi: string[];
  tempoMs: number;
}

export interface CucituraNonFatta {
  ok: false;
  errore: string;
  /** the nets with pours, when the choice of the net is what failed */
  candidate?: Array<{ nome: string; areaMm2: number; strati: string[] }>;
}

// ---------------------------------------------------------------------------
// Geometry: rings, pours, a grid of cells
// ---------------------------------------------------------------------------

/** a ring split in runs of edges with their box: inside and near ask only the runs that can answer */
interface Anello {
  xs: Float64Array;
  ys: Float64Array;
  n: number;
  corse: Array<{ i0: number; i1: number; minX: number; maxX: number; minY: number; maxY: number }>;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}
const CORSA = 16;

function anelloDi(punti: Punto[]): Anello {
  const n = punti.length;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  punti.forEach((p, i) => {
    xs[i] = p.x;
    ys[i] = p.y;
  });
  const corse: Anello["corse"] = [];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i0 = 0; i0 < n; i0 += CORSA) {
    const i1 = Math.min(n, i0 + CORSA);
    let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
    // edge k goes from vertex k to vertex k + 1: the run's box holds both ends of each
    for (let k = i0; k <= i1; k++) {
      const x = xs[k % n], y = ys[k % n];
      if (x < a) a = x;
      if (x > b) b = x;
      if (y < c) c = y;
      if (y > d) d = y;
    }
    corse.push({ i0, i1, minX: a, maxX: b, minY: c, maxY: d });
    if (a < minX) minX = a;
    if (b > maxX) maxX = b;
    if (c < minY) minY = c;
    if (d > maxY) maxY = d;
  }
  return { xs, ys, n, corse, minX, maxX, minY, maxY };
}

/** inside the ring: the ray goes right, and meets only the runs that reach past the point */
function dentroAnello(a: Anello, x: number, y: number): boolean {
  if (x < a.minX || x > a.maxX || y < a.minY || y > a.maxY) return false;
  let dentro = false;
  for (const c of a.corse) {
    if (y < c.minY || y > c.maxY || x > c.maxX) continue;
    for (let k = c.i0; k < c.i1; k++) {
      const j = k + 1 === a.n ? 0 : k + 1;
      const py = a.ys[k], qy = a.ys[j];
      if (py > y === qy > y) continue;
      const px = a.xs[k], qx = a.xs[j];
      if (x < ((qx - px) * (y - py)) / (qy - py) + px) dentro = !dentro;
    }
  }
  return dentro;
}

/** an edge of the ring nearer than r to the point */
function vicinoAdAnello(a: Anello, x: number, y: number, r: number): boolean {
  if (x < a.minX - r || x > a.maxX + r || y < a.minY - r || y > a.maxY + r) return false;
  for (const c of a.corse) {
    if (x < c.minX - r || x > c.maxX + r || y < c.minY - r || y > c.maxY + r) continue;
    for (let k = c.i0; k < c.i1; k++) {
      const j = k + 1 === a.n ? 0 : k + 1;
      if (pointSegDistance(x, y, a.xs[k], a.ys[k], a.xs[j], a.ys[j]) < r) return true;
    }
  }
  return false;
}

const areaDi = (punti: Punto[]): number => {
  let s = 0;
  for (let i = 0, j = punti.length - 1; i < punti.length; j = i++) s += (punti[j].x + punti[i].x) * (punti[j].y - punti[i].y);
  return Math.abs(s / 2);
};

interface Colata {
  indice: number;
  id: string;
  /** the connectivity group of its net */
  gruppo: string;
  layer: string;
  /** what it keeps from the other nets: its own (DISTANZA_PROPRIA) or the project's */
  distanza: number;
  esterno: Anello;
  buchi: Anello[];
  areaMm2: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** the point is on the copper of the pour */
function nelRame(c: Colata, x: number, y: number): boolean {
  if (x < c.minX || x > c.maxX || y < c.minY || y > c.maxY) return false;
  if (!dentroAnello(c.esterno, x, y)) return false;
  for (const b of c.buchi) if (dentroAnello(b, x, y)) return false;
  return true;
}

/** the copper of the pour covers the whole disc */
function copreDisco(c: Colata, x: number, y: number, r: number): boolean {
  if (!nelRame(c, x, y)) return false;
  if (vicinoAdAnello(c.esterno, x, y, r)) return false;
  for (const b of c.buchi) if (vicinoAdAnello(b, x, y, r)) return false;
  return true;
}

/** the copper of the pour comes nearer than r to the point */
function toccaDisco(c: Colata, x: number, y: number, r: number): boolean {
  if (x < c.minX - r || x > c.maxX + r || y < c.minY - r || y > c.maxY + r) return false;
  if (nelRame(c, x, y)) return true;
  if (vicinoAdAnello(c.esterno, x, y, r)) return true;
  for (const b of c.buchi) if (vicinoAdAnello(b, x, y, r)) return true;
  return false;
}

/** a uniform grid of cells holding indices by box: the questions look only at the cells near the point */
class Celle {
  private readonly celle = new Map<number, number[]>();
  private visto: Int32Array = new Int32Array(0);
  private giro = 0;
  constructor(private readonly passo: number) {}
  private chiave(i: number, j: number): number {
    return (i + 32768) * 65536 + (j + 32768);
  }
  metti(k: number, minX: number, minY: number, maxX: number, maxY: number): void {
    if (k >= this.visto.length) {
      const v = new Int32Array(Math.max(64, (k + 1) * 2));
      v.set(this.visto);
      this.visto = v;
    }
    const i0 = Math.floor(minX / this.passo), i1 = Math.floor(maxX / this.passo);
    const j0 = Math.floor(minY / this.passo), j1 = Math.floor(maxY / this.passo);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const key = this.chiave(i, j);
        const l = this.celle.get(key);
        if (l) l.push(k);
        else this.celle.set(key, [k]);
      }
    }
  }
  /** every index whose box comes within r of the point, once; the visit returns true to stop */
  cerca(x: number, y: number, r: number, visita: (k: number) => boolean | void): void {
    const giro = ++this.giro;
    const i0 = Math.floor((x - r) / this.passo), i1 = Math.floor((x + r) / this.passo);
    const j0 = Math.floor((y - r) / this.passo), j1 = Math.floor((y + r) / this.passo);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const l = this.celle.get(this.chiave(i, j));
        if (!l) continue;
        for (const k of l) {
          if (this.visto[k] === giro) continue;
          this.visto[k] = giro;
          if (visita(k) === true) return;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The nets: every piece of copper by its connectivity group
// ---------------------------------------------------------------------------

/**
 * Which group each thing belongs to, in the one dialect the board's own keys
 * share: a source_net and the traces and ports joined to it carry the same
 * subcircuit_connectivity_map_key. Copper we or the router lay speaks others
 * (`net:<id>`, `source_net_3_mst0`, a port id), brought back as drc.ts does.
 */
function gruppi(cj: El[]) {
  const chiaveDiRete = new Map<string, string>();
  const reteDiChiave = new Map<string, string>();
  const nomeDiRete = new Map<string, string>();
  for (const el of cj) {
    if (el.type !== "source_net" || !el.source_net_id) continue;
    const id = String(el.source_net_id);
    const k = String(el.subcircuit_connectivity_map_key ?? "") || `net:${id}`;
    chiaveDiRete.set(id, k);
    reteDiChiave.set(k, id);
    nomeDiRete.set(id, String(el.name ?? id));
  }
  const diPortaSorgente = new Map<string, string>();
  for (const el of cj) {
    if (el.type === "source_port" && el.source_port_id && el.subcircuit_connectivity_map_key) {
      diPortaSorgente.set(String(el.source_port_id), String(el.subcircuit_connectivity_map_key));
    }
  }
  const diTracciaSorgente = new Map<string, string>();
  for (const el of cj) {
    if (el.type !== "source_trace" || !el.source_trace_id) continue;
    const k = String(el.subcircuit_connectivity_map_key ?? "");
    const rete = ((el.connected_source_net_ids as unknown[] | undefined) ?? []).map(String)[0];
    const g = k || (rete ? chiaveDiRete.get(rete) : undefined);
    if (g) diTracciaSorgente.set(String(el.source_trace_id), g);
    // a port joined by a trace is in the trace's group, even when the port carries no key
    for (const p of ((el.connected_source_port_ids as unknown[] | undefined) ?? []).map(String)) {
      if (g && !diPortaSorgente.has(p)) diPortaSorgente.set(p, g);
    }
  }
  const diPortaPcb = new Map<string, string>();
  for (const el of cj) {
    if (el.type !== "pcb_port" || !el.pcb_port_id) continue;
    const g = diPortaSorgente.get(String(el.source_port_id ?? ""));
    if (g) diPortaPcb.set(String(el.pcb_port_id), g);
  }
  const risolvi = (k: string): string | null => {
    if (!k) return null;
    if (reteDiChiave.has(k)) return k;
    if (k.startsWith("net:")) return chiaveDiRete.get(k.slice(4)) ?? k;
    const mst = /^(source_net_\d+)_mst/.exec(k)?.[1];
    if (mst) return chiaveDiRete.get(mst) ?? k;
    return diPortaSorgente.get(k) ?? k;
  };
  return {
    chiaveDiRete,
    nomeDiRete,
    pad: (el: El): string | null => diPortaPcb.get(String(el.pcb_port_id ?? "")) ?? null,
    traccia: (el: El): string | null =>
      diTracciaSorgente.get(String(el.source_trace_id ?? "")) ?? risolvi(String(el.subcircuit_connectivity_map_key ?? "")),
    via: (el: El): string | null =>
      risolvi(String(el.subcircuit_connectivity_map_key ?? "")) ?? diPortaPcb.get(String(el.pcb_port_id ?? "")) ?? null,
    colata: (el: El): string => {
      const id = String(el.source_net_id ?? "");
      return chiaveDiRete.get(id) ?? `net:${id}`;
    },
  };
}

/**
 * THE NET TO STITCH, never guessed. Asked by name or id: that one, when it has
 * pours. Otherwise the ground: the net called GND, when it is also the one with
 * the most poured copper; with no GND, the only ground-named net (eMassa) with
 * pours, when it is also the one with the most. Anything else is ambiguous and
 * said, with the candidates.
 */
export function sceltaDellaRete(
  circuitJson: unknown[],
  richiesta?: string,
): { id: string; nome: string } | CucituraNonFatta {
  const cj = circuitJson as El[];
  const nomi = new Map<string, string>();
  for (const el of cj) if (el.type === "source_net" && el.source_net_id) nomi.set(String(el.source_net_id), String(el.name ?? el.source_net_id));
  const area = new Map<string, number>();
  const strati = new Map<string, Set<string>>();
  for (const el of cj) {
    if (el.type !== "pcb_copper_pour") continue;
    const id = String(el.source_net_id ?? "");
    if (!id) continue;
    const v = ((el.brep_shape as { outer_ring?: { vertices?: Punto[] } } | undefined)?.outer_ring?.vertices ?? []).filter(
      (p) => num(p?.x) !== null && num(p?.y) !== null,
    );
    area.set(id, (area.get(id) ?? 0) + (v.length >= 3 ? areaDi(v) : 0));
    const s = strati.get(id) ?? new Set<string>();
    s.add(String(el.layer ?? ""));
    strati.set(id, s);
  }
  const candidate = [...area.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 8)
    .map(([id, a]) => ({ nome: nomi.get(id) ?? id, areaMm2: Number(a.toFixed(1)), strati: [...(strati.get(id) ?? [])].sort() }));
  if (area.size === 0) return { ok: false, errore: "sulla scheda salvata non c'e' nessuna colata: non c'e' massa da cucire" };
  if (richiesta !== undefined) {
    const id = [...nomi.entries()].find(([k, n]) => n === richiesta || k === richiesta)?.[0];
    if (!id) return { ok: false, errore: `la rete ${richiesta} non c'e' sulla scheda salvata`, candidate };
    if (!area.has(id)) return { ok: false, errore: `la rete ${richiesta} non ha colate: non c'e' massa da cucire`, candidate };
    return { id, nome: nomi.get(id) ?? id };
  }
  const piuGrande = [...area.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
  const gnd = [...area.keys()].filter((id) => (nomi.get(id) ?? "").toUpperCase() === "GND");
  if (gnd.length === 1) {
    if (gnd[0] === piuGrande) return { id: gnd[0], nome: nomi.get(gnd[0]) ?? gnd[0] };
    return {
      ok: false,
      errore: `rete di massa ambigua: GND non e' la rete con le colate piu' grandi (${nomi.get(piuGrande) ?? piuGrande}); indica rete`,
      candidate,
    };
  }
  const masse = [...area.keys()].filter((id) => eMassa(nomi.get(id)));
  if (masse.length === 1 && masse[0] === piuGrande) return { id: masse[0], nome: nomi.get(masse[0]) ?? masse[0] };
  return {
    ok: false,
    errore:
      masse.length === 0
        ? "nessuna rete di massa con colate (GND, AGND, VSS...): indica rete"
        : "rete di massa ambigua: indica rete",
    candidate,
  };
}

// ---------------------------------------------------------------------------
// The obstacles
// ---------------------------------------------------------------------------

type Ostacolo =
  /** a trace segment on one layer */
  | { k: "pista"; ax: number; ay: number; bx: number; by: number; mezza: number; layer: string | null; gruppo: string | null }
  /** an SMT pad (one layer) or a plated hole (every layer, with its drill) */
  | { k: "piazzola"; forma: FormaRame; layer: string | null; gruppo: string | null; foro?: Capsula }
  /** a via of the board, every layer */
  | { k: "via"; x: number; y: number; r: number; foro: number; gruppo: string | null }
  /** a bare hole */
  | { k: "nudo"; foro: Capsula };

function scatolaDi(o: Ostacolo): [number, number, number, number] {
  switch (o.k) {
    case "pista":
      return [Math.min(o.ax, o.bx) - o.mezza, Math.min(o.ay, o.by) - o.mezza, Math.max(o.ax, o.bx) + o.mezza, Math.max(o.ay, o.by) + o.mezza];
    case "piazzola": {
      const f = o.forma;
      if (f.tipo === "cerchio") return [f.x - f.r, f.y - f.r, f.x + f.r, f.y + f.r];
      if (f.tipo === "capsula") {
        const c = f.capsula;
        return [Math.min(c.ax, c.bx) - c.r, Math.min(c.ay, c.by) - c.r, Math.max(c.ax, c.bx) + c.r, Math.max(c.ay, c.by) + c.r];
      }
      const m = Math.hypot(f.w, f.h) / 2;
      return [f.x - m, f.y - m, f.x + m, f.y + m];
    }
    case "via":
      return [o.x - o.r, o.y - o.r, o.x + o.r, o.y + o.r];
    case "nudo": {
      const c = o.foro;
      return [Math.min(c.ax, c.bx) - c.r, Math.min(c.ay, c.by) - c.r, Math.max(c.ax, c.bx) + c.r, Math.max(c.ay, c.by) + c.r];
    }
  }
}

/** the polygon of a keepout or a cutout, or its circle */
function sagomaDiZona(el: El): { punti: Punto[] } | { x: number; y: number; r: number } | null {
  const c = el.center as { x?: unknown; y?: unknown } | undefined;
  const cx = num(c?.x) ?? num(el.x);
  const cy = num(c?.y) ?? num(el.y);
  const shape = String(el.shape ?? "");
  if (shape === "circle" && cx !== null && cy !== null && num(el.radius) !== null) return { x: cx, y: cy, r: num(el.radius)! };
  if (shape === "rect" && cx !== null && cy !== null && num(el.width) !== null && num(el.height) !== null) {
    const w = num(el.width)! / 2, h = num(el.height)! / 2;
    const rad = ((num(el.rotation) ?? num(el.ccw_rotation) ?? 0) * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    return {
      punti: [[-w, -h], [w, -h], [w, h], [-w, h]].map(([u, v]) => ({ x: cx + u * cos - v * sin, y: cy + u * sin + v * cos })),
    };
  }
  const punti = ((el.points as Array<{ x?: unknown; y?: unknown }> | undefined) ?? [])
    .map((p) => ({ x: num(p?.x), y: num(p?.y) }))
    .filter((p): p is Punto => p.x !== null && p.y !== null);
  return punti.length >= 3 ? { punti } : null;
}

/** how far a point is from a zone: 0 inside */
function distanzaDaZona(z: { punti: Punto[]; anello: Anello } | { x: number; y: number; r: number }, x: number, y: number): number {
  if ("r" in z) return Math.max(0, Math.hypot(x - z.x, y - z.y) - z.r);
  if (dentroAnello(z.anello, x, y)) return 0;
  let d = Infinity;
  for (let i = 0, j = z.punti.length - 1; i < z.punti.length; j = i++) {
    d = Math.min(d, pointSegDistance(x, y, z.punti[j].x, z.punti[j].y, z.punti[i].x, z.punti[i].y));
  }
  return d;
}

/** the board outline: the drawn one when it is one, else the width x height rectangle */
function contornoDellaScheda(board: El | undefined): Punto[] {
  if (!board) return [];
  const disegnato = ((board.outline as Array<{ x?: unknown; y?: unknown }> | undefined) ?? [])
    .map((p) => ({ x: num(p?.x), y: num(p?.y) }))
    .filter((p): p is Punto => p.x !== null && p.y !== null);
  if (disegnato.length >= 3) return disegnato;
  const w = num(board.width), h = num(board.height);
  if (w === null || h === null) return [];
  const c = (board.center as { x?: unknown; y?: unknown } | undefined) ?? {};
  const cx = num(c.x) ?? 0, cy = num(c.y) ?? 0;
  return [
    { x: cx - w / 2, y: cy - h / 2 },
    { x: cx + w / 2, y: cy - h / 2 },
    { x: cx + w / 2, y: cy + h / 2 },
    { x: cx - w / 2, y: cy + h / 2 },
  ];
}

const tre = (v: number): number => Math.round(v * 1000) / 1000;

/**
 * The board without the pcb_via elements standing at these points, to the
 * micron: what a previous run of the tool wrote (see ground-stitching-file.ts).
 * Two vias of the board on one point would be one drill on another, so no other
 * via is taken off with them.
 */
export function senzaLeVieAi(circuitJson: unknown[], punti: Punto[]): unknown[] {
  if (punti.length === 0) return circuitJson;
  const chiavi = new Set(punti.map((p) => `${tre(p.x)},${tre(p.y)}`));
  return (circuitJson as El[]).filter((el) => {
    if (el.type !== "pcb_via") return true;
    const x = num(el.x), y = num(el.y);
    return x === null || y === null || !chiavi.has(`${tre(x)},${tre(y)}`);
  });
}

// ---------------------------------------------------------------------------
// The stitching
// ---------------------------------------------------------------------------

/**
 * The vias that stitch the ground of a compiled board (see the top of this
 * file). `circuitJson`: the saved board; `rules`: the project's.
 */
export function cuciLaMassa(
  circuitJson: unknown[],
  rules: DesignRules,
  opzioni: OpzioniCucitura = {},
): EsitoCucitura | CucituraNonFatta {
  const inizio = performance.now();
  const cj = circuitJson as El[];
  const scelta = sceltaDellaRete(cj, opzioni.rete);
  if ("ok" in scelta) return scelta;
  const g = gruppi(cj);
  const gruppoMassa = g.chiaveDiRete.get(scelta.id) ?? `net:${scelta.id}`;
  const avvisi: string[] = [];

  // --- the via, never below the project's minimums
  const foroChiesto = opzioni.foroMm ?? FORO_DI_SERIE_MM;
  const foro = Math.max(foroChiesto, rules.minViaHoleMm);
  if (foro > foroChiesto) avvisi.push(`foro portato da ${foroChiesto} a ${foro} mm, il minimo delle regole del progetto (minViaHoleMm)`);
  const coronaChiesta = opzioni.coronaMm ?? CORONA_DI_SERIE_MM;
  const corona = tre(Math.max(coronaChiesta, rules.minViaDiameterMm, foro + ANELLO_MINIMO_MM));
  if (corona > coronaChiesta) {
    avvisi.push(`corona portata da ${coronaChiesta} a ${corona} mm: minViaDiameterMm del progetto, o ${ANELLO_MINIMO_MM} mm piu' del foro`);
  }
  const R = corona / 2;
  const rh = foro / 2;
  const passo = opzioni.passoMm ?? PASSO_DI_SERIE_MM;
  const sfalsata = opzioni.sfalsata ?? true;
  const conBordo = opzioni.bordo ?? true;
  const passoBordo = opzioni.passoBordoMm ?? passo;
  const maxVie = opzioni.maxVie ?? MAX_VIE_DI_SERIE;
  const copreFinoGHz = Number(frequenzaCoperta(passo).toFixed(2));

  // --- the distances
  const colataProgetto = rules.pourClearanceMm ?? rules.minClearanceMm;
  const viaVia = distanzaMinimaFra(rules, "via", "via");
  const padVia = distanzaMinimaFra(rules, "pad", "via");
  const pistaVia = distanzaMinimaFra(rules, "trace", "via");
  const bordoMin = rules.minBoardEdgeClearanceMm;
  const foroForo = rules.minHoleToHoleMm;
  const lontane = new Map<string, number>();
  for (const r of opzioni.retiLontane ?? []) {
    const id = [...g.nomeDiRete.entries()].find(([k, n]) => n === r.rete || k === r.rete)?.[0];
    if (!id) {
      avvisi.push(`retiLontane: la rete ${r.rete} non c'e' sulla scheda, ignorata`);
      continue;
    }
    const k = g.chiaveDiRete.get(id) ?? `net:${id}`;
    lontane.set(k, Math.max(lontane.get(k) ?? 0, r.distanzaMm));
  }
  const piuLontana = Math.max(0, ...lontane.values());

  // --- the board
  const board = cj.find((el) => el.type === "pcb_board");
  const strati = stratiDiRame(num(board?.num_layers) ?? 2);
  const esterni = [strati[0], strati[strati.length - 1]];
  const contorno = contornoDellaScheda(board);
  if (contorno.length < 3) return { ok: false, errore: "la scheda salvata non ha un contorno" };
  const anelloScheda = anelloDi(contorno);
  const ritagli = cj
    .filter((el) => el.type === "pcb_cutout")
    .map(sagomaDiZona)
    .filter((z): z is NonNullable<typeof z> => z !== null)
    .map((z) => ("punti" in z ? { ...z, anello: anelloDi(z.punti) } : z));
  const vietate = cj
    .filter((el) => el.type === "pcb_keepout")
    .map(sagomaDiZona)
    .filter((z): z is NonNullable<typeof z> => z !== null)
    .map((z) => ("punti" in z ? { ...z, anello: anelloDi(z.punti) } : z));
  const escluse = (opzioni.zoneEscluse ?? []).map((z) => {
    const punti = "punti" in z ? z.punti : [
      { x: z.x - z.w / 2, y: z.y - z.h / 2 },
      { x: z.x + z.w / 2, y: z.y - z.h / 2 },
      { x: z.x + z.w / 2, y: z.y + z.h / 2 },
      { x: z.x - z.w / 2, y: z.y + z.h / 2 },
    ];
    return { punti, anello: anelloDi(punti) };
  });

  // --- the pours
  const colate: Colata[] = [];
  for (const el of cj) {
    if (el.type !== "pcb_copper_pour") continue;
    const brep = el.brep_shape as { outer_ring?: { vertices?: unknown }; inner_rings?: Array<{ vertices?: unknown }> } | undefined;
    const punti = (v: unknown): Punto[] =>
      ((v as Array<{ x?: unknown; y?: unknown }> | undefined) ?? [])
        .map((p) => ({ x: num(p?.x), y: num(p?.y) }))
        .filter((p): p is Punto => p.x !== null && p.y !== null);
    const fuori = punti(brep?.outer_ring?.vertices);
    if (fuori.length < 3) continue;
    const buchi = (brep?.inner_rings ?? []).map((r) => punti(r?.vertices)).filter((r) => r.length >= 3);
    const esterno = anelloDi(fuori);
    colate.push({
      indice: colate.length,
      id: String(el.pcb_copper_pour_id ?? `colata_${colate.length}`),
      gruppo: g.colata(el),
      layer: String(el.layer ?? "top"),
      distanza: distanzaPropria(el) ?? colataProgetto,
      esterno,
      buchi: buchi.map(anelloDi),
      areaMm2: Math.max(0, areaDi(fuori) - buchi.reduce((t, b) => t + areaDi(b), 0)),
      minX: esterno.minX,
      maxX: esterno.maxX,
      minY: esterno.minY,
      maxY: esterno.maxY,
    });
  }
  const massa = colate.filter((c) => c.gruppo === gruppoMassa);
  const altre = colate.filter((c) => c.gruppo !== gruppoMassa);
  const massaPerStrato = new Map<string, Colata[]>(strati.map((s) => [s, massa.filter((c) => c.layer === s)]));
  const altrePerStrato = new Map<string, Colata[]>(strati.map((s) => [s, altre.filter((c) => c.layer === s)]));
  const esterniConMassa = esterni.filter((s) => (massaPerStrato.get(s) ?? []).length > 0);
  const interniConMassa = strati.filter((s) => !esterni.includes(s) && (massaPerStrato.get(s) ?? []).length > 0);

  // --- the obstacles, in cells
  const ostacoli: Ostacolo[] = [];
  const vieDiMassa: Punto[] = [];
  const vieViste = new Set<string>();
  const mettiVia = (x: number, y: number, d: number, f: number, gruppo: string | null) => {
    const chiave = `${tre(x)},${tre(y)}`;
    if (vieViste.has(chiave)) return;
    vieViste.add(chiave);
    ostacoli.push({ k: "via", x, y, r: d / 2, foro: f, gruppo });
    if (gruppo === gruppoMassa) vieDiMassa.push({ x, y });
  };
  for (const el of cj) {
    if (el.type === "pcb_smtpad") {
      const forma = rameDelPad(el);
      if (forma) ostacoli.push({ k: "piazzola", forma, layer: el.layer ? String(el.layer) : null, gruppo: g.pad(el) });
    } else if (el.type === "pcb_plated_hole") {
      const forma = rameDelForo(el);
      const f = foroDi(el);
      if (forma) ostacoli.push({ k: "piazzola", forma, layer: null, gruppo: g.pad(el), ...(f ? { foro: f } : {}) });
      else if (f) ostacoli.push({ k: "nudo", foro: f });
    } else if (el.type === "pcb_hole") {
      const f = foroDi(el);
      if (f) ostacoli.push({ k: "nudo", foro: f });
    } else if (el.type === "pcb_via") {
      const x = num(el.x), y = num(el.y);
      const d = num(el.outer_diameter) ?? num(el.hole_diameter);
      if (x !== null && y !== null && d !== null) mettiVia(x, y, d, num(el.hole_diameter) ?? rules.minViaHoleMm, g.via(el));
    }
  }
  for (const el of cj) {
    if (el.type !== "pcb_trace") continue;
    const gruppo = g.traccia(el);
    const route = (el.route as El[] | undefined) ?? [];
    for (let i = 0; i < route.length; i++) {
      const b = route[i];
      if (b.route_type === "via") {
        const x = num(b.x), y = num(b.y);
        const d = num(b.via_diameter) ?? num(b.outer_diameter) ?? rules.minViaDiameterMm;
        if (x !== null && y !== null) mettiVia(x, y, d, num(b.via_hole_diameter) ?? num(b.hole_diameter) ?? rules.minViaHoleMm, gruppo);
        continue;
      }
      const a = route[i - 1];
      if (!a || a.route_type !== "wire" || b.route_type !== "wire") continue;
      const ax = num(a.x), ay = num(a.y), bx = num(b.x), by = num(b.y);
      if (ax === null || ay === null || bx === null || by === null) continue;
      ostacoli.push({
        k: "pista",
        ax, ay, bx, by,
        mezza: (num(b.width) ?? num(a.width) ?? rules.minTraceWidthMm) / 2,
        layer: b.layer ? String(b.layer) : a.layer ? String(a.layer) : null,
        gruppo,
      });
    }
  }
  const celle = new Celle(1);
  ostacoli.forEach((o, i) => {
    const [a, b, c, d] = scatolaDi(o);
    celle.metti(i, a, b, c, d);
  });
  const celleVieMassa = new Celle(Math.max(1, passo / 2));
  vieDiMassa.forEach((v, i) => celleVieMassa.metti(i, v.x, v.y, v.x, v.y));

  // --- the footprints of the parts and the mating spaces, both faces
  const formeIngombro: Array<{ f: Forma; tipo: "ingombro" | "innesto" }> = [];
  for (const p of leggiIngombri(cj, eccedenzaDellIngombro(rules))) {
    for (const f of [...p.forme, ...p.fori]) formeIngombro.push({ f, tipo: "ingombro" });
    for (const i of p.innesti) formeIngombro.push({ f: i.forma, tipo: "innesto" });
  }
  const celleIngombri = new Celle(2);
  formeIngombro.forEach((x, i) => celleIngombri.metti(i, x.f.box.minX, x.f.box.minY, x.f.box.maxX, x.f.box.maxY));

  // --- the silkscreen as it prints, both faces: strokes with their pen, and filled drawings
  const luceSerigrafia = Math.max(distanzaDellaSerigrafia(rules), TOLLERANZA_MM);
  const tratti: Array<{ ax: number; ay: number; bx: number; by: number; h: number }> = [];
  const pieni: Array<{ punti: Punto[]; anello: Anello }> = [];
  for (const el of cj) {
    if (!String(el.type).startsWith("pcb_silkscreen_")) continue;
    const d = disegnoStampato(el);
    if (!d) continue;
    for (const [a, b] of d.segmenti) tratti.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y, h: d.mezzaPenna });
    for (const r of d.regioni) if (r.length >= 3) pieni.push({ punti: r, anello: anelloDi(r) });
  }
  const celleSerigrafia = new Celle(1);
  tratti.forEach((t, i) =>
    celleSerigrafia.metti(i, Math.min(t.ax, t.bx) - t.h, Math.min(t.ay, t.by) - t.h, Math.max(t.ax, t.bx) + t.h, Math.max(t.ay, t.by) + t.h),
  );

  /** the widest distance any check asks, for the cells to look at */
  const portata =
    R +
    Math.max(
      colataProgetto, viaVia, padVia, pistaVia, foroForo, bordoMin, piuLontana,
      opzioni.distanzaPisteMm ?? 0, ...colate.map((c) => c.distanza),
    ) + 0.01;

  /** the ground pours covering the disc on each layer, by layer */
  const copertura = (x: number, y: number): Map<string, Colata[]> => {
    const out = new Map<string, Colata[]>();
    for (const s of strati) {
      const sopra = (massaPerStrato.get(s) ?? []).filter((c) => copreDisco(c, x, y, R));
      if (sopra.length > 0) out.set(s, sopra);
    }
    return out;
  };

  /**
   * Whether a via can stand at (x, y), and if not the first reason why. The
   * proposed vias already accepted are checked last (vicina_a_cucitura).
   */
  const accettate: Punto[] = [];
  const celleAccettate = new Celle(Math.max(1, passo / 2));
  const distanzaFraNuove = Math.max(Math.min(passo, conBordo ? passoBordo : passo) / 2, corona + viaVia, foro + foroForo);
  const prova = (x: number, y: number): { ok: true; sopra: Map<string, Colata[]> } | { ok: false; motivo: MotivoScarto } => {
    // the board, its cutouts and its edge
    if (!dentroAnello(anelloScheda, x, y)) return { ok: false, motivo: "fuori_scheda" };
    for (const z of ritagli) if (distanzaDaZona(z, x, y) === 0) return { ok: false, motivo: "fuori_scheda" };
    if (vicinoAdAnello(anelloScheda, x, y, R + bordoMin)) return { ok: false, motivo: "bordo" };
    for (const z of ritagli) if (distanzaDaZona(z, x, y) < R + bordoMin) return { ok: false, motivo: "bordo" };
    for (const z of escluse) if (distanzaDaZona(z, x, y) < R) return { ok: false, motivo: "zona_esclusa" };
    for (const z of vietate) if (distanzaDaZona(z, x, y) < R) return { ok: false, motivo: "zona_vietata" };

    // the ground under it
    const sopra = copertura(x, y);
    if (sopra.size < 2) return { ok: false, motivo: "massa_su_meno_di_due_strati" };
    for (const s of esterniConMassa) if (!sopra.has(s)) return { ok: false, motivo: "manca_massa_esterna" };
    for (const s of interniConMassa) if (!sopra.has(s)) return { ok: false, motivo: "manca_massa_interna" };

    // the parts
    const disco = formaDi([{ x, y }], R);
    let parte: MotivoScarto | null = null;
    celleIngombri.cerca(x, y, R, (i) => {
      const { f, tipo } = formeIngombro[i];
      if (distanzaRiquadri(disco.box, f.box) > TOLLERANZA_INGOMBRI_MM) return;
      const m = misuraForme(disco, f);
      if (m.sovrapposizione > 0 || m.distanza <= TOLLERANZA_INGOMBRI_MM) {
        parte = tipo;
        if (tipo === "ingombro") return true;
      }
    });
    if (parte) return { ok: false, motivo: parte };

    /** the distance this layer asks from the copper of another net: the ground pour's own there, or the project's */
    const distanzaSu = (s: string | null): number => {
      if (s === null) return Math.max(...strati.map((q) => distanzaSu(q)));
      const c = sopra.get(s);
      return c ? Math.max(...c.map((q) => q.distanza)) : colataProgetto;
    };
    // pads, holes, vias, traces: the worst reason wins, in the order of MOTIVI
    const ordine: MotivoScarto[] = ["piazzola", "foro", "via_esistente", "pista_altra_rete", "rete_lontana"];
    let peggio = Infinity;
    const segna = (m: MotivoScarto) => {
      peggio = Math.min(peggio, ordine.indexOf(m));
    };
    celle.cerca(x, y, portata, (i) => {
      const o = ostacoli[i];
      const mia = o.k !== "nudo" && o.gruppo === gruppoMassa;
      const extra = o.k !== "nudo" && o.gruppo !== null ? (lontane.get(o.gruppo) ?? 0) : 0;
      if (o.k === "pista") {
        if (mia) return;
        const d = pointSegDistance(x, y, o.ax, o.ay, o.bx, o.by) - o.mezza - R;
        if (d < Math.max(opzioni.distanzaPisteMm ?? distanzaSu(o.layer), pistaVia)) segna("pista_altra_rete");
        else if (d < extra) segna("rete_lontana");
      } else if (o.k === "piazzola") {
        const d = distanzaPuntoForma(o.forma, x, y) - R;
        if (d < (mia ? padVia : Math.max(distanzaSu(o.layer), padVia))) segna("piazzola");
        else if (d < extra) segna("rete_lontana");
        if (o.foro) {
          const c = o.foro;
          if (pointSegDistance(x, y, c.ax, c.ay, c.bx, c.by) - c.r - rh < foroForo) segna("foro");
        }
      } else if (o.k === "via") {
        const d = Math.hypot(x - o.x, y - o.y);
        if (d - o.r - R < (mia ? viaVia : Math.max(distanzaSu(null), viaVia))) segna("via_esistente");
        else if (d - o.foro / 2 - rh < foroForo) segna("via_esistente");
        else if (d - o.r - R < extra) segna("rete_lontana");
      } else {
        const c = o.foro;
        const d = pointSegDistance(x, y, c.ax, c.ay, c.bx, c.by) - c.r;
        if (d - rh < foroForo || d - R < bordoMin) segna("foro");
      }
      return peggio === 0;
    });
    if (Number.isFinite(peggio)) return { ok: false, motivo: ordine[peggio] };

    // the pours of the other nets, layer by layer
    for (const s of strati) {
      const vicino = distanzaSu(s);
      for (const c of altrePerStrato.get(s) ?? []) {
        const extra = lontane.get(c.gruppo) ?? 0;
        if (toccaDisco(c, x, y, R + Math.max(vicino, c.distanza))) return { ok: false, motivo: "colata_altra_rete" };
        if (extra > 0 && toccaDisco(c, x, y, R + extra)) return { ok: false, motivo: "rete_lontana" };
      }
    }

    // the silkscreen: the hole (it goes through both faces) keeps the silkscreen clearance from the ink
    let inchiostro = false;
    celleSerigrafia.cerca(x, y, rh + luceSerigrafia, (i) => {
      const t = tratti[i];
      if (pointSegDistance(x, y, t.ax, t.ay, t.bx, t.by) - t.h - rh < luceSerigrafia) return (inchiostro = true);
    });
    for (const p of pieni) {
      if (inchiostro) break;
      const a = p.anello;
      const r = rh + luceSerigrafia;
      if (x < a.minX - r || x > a.maxX + r || y < a.minY - r || y > a.maxY + r) continue;
      if (distanzaDaZona(p, x, y) - rh < luceSerigrafia) inchiostro = true;
    }
    if (inchiostro) return { ok: false, motivo: "serigrafia" };

    // a ground via already there, and the vias proposed so far
    let gia = false;
    celleVieMassa.cerca(x, y, passo / 2, (i) => {
      if (Math.hypot(vieDiMassa[i].x - x, vieDiMassa[i].y - y) < passo / 2 - TOLLERANZA_MM) return (gia = true);
    });
    if (gia) return { ok: false, motivo: "gia_cucita" };
    let vicina = false;
    celleAccettate.cerca(x, y, distanzaFraNuove, (i) => {
      if (Math.hypot(accettate[i].x - x, accettate[i].y - y) < distanzaFraNuove - TOLLERANZA_MM) return (vicina = true);
    });
    if (vicina) return { ok: false, motivo: "vicina_a_cucitura" };
    return { ok: true, sopra };
  };

  const vie: EsitoCucitura["vie"] = [];
  const scarti: Partial<Record<MotivoScarto, number>> = {};
  let provate = 0;
  const scarta = (m: MotivoScarto, n = 1) => {
    scarti[m] = (scarti[m] ?? 0) + n;
  };
  const accetta = (x: number, y: number, tipo: TipoVia) => {
    celleAccettate.metti(accettate.length, x, y, x, y);
    accettate.push({ x, y });
    vie.push({ x, y, tipo });
  };

  // --- 1. the islands of ground, first
  const isole = isoleDiMassa(cj, g, gruppoMassa, massa, strati);
  const collegate: IsolaDiMassa[] = [];
  const senzaPosto: Array<IsolaDiMassa & { motivo: MotivoScarto }> = [];
  for (const isola of isole.isole) {
    const c = isola.colata;
    const dove = { strato: c.layer, areaMm2: Number(c.areaMm2.toFixed(3)), x: tre(isola.punto.x), y: tre(isola.punto.y) };
    // a via placed for an island before it already ties this one too
    if (isole.principale.has(c.indice)) {
      collegate.push(dove);
      continue;
    }
    if (vie.length >= maxVie) {
      senzaPosto.push({ ...dove, motivo: "tetto" });
      continue;
    }
    const motivi = new Map<MotivoScarto, number>();
    let presa: { p: Punto; sopra: Map<string, Colata[]> } | null = null;
    for (const p of puntiDellIsola(c, R)) {
      provate++;
      const esito = prova(p.x, p.y);
      if (!esito.ok) {
        motivi.set(esito.motivo, (motivi.get(esito.motivo) ?? 0) + 1);
        continue;
      }
      // it has to reach the main plane on another layer, or it ties the island to nothing
      const alPiano = [...esito.sopra.entries()].some(([s, cc]) => s !== c.layer && cc.some((q) => isole.principale.has(q.indice)));
      if (!alPiano) {
        motivi.set("non_raggiunge_il_piano", (motivi.get("non_raggiunge_il_piano") ?? 0) + 1);
        continue;
      }
      presa = { p, sopra: esito.sopra };
      break;
    }
    if (presa) {
      accetta(presa.p.x, presa.p.y, "isola");
      collegate.push(dove);
      // every piece the via stands in is on the main plane now, and whatever those pieces were joined to
      for (const cc of presa.sopra.values()) for (const q of cc) for (const m of isole.conGli(q.indice)) isole.principale.add(m);
    } else {
      const motivo = [...motivi.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? "massa_su_meno_di_due_strati";
      senzaPosto.push({ ...dove, motivo });
    }
  }

  // --- 2. the row along the edge, 3. the grid
  const candidati: Array<{ p: Punto; tipo: TipoVia }> = [
    ...(conBordo ? filaDelBordo(contorno, passoBordo, bordoMin + R + 0.01).map((p) => ({ p, tipo: "bordo" as const })) : []),
    // the lattice over the box of the pours: the points off the board are not positions at all, not counted
    ...grigliaSullaMassa(massa, passo, sfalsata)
      .filter((p) => dentroAnello(anelloScheda, p.x, p.y))
      .map((p) => ({ p, tipo: "griglia" as const })),
  ];
  let raggiunto = false;
  for (let i = 0; i < candidati.length; i++) {
    if (vie.length >= maxVie) {
      raggiunto = true;
      scarta("tetto", candidati.length - i);
      provate += candidati.length - i;
      break;
    }
    const { p, tipo } = candidati[i];
    provate++;
    const esito = prova(p.x, p.y);
    if (esito.ok) accetta(p.x, p.y, tipo);
    else scarta(esito.motivo);
  }
  if (raggiunto) {
    avvisi.push(`tetto di ${maxVie} vie raggiunto: le posizioni oltre non sono state provate (la griglia e' ordinata dalla piu' rada alla piu' fitta, quindi le vie messe coprono la scheda a un passo piu' largo); alza maxVie o il passo`);
  }
  if (passo > 2.7) {
    avvisi.push(`a passo ${passo} mm la cucitura e' lambda/20 solo fino a ${copreFinoGHz} GHz in FR4 (2,7 GHz chiede circa 2,7 mm)`);
  }

  const conteggio: Record<TipoVia, number> = { isola: 0, bordo: 0, griglia: 0 };
  for (const v of vie) conteggio[v.tipo]++;
  return {
    ok: true,
    rete: scelta,
    via: { foroMm: foro, coronaMm: corona },
    passoMm: passo,
    sfalsata,
    bordo: { attiva: conBordo, passoMm: passoBordo },
    copreFinoGHz,
    vie,
    conteggio,
    posizioniProvate: provate,
    scarti,
    isole: { trovate: isole.isole.length, collegate, senzaPosto },
    tetto: { maxVie, raggiunto },
    avvisi,
    tempoMs: Math.round(performance.now() - inizio),
  };
}

// ---------------------------------------------------------------------------
// Where the candidates come from
// ---------------------------------------------------------------------------

/**
 * THE GRID, anchored to the board's origin so it does not move when a pour
 * changes shape: square, or triangular (rows sqrt(3)/2 of a pitch apart, every
 * other one shifted by half a pitch, so every via has its six neighbours at one
 * pitch). Only over the box of the ground pours. Ordered from the sparsest
 * lattice to the full one (every 8th point of every 8th row, then every 4th...):
 * when the cap stops the grid, the vias placed cover the board at a wider
 * pitch instead of filling one half of it.
 */
function grigliaSullaMassa(massa: Colata[], passo: number, sfalsata: boolean): Punto[] {
  if (massa.length === 0) return [];
  const minX = Math.min(...massa.map((c) => c.minX));
  const maxX = Math.max(...massa.map((c) => c.maxX));
  const minY = Math.min(...massa.map((c) => c.minY));
  const maxY = Math.max(...massa.map((c) => c.maxY));
  const riga = sfalsata ? (passo * Math.sqrt(3)) / 2 : passo;
  const out: Array<{ p: Punto; livello: number; i: number; j: number }> = [];
  const livelloDi = (i: number, j: number): number => {
    for (const k of [8, 4, 2]) if (i % k === 0 && j % k === 0) return k;
    return 1;
  };
  for (let j = Math.ceil(minY / riga); j * riga <= maxY; j++) {
    const scarto = sfalsata && Math.abs(j % 2) === 1 ? passo / 2 : 0;
    for (let i = Math.ceil((minX - scarto) / passo); i * passo + scarto <= maxX; i++) {
      out.push({ p: { x: tre(i * passo + scarto), y: tre(j * riga) }, livello: livelloDi(i, j), i, j });
    }
  }
  out.sort((a, b) => b.livello - a.livello || a.j - b.j || a.i - b.i);
  return out.map((o) => o.p);
}

/**
 * THE ROW ALONG THE EDGE: points every `passo` along the outline, walked as one
 * line from its first vertex, each moved into the board by `rientro` along the
 * side it lies on. A point the corners push too near another side is refused by
 * the edge check like any other.
 */
function filaDelBordo(contorno: Punto[], passo: number, rientro: number): Punto[] {
  // twice the signed area: positive for a counterclockwise outline (y up), whose inside is left of each side
  let doppia = 0;
  for (let i = 0, j = contorno.length - 1; i < contorno.length; j = i++) doppia += contorno[j].x * contorno[i].y - contorno[i].x * contorno[j].y;
  const verso = doppia > 0 ? 1 : -1;
  const out: Punto[] = [];
  let resto = 0;
  for (let i = 0; i < contorno.length; i++) {
    const a = contorno[i];
    const b = contorno[(i + 1) % contorno.length];
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    if (l < 1e-9) continue;
    const ux = (b.x - a.x) / l, uy = (b.y - a.y) / l;
    // the inward normal: left of the side for a counterclockwise outline
    const nx = -uy * verso, ny = ux * verso;
    let t = resto;
    while (t <= l) {
      out.push({ x: tre(a.x + ux * t + nx * rientro), y: tre(a.y + uy * t + ny * rientro) });
      t += passo;
    }
    resto = t - l;
  }
  return out;
}

/**
 * Points of an island where a via could go, nearest to the middle of its box
 * first: a lattice fine enough for a ring, never more than a few thousand
 * points, only those already on its copper with the ring inside.
 */
function puntiDellIsola(c: Colata, R: number): Punto[] {
  const w = c.maxX - c.minX, h = c.maxY - c.minY;
  let passo = Math.max(0.05, Math.min(0.25, R / 2));
  if ((w / passo) * (h / passo) > 20_000) passo = Math.sqrt((w * h) / 20_000);
  const cx = (c.minX + c.maxX) / 2, cy = (c.minY + c.maxY) / 2;
  const out: Array<{ p: Punto; d: number }> = [];
  for (let y = c.minY + R; y <= c.maxY - R + 1e-9; y += passo) {
    for (let x = c.minX + R; x <= c.maxX - R + 1e-9; x += passo) {
      const p = { x: tre(x), y: tre(y) };
      if (!copreDisco(c, p.x, p.y, R)) continue;
      out.push({ p, d: Math.hypot(p.x - cx, p.y - cy) });
    }
  }
  out.sort((a, b) => a.d - b.d || a.p.y - b.p.y || a.p.x - b.p.x);
  return out.slice(0, 400).map((o) => o.p);
}

// ---------------------------------------------------------------------------
// The islands
// ---------------------------------------------------------------------------

/**
 * THE PIECES OF GROUND POUR NOT CONNECTED TO THE REST. Everything of the net
 * that conducts is a node: the pieces of pour, the vias (on every layer), the
 * pads (on their layer), the plated holes (every layer), the traces. A piece
 * joins what stands in its copper; a trace joins the pads, vias and traces its
 * points touch. The main plane is the group holding the most poured area; the
 * pieces outside it are the islands, largest first.
 */
function isoleDiMassa(
  cj: El[],
  g: ReturnType<typeof gruppi>,
  gruppoMassa: string,
  massa: Colata[],
  strati: string[],
): { isole: Array<{ colata: Colata; punto: Punto }>; principale: Set<number>; conGli: (indice: number) => number[] } {
  if (massa.length === 0) return { isole: [], principale: new Set(), conGli: () => [] };
  const padre: number[] = [];
  const nuovo = (): number => {
    padre.push(padre.length);
    return padre.length - 1;
  };
  const radice = (a: number): number => {
    while (padre[a] !== a) {
      padre[a] = padre[padre[a]];
      a = padre[a];
    }
    return a;
  };
  const unisci = (a: number, b: number) => {
    const ra = radice(a), rb = radice(b);
    if (ra !== rb) padre[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  // node i of a piece is massa[i]'s position in this list
  const nodoDi = new Map<number, number>();
  for (const c of massa) nodoDi.set(c.indice, nuovo());
  const celle = new Celle(2);
  massa.forEach((c, i) => celle.metti(i, c.minX, c.minY, c.maxX, c.maxY));
  /** joins the node to every piece whose copper holds the point, on these layers */
  const aiPezzi = (nodo: number, x: number, y: number, suStrati: string[] | null) => {
    celle.cerca(x, y, 0, (i) => {
      const c = massa[i];
      if (suStrati && !suStrati.includes(c.layer)) return;
      if (nelRame(c, x, y)) unisci(nodo, nodoDi.get(c.indice)!);
    });
  };
  /*
   * Two pieces on one layer that overlap or touch are one copper: a project
   * declares pours that overlap (sbb-dl-principale: an inner2 strip lying over
   * the inner2 plane), and the Gerber draws them as one.
   */
  massa.forEach((a, i) => {
    celle.cerca((a.minX + a.maxX) / 2, (a.minY + a.maxY) / 2, Math.max(a.maxX - a.minX, a.maxY - a.minY) / 2 + 0.01, (j) => {
      const b = massa[j];
      if (j <= i || b.layer !== a.layer) return;
      if (radice(nodoDi.get(a.indice)!) === radice(nodoDi.get(b.indice)!)) return;
      if (siToccano(a, b)) unisci(nodoDi.get(a.indice)!, nodoDi.get(b.indice)!);
    });
  });
  // the pads and holes of the net, and its vias: points a trace can land on
  const punti: Array<{ x: number; y: number; nodo: number; layer: string | null; forma?: FormaRame; r?: number }> = [];
  for (const el of cj) {
    if (el.type === "pcb_smtpad" || el.type === "pcb_plated_hole") {
      if (g.pad(el) !== gruppoMassa) continue;
      const forma = el.type === "pcb_smtpad" ? rameDelPad(el) : rameDelForo(el);
      if (!forma) continue;
      const nodo = nuovo();
      const layer = el.type === "pcb_smtpad" ? String(el.layer ?? "top") : null;
      aiPezzi(nodo, forma.x, forma.y, layer ? [layer] : strati);
      punti.push({ x: forma.x, y: forma.y, nodo, layer, forma });
    } else if (el.type === "pcb_via") {
      if (g.via(el) !== gruppoMassa) continue;
      const x = num(el.x), y = num(el.y);
      if (x === null || y === null) continue;
      const nodo = nuovo();
      aiPezzi(nodo, x, y, strati);
      punti.push({ x, y, nodo, layer: null, r: (num(el.outer_diameter) ?? 0) / 2 });
    }
  }
  const cellePunti = new Celle(1);
  punti.forEach((p, i) => {
    if (p.forma) {
      const b = ingombroForma(p.forma);
      cellePunti.metti(i, b.minX, b.minY, b.maxX, b.maxY);
    } else {
      const m = Math.max(0.05, p.r ?? 0);
      cellePunti.metti(i, p.x - m, p.y - m, p.x + m, p.y + m);
    }
  });
  const capiDiPista: Array<{ x: number; y: number; layer: string | null; nodo: number }> = [];
  for (const el of cj) {
    if (el.type !== "pcb_trace" || g.traccia(el) !== gruppoMassa) continue;
    const nodo = nuovo();
    const route = ((el.route as El[] | undefined) ?? []).filter((p) => num(p.x) !== null && num(p.y) !== null);
    route.forEach((p, i) => {
      const x = num(p.x)!, y = num(p.y)!;
      const via = p.route_type === "via";
      const layer = via ? null : p.layer ? String(p.layer) : null;
      aiPezzi(nodo, x, y, layer ? [layer] : strati);
      // what the point lands on: a pad on its layer, a hole, a via
      cellePunti.cerca(x, y, 0.01, (k) => {
        const q = punti[k];
        if (layer && q.layer && q.layer !== layer) return;
        const d = q.forma ? distanzaPuntoForma(q.forma, x, y) : Math.hypot(q.x - x, q.y - y) - (q.r ?? 0);
        if (d <= 0.01) unisci(nodo, q.nodo);
      });
      if (i === 0 || i === route.length - 1 || via) capiDiPista.push({ x, y, layer, nodo });
    });
  }
  // two traces that meet: an end of one on a point of the other, on the same layer
  const celleCapi = new Celle(1);
  capiDiPista.forEach((c, i) => celleCapi.metti(i, c.x, c.y, c.x, c.y));
  for (const c of capiDiPista) {
    celleCapi.cerca(c.x, c.y, 0.01, (k) => {
      const o = capiDiPista[k];
      if (o.nodo === c.nodo || (c.layer && o.layer && c.layer !== o.layer)) return;
      if (Math.hypot(o.x - c.x, o.y - c.y) <= 0.01) unisci(c.nodo, o.nodo);
    });
  }
  // the main plane: the group with the most poured area
  const areaDelGruppo = new Map<number, number>();
  for (const c of massa) {
    const r = radice(nodoDi.get(c.indice)!);
    areaDelGruppo.set(r, (areaDelGruppo.get(r) ?? 0) + c.areaMm2);
  }
  const piano = [...areaDelGruppo.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
  const principale = new Set(massa.filter((c) => radice(nodoDi.get(c.indice)!) === piano).map((c) => c.indice));
  const isole = massa
    .filter((c) => !principale.has(c.indice))
    .sort((a, b) => b.areaMm2 - a.areaMm2 || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((c) => ({ colata: c, punto: puntoNellaColata(c) }));
  /** the pieces joined to this one (itself included) */
  const membri = new Map<number, number[]>();
  for (const c of massa) {
    const r = radice(nodoDi.get(c.indice)!);
    membri.set(r, [...(membri.get(r) ?? []), c.indice]);
  }
  const conGli = (indice: number): number[] => {
    const nodo = nodoDi.get(indice);
    return nodo === undefined ? [indice] : (membri.get(radice(nodo)) ?? [indice]);
  };
  return { isole, principale, conGli };
}

/** the copper of two pours on one layer overlaps or touches: a vertex of one in the other, or two edges that meet */
function siToccano(a: Colata, b: Colata): boolean {
  const t = 0.001;
  if (a.maxX < b.minX - t || b.maxX < a.minX - t || a.maxY < b.minY - t || b.maxY < a.minY - t) return false;
  const anelliDi = (c: Colata) => [c.esterno, ...c.buchi];
  for (const [p, q] of [[a, b], [b, a]] as const) {
    for (const r of anelliDi(p)) {
      for (let k = 0; k < r.n; k++) {
        if (nelRame(q, r.xs[k], r.ys[k])) return true;
      }
    }
  }
  // the edges, run against run where the boxes meet
  for (const ra of anelliDi(a)) {
    for (const ca of ra.corse) {
      if (ca.maxX < b.minX - t || ca.minX > b.maxX + t || ca.maxY < b.minY - t || ca.minY > b.maxY + t) continue;
      for (const rb of anelliDi(b)) {
        for (const cb of rb.corse) {
          if (ca.maxX < cb.minX - t || cb.maxX < ca.minX - t || ca.maxY < cb.minY - t || cb.maxY < ca.minY - t) continue;
          for (let i = ca.i0; i < ca.i1; i++) {
            const i2 = i + 1 === ra.n ? 0 : i + 1;
            for (let j = cb.i0; j < cb.i1; j++) {
              const j2 = j + 1 === rb.n ? 0 : j + 1;
              const d = dSS(
                { x: ra.xs[i], y: ra.ys[i] },
                { x: ra.xs[i2], y: ra.ys[i2] },
                { x: rb.xs[j], y: rb.ys[j] },
                { x: rb.xs[j2], y: rb.ys[j2] },
              ).d;
              if (d <= t) return true;
            }
          }
        }
      }
    }
  }
  return false;
}

/** a point on the copper of a pour, to show where it is: the middle of its box when it is copper, else a vertex */
function puntoNellaColata(c: Colata): Punto {
  const cx = (c.minX + c.maxX) / 2, cy = (c.minY + c.maxY) / 2;
  if (nelRame(c, cx, cy)) return { x: cx, y: cy };
  return { x: c.esterno.xs[0], y: c.esterno.ys[0] };
}
